"""Персонажи со скелетом (S4 Claude Studio, docs/studio/stage4-characters.md): библиотека канала —
skeletons/<type>.json, characters/<slug>/character.json + vN/prefab.js (character({...}) — engine/rig.js) + vN/costumes/*.js, costumes/<slug>/.
Рендер позы — стенд stands/char.html через render_shot.js. CLI: studio.py char list | show <slug> | pose <slug> '<поза JSON>' out.png | skeleton <type> | version <slug> <папка>."""
import json, os, re, shutil, subprocess, sys, time

import paths as P  # noqa: E402


def now_ms():
    return int(time.time() * 1000)


def _std(A):
    return A.stapi()


def lib(A, cid=None):
    c = _std(A).channel_dir(cid)
    return c, _std(A).lib_dir(c)


def card_path(ld, slug):
    return os.path.join(ld, "characters", slug, "character.json")


def load_card(ld, slug):
    try:
        return json.load(open(card_path(ld, slug), encoding="utf-8"))
    except (OSError, ValueError):
        return None


def latest_rigged(card):
    """Последняя версия со скелетом (prefab.js), или None."""
    vs = [v for v in (card or {}).get("versions") or [] if v.get("rig")]
    return vs[-1] if vs else None


def chars(A, cid=None):
    """Персонажи канала: [{slug, name, latest, rig, skeleton, v (версия со скелетом), preview}]."""
    c, ld = lib(A, cid)
    out = []
    d = os.path.join(ld, "characters")
    for slug in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        card = load_card(ld, slug)
        if not card:
            continue
        r = latest_rigged(card)
        out.append({"slug": slug, "name": card.get("name", slug), "latest": card.get("latest"), "rig": (r or {}).get("rig"), "skeleton": (r or {}).get("skeleton"),
                    "v": (r or {}).get("v"), "preview": (r or card["versions"][-1] if card.get("versions") else {}).get("preview", ""), "channel": c["id"]})
    return out


def skeleton_hog():
    """Скелет ёжика — из engine/rig.js (HOG_SKELETON), чтобы библиотека и движок не расходились."""
    code = open(os.path.join(P.ENGINE, "rig.js"), encoding="utf-8").read()
    js = "const document = { currentScript: null }, location = { origin: '' };\n" + code + "\nprocess.stdout.write(JSON.stringify(HOG_SKELETON));"
    r = subprocess.run(["node", "-e", js], capture_output=True, text=True, encoding="utf-8", timeout=30)
    if r.returncode:
        raise RuntimeError("rig.js: " + r.stderr[-400:])
    return json.loads(r.stdout)


def save_skeleton(A, sk, cid=None):
    c, ld = lib(A, cid)
    p = os.path.join(ld, "skeletons", sk["type"] + ".json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    A.write_text(p, json.dumps(sk, ensure_ascii=False, indent=1))
    return p


def render_pose(A, url_char, out_dir, pose=None, extra="", size="900x1100"):
    """Персонаж в позе -> out_dir/element.png (стенд char.html)."""
    try:
        port = int(open(os.path.join(P.STATE, ".port")).read().strip())
    except (OSError, ValueError):
        port = 8790
    q = f"char={url_char}&size={size}&parts=element" + (f"&pose={json.dumps(pose, ensure_ascii=False)}" if pose else "") + extra
    url = f"http://127.0.0.1:{port}/render/char.html?{q}"
    os.makedirs(out_dir, exist_ok=True)
    r = subprocess.run(["node", os.path.join(P.STANDS, "render_shot.js"), url, out_dir], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    png = os.path.join(out_dir, "element.png")
    if not os.path.isfile(png):
        raise RuntimeError("стенд персонажа не отрисовал: " + (r.stdout + r.stderr)[-600:])
    return png


def add_version(A, slug, src_dir, meta, cid=None, video=None):
    """Новая версия персонажа из папки (prefab.js, costumes/, parts/…): копия в characters/<slug>/v<N>/, превью со стенда, character.json и index.json."""
    c, ld = lib(A, cid)
    card = load_card(ld, slug)
    if not card:
        card = {"schema": 2, "id": f"characters/{slug}", "kind": "characters", "name": meta.get("name", slug), "desc": meta.get("desc", ""), "tags": [], "versions": [], "latest": 0}
    v = max([x["v"] for x in card["versions"]] + [0]) + 1
    vd = os.path.join(ld, "characters", slug, f"v{v}")
    if os.path.abspath(src_dir) != os.path.abspath(vd):
        shutil.copytree(src_dir, vd, dirs_exist_ok=True)
    files = sorted(os.path.relpath(os.path.join(r, f), vd).replace(os.sep, "/") for r, _, fs in os.walk(vd) for f in fs)
    url = f"/api/lib/file/{c['id']}/characters/{slug}/v{v}/prefab.js"
    tmp = os.path.join(vd, "_shot")
    png = render_pose(A, url, tmp, extra="&skel=0")
    shutil.copy2(png, os.path.join(vd, "preview.png"))
    shutil.rmtree(tmp, ignore_errors=True)
    if "preview.png" not in files:
        files.append("preview.png")
    if not os.path.isfile(os.path.join(vd, "license.json")):
        A.write_text(os.path.join(vd, "license.json"), json.dumps([{"own": True, "note": "нарисовано в Claude Studio"}], ensure_ascii=False, indent=1))
    ver = {"v": v, "ts": now_ms(), "files": files, "preview": f"v{v}/preview.png", "rig": meta.get("rig", "param"), "skeleton": meta.get("skeleton", "hog"),
           "note": meta.get("note", ""), **({"from": video} if video else {})}
    card["schema"] = 2
    card["versions"].append(ver)
    card["latest"] = v
    A.write_text(card_path(ld, slug), json.dumps(card, ensure_ascii=False, indent=1))
    items = _std(A).lib_index(c)
    lid = f"characters/{slug}"
    row = next((i for i in items if i["id"] == lid), None) or {"id": lid, "kind": "characters", "name": card["name"], "desc": card.get("desc", ""), "tags": []}
    row.update({"latest": v, "preview": f"{lid}/v{v}/preview.png", "rig": ver["rig"], "skeleton": ver["skeleton"], "updated": now_ms()})
    items = [i for i in items if i["id"] != lid] + [row]
    _std(A).lib_save_index(A, c, sorted(items, key=lambda i: (i["kind"], i["name"].lower())))
    return {"id": lid, "v": v, "ref": f"lib:{lid}@{v}"}


def cli(A, argv):
    """char list | show <slug> | pose <slug> '<поза JSON>' <out.png> | skeleton <type> | version <slug> <папка> [--rig param|parts --skeleton hog]"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "list":
        for x in chars(A):
            print(f"{x['slug']:<34} v{x['latest']}" + (f"  🦴 {x['skeleton']} ({x['rig']}) v{x['v']}" if x.get("rig") else "  (лист 2D, без скелета)") + f"  {x['name']}")
        return True
    if cmd == "show":
        _, ld = lib(A)
        print(json.dumps(load_card(ld, a[0]), ensure_ascii=False, indent=1)); return True
    if cmd == "skeleton":
        _, ld = lib(A)
        p = os.path.join(ld, "skeletons", a[0] + ".json")
        if a[0] == "hog" and not os.path.isfile(p):
            p = save_skeleton(A, skeleton_hog())
        print(open(p, encoding="utf-8").read()); return True
    if cmd == "pose":
        c, ld = lib(A)
        card = load_card(ld, a[0]); r = latest_rigged(card)
        if not r:
            raise ValueError("у персонажа нет версии со скелетом")
        out = os.path.abspath(a[2]); tmp = out + "_tmp"
        png = render_pose(A, f"/api/lib/file/{c['id']}/characters/{a[0]}/v{r['v']}/prefab.js", tmp, json.loads(a[1] or "{}"), extra="&skel=1")
        shutil.move(png, out); shutil.rmtree(tmp, ignore_errors=True)
        print(out); return True
    if cmd == "version":
        rig = A._opt(a, "--rig", "param"); sk = A._opt(a, "--skeleton", "hog")
        r = add_version(A, a[0], a[1], {"rig": rig, "skeleton": sk})
        if sk == "hog":
            save_skeleton(A, skeleton_hog())
        print(f"{r['ref']} — готово"); return True
    return False
