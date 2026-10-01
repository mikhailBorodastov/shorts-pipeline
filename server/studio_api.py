"""Claude Studio (S2): каналы, стиль канала, архив видео, библиотека v1. ideas_api перезагружает модуль на лету (как scene_api).

Канал — папка с channel.json (architecture §3.1): style/ (style-guide.md, палитра, голос…), library/, videos/, index.md.
Библиотека (§3.7) — <канал>/library/:
    index.json                        [{id: 'props/desk-dsp', kind, name, tags, latest, preview, from: {video, element}, versions: [...]}]
    <kind>/<slug>/<kind>.json         карточка: id, name, kind, versions [{v, from, ts, files, preview, license}]
    <kind>/<slug>/v<N>/               файлы версии: element.js / prefab.js, preview.png, *.wav, model.glb…, license.json, README.md
kind: characters | props | models | sounds (сцены — не в библиотеке). Ссылка из сцены — lib:<kind>/<slug>@<N>.
Публикуется только утверждённое ✓ и только с лицензией у чужих ассетов (license.json).

HTTP (ideas_api передаёт сюда /api/studio/… и /api/lib…):
    GET  /api/studio/channels                -> {channels, current}
    POST /api/studio/use      {channel}      -> текущий канал (state.json)
    GET  /api/studio/style?channel=ID        -> {text, path}           стиль-гайд канала (⚙ стиль)
    POST /api/studio/style    {channel, text}
    GET  /api/lib?channel=ID&q=…&kind=…      -> {items}                 поиск и фильтры
    GET  /api/lib/item?channel=ID&id=kind/slug
    POST /api/lib/publish     {key, el, as: 'new'|<lib id>}  -> {job}  (элемент видео -> библиотека, новой версией)
CLI: python studio.py lib list [--kind …] | show <id> | publish <video> <element> [--as new|<id>] | candidates [--video ID]
"""
import json, os, re, shutil, subprocess, time

import paths as P

LIB_KINDS = {"char": "characters", "prop": "props", "sound": "sounds", "model": "models"}
LIB_LABEL = {"characters": "персонажи", "props": "пропсы", "sounds": "звуки", "models": "3D-модели"}


def now_ms():
    return int(time.time() * 1000)


def _q1(q, k, d=""):
    return (q.get(k) or [d])[0]


def slug(name):
    t = str.maketrans("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "abvgdeejziiklmnoprstufhccss_y_eua")
    s = (name or "").lower().translate(t)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:48] or "item"


# ---------------------------------------------------------------- channels, style
def channel_dir(cid=None):
    c = P.channel(cid)
    if not c:
        raise ValueError("нет канала — переезд ещё не сделан (tools/migrate_v2.py)")
    return c


def style_path(c):
    return os.path.join(c["dir"], "style", "style-guide.md")


# ---------------------------------------------------------------- archive a video
def archive_video(A, vid):
    """«Удалить» видео = перенести папку в _archive/videos/<канал>/<папка>-<время> (ничего не пропадает)."""
    if P.legacy():
        src = P.video_json(vid)
        if not src or not os.path.isfile(src):
            raise ValueError("нет такого видео")
        dst = os.path.join(P.LEGACY, "trash", f"{vid}-{int(time.time())}.json")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        return {"ok": True, "to": dst}
    v = P.index(True)["videos"].get(vid)
    if not v:
        raise ValueError("нет такого видео")
    dst = os.path.join(P.ARCHIVE, "videos", v["channel"] or "_", f"{v['folder']}-{time.strftime('%y%m%d-%H%M%S')}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with A._lock, A.FileLock():
        shutil.move(v["dir"], dst)
    P.index(True)
    A.write_index()
    return {"ok": True, "to": dst}


# ---------------------------------------------------------------- the video project's own pages (script.html, review.html)
def project_port(vdir, start=True, wait=12):
    """Port of the video project's review server (review_server.py): the running one, or start it (hidden) and wait for build/.review_port."""
    import subprocess, sys, urllib.request
    pf = os.path.join(vdir, "build", ".review_port")

    def alive():
        try:
            p = int(open(pf).read().strip())
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/version", timeout=0.5) as r:
                if json.loads(r.read()).get("root") == os.path.basename(vdir):
                    return p
        except Exception:
            return None
    p = alive()
    if p or not start:
        return p
    try:
        os.remove(pf)
    except OSError:
        pass
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([sys.executable, "review_server.py"], cwd=vdir, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=flags, env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    t0 = time.time()
    while time.time() - t0 < wait:
        time.sleep(0.3)
        p = alive()
        if p:
            return p
    raise RuntimeError("локальный скрипт ролика не запустился (review_server.py)")


# ---------------------------------------------------------------- library
def lib_dir(c):
    return os.path.join(c["dir"], "library")


def lib_index(c):
    p = os.path.join(lib_dir(c), "index.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return []


def lib_save_index(A, c, items):
    os.makedirs(lib_dir(c), exist_ok=True)
    A.write_text(os.path.join(lib_dir(c), "index.json"), json.dumps(items, ensure_ascii=False, indent=1))


def lib_search(c, q="", kind=""):
    words = [w for w in (q or "").lower().replace("ё", "е").split() if w]
    out = []
    for it in lib_index(c):
        if kind and it.get("kind") != kind:
            continue
        hay = json.dumps([it.get("name"), it.get("tags"), it.get("id"), it.get("desc")], ensure_ascii=False).lower().replace("ё", "е")
        if all(w in hay for w in words):
            out.append(it)
    return out


def _render_of(e):
    rs = e.get("renders") or []
    if e.get("kind") == "prop":                               # у пропса 2D и 3D-версии рядом: берём те, что выбраны переключателем (dim)
        d3 = e.get("dim") == "3d"
        rs = [r for r in rs if bool(r.get("three3")) == d3]
    if e.get("kind") == "char":                               # у персонажа лист и версии со скелетом рядом (form: rig — S4)
        rg = e.get("form") == "rig"
        rs = [r for r in rs if bool(r.get("rigchar")) == rg]
    return next((r for r in rs if r.get("id") == e.get("render")), rs[-1] if rs else None)


def candidates(A, vid=None):
    """Утверждённые ✓ элементы видео (персонажи, пропсы, звуки и их 3D-ассеты), которых ещё нет в библиотеке."""
    out = []
    cur = (P.channel() or {}).get("id")
    idx = P.index()["videos"]
    for d in A.plans():
        if vid and d["id"] != vid:
            continue
        if not vid and idx.get(d["id"], {}).get("channel") != cur:      # только видео текущего канала: у каждого канала своя библиотека
            continue
        for e in d.get("elements") or []:
            if e.get("status") != "ok" or e.get("kind") not in ("char", "prop", "sound"):
                continue
            has = bool(_render_of(e)) if e.get("kind") != "sound" else bool(A.pr().el_mix(e))
            out.append({"video": d["id"], "videoName": d.get("name"), "el": e["id"], "name": e.get("name"), "kind": e.get("kind"),
                        "ready": has, "lib": e.get("lib"), "assets": len(e.get("assets") or []), "d3": bool((_render_of(e) or {}).get("three3"))})
    return out


def publish(A, job):
    """Элемент видео -> библиотека канала новой версией (или новым предметом). Копирует файлы, превью, лицензии, пишет index.json."""
    key, eid, as_ = job.key, job.params.get("el"), job.params.get("as") or "new"
    vid = key[5:]
    doc = A.load(key)
    e = A._by_id(doc.get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    if e.get("status") != "ok":
        raise ValueError("в библиотеку — только утверждённое ✓")
    kind = LIB_KINDS.get(e.get("kind"))
    if not kind:
        raise ValueError("сцены в библиотеку не публикуются (только персонажи, пропсы, звуки, 3D-модели)")
    c = channel_dir(P.index()["videos"].get(vid, {}).get("channel"))
    items = lib_index(c)
    r0 = _render_of(e) if kind == "characters" else None
    if r0 and r0.get("rigchar"):                               # персонаж со скелетом (S4): версия персонажа + тип скелета — char_api
        return publish_rigged(A, job, doc, vid, e, r0, as_)
    if as_ == "new":
        base = slug(e.get("name"))
        sl, k = base, 2
        while any(i["id"] == f"{kind}/{sl}" for i in items):
            sl, k = f"{base}-{k}", k + 1
        lid = f"{kind}/{sl}"
    else:
        lid = as_
        if not any(i["id"] == lid for i in items):
            raise ValueError(f"в библиотеке нет {lid}")
    ldir = os.path.join(lib_dir(c), *lid.split("/"))
    card_p = os.path.join(ldir, kind.rstrip("s") + ".json")
    try:
        card = json.load(open(card_p, encoding="utf-8"))
    except (OSError, ValueError):
        card = {"schema": 1, "id": lid, "kind": kind, "name": e.get("name"), "desc": e.get("desc", ""), "tags": [], "versions": [], "latest": 0}
    v = max([x["v"] for x in card["versions"]] + [0]) + 1
    vd = os.path.join(ldir, f"v{v}")
    os.makedirs(vd, exist_ok=True)
    files, preview, lic = [], "", []

    def put(src, name):
        if src and os.path.isfile(src):
            shutil.copy2(src, os.path.join(vd, name))
            files.append(name)
            return name
        return ""
    if kind == "sounds":
        mix = A.pr().el_mix(e)
        if not mix:
            raise ValueError("у звука не выбран файл")
        for i, m in enumerate(mix, 1):
            s = m["s"]
            put(P.resolve(s["file"]), f"{i}-{slug(s.get('title') or 'layer')}{os.path.splitext(s['file'])[1]}")
            if s.get("license"):
                lic.append({"file": files[-1] if files else "", "title": s.get("title"), "author": s.get("author"), "license": s.get("license"), "page": s.get("page")})
    else:
        r = _render_of(e)
        if not r:
            raise ValueError("у элемента нет черновика")
        rdir = P.resolve("render/" + r["dir"])
        for f in ("element.js", "prefabs.js", "scene.json", "prefab.js", "model.glb", "model.py"):   # prefab.js + model — 3D-пропс (S3)
            put(os.path.join(rdir, f), f)
        preview = put(P.resolve(r["img"]), "preview" + os.path.splitext(r["img"])[1])
        for a in e.get("assets") or []:                      # 3D models / pictures the author took into work, with their licenses
            src_dir = P.resolve(a["dir"])
            if os.path.isdir(src_dir):
                dst = os.path.join(vd, "assets", slug(a.get("title") or a["id"]))
                shutil.copytree(src_dir, dst, dirs_exist_ok=True)
                files.append("assets/" + os.path.basename(dst))
                lic.append({"file": "assets/" + os.path.basename(dst), "title": a.get("title"), "author": a.get("author"), "license": a.get("license"),
                            "page": a.get("page"), "src": a.get("src")})
    if any(not x.get("license") for x in lic):
        shutil.rmtree(vd, ignore_errors=True)
        raise ValueError("у чужого ассета нет лицензии — в библиотеку без неё нельзя")
    A.write_text(os.path.join(vd, "license.json"), json.dumps(lic or [{"own": True, "note": "нарисовано в Claude Studio"}], ensure_ascii=False, indent=1))
    A.write_text(os.path.join(vd, "README.md"), f"# {e.get('name')} — v{v}\n\n{e.get('desc', '')}\n\nИз видео «{doc.get('name')}» ({vid}), элемент {eid}.\n"
                 + (f"Код: element.js (функция {r.get('fn')})\n" if kind != "sounds" and (r or {}).get("fn") else "")
                 + ("3D-пропс: prefab.js (props3d.js), в сцене — src.prefab = 'lib:" + lid + "@" + str(v) + "'\n" if kind != "sounds" and (r or {}).get("three3") else ""))
    ver = {"v": v, "ts": now_ms(), "from": {"video": vid, "videoName": doc.get("name"), "element": eid, "render": (_render_of(e) or {}).get("id")},
           "files": files, "preview": f"v{v}/{preview}" if preview else "", "fn": (_render_of(e) or {}).get("fn", ""),
           "dim": "3d" if (_render_of(e) or {}).get("three3") else "2d"}
    card["versions"].append(ver)
    card["latest"] = v
    card["name"] = card.get("name") or e.get("name")
    A.write_text(card_p, json.dumps(card, ensure_ascii=False, indent=1))
    row = {"id": lid, "kind": kind, "name": card["name"], "desc": card.get("desc", ""), "tags": card.get("tags", []), "latest": v, "dim": ver["dim"],
           "d3": max([x["v"] for x in card["versions"] if x.get("dim") == "3d"] + [0]),
           "preview": f"{lid}/{ver['preview']}" if ver["preview"] else "", "from": ver["from"], "updated": now_ms()}
    items = [i for i in items if i["id"] != lid] + [row]
    lib_save_index(A, c, sorted(items, key=lambda i: (i["kind"], i["name"].lower())))
    A.apply_ops(key, [{"op": "set", "path": ["elements", eid, "lib"], "value": {"id": lid, "v": v, "channel": c["id"]}}])
    job.result = row
    job.summary = f"«{e.get('name')}» в библиотеке: lib:{lid}@{v}"


def publish_rigged(A, job, doc, vid, e, r, as_):
    """Персонаж со скелетом -> library/characters/<slug>/vN (prefab.js, rig.json, превью) + library/skeletons/<type>.json (кости, слоты, позы)."""
    C = A.chapi()
    c = channel_dir(P.index()["videos"].get(vid, {}).get("channel"))
    src = P.resolve("render/" + r["dir"])
    rp = os.path.join(src, "rig.json")
    rig = json.load(open(rp, encoding="utf-8")) if os.path.isfile(rp) else {"type": "hog", "param": True}   # ёжик: риг по параметрам, скелет hog
    if r.get("model3d"):                                       # S9: 3D-герой из Blender — тип скелета и кости из prefab.js (карта костей позы -> кости арматуры)
        pf = open(os.path.join(src, "prefab.js"), encoding="utf-8").read()
        m = re.search(r"skeleton:\s*'([a-z0-9-]+)'", pf)
        rig = {"type": (m.group(1) if m else (r.get("fn") or "model")), "model": True,
               "bones": [{"id": k, "bone": b_} for k, b_ in re.findall(r"(\w+):\s*\{\s*bone:\s*'([^']+)'", pf)]}
    sl = as_.split("/", 1)[1] if as_ and as_ != "new" else slug(e.get("name"))
    tmp = os.path.join(lib_dir(c), "characters", sl, "_new")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for f in os.listdir(src):
        if f.endswith(".js") or f in ("rig.json", "model.glb", "model.py"):
            shutil.copy2(os.path.join(src, f), os.path.join(tmp, f))
        elif f == "costumes":
            shutil.copytree(os.path.join(src, f), os.path.join(tmp, f))
    card = C.load_card(lib_dir(c), sl)
    v = max([x["v"] for x in (card or {}).get("versions") or []] + [0]) + 1
    dst = os.path.join(lib_dir(c), "characters", sl, f"v{v}")
    shutil.move(tmp, dst)
    res = C.add_version(A, sl, dst, {"rig": "model" if rig.get("model") else "param" if rig.get("param") else "parts", "skeleton": rig.get("type") or "?", "name": e.get("name"), "desc": e.get("desc", ""),
                                     "note": r.get("summary", "")}, cid=c["id"], video={"video": vid, "videoName": doc.get("name"), "element": e["id"], "render": r.get("id")})
    sk = {"schema": 1, "type": rig.get("type"), "name": rig.get("typeName") or rig.get("type"), "rig": "model" if rig.get("model") else "parts",
          "bones": [{k: b[k] for k in ("id", "parent", "limits", "bone") if k in b} for b in rig.get("bones") or []],
          "slots": rig.get("slots") or {}, "poses": rig.get("poses") or {}, "from": {"character": sl, "v": res["v"]}}
    if rig.get("param"):
        if not os.path.isfile(os.path.join(lib_dir(c), "skeletons", "hog.json")):
            C.save_skeleton(A, C.skeleton_hog(), c["id"])
    elif rig.get("type"):
        p = os.path.join(lib_dir(c), "skeletons", rig["type"] + ".json")
        if not os.path.isfile(p):                              # тип скелета заводится первым персонажем; дальше его кости — общий договор
            C.save_skeleton(A, sk, c["id"])
    A.apply_ops(job.key, [{"op": "set", "path": ["elements", e["id"], "lib"], "value": {"id": res["id"], "v": res["v"], "channel": c["id"]}}])
    job.result = res
    job.summary = f"«{e.get('name')}» со скелетом {rig.get('type')} в библиотеке: {res['ref']}"


def run_job(A, job):
    if job.kind == "libpublish":
        publish(A, job)
        return True
    return False


# ---------------------------------------------------------------- HTTP
def handle_get(A, h, p, q):
    if p == "/api/studio/channels":
        cur = P.channel()
        h._json({"channels": [{k: v for k, v in c.items() if k != "dir"} for c in P.channels(True)], "current": cur and cur["id"], "legacy": P.legacy()}); return True
    if p == "/api/studio/style":
        c = channel_dir(_q1(q, "channel") or None)
        sp = style_path(c)
        h._json({"text": open(sp, encoding="utf-8").read() if os.path.isfile(sp) else "", "path": sp}); return True
    if p == "/api/lib":
        c = channel_dir(_q1(q, "channel") or None)
        h._json({"items": lib_search(c, _q1(q, "q"), _q1(q, "kind")), "kinds": LIB_LABEL, "channel": c["id"]}); return True
    if p == "/api/lib/item":
        c = channel_dir(_q1(q, "channel") or None)
        lid = _q1(q, "id")
        if not re.fullmatch(r"[a-z]+/[a-z0-9-]+", lid):
            raise ValueError("плохой id")
        kind = lid.split("/")[0]
        h._json(json.load(open(os.path.join(lib_dir(c), *lid.split("/"), kind.rstrip("s") + ".json"), encoding="utf-8"))); return True
    if p == "/api/lib/candidates":
        h._json({"items": candidates(A, _q1(q, "video") or None)}); return True
    if p.startswith("/api/lib/file/"):                       # /api/lib/file/<channel | video:<id>>/<kind>/<slug>/v<N>/<file>
        m = re.match(r"/api/lib/file/((?:video:)?[a-z0-9-]+)/(.+)$", p)
        cid = m and m.group(1)
        if cid and cid.startswith("video:"):                  # сцена видео знает только свой id: канал — тот, где лежит видео
            cid = P.index()["videos"].get(cid[6:], {}).get("channel")
        c = channel_dir(cid) if cid else None
        if not c:
            h.send_error(404); return True
        return A._static(h, lib_dir(c), m.group(2))
    return False


def handle_post(A, h, p, body):
    if p == "/api/studio/use":
        c = P.channel(body.get("channel"))
        if not c or c.get("id") != body.get("channel"):
            raise ValueError("нет такого канала")
        P.state_set("channel", c["id"])
        h._json({"ok": True, "channel": c["id"]}); return True
    if p == "/api/studio/style":
        c = channel_dir(body.get("channel") or None)
        os.makedirs(os.path.dirname(style_path(c)), exist_ok=True)
        A.write_text(style_path(c), body.get("text") or "")
        h._json({"ok": True}); return True
    if p == "/api/studio/project":                          # open the video project's script / review page inside the stage
        vid = body.get("id", "")
        vdir = P.video(vid) or (P.project((A.load("plan:" + vid) or {}).get("project", "")) if vid else None)
        if not vdir or not os.path.isfile(os.path.join(vdir, "review_server.py")):
            raise ValueError("у видео ещё нет проекта ролика — «🚀 Начать производство»")
        port = project_port(vdir)
        page = body.get("page") if body.get("page") in ("script", "preview") else "review"
        url = f"http://localhost:{port}/src/index.html?preview" if page == "preview" else f"http://localhost:{port}/src/{page}.html"   # preview — плеер кадров для этапа «Монтаж» (S6)
        h._json({"port": port, "url": url, "dir": vdir}); return True
    if p == "/api/lib/publish":
        j = A.start_job("libpublish", body.get("key", ""), f"libpublish:{body.get('el', '')}", {"el": body.get("el"), "as": body.get("as") or "new"})
        h._json({"job": j.info()}); return True
    return False


# ---------------------------------------------------------------- правка библиотеки: новая версия копией (старые версии не меняются — их держат другие видео)
def _ref(ref):
    m = re.match(r"^(?:lib:)?((props|characters|sounds|skeletons|anims)/[a-z0-9-]+)@?(\d+)?$", (ref or "").strip())
    if not m:
        raise ValueError("ссылка вида props/<slug>@N или characters/<slug>@N")
    return m.group(1), m.group(2), int(m.group(3)) if m.group(3) else None


def fork(A, c, ref, as_name="", note="", by="agent"):
    """lib fork: копия версии vN -> новая версия того же предмета (vM) или новый предмет (as_name). Возвращает {ref, dir}.
    Файлы новой версии можно править (prefab.js, model.py -> blender_run, model.glb, rig.json); превью — lib preview."""
    lid, kind, v = _ref(ref)
    ld = lib_dir(c)
    card_p = os.path.join(ld, *lid.split("/"), kind.rstrip("s") + ".json")
    card = json.load(open(card_p, encoding="utf-8"))
    v = v or card.get("latest")
    src_ver = next((x for x in card["versions"] if x["v"] == v), None)
    if not src_ver:
        raise ValueError(f"у {lid} нет v{v}")
    src = os.path.join(ld, *lid.split("/"), f"v{v}")
    items = lib_index(c)
    if as_name:
        base = slug(as_name)
        sl, k = base, 2
        while any(i["id"] == f"{kind}/{sl}" for i in items) or os.path.exists(os.path.join(ld, kind, sl)):
            sl, k = f"{base}-{k}", k + 1
        nid = f"{kind}/{sl}"
        ncard_p = os.path.join(ld, kind, sl, kind.rstrip("s") + ".json")
        ncard = {"schema": 1, "id": nid, "kind": kind, "name": as_name, "desc": note or card.get("desc", ""), "tags": list(card.get("tags") or []), "versions": [], "latest": 0}
    else:
        nid, ncard_p, ncard = lid, card_p, card
    nv = max([x["v"] for x in ncard["versions"]] + [0]) + 1
    dst = os.path.join(ld, *nid.split("/"), f"v{nv}")
    shutil.copytree(src, dst)
    pf = os.path.join(dst, "prefab.js")
    if as_name and kind == "characters" and os.path.isfile(pf):     # свой id у копии — иначе два персонажа в одной сцене делят реестр RIG.chars
        t = open(pf, encoding="utf-8").read()
        t = re.sub(r"(character\(\{\s*id:\s*)(['\"])[^'\"]*\2", lambda m: m.group(1) + m.group(2) + nid.split("/")[1] + m.group(2), t, count=1)
        t = re.sub(r"(character\(\{[^}]*?name:\s*)(['\"])[^'\"]*\2", lambda m: m.group(1) + m.group(2) + as_name.replace("'", "") + m.group(2), t, count=1)
        A.write_text(pf, t)
    ver = dict(src_ver, v=nv, ts=now_ms(), forkOf=f"{lid}@{v}", by=by, note=note or f"копия {lid}@{v}")
    ver.pop("from", None)
    ver["preview"] = f"v{nv}/" + os.path.basename(src_ver["preview"]) if src_ver.get("preview") else ""
    ncard["versions"].append(ver)
    ncard["latest"] = nv
    A.write_text(ncard_p, json.dumps(ncard, ensure_ascii=False, indent=1))
    row = next((i for i in items if i["id"] == nid), None)
    if row is None:
        row = {"id": nid, "kind": kind, "name": ncard["name"], "desc": ncard.get("desc", ""), "tags": ncard.get("tags", []), "from": {"fork": f"{lid}@{v}"}}
        items.append(row)
    row.update(latest=nv, preview=f"{nid}/{ver['preview']}" if ver["preview"] else "", updated=now_ms())
    if ver.get("dim") == "3d":
        row["dim"], row["d3"] = "3d", nv
    lib_save_index(A, c, sorted(items, key=lambda i: (i["kind"], i["name"].lower())))
    return {"ref": f"lib:{nid}@{nv}", "dir": dst.replace("\\", "/"), "from": f"{lid}@{v}"}


def preview(A, c, ref):
    """lib preview: кадры версии на стенде (пропс — 4 ракурса render_prop.js, персонаж — render_char.js / render_prop.js для 3D) -> preview.png версии."""
    lid, kind, v = _ref(ref)
    ld = lib_dir(c)
    d = os.path.join(ld, *lid.split("/"), f"v{v}")
    if not os.path.isfile(os.path.join(d, "prefab.js")):
        raise ValueError(f"у {lid}@{v} нет prefab.js")
    try:
        port = open(os.path.join(P.STATE, ".port"), encoding="utf-8").read().strip()
    except OSError:
        raise RuntimeError("Studio не запущена — превью снимает её стенд")
    url = f"/api/lib/file/{c['id']}/{lid}/v{v}/prefab.js"
    out = os.path.join(d, "_shots")
    rig2d = kind == "characters" and os.path.isfile(os.path.join(d, "rig.json"))
    script = "render_char.js" if rig2d else "render_prop.js"
    r = subprocess.run(["node", os.path.join(P.STANDS, script), url, out, "--port", port], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    shot = os.path.join(out, "clean.png" if rig2d else "element.png")
    if not os.path.isfile(shot):
        raise RuntimeError("кадры не снялись: " + ((r.stdout or "") + (r.stderr or ""))[-600:])
    shutil.copy2(shot, os.path.join(d, "preview.png"))
    return {"preview": os.path.join(d, "preview.png").replace("\\", "/"), "shots": out.replace("\\", "/"), "log": (r.stdout or "").strip()[-300:]}


# ---------------------------------------------------------------- CLI
def cli(A, argv):
    """lib list [--kind props] [--channel ID] | lib show <kind/slug> | lib publish <video> <element> [--as new|<kind/slug>] | lib candidates [--video ID]
    | lib fork <kind/slug>[@N] [--as "Новое имя"] [--note "что меняю"] — новая версия копией (или новый предмет), путь для правки
    | lib preview <kind/slug>@N — снять превью версии на стенде (после правки файлов)"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    c = channel_dir(A._opt(a, "--channel"))
    if cmd == "list":
        for it in lib_search(c, "", A._opt(a, "--kind", "")):
            fr = it.get("from") or {}
            print(f"{it['id']:<34} v{it['latest']}  {it['name']}" + (f"  ← {fr.get('videoName')}" if fr.get("videoName") else f"  ← копия {fr['fork']}" if fr.get("fork") else ""))
        return True
    if cmd == "show":
        print(json.dumps(json.load(open(os.path.join(lib_dir(c), *a[0].split("/"), a[0].split("/")[0].rstrip("s") + ".json"), encoding="utf-8")), ensure_ascii=False, indent=1))
        return True
    if cmd == "candidates":
        for x in candidates(A, A._opt(a, "--video")):
            print(f"{x['video']} {x['el']}  {x['kind']:<5} {'✓' if x['ready'] else '·'} {x['name']}" + (f"  [уже: lib:{x['lib']['id']}@{x['lib']['v']}]" if x.get("lib") else ""))
        return True
    if cmd == "fork":
        import agent as AG
        r = fork(A, c, a[0], A._opt(a, "--as", ""), A._opt(a, "--note", ""), by="agent" if AG.current_run() else "author")
        print(json.dumps(r, ensure_ascii=False)); return True
    if cmd == "preview":
        print(json.dumps(preview(A, c, a[0]), ensure_ascii=False)); return True
    if cmd == "publish":
        job = A.Job("libpublish", "plan:" + a[0], "libpublish", {"el": a[1], "as": A._opt(a, "--as", "new")})
        publish(A, job)
        print(job.summary)
        return True
    return False
