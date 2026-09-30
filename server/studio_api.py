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
import json, os, re, shutil, time

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
    return next((r for r in rs if r.get("id") == e.get("render")), rs[-1] if rs else None)


def candidates(A, vid=None):
    """Утверждённые ✓ элементы видео (персонажи, пропсы, звуки и их 3D-ассеты), которых ещё нет в библиотеке."""
    out = []
    for d in A.plans():
        if vid and d["id"] != vid:
            continue
        for e in d.get("elements") or []:
            if e.get("status") != "ok" or e.get("kind") not in ("char", "prop", "sound"):
                continue
            has = bool(_render_of(e)) if e.get("kind") != "sound" else bool(A.pr().el_mix(e))
            out.append({"video": d["id"], "videoName": d.get("name"), "el": e["id"], "name": e.get("name"), "kind": e.get("kind"),
                        "ready": has, "lib": e.get("lib"), "assets": len(e.get("assets") or [])})
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
        for f in ("element.js", "prefabs.js", "scene.json"):
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
                 + (f"Код: element.js (функция {r.get('fn')})\n" if kind != "sounds" and (r or {}).get("fn") else ""))
    ver = {"v": v, "ts": now_ms(), "from": {"video": vid, "videoName": doc.get("name"), "element": eid, "render": (_render_of(e) or {}).get("id")},
           "files": files, "preview": f"v{v}/{preview}" if preview else "", "fn": (_render_of(e) or {}).get("fn", "")}
    card["versions"].append(ver)
    card["latest"] = v
    card["name"] = card.get("name") or e.get("name")
    A.write_text(card_p, json.dumps(card, ensure_ascii=False, indent=1))
    row = {"id": lid, "kind": kind, "name": card["name"], "desc": card.get("desc", ""), "tags": card.get("tags", []), "latest": v,
           "preview": f"{lid}/{ver['preview']}" if ver["preview"] else "", "from": ver["from"], "updated": now_ms()}
    items = [i for i in items if i["id"] != lid] + [row]
    lib_save_index(A, c, sorted(items, key=lambda i: (i["kind"], i["name"].lower())))
    A.apply_ops(key, [{"op": "set", "path": ["elements", eid, "lib"], "value": {"id": lid, "v": v, "channel": c["id"]}}])
    job.result = row
    job.summary = f"«{e.get('name')}» в библиотеке: lib:{lid}@{v}"


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
    if p.startswith("/api/lib/file/"):                       # /api/lib/file/<channel>/<kind>/<slug>/v<N>/<file>
        m = re.match(r"/api/lib/file/([a-z0-9-]+)/(.+)$", p)
        c = channel_dir(m.group(1)) if m else None
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
        page = "script" if body.get("page") == "script" else "review"
        h._json({"port": port, "url": f"http://localhost:{port}/src/{page}.html", "dir": vdir}); return True
    if p == "/api/lib/publish":
        j = A.start_job("libpublish", body.get("key", ""), f"libpublish:{body.get('el', '')}", {"el": body.get("el"), "as": body.get("as") or "new"})
        h._json({"job": j.info()}); return True
    return False


# ---------------------------------------------------------------- CLI
def cli(A, argv):
    """lib list [--kind props] [--channel ID] | lib show <kind/slug> | lib publish <video> <element> [--as new|<kind/slug>] | lib candidates [--video ID]"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    c = channel_dir(A._opt(a, "--channel"))
    if cmd == "list":
        for it in lib_search(c, "", A._opt(a, "--kind", "")):
            print(f"{it['id']:<34} v{it['latest']}  {it['name']}" + (f"  ← {it['from'].get('videoName')}" if it.get("from") else ""))
        return True
    if cmd == "show":
        print(json.dumps(json.load(open(os.path.join(lib_dir(c), *a[0].split("/"), a[0].split("/")[0].rstrip("s") + ".json"), encoding="utf-8")), ensure_ascii=False, indent=1))
        return True
    if cmd == "candidates":
        for x in candidates(A, A._opt(a, "--video")):
            print(f"{x['video']} {x['el']}  {x['kind']:<5} {'✓' if x['ready'] else '·'} {x['name']}" + (f"  [уже: lib:{x['lib']['id']}@{x['lib']['v']}]" if x.get("lib") else ""))
        return True
    if cmd == "publish":
        job = A.Job("libpublish", "plan:" + a[0], "libpublish", {"el": a[1], "as": A._opt(a, "--as", "new")})
        publish(A, job)
        print(job.summary)
        return True
    return False
