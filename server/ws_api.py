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


def open_ws(A, src, key=None):
    if src.startswith("lib:"):
        lid, _, v = src[4:].partition("@")
        SA = A.stapi()
        c = SA.channel_dir(None if not key else P.index()["videos"].get(key[5:], {}).get("channel"))
        vid = service_video(A, c["id"])
        key = "plan:" + vid
        _, card = SA._card(c, lid)
        v = int(v or card["latest"])
        d = A.load(key)
        e = next((x for x in d.get("elements") or [] if (x.get("lib") or {}).get("id") == lid and (x.get("lib") or {}).get("v") == v and x.get("status") != "drop"), None)
        if not e:
            r = SA.import_to_video(A, key, lid, v, "мастерская: правка библиотечного предмета", "")
            e = A._by_id(A.load(key).get("elements"), r["el"])
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
        S.apply(A, key, ws["id"], ops, by="author", desc=f"мастерская: {e.get('name', '')} {ref}")
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


def handle_post(A, h, p, body):
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
    ws clip <video> <el сцены> "Имя" t0 t1 [--loop] [--type hog] — ключи позы ассета -> клип библиотеки"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "open":
        v = A._opt(a, "--video")
        print(json.dumps(open_ws(A, a[0], "plan:" + v if v else None), ensure_ascii=False)); return True
    if cmd == "clip":
        print(json.dumps(save_clip(A, "plan:" + a[0], a[1], "asset", a[2], a[3], a[4], "--loop" in a, A._opt(a, "--type", "")), ensure_ascii=False)); return True
    return False
