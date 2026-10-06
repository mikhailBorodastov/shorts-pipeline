"""S22: чек-лист препродакшена для монтажа — пункты «🎬 Для финала» каждого элемента (ТЗ автора к готовому ролику) и в каких сценах монтажа
этот элемент стоит. Автор, аудит 6 окт 2026: из 150 правок ролика Valve заметная часть — «я же просил на препродакшене» (Гейб с Queen of Pain,
охранник за ресепшеном, сервер падает на учёного): пункты «для финала» видел только агент сцены редактора (scene brief), монтаж на локациях — нет.

    montage needs  <видео>   — чек-лист: открытые / сделанные пункты, сцены и секунды ролика, где элемент стоит («нигде не стоит» — тоже сигнал)
    montage verify <видео>   — проверка по кадрам (Sonnet): по 2 кадра на сцену, сделан ли каждый пункт и не спорит ли кадр с таблицей преемственности -> build/needs.json
    montage continuity <видео> [--rebuild] — таблица преемственности по сценарию (Sonnet): где, когда, кто и в каком состоянии (video.json → continuity)
"""
import json
import os
import re
import subprocess

import paths as P


def _refs(obj):
    """id элементов, на которые ссылается объект сцены: el:<id>@vN, pending."""
    src = (obj or {}).get("src") or {}
    out = set()
    m = re.match(r"^el:([A-Za-z0-9_-]+)@", str(src.get("prefab") or ""))
    if m:
        out.add(m.group(1))
    if src.get("pending"):
        out.add(str(src["pending"]))
    if obj.get("el"):
        out.add(str(obj["el"]))
    return out


def _scene_uses(A, vid, plan, sid):
    """Какие элементы видео стоят в сцене монтажа sid (сцена на локации ms… или сцена редактора)."""
    els = {e["id"]: e for e in plan.get("elements") or []}
    used = set()
    loc_el = None
    m = next((x for x in plan.get("mscenes") or [] if x.get("id") == sid), None)
    if m:                                                    # S13: сцена — оверлей на локации
        loc_el = m.get("location")
        try:
            import locations_api as L
            ov = json.load(open(L.overlay_path(A, vid, sid), encoding="utf-8"))
            for o in ov.get("objects") or []:
                used |= _refs(o)
        except (OSError, ValueError):
            pass
    elif sid in els:                                         # S6: сцена редактора целиком
        loc_el = sid
    if loc_el and loc_el in els:
        used.add(loc_el)
        try:
            used |= {x["id"] for x, _ in A.pr().cast_of(els[loc_el], plan)}
            doc = A.scapi().load_scene(A, "plan:" + vid, loc_el)
            for o in doc.get("objects") or []:
                used |= _refs(o)
        except Exception:
            pass
    return used


def checklist(A, vid):
    """-> (items, scenes): items [{id, el, elName, kind, text, done, reply, scenes:[sid]}], scenes {sid: {name, at, len, n}}."""
    plan = A.load("plan:" + vid)
    M = plan.get("montage") or {}
    units = sorted(M.get("units") or [], key=lambda u: float(u.get("at") or 0))
    ms = {x["id"]: x for x in plan.get("mscenes") or []}
    els = {e["id"]: e for e in plan.get("elements") or []}
    scenes, uses = {}, {}
    for n, u in enumerate(units, 1):
        sid = u.get("scene")
        if not sid or sid in scenes:
            continue
        scenes[sid] = {"n": n, "name": (ms.get(sid) or {}).get("name") or (els.get(sid) or {}).get("name") or sid,
                       "at": float(u.get("at") or 0), "len": float(u.get("len") or 0)}
        uses[sid] = _scene_uses(A, vid, plan, sid)
    if not units and plan.get("fast"):                       # быстрый ролик: сцены — код src/scenes/sNN.js (SCENES[k] = …), время — секция k голоса
        pd = P.video(vid) or ""
        try:
            secs = json.load(open(os.path.join(pd, "build", "vo_timing.json"), encoding="utf-8")).get("sections") or []
        except (OSError, ValueError):
            secs = []
        sd = os.path.join(pd, "src", "scenes")
        alias = {}                                           # общий код: LOC = { csDesks: 'e17b…' } — сцены пишут LOC.csDesks, а не id
        try:
            common = re.sub(r"//[^\n]*|/\*.*?\*/", "", open(os.path.join(pd, "src", "scenes.js"), encoding="utf-8", errors="replace").read(), flags=re.S)
            for name, eid in re.findall(r"\b([A-Za-z_$][\w$]*)\s*[:=]\s*['\"]([A-Za-z0-9_-]+)['\"]", common):
                if eid in els:
                    alias.setdefault(eid, set()).add(name)
        except OSError:
            pass
        for f in sorted(os.listdir(sd)) if os.path.isdir(sd) else []:
            code = open(os.path.join(sd, f), encoding="utf-8", errors="replace").read()
            ks = [int(k) for k in re.findall(r"SCENES\[\s*(\d+)\s*\]\s*=(?!=)", code)]
            if not ks:
                continue
            body = re.sub(r"//[^\n]*|/\*.*?\*/", "", code, flags=re.S)
            for k in ks:
                sid = f"s{k}"
                sec = secs[k] if k < len(secs) else {}
                scenes[sid] = {"n": k, "name": f"{f}" + (f" · {sec.get('title')}" if sec.get("title") else ""),
                               "at": float(sec.get("start") or 0), "len": float(sec.get("dur") or 0)}
                uses[sid] = {i for i in els if i in body or any(re.search(r"\b" + re.escape(a) + r"\b", body) for a in alias.get(i, ()))}
    items = []
    for e in plan.get("elements") or []:
        if e.get("status") == "drop":
            continue
        for f in e.get("final") or []:
            if not (f.get("text") or "").strip():
                continue
            items.append({"id": f["id"], "el": e["id"], "elName": e.get("name", ""), "kind": e.get("kind"), "text": f["text"].strip(),
                          "done": bool(f.get("done")), "reply": f.get("reply") or "", "scenes": [s for s in scenes if e["id"] in uses[s]]})
    return items, scenes


def needs_text(A, vid):
    items, scenes = checklist(A, vid)
    if not items:
        return "🎬 Для финала: пунктов нет"
    ver = {}
    try:
        ver = {x["id"]: x for x in json.load(open(os.path.join(P.video(vid), "build", "needs.json"), encoding="utf-8")).get("items") or []}
    except (OSError, ValueError, TypeError):
        pass
    L = [f"🎬 Для финала — ТЗ автора к готовому ролику ({sum(not i['done'] for i in items)} открытых из {len(items)}). "
         f"Сделал — закрой: scene final-done {vid} <ЭЛЕМЕНТ> <ID>[,ID] \"что сделано\"; проверка по кадрам — montage verify {vid}"]
    for i in sorted(items, key=lambda i: (i["done"], min([scenes[s]["n"] for s in i["scenes"]] or [999]))):
        where = ", ".join(f"сцена {scenes[s]['n']} «{scenes[s]['name']}» {scenes[s]['at']:.1f}–{scenes[s]['at'] + scenes[s]['len']:.1f} с" for s in i["scenes"]) \
            or "⚠ элемент НИГДЕ не стоит в монтаже — поставь его в нужную сцену"
        v = ver.get(i["id"])
        chk = "" if not v else (" · проверка: ✓" if v.get("ok") is True else f" · проверка: ❌ {v.get('why', '')}" if v.get("ok") is False else f" · проверка: ? {v.get('why', '')}")
        L.append(f"{'✓' if i['done'] else '☐'} [{i['el']} {i['id']}] {i['elName']}: {i['text']}\n    где: {where}"
                 + (f"\n    сделано: {i['reply']}" if i["done"] and i["reply"] else "") + chk)
    return "\n".join(L)


def _claude_job(vid, tag):
    class J:
        id, proc, meta, cancelled, summary = f"{tag}-{vid}", None, {}, False, ""
    return J()


# ---------------------------------------------------------------- В: таблица преемственности (S22)
# Автор, правки Valve и «Стива»: «опять старый офис вернулся? мы ж переехали», «почему с руками» (их оторвало), «он уже улетел в прошлом кадре»,
# «у нас же есть свой Гейб». Монтаж не помнил, в каком состоянии мир и герои к этой сцене. Таблица — по сцене сценария (секции голоса):
# где, когда / эпоха, кто в кадре и в каком состоянии, что держится с прошлых сцен, что меняется здесь и держится дальше.
def _secs(A, vid):
    pd = P.video(vid) or ""
    try:
        return json.load(open(os.path.join(pd, "build", "vo_timing.json"), encoding="utf-8")).get("sections") or []
    except (OSError, ValueError):
        return []


def _script(A, vid):
    pd = P.video(vid) or ""
    try:
        return open(os.path.join(pd, "script.md"), encoding="utf-8").read()
    except OSError:
        return ""


def continuity(A, vid, rebuild=False):
    """-> {scenes: [...], hash}. Есть и сценарий тот же — из видео (video.json → continuity), иначе Sonnet строит заново."""
    import hashlib
    plan = A.load("plan:" + vid)
    script = _script(A, vid)
    if not script.strip():
        return None
    notes = [n.get("text", "").strip() for n in plan.get("notes") or [] if (n.get("text") or "").strip()]   # правки автора к ролику — решения поверх сценария
    h = hashlib.sha1((script + "\n".join(notes)).encode("utf-8")).hexdigest()[:12]
    cur = plan.get("continuity") or {}
    if cur.get("hash") == h and cur.get("scenes") and not rebuild:
        return cur
    from ideas_claude import S, STR, ARR
    els = [e for e in plan.get("elements") or [] if e.get("status") != "drop" and e.get("kind") in ("char", "prop", "scene")]
    cast = "\n".join(f"- {e['kind']} «{e.get('name')}»: {(e.get('desc') or '')[:140]}" for e in els[:120])
    secs = _secs(A, vid)
    sec_list = "\n".join(f"{k}. {s.get('title') or ''}" for k, s in enumerate(secs)) or "(голоса нет — бери сцены сценария по порядку)"
    prompt = f"""Составь ТАБЛИЦУ ПРЕЕМСТВЕННОСТИ для монтажа ролика: по каждой сцене сценария — в каком состоянии мир и герои, чтобы картинка не противоречила
ни сценарию, ни прошлым сценам. Типичные ошибки, которые она ловит: герой улетел — а в следующей сцене стоит на месте; руки оторвало — а дальше снова с руками;
переехали в новый офис — а в следующей сцене опять старый; эпоха сменилась — а на столе вещи прошлой.

Сцены (секции голоса, k с нуля — так они нумеруются в монтаже):
{sec_list}

Персонажи, предметы и места препродакшена (называй их ТАК ЖЕ):
{cast}

Сценарий:
{script[:24000]}
{("ПРАВКИ АВТОРА К РОЛИКУ — его решения ПОВЕРХ сценария (кто где больше не нужен, что убрать, кем заменить); где спорят со сценарием — главнее они:" + chr(10) + chr(10).join("- " + t[:300] for t in notes[-80:])) if notes else ""}

По каждой сцене k: place — где (место препродакшена, если подходит), time — когда / эпоха (год, утро / ночь), cast — кто в кадре и в каком он состоянии
(одежда, ранения, где находится, что держит; «как обычно» — если ничего особого), keep — что ДЕРЖИТСЯ с прошлых сцен и должно быть видно (коротко),
change — что МЕНЯЕТСЯ в этой сцене и дальше держится. Только то, что следует из сценария; не выдумывай деталей. Коротко, по-русски."""
    spec = {"system": "Ты помощник монтажёра: следишь за непрерывностью (континуити) сцен. Отвечай строго JSON по схеме.", "prompt": prompt,
            "model": A.TEXT_MODEL, "timeout": 300,
            "schema": S({"scenes": ARR(S({"k": {"type": "integer"}, "title": STR, "place": STR, "time": STR,
                                          "cast": ARR(S({"who": STR, "state": STR}, ["who", "state"])), "keep": ARR(STR), "change": ARR(STR)},
                                         ["k", "place", "cast"]))}, ["scenes"])}
    res = A.run_claude(_claude_job(vid, "cont"), spec) or {}
    doc = {"hash": h, "at": A.now_ms(), "scenes": res.get("scenes") or []}
    A.apply_ops("plan:" + vid, [{"op": "set", "path": ["continuity"], "value": doc}])
    return doc


def continuity_text(A, vid, rebuild=False):
    doc = continuity(A, vid, rebuild)
    if not doc:
        return "Таблица преемственности: сценария (script.md) нет"
    L = [f"🧭 Таблица преемственности (из сценария; монтируй так, чтобы каждая сцена ей не противоречила — место, время, кто и в каком состоянии; "
         f"сценарий поменяется — montage continuity {vid} --rebuild):"]
    for s in doc.get("scenes") or []:
        who = "; ".join(f"{c.get('who')} — {c.get('state')}" for c in s.get("cast") or [])
        L.append(f"[{s.get('k')}] {s.get('title') or ''} · {s.get('place') or '?'} · {s.get('time') or ''}\n    в кадре: {who or '—'}"
                 + (f"\n    держится: {'; '.join(s.get('keep') or [])}" if s.get("keep") else "")
                 + (f"\n    меняется: {'; '.join(s.get('change') or [])}" if s.get("change") else ""))
    return "\n".join(L)


def verify(A, vid):
    """Проверка по кадрам (Sonnet, один проход): сделан ли каждый пункт «для финала» (по кадрам его сцен) и не спорит ли картинка с таблицей
    преемственности (по кадрам каждой сцены сценария). -> текст; build/needs.json."""
    items, scenes = checklist(A, vid)
    items = [i for i in items if i["scenes"]]
    pd = P.video(vid)
    secs = _secs(A, vid)
    cont = (A.load("plan:" + vid).get("continuity") or {}).get("scenes") or []
    spans = {}                                                # ключ кадров -> (подпись, начало, длина)
    for s in {s for i in items for s in i["scenes"]}:
        spans["m_" + s] = (f"сцена монтажа {scenes[s]['n']} «{scenes[s]['name']}»", scenes[s]["at"], scenes[s]["len"])
    checks = []
    for c in cont:
        k = c.get("k")
        if not isinstance(k, int) or k >= len(secs):
            continue
        want = [f"{x.get('who')} — {x.get('state')}" for x in c.get("cast") or [] if (x.get("state") or "").strip() and "обычн" not in x.get("state", "")] + list(c.get("keep") or [])
        if not want:
            continue
        spans[f"c_{k}"] = (f"сцена сценария {k} «{secs[k].get('title') or ''}»", float(secs[k].get("start") or 0), float(secs[k].get("dur") or 0))
        checks.append({"id": f"cont{k}", "key": f"c_{k}", "text": f"сцена {k}: место «{c.get('place')}»; " + "; ".join(want)})
    if not items and not checks:
        return "проверять нечего: нет пунктов «для финала» у элементов в монтаже и нет таблицы преемственности (montage continuity)"
    os.makedirs(os.path.join(pd, "build", "needs"), exist_ok=True)
    env = P.tool_env(dict(os.environ, PYTHONIOENCODING="utf-8", REVIEW_PORT=str(A.stapi().project_port(pd))))
    sheets = {}
    for key, (label, at, ln) in spans.items():
        if ln <= 0:
            continue
        out = os.path.join(pd, "build", "needs", f"{key}.png")
        subprocess.run(["node", "render.js", "snap", ",".join(f"{at + ln * f:.2f}" for f in (0.3, 0.7)), out], cwd=pd, env=env, capture_output=True,
                       timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if os.path.isfile(out):
            sheets[key] = out
    fwd = lambda p: p.replace(chr(92), "/")
    lines = []
    for i in items:
        shots = [f"{spans['m_' + s][0]}: {fwd(sheets['m_' + s])}" for s in i["scenes"] if "m_" + s in sheets]
        lines.append(f"- {i['id']} · ТЗ «{i['elName']}»: «{i['text']}» · кадры: " + ("; ".join(shots) or "нет"))
    for c in checks:
        if c["key"] in sheets:
            lines.append(f"- {c['id']} · ПРЕЕМСТВЕННОСТЬ {c['text']} · кадры: {spans[c['key']][0]}: {fwd(sheets[c['key']])}")
    from ideas_claude import S, STR
    prompt = ("Проверка готового ролика. Пункты двух видов: ТЗ — что автор хотел увидеть в ролике («🎬 Для финала»); ПРЕЕМСТВЕННОСТЬ — каким по сценарию "
              "должен быть кадр сцены (место, кто и в каком состоянии). У каждого — листы кадров (по 2 кадра на сцену, PNG). Посмотри кадры через Read и реши: "
              "ok true — в кадрах это есть / не противоречит; false — нет, сделано не так или явно противоречит (why: что не так, коротко, по-русски); "
              "null — по этим кадрам не понять. Не придирайся к мелочам, которых не видно, и не додумывай.\n\n" + "\n".join(lines))
    spec = {"system": "Ты проверяешь кадры ролика по ТЗ автора и непрерывности сцен. Отвечай строго JSON по схеме.", "prompt": prompt,
            "model": A.TEXT_MODEL, "timeout": 900, "read": list(sheets.values()), "tools": ["Read"], "allowed": ["Read"],
            "schema": S({"items": {"type": "array", "items": S({"id": STR, "ok": {"type": ["boolean", "null"]}, "why": STR}, ["id", "ok"])}}, ["items"])}
    res = A.run_claude(_claude_job(vid, "needs"), spec) or {}
    got = {x.get("id"): x for x in res.get("items") or []}
    rows = [dict(id=i["id"], el=i["el"], kind="final", text=i["text"], ok=(got.get(i["id"]) or {}).get("ok"), why=(got.get(i["id"]) or {}).get("why", "")) for i in items]
    rows += [dict(id=c["id"], el="", kind="continuity", text=c["text"], ok=(got.get(c["id"]) or {}).get("ok"), why=(got.get(c["id"]) or {}).get("why", ""))
             for c in checks if c["key"] in sheets]
    P.write_atomic(os.path.join(pd, "build", "needs.json"), json.dumps({"items": rows, "sheets": sheets}, ensure_ascii=False, indent=1))
    bad = [r for r in rows if r["ok"] is False]
    unk = [r for r in rows if r["ok"] is None]
    tag = lambda r: f"[{r['el']} {r['id']}]" if r["kind"] == "final" else "[преемственность]"
    out = [f"проверка по кадрам: ✓ {sum(r['ok'] is True for r in rows)} · ❌ {len(bad)} · ? {len(unk)} из {len(rows)}"]
    out += [f"❌ {tag(r)} {r['text']} — {r['why']}" for r in bad]
    out += [f"? {tag(r)} {r['text']} — {r['why']}" for r in unk]
    return "\n".join(out)
