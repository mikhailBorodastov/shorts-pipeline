"""S12.2 — страница «Видео» и поп-ап «Новое видео» (docs/studio/stage12-redesign.md §3–4).

GET  /api/videos/extra            -> {id: {scenes, len, ready, cover, outs}}   карточки: сцены, длина, есть ли рендер, обложка
GET  /api/videos/cover?id=…       -> картинка карточки: обложка (out/thumbnail_1) | первый кадр ролика (ffmpeg, кэш) | кадр первой сцены
POST /api/videos/open             <- {id, sub?}       открыть папку видео в проводнике (только внутри папки видео)
POST /api/videos/create           <- {name, mode, delivery, look, len, topic, script, direction, refs[]}  -> {id}
POST /api/videos/voice?id=&name=  <- сырые байты     озвучка из поп-апа -> <видео>/refs/voice/ (нарезка — на шаге «Озвучка»)
POST /api/videos/brief            <- {id, …brief}    поправить бриф (поля поп-апа) — контекст для Claude пересобирается
"""
import glob
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
            "cover": bool(vdir and _cover_src(A, d, vdir))}


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


def brief_text(A, b):
    """Бриф поп-апа -> «Контекст» видео (topic): его читают все кнопки ✨ и агент (video.md)."""
    R = A.ref()
    dl = next((x for x in R.get("deliveries", []) if x["key"] == b.get("delivery")), None)
    lk = next((x for x in R.get("looks", []) if x["key"] == b.get("look")), None)
    L = []
    if dl and dl["key"] != "auto":
        L.append(f"Подача: {dl['label']} — {dl['desc']}")
    if lk:
        L.append(f"Визуал: {lk['label']} — {lk['desc']}")
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
    look = next((x for x in A.ref().get("looks", []) if x["key"] == body.get("look")), None)
    d = A.new_plan(mode, name, channel=channel or body.get("channel"))
    b = {k: body.get(k) for k in ("delivery", "look", "len", "topic", "script", "direction")}
    b["len"] = int(body.get("len") or 0)
    ops = [{"op": "set", "path": ["brief"], "value": b},
           {"op": "set", "path": ["idea"], "value": (body.get("topic") or "").strip() or ("Свой сценарий автора" if (body.get("script") or "").strip() else name)},
           {"op": "set", "path": ["topic"], "value": brief_text(A, b)}]
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
    ops = [{"op": "set", "path": ["brief"], "value": b}, {"op": "set", "path": ["topic"], "value": brief_text(A, b)}]
    look = next((x for x in A.ref().get("looks", []) if x["key"] == b.get("look")), None)
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
    if p == "/api/videos/cover":
        f = cover_path(A, q.get("id", [""])[0])
        if not f:
            h.send_error(404); return True
        A._send_file(h, f); return True
    return False


def handle_post(A, h, p, q, body):
    if p == "/api/videos/open":
        h._json(open_folder(body.get("id", ""), body.get("sub", ""))); return True
    if p == "/api/videos/create":
        h._json(create(A, body)); return True
    if p == "/api/videos/brief":
        h._json(set_brief(A, body.get("id", ""), body)); return True
    return False
