"""Визуалы канала: техники → луки (S14, docs/studio/stage14-looks.md).

channel.json:
  techniques[] {id, key, label, icon, desc, engine '2d'|'3d', builtin, controls[Control], scene}
  looks[]      {id, key, tech, engine, label, desc, builtin, factory {params, desc} | None, params {путь.с.точкой: значение}, extra[Control], scene,
                palette {colors}, heroes [{id, kind 'lib'|'desc'|'hog', ref, name, desc, character, role 'main'|'', video}], refs[], interview {qa[], refs[], done},
                preview {video, poster, sig, ts, status, error}, build {why, note, ts}}
  Control = {key, label, hint, type 'toggle'|'slider'|'select'|'color', min, max, step, options [[v, label]], default, group, dep}
Стартовые техники и луки — web/ref.json (techniques, looks); переезд старых визуалов (looks с engine) — migrate(), один раз, с копией channel.json в style/.history.
В ролик лук попадает как window.LOOK (src/format.js проекта, format_js): вложенный объект из params (+ brief.lookOver видео, заморозка lookSnap у вышедших),
его читают engine/lib.js (LOOKV, lookPost), stage3d.js (lookFx), props3d.js, rig.js и тулкит paper.js.
"""
import hashlib, json, os, re, shutil, subprocess, sys, time

import paths as P  # noqa: E402

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def now_ms():
    return int(time.time() * 1000)


def _chan(cid=None):
    c = P.channel(cid) if cid else P.channel()
    if not c:
        raise ValueError("нет такого канала")
    return c


def _by(lst, k, v):
    return next((x for x in lst or [] if x.get(k) == v), None)


# ---------------------------------------------------------------- ручки и значения
def tech_of(doc, look):
    return _by(doc.get("techniques"), "key", look.get("tech")) or {}


def controls(doc, look):
    """Ручки лука: техники + свои (extra) — свои с тем же ключом заменяют."""
    out = {c["key"]: c for c in (tech_of(doc, look).get("controls") or []) if c.get("key")}
    for c in look.get("extra") or []:
        if c.get("key"):
            out[c["key"]] = dict(c, own=True)
    return list(out.values())


def defaults(ctls):
    return {c["key"]: c.get("default") for c in ctls if c.get("key") and c.get("default") is not None}


def nest(params):
    """{'fx.bloom.on': True, 'post.sat': -1} -> {'fx': {'bloom': {'on': True}}, 'post': {'sat': -1}}"""
    out = {}
    for k in sorted(params or {}):
        v = params[k]
        cur, parts = out, k.split(".")
        for p in parts[:-1]:
            if not isinstance(cur.get(p), dict):
                cur[p] = {}
            cur = cur[p]
        cur[parts[-1]] = v
    return out


def effective(doc, look, over=None):
    """Значения ручек: умолчания техники + лук + перекрытия видео."""
    v = defaults(controls(doc, look))
    v.update(look.get("params") or {})
    v.update(over or {})
    return v


def look_obj(doc, look, over=None, heroes=None):
    """window.LOOK для ролика / превью: только ручки, отличные от умолчаний (умолчание = «как задумано в сцене», движок не трогает)."""
    dflt = defaults(controls(doc, look))
    L = nest({k: v for k, v in effective(doc, look, over).items() if k not in dflt or v != dflt[k]})
    L["key"], L["tech"], L["engine"] = look.get("key"), look.get("tech"), look.get("engine") or tech_of(doc, look).get("engine") or "2d"
    L["palette"] = [c.get("hex") for c in (look.get("palette") or {}).get("colors") or [] if c.get("hex")]
    L["heroes"] = [{k: h.get(k) for k in ("kind", "ref", "name", "role") if h.get(k)} for h in (heroes if heroes is not None else look.get("heroes") or [])]
    return L


# ---------------------------------------------------------------- переезд старых визуалов (S12.10 -> S14)
def needs_migrate(doc):
    return not doc.get("techniques")


def migrate(A, cid):
    """Старые looks[] {key, label, desc, engine, refs} -> техники (paper / diorama) + луки. Повторно ничего не делает."""
    c = _chan(cid)
    key = "channel:" + c["id"]
    doc = A.load(key)
    if not needs_migrate(doc):
        return {"ok": True, "migrated": False}
    src = os.path.join(c["dir"], "channel.json")
    hd = os.path.join(c["dir"], "style", ".history")
    os.makedirs(hd, exist_ok=True)
    shutil.copy2(src, os.path.join(hd, time.strftime("%Y%m%d-%H%M%S") + "_channel-before-s14.json"))
    R = A.ref()
    techs = [dict(t, id=A.new_id("t"), builtin=True, scene=None) for t in R.get("techniques") or []]
    try:
        pal = json.load(open(os.path.join(c["dir"], "style", "palette.json"), encoding="utf-8"))
    except (OSError, ValueError):
        pal = {}
    colors = pal.get("colors") or []
    old = doc.get("looks") or []
    looks = []
    tdoc = {"techniques": techs}
    for rl in R.get("looks") or []:                               # встроенные — только те, что у канала уже были (ключи paper, diorama, noir: видео не ломаются);
        was = _by(old, "key", rl["key"])                          # новый канал получает одни техники — свои луки соберутся из его интервью
        if not was:
            continue
        lk = {"id": (was or {}).get("id") or A.new_id("l"), "key": rl["key"], "tech": rl["tech"], "engine": rl["engine"], "builtin": True,
              "label": rl["label"], "desc": (was or {}).get("desc") or rl["desc"], "refs": (was or {}).get("refs") or [], "extra": [], "scene": None,
              "palette": {"colors": [dict(x) for x in colors]}, "heroes": [], "interview": {"qa": [], "refs": [], "done": False}, "preview": {}, "build": {}}
        lk["params"] = effective(tdoc, dict(lk, params=rl.get("params") or {}))
        lk["factory"] = {"params": dict(lk["params"]), "desc": lk["desc"], "label": rl["label"]}   # описание канала (если было) — заводское: не «изменён» с порога
        looks.append(lk)
    for o in old:                                                 # свои старые визуалы — в технику по движку
        if _by(looks, "key", o.get("key")):
            continue
        tk = "diorama" if o.get("engine") == "3d" else "paper"
        lk = {"id": o.get("id") or A.new_id("l"), "key": o.get("key") or A.new_id("l"), "tech": tk, "engine": o.get("engine") or "2d", "builtin": False, "factory": None,
              "label": o.get("label") or "визуал", "desc": o.get("desc") or "", "refs": o.get("refs") or [], "extra": [], "scene": None,
              "palette": {"colors": [dict(x) for x in colors]}, "heroes": [], "interview": {"qa": [], "refs": [], "done": False}, "preview": {}, "build": {}}
        lk["params"] = effective(tdoc, lk)
        looks.append(lk)
    ops = [{"op": "set", "path": ["techniques"], "value": techs}, {"op": "set", "path": ["looks"], "value": looks},
           {"op": "set", "path": ["heroLegacy"], "value": {"hero": doc.get("hero") or {}, "rulesHero": (doc.get("rules") or {}).get("hero") or ""}}]
    A.apply_ops(key, ops)
    return {"ok": True, "migrated": True, "techniques": len(techs), "looks": len(looks)}


def refresh_builtins(A, cid):
    """Встроенные техники и луки — из свежего ref.json (ручки техники, заводские значения луков). Нетронутые автором луки получают новые заводские значения."""
    c = _chan(cid)
    key = "channel:" + c["id"]
    doc = A.load(key)
    R = A.ref()
    ops, n = [], 0
    for rt in R.get("techniques") or []:
        t = _by(doc.get("techniques"), "key", rt["key"])
        if t and t.get("builtin"):
            ops += [{"op": "set", "path": ["techniques", t["id"], k], "value": rt[k]} for k in ("controls", "desc", "label", "icon", "engine")]
    tdoc = {"techniques": [dict(_by(doc.get("techniques"), "key", rt["key"]) or {}, **rt) for rt in R.get("techniques") or []]}
    for rl in R.get("looks") or []:
        lk = _by(doc.get("looks"), "key", rl["key"])
        if not lk or not lk.get("builtin"):
            continue
        untouched = not lk.get("factory") or (lk.get("params") == (lk["factory"] or {}).get("params"))
        keys = {x["key"] for x in controls(tdoc, dict(lk, extra=[]))}
        fp = {k: v for k, v in effective(tdoc, dict(lk, params=rl.get("params") or {}, extra=[])).items() if k in keys}
        ops.append({"op": "set", "path": ["looks", lk["id"], "factory"], "value": {"params": fp, "desc": rl["desc"], "label": rl["label"]}})
        if untouched:
            ops += [{"op": "set", "path": ["looks", lk["id"], "params"], "value": dict(fp)}, {"op": "set", "path": ["looks", lk["id"], "desc"], "value": rl["desc"]}]
            n += 1
    if ops:
        A.apply_ops(key, ops)
    return {"ok": True, "looks": n}


def catalog(A, doc):
    """Встроенные луки из ref.json, которых у канала нет, — каталог «взять готовый»."""
    have = {lk.get("key") for lk in doc.get("looks") or []}
    return [rl for rl in A.ref().get("looks") or [] if rl["key"] not in have]


def take_builtin(A, cid, lkey):
    """Взять встроенный лук из каталога в канал (как есть, с заводскими значениями, без героев)."""
    c = _chan(cid)
    key = "channel:" + c["id"]
    doc = A.load(key)
    rl = next((x for x in catalog(A, doc) if x["key"] == lkey), None)
    if not rl:
        raise ValueError("такого встроенного лука нет или он уже в канале")
    lk = {"id": A.new_id("l"), "key": rl["key"], "tech": rl["tech"], "engine": rl["engine"], "builtin": True, "label": rl["label"], "desc": rl["desc"],
          "refs": [], "extra": [], "scene": None, "palette": {"colors": []}, "heroes": [], "interview": {"qa": [], "refs": [], "done": False}, "preview": {}, "build": {}}
    lk["params"] = effective(doc, dict(lk, params=rl.get("params") or {}))
    lk["factory"] = {"params": dict(lk["params"]), "desc": rl["desc"], "label": rl["label"]}
    A.apply_ops(key, [{"op": "add", "path": ["looks"], "item": lk}])
    return {"ok": True, "look": lk["id"]}


def from_interview(A, cid, start=True):
    """Черновик лука из интервью канала: ответы блока «Визуал и герой» + референсы (полка и вложения) -> ✨ сборка (lookbuild)."""
    c = _chan(cid)
    key = "channel:" + c["id"]
    doc = A.load(key)
    I = doc.get("interview") or {}
    qa = [q for q in I.get("qa") or [] if (q.get("block") or "visual") == "visual" and ((q.get("a") or "").strip() or q.get("refs"))]
    if not qa and not I.get("refs"):
        raise ValueError("в интервью канала нет ответов про визуал — ответь на блок «Визуал и герой» или собери визуал по референсам")
    lid = A.new_id("l")
    lk = {"id": lid, "key": "l" + A.new_id(""), "tech": "", "engine": "", "label": f"Визуал «{doc.get('name', '')}»", "desc": "", "builtin": False, "factory": None, "draft": True,
          "params": {}, "extra": [], "scene": None, "palette": {"colors": []}, "heroes": [], "refs": [dict(r) for r in I.get("refs") or []], "from": "interview",
          "interview": {"qa": [{"id": A.new_id("q"), "q": q["q"], "why": q.get("why", ""), "a": q.get("a", ""), "refs": [dict(r) for r in q.get("refs") or []], "by": "channel"} for q in qa], "done": True},
          "preview": {}, "build": {}}
    A.apply_ops(key, [{"op": "add", "path": ["looks"], "item": lk}])
    job = A.start_job("lookbuild", key, "lookbuild:" + lid, {"channel": c["id"], "look": lid}) if start else None
    return {"ok": True, "look": lid, "job": job.info() if job else None}


def reset(A, cid, look_id):
    """↺ к заводским: значения ручек, название и описание встроенного лука."""
    c = _chan(cid)
    key = "channel:" + c["id"]
    doc = A.load(key)
    lk = _by(doc.get("looks"), "id", look_id)
    if not lk or not lk.get("factory"):
        raise ValueError("у этого лука нет заводских настроек")
    F = lk["factory"]
    A.apply_ops(key, [{"op": "set", "path": ["looks", look_id, "params"], "value": dict(F.get("params") or {})},
                      {"op": "set", "path": ["looks", look_id, "desc"], "value": F.get("desc") or lk.get("desc", "")},
                      {"op": "set", "path": ["looks", look_id, "label"], "value": F.get("label") or lk.get("label", "")}])
    return {"ok": True}


def usage(A, cid, lkey):
    """Видео канала на этом луке: [{id, name, status}]."""
    out = []
    for vid, x in P.index(True)["videos"].items():
        if x.get("channel") != cid:
            continue
        try:
            d = A.load("plan:" + vid)
        except Exception:
            continue
        if (d.get("brief") or {}).get("look") == lkey:
            out.append({"id": vid, "name": d.get("name") or x.get("name") or vid, "status": d.get("status") or ""})
    return out


# ---------------------------------------------------------------- лук видео: в проект (format.js) и в бриф
def _chan_doc(A, cid):
    try:
        return A.load("channel:" + cid) if cid else {}
    except Exception:
        return {}


def video_look(A, plan, cid=None):
    """(doc канала, лук, перекрытия, герои) для видео; у вышедших — заморозка lookSnap."""
    cid = cid or P.index()["videos"].get(plan.get("id"), {}).get("channel")
    doc = _chan_doc(A, cid)
    b = plan.get("brief") or {}
    lk = _by(doc.get("looks"), "key", b.get("look"))
    if not lk:
        return doc, None, {}, None
    snap = plan.get("lookSnap")
    if snap:
        return doc, dict(lk, params=snap.get("params") or {}, palette=snap.get("palette") or lk.get("palette")), {}, snap.get("heroes")
    o = b.get("lookOver") or {}
    return doc, lk, o.get("params") or {}, o.get("heroes")


def format_js(A, plan, cid=None):
    """src/format.js проекта: кадр (FRAME_SIZE) + визуал (window.LOOK)."""
    long_ = plan.get("mode") == "long"
    s = ("// Кадр ролика: " + ("длинное видео 16:9" if long_ else "шортс 9:16") + ". Пишет Claude Studio (looks_api.format_js).\n"
         "window.FRAME_SIZE = " + ("[1920, 1080]" if long_ else "[1080, 1920]") + ";\n")
    try:
        doc, lk, over, heroes = video_look(A, plan, cid)
    except Exception:
        lk = None
    if lk:
        s += "// Визуал канала (S14): ручки лука + настройки этого видео — читают lib.js (LOOKV), stage3d.js, props3d.js, rig.js, paper.js.\n"
        s += "window.LOOK = " + json.dumps(look_obj(doc, lk, over, heroes), ensure_ascii=False) + ";\n"
    return s


def write_format(A, plan, vdir=None, cid=None):
    vdir = vdir or P.video(plan.get("id"))
    if vdir and os.path.isdir(os.path.join(vdir, "src")):
        A.write_text(os.path.join(vdir, "src", "format.js"), format_js(A, plan, cid))


def _fmtv(c, v):
    if c.get("type") == "toggle":
        return "вкл" if v else "выкл"
    if c.get("type") == "select":
        return next((l for k, l in c.get("options") or [] if k == v), str(v))
    if isinstance(v, float):
        return f"{v:.3g}"
    return str(v)


def params_text(doc, look, over=None):
    """Ручки, отличные от умолчаний техники, человеческим языком."""
    ctls = controls(doc, look)
    dflt = defaults(ctls)
    vals = effective(doc, look, over)
    rows = []
    for c in ctls:
        k = c["key"]
        if k in vals and (c.get("own") or vals[k] != dflt.get(k)):
            rows.append(f"{c.get('label') or k} ({k}) = {_fmtv(c, vals[k])}" + (f" — {c['hint']}" if c.get("own") and c.get("hint") else ""))
    return "; ".join(rows)


def heroes_text(heroes):
    if not heroes:
        return "нет постоянного героя — персонажи по сюжету ролика"
    out = []
    for h in heroes:
        s = h.get("name") or "герой"
        if h.get("role") == "main":
            s += " (главный)"
        if h.get("kind") == "lib" and h.get("ref"):
            s += f" — {h['ref']}"
        elif h.get("kind") == "hog":
            s += " — бумажный ёжик тулкита (drawHog / hogCard)"
        if h.get("desc"):
            s += f": {h['desc']}"
        out.append(s)
    return "; ".join(out)


def brief_lines(A, b, cid):
    """Строки «Визуал / Настройки лука / Герои» для брифа видео (videos_api.brief_text)."""
    doc = _chan_doc(A, cid)
    lk = _by(doc.get("looks"), "key", b.get("look"))
    if not lk:
        return []
    t = tech_of(doc, lk)
    o = b.get("lookOver") or {}
    L = [f"Визуал: {t.get('label', '')} / {lk.get('label', '')} — {lk.get('desc', '')}"]
    pt = params_text(doc, lk, o.get("params"))
    if pt:
        L.append("Настройки лука (window.LOOK, движок применяет сам; свои ручки читай LOOKV('ключ', умолчание)): " + pt)
    L.append("Герои: " + heroes_text(o.get("heroes") if o.get("heroes") is not None else lk.get("heroes")))
    return L


def freeze(A, vid):
    """Видео вышло — настройки лука замораживаются (lookSnap)."""
    key = "plan:" + vid
    d = A.load(key)
    if d.get("lookSnap"):
        return
    doc, lk, over, heroes = video_look(A, d)
    if not lk:
        return
    A.apply_ops(key, [{"op": "set", "path": ["lookSnap"], "value": {"params": effective(doc, lk, over), "heroes": heroes if heroes is not None else lk.get("heroes") or [],
                                                                     "palette": lk.get("palette") or {}, "look": lk.get("key"), "ts": now_ms()}}])


# ---------------------------------------------------------------- HTTP / CLI
def handle_get(A, h, p, q):
    cid = (q.get("channel") or [""])[0] or None
    if p == "/api/looks/catalog":
        c = _chan(cid)
        h._json({"items": catalog(A, A.load("channel:" + c["id"]))}); return True
    if p == "/api/looks/usage":
        h._json({"items": usage(A, _chan(cid)["id"], (q.get("look") or [""])[0])}); return True
    return False


def handle_post(A, h, p, body):
    cid = body.get("channel") or None
    jobs = {"/api/looks/preview": "lookprev", "/api/looks/hero": "lookhero", "/api/looks/questions": "lookq", "/api/looks/build": "lookbuild"}
    if p in jobs:                                              # задачи — server/looks_jobs.py
        c = _chan(cid)
        params = {"channel": c["id"], "look": body.get("look"), "hero": body.get("hero"), "n": body.get("n")}
        j = A.start_job(jobs[p], "channel:" + c["id"], jobs[p] + ":" + str(body.get("look")), params)
        h._json({"job": j.info()}); return True
    if p == "/api/looks/refurl":                               # 🔎 найденная картинка -> style/refs канала
        h._json({"f": A.ljapi().ref_from_url(_chan(cid)["id"], body.get("url"), body.get("fallback"))}); return True
    if p == "/api/looks/migrate":
        h._json(migrate(A, cid)); return True
    if p == "/api/looks/take":                                 # взять встроенный лук из каталога
        h._json(take_builtin(A, cid, body.get("key"))); return True
    if p == "/api/looks/from-interview":                       # ✨ визуал из интервью канала
        h._json(from_interview(A, cid)); return True
    if p == "/api/looks/reset":
        h._json(reset(A, cid, body.get("look"))); return True
    return False


def cli(A, argv):
    """looks migrate [канал] | looks refresh [канал] — встроенные из ref.json | looks show [канал] | looks format <видео> — что попадёт в src/format.js"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "migrate":
        print(migrate(A, a[0] if a else None)); return True
    if cmd == "refresh":
        print(refresh_builtins(A, a[0] if a else None)); return True
    if cmd == "show":
        c = _chan(a[0] if a else None)
        doc = A.load("channel:" + c["id"])
        for t in doc.get("techniques") or []:
            print(f"{t.get('icon', '')} {t['label']} [{t['key']}, {t.get('engine')}]")
            for lk in doc.get("looks") or []:
                if lk.get("tech") == t["key"]:
                    print(f"   · {lk['label']} [{lk['key']}] — {params_text(doc, lk) or 'умолчания'}; герои: {heroes_text(lk.get('heroes'))}")
        return True
    if cmd == "format":
        print(format_js(A, A.load("plan:" + a[0]))); return True
    return False
