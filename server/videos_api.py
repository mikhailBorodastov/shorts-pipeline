"""S12.2 — страница «Видео» и поп-ап «Новое видео» (docs/studio/stage12-redesign.md §3–4).

GET  /api/videos/extra            -> {id: {scenes, len, ready, cover, outs}}   карточки: сцены, длина, есть ли рендер, обложка
GET  /api/videos/cover?id=…       -> картинка карточки: обложка (out/thumbnail_1) | первый кадр ролика (ffmpeg, кэш) | кадр первой сцены
POST /api/videos/open             <- {id, sub?}       открыть папку видео в проводнике (только внутри папки видео)
POST /api/videos/create           <- {name, mode, delivery, look, len, topic, script, direction, refs[]}  -> {id}
POST /api/videos/voice?id=&name=  <- сырые байты     озвучка из поп-апа -> <видео>/refs/voice/ (нарезка — на шаге «Озвучка»)
POST /api/videos/brief            <- {id, …brief}    поправить бриф (поля поп-апа) — контекст для Claude пересобирается
POST /api/videos/snap             <- {id, t}         📷 кадр ролика -> out/shots/shot-<t>.png
"""
import glob
import json
import os
import re
import subprocess
import threading
import time
import uuid

import paths as P

_lock = threading.Lock()
COVERS = os.path.join(P.STATE, "cache", "covers")
AUDIO = (".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac")


# ---------------------------------------------------------------- карточки
def _outs(vdir):
    """Готовые ролики видео: out/*.mp4, новые первыми."""
    return sorted(glob.glob(os.path.join(vdir, "out", "*.mp4")), key=os.path.getmtime, reverse=True)


def _script_scenes(vdir):
    """Сцен в script.md: формат сценариста (### 0:00–0:04 — …) или шаблона (## …). Заглушка шаблона не считается."""
    p = os.path.join(vdir, "script.md")
    try:
        with open(p, encoding="utf-8") as f:
            t = f.read()
    except OSError:
        return 0
    if "Зачем ежу иголки" in t[:400]:
        return 0
    n = len(re.findall(r"(?m)^###\s+\d", t))
    return n or len(re.findall(r"(?m)^##\s+\S", t))


def extra(A, d):
    """Что нужно карточке кроме plan_summary."""
    vdir = P.video(d["id"]) if not P.legacy() else None
    els = [e for e in d.get("elements") or [] if e.get("kind") == "scene" and e.get("status") != "drop"]
    mt = d.get("montage") or {}
    scenes = len(mt.get("units") or []) or len(els) or (_script_scenes(vdir) if vdir else 0)
    outs = _outs(vdir) if vdir else []
    return {"scenes": scenes, "len": mt.get("len") or 0, "ready": bool(outs), "outs": len(outs),
            "cover": bool(vdir and _cover_src(A, d, vdir)), "step": _step(A, d, vdir, mt)}


def _step(A, d, vdir, mt):
    """Этап по факту, как пайплайн окна видео (S12.13), а не «последний открытый»: бриф → сценарий → препродакшен → монтаж → упаковка."""
    if d.get("stage") == "brief":
        return "brief"
    if not vdir or not os.path.isfile(os.path.join(vdir, "script.md")):
        return "script"
    try:
        if A.mnapi().script_state(d["id"]).get("template"):
            return "script"
    except Exception:
        pass
    live = [e for e in d.get("elements") or [] if e.get("status") != "drop"]
    if not live or any(e.get("status") != "ok" for e in live):
        return "pre"
    if not (mt.get("units") or []):
        return "montage"
    return "pack"


def _thumb_file(vdir):
    for n in ("thumbnail_1.jpg", "thumbnail_1.png", "thumbnail.jpg", "thumbnail.png"):
        f = os.path.join(vdir, "out", n)
        if os.path.isfile(f):
            return f
    fs = sorted(glob.glob(os.path.join(vdir, "out", "*_thumbnail.*")), key=os.path.getmtime, reverse=True)
    return fs[0] if fs else None


def _scene_img(d):
    """Кадр первой сцены препродакшена (последняя версия черновика)."""
    for kinds in (("scene",), ("char", "prop")):
        for e in d.get("elements") or []:
            if e.get("kind") in kinds and e.get("status") != "drop":
                for r in reversed(e.get("renders") or []):
                    if r.get("img"):
                        f = P.resolve(r["img"])
                        if os.path.isfile(f):
                            return f
    return None


def _cover_src(A, d, vdir):
    """('file', путь) | ('mp4', путь) | None — в порядке: обложка → первый кадр ролика → кадр сцены."""
    pick = ((d.get("pack") or {}).get("thumb") or "")      # S12.9: «Сделать обложкой» на доске
    if pick and os.path.isfile(os.path.join(vdir, "out", pick)):
        return ("file", os.path.join(vdir, "out", pick))
    t = _thumb_file(vdir)
    if t:
        return ("file", t)
    outs = _outs(vdir)
    if outs:
        return ("mp4", outs[0])
    s = _scene_img(d)
    return ("file", s) if s else None


def cover_path(A, vid):
    d = A.load("plan:" + vid)
    vdir = P.video(vid)
    src = vdir and _cover_src(A, d, vdir)
    if not src:
        return None
    kind, f = src
    if kind == "file":
        return f
    os.makedirs(COVERS, exist_ok=True)                 # первый кадр ролика: ffmpeg один раз, пока mp4 не сменится
    out = os.path.join(COVERS, f"{vid}-{int(os.path.getmtime(f))}.jpg")
    if not os.path.isfile(out):
        with _lock:
            if not os.path.isfile(out):
                for old in glob.glob(os.path.join(COVERS, vid + "-*.jpg")):
                    try:
                        os.remove(old)
                    except OSError:
                        pass
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "0.6", "-i", f, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out],
                               capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return out if os.path.isfile(out) else None


# ---------------------------------------------------------------- папка
def open_folder(vid, sub=""):
    vdir = P.video(vid)
    if not vdir:
        raise ValueError("нет такого видео")
    target = os.path.abspath(os.path.join(vdir, sub)) if sub else vdir
    if not target.startswith(os.path.abspath(vdir)) or not os.path.isdir(target):
        target = vdir
    if os.name == "nt":
        os.startfile(target)                          # noqa — проводник Windows
    else:
        subprocess.Popen(["xdg-open", target])
    return {"ok": True, "path": target}


# ---------------------------------------------------------------- поп-ап «Новое видео»
def _fmt_len(sec):
    sec = int(sec or 0)
    return f"{sec // 60}:{sec % 60:02d}" if sec else ""


def _lists(A, cid=None):
    """Подачи и визуалы: канала (channel.json — вкладки «Стиль»), иначе стартовые из ref.json."""
    R, c = A.ref(), P.channel(cid) if cid else P.channel()
    try:
        cj = json.load(open(os.path.join(c["dir"], "channel.json"), encoding="utf-8")) if c else {}
    except (OSError, ValueError):
        cj = {}
    return (cj.get("deliveries") or R.get("deliveries", [])), (cj.get("looks") or R.get("looks", [])), c


def brief_text(A, b, cid=None):
    """Бриф поп-апа -> «Контекст» видео (topic): его читают все кнопки ✨ и агент (video.md)."""
    DL, LK, c = _lists(A, cid)
    dl = next((x for x in DL if x.get("key") == b.get("delivery")), None)
    lk = next((x for x in LK if x.get("key") == b.get("look")), None)
    L = []
    if dl and dl["key"] != "auto":
        L.append(f"Подача: {dl['label']} — {dl['desc']}")
    if lk:
        L.append(f"Визуал: {lk['label']} — {lk.get('desc', '')}")
        refs = [(r.get("url") or ("<канал>/" + r["img"])) + (f" ({r['note']})" if r.get("note") else "") for r in lk.get("refs") or [] if r.get("img") or r.get("url")]
        if refs and c:
            L.append("Референсы визуала: " + "; ".join(x.replace("<канал>", c["dir"].replace(chr(92), "/")) for x in refs))
    if b.get("len"):
        L.append(f"Ориентировочная длина: {_fmt_len(b['len'])} (≈ {round(int(b['len']) * 2.65)} слов голоса при 2,65 сл/с; на монтаже может измениться)")
    if (b.get("direction") or "").strip():
        L.append("Указания автора: " + b["direction"].strip())
    if (b.get("script") or "").strip():
        L.append("Свой сценарий автора — это текст голоса: НЕ переписывай его, только разложи по сценам (картинка, VO):\n" + b["script"].strip())
    if b.get("voice"):
        L.append(f"Озвучка уже записана: refs/voice/{b['voice']} — тайминги брать из неё.")
    return "\n".join(L)


def create(A, body, channel=None):
    name = (body.get("name") or "").strip()
    if not name:
        raise ValueError("нужно название")
    mode = "long" if body.get("mode") == "long" else "short"
    _dl, LK, _c = _lists(A, channel or body.get("channel"))
    look = next((x for x in LK if x.get("key") == body.get("look")), None)
    d = A.new_plan(mode, name, channel=channel or body.get("channel"))
    b = {k: body.get(k) for k in ("delivery", "look", "len", "topic", "script", "direction")}
    b["len"] = int(body.get("len") or 0)
    ops = [{"op": "set", "path": ["brief"], "value": b},
           {"op": "set", "path": ["idea"], "value": (body.get("topic") or "").strip() or ("Свой сценарий автора" if (body.get("script") or "").strip() else name)},
           {"op": "set", "path": ["topic"], "value": brief_text(A, b, channel or body.get("channel"))}]
    if look and look.get("engine"):
        ops.append({"op": "set", "path": ["engine"], "value": look["engine"]})
    for u in body.get("refs") or []:
        u = (u or "").strip()
        if re.match(r"https?://", u):
            kind = "video" if re.search(r"youtu\.?be|vimeo|tiktok|rutube|vk\.com/video|\.mp4\b", u) else "link"
            ops.append({"op": "add", "path": ["refs"], "item": {"id": "r" + uuid.uuid4().hex[:6], "kind": kind, "url": u, "note": ""}})
    A.apply_ops("plan:" + d["id"], ops)
    return {"id": d["id"]}


def set_brief(A, vid, body):
    key = "plan:" + vid
    d = A.load(key)
    b = dict(d.get("brief") or {})
    for k in ("delivery", "look", "len", "topic", "script", "direction", "voice"):
        if k in body:
            b[k] = int(body[k] or 0) if k == "len" else body[k]
    cid = P.index()["videos"].get(vid, {}).get("channel")
    ops = [{"op": "set", "path": ["brief"], "value": b}, {"op": "set", "path": ["topic"], "value": brief_text(A, b, cid)}]
    look = next((x for x in _lists(A, cid)[1] if x.get("key") == b.get("look")), None)
    if look and look.get("engine"):
        ops.append({"op": "set", "path": ["engine"], "value": look["engine"]})
    return A.apply_ops(key, ops)


def save_voice(A, vid, name, data):
    vdir = P.video(vid)
    if not vdir:
        raise ValueError("нет такого видео")
    ext = os.path.splitext(name or "")[1].lower()
    if ext not in AUDIO:
        raise ValueError("нужен звук: " + " ".join(AUDIO))
    d = os.path.join(vdir, "refs", "voice")
    os.makedirs(d, exist_ok=True)
    base = re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(name))[0])[:40] or "voice"
    fn = time.strftime("%m%d-%H%M") + "-" + base + ext
    with open(os.path.join(d, fn), "wb") as f:
        f.write(data)
    set_brief(A, vid, {"voice": fn})
    return {"file": fn}


# ---------------------------------------------------------------- 📷 кадр ролика (S12.3)
def snap(A, vid, t):
    """Кадр ролика в момент t -> <видео>/out/shots/<имя>-<t>.png (render.js snap через локальный скрипт ревью проекта)."""
    vdir = P.video(vid)
    if not vdir or not os.path.isfile(os.path.join(vdir, "render.js")):
        raise ValueError("у видео ещё нет проекта ролика")
    t = max(0.0, float(t or 0))
    rel = f"out/shots/shot-{t:07.2f}.png".replace(":", "-")
    os.makedirs(os.path.join(vdir, "out", "shots"), exist_ok=True)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", REVIEW_PORT=str(A.stapi().project_port(vdir)))
    r = subprocess.run(["node", "render.js", "snap", f"{t:.2f}", rel], cwd=vdir, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    f = os.path.join(vdir, *rel.split("/"))
    if not os.path.isfile(f):
        raise RuntimeError("кадр не снялся: " + (r.stdout + r.stderr).strip()[-300:])
    return {"file": rel, "path": f}


# ---------------------------------------------------------------- 📝 окно «Сценарий» (S12.5)
TEXTS = ("research.md", "script.md")


def text(vid, name):
    """research.md / script.md папки видео (вкладка «Ресерч и источники», «Скопировать для TTS»)."""
    vdir = P.video(vid)
    if not vdir or name not in TEXTS:
        raise ValueError("нет такого файла")
    f = os.path.join(vdir, name)
    if not os.path.isfile(f):
        return {"name": name, "text": "", "exists": False}
    with open(f, encoding="utf-8", errors="replace") as fh:
        return {"name": name, "text": fh.read(), "exists": True, "mtime": os.path.getmtime(f)}


def _vers_dir(vdir):
    return os.path.join(vdir, "build", "script_versions")


def script_versions(vid):
    vdir = P.video(vid)
    d = _vers_dir(vdir) if vdir else ""
    try:
        import json as _j
        idx = _j.load(open(os.path.join(d, "index.json"), encoding="utf-8"))
    except (OSError, ValueError):
        idx = []
    return list(reversed(idx))


def script_snapshot(vid, why=""):
    """Версия script.md: копия в build/script_versions/<время>.md, если текст изменился с прошлой версии."""
    import json as _j
    vdir = P.video(vid)
    f = vdir and os.path.join(vdir, "script.md")
    if not f or not os.path.isfile(f):
        return None
    cur = open(f, encoding="utf-8", errors="replace").read()
    if "Зачем ежу иголки" in cur[:400]:                 # заглушка шаблона — не версия
        return None
    d = _vers_dir(vdir)
    os.makedirs(d, exist_ok=True)
    ip = os.path.join(d, "index.json")
    try:
        idx = _j.load(open(ip, encoding="utf-8"))
    except (OSError, ValueError):
        idx = []
    if idx:
        try:
            if open(os.path.join(d, idx[-1]["file"]), encoding="utf-8", errors="replace").read() == cur:
                return None
        except OSError:
            pass
    name = time.strftime("%y%m%d-%H%M%S") + ".md"
    with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
        fh.write(cur)
    idx.append({"file": name, "ts": int(time.time() * 1000), "why": why, "words": len(re.findall(r"\w+", " ".join(l[1:] for l in cur.splitlines() if l.startswith(">"))))})
    with open(ip, "w", encoding="utf-8") as fh:
        _j.dump(idx[-200:], fh, ensure_ascii=False, indent=1)
    return name


def script_version(vid, name):
    vdir = P.video(vid)
    if not vdir or not re.fullmatch(r"[\d-]+\.md", name or ""):
        raise ValueError("нет такой версии")
    f = os.path.join(_vers_dir(vdir), name)
    return {"name": name, "text": open(f, encoding="utf-8", errors="replace").read()}


def script_restore(vid, name):
    v = script_version(vid, name)
    script_snapshot(vid, "перед возвратом версии")
    with open(os.path.join(P.video(vid), "script.md"), "w", encoding="utf-8") as fh:
        fh.write(v["text"])
    script_snapshot(vid, "возвращена версия " + name[:-3])
    return {"ok": True}


def open_file(vid, rel):
    """Проводник с выделенным файлом видео (script.md, research.md …)."""
    vdir = P.video(vid)
    f = vdir and os.path.abspath(os.path.join(vdir, rel))
    if not f or not f.startswith(os.path.abspath(vdir)) or not os.path.exists(f):
        return open_folder(vid)
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", f], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(f)])
    return {"ok": True, "path": f}


# ---------------------------------------------------------------- 🎞 B-roll (S12.6)
VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi")


def _ts(x):
    """'1:23.5' | '83.5' -> секунды (или None)."""
    if x in (None, ""):
        return None
    s = 0.0
    for part in str(x).strip().split(":"):
        s = s * 60 + float(part.replace(",", "."))
    return s


def broll_upload(A, vid, el, name, data):
    """Файл с компьютера -> <видео>/files/broll_<el>_src<ext>; путь — источником для «Взять кусок»."""
    vdir = P.video(vid)
    ext = os.path.splitext(name or "")[1].lower()
    if not vdir or ext not in VIDEO_EXT:
        raise ValueError("нужно видео: " + " ".join(VIDEO_EXT))
    os.makedirs(os.path.join(vdir, "files"), exist_ok=True)
    f = os.path.join(vdir, "files", f"broll_{re.sub(r'[^\w-]', '', el)}_src{ext}")
    with open(f, "wb") as fh:
        fh.write(data)
    return {"src": f, "name": name}


def run_broll(A, job):
    """Кусок видео (ссылка YouTube и др. через yt-dlp — до 1080p; файл — ffmpeg) -> files/broll_<el>.mp4 + кадр-превью; в элемент — broll{}."""
    import json as _j
    vid, pr = job.key[5:], job.params
    el = re.sub(r"[^\w-]", "", pr.get("el") or "")
    vdir = P.video(vid)
    src = (pr.get("src") or "").strip()
    if not vdir or not el or not src:
        raise ValueError("нужны видео, элемент и источник")
    t0, t1 = _ts(pr.get("from")), _ts(pr.get("to"))
    if t0 is not None and t1 is not None and t1 <= t0:
        raise ValueError("«по» должно быть позже «с»")
    cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    tmp, cut = None, True
    if re.match(r"^https?://", src):
        import tempfile, sys as _s
        td = tempfile.mkdtemp(prefix="broll_")
        out = os.path.join(td, "src.%(ext)s")
        cmd = [_s.executable, "-m", "yt_dlp", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "--no-playlist", "--no-part", "-o", out]
        if t0 is not None or t1 is not None:
            cmd += ["--download-sections", f"*{t0 or 0}-{t1 if t1 is not None else 'inf'}", "--force-keyframes-at-cuts"]
        job.summary = "yt-dlp: качаю кусок…"
        r = subprocess.run(cmd + [src], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=cf)
        fs = [f for f in glob.glob(os.path.join(td, "src.*")) if not f.endswith(".part")]
        if r.returncode != 0 or not fs:
            raise RuntimeError("yt-dlp не скачал: " + (r.stderr or r.stdout)[-500:])
        tmp, cut = fs[0], False                          # кусок уже вырезан
    elif os.path.isfile(src):
        tmp = src
    else:
        raise ValueError("нужна ссылка или файл с компьютера")
    dst = os.path.join(vdir, "files", f"broll_{el}.mp4")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    job.summary = "ffmpeg: готовлю mp4…"
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if cut and t0 is not None:
        cmd += ["-ss", f"{t0:.3f}"]
    cmd += ["-i", tmp]
    if cut and t1 is not None:
        cmd += ["-t", f"{t1 - (t0 or 0):.3f}"]
    cmd += ["-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", dst]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=cf)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise RuntimeError("ffmpeg: " + (r.stderr or r.stdout)[-400:])
    pr2 = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", dst], capture_output=True, text=True, creationflags=cf)
    info = _j.loads(pr2.stdout or "{}")
    dur = float((info.get("format") or {}).get("duration") or 0)
    st = next((s for s in info.get("streams") or [] if s.get("width")), {})
    thumb = os.path.join(vdir, "files", f"broll_{el}.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{dur / 2:.2f}", "-i", dst, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", thumb], capture_output=True, creationflags=cf)
    title = ""
    if re.match(r"^https?://", src):
        try:
            from media_api import probe_title
            title = probe_title(src) or ""
        except Exception:
            pass
    item = {"src": src if re.match(r"^https?://", src) else os.path.basename(src), "from": pr.get("from") or "", "to": pr.get("to") or "",
            "file": f"files/{vid}/broll_{el}.mp4", "thumb": f"files/{vid}/broll_{el}.jpg" if os.path.isfile(thumb) else "",
            "dur": round(dur, 2), "w": st.get("width"), "h": st.get("height"), "title": title, "owner": pr.get("owner") or "", "at": int(time.time() * 1000)}
    A.apply_ops(job.key, [{"op": "set", "path": ["elements", el, "broll"], "value": item}])
    job.result = item
    job.summary = f"🎞 B-roll готов: {dur:.1f} с" + (f", {st.get('width')}×{st.get('height')}" if st.get("width") else "")


# ---------------------------------------------------------------- 🔍 поиск по каналу (S12.10, Ctrl K)
_TXT = {}


def _text_of(f):
    try:
        k = (f, os.path.getmtime(f))
    except OSError:
        return ""
    if k not in _TXT:
        try:
            _TXT[k] = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            _TXT[k] = ""
    return _TXT[k]


def search(A, q, limit=40):
    """Видео (название, идея, тема, текст сценария), элементы препродакшена, библиотека, готовые ролики, правила памяти."""
    norm = lambda s: (s or "").lower().replace("ё", "е")
    words = [w for w in norm(q).split() if w]
    if not words:
        return []
    hit = lambda s: all(w in norm(s) for w in words)
    def snip(s):
        t, i = norm(s), norm(s).find(words[0])
        if i < 0:
            return ""
        a = max(0, i - 50)
        return ("…" if a else "") + " ".join(s[a:i + 90].split()) + "…"
    out = []
    ch = P.channel()
    for d in A.plans(ch["id"] if ch else None):
        if d.get("service") or d.get("status") == "archived":
            continue
        vid, name = d["id"], d.get("name", "")
        if hit(name + " " + (d.get("idea") or "") + " " + (d.get("topic") or "")):
            out.append({"group": "Видео", "label": name, "hint": (d.get("idea") or "")[:80], "href": f"#/v/{vid}", "icon": "tall" if d.get("mode") != "long" else "wide"})
        vdir = P.video(vid)
        sc = _text_of(os.path.join(vdir, "script.md")) if vdir else ""
        if sc and "Зачем ежу иголки" not in sc[:400] and hit(sc):
            out.append({"group": "Сценарии", "label": name, "hint": snip(sc), "href": f"#/v/{vid}", "icon": "book"})
        for e in d.get("elements") or []:
            if e.get("status") != "drop" and not e.get("ws") and hit((e.get("name") or "") + " " + (e.get("desc") or "")):
                out.append({"group": "Препродакшен", "label": e.get("name", ""), "hint": f"{name} · {e.get('kind')}", "href": f"#/v/{vid}/pre/{e['id']}", "icon": "users"})
        for f in glob.glob(os.path.join(vdir or "", "out", "*.mp4")):
            n = os.path.basename(f)
            if not n.endswith("_NO_VO.mp4") and hit(n + " " + name):
                out.append({"group": "Рендеры", "label": n, "hint": name, "href": "#/renders", "icon": "film"})
    try:
        c = A.stapi().channel_dir(ch["id"]) if ch else None
        idx = json.load(open(os.path.join(A.stapi().lib_dir(c), "index.json"), encoding="utf-8")) if c else {}
        for it in (idx.get("items") if isinstance(idx, dict) else idx) or []:
            if hit((it.get("name") or "") + " " + (it.get("desc") or "") + " " + " ".join(it.get("tags") or [])):
                out.append({"group": "Библиотека", "label": it.get("name", ""), "hint": it.get("kind", ""), "href": "#/lib/item/" + it["id"], "icon": "library"})
    except Exception:
        pass
    try:
        R = A.mmapi().rules(ch["id"] if ch else None)
        for r in R["channel"] + R["all"]:
            if hit(r.get("text") + " " + (r.get("why") or "")):
                out.append({"group": "Память", "label": r["text"][:90], "hint": {"new": "предложено", "on": "действует", "off": "выключено"}.get(r.get("status"), ""), "href": "#/memory", "icon": "bulb"})
    except Exception:
        pass
    return out[:limit]


# ---------------------------------------------------------------- HTTP
def handle_get(A, h, p, q):
    if p == "/api/videos/extra":
        ch = P.channel()
        out = {}
        for d in A.plans(ch["id"] if ch else None):
            if not d.get("service"):
                try:
                    out[d["id"]] = extra(A, d)
                except Exception as e:                 # одна битая папка не ломает страницу
                    out[d["id"]] = {"err": str(e)}
        h._json(out); return True
    if p == "/api/videos/text":
        h._json(text(q.get("id", [""])[0], q.get("f", [""])[0])); return True
    if p == "/api/videos/scriptver":
        vid, name = q.get("id", [""])[0], q.get("v", [""])[0]
        h._json(script_version(vid, name) if name else {"versions": script_versions(vid)}); return True
    if p == "/api/videos/search":
        h._json(search(A, q.get("q", [""])[0])); return True
    if p == "/api/videos/genat":                     # S12.7: когда монтаж последний раз писал файлы проекта (окно перезагружает превью)
        vdir = P.video(q.get("id", [""])[0])
        fs = [os.path.join(vdir, "src", n) for n in ("montage.js", "scenes.js")] if vdir else []
        h._json({"t": max([os.path.getmtime(f) for f in fs if os.path.isfile(f)] or [0])}); return True
    if p == "/api/videos/cover":
        f = cover_path(A, q.get("id", [""])[0])
        if not f:
            h.send_error(404); return True
        A._send_file(h, f); return True
    return False


def handle_post(A, h, p, q, body):
    if p == "/api/videos/open":
        h._json(open_file(body.get("id", ""), body["file"]) if body.get("file") else open_folder(body.get("id", ""), body.get("sub", ""))); return True
    if p == "/api/videos/scriptsnap":
        h._json({"name": script_snapshot(body.get("id", ""), body.get("why", ""))}); return True
    if p == "/api/videos/scriptrestore":
        h._json(script_restore(body.get("id", ""), body.get("v", ""))); return True
    if p == "/api/videos/create":
        h._json(create(A, body)); return True
    if p == "/api/videos/broll":                       # S12.6: B-roll элемента — кусок видео (задача brollfetch)
        j = A.start_job("brollfetch", body.get("key", ""), "broll:" + (body.get("el") or ""), {k: body.get(k) for k in ("el", "src", "from", "to", "owner")})
        h._json({"job": j.info()}); return True
    if p == "/api/videos/snap":
        h._json(snap(A, body.get("id", ""), body.get("t", 0))); return True
    if p == "/api/videos/brief":
        h._json(set_brief(A, body.get("id", ""), body)); return True
    return False
