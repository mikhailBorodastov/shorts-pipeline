"""S15 «Уже было» (docs/studio/stage15-reuse.md): прежде чем рисовать новый ассет — найти, не сделан ли он раньше.

Каталог — библиотека канала (персонажи, пропсы, звуки) + утверждённые ✓ элементы прошлых видео канала, ещё не опубликованные.
После «✨ Накидать» (и CLI add-elements) новые персонажи, пропсы и звуки получают e.libMatch = {state: 'wait'} и задачу reuse (Sonnet):
Claude сверяет их с каталогом (по сомнительным — смотрит превью) -> e.libMatch = {state: 'found'|'none', found: [{ref, score, why, diff, suggest, …}]}.
Автор решает в поп-апе «Нашлось в библиотеке» (web/ui/preprod.js) -> pick():
    as-is — копия предмета в тот же элемент, ✓, черновик не рисуется;   base — копия + задача element «поправь под это видео» (vN+1);
    new  — обычный черновик.   Предмет из прошлого видео (el:…) сначала публикуется в библиотеку.
Пока решения нет, черновик не рисуется: «✨ Сделать всё» пропускает элемент, сервер держит его задачи (ideas_api._waits_for -> holds()).

HTTP: POST /api/lib/reuse {key, el, how, ref}   POST /api/lib/reuse/check {key, els?}
CLI:  python studio.py lib reuse <видео> <эл> as-is|base|new [ref]  |  lib reuse-check <видео> [эл…]  |  lib reuse-catalog <видео>
"""
import json, os, re, shutil, time, urllib.error

import paths as P

KINDS = ("char", "prop", "sound", "scene", "vfx")
BASE_ONLY = ("scene", "vfx")       # S15 ч.2: локации / сцены и эффекты — только «За основу» из прошлых видео (в библиотеке их нет; код сцены надо подогнать)
LIB2EL = {"characters": "char", "props": "prop", "sounds": "sound"}
MIN_SCORE = 0.6                    # ниже — шум в окне («Стив в пижаме» ≈ «Ёжик в пижаме» по одной одежде)
PER_KIND = 45                      # строк одного вида в промпт: больше — сначала самые похожие по словам


def now_ms():
    return int(time.time() * 1000)


def _sa(A):
    return A.stapi()


def _chan(pid):
    return P.index()["videos"].get(pid, {}).get("channel")


def _stems(t):
    t = (t or "").lower().replace("ё", "е")
    return {w[:5] for w in re.findall(r"[a-zа-я0-9]{3,}", t)}


# ---------------------------------------------------------------- каталог
def catalog(A, pid):
    """Все строки, из которых можно взять готовое: [{ref, kind, name, desc, tags, img, file, audio, dim, video, videoName, src}]."""
    SA = _sa(A)
    cid = _chan(pid)
    c = SA.channel_dir(cid)
    ld = SA.lib_dir(c)
    rows, in_lib = [], set()
    for it in SA.lib_index(c):
        k = LIB2EL.get(it.get("kind"))
        if not k:
            continue
        fr = it.get("from") or {}
        if fr.get("video") and fr.get("element"):
            in_lib.add((fr["video"], fr["element"]))
        v = it.get("latest")
        row = {"ref": f"lib:{it['id']}@{v}", "kind": k, "name": it.get("name", ""), "desc": it.get("desc", ""), "tags": it.get("tags") or [],
               "dim": it.get("dim") or "2d", "video": fr.get("video", ""), "videoName": fr.get("videoName", ""), "src": "lib"}
        if it.get("preview"):
            row["img"] = f"/api/lib/file/{c['id']}/{it['preview']}"
            row["file"] = os.path.join(ld, *it["preview"].split("/"))
        if k == "sound":
            vd = os.path.join(ld, *it["id"].split("/"), f"v{v}")
            snd = sorted(f for f in os.listdir(vd) if f.lower().endswith((".wav", ".mp3", ".ogg"))) if os.path.isdir(vd) else []
            if snd:
                row["audio"] = f"/api/lib/file/{c['id']}/{it['id']}/v{v}/{snd[0]}"
        rows.append(row)
    for d in A.plans(cid):
        if d["id"] == pid or d.get("name") == "🛠 Мастерская":        # служебное видео мастерской (ws_api.WS_NAME) — не источник
            continue
        for e in d.get("elements") or []:
            if e.get("kind") not in KINDS or e.get("lib") or e.get("by") == "lib" or e.get("ws") or e.get("status") == "drop":
                continue
            if e.get("status") != "ok" and not (e["kind"] in BASE_ONLY and (e.get("stage") or {}).get("work")):
                continue                                  # локацию автор редко отмечает ✓ — берём и ту, что уже собрана в редакторе сцены
            if (d["id"], e["id"]) in in_lib:
                continue
            row = {"ref": f"el:{d['id']}/{e['id']}", "kind": e["kind"], "name": e.get("name", ""), "desc": e.get("desc", ""), "tags": [],
                   "video": d["id"], "videoName": d.get("name", ""), "src": "video"}
            if e["kind"] == "sound":
                mix = A.pr().el_mix(e)
                if not mix:
                    continue
                row["audio"] = "/" + mix[0]["s"]["file"]
            else:
                own = [x for x in e.get("own") or [] if x.get("img")]
                r = SA._render_of(e)
                if own:                                   # 📎 свой ассет автора (фото-вырезка по состояниям) — главнее черновика
                    row.update(img="/" + own[0]["img"], file=P.resolve(own[0]["img"]), own=len(own), dim="2d",
                               states=[x.get("state") for x in own if x.get("state")][:6])
                elif r:
                    row["dim"] = "3d" if r.get("three3") or r.get("three") else "2d"
                    if e["kind"] == "scene":
                        row["loc"] = bool(d.get("locations"))
                    if r.get("img"):
                        row["img"] = "/" + r["img"]
                        row["file"] = P.resolve(r["img"])
                else:
                    continue
            rows.append(row)
    return rows


def _shortlist(rows, els):
    """По виду: весь каталог, если он короткий, иначе самые похожие по словам на новые элементы этого вида."""
    out = []
    for k in KINDS:
        rk = [r for r in rows if r["kind"] == k]
        mine = [e for e in els if e.get("kind") == k]
        if not rk or not mine:
            continue
        if len(rk) > PER_KIND:
            want = set().union(*(_stems(f"{e.get('name')} {e.get('desc')}") for e in mine))
            rk.sort(key=lambda r: -len(want & _stems(f"{r['name']} {r['desc']} {' '.join(r['tags'])}")))
            rk = rk[:PER_KIND]
        out += rk
    return out


# ---------------------------------------------------------------- запуск поиска
def check(A, key, ids=None, force=False):
    """Новые элементы -> libMatch.wait + задача reuse. ids=None — все персонажи, пропсы и звуки без черновика и без решения.
    Возвращает job или None (проверять нечего / в каталоге нет ничего того же вида)."""
    d = A.load(key)
    pid = key[5:]
    els = [e for e in d.get("elements") or [] if e.get("kind") in KINDS and e.get("status") != "drop" and not e.get("lib")
           and (ids is None or e["id"] in ids)
           and not ((e.get("libMatch") or {}).get("pick"))
           and (force or not (e.get("renders") or (e.get("sounds") if e.get("kind") == "sound" else None)))]
    if not els:
        return None
    try:
        rows = catalog(A, pid)
    except ValueError:                                   # нет канала (старый режим) — проверять не в чем
        return None
    kinds = {r["kind"] for r in rows}
    els = [e for e in els if e["kind"] in kinds]
    if not els:
        return None
    t = now_ms()
    A.apply_ops(key, [{"op": "set", "path": ["elements", e["id"], "libMatch"], "value": {"state": "wait", "at": t}} for e in els])
    return A.start_job("reuse", key, "reuse:" + els[0]["id"], {"els": [e["id"] for e in els]})


def after_elements(A, key, ops):
    """После «✨ Накидать» / add-elements: id новых элементов из операций -> check()."""
    ids = [o["item"]["id"] for o in ops if o.get("op") == "add" and o.get("path") == ["elements"] and (o.get("item") or {}).get("kind") in KINDS]
    if not ids:
        return None
    try:
        return check(A, key, ids)
    except Exception as ex:                              # поиск — помощник: его сбой не должен ронять «Накидать»
        print("! reuse check:", ex)
        return None


# ---------------------------------------------------------------- задача Claude: промпт и разбор ответа
def spec(A, docs, params, sysp):
    plan = docs["plan"]
    ids = set(params.get("els") or [])
    els = [e for e in plan.get("elements") or [] if e["id"] in ids]
    if not els:
        raise ValueError("нечего проверять — элементы удалены")
    rows = _shortlist(catalog(A, plan["id"]), els)
    params["_rows"] = {r["ref"]: r for r in rows}
    KN = {"char": "персонаж", "prop": "пропс", "sound": "звук", "scene": "локация" if plan.get("locations") else "сцена", "vfx": "эффект"}
    need = "\n".join(f"- {e['id']} · {KN[e['kind']]} «{e.get('name', '')}» — {e.get('desc') or 'без описания'}" + (f" (в ролике: {e['why']})" if e.get("why") else "")
                     for e in els)
    have = "\n".join(f"- {r['ref']} · {KN[r['kind']]} «{r['name']}» — {(r['desc'] or 'без описания')[:220]}"
                     + (f" [теги: {', '.join(r['tags'][:8])}]" if r["tags"] else "") + (" [3D]" if r.get("dim") == "3d" else "")
                     + (" [локация]" if r.get("loc") else "")
                     + (f" [свой ассет автора: {r['own']} сост." + (f" — {'; '.join(r['states'])}" if r.get("states") else "") + "]" if r.get("own") else "")
                     + (f" ← из видео «{r['videoName']}»" if r.get("videoName") else "") + (f"\n  превью: {r['file'].replace(chr(92), '/')}" if r.get("file") and os.path.isfile(r["file"]) else "")
                     for r in rows)
    prompt = f"""Шаг «Уже было» препродакшена ролика «{plan.get('name', '')}». Автор не хочет рисовать заново то, что канал уже делал:
прежде чем делать новые ассеты, найди среди готовых (библиотека канала и утверждённые элементы прошлых видео) те же самые персонажи, предметы, звуки, места и эффекты.

НУЖНО ЭТОМУ ВИДЕО:
{need}

ГОТОВОЕ (ref · вид · название — описание):
{have}

Как решать:
- Совпадение — это ТОТ ЖЕ персонаж (тот же человек / герой, например Гейб Ньюэлл = Гейб Ньюэлл в другой одежде), ТОТ ЖЕ предмет или очень близкий
  (ЭЛТ-монитор ≈ «Монитор Бол-сой»), тот же звук (дверь лифта ≈ двери лифта). Только тот же вид: персонаж к персонажу, пропс к пропсу, звук к звуку.
- Не совпадение: просто та же тема или эпоха («ноутбук» ≠ «смартфон», «ёжик в пижаме» и «ёжик в кепке» — ОДИН персонаж, а вот «мама» ≠ «бабушка»).
  Разные персонажи в одинаковой одежде или позе — НЕ совпадение («Стив в пижаме» ≠ «ёжик в пижаме»); звук того же места, но другого источника — тоже нет
  (сверчок ≠ «вечерний эмбиент двора»), разные эффекты одной стихии — тоже (взрыв ≠ дым).
- Наш бумажный ёжик-герой в другом образе — совпадение с suggest base (костюм другой, герой тот же).
- Сцены и локации: совпадение — ТО ЖЕ МЕСТО или очень похожее (кабинет Гейба 2004 ≈ офис Valve нулевых, двор панелек ≈ двор панелек с лавками),
  которое быстрее подогнать, чем строить с нуля. Сцена ↔ локация — можно. Эффекты: тот же эффект (вспышка, дым, глитч, конфетти).
  Для них suggest — всегда base, а diff — что поменять под этот ролик (предметы, время суток, вывески, кто в кадре).
- Если по тексту не уверен — открой превью (Read по пути) и сравни с описанием нужного.
score: 0.9–1 — то же самое, можно брать как есть; 0.7–0.9 — то же, но нужна правка; 0.6–0.7 — похоже, можно взять за основу. Ниже 0.6 не пиши: лучше ничего, чем шум.
why — одна фраза, почему это тот же (для автора, по-русски); diff — чем готовое отличается от нужного в этом ролике (пусто, если ничем) —
это пойдёт правкой, если автор возьмёт «за основу», поэтому пиши как задание художнику («свитер вместо рубашки, без очков»).
suggest — as-is, если подходит без правок, иначе base. Не больше 3 находок на элемент, лучшие первыми. Элементы без находок просто не упоминай.
el — только id нужного элемента (первое слово его строки, без названия); ref — ровно как в списке."""
    return {"system": sysp, "prompt": prompt, "timeout": 600,
            "read": [r["file"] for r in rows if r.get("file") and os.path.isfile(r["file"])],
            "schema": {"type": "object", "additionalProperties": False, "required": ["matches"], "properties": {
                "matches": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                       "required": ["el", "ref", "score", "why", "diff", "suggest"], "properties": {
                    "el": {"type": "string"}, "ref": {"type": "string"}, "score": {"type": "number"}, "why": {"type": "string"},
                    "diff": {"type": "string"}, "suggest": {"type": "string", "enum": ["as-is", "base"]}}}}}}}


def apply(docs, params, res):
    plan, key = docs["plan"], docs["key"]
    rows = params.get("_rows") or {}
    ids = params.get("els") or []
    by = {}
    for m in res.get("matches") or []:
        m = dict(m, el=(re.match(r"\s*([A-Za-z0-9_-]+)", m.get("el") or "") or [None, ""])[1],   # Claude бывает пишет «id · название» — берём id
                 ref=(m.get("ref") or "").strip().split(" ")[0])
        r = rows.get(m.get("ref"))
        if not r or m.get("el") not in ids or float(m.get("score") or 0) < MIN_SCORE:
            continue
        e = next((x for x in plan.get("elements") or [] if x["id"] == m["el"]), None)
        if not e or e.get("kind") != r["kind"]:
            continue
        lst = by.setdefault(m["el"], [])
        if any(x["ref"] == r["ref"] for x in lst):
            continue
        lst.append({"ref": r["ref"], "score": round(float(m["score"]), 2), "why": m.get("why", ""), "diff": m.get("diff", ""),
                    "suggest": m.get("suggest") if m.get("suggest") in ("as-is", "base") and r["kind"] not in BASE_ONLY else "base",
                    **{k: r[k] for k in ("name", "desc", "img", "audio", "dim", "video", "videoName", "src", "own") if r.get(k)}})
    ops, t, n = [], now_ms(), 0
    for e in plan.get("elements") or []:
        if e["id"] not in ids or (e.get("libMatch") or {}).get("pick"):
            continue
        found = sorted(by.get(e["id"], []), key=lambda x: -x["score"])[:3]
        n += bool(found)
        ops.append({"op": "set", "path": ["elements", e["id"], "libMatch"], "value": {"state": "found" if found else "none", "found": found, "at": t}})
    res["found"] = [eid for eid in ids if by.get(eid)]
    return [(key, ops)], (f"📚 Нашлось уже сделанное: {n} из {len(ids)} — реши в окне «Нашлось в библиотеке»" if n else f"📚 В библиотеке ничего похожего ({len(ids)} проверено)")


# ---------------------------------------------------------------- удержание черновиков
def holds(A, job, d=None):
    """Задачу element / make3d / sound элемента с нерешённой находкой держим, пока автор не решит.
    Не держим: в автомонтаже (автора рядом нет) и если поиск завис (wait без живой задачи reuse)."""
    if job.kind not in ("element", "make3d", "sound", "charparts", "charmodel") or not job.key.startswith("plan:"):
        return False
    d = d or A.load(job.key)
    e = A._by_id(d.get("elements"), (job.params or {}).get("el"))
    lm = (e or {}).get("libMatch") or {}
    if not lm or lm.get("pick") or lm.get("state") not in ("wait", "found"):
        return False
    live = [j for j in A.JOBS.values() if j.key == job.key and j.status in ("running", "queued")]
    if any(j.kind == "automontage" for j in live):
        return False
    if lm["state"] == "wait":
        return any(j.kind == "reuse" and e["id"] in (j.params or {}).get("els", []) for j in live)
    return True


# ---------------------------------------------------------------- решение автора
def _publish_el(A, ref):
    """el:<видео>/<эл> -> публикация в библиотеку (как «📚 в библиотеку») -> (lid, v)."""
    vid, eid = ref[3:].split("/", 1)
    job = A.Job("libpublish", "plan:" + vid, "libpublish", {"el": eid, "as": "new"})
    _sa(A).publish(A, job)
    lib = A._by_id(A.load("plan:" + vid).get("elements"), eid).get("lib") or {}
    return lib["id"], int(lib["v"])


def _lib_ref(ref):
    m = re.match(r"^lib:([a-z]+/[a-z0-9-]+)@(\d+)$", ref or "")
    if not m:
        raise ValueError("плохая ссылка: " + str(ref))
    return m.group(1), int(m.group(2))


def _sound_into(A, key, e, lid, v, src_el=None):
    """Звук: слои (файлы, сдвиг, громкость) -> files/<видео>/sfx/ этого видео, mix элемента."""
    pid = key[5:]
    dst = os.path.join(P.files(pid), "sfx")
    os.makedirs(dst, exist_ok=True)
    items, mix = [], []
    if src_el is not None and A.pr().el_mix(src_el):
        layers = [(P.resolve(m["s"]["file"]), m["s"], m["at"], m["gain"], m.get("note", "")) for m in A.pr().el_mix(src_el)]
    else:
        c = _sa(A).channel_dir(_chan(pid))
        vd = os.path.join(_sa(A).lib_dir(c), *lid.split("/"), f"v{v}")
        lic = {}
        try:
            lic = {x.get("file"): x for x in json.load(open(os.path.join(vd, "license.json"), encoding="utf-8"))}
        except (OSError, ValueError):
            pass
        layers = [(os.path.join(vd, f), {"title": os.path.splitext(f)[0], **{k: lic.get(f, {}).get(k, "") for k in ("author", "license", "page")}}, 0.0, 1.0, "")
                  for f in sorted(os.listdir(vd)) if f.lower().endswith((".wav", ".mp3", ".ogg"))]
    for path, s, at, gain, note in layers:
        if not os.path.isfile(path):
            continue
        nf = os.path.join(dst, f"lib-{A.new_id('')}{os.path.splitext(path)[1]}")
        shutil.copy2(path, nf)
        sid = A.new_id("s")
        items.append({"id": sid, "file": A.rel_data(nf), "title": (s.get("title") or "")[:160], "author": s.get("author", ""), "license": s.get("license", ""),
                      "page": s.get("page", ""), "src": "lib", "url": f"lib:{lid}@{v}", "dur": s.get("dur"), "peak_t": s.get("peak_t"), "rms_db": s.get("rms_db"),
                      "by": "lib", "why": "из библиотеки", "ts": now_ms()})
        mix.append({"id": A.new_id("l"), "sid": sid, "at": at, "gain": gain, "note": note})
    if not items:
        raise ValueError("у звука в библиотеке нет файлов")
    return ([{"op": "add", "path": ["elements", e["id"], "sounds"], "item": it} for it in items]
            + [{"op": "set", "path": ["elements", e["id"], "mix"], "value": mix}, {"op": "set", "path": ["elements", e["id"], "sound"], "value": items[0]["id"]}])


def pick(A, key, eid, how, ref=""):
    """Решение автора по находке: as-is | base | new. -> {el, how, ref, job?}"""
    if how not in ("as-is", "base", "new"):
        raise ValueError("как: as-is | base | new")
    d = A.load(key)
    e = A._by_id(d.get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    lm = dict(e.get("libMatch") or {})
    t = now_ms()
    if how == "new":
        lm["pick"] = {"how": "new", "at": t}
        A.apply_ops(key, [{"op": "set", "path": ["elements", eid, "libMatch"], "value": lm}])
        return {"el": eid, "how": "new"}
    if not ref:
        ref = ((lm.get("found") or [{}])[0]).get("ref", "")
    hit = next((x for x in lm.get("found") or [] if x.get("ref") == ref), {})
    orig, src_el = ref, None
    if ref.startswith("el:"):
        vid, sid = ref[3:].split("/", 1)
        src_el = A._by_id(A.load("plan:" + vid).get("elements"), sid)
        if not src_el:
            raise ValueError("элемент прошлого видео пропал")
        if e["kind"] in BASE_ONLY:                       # локация / сцена / эффект: копия черновика + правка под ролик
            if how != "base":
                raise ValueError("локацию, сцену и эффект можно взять только за основу")
            return _draft_into(A, key, e, src_el, lm, orig, hit, t)
        if any(x.get("img") for x in src_el.get("own") or []):     # свой ассет автора: состояния копируются как есть (в библиотеку такие пока не публикуются)
            return _own_into(A, key, e, src_el, how, lm, orig, hit, t)
        if src_el.get("lib"):                            # уже опубликовали (другим решением) — берём ту версию
            lid, v = src_el["lib"]["id"], int(src_el["lib"]["v"])
        else:
            lid, v = _publish_el(A, ref)
        ref = f"lib:{lid}@{v}"
    else:
        lid, v = _lib_ref(ref)
    ok = "ok" if how == "as-is" else ""
    lm["pick"] = {"how": how, "ref": ref, "from": orig, "at": t}
    res = {"el": eid, "how": how, "ref": ref}
    if e["kind"] == "sound":
        if src_el is None:                               # слои со сдвигом и громкостью — из элемента, откуда опубликован звук (если он ещё есть)
            fr = (_card_ver(A, key, lid, v) or {}).get("from") or {}
            if fr.get("video") and fr.get("element"):
                try:
                    src_el = A._by_id(A.load("plan:" + fr["video"]).get("elements"), fr["element"])
                except Exception:
                    src_el = None
        ops = _sound_into(A, key, e, lid, v, src_el)
        ops += [{"op": "set", "path": ["elements", eid, k], "value": val} for k, val in
                (("lib", {"id": lid, "v": v}), ("status", ok), ("libMatch", lm))]
        A.apply_ops(key, ops)
        return res
    r = _sa(A).import_to_video(A, key, lid, v, e.get("why", ""), e.get("name", ""), into=eid, status=ok)
    lm["pick"]["rid"] = r.get("rid")
    ops = [{"op": "set", "path": ["elements", eid, "libMatch"], "value": lm}]
    if how == "base" and (hit.get("diff") or "").strip():
        ops.append({"op": "set", "path": ["elements", eid, "fx"], "value": {"main": {"notes": [{"id": A.new_id("n"), "text": hit["diff"].strip()}], "pins": [], "text": ""}}})
    A.apply_ops(key, ops)
    if how == "base":
        cur = A._by_id(A.load(key).get("elements"), eid)
        if (cur.get("renders") or [{}])[-1].get("rigchar"):
            res["note"] = "персонаж со скелетом: правь его «Поправить с Claude» в библиотеке — черновик со скелетом заново не рисуется"
        elif ((cur.get("fx") or {}).get("main") or {}).get("notes"):
            j = A.start_job("element", key, "element:" + eid, {"el": eid, "base": r.get("rid")})
            res["job"] = j.info()
    return res


def _own_into(A, key, e, src_el, how, lm, ref, hit, t):
    """📎 Свой ассет автора из прошлого видео -> копии картинок состояний в files этого видео, own[] элемента."""
    pid = key[5:]
    own = []
    for x in src_el.get("own") or []:
        if not x.get("img") or not os.path.isfile(P.resolve(x["img"])):
            continue
        img = A.save_file(pid, open(P.resolve(x["img"]), "rb").read())
        own.append({**x, "id": A.new_id("w"), "img": img})
    if not own:
        raise ValueError("картинок своего ассета не нашлось")
    lm["pick"] = {"how": how, "ref": ref, "from": ref, "at": t, "own": True}
    ops = [{"op": "set", "path": ["elements", e["id"], "own"], "value": own},
           {"op": "set", "path": ["elements", e["id"], "status"], "value": "ok" if how == "as-is" else ""},
           {"op": "set", "path": ["elements", e["id"], "libMatch"], "value": lm}]
    if how == "base" and (hit.get("diff") or "").strip():
        ops.append({"op": "set", "path": ["elements", e["id"], "fx"], "value": {"main": {"notes": [{"id": A.new_id("n"), "text": hit["diff"].strip()}], "pins": [], "text": ""}}})
    A.apply_ops(key, ops)
    res = {"el": e["id"], "how": how, "ref": ref, "own": len(own)}
    if how == "base":
        res["note"] = "свой ассет скопирован: поправь состояния сам (📎 в карточке) — Claude такие не перерисовывает"
    return res


def _draft_into(A, key, e, src_el, lm, ref, hit, t):
    """S15 ч.2: сцена / локация / эффект из прошлого видео -> копия его черновика новой версией этого элемента + задача element «подгони под ролик».
    Редактор сцены не копируется (scene.json держит ссылки на элементы ТОГО видео): после черновика сцена сама уйдёт в редактор, как новая."""
    pid, eid = key[5:], e["id"]
    cur = _sa(A)._render_of(src_el)
    has_js = lambda r: r.get("dir") and os.path.isfile(os.path.join(P.resolve("render/" + r["dir"]), "element.js"))
    # Claude правит element.js: берём текущий черновик, а если он из редактора сцены (scene.json + prefabs.js) — последний с кодом,
    # редакторскую версию даём ссылкой в правке (там расстановка автора)
    r0 = cur if cur and has_js(cur) else next((r for r in reversed(src_el.get("renders") or []) if has_js(r)), None)
    if not r0:
        raise ValueError("у сцены прошлого видео нет черновика с кодом (element.js)")
    src = P.resolve("render/" + r0["dir"])
    ed = P.resolve("render/" + cur["dir"]) if cur and cur is not r0 and cur.get("dir") else ""
    nv = max([x.get("v", 0) for x in e.get("renders") or []] + [0]) + 1
    wd = os.path.join(P.render(pid), eid, f"v{nv}")
    shutil.rmtree(wd, ignore_errors=True)
    shutil.copytree(src, wd, ignore=shutil.ignore_patterns("_*", "work"))
    img = A.save_file(pid, open(P.resolve(r0["img"]), "rb").read()) if r0.get("img") and os.path.isfile(P.resolve(r0["img"])) else ""
    rid = A.new_id("r")
    vn = (hit.get("videoName") or "прошлого видео")
    r = {"id": rid, "v": nv, "dir": f"{pid}/{eid}/v{nv}", "img": img, "extra": [], "fn": r0.get("fn", ""), "feedback": "", "reuse": ref,
         "summary": f"основа — «{src_el.get('name', '')}» из «{vn}»", "ts": now_ms(), **{k: r0[k] for k in ("three", "three3", "layout", "groups") if r0.get(k)}}
    lm["pick"] = {"how": "base", "ref": ref, "from": ref, "at": t, "rid": rid}
    note = (hit.get("diff") or "").strip() or f"Это основа из ролика «{vn}». Подгони под этот ролик: {e.get('desc') or e.get('name')}"
    if ed and os.path.isfile(os.path.join(ed, "scene.json")):
        note += (f" (В том ролике сцену потом доводили в редакторе: {ed.replace(chr(92), '/')}/scene.json и prefabs.js, кадр {P.resolve(cur['img']).replace(chr(92), '/') if cur.get('img') else '—'}"
                 " — сверь расстановку и перенеси удачное в код.)")
    A.apply_ops(key, [{"op": "add", "path": ["elements", eid, "renders"], "item": r}, {"op": "set", "path": ["elements", eid, "render"], "value": rid},
                      {"op": "set", "path": ["elements", eid, "status"], "value": ""},
                      {"op": "set", "path": ["elements", eid, "fx"], "value": {"main": {"notes": [{"id": A.new_id("n"), "text": note}], "pins": [], "text": ""}}},
                      {"op": "set", "path": ["elements", eid, "libMatch"], "value": lm}])
    j = A.start_job("element", key, "element:" + eid, {"el": eid, "base": rid})
    return {"el": eid, "how": "base", "ref": ref, "job": j.info()}


def _card_ver(A, key, lid, v):
    try:
        _, card = _sa(A)._card(_sa(A).channel_dir(_chan(key[5:])), lid)
        return next((x for x in card["versions"] if x["v"] == v), None)
    except (OSError, ValueError, KeyError):
        return None


def undo(A, key, eid):
    """Отменить решение (пока черновик не утверждён): элемент снова «ждёт решения», скопированное уходит из него."""
    e = A._by_id(A.load(key).get("elements"), eid)
    lm = dict((e or {}).get("libMatch") or {})
    if not lm.get("pick"):
        raise ValueError("решения ещё нет")
    p = lm.pop("pick")
    ops = [{"op": "set", "path": ["elements", eid, "libMatch"], "value": lm}]
    if p.get("how") != "new":
        ops += [{"op": "set", "path": ["elements", eid, k], "value": v} for k, v in (("lib", None), ("status", ""), ("fx", {}))]
        if p.get("own"):
            ops.append({"op": "set", "path": ["elements", eid, "own"], "value": []})
        elif e.get("kind") == "sound":
            ops += [{"op": "set", "path": ["elements", eid, "sounds"], "value": [s for s in e.get("sounds") or [] if s.get("by") != "lib"]},
                    {"op": "set", "path": ["elements", eid, "mix"], "value": None}, {"op": "set", "path": ["elements", eid, "sound"], "value": None}]
        else:
            ops += [{"op": "set", "path": ["elements", eid, "renders"], "value": [r for r in e.get("renders") or [] if not r.get("lib") and not r.get("reuse")]},
                    {"op": "set", "path": ["elements", eid, "render"], "value": None}]
    A.apply_ops(key, ops)
    return {"el": eid, "undone": p.get("how")}


# ---------------------------------------------------------------- HTTP, CLI
def handle_post(A, h, p, body):
    if p == "/api/lib/reuse":
        if body.get("how") == "undo":
            h._json(undo(A, body.get("key", ""), body.get("el", ""))); return True
        h._json(pick(A, body.get("key", ""), body.get("el", ""), body.get("how", ""), body.get("ref") or "")); return True
    if p == "/api/lib/reuse/check":
        j = check(A, body.get("key", ""), body.get("els") or None, force=bool(body.get("force")))
        h._json({"job": j.info() if j else None}); return True
    return False


def _studio_post(path, body):
    """Запрос к запущенной Studio: решение «за основу» ставит задачу Claude, а задача из процесса CLI умерла бы вместе с ним."""
    import urllib.request
    port = open(os.path.join(P.STATE, ".port"), encoding="utf-8").read().strip()
    rq = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                headers={"Content-Type": "application/json; charset=utf-8", "X-Ideas": "1"})
    try:
        with urllib.request.urlopen(rq, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise ValueError(json.loads(e.read() or b"{}").get("error") or str(e))


def cli(A, cmd, a):
    if cmd == "reuse":                                   # lib reuse <видео> <эл> as-is|base|new|undo [ref]
        body = {"key": "plan:" + a[0], "el": a[1], "how": a[2], "ref": a[3] if len(a) > 3 else ""}
        try:
            r = _studio_post("/api/lib/reuse", body)
        except OSError:                                  # Studio не запущена — решаем здесь (кроме «за основу»: ей нужна очередь Claude)
            if a[2] == "base":
                raise ValueError("«за основу» ставит задачу Claude — запусти Studio")
            r = undo(A, body["key"], a[1]) if a[2] == "undo" else pick(A, body["key"], a[1], a[2], body["ref"])
        print(json.dumps(r, ensure_ascii=False)); return True
    if cmd == "reuse-check":                             # lib reuse-check <видео> [эл …] — запустить поиск (задача reuse)
        j = A._cli_reuse("plan:" + a[0], ids=a[1:] or None, force=bool(a[1:]))
        print(f"📚 ищу в библиотеке и прошлых видео: задача {j}" if j else "проверять нечего (или Studio не запущена)"); return True
    if cmd == "reuse-catalog":                           # lib reuse-catalog <видео> — что видит поиск
        for r in catalog(A, a[0]):
            print(f"{r['ref']:<44} {r['kind']:<5} {r['name']}" + (f"  ← {r['videoName']}" if r.get("videoName") else ""))
        return True
    return False
