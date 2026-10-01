"""Промпты и схемы для кнопок ✨ «Штурма идей» (claude -p на подписке, без API-ключей; запускает ideas_api.run_claude).

build(action, docs, params) -> {system, prompt, schema, web, read}
apply(action, docs, params, result) -> ([(key, ops)], summary)
docs = {"plan": штурм или None, "brand", "bank", "stats", "key", "data"}. ideas_api перезагружает модуль на лету.
Методика — «Мастер-планер» (пересказ), подача шортсов — prompts/style-guide.md.
"""
import json, os, re, shutil, subprocess, sys, time, uuid
import paths as P  # где что лежит (Claude Studio)
import preprod  # модель элементов препродакшена: @-ссылки, состав сцен, слои звука

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(P.WEB, "ref.json"), encoding="utf-8") as _f:
    REF = json.load(_f)

BRAND = [("name", "Канал"), ("bring", "О канале"), ("differ", "Чем отличаемся от конкурентов"),
         ("killer", "Стайл-гайд (начало)"), ("never", "Чего не делаем никогда")]
MODE = {
    "short": ("вертикальный шортс на 55–90 секунд (≈150–200 слов закадра), рисованная бумажная анимация, за кадром — голос рассказчика. "
              "Одна сюжетная линия. Первая фраза цепляет сразу, без приветствий. Смена мысли или события каждые 5–10 секунд. "
              "Финал перекликается с началом. Без призывов подписаться и без морали. "
              "В ленте шортсов зритель сразу видит первый кадр — он работает как превью."),
    "long": ("горизонтальное видео на 8–15 минут (16:9). 30–40 битов, структура — три акта (15 точек) или инструкция по шагам. "
             "Открывающий образ удерживает зрителя в первые 30 секунд, кульминация и завершающий образ ведут к следующему ролику. "
             "Название и превью 16:9 решают, кликнут ли в ролик вообще."),
}


GENRE = {
    "news": ("Новость: реальные факты с источниками. Хук — шок-факт или «карточка дела» с именем, годом или цифрой, без вопроса. "
             "Повороты через «Но», цифры с бытовым сравнением, сухая ироничная кода. Антиутопию вслух не проговариваем — она в коде."),
    "history": ("Реальная история из прошлого: факты с источниками, но подаются как рассказ — герои, место, время. Хук — итог вперёд "
                "или «карточка дела» (год + кто + что сделал). Хронология по нарастанию странности, поворот, развязка, кода «кстати / до сих пор»."),
    "story": ("Сюжетная выдуманная история: герой — бумажный ёжик, рассказчик ведёт её за кадром. Фактов и цифр не нужно; реальный мир "
              "присутствует только как узнаваемые детали (эпоха, места, предметы, звуки, надписи) — они дают зрителю «я там был». "
              "Держит не информация, а ожидание: что будет дальше и чем кончится. Хук — герой уже в странной ситуации или обещание беды. "
              "Каждое событие обостряет ситуацию, эскалация к кульминации, финал — поворот или рифма с началом (можно открытый). "
              "Тон — хоррор, комедия, сказка или мистика — задают вводные."),
}


GENRE["auto"] = ("Жанр определи сам по идее, контексту и ответам автора: новость (реальные факты с источниками, хук — шок-факт, повороты через «Но», "
                 "сухая кода), реальная история из прошлого (факты, но рассказом: герои, место, время) или выдуманный сюжет (держит ожидание, эскалация, "
                 "финал — поворот или рифма с началом). Держи выбранный жанр во всём.")


def genre_of(plan):
    """Old brainstorms had a genre field; a video of Claude Studio has none — Claude infers it («auto»)."""
    if (plan or {}).get("flow") == "idea" and not (plan or {}).get("genre"):
        return "auto"
    g = (plan or {}).get("genre") or "news"
    return g if g in GENRE else "news"


def nid(prefix):
    return prefix + uuid.uuid4().hex[:8]


def S(props, req=None):
    """Tiny JSON-schema helper: object with properties, all required unless listed."""
    return {"type": "object", "properties": props, "required": req if req is not None else list(props)}


STR = {"type": "string"}
ARR = lambda item: {"type": "array", "items": item}


def mode_of(docs, params=None):
    p = docs.get("plan")
    m = (p or {}).get("mode") or (params or {}).get("mode") or "short"
    return m if m in MODE else "short"


def system(docs, mode, genre="news"):
    b = docs["brand"]
    brand = "\n".join(f"- {label}: {b[k].strip()}" for k, label in BRAND if (b.get(k) or "").strip())
    return f"""Ты — соавтор YouTube-канала в Claude Studio: вместе с автором проходишь путь видео — идея, вопросы, название, препродакшен, сцены, сценарий, голос, монтаж, упаковка.
Сначала понять ролик и собрать всё, из чего он состоит, и только потом писать сценарий.

Канал (о канале и начало его стайл-гайда):
{brand or '- (канал ещё не описан)'}

Формат ролика: {MODE[mode]}

Жанр: {GENRE[genre]}

Как работать:
- Пиши по-русски, живо и конкретно: узнаваемые вещи и детали (в новостях и реальных историях — ещё имена, годы, цифры). Без канцелярита и общих слов.
- Правило трёх: варианты должны быть совсем разными по углу, а не перефразами одного.
- Плохих идей нет: смелые и странные варианты приветствуются. Спрашивай себя «как было бы прикольно?», а не «как правильно?».
- Факты не выдумывай. Факт, которого нет во вводных и который ты не нашёл в источнике, помечай «проверить».
- Отвечай строго JSON по заданной схеме."""


# ---------------- context blocks ----------------
def is_idea(plan):
    return (plan or {}).get("flow") == "idea"


def idea_of(plan):
    if is_idea(plan):
        t = (plan.get("idea") or "").strip()
        return {"id": "", "text": t} if t else None
    return next((i for i in plan.get("ideas", []) if i["id"] == plan.get("chosen")), None)


QGROUPS = {"story": "сюжет", "hero": "герои", "world": "мир и детали", "tone": "тон", "facts": "факты", "pack": "упаковка", "challenge": "челлендж"}
KINDS = {"char": "персонаж", "prop": "пропс", "scene": "сцена", "sound": "звук"}   # scenes after the characters and props that stand in them


def refs_text(plan, limit=6000):
    """Reference videos / links / pictures of the author as text (transcripts are cut to fit)."""
    rows, left = [], limit
    for r in plan.get("refs") or []:
        ps = r.get("parse") or {}
        if r.get("kind") == "image":
            rows.append("- картинка-референс" + (f": {r['note']}" if r.get("note") else ""))
            continue
        head = f"- {'видео' if r.get('kind') == 'video' else 'ссылка'} «{r.get('title') or ps.get('title') or ''}» {r.get('url') or r.get('path') or ''}".rstrip()
        rows.append(head + (f"\n  Что взять из него (автор): {r['note']}" if r.get("note") else ""))
        if ps.get("status") == "done":
            tx = (ps.get("text") or "").strip()
            cut = tx[:max(0, left)]
            left -= len(cut)
            rows.append(f"  Длина {ps.get('dur')} с, кадры сеткой 6×5 через каждые {ps.get('step')} с." + (f"\n  Расшифровка:\n{cut}" + (" …(дальше обрезано)" if len(cut) < len(tx) else "") if cut else ""))
    return "Референсы автора:\n" + "\n".join(rows) if rows else ""


def refs_files(plan, data):
    """Pictures Claude may Read: contact sheets of reference videos and reference images."""
    out = []
    for r in plan.get("refs") or []:
        for rel in ([r["img"]] if r.get("img") else []) + list((r.get("parse") or {}).get("sheets") or []):
            p = os.path.abspath(P.resolve(rel))
            if os.path.isfile(p):
                out.append(p)
    return out


def qa_text(plan, all_=False):
    qs = plan.get("qa") or []
    rows = [f"- В: {q.get('q', '').strip()}\n  О: {(q.get('a') or '').strip() or ('(пропущен — не важно)' if q.get('skip') else '(без ответа)')}"
            for q in qs if all_ or (q.get("a") or "").strip()]
    return ("Вопросы и ответы автора (его ответы — решения, следуй им):\n" + "\n".join(rows)) if rows else ""


TEMPLATE_SCRIPT = "# Зачем ежу иголки"                     # заглушка шаблона проекта: сценарий ещё не писали


def script_of(plan):
    """S11: сценарий проекта (script.md), если он уже написан — препродакшен строится по нему."""
    vdir = P.video(plan.get("id") or "") or ""
    try:
        t = open(os.path.join(vdir, "script.md"), encoding="utf-8").read()
    except OSError:
        return ""
    if not t.strip() or t.lstrip().startswith(TEMPLATE_SCRIPT):
        return ""
    return re.sub(r"<!--.*?-->", "", t, flags=re.S).strip()[:9000]


def elements_text(plan):
    els = [e for e in plan.get("elements") or [] if e.get("status") != "drop"]
    if not els:
        return ""
    return "Препродакшен (элементы ролика):\n" + "\n".join(
        f"- [{KINDS.get(e.get('kind'), e.get('kind'))}] {e.get('name', '')}" + (f" — {e['desc']}" if e.get("desc") else "") for e in els)


def ctx(plan, *parts):
    out = []
    for part in parts:
        if part == "topic":
            out.append(("Контекст от автора:\n" if is_idea(plan) else "Вводные:\n") + ((plan.get("topic") or "").strip() or "(не заданы)"))
        elif part == "idea":
            i = idea_of(plan)
            out.append(("Идея автора: " if is_idea(plan) else "Выбранная идея: ") + (i["text"] if i else "(ещё не выбрана — опирайся на вводные)"))
        elif part == "refs":
            t = refs_text(plan)
            if t:
                out.append(t)
        elif part == "qa":
            t = qa_text(plan)
            if t:
                out.append(t)
        elif part == "elements":
            t = elements_text(plan)
            if t:
                out.append(t)
        elif part == "q7":
            q7 = plan.get("q7") or {}
            rows = [f"- {q['label']} {q7[q['key']].strip()}" for q in REF["q7"] if (q7.get(q["key"]) or "").strip()]
            if rows:
                out.append("Ответы на 7 вопросов:\n" + "\n".join(rows))
        elif part == "beats":
            bs = [b for b in plan.get("beats", []) if b.get("keep", True)]
            if bs:
                out.append("Биты (вопрос → ответ):\n" + "\n".join(f"- [{b['id']}] {b.get('q', '')} → {b.get('a', '')}" for b in bs))
        elif part == "meanings":
            ms = plan.get("meanings", [])
            if ms:
                g = lambda mk: ", ".join(m["text"] for m in ms if (m.get("mark") or "") == mk) or "—"
                out.append(f"Смыслы. Без этого никак: {g('must')}. Остальные: {g('')}. Вычеркнуты (не использовать): {g('cut')}.")
    return "\n\n".join(out)


def words_block():
    return "\n".join(f"- {w['key']}: {w['label']} ({w['hint']})" for w in REF["words"])


def types_block():
    out = []
    for z in REF["thumbZones"]:
        out.append(f"{z['label']} ({z['sub']}):")
        out += [f"  - {k}: {REF['thumbTypes'][k]['label']} — {REF['thumbTypes'][k]['desc']}" for k in z["types"]]
    return "\n".join(out)


def slots_of(plan):
    st = plan.get("structure") or {}
    if plan.get("mode") != "long":
        sch = REF["schemes"].get(st.get("scheme") or "V", REF["schemes"]["V"])
        return sch["label"], [{"key": b["key"], "label": f"{b['label']} ({b['t']})", "hint": b["hint"]} for b in sch["blocks"]]
    if st.get("scheme") == "steps":
        fixed = REF["steps"]
        rows = [s for s in fixed if not s.get("end")] + [{"key": s["id"], "label": s.get("text") or "Шаг", "hint": ""} for s in st.get("steps", [])] \
            + [s for s in fixed if s.get("end")]
        return "инструкции по шагам", rows
    return "трёхактной структуре (15 точек)", REF["acts"]


def norm(s):
    return " ".join((s or "").lower().replace("ё", "е").split())


# ---------------- actions ----------------
def build(action, docs, params):
    plan = docs.get("plan")
    mode = mode_of(docs, params)
    genre = genre_of(plan)
    sysp = system(docs, mode, genre)
    web = False
    read = []
    tmax = REF["modes"][mode]["titleMax"]

    if action == "ideas":
        n = int(params.get("n") or 10)
        web = bool(plan.get("web"))
        have = "\n".join(f"- {i['text']}" for i in plan.get("ideas", [])) or "(пока ничего)"
        prompt = f"""Шаг «Штурм идей». Предложи {n} идей для ролика по вводным ниже.
Идеи — совсем разные по углу. Источники: из головы («всегда хотелось рассказать о…», «а прикольно было бы сделать…»), по мотивам выстреливших роликов через «а как бы это сделал я», из свежих новостей.
text — одна-две фразы: о чём ролик и где крючок. why — почему это зацепит зрителя, одной фразой.
{'Сначала поищи в интернете свежие новости и обсуждения по теме за последние недели. Для идей из новостей заполни src (ссылка) и date (ГГГГ-ММ-ДД).' if web else 'src и date заполняй, только если идея опирается на ссылку из вводных.'}
Не повторяй то, что уже есть.

{ctx(plan, 'topic')}

Уже есть:
{have}"""
        schema = S({"ideas": ARR(S({"text": STR, "why": STR, "src": STR, "date": STR}, ["text", "why"]))})

    elif action == "bank":
        n = int(params.get("n") or 10)
        auto = bool(params.get("auto"))                     # scheduled / «Обновить сейчас» from news sites
        web = bool(docs["bank"].get("web")) or auto
        have = "\n".join(f"- {i.get('title', '')}" for i in docs["bank"]["items"][-80:]) or "(пусто)"
        focus = "" if auto else (params.get("focus") or "").strip()
        srcs = [s for s in docs["bank"].get("sources") or [] if (s.get("url") or "").strip()]
        if auto and srcs:
            news = ("Открой эти сайты (WebFetch; если страница не открылась — WebSearch по этому сайту) и найди самые популярные "
                    "и обсуждаемые новости за последние 3 дня:\n"
                    + "\n".join(f"- {s['url'].strip()}" + (f" — {s['note']}" if s.get("note") else "") for s in srcs)
                    + "\nБери только новости, которые подходят каналу, и делай из них идеи роликов. src — ссылка на саму новость, fresh — её дата.")
        elif auto:
            news = "Поищи в интернете самые обсуждаемые новости под тематику канала за последние 3 дня и сделай из них идеи. src — ссылка на новость, fresh — её дата."
        elif web:
            news = "Поищи в интернете свежие новости под тематику канала за последние недели, из них сделай хотя бы половину идей."
        else:
            news = "Интернета у тебя сейчас нет: ссылки не придумывай — src оставь пустым, а в fresh для новостей по памяти пиши примерную дату и «проверить»."
        prompt = f"""Пополни банк идей канала: {n} идей роликов{f' на тему «{focus}»' if focus else ''}. Годятся и шортсы, и длинные видео — отметь mode (short, long или any).
title — коротко, до 8 слов; desc — одна-две фразы с крючком; cool — насколько идея горячая, 1–3; speed — сколько готовить: 1 — за день, 2 — за неделю, 3 — месяц сбора материала; fresh — дата инфоповода (ГГГГ-ММ-ДД) или «вечнозелёная»; src — ссылка, если идея из новости.
{news}
Не повторяй то, что уже есть в банке:
{have}"""
        schema = S({"ideas": ARR(S({"title": STR, "desc": STR, "mode": {"type": "string", "enum": ["short", "long", "any"]},
                                    "cool": {"type": "integer"}, "speed": {"type": "integer"}, "fresh": STR, "src": STR},
                                   ["title", "desc", "mode", "cool", "speed"]))})

    elif action == "beats":
        n = int(params.get("n") or (12 if mode == "short" else 25))
        web = bool(plan.get("web"))
        have = "\n".join(f"- {b.get('q', '')} → {b.get('a', '')}" for b in plan.get("beats", [])) or "(пока ничего)"
        if genre == "story":
            task = f"""Шаг «Собираем биты» для сюжетной истории. Бит — сюжетная единица: q — сетап (ситуация, действие героя или деталь, от которой зритель ждёт «что сейчас будет?», тревожится или улыбается), a — панчлайн (что происходит на самом деле: поворот, пугалка, шутка, разгадка). Если вторую половину надо додумать — оставь её пустой.
Думай сценами, которые можно нарисовать бумажной анимацией и рассказать голосом за кадром. Собери вперемешку:
- события сюжета от завязки к финалу, каждое страннее или страшнее прошлого, и 2–3 разных варианта финала;
- узнаваемые детали мира (звуки, предметы, надписи, цвета, запахи эпохи) — это тоже биты: сетап «что гудит в потолке?», панчлайн «лампа дневного света, как в каждой поликлинике».
Не превращай историю в лекцию: цифры и справки — только если без них теряется смысл.
src: «сюжет» — для придуманного, «деталь» — для узнаваемой детали, «проверить» — если это утверждение о реальном мире.
Собери {n} новых битов, не повторяя уже собранные."""
        else:
            task = f"""Шаг «Собираем биты» для выбранной идеи. Бит — единица смысла ролика: q — вопрос или сетап (создаёт ожидание зрителя), a — ответ или панчлайн (даёт реакцию). Если вторую половину надо додумать — оставь её пустой.
Нужны факты, детали, повороты, юмор из фактов и то, что круто показать на экране. Самое большое число переводи в бытовое сравнение.
src — откуда факт: ссылка, «вводные» или «проверить».
{'Проверь и дополни факты поиском в интернете, ссылки клади в src.' if web else 'Интернета у тебя сейчас нет: ссылки не придумывай — в src пиши «вводные» (если факт оттуда) или «проверить».'}
Собери {n} новых битов, не повторяя уже собранные."""
        if is_idea(plan):
            task += ("\nИдея уже выбрана автором, и он ответил на твои вопросы: ответы — его решения, строй биты из них, а не из своих догадок. "
                     "Чего нет ни в идее, ни в ответах — додумай, но в src пометь «додумать». Биты должны покрыть ролик от хука до финала. "
                     "Если есть референс — возьми из него то, что автор просил («что взять»), но не пересказывай чужой ролик.")
            read = refs_files(plan, docs["data"])
            if read:
                task += "\nКадры референсов можно посмотреть (Read): " + "; ".join(p.replace(chr(92), "/") for p in read)
        prompt = f"""{task}

{ctx(plan, 'idea', 'topic', 'refs', 'qa', 'q7')}

Уже есть:
{have}"""
        schema = S({"beats": ARR(S({"q": STR, "a": STR, "src": STR}, ["q", "a"]))})

    elif action == "questions":
        qa = plan.get("qa") or []
        rnd = max([int(q.get("round") or 1) for q in qa] + [0]) + 1
        n = int(params.get("n") or (18 if not qa else 10))
        focus = (params.get("focus") or "").strip()
        read = refs_files(plan, docs["data"])
        prompt = f"""Шаг «Вопросы по идее». Автор уже знает, какой ролик хочет снять. Задай ему {n} вопросов, которые у тебя возникают по этой идее: ответы нужны, чтобы придумать название, собрать сцены, персонажей, пропсы и звуки, а потом написать сценарий — и ничего не выдумывать за автора.
Спрашивай о том, чего не хватает для сценария и анимации:
- story — сюжет и логика: с чего начинается, что происходит, где поворот, чем кончается, что зритель должен понять;
- hero — герои: кто они, чего хотят, как выглядят и звучат, как реагируют;
- world — мир и детали: место, время, эпоха, узнаваемые предметы, надписи, звуки, свет;
- tone — тон: где страшно, смешно или грустно, на что похоже по ощущению;
- facts — факты (для новости и реальной истории): откуда, что проверить, какие цифры;
- pack — упаковка: что зацепит в первую секунду, что будет на обложке;
- challenge — неудобные вопросы: где идея слабая, что зритель уже видел, почему он досмотрит до конца.
Каждый вопрос — про ЭТУ идею, одно конкретное предложение; на него можно ответить за 10–30 секунд. Можно давать варианты прямо в вопросе («мама — строгая или рассеянная?»). Не спрашивай то, что уже сказано в идее, контексте или ответах.
q — вопрос; why — что решит ответ (коротко, для автора); group — тема из списка выше.
{('Автор просит: «' + focus + '» — учти это в первую очередь.') if focus else ''}
{('Это уточняющий раунд ' + str(rnd) + ': опирайся на ответы автора — копай глубже там, где ответ открыл новое или остался размытым; не повторяй заданные вопросы.') if qa else ''}
{('Кадры референсов можно посмотреть (Read): ' + '; '.join(p.replace(chr(92), '/') for p in read)) if read else ''}

{ctx(plan, 'idea', 'topic', 'refs')}

{qa_text(plan, all_=True) or '(вопросов ещё не было)'}"""
        schema = S({"questions": ARR(S({"q": STR, "why": STR, "group": {"type": "string", "enum": list(QGROUPS)}}))})

    elif action == "challenge":
        bs = [b for b in plan.get("beats", []) if b.get("keep", True)]
        prompt = f"""Шаг «Челлендж». Ты — строгий редактор. Посмотри на идею, ответы автора и биты и найди слабые места:
где зрителю станет скучно или он пролистает; где логика не сходится; где сетап без панчлайна или панчлайн без сетапа; работает ли хук в первую секунду и финал; что зритель уже видел у других; чего не хватает, чтобы это нарисовать и озвучить.
points — 4–8 коротких пунктов «проблема → что сделать» (конкретно про эти биты, со ссылкой на бит, если он про конкретный).
questions — 3–6 новых вопросов автору, ответы на которые закроют эти дыры (why — что решит ответ, group — тема: story, hero, world, tone, facts, pack, challenge).
verdict: strong — можно писать сценарий, ok — есть что усилить, weak — ролик пока не держит.

{ctx(plan, 'idea', 'topic', 'qa')}

{('Биты (вопрос → ответ):' + chr(10) + chr(10).join(f"{i}. {b.get('q', '')} → {b.get('a', '')}" for i, b in enumerate(bs, 1))) if bs else 'Битов пока нет — оцени идею и ответы.'}"""
        schema = S({"verdict": {"type": "string", "enum": ["strong", "ok", "weak"]}, "points": ARR(STR),
                    "questions": ARR(S({"q": STR, "why": STR, "group": {"type": "string", "enum": list(QGROUPS)}}))})

    elif action == "elements":
        kind = params.get("kind") if params.get("kind") in KINDS else ""
        focus = (params.get("focus") or "").strip()
        els = plan.get("elements") or []
        have = "\n".join(f"- [{KINDS.get(e.get('kind'), '')}] {e.get('name', '')}" + (" (вычеркнут автором — не предлагай снова)" if e.get("status") == "drop" else "")
                         for e in els) or "(пока ничего)"
        engine = "3D-диорама в духе Paper Mario (картонные локации, бумажные герои-карточки)" if plan.get("engine") == "3d" else "2D-аппликация (коллаж из бумаги)"
        howmany = (f"Только тип {kind} ({KINDS[kind]}): 4–8 новых." if kind else
                   "Персонажи — все, кто в кадре (массовка — одним элементом); пропсы — 8–15 самых важных; сцены — все локации ролика; звуки — 6–12.")
        cast = [e.get("name", "") for e in els if e.get("kind") in ("char", "prop") and e.get("status") != "drop"]
        scr = script_of(plan)
        if scr and not kind:
            howmany = ("ЕСТЬ СЦЕНАРИЙ (ниже) — препродакшен строится по нему (S11): каждой сцене сценария (### …) — ровно одна сцена препродакшена, sec — заголовок этой сцены "
                       "сценария как есть (без таймкода), desc — что в кадре по «Картинке», why — что звучит (VO) и смысл сцены; уже имеющиеся сцены не дублируй. "
                       "Персонажи и пропсы — всё, что названо или подразумевается в «Картинке» и тексте (массовка — одним элементом); звуки — эмбиент локаций и звуки действий по сценарию.")
        prompt = f"""Шаг «Препродакшен». Ролик — бумажная анимация ({engine}), герой — наш бумажный ёжик. Чтобы собрать его, заранее готовим элементы. Составь список того, что понадобится:
- char — персонажи: наш ёжик в нужном образе и все, кто появляется в кадре;
- prop — пропсы и реквизит: предметы, надписи и таблички, мебель, свет (лампы), текстуры пола и стен, мелочи эпохи — то, что делает место узнаваемым;
- scene — сцены и локации: каждое место действия (каждой смене мысли — своя локация, перечисления — отдельные мини-сцены). Сцены собираются из персонажей и пропсов: в uses перечисли названия тех, кто и что в ней стоит — из уже имеющихся{(' (' + ', '.join(cast[:40]) + ')') if cast else ''} или предложенных тобой здесь же; чего в сцене не хватает, добавь отдельным персонажем или пропсом;
- sound — звуки: эмбиент каждой локации, звуки действий (двери, кнопки, шаги), музыка фоном, акценты для пугалок и шуток.
name — коротко (2–5 слов); desc — как выглядит или звучит: конкретно и узнаваемо (материал, цвет, эпоха, состояние, размер); why — в каком месте ролика нужен.
Для звуков q — 2–4 английских слова для поиска в библиотеках звуков («elevator door open», «fluorescent light hum»); для остальных q пустое. uses — только у сцен, у остальных пустой список.
{howmany}
{('Автор просит: «' + focus + '» — это в первую очередь.') if focus else ''}
Не повторяй уже имеющееся:
{have}

{ctx(plan, 'idea', 'topic', 'qa', 'refs') if plan.get('flow') == 'idea' else ctx(plan, 'idea', 'topic', 'qa', 'beats', 'meanings', 'refs')}
{('Сценарий ролика (script.md проекта):' + chr(10) + scr) if scr else ''}"""
        schema = S({"elements": ARR(S({"kind": {"type": "string", "enum": list(KINDS)}, "name": STR, "desc": STR, "why": STR, "q": STR, "uses": ARR(STR), "sec": STR},
                                      ["kind", "name", "desc", "why"]))})

    elif action == "element":
        return element_spec(docs, params, sysp, genre)

    elif action == "charparts":
        return charparts_spec(docs, params, sysp)

    elif action == "trellisfix":
        return trellisfix_spec(docs, params, sysp)

    elif action == "libfix":
        return libfix_spec(docs, params, sysp)

    elif action == "animteach":
        return animteach_spec(docs, params, sysp)

    elif action == "sound":
        return sound_spec(docs, params, sysp)

    elif action == "assets":
        return assets_spec(docs, params, sysp)

    elif action == "q7":
        prompt = f"""Шаг 1 генератора названий: ответь на 7 вопросов о ролике — коротко, но по сути, 1–3 предложения на ответ.
struck («что зацепило тебя») и need («почему НУЖНО снять») — про автора: предложи, что могло зацепить и зачем это снимать, как черновик, который автор поправит.
Ключи: about — о чём это видео (самый развёрнутый ответ), main — что главное, remember — что запомнят, differ — чем отличается от роликов других авторов, struck, need, all — почему должны увидеть все.

{ctx(plan, 'idea', 'topic', 'beats')}"""
        schema = S({k["key"]: STR for k in REF["q7"]})

    elif action == "meanings":
        prompt = f"""Шаг 2 генератора названий: выпиши смыслы ролика — смысловые единицы, которые раскрывают его суть.
Принцип пещерного человека: самые простые и яркие слова, понятные первокласснику (не «энергопотребление вычислительных центров», а «ИИ», «СВЕТ», «СЧЁТ»). 1–3 слова на смысл, 8–14 смыслов.
must=true — без этого смысла суть ролика теряется полностью. Не бери смыслы, которые создают ложное впечатление о содержании.

{ctx(plan, 'idea', 'q7', 'qa', 'beats')}"""
        schema = S({"meanings": ARR(S({"text": STR, "must": {"type": "boolean"}}))})

    elif action == "titles":
        angle = params.get("angle")
        k = int(params.get("k") or 3)
        angs = [a for a in REF["angles"] if not angle or a["key"] == angle]
        have = "\n".join(f"- {t.get('text', '')}" for t in plan.get("titles", [])) or "(пока ничего)"
        prompt = f"""Шаг 3 генератора названий — «углы атаки». В центре круга — идея ролика. Сформулируй названия через {'угол' if angle else 'каждый угол'}:
{chr(10).join(f"- {a['key']}: {a['label']} ({a['hint']})" for a in angs)}
По {k} названия на угол, совсем разные. {'Опирайся на идею, контекст и ответы автора: что в ролике главное и что зацепит.' if plan.get('flow') == 'idea' else 'Опирайся на смыслы «без этого никак», вычеркнутые не используй.'}
Усиливай названия словами из эмоциональных групп:
{words_block()}
words — ключи групп, которые задействованы в названии. Длина — до {tmax} знаков. Название не спойлерит главный поворот и не обещает того, чего нет в ролике.

{ctx(plan, 'idea', 'topic', 'qa', 'refs') if plan.get('flow') == 'idea' else ctx(plan, 'idea', 'q7', 'qa', 'meanings')}

Уже есть:
{have}"""
        schema = S({"titles": ARR(S({"angle": {"type": "string", "enum": [a["key"] for a in angs]}, "text": STR,
                                     "words": ARR({"type": "string", "enum": [w["key"] for w in REF["words"]]})}))})

    elif action == "strengthen":
        t = next((x for x in plan.get("titles", []) if x["id"] == params.get("title")), None) or {}
        ang = next((a["label"] for a in REF["angles"] if a["key"] == t.get("angle")), "")
        prompt = f"""Усиль название «{t.get('text', '')}» (угол: {ang}): дай 3 варианта с сильными словами из разных эмоциональных групп.
Смысл и угол те же, длина до {tmax} знаков, без кликбейта, которого ролик не оправдает.
Группы:
{words_block()}

{ctx(plan, 'idea', 'meanings')}"""
        schema = S({"variants": ARR(S({"text": STR, "words": ARR({"type": "string", "enum": [w["key"] for w in REF["words"]]})}))})

    elif action == "images":
        ms = [m for m in plan.get("meanings", []) if (m.get("mark") or "") != "cut"]
        need = []
        for m in ms:
            filled = {g.get("slot") for g in plan.get("images", []) if g.get("meaning") == m["id"] and (g.get("text") or g.get("img"))}
            if len(filled) < 3:
                need.append(f"- [{m['id']}] {m['text']}" + (" (без этого никак)" if m.get("mark") == "must" else ""))
        prompt = f"""Шаг «Смыслы в образы». Для каждого смысла ниже подбери 3 РАЗНЫХ сильных образа: предмет, человека, символ или сцену, которые узнаются мгновенно (услышал слово — и сразу видишь картинку). Не три вариации одного и того же.
Предпочитай узнаваемую конкретику: реальные логотипы, кадры, игровые спрайты, вещи эпохи, мемы. 2–8 слов на образ. meaning — id смысла в квадратных скобках.

Смыслы:
{chr(10).join(need) or '(все уже заполнены)'}

{ctx(plan, 'idea')}"""
        schema = S({"images": ARR(S({"meaning": STR, "options": ARR(STR)}))})

    elif action == "thumbs":
        t = next((x for x in plan.get("titles", []) if x["id"] == params.get("title")), None) or {}
        k = int(params.get("k") or 1)
        imgs = []
        for m in plan.get("meanings", []):
            opts = [g["text"] for g in plan.get("images", []) if g.get("meaning") == m["id"] and g.get("text")]
            if opts:
                imgs.append(f"- {m['text']}: " + "; ".join(opts))
        hook = ("первая фраза рассказчика (10–15 слов): герой уже в странной ситуации или обещание беды, без вопроса и приветствия"
                if genre == "story" else "первая фраза закадра (10–15 слов, с именем, годом или цифрой, без вопроса и приветствия)")
        what = (f"связки для шортса. hook — {hook}; "
                "frame — первый кадр ролика, он же превью в ленте; desc — обложка 9:16 для полки шортсов и страницы канала; "
                "text — текст на обложке (2–4 слова или число) либо пусто") if mode == "short" else \
               "превью 16:9. desc — что в кадре, 1–3 предложения; text — текст на превью (минимум слов) либо пусто; hook и frame оставь пустыми"
        have = [c.get("desc") for c in plan.get("thumbs", []) if c.get("title") == t.get("id") and c.get("desc")]
        many = f"{k} совсем разных концептов" if k > 1 else "один, самый сильный концепт"
        prompt = f"""Шаг «Концепт идеального превью» для названия «{t.get('text', '')}». Придумай {many} {what}.
{('Уже есть такие — предложи другой ход, не похожий на них:' + chr(10) + chr(10).join('- ' + x for x in have)) if have else ''}
Задачи превью: привлечь внимание, заинтересовать, показать, что зритель получит, и что это наш ролик. 1 образ — идеально, 3 — хорошо, больше 7 — провал. n — сколько образов в кадре.
Не делай ребус: смысл не должен собираться из разрозненных картинок. Текст не повторяет название (текст читают медленно, картинку схватывают сразу); число, сумма или «СТОП» — это уже образ.
type — тип по карте превью, лучше из «золотого грааля»:
{types_block()}

{ctx(plan, 'idea', 'meanings', 'elements')}
Образы для смыслов:
{chr(10).join(imgs) or '(не подобраны)'}"""
        schema = S({"thumbs": ARR(S({"desc": STR, "type": {"type": "string", "enum": list(REF["thumbTypes"])}, "n": {"type": "integer"},
                                     "text": STR, "hook": STR, "frame": STR}, ["desc", "type", "n", "text"]))})

    elif action == "packtext":                                # S8: тексты упаковки по шагу E (_studio/CLAUDE.md)
        import pack_api
        vdir = P.video(plan["id"]) or ""
        try:
            script = open(os.path.join(vdir, "script.md"), encoding="utf-8").read()[:6000]
        except OSError:
            script = "(сценария нет — ролик без голоса; опирайся на идею, контекст и ответы автора)"
        rs = pack_api.rights(plan)
        fin = [t["text"] for t in plan.get("titles") or [] if t.get("star")]
        prompt = f"""Шаг «Упаковка» (E): тексты для публикации ролика «{plan.get('name')}».

{ctx(plan, 'idea', 'topic', 'qa')}

Финалисты названия (автор отметил ★): {'; '.join(fin) or '—'}

Сценарий ролика:
{script}

Что вошло в ролик и чьё оно (собрано из лицензий):
{pack_api.rights_md(rs)}

Сделай:
- titles — 5 названий до ~50 знаков, без спойлера главного поворота. Придумай по 2–3 на каждый угол атаки (число или сумма; сильный образ или эмоция; время или срочность; отрицание или противоречие) и возьми 5 самых сильных и разных; лучшее — best: true (одно). Финалисты автора — основа, можно их улучшить. angle — угол.
- short — короткое описание для Shorts / Reels (1–2 фразы, живо, в подаче канала).
- sources — описание с источниками (если ролик на фактах — ссылки и что откуда; если зарисовка — откуда вайб и отсылки).
- provoke — описание-провокация для комментариев (вопрос зрителю, который хочется обсудить).
- pin — закреп в комментариях от автора.
- tags — 6–10 хэштегов с #.
- rights — раздел «Права» человеческим языком по списку выше: чьи кадры, музыка, звуки, логотипы и пародии вошли в ролик; узнаваемые бренды и игры назови (права у владельцев).
Факты — только из видео и сценария. Без CTA «подпишись» и без морали."""
        schema = S({"titles": ARR(S({"text": STR, "angle": STR, "best": {"type": "boolean"}}, ["text", "angle"])), "short": STR, "sources": STR, "provoke": STR,
                    "pin": STR, "tags": ARR(STR), "rights": STR}, ["titles", "short", "sources", "provoke", "pin", "tags", "rights"])

    elif action == "critique":
        c = next((x for x in plan.get("thumbs", []) if x["id"] == params.get("thumb")), None) or {}
        t = next((x for x in plan.get("titles", []) if x["id"] == c.get("title")), None) or {}
        read = [os.path.abspath(P.resolve(c[k])) for k in ("img", "frameImg")
                if c.get(k) and os.path.isfile(P.resolve(c[k]))]
        tt = REF["thumbTypes"].get(c.get("type"), {}).get("label", "не выбран")
        prompt = f"""Разбери концепт {'связки шортса' if mode == 'short' else 'превью'} как строгий редактор. Название ролика: «{t.get('text', '')}».
Описание: {c.get('desc') or '(нет)'}
Текст на {'обложке' if mode == 'short' else 'превью'}: {c.get('text') or '(нет)'}
Тип по карте, который выбрал автор: {tt}; образов в кадре, по мнению автора: {c.get('n') or '?'}
{f"Хук: {c.get('hook') or '(нет)'}{chr(10)}Первый кадр: {c.get('frame') or '(нет)'}" if mode == 'short' else ''}
{('Посмотри эскизы (прочитай файлы): ' + '; '.join(read) + '. Обложка — img, первый кадр — frameImg.') if read else 'Эскизов нет — суди по описанию.'}
Для шортса обложка и первый кадр — разные задачи: обложка работает на полке и в рекомендациях (статичная, читается в маленьком размере), первый кадр — в ленте (в движении, решает «остаться или пролистнуть», звучит хук). Оцени их отдельно.

Проверь: считывается ли за секунду; сколько образов; не ребус ли; не повторяет ли текст название; выполняет ли 4 задачи (внимание, интерес, что зритель получит, что это наш ролик){'; хук — 10–15 слов с конкретикой, без вопроса' if mode == 'short' else ''}.
points — 3–5 коротких пунктов с тем, что изменить. type — к какому типу карты это относится на самом деле. verdict: good — можно брать, fix — доработать, bad — не работает.
Типы:
{types_block()}"""
        schema = S({"verdict": {"type": "string", "enum": ["good", "fix", "bad"]}, "points": ARR(STR),
                    "type": {"type": "string", "enum": list(REF["thumbTypes"])}})

    elif action == "structure":
        label, rows = slots_of(plan)
        ft = next((x for x in plan.get("titles", []) if x["id"] == (plan.get("final") or {}).get("title")), None)
        prompt = f"""Шаг «Структура»: разложи оставленные биты по {label}.
Каждый бит — ровно в один слот, порядок внутри слота важен. Биты, которые не нужны, отдай в unused. Для слотов без подходящего бита напиши в note, чего там не хватает. Новых битов не выдумывай.
Первый слот (хук, открывающий образ) и последний (кода, завершающий образ) должны перекликаться словом, образом или цифрой.
Название ролика: {('«' + ft['text'] + '»') if ft else '(не выбрано)'}

Слоты (key — что там должно быть):
{chr(10).join(f"- {r['key']}: {r['label']} — {r.get('hint', '')}" for r in rows)}

{ctx(plan, 'idea', 'beats')}"""
        schema = S({"slots": ARR(S({"key": {"type": "string", "enum": [r["key"] for r in rows]}, "beats": ARR(STR), "note": STR})),
                    "unused": ARR(STR)})

    elif action == "conclusions":
        m, cp = params.get("mode") or "short", str(params.get("cp") or "1")
        rows = [r for r in docs["stats"]["items"] if (r.get("mode") or "short") == m]
        keys = ["awesome", "h1", "d1", "d7", "d14", "d28"] + [x["key"] for x in REF["viewsExtra"][m]]
        table = "\n".join(f"- «{r.get('name', '')}» ({r.get('date', '')}): " + ", ".join(f"{k}={r.get(k)}" for k in keys if r.get(k) not in (None, ""))
                          for r in rows) or "(данных нет)"
        prompt = f"""Подведи итоги после {cp}-го ролика ({REF['modes'][m]['label']}). Ответь по цифрам:
{chr(10).join('- ' + q for q in REF['statsQ'])}
Отдельно отметь, где своя оценка до выхода (awesome) разошлась с цифрами. 4–8 коротких пунктов, только из данных; если данных мало, так и скажи.
verdict: continue — гипотеза работает, adjust — корректируемся, stop — всё мимо, пора менять гипотезу, early — рано судить.

Поля: awesome — «офигенно получилось?» до цифр, h1/d1/d7/d14/d28 — просмотры за час/сутки/7/14/28 дней, viewed — % не пролиставших, avg — средний % просмотра, ctr — CTR превью, subs — подписки.
Ролики:
{table}"""
        schema = S({"points": ARR(STR), "verdict": {"type": "string", "enum": ["continue", "adjust", "stop", "early"]}})

    elif action == "render":
        return render_spec(docs, params, sysp, genre)

    else:
        raise ValueError(f"неизвестное действие: {action}")
    return {"system": sysp, "prompt": prompt, "schema": schema, "web": web, "read": read}


# Рисуем с прицелом на анимацию и переиспользование (пожелание автора, S10): части, которые потом захочется двигать, — отдельно
ANIM_READY = """Делай с прицелом на анимацию и на другие ролики — подумай, что с этим потом захотят сделать, и раздели на части:
- всё, что может двигаться, открываться или меняться само по себе, — отдельная часть со своим параметром o.* (0…1 или состояние), а не нарисовано намертво:
  дверь и дверца (o.door), шторы (o.curtain — задёрнуты / открыты), крышка, ящик, экран (o.screen — что на нём), лампочки и индикаторы (o.led, o.glow),
  стрелки часов (o.t), пламя, дым; силуэт в окне — отдельно от рамы, стекла и штор (силуэт может пройти, остановиться, задёрнуть штору);
- персонаж — без «вшитых» предметов в руках (трубка, кружка, телефон — отдельные пропсы, их потом дадут в руку); по умолчанию нейтральная поза, руки свободны;
- повторяющееся (окна дома, люди в окнах, книги на полке) — одной функцией с параметрами (номер, цвет, состояние), чтобы собрать много разных из одного;
- в summary перечисли части и параметры: «o.curtain 0…1 — штора, o.who — силуэт (none | man | woman | cat), o.light — свет в окне» — по ним Claude и автор будут анимировать."""

STYLE = ("Стиль канала — бумажная аппликация (коллаж): фигуры вырезаны из бумаги, у них рваная кромка, зерно и тени; фото, логотипы и "
         "спрайты вклеены вырезками с белой обводкой; надписи — на тетрадных листках и от руки (шрифт Caveat) или плашками Rubik 900. "
         "Герой — наш бумажный ёжик (drawHog): серый, из сотен рваных полосок, тёмная маска, большие глаза, светлая мордочка, в духе «Ёжика в тумане». "
         "Круглого ёжика из chars.js не использовать. Палитру и фон подбирай под историю.")


PARTS = {"cover": ("обложка", "COVER"), "frame": ("первый кадр", "FRAME")}


def fx_of(c, params):
    """Edits for the next version: pins + a note per picture (thumbs[].fx.cover / .frame), plus an old-style one-line note."""
    fxs = {}
    for part in PARTS:
        e = ((c.get("fx") or {}).get(part)) or {}
        pins = [{"id": p.get("id"), "x": float(p.get("x") or 0), "y": float(p.get("y") or 0), "text": (p.get("text") or "").strip()}
                for p in e.get("pins") or [] if isinstance(p, dict)]
        text = (e.get("text") or "").strip()
        notes = fx_notes(e)
        if pins or text or notes:
            fxs[part] = {"text": text, "pins": pins, "notes": notes}
    return (params.get("feedback") or "").strip(), fxs


def fx_notes(e):
    """«в целом» as a stack of separate edits: fx.<part>.notes[] = {id, text} (each Enter on the page adds one)."""
    return [{"id": n.get("id"), "text": (n.get("text") or "").strip()} for n in (e or {}).get("notes") or [] if isinstance(n, dict) and (n.get("text") or "").strip()]


def fx_text(fb, fxs):
    """One readable line for the version history."""
    out = [f"{PARTS[k][0]}: " + "; ".join(([e["text"]] if e["text"] else []) + [n["text"] for n in e.get("notes") or []]
                                         + [f"📍{i} {p['text'] or '(смотри место)'}" for i, p in enumerate(e["pins"], 1)])
           for k, e in fxs.items()]
    return " · ".join(([fb] if fb else []) + out)


def mark_pins(src, dst, pins):
    """Copy of the previous render with numbered pins, so Claude sees exactly where the author pointed."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        im = Image.open(src).convert("RGB")
        d, (w, hh) = ImageDraw.Draw(im), im.size
        r = max(26, w // 30)
        try:
            f = ImageFont.truetype("arialbd.ttf", int(r * 1.1))
        except Exception:
            f = ImageFont.load_default()
        for i, p in enumerate(pins, 1):
            x, y = p["x"] * w, p["y"] * hh
            d.ellipse([x - r, y - r, x + r, y + r], fill=(230, 30, 60), outline=(255, 255, 255), width=max(3, r // 7))
            d.text((x, y), str(i), fill=(255, 255, 255), font=f, anchor="mm")
        im.save(dst)
        return True
    except Exception as e:
        print("! пины не нарисовались:", e)
        return False


def fx_prompt(fb, fxs, base, data, wd, v):
    lines = [f"ПРАВКА. Это новая версия v{v}. В папке уже лежит scene.js предыдущей версии — начни с него, "
             "исправь ровно то, что просит автор, остальное сохрани."]
    if fb:
        lines.append(f"Общее замечание: «{fb}».")
    for part, (name, obj) in PARTS.items():
        e = fxs.get(part)
        if not e:
            lines.append(f"{name.capitalize()} ({obj}): правок нет — не трогай.")
            continue
        lines.append(f"Правки — {name} ({obj}):")
        if e["text"]:
            lines.append(f"- в целом: «{e['text']}»")
        for n in e.get("notes") or []:
            lines.append(f"- в целом: «{n['text']}»")
        for i, p in enumerate(e["pins"], 1):
            lines.append(f"- пин {i} (x≈{round(p['x'] * 1080)}, y≈{round(p['y'] * 1920)} из 1080×1920): «{p['text'] or 'автор отметил это место без слов — посмотри, что там не так'}»")
        src = P.resolve(base.get(part) or "")
        dst = os.path.join(wd, f"pins_{part}.png")
        if e["pins"] and base.get(part) and os.path.isfile(src) and mark_pins(src, dst, e["pins"]):
            lines.append(f"  Прошлая версия с номерами пинов: {dst.replace(chr(92), '/')} — посмотри через Read.")
    return chr(10).join(lines)


def render_spec(docs, params, sysp, genre):
    """«🎨 Отрисовать»: Claude writes a scene for the render stand (web/render/page.html), shoots it with render_shot.js,
    looks at the PNGs and fixes them, 2–4 passes. Work folder: _ideas/render/<plan>/<concept>/v<N>/."""
    plan, data = docs["plan"], docs["data"]
    c = next((x for x in plan.get("thumbs", []) if x["id"] == params.get("thumb")), None)
    if not c:
        raise ValueError("концепт не найден")
    t = next((x for x in plan.get("titles", []) if x["id"] == c.get("title")), None) or {}
    short = plan.get("mode") != "long"
    renders = c.get("renders", [])
    v = max([r.get("v", 0) for r in renders] + [0]) + 1
    rel = f"{plan['id']}/{c['id']}/v{v}"
    wd = P.resolve("render/" + rel)
    os.makedirs(wd, exist_ok=True)
    base = next((r for r in renders if r.get("id") == params.get("base")), None)
    if base:
        prev = os.path.join(P.resolve("render/" + base["dir"]), "scene.js")
        if os.path.isfile(prev):
            shutil.copy2(prev, os.path.join(wd, "scene.js"))
    params["_wd"], params["_rel"], params["_v"] = wd, rel, v

    def fwd(x):
        return x.replace(chr(92), "/")

    shot = fwd(os.path.join(P.STANDS, "render_shot.js"))
    paper = fwd(os.path.join(P.STANDS, "paper.js"))
    url = f"http://127.0.0.1:{docs['port']}/render/page.html?scene=/rscene/{rel}/scene.js"
    cmd = f'node {shot} "{url}" {fwd(wd)} 0.2,1.5'
    sk = [(k, fwd(P.resolve(c[k]))) for k in ("img", "frameImg") if c.get(k) and os.path.isfile(P.resolve(c[k]))]
    ms = {m["id"]: m for m in plan.get("meanings", [])}
    pics = [g for g in plan.get("images", []) if g.get("img") and os.path.isfile(P.resolve(g["img"]))]
    pic_lines = chr(10).join(f"- IMG-ключ i{n}: '/{g['img']}' (файл {fwd(P.resolve(g['img']))}) — {g.get('text') or ''} "
                          f"[смысл: {ms.get(g.get('meaning'), {}).get('text', '')}]" for n, g in enumerate(pics, 1)) or "(картинок нет)"
    fb, fxs = fx_of(c, params)
    params["_fx"] = fxs
    # preproduction: drawn scenes, characters and props — ready code for the cover and the first frame; @-marked ones first
    texts = [c.get(k) for k in ("desc", "frame", "hook", "text")] + [fb] + [(e or {}).get("text") for e in fxs.values()] \
        + [p.get("text") for e in fxs.values() for p in e.get("pins") or []]
    marked = {x["id"] for t in texts for x in preprod.mentions_in(t, plan)}
    pre = []
    for x in sorted(plan.get("elements") or [], key=lambda x: x["id"] not in marked):
        rs = x.get("renders") or []
        r = next((y for y in rs if y.get("id") == x.get("render")), rs[-1] if rs else None)
        if r and x.get("status") != "drop":
            pre.append(f"- {KINDS.get(x.get('kind'), '')} @[{x.get('name', '')}]{' (утверждён)' if x.get('status') == 'ok' else ''}"
                       f"{' ← автор отметил его через @ в концепте или правках — он обязан быть в кадре' if x['id'] in marked else ''}: картинка {fwd(P.resolve(r['img']))}, "
                       f"код {fwd(os.path.join(P.resolve('render/' + r['dir']), 'element.js'))}" + (f", функция {r['fn']}" if r.get("fn") else ""))
    pre_block = ("Готовые элементы препродакшена этого ролика (@[Название] в текстах автора — ссылка на них) — бери их код (скопируй нужные функции в scene.js) и держи тот же вид, "
                 "что автор уже утвердил (3D-сцены здесь не отрисуются — возьми из них палитру и детали для 2D):" + chr(10) + chr(10).join(pre)) if pre else ""
    sketch = ("- Эскизы автора — посмотри их через Read и повтори композицию (что где стоит, размеры, ракурс), переводя в наш стиль, "
              "а не копируя линии: " + "; ".join(f"{'обложка' if k == 'img' else 'первый кадр'} — {p}" for k, p in sk)) if sk \
        else "- Эскизов нет — композицию строй по описанию."
    edit = fx_prompt(fb, fxs, base, data, wd, v) if base and (fb or fxs) else ""
    what = "обложку и первый кадр шортса (оба 1080×1920)" if short else "превью 16:9 и первый кадр (холст 1080×1920, рисуй в центральной полосе 16:9)"
    prompt = f"""Задача: отрисовать {what} для ролика «{t.get('text', '')}» нашим движком.

{STYLE}

Концепт от автора (главное — следуй ему):
- Обложка (полка шортсов, рекомендации, страница канала; статичная, считывается в маленьком размере): {c.get('desc') or '(нет описания)'}
- Текст на обложке: {c.get('text') or '(без текста)'}
- Тип по карте превью: {c.get('type') or '?'}
- Первый кадр (лента, решает «остаться или пролистнуть»; это сцена 1 ролика): {c.get('frame') or '(нет описания — придумай по обложке и хуку)'}
- Хук (голос за кадром, на кадре НЕ пишется): {c.get('hook') or '—'}
{sketch}

Идея ролика: {(idea_of(plan) or {}).get('text', '')}

Картинки автора из «Смыслы в образы» — используй подходящие как вырезки (photo / sticker), посмотреть можно через Read:
{pic_lines}
{pre_block}

{edit}

Как работать:
1. Прочитай тулкит {paper}: cut/cutRect/cutEll, paperBG, desk, photo, sticker, note, label, scrawl, stamp, light, tint, flakes, slam/popIn,
   drawHog(ctx, x, yНог, рост, {{kind, look, lid, mouth, armL, armR, lenL, lenR, hoodie, cap, glasses, prop, t, rot}}) и aim.
   Хелперы lib.js глобальные: W=1080, H=1920, TAU, lerp, remap, clamp, E.*, rng, rr, circle, font(size, weight), vgrad, radial, imgFit.
2. Запиши в текущую папку файл scene.js (только его) по контракту:
   const PICS = {{ i3: '/files/…png' }};              // нужные картинки -> IMG.i3
   const COVER = {{ draw(ctx) {{ … }} }};              // обложка
   const FRAME = {{ t: 0.6, draw(ctx, T) {{ … }} }};   // первые ~2 с ролика, T — секунды: лёгкое движение (дыхание ёжика t: T, дрейф фона, popIn/slam); к T=0.6 кадр уже цепляет
3. Отрисуй командой (ровно так): {cmd}
   Получишь cover.png, frame.png (T=0.6), frame_0.2.png, frame_1.5.png и ошибки страницы, если есть.
4. Посмотри PNG через Read, сравни с концептом и эскизом, исправь scene.js и отрисуй снова. 2–4 прохода, пока не станет хорошо.

Правила кадра:
- Обложка: яркая и чистая, 1–3 образа, без ребуса; крупный объект или ёжик с сильной эмоцией. Текст — только если он есть в концепте
  (Rubik 900 или плашка label, толстая обводка), и он не повторяет название. Всё важное — в зоне y 150–1400 и x 60–1020.
- Первый кадр: живая сцена без заголовков (субтитры добавит движок, зона y 1400–1540 свободна), читается за секунду.
- Фон шире кадра, без белых дыр.
- Жанр: {GENRE[genre]}

В ответе: summary — что сделано и какие решения (2–3 предложения), cover и frame — по одной фразе, что на картинке."""
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 1500,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {shot}:*)"],
            "dirs": [wd, P.files(plan["id"]), P.STANDS, P.render(plan["id"])],
            "schema": S({"summary": STR, "cover": STR, "frame": STR})}


SHEETS = {
    "char": ("персонажа",
             "лист персонажа 1080×1920: сверху имя (Caveat); в центре персонаж крупно в полный рост (~900 px); внизу в ряд 3 маленьких варианта (~380 px) — "
             "эмоции и позы, которые понадобятся в ролике (например испуг, радость, вид сзади или шаг), под каждым подпись Caveat. Фон — светлая бумага (desk или paperBG)",
             "function drawИмя(ctx, x, yНог, рост, o = {})   // o.mood, o.look (-1…1), o.t — время (дыхание, моргание), o.pose — всё, что понадобится"),
    "prop": ("пропса (предмета)",
             "лист предмета 1080×1920: предмет крупно в центре (~650 px); рядом 1–3 варианта или состояния (открыт / закрыт, горит / погас, целый / сломан); "
             "для масштаба маленький бумажный ёжик рядом; подписи Caveat. Фон — светлая бумага",
             "function drawИмя(ctx, x, yНиза, размер, o = {})   // o.state, o.t — варианты и время"),
    "scene": ("сцены (локации)",
              "кадр 9:16 этой локации, как он будет в ролике: фон шире кадра, главный свет и настроение, узнаваемые детали из описания; "
              "наш ёжик в кадре для масштаба (не главный объект). Зона субтитров y 1400–1540 без важного",
              "function drawИмя(ctx, T, o = {})   // фон локации целиком, без героев; o.cam = {x, y, s} — сдвиг и масштаб камеры"),
}


def _fwd(x):
    return x.replace(chr(92), "/")


def _example_3d(root):
    """Existing 3D worlds to learn from (whole shorts on stage3d.js)."""
    out = []
    for proj, f, what in (("Не жми эту кнопку в лифте детской поликлиники", "clinic3d.js", "интерьер поликлиники: коридоры, лифт, лампы"),
                          ("Коты сыщики 3D", "yard3d.js", "двор-диорама, время суток")):
        d = P.project(proj)
        p = os.path.join(d, "src", f) if d else ""
        if p and os.path.isfile(p):
            out.append((p, what))
    return out


def dim_of(e, ch=None):
    """2d | 3d у персонажа и пропса (S3): поле dim; нет поля — 2d, если черновики уже есть, иначе по умолчанию канала (channel.json → defaults.dim)."""
    if e.get("dim") in ("2d", "3d"):
        return e["dim"]
    if e.get("renders"):
        return "2d"
    return (((ch or {}).get("defaults") or {}).get("dim")) or "2d"


def is_prop3(e, ch=None):
    return e.get("kind") == "prop" and dim_of(e, ch) == "3d"      # персонажи в 3D — S4


def _prop3_pins(docs, base, wd, pins):
    """Прошлая версия 3D-пропса с номерами пинов с четырёх ракурсов -> wd/pins.png, pins_1…7.png."""
    if not pins or not base:
        return False
    pf = os.path.join(P.resolve("render/" + base["dir"]), "prefab.js")
    if not os.path.isfile(pf):
        return False
    pj = os.path.join(wd, "pins.json")
    json.dump([{"n": i, "p": p["p"]} for i, p in enumerate(pins, 1)], open(pj, "w", encoding="utf-8"))
    try:
        subprocess.run(["node", os.path.join(P.STANDS, "render_prop.js"), f"/rscene/{base['dir']}/prefab.js", wd, "--port", str(docs["port"]), "--pins", pj],
                       capture_output=True, timeout=240)
    except Exception:
        return False
    return os.path.isfile(os.path.join(wd, "pins.png"))


def prop3_engine(docs, e, rel, wd, blender):
    """Контракт 3D-пропса (docs/studio/stage3-props.md) для промпта «🎨 Нарисовать черновик»."""
    rp = _fwd(os.path.join(P.STANDS, "render_prop.js"))
    br = _fwd(os.path.join(P.STANDS, "blender_run.py"))
    how = e.get("how") or "auto"
    ways = {"shapes": "фигурами кодом (P3.box / cyl / lathe / extrude + наклейки)",
            "model": "из 3D-модели, которую автор взял в работу (📦 ассеты ниже), с доработкой кодом (детали, наклейки, цвета)",
            "blender": "через Blender: скрипт bpy (фаски, булевы операции, сглаживание, сложные формы) → model.glb, детали и наклейки — кодом поверх"}
    if how == "auto":
        pick = ("Способ выбери сам по сложности: простые формы (ящики, цилиндры, панели) — фигурами кодом; "
                + ("сложные, скруглённые, органические (кресло, телефонная трубка, машина) — через Blender; " if blender else "")
                + "если автор взял подходящую модель в 📦 — из неё.")
    else:
        pick = "Способ задал автор: " + ways.get(how, how) + "."
    style = (docs.get("channel") or {}).get("style3d") or "paper"
    look = "бумажный макет — матовая бумага с зерном, линии сгибов, круглое собрано из граней" if style == "paper" else "игрушка — гладко, скруглённо, мягкий блик"
    bl = ""
    if blender:
        bl = f"""
   Blender (если выбрал его): напиши в текущую папку model.py — скрипт bpy для пустой сцены (метры; низ модели на z = 0, перед смотрит на -Y Blender:
   после экспорта это +z three.js). Меши, модификаторы (Bevel, Boolean, Subdivision, Solidify), материалы — только цвет (Principled BSDF Base Color, roughness 1).
   Собери командой (ровно так): python {br} model.py  → model.glb рядом + размеры; ошибки Python — в ответе, лог — model.log.
   В prefab.js: models: {{ m1: 'model.glb' }}, kind: 'model', model: 'm1', h: <высота>, detail(w, o, G) {{ … наклейки и мелочи поверх … }}."""
    return f"""Движок — 3D-пропс для диорамы (props3d.js поверх stage3d.js, three.js). Стиль 3D канала: {look} (материалы P3 делают его сами — не задавай свои материалы без нужды).
1. Прочитай шапку {_fwd(os.path.join(P.ENGINE, 'props3d.js'))} (P3.box, cyl, lathe, extrude, sticker, part, p) и образец {_fwd(os.path.join(P.STANDS, 'samples', 'crt3d', 'prefab.js'))} — ЭЛТ-монитор фигурами кодом.
   Бумажный тулкит для рисунков на наклейках (экраны, логотипы, надписи, кнопки): {_fwd(os.path.join(P.STANDS, 'paper.js'))}.
2. {pick}
   Запиши в текущую папку prefab.js (контракт — образец):
   prop3d({{ name: '{e.get('name', '')}', h: <реальная высота, м>, params: {{ … что автор сможет менять в сцене … }}, build(w, o) {{ const G = new THREE.Group(); … return G; }}, tick(T, o, holder) {{ … если что-то движется или светится … }} }});
   Реальный масштаб в метрах (ёжик ≈ 0.9 м, стол ≈ 0.75 м), 0 — центр низа, перед смотрит на +z. Всё собрано со всех сторон: автор крутит пропс, сзади не должно быть дыр.
   Мелкие детали — наклейками (P3.sticker с 2D-рисунком) или маленькими P3.box; надписи и экраны — наклейками.{bl}
3. Сними кадры командой (ровно так): node {rp} /rscene/{rel}/prefab.js {_fwd(wd)} --port {docs['port']}
   Получишь element.png — лист 2×2 из четырёх ракурсов (¾ спереди, другой бок, ¾ сзади, другой бок), element_1/3/5/7.png — каждый крупно, и ошибки страницы."""


def trellisfix_spec(docs, params, sysp):
    """«Поправить» у героя, слепленного TRELLIS локально (comfy3d.py): Claude читает пины и заметки, смотрит кадры и подбирает,
    ЧТО перегенерировать и с какими настройками. Саму модель лепит потом задача charmodel (source trellis, mode fix) — без Claude."""
    plan = docs["plan"]
    e = next((x for x in plan.get("elements") or [] if x["id"] == params.get("el")), None)
    if not e:
        raise ValueError("элемент не найден")
    base = next((r for r in e.get("renders") or [] if r.get("id") == params.get("base")), None)
    if not base or base.get("source") != "trellis":
        raise ValueError("править так можно только модель TRELLIS")
    bm = base.get("meta") or {}
    wd = os.path.join(P.resolve("render/" + base["dir"]), "_fix")
    os.makedirs(wd, exist_ok=True)
    fx = ((e.get("fx") or {}).get("main")) or {}
    pins3 = [{"id": p.get("id"), "p": p.get("p"), "n": p.get("n"), "text": (p.get("text") or "").strip()} for p in fx.get("pins3d") or [] if p.get("p")]
    notes = fx_notes(fx)
    ftext = (fx.get("text") or "").strip()
    params["_fx"] = {"text": ftext, "notes": notes, "pins3d": pins3, "pins": []}
    if not (pins3 or notes or ftext):
        raise ValueError("правок нет: поставь пины на модели или напиши «в целом»")
    bd = P.resolve("render/" + base["dir"])
    shots = [os.path.join(bd, f) for f in ("element.png", "pose_up/element.png") if os.path.isfile(os.path.join(bd, f))]
    if pins3 and _prop3_pins(docs, base, wd, pins3):
        shots = [os.path.join(wd, "pins.png")] + shots
    refs = [r for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
    rcopy = {}                                                    # копии рядом: Read за пределами рабочей папки (кириллица, тире в пути) не всегда пускает
    for i, r in enumerate(refs, 1):
        dst = os.path.join(wd, f"ref{i}{os.path.splitext(r['img'])[1].lower() or '.png'}")
        shutil.copy2(P.resolve(r["img"]), dst)
        rcopy[r["img"]] = dst
    lines = [f"- «{t}»" for t in ([ftext] if ftext else []) + [n["text"] for n in notes]]
    lines += [f"- 📍 пин {i}: точка {p['p']} на модели: «{p['text'] or 'автор отметил место без слов — посмотри'}»" for i, p in enumerate(pins3, 1)]
    prompt = f"""{'3D-пропс' if e.get('kind') == 'prop' else 'Герой'} «{e.get('name')}» слеплен локальной нейросетью по картинке (TRELLIS.2 / Pixal3D в ComfyUI). Автор оставил правки к версии v{base.get('v')}:
{chr(10).join(lines)}

Посмотри через Read кадры этой версии: {', '.join(_fwd(x) for x in shots)}{' (pins.png — номера пинов с четырёх сторон, полый кружок — с обратной стороны)' if pins3 else ''}.
Картинки-референсы элемента (через Read; в ответе указывай путь в квадратных скобках): {', '.join(f'{_fwd(rcopy[r["img"]])} [{r["img"]}]' + (f' — «{r["note"]}»' if r.get("note") else '') for r in refs) or 'нет'}.
Текущие настройки: движок {bm.get('engine')}, ступень {bm.get('stage')}, картинка {bm.get('ref')}, ракурсы {json.dumps(bm.get('views') or {}, ensure_ascii=False)},
поля кадра pad {bm.get('pad') or 1.1}, убирать фон {bm.get('bg', True)}, сетка faces {bm.get('faces') or 'по умолчанию'}, текстура tex {bm.get('tex') or 'по умолчанию'}.

Нейросеть нельзя попросить словами — меняются только настройки. Реши, что поможет:
- reseed — какие случайные стадии перегенерировать: structure (силуэт и объём целиком — если форма не та, лишние/слипшиеся части), shape (детали формы при том же силуэте),
  upsample (мелкие детали чистовика), texture (раскраска: пятна, цвета, грязь). Чем меньше стадий — тем больше остаётся как было.
- engine — pixal3d (точнее повторяет картинку спереди), trellis (TRELLIS.2: свободнее достраивает спину и бока), multiview (по 2–4 ракурсам: front/left/back/right — пути files/… из референсов; нужен, если сзади и сбоку модель выдумана неверно, а в референсах есть эти виды).
- ref — другая картинка-референс (путь files/…), если текущая плохая (обрезаны руки, сложный фон, герой не целиком). texref — картинка только для раскраски (форма останется).
- pad 1.0–1.6: больше — если обрезало торчащие части (оружие, уши, хвост). bg false — если фон уже прозрачный и BiRefNet съедает детали.
  ВАЖНО: ref, engine, pad, bg меняют вход нейросети — фигура изменится целиком даже с теми же сидами. Не трогай их, если автор доволен формой и просит только детали или цвет.
  texref — только другая картинка (например, перекрашенный референс); та же картинка, что ref, ничего не даёт — тогда просто reseed texture.
- stage draft (быстро, 512³) или final (1536³, долго) — оставь как было, если автор не просит иначе.
- faces — число треугольников (50000–700000): меньше — проще и легче, больше — детальнее. tex 1024/2048/4096.
Если правка нейросетью невыполнима (например, «сделай улыбку» — лицо меняется только картинкой), так и скажи в reply и предложи, что поменять в референсе.
reply — 1–3 фразы автору по-русски, что и почему меняешь."""
    sch = S({"reply": STR, "reseed": ARR({"type": "string", "enum": ["structure", "shape", "upsample", "texture"]}),
             "engine": {"type": "string", "enum": ["pixal3d", "trellis", "multiview"]}, "stage": {"type": "string", "enum": ["draft", "final"]},
             "ref": STR, "texref": STR, "views": S({k: STR for k in ("front", "left", "back", "right")}),
             "pad": {"type": "number"}, "bg": {"type": "boolean"}, "faces": {"type": "integer"}, "tex": {"type": "integer"}}, ["reply", "reseed"])
    dirs = [bd, wd] + sorted({os.path.dirname(P.resolve(r["img"])) for r in refs})
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 600, "tools": ["Read"], "allowed": ["Read"], "dirs": dirs, "schema": sch}


def libfix_spec(docs, params, sysp):
    """✏️ Правка предмета библиотеки (страница предмета): lib fork -> новая версия, Claude правит её файлы по пинам и заметкам, снимает превью.
    Старые версии не меняются (их держат сцены видео), новая становится основной."""
    import studio_api as SA
    c = SA.channel_dir(params.get("channel"))
    lid, v = params["id"], int(params.get("v") or 0)
    cp, card = SA._card(c, lid)
    v = v or card["latest"]
    base = os.path.join(SA.lib_dir(c), *lid.split("/"), f"v{v}")
    if not os.path.isfile(os.path.join(base, "prefab.js")):
        raise ValueError("у этой версии нет prefab.js — 2D-предметы правятся в препродакшене видео (новой версией оттуда)")
    notes = [n.strip() for n in params.get("notes") or [] if str(n).strip()]
    pins3 = [p for p in params.get("pins3d") or [] if p.get("p")]
    if not (notes or pins3):
        raise ValueError("правок нет: поставь пины на модели или напиши, что поменять")
    fb = "; ".join(notes + [f"📍{i} {p.get('text') or '(смотри место)'}" for i, p in enumerate(pins3, 1)])
    r = SA.fork(docs_A(docs), c, f"{lid}@{v}", "", fb, by="claude")
    wd = r["dir"]
    params.update(_wd=wd, _ref=r["ref"], _fb=fb, _name=card.get("name"))
    kind = lid.split("/")[0]
    shots = []
    if pins3:
        pj = os.path.join(wd, "_fix", "pins.json")
        os.makedirs(os.path.dirname(pj), exist_ok=True)
        json.dump([{"n": i, "p": p["p"]} for i, p in enumerate(pins3, 1)], open(pj, "w", encoding="utf-8"))
        subprocess.run(["node", os.path.join(P.STANDS, "render_prop.js"), f"/api/lib/file/{c['id']}/{lid}/v{v}/prefab.js", os.path.join(wd, "_fix"), "--port", str(docs["port"]), "--pins", pj],
                       capture_output=True, timeout=300)
        if os.path.isfile(os.path.join(wd, "_fix", "pins.png")):
            shots.append(os.path.join(wd, "_fix", "pins.png"))
    for f in ("preview.png", "_shots/element.png"):
        if os.path.isfile(os.path.join(base, f)):
            shots.append(os.path.join(base, f))
    files = sorted(f for f in os.listdir(wd) if os.path.isfile(os.path.join(wd, f)))
    sp = _fwd(os.path.join(P.SERVER, "studio.py"))
    br = _fwd(os.path.join(P.STANDS, "blender_run.py"))
    lines = [f"- «{t}»" for t in notes] + [f"- 📍 пин {i}: точка {p['p']} на модели: «{p.get('text') or 'автор отметил место без слов — посмотри'}»" for i, p in enumerate(pins3, 1)]
    prompt = f"""Правка предмета библиотеки канала: «{card.get('name')}» ({lid}). Это НОВАЯ версия {r['ref']} — копия v{v}, папка {_fwd(wd)} (файлы: {', '.join(files)}).
Правь только файлы в этой папке; старые версии и всё остальное не трогай.

Что просит автор:
{chr(10).join(lines)}

Посмотри через Read прошлую версию: {', '.join(_fwd(x) for x in shots) or 'кадров нет'}{' (pins.png — номера пинов с четырёх сторон, полый кружок — пин с обратной стороны)' if pins3 else ''}.
Как устроен предмет: prefab.js — {'персонаж: character({{…}}) (engine/rig.js), rig.json — суставы и позы' if kind == 'characters' else 'prop3d({{…}}) (engine/props3d.js: фигуры P3.box / cyl / lathe / extrude, наклейки P3.sticker; kind: model — model.glb + detail)'}.
- Есть model.py — это Blender: правь его и пересобери модель: python {br} {_fwd(os.path.join(wd, 'model.py'))}
- Только model.glb (модель из TRELLIS / Meshy / ассета) — форму меняй скриптом Blender: напиши {_fwd(os.path.join(wd, 'fix_model.py'))} (bpy: открыть model.glb, поменять, сохранить
  model.glb рядом с export_yup=True) и запусти: python {br} {_fwd(os.path.join(wd, 'fix_model.py'))}; цвет / размер / мелкие детали проще — в prefab.js (h, detail, наклейки).
  Узлы модели: python {sp} model info {_fwd(os.path.join(wd, 'model.glb'))}
- После правки сними кадры: python {sp} lib preview {r['ref'][4:]} — и посмотри их через Read (папка _shots); поправь, если вышло не так. 2–3 прохода.
Ответь JSON: summary — 1–2 фразы автору, что поменял; note — что проверить."""
    sch = S({"summary": STR, "note": STR}, ["summary"])
    allowed = ["Read", "Edit", "Write", "Grep", "Glob", f"Bash(python {sp}:*)", f"Bash(python {br}:*)"]
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 2400, "tools": ["Read", "Edit", "Write", "Grep", "Glob", "Bash"], "allowed": allowed,
            "dirs": [wd, base, P.ENGINE, P.STANDS], "schema": sch}


def docs_A(docs):
    import ideas_api
    return ideas_api


def charparts_spec(docs, params, sysp):
    """«🦴 Собрать персонажа» (S4): Claude (Opus) рисует персонажа частями на листе и предлагает скелет —
    prefab.js (character({ …, parts: { имя(g) {…} } })) + rig.json (суставы, крепление частей, позы, лица), снимает render_char.js, правит.
    Папка — render/<plan>/<el>/v<N>/ (как черновики). docs/studio/stage4-characters.md §3.2, §4."""
    plan, data = docs["plan"], docs["data"]
    e = next((x for x in plan.get("elements") or [] if x["id"] == params.get("el")), None)
    if not e or e.get("kind") != "char":
        raise ValueError("собрать со скелетом можно только персонажа")
    renders = e.get("renders", [])
    v = max([r.get("v", 0) for r in renders] + [0]) + 1
    rel = f"{plan['id']}/{e['id']}/v{v}"
    wd = P.resolve("render/" + rel)
    os.makedirs(wd, exist_ok=True)
    base = next((r for r in renders if r.get("id") == params.get("base") and r.get("rigchar")), None)
    if base:
        bd = P.resolve("render/" + base["dir"])
        for f in ("prefab.js", "rig.json", "model.py", "model.glb"):
            src = os.path.join(bd, f)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(wd, f))
        if os.path.isdir(os.path.join(bd, "costumes")):
            shutil.copytree(os.path.join(bd, "costumes"), os.path.join(wd, "costumes"), dirs_exist_ok=True)
    params["_wd"], params["_rel"], params["_v"] = wd, rel, v
    slug = re.sub(r"[^a-z0-9-]+", "-", (e.get("slug") or e["id"]).lower()).strip("-") or e["id"]
    if (e.get("make") or params.get("make")) == "blender":       # S9: 3D-персонаж в Blender (model.glb с арматурой) — rig 'model'
        params["_blender"] = True
        return charblender_spec(docs, params, sysp, e, wd, rel, v, slug, base)
    rc = _fwd(os.path.join(P.STANDS, "render_char.js"))
    cmd = f"node {rc} /rscene/{rel}/prefab.js {_fwd(wd)} --port {docs['port']}"
    refs = [(r, P.resolve(r["img"])) for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
    ref_lines = "\n".join(f"- {_fwd(p_)}" + (f" — {r['note']}" if r.get("note") else "") for r, p_ in refs) or "(референсов нет — опирайся на описание)"
    r2 = next((r for r in reversed(renders) if not r.get("rigchar") and r.get("img")), None)
    flat = (f"Персонаж уже нарисован листом (2D): картинка {_fwd(P.resolve(r2['img']))}, код {_fwd(os.path.join(P.resolve('render/' + r2['dir']), 'element.js'))}"
            + (f" (функция {r2['fn']})" if r2.get("fn") else "") + ". Возьми его облик и код рисования, разрежь на части.") if r2 else ""
    fx = ((e.get("fx") or {}).get("main")) or {}
    notes = [n["text"] for n in fx_notes(fx)] + ([fx["text"].strip()] if (fx.get("text") or "").strip() else [])
    params["_fx"] = {"notes": fx_notes(fx), "text": (fx.get("text") or "").strip(), "pins": []} if notes else {}
    edit = ""
    if base:
        edit = f"ПРАВКА. Это версия v{v}; в папке уже лежат prefab.js и rig.json прошлой версии v{base.get('v')} — начни с них, сделай ровно то, что просит автор, остальное сохрани:\n" + "\n".join(f"- «{t}»" for t in notes)
        if base.get("img"):
            edit += f"\nПрошлая версия (лист поз): {_fwd(P.resolve(base['img']))}"
    types = []
    try:
        sd = os.path.join((docs.get("channel") or {}).get("dir") or "", "library", "skeletons")
        for f in sorted(os.listdir(sd)) if sd and os.path.isdir(sd) else []:
            j = json.load(open(os.path.join(sd, f), encoding="utf-8"))
            types.append(f"- {j.get('type')}: {j.get('name', '')} — кости {', '.join(b['id'] for b in j.get('bones', []))} ({_fwd(os.path.join(sd, f))})")
    except Exception:
        pass
    paper = _fwd(os.path.join(P.STANDS, "paper.js"))
    rig = _fwd(os.path.join(P.ENGINE, "rig.js"))
    sample = _fwd(os.path.join(P.STANDS, "samples", "testchar"))
    prompt = f"""Задача: собрать персонажа «{e.get('name', '')}» для роликов канала — нарисовать его ЧАСТЯМИ и предложить СКЕЛЕТ, чтобы его можно было двигать (позы, эмоции, позже анимации).
Описание от автора: {e.get('desc') or '(нет — придумай по названию и идее ролика)'}
Где нужен: {e.get('why') or '—'}

{STYLE}
{ANIM_READY}

Референсы автора (посмотри через Read):
{ref_lines}
{flat}

{preprod.element_brief(e, plan, data)}

{edit}

Типы скелетов, что уже есть в библиотеке канала (если персонаж подходит под тип — возьми ТЕ ЖЕ id костей, тогда анимации типа будут общими):
{chr(10).join(types) or '- hog: наш бумажный ёжик (риг по параметрам drawHog, частей не нужно)'}
ЕСЛИ ЭТО ЁЖИК (наш бумажный ёжик в одежде, с аксессуарами, взрослый, ребёнок, ёжиха) — НЕ режь на части, собери его на скелете ёжика (риг по параметрам drawHog):
   prefab.js: character({{ id: '{slug}', name: '…', skeleton: 'hog', rig: 'param', h: <рост, м; ребёнок ≈ 0.74, взрослый ≈ 0.95>, base: {{ kind: 'adult' | 'kid' | 'friend', legs: 'short' | 'feet', seed: 1 }},
     wear: {{ '<костюм>': true }}, costumes: ['costumes/<костюм>.js'], pose: {{ face: {{ mouth, lid, look }} }}, emotions: {{ 'спокойный': {{ mouth, lid, ok: true }}, … }} }});
   костюм costumes/<костюм>.js: costume({{ id, name, skeleton: 'hog', slot: 'body', layers: {{ body(ctx, st) {{ … в системе тела drawHog: st.S = HOG_PX, ноги в 0, вверх — минус … }}, over(ctx, st) {{ … поверх лап (st.paws) … }}, head(ctx, st) {{ … шляпа, причёска … }} }} }});
   Одежда, причёска, бусы, фартук — слоями костюма; тело, лицо и лапы рисует drawHog (параметры base). Образец — «Ёжик в пижаме»: D:/work/Animations/Доедать будешь/library/characters/ejik-v-pijame/v2/prefab.js и costumes/pijama-mishki.js, kepka.js.
   rig.json не нужен. Кадры — той же командой (ниже); в ответе fn = hog.

Как устроено (прочитай шапку и раздел «риг 'parts'» в {rig}; образец формата — {sample}/prefab.js и rig.json, «гусеница» с гнущимся телом, рукой на булавке и двумя лицами):
1. prefab.js в текущей папке:
   character({{ id: '{slug}', name: '{e.get('name', '')}', skeleton: '<тип>', rig: 'parts', h: <рост в метрах; ёжик ≈ 0.74>, parts: {{ имяЧасти(g) {{ … рисует часть в координатах листа … }}, … }} }});
   Тулкит бумаги (глобальный): {paper} — cut / cutEll / torn / grainOver / circle, цвета и зерно как у нашего ёжика. Каждая часть — своя функция, рисует ТОЛЬКО свою часть на прозрачном листе.
   Части заходят за сустав с запасом (кружок или скругление под соседней частью), чтобы при повороте не было щели; дальние части (задние лапы, хвост) — ниже по z.
2. rig.json: {{ "schema": 1, "type": "<тип латиницей, например cat>", "typeName": "<по-русски>", "mode": "bend" или "pins", "sheet": [1000, 1000], "foot": [x, y — точка между ступнями], "height": <рост на листе, px>,
   "bones": [{{ "id", "parent", "joint": [x, y] — сустав в покое, "end": [x, y] — конец кости (для последних в цепочке), "limits": [мин, макс] радиан }}],
   "parts": [{{ "id": "имяЧасти", "bone": "кость" (часть целиком на кости) или "bones": [цепочка] (гнётся — хвост, тело, уши), "z": порядок, "front": true — только спереди (лицо) }}],
   "slots": {{ "head": "кость головы", "handL": …, "handR": …, "back": … }},
   "face": {{ "base": "частьЛица", "emotions": {{ "радость": "частьЛица2", … }} }}, "emotions": {{ "радость": {{}} , … }},
   "poses": {{ "покой": {{}}, … ещё 4 проверочные позы типа (например «лапы вверх», «шаг», «сидит», «хвост трубой»): {{ "bones": {{ "кость": {{ "rot": радианы (+ по часовой) }} }}, "face": {{ "name": "радость" }} }} }} }}
   Кости: корень root в точке ног; тело, голова, уши, лапы (по кости на сегмент, если лапа должна гнуться), хвост цепочкой из 3 костей. Эмоции-лица: base + радость + удивление + грусть (лица рисуй отдельными частями на кости головы).
3. Сними кадры (ровно так): {cmd}
   element.png — пять проверочных поз с костями, rest.png — покой с костями, clean.png — без костей, emotions.png — лица. Посмотри все через Read:
   части не рвутся и не расходятся в суставах, сгибы гладкие, кости стоят в суставах, позы читаются, лица различимы. Исправь prefab.js / rig.json и сними снова — 2–4 прохода.

В ответе: summary — что нарисовано и какой скелет (2–3 предложения); fn — тип скелета (или hog); note — что автору проверить (какие суставы подвинуть в редакторе скелета)."""
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 2400,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {rc}:*)"],
            "dirs": [wd, P.files(plan["id"]), P.STANDS, P.ENGINE, P.render(plan["id"])], "schema": S({"summary": STR, "fn": STR, "note": STR})}


def charblender_spec(docs, params, sysp, e, wd, rel, v, slug, base):
    """«🦴 со скелетом» для героя в 3D (S9): Claude (Opus) пишет model.py для Blender (меш + арматура + автовеса + материалы + shape keys лица),
    собирает model.glb (blender_run.py), пишет prefab.js character({ rig: 'model', bones: {…} }), снимает поворотный стол и позы (render_prop.js), правит."""
    plan = docs["plan"]
    ch = docs.get("channel") or {}
    br = _fwd(os.path.join(P.STANDS, "blender_run.py"))
    rp = _fwd(os.path.join(P.STANDS, "render_prop.js"))
    url = f"/rscene/{rel}/prefab.js"
    refs = [(r, P.resolve(r["img"])) for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
    ref_lines = "\n".join(f"- {_fwd(p_)}" + (f" — {r['note']}" if r.get("note") else "") for r, p_ in refs) or "(референсов нет — опирайся на описание)"
    guide = ""
    try:
        guide = open(os.path.join(ch.get("dir") or "", "style", "style-guide.md"), encoding="utf-8").read()[:5000]
    except OSError:
        pass
    pal = ""
    try:
        pal = json.dumps(json.load(open(os.path.join(ch.get("dir") or "", "style", "palette.json"), encoding="utf-8")).get("colors") or [], ensure_ascii=False)
    except (OSError, ValueError):
        pass
    fx = ((e.get("fx") or {}).get("main")) or {}
    notes = [n["text"] for n in fx_notes(fx)] + ([fx["text"].strip()] if (fx.get("text") or "").strip() else [])
    params["_fx"] = {"notes": fx_notes(fx), "text": (fx.get("text") or "").strip(), "pins": []} if notes else {}
    edit = ""
    if base:
        edit = (f"ПРАВКА. Это версия v{v}; в папке уже лежат model.py, model.glb и prefab.js прошлой версии v{base.get('v')} — начни с них, сделай ровно то, что просит автор:\n"
                + "\n".join(f"- «{t}»" for t in notes) + (f"\nПрошлая версия (лист): {_fwd(P.resolve(base['img']))}" if base.get("img") else ""))
    prompt = f"""Задача: главный герой канала «{ch.get('name', '')}» — «{e.get('name', '')}» — как 3D-МОДЕЛЬ В BLENDER СО СКЕЛЕТОМ, чтобы его можно было ставить в сцены и двигать (позы, клипы, ходьба, эмоции).
Описание: {e.get('desc') or '—'}

Референсы (посмотри все через Read — силуэт, пропорции, цвета, детали):
{ref_lines}

Стиль канала (начало стайл-гайда) и палитра:
{guide}
Палитра: {pal}

{edit}

Как сделать (рабочая папка — текущая, {_fwd(wd)}):
1. model.py — скрипт bpy (Blender 5.x, пустая сцена; экспорт делает обёртка). ДЕТАЛИЗИРОВАННАЯ модель, как можно ближе к референсам (не «low-poly болванка»):
   силуэт и пропорции референса; органика — сглаженные формы (базовые меши + subdivision 2–3 уровня, затем проминание / раздувание групп вершин под мышцы, скулы, надбровья, нос, губы — bmesh / proportional edit кодом),
   отдельные пальцы с суставами, ногти, клыки, уши с изгибом, причёска прядями (кривые / extrude с сужением), одежда и снаряжение со складками, ремнями, заклёпками, бусинами — всё, что видно на референсах.
   Цвета и рисованный вид: материалы по палитре + цвета вершин (тени в складках, светлее на выступах — по нормалям / ambient occlusion кодом), чтобы смотрелось «нарисованным от руки», как текстуры игры;
   можно запечь в текстуру (bake) — по желанию. Бюджет — до ~150–200 тыс. треугольников. Всё — на одной арматуре (join в один или несколько мешей).
   Арматура «Rig»: root (между ступнями) → hips → spine → chest → neck → head; плечи upper_arm.L/R → forearm.L/R → hand.L/R; ноги thigh.L/R → shin.L/R → foot.L/R; можно jaw, ear.L/R.
   Привязка: parent_set(type='ARMATURE_AUTO'); проверь, что у каждой части есть веса (голова не тянется за рукой). Поза покоя — A-поза (руки вниз под ~35–45°) или T-поза.
   Shape keys лица (по возможности): mouth_open, mouth_o, smile, blink — на меше головы (относительно Basis).
   Низ модели — на z = 0, лицо — к -Y (станет +z, к камере), единицы — метры, рост ~{e.get('h') or '1.9'} м.
2. Собери: python {br} model.py   → model.glb рядом (готово: … размеры). Ошибки — в model.log.
3. prefab.js в этой папке:
   character({{ id: '{slug}', name: '{e.get('name', '')}', skeleton: '<тип скелета латиницей, например troll>', rig: 'model', model: 'model.glb', h: <рост, м>, idle: null,
     bones: {{ root: {{ bone: 'root', axis: 'y' }}, body: {{ bone: 'spine', axis: 'x' }}, head: {{ bone: 'head', axis: 'x' }},
               armL: {{ bone: 'upper_arm.L', axis: 'z', k: …, off: 0 }}, armR: {{ bone: 'upper_arm.R', axis: 'z', k: … }}, forearmL: …, forearmR: …, legL: {{ bone: 'thigh.L', axis: 'x' }}, legR: …, shinL: …, shinR: … }},
     face: {{ mouth: {{ open: 'mouth_open', o: 'mouth_o', smile: 'smile' }}, lid: 'blink' }},
     emotions: {{ 'спокойный': {{ face: {{}} , ok: true }}, 'радость': {{ face: {{ mouth: 'smile' }} }}, 'удивление': {{ face: {{ mouth: 'o' }} }} }},
     pose: {{}} }});
   Поза — как у всех героев студии: bones.<кость>.rot (радианы) поворачивает кость арматуры вокруг axis в осях МОДЕЛИ (x — вправо, y — вверх, z — вперёд к камере) на off + k·rot от покоя.
   Договорённость: armL / armR rot 0 — руки как в покое, +1.2 — рука поднята вбок-вверх (подбери k = ±1 так, чтобы ОБЕ руки поднимались при +), legL / legR + — нога вперёд (шаг), body + — наклон вперёд, head + — кивок вниз.
   Движок — {_fwd(os.path.join(P.ENGINE, 'rig.js'))}: функция modelChar (прочитай её).
4. Кадры (ровно так): node {rp} {url} {_fwd(wd)}            — поворотный стол в покое: element.png (лист 2×2) и element_1/3/5/7.png
   Позы: node {rp} {url} {_fwd(os.path.join(wd, 'pose_up'))} --params '{{"pose": {{"bones": {{"armL": {{"rot": 1.2}}, "armR": {{"rot": 1.2}}}}}}}}'
         node {rp} {url} {_fwd(os.path.join(wd, 'pose_step'))} --params '{{"pose": {{"bones": {{"legL": {{"rot": 0.5}}, "legR": {{"rot": -0.4}}, "armL": {{"rot": -0.3}}, "armR": {{"rot": 0.3}}}}}}}}'
   Посмотри через Read: похоже ли на референсы (силуэт, цвета, клыки, уши, причёска), нет ли дыр и вывернутой геометрии, руки поднимаются обе и по-человечески, сетка не рвётся в суставах.
   Исправь model.py / prefab.js, собери и сними снова — 2–4 прохода.

В ответе: summary — что получилось (2–3 предложения); fn — тип скелета (как skeleton в prefab.js); note — что автору проверить."""
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 3000,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(python {br}:*)", f"Bash(node {rp}:*)"],
            "dirs": [wd, P.files(plan["id"]), P.STANDS, P.ENGINE, P.render(plan["id"])], "schema": S({"summary": STR, "fn": STR, "note": STR})}


def animteach_spec(docs, params, sysp):
    """«+ научить» (S5): Claude (Opus) пишет клип анимации типа скелета по просьбе автора, снимает ленту кадров на персонаже, смотрит, правит.
    Черновик — library/anims/_draft/<job>/anim.json (отдаётся /api/lib/file/…), готовый — library/anims/<type>/<slug>.json (apply)."""
    ch = docs.get("channel") or {}
    lib = os.path.join(ch.get("dir") or "", "library")
    typ = re.sub(r"[^a-z0-9-]", "", params.get("type") or "hog") or "hog"
    wd = os.path.join(lib, "anims", "_draft", params.setdefault("_id", time.strftime("%y%m%d-%H%M%S")))
    os.makedirs(wd, exist_ok=True)
    params["_wd"], params["_type"] = wd, typ
    rel = f"/api/lib/file/{ch.get('id')}/anims/_draft/{params['_id']}"
    char = params.get("char") or ""
    if not char:                                              # персонаж для ленты: первый в библиотеке на этом скелете
        for slug in sorted(os.listdir(os.path.join(lib, "characters"))) if os.path.isdir(os.path.join(lib, "characters")) else []:
            try:
                card = json.load(open(os.path.join(lib, "characters", slug, "character.json"), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            vs = [v for v in card.get("versions") or [] if v.get("skeleton") == typ]
            if vs:
                char = f"/api/lib/file/{ch.get('id')}/characters/{slug}/v{vs[-1]['v']}/prefab.js"
                break
    ra = _fwd(os.path.join(P.STANDS, "render_anim.js"))
    cmd = f"node {ra} {char} {rel}/anim.json {_fwd(wd)} --port {docs['port']}"
    skp = os.path.join(lib, "skeletons", typ + ".json")
    sk = _fwd(skp) if os.path.isfile(skp) else "(нет файла — тип описан в rig.json персонажа)"
    ex = [f for f in sorted(os.listdir(os.path.join(lib, "anims", typ)))] if os.path.isdir(os.path.join(lib, "anims", typ)) else []
    ex_lines = "\n".join(f"- {_fwd(os.path.join(lib, 'anims', typ, f))}" for f in ex if f.endswith(".json")) or "(клипов этого типа пока нет)"
    hog = typ == "hog"
    bones = ("Кости ёжика (риг по параметрам drawHog): armL / armR — rot (0 = лапа вниз вдоль тела, + = к центру и вверх, − = наружу и вверх; −2.9 — над головой), "
             "len (множитель длины лапы, 0.6…1.6); body — rot (наклон всего тела вокруг таза, ±0.25), sq (сжатие, −0.1…0.12); legL / legR — rot (0…1 — подъём ступни стоя, "
             "сидя — качание ноги ±0.3); sit — сидит (true / false). Лицо face: mouth o | flat | smile | sad | open, lid 0…0.8 (0 — распахнуты), brows none | up | angry | sad | worried, "
             "look [x, y] −1…1 (y > 0 — вниз), blink 0…1, tired. IK лапы: ik.armL / ik.armR = [x, y] — цель кончика лапы в долях роста от ног, y вверх "
             "(глаза ≈ [±0.09, 0.6], макушка ≈ [0, 0.95], затылок и темя ≈ [±0.2, 0.85…0.9], нос ≈ [0, 0.54], живот ≈ [0, 0.3]). "
             "Карточка card: y (подскок, м), rz (качнуться, рад), ry (поворот, рад), sy (сплющиться).") if hog else \
            f"Кости и позы типа — в {sk}; значения rot — радианы от покоя (+ по часовой), IK лапы — ik.<кость-плечо> = [x, y] в долях роста от ног, y вверх."
    prompt = f"""Задача: выучить движение для персонажей типа скелета «{typ}» по просьбе автора: «{params.get('ask', '')}».
Клип потом ставят на любого персонажа этого типа (наследование), поэтому только кости, лицо, IK и карточка — без рисунков.

Формат клипа (JSON, запиши в текущую папку anim.json):
{{ "schema": 1, "id": "{typ}/<slug латиницей>", "name": "<по-русски, 1–3 слова>", "type": "{typ}", "dur": <секунды, 0.8–4>, "loop": false (true — только для циклов: ходьба, дыхание),
  "tracks": {{ "<кость>.<rot|len|sq>": [[t, значение, "ease к следующему: io|linear|in|out|hold"], …], "face.<поле>": [[t, значение]], "ik.<лапа>": [[t, [x, y]]], "card.<y|rz|ry|sy>": …, "sit": [[t, true]] }} }}
Ключ — [время от начала клипа, значение, ease]. Значения костей — от позы покоя. Начало и конец — близко к покою (клип плавно входит и выходит, 0.2 с кроссфейд), кроме сознательно другого финала.
{bones}
Ещё раз: движение должно читаться на маленьком бумажном персонаже в кадре 9:16 — крупно, с подготовкой и отыгрышем (замах перед действием, чуть перелёт и возврат), лицо помогает.
Готовые клипы этого типа — образцы формата и стиля (Read):
{ex_lines}

Сними ленту кадров (ровно так): {cmd}
Получишь strip.png — 8 моментов клипа на персонаже. Посмотри через Read: читается ли «{params.get('ask', '')}», нет ли вывернутых лап и дёрганий, хватает ли амплитуды. Исправь anim.json и сними снова — 2–4 прохода.
В ответе: name, slug (латиницей, коротко, через дефис), summary — что делает клип (1–2 предложения), note — что автору проверить."""
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 1500,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {ra}:*)"],
            "dirs": [wd, lib, P.STANDS, P.ENGINE], "schema": S({"name": STR, "slug": STR, "summary": STR, "note": STR})}


def element_spec(docs, params, sysp, genre):
    """«🎨 Сделать» for a preproduction element: Claude writes element.js for the stand (2D page.html, or the 3D stand for a scene
    when the plan's engine is 3d), shoots it with render_shot.js, looks and fixes. Work folder: _ideas/render/<plan>/<element>/v<N>/."""
    plan, data = docs["plan"], docs["data"]
    e = next((x for x in plan.get("elements") or [] if x["id"] == params.get("el")), None)
    if not e:
        raise ValueError("элемент не найден")
    if e.get("kind") not in SHEETS:
        raise ValueError("этот элемент не рисуется — это звук")
    renders = e.get("renders", [])
    v = max([r.get("v", 0) for r in renders] + [0]) + 1
    rel = f"{plan['id']}/{e['id']}/v{v}"
    wd = P.resolve("render/" + rel)
    os.makedirs(wd, exist_ok=True)
    base = next((r for r in renders if r.get("id") == params.get("base")), None)
    prop3 = is_prop3(e, docs.get("channel"))
    params["_prop3"] = prop3
    if base and bool(base.get("three3")) == prop3:          # правка — от прошлого кода того же вида (2D -> 3D начинается с нуля, 2D идёт референсом)
        for f in ("element.js", "prefab.js", "model.py", "model.glb"):
            prev = os.path.join(P.resolve("render/" + base["dir"]), f)
            if os.path.isfile(prev):
                shutil.copy2(prev, os.path.join(wd, f))
    elif base:
        base = None
    params["_wd"], params["_rel"], params["_v"] = wd, rel, v
    fr = e.get("from") or {}
    if params.get("extract") and fr.get("scene"):              # S11 ч.4: предмет, сделанный в редакторе сцены, -> отдельный 3D-пропс
        params["_prop3"], params["_three"] = True, False
        sw = P.resolve(f"render/{plan['id']}/{fr['scene']}/work")
        rp = _fwd(os.path.join(P.STANDS, "render_prop.js"))
        sample = _fwd(os.path.join(P.STANDS, "samples", "crt3d", "prefab.js"))
        prompt = f"""Задача: вынести предмет «{e.get('name')}» из кода сцены в отдельный 3D-пропс препродакшена — чтобы его можно было ставить в другие сцены и положить в библиотеку.
Сейчас он — префаб «{fr.get('prefab')}» в {_fwd(os.path.join(sw, 'prefabs.js'))} (объект {fr.get('obj')} в {_fwd(os.path.join(sw, 'scene.json'))}).
Запиши {_fwd(os.path.join(wd, 'prefab.js'))}: prop3d({{ name, h, params, build(w, o) {{ … return G; }} }}) — формат и пример: {_fwd(os.path.join(P.DOCS, 'studio', 'stage3-props.md'))}, {sample}.
- Перенеси код рисования этого предмета (и только нужные ему функции и константы) как есть; всё — внутри файла, без глобальных имён, которые могут столкнуться
  с другими prefab.js (оберни помощников в объект или замыкание). 0 — центр низа, перед смотрит на +z: если префаб строился «по месту» (home), сдвинь к началу координат.
- Карточка (kind 'card', 2D-рисунок) -> P3.sticker / тонкая коробка с наклейкой; коробка (kind 'box') -> P3.box с гранями-наклейками; group — как есть внутри build.
- params префаба — в params; каналы (channels), если были, — тоже.
Проверь: node {rp} /rscene/{rel}/prefab.js {_fwd(wd)} --port {docs['port']} — 4 ракурса и лист element.png; посмотри через Read, поправь, если не похоже на предмет в сцене.
В ответе: summary — что вынесено и что поменялось; fn — пусто; note — что автору проверить."""
        sysp_x = "Ты — технический художник Claude Studio: выносишь предметы бумажной 3D-анимации из кода сцены в отдельные пропсы, не меняя их вид. Отвечай строго JSON по схеме."
        dirs = [d for d in (wd, sw, P.STANDS, os.path.join(P.DOCS, "studio"), P.ENGINE) if os.path.isdir(d)]
        return {"system": sysp_x, "prompt": prompt, "cwd": wd, "timeout": 2400,
                "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {rp}:*)"],
                "dirs": dirs, "schema": S({"summary": STR, "fn": STR, "note": STR})}
    three = e.get("kind") == "scene" and plan.get("engine") == "3d"
    params["_three"] = three
    shot = _fwd(os.path.join(P.STANDS, "render_shot.js"))
    paper = _fwd(os.path.join(P.STANDS, "paper.js"))
    stand = "tpl/stand3d.html" if three else "render/page.html"
    url = f"http://127.0.0.1:{docs['port']}/{stand}?scene=/rscene/{rel}/element.js&parts=element"
    cmd = f'node {shot} "{url}" {_fwd(wd)} {"0.2,2.5" if three else "1.5"}'
    what, sheet, fn = SHEETS[e["kind"]]
    refs = [(r, P.resolve(r["img"])) for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
    ref_lines = "\n".join(f"- '/{r['img']}' (файл {_fwd(p)})" + (f" — {r['note']}" if r.get("note") else "") for r, p in refs) or "(автор референсов не дал — опирайся на описание и узнаваемую конкретику)"
    own = preprod.assets_brief(e, data, three or prop3)
    flat = ""
    if prop3 and not base:
        r2 = next((r for r in reversed(renders) if not r.get("three3") and r.get("img")), None)
        if r2:
            flat = (f"Этот пропс уже нарисован в 2D{' и утверждён автором' if e.get('status') == 'ok' else ''}: картинка {_fwd(P.resolve(r2['img']))}, код {_fwd(os.path.join(P.resolve('render/' + r2['dir']), 'element.js'))}"
                    + (f" (функция {r2['fn']})" if r2.get("fn") else "") + ". Сделай его объёмным: та же форма, цвета и узнаваемые детали; "
                    "рисунки деталей (экран, логотип, кнопки, надписи) можно взять из этого кода в наклейки P3.sticker.")
    # a scene is assembled from its characters and props (uses): their drafts and code go in first
    cast = preprod.cast_of(e, plan) if e.get("kind") == "scene" else []
    inside = []
    for x, via in cast:
        rs = x.get("renders") or []
        r = next((y for y in rs if y.get("id") == x.get("render")), rs[-1] if rs else None)
        line = f"- {KINDS.get(x.get('kind'), '')} @[{x.get('name', '')}] — {x.get('desc') or 'без описания'}" + (" (утверждён автором)" if x.get("status") == "ok" else "")             + (" (автор отметил через @ в тексте сцены)" if via == "@" else "")
        if r:
            line += (f"\n  черновик {_fwd(P.resolve(r['img']))}, код {_fwd(os.path.join(P.resolve('render/' + r['dir']), 'element.js'))}"
                     + (f", функция {r['fn']}" if r.get("fn") else ""))
        else:
            refs_x = [_fwd(P.resolve(rr["img"])) for rr in x.get("refs") or [] if rr.get("img")]
            line += "\n  черновика ещё нет — нарисуй по описанию" + (" и референсам: " + ", ".join(refs_x) if refs_x else "")
        ab = preprod.assets_brief(x, data, three, "  ")
        if ab:
            line += "\n  ассеты, которые автор взял для него в работу (модель можно поставить вместо карточки):\n" + ab
        inside.append(line)
    # other drawn elements of this plan: their code can be reused (the hog in the right outfit, a prop inside a scene…)
    done = []
    for x in plan.get("elements") or []:
        rs = x.get("renders") or []
        r = next((y for y in rs if y.get("id") == x.get("render")), rs[-1] if rs else None)
        if x["id"] != e["id"] and x["id"] not in {c["id"] for c, _ in cast} and r and x.get("status") != "drop":
            done.append(f"- {KINDS.get(x.get('kind'), '')} «{x.get('name', '')}»: код {_fwd(os.path.join(P.resolve('render/' + r['dir']), 'element.js'))}"
                        + (f", функция {r['fn']}" if r.get("fn") else "") + (" (утверждён автором)" if x.get("status") == "ok" else ""))
    fx = ((e.get("fx") or {}).get("main")) or {}
    pins = [{"id": p.get("id"), "x": float(p.get("x") or 0), "y": float(p.get("y") or 0), "text": (p.get("text") or "").strip()} for p in fx.get("pins") or []]
    ftext = (fx.get("text") or "").strip()
    fnotes = fx_notes(fx)
    pins3 = [{"id": p.get("id"), "p": p.get("p"), "n": p.get("n"), "text": (p.get("text") or "").strip()} for p in fx.get("pins3d") or [] if p.get("p")] if prop3 else []
    if prop3:
        pins = []
    params["_fx"] = {"text": ftext, "pins": pins, "notes": fnotes, "pins3d": pins3} if (ftext or pins or fnotes or pins3) else {}
    edit = ""
    if base and params["_fx"]:
        lines = [f"ПРАВКА. Это новая версия v{v}. В папке уже лежит element.js прошлой версии v{base.get('v')} — начни с него, исправь ровно то, что просит автор, остальное сохрани."]
        for t in ([ftext] if ftext else []) + [n["text"] for n in fnotes]:
            lines.append(f"- в целом: «{t}»")
        for i, p in enumerate(pins, 1):
            lines.append(f"- пин {i} (x≈{round(p['x'] * 1080)}, y≈{round(p['y'] * 1920)} из 1080×1920): «{p['text'] or 'автор отметил это место без слов — посмотри, что там не так'}»")
        src = P.resolve(base.get("img") or "")
        dst = os.path.join(wd, "pins.png")
        if pins and base.get("img") and os.path.isfile(src) and mark_pins(src, dst, pins):
            lines.append(f"Прошлая версия с номерами пинов: {_fwd(dst)} — посмотри через Read.")
        for i, p in enumerate(pins3, 1):
            lines.append(f"- 📍 пин {i} на модели, точка {p['p']} (м, координаты пропса; нормаль {p.get('n')}): «{p['text'] or 'автор отметил это место без слов — посмотри, что там не так'}»")
        if pins3 and _prop3_pins(docs, base, wd, pins3):
            lines.append(f"Прошлая версия с номерами пинов с четырёх сторон: {_fwd(dst)} (лист) и pins_1/3/5/7.png крупно — посмотри через Read. Полый кружок — пин с обратной стороны.")
        edit = "\n".join(lines)
    try:
        has_lay = "// ==== расстановка автора" in open(os.path.join(wd, "element.js"), encoding="utf-8").read()
    except OSError:
        has_lay = False
    if has_lay:
        edit += ("\nВ конце element.js — блок «// ==== расстановка автора» (w.groups — группы, w.layout — сдвиги): автор сам группировал и двигал объекты в 3D-просмотре. Это его решение: "
                 "оставь блок в конце файла как есть и не меняй имена объектов (name), на которые он ссылается. Если в блоке есть имена без name в коде "
                 "(«карточка 3», «коробка 2» — по порядку создания), допиши этим объектам name: '…' ровно как в блоке, иначе после правок имена съедут. "
                 "Автоматические группы («spruce 12», «группа 3») собираются сами из безымянных объектов, созданных подряд на одном месте, — не меняй порядок их создания или собери их части в THREE.Group с этим именем (w.add(group, pos, 'spruce 12')). "
                 "Если правка автора — переставить что-то ещё, можно вписать сдвиг прямо в координаты кода и убрать этот ключ из блока.")
    if prop3:
        engine = prop3_engine(docs, e, rel, wd, P.blender())
    elif three:
        ex = _example_3d(docs["root"])
        engine = f"""Движок — 3D (stage3d.js шаблона, three.js): картонная диорама в духе Paper Mario + свет и пост-эффекты Octopath.
1. Прочитай шапку {_fwd(os.path.join(P.ENGINE, 'stage3d.js'))} (API мира: card, box, plane, lamp, sun, ambient, motes, shaft, glow, camKeys; герои hogCard, spriteCard; грабли) и {_fwd(os.path.join(P.ENGINE, 'moves3d.js'))}.
   Примеры целых миров: {'; '.join(f'{_fwd(p)} — {w}' for p, w in ex) or '(нет)'}. Бумажный тулкит для текстур карточек и drawHog: {paper}.
2. Запиши в текущую папку файл element.js (только его):
   const PICS = {{ r1: '/files/…png' }};          // если нужны картинки (spriteCard / текстуры) -> IMG.r1
   const MODELS = {{ m1: '/files/…/x.glb' }};      // только если автор взял 3D-модели в работу (список ниже) -> w.model('m1', {{ h, pos, name, matte: true }})
   const WORLD = world3d({{ fx: 'night'|'dusk'|'day', build(w) {{ … }}, update(w, lt, D, T) {{ … медленный проезд камеры w.camKeys … }} }});
   const ELEMENT = {{ t: 0.6, len: 6, draw(ctx, T) {{ WORLD.draw(ctx, T, 4, T); }} }};   // len — длина петли: автор смотрит сцену живьём и крутит камеру мышью, так что сцена должна быть собрана со всех сторон, без дыр сзади и сбоку
   Локация — отдельной функцией build (например buildReception(w, o)), чтобы её можно было перенести в ролик. Ёжик — hogCard для масштаба.
   Персонажи и пропсы сцены — картонные карточки: w.card({{ name: 'Название', px: [512, 768], h: 1.2, pos: [x, 0, z], rim: 7, draw: (g, cw, ch, lt, T) => drawX(g, cw / 2, ch - 10, ch * 0.9, {{ t: T }}) }}), где drawX — их функция из element.js (скопируй её к себе); наш ёжик — hogCard.
   Имена: автор может переставлять объекты в 3D-просмотре («✋ Двигать»), поэтому каждому отдельному предмету (card, box, lamp, model, hogCard, spriteCard) дай name — для элементов препродакшена их название как в списке («Лифт»), остальным — короткое по-русски («Скамейка слева»). Предмет из нескольких частей (ель из двух карточек, стеллаж с вещами) — собери в THREE.Group и добавь w.add(group, [x, y, z], 'Ель слева'): тогда он двигается целиком. Пол, небо и стены — без name. Двигающиеся объекты позиционируй в update() от своей базовой точки — расстановка автора ляжет поверх.
3. Отрисуй командой (ровно так): {cmd}
   Получишь element.png (T=0.6), element_0.2.png и element_2.5.png (движение камеры) и ошибки страницы, если есть."""
    else:
        engine = f"""Движок — 2D, бумажный тулкит канала.
1. Прочитай тулкит {paper}: cut/cutRect/cutEll/torn, paperBG, desk, photo, sticker, note, label, scrawl, stamp, light, tint, flakes, popIn,
   drawHog(ctx, x, yНог, рост, {{kind: 'adult'|'kid'|'friend', look, lid, mouth, armL, armR, lenL, lenR, hoodie, cap, glasses, prop, walk, backView, t}}) и aim.
   Хелперы lib.js глобальные: W=1080, H=1920, TAU, lerp, remap, clamp, E.*, rng, rr, circle, font(size, weight), vgrad, radial, imgFit.
2. Запиши в текущую папку файл element.js (только его):
   const PICS = {{ r1: '/files/…png' }};          // если нужны картинки автора как вырезки (photo / sticker) -> IMG.r1
   {fn}
   const ELEMENT = {{ t: 0.6, draw(ctx, T) {{ … }} }};   // {sheet}
   Сам элемент — отдельной функцией (имя по-английски в camelCase, например drawLiftPanel), ELEMENT.draw только раскладывает лист.
3. Отрисуй командой (ровно так): {cmd}
   Получишь element.png (T=0.6), element_1.5.png и ошибки страницы, если есть."""
    prompt = f"""Задача: нарисовать черновик {what} для препродакшена ролика — «{e.get('name', '')}».
Описание от автора: {e.get('desc') or '(нет — придумай по названию и идее ролика)'}
Где нужен в ролике: {e.get('why') or '—'}

{STYLE}
{ANIM_READY}

Референсы автора — посмотри их через Read и возьми узнаваемое (форму, цвета, детали, надписи), переводя в наш бумажный стиль, а не копируя фото:
{ref_lines}

{flat}

{('Бесплатные ассеты, которые автор нашёл и взял в работу для этого элемента — используй их (переводя в наш бумажный стиль), а не рисуй то же самое заново; лицензии уже записаны:' + chr(10) + own) if own else ''}

{('В этой сцене стоят (обязательно размести их, узнаваемо и в масштабе; готовый код — скопируй функцию из их element.js к себе и вызови, не рисуй заново):' + chr(10) + chr(10).join(inside)) if inside else ''}

{('Уже нарисованные элементы этого ролика — можно брать их код (Read) и держать общий стиль и палитру:' + chr(10) + chr(10).join(done)) if done else ''}

{preprod.element_brief(e, plan, data)}

Идея ролика: {(idea_of(plan) or {}).get('text', '')}

{edit}

{engine}
4. Посмотри PNG через Read, сравни с описанием и референсами, исправь {'prefab.js (и model.py)' if prop3 else 'element.js'} и отрисуй снова. 2–4 прохода, пока не станет хорошо.

Правила: читается за секунду; узнаваемая конкретика важнее общих форм; без белых дыр по краям; все подпути одной фигуры — по часовой стрелке (правило nonzero).
Жанр: {GENRE[genre]}

В ответе: summary — что нарисовано и какие решения (2–3 предложения); fn — {'способ: shapes, model или blender' if prop3 else 'имя главной функции элемента (или функции build для 3D)'}; note — что автору стоит проверить или решить."""
    dirs = [wd, P.files(plan["id"]), P.STANDS, P.render(plan["id"])]
    if three or prop3:
        dirs += [P.ENGINE] + ([os.path.dirname(p) for p, _ in _example_3d(docs["root"])] if three else [])
    allowed = ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {shot}:*)"]
    if prop3:
        allowed = ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {_fwd(os.path.join(P.STANDS, 'render_prop.js'))}:*)"]
        if P.blender():
            allowed.append(f"Bash(python {_fwd(os.path.join(P.STANDS, 'blender_run.py'))}:*)")
    return {"system": sysp, "prompt": prompt, "cwd": wd, "timeout": 2400 if prop3 else 1800,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], "allowed": allowed,
            "dirs": dirs, "schema": S({"summary": STR, "fn": STR, "note": STR})}


def assets_spec(docs, params, sysp):
    """«✨ Подобрать ассеты»: Claude searches the free catalogs with assets.py and returns 3–6 picks with a reason;
    apply() resolves them to full search rows and keeps them as suggestions (e.picks) — the author takes them with 📌 / ⬇."""
    plan = docs["plan"]
    e = next((x for x in plan.get("elements") or [] if x["id"] == params.get("el")), None)
    if not e:
        raise ValueError("элемент не найден")
    py = _fwd(sys.executable)
    ast = _fwd(os.path.join(docs["here"], "assets.py"))
    three = plan.get("engine") == "3d"
    have = "\n".join(f"- в работе: «{a.get('title', '')}» ({a.get('src')}, {a.get('kind')})" + (f" — автор: {a['why']}" if a.get("why") else "") for a in e.get("assets") or [])
    have += "\n" + "\n".join(f"- уже предлагал: «{p.get('title', '')}» ({p.get('src')}:{p.get('id')})" for p in e.get("picks") or [])
    refs = "\n".join(f"- референс автора: {r.get('note') or '(без подписи)'}" for r in e.get("refs") or [] if r.get("img"))
    cast = ""
    if e.get("kind") == "scene":
        cast = "В сцене стоят: " + (", ".join(f"{KINDS.get(x.get('kind'), '')} «{x.get('name', '')}»" + (" (есть черновик)" if preprod.el_render(x) else "")
                                              for x, _ in preprod.cast_of(e, plan)) or "(состав не задан)")
    ask = (e.get("aask") or "").strip()
    target = ("3D-диорама (stage3d: картонные карточки + low-poly модели glTF, матовый бумажный вид)" if three and e.get("kind") == "scene"
              else "3D-ролик: у персонажей и пропсов черновик рисуется 2D-карточкой, но в сцену может встать и 3D-модель" if three
              else "2D бумажная аппликация: фото и рисунки — вырезками или как образец для перерисовки")
    prompt = f"""Шаг «Ассеты для препродакшена». Подбери бесплатные ассеты для элемента: {KINDS.get(e.get('kind'), '')} «{e.get('name', '')}» — {e.get('desc') or '(описания нет)'}.
Где в ролике: {e.get('why') or '—'}
Движок ролика: {target}.
{('Автор уточняет, что нужно (главное): «' + ask + '»') if ask else ''}
{cast}
{refs}
Уже есть (не повторяй):
{have.strip() or '(пока ничего)'}

{preprod.element_brief(e, plan, docs["data"])}

Ищи командой (запросы — по-английски: синонимы, конкретнее, шире; в одной команде можно несколько запросов одного kind):
   {py} {ast} search "<запрос 1>" "<запрос 2>" --kind 3d|2d|tex --n 8
Запускай её ровно в таком виде: полный путь к python и assets.py, без переменных, циклов, ; и && — иначе команду не пропустят. Разные kind — разными командами, можно параллельно.
kind: 3d — модели (Poly Pizza, Poly Haven, Sketchfab, OpenGameArt), 2d — фото и рисунки (Openverse, Commons, OpenGameArt), tex — текстуры (ambientCG, Poly Haven).
Получишь JSON: src, id, title, license, author, dl (можно ли скачать), note. Для сцены ищи и её предметы по отдельности (мебель, техника, машины, вывески), и поверхности (пол, стены).
Выбери 3–6 лучших. Критерии: узнаваемо то самое (форма, эпоха, детали из описания и референсов); для 3D — low-poly и простые формы лучше фотореализма (так они ложатся в бумажную диораму), Poly Pizza обычно лучший выбор;
лицензия CC0 лучше CC-BY, NC и неизвестные — только если нет другого (скажи в why); dl=false — только как референс.
picks: src и id — ровно как в JSON search, query и kind — запрос, которым нашёл (по нему ассет найдут снова), title — как в JSON,
use — work (можно брать в ролик как есть) или ref (только как образец для перерисовки), why — по-русски, одной фразой: почему он и что с ним сделать («стул как есть, покрасить в серый», «только форма кабины»)."""
    return {"system": sysp, "prompt": prompt, "timeout": 900,
            "tools": ["Bash"], "allowed": [f"Bash({py} {ast} search:*)"],
            "schema": S({"picks": ARR(S({"src": STR, "id": STR, "query": STR, "kind": {"type": "string", "enum": ["3d", "2d", "tex"]}, "title": STR,
                                         "use": {"type": "string", "enum": ["work", "ref"]}, "why": STR}, ["src", "id", "query", "kind", "why"]))})}


def sound_spec(docs, params, sysp):
    """«✨ Подобрать звук»: Claude searches with sounds.py (library, Freesound, Commons) and the web, returns 3–5 candidates;
    apply() downloads them into the element."""
    plan = docs["plan"]
    e = next((x for x in plan.get("elements") or [] if x["id"] == params.get("el")), None)
    if not e:
        raise ValueError("элемент не найден")
    py = _fwd(sys.executable)
    snd = _fwd(os.path.join(docs["here"], "sounds.py"))
    inmix = {m["sid"]: (n, m) for n, m in enumerate(preprod.el_mix(e), 1)}
    have = "\n".join(f"- «{s.get('title', '')}» {s.get('url') or ''}"
                     + (f" ← в миксе автора, слой {inmix[s['id']][0]}" + (f": {inmix[s['id']][1]['note']}" if inmix[s['id']][1].get('note') else "") if s["id"] in inmix else "")
                     for s in e.get("sounds") or []) or "(пока ничего)"
    ask = (e.get("ask") or "").strip()
    brief = preprod.element_brief(e, plan, docs["data"])
    mixnote = (e.get("mixNote") or "").strip()
    prompt = f"""Шаг «Звук для ролика». Нужен звук «{e.get('name', '')}» — {e.get('desc') or '(описания нет)'}.
Где в ролике: {e.get('why') or '—'}
{('Автор уточняет, какой нужен (главное): «' + ask + '»') if ask else ''}
Уже скачаны (не повторяй):
{have}
{('Как автор хочет свести слои: «' + mixnote + '» — если нужен недостающий слой, ищи именно его.') if mixnote else ''}
{brief}

Найди 3–5 лучших кандидатов.
1. Сначала библиотека пайплайна и открытые базы: запускай
   {py} {snd} search "<английский запрос>"
   Можно несколько раз с разными запросами (синонимы, точнее, шире{', например: ' + e['q'] if e.get('q') else ''}). Получишь JSON: url — что качать, page, dur (с), license, tags.
2. Если там нет подходящего — поищи в интернете (WebSearch / WebFetch): Freesound, Wikimedia Commons, YouTube (звуки и эмбиенты), myinstants для мемов.
   Для YouTube и длинных записей укажи start и end (секунды) — кусок с нужным звуком, если его можно понять по описанию или таймкодам; иначе оставь пустыми.
Выбирай по названию, описанию и длительности: акцент — короткий (до 3 с); эмбиент — 10–60 с ровного фона без речи и музыки; музыка — трек без слов в нужном настроении.
Лицензии: библиотека пайплайна и CC0 лучше, чем Attribution; NC и неизвестные — только если нет другого, тогда скажи об этом в why.
candidates — url ровно такой, какой вернул search (или ссылка на страницу / видео), title — понятное название звука, why — почему он (1 фраза),
start/end — числа или null; page, license, author — перепиши из результата search, если они там были."""
    return {"system": sysp, "prompt": prompt, "timeout": 900,
            "tools": ["WebSearch", "WebFetch", "Bash"], "allowed": ["WebSearch", "WebFetch", f"Bash({py} {snd} search:*)"],
            "schema": S({"candidates": ARR(S({"url": STR, "title": STR, "why": STR, "start": {"type": ["number", "null"]}, "end": {"type": ["number", "null"]},
                                              "page": STR, "license": STR, "author": STR}, ["url", "title", "why"]))})}


def apply(action, docs, params, res):
    plan, key = docs.get("plan"), docs.get("key")
    t = int(time.time() * 1000)

    if action == "ideas":
        seen = {norm(i["text"]) for i in plan.get("ideas", [])}
        ops = []
        for i in res.get("ideas", []):
            if i.get("text") and norm(i["text"]) not in seen:
                seen.add(norm(i["text"]))
                ops.append({"op": "add", "path": ["ideas"], "item": {"id": nid("i"), "text": i["text"].strip(), "why": i.get("why", ""),
                                                                    "src": i.get("src", ""), "date": i.get("date", ""), "star": False, "by": "claude"}})
        return [(key, ops)], f"Claude: +{len(ops)} идей"

    if action == "bank":
        auto = bool(params.get("auto"))
        items = docs["bank"]["items"]
        seen = {norm(i.get("title")) for i in items} | {norm(i.get("src")) for i in items if i.get("src")}
        ops = []
        for i in res.get("ideas", []):
            src = (i.get("src") or "").strip()
            if i.get("title") and norm(i["title"]) not in seen and not (src and norm(src) in seen):
                seen.update({norm(i["title"]), norm(src)} if src else {norm(i["title"])})
                ops.append({"op": "add", "path": ["items"], "item": {
                    "id": nid("k"), "title": i["title"].strip(), "desc": i.get("desc", ""), "mode": i.get("mode", "any"),
                    "cool": max(1, min(3, int(i.get("cool") or 1))), "speed": max(1, min(3, int(i.get("speed") or 2))),
                    "fresh": i.get("fresh", ""), "src": src, "status": "new", "by": "claude", "auto": auto, "created": t}})
        summary = f"Claude: +{len(ops)} идей в банк" + (" из новостей" if auto else "")
        if auto:
            ops += [{"op": "set", "path": ["auto", "last"], "value": t},
                    {"op": "set", "path": ["auto", "summary"], "value": f"+{len(ops)} новых идей"}]
        return [("bank", ops)], summary

    if action == "beats":
        seen = {norm(b.get("q", "") + b.get("a", "")) for b in plan.get("beats", [])}
        ops = []
        for b in res.get("beats", []):
            if (b.get("q") or b.get("a")) and norm(b.get("q", "") + b.get("a", "")) not in seen:
                ops.append({"op": "add", "path": ["beats"], "item": {"id": nid("b"), "q": b.get("q", ""), "a": b.get("a", ""),
                                                                    "src": b.get("src", ""), "keep": True, "by": "claude"}})
        return [(key, ops)], f"Claude: +{len(ops)} битов"

    if action == "q7":
        q7 = plan.get("q7") or {}
        ops = [{"op": "set", "path": ["q7", k], "value": v.strip()} for k, v in res.items()
               if isinstance(v, str) and v.strip() and not (q7.get(k) or "").strip()]
        return [(key, ops)], (f"Claude заполнил пустые ответы: {len(ops)}" if ops else "Все ответы уже заполнены — ничего не менял")

    if action == "meanings":
        seen = {norm(m["text"]) for m in plan.get("meanings", [])}
        ops = []
        for m in res.get("meanings", []):
            if m.get("text") and norm(m["text"]) not in seen:
                seen.add(norm(m["text"]))
                ops.append({"op": "add", "path": ["meanings"], "item": {"id": nid("m"), "text": m["text"].strip(),
                                                                       "mark": "must" if m.get("must") else "", "by": "claude"}})
        return [(key, ops)], f"Claude: +{len(ops)} смыслов"

    if action == "titles":
        seen = {norm(x.get("text")) for x in plan.get("titles", [])}
        ops = []
        for x in res.get("titles", []):
            if x.get("text") and norm(x["text"]) not in seen:
                seen.add(norm(x["text"]))
                ops.append({"op": "add", "path": ["titles"], "item": {"id": nid("t"), "angle": x.get("angle", "image"), "text": x["text"].strip(),
                                                                     "words": x.get("words", []), "star": False, "by": "claude"}})
        return [(key, ops)], f"Claude: +{len(ops)} названий"

    if action == "strengthen":
        return [], "Claude предложил варианты"

    if action == "images":
        have = {(g.get("meaning"), g.get("slot")): g for g in plan.get("images", [])}
        mids = {m["id"] for m in plan.get("meanings", [])}
        ops, n = [], 0
        for row in res.get("images", []):
            mid = (row.get("meaning") or "").strip("[] ")
            if mid not in mids:
                continue
            opts = [o for o in row.get("options", []) if o]
            for slot in range(3):
                g = have.get((mid, slot))
                if g and (g.get("text") or g.get("img")):
                    continue
                if not opts:
                    break
                txt = opts.pop(0)
                if g:
                    ops.append({"op": "set", "path": ["images", g["id"], "text"], "value": txt})
                else:
                    ops.append({"op": "add", "path": ["images"], "item": {"id": nid("g"), "meaning": mid, "slot": slot, "text": txt, "img": "", "by": "claude"}})
                n += 1
        return [(key, ops)], f"Claude: +{n} образов"

    if action == "thumbs":
        ops = [{"op": "add", "path": ["thumbs"], "item": {
            "id": nid("c"), "title": params.get("title"), "desc": c.get("desc", ""), "type": c.get("type", ""),
            "n": int(c.get("n") or 0) or None, "text": c.get("text", ""), "hook": c.get("hook", ""), "frame": c.get("frame", ""),
            "img": "", "by": "claude"}} for c in res.get("thumbs", []) if c.get("desc")]
        return [(key, ops)], f"Claude: +{len(ops)} концептов"

    if action == "packtext":
        import pack_api
        rs = pack_api.rights(plan)
        old = plan.get("pack") or {}
        pack = {**old, **{k: res.get(k) for k in ("titles", "short", "sources", "provoke", "pin", "tags")},
                "rights_md": (res.get("rights") or "").strip() + "\n\n" + pack_api.rights_md(rs), "rights": rs, "at": t}
        return [(key, [{"op": "set", "path": ["pack"], "value": pack}])], f"Упаковка: {len(res.get('titles') or [])} названий, описания, хэштеги, права"
    if action == "critique":
        cid = params.get("thumb")
        c = next((x for x in plan.get("thumbs", []) if x["id"] == cid), None)
        if not c:
            return [], "Концепт уже удалён"
        ops = [{"op": "set", "path": ["thumbs", cid, "critique"], "value": {"verdict": res.get("verdict"), "points": res.get("points", []),
                                                                            "type": res.get("type"), "at": t}}]
        if not c.get("type") and res.get("type"):
            ops.append({"op": "set", "path": ["thumbs", cid, "type"], "value": res["type"]})
        return [(key, ops)], "Claude разобрал концепт"

    if action == "structure":
        valid = {b["id"] for b in plan.get("beats", [])}
        _, rows = slots_of(plan)
        keys = {r["key"] for r in rows}
        slots, notes, used = {}, dict((plan.get("structure") or {}).get("notes") or {}), set()
        for s in res.get("slots", []):
            if s.get("key") not in keys:
                continue
            ids = [b for b in s.get("beats", []) if b in valid and b not in used]
            used.update(ids)
            slots[s["key"]] = ids
            if s.get("note"):
                notes[s["key"]] = s["note"]
        return [(key, [{"op": "set", "path": ["structure", "slots"], "value": slots},
                       {"op": "set", "path": ["structure", "notes"], "value": notes}])], \
            f"Claude разложил {len(used)} битов по {sum(1 for v in slots.values() if v)} слотам"

    if action == "conclusions":
        m, cp = params.get("mode") or "short", str(params.get("cp") or "1")
        verdicts = {"continue": "✅ продолжаем", "adjust": "🔧 корректируемся", "stop": "⛔ меняем гипотезу", "early": "⏳ рано судить"}
        text = "\n".join("• " + p for p in res.get("points", [])) + f"\n\nВывод: {verdicts.get(res.get('verdict'), res.get('verdict'))}"
        cur = ((docs["stats"].get("conclusions") or {}).get(m) or {}).get(cp, "")
        if cur.strip():
            return [], "Вывод уже написан — вариант Claude показан рядом"
        return [("stats", [{"op": "set", "path": ["conclusions", m, cp], "value": text}])], "Claude написал выводы"

    if action == "render":
        wd, rel, v = params["_wd"], params["_rel"], params["_v"]
        need = [os.path.join(wd, f) for f in ("cover.png", "frame.png")]
        if not all(os.path.isfile(f) for f in need):
            raise RuntimeError("Claude не довёл отрисовку до PNG — попробуй ещё раз или уточни описание")
        cid = params["thumb"]
        c = next((x for x in plan.get("thumbs", []) if x["id"] == cid), None)
        if not c:
            return [], "Концепт уже удалён"
        cover, frame = (docs["save"](plan["id"], open(f, "rb").read()) for f in need)
        rid = nid("r")
        fb, fxs = (params.get("feedback") or "").strip(), params.get("_fx") or {}
        item = {"id": rid, "v": v, "dir": rel, "cover": cover, "frame": frame, "feedback": fx_text(fb, fxs), "fx": fxs,
                "summary": res.get("summary", ""), "coverNote": res.get("cover", ""), "frameNote": res.get("frame", ""), "ts": t}
        ops = [{"op": "add", "path": ["thumbs", cid, "renders"], "item": item},
               {"op": "set", "path": ["thumbs", cid, "render"], "value": rid},
               {"op": "set", "path": ["thumbs", cid, "fb"], "value": ""}]
        # clear only what was sent: pins added while Claude was drawing stay for the next round
        cur = c.get("fx") or {}
        for part, e in fxs.items():
            ops += [{"op": "del", "path": ["thumbs", cid, "fx", part, "pins"], "id": p["id"]} for p in e["pins"] if p.get("id")]
            ops += [{"op": "del", "path": ["thumbs", cid, "fx", part, "notes"], "id": n["id"]} for n in e.get("notes") or [] if n.get("id")]
            if e["text"] and ((cur.get(part) or {}).get("text") or "").strip() == e["text"]:
                ops.append({"op": "set", "path": ["thumbs", cid, "fx", part, "text"], "value": ""})
        return [(key, ops)], f"Claude отрисовал версию v{v}"

    if action in ("questions", "challenge"):
        qa = plan.get("qa") or []
        rnd = max([int(q.get("round") or 1) for q in qa] + [0]) + 1
        seen = {norm(q.get("q")) for q in qa}
        ops = []
        for q in res.get("questions", []):
            if q.get("q") and norm(q["q"]) not in seen:
                seen.add(norm(q["q"]))
                ops.append({"op": "add", "path": ["qa"], "item": {"id": nid("q"), "q": q["q"].strip(), "a": "", "why": q.get("why", ""),
                                                                 "group": q.get("group", ""), "round": rnd, "by": "claude", "from": action}})
        if action == "questions":
            return [(key, ops)], f"Claude: +{len(ops)} вопросов"
        ops.insert(0, {"op": "set", "path": ["challenge"], "value": {"verdict": res.get("verdict"), "points": res.get("points", []), "at": t, "round": rnd}})
        return [(key, ops)], f"Claude разобрал биты: {len(res.get('points', []))} замечаний, +{len(ops) - 1} вопросов"

    if action == "elements":
        seen = {(e.get("kind"), norm(e.get("name"))) for e in plan.get("elements") or []}
        cast = {norm(e.get("name")): e["id"] for e in plan.get("elements") or [] if e.get("kind") in ("char", "prop") and e.get("status") != "drop"}
        ops = []
        for e in res.get("elements", []):
            k = (e.get("kind"), norm(e.get("name")))
            if e.get("name") and e.get("kind") in KINDS and k not in seen:
                seen.add(k)
                item = {"id": nid("e"), "kind": e["kind"], "name": e["name"].strip(), "desc": e.get("desc", ""), "why": e.get("why", ""),
                        "q": e.get("q", "") if e["kind"] == "sound" else "", "status": "", "refs": [], "by": "claude"}
                if e["kind"] in ("char", "prop"):
                    cast.setdefault(norm(item["name"]), item["id"])
                elif e["kind"] == "scene":
                    item["_uses"] = e.get("uses") or []
                    if (e.get("sec") or "").strip():                 # S11: сцена сценария, по которой сделана эта
                        item["script"] = {"title": e["sec"].strip()[:120]}
                ops.append({"op": "add", "path": ["elements"], "item": item})
        for o in ops:                           # scene -> ids of its characters and props (names from this answer or already in the plan)
            names = o["item"].pop("_uses", None)
            if names is not None:
                o["item"]["uses"] = list(dict.fromkeys(cast[norm(n)] for n in names if norm(n) in cast))
        by = {}
        for o in ops:
            by[o["item"]["kind"]] = by.get(o["item"]["kind"], 0) + 1
        many = {"scene": "сцены", "char": "персонажи", "prop": "пропсы", "sound": "звуки"}
        return [(key, ops)], "Claude: " + (", ".join(f"{many[k]} +{n}" for k, n in by.items()) or "новых элементов нет")

    if action == "animteach":
        wd, typ = params["_wd"], params["_type"]
        src = os.path.join(wd, "anim.json")
        if not os.path.isfile(src):
            raise RuntimeError("Claude не записал anim.json — попробуй ещё раз")
        a = json.load(open(src, encoding="utf-8"))
        slug = re.sub(r"[^a-z0-9-]+", "-", (res.get("slug") or a.get("id", "").split("/")[-1] or "move").lower()).strip("-")[:40] or "move"
        dst_dir = os.path.join(os.path.dirname(os.path.dirname(wd)), typ)
        os.makedirs(dst_dir, exist_ok=True)
        base, k = slug, 2
        while os.path.isfile(os.path.join(dst_dir, slug + ".json")):
            slug, k = f"{base}-{k}", k + 1
        a.update({"schema": 1, "id": f"{typ}/{slug}", "type": typ, "name": res.get("name") or a.get("name") or slug, "prompt": params.get("ask", ""),
                  "by": "claude", "summary": res.get("summary", ""), "created": time.strftime("%Y-%m-%d")})
        open(os.path.join(dst_dir, slug + ".json"), "w", encoding="utf-8").write(json.dumps(a, ensure_ascii=False, indent=1))
        if os.path.isfile(os.path.join(wd, "strip.png")):
            shutil.copy2(os.path.join(wd, "strip.png"), os.path.join(dst_dir, slug + ".png"))
        res.update({"id": a["id"], "name": a["name"], "dur": a.get("dur"), "loop": a.get("loop", False)})
        return [], f"Claude выучил «{a['name']}» ({a['id']}, {a.get('dur')} с) — в библиотеке анимаций типа {typ}"

    if action == "libfix":                                        # новая версия библиотеки: превью (если Claude не снял), заметка правки в карточке
        import studio_api as SA
        c = SA.channel_dir(params.get("channel"))
        ref = params["_ref"][4:]
        lid, nv = ref.split("@")[0], int(ref.split("@")[1])
        try:
            SA.preview(docs_A(docs), c, ref)
        except Exception as e:
            print("! libfix preview:", e)
        cp, card = SA._card(c, lid)
        for x in card["versions"]:
            if x["v"] == nv:
                x.update(feedback=params.get("_fb", ""), summary=res.get("summary", ""), note=res.get("note", ""), by="claude")
        open(cp, "w", encoding="utf-8").write(json.dumps(card, ensure_ascii=False, indent=1))
        SA.set_meta(docs_A(docs), c, lid, {})
        res["ref"] = params["_ref"]
        return [], f"«{params.get('_name')}» v{nv}: {res.get('summary', 'поправлено')}"

    if action == "trellisfix":                                    # правки сняты, параметры уходят в задачу charmodel (её запускает страница по onResult)
        eid = params["el"]
        fx = params.get("_fx") or {}
        res["feedback"] = "; ".join(([fx["text"]] if fx.get("text") else []) + [n["text"] for n in fx.get("notes") or []]
                                    + [f"📍{i} {p['text'] or '(смотри место)'}" for i, p in enumerate(fx.get("pins3d") or [], 1)])
        ops = [{"op": "del", "path": ["elements", eid, "fx", "main", "notes"], "id": n["id"]} for n in fx.get("notes") or [] if n.get("id")]
        ops += [{"op": "del", "path": ["elements", eid, "fx", "main", "pins3d"], "id": p["id"]} for p in fx.get("pins3d") or [] if p.get("id")]
        if fx.get("text"):
            ops.append({"op": "set", "path": ["elements", eid, "fx", "main", "text"], "value": ""})
        return [(key, ops)], "TRELLIS: " + (res.get("reply") or "перелепливаю")

    if action == "charparts":
        wd, rel, v = params["_wd"], params["_rel"], params["_v"]
        eid = params["el"]
        e = next((x for x in plan.get("elements") or [] if x["id"] == eid), None)
        if not e:
            return [], "Элемент уже удалён"
        main = os.path.join(wd, "element.png")
        hogish = (res.get("fn") or "").strip().lower() == "hog"          # ёжик: риг по параметрам + костюмы, без rig.json
        if not os.path.isfile(main) and os.path.isfile(os.path.join(wd, "prefab.js")):   # Claude не снял кадры (команда не прошла) — снимаем сами
            subprocess.run(["node", os.path.join(P.STANDS, "render_char.js"), f"/rscene/{rel}/prefab.js", wd, "--port", str(docs["port"])],
                           capture_output=True, timeout=300)
        blender = bool(params.get("_blender"))
        if blender and not os.path.isfile(main) and os.path.isfile(os.path.join(wd, "model.glb")):   # кадры не сняты — снимаем сами
            subprocess.run(["node", os.path.join(P.STANDS, "render_prop.js"), f"/rscene/{rel}/prefab.js", wd, "--port", str(docs["port"])], capture_output=True, timeout=300)
        if blender and (not os.path.isfile(main) or not os.path.isfile(os.path.join(wd, "model.glb"))):
            raise RuntimeError("Claude не довёл 3D-героя до model.glb и кадров — попробуй ещё раз (лог Blender — model.log)")
        if not blender and (not os.path.isfile(main) or not (hogish or os.path.isfile(os.path.join(wd, "rig.json")))):
            raise RuntimeError("Claude не довёл персонажа до кадров (element.png, rig.json) — попробуй ещё раз")
        img = docs["save"](plan["id"], open(main, "rb").read())
        extra = [docs["save"](plan["id"], open(os.path.join(wd, f), "rb").read()) for f in ("rest.png", "clean.png", "emotions.png", "pose_up/element.png", "pose_step/element.png")
                 if os.path.isfile(os.path.join(wd, f))]
        fx = params.get("_fx") or {}
        rid = nid("r")
        fb = "; ".join(([fx["text"]] if fx.get("text") else []) + [n["text"] for n in fx.get("notes") or []])
        item = {"id": rid, "v": v, "dir": rel, "img": img, "extra": extra, "feedback": fb, "fx": fx, "fn": res.get("fn", ""), "rigchar": True, **({"model3d": True} if blender else {}),
                "summary": res.get("summary", ""), "note": res.get("note", ""), "ts": t}
        ops = [{"op": "add", "path": ["elements", eid, "renders"], "item": item}, {"op": "set", "path": ["elements", eid, "render"], "value": rid}]
        if e.get("form") != "rig":
            ops.append({"op": "set", "path": ["elements", eid, "form"], "value": "rig"})
        cur = ((e.get("fx") or {}).get("main")) or {}
        ops += [{"op": "del", "path": ["elements", eid, "fx", "main", "notes"], "id": n["id"]} for n in fx.get("notes") or [] if n.get("id")]
        if fx.get("text") and (cur.get("text") or "").strip() == fx["text"]:
            ops.append({"op": "set", "path": ["elements", eid, "fx", "main", "text"], "value": ""})
        return [(key, ops)], f"Claude собрал «{e.get('name', '')}» со скелетом ({res.get('fn', '')}) v{v}"

    if action == "element":
        wd, rel, v = params["_wd"], params["_rel"], params["_v"]
        main = os.path.join(wd, "element.png")
        if not os.path.isfile(main):
            raise RuntimeError("Claude не довёл отрисовку до PNG — попробуй ещё раз или уточни описание")
        eid = params["el"]
        e = next((x for x in plan.get("elements") or [] if x["id"] == eid), None)
        if not e:
            return [], "Элемент уже удалён"
        img = docs["save"](plan["id"], open(main, "rb").read())
        extra = [docs["save"](plan["id"], open(os.path.join(wd, f), "rb").read()) for f in sorted(os.listdir(wd))
                 if f.startswith("element_") and f.endswith(".png")]
        fx = params.get("_fx") or {}
        rid = nid("r")
        fb = "; ".join(([fx["text"]] if fx.get("text") else []) + [n["text"] for n in fx.get("notes") or []]
                       + [f"📍{i} {p['text'] or '(смотри место)'}" for i, p in enumerate((fx.get("pins") or []) + (fx.get("pins3d") or []), 1)])
        item = {"id": rid, "v": v, "dir": rel, "img": img, "extra": extra, "feedback": fb, "fx": fx, "fn": res.get("fn", ""),
                "summary": res.get("summary", ""), "note": res.get("note", ""), "three": bool(params.get("_three")), "ts": t}
        ops = []
        if params.get("_prop3"):
            if not os.path.isfile(os.path.join(wd, "prefab.js")):
                raise RuntimeError("Claude не записал prefab.js — попробуй ещё раз")
            item.update({"three3": True, "how": res.get("fn", ""), "fn": ""})
            if e.get("dim") != "3d":
                ops.append({"op": "set", "path": ["elements", eid, "dim"], "value": "3d"})
        ops += [{"op": "add", "path": ["elements", eid, "renders"], "item": item}, {"op": "set", "path": ["elements", eid, "render"], "value": rid}]
        cur = ((e.get("fx") or {}).get("main")) or {}
        ops += [{"op": "del", "path": ["elements", eid, "fx", "main", "pins"], "id": p["id"]} for p in fx.get("pins") or [] if p.get("id")]
        ops += [{"op": "del", "path": ["elements", eid, "fx", "main", "notes"], "id": n["id"]} for n in fx.get("notes") or [] if n.get("id")]
        ops += [{"op": "del", "path": ["elements", eid, "fx", "main", "pins3d"], "id": p["id"]} for p in fx.get("pins3d") or [] if p.get("id")]
        if fx.get("text") and (cur.get("text") or "").strip() == fx["text"]:
            ops.append({"op": "set", "path": ["elements", eid, "fx", "main", "text"], "value": ""})
        return [(key, ops)], f"Claude нарисовал «{e.get('name', '')}» v{v}"

    if action == "assets":
        import assets as A
        eid = params["el"]
        e = next((x for x in plan.get("elements") or [] if x["id"] == eid), None)
        if not e:
            return [], "Элемент уже удалён"
        seen = {(p.get("src"), str(p.get("id"))) for p in e.get("picks") or []} | {(a.get("src"), str(a.get("sid"))) for a in e.get("assets") or []}
        found, ops, lost = {}, [], []
        for c in res.get("picks", [])[:8]:
            k = (c.get("src"), str(c.get("id")))
            if k in seen:
                continue
            q = (c.get("query") or c.get("title") or "", c.get("kind") or "3d")
            if q not in found:                          # the full row (thumb, page, licence) comes from the catalog again, not from Claude
                try:
                    found[q] = A.search(q[0], q[1], 20, data_dir=docs["data"])["results"]
                except Exception:
                    found[q] = []
            row = next((r for r in found[q] if (r["src"], str(r["id"])) == k), None)
            if not row:
                lost.append(c.get("title") or c.get("id"))
                continue
            seen.add(k)
            ops.append({"op": "add", "path": ["elements", eid, "picks"], "item": {**row, "pid": nid("k"), "why": c.get("why", ""), "use": c.get("use") or "ref", "ts": t}})
        return [(key, ops)], f"Claude: {len(ops)} ассет(ов) для «{e.get('name', '')}» — смотри «✨ Claude предлагает»" + (f" (не нашлись снова: {', '.join(lost)[:120]})" if lost else "")

    if action == "sound":
        eid = params["el"]
        e = next((x for x in plan.get("elements") or [] if x["id"] == eid), None)
        if not e:
            return [], "Элемент уже удалён"
        have = {(s.get("url") or "") for s in e.get("sounds") or []}
        ops, bad = [], []
        for c in res.get("candidates", [])[:6]:
            url = (c.get("url") or "").strip()
            if not url or url in have:
                continue
            have.add(url)
            try:
                item = docs["sound"](plan["id"], url, c.get("start"), c.get("end"), by="claude", why=c.get("why", ""))
                if c.get("title") and (not item.get("title") or re.search(r"\.(mp3|ogg|wav|flac|m4a)$", item["title"], re.I)):
                    item["title"] = c["title"]                  # a file name is no title: take the one from the search result
                for k in ("page", "license", "author"):
                    if c.get(k) and not item.get(k):
                        item[k] = c[k]
                ops.append({"op": "add", "path": ["elements", eid, "sounds"], "item": item})
            except Exception as ex:
                bad.append(f"{c.get('title') or url}: {str(ex)[:80]}")
        if ops and not preprod.el_mix(e):                   # nothing chosen yet: the first candidate becomes the sound (one layer)
            first = ops[0]["item"]["id"]
            ops += [{"op": "set", "path": ["elements", eid, "mix"], "value": [{"id": nid("l"), "sid": first, "at": 0, "gain": 1, "note": ""}]},
                    {"op": "set", "path": ["elements", eid, "sound"], "value": first}]
        n = sum(1 for o in ops if o["op"] == "add")
        return [(key, ops)], f"Claude: +{n} звуков для «{e.get('name', '')}»" + (f" (не скачались: {len(bad)} — {'; '.join(bad)[:200]})" if bad else "")

    raise ValueError(f"неизвестное действие: {action}")


# ---------------- редактор сцены (S1 Claude Studio): агент и перевод старых сцен ----------------
ANY = {}
OP_SCHEMA = {"type": "object", "properties": {
    "op": {"type": "string", "enum": ["set", "unset", "add", "del", "move"]},
    "path": {"type": "array", "items": {"type": "string"}},
    "value": ANY, "item": {"type": "object"}, "id": STR, "to": {"type": "integer"}, "at": {"type": "integer"}}, "required": ["op", "path"]}

SCENE_RULES = """Сцена — документ scene.json (формат — _pipeline/docs/studio/architecture.md §3.3). Единицы — метры, y вверх, камера смотрит вдоль −z.
- objects[]: {id, name, src: {prefab, el}, params, pos [x,y,z], rot [x,y,z] (радианы, порядок YXZ; обычно меняется только rot[1] — поворот по Y), scale (число), hide, locked, parent (id группы или null), keys}.
  Группа — объект с type: "group"; координаты детей — относительно группы. Предметы стоят нижней точкой: pos.y = 0 — на полу.
- links [{id, to: <id объекта>, from: t0, until?: t1}] — привязка «как Parent в After Effects», но с момента: с t0 объект едет и крутится за `to`
  (поверх своих keys и клипов — их не трогай, свои ключи двигают его относительно `to`), в t0 не прыгает; после until набранный сдвиг остаётся.
  «Ёжик сел в кресло и едет с ним» — ёжику links [{to: кресло, from: момент посадки}] (ключи pos ёжика, которые повторяли путь кресла, тогда убери);
  «клавиатура и мышь на выдвижной полке» — им links [{to: полка, from: 0}]. Ставь операцией set по пути ["objects", id, "links"] целиком.
- Новый предмет в сцене (S11): объект со своим префабом сцены, lib: или el:, которого нет в препродакшене, САМ становится элементом препродакшена («сделан в сцене», src.el) — давай ему понятное русское name (по нему элемент и называется; совпало с существующим элементом — свяжется с ним).
- Предмет в руке персонажа (S10.2): keys["hold.handR"|"hold.handL"] = [{id, t, v: "<ref 3D-пропса>" | null}] — ступенькой: с t в лапе предмет, null — отпустил;
  hold: {handR: ref} — всё время. Ref — как src.prefab пропса (lib:props/<slug>@N или el:<id>@vN; список — scene brief / библиотека).
  Как держать (место в кисти, поворот, размер, поза руки — «трубка у уха») — хват персонажа grips.json, его ставят в мастерской «✋ Предметы»
  (или `studio.py ws grips <видео> <ассет> '<JSON>'`); в сцене поза руки при хвате включается сама, поверх неё — ключи pose.
  «Дай ей трубку на 3-й секунде, на 6-й положи» — set ["objects", id, "keys", "hold.handR"] = [{id:"h1", t:3, v:ref}, {id:"h2", t:6, v:null}]; отдельный объект-трубку не ставь.
- Живые части пропса (S10.3): префаб объявляет channels (экран, индикатор, курсор…) — список и видео канала печатает `scene brief` («Живые части»).
  Ключи keys["ch.<имя>"] = [{id, t, v}]: числа и [x, y] — плавно (ease), остальное — ступенькой до следующего ключа; v: null — вернуть как в params.
  Экран (media): v — программа ('xp', 'off'…) или видео {media: "lib:media/<slug>@N", from: сек_в_видео, speed, loop, fit: cover|contain|stretch} — клип стартует в момент ключа.
  «Запусти San Andreas на мониторе в 2 с, курсор к ярлыку» — ch.cursor [{t:0, v:[0.2,0.2]}, {t:1.6, v:[0.62,0.55]}, {t:2, v:null}], ch.screen [{t:1.6, v:"select"}, {t:2, v:{media:…, from:0}}].
  Нужного видео нет — `studio.py media add "<ссылка>" --name "…" --from 12 --to 40` (YouTube и др., кусок до минуты; права на чужие кадры — у владельца), потом ключ.
  Своему пропсу без channels — новая версия префаба (lib fork): channels: {...} в prop3d и build возвращает {obj: G, tick(T) {…}} с P3.ch / P3.screen / P3.media / P3.blink (engine/props3d.js; образец — library props/elt-monitor-bol-soi v3).
- keys.<pos|rot|scale|hide>[] = {id, t, v, ease}; ease у ЛЕВОГО ключа — кривая до следующего: linear | io (плавно, по умолчанию) | in | out | hold.
  Нет ключей — работает статичное значение (pos / rot / scale). Есть ключи — статичное значение не работает, меняй ключи.
- lights[]: {id, name, type: lamp|point|ambient|sun, pos, color, intensity, dist, keys: {intensity, pos}}. Свет внутри предмета (лампа на столе) — в его префабе, управляется его params.
- camera: {fov, handheld, focus, keys: [{id, t, pos, target, fov, ease}], cuts: [{id, t, name}]} — склейка: ключи по разные стороны не перетекают.
- markers [{id, t, name}], sounds [{id, t, src: 'el:<id>'|'lib:<id>', gain, note}].
- params предмета читает его префаб (prefabs.js): P_(o, 'имя', по_умолчанию). Меняй их операцией set по пути ["objects", id, "params", "имя"].
- Персонаж (src.prefab = "lib:characters/<slug>@N", S5, docs/studio/stage5-animations.md): clips [{id, t, dur, anim: "<тип>/<slug>", speed, loop}] — движения из библиотеки типа скелета;
  pose [{id, t, bones: {armL: {rot, len}, body: {rot, sq}, legL: {rot}}, ik: {armR: [x, y] — цель кончика лапы в долях роста от ног, y вверх | null — отпустить}, face: {mouth, lid, brows, look},
  sit, facing, note, refine: "open"|"done"}] — ключи позы поверх клипов, интерполируются по каналам между ключами; walk: auto (ходьба сама при движении по keys.pos) | off;
  keys.emotion (эмоция из листа персонажа, держится до следующего ключа), keys["wear.<костюм>"] (true / false). Ёжик: armL / armR rot 0 — вниз, + к центру и вверх, − наружу; −2.9 — над головой.
  «Доведи» позу: подход (ключ позы за 0.3–0.6 с до — лапа отведена, тело чуть назад), сам ключ, отход (ключ с ik: {лапа: null} через 0.4–0.8 с; в нём же верни к 0 все кости и наклон, которые трогал в подходе, — ключи позы держатся до следующего), наклон тела к цели (body.rot ±0.1–0.2), лицо под момент.
  Цель лапы, которую поставил автор, не меняй. Добавить клип: {"op": "add", "path": ["objects", id, "clips"], "item": {…}}; ключ позы: {"op": "add", "path": ["objects", id, "pose"], "item": {…}}.

Операции (в списках путь идёт через id элемента):
  {"op": "set", "path": ["objects", "o16", "pos"], "value": [1.0, 0.78, 0.1]}
  {"op": "set", "path": ["objects", "o16", "params", "color"], "value": "#ff9a3c"}
  {"op": "add", "path": ["objects", "o18", "keys", "pos"], "item": {"id": "k<6 символов>", "t": 2.0, "v": [0.3, 0, 0.2], "ease": "io"}}
  {"op": "set", "path": ["objects", "o18", "keys", "pos", "<id ключа>", "v"], "value": [0.3, 0, 0.2]}
  {"op": "add", "path": ["camera", "keys"], "item": {"id": "c…", "t": 4.0, "pos": [0, 1, 2], "target": [0, 1, 0], "ease": "io"}}
  {"op": "add", "path": ["objects"], "item": {"id": "o…", "name": "…", "src": {"prefab": "…"}, "pos": [0, 0, 0], "rot": [0, 0, 0], "scale": 1}}   (только из существующих префабов)
  {"op": "del", "path": ["objects"], "id": "o9"}    {"op": "unset", "path": ["objects", "o16", "params", "color"]}
Новые id придумывай сам: буква типа + 6 символов (o…, k…, c…, m…, s…, g…)."""


LOOK_SONNET = ("- Если для просьбы нужен новый вид предмета (другой рисунок, новая деталь), а не расстановка — сделай, что можешь операциями, "
               "и в reply скажи, что вид меняет режим Opus (переключатель в панели) или «Поправить» в карточке элемента.")
LOOK_OPUS = ("- Если для просьбы нужен новый вид предмета (другой рисунок, новая деталь, другой цвет корпуса) — поправь его код прямо в prefabs.js (Edit): "
             "только нужный префаб или его функцию рисования, остальное не трогай; позиции и движение — по-прежнему операциями в ops. "
             "Проверь себя кадром: {SHOT} — и посмотри PNG через Read (1–3 прохода). В поле prefabs коротко напиши, что поменял в коде (пусто — если не трогал).")


def _scene_summary(doc, info, limit=160):
    by = {o["id"]: o for o in doc.get("objects") or []}
    rows = []
    for o in (doc.get("objects") or [])[:limit]:
        depth, p = 0, o.get("parent")
        while p and depth < 8:
            depth, p = depth + 1, (by.get(p) or {}).get("parent")
        ks = {k: [round(x["t"], 2) for x in v] for k, v in (o.get("keys") or {}).items() if v}
        pf = (o.get("src") or {}).get("prefab")
        rows.append("  " * depth + f"- {o['id']} «{o.get('name')}»" + (" [группа]" if o.get("type") == "group" else f" префаб {pf}")
                    + f" pos {o.get('pos')} rotY {round((o.get('rot') or [0, 0, 0])[1], 3)} scale {o.get('scale', 1)}"
                    + (f" params {json.dumps(o['params'], ensure_ascii=False)}" if o.get("params") else "")
                    + (f" ключи {ks}" if ks else "") + (" скрыт" if o.get("hide") else "") + (" 🔒" if o.get("locked") else "")
                    + (f"\n    клипы {json.dumps(o['clips'], ensure_ascii=False)}" if o.get("clips") else "")
                    + (f"\n    поза {json.dumps(o['pose'], ensure_ascii=False)}" if o.get("pose") else "")
                    + (f" walk {o['walk']}" if o.get("walk") else ""))
    if len(doc.get("objects") or []) > limit:
        rows.append(f"… и ещё {len(doc['objects']) - limit} (полностью — в scene.json)")
    lights = [f"- {l['id']} «{l.get('name')}» {l.get('type')} pos {l.get('pos')} {l.get('color') or l.get('sky')} яркость {l.get('intensity')}" for l in doc.get("lights") or []]
    c = doc.get("camera") or {}
    cam = [f"- ключ {k['id']} t={k['t']} pos {k.get('pos')} target {k.get('target')}" + (f" fov {k['fov']}" if k.get("fov") else "") + f" ease {k.get('ease', 'io')}" for k in c.get("keys") or []]
    pf = [f"- {k} ({v['kind']})" + (f": {v['note']}" if v.get("note") else "") + (f" · params {json.dumps(v['params'], ensure_ascii=False)}" if v.get("params") else "") for k, v in info.items()]
    return (f"Сцена «{doc.get('name')}», длина {doc.get('len')} с, {doc.get('fps', 30)} к/с.\nОбъекты:\n" + "\n".join(rows)
            + "\nСвет:\n" + ("\n".join(lights) or "—")
            + f"\nКамера: fov {c.get('fov')}, дрожь {c.get('handheld')}, фокус {c.get('focus')}\n" + ("\n".join(cam) or "—")
            + f"\nСклейки: {[(x['t'], x.get('name')) for x in c.get('cuts') or []]}\nМаркеры: {[(m['t'], m.get('name')) for m in doc.get('markers') or []]}"
            + f"\nЗвуки: {[(s['t'], s.get('src'), s.get('note')) for s in doc.get('sounds') or []]}"
            + "\nПрефабы (prefabs.js):\n" + "\n".join(pf))


def sceneagent_spec(docs, e, doc, c):
    """💬 одна просьба автора в редакторе сцены -> одна пачка операций над scene.json."""
    import scene_api
    work = c["work"]
    info = scene_api.prefab_info(os.path.join(work, "prefabs.js"))
    names = {o["id"]: o.get("name") for o in (doc.get("objects") or []) + (doc.get("lights") or [])}
    sel = [f"{i} «{names.get(i, 'камера' if i.startswith('camera') else i)}»" for i in c.get("sel") or []]
    au = doc.get("authored") or {}
    aut = "\n".join(f"- {names.get(k, k)} ({k}): {', '.join(v)}" for k, v in au.items()) or "—"
    hist = "\n".join(f"- {'автор' if h.get('by') == 'author' else 'Claude'}: {h.get('desc')}" for h in c.get("history") or [] if h.get("desc")) or "—"
    frame = c.get("frame")
    prompt = f"""Просьба автора: «{c['ask']}»

Время курсора: {c['t']:.2f} с. Выбрано: {', '.join(sel) or 'ничего'}.
{('Кадр сцены в этот момент (так её видит зритель): ' + _fwd(frame) + ' — посмотри через Read.') if frame else ''}
Полный документ: {_fwd(os.path.join(work, 'scene.json'))}; код предметов (только читать): {_fwd(os.path.join(work, 'prefabs.js'))}.

{_scene_summary(doc, info)}

Что автор делал руками (authored) — это его решения, НЕ меняй эти пути, если он прямо не просит об этом в просьбе выше:
{aut}
Если просьба прямо касается такого пути (например, «переставь кресло, которое я повернул»), перечисли его в allow как «<id>.<подпуть>» (например «o17.rot»).

Последние правки:
{hist}

{SCENE_RULES}

Как ответить:
- ops — ОДНА пачка операций, которая выполняет просьбу целиком (её отменят одним Ctrl+Z). Меняй только то, о чём просят. Координаты считай по pos других объектов (стол, пол) — не на глаз.
  «Поставь на стол» — y = высота столешницы (смотри pos предметов, которые уже стоят на столе); «включи / потеплее / ярче» — params предмета (color, intensity) или яркость света.
  Время ключей — от курсора, если автор не назвал другое. Не трогай ключи, которых просьба не касается.
{LOOK_OPUS if c.get('prefabs') else LOOK_SONNET}
- Если просьба непонятна или противоречит authored — ops пустой, в reply — короткий вопрос.
- reply — 1–2 фразы автору по-русски, что сделано; desc — короткое описание пачки для истории («лампа: на стол, тёплый свет»).
- Ничего не выдумывай про объекты: только id и префабы из списка выше."""
    sysp = ("Ты — помощник автора в редакторе 3D-сцены бумажной анимации (Claude Studio). Ты правишь сцену операциями над её JSON-документом: "
            "точно, минимально, по просьбе. Ручные правки автора священны. Отвечай строго JSON по схеме.")
    dirs = [work] + ([os.path.dirname(frame)] if frame else [])
    if c.get("prefabs"):                                   # Opus: may also change how things look (prefabs.js), checks itself with a frame
        shot = _fwd(os.path.join(P.STANDS, "render_shot.js"))
        dirs += [P.ENGINE, P.STANDS]
        return {"system": sysp, "prompt": prompt.replace("{SHOT}", f'node {shot} "{c["url"]}" {_fwd(c["check"])} {c["t"]:.2f}'), "cwd": work, "timeout": 1500,
                "tools": ["Read", "Grep", "Edit", "Bash"], "allowed": ["Read", "Grep", "Edit", f"Bash(node {shot}:*)"], "dirs": dirs,
                "schema": S({"reply": STR, "desc": STR, "ops": ARR(OP_SCHEMA), "allow": ARR(STR), "prefabs": STR}, ["reply", "desc", "ops"])}
    return {"system": sysp, "prompt": prompt, "cwd": work, "timeout": 600, "tools": ["Read", "Grep"], "allowed": ["Read", "Grep"], "dirs": dirs,
            "schema": S({"reply": STR, "desc": STR, "ops": ARR(OP_SCHEMA), "allow": ARR(STR)}, ["reply", "desc", "ops"])}


def sceneconvert_spec(docs, e, base, c):
    """Перевод старой 3D-сцены (element.js + блок расстановки автора) в формат редактора: prefabs.js + scene.json, с проверкой кадров «было / стало»."""
    src, work, cmp_dir = c["src"], c["work"], c["cmp"]
    shot = _fwd(os.path.join(P.STANDS, "render_shot.js"))
    diff = _fwd(os.path.join(P.STANDS, "scene_diff.py"))
    srv = _fwd(os.path.join(c["here"], "ideas_server.py"))
    url = f"http://127.0.0.1:{c['port']}/tpl/stand3d.html?stage=/rscene/{c['rel']}/scene.json&parts=element"
    new = _fwd(os.path.join(cmp_dir, "new"))
    plan = docs["plan"]
    cast = {x["id"]: x.get("name") for x, _ in preprod.cast_of(e, plan)} if e.get("kind") == "scene" else {}
    els = "\n".join(f"   - {i}: «{n}»" for i, n in cast.items()) or "   —"
    ex_dir = os.path.join(P.render("260930-08d8"), "e6640ce01", "work")
    example = (f"Образец готового перевода (сцена «Комната зимним утром»): {_fwd(os.path.join(ex_dir, 'scene.json'))} и хвост {_fwd(os.path.join(ex_dir, 'prefabs.js'))} "
               "(раздел «префабы сцены» в конце файла) — посмотри, как там устроены home, группы, ключи ёжика и параметры.") if os.path.isfile(os.path.join(ex_dir, "scene.json")) and ex_dir != work else ""
    prompt = f"""Задача: перевести 3D-сцену препродакшена «{e.get('name')}» из старого формата (один element.js с кодом world3d) в формат редактора сцены:
prefabs.js (как выглядит каждый предмет — код) + scene.json (где он стоит, как движется, как снята камера — данные).

Исходник: {_fwd(os.path.join(src, 'element.js'))} (версия v{base.get('v')}). В конце может быть блок «// ==== расстановка автора» (w.groups / w.layout) — это ручная расстановка автора.
Запиши ровно два файла в {_fwd(work)}: prefabs.js и scene.json.

Прочитай сначала:
- формат: {_fwd(os.path.join(P.DOCS, 'studio', 'architecture.md'))} §3.3–3.5;
- движок: шапку {_fwd(os.path.join(P.ENGINE, 'scene.js'))} (kind префабов, home, tick, overlay) и API мира в шапке {_fwd(os.path.join(P.ENGINE, 'stage3d.js'))};
- схему: {_fwd(os.path.join(P.ENGINE, 'scene.schema.json'))}.
{example}

Как переводить:
1. prefabs.js = весь код рисования из element.js как есть (функции, константы, PICS / MODELS) + в конце объект const PREFABS = {{ ключ: {{ kind, … }} }}.
   Каждый предмет — свой префаб с человеческим ключом. Повторяющиеся (ели, книги, стулья) — один префаб, много объектов.
   Чтобы не пересчитывать координаты, префаб может строить предмет «по месту», как в старом коде, и указать home: {{ pos, rotY }} — где он стоит;
   тогда у объекта в scene.json pos = home.pos, rot = [0, home.rotY, 0]. Перед префабами можно завести константы размеров (как RK в образце).
   Окружение (стены, пол, потолок, небо) — kind: 'env', подключается через world.env. 2D-надписи поверх кадра — kind: 'overlay'.
   Анимация внутри предмета (метель, стрелки, мигание экрана, позы героя по времени) — от T внутри префаба (draw(g, cw, ch, T, o) у card или tick в group).
   Времена этих внутренних событий, которые автор может захотеть сдвинуть, вынеси в params (P_(o, 'имя', по_умолчанию), как в образце).
2. scene.json (schema 1): id «{e['id']}», name, len (из ELEMENT.len), fps 30, world {{ fx, bg, fog, env }}, camera {{ fov, handheld, focus, keys, cuts: [] }} из w.camKeys,
   lights[] — свет комнаты (ambient, отдельные лампы), objects[] — предметы с человеческими именами по-русски, sounds [], markers [], comments [], authored {{}}.
   Элементам препродакшена из состава сцены дай их имена и src.el:
{els}
   Составные вещи (мебель, компьютер) — группами: объект type: "group" + parent у частей.
   Движение предметов по сцене (из update: переезды, прыжки, выдвижения) — ключами keys.pos / rot (если кривая сложная — несколько ключей linear, снятых с траектории).
3. Расстановку автора (w.layout / w.groups) впиши в позиции и группы и отметь в authored: {{ "<id>": ["pos", "rot", …] }} — это его решения.
4. Проверь:
   python {srv} scene validate {plan['id']} {e['id']}      — схема и ссылки (должно быть ok)
   node {shot} "{url}" {new} {c['ts']}                        — кадры новой сцены
   python {diff} {_fwd(os.path.join(cmp_dir, 'old'))} {new} --out {_fwd(os.path.join(cmp_dir, 'compare.png'))}   — сравнение с кадрами старой (порог: средняя < 4, 95% < 24)
   Посмотри compare.png через Read. Если не похоже — найди, что съехало, поправь и сними снова (до 3 проходов).

В ответе: summary — сколько объектов, что группами, что стало ключами, что осталось внутри префабов (2–4 предложения); diff — итог последнего сравнения; note — что автору проверить."""
    sysp = ("Ты — технический художник Claude Studio: переводишь сцены бумажной 3D-анимации из кода в данные редактора, не меняя картинку. "
            "Работаешь аккуратно и проверяешь себя кадрами. Отвечай строго JSON по схеме.")
    dirs = [work, src, cmp_dir, P.ENGINE, os.path.join(P.DOCS, "studio"), P.STANDS, ex_dir]
    return {"system": sysp, "prompt": prompt, "cwd": work, "timeout": 1800,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {shot}:*)", f"Bash(python {diff}:*)", f"Bash(python {srv} scene validate:*)"],
            "dirs": [d for d in dirs if os.path.isdir(d)], "schema": S({"summary": STR, "diff": STR, "note": STR})}
