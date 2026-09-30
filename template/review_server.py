"""Локальный сервер ревью: статика проекта + API заметок (логика — в review_api.py, подхватывается на лету).

    python review_server.py [--open]             -> http://localhost:8765/src/review.html
                                                    (порт занят другим проектом — берёт 8766, 8767, …;
                                                     выбранный порт пишет в build/.review_port)
    python review_server.py port                  (порт уже запущенного сервера этого проекта)
    python review_server.py reply 3 "текст" --done   (ответ на правку #3 и отметка «сделано»)
    python review_server.py list                  (открытые правки в консоль)
    python review_server.py script-list | script-reply N "текст" [--done] [--field VO --from "…" --to "…"]
                                                  (правки сценария со страницы /src/script.html, см. script_api.py)
    python review_server.py --open script         (открыть раскадровку сценария вместо ревью видео)

GET  /api/notes        -> список заметок
POST /api/notes        <- заметки из браузера; СЛИВАЮТСЯ с файлом по полю `updated`
                          (у каждой заметки побеждает более свежая версия), ответ — итоговый список
POST /api/shot?id=N    <- dataURL png -> review/shots/N.png
GET  /api/version      -> mtime исходников (авто-перезагрузка) и заметок

Файлы: review/notes.json (данные), review/notes.md (читаемая версия для Claude).
Удалённые заметки не стираются, а помечаются deleted=true — так удаление тоже «сливается».
"""
import importlib, json, os, socket, sys, threading, urllib.request, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("REVIEW_PORT", "8765"))
sys.path.insert(0, ROOT)
import review_api  # noqa: E402  (all request logic lives there and is hot-reloaded)

_api_lock = threading.Lock()
_api_mtime = os.path.getmtime(review_api.__file__)


def api():
    """review_api, reloaded if its file changed since the last request (no server restart needed)."""
    global _api_mtime
    with _api_lock:
        m = os.path.getmtime(review_api.__file__)
        if m != _api_mtime:
            try:
                importlib.reload(review_api)
                print("review_api перезагружен")
            except Exception as e:           # keep serving with the previous version
                print("! review_api не загрузился:", e)
            _api_mtime = m
    return review_api


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_GET(self):
        if not api().handle_get(self):
            super().do_GET()

    def do_POST(self):
        if not api().handle_post(self):
            self.send_error(404)


def cli():
    a = api()
    cmd = sys.argv[1]
    if cmd == "list":
        for n in sorted(a.load(), key=lambda n: n["t"]):
            if n.get("deleted") or n.get("status") == "done":
                continue
            print(f"#{n['id']} [{a.fmt(n['t'])}{' – ' + a.fmt(n['t2']) if n.get('t2') else ''}] "
                  f"{n.get('sceneName', '')}: {n.get('text', '')}")
    elif cmd == "reply":
        nid, text = int(sys.argv[2]), sys.argv[3]
        if not a.reply(nid, text, "--done" in sys.argv):
            sys.exit(f"нет правки #{nid}")
        print("ok", nid)
    elif not (hasattr(a, "cli") and a.cli(sys.argv[1:])):
        sys.exit(f"неизвестная команда: {cmd}")


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server silently share a busy port (and the old one keeps
    # answering). Bind exclusively instead, so a busy port fails loudly and we move to the next one.
    allow_reuse_address = False
    request_queue_size = 128   # render workers fetch hundreds of assets at once; the default backlog of 5 refused connections

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def is_busy(port):
    """Instant check: can we bind it? (connecting to a closed port on Windows takes ~0.5-2 s)"""
    t = socket.socket()
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            t.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        t.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        t.close()


def probe(port):
    """Project name served on this port, or None."""
    if not is_busy(port):
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=0.4) as r:
            return json.loads(r.read()).get("root", "?")
    except Exception:
        return None


def running_port():
    me = os.path.basename(ROOT)
    for p in range(PORT, PORT + 20):
        if probe(p) == me:
            return p
    return None


def serve(open_browser, page="review"):
    p = running_port()
    if p:                                    # this project is already being served
        url = f"http://localhost:{p}/src/{page}.html"
        print(f"Уже запущено: {url}")
        if open_browser:
            webbrowser.open(url)
        return
    srv = None
    for p in range(PORT, PORT + 20):
        try:
            srv = Server(("127.0.0.1", p), H)
            break
        except OSError:
            other = probe(p)
            print(f"Порт {p} занят{' проектом «' + other + '»' if other else ''} — пробую следующий")
    if not srv:
        sys.exit("Нет свободного порта 8765–8784")
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    with open(os.path.join(ROOT, "build", ".review_port"), "w") as f:
        f.write(str(p))
    url = f"http://localhost:{p}/src/{page}.html"
    print(f"Ревью «{os.path.basename(ROOT)}»: {url}")
    if open_browser:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "port":           # port of this project's running server (empty if none)
        print(running_port() or "")
    elif args and not args[0].startswith("-") and args[0] != "script":
        cli()
    else:
        serve("--open" in args, "script" if "script" in args else "review")
