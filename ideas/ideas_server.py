"""Штурм идей: локальный сервис по методике «Мастер-планера», в двух режимах (шортс и длинное видео) и двух путях:
«есть идея» (идея и референсы → вопросы Claude → биты → название → препродакшен: сцены, персонажи, пропсы, звуки → обложка)
и «штурм» (идеи → биты → название → образы → превью → структура → в работу → итоги).

    python ideas_server.py [--open]      -> http://localhost:8790/  (порт занят — 8791, 8792, …; пишется в _ideas/.port)
    python ideas_server.py port          (порт уже запущенного сервиса)
    python ideas_server.py list | show ID | bank | new short|long "Имя" [--topic "…"] [--idea "…"] [--storm]
                           | add-ideas ID "…" … | add-beats ID "вопрос | ответ" … | add-bank "Идея" [--desc …]
                           | add-questions ID "вопрос" … | add-elements ID scene|char|prop|sound "название | описание" …
                           | set KEY путь значение | produce ID "Проект" [--attach]
                                         (команды для Claude в сессии, полный список — ideas_api.cli)

Код лежит здесь (_pipeline/ideas), данные — в <рабочая папка>/_ideas, вне git (plans/*.json + *.md, bank.json,
brand.json, stats.json, files/, копия PDF тетради). Вся логика запросов — в ideas_api.py, он перезагружается на лету.
"""
import importlib, json, os, socket, sys, threading, time, urllib.request, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("IDEAS_PORT", "8790"))
sys.path.insert(0, HERE)
import ideas_api  # noqa: E402  (all request logic lives there and is hot-reloaded)

_api_lock = threading.Lock()
_api_mtime = os.path.getmtime(ideas_api.__file__)


def api():
    """ideas_api, reloaded if its file changed since the last request (no restart needed)."""
    global _api_mtime
    with _api_lock:
        m = os.path.getmtime(ideas_api.__file__)
        if m != _api_mtime:
            try:
                importlib.reload(ideas_api)
                print("ideas_api перезагружен")
            except Exception as e:           # keep serving with the previous version
                print("! ideas_api не загрузился:", e)
            _api_mtime = m
    return ideas_api


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, "web"), **kw)

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


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server silently share a busy port. Bind exclusively instead.
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def is_busy(port):
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
    """True if this port serves «Штурм идей» for the same data folder."""
    if not is_busy(port):
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=0.5) as r:
            return json.loads(r.read()).get("data") == ideas_api.DATA
    except Exception:
        return False


def running_port():
    for p in range(PORT, PORT + 10):
        if probe(p):
            return p
    return None


def serve(open_browser):
    p = running_port()
    if p:
        url = f"http://localhost:{p}/"
        print(f"Уже запущено: {url}")
        if open_browser:
            webbrowser.open(url)
        return
    srv = None
    for p in range(PORT, PORT + 10):
        try:
            srv = Server(("127.0.0.1", p), H)
            break
        except OSError:
            print(f"Порт {p} занят — пробую следующий")
    if not srv:
        sys.exit(f"Нет свободного порта {PORT}–{PORT + 9}")
    with open(os.path.join(ideas_api.DATA, ".port"), "w") as f:
        f.write(str(p))
    url = f"http://localhost:{p}/"
    print(f"Штурм идей: {url}\nДанные: {ideas_api.DATA}\nClaude: {ideas_api.claude_bin() or 'не найден — кнопки ✨ выключены'}")
    if open_browser:
        webbrowser.open(url)
    threading.Thread(target=ticker, daemon=True).start()
    srv.serve_forever()


def ticker():
    """Once a minute: background duties of the API (bank auto-refresh from news sites)."""
    while True:
        time.sleep(60)
        try:
            a = api()
            if hasattr(a, "auto_tick"):
                a.auto_tick()
        except Exception as e:
            print("! автообновление банка:", e)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "port":
        print(running_port() or "")
    elif args and not args[0].startswith("-"):
        if not api().cli(args):
            sys.exit(f"неизвестная команда: {args[0]}")
    else:
        serve("--open" in args)
