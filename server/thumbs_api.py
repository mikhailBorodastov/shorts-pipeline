"""S12.9 — раздел «Обложки» (docs/studio/stage12-redesign.md §10.4): доски-канвасы и генерация картинок.

Доска видео — <видео>/thumbs/ (board.json — ноды и связи, их пишет страница; results.json — статусы генераций, их пишет сервер; in/ — картинки автора; gen/ — результаты),
«свободная» доска канала — <канал>/thumbs/. Ноды: image {src}, text {text}, prompt {text, model, aspect, quality}, result {from, …} — статус результата живёт в results.json.

Модели (провайдер — модулем ниже; ключ Higgsfield — ⚙ Настройки → secrets.json higgsfield = «ID:секрет»):
  hf:sunburst | hf:flare  — Marketing Studio Image 2.5 (до 16 референсов, 1k/2k/4k, качество low…max)
  hf:grok                 — Grok Image 2.0 (до 10 референсов, 1k/2k)
  hf:qwen                 — Qwen Image 3 (правка 1–3 картинок; без картинок — text-to-image)
  hf:ideogram             — Ideogram 4.0 (1 референс)
  hf:soul                 — SOUL V2 (без референсов)
  claude                  — Claude рисует обложку кодом нашим движком (концепт видео → задача render), с ёжиком канала

GET  /api/thumbs/boards                   -> [{b, name, cover, n}]
GET  /api/thumbs/board?b=                 -> {board, results, models, key}
GET  /api/thumbs/file?b=&f=               -> картинка доски (in/… | gen/…)
POST /api/thumbs/board      <- {b, board}             сохранить ноды и связи
POST /api/thumbs/upload?b=&name=  <- байты             картинка -> in/<id>.<ext> -> {src}
POST /api/thumbs/fromurl    <- {b, url}                 картинка по адресу (кадр ролика, элемент) -> in/
POST /api/thumbs/generate   <- {b, rid, model, prompt, refs[src…], aspect, quality, resolution}  -> {rid}
POST /api/thumbs/use        <- {b, src}                 «Сделать обложкой» -> <видео>/out/thumbnail_main.<ext>, pack.thumb
"""
import base64, json, mimetypes, os, re, shutil, threading, time, urllib.request, uuid

import paths as P

HF = "https://api.higgsfield.ai"
MODELS = [
    {"id": "hf:sunburst", "label": "Marketing Studio 2.5 Sunburst", "path": "/marketing-studio/image/sunburst", "refs": 16, "res": ["1k", "2k", "4k"], "q": ["low", "medium", "high", "xhigh", "max"],
     "ar": ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"]},
    {"id": "hf:flare", "label": "Marketing Studio 2.5 Flare", "path": "/marketing-studio/image/flare", "refs": 16, "res": ["1k", "2k", "4k"], "q": ["low", "medium", "high", "xhigh", "max"],
     "ar": ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"]},
    {"id": "hf:grok", "label": "Grok Image 2.0", "path": "/xai/grok-imagine-image-2.0", "refs": 10, "res": ["1k", "2k"], "q": ["low", "medium"],
     "ar": ["auto", "1:1", "1:2", "2:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"]},
    {"id": "hf:qwen", "label": "Qwen Image 3", "path": "/alibaba/qwen-image-3/edit", "path0": "/alibaba/qwen-image-3/text-to-image", "refs": 3, "res": ["1k", "2k"], "q": [],
     "ar": ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]},
    {"id": "hf:ideogram", "label": "Ideogram 4.0", "path": "/ideogram/v4.0", "refs": 1, "res": [], "q": [], "ar": ["1:1", "3:4", "4:3", "9:16", "16:9"]},
    {"id": "hf:soul", "label": "SOUL V2", "path": "/higgsfield-ai/soul/v2/standard", "refs": 0, "res": ["2k", "4k"], "q": [], "ar": ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"]},
    {"id": "claude", "label": "Claude · кодом (наш движок, ёжик канала)", "refs": 8, "res": [], "q": [], "ar": ["9:16", "16:9"]},
]
_lock = threading.Lock()


# ---------------------------------------------------------------- доски
def bdir(b):
    """b = id видео | 'ch' (свободная доска текущего канала)."""
    if b == "ch":
        c = P.channel()
        if not c:
            raise ValueError("нет канала")
        return os.path.join(c["dir"], "thumbs")
    v = P.video(b)
    if not v:
        raise ValueError("нет такого видео")
    return os.path.join(v, "thumbs")


def _read(p, default):
    try:
        return json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def board(b):
    d = bdir(b)
    return {"board": _read(os.path.join(d, "board.json"), {"nodes": [], "edges": [], "view": {"x": 0, "y": 0, "z": 1}}),
            "results": _read(os.path.join(d, "results.json"), {}), "models": MODELS, "key": bool(hf_key())}


def save_board(b, bd):
    if not isinstance(bd, dict) or not isinstance(bd.get("nodes"), list):
        raise ValueError("плохая доска")
    _write(os.path.join(bdir(b), "board.json"), bd)
    return {"ok": True}


def boards(A):
    ch = P.channel()
    out = [{"b": "ch", "name": "Свободная доска канала", "n": len(_read(os.path.join(bdir("ch"), "board.json"), {}).get("nodes") or []) if ch else 0}]
    for d in A.plans(ch["id"] if ch else None):
        if d.get("service") or d.get("status") == "archived":
            continue
        bd = _read(os.path.join(P.video(d["id"]) or "", "thumbs", "board.json"), {})
        out.append({"b": d["id"], "name": d.get("name", ""), "n": len(bd.get("nodes") or []), "mode": d.get("mode") or "short", "updated": d.get("updated", 0)})
    return out


def file_path(b, f):
    d = bdir(b)
    p = os.path.abspath(os.path.join(d, f))
    if not p.startswith(os.path.abspath(d) + os.sep) or not os.path.isfile(p):
        raise ValueError("нет такого файла")
    return p


def upload(b, name, data):
    ext = os.path.splitext(name or "")[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        raise ValueError("нужна картинка: png, jpg, webp")
    d = os.path.join(bdir(b), "in")
    os.makedirs(d, exist_ok=True)
    fn = "i" + uuid.uuid4().hex[:8] + (".jpg" if ext == ".jpeg" else ext)
    with open(os.path.join(d, fn), "wb") as f:
        f.write(data)
    return {"src": "in/" + fn}


def from_url(A, b, url):
    """Картинка по адресу студии (/files/…, /api/videos/cover, кадр) или из интернета -> in/."""
    m = re.match(r"^/?((?:files|render)/[a-z0-9-]{3,40}/[^?#]+)", url)
    if m:                                                # картинка видео (элемент, референс, черновик)
        f = P.resolve(m.group(1))
        return upload(b, os.path.basename(f), open(f, "rb").read())
    m = re.match(r"^/api/videos/cover\?id=([a-z0-9-]{3,40})", url)
    if m:                                                # обложка / первый кадр видео
        f = A.vdapi().cover_path(A, m.group(1))
        if not f:
            raise ValueError("у видео нет обложки и кадра")
        return upload(b, os.path.basename(f), open(f, "rb").read())
    if not re.match(r"^https?://", url):
        raise ValueError("нужна ссылка на картинку")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ClaudeStudio", "X-Ideas": "1"}), timeout=60) as r:
        data, ct = r.read(), r.headers.get("Content-Type", "")
    ext = mimetypes.guess_extension((ct or "").split(";")[0].strip()) or ".png"
    return upload(b, "x" + (".jpg" if ext in (".jpe", ".jpeg") else ext), data)


# ---------------------------------------------------------------- генерация
def hf_key():
    import settings_api
    return settings_api.secret("higgsfield")


def _hf(method, url, body=None, key=None):
    hd = {"Authorization": "Key " + key, "Content-Type": "application/json", "User-Agent": "ClaudeStudio"}
    data = json.dumps(body).encode() if body is not None else None
    if method == "POST" and url.startswith(HF) and "/requests/" not in url:
        hd["Idempotency-Key"] = str(uuid.uuid4())
    req = urllib.request.Request(url if url.startswith("http") else HF + url, data=data, headers=hd, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError({401: "Higgsfield: ключ не подошёл (⚙ Настройки)", 402: "Higgsfield: не хватает кредитов", 404: "Higgsfield: модель недоступна вашему аккаунту",
                            422: "Higgsfield: параметры не подошли — " + msg, 429: "Higgsfield: слишком много запросов, подожди"}.get(e.code, f"Higgsfield {e.code}: {msg}"))


def _hf_upload(key, path):
    ct = mimetypes.guess_type(path)[0] or "image/png"
    up = _hf("POST", "/files/generate-upload-url", {"content_type": ct}, key)
    req = urllib.request.Request(up["upload_url"], data=open(path, "rb").read(), headers=up.get("upload_headers") or {"Content-Type": ct}, method="PUT")
    urllib.request.urlopen(req, timeout=120).read()
    return up["public_url"]


def _set_result(b, rid, **kw):
    with _lock:
        p = os.path.join(bdir(b), "results.json")
        R = _read(p, {})
        R[rid] = {**R.get(rid, {}), **kw, "at": int(time.time() * 1000)}
        _write(p, R)


def generate(A, body):
    b, rid = body.get("b", ""), body.get("rid") or ("r" + uuid.uuid4().hex[:8])
    m = next((x for x in MODELS if x["id"] == body.get("model")), MODELS[0])
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("нужен промпт")
    refs = [file_path(b, s) for s in (body.get("refs") or [])][: max(m["refs"], 0) or 0]
    if m["id"].startswith("hf:") and not hf_key():
        raise ValueError("нет ключа Higgsfield — ⚙ Настройки → Higgsfield («ID:секрет» из console.higgsfield.ai)")
    if m["id"] == "claude" and b == "ch":
        raise ValueError("«Claude · кодом» рисует обложку конкретного видео — откройте доску видео")
    _set_result(b, rid, status="queued", model=m["id"], label=m["label"], prompt=prompt, file="", error="")
    threading.Thread(target=_run, args=(A, b, rid, m, prompt, refs, body), daemon=True).start()
    return {"rid": rid}


def _run(A, b, rid, m, prompt, refs, body):
    try:
        if m["id"] == "claude":
            return _run_claude(A, b, rid, prompt, refs, body)
        key = hf_key()
        _set_result(b, rid, status="uploading" if refs else "queued")
        urls = [_hf_upload(key, r) for r in refs]
        q = {"prompt": prompt}
        ar = body.get("aspect") if body.get("aspect") in m["ar"] else m["ar"][0]
        q["aspect_ratio"] = ar
        if m["res"]:
            q["resolution"] = body.get("resolution") if body.get("resolution") in m["res"] else m["res"][min(1, len(m["res"]) - 1)]
        if m["q"]:
            q["quality"] = body.get("quality") if body.get("quality") in m["q"] else ("high" if "high" in m["q"] else m["q"][-1])
        path = m["path"]
        if m["id"] == "hf:ideogram":
            if urls:
                q["image_url"] = urls[0]
        elif m["id"] == "hf:qwen" and not urls:
            path = m["path0"]
        elif m["refs"] and urls:
            q["image_urls"] = urls
        r = _hf("POST", path, q, key)
        st_url, delay, t0 = r.get("status_url") or f"{HF}/requests/{r['request_id']}/status", 2.0, time.time()
        _set_result(b, rid, status=r.get("status", "queued"), request=r.get("request_id"))
        while True:
            time.sleep(delay); delay = min(delay * 1.4, 8)
            s = _hf("GET", st_url, None, key)
            _set_result(b, rid, status=s.get("status"))
            if s.get("status") == "completed":
                img = ((s.get("images") or [{}])[0]).get("url")
                if not img:
                    raise RuntimeError("Higgsfield не вернул картинку")
                break
            if s.get("status") in ("failed", "nsfw", "canceled"):
                raise RuntimeError({"nsfw": "Higgsfield: модерация отклонила запрос", "canceled": "отменено"}.get(s["status"], "Higgsfield: генерация не удалась " + str(s.get("error") or "")))
            if time.time() - t0 > 900:
                raise RuntimeError("Higgsfield: дольше 15 минут — бросил ждать")
        data = urllib.request.urlopen(urllib.request.Request(img, headers={"User-Agent": "ClaudeStudio"}), timeout=120).read()   # ссылки живут 7 дней — копия у нас
        ext = os.path.splitext(img.split("?")[0])[1].lower() or ".png"
        _save_gen(b, rid, data, ext)
    except Exception as e:
        _set_result(b, rid, status="failed", error=str(e)[:400])


def _save_gen(b, rid, data, ext):
    d = os.path.join(bdir(b), "gen")
    os.makedirs(d, exist_ok=True)
    fn = rid + (ext if ext in (".png", ".jpg", ".jpeg", ".webp") else ".png")
    with open(os.path.join(d, fn), "wb") as f:
        f.write(data)
    _set_result(b, rid, status="completed", file="gen/" + fn, error="")


def _run_claude(A, b, rid, prompt, refs, body):
    """Обложка кодом: концепт в видео (thumbs[]) -> задача render (Claude рисует нашим движком, смотрит, правит) -> картинка обложки."""
    key, cid = "plan:" + b, "t" + uuid.uuid4().hex[:7]
    imgs = []
    for r in refs[:8]:                                    # референсы — картинками видео, чтобы Claude их видел
        imgs.append(A.save_file(b, open(r, "rb").read()))
    imgs = [x for x in imgs if x]
    A.apply_ops(key, [{"op": "add", "path": ["thumbs"], "item": {"id": cid, "title": "", "desc": prompt + ("\nРеференсы автора: " + ", ".join("/" + x for x in imgs) if imgs else ""),
                                                             "type": "", "text": "", "hook": "", "frame": "", "img": imgs[0] if imgs else "", "renders": [], "by": "board"}}])
    _set_result(b, rid, status="in_progress")
    j = A.start_job("render", key, "render:" + cid, {"thumb": cid, "part": "cover"})
    while j.status == "running":
        time.sleep(2)
    if j.status != "done":
        raise RuntimeError("Claude: " + (j.error or j.status))
    c = next((x for x in A.load(key).get("thumbs") or [] if x["id"] == cid), {})
    r = (c.get("renders") or [{}])[-1]
    src = P.resolve(r.get("cover") or r.get("img") or "")   # render: renders[].cover — обложка, .frame — первый кадр
    if not os.path.isfile(src):
        raise RuntimeError("Claude не нарисовал обложку")
    _save_gen(b, rid, open(src, "rb").read(), os.path.splitext(src)[1])


def use(A, b, src):
    """«Сделать обложкой»: картинка -> <видео>/out/thumbnail_main.<ext>; pack.thumb — для экспорта, карточки видео и упаковки."""
    if b == "ch":
        raise ValueError("обложку ставят на доске видео")
    f = file_path(b, src)
    out = os.path.join(P.video(b), "out")
    os.makedirs(out, exist_ok=True)
    ext = os.path.splitext(f)[1].lower()
    for old in ("thumbnail_main.png", "thumbnail_main.jpg", "thumbnail_main.webp"):
        try:
            os.remove(os.path.join(out, old))
        except OSError:
            pass
    shutil.copy2(f, os.path.join(out, "thumbnail_main" + ext))
    A.apply_ops("plan:" + b, [{"op": "set", "path": ["pack", "thumb"], "value": "thumbnail_main" + ext}])
    return {"ok": True, "file": "out/thumbnail_main" + ext}


# ---------------------------------------------------------------- HTTP
def handle_get(A, h, p, q):
    g = lambda k: q.get(k, [""])[0]
    if p == "/api/thumbs/boards":
        h._json(boards(A)); return True
    if p == "/api/thumbs/board":
        h._json(board(g("b"))); return True
    if p == "/api/thumbs/file":
        A._send_file(h, file_path(g("b"), g("f"))); return True
    return False


def handle_post(A, h, p, q, body):
    if p == "/api/thumbs/board":
        h._json(save_board(body.get("b", ""), body.get("board"))); return True
    if p == "/api/thumbs/fromurl":
        h._json(from_url(A, body.get("b", ""), body.get("url", ""))); return True
    if p == "/api/thumbs/generate":
        h._json(generate(A, body)); return True
    if p == "/api/thumbs/use":
        h._json(use(A, body.get("b", ""), body.get("src", ""))); return True
    return False
