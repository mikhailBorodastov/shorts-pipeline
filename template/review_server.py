"""Локальный сервер ревью: статика проекта + API заметок.

    python review_server.py [--open]             -> http://localhost:8765/src/review.html
                                                    (порт занят другим проектом — берёт 8766, 8767, …;
                                                     выбранный порт пишет в build/.review_port)
    python review_server.py port                  (порт уже запущенного сервера этого проекта)
    python review_server.py reply 3 "текст" --done   (ответ на правку #3 и отметка «сделано»)
    python review_server.py list                  (открытые правки в консоль)

GET  /api/notes        -> список заметок
POST /api/notes        <- заметки из браузера; СЛИВАЮТСЯ с файлом по полю `updated`
                          (у каждой заметки побеждает более свежая версия), ответ — итоговый список
POST /api/shot?id=N    <- dataURL png -> review/shots/N.png
GET  /api/version      -> mtime исходников (авто-перезагрузка) и заметок

Файлы: review/notes.json (данные), review/notes.md (читаемая версия для Claude).
Удалённые заметки не стираются, а помечаются deleted=true — так удаление тоже «сливается».
"""
import base64, json, os, re, socket, sys, time, urllib.request, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
REVIEW = os.path.join(ROOT, "review")
SHOTS = os.path.join(REVIEW, "shots")
NOTES = os.path.join(REVIEW, "notes.json")
WATCH = [os.path.join(ROOT, "src"), os.path.join(ROOT, "build", "mix.wav")]
PORT = int(os.environ.get("REVIEW_PORT", "8765"))
SFX_LIB = os.environ.get("SFX_LIBRARY") or os.path.join(os.path.dirname(ROOT), "_pipeline", "sfx_library")
MIME = {".wav": "audio/wav", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".html": "text/html; charset=utf-8"}
os.makedirs(SHOTS, exist_ok=True)


def fmt(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def load():
    return json.load(open(NOTES, encoding="utf-8")) if os.path.exists(NOTES) else []


def save(notes):
    with open(NOTES, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=1)
    with open(os.path.join(REVIEW, "notes.md"), "w", encoding="utf-8") as f:
        f.write(notes_md(notes))


def merge(server, client):
    by_id = {n["id"]: n for n in server}
    for n in client:
        cur = by_id.get(n["id"])
        if cur is None or n.get("updated", 0) >= cur.get("updated", 0):
            by_id[n["id"]] = n
    return sorted(by_id.values(), key=lambda n: n["id"])


def notes_md(notes):
    live = [n for n in notes if not n.get("deleted")]
    open_n = [n for n in live if n.get("status") != "done"]
    lines = ["# Правки", "",
             f"Всего: {len(live)}, открытых: {len(open_n)}. Обновлено: {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    for n in sorted(live, key=lambda n: n["t"]):
        rng = f" – {fmt(n['t2'])}" if n.get("t2") else ""
        st = "✅ сделано" if n.get("status") == "done" else "🔴 открыта"
        lines.append(f"## #{n['id']} · {fmt(n['t'])}{rng} · сцена {n.get('scene', '?')} «{n.get('sceneName', '')}» · {st}")
        if n.get("x") is not None:
            lines.append(f"- Точка на кадре: x={round(n['x'])}, y={round(n['y'])} (из 1080×1920)")
        if n.get("caption"):
            lines.append(f"- Субтитр в этот момент: «{n['caption']}»")
        if n.get("kind") == "sfx":
            lines += sfx_lines(n)
        else:
            lines.append(f"- Скрин: review/shots/{n['id']}.png")
        lines.append("")
        lines.append(n.get("text", "").strip() or "_(пусто)_")
        for r in n.get("replies", []):
            lines.append(f"> **{r.get('who', '')}**: {r.get('text', '')}")
        lines.append("")
    return "\n".join(lines)


def sfx_lines(n):
    """Readable description of a sound note (kind='sfx') for Claude."""
    s = n.get("sfx") or {}
    out = []
    if s.get("new"):
        out.append(f"- 🔊 **Добавить звук** `{s.get('replace')}` в {fmt(n['t'])} (сцена {n.get('scene', '?')})"
                   + (f", громкость {s['gainDb']:+.0f} dB" if s.get("gainDb") else "") + (", пик на этот момент" if s.get("align") == "peak" else ""))
        return out
    cue = f"cue #{s.get('i')} · `{s.get('type')}`" + (f" (играет `{s.get('src')}`)" if s.get("src") and s.get("src") != s.get("type") else "")
    where = (f"автоматический вжух перехода в сцену {(s.get('scene') or 0) + 1} (main.js; отключить — noWhoosh, заменить — свой add() в sfx сцены)"
             if s.get("origin") == "transition" else f"сцена {(s.get('scene') or 0) + 1}, scenes.js → sfx(add)")
    out.append(f"- 🔊 Звук: {cue} · t={s.get('t')} · gain {s.get('gain')} · {where}")
    acts = []
    if s.get("delete"):
        acts.append("**удалить**")
    if s.get("replace"):
        acts.append(f"**заменить** на `{s['replace']}`")
    if s.get("gainDb"):
        acts.append(f"**громкость {s['gainDb']:+.0f} dB** (множитель ×{10 ** (s['gainDb'] / 20):.2f})")
    if acts:
        out.append("- Действие: " + ", ".join(acts))
    return out


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
        u = urlparse(self.path)
        if u.path == "/":
            self.send_response(302); self.send_header("Location", "/src/review.html"); self.end_headers(); return
        if u.path == "/api/notes":
            return self._json(load())
        if u.path.startswith("/sfxlib/"):                 # shared sound library (_pipeline/sfx_library)
            rel = os.path.normpath(unquote(u.path[len("/sfxlib/"):])).replace("\\", "/")
            f = os.path.join(SFX_LIB, rel)
            if rel.startswith("..") or not os.path.isfile(f):
                return self.send_error(404)
            data = open(f, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(os.path.splitext(f)[1].lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/api/version":
            m = 0
            for w in WATCH:
                if os.path.isdir(w):
                    for f in os.listdir(w):
                        m = max(m, os.path.getmtime(os.path.join(w, f)))
                elif os.path.exists(w):
                    m = max(m, os.path.getmtime(w))
            return self._json({"v": m, "n": os.path.getmtime(NOTES) if os.path.exists(NOTES) else 0, "root": os.path.basename(ROOT)})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/notes":
            merged = merge(load(), json.loads(self._body()))
            save(merged)
            return self._json({"ok": True, "n": os.path.getmtime(NOTES), "notes": merged})
        if u.path == "/api/shot":
            nid = re.sub(r"\D", "", parse_qs(u.query).get("id", ["0"])[0])
            data = self._body().decode().split(",", 1)[1]
            with open(os.path.join(SHOTS, f"{nid}.png"), "wb") as f:
                f.write(base64.b64decode(data))
            return self._json({"ok": True})
        self.send_error(404)


def cli():
    cmd = sys.argv[1]
    notes = load()
    if cmd == "list":
        for n in sorted(notes, key=lambda n: n["t"]):
            if n.get("deleted") or n.get("status") == "done":
                continue
            print(f"#{n['id']} [{fmt(n['t'])}{' – ' + fmt(n['t2']) if n.get('t2') else ''}] "
                  f"{n.get('sceneName', '')}: {n.get('text', '')}")
    elif cmd == "reply":
        nid, text = int(sys.argv[2]), sys.argv[3]
        for n in notes:
            if n["id"] == nid:
                n.setdefault("replies", []).append({"who": "Claude", "text": text})
                if "--done" in sys.argv:
                    n["status"] = "done"
                n["updated"] = int(time.time() * 1000)
                save(notes); print("ok", nid); return
        sys.exit(f"нет правки #{nid}")


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server silently share a busy port (and the old one keeps
    # answering). Bind exclusively instead, so a busy port fails loudly and we move to the next one.
    allow_reuse_address = False

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


def serve(open_browser):
    p = running_port()
    if p:                                    # this project is already being served
        url = f"http://localhost:{p}/src/review.html"
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
    url = f"http://localhost:{p}/src/review.html"
    print(f"Ревью «{os.path.basename(ROOT)}»: {url}")
    if open_browser:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "port":           # port of this project's running server (empty if none)
        print(running_port() or "")
    elif args and args[0] in ("list", "reply"):
        cli()
    else:
        serve("--open" in args)
