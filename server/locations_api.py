"""S13: локации и сцены монтажа (docs/studio/stage13-locations.md).

Локация — в видео с флагом locations: true это элемент препродакшена kind "scene" (подписи «Локации»): папка как у сцены редактора (preprod/<el>/work/scene.json + prefabs.js), но без времени
(у объектов нет keys / clips / pose / face, у камеры нет keys / cuts) + ракурсы shots[] {id, name, pos, target, fov, note} + фоновый звук ambient[] {src, gain}.
Фоновая жизнь — то, что движок считает от времени сам: каналы префабов, мерцание света, частицы мира.

Сцена монтажа — id ms<hex>, папка preprod/<sid>/: overlay.json — что происходит поверх локации (источник правды; его правят scene ops, история и отмена —
как у сцен), work/scene.json + prefabs.js — СОБРАННАЯ сцена (локация + оверлей) для движка, генератора монтажа, кадров и клипов. Список — video.json → mscenes[].
Оверлей: {schema, id, name, len, fps, location, locRev, camera{keys[{id, t, shot?, pos?, target?, fov?, ease, dolly?}], cuts}, patch{objId: {pos, rot, scale, hide, params…}},
objects[] (персонажи и добавленные предметы), lights[], sounds[], markers[], comments[]}.
Правка локации (rev растёт) -> все её сцены пересобираются (on_location_change), клипы видят новый ключ и перерендериваются (13.4).
"""
import copy
import json
import os
import re
import shutil
import uuid

import paths as P

TIMED = ("keys", "clips", "pose", "face", "walk", "lipsync", "links")


def new_sid():
    return "ms" + uuid.uuid4().hex[:8]


def is_ms(el):
    return bool(re.fullmatch(r"ms[0-9a-f]{4,16}", el or ""))


def mdir(A, vid, sid):
    return os.path.join(P.render(vid), sid)


def overlay_path(A, vid, sid):
    return os.path.join(mdir(A, vid, sid), "overlay.json")


def uses_locations(plan):
    """Видео по схеме S13: сцены препродакшена — локации, сцены — на монтаже."""
    return bool((plan or {}).get("locations"))


def is_location(e, plan=None):
    return (e or {}).get("kind") == "scene" and (plan is None or uses_locations(plan))


def loc_dir(A, vid, el):
    return A.scapi().work_dir(A, vid, el)


def load_loc(A, vid, el):
    return json.load(open(os.path.join(loc_dir(A, vid, el), "scene.json"), encoding="utf-8"))


# ---------------------------------------------------------------- локация
def strip_time(scene):
    """Сцена редактора -> локация: без времени (ключи, клипы, позы, лица у объектов и света, камера без ключей), без маркеров и звуков сцены.
    Ракурсы — из ключей камеры и склеек (каждый план — ракурс), если своих ещё нет."""
    loc = copy.deepcopy(scene)
    for o in (loc.get("objects") or []) + (loc.get("lights") or []):
        k = o.get("keys") or {}
        for prop, lst in list(k.items()):                   # статичное значение — первое значение ключа (если своего не было)
            if lst and prop in ("pos", "rot", "scale", "hide", "intensity", "color") and o.get(prop) is None:
                o[prop] = lst[0].get("v")
        o["keys"] = {}
        for f in TIMED[1:]:
            o.pop(f, None)
    cam = loc.get("camera") or {}
    if not loc.get("shots"):
        shots, n = [], 0
        for k in cam.get("keys") or []:
            if k.get("pos") and k.get("target"):
                n += 1
                shots.append({"id": f"sh{n}", "name": f"ракурс {n}", "pos": k["pos"], "target": k["target"], "fov": k.get("fov") or cam.get("fov") or 30, "note": ""})
        loc["shots"] = shots[:8]
    loc["camera"] = {"fov": cam.get("fov") or 30, "handheld": cam.get("handheld") or 0, "keys": [], "cuts": []}
    for f in ("markers", "sounds", "comments"):
        loc[f] = []
    loc.setdefault("ambient", [])
    loc["location"] = True
    loc["len"] = loc.get("len") or 6
    return loc


def shot_scene(loc, shot_id):
    """Кадр локации с ракурса: локация + камера в точке ракурса (для листа черновика и превью)."""
    return compose(loc, {"id": "shot", "len": loc.get("len") or 6, "camera": {"keys": [{"id": "k1", "t": 0, "shot": shot_id}]}, "objects": []})


# ---------------------------------------------------------------- сборка сцены
def _shot(loc, sid):
    return next((s for s in loc.get("shots") or [] if s.get("id") == sid or s.get("name") == sid), None)


def _cam_key(loc, k):
    """Ключ камеры оверлея -> обычный ключ: shot раскрывается в pos/target/fov ракурса; dolly (0…1) — доля пути к цели (наезд), dpos/dtarget — сдвиг."""
    out = {x: v for x, v in k.items() if x not in ("shot", "dolly", "dpos", "dtarget")}
    sh = _shot(loc, k.get("shot")) if k.get("shot") else None
    if sh:
        pos, tgt = list(sh["pos"]), list(sh["target"])
        d = float(k.get("dolly") or 0)
        if d:
            pos = [p + (t - p) * d for p, t in zip(pos, tgt)]
        out.setdefault("pos", [round(v + (k.get("dpos") or [0, 0, 0])[i], 4) for i, v in enumerate(pos)])
        out.setdefault("target", [round(v + (k.get("dtarget") or [0, 0, 0])[i], 4) for i, v in enumerate(tgt)])
        out.setdefault("fov", sh.get("fov"))
    return out


def compose(loc, ov):
    """Локация + оверлей -> сцена для движка (engine/scene.js sceneWorld): объекты и свет локации -> patch сцены -> объекты сцены -> камера, звуки, маркеры сцены."""
    doc = copy.deepcopy(loc)
    patch = ov.get("patch") or {}
    for o in (doc.get("objects") or []) + (doc.get("lights") or []):
        p = patch.get(o.get("id"))
        if p:
            for k, v in p.items():
                if k == "params" and isinstance(v, dict):
                    o["params"] = dict(o.get("params") or {}, **v)
                else:
                    o[k] = copy.deepcopy(v)
    ids = {o["id"] for o in doc.get("objects") or []}
    doc["objects"] = (doc.get("objects") or []) + [o for o in copy.deepcopy(ov.get("objects") or []) if o.get("id") not in ids]
    doc["lights"] = (doc.get("lights") or []) + copy.deepcopy(ov.get("lights") or [])
    cam = dict(doc.get("camera") or {}, **{k: v for k, v in (ov.get("camera") or {}).items() if k not in ("keys", "cuts")})
    keys = [_cam_key(loc, k) for k in (ov.get("camera") or {}).get("keys") or []]
    if not keys and (loc.get("shots") or []):                 # без камеры — первый ракурс локации
        keys = [_cam_key(loc, {"id": "k0", "t": 0, "shot": loc["shots"][0]["id"]})]
    cam["keys"], cam["cuts"] = keys, copy.deepcopy((ov.get("camera") or {}).get("cuts") or [])
    doc["camera"] = cam
    amb = [{"id": "amb" + str(i), "t": 0, "src": a.get("src"), "gain": a.get("gain", 0.5), "note": "фон локации"} for i, a in enumerate(loc.get("ambient") or []) if a.get("src")]
    doc["sounds"] = amb + copy.deepcopy(ov.get("sounds") or [])
    for f in ("markers", "comments"):
        doc[f] = copy.deepcopy(ov.get(f) or [])
    doc.update(id=ov.get("id"), name=ov.get("name") or loc.get("name"), len=ov.get("len") or 6, fps=ov.get("fps") or loc.get("fps") or 30,
               location={"el": ov.get("location"), "rev": loc.get("rev", 0)}, rev=ov.get("rev", 0))
    doc.pop("shots", None); doc.pop("ambient", None)
    if ov.get("authored"):
        doc["authored"] = ov["authored"]
    return doc


def recompose(A, vid, sid):
    """overlay.json (+ локация) -> work/scene.json и prefabs.js локации. -> собранная сцена."""
    ov = json.load(open(overlay_path(A, vid, sid), encoding="utf-8"))
    loc = load_loc(A, vid, ov["location"])
    doc = compose(loc, ov)
    wd = os.path.join(mdir(A, vid, sid), "work")
    os.makedirs(wd, exist_ok=True)
    src = os.path.join(loc_dir(A, vid, ov["location"]), "prefabs.js")
    if os.path.isfile(src):
        shutil.copy2(src, os.path.join(wd, "prefabs.js"))
    A.write_text(os.path.join(wd, "scene.json"), json.dumps(doc, ensure_ascii=False, indent=1))
    return doc


def new_scene(A, vid, loc_el, name, overlay=None, sec=""):
    """Новая сцена монтажа на локации: оверлей (камера, персонажи, звуки, маркеры) -> mscenes[] видео, собранная сцена в work/."""
    key = "plan:" + vid
    plan = A.load(key)
    e = A._by_id(plan.get("elements"), loc_el)
    if not is_location(e, plan):
        raise ValueError("это не локация")
    if not os.path.isfile(os.path.join(loc_dir(A, vid, loc_el), "scene.json")):
        raise ValueError("у локации ещё нет сцены в редакторе — сначала черновик локации")
    loc = load_loc(A, vid, loc_el)
    sid = new_sid()
    ov = dict({"schema": 1, "id": sid, "name": name or e.get("name"), "len": 6, "fps": 30, "camera": {"keys": [], "cuts": []}, "patch": {},
               "objects": [], "lights": [], "sounds": [], "markers": [], "comments": []}, **(overlay or {}))
    ov.update(id=sid, location=loc_el, locRev=loc.get("rev", 0), rev=0)
    os.makedirs(os.path.join(mdir(A, vid, sid), "work"), exist_ok=True)
    A.write_text(overlay_path(A, vid, sid), json.dumps(ov, ensure_ascii=False, indent=1))
    recompose(A, vid, sid)
    A.apply_ops(key, [{"op": "add", "path": ["mscenes"], "item": {"id": sid, "name": ov["name"], "location": loc_el, **({"sec": sec} if sec else {})}}])
    return sid


def on_location_change(A, vid, loc_el):
    """Правка локации: все её сцены монтажа пересобираются (их клипы увидят новый ключ и перерендерятся)."""
    n = 0
    for m in A.load("plan:" + vid).get("mscenes") or []:
        if m.get("location") == loc_el and os.path.isfile(overlay_path(A, vid, m["id"])):
            try:
                recompose(A, vid, m["id"]); n += 1
            except Exception as ex:
                print("! recompose", m["id"], ex)
    return n


def remove_scene(A, vid, sid):
    """Сцена монтажа -> _archive (папка), из mscenes и юнитов монтажа."""
    key = "plan:" + vid
    d = mdir(A, vid, sid)
    if os.path.isdir(d):
        dst = os.path.join(P.ARCHIVE, "mscenes", vid, sid)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(d, dst)
    plan = A.load(key)
    ops = [{"op": "del", "path": ["mscenes"], "id": sid}]
    M = plan.get("montage") or {}
    if any(u.get("scene") == sid for u in M.get("units") or []):
        M = dict(M, units=[u for u in M["units"] if u.get("scene") != sid])
        ops.append({"op": "set", "path": ["montage"], "value": M})
    A.apply_ops(key, ops)


def list_scenes(A, vid):
    plan = A.load("plan:" + vid)
    els = {e["id"]: e for e in plan.get("elements") or []}
    out = []
    for m in plan.get("mscenes") or []:
        try:
            ov = json.load(open(overlay_path(A, vid, m["id"]), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        loc = els.get(m.get("location")) or {}
        try:
            lrev = load_loc(A, vid, m["location"]).get("rev", 0)
        except (OSError, ValueError, KeyError):
            lrev = None
        out.append({"id": m["id"], "name": ov.get("name"), "location": m.get("location"), "locName": loc.get("name", ""), "len": ov.get("len"),
                    "objects": len(ov.get("objects") or []), "patch": len(ov.get("patch") or {}), "rev": ov.get("rev", 0),
                    "locRev": lrev, "sec": m.get("sec", "")})
    return out


def locations_brief(A, vid):
    """Для агента: локации видео (утверждены ли, ракурсы, сколько объектов) и сцены монтажа на них."""
    plan = A.load("plan:" + vid)
    L = []
    for e in plan.get("elements") or []:
        if not is_location(e, plan) or e.get("status") == "drop":
            continue
        try:
            loc = load_loc(A, vid, e["id"])
            shots = "; ".join(f"{s['id']} «{s.get('name')}»" + (f" ({s['note']})" if s.get("note") else "") for s in loc.get("shots") or []) or "нет"
            objs = ", ".join(f"{o['id']} {o.get('name')}" for o in (loc.get("objects") or [])[:40])
            L.append(f"- {e['id']} «{e.get('name')}» {'✓ утверждена' if e.get('status') == 'ok' else '(не утверждена)'} · rev {loc.get('rev', 0)}\n  ракурсы: {shots}\n  объекты: {objs}")
        except (OSError, ValueError):
            L.append(f"- {e['id']} «{e.get('name')}» — черновика в редакторе ещё нет")
    S = list_scenes(A, vid)
    out = "Локации (препродакшен):\n" + ("\n".join(L) or "  —")
    try:
        ch = A.scapi().chars3d_choices(A, "plan:" + vid, plan)
        out += "\nПерсонажи для сцен (objects[].src.character): " + ("; ".join(f"{c['ref']} «{c.get('name')}»" for c in ch[:30]) or "—")
    except Exception:
        pass
    out += "\nСцены монтажа (оверлеи на локациях):\n" + ("\n".join(f"- {s['id']} «{s['name']}» на {s['location']} «{s['locName']}» · {s['len']} с · своих объектов {s['objects']}, отличий от локации {s['patch']}" for s in S) or "  —")
    return out


# ---------------------------------------------------------------- CLI: studio.py mscene …
def cli(A, argv):
    """mscene list VID | mscene new VID LOC_EL "имя" ['<JSON оверлея>'] [--sec "заголовок сцены сценария"] | mscene show VID SID | mscene compose VID SID
    | mscene rm VID SID | mscene locations VID — бриф локаций и сцен | mscene to-location VID EL — сцену редактора сделать локацией (без времени, ракурсы из камеры)
    Правки сцены монтажа — обычные scene ops VID SID '<ops>' (они меняют оверлей и пересобирают сцену); кадр — scene frame VID SID t."""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "list":
        for s in list_scenes(A, a[0]):
            print(f"{s['id']}  «{s['name']}»  на {s['location']} «{s['locName']}»  {s['len']} с  объектов {s['objects']}  отличий {s['patch']}")
        return True
    if cmd == "locations":
        print(locations_brief(A, a[0])); return True
    if cmd == "new":
        ov = json.loads(a[3]) if len(a) > 3 and not a[3].startswith("--") else None
        print(new_scene(A, a[0], a[1], a[2], ov, A._opt(a, "--sec", "") or "")); return True
    if cmd == "show":
        print(json.dumps(json.load(open(overlay_path(A, a[0], a[1]), encoding="utf-8")), ensure_ascii=False, indent=1)); return True
    if cmd == "compose":
        d = recompose(A, a[0], a[1]); print(f"собрана: объектов {len(d.get('objects') or [])}, ключей камеры {len(d['camera']['keys'])}"); return True
    if cmd == "to-location":                               # сцена редактора этого видео -> локация (снять время, ракурсы из камеры)
        vid, el = a[0], a[1]
        doc = A.scapi().load_scene(A, "plan:" + vid, el)
        loc = strip_time(doc)
        loc["rev"] = doc.get("rev", 0) + 1
        A.scapi().save_scene(A, "plan:" + vid, el, loc)
        print(f"локация: объектов {len(loc.get('objects') or [])}, ракурсов {len(loc.get('shots') or [])}"); return True
    if cmd == "rm":
        remove_scene(A, a[0], a[1]); print("в архиве"); return True
    print(cli.__doc__); return True
