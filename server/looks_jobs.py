"""Задачи визуалов канала (S14, docs/studio/stage14-looks.md §5–6) — данные и бриф в looks_api.py.

lookprev  — превью лука: демо-сцена на стенде (render_clip.js, 4 с) -> style/looks/<key>/preview_*.mp4 + poster_*.jpg (плитка 4:5); без Claude.
lookhero  — «🦸 Сделать» героя лука: служебное видео с персонажем (channel_api.hero_setup); без Claude.
lookq     — вопросы интервью нового визуала по референсам (Sonnet + Read).
lookbuild — ✨ собрать визуал: техника или лук, ручки (+ свои), пример сцены, палитра, герои (Opus + Read/Write/Edit + node render_shot.js); потом lookprev.
Референсы: картинки style/refs/*, видео со ссылкой и куском «с–по» -> лист кадров 6×5 style/looks/<key>/refs/<id>/sheet.jpg (yt-dlp --download-sections).
"""
import hashlib, json, os, re, shutil, subprocess, threading, time
from urllib.parse import quote

import paths as P  # noqa: E402
import looks_api as L  # noqa: E402

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _port(A):
    try:
        return int(open(os.path.join(A.DATA, ".port")).read().strip())
    except (OSError, ValueError):
        return 8790


# ---------------------------------------------------------------- превью
def hero_img(cid, h):
    m = re.match(r"^lib:([a-z]+)/([a-z0-9-]+)@(\d+)$", h.get("ref") or "")
    return f"/api/lib/file/{cid}/{m.group(1)}/{m.group(2)}/v{m.group(3)}/preview.png" if m else ""


def stand_obj(cid, doc, look):
    """window.LOOK для стенда: + картинки героев из библиотеки и название лука."""
    o = L.look_obj(doc, look)
    o["label"] = look.get("label") or ""
    o["heroes"] = [dict(x, img=hero_img(cid, h) if h.get("kind") == "lib" else "") for x, h in zip(o["heroes"], look.get("heroes") or [])]
    return o


def scene_of(cid, doc, look):
    """(страница стенда, адрес сцены, путь к файлу сцены)."""
    t = L.tech_of(doc, look)
    eng = t.get("engine") or look.get("engine") or "2d"
    rel = look.get("scene") or t.get("scene")
    if rel:
        c = L._chan(cid)
        url, f = f"/chfile/{cid}/{rel}", os.path.join(c["dir"], *rel.split("/"))
    else:
        base = "diorama" if (t.get("key") == "diorama" or eng == "3d") else "paper"
        url, f = f"/render/looks/{base}.js", os.path.join(P.STANDS, "looks", base + ".js")
    return ("/tpl/stand3d.html" if eng == "3d" else "/render/page.html"), url, f


def look_dir(c, look):
    d = os.path.join(c["dir"], "style", "looks", re.sub(r"[^A-Za-z0-9_-]", "_", look.get("key") or look["id"]))
    os.makedirs(d, exist_ok=True)
    return d


def sig(cid, doc, look):
    page, url, f = scene_of(cid, doc, look)
    try:
        mt = os.path.getmtime(f)
    except OSError:
        mt = 0
    return hashlib.sha1(json.dumps([stand_obj(cid, doc, look), page, url, mt], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


_LOCK = P.__dict__.setdefault("_lookprev_lock", threading.Lock())   # render_clip.js держит профили браузеров .clip_profile_N — съёмки по одной (замок переживает перезагрузку модуля)


def render_preview(A, job):
    if not _LOCK.acquire(blocking=False):
        job.summary = "ждёт очереди — снимается превью другого лука"
        _LOCK.acquire()
    try:
        _render_preview(A, job)
    finally:
        _LOCK.release()


def _render_preview(A, job):
    cid, lid = job.params["channel"], job.params["look"]
    key = "channel:" + cid
    c = L._chan(cid)
    for _round in range(3):                                  # правки пришли во время съёмки — снимаем ещё раз (до 3 раз)
        doc = A.load(key)
        lk = L._by(doc.get("looks"), "id", lid)
        if not lk or lk.get("draft"):
            job.summary = "лука нет"
            return
        s, P0 = sig(cid, doc, lk), lk.get("preview") or {}
        d = look_dir(c, lk)
        if P0.get("sig") == s and P0.get("video") and os.path.isfile(os.path.join(c["dir"], *P0["video"].split("/"))):
            job.summary = "превью без изменений"
            return
        A.apply_ops(key, [{"op": "set", "path": ["looks", lid, "preview", "status"], "value": "running"}])
        page, url, _f = scene_of(cid, doc, lk)
        full = (f"http://127.0.0.1:{_port(A)}{page}?scene={quote(url, safe='')}&parts=element"
                f"&lookj={quote(json.dumps(stand_obj(cid, doc, lk), ensure_ascii=False), safe='')}")
        clip = os.path.join(d, "_clip.mp4")
        job.summary = f"снимаю превью «{lk.get('label', '')}»…"
        r = subprocess.run(["node", os.path.join(P.STANDS, "render_clip.js"), full, clip, "4", "24"], cwd=P.STANDS, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=600, creationflags=NOWIN, env=dict(os.environ, WORKERS="2"))
        if not os.path.isfile(clip):
            err = (r.stdout + r.stderr).strip()[-300:]
            A.apply_ops(key, [{"op": "set", "path": ["looks", lid, "preview", "status"], "value": "error"},
                              {"op": "set", "path": ["looks", lid, "preview", "error"], "value": err}])
            raise RuntimeError("превью не снялось: " + err)
        n = int(time.time())
        vid, pst = f"preview_{n}.mp4", f"poster_{n}.jpg"
        crop = "crop=1080:1350:0:150,scale=360:450"            # плитка 4:5 — середина кадра 9:16, где действие
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", clip, "-vf", crop, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(d, vid)], capture_output=True, creationflags=NOWIN, timeout=120)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1.2", "-i", clip, "-vf", crop, "-frames:v", "1", "-q:v", "3", os.path.join(d, pst)],
                       capture_output=True, creationflags=NOWIN, timeout=60)
        for f in os.listdir(d):                                  # прошлые превью и временное — прочь (новое имя: браузер не берёт старое из кэша)
            if (f.startswith(("preview_", "poster_")) and f not in (vid, pst)) or f == "_clip.mp4":
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
        shutil.rmtree(os.path.join(d, "_clip_frames"), ignore_errors=True)
        rel = os.path.relpath(d, c["dir"]).replace("\\", "/")
        A.apply_ops(key, [{"op": "set", "path": ["looks", lid, "preview"],
                           "value": {"video": f"{rel}/{vid}", "poster": f"{rel}/{pst}", "sig": s, "ts": L.now_ms(), "status": "", "error": ""}}])
        job.summary = f"превью «{lk.get('label', '')}» готово"
        d2 = A.load(key)
        if sig(cid, d2, L._by(d2.get("looks"), "id", lid) or lk) == s:
            return


# ---------------------------------------------------------------- референсы: картинка по адресу (🔎 поиск), кусок видео -> лист кадров
def ref_from_url(cid, url, fallback=""):
    import io, urllib.parse, urllib.request, uuid
    from PIL import Image
    c = L._chan(cid)
    last = None
    for u in [x for x in (url, fallback) if x]:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
        for k in ("imgurl", "mediaurl", "img_url"):
            if q.get(k):
                u = q[k][0]
                break
        if not re.match(r"^https?://", u):
            continue
        pr = urllib.parse.urlparse(u)
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                                                      "Referer": f"{pr.scheme}://{pr.netloc}/", "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read(25 << 20)
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((1600, 1600))
            os.makedirs(os.path.join(c["dir"], "style", "refs"), exist_ok=True)
            fn = "r" + uuid.uuid4().hex[:8] + ".jpg"
            im.save(os.path.join(c["dir"], "style", "refs", fn), quality=90)
            return "style/refs/" + fn
        except Exception as e:
            last = e
    raise ValueError(f"сайт не отдал картинку ({last.__class__.__name__ if last else 'нет адреса'}) — сохрани её и перетащи файлом")


def _secs(t):
    t = (t or "").strip()
    if not t:
        return None
    try:
        parts = [float(x) for x in t.replace(",", ".").split(":")]
    except ValueError:
        return None
    v = 0.0
    for x in parts:
        v = v * 60 + x
    return v


def video_sheet(A, c, look, r, log=print):
    """Ссылка на видео (+ кусок с–по) -> лист кадров 6×5 (кэш по ссылке и куску)."""
    out = os.path.join(look_dir(c, look), "refs", re.sub(r"[^A-Za-z0-9_-]", "_", r["id"]))
    a, b = _secs(r.get("from")), _secs(r.get("to"))
    tag = f"{r.get('url')}|{a}|{b}"
    sheet, srcf = os.path.join(out, "sheet.jpg"), os.path.join(out, "src.txt")
    if os.path.isfile(sheet) and os.path.isfile(srcf) and open(srcf, encoding="utf-8").read() == tag:
        return sheet
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    rv = A.vapi()
    args = ["-f", "bv*[height<=480]/b[height<=480]/b", "--merge-output-format", "mp4", "-o", os.path.join(out, "v.%(ext)s")]
    if a is not None or b is not None:
        args += ["--download-sections", f"*{a or 0}-{b if b is not None else 'inf'}", "--force-keyframes-at-cuts"]
    log("качаю кусок видео-референса…")
    rr = rv.ytdlp(*args, r["url"], timeout=1200)
    vids = [f for f in os.listdir(out) if f.startswith("v.") and f.lower().endswith((".mp4", ".mkv", ".webm"))]
    if not vids:
        raise RuntimeError("yt-dlp не скачал видео: " + (rr.stderr or rr.stdout or "").strip()[-200:])
    v = os.path.join(out, vids[0])
    dur = rv.duration(v) or 30
    step = max(0.2, dur / 30)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", v, "-vf", f"fps=1/{step:.3f},scale=320:-2,tile=6x5:padding=4:color=white", "-frames:v", "1", "-q:v", "4", sheet],
                   capture_output=True, creationflags=NOWIN, timeout=300)
    try:
        os.remove(v)
    except OSError:
        pass
    if not os.path.isfile(sheet):
        raise RuntimeError("не нарезал кадры из видео")
    open(srcf, "w", encoding="utf-8").write(tag)
    return sheet


def gather_refs(A, c, look, log=print):
    """Референсы полки и вложения к ответам -> [(путь картинки, подпись)] для Read; видео — листами кадров."""
    out = []
    items = [(r, "полка") for r in look.get("refs") or []]
    for q in (look.get("interview") or {}).get("qa") or []:
        items += [(r, f"к ответу «{q.get('q', '')[:60]}»") for r in q.get("refs") or []]
    for r, where in items:
        note = (r.get("note") or "").strip()
        if r.get("img"):
            f = os.path.join(c["dir"], *r["img"].split("/"))
            if os.path.isfile(f):
                out.append((f, f"картинка ({where}){': ' + note if note else ''}"))
        elif r.get("url"):
            try:
                sh = video_sheet(A, c, look, r, log)
                rng = f" {r.get('from') or '0:00'}–{r.get('to') or 'конец'}" if (r.get("from") or r.get("to")) else ""
                out.append((sh, f"видео {r['url']}{rng} — 30 кадров сеткой 6×5 слева направо, сверху вниз ({where}){': ' + note if note else ''}"))
            except Exception as e:
                log(f"видео-референс не разобран: {e}")
    return out


# ---------------------------------------------------------------- промпты
def techs_text(doc):
    rows = []
    for t in doc.get("techniques") or []:
        ctl = "; ".join(f"{x['key']} ({x.get('label', '')}, {x.get('type')}" + (f" {x.get('min')}…{x.get('max')}" if x.get("type") == "slider" else "")
                        + (f": {', '.join(str(o[0]) for o in x.get('options') or [])}" if x.get("type") == "select" else "") + ")" for x in t.get("controls") or [])
        looks = ", ".join(lk.get("label", "") for lk in doc.get("looks") or [] if lk.get("tech") == t["key"] and not lk.get("draft"))
        rows.append(f"- {t['key']} — {t.get('label')} [{t.get('engine')}]: {t.get('desc', '')}\n  луки: {looks or '—'}\n  ручки: {ctl}")
    return "\n".join(rows)


def qa_text(look):
    rows = []
    for q in (look.get("interview") or {}).get("qa") or []:
        rows.append(f"- {q['q']}\n  → {(q.get('a') or '').strip() or '(без ответа)'}" + (f" [+ {len(q.get('refs') or [])} вложений]" if q.get("refs") else ""))
    return "\n".join(rows)


def chan_ctx(c):
    """Визуал из интервью канала: начало стайл-гайда и палитра канала — это первый, главный лук канала."""
    try:
        g = open(os.path.join(c["dir"], "style", "style-guide.md"), encoding="utf-8").read()[:5000]
    except OSError:
        g = ""
    try:
        pal = json.load(open(os.path.join(c["dir"], "style", "palette.json"), encoding="utf-8")).get("colors") or []
    except (OSError, ValueError):
        pal = []
    return ("Это ПЕРВЫЙ визуал нового канала — собери его по интервью канала, а не по чужим лукам. Стайл-гайд канала (начало):\n" + g
            + ("\nПалитра канала: " + ", ".join(f"{x.get('name')} {x.get('hex')}" for x in pal) if pal else ""))


def refs_list(refs):
    return "\n".join(f"- {f} — {w}" for f, w in refs) or "(референсов нет)"


def lookq_spec(A, doc, look, refs, n):
    C = A.capi()
    return {"system": "Ты — арт-директор YouTube-канала: помогаешь автору сформулировать новый визуал (вид роликов) по его референсам для Claude Studio. "
                      "По-русски, коротко, конкретно. Отвечай строго JSON по схеме.",
            "prompt": f"""Канал «{doc.get('name')}». О канале: {doc.get('about') or '—'}.
Автор собирает новый визуал «{look.get('label') or 'без названия'}». Посмотри референсы (Read каждого файла):
{refs_list(refs)}

Какие техники уже есть у канала (движок кадра и его ручки):
{techs_text(doc)}

Задай {n} вопросов про ЭТОТ вид: что именно взять из референсов (контур, свет, материал, фактура, цвет, камера, движение, 2D или объём), чем он отличается от луков канала,
нужен ли постоянный герой и кто. Каждый вопрос — с вариантами прямо в тексте и ссылкой на конкретный референс («как на 2-й картинке или…?»), ответ — за 10–30 секунд.
Не повторяй уже заданное. q — вопрос; why — что решит ответ.

Уже спросили:
{qa_text(look) or '(ничего)'}""",
            "schema": C.S({"questions": C.ARR(C.S({"q": C.STR, "why": C.STR}, ["q"]))}),
            "tools": ["Read"], "allowed": ["Read"], "dirs": sorted({os.path.dirname(f) for f, _ in refs}), "timeout": 600}


def lookbuild_spec(A, doc, c, look, refs, wd, port):
    C = A.capi()
    S, STR, ARR = C.S, C.STR, C.ARR
    shot = os.path.join(P.STANDS, "render_shot.js").replace("\\", "/")
    st, eng_dir, wdf = P.STANDS.replace("\\", "/"), P.ENGINE.replace("\\", "/"), wd.replace("\\", "/")
    rel = os.path.relpath(wd, c["dir"]).replace("\\", "/")
    base = f"http://127.0.0.1:{port}"
    lookf, scene = quote(f"/chfile/{c['id']}/{rel}/look.json"), quote(f"/chfile/{c['id']}/{rel}/scene.js")   # простые пути: команда рендера как у черновиков элементов
    url2 = f"{base}/render/page.html?scene={scene}&parts=element&lookf={lookf}"
    url3 = f"{base}/tpl/stand3d.html?scene={scene}&parts=element&lookf={lookf}"
    ctl = S({"key": STR, "label": STR, "hint": STR, "type": {"type": "string", "enum": ["toggle", "slider", "select", "color"]}, "min": {"type": "number"}, "max": {"type": "number"},
             "step": {"type": "number"}, "options": ARR(ARR(STR)), "default": STR, "group": STR, "dep": STR}, ["key", "label", "type", "default"])
    try:
        libs = [x for x in json.load(open(os.path.join(c["dir"], "library", "index.json"), encoding="utf-8")) if x.get("kind") == "characters"]
    except (OSError, ValueError):
        libs = []
    schema = S({"decision": {"type": "string", "enum": ["look", "tech"]}, "why": STR, "tech": STR,
                "new_tech": S({"key": STR, "label": STR, "icon": STR, "desc": STR, "engine": {"type": "string", "enum": ["2d", "3d"]}, "controls": ARR(ctl)}),
                "label": STR, "desc": STR, "params": ARR(S({"key": STR, "value": STR}, ["key", "value"])), "extra": ARR(ctl), "scene": {"type": "boolean"},
                "palette": ARR(S({"name": STR, "hex": STR, "use": STR}, ["name", "hex"])),
                "heroes": ARR(S({"kind": {"type": "string", "enum": ["lib", "hog", "desc"]}, "ref": STR, "name": STR, "desc": STR, "role": STR}, ["kind", "name"])), "note": STR},
               ["decision", "why", "label", "desc", "params", "palette", "heroes"])
    lib_txt = ", ".join(f"lib:{x['id']}@{x.get('latest', 1)} ({x.get('name')}{', ёжик тулкита — kind hog' if x.get('hog') else ''})" for x in libs) or "пусто"
    prompt = f"""Собери новый визуал канала «{doc.get('name')}» по референсам и интервью автора. О канале: {doc.get('about') or '—'}.

Референсы (Read каждый):
{refs_list(refs)}

Интервью (ответы автора — его решения):
{qa_text(look) or '(без интервью)'}
{chan_ctx(c) if look.get("from") == "interview" else ""}

Техники канала — движок кадра, его ручки (window.LOOK, путь с точкой) и луки:
{techs_text(doc)}

Устройство (docs/studio/stage14-looks.md): техника — чем рисуется кадр (2D — тулкит paper.js на canvas; 3D — stage3d.js, three.js), лук — значения ручек + палитра + герои.
Ручки уже работают в движке: paper.edge/shadow/grain/drift (множители 2D-тулкита), post.vignette/sat/warm/tint/tintA (цвет кадра), fx.* (3D: bloom, dof, tilt, grade, ca, noise), cards.facing, style3d.

1. Реши: decision = "look" — новый лук в имеющейся технике (tech = её key), если вид достижим её движком и ручками (+ свои ручки);
   "tech" — новая техника (new_tech: key латиницей, label, icon-эмодзи, desc, engine 2d|3d, controls — её ручки: нужные из встроенных того же движка + свои),
   если вид требует другого способа рисования (пиксель-арт, Vox-коллаж, контур по глубине…). why — почему, 1–2 фразы для автора.
2. Свои ручки (extra; у новой техники — в её controls) — 2–6 штук под то, что важно в референсах (толщина контура, пикселизация, постеризация, цвет обводки…):
   key — custom.<имя>; type toggle | slider (min, max, step) | select (options [[значение, подпись]]) | color; default — строкой; group — «Своё»; hint — что делает.
   Свои ручки работают ТОЛЬКО в коде сцен: читай их как LOOKV('custom.<имя>', умолчание).
3. Пример сцены — если есть свои ручки или новая техника, напиши {wdf}/scene.js (scene = true) по контракту стенда:
   const PICS = {{}}; const ELEMENT = {{ t: 1.2, len: 5, draw(ctx, T) {{ … }} }}; для 3D ещё const WORLD = world3d({{ fx: 'dusk', build(w) {{ … }}, update(w, lt) {{ … }} }}) и WORLD.draw(ctx, T, 5, T) в ELEMENT.draw.
   Возьми за основу образцы {st}/looks/paper.js (2D) и {st}/looks/diorama.js (3D): window.LOOK — palette, heroes (kind hog | img), label; в конце vignette(ctx, LOOKV('post.vignette', 0.45)) и lookPost(ctx).
   Сцена — 5 с петлёй, читается в окошке 9:16 (главное — в середине по высоте, y 300…1650), показывает вид: фон, пара предметов, плашка, герои лука; свои ручки ВИДНО меняют картинку.
   Тулкит 2D — {st}/paper.js, 3D — {eng_dir}/stage3d.js (шапка — API), общие помощники — {eng_dir}/lib.js.
   Проверка: запиши {wdf}/look.json — объект window.LOOK (вложенный: {{"paper": {{"edge": 1.4}}, "custom": {{"outline": 3}}, "palette": ["#…"], "heroes": [], "label": "…"}})
   и сними кадр командой (ровно так, адрес в кавычках):
     2D: node {shot} "{url2}" "{wdf}/shot"
     3D: node {shot} "{url3}" "{wdf}/shot"
   Команду запускай одну, без cd, && и перенаправлений — иначе она не разрешится. Посмотри shot/element.png (Read), сравни с референсами, поправь сцену и значения.
   2–3 прохода. Ошибки страницы печатаются в консоль.
   Нет своих ручек и техника имеющаяся — scene = false: превью снимется на демо-сцене техники.
4. params — значения ВСЕХ важных ручек лука (key, value строкой: "1.4", "true", "#c8202b"); label — короткое название; desc — 1–2 фразы для брифа (материалы, свет, цвет, камера).
5. palette — 5–8 цветов из референсов (name, hex, use). heroes — по интервью: kind lib (ref из библиотеки канала: {lib_txt}), hog — бумажный ёжик тулкита,
   desc — новый персонаж (name, desc для художника); не хочет героя — пустой список. role "main" — у главного.
note — что получилось и что автору покрутить."""
    return {"system": "Ты — арт-директор и технический художник Claude Studio: по референсам собираешь визуал канала — технику или лук с ручками и примером сцены. "
                      "По-русски. Отвечай строго JSON по схеме.",
            "prompt": prompt, "schema": schema, "cwd": wd, "timeout": 2400,
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"], "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(node {shot}:*)"],
            "dirs": sorted({wd, P.STANDS, P.ENGINE} | {os.path.dirname(f) for f, _ in refs})}


# ---------------------------------------------------------------- результат сборки
def _val(v, ctl):
    t = (ctl or {}).get("type")
    if isinstance(v, str):
        if t == "toggle":
            return v.strip().lower() in ("true", "1", "да", "вкл", "on")
        if t == "slider":
            try:
                return float(v)
            except ValueError:
                return (ctl or {}).get("min") or 0
    return v


def _ctl_clean(x):
    x = {k: v for k, v in x.items() if v not in (None, "", [])}
    x["default"] = _val(x.get("default"), x)
    x.setdefault("group", "Своё")
    return x


def apply_build(A, key, c, lid, lk, r, wd):
    doc = A.load(key)
    ops, new_tech = [], None
    if r.get("decision") == "tech" and (r.get("new_tech") or {}).get("key"):
        nt = r["new_tech"]
        tk = re.sub(r"[^a-z0-9_-]", "", nt["key"].lower()) or "t" + A.new_id("")
        while L._by(doc.get("techniques"), "key", tk):
            tk += "2"
        new_tech = {"id": A.new_id("t"), "key": tk, "label": nt.get("label") or tk, "icon": nt.get("icon") or "🎨", "desc": nt.get("desc") or "",
                    "engine": nt.get("engine") or "2d", "builtin": False, "controls": [_ctl_clean(x) for x in nt.get("controls") or [] if x.get("key")], "scene": None}
        tech = new_tech
    else:
        tech = L._by(doc.get("techniques"), "key", r.get("tech")) or (doc.get("techniques") or [{}])[0]
    extra = [_ctl_clean(x) for x in r.get("extra") or [] if x.get("key")]
    scene_rel = None
    if r.get("scene") and os.path.isfile(os.path.join(wd, "scene.js")):
        scene_rel = os.path.relpath(os.path.join(wd, "scene.js"), c["dir"]).replace("\\", "/")
        if new_tech:
            new_tech["scene"] = scene_rel                       # сцена новой техники — её демо-сцена
    if new_tech:
        ops.append({"op": "add", "path": ["techniques"], "item": new_tech})
    tmp = {"techniques": (doc.get("techniques") or []) + ([new_tech] if new_tech else [])}
    lk2 = dict(lk, tech=tech["key"], extra=extra, params={})
    cmap = {x["key"]: x for x in L.controls(tmp, lk2)}
    params = L.effective(tmp, lk2)
    for p_ in r.get("params") or []:
        if p_.get("key"):
            params[p_["key"]] = _val(p_.get("value"), cmap.get(p_["key"]))
    heroes, any_main = [], any(h.get("role") == "main" for h in r.get("heroes") or [])
    for i, h in enumerate(r.get("heroes") or []):
        if h.get("kind") == "lib" and not re.match(r"^lib:characters/[a-z0-9-]+@\d+$", h.get("ref") or ""):
            h = dict(h, kind="desc")
        heroes.append({"id": A.new_id("h"), "kind": h["kind"], "ref": h.get("ref") or "", "name": h.get("name") or "герой", "desc": h.get("desc") or "",
                       "role": "main" if (h.get("role") == "main" or (i == 0 and not any_main)) else ""})
    upd = {"tech": tech["key"], "engine": tech.get("engine") or "2d", "label": r.get("label") or lk.get("label"), "desc": r.get("desc") or "", "params": params, "extra": extra,
           "scene": None if new_tech else scene_rel, "palette": {"colors": r.get("palette") or []}, "heroes": heroes, "draft": False,
           "build": {"why": r.get("why") or "", "note": r.get("note") or "", "decision": r.get("decision"), "ts": L.now_ms()}}
    ops += [{"op": "set", "path": ["looks", lid, k], "value": v} for k, v in upd.items()]
    A.apply_ops(key, ops)
    return tech, new_tech


def run_job(A, job):
    cid, lid = job.params.get("channel"), job.params.get("look")
    key = "channel:" + cid
    if job.kind == "lookprev":
        return render_preview(A, job)
    c = L._chan(cid)
    doc = A.load(key)
    lk = L._by(doc.get("looks"), "id", lid)
    if not lk:
        raise ValueError("нет такого лука")

    def log(m):
        job.summary = m
    if job.kind == "lookhero":
        h = L._by(lk.get("heroes"), "id", job.params.get("hero"))
        if not h:
            raise ValueError("нет такого героя у лука")
        r = A.chnapi().hero_setup(A, cid, hero=dict(h, make=h.get("make") or "parts"), tag=f"{lid}:{h['id']}")
        A.apply_ops(key, [{"op": "set", "path": ["looks", lid, "heroes"], "value": [dict(x, video=r["video"]) if x.get("id") == h["id"] else x for x in lk.get("heroes") or []]}])
        job.result, job.summary = r, f"Герой «{h.get('name')}»: видео «{r['name']}»"
        return
    if job.kind == "lookq":
        log("смотрю референсы…")
        refs = gather_refs(A, c, lk, log)
        spec = lookq_spec(A, doc, lk, refs, int(job.params.get("n") or 7))
        spec["model"] = A.TEXT_MODEL
        log("Claude смотрит референсы и придумывает вопросы…")
        r = A.run_claude(job, spec)
        ops = [{"op": "add", "path": ["looks", lid, "interview", "qa"], "item": {"id": A.new_id("q"), "q": q["q"], "why": q.get("why", ""), "a": "", "refs": [], "by": "claude"}}
               for q in r.get("questions") or [] if q.get("q")]
        if not lk.get("interview"):
            ops.insert(0, {"op": "set", "path": ["looks", lid, "interview"], "value": {"qa": [], "done": False}})
        A.apply_ops(key, ops)
        job.summary = f"Claude: +{len(ops)} вопросов"
        return
    if job.kind == "lookbuild":
        log("смотрю референсы…")
        refs = gather_refs(A, c, lk, log)
        wd = os.path.join(look_dir(c, lk), "build")
        os.makedirs(wd, exist_ok=True)
        spec = lookbuild_spec(A, doc, c, lk, refs, wd, _port(A))
        spec["model"] = A.VISUAL_MODEL
        if getattr(A, "VISUAL_EFFORT", ""):
            spec["effort"] = A.VISUAL_EFFORT
        log("Claude (Opus) собирает визуал…")
        try:
            r = A.run_claude(job, spec)
        except Exception as e:
            A.apply_ops(key, [{"op": "set", "path": ["looks", lid, "build"], "value": {"error": str(e)[:300], "ts": L.now_ms()}}])
            raise
        tech, new_tech = apply_build(A, key, c, lid, lk, r, wd)
        job.result = {"look": lid, "tech": tech["key"], "decision": r.get("decision")}
        job.summary = (f"Новая техника «{tech['label']}» и лук «" if new_tech else "Новый лук «") + (r.get("label") or "") + "» — снимаю превью…"
        try:
            A.start_job("lookprev", key, "lookprev:" + lid, {"channel": cid, "look": lid})
        except Exception:
            pass
        return
