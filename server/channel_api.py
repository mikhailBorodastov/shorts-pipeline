"""Новый канал и его стиль (S9, docs/studio/stage9-channel.md).

- «+ Канал» — папка канала в рабочей папке: channel.json, style/ (style-guide.md, palette.json, voice.json, captions.json, toolkit.js), library/, videos/, свой git.
- Интервью по стилю — вопросы Claude по четырём блокам (визуал и герой, подача и голос, монтаж и звук, упаковка): channel.json → interview.qa[]; задача `chanq` (Sonnet).
- «✨ Собрать стиль» — задача `chanstyle` (Opus): по ответам — style-guide.md, палитра, шрифты, голос, субтитры, правила (paperFacing…), стиль 3D, тулкит, описание героя.
- ⚙ Стиль — правка всех файлов из приложения; каждое сохранение кладёт прошлую версию в style/.history/ (история и откат).
- Герой канала — служебное видео «Герой канала» с элементом-персонажем (S4: «🦴 со скелетом» → библиотека) и пустой сценой редактора для проверки.
"""
import glob, hashlib, json, os, re, shutil, subprocess, sys, time

import paths as P  # noqa: E402

BLOCKS = [("visual", "Визуал и герой"), ("delivery", "Подача и голос"), ("montage", "Монтаж и звук"), ("pack", "Упаковка")]
VOICES = ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural", "ru-RU-DariyaNeural", "en-US-GuyNeural", "en-US-JennyNeural", "en-GB-RyanNeural"]
STYLE_FILES = {"style": "style-guide.md", "palette": "palette.json", "voice": "voice.json", "captions": "captions.json", "toolkit": "toolkit.js"}
BAD = '<>:"/\\|?*'


def now_ms():
    return int(time.time() * 1000)


def fonts():
    return sorted(os.path.splitext(f)[0] for f in os.listdir(P.FONTS) if f.lower().endswith((".ttf", ".otf")))


def _git(d, *a):
    return subprocess.run(["git", *a], cwd=d, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


# ---------------------------------------------------------------- + канал
def new_channel(A, name, icon="📺", about="", lang="ru"):
    name = (name or "").strip().rstrip(".")
    if not name or any(c in name for c in BAD):
        raise ValueError("в названии канала нельзя: " + " ".join(BAD))
    d = os.path.join(P.ROOT, name)
    if os.path.exists(d):
        raise ValueError(f"папка «{name}» уже есть")
    ids = {c["id"] for c in P.channels(True)}
    cid = A.stapi().slug(name)
    while cid in ids:
        cid += "-2"
    for sub in ("style", "library/characters", "library/props", "library/skeletons", "library/anims", "library/sounds", "videos"):
        os.makedirs(os.path.join(d, *sub.split("/")), exist_ok=True)
    doc = {"schema": 1, "id": cid, "name": name, "icon": icon or "📺", "lang": lang, "formats": ["short", "long"],
           "style": "style/style-guide.md", "toolkit": "style/toolkit.js",
           "rules": {"paperFacing": True, "facingMaxDeg": 35, "hero": ""},
           "models": {"text": "sonnet", "visual": "claude-opus-5-5"}, "defaults": {"engine": "3d", "mode": "short", "dim": "3d"},
           "about": about, "style3d": "paper", "interview": {"qa": [], "done": False}, "rev": 1, "updated": now_ms()}
    A.write_text(os.path.join(d, "channel.json"), json.dumps(doc, ensure_ascii=False, indent=1))
    A.write_text(os.path.join(d, "style", "style-guide.md"), f"# Стайл-гайд канала «{name}»\n\n{about}\n\n(Соберётся после интервью по стилю: ⚙ Стиль → 🎤 Интервью → «✨ Собрать стиль».)\n")
    shutil.copy2(os.path.join(P.STANDS, "paper.js"), os.path.join(d, "style", "toolkit.js"))   # стартовый тулкит — бумажный (после интервью можно заменить)
    A.write_text(os.path.join(d, "library", "index.json"), "[]")
    gi = next((os.path.join(c["dir"], ".gitignore") for c in P.channels() if os.path.isfile(os.path.join(c["dir"], ".gitignore"))), None)
    if gi:
        shutil.copy2(gi, os.path.join(d, ".gitignore"))
    _git(d, "init", "-q")
    _git(d, "add", "-A")
    _git(d, "commit", "-q", "-m", f"Канал «{name}» создан в Claude Studio")
    P.index(True)
    P.state_set("channel", cid)
    return {"id": cid, "dir": d}


def chan(cid):
    c = P.channel(cid)
    if not c or (cid and c["id"] != cid):
        raise ValueError("нет такого канала")
    return c


# ---------------------------------------------------------------- файлы стиля: чтение, запись с историей
def style_files(cid):
    c = chan(cid)
    out = {}
    for k, f in STYLE_FILES.items():
        p = os.path.join(c["dir"], "style", f)
        try:
            txt = open(p, encoding="utf-8").read()
        except OSError:
            txt = ""
        out[k] = json.loads(txt) if f.endswith(".json") and txt.strip() else ({} if f.endswith(".json") else txt)
    hist = sorted(glob.glob(os.path.join(c["dir"], "style", ".history", "*")), reverse=True)[:40]
    out["history"] = [os.path.basename(x) for x in hist]
    out["fonts"], out["voices"] = fonts(), VOICES
    hd = os.path.join(c["dir"], "style", "hero")
    out["heroRefs"] = sorted("style/hero/" + f for f in os.listdir(hd) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))) if os.path.isdir(hd) else []
    return out


def save_style_file(A, cid, kind, value, note=""):
    c = chan(cid)
    f = STYLE_FILES.get(kind)
    if not f:
        raise ValueError("нет такого файла стиля")
    p = os.path.join(c["dir"], "style", f)
    if os.path.isfile(p):                                      # прошлая версия — в историю (откат: «↺» в ⚙ Стиль)
        hd = os.path.join(c["dir"], "style", ".history")
        os.makedirs(hd, exist_ok=True)
        shutil.copy2(p, os.path.join(hd, time.strftime("%Y%m%d-%H%M%S") + "_" + f))
    txt = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1)
    A.write_text(p, txt)
    return p


def restore(A, cid, name):
    c = chan(cid)
    src = os.path.join(c["dir"], "style", ".history", os.path.basename(name))
    m = re.match(r"\d{8}-\d{6}_(.+)$", os.path.basename(name))
    if not m or not os.path.isfile(src):
        raise ValueError("нет такой версии")
    kind = next(k for k, f in STYLE_FILES.items() if f == m.group(1))
    return save_style_file(A, cid, kind, open(src, encoding="utf-8").read())


# ---------------------------------------------------------------- 🎙 проба голоса
def voice_test(voice, rate="+20%", pitch="+0Hz", text="Привет! Так будет звучать голос канала."):
    import asyncio, edge_tts
    d = os.path.join(P.STATE, "voicetest")
    os.makedirs(d, exist_ok=True)
    name = hashlib.md5(f"{voice}|{rate}|{pitch}|{text}".encode("utf-8")).hexdigest()[:12] + ".mp3"
    out = os.path.join(d, name)
    if not os.path.isfile(out):
        asyncio.run(edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(out))
    return name


# ---------------------------------------------------------------- Claude: вопросы интервью и сборка стиля
def qa_text(doc):
    qa = (doc.get("interview") or {}).get("qa") or []
    by = {k: [] for k, _ in BLOCKS}
    for q in qa:
        by.setdefault(q.get("block") or "visual", []).append(q)
    out = []
    for k, label in BLOCKS:
        rows = [f"- {q['q']}\n  → {(q.get('a') or '').strip() or ('(пропущен)' if q.get('skip') else '(без ответа)')}" for q in by.get(k) or []]
        if rows:
            out.append(f"## {label}\n" + "\n".join(rows))
    return "\n\n".join(out)


def chanq_spec(A, doc, params):
    C = A.capi()
    qa = (doc.get("interview") or {}).get("qa") or []
    rnd = max([int(q.get("round") or 1) for q in qa] + [0]) + 1
    block = params.get("block") or ""
    blocks = "\n".join(f"- {k} — {v}" for k, v in BLOCKS)
    n = int(params.get("n") or (20 if not qa else 8))
    prompt = f"""Интервью по стилю нового YouTube-канала «{doc.get('name')}». О канале: {doc.get('about') or '(не описан)'}.
Из ответов автора соберётся стайл-гайд канала: как выглядят картинки и главный герой, как звучит подача и голос, как смонтированы ролики и звук, как упакованы (обложки, названия).
Задай {n} вопросов{(' только по блоку ' + block) if block else ' — поровну по блокам'}:
{blocks}
Вопросы конкретные, с вариантами прямо в вопросе («герой — серьёзный или нелепый, как …?»), на ответ 10–30 секунд. Спрашивай про: визуальный стиль и палитру, референсы (каналы, игры, мультфильмы),
главного героя (кто, как выглядит, характер, как двигается), 2D или 3D, подачу (тон, темп, юмор, жанры роликов), голос диктора (мужской / женский, TTS или свой, скорость),
субтитры, монтаж (длина, склейки, переходы, музыка, звуки), обложки и названия. Не повторяй уже заданное.
q — вопрос; why — что решит ответ (коротко); block — блок из списка.
{('Это уточняющий раунд ' + str(rnd) + ': копай глубже там, где ответ открыл новое или остался размытым.') if qa else ''}

{qa_text(doc) or '(вопросов ещё не было)'}"""
    return {"system": f"Ты — продюсер YouTube-канала: помогаешь автору сформулировать стиль канала, чтобы по нему делались ролики в Claude Studio. Пиши по-русски, коротко и конкретно. Отвечай строго JSON по схеме.",
            "prompt": prompt, "schema": C.S({"questions": C.ARR(C.S({"q": C.STR, "why": C.STR, "block": {"type": "string", "enum": [k for k, _ in BLOCKS]}}))}),
            "round": rnd}


def chanstyle_spec(A, doc):
    C = A.capi()
    c = chan(doc["id"])
    try:
        guide = open(os.path.join(P.PROMPTS, "style-guide.md"), encoding="utf-8").read()[:9000]
    except OSError:
        guide = ""
    ex = next((x for x in P.channels() if x["id"] != doc["id"] and os.path.isfile(os.path.join(x["dir"], "style", "style-guide.md"))), None)
    example = open(os.path.join(ex["dir"], "style", "style-guide.md"), encoding="utf-8").read()[:5000] if ex else ""
    prompt = f"""Собери стиль нового канала «{doc.get('name')}» по интервью с автором. О канале: {doc.get('about') or '—'}.

Интервью (ответы автора — его решения, не переписывай их, а развивай):
{qa_text(doc)}

Что нужно (всё — по ответам; чего автор не сказал — предложи и пометь «предложено»):
- style_guide — стайл-гайд канала в markdown: 1) о канале и зрителе; 2) визуальный стиль (техника, палитра словами, фон, свет, как вклеиваются реальные материалы); 3) главный герой (внешность, характер, как двигается, что нельзя);
  4) подача (тон, хук, темп слов в секунду, длина фраз, юмор, кода, чего не делаем); 5) голос и субтитры; 6) монтаж и звук (длина ролика, склейки, переходы, музыка, звуки); 7) упаковка (обложки, названия); 8) чек-лист перед публикацией.
  Конкретно, с примерами. Это главный документ: по нему Claude пишет сценарии и рисует.
- about — канал одной строкой (Claude читает её во всех кнопках ✨).
- palette — 6–10 цветов: name, hex, use (где: фон, герой, акцент, текст…).
- fonts — title (заголовки и обложки), body (субтитры), hand (рукописный) — из доступных: {', '.join(fonts())}; если нужен другой шрифт — в note, автор добавит.
- voice — голос диктора для edge-tts: voice из {', '.join(VOICES)}, rate (например +20%), pitch (например +0Hz), note (почему).
- captions — субтитры: font, size (60–90), color, stroke, y (доля высоты кадра, 0.7–0.8), maxWords (1–4), upper (true/false).
- rules — paperFacing (true — бумажные карточки-персонажи поворачиваются к камере, как в Paper Mario), facingMaxDeg (20–45).
- style3d — стиль 3D-предметов: paper (бумажный макет) | toy (пластилин / игрушка) | flat (плоские цветные формы) | lowpoly.
- toolkit — paper (бумажный тулкит канала «Доедать будешь»: рваные вырезки, рукописные плашки) или new (свой — если стиль совсем другой); toolkit_note — что в нём поменять.
- hero — главный герой: name, desc (внешность для художника, подробно: силуэт, цвета, детали), character (характер), skeleton (как устроено тело: двуногий, четвероногий, крылья, хвост…).

Пример структуры стайл-гайда другого канала (не копируй стиль — только устройство документа):
{example}

Общий гайд подачи шортсов (бери то, что подходит этому каналу):
{guide}"""
    S, STR, ARR = C.S, C.STR, C.ARR
    NUM, BOOL = {"type": "number"}, {"type": "boolean"}
    schema = S({"style_guide": STR, "about": STR,
                "palette": ARR(S({"name": STR, "hex": STR, "use": STR}, ["name", "hex", "use"])),
                "fonts": S({"title": STR, "body": STR, "hand": STR, "note": STR}, ["title", "body", "hand"]),
                "voice": S({"voice": STR, "rate": STR, "pitch": STR, "note": STR}, ["voice", "rate"]),
                "captions": S({"font": STR, "size": NUM, "color": STR, "stroke": STR, "y": NUM, "maxWords": NUM, "upper": BOOL}, ["font", "size", "color", "y", "maxWords"]),
                "rules": S({"paperFacing": BOOL, "facingMaxDeg": NUM}, ["paperFacing"]),
                "style3d": {"type": "string", "enum": ["paper", "toy", "flat", "lowpoly"]},
                "toolkit": {"type": "string", "enum": ["paper", "new"]}, "toolkit_note": STR,
                "hero": S({"name": STR, "desc": STR, "character": STR, "skeleton": STR}, ["name", "desc"])},
               ["style_guide", "about", "palette", "fonts", "voice", "captions", "rules", "style3d", "toolkit", "hero"])
    return {"system": "Ты — арт-директор и продюсер YouTube-канала. По интервью автора собираешь стиль канала для Claude Studio. Пишешь по-русски, конкретно. Отвечай строго JSON по схеме.",
            "prompt": prompt, "schema": schema, "timeout": 900}


def run_job(A, job):
    cid = job.key[8:]
    doc = A.load(job.key)
    if job.kind == "chanq":
        spec = chanq_spec(A, doc, job.params)
        spec["model"] = A.TEXT_MODEL
        job.summary = "Claude придумывает вопросы…"
        res = A.run_claude(job, spec)
        ops = [{"op": "add", "path": ["interview", "qa"], "item": {"id": A.new_id("q"), "q": q["q"], "why": q.get("why", ""), "block": q.get("block") or "visual",
                                                                "a": "", "round": spec["round"], "by": "claude"}} for q in res.get("questions") or [] if q.get("q")]
        if not doc.get("interview"):
            ops.insert(0, {"op": "set", "path": ["interview"], "value": {"qa": [], "done": False}})
        A.apply_ops(job.key, ops)
        job.summary = f"Claude: +{len(ops)} вопросов"
        return True
    if job.kind == "chanstyle":
        spec = chanstyle_spec(A, doc)
        spec["model"] = A.VISUAL_MODEL
        job.summary = "Claude собирает стиль канала…"
        r = A.run_claude(job, spec)
        save_style_file(A, cid, "style", r["style_guide"].strip() + "\n")
        save_style_file(A, cid, "palette", {"colors": r.get("palette") or [], "fonts": r.get("fonts") or {}})
        save_style_file(A, cid, "voice", r.get("voice") or {})
        save_style_file(A, cid, "captions", r.get("captions") or {})
        rules = dict(doc.get("rules") or {}, **{k: v for k, v in (r.get("rules") or {}).items() if v is not None})
        ops = [{"op": "set", "path": ["about"], "value": r.get("about") or doc.get("about", "")},
               {"op": "set", "path": ["rules"], "value": rules},
               {"op": "set", "path": ["style3d"], "value": r.get("style3d") or "paper"},
               {"op": "set", "path": ["toolkitChoice"], "value": {"kind": r.get("toolkit") or "paper", "note": r.get("toolkit_note") or ""}},
               {"op": "set", "path": ["hero"], "value": dict((doc.get("hero") or {}), **(r.get("hero") or {}))},
               {"op": "set", "path": ["interview", "done"], "value": True},
               {"op": "set", "path": ["interview", "styled"], "value": now_ms()}]
        A.apply_ops(job.key, ops)
        job.result = {k: r.get(k) for k in ("about", "voice", "captions", "style3d", "toolkit", "hero")}
        job.summary = f"Стиль собран: стайл-гайд, {len(r.get('palette') or [])} цветов, голос {(r.get('voice') or {}).get('voice', '')}, герой «{(r.get('hero') or {}).get('name', '')}»"
        return True
    if job.kind == "chanhero":
        job.result = hero_setup(A, cid)
        job.summary = "Герой канала: видео «" + job.result["name"] + "»"
        return True
    return False


# ---------------------------------------------------------------- герой канала: служебное видео с персонажем и пустой сценой
EMPTY_PREFABS = """// Пустая сцена канала (S9, channel_api.EMPTY_PREFABS): пол и задник цветами палитры канала. Предметы и персонажи — из библиотеки (lib:…).
const PICS = {};
const STAGE_COL = %(cols)s;
function stageFloor(g, cw, ch) {
  g.fillStyle = STAGE_COL.floor; g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${0.03 + (i %% 5) * 0.01})`; g.fillRect((i * 97) %% cw, (i * 53) %% ch, 6 + (i %% 7) * 4, 2); }
}
function stageBack(g, cw, ch) {
  const gr = g.createLinearGradient(0, 0, 0, ch); gr.addColorStop(0, STAGE_COL.top); gr.addColorStop(1, STAGE_COL.back);
  g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
}
const PREFABS = {
  stage: { kind: 'env', build(w) {
    w.plane({ key: 'st_floor', size: [8, 6], ppm: 60, draw: stageFloor, flat: true, pos: [0, 0, 0] });
    w.plane({ key: 'st_back', size: [10, 5], ppm: 40, draw: stageBack, pos: [0, 2.5, -2.5] });
  } },
};
"""


def empty_scene(A, vid, el, name, palette):
    cols = {"floor": "#6b5a48", "back": "#2c3550", "top": "#4d6085"}
    for c in (palette or {}).get("colors") or []:
        u = (c.get("use") or "").lower()
        if "фон" in u and cols["back"] == "#2c3550":
            cols["back"] = c["hex"]
        elif ("пол" in u or "земл" in u) and cols["floor"] == "#6b5a48":
            cols["floor"] = c["hex"]
    wd = os.path.join(P.render(vid), el, "work")
    os.makedirs(wd, exist_ok=True)
    A.write_text(os.path.join(wd, "prefabs.js"), EMPTY_PREFABS % {"cols": json.dumps(cols)})
    doc = {"schema": 1, "id": el, "name": name, "len": 6, "fps": 30,
           "world": {"fx": {"preset": "day"}, "bg": cols["back"], "env": "stage"},
           "camera": {"fov": 30, "handheld": 0.004, "keys": [{"id": "c1", "t": 0, "pos": [0, 1.15, 4.2], "target": [0, 0.85, 0], "ease": "io"}], "cuts": []},
           "lights": [{"id": "l1", "name": "Небо", "type": "ambient", "sky": "#ffffff", "ground": "#5a4a3a", "intensity": 0.9},
                      {"id": "l2", "name": "Солнце", "type": "sun", "pos": [2, 4, 3], "color": "#fff1d6", "intensity": 1.6}],
           "objects": [], "sounds": [], "markers": [], "comments": [], "authored": {}, "rev": 0, "updated": now_ms(), "libs": []}
    A.write_text(os.path.join(wd, "scene.json"), json.dumps(doc, ensure_ascii=False, indent=1))
    return wd


def hero_setup(A, cid):
    c = chan(cid)
    doc = A.load("channel:" + cid)
    hero = doc.get("hero") or {}
    hn = hero.get("name") or "Герой"
    vids = [v for v, x in P.index(True)["videos"].items() if x.get("channel") == cid]
    for v in vids:                                             # уже есть — вернуть его
        d = A.load("plan:" + v)
        if d.get("heroSetup"):
            return {"video": v, "name": d.get("name")}
    d = A.new_plan("short", f"Герой канала — {hn}", "", channel=cid)
    vid = d["id"]
    ch = A.new_id("e")
    sc = A.new_id("e")
    desc = (hero.get("desc") or "") + (("\nХарактер: " + hero["character"]) if hero.get("character") else "") + (("\nТело: " + hero["skeleton"]) if hero.get("skeleton") else "")
    refs = []                                                  # референсы героя из стиля канала -> файлы видео (как картинки автора у элемента)
    hd = os.path.join(c["dir"], "style", "hero")
    if os.path.isdir(hd):
        os.makedirs(P.files(vid), exist_ok=True)
        for f in sorted(os.listdir(hd)):
            if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                shutil.copy2(os.path.join(hd, f), os.path.join(P.files(vid), "hero-" + f))
                refs.append({"id": A.new_id("r"), "img": f"files/{vid}/hero-{f}", "note": "референс героя (style/hero)"})
    A.apply_ops("plan:" + vid, [
        {"op": "set", "path": ["heroSetup"], "value": True},
        {"op": "set", "path": ["idea"], "value": f"Служебное видео канала «{doc.get('name')}»: главный герой {hn} — персонаж со скелетом для библиотеки и пустая сцена для проверки."},
        {"op": "add", "path": ["elements"], "item": {"id": ch, "kind": "char", "name": hn, "desc": desc, "why": "главный герой канала", "status": "", "refs": refs, "by": "studio", "dim": "3d", "make": hero.get("make") or "blender"}},
        {"op": "add", "path": ["elements"], "item": {"id": sc, "kind": "scene", "name": "Пустая сцена", "desc": "Пол и задник цветами канала — проверить героя в 3D.", "why": "проверка героя",
                                                     "status": "", "refs": [], "by": "studio", "uses": [ch]}},
    ])
    pal = style_files(cid).get("palette") or {}
    empty_scene(A, vid, sc, "Пустая сцена", pal)
    A.apply_ops("plan:" + vid, [{"op": "set", "path": ["elements", sc, "stage"], "value": {"work": f"{vid}/{sc}/work", "from": "empty", "by": "studio", "ts": now_ms()}}])
    return {"video": vid, "name": d["name"], "char": ch, "scene": sc}


# ---------------------------------------------------------------- HTTP / CLI
def handle_get(A, h, p, q):
    cid = (q.get("channel") or [""])[0] or None
    if p == "/api/channel/style":
        h._json(style_files(cid)); return True
    if p == "/api/channel/file":                              # файлы стиля канала (картинки героя)
        c = chan(cid)
        rel = (q.get("f") or [""])[0].replace("\\", "/")
        f = os.path.normpath(os.path.join(c["dir"], *rel.split("/")))
        if not rel.startswith("style/") or not f.startswith(os.path.normpath(os.path.join(c["dir"], "style"))) or not os.path.isfile(f):
            h._json({"error": "нет файла"}, 404); return True
        A._send_file(h, f); return True
    if p == "/api/channel/voicefile":
        f = os.path.join(P.STATE, "voicetest", os.path.basename((q.get("f") or [""])[0]))
        if not os.path.isfile(f):
            h._json({"error": "нет файла"}, 404); return True
        A._send_file(h, f); return True
    return False


def handle_post(A, h, p, body):
    cid = body.get("channel") or None
    if p == "/api/channel/new":
        h._json(new_channel(A, body.get("name"), body.get("icon"), body.get("about") or "")); return True
    if p == "/api/channel/stylefile":
        h._json({"path": save_style_file(A, cid, body.get("kind"), body.get("value"))}); return True
    if p == "/api/channel/restore":
        h._json({"path": restore(A, cid, body.get("name"))}); return True
    if p == "/api/channel/voicetest":
        v = body.get("voice") or {}
        h._json({"f": voice_test(v.get("voice") or VOICES[0], v.get("rate") or "+20%", v.get("pitch") or "+0Hz", body.get("text") or "Привет! Так будет звучать голос канала.")}); return True
    if p in ("/api/channel/questions", "/api/channel/style-build", "/api/channel/hero"):
        kind = {"/api/channel/questions": "chanq", "/api/channel/style-build": "chanstyle", "/api/channel/hero": "chanhero"}[p]
        c = chan(cid)
        j = A.start_job(kind, "channel:" + c["id"], kind, {k: body.get(k) for k in ("block", "n")})
        h._json({"job": j.info()}); return True
    return False


def cli(A, argv):
    """channel new "Имя" [--icon 🧌] [--about "…"] | channel style ID | channel hero ID | channel scene PLAN EL "Имя" (пустая сцена)"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "new":
        print(new_channel(A, a[0], A._opt(a, "--icon", "📺"), A._opt(a, "--about", ""))); return True
    if cmd == "style":
        print(json.dumps(style_files(a[0]), ensure_ascii=False, indent=1)[:4000]); return True
    if cmd == "hero":
        print(hero_setup(A, a[0])); return True
    if cmd == "scene":
        print(empty_scene(A, a[0], a[1], a[2] if len(a) > 2 else "Пустая сцена", {})); return True
    return False
