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
  flux:4b | flux:9b       — FLUX.2 [klein] локально на видеокарте (server/flux2.py, ComfyUI Studio): промпт + до 3 референсов, seed;
                            9B (некоммерческая лицензия) в списке, только если включена в ⚙ Настройках

GET  /api/thumbs/boards                   -> [{b, name, cover, n}]
GET  /api/thumbs/board?b=                 -> {board, results, models, key}
GET  /api/thumbs/file?b=&f=               -> картинка доски (in/… | gen/…)
POST /api/thumbs/board      <- {b, board}             сохранить ноды и связи
POST /api/thumbs/upload?b=&name=  <- байты             картинка -> in/<id>.<ext> -> {src}
POST /api/thumbs/fromurl    <- {b, url, fallback?}      картинка по адресу (кадр ролика, элемент, 🔎 поиск; fallback — превью, если оригинал не отдали) -> in/
GET  /api/thumbs/chars?b=                 -> {items: [{slug, name, preview, rig, emotions[]}]}   персонажи библиотеки канала доски
POST /api/thumbs/fromlib    <- {b, slug, emotion}       персонаж библиотеки -> in/: со скелетом — фигура в эмоции без фона (стенд char.html), 2D — его лист-превью
POST /api/thumbs/generate   <- {b, rid, model, prompt, refs[src…], aspect, quality, resolution, seed, title}  -> {rid}
                            title — только у flux: заголовок накладывается шрифтом поверх (кириллицу модель пишет с опечатками)
POST /api/thumbs/use        <- {b, src}                 «Сделать обложкой» -> <видео>/out/thumbnail_main.<ext>, pack.thumb
POST /api/thumbs/unuse      <- {b}                      снять обложку видео (файл out/thumbnail_main.* и pack.thumb)
POST /api/thumbs/paste      <- {from, to, files[src…], results{rid: R}}  Ctrl+V нод с другой доски: картинки копируются в доску to -> {map{src: новый}, results}
"""
import base64, json, mimetypes, os, re, shutil, threading, time, urllib.parse, urllib.request, uuid

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
FLUX_AR = ["16:9", "9:16", "1:1", "4:3", "3:4"]
_lock = threading.Lock()


def models():
    """Список моделей доски: облачные + локальные FLUX.2 [klein] (9B — только если разрешена в настройках)."""
    import flux2
    return MODELS + [{"id": "flux:" + k, "label": flux2.MODELS[k]["label"], "refs": flux2.MAX_REFS, "res": list(flux2.RES), "q": [], "ar": FLUX_AR, "seed": True, "local": True}
                     for k in flux2.enabled_models()]


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
    P.write_atomic(p, json.dumps(d, ensure_ascii=False, indent=1))


def board(b):
    d = bdir(b)
    return {"board": _read(os.path.join(d, "board.json"), {"nodes": [], "edges": [], "view": {"x": 0, "y": 0, "z": 1}}),
            "results": _read(os.path.join(d, "results.json"), {}), "models": models(), "key": bool(hf_key())}


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
    pr = urllib.parse.urlparse(url)                      # 🔎 поиск картинок: оригиналы с чужих сайтов — как браузер, иначе 403
    hdr = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
           "Referer": f"{pr.scheme}://{pr.netloc}/", "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=30) as r:
            data, ct = r.read(40 << 20), r.headers.get("Content-Type", "")
    except Exception as ex:
        raise ValueError(f"сайт не отдал картинку ({getattr(ex, 'code', '') or ex.__class__.__name__})") from None
    ext = mimetypes.guess_extension((ct or "").split(";")[0].strip()) or ".png"
    if ext not in (".png", ".jpg", ".jpe", ".jpeg", ".webp", ".gif"):   # avif / bmp / html вместо картинки
        try:
            from PIL import Image
            import io
            buf = io.BytesIO(); Image.open(io.BytesIO(data)).convert("RGBA").save(buf, "PNG"); data, ext = buf.getvalue(), ".png"
        except Exception:
            raise ValueError("по ссылке не картинка") from None
    return upload(b, "x" + (".jpg" if ext in (".jpe", ".jpeg") else ext), data)


# ---------------------------------------------------------------- персонажи библиотеки на доску
def _board_channel(b):
    if b == "ch":
        c = P.channel()
    else:
        c = P.channel((P.index()["videos"].get(b) or {}).get("channel"))
    if not c:
        raise ValueError("нет канала у доски")
    return c


def lib_chars(A, b):
    """Персонажи библиотеки канала доски (без убранных в архив): превью, есть ли скелет, эмоции (утверждённые — первыми)."""
    c = _board_channel(b)
    gone = {r["id"] for r in A.stapi().lib_index(c) if r.get("archived")}
    ch = A.chapi()
    out = []
    for x in ch.chars(A, c["id"]):
        if "characters/" + x["slug"] in gone:
            continue
        em = []
        if x.get("rig"):
            try:
                E = ch.sheet_info(A, x["slug"], c["id"]).get("emotions") or {}
                em = sorted(E, key=lambda k: not E[k].get("ok"))
            except Exception:
                pass
        out.append({"slug": x["slug"], "name": x["name"], "rig": bool(x.get("rig")), "emotions": em,
                    "preview": f"/api/lib/file/{c['id']}/characters/{x['slug']}/{x['preview']}" if x.get("preview") else ""})
    return {"items": out}


def from_lib(A, b, slug, emotion=""):
    """Персонаж -> картинка доски. Со скелетом — рендер стенда (char.html, без фона, обрезка по фигуре), иначе — превью-лист последней версии."""
    from urllib.parse import quote
    c = _board_channel(b)
    ch = A.chapi()
    x = next((i for i in ch.chars(A, c["id"]) if i["slug"] == slug), None)
    if not x:
        raise ValueError("нет такого персонажа в библиотеке")
    name = x["name"] + (" · " + emotion if emotion else "")
    if not x.get("rig"):
        f = os.path.join(A.stapi().lib_dir(c), "characters", slug, x["preview"])
        if not x.get("preview") or not os.path.isfile(f):
            raise ValueError("у персонажа нет превью")
        return dict(upload(b, os.path.basename(f), open(f, "rb").read()), name=name)
    tmp = os.path.join(bdir(b), "_char_" + uuid.uuid4().hex[:6])
    try:
        png = ch.render_pose(A, f"/api/lib/file/{c['id']}/characters/{slug}/v{x['v']}/prefab.js", tmp,
                             extra="&skel=0&bg=none" + ("&emotion=" + quote(emotion) if emotion else ""))
        from PIL import Image
        im = Image.open(png).convert("RGBA")
        bb = im.getchannel("A").getbbox()                     # по фигуре, с полем
        if bb:
            m = 24
            im = im.crop((max(0, bb[0] - m), max(0, bb[1] - m), min(im.width, bb[2] + m), min(im.height, bb[3] + m)))
        im.save(png)
        return dict(upload(b, "char.png", open(png, "rb").read()), name=name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
        r = R[rid]
    if kw.get("status") in ("completed", "failed"):          # S20.5: картинка для обложки готова (или нет) — в ленту 🔔
        try:
            import notify_api
            vid = None if b == "ch" else b
            who = r.get("label") or r.get("model") or "генерация"
            if kw["status"] == "completed":
                notify_api.add("thumb", "Картинка для обложки готова", f"{who}: {(r.get('prompt') or '')[:120]}", vid, None,
                               "#/thumbs/" + b, "🖼", dedup="thumb:" + b + ":" + rid, channel=None if vid else notify_api.channel_of())
            else:
                notify_api.add("error", "Картинка для обложки не получилась", f"{who}: {r.get('error') or ''}", vid, None,
                               "#/thumbs/" + b, "⚠", dedup="thumbx:" + b + ":" + rid, channel=None if vid else notify_api.channel_of())
        except Exception as e:
            print("! notify thumb:", e)


def generate(A, body):
    b, rid = body.get("b", ""), body.get("rid") or ("r" + uuid.uuid4().hex[:8])
    m = next((x for x in models() if x["id"] == body.get("model")), None)
    if not m:
        raise ValueError("модель недоступна: " + str(body.get("model")) + (" — включи 9B в ⚙ Настройках" if body.get("model") == "flux:9b" else ""))
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
        if m["id"].startswith("flux:"):
            return _run_flux(b, rid, m, prompt, refs, body)
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


def _run_flux(b, rid, m, prompt, refs, body):
    """FLUX.2 [klein] на своей видеокарте: адаптер flux2.generate_thumbnail -> gen/<rid>.png; сид и время — в результат (повторить картинку)."""
    import flux2
    last = [""]

    def log(s):
        st = "queued" if s.startswith("в очереди") else "in_progress"
        if s != last[0]:
            last[0] = s; _set_result(b, rid, status=st, note=s)
    d = os.path.join(bdir(b), "gen")
    f, meta = flux2.generate_thumbnail(prompt, refs, None, body.get("seed"), m["id"][5:], os.path.join(d, rid + ".png"),
                                       aspect=body.get("aspect"), res=body.get("resolution"), log=log, title=body.get("title"))
    _set_result(b, rid, status="completed", file="gen/" + os.path.basename(f), error="", note="", seed=meta["seed"], secs=meta["secs"], size=f"{meta['w']}×{meta['h']}")


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
    j.meta["silent"] = True                               # в ленту 🔔 — одной записью «картинка готова» (ниже), без «обложка нарисована»
    while j.status in ("running", "queued"):               # задача Claude сначала стоит в очереди (S12.13) — ждём и её
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


def unuse(A, b):
    """Снять обложку видео (поставили случайно): out/thumbnail_main.* -> прочь, pack.thumb = null."""
    v = P.video(b)
    if not v:
        raise ValueError("нет такого видео")
    for old in ("thumbnail_main.png", "thumbnail_main.jpg", "thumbnail_main.webp"):
        try:
            os.remove(os.path.join(v, "out", old))
        except OSError:
            pass
    A.apply_ops("plan:" + b, [{"op": "set", "path": ["pack", "thumb"], "value": None}])
    return {"ok": True}


def paste(src_b, dst_b, files, results):
    """Ctrl+V с другой (или той же) доски: файлы нод (in/…, gen/…) копируются в доску dst_b под свободными именами,
    статусы результатов (ключи — уже новые id нод) пишутся в её results.json с новыми путями; незаконченные — «отменено»."""
    dd = bdir(dst_b)
    m = {}
    for f in files or []:
        if f in m or not isinstance(f, str):
            continue
        try:
            sp = file_path(src_b, f)
        except ValueError:
            continue
        sub, name = (f.split("/", 1) + [""])[:2] if "/" in f else ("in", f)
        sub = sub if sub in ("in", "gen") else "in"
        base, ext = os.path.splitext(os.path.basename(name))
        nf = sub + "/" + base + ext
        if os.path.exists(os.path.join(dd, nf)) and os.path.abspath(os.path.join(dd, nf)) != os.path.abspath(sp):
            nf = sub + "/" + base[:1] + uuid.uuid4().hex[:8] + ext
        tp = os.path.join(dd, nf)
        if os.path.abspath(tp) != os.path.abspath(sp):
            os.makedirs(os.path.dirname(tp), exist_ok=True)
            shutil.copy2(sp, tp)
        m[f] = nf
    out = {}
    with _lock:
        p = os.path.join(dd, "results.json")
        R = _read(p, {})
        for rid, r in (results or {}).items():
            if not isinstance(r, dict) or not re.match(r"^[a-z0-9]{3,24}$", rid):
                continue
            r = dict(r)
            if r.get("file"):
                r["file"] = m.get(r["file"], r["file"])
            if r.get("status") not in ("completed", "failed", "nsfw", "canceled"):
                r.update(status="canceled", note="скопировано до конца генерации")
            R[rid] = out[rid] = r
        _write(p, R)
    return {"map": m, "results": out}


# ---------------------------------------------------------------- HTTP
def handle_get(A, h, p, q):
    g = lambda k: q.get(k, [""])[0]
    if p == "/api/thumbs/boards":
        h._json(boards(A)); return True
    if p == "/api/thumbs/board":
        h._json(board(g("b"))); return True
    if p == "/api/thumbs/chars":
        h._json(lib_chars(A, g("b"))); return True
    if p == "/api/thumbs/file":
        A._send_file(h, file_path(g("b"), g("f"))); return True
    return False


def handle_post(A, h, p, q, body):
    if p == "/api/thumbs/board":
        h._json(save_board(body.get("b", ""), body.get("board"))); return True
    if p == "/api/thumbs/fromurl":
        try:
            h._json(from_url(A, body.get("b", ""), body.get("url", "")))
        except ValueError:                               # оригинал не отдали — берём превью из выдачи поиска
            if not body.get("fallback"):
                raise
            h._json({**from_url(A, body.get("b", ""), body["fallback"]), "thumb": True})
        return True
    if p == "/api/thumbs/generate":
        h._json(generate(A, body)); return True
    if p == "/api/thumbs/fromlib":
        h._json(from_lib(A, body.get("b", ""), body.get("slug", ""), body.get("emotion") or "")); return True
    if p == "/api/thumbs/use":
        h._json(use(A, body.get("b", ""), body.get("src", ""))); return True
    if p == "/api/thumbs/unuse":
        h._json(unuse(A, body.get("b", ""))); return True
    if p == "/api/thumbs/paste":
        h._json(paste(body.get("from", ""), body.get("to", ""), body.get("files"), body.get("results"))); return True
    return False
