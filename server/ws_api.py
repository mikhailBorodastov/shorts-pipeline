"""🛠 Мастерская ассета (S10, docs/studio/stage10-workshop.md): персонаж или пропс в своей служебной сцене редактора.

Ассет — элемент видео (препродакшен) или предмет библиотеки. Библиотечный сначала берётся в служебное видео канала «🛠 Мастерская»
(`service: "workshop"`, `studio_api.import_to_video`), так что всё работает как у элемента: редактор скелета, «✨ собери / почини», версии, «📚 в библиотеку».
Служебная сцена — элемент `kind: scene` с `ws: {el}` (ассет — `el:<id>@v<N>` текущей версии) в том же видео; в списках сцен, монтаже, упаковке и экспорте её нет.
POST /api/ws/open {src: 'lib:<kind>/<slug>[@N]' | 'el:<id>', key?} -> {video, el (сцена), asset (элемент)}; CLI: ws open <src> [--video ID]
POST /api/ws/clip {key, el, obj, name, t0, t1, loop, type} — ключи позы объекта в окне [t0, t1] -> клип библиотеки anims/<type>/<slug>.json (S10.1 «💾 Сохранить как клип»)
POST /api/ws/publish {key, asset} — версия ассета -> новая версия предмета библиотеки (или новый предмет)"""
import json, os, re, time

import paths as P

WS_NAME = "🛠 Мастерская"


def now_ms():
    return int(time.time() * 1000)


def service_video(A, cid):
    """Служебное видео канала для мастерской библиотечных ассетов (создаётся один раз)."""
    for vid, x in P.index(True)["videos"].items():
        if x.get("channel") != cid:
            continue
        try:
            d = A.load("plan:" + vid)
        except Exception:
            continue
        if d.get("service") == "workshop":
            return vid
    d = A.new_plan("short", WS_NAME, "", channel=cid)
    A.apply_ops("plan:" + d["id"], [{"op": "set", "path": ["service"], "value": "workshop"},
                                    {"op": "set", "path": ["idea"], "value": "Служебное видео: мастерская библиотечных персонажей и пропсов (скелет, анимации, предметы в руках). Не ролик."},
                                    {"op": "set", "path": ["engine"], "value": "3d"}])
    return d["id"]


def _cur_render(e):
    rs = e.get("renders") or []
    return next((r for r in rs if r.get("id") == e.get("render")), rs[-1] if rs else None)


def asset_ref(e):
    r = _cur_render(e)
    if not r:
        raise ValueError("у элемента ещё нет черновика — сначала нарисуй или собери его")
    if not (r.get("three3") or r.get("rigchar") or r.get("model3d")):
        raise ValueError("мастерская — для персонажей со скелетом и 3D-пропсов; 2D-черновик сначала собери со скелетом («🦴 Собрать персонажа») или сделай объёмным (🖥 TRELLIS)")
    return f"el:{e['id']}@v{r['v']}", r


def lib_element(A, lid, v=None, channel=None):
    """Рабочая копия предмета библиотеки (lid@v) в служебном видео канала -> (key, element). Есть — та же (с её черновиками и правками), нет — импорт.
    Правится всеми инструментами препродакшена; «📚 В библиотеку» (publish) делает новую версию того же предмета."""
    SA = A.stapi()
    c = SA.channel_dir(channel)
    key = "plan:" + service_video(A, c["id"])
    _, card = SA._card(c, lid)
    v = int(v or card["latest"])
    d = A.load(key)
    e = next((x for x in d.get("elements") or [] if (x.get("lib") or {}).get("id") == lid and (x.get("lib") or {}).get("v") == v and x.get("status") != "drop" and not x.get("ws")), None)
    if not e:
        r = SA.import_to_video(A, key, lid, v, "правка библиотечного предмета (рабочая копия)", "")
        e = A._by_id(A.load(key).get("elements"), r["el"])
    return key, e


def open_ws(A, src, key=None):
    if src.startswith("lib:"):
        lid, _, v = src[4:].partition("@")
        key, e = lib_element(A, lid, v or None, None if not key else P.index()["videos"].get(key[5:], {}).get("channel"))
    else:
        if not key:
            raise ValueError("нужно видео (key) для элемента")
        e = A._by_id(A.load(key).get("elements"), src[3:].split("@")[0])
        if not e:
            raise ValueError("элемент не найден")
    ref, r = asset_ref(e)
    d = A.load(key)
    ws = next((x for x in d.get("elements") or [] if (x.get("ws") or {}).get("el") == e["id"]), None)
    vid = key[5:]
    char = e.get("kind") == "char"
    h = float(((r.get("meta") or {}).get("h")) or (1.0 if char else 0.6))
    if not ws:
        sid = A.new_id("e")
        A.apply_ops(key, [{"op": "add", "path": ["elements"], "item": {"id": sid, "kind": "scene", "name": "🛠 " + e.get("name", ""), "desc": "служебная сцена мастерской",
                                                                     "status": "ok", "by": "studio", "uses": [e["id"]], "ws": {"el": e["id"]}}}])
        A.chnapi().empty_scene(A, vid, sid, "🛠 " + e.get("name", ""), {})
        A.apply_ops(key, [{"op": "set", "path": ["elements", sid, "stage"], "value": {"work": f"{vid}/{sid}/work", "from": "workshop", "by": "studio", "ts": now_ms()}}])
        ws = A._by_id(A.load(key).get("elements"), sid)
    # объект ассета в сцене: всегда текущая версия элемента; камера — по росту
    S = A.scapi()
    doc = S.load_scene(A, key, ws["id"])
    obj = next((o for o in doc.get("objects") or [] if o.get("id") == "asset"), None)
    ops = []
    if not obj:
        ops.append({"op": "add", "path": ["objects"], "item": {"id": "asset", "name": e.get("name", ""), "src": {"prefab": ref, "el": e["id"]}, "pos": [0, 0, 0], "rot": [0, 0, 0], "scale": 1}})
        hh = max(0.3, h)
        ops.append({"op": "set", "path": ["camera", "keys"], "value": [{"id": "c1", "t": 0, "pos": [0, hh * 0.6, hh * 4.4 + 0.6], "target": [0, hh * 0.48, 0], "ease": "io"}]})
        ops.append({"op": "set", "path": ["len"], "value": 4})
    elif (obj.get("src") or {}).get("prefab") != ref:
        ops.append({"op": "set", "path": ["objects", "asset", "src", "prefab"], "value": ref})
    if ops:
        S.apply(A, key, ws["id"], ops, by="ws", desc=f"мастерская: {e.get('name', '')} {ref}")   # служебная сборка — не «правил руками»: агент тоже может ставить ключи
    au = (S.load_scene(A, key, ws["id"]).get("authored") or {})
    if au.get("asset") == ["*"]:                                  # старые мастерские: объект ассета был помечен целиком при создании
        d2 = S.load_scene(A, key, ws["id"]); d2["authored"].pop("asset", None); S.save_scene(A, key, ws["id"], d2)
    return {"video": vid, "el": ws["id"], "asset": e["id"], "ref": ref, "kind": e.get("kind"), "lib": e.get("lib")}


# ---------------------------------------------------------------- ключи позы -> клип библиотеки (S5 формат: tracks "<кость>.<rot|len|sq>", "ik.<кость>", "face.<поле>")
def pose_to_tracks(pose, t0, t1):
    tracks = {}

    def put(k, t, v, ease):
        tracks.setdefault(k, []).append([round(t - t0, 4), v] + ([ease] if ease and ease != "io" else []))

    for k in sorted([x for x in pose or [] if t0 - 1e-6 <= x.get("t", 0) <= t1 + 1e-6], key=lambda x: x["t"]):
        t, ease = k["t"], k.get("ease")
        for b, ch in (k.get("bones") or {}).items():
            for f, v in (ch or {}).items():
                if isinstance(v, (int, float)):
                    put(f"{b}.{f}", t, v, ease)
        for b, v in (k.get("ik") or {}).items():
            put(f"ik.{b}", t, v, ease)
        for f, v in (k.get("face") or {}).items():
            put(f"face.{f}", t, v, ease)
        for f, v in (k.get("card") or {}).items():
            put(f"card.{f}", t, v, ease)
        for f in ("sit", "facing"):
            if f in k:
                put(f, t, k[f], ease)
    return tracks


def save_clip(A, key, el, obj_id, name, t0, t1, loop, typ):
    S = A.scapi()
    doc = S.load_scene(A, key, el)
    o = next((x for x in doc.get("objects") or [] if x.get("id") == obj_id), None)
    if not o:
        raise ValueError("объект не найден")
    t0, t1 = float(t0), float(t1)
    tracks = pose_to_tracks(o.get("pose"), t0, t1)
    if not tracks:
        raise ValueError(f"в окне {t0:g}–{t1:g} с нет ключей позы — поставь их (ручки на лапах, свойства позы) и сохрани снова")
    vid = key[5:]
    c = A.stapi().channel_dir(P.index()["videos"].get(vid, {}).get("channel"))
    typ = re.sub(r"[^a-z0-9-]", "", (typ or "").lower()) or "hog"
    d = os.path.join(A.stapi().lib_dir(c), "anims", typ)
    os.makedirs(d, exist_ok=True)
    base = A.stapi().slug(name) or "clip"
    slug, k = base, 2
    while os.path.isfile(os.path.join(d, slug + ".json")):
        slug, k = f"{base}-{k}", k + 1
    clip = {"schema": 1, "id": f"{typ}/{slug}", "name": name, "type": typ, "dur": round(t1 - t0, 4), "loop": bool(loop), "tracks": tracks,
            "by": "author", "from": {"video": vid, "scene": el, "obj": obj_id, "t0": t0, "t1": t1}, "created": time.strftime("%Y-%m-%d")}
    A.write_text(os.path.join(d, slug + ".json"), json.dumps(clip, ensure_ascii=False, indent=1))
    return {"id": clip["id"], "path": os.path.join(d, slug + ".json"), "tracks": len(tracks), "dur": clip["dur"]}


def publish(A, key, asset):
    """Версия ассета мастерской -> библиотека: новая версия того же предмета (если ассет из библиотеки) или новый предмет."""
    e = A._by_id(A.load(key).get("elements"), asset)
    if not e:
        raise ValueError("элемент не найден")
    as_ = (e.get("lib") or {}).get("id") or "new"
    job = A.Job("libpublish", key, "libpublish", {"el": asset, "as": as_})
    A.stapi().publish(A, job)
    return {"summary": job.summary, "as": as_}


# ---------------------------------------------------------------- 🦴 сборка: данные скелета ассета и карта костей 3D-модели (как retarget-маппинг в HumanIK / Rigify)
OUR_BONES = {"biped": ["body", "head", "armL", "forearmL", "handL", "armR", "forearmR", "handR", "legL", "shinL", "footL", "legR", "shinR", "footR", "jaw"],
             "quadruped": ["body", "head", "legFL", "shinFL", "legFR", "shinFR", "legBL", "shinBL", "legBR", "shinBR", "tail"]}


def _asset(A, key, asset):
    e = A._by_id(A.load(key).get("elements"), asset)
    if not e:
        raise ValueError("элемент не найден")
    rs = e.get("renders") or []
    r = next((x for x in rs if x.get("id") == e.get("render")), rs[-1] if rs else None)
    if not r:
        raise ValueError("у ассета нет версии")
    return e, r, P.resolve("render/" + r["dir"])


def setup_info(A, key, asset):
    """Что показать во вкладке «🦴 Сборка»: тип рига, адрес prefab.js для редактора суставов (риг частей), карта костей 3D-модели."""
    e, r, d = _asset(A, key, asset)
    pf = open(os.path.join(d, "prefab.js"), encoding="utf-8").read() if os.path.isfile(os.path.join(d, "prefab.js")) else ""
    rig = (re.search(r"rig:\s*['\"](\w+)['\"]", pf) or [None, ""])[1]
    out = {"rig": rig or ("parts" if os.path.isfile(os.path.join(d, "rig.json")) else ""), "skeleton": (re.search(r"skeleton:\s*['\"]([\w-]+)['\"]", pf) or [None, ""])[1],
           "prefab": f"/rscene/{r['dir']}/prefab.js", "rid": r["id"], "v": r.get("v"), "el": e["id"]}
    if out["rig"] == "model":
        try:
            info = json.load(open(os.path.join(d, "info.json"), encoding="utf-8"))
        except (OSError, ValueError):
            info = {}
        m = {}
        for mm in re.finditer(r"(\w+):\s*\{\s*bone:\s*['\"]([^'\"]*)['\"],\s*axis:\s*['\"](\w)['\"](?:,\s*k:\s*(-?[\d.]+))?(?:,\s*off:\s*(-?[\d.]+))?", pf):
            m[mm.group(1)] = {"bone": mm.group(2), "axis": mm.group(3), "k": float(mm.group(4) or 1), **({"off": float(mm.group(5))} if mm.group(5) else {})}
        if not info.get("bones") and os.path.isfile(os.path.join(d, "model.glb")):     # модель собрана в Blender без info.json — кости снимаем один раз
            import tempfile
            try:
                bi = A.m3d().normalize(os.path.join(d, "model.glb"), tempfile.mkdtemp(prefix="bones_"))
                info["bones"] = bi.get("bones") or []
                json.dump(info, open(os.path.join(d, "info.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            except Exception as ex:
                print("! ws setup bones:", ex)
        out.update(map=m or info.get("map") or {}, bones=[A.m3d().sanitize(b["name"]) for b in info.get("bones") or []],   # как их видит three.js (без точек)
                   ours=OUR_BONES.get(out["skeleton"], OUR_BONES["biped"]), anims=info.get("animations") or [])
    return out


def save_bonemap(A, key, asset, mp):
    """Карта костей 3D-героя -> новая версия элемента (та же модель, новый prefab.js) + кадры поворотного стола и проверочных поз."""
    import shutil, subprocess
    M = A.m3d()
    e, r, d = _asset(A, key, asset)
    pf = open(os.path.join(d, "prefab.js"), encoding="utf-8").read()
    rs = e.get("renders") or []
    v = max([x.get("v", 0) for x in rs] + [0]) + 1
    pid = key[5:]
    rel = f"{pid}/{asset}/v{v}"
    wd = P.resolve("render/" + rel)
    shutil.copytree(d, wd, ignore=shutil.ignore_patterns("element*.png", "pose_*", "_shots", "_fix"))
    try:
        info = json.load(open(os.path.join(wd, "info.json"), encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    clean = {k: {"bone": str(x["bone"]), "axis": x.get("axis") if x.get("axis") in ("x", "y", "z") else "x", "k": 1 if float(x.get("k", 1)) >= 0 else -1}
             for k, x in (mp or {}).items() if x and x.get("bone")}
    info["map"] = clean
    json.dump(info, open(os.path.join(wd, "info.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    cid = (re.search(r"id:\s*(\"[^\"]*\")", pf) or [None, '"hero"'])[1]
    sk = (re.search(r"skeleton:\s*(\"[^\"]*\"|'[^']*')", pf) or [None, '"biped"'])[1].strip("'\"")
    hh = float((re.search(r"h:\s*([\d.]+)", pf) or [None, "1.8"])[1])
    A.write_text(os.path.join(wd, "prefab.js"), M.prefab_js(json.loads(cid), e.get("name") or "персонаж", sk, hh, info, "карта костей — мастерская"))
    rp = os.path.join(P.STANDS, "render_prop.js"); url = f"/rscene/{rel}/prefab.js"; port = str(A._docs(key)["port"])
    cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(["node", rp, url, wd, "--port", port], capture_output=True, timeout=300, creationflags=cf)
    for name, pose in (("pose_up", {"bones": {"armL": {"rot": 1.2}, "armR": {"rot": 1.2}}}), ("pose_step", {"bones": {"legL": {"rot": 0.5}, "legR": {"rot": -0.4}, "armL": {"rot": -0.3}, "armR": {"rot": 0.3}}})):
        subprocess.run(["node", rp, url, os.path.join(wd, name), "--port", port, "--params", json.dumps({"pose": pose})], capture_output=True, timeout=300, creationflags=cf)
    img = A.save_file(pid, open(os.path.join(wd, "element.png"), "rb").read()) if os.path.isfile(os.path.join(wd, "element.png")) else r.get("img")
    extra = [A.save_file(pid, open(os.path.join(wd, f), "rb").read()) for f in ("pose_up/element.png", "pose_step/element.png") if os.path.isfile(os.path.join(wd, f))]
    rid = A.new_id("r")
    item = dict({k: r[k] for k in ("fn", "rigchar", "model3d", "source", "meta") if k in r}, id=rid, v=v, dir=rel, img=img, extra=extra,
                summary=f"карта костей поправлена в мастерской ({len(clean)} костей)", feedback="карта костей", ts=now_ms())
    A.apply_ops(key, [{"op": "add", "path": ["elements", asset, "renders"], "item": item}, {"op": "set", "path": ["elements", asset, "render"], "value": rid}])
    return {"v": v, "rid": rid, "bones": len(clean)}


def grips_get(A, key, asset):
    """«✋ Предметы»: как персонаж держит предметы (grips.json рядом с prefab.js версии ассета)."""
    e, r, d = _asset(A, key, asset)
    try:
        g = json.load(open(os.path.join(d, "grips.json"), encoding="utf-8"))
    except (OSError, ValueError):
        g = {}
    return {"grips": g, "v": r.get("v"), "dir": r["dir"]}


def grips_save(A, key, asset, grips):
    """Хваты -> grips.json рабочей версии ассета (данные, как emotions.json: без новой версии; в библиотеку — «📚 В библиотеку»).
    Ключ — предмет без версии: 'props/<slug>' (lib:) или 'el:<id>'; значение — {off:[dx,dy] доли роста в осях предмета, rot, scale, back, follow, pose}."""
    e, r, d = _asset(A, key, asset)
    clean = {}
    for k, g in (grips or {}).items():
        if not isinstance(g, dict) or not re.match(r"^(props/[a-z0-9-]+|el:[A-Za-z0-9_-]+|\*)$", str(k)):
            continue
        x = {}
        if isinstance(g.get("off"), list):
            x["off"] = [round(float(v or 0), 4) for v in g["off"][:3]]
        for f in ("rot", "scale"):
            if g.get(f) is not None:
                x[f] = round(float(g[f]), 4)
        for f in ("back", "follow"):
            if g.get(f) is not None:
                x[f] = bool(g[f])
        if isinstance(g.get("pose"), dict) and g["pose"]:
            x["pose"] = {k2: v for k2, v in g["pose"].items() if k2 in ("bones", "ik", "face")}
        for slot in ("handR", "handL"):                       # хват под конкретную руку (rigGrip: G[k][slot] поверх G[k])
            if isinstance(g.get(slot), dict):
                x[slot] = g[slot]
        clean[k] = x
    A.write_text(os.path.join(d, "grips.json"), json.dumps(clean, ensure_ascii=False, indent=1))
    return {"ok": True, "n": len(clean), "v": r.get("v")}


def handle_post(A, h, p, body):
    if p == "/api/ws/workcopy":                                    # ✏️ править предмет библиотеки всеми инструментами препродакшена
        key, e = lib_element(A, body.get("id", ""), body.get("v") or None, body.get("channel") or None)
        h._json({"video": key[5:], "el": e["id"]}); return True
    if p == "/api/ws/grips":
        if "grips" in body:
            h._json(grips_save(A, body.get("key", ""), body.get("asset", ""), body.get("grips") or {})); return True
        h._json(grips_get(A, body.get("key", ""), body.get("asset", ""))); return True
    if p == "/api/ws/setup":
        h._json(setup_info(A, body.get("key", ""), body.get("asset", ""))); return True
    if p == "/api/ws/bonemap":
        h._json(save_bonemap(A, body.get("key", ""), body.get("asset", ""), body.get("map") or {})); return True
    if p == "/api/ws/open":
        h._json(open_ws(A, body.get("src", ""), body.get("key") or None)); return True
    if p == "/api/ws/clip":
        h._json(save_clip(A, body.get("key", ""), body.get("el", ""), body.get("obj") or "asset", body.get("name") or "движение",
                          body.get("t0", 0), body.get("t1", 0), body.get("loop"), body.get("type") or "")); return True
    if p == "/api/ws/publish":
        h._json(publish(A, body.get("key", ""), body.get("asset", ""))); return True
    return False


def cli(A, argv):
    """ws open <lib:kind/slug[@N] | el:<id>> [--video ID] — открыть мастерскую (создаёт служебную сцену) -> {video, el}
    ws clip <video> <el сцены> "Имя" t0 t1 [--loop] [--type hog] — ключи позы ассета -> клип библиотеки
    ws grips <video> <asset> ['{"props/trubka": {"off": [0, -0.12], "rot": 0.3, "pose": {...}}}'] — хваты предметов (S10.2)"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "open":
        v = A._opt(a, "--video")
        print(json.dumps(open_ws(A, a[0], "plan:" + v if v else None), ensure_ascii=False)); return True
    if cmd == "grips":                                           # ws grips <video> <asset> ['<JSON хватов>'] — показать / записать
        key = "plan:" + a[0]
        print(json.dumps(grips_save(A, key, a[1], json.loads(a[2])) if len(a) > 2 else grips_get(A, key, a[1]), ensure_ascii=False, indent=1)); return True
    if cmd == "clip":
        print(json.dumps(save_clip(A, "plan:" + a[0], a[1], "asset", a[2], a[3], a[4], "--loop" in a, A._opt(a, "--type", "")), ensure_ascii=False)); return True
    return False
