"""Логика сервера ревью (заметки, библиотека звуков, описания правок для Claude).

Этот модуль review_server.py перезагружает сам, как только файл меняется: обновления пайплайна
подхватываются без перезапуска окна сервера. Поднимай API_VERSION, когда меняется то,
от чего зависит страница ревью (она покажет плашку «перезапусти сервер», если версия старая).

POST /api/ref?id=N[&kind=script]  <- картинка-референс к заметке (сырые байты или dataURL, png/jpg/webp/gif, до 10 МБ)
                                     -> {path: "review/refs/N_k.png"}; для заметок сценария — review/refs/sN_k.png.
                                     Путь страница сама пишет в поле `refs` заметки; notes.md перечисляет эти файлы.
"""
import base64, importlib, json, os, re, threading, time
from urllib.parse import urlparse, parse_qs, unquote

API_VERSION = 5

ROOT = os.path.dirname(os.path.abspath(__file__))
REVIEW = os.path.join(ROOT, "review")
SHOTS = os.path.join(REVIEW, "shots")
NOTES = os.path.join(REVIEW, "notes.json")
REFS = os.path.join(REVIEW, "refs")                  # картинки-референсы к заметкам (видео и сценария)
REF_MAX = 10 * 1024 * 1024
WATCH = [os.path.join(ROOT, "src"), os.path.join(ROOT, "build", "mix.wav"), os.path.join(ROOT, "build", "sfx_resolved.json")]
SFX_LIB = os.environ.get("SFX_LIBRARY") or os.path.join(os.path.dirname(ROOT), "_pipeline", "sfx_library")
MIME = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".json": "application/json; charset=utf-8",
        ".md": "text/markdown; charset=utf-8", ".html": "text/html; charset=utf-8"}
os.makedirs(SHOTS, exist_ok=True)

import script_api  # noqa: E402  раскадровка сценария (/src/script.html); тоже перезагружается на лету
_script_mtime = os.path.getmtime(script_api.__file__)


def sapi():
    """script_api, reloaded when its file changes (review_server reloads only this module)."""
    global _script_mtime
    m = os.path.getmtime(script_api.__file__)
    if m != _script_mtime:
        try:
            importlib.reload(script_api)
            print("script_api перезагружен")
        except Exception as e:
            print("! script_api не загрузился:", e)
        _script_mtime = m
    return script_api


def cli(argv):
    """Extra CLI commands (review_server.py forwards everything it doesn't know)."""
    return sapi().cli(argv)


def fmt(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


# ---------------- notes ----------------
def load():
    return json.load(open(NOTES, encoding="utf-8")) if os.path.exists(NOTES) else []


def save(notes):
    with open(NOTES, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=1)
    with open(os.path.join(REVIEW, "notes.md"), "w", encoding="utf-8") as f:
        f.write(notes_md(notes))


def merge(server, client):
    """Per note, the version with the newer `updated` wins (so nobody's edits get overwritten)."""
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
        if n.get("refs"):
            lines.append(ref_line(n))
        lines.append("")
        lines.append(n.get("text", "").strip() or "_(пусто)_")
        for r in n.get("replies", []):
            lines.append(f"> **{r.get('who', '')}**: {r.get('text', '')}")
        lines.append("")
    return "\n".join(lines)


def ref_line(n):
    """'- Референсы: …' for notes.md (script_api uses it too)."""
    return "- Референсы (картинки от пользователя, посмотри их): " + ", ".join(n["refs"])


# ---------------- reference images ----------------
_ref_lock = threading.Lock()


def ref_ext(data):
    """File type by magic bytes (the browser's Content-Type is not trusted)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def save_ref(nid, data, kind=""):
    """Image bytes -> review/refs/<N>_<k>.<ext> (script notes: s<N>_<k>). Never overwrites; returns the project-relative path."""
    if data[:5] == b"data:":                      # dataURL, as /api/shot gets it
        data = base64.b64decode(data.split(b",", 1)[1])
    if len(data) > REF_MAX:
        raise ValueError(f"картинка больше {REF_MAX // 2**20} МБ")
    ext = ref_ext(data)
    if not ext:
        raise ValueError("это не картинка png/jpg/webp/gif")
    prefix = ("s" if kind == "script" else "") + f"{int(nid)}_"
    os.makedirs(REFS, exist_ok=True)
    with _ref_lock:
        ks = [int(m.group(1)) for f in os.listdir(REFS) if (m := re.match(re.escape(prefix) + r"(\d+)\.", f))]
        name = f"{prefix}{max(ks, default=0) + 1}.{ext}"
        with open(os.path.join(REFS, name), "xb") as f:
            f.write(data)
    return f"review/refs/{name}"


def sfx_lines(n):
    """Readable description of a sound note (kind='sfx') for Claude."""
    s = n.get("sfx") or {}
    out = []
    if s.get("new"):
        out.append(f"- 🔊 **Добавить звук** `{s.get('replace')}` в {fmt(n['t'])} (сцена {n.get('scene', '?')})"
                   + (f", громкость {s['gainDb']:+.0f} dB" if s.get("gainDb") else "") + (", пик на этот момент" if s.get("align") == "peak" else ""))
        return out
    cue = f"cue #{s.get('i')} · `{s.get('type')}`" + (f" (играет `{s.get('src')}`)" if s.get("src") and s.get("src") != s.get("type") else "")
    where = (f"автоматический вжух перехода в сцену {(s.get('scene') or 0) + 1} (main.js; отключить — noWhoosh, заменить — TRANS_WHOOSH или свой add() в sfx сцены)"
             if s.get("origin") == "transition" else f"сцена {(s.get('scene') or 0) + 1}, scenes.js → sfx(add)")
    out.append(f"- 🔊 Звук: {cue} · t={s.get('t')} · gain {s.get('gain')} · {where}")
    acts = []
    if s.get("delete"):
        acts.append("**удалить**")
    if s.get("replace"):
        acts.append(f"**заменить** на `{s['replace']}`" + (" (пик на этот момент)" if s.get("replaceAlign") == "peak" else ""))
    if s.get("gainDb"):
        acts.append(f"**громкость {s['gainDb']:+.0f} dB** (множитель ×{10 ** (s['gainDb'] / 20):.2f})")
    if acts:
        out.append("- Действие: " + ", ".join(acts))
    return out


def reply(nid, text, done=False):
    notes = load()
    for n in notes:
        if n["id"] == nid:
            n.setdefault("replies", []).append({"who": "Claude", "text": text})
            if done:
                n["status"] = "done"
            n["updated"] = int(time.time() * 1000)
            save(notes)
            return True
    return False


# ---------------- HTTP ----------------
def _send_file(h, path):
    data = open(path, "rb").read()
    h.send_response(200)
    h.send_header("Content-Type", MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))
    h.send_header("Content-Length", str(len(data)))
    h.end_headers()
    h.wfile.write(data)


# frame-affecting code: everything in src/ except the review / storyboard page code
_NOT_FRAMES = {"review.js", "review.html", "script.js", "script.html", "refs.js"}


def video_info():
    out = os.path.join(ROOT, "out")
    vids = [f for f in (os.listdir(out) if os.path.isdir(out) else []) if f.lower().endswith(".mp4") and "_NO_VO" not in f]
    if not vids:
        return {"url": None}
    v = max(vids, key=lambda f: os.path.getmtime(os.path.join(out, f)))
    vm = os.path.getmtime(os.path.join(out, v))
    src = os.path.join(ROOT, "src")
    code = max([os.path.getmtime(os.path.join(src, f)) for f in os.listdir(src)
                if f.endswith((".js", ".html")) and f not in _NOT_FRAMES] + [0])
    return {"url": "/out/" + v, "mtime": vm, "code": code, "stale": code > vm + 1}


def _send_range(h, f):
    """Static file with HTTP Range support: without it the browser cannot seek in a video."""
    size = os.path.getsize(f)
    rng = h.headers.get("Range")
    a, b = 0, size - 1
    if rng and rng.startswith("bytes="):
        x, _, y = rng[6:].split(",")[0].partition("-")
        if x: a = int(x); b = int(y) if y else size - 1
        else: a = max(0, size - int(y))
        b = min(b, size - 1)
        h.send_response(206); h.send_header("Content-Range", f"bytes {a}-{b}/{size}")
    else:
        h.send_response(200)
    h.send_header("Content-Type", "video/mp4"); h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(b - a + 1)); h.end_headers()
    try:
        with open(f, "rb") as fh:
            fh.seek(a); left = b - a + 1
            while left > 0:
                chunk = fh.read(min(1 << 20, left))
                if not chunk: break
                h.wfile.write(chunk); left -= len(chunk)
    except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
        pass


def handle_get(h):
    """Return True if the request was handled here (otherwise the static file handler serves it)."""
    u = urlparse(h.path)
    if u.path == "/":
        h.send_response(302); h.send_header("Location", "/src/review.html"); h.end_headers(); return True
    if u.path == "/api/notes":
        h._json(load()); return True
    if u.path == "/api/version":
        m = 0
        for w in WATCH:
            if os.path.isdir(w):
                for f in os.listdir(w):
                    m = max(m, os.path.getmtime(os.path.join(w, f)))
            elif os.path.exists(w):
                m = max(m, os.path.getmtime(w))
        h._json({"v": m, "n": os.path.getmtime(NOTES) if os.path.exists(NOTES) else 0,
                 "root": os.path.basename(ROOT), "api": API_VERSION,
                 "sfxlib": os.path.exists(os.path.join(SFX_LIB, "index.json"))})
        return True
    if u.path == "/api/video":                       # the rendered short: the review page plays it instead of drawing live
        h._json(video_info()); return True
    if u.path.startswith("/out/") and u.path.lower().endswith(".mp4"):
        rel = os.path.normpath(unquote(u.path[1:])).replace("\\", "/")
        f = os.path.join(ROOT, rel)
        if rel.startswith("..") or not os.path.isfile(f):
            h.send_error(404, rel); return True
        _send_range(h, f); return True
    if u.path.startswith(("/api/script", "/api/frame")):
        return sapi().handle_get(h, _send_file)
    if u.path.startswith("/sfxlib/"):                 # shared sound library (_pipeline/sfx_library)
        rel = os.path.normpath(unquote(u.path[len("/sfxlib/"):])).replace("\\", "/")
        f = os.path.join(SFX_LIB, rel)
        if rel.startswith("..") or os.path.isabs(rel) or not os.path.isfile(f):
            h.send_error(404, "sound library: " + rel); return True
        _send_file(h, f); return True
    return False


def handle_post(h):
    u = urlparse(h.path)
    if u.path.startswith("/api/script"):
        return sapi().handle_post(h)
    if u.path == "/api/notes":
        merged = merge(load(), json.loads(h._body()))
        save(merged)
        h._json({"ok": True, "n": os.path.getmtime(NOTES), "notes": merged}); return True
    if u.path == "/api/ref":
        q = parse_qs(u.query)
        nid = re.sub(r"\D", "", q.get("id", [""])[0])
        size = int(h.headers.get("Content-Length", 0))
        if not nid:
            h._json({"error": "нет id заметки"}, 400); return True
        if size > REF_MAX * 4 // 3 + 4096:        # base64 is 4/3 of the file
            h._json({"error": f"картинка больше {REF_MAX // 2**20} МБ"}, 413); return True
        try:
            path = save_ref(nid, h._body(), q.get("kind", [""])[0])
        except (ValueError, IndexError, base64.binascii.Error) as e:
            h._json({"error": str(e) or "не картинка"}, 400); return True
        h._json({"ok": True, "path": path}); return True
    if u.path == "/api/shot":
        nid = re.sub(r"\D", "", parse_qs(u.query).get("id", ["0"])[0])
        data = h._body().decode().split(",", 1)[1]
        with open(os.path.join(SHOTS, f"{nid}.png"), "wb") as f:
            f.write(base64.b64decode(data))
        h._json({"ok": True}); return True
    return False
