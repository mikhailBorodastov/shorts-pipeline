"""S16. «📐 По референсу» — наша история в подаче чужого шорта (docs/studio/stage16-refbase.md).

Референс подачи — refs[].role == 'base' (один на видео, refs_api.set_base). Задачи:
  refbase    (без Claude) — разбор подачи: whisper по словам, фразы, кадры с таймкодом, склейки (refvideo.base_extras -> refs[].parse.base)
  beatmap    (Opus, 🌐, Read) — карта «их бит -> наш бит» -> video.json → beatmap
  reftopics  (Opus, 🌐, Read) — «💡 Похожие темы»: ссылка на шорт -> темы для нашего канала в той же механике -> video.json → refTopics

beatmap = {ref, status: draft|ok, at, okAt, lenRef, lenOur, rhythm, summary, feedback,
           beats: [{id, t0, t1, fn, device, vo, voRu, screen, words, ot0, ot1, our: {vo, screen, note}, lock, fx: {notes: [{id, text}]}}],
           fx: {notes: [{id, text}]}}
refTopics = {ref, at, about, trick, items: [{id, title, topic, angle, why, facts, risk}]}

    python studio.py beatmap show <видео>         — карта текстом (агент сценария читает её отсюда)
    python studio.py beatmap run  <видео>         — разложить заново (Claude, ждёт конца; правки и 🔒 учитываются)
    python studio.py beatmap ok   <видео> [--off] — утвердить / снять утверждение
    python studio.py beatmap topics <видео>       — «💡 Похожие темы» по референсу подачи
"""
import json, os, re, sys, time, uuid

import paths as P

STALE_MS = 3 * 3600 * 1000
LONG = 180                   # длиннее — «длинное видео» (как в check_script.long_info)
PHRASES_INLINE = 15000       # столько фраз референса — прямо в промпт, остальное Claude дочитывает файлом
MODES = {"same": "один в один", "compress": "сжатие: длинное → шортс", "expand": "растяжение: шортс → длинное"}


def mode_of(plan, dur):
    """Режим карты: автор выбрал (beatmapMode) или по длинам референса и брифа."""
    wish = plan.get("beatmapMode")
    if wish in MODES:
        return wish
    blen = float((plan.get("brief") or {}).get("len") or 0) or dur
    if dur > LONG and blen <= LONG:
        return "compress"
    if dur <= LONG and blen > LONG:
        return "expand"
    return "same"


def _mm(t):
    t = float(t or 0)
    return f"{int(t) // 60}:{int(t) % 60:02d}"


def _read(rel, limit=20000):
    try:
        with open(P.resolve(rel), encoding="utf-8") as f:
            return f.read()[:limit]
    except (OSError, TypeError):
        return ""


def _abs(rel):
    return os.path.abspath(P.resolve(rel)).replace("\\", "/") if rel else ""


def base_ref(A, key):
    return A.rapi().base_of(A.load(key))


def ensure_parsed(A, job, rid):
    """Обычный разбор + разбор подачи прямо в задаче (если ещё нет): Claude без них не видит ни слов, ни кадров."""
    key = job.key

    def log(s):
        job.summary = s
    r = A._by_id(A.load(key).get("refs"), rid) or {}
    ps = r.get("parse") or {}
    for _ in range(360):                                   # уже разбирается другой задачей — подождать (до 30 мин)
        if not A.rapi().is_live(ps) and not A.rapi().is_live(ps.get("base") or {}):
            break
        job.summary = "жду разбор референса: " + (ps.get("msg") or "…")
        time.sleep(5)
        if job.cancelled:
            raise RuntimeError("отменено")
        r = A._by_id(A.load(key).get("refs"), rid) or {}
        ps = r.get("parse") or {}
    if ps.get("status") != "done":
        A.rapi().run(A, key, rid, log)                     # у base сам сделает и подачу
        r = A._by_id(A.load(key).get("refs"), rid) or {}
        ps = r.get("parse") or {}
    if r.get("role") == "base" and (ps.get("base") or {}).get("status") != "done":
        A.rapi().run_base(A, key, rid, log)
        r = A._by_id(A.load(key).get("refs"), rid) or {}
    return r


def ref_block(r, words=True):
    """Всё о референсе для промпта: фразы с таймкодами (или расшифровка), ритм, склейки, описание."""
    ps, bs = r.get("parse") or {}, (r.get("parse") or {}).get("base") or {}
    info = {}
    try:
        info = json.loads(_read(ps.get("info"), 8000) or "{}")
    except ValueError:
        pass
    L = [f"Референс: «{r.get('title') or ps.get('title') or ''}»" + (f" — {r.get('channel') or ps.get('channel')}" if r.get("channel") or ps.get("channel") else ""),
         f"Ссылка: {r.get('url') or r.get('path')}", f"Длина: {ps.get('dur')} с"]
    if (info.get("description") or "").strip():
        L.append("Описание ролика: " + info["description"].strip()[:1500])
    if info.get("chapters"):
        L.append("Главы референса (YouTube): " + "; ".join(f"{_mm(c.get('t'))} {c.get('title')}" for c in info["chapters"]))
    if r.get("note"):
        L.append("Что взять (автор): " + r["note"])
    if bs.get("status") == "done":
        R = bs.get("rhythm") or {}
        L.append(f"Ритм: {R.get('words')} слов, {R.get('wps')} сл/с, фраза ~{R.get('phrase')} слов, пауз > 0,6 с: {R.get('pauses')}, речь {R.get('speech')} с из {R.get('dur')} с; язык: {bs.get('lang') or '?'}")
        try:
            cuts = json.loads(_read(bs.get("shots"), 20000) or "[]")
        except ValueError:
            cuts = []
        L.append(f"Склейки ({len(cuts)}): " + ", ".join(f"{c:.1f}" for c in cuts[:80]))
        if words:
            full = _read(bs.get("phrases"), 400000)
            L.append("Фразы голоса с таймкодами (whisper по словам; «· N сл.» — длина фразы):\n" + full[:PHRASES_INLINE]
                     + (f"\n…(дальше обрезано — ДОЧИТАЙ файл целиком через Read кусками: {_abs(bs.get('phrases'))}, всего {len(full)} знаков)" if len(full) > PHRASES_INLINE else ""))
        L.append(f"Кадры с таймкодом (каждые {bs.get('step')} с, сетка 5×4, таймкод в углу кадра) — ПОСМОТРИ ИХ ВСЕ через Read и считай текст на экране:\n"
                 + "\n".join(_abs(x) for x in bs.get("sheets") or []))
    else:
        L.append("Расшифровка:\n" + _read(ps.get("transcript"), 12000))
        L.append("Кадры (сетка 6×5): " + ", ".join(_abs(x) for x in ps.get("sheets") or []))
    return "\n".join(L)


def _sheets(r):
    ps = r.get("parse") or {}
    out = [_abs(x) for x in ((ps.get("base") or {}).get("sheets") or ps.get("sheets") or [])]
    return [p for p in out if os.path.isfile(p)]


def _brief(plan):
    from ideas_claude import ctx, qa_text
    return "\n\n".join(x for x in (ctx(plan, "idea", "topic"), qa_text(plan)) if x)


def _research(plan):
    vdir = P.video(plan.get("id") or "") or ""
    try:
        return open(os.path.join(vdir, "research.md"), encoding="utf-8").read()[:8000]
    except OSError:
        return ""


def _system(A, key, mode):
    from ideas_claude import system
    return system(A._docs(key), mode)


# ---------------------------------------------------------------- карта подачи
def beatmap_prompt(A, key, r):
    plan = A.load(key)
    bm = plan.get("beatmap") or {}
    blen = int((plan.get("brief") or {}).get("len") or 0)
    dur = float((r.get("parse") or {}).get("dur") or 0)
    prev = ""
    if bm.get("beats") and bm.get("ref") == r["id"] and (bm.get("mode") or "same") == mode_of(plan, dur):   # сменили режим — раскладка с нуля
        rows = []
        for b in bm["beats"]:
            o = b.get("our") or {}
            rows.append(f"- id {b['id']} [{_mm(b.get('t0'))}–{_mm(b.get('t1'))}] {b.get('fn')}" + (" 🔒 АВТОР ПРАВИЛ — верни этот бит с тем же id, «наш бит» не меняй" if b.get("lock") else "")
                        + f"\n  наш: голос «{o.get('vo', '')}»" + (f", на экране «{o.get('screen')}»" if o.get("screen") else "") + (f", заметка: {o.get('note')}" if o.get("note") else "")
                        + "".join(f"\n  📌 правка автора: {n.get('text')}" for n in (b.get("fx") or {}).get("notes") or []))
        gen = [n.get("text") for n in (bm.get("fx") or {}).get("notes") or [] if n.get("text")]
        prev = ("Прошлая версия карты — разложи заново С УЧЁТОМ правок автора (📌 и «в целом»). Биты с 🔒 верни с тем же id — сервер оставит их как есть; "
                "у остальных тот же бит — тот же id.\n" + "\n".join(rows) + ("\nПравки «в целом»:\n" + "\n".join("- " + g for g in gen) if gen else ""))
    research = _research(plan)
    blen = blen or round(dur)
    kk = (blen / dur) if dur else 1.0
    merge = ""
    if kk < 0.75:
        merge = ("\nНаш ролик заметно короче: короткие соседние биты одной функции СЛЕЙ в один (t0 первого, t1 последнего), а второстепенный бит (повтор приёма, третий пример) "
                 "можно убрать — верни его с our.vo = '' и note «убрать: почему». Хук, поворот и кода остаются всегда.")
    elif kk > 1.35:
        merge = "\nНаш ролик заметно длиннее: фразы те же по длине, а в бит можно добавить вторую фразу того же приёма."
    k = (blen / dur) if dur else 1.0
    mode = mode_of(plan, dur)
    wps = ((r.get("parse") or {}).get("base") or {}).get("rhythm", {}).get("wps") or 2.65
    long_our = blen > LONG
    if mode == "compress":
        how = f"""РЕЖИМ: СЖАТИЕ — референс длинный ({_mm(dur)}), наш ролик — шортс на {blen} с. Режем НЕ подряд: собери ФОРМУЛУ всего ролика — его хук, фирменные приёмы и обороты,
ход мысли (как он ведёт зрителя от вопроса к ответу), повороты, коду — и выстрой из них наш шортс на 6–14 битов. Порядок битов — НАШ, по ходу шортса; хук — от хука референса, кода — от его коды.
У каждого бита t0, t1 — откуда в референсе взят приём (любое место ролика), fn / device / vo / screen — что там; chapter = ''."""
        cut = "2. Посмотри ролик целиком (листы кадров, все фразы) и выбери 6–14 моментов-приёмов, из которых соберётся шортс. Для каждого:"
    elif mode == "expand":
        how = f"""РЕЖИМ: РАСТЯЖЕНИЕ — референс шортс ({_mm(dur)}), наш ролик длинный ({_mm(blen)}). Каждый бит шортса — ГЛАВА нашего ролика: хук шортса → холодное открытие и обещание
(первые 30–45 с, chapter = ''), его кода → финал с рифмой на открытие. Внутри главы — 3–8 наших битов, которые повторяют приём этого бита шортса (свой мини-хук, свой поворот, своя добивка, те же связки).
chapter — название НАШЕЙ главы; t0, t1 — бит шортса, из которого глава; fn / device / vo / screen — этого бита шортса (у всех битов главы одинаковые — нормально).
Длинный ролик держится на перехватах каждые 60–90 с и повороте в середине (_studio/prompts/longform.md)."""
        cut = "2. Разрежь шортс на биты по смыслу (по фразам и склейкам), каждый бит — глава; внутри глав напиши наши биты. Для каждого НАШЕГО бита:"
    else:
        how = ("РЕЖИМ: ОДИН В ОДИН — те же биты в том же порядке и в тех же долях времени." + (f"""
Ролик длинный: сгруппируй биты в главы — chapter = название НАШЕЙ главы (3–7 глав по 1,5–3 мин; есть главы у референса — по ним, иначе по смене темы),
открытие до первой главы — chapter = ''. Бит — примерно 15–40 с референса.""" if long_our or dur > LONG else " chapter = ''."))
        cut = f"2. Разрежь референс на биты по смыслу ({'примерно 1 бит на 15–40 с' if dur > LONG else 'обычно 6–14 на 30–60 с'}; по границам фраз и склеек). Для каждого бита:"
    return f"""Шаг «📐 Карта подачи» (S16). Автор хочет рассказать НАШУ тему в подаче референса — «переложить на рельсы»: те же приёмы, та же длина фраз и те же связки;
слова — про нашу тему, но по подаче близко к оригиналу. Картинку и монтаж НЕ переносим — только голос и текст на экране.
Если подача референса спорит со стайл-гайдом канала (CTA, мораль, другой темп) — главнее референс, полностью.

{how}

{ref_block(r)}

НАША ТЕМА (бриф, ответы автора — его решения):
{_brief(plan)}
{('Ресерч видео (research.md):' + chr(10) + research) if research else ''}
Длина нашего ролика по брифу: {blen} с ({_mm(blen)}), у референса {dur:.0f} с ({_mm(dur)}).
odur — сколько секунд бит идёт У НАС; сумма odur ≈ {blen} с.{' В режиме «один в один» odur ≈ (t1 − t0) × ' + f'{k:.2f}' + ' — доли битов как у референса.' if mode == 'same' else ''}
БЮДЖЕТ СЛОВ бита = odur × {wps} сл/с (темп референса), ±20 %. Сервер сам посчитает наши таймкоды по odur.{merge if mode == 'same' else ''}

{prev}

Что сделать:
1. Посмотри ВСЕ листы кадров (Read) и прочитай фразы целиком. Текст на экране (заголовки, подписи, «жди концовку», стрелки со словами) — тоже подача: перенеси его в screen.
{cut}
   t0, t1 — секунды референса; chapter — глава (см. режим); odur — секунды у нас; fn — функция бита (хук-вопрос, ложная догадка, причина 1, поворот, кода, призыв…); device — приём (как сделано: обращение на «вы» + число, перечисление по убыванию длины, пауза перед поворотом…);
   vo — как сказано (дословно, язык оригинала; нет голоса — ''); voRu — перевод на русский, если язык не русский (иначе ''); screen — текст на экране в этом бите ('' если нет); words — слов в vo.
3. summary — в чём фишка подачи, 1–2 фразы до 300 знаков, без слов «Фишка подачи» (что зритель чувствует и почему досматривает).
4. our — НАШ бит на этом месте: тот же приём и функция, слов — по бюджету (odur × темп), длина отдельной фразы — как у них, те же связки и обороты («Но есть нюанс» остаётся «Но есть нюанс»), по-русски;
   screen — наш текст на экране там, где он был у референса (тот же тип: если у них «WAIT FOR IT», у нас аналог); note — источник факта («research [2]», ссылка) или пояснение.
   Числа, имена, факты — ТОЛЬКО наши: из брифа, ответов автора, ресерча или проверенные тобой поиском (WebSearch) — со ссылкой в note. Факты референса к нам не переносятся.
   Бит, которому в нашей теме нечего поставить, — our.vo = '', note = «нет пары: … Вариант: …» (автор решит).
5. id — у бита из прошлой версии — его id, у нового — ''."""


BEAT = {"type": "object", "properties": {
    "id": {"type": "string"}, "t0": {"type": "number"}, "t1": {"type": "number"}, "fn": {"type": "string"}, "device": {"type": "string"},
    "vo": {"type": "string"}, "voRu": {"type": "string"}, "screen": {"type": "string"}, "words": {"type": "integer"},
    "chapter": {"type": "string"}, "odur": {"type": "number"},
    "our": {"type": "object", "properties": {"vo": {"type": "string"}, "screen": {"type": "string"}, "note": {"type": "string"}}, "required": ["vo", "screen", "note"]}},
    "required": ["t0", "t1", "fn", "device", "vo", "screen", "odur", "our"]}
BEATMAP_SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}, "beats": {"type": "array", "items": BEAT}}, "required": ["summary", "beats"]}


def beatmap(A, job):
    key = job.key
    r = base_ref(A, key)
    if not r:
        raise ValueError("нет референса подачи — отметь «📐 За основу» у видео-референса в брифе")
    r = ensure_parsed(A, job, r["id"])
    plan0 = A.load(key)
    dur0 = float((r.get("parse") or {}).get("dur") or 0)
    blen0 = float((plan0.get("brief") or {}).get("len") or 0) or dur0
    mode = mode_of(plan0, dur0)
    job.summary = f"Claude раскладывает референс на биты ({MODES[mode]})…"
    spec = {"system": _system(A, key, plan0.get("mode") or "short"), "prompt": beatmap_prompt(A, key, r), "schema": BEATMAP_SCHEMA,
            "web": True, "read": _sheets(r), "model": A.VISUAL_MODEL, "timeout": 2400 if max(dur0, blen0) > LONG else 1200}
    res = A.run_claude(job, spec) or {}
    plan = A.load(key)
    old = plan.get("beatmap") or {}
    old_by = {b["id"]: b for b in old.get("beats") or []} if old.get("ref") == r["id"] and (old.get("mode") or "same") == mode else {}
    ps = r.get("parse") or {}
    dur = float(ps.get("dur") or 0) or max([b.get("t1") or 0 for b in res.get("beats") or []] + [1])
    blen = float((plan.get("brief") or {}).get("len") or 0) or dur
    k = blen / dur if dur else 1
    R = (ps.get("base") or {}).get("rhythm") or {}
    wps = R.get("wps") or 2.65
    beats, at = [], 0.0
    src = res.get("beats") or []
    if mode == "same":                                       # один в один — порядок референса
        src = sorted(src, key=lambda x: x.get("t0") or 0)
    for b in src:
        prev = old_by.get(b.get("id") or "")
        nb = {"id": prev["id"] if prev else "b" + uuid.uuid4().hex[:6], "t0": round(float(b.get("t0") or 0), 1), "t1": round(float(b.get("t1") or 0), 1),
              "fn": b.get("fn", ""), "device": b.get("device", ""), "vo": b.get("vo", ""), "voRu": b.get("voRu", ""), "screen": b.get("screen", ""),
              "words": int(b.get("words") or len((b.get("vo") or "").split())), "our": b.get("our") or {"vo": "", "screen": "", "note": ""}, "fx": {"notes": []}}
        if prev and prev.get("lock"):
            nb["our"], nb["lock"] = prev.get("our") or nb["our"], True
        nb["chapter"] = (b.get("chapter") or "").strip()
        od = float(b.get("odur") or 0) or (nb["t1"] - nb["t0"]) * k
        nb["ot0"], nb["ot1"] = round(at, 1), round(at + od, 1)   # наши таймкоды — подряд по odur (в сжатии и растяжении порядок наш, не референса)
        at += od
        nb["target"] = max(1, round(od * wps))                  # бюджет слов нашего бита: его секунды × темп референса
        beats.append(nb)
    sent = [n.get("text") for b in old.get("beats") or [] for n in (b.get("fx") or {}).get("notes") or []] + [n.get("text") for n in (old.get("fx") or {}).get("notes") or []]
    if at and blen and abs(at - blen) > blen * 0.05:          # сумма odur ушла от брифа — подровнять пропорционально
        f = blen / at
        for nb in beats:
            nb["ot0"], nb["ot1"] = round(nb["ot0"] * f, 1), round(nb["ot1"] * f, 1)
            nb["target"] = max(1, round((nb["ot1"] - nb["ot0"]) * wps))
    new = {"ref": r["id"], "mode": mode, "status": "draft", "at": A.now_ms(), "lenRef": round(dur, 1), "lenOur": round(blen, 1), "rhythm": R, "summary": res.get("summary", ""),
           "beats": beats, "fx": {"notes": []}, "feedback": [t for t in sent if t], "v": int(old.get("v") or 0) + 1}
    A.rapi().alive(key)
    A.apply_ops(key, [{"op": "set", "path": ["beatmap"], "value": new}])
    miss = sum(1 for b in beats if not (b["our"].get("vo") or b["our"].get("screen")))
    nch = len({b["chapter"] for b in beats if b["chapter"]})
    job.summary = f"Карта подачи v{new['v']} ({MODES[mode]}): {len(beats)} бит(ов)" + (f", глав {nch}" if nch else "") + (f", без пары: {miss}" if miss else "") + (f" · учтено правок: {len(new['feedback'])}" if new["feedback"] else "")


def beatmap_text(plan):
    """Карта для агента сценария и CLI."""
    bm = plan.get("beatmap") or {}
    if not bm.get("beats"):
        return "Карты подачи нет."
    r = next((x for x in plan.get("refs") or [] if x.get("id") == bm.get("ref")), {}) or {}
    R = bm.get("rhythm") or {}
    L = [f"# Карта подачи v{bm.get('v', 1)} — {'✅ утверждена автором' if bm.get('status') == 'ok' else 'черновик (не утверждена)'}",
         f"Референс: «{r.get('title', '')}» {r.get('url') or r.get('path') or ''}",
         f"Режим: {MODES.get(bm.get('mode') or 'same')}. Длина: референс {_mm(bm.get('lenRef'))} → наш {_mm(bm.get('lenOur'))}. Ритм референса: {R.get('wps')} сл/с, фраза ~{R.get('phrase')} слов, пауз {R.get('pauses')}.",
         f"Фишка подачи: {bm.get('summary', '')}", ""]
    ch = None
    for i, b in enumerate(bm["beats"], 1):
        o = b.get("our") or {}
        if (b.get("chapter") or "") != ch:
            ch = b.get("chapter") or ""
            L.append(f"# ГЛАВА: {ch}" if ch else "# (открытие / без главы)")
        L.append(f"## Бит {i} · референс {_mm(b.get('t0'))}–{_mm(b.get('t1'))} → наш {_mm(b.get('ot0'))}–{_mm(b.get('ot1'))} · {b.get('fn')}" + (" 🔒" if b.get("lock") else ""))
        L.append(f"приём: {b.get('device')}")
        L.append(f"у них: «{b.get('vo')}»" + (f" (перевод: «{b.get('voRu')}»)" if b.get("voRu") else "") + f" · {b.get('words') or 0} сл." + (f" · на экране: «{b.get('screen')}»" if b.get("screen") else ""))
        L.append(f"НАШ: голос «{o.get('vo', '')}» · {len((o.get('vo') or '').split())} сл. (бюджет {b.get('target') or b.get('words') or 0})" + (f" · на экране: «{o.get('screen')}»" if o.get("screen") else "") + (f" · {o.get('note')}" if o.get("note") else ""))
        L.append("")
    return "\n".join(L)


def agent_block(plan):
    """Добавка к режиму «📝 Сценарий» агента, если карта утверждена."""
    bm = plan.get("beatmap") or {}
    if bm.get("status") != "ok" or not bm.get("beats"):
        return ""
    r = next((x for x in plan.get("refs") or [] if x.get("id") == bm.get("ref")), {}) or {}
    R = bm.get("rhythm") or {}
    rate = ""
    if R.get("wps"):
        rate = f"+{max(0, min(45, round((R['wps'] / 2.2 - 1) * 100)))}%"
    return f"""
- 📐 ПО РЕФЕРЕНСУ (S16) — главнее всего остального про подачу: автор утвердил карту подачи (beatmap show {plan.get('id')} — прочитай её ЦЕЛИКОМ перед сценарием).
  Сценарий пишется ПО КАРТЕ: одна сцена на бит, в том же порядке (короткие соседние биты можно слить в одну сцену, но не переставлять), таймкоды сцен — «наш» из карты.
  Есть главы в карте («# ГЛАВА: …») — перед первой сценой главы строка «## Глава N. <название из карты>» (длинный формат, _studio/prompts/longform.md); биты без главы — открытие до первой главы.
  **VO** — «НАШ голос» бита: можно только довести до звучания (ударения, произносимость), смысл, приём и длину фразы не менять; **Текст:** — «НАШ на экране» бита (если есть);
  **Картинку** придумываешь сам — в стиле канала и элементами препродакшена (монтаж референса не переносим). Бит без пары — реши по заметке, а в ответе скажи как.
  Шапка script.md: строка «по референсу: {r.get('url') or r.get('path') or ''}» и rate под темп референса ({R.get('wps')} сл/с; начни с rate: {rate or '+25%'} и проверь по montage tts).
  Стайл-гайд канала — только там, где референс ничего не диктует: CTA, мораль, другой темп из референса ОСТАЮТСЯ. montage check в режиме «по референсу» сверяет сценарий с картой — его ❌ исправь.
  В конце ответа вместо «референс → что взял → сцена» — таблица «бит референса → сцена»."""


def export(A, vid):
    """Карта -> <проект>/refs/beatmap.json (её читает check_script.py); старый check_script.py без сверки с картой — свежий из шаблона."""
    vdir = P.video(vid)
    plan = A.load("plan:" + vid)
    if not vdir or not os.path.isfile(os.path.join(vdir, "build.sh")) or not (plan.get("beatmap") or {}).get("beats"):
        return False
    os.makedirs(os.path.join(vdir, "refs"), exist_ok=True)
    with open(os.path.join(vdir, "refs", "beatmap.json"), "w", encoding="utf-8") as f:
        json.dump(plan["beatmap"], f, ensure_ascii=False, indent=1)
    dst = os.path.join(vdir, "check_script.py")
    try:
        mark = re.search(r"BEATMAP_CHECK = \d+", open(os.path.join(P.TEMPLATE, "check_script.py"), encoding="utf-8").read())
        if mark and mark.group(0) not in open(dst, encoding="utf-8").read():
            import shutil
            shutil.copy2(os.path.join(P.TEMPLATE, "check_script.py"), dst)
    except OSError:
        pass
    return True


def set_ok(A, key, on=True):
    bm = A.load(key).get("beatmap") or {}
    if not bm.get("beats"):
        raise ValueError("карты подачи нет — сначала beatmap run")
    A.apply_ops(key, [{"op": "set", "path": ["beatmap", "status"], "value": "ok" if on else "draft"},
                      {"op": "set", "path": ["beatmap", "okAt"], "value": A.now_ms() if on else None}])
    export(A, key[5:])


# ---------------------------------------------------------------- 💡 похожие темы
TOPICS_SCHEMA = {"type": "object", "properties": {
    "about": {"type": "string"}, "trick": {"type": "string"}, "label": {"type": "string"},
    "items": {"type": "array", "items": {"type": "object", "properties": {
        "title": {"type": "string"}, "topic": {"type": "string"}, "angle": {"type": "string"}, "why": {"type": "string"},
        "facts": {"type": "string"}, "risk": {"type": "string"}}, "required": ["title", "topic", "angle", "why", "facts"]}}},
    "required": ["about", "trick", "label", "items"]}


def topics_prompt(A, key, r, n, hint):
    plan = A.load(key)
    old = [t.get("title") for t in (plan.get("refTopics") or {}).get("items") or []]
    return f"""Шаг «💡 Похожие темы» (S16). Автору понравился этот шорт — его подача и его тема. Он хочет сделать похожий ролик для НАШЕГО канала: не копию и не плагиат,
а свою тему, которая «стреляет» по тому же механизму. Подачу (структуру и приёмы) мы потом возьмём у референса один в один, поэтому тема должна в неё ложиться.

{ref_block(r, words=True)}

Что сделать:
1. about — о чём референс, 1–2 фразы до 250 знаков (по-русски). trick — почему он работает, до 450 знаков: какой триггер у зрителя (любопытство, «я тоже так делаю», возмущение, ностальгия…) и какая механика подачи.
label — имя этого ресерча для списка видео, 2–5 слов по-русски, по запросу автора и референсу (например «Гаджеты-шпионы в детской» или «Игры, которые нельзя пройти»).
2. items — {n} тем для НАШЕГО канала (его профиль и стиль — в системном промпте): тот же триггер и та же механика, но другой предмет. Совсем разные по углу, а не перефразы одной.
   Смелые и неожиданные приветствуются, но каждая — реальная: факт, на котором она стоит, проверь поиском (WebSearch) и дай ссылку.
   КОРОТКО — это карточки выбора: title — рабочее название (до ~50 знаков); topic — о чём ролик, до 220 знаков, с конкретикой (имена, годы, цифры);
   angle — до 200 знаков: что будет хуком, что — поворотом; why — одна фраза; facts — 1–2 ссылки на источники (только ссылки и 3–5 слов к каждой); risk — одна фраза или ''.
   Не повторяй тему самого референса (это плагиат) и темы, которые уже предлагались: {', '.join(x for x in old if x) or '—'}.
{('Пожелание автора: ' + hint) if hint else ''}"""


def reftopics(A, job):
    key, p = job.key, job.params or {}
    rid = p.get("ref") or (base_ref(A, key) or {}).get("id")
    if not rid:
        raise ValueError("нет референса — вставь ссылку на шорт")
    r = ensure_parsed(A, job, rid)
    job.summary = "Claude ищет похожие темы…"
    res = A.run_claude(job, {"system": _system(A, key, A.load(key).get("mode") or "short"), "prompt": topics_prompt(A, key, r, int(p.get("n") or 6), (p.get("hint") or "").strip()),
                             "schema": TOPICS_SCHEMA, "web": True, "read": _sheets(r), "model": A.VISUAL_MODEL, "timeout": 900}) or {}
    old = (A.load(key).get("refTopics") or {}).get("items") or [] if (A.load(key).get("refTopics") or {}).get("ref") == rid else []
    items = [{"id": "t" + uuid.uuid4().hex[:6], **{k: (t.get(k) or "") for k in ("title", "topic", "angle", "why", "facts", "risk")}} for t in res.get("items") or []]
    A.rapi().alive(key)
    A.apply_ops(key, [{"op": "set", "path": ["refTopics"], "value": {"ref": rid, "at": A.now_ms(), "about": res.get("about", ""), "trick": res.get("trick", ""),
                                                                     "items": items + [t for t in old if t.get("pick")]}}])
    label = (res.get("label") or "").strip()[:60]
    name = (A.load(key).get("name") or "").strip()
    if label and (not name or name.startswith("Ресерч")):    # имя черновика ресерча автор не трогал — осмысленное от Claude
        A.apply_ops(key, [{"op": "set", "path": ["name"], "value": "Ресерч: " + label}])
    job.summary = f"Похожих тем: {len(items)}"


# ---------------------------------------------------------------- задачи, HTTP, CLI
def run_job(A, job):
    if job.kind == "refbase":
        r = A._by_id(A.load(job.key).get("refs"), (job.params or {}).get("ref")) or {}
        if not r:
            raise ValueError("референс не найден")
        ensure_parsed(A, job, r["id"])
        R = (((A._by_id(A.load(job.key).get("refs"), r["id"]) or {}).get("parse") or {}).get("base") or {}).get("rhythm") or {}
        job.summary = f"Подача разобрана: {R.get('words', 0)} слов, {R.get('wps', 0)} сл/с"
    elif job.kind == "beatmap":
        beatmap(A, job)
    elif job.kind == "reftopics":
        reftopics(A, job)


def handle_post(A, h, p, body):
    if p == "/api/refs/base":                              # 📐 За основу / снять
        h._json({"msg": A.rapi().set_base(A, body.get("key", ""), body.get("ref", ""), bool(body.get("on", True)))})
        return True
    if p == "/api/beatmap/ok":
        set_ok(A, body.get("key", ""), bool(body.get("on", True)))
        h._json({"ok": True})
        return True
    return False


def cli(A, argv):
    sub, a = (argv[0] if argv else "show"), argv[1:]
    if not a:
        sys.exit(__doc__)
    key = A._plan_key(a[0])
    if sub == "show":
        print(beatmap_text(A.load(key)))
        return True
    if sub in ("run", "topics"):
        job = A.Job("beatmap" if sub == "run" else "reftopics", key, sub, {})
        (beatmap if sub == "run" else reftopics)(A, job)
        print(job.summary)
        if sub == "run":
            print(beatmap_text(A.load(key)))
        else:
            for t in (A.load(key).get("refTopics") or {}).get("items") or []:
                print(f"- {t['title']} — {t['topic']}\n  механика: {t['angle']}")
        return True
    if sub == "ok":
        set_ok(A, key, "--off" not in a)
        print("снято" if "--off" in a else "✅ карта утверждена")
        return True
    sys.exit(__doc__)
