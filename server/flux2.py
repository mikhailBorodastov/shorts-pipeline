"""Локальные обложки: FLUX.2 [klein] от Black Forest Labs (text-to-image + до 3 референсов в одной модели) через ComfyUI.

По умолчанию — тот же ComfyUI Studio, что и для локальной 3D (tools/comfyui, 127.0.0.1:8199, поднимается сам через comfy3d.start);
в ⚙ Настройках можно указать адрес другого ComfyUI (тогда Studio его не запускает, только шлёт графы).
Граф — как в шаблонах Comfy-Org «Flux.2 Klein … Image Edit (Distilled)» (workflow_templates, MIT): UNETLoader + CLIPLoader(flux2) + VAELoader →
CLIPTextEncode / ConditioningZeroOut → на каждый референс ImageScaleToTotalPixels(1 Мп) → VAEEncode → ReferenceLatent (в позитив и негатив) →
EmptyFlux2LatentImage + Flux2Scheduler(4 шага) + euler + CFGGuider(cfg 1) → SamplerCustomAdvanced → VAEDecode → SaveImage.

Модель грузится один раз: ComfyUI кэширует выходы загрузчиков между запросами, пока граф тот же (меняются только промпт, сид, размер, картинки),
поэтому со второй картинки идёт только сэмплинг. Выгружает её «⏹ Освободить видеопамять» (⚙ Настройки) или 3D-лепка, которой нужна вся память.

Модели (веса — tools/comfy_setup.py --flux 4b | 9b-te | 9b):
  4b — FLUX.2 [klein] 4B, Apache 2.0 (можно коммерчески): flux-2-klein-4b-fp8 + qwen_3_4b + flux2-vae;
  9b — FLUX.2 [klein] 9B, FLUX Non-Commercial: flux-2-klein-9b-fp8 (gated — принять лицензию на HF) + qwen_3_8b_fp8mixed + flux2-vae;
       выключена, пока в настройках не включено allow9b.

Настройки — .studio/state.json → flux (⚙ Настройки → «Локальные обложки»): url, weights_dir, model, allow9b, timeout, steps.
Переменная STUDIO_FLUX_URL важнее url из настроек.

API: generate_thumbnail(prompt, refs=[], size=(1280, 720), seed=None, model=None, out=путь, title=None) -> (путь PNG, meta)
Надписи: модель пишет кириллицу с опечатками (тест 2026-10: 3 из 10 заголовков 4B без ошибок) — для заголовка есть title:
картинка генерируется без текста, с местом под надпись, а заголовок накладывается шрифтом Rubik 900 с обводкой (_raw.png — без надписи).
CLI: python flux2.py status | gen "<промпт>" [--ref a.png …] [--size 1280x720] [--seed N] [--model 4b|9b] [--out x.png] [--title "ЗАГОЛОВОК"] | bench [--model 4b|9b]
"""
import json, os, random, sys, time, urllib.error, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import paths as P  # noqa: E402

MODELS = {
    "4b": {"label": "FLUX.2 klein 4B · локально", "unet": "flux-2-klein-4b-fp8.safetensors", "clip": "qwen_3_4b.safetensors", "vae": "flux2-vae.safetensors",
           "license": "Apache 2.0", "page": "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8"},
    "9b": {"label": "FLUX.2 klein 9B · локально (некоммерч.)", "unet": "flux-2-klein-9b-fp8.safetensors", "clip": "qwen_3_8b_fp8mixed.safetensors", "vae": "flux2-vae.safetensors",
           "license": "FLUX Non-Commercial", "page": "https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8"},
}
DEFAULTS = {"url": "", "weights_dir": "", "model": "4b", "allow9b": False, "timeout": 300, "steps": 4}
MAX_REFS = 3
SIZE = (1280, 720)
ASPECTS = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4)}
RES = {"720p": 720, "1080p": 1080}                     # короткая сторона


class FluxError(RuntimeError):
    """Понятная автору ошибка (не запущен сервис, нет весов, видеопамять, таймаут) — текст идёт прямо в карточку результата."""


# ---------------------------------------------------------------- настройки
def config():
    c = dict(DEFAULTS, **(P.state_get("flux") or {}))
    if os.environ.get("STUDIO_FLUX_URL"):
        c["url"] = os.environ["STUDIO_FLUX_URL"]
    return c


def save_config(body):
    c = dict(DEFAULTS, **(P.state_get("flux") or {}))
    for k in DEFAULTS:
        if k in body and body[k] is not None:
            v = body[k]
            if k in ("timeout", "steps"):
                v = max(1, int(v))
            elif k == "allow9b":
                v = bool(v)
            elif k == "model":
                v = v if v in MODELS else "4b"
            else:
                v = str(v).strip().strip('"').rstrip("/\\")
            c[k] = v
    if c["weights_dir"] and not os.path.isdir(c["weights_dir"]):
        raise ValueError("нет такой папки: " + c["weights_dir"])
    P.state_set("flux", c)
    write_extra_paths(c)
    return status()


def write_extra_paths(c=None):
    """weights_dir -> .studio/comfy_extra_paths.yaml: ComfyUI Studio ищет веса ещё и там (подхватит при следующем запуске)."""
    c = c or config()
    f = os.path.join(P.STATE, "comfy_extra_paths.yaml")
    d = c.get("weights_dir")
    if not d:
        if os.path.isfile(f):
            os.remove(f)
        return
    d = d.replace("\\", "/")
    os.makedirs(P.STATE, exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:            # и плоская папка, и раскладка как у ComfyUI (diffusion_models/, text_encoders/, vae/)
        fh.write(f"studio_flux:\n    base_path: \"{d}\"\n    diffusion_models: |\n        diffusion_models\n        unet\n        .\n"
                 f"    text_encoders: |\n        text_encoders\n        clip\n        .\n    vae: |\n        vae\n        .\n")


def local():
    """Адрес не задан — свой ComfyUI Studio (поднимаем сами)."""
    return not config()["url"]


def base():
    if local():
        import comfy3d
        return comfy3d.BASE
    u = config()["url"]
    return u if u.startswith("http") else "http://" + u


def model_dirs():
    import comfy3d
    dirs = [os.path.join(comfy3d.ROOT, "ComfyUI", "models")]
    if config()["weights_dir"]:
        dirs.append(config()["weights_dir"])
    return dirs


def files_on_disk():
    have = set()
    for d in model_dirs():
        for _, _, fs in os.walk(d):
            have.update(fs)
    return have


def status():
    """Для ⚙ Настроек и доски обложек: что скачано, запущен ли сервис, настройки."""
    c = config()
    have = files_on_disk() if local() else set()
    out = {"config": c, "local": local(), "base": base(), "alive": alive(), "models": {}}
    for k, m in MODELS.items():
        miss = [m[x] for x in ("unet", "clip", "vae") if m[x] not in have] if local() else []
        out["models"][k] = {"label": m["label"], "license": m["license"], "page": m["page"], "missing": miss, "ready": not miss, "enabled": k == "4b" or c["allow9b"]}
    return out


def enabled_models():
    """Модели для списка на доске: 4B всегда, 9B — только если включена в настройках."""
    c = config()
    return [k for k in MODELS if k == "4b" or c["allow9b"]]


# ---------------------------------------------------------------- HTTP к ComfyUI
def _get(path, timeout=30):
    return json.loads(urllib.request.urlopen(base() + path, timeout=timeout).read())


def alive():
    try:
        _get("/system_stats", 2)
        return True
    except Exception:
        return False


def ensure_service(log=print):
    if alive():
        return
    if not local():
        raise FluxError(f"Сервис генерации не отвечает по адресу {base()} — запусти там ComfyUI (с --listen) или очисти адрес в ⚙ Настройках, "
                        "тогда Studio поднимет свой ComfyUI сама")
    import comfy3d
    try:
        comfy3d.start(log, need3d=False)
    except RuntimeError as e:
        raise FluxError(str(e))


def _check_model(key):
    """Есть ли веса у сервиса: смотрим списки загрузчиков в /object_info (работает и для чужого ComfyUI)."""
    m = MODELS[key]
    try:
        info = _get("/object_info/UNETLoader", 60)["UNETLoader"]["input"]["required"]["unet_name"][0], \
            _get("/object_info/CLIPLoader", 60)["CLIPLoader"]["input"]["required"]["clip_name"][0], \
            _get("/object_info/VAELoader", 60)["VAELoader"]["input"]["required"]["vae_name"][0]
    except Exception as e:
        raise FluxError("ComfyUI не отдал список моделей: " + str(e)[:200])
    miss = [m[x] for x, lst in zip(("unet", "clip", "vae"), info) if m[x] not in lst]
    if miss:
        hint = ("веса 9B закрыты лицензией: прими её на " + m["page"] + ", залогинься (`hf auth login`) и запусти «⬇ Скачать 9B» в ⚙ Настройках"
                if key == "9b" and m["unet"] in miss else "⚙ Настройки → «Локальные обложки» → «⬇ Скачать» (или python _studio/tools/comfy_setup.py --flux " + key + ")")
        on_disk = local() and all(x in files_on_disk() for x in miss)
        if on_disk:                                         # файл уже лежит, а ComfyUI запущен раньше — он не видит новые веса до перезапуска
            hint = "файлы уже скачаны, а ComfyUI запущен раньше — нажми «⏹ Освободить видеопамять» в ⚙ Настройках и повтори"
        raise FluxError(f"Нет весов {', '.join(miss)} — {hint}")


def _flat(path):
    """Прозрачный PNG (персонаж без фона с доски) -> на белый: LoadImage в ComfyUI отбрасывает альфу, и прозрачное становится чёрным."""
    from PIL import Image
    import io
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A"))
        buf = io.BytesIO()
        bg.save(buf, "PNG")
        return buf.getvalue(), ".png"
    return open(path, "rb").read(), os.path.splitext(path)[1].lower() or ".png"


def _upload(path):
    bnd = "----fx" + uuid.uuid4().hex
    data, ext = _flat(path)
    name = f"studio_flux_{uuid.uuid4().hex[:8]}{ext}"
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() \
        + data + f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n".encode()
    r = urllib.request.Request(base() + "/upload/image", body, {"Content-Type": "multipart/form-data; boundary=" + bnd}, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=120).read())["name"]


def _queue(api, cid):
    body = json.dumps({"prompt": api, "client_id": cid}).encode()
    r = urllib.request.Request(base() + "/prompt", body, {"Content-Type": "application/json"}, method="POST")
    try:
        res = json.loads(urllib.request.urlopen(r, timeout=60).read())
    except urllib.error.HTTPError as e:
        raise FluxError("ComfyUI не принял граф: " + e.read().decode("utf-8", "replace")[:800])
    except urllib.error.URLError as e:
        raise FluxError(f"Сервис генерации не отвечает ({base()}): {e.reason}")
    if res.get("node_errors"):
        raise FluxError("ComfyUI не принял граф: " + json.dumps(res["node_errors"], ensure_ascii=False)[:800])
    return res["prompt_id"]


def _interrupt(pid):
    for path, body in (("/queue", {"delete": [pid]}), ("/interrupt", {"prompt_id": pid})):
        try:
            urllib.request.urlopen(urllib.request.Request(base() + path, json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST"), timeout=5)
        except Exception:
            pass


def _oom(msg):
    m = (msg or "").lower()
    return "out of memory" in m or "outofmemory" in m or "cuda error: out" in m or "allocation on device" in m


def _wait(pid, timeout, log):
    t0, pending = time.time(), True
    while time.time() - t0 < timeout:
        try:
            h = _get(f"/history/{pid}", 30).get(pid)
        except Exception as e:
            raise FluxError(f"ComfyUI перестал отвечать во время генерации ({e}) — возможно, упал от нехватки памяти; см. _studio/tools/comfyui/comfy.log")
        if h:
            st = h.get("status") or {}
            if st.get("status_str") == "error":
                err = next((m[1] for m in st.get("messages") or [] if m[0] == "execution_error"), {})
                text = f"{err.get('exception_type', '')}: {err.get('exception_message', '')}"
                if _oom(text):
                    raise FluxError("Не хватает видеопамяти: закрой игры и рендер, нажми «⏹ Освободить видеопамять» (⚙ Настройки), "
                                    "уменьши размер или возьми 4B вместо 9B")
                raise FluxError(f"ComfyUI: {err.get('node_type', '')}: {text.strip(': ')[:500]}")
            if st.get("completed") or st.get("status_str") == "success":
                return h
        if pending:
            try:
                q = _get("/queue", 10)
                pending = any(x[1] == pid for x in q.get("queue_pending") or [])
                log("в очереди ComfyUI" if pending else "генерирую")
            except Exception:
                pass
        time.sleep(0.25)
    _interrupt(pid)
    raise FluxError(f"Генерация не уложилась в {timeout} с — остановил. Первый запуск грузит модель с диска дольше; "
                    "если повторяется — проверь, не занята ли видеокарта, или подними таймаут в ⚙ Настройках")


# ---------------------------------------------------------------- граф
def size_for(aspect=None, res=None, size=None):
    """Точный размер картинки (w, h), чётный. size=(w,h) или 'WxH' важнее аспекта; по умолчанию 1280×720.
    Латенты FLUX кратны 16: генерируем с округлением вверх (gen_dims) и обрезаем по центру — 1920×1080 выходит ровно."""
    if size:
        w, h = (int(x) for x in (size.lower().split("x") if isinstance(size, str) else size))
    elif aspect in ASPECTS:
        a, b = ASPECTS[aspect]
        short = RES.get(res, 720)
        w, h = (round(short * a / b), short) if a >= b else (short, round(short * b / a))
    else:
        w, h = SIZE
    w, h = max(256, min(2048, w)), max(256, min(2048, h))
    return w - w % 2, h - h % 2


def gen_dims(w, h):
    return -(-w // 16) * 16, -(-h // 16) * 16


def _crop(path, w, h):
    from PIL import Image
    im = Image.open(path)
    if im.size != (w, h):
        x, y = (im.width - w) // 2, (im.height - h) // 2
        im.crop((x, y, x + w, y + h)).save(path)


def build(key, prompt, images, w, h, seed, steps):
    m = MODELS[key]
    L = lambda nid, slot=0: [str(nid), slot]
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": m["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": m["clip"], "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": m["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": L(2), "text": prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": L(4)}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": w, "height": h}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
    }
    pos, neg = L(4), L(5)
    for i, img in enumerate(images):                       # референс: 1 Мп -> латент -> ReferenceLatent на обе ветки (как в шаблоне Comfy-Org)
        b = 100 + i * 10
        g[str(b)] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[str(b + 1)] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": L(b), "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 1}}
        g[str(b + 2)] = {"class_type": "VAEEncode", "inputs": {"pixels": L(b + 1), "vae": L(3)}}
        g[str(b + 3)] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos, "latent": L(b + 2)}}
        g[str(b + 4)] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": neg, "latent": L(b + 2)}}
        pos, neg = L(b + 3), L(b + 4)
    g["10"] = {"class_type": "CFGGuider", "inputs": {"model": L(1), "positive": pos, "negative": neg, "cfg": 1.0}}
    g["11"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": L(9), "guider": L(10), "sampler": L(8), "sigmas": L(7), "latent_image": L(6)}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": L(11), "vae": L(3)}}
    g["13"] = {"class_type": "SaveImage", "inputs": {"images": L(12), "filename_prefix": "studio/flux2"}}
    return g


# ---------------------------------------------------------------- заголовок поверх (запасной путь для кириллицы)
FONT = os.path.join(os.path.dirname(HERE), "template", "assets", "fonts", "Rubik.ttf")


def title_side(w, h):
    return "left" if w > h * 1.15 else "top"


def title_prompt(prompt, side):
    where = {"left": "the left half", "top": "the top third"}[side]
    return prompt + f". No text, no letters, no logos anywhere. Keep {where} of the image as clean empty background for a headline; main subject on the other side."


def draw_title(path, title, side=None, fill=(17, 17, 17), stroke=(255, 255, 255)):
    """Заголовок 1–3 слова: Rubik 900, толстая белая обводка, по словам в строку, кегль подбирается под зону (левая половина / верхняя треть)."""
    from PIL import Image, ImageDraw, ImageFont
    im = Image.open(path).convert("RGB")
    W, H = im.size
    side = side or title_side(W, H)
    words = title.upper().split()
    lines = words if len(words) > 1 else [title.upper()]
    if len(words) == 4:
        lines = [" ".join(words[:2]), " ".join(words[2:])]
    bx, by, bw, bh = (int(W * .05), int(H * .08), int(W * .45), int(H * .84)) if side == "left" else (int(W * .07), int(H * .09), int(W * .86), int(H * .28))
    size = int(bh / len(lines) * 0.95)
    while size > 12:
        f = ImageFont.truetype(FONT, size)
        try:
            f.set_variation_by_axes([900])
        except Exception:
            pass
        sw = max(3, size // 9)
        dr = ImageDraw.Draw(im)
        boxes = [dr.textbbox((0, 0), ln, font=f, stroke_width=sw) for ln in lines]
        lh = [b[3] - b[1] for b in boxes]
        if max(b[2] - b[0] for b in boxes) <= bw and sum(lh) + (len(lines) - 1) * size * .08 <= bh:
            break
        size -= 4
    total = sum(lh) + (len(lines) - 1) * size * .08
    y = by + (bh - total) / 2
    for ln, b, hgt in zip(lines, boxes, lh):
        x = bx + (bw - (b[2] - b[0])) / 2 - b[0]
        dr.text((x, y - b[1]), ln, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke)
        y += hgt + size * .08
    im.save(path)
    return side


# ---------------------------------------------------------------- адаптер
def generate_thumbnail(prompt, refs=(), size=None, seed=None, model=None, out=None, aspect=None, res=None, log=lambda s: None, title=None):
    """-> (путь картинки, meta {model, seed, w, h, refs, secs, gen_secs}). Блокирует — вызывать из фонового потока (thumbs_api так и делает)."""
    c = config()
    key = model if model in MODELS else c["model"]
    if key == "9b" and not c["allow9b"]:
        raise FluxError("FLUX.2 klein 9B выключена — она под некоммерческой лицензией. Включить: ⚙ Настройки → «Локальные обложки» → «Разрешить 9B»")
    prompt = (prompt or "").strip()
    if not prompt:
        raise FluxError("нужен промпт")
    refs = [r for r in (refs or []) if r][:MAX_REFS]
    for r in refs:
        if not os.path.isfile(r):
            raise FluxError("нет файла референса: " + r)
    w, h = size_for(aspect, res, size)
    title = (title or "").strip()
    if title:
        prompt = title_prompt(prompt, title_side(w, h))
    seed = int(seed) if seed not in (None, "") else random.randint(1, 2 ** 48)
    t0 = time.time()
    log("запускаю ComfyUI" if not alive() else "готовлю граф")
    ensure_service(log)
    _check_model(key)
    imgs = [_upload(r) for r in refs]
    t1 = time.time()
    import gpulock
    with gpulock.hold("обложка FLUX", log):                  # S22: видеокарта по очереди с рендером
        t1 = time.time()                                     # замер генерации — без ожидания видеокарты
        pid =_queue(build(key, prompt, imgs, *gen_dims(w, h), seed, int(c["steps"])), uuid.uuid4().hex)
        hist = _wait(pid, int(c["timeout"]), log)
    f = next((x for o in (hist.get("outputs") or {}).values() for x in o.get("images") or [] if x.get("type") == "output"), None)
    if not f:
        raise FluxError("ComfyUI не вернул картинку")
    q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": "output"})
    data = urllib.request.urlopen(f"{base()}/view?{q}", timeout=120).read()
    out = out or os.path.join(P.STATE, "flux", f"flux_{int(time.time())}.png")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(data)
    _crop(out, w, h)
    if title:                                              # без надписи — рядом, чтобы переписать заголовок без новой генерации
        import shutil
        shutil.copy2(out, os.path.splitext(out)[0] + "_raw.png")
        draw_title(out, title)
    meta = {"provider": "flux2-klein", "model": key, "license": MODELS[key]["license"], "seed": seed, "w": w, "h": h, "refs": len(refs),
            "steps": int(c["steps"]), "title": title, "secs": round(time.time() - t0, 2), "gen_secs": round(time.time() - t1, 2)}
    return out, meta


# ---------------------------------------------------------------- CLI
def _bench(model):
    """Замеры: без референсов и с 1–3 (референсы — картинки, сгенерированные тут же). Первый прогон — с загрузкой модели."""
    d = os.path.join(P.STATE, "flux", "bench_" + model)
    os.makedirs(d, exist_ok=True)
    rows = []
    for i, n in enumerate([0, 0, 0, 1, 2, 3]):
        refs = [os.path.join(d, f"t{k}.png") for k in range(n)]
        p = "a paper cutout hedgehog holding a giant red button, bright yellow background, bold collage style" if not n else \
            "the hedgehog from image 1 stands next to the objects from the other images, bright cyan background, paper collage"
        f, m = generate_thumbnail(p, refs, SIZE, 1000 + i, model, os.path.join(d, f"t{len([r for r in rows if not r['refs']])}.png" if not n else f"r{n}.png"))
        rows.append(m)
        print(f"{model}  refs={n}  {m['w']}x{m['h']}  всего {m['secs']:.2f} с  (генерация {m['gen_secs']:.2f} с){'  ← с загрузкой модели' if i == 0 else ''}", flush=True)
    return rows


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    if not a or a[0] == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=1))
    elif a[0] == "gen":
        refs = [a[i + 1] for i, x in enumerate(a) if x == "--ref"]
        try:
            print(generate_thumbnail(a[1], refs, opt("--size"), opt("--seed"), opt("--model"), opt("--out"), log=lambda s: print("·", s, flush=True), title=opt("--title")))
        except FluxError as e:
            sys.exit("✗ " + str(e))
    elif a[0] == "bench":
        _bench(opt("--model", "4b"))
    else:
        print(__doc__)
