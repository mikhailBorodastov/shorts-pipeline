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
    png = render_pose(A, url, tmp, extra="&skel=0")          # превью — без костей
    shutil.copy2(png, os.path.join(vd, "preview.png"))
    shutil.rmtree(tmp, ignore_errors=True)
    if "preview.png" not in files:
        files.append("preview.png")
    if not os.path.isfile(emotions_path(ld, slug)):
        A.write_text(emotions_path(ld, slug), "{}")
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


# ---------------------------------------------------------------- эмоции (emotions.json рядом с character.json — общие для всех версий)
def emotions_path(ld, slug):
    return os.path.join(ld, "characters", slug, "emotions.json")


def load_emotions(ld, slug):
    try:
        return json.load(open(emotions_path(ld, slug), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_emotions(A, ld, slug, em):
    A.write_text(emotions_path(ld, slug), json.dumps(em, ensure_ascii=False, indent=1))


def prefab_emotions(ld, slug, v):
    """Эмоции, записанные в prefab.js версии (emotions: {...}) — для списка вместе с emotions.json."""
    try:
        src = open(os.path.join(ld, "characters", slug, f"v{v}", "prefab.js"), encoding="utf-8").read()
    except OSError:
        return {}
    out = {}
    m = re.search(r"emotions:\s*\{(.*?)\n\s*\},\n", src, re.S)
    for name, body in re.findall(r"'([^']+)':\s*\{([^{}]*)\}", m.group(1) if m else ""):
        out[name] = {"ok": "ok: true" in body, "src": "prefab"}
    return out


def sheet_info(A, slug, cid=None):
    c, ld = lib(A, cid)
    card = load_card(ld, slug)
    if not card:
        raise ValueError("нет такого персонажа")
    r = latest_rigged(card)
    sk = r and r.get("skeleton")
    same = [x for x in chars(A, cid) if x.get("skeleton") == sk and x["slug"] != slug] if sk else []
    em = prefab_emotions(ld, slug, r["v"]) if r else {}
    try:                                                    # риг частей: лица-эмоции записаны в rig.json версии
        for k, v in (json.load(open(os.path.join(ld, "characters", slug, f"v{r['v']}", "rig.json"), encoding="utf-8")).get("emotions") or {}).items():
            em[k] = dict(v, src="prefab", ok=v.get("ok", True))
    except (OSError, ValueError, TypeError):
        pass
    em.update(load_emotions(ld, slug))
    costumes = []
    if r:
        cd = os.path.join(ld, "characters", slug, f"v{r['v']}", "costumes")
        for f in sorted(os.listdir(cd)) if os.path.isdir(cd) else []:
            src = open(os.path.join(cd, f), encoding="utf-8").read()
            m = re.search(r"id:\s*'([^']+)',\s*name:\s*'([^']+)'", src)
            sl = re.search(r"slot:\s*'([^']+)'", src)
            if m:
                costumes.append({"id": m.group(1), "name": m.group(2), "slot": sl.group(1) if sl else ""})
    try:
        skel = json.load(open(os.path.join(ld, "skeletons", f"{sk}.json"), encoding="utf-8")) if sk else None
    except (OSError, ValueError):
        skel = None
    return {"slug": slug, "channel": c["id"], "card": card, "rigged": r, "skeleton": sk, "skel": skel, "same": same, "emotions": em, "costumes": costumes,
            "url": f"/api/lib/file/{c['id']}/characters/{slug}/v{r['v']}/prefab.js" if r else ""}


def emotion_spec(A, info, want=""):
    face = ("глаза eyes: open | half | closed; веко lid 0..1 (0 — открыты широко, 0.62 — сонные); рот mouth: o | flat | smile | sad | open; "
            "брови brows: none | up | angry | sad | worried; взгляд look [x, y] от -1 до 1 (y > 0 — вниз); усталость tired: true")
    have = "\n".join(f"- {k}{' (утверждена автором)' if v.get('ok') else ''}" for k, v in info["emotions"].items()) or "(пока нет)"
    base = ["радость", "удивление", "грусть", "злость", "сонный", "испуг"]
    miss = [b for b in base if b not in info["emotions"]]
    ask = ("эмоции: " + want) if want else ("недостающие базовые эмоции: " + ", ".join(miss)) if miss else "ещё 2–3 эмоции, полезные для роликов канала (хитрый, растерянный, гордый…)"
    prompt = f"""Персонаж «{info['card'].get('name')}» — бумажный ёжик из аппликации (скелет hog, лицо рисует drawHog по параметрам).
Описание: {info['card'].get('desc', '')}
Что умеет лицо: {face}.
Уже есть эмоции:
{have}
Предложи {ask}.
Каждая — набор параметров лица, узнаваемый с одного взгляда на маленьком ёжике в кадре 9:16 (крупные различия: брови, рот, веко, взгляд). Не повторяй уже имеющиеся.
В ответе: emotions — список {{ name (по-русски, одно-два слова, строчными), eyes, lid, mouth, brows, look, tired, note (коротко, чем читается) }}."""
    S = lambda props, req=None: {"type": "object", "properties": props, "required": req or list(props), "additionalProperties": False}
    item = S({"name": {"type": "string"}, "eyes": {"type": "string", "enum": ["open", "half", "closed"]}, "lid": {"type": "number"},
              "mouth": {"type": "string", "enum": ["o", "flat", "smile", "sad", "open"]}, "brows": {"type": "string", "enum": ["none", "up", "angry", "sad", "worried"]},
              "look": {"type": "array", "items": {"type": "number"}}, "tired": {"type": "boolean"}, "note": {"type": "string"}})
    return {"system": "Ты — аниматор бумажной аппликации. Отвечаешь только JSON по схеме.", "prompt": prompt, "schema": S({"emotions": {"type": "array", "items": item}}),
            "model": A.TEXT_MODEL, "timeout": 300}


def rig_version(A, job):
    """✋ редактор скелета -> новая версия черновика персонажа: тот же prefab.js, новый rig.json, кадры render_char.js (без Claude)."""
    key, el, base_id, rig = job.key, job.params["el"], job.params.get("base"), job.params["rig"]
    plan = A.load(key)
    e = A._by_id(plan.get("elements"), el)
    if not e:
        raise ValueError("элемент не найден")
    base = next((r for r in e.get("renders") or [] if r.get("id") == base_id and r.get("rigchar")), None)
    if not base:
        raise ValueError("нет версии персонажа со скелетом")
    v = max([r.get("v", 0) for r in e.get("renders") or []] + [0]) + 1
    pid = key[5:]
    rel = f"{pid}/{el}/v{v}"
    src, wd = P.resolve("render/" + base["dir"]), P.resolve("render/" + rel)
    os.makedirs(wd, exist_ok=True)
    for f in os.listdir(src):
        if f.endswith(".js") or f == "parts":
            (shutil.copytree if os.path.isdir(os.path.join(src, f)) else shutil.copy2)(os.path.join(src, f), os.path.join(wd, f))
    old = json.load(open(os.path.join(src, "rig.json"), encoding="utf-8"))
    moved = [b["id"] for b in rig.get("bones") or [] if (next((o for o in old.get("bones") or [] if o["id"] == b["id"]), {}) or {}).get("joint") != b.get("joint")]
    reparent = [b["id"] for b in rig.get("bones") or [] if (next((o for o in old.get("bones") or [] if o["id"] == b["id"]), {}) or {}).get("parent") != b.get("parent")]
    A.write_text(os.path.join(wd, "rig.json"), json.dumps(rig, ensure_ascii=False, indent=1))
    d = A._docs(key)
    r = subprocess.run(["node", os.path.join(P.STANDS, "render_char.js"), f"/rscene/{rel}/prefab.js", wd, "--port", str(d["port"])], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    main = os.path.join(wd, "element.png")
    if not os.path.isfile(main):
        raise RuntimeError("кадры не снялись: " + (r.stdout + r.stderr)[-400:])
    img = d["save"](pid, open(main, "rb").read())
    extra = [d["save"](pid, open(os.path.join(wd, f), "rb").read()) for f in ("rest.png", "clean.png", "emotions.png") if os.path.isfile(os.path.join(wd, f))]
    fb = "🦴 скелет: " + ", ".join(filter(None, [("суставы " + ", ".join(moved)) if moved else "", ("родители " + ", ".join(reparent)) if reparent else ""])) or "🦴 скелет без изменений"
    rid = "r" + os.urandom(4).hex()
    item = {"id": rid, "v": v, "dir": rel, "img": img, "extra": extra, "feedback": fb, "by": "skeleton", "rigchar": True, "fn": base.get("fn", ""), "ts": now_ms()}
    A.apply_ops(key, [{"op": "add", "path": ["elements", el, "renders"], "item": item}, {"op": "set", "path": ["elements", el, "render"], "value": rid}])
    job.result = item
    job.summary = f"«{e.get('name')}» v{v}: {fb}"


def run_job(A, job):
    if job.kind == "charrig":
        rig_version(A, job)
        return True
    if job.kind == "charemotions":
        slug = job.params["slug"]
        info = sheet_info(A, slug)
        res = A.run_claude(job, emotion_spec(A, info, job.params.get("want", "")))
        _, ld = lib(A)
        em = load_emotions(ld, slug)
        n = 0
        for e in res.get("emotions") or []:
            name = (e.get("name") or "").strip().lower()
            if not name or name in info["emotions"]:
                continue
            em[name] = {k: e[k] for k in ("eyes", "lid", "mouth", "brows", "look", "tired") if k in e and e[k] is not None and e[k] is not False and e[k] != "none"}   # lid 0 — это «широко открыты», не «нет»
            em[name].update({"ok": False, "by": "claude", "note": e.get("note", "")})
            n += 1
        save_emotions(A, ld, slug, em)
        job.result = {"added": n}
        job.summary = f"Claude предложил эмоций: {n} — «{info['card'].get('name')}», утверди в листе персонажа"
        return True
    return False


def anims(A, typ, cid=None):
    """Клипы типа скелета (library/anims/<type>/*.json): [{id, name, dur, loop, proc, by, prompt, preview}] — S5."""
    c, ld = lib(A, cid)
    d = os.path.join(ld, "anims", typ)
    out = []
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not f.endswith(".json"):
            continue
        try:
            a = json.load(open(os.path.join(d, f), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pv = os.path.join(d, f[:-5] + ".png")
        out.append({k: a.get(k) for k in ("id", "name", "dur", "loop", "proc", "by", "prompt")} | {
            "preview": f"/api/lib/file/{c['id']}/anims/{typ}/{f[:-5]}.png" if os.path.isfile(pv) else "", "channel": c["id"]})
    return sorted(out, key=lambda x: (x.get("by") != "base", x.get("name") or ""))


def handle_get(A, h, p, q):
    if p == "/api/anims":                                   # клипы типа скелета; video=<id> — канал этого видео
        vid = (q.get("video") or [""])[0]
        cid = P.index()["videos"].get(vid, {}).get("channel") if vid else None
        h._json({"items": anims(A, (q.get("type") or ["hog"])[0], cid)}); return True
    if p == "/api/char":
        h._json(sheet_info(A, (q.get("slug") or [""])[0])); return True
    if p == "/api/chars":
        h._json({"items": chars(A)}); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/char/emotion":                             # ✓ утвердить / ✗ убрать эмоцию
        _, ld = lib(A)
        slug, name, act = body["slug"], body["name"], body.get("act", "ok")
        em = load_emotions(ld, slug)
        if act == "drop":
            em.pop(name, None)
        else:
            em.setdefault(name, {})["ok"] = act == "ok"
            if act == "ok":
                em[name]["by"] = em[name].get("by") or "author"
        save_emotions(A, ld, slug, em)
        h._json({"ok": True, "emotions": em}); return True
    if p == "/api/char/teach":                               # «+ научить» (S5): Claude (Opus) выучивает клип типа скелета
        vid = body.get("video") or ""
        key = ("plan:" + vid) if vid else ("channel:" + ((P.channel() or {}).get("id") or ""))   # из листа персонажа видео нет — канал
        j = A.start_job("animteach", key, "teach:" + (body.get("type") or "hog"), {"type": body.get("type") or "hog", "ask": body.get("ask", ""), "char": body.get("char") or ""})
        h._json({"job": j.info()}); return True
    if p == "/api/char/rig":                                 # 🦴 редактор скелета: сохранить суставы новой версией (без Claude)
        j = A.start_job("charrig", body["key"], "charrig:" + body["el"], {"el": body["el"], "base": body.get("base"), "rig": body["rig"]})
        h._json({"job": j.info()}); return True
    if p == "/api/char/emotions":                            # ✨ предложить эмоции (Claude, Sonnet)
        j = A.start_job("charemotions", "char:" + body["slug"], "emotions", {"slug": body["slug"], "want": body.get("want", "")})
        h._json({"job": j.info()}); return True
    return False
