"""Локальная генерация 3D по картинке: TRELLIS.2 / Pixal3D в отдельном ComfyUI Studio (tools/comfyui, ставит tools/comfy_setup.py).
Studio сама поднимает ComfyUI в фоне (127.0.0.1:8199, без окна), шлёт граф через /prompt и забирает GLB.
Граф — шаблоны Comfy-Org (server/comfy/*.json, MIT), переведённые в API-формат по /object_info; правим узлы по id шаблона.

Режимы (params.mode) — всё для «refine» героя:
  draft  — черновик: форма 512³ без апскейла, текстура 1024, лёгкая сетка (~1–2 мин на 16 ГБ);
  final  — «⬆ Довести»: те же сиды структуры и формы (та же фигура) + апскейл 1536³, текстура 2048–4096, полная сетка;
  retex  — «🎨 Перетекстурить»: форма та же (сиды структуры, формы, апскейла), новый сид текстуры и, если есть, другая картинка для текстуры;
  fix    — правки по пинам: параметры подбирает Claude (ideas_claude.trellisfix_spec) — сиды, движок, рамка, сетка — дальше как draft/final.
Движок (params.engine): pixal3d (по умолчанию: точнее повторяет картинку), trellis (TRELLIS.2), multiview (Pixal3D по 2–4 ракурсам: front/left/back/right).
CLI: python comfy3d.py status | start | stop | info | run <картинка> <папка> [JSON-параметры]"""
import json, os, random, subprocess, sys, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(HERE)
ROOT = os.path.join(STUDIO, "tools", "comfyui", "ComfyUI_windows_portable")
PY = os.path.join(ROOT, "python_embeded", "python.exe")
PORT = int(os.environ.get("STUDIO_COMFY_PORT") or 8199)
BASE = f"http://127.0.0.1:{PORT}"
TPL = {"single": os.path.join(HERE, "comfy", "image_to_model.json"), "multiview": os.path.join(HERE, "comfy", "multi_views.json")}
CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_PROC = None
_INFO = None

# id узлов в шаблонах Comfy-Org (одинаковые в обоих)
N = dict(load=122, switch=316, bgswitch=248, crop=312, s_struct=3, s_shape=18, upsample=94, s_up=23, decode_shape=92, tex_stage=98, s_tex=12,
         remesh=241, decimate=186, unwrap=196, bake=147, texres=288, normal=224, ao=233, save=322, pixcond=298, trcond=299, struct_dec=119)
VIEWS = {"front": 364, "left": 364, "back": 364, "right": 364}       # multiview: один лист-разворот режется ImageCropV2 (338/341/342/345) — свои картинки подставляем на место кропов
MV_SLOTS = {"front": 340, "left": 344, "back": 343, "right": 346}   # SaveImageAdvanced -> Pixal3DMultiViewConditioning
MV_CROPS = {"front": 338, "left": 341, "back": 342, "right": 345}


# ---------------------------------------------------------------- ComfyUI: есть ли, запуск
def installed():
    need = ["trellis_2_int8_convrot.safetensors", "pixal3d_int8_convrot.safetensors", "trellis_2_shape_vae_bf16.safetensors",
            "trellis_2_texture_vae_bf16.safetensors", "dino_v3_L_naf_fp32.safetensors", "birefnet.safetensors", "moge_2_vitl_normal_fp16.safetensors"]
    have = {f for _, _, fs in os.walk(os.path.join(ROOT, "ComfyUI", "models")) for f in fs}
    return {"comfy": os.path.isfile(PY), "missing": [m for m in need if m not in have],
            "multiview": "pixal3d_multiview_int8_convrot.safetensors" in have, "dir": ROOT, "port": PORT}


def _get(path, timeout=30):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=timeout).read())


def alive():
    try:
        _get("/system_stats", 2)
        return True
    except Exception:
        return False


def start(log=print, timeout=240):
    """Поднять ComfyUI Studio (если не поднят). Вывод — tools/comfyui/comfy.log."""
    global _PROC
    if alive():
        return True
    st = installed()
    if not st["comfy"]:
        raise RuntimeError("ComfyUI для 3D не установлен — ⚙ Настройки → «Локальная 3D (TRELLIS.2)» → Установить (или python _studio/tools/comfy_setup.py)")
    if st["missing"]:
        raise RuntimeError("не хватает моделей: " + ", ".join(st["missing"]) + " — докачай: python _studio/tools/comfy_setup.py")
    log("запускаю ComfyUI (TRELLIS.2)…")
    lf = open(os.path.join(os.path.dirname(ROOT), "comfy.log"), "ab")
    _PROC = subprocess.Popen([PY, "-s", os.path.join(ROOT, "ComfyUI", "main.py"), "--port", str(PORT), "--listen", "127.0.0.1", "--disable-auto-launch",
                              "--windows-standalone-build"], cwd=ROOT, stdout=lf, stderr=lf, stdin=subprocess.DEVNULL, creationflags=CF)
    t0 = time.time()
    while time.time() - t0 < timeout:
        if _PROC.poll() is not None:
            raise RuntimeError("ComfyUI не запустился — см. _studio/tools/comfyui/comfy.log")
        if alive():
            return True
        time.sleep(1.5)
    raise RuntimeError("ComfyUI не ответил за 4 минуты — см. _studio/tools/comfyui/comfy.log")


def stop():
    """Остановить ComfyUI Studio (освободить видеопамять)."""
    try:
        urllib.request.urlopen(urllib.request.Request(BASE + "/api/manager/reboot"), timeout=2)
    except Exception:
        pass
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}"],
                       capture_output=True, creationflags=CF)
    return not alive()


# ---------------------------------------------------------------- шаблон -> API-граф
def object_info():
    global _INFO
    if _INFO is None:
        _INFO = _get("/object_info", 120)
    return _INFO


WIDGET_T = ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3")


def _is_widget(spec):
    t = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
    return isinstance(t, list) or t in WIDGET_T


def _order(d):
    return list((d.get("required") or {}).items()) + list((d.get("optional") or {}).items())


def to_api(ui):
    """Граф из редактора ComfyUI (nodes/links) -> API-формат {id: {class_type, inputs}} по /object_info."""
    info = object_info()
    links = {l[0]: l for l in ui["links"]}
    api = {}
    for n in ui["nodes"]:
        t = n["type"]
        if t in ("Note", "MarkdownNote") or n.get("mode") in (2, 4) or t not in info:
            continue
        socket = {i["name"] for i in n.get("inputs") or [] if not i.get("widget")}
        linked = {i["name"]: links[i["link"]] for i in n.get("inputs") or [] if i.get("link") in links}
        wv = n.get("widgets_values")
        vals = wv if isinstance(wv, dict) else {}                  # новые узлы иногда пишут словарём
        wv = None if isinstance(wv, dict) else list(wv or [])
        inputs = {}

        def walk(order, prefix=""):
            for name, spec in order:
                full = prefix + name
                opt = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
                widget = _is_widget(spec) or (name not in socket and not prefix)   # свои виджеты узла (LOAD_3D у Save3DAdvanced) — тоже значение в widgets_values
                v = None
                if widget:
                    if wv:
                        v = wv.pop(0)
                        if opt.get("control_after_generate") and wv and wv[0] in ("fixed", "randomize", "increment", "decrement"):
                            wv.pop(0)
                    elif full in vals:
                        v = vals[full]
                if full in linked:
                    l = linked[full]; inputs[full] = [str(l[1]), l[2]]
                elif v is not None:
                    inputs[full] = v
                if (spec[0] if isinstance(spec, (list, tuple)) else spec) == "COMFY_DYNAMICCOMBO_V3":   # выбранный вариант тянет свои поля: «имя.поле»
                    o = next((o for o in opt.get("options") or [] if o.get("key") == v), None)
                    if o:
                        walk(_order(o.get("inputs") or {}), full + ".")

        walk(_order(info[t]["input"]))
        for name, spec in (info[t]["input"].get("required") or {}).items():   # шаблон старше узла: новые обязательные поля — по умолчанию
            if name not in inputs and _is_widget(spec):
                o = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
                if "default" in o:
                    inputs[name] = o["default"]
                elif isinstance(spec[0], list) and spec[0]:
                    inputs[name] = spec[0][0]
                elif o.get("options"):
                    inputs[name] = o["options"][0] if not isinstance(o["options"][0], dict) else o["options"][0].get("key")
        api[str(n["id"])] = {"class_type": t, "inputs": inputs, "_meta": {"title": n.get("title") or t}}
    # узлы без входящих связей, которые никуда не ведут, движок отбросит сам; висячие ссылки на выкинутые узлы убираем
    for nid, nd in api.items():
        for k2, v in list(nd["inputs"].items()):
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] not in api:
                del nd["inputs"][k2]
    return api


def _set(api, nid, **kw):
    api[str(nid)]["inputs"].update(kw)


def prune(api):
    """Ссылка на удалённый узел: необязательный вход — убрать, обязательный — убрать весь узел (и дальше по цепочке)."""
    info = object_info()
    while True:
        gone = False
        for nid in list(api):
            nd = api[nid]
            req = (info.get(nd["class_type"], {}).get("input") or {}).get("required") or {}
            for k, v in list(nd["inputs"].items()):
                if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] not in api:
                    if k.split(".")[0] in req:
                        api.pop(nid); gone = True; break
                    del nd["inputs"][k]
        if not gone:
            return api


def save_id(api):
    return next(k for k, v in api.items() if v["class_type"] == "Save3DAdvanced")


def _link(nid, slot=0):
    return [str(nid), slot]


# ---------------------------------------------------------------- загрузка картинок, запуск, результат
def upload(path):
    bnd = "----cs" + uuid.uuid4().hex
    name = f"studio_{uuid.uuid4().hex[:8]}{os.path.splitext(path)[1].lower() or '.png'}"
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() \
        + open(path, "rb").read() + f"\r\n--{bnd}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{bnd}--\r\n".encode()
    r = urllib.request.Request(BASE + "/upload/image", body, {"Content-Type": "multipart/form-data; boundary=" + bnd}, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=120).read())["name"]


def queue(api):
    cid = uuid.uuid4().hex
    body = json.dumps({"prompt": {k: {"class_type": v["class_type"], "inputs": v["inputs"]} for k, v in api.items()}, "client_id": cid}).encode()
    r = urllib.request.Request(BASE + "/prompt", body, {"Content-Type": "application/json"}, method="POST")
    try:
        res = json.loads(urllib.request.urlopen(r, timeout=60).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError("ComfyUI не принял граф: " + e.read().decode("utf-8", "replace")[:1500])
    if res.get("node_errors"):                                    # граф частично не прошёл проверку — дальше не ждём
        bad = [f"{v.get('class_type')} {k}: " + "; ".join(f"{e.get('message')} {e.get('details', '')}".strip() for e in v.get("errors") or []) for k, v in res["node_errors"].items()]
        raise RuntimeError("ComfyUI не принял граф: " + " | ".join(bad)[:1500])
    return res["prompt_id"]


def wait(pid, log, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = _get(f"/history/{pid}", 30).get(pid)
        if h:
            st = h.get("status") or {}
            if st.get("status_str") == "error":
                msg = next((m[1] for m in st.get("messages") or [] if m[0] == "execution_error"), {})
                raise RuntimeError(f"ComfyUI: {msg.get('node_type', '')}: {str(msg.get('exception_message', msg))[:600]}")
            if st.get("completed") or st.get("status_str") == "success":   # выходы превью появляются раньше конца — ждём статус
                return h
        try:
            q = _get("/queue", 10)
            log(f"TRELLIS лепит модель… {int(time.time() - t0)} с" + (" (в очереди)" if any(x[1] == pid for x in q.get("queue_pending") or []) else ""))
        except Exception:
            pass
        time.sleep(3)
    raise RuntimeError("TRELLIS не уложился в час")


def _files(h, nid):
    out = (h.get("outputs") or {}).get(str(nid)) or {}
    for k in ("3d", "result", "model_file", "images", "files"):
        for f in out.get(k) or []:
            if isinstance(f, dict) and f.get("filename"):
                yield f
            elif isinstance(f, str):
                yield {"filename": os.path.basename(f), "subfolder": os.path.dirname(f), "type": "output"}


def fetch(f, dst):
    q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
    data = urllib.request.urlopen(f"{BASE}/view?{q}", timeout=300).read()
    open(dst, "wb").write(data)
    return dst


# ---------------------------------------------------------------- сборка графа под режим
def build(p, images):
    """p — параметры (engine, mode, seeds, faces, tex, pad, bg, res); images — {'main': имя в ComfyUI} или {'front','left','back','right'} для multiview."""
    mv = p.get("engine") == "multiview"
    api = to_api(json.load(open(TPL["multiview" if mv else "single"], encoding="utf-8")))
    sd = p["seeds"]
    _set(api, N["s_struct"], seed=sd["structure"])
    _set(api, N["s_shape"], seed=sd["shape"])
    _set(api, N["s_up"], seed=sd["upsample"])
    _set(api, N["s_tex"], seed=sd["texture"])
    if mv:
        for slot, sv in MV_SLOTS.items():
            img = images.get(slot)
            crop = MV_CROPS[slot]
            if img:                                                # своя картинка ракурса вместо куска листа-разворота
                lid = f"9{sv}"
                api[lid] = {"class_type": "LoadImage", "inputs": {"image": img}, "_meta": {"title": "view " + slot}}
                for nid, nd in api.items():
                    for k, v in nd["inputs"].items():
                        if v == _link(crop):
                            nd["inputs"][k] = _link(lid)
            else:                                                  # ракурса нет — убрать его из условия
                for nd in api.values():
                    if nd["class_type"] == "Pixal3DMultiViewConditioning":
                        nd["inputs"].pop(slot, None)
        for nid in list(api):
            if api[nid]["class_type"] in ("LoadImage", "ImageCropV2") and nid in (str(VIEWS["front"]), *[str(c) for c in MV_CROPS.values()]):
                api.pop(nid, None)
        prune(api)                                                 # ракурсов меньше 4: цепочки пустых ракурсов уходят целиком
    else:
        _set(api, N["load"], image=images["main"])
        _set(api, N["switch"], value=p.get("engine") == "trellis")
        if p.get("bg") is False:
            _set(api, N["bgswitch"], switch=False)
        if p.get("pad"):                                          # поля вокруг героя на кадре (1.0–2.0): больше — меньше обрезает руки/оружие
            _set(api, N["crop"], pad_factor=float(p["pad"]))
    if images.get("tex") and not mv:                              # перетекстурить по другой картинке: она идёт только в стадию текстуры, форма — от основной
        pix = p.get("engine") != "trellis"
        api["9500"] = {"class_type": "LoadImage", "inputs": {"image": images["tex"]}, "_meta": {"title": "texture ref"}}
        api["9501"] = {"class_type": "RemoveBackground", "inputs": {"bg_removal_model": _link(193), "image": _link(9500)}, "_meta": {"title": "texture bg"}}
        api["9502"] = {"class_type": "ImageCropToMask", "inputs": dict(api[str(N["crop"])]["inputs"], images=_link(9500), masks=_link(9501)), "_meta": {"title": "texture crop"}}
        api["9503"] = ({"class_type": "Pixal3DConditioning", "inputs": dict(api[str(N["pixcond"])]["inputs"], image=_link(9502))} if pix else
                       {"class_type": "Trellis2Conditioning", "inputs": dict(api[str(N["trcond"])]["inputs"], image=_link(9502))})
        _set(api, N["tex_stage"], positive=_link(9503, 0), negative=_link(9503, 1))
    draft = p.get("mode") == "draft" or (p.get("mode") == "fix" and p.get("stage") != "final")
    tex = int(p.get("tex") or (1024 if draft else 2048))
    _set(api, N["texres"], value=tex)
    if draft:                                                     # без апскейла 1536: форма и текстура прямо от ступени 512
        api.pop(str(N["upsample"]), None); api.pop(str(N["s_up"]), None)
        _set(api, N["decode_shape"], samples=_link(N["s_shape"]))
        _set(api, N["tex_stage"], shape_latent=_link(N["s_shape"]))
        if not images.get("tex"):
            _set(api, N["tex_stage"], positive=_link(91, 0), negative=_link(91, 1))
        _set(api, N["remesh"], **{k: v for k, v in {"resolution": 512}.items() if k in api[str(N["remesh"])]["inputs"]})
    faces = int(p.get("faces") or (150000 if draft else 400000))
    dec = api[str(N["decimate"])]["inputs"]
    for k in ("target_faces", "face_count", "target", "faces"):
        if k in dec:
            dec[k] = faces
    if not draft:
        _set(api, N["upsample"], target_resolution=int(p.get("res") or 1536))
    # предпросмотры и лишние сохранения не нужны
    for nd_id in [k for k, v in api.items() if v["class_type"] in ("Preview3DAdvanced", "PreviewImage", "MaskPreview", "SaveImageAdvanced") and k not in [str(x) for x in MV_SLOTS.values()]]:
        if any(isinstance(v, list) and v[0] == nd_id for nd in api.values() for v in nd["inputs"].values()):
            continue                                               # через некоторые превью картинка идёт дальше (ImageCropToMask <- MaskPreview)
        api.pop(nd_id)
    _set(api, save_id(api), filename_prefix=f"studio/{p.get('tag', 'model')}")
    if p.get("mv_fov") and mv:
        for nd in api.values():
            if nd["class_type"] == "Pixal3DMultiViewConditioning":
                nd["inputs"]["fov"] = float(p["mv_fov"])
    return api


def new_seeds(base=None, keep=()):
    s = dict(base or {})
    for k in ("structure", "shape", "upsample", "texture"):
        if k not in keep or k not in s:
            s[k] = random.randint(1, 2 ** 31)
    return s


def generate(images, out_dir, log=print, **p):
    """images — {'main': путь} или {'front': путь, 'left': …}; -> (путь GLB, meta для info.json / renders[].meta)."""
    start(log)
    p.setdefault("engine", "pixal3d")
    p.setdefault("mode", "draft")
    p["seeds"] = p.get("seeds") or new_seeds()
    up = {k: upload(v) for k, v in images.items() if v}
    log("TRELLIS: картинки загружены, собираю граф…")
    api = build(p, up)
    json.dump(api, open(os.path.join(out_dir, "comfy_graph.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    t0 = time.time()
    h = wait(queue(api), log)
    glb = next((f for f in _files(h, save_id(api)) if f["filename"].lower().endswith((".glb", ".gltf"))), None)
    if not glb:
        glb = next((f for nid in (h.get("outputs") or {}) for f in _files(h, nid) if f["filename"].lower().endswith(".glb")), None)
    if not glb:
        raise RuntimeError("ComfyUI не отдал GLB: " + json.dumps(h.get("outputs"), ensure_ascii=False)[:600])
    raw = fetch(glb, os.path.join(out_dir, "trellis_raw.glb"))
    meta = {"provider": "trellis", "engine": p["engine"], "mode": p["mode"], "stage": "draft" if p["mode"] == "draft" or p.get("stage") == "draft" else "final",
            "seeds": p["seeds"], "tex": p.get("tex"), "faces": p.get("faces"), "pad": p.get("pad"), "bg": p.get("bg", True), "secs": round(time.time() - t0)}
    return raw, meta


if __name__ == "__main__":
    a = sys.argv[1:]
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if not a or a[0] == "status":
        print(json.dumps(dict(installed(), alive=alive()), ensure_ascii=False, indent=1))
    elif a[0] == "start":
        print(start())
    elif a[0] == "stop":
        print(stop())
    elif a[0] == "info":
        start(); print(json.dumps({k: object_info()[k]["input"] for k in a[1:]}, ensure_ascii=False, indent=1))
    elif a[0] == "api":
        start(); print(json.dumps(to_api(json.load(open(TPL[a[1] if len(a) > 1 else "single"], encoding="utf-8"))), ensure_ascii=False, indent=1))
    elif a[0] == "run":
        os.makedirs(a[2], exist_ok=True)
        imgs = json.loads(a[1]) if a[1].startswith("{") else {"main": a[1]}
        print(generate(imgs, a[2], **(json.loads(a[3]) if len(a) > 3 else {})))
    else:
        print(__doc__)
