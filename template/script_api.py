"""Раскадровка сценария: разбор script.md по сценам, правка сцен из браузера, заметки к сценарию, кадры из видео.

Страница: /src/script.html (тот же сервер ревью). Модуль подхватывается на лету, как review_api.py.

GET  /api/script            -> {preamble, blocks[], timing[], cfg, mtime}
POST /api/script            <- {op, i, hash, ...}: save | raw | move | insert | delete
                               (hash — отпечаток блока, который видел браузер; не совпал -> 409 и свежие данные)
GET  /api/script/version    -> mtime сценария, заметок, таймингов + статус озвучки
GET  /api/script/notes      -> заметки к сценарию
POST /api/script/notes      <- заметки; сливаются по полю `updated`, как у видео-заметок
POST /api/script/tts        -> запустить python tts.py в фоне
POST /api/ref?id=N&kind=script -> картинка-референс к заметке -> review/refs/sN_k.png (обработчик в review_api.py)
GET  /api/frame?t=&src=&w=  -> jpg-кадр из видео (кэш в build/script_frames/)

Файлы: script.md (сам сценарий), review/script_notes.{json,md}, review/script_trash.md (удалённые сцены),
review/refs/sN_k.* (картинки-референсы к заметкам; пути — в поле `refs` заметки).
CLI (через review_server.py): script-list, script-reply N "текст" [--done] [--field VO --from "…" --to "…"].
"""
import hashlib, json, os, re, subprocess, sys, threading, time
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(ROOT, "script.md")
REVIEW = os.path.join(ROOT, "review")
NOTES = os.path.join(REVIEW, "script_notes.json")
TIMING = os.path.join(ROOT, "build", "vo_timing.json")
FRAMES = os.path.join(ROOT, "build", "script_frames")   # not build/frames: render.js writes video frames there
TTS_LOG = os.path.join(ROOT, "build", "tts.log")

HEAD = re.compile(r"^(#{1,3})[ \t]+(.+?)[ \t]*$", re.M)
TIMECODE = re.compile(r"(\d+:\d{2}(?:\.\d+)?)\s*[–—-]\s*(\d+:\d{2}(?:\.\d+)?)")
# '**Картинка:** текст' | '**VO:**' | 'Голос: текст' | '- **Текст:** …'
FIELD = re.compile(r"^[ \t]*(?:[-*][ \t]+)?(\*\*)?([А-ЯЁA-Z][^:*\n>]{0,40}?)[ \t]*:[ \t]*(\*\*)?[ \t]*(.*)$")
VOICE_NAMES = ("vo", "голос")
PICTURE_NAMES = ("картинка", "визуал")
SETTINGS = re.compile(r"^\s*(voice|rate|произношение|вопрос|видео|хвост)\s*:", re.I)
_lock = threading.Lock()
_frame_sem = threading.Semaphore(3)
_tts = globals().get("_tts") or {"proc": None, "started": 0, "finished": 0, "rc": None}   # survives hot reload


def _hash(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:12]


# ---------------- parsing ----------------
def _field(line, bold_mode):
    """Match a field line. With any '**Поле:**' in the block only bold fields count (so 'Потом схема: …' inside
       a description stays text); plain 'Визуал: …' fields are the pipeline format (1–3 word names)."""
    if SETTINGS.match(line):
        return None
    m = FIELD.match(line)
    if not m:
        return None
    bold = bool(m.group(1) or m.group(3))
    if bold_mode and not bold:
        return None
    if not bold and len(m.group(2).split()) > 3:
        return None
    return m


def parse_fields(body):
    """Block body -> ordered list of {name, value, style} (name=None for free text we keep verbatim)."""
    lines = body.split("\n")
    bold_mode = bool(re.search(r"^[ \t]*(?:[-*][ \t]+)?\*\*[^*\n]{1,40}:[ \t]*\*\*", body, re.M))
    out, i = [], 0
    while i < len(lines):
        m = _field(lines[i], bold_mode)
        if m:
            bold = bool(m.group(1) or m.group(3))
            name, first = m.group(2).strip(), m.group(4)
            i += 1
            if not first.strip() and i < len(lines) and lines[i].lstrip().startswith(">"):
                q = []
                while i < len(lines) and lines[i].lstrip().startswith(">"):
                    q.append(re.sub(r"^\s*>\s?", "", lines[i]))
                    i += 1
                out.append({"name": name, "value": "\n".join(q), "style": "quote" + ("-bold" if bold else "")})
                continue
            val = [first]
            while i < len(lines) and lines[i].strip() and not _field(lines[i], bold_mode) \
                    and not re.match(r"^\s*(---+|\*\([^)]*\)\*|>.*)\s*$", lines[i]):
                val.append(lines[i])
                i += 1
            out.append({"name": name, "value": "\n".join(val).strip(), "style": "bold" if bold else "plain"})
            continue
        raw = [lines[i]]
        i += 1
        while i < len(lines) and not _field(lines[i], bold_mode):
            raw.append(lines[i])
            i += 1
        text = "\n".join(raw)
        if text.strip():
            out.append({"name": None, "value": text.strip("\n"), "style": "raw"})
    return out


def is_scene(title, fields):
    names = {(f["name"] or "").lower() for f in fields}
    if names & set(VOICE_NAMES):
        return any((f["name"] or "").lower() in VOICE_NAMES and f["value"].strip() for f in fields)
    return bool(TIMECODE.search(title) and names & set(PICTURE_NAMES))


def parse(text=None):
    if text is None:
        text = open(SCRIPT, encoding="utf-8").read() if os.path.exists(SCRIPT) else ""
    text = text.replace("\r\n", "\n")
    heads = [h for h in HEAD.finditer(text) if len(h.group(1)) >= 2]
    first = heads[0].start() if heads else len(text)
    blocks = []
    for k, h in enumerate(heads):
        end = heads[k + 1].start() if k + 1 < len(heads) else len(text)
        raw = text[h.start():end]
        # a trailing '---' separator belongs between blocks, not to the scene above it
        m = re.search(r"\n(---+)[ \t]*\n\s*$", raw)
        tail = ""
        if m:
            tail, raw = raw[m.start() + 1:], raw[:m.start() + 1]
        body = raw[h.end() - h.start():].lstrip("\n")
        title = h.group(2).strip()
        fields = parse_fields(body.rstrip("\n"))
        tc = TIMECODE.search(title)
        blocks.append({"level": len(h.group(1)), "title": title, "raw": raw, "hash": _hash(raw),
                       "fields": fields, "scene": is_scene(title, fields),
                       "tc": [tc.group(1), tc.group(2)] if tc else None,
                       "name": re.sub(r"^\s*" + TIMECODE.pattern + r"\s*[—–-]?\s*", "", title).strip() if tc else title})
        if tail:
            blocks.append({"level": 0, "title": "", "raw": tail, "hash": _hash(tail), "fields": [], "scene": False, "hr": True})
    return {"preamble": text[:first], "preamble_hash": _hash(text[:first]), "blocks": blocks}


def settings(preamble):
    cfg = {"voice": "", "rate": "", "pron": {}, "rise": [], "video": ""}
    for line in preamble.splitlines():
        m = re.match(r"\s*(voice|rate)\s*:\s*(.+)", line, re.I)
        if m:
            cfg[m.group(1).lower()] = m.group(2).strip()
        m = re.match(r"\s*вопрос\s*:\s*(.+)", line, re.I)
        if m:
            cfg["rise"].append(m.group(1).strip())
        m = re.match(r"\s*произношение\s*:\s*(.+?)\s*=\s*(.+)", line, re.I)
        if m:
            cfg["pron"][m.group(1).strip()] = m.group(2).strip()
        m = re.match(r"\s*видео\s*:\s*(.+)", line, re.I)
        if m:
            cfg["video"] = m.group(1).strip()
    return cfg


def render_block(b, title, fields):
    """Serialize an edited scene back to markdown, keeping each field's original style."""
    out = ["#" * (b.get("level") or 3) + " " + title.strip()]
    for f in fields:
        name, val, st = f.get("name"), (f.get("value") or "").rstrip(), f.get("style") or "bold"
        if name is None:
            if val.strip():
                out.append(val)
            continue
        b1 = "**" if "bold" in st else ""
        if st.startswith("quote"):
            q = [l for l in val.split("\n")] or [""]
            out.append(f"{b1}{name}:{b1}")
            out += ["> " + l if l.strip() else ">" for l in q]
        else:
            out.append(f"{b1}{name}:{b1} {val}".rstrip())
    raw = b.get("raw") or ""
    trail = raw[len(raw.rstrip("\n")):] or "\n\n"          # keep the block's original blank-line tail
    return "\n".join(out) + trail


def new_scene(level, style_bold=True):
    b = "**" if style_bold else ""
    return (f"{'#' * level} НОВАЯ СЦЕНА\n{b}Картинка:{b} что в кадре\n{b}Текст:{b} —\n"
            f"{b}VO:{b}\n> Текст диктора.\n\n")


# ---------------- timing (build/vo_timing.json) ----------------
def _norm(s):
    return re.sub(r"[^\wё]", "", s.lower())


def voice_text(fields):
    for f in fields:
        if (f["name"] or "").lower() in VOICE_NAMES:
            v = re.sub(r"\*\([^)]*\)\*", " ", f["value"])
            return re.sub(r"\s+", " ", re.sub(r"[*_]{1,2}", "", v)).strip()
    return ""


def timing(doc):
    """Per scene block: start/dur/audio from the last tts run, and whether its text changed since."""
    if not os.path.exists(TIMING):
        return {}
    try:
        secs = json.load(open(TIMING, encoding="utf-8")).get("sections", [])
    except Exception:
        return {}
    scenes = [k for k, b in enumerate(doc["blocks"]) if b["scene"]]
    res = {}
    for n, k in enumerate(scenes):
        if n >= len(secs):
            break
        s, b = secs[n], doc["blocks"][k]
        spoken = "".join(w["w"] for w in s.get("words", []))
        vt = voice_text(b["fields"])
        stale = (_norm(spoken) != _norm(vt)) if not s.get("silent") else bool(vt)
        res[k] = {"start": s["start"], "dur": s["dur"], "file": "/" + s.get("file", "").replace("\\", "/"),
                  "silent": bool(s.get("silent")), "stale": stale}
    return res


# ---------------- script edits ----------------
def _write(doc, blocks=None, preamble=None):
    blocks = doc["blocks"] if blocks is None else blocks
    text = (doc["preamble"] if preamble is None else preamble) + "".join(b["raw"] for b in blocks)
    tmp = SCRIPT + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, SCRIPT)


def payload():
    doc = parse()
    return {"preamble": doc["preamble"], "preamble_hash": doc["preamble_hash"], "blocks": doc["blocks"],
            "timing": timing(doc), "cfg": settings(doc["preamble"]),
            "mtime": os.path.getmtime(SCRIPT) if os.path.exists(SCRIPT) else 0, "root": os.path.basename(ROOT)}


def apply_op(op):
    with _lock:
        doc = parse()
        blocks = doc["blocks"]
        i = op.get("i")
        kind = op.get("op")
        if kind == "preamble":
            if op.get("hash") != doc["preamble_hash"]:
                return 409, payload()
            _write(doc, preamble=op["raw"].rstrip("\n") + "\n\n")
            return 200, payload()
        if kind == "insert":
            after = i if i is not None else len(blocks) - 1
            lvl = next((b["level"] for b in blocks if b["scene"]), 3)
            bold = any(f["style"] != "plain" for b in blocks if b["scene"] for f in b["fields"] if f["name"])
            raw = new_scene(lvl, bold)
            blocks.insert(after + 1, {"raw": raw})
            _write(doc, blocks)
            return 200, payload()
        if i is None or not (0 <= i < len(blocks)) or blocks[i]["hash"] != op.get("hash"):
            return 409, payload()
        b = blocks[i]
        if kind == "save":
            b["raw"] = render_block(b, op.get("title", b["title"]), op.get("fields", b["fields"]))
        elif kind == "raw":
            r = op["raw"].rstrip("\n") + "\n\n"
            b["raw"] = r
        elif kind == "delete":
            with open(os.path.join(REVIEW, "script_trash.md"), "a", encoding="utf-8") as f:
                f.write(f"<!-- удалено {time.strftime('%Y-%m-%d %H:%M:%S')} -->\n{b['raw']}\n")
            blocks.pop(i)
        elif kind == "move":
            d = 1 if op.get("dir", 1) > 0 else -1
            j = i + d                                   # jump over separators / non-scene blocks to the next scene
            while 0 <= j < len(blocks) and not blocks[j]["scene"]:
                j += d
            if not (0 <= j < len(blocks)):
                return 200, payload()
            blocks[i], blocks[j] = blocks[j], blocks[i]
        else:
            return 400, {"error": "unknown op"}
        _write(doc, blocks)
        return 200, payload()


# ---------------- notes ----------------
ACTIONS = {"factcheck": "🔎 Фактчек", "rewrite": "✍️ Переписать текст", "visual": "🎨 Картинка / раскадровка",
           "comment": "💬 Заметка"}


def load_notes():
    return json.load(open(NOTES, encoding="utf-8")) if os.path.exists(NOTES) else []


def save_notes(notes):
    os.makedirs(REVIEW, exist_ok=True)
    with open(NOTES, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=1)
    with open(os.path.join(REVIEW, "script_notes.md"), "w", encoding="utf-8") as f:
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
    L = ["# Правки сценария", "",
         f"Всего: {len(live)}, открытых: {len(open_n)}. Обновлено: {time.strftime('%Y-%m-%d %H:%M:%S')}",
         "Ответ: `python review_server.py script-reply N \"что сделано\" --done`; предложить замену текста, "
         "которую пользователь применит кнопкой: `--field VO --from \"старый кусок\" --to \"новый\"`.", ""]
    for n in sorted(live, key=lambda n: (n.get("status") == "done", n.get("scene") if n.get("scene") is not None else -1, n["id"])):
        st = "✅ сделано" if n.get("status") == "done" else "🔴 открыта"
        where = f"сцена {n['scene'] + 1} «{n.get('sceneName', '')}»" if n.get("scene") is not None else "весь сценарий"
        L.append(f"## #{n['id']} · {ACTIONS.get(n.get('action'), n.get('action', ''))} · {where} · {st}")
        if n.get("field"):
            L.append(f"- Поле: {n['field']}")
        if n.get("quote"):
            L.append("- Фрагмент:")
            L += ["  > " + l for l in n["quote"].splitlines()]
        if n.get("refs"):
            L.append("- Референсы (картинки от пользователя, посмотри их): " + ", ".join(n["refs"]))
        L.append("")
        L.append(n.get("text", "").strip() or "_(без комментария)_")
        for r in n.get("replies", []):
            L.append(f"> **{r.get('who', '')}**: " + r.get("text", "").replace("\n", "\n> "))
            if r.get("suggest"):
                s = r["suggest"]
                L.append(f"> ↳ предложена замена в «{s.get('field', '')}»: «{s.get('from', '')}» → «{s.get('to', '')}»"
                         + (" (применена)" if s.get("applied") else ""))
                if s.get("orig") and s["orig"] != s.get("to"):
                    L.append(f"> ↳ пользователь поправил вариант Claude «{s['orig']}»")
        L.append("")
    return "\n".join(L)


def reply(nid, text, done=False, suggest=None):
    notes = load_notes()
    for n in notes:
        if n["id"] == nid:
            r = {"who": "Claude", "text": text, "at": int(time.time() * 1000)}
            if suggest:
                r["suggest"] = suggest
            n.setdefault("replies", []).append(r)
            if done:
                n["status"] = "done"
            n["updated"] = int(time.time() * 1000)
            save_notes(notes)
            return True
    return False


# ---------------- tts ----------------
def tts_status():
    p = _tts["proc"]
    running = p is not None and p.poll() is None
    if p is not None and not running and _tts["rc"] is None:
        _tts["rc"], _tts["finished"] = p.returncode, time.time()
    tail = ""
    if os.path.exists(TTS_LOG):
        with open(TTS_LOG, encoding="utf-8", errors="replace") as f:
            tail = "".join(f.readlines()[-6:])
    return {"running": running, "rc": _tts["rc"], "started": _tts["started"], "finished": _tts["finished"], "log": tail}


def tts_start():
    if tts_status()["running"]:
        return False
    os.makedirs(os.path.dirname(TTS_LOG), exist_ok=True)
    log = open(TTS_LOG, "w", encoding="utf-8")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PYTHONUNBUFFERED="1")
    _tts.update(proc=subprocess.Popen([sys.executable, "tts.py"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env),
                started=time.time(), finished=0, rc=None)
    return True


# ---------------- frames from reference video ----------------
def resolve_video(src):
    if not src:
        src = settings(parse()["preamble"])["video"]
    if not src:
        return None
    src = src.strip().strip('"')
    for base in ("", ROOT, os.path.join(ROOT, "refs")):
        p = os.path.join(base, src) if base else src
        if os.path.isfile(p):
            return os.path.abspath(p)
    return None


def frame(src, t, w):
    path = resolve_video(src)
    if not path:
        return None
    os.makedirs(FRAMES, exist_ok=True)
    out = os.path.join(FRAMES, f"{_hash(path)}_{t:.2f}_{w}.jpg")
    if not os.path.exists(out):
        with _frame_sem:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1",
                            "-vf", f"scale={w}:-2", "-q:v", "4", out], capture_output=True)
    return out if os.path.exists(out) else None


# ---------------- HTTP ----------------
def handle_get(h, send_file):
    u = urlparse(h.path)
    if u.path == "/api/script":
        h._json(payload()); return True
    if u.path == "/api/script/version":
        g = lambda p: os.path.getmtime(p) if os.path.exists(p) else 0
        h._json({"s": g(SCRIPT), "n": g(NOTES), "t": g(TIMING), "tts": tts_status()}); return True
    if u.path == "/api/script/notes":
        h._json(load_notes()); return True
    if u.path == "/api/frame":
        q = parse_qs(u.query)
        try:
            t = float(q.get("t", ["0"])[0]); w = max(80, min(1920, int(q.get("w", ["480"])[0])))
        except ValueError:
            h.send_error(400); return True
        f = frame(q.get("src", [""])[0], t, w)
        if not f:
            h.send_error(404, "video not found (header line «видео: путь» in script.md)"); return True
        send_file(h, f); return True
    return False


def handle_post(h):
    u = urlparse(h.path)
    if u.path == "/api/script":
        code, data = apply_op(json.loads(h._body()))
        h._json(data, code); return True
    if u.path == "/api/script/notes":
        merged = merge(load_notes(), json.loads(h._body()))
        save_notes(merged)
        h._json({"ok": True, "notes": merged}); return True
    if u.path == "/api/script/tts":
        h._json({"started": tts_start(), **tts_status()}); return True
    return False


def cli(argv):
    cmd = argv[0]
    if cmd == "script-list":
        for n in load_notes():
            if n.get("deleted") or n.get("status") == "done":
                continue
            where = f"сцена {n['scene'] + 1}" if n.get("scene") is not None else "весь сценарий"
            print(f"#{n['id']} [{ACTIONS.get(n.get('action'), '')}] {where}: {n.get('text', '')}"
                  + (f"  «{n['quote'][:60]}»" if n.get("quote") else ""))
        return True
    if cmd == "script-reply":
        nid, text = int(argv[1]), argv[2]
        opt = lambda k: argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else None
        sug = None
        if opt("--to") is not None:
            sug = {"field": opt("--field") or "VO", "from": opt("--from") or "", "to": opt("--to")}
        if not reply(nid, text, "--done" in argv, sug):
            sys.exit(f"нет правки сценария #{nid}")
        print("ok", nid)
        return True
    return False
