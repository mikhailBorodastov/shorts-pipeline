"""Референсы видео (бриф): ссылки и файлы автора -> разбор (refvideo.py: кадры + расшифровка) -> refs[].parse; CLI для агента сценария.

refs[] = {id, kind: video|link|image, url, path, title, channel, dur, note, role: 'base' (S16: референс подачи, один на видео), parse: {status: running|done|error, msg, title, channel, dur, step,
          sheets[], transcript, info, text (первые 12000 знаков), text_from, err, at, pid,
          base: {status, words, phrases, sheets[], step, shots, cuts, lang, rhythm{wps, phrase, pauses, speech, words, dur}, err}}}   — только у base
Видео разбирается в <видео>/files/ref_<id>/ (video.mp4, sheet*.jpg, transcript.txt, info.json).

    python studio.py ref list  <видео>                  — референсы, статус разбора, пути к расшифровке и кадрам
    python studio.py ref add   <видео> "<ссылка|путь>" [--note "что взять"]   (несколько ссылок подряд — тоже можно)
    python studio.py ref parse <видео> [<rid> | --all] [--force]   — фоновый разбор (не ждёт: длинный ролик качается дольше лимита Bash)
    python studio.py ref wait  <видео> [--max 100]       — ждать конца разборов (сек), печатать ход; не дождался — запусти снова
    python studio.py ref read  <видео> <rid> [--from 0] [--chars 20000]   — расшифровка кусками
    python studio.py ref base  <видео> <rid> [--off]     — S16: референс подачи (📐 за основу): разбор по словам, кадры с таймкодом, склейки
"""
import json, os, re, subprocess, sys, time, uuid

import paths as P

VIDEO_RE = re.compile(r"youtu\.?be|vimeo\.com|tiktok\.com|rutube\.ru|vk\.com/(video|clip)|vkvideo\.ru|dzen\.ru/video|twitch\.tv|instagram\.com/(reel|p)/"
                      r"|x\.com/.+/status|twitter\.com/.+/status|bilibili\.com|\.(mp4|mov|webm|mkv|m4v)(\?|$)", re.I)
VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
STALE = 3 * 3600                                    # «running» дольше — процесс умер, можно запускать заново
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def kind_of(src):
    src = (src or "").strip()
    if re.match(r"https?://", src):
        return "video" if VIDEO_RE.search(src) else "link"
    return "video" if os.path.isdir(src) or src.lower().endswith(VIDEO_EXT) else "link"


def split_src(s):
    """Строка из поля -> список ссылок / путей. Ссылки, склеенные без пробела, — разные референсы; путь с пробелами — один."""
    s = (s or "").strip().strip('"')
    if not re.search(r"https?://", s):
        return [s] if s else []
    out = []
    for part in re.split(r"\s+", s):
        out += [u for u in re.split(r"(?=https?://)", part) if re.match(r"https?://", u)]
    return out


def clean_url(u):
    """YouTube: без служебных &pp= / &si= / &t=… — та же ссылка, но читаемая (и одинаковая для дублей)."""
    m = re.search(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/)|youtu\.be/)([\w-]{11})", u)
    if m:
        return ("https://www.youtube.com/shorts/" if "/shorts/" in u else "https://www.youtube.com/watch?v=") + m.group(1)
    return u


def add(A, key, raw, note="", kinds=None):
    """+ референсы из строки (одна или несколько ссылок / путь). -> [{id, kind, url|path}]; видео сразу ставятся на разбор, если можно."""
    d = A.load(key)
    have = {clean_url(r.get("url") or "") for r in d.get("refs") or [] if r.get("url")}
    items, ops = [], []
    for src in split_src(raw):
        url = re.match(r"https?://", src) is not None
        if url:
            src = clean_url(src)
            if src in have:
                continue
            have.add(src)
        k = kinds or kind_of(src)
        it = {"id": "r" + uuid.uuid4().hex[:6], "kind": k, "url": src if url else "", "path": "" if url else src, "title": "", "note": note, "parse": {}}
        items.append(it)
        ops.append({"op": "add", "path": ["refs"], "item": it})
    if ops:
        A.apply_ops(key, ops)
    return items


def alive(key):
    """Видео ещё в канале (не ушло в архив, пока шёл разбор): иначе запись в документ воскресила бы его папку."""
    if key.startswith("plan:") and not P.video(key[5:]):
        raise RuntimeError("видео в архиве — разбор остановлен")


def _set(A, key, rid, **kv):
    alive(key)
    A.apply_ops(key, [{"op": "set", "path": ["refs", rid, k], "value": v} for k, v in kv.items()])


def _patch_parse(A, key, rid, **kv):
    r = A._by_id(A.load(key).get("refs"), rid) or {}
    ps = dict(r.get("parse") or {})
    ps.update(kv)
    _set(A, key, rid, parse=ps)


def is_live(ps):
    return ps.get("status") == "running" and time.time() * 1000 - (ps.get("at") or 0) < STALE * 1000


def run(A, key, rid, log=None):
    """Разбор одного референса (в потоке задачи сервера или в фоновом процессе CLI)."""
    vapi = A.vapi()
    r = A._by_id(A.load(key).get("refs"), rid)
    if not r:
        raise ValueError("референс не найден")
    src = (r.get("url") or r.get("path") or "").strip()
    if not src:
        raise ValueError("у референса нет ссылки или пути")
    t_last = [0.0]

    def say(s):
        if log:
            log(s)
        if time.time() - t_last[0] > 4:                   # ход разбора — в документ (страница показывает «разбираю: …»)
            t_last[0] = time.time()
            _patch_parse(A, key, rid, msg=s)
    _set(A, key, rid, parse={"status": "running", "msg": "начинаю…", "at": A.now_ms(), "pid": os.getpid()})
    if re.match(r"https?://", src) and not r.get("title"):  # название — сразу, до скачивания
        try:
            m = vapi.meta(src)
            kv = {k: v for k, v in (("title", m["title"][:160]), ("channel", m["channel"][:80]), ("dur", round(m["dur"]))) if v}
            if kv:
                _set(A, key, rid, **kv)
        except Exception as e:
            say(f"название не получил: {str(e)[:120]}")
    try:
        res = vapi.parse(src, os.path.join(P.files(key[5:]), "ref_" + rid), say)
    except Exception as e:
        _set(A, key, rid, parse={"status": "error", "err": str(e)[:300], "at": A.now_ms()})
        raise
    rel = A.rel_data
    ps = {"status": "done", "title": res["title"], "channel": res.get("channel", ""), "dur": res["dur"], "step": res["step"],
          "sheets": [rel(s) for s in res["sheets"]], "transcript": rel(res["transcript"]), "info": rel(res["info"]),
          "text": res["text"][:12000], "chars": len(res["text"]), "text_from": res.get("text_from", ""), "video": res["video"], "at": A.now_ms()}
    r = A._by_id(A.load(key).get("refs"), rid) or {}
    kv = {"parse": ps}
    if not r.get("title") and res["title"]:
        kv["title"] = res["title"][:160]
    if not r.get("channel") and res.get("channel"):
        kv["channel"] = res["channel"][:80]
    if not r.get("dur") and res["dur"]:
        kv["dur"] = round(res["dur"])
    _set(A, key, rid, **kv)
    msg = f"«{res['title'][:60]}»: {len(res['sheets'])} лист(а) кадров, расшифровка {len(res['text'])} знаков ({res.get('text_from') or '—'})"
    if r.get("role") == "base":                             # S16: референс подачи — ещё ритм по словам и кадры с таймкодом
        msg += " · " + run_base(A, key, rid, log)
    return msg


def run_base(A, key, rid, log=None):
    """S16: разбор референса подачи поверх обычного (видео уже скачано): refvideo.base_extras -> refs[].parse.base."""
    r = A._by_id(A.load(key).get("refs"), rid) or {}
    ps = r.get("parse") or {}
    if ps.get("status") != "done" or not ps.get("video") or not os.path.isfile(ps["video"]):
        raise ValueError("референс ещё не разобран — сначала обычный разбор")
    _patch_parse(A, key, rid, base={"status": "running", "at": A.now_ms()})

    def say(s):
        if log:
            log(s)
        _patch_parse(A, key, rid, msg=s)
    try:
        b = A.vapi().base_extras(ps["video"], os.path.join(P.files(key[5:]), "ref_" + rid), ps.get("dur") or 0, say)
    except Exception as e:
        _patch_parse(A, key, rid, base={"status": "error", "err": str(e)[:300], "at": A.now_ms()}, msg="")
        raise
    rel = A.rel_data
    out = os.path.join(P.files(key[5:]), "ref_" + rid)
    video = ps["video"]
    if os.path.dirname(os.path.abspath(video)) != os.path.abspath(out) and os.path.getsize(video) < 300 * 2 ** 20:   # файл с диска: копия рядом — плеер карты подачи берёт его с сервера
        import shutil
        dst = os.path.join(out, "video" + os.path.splitext(video)[1].lower())
        shutil.copy2(video, dst)
        video = dst
    base = {"status": "done", "video": rel(video), "words": rel(b["words"]), "phrases": rel(b["phrases"]), "sheets": [rel(x) for x in b["sheets"]], "step": b["step"],
            "shots": rel(b["shots"]), "cuts": b["cuts"], "lang": b["lang"], "rhythm": b["rhythm"], "at": A.now_ms()}
    _patch_parse(A, key, rid, base=base, msg="")
    R = b["rhythm"]
    return f"подача: {R['words']} слов, {R['wps']} сл/с, фраза ~{R['phrase']}, склеек {b['cuts']}"


def base_of(plan):
    """Референс подачи видео (S16) или None."""
    return next((r for r in (plan or {}).get("refs") or [] if r.get("role") == "base"), None)


def set_base(A, key, rid, on=True, cli=False):
    """📐 За основу: роль base одному референсу (у прежнего снимается); разобран — сразу разбор подачи, нет — обычный разбор (он сам сделает и подачу)."""
    refs = A.load(key).get("refs") or []
    r = A._by_id(refs, rid)
    if not r:
        raise ValueError("референс не найден")
    if on and r.get("kind") != "video":
        raise ValueError("за основу можно взять только видео")
    ops = [{"op": "set", "path": ["refs", x["id"], "role"], "value": None} for x in refs if x.get("role") == "base" and x["id"] != rid]
    ops.append({"op": "set", "path": ["refs", rid, "role"], "value": "base" if on else None})
    A.apply_ops(key, ops)
    if not on:
        return "снято"
    ps = r.get("parse") or {}
    if cli:                                                # CLI: задачи сервера тут не живут — подача сразу, разбор — фоновым процессом
        if ps.get("status") == "done":
            return "основа подачи · " + (run_base(A, key, rid, print) if (ps.get("base") or {}).get("status") != "done" else "уже разобрана")
        if not is_live(ps):
            _spawn(key, rid)
        return f"основа подачи — разбираю в фоне (ref wait {key[5:]})"
    if ps.get("status") == "done":
        if (ps.get("base") or {}).get("status") != "done":
            try:
                A.start_job("refbase", key, "refbase:" + rid, {"ref": rid})
            except RuntimeError:
                pass
        return "основа подачи"
    if not is_live(ps):
        try:
            A.start_job("refparse", key, "refparse:" + rid, {"ref": rid})
        except RuntimeError:
            pass
    return "основа подачи — разбираю"


def autoparse(A, key):
    """Все видео-референсы без разбора — на разбор задачами сервера (после «Новое видео» и «+ референс»)."""
    n = 0
    for r in A.load(key).get("refs") or []:
        ps = r.get("parse") or {}
        if r.get("kind") == "video" and ps.get("status") != "done" and not is_live(ps):
            try:
                A.start_job("refparse", key, "refparse:" + r["id"], {"ref": r["id"]})
                n += 1
            except RuntimeError:
                pass                                       # уже идёт
    return n


# ---------------------------------------------------------------- CLI (агент сценария)
def _abs(rel):
    return os.path.abspath(P.resolve(rel)).replace("\\", "/") if rel else ""


def _mm(s):
    s = int(s or 0)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def list_text(A, key):
    refs = A.load(key).get("refs") or []
    if not refs:
        return "Референсов нет."
    L = []
    for r in refs:
        ps = r.get("parse") or {}
        if r.get("kind") == "image":
            L.append(f"{r['id']}  🖼 картинка {_abs(r.get('img'))}" + (f" — {r['note']}" if r.get("note") else ""))
            continue
        st = {"done": "✅ разобран", "error": "❌ ошибка", "running": "⏳ разбирается" if is_live(ps) else "⚠ завис"}.get(ps.get("status"), "— не разобран")
        L.append(f"{r['id']}  {'📼 видео' if r.get('kind') == 'video' else '🔗 ссылка'}  «{r.get('title') or ps.get('title') or '(без названия)'}»"
                 + (f" · {r.get('channel') or ps.get('channel')}" if r.get("channel") or ps.get("channel") else "")
                 + (f" · {_mm(r.get('dur') or ps.get('dur'))}" if r.get("dur") or ps.get("dur") else "") + f"  [{st}]")
        L.append(f"    {r.get('url') or r.get('path')}")
        if r.get("role") == "base":
            L.append("    📐 РЕФЕРЕНС ПОДАЧИ — наш ролик рассказывается в его подаче (карта: beatmap show)")
        if r.get("note"):
            L.append(f"    что взять (автор): {r['note']}")
        bs = ps.get("base") or {}
        if bs.get("status") == "done":
            R = bs.get("rhythm") or {}
            L.append(f"    подача: фразы с таймкодами {_abs(bs.get('phrases'))} · {R.get('wps')} сл/с, фраза ~{R.get('phrase')} сл., пауз {R.get('pauses')}, склеек {bs.get('cuts')}")
            L.append(f"    кадры с таймкодом (5×4, каждые {bs.get('step')} с): " + ", ".join(_abs(x) for x in bs.get("sheets") or []))
        if ps.get("status") == "done":
            L.append(f"    расшифровка: {_abs(ps.get('transcript'))}  ({ps.get('chars') or len(ps.get('text') or '')} знаков, {ps.get('text_from') or '—'})")
            L.append(f"    кадры (сеткой 6×5, каждые {ps.get('step')} с): " + ", ".join(_abs(s) for s in ps.get("sheets") or []))
            if ps.get("info"):
                L.append(f"    описание и главы: {_abs(ps['info'])}")
        elif ps.get("status") == "error":
            L.append(f"    ошибка: {ps.get('err')}")
        elif is_live(ps):
            L.append(f"    сейчас: {ps.get('msg') or '…'}")
    return "\n".join(L)


def _spawn(key, rid):
    """Фоновый разбор: отдельный процесс, переживает конец команды агента."""
    flags = NOWIN | getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    logf = os.path.join(P.files(key[5:]), f"ref_{rid}.log")
    os.makedirs(os.path.dirname(logf), exist_ok=True)
    subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "studio.py"), "ref", "_run", key[5:], rid],
                     stdout=open(logf, "w", encoding="utf-8"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                     creationflags=flags, close_fds=True, cwd=os.path.dirname(os.path.abspath(__file__)),
                     env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))


def cli(A, argv):
    sub, a = (argv[0] if argv else "list"), argv[1:]
    if not a:
        sys.exit(__doc__)
    key = A._plan_key(a[0])
    if sub == "list":
        print(list_text(A, key))
        return True
    if sub == "add":
        items = add(A, key, " ".join(x for x in a[1:] if not x.startswith("--") and x != A._opt(a, "--note")), A._opt(a, "--note", "") or "")
        for it in items:
            print(f"+ {it['id']}  {it['kind']}  {it['url'] or it['path']}")
            if it["kind"] == "video":
                _spawn(key, it["id"])
        print(f"Добавлено: {len(items)}. Видео разбираются в фоне — ref wait {a[0]}" if items else "Ничего нового (такие ссылки уже есть).")
        return True
    if sub == "parse":
        rids = [x for x in a[1:] if not x.startswith("--")]
        refs = A.load(key).get("refs") or []
        todo = [r for r in refs if r.get("kind") == "video" and (r["id"] in rids or (not rids and ((r.get("parse") or {}).get("status") != "done" or "--force" in a)))]
        if rids and "--force" not in a:
            todo = [r for r in todo if (r.get("parse") or {}).get("status") != "done" or r["id"] in rids]
        n = 0
        for r in todo:
            if is_live(r.get("parse") or {}):
                print(f"= {r['id']} уже разбирается")
                continue
            _spawn(key, r["id"])
            n += 1
            print(f"⏳ {r['id']}  {r.get('title') or r.get('url') or r.get('path')}")
        print(f"Запущено разборов: {n}. Дальше: ref wait {a[0]}" if n else "Нечего разбирать — все видео уже разобраны (заново: --force).")
        return True
    if sub == "_run":                                      # внутренний: фоновый процесс одного разбора
        try:
            print(run(A, key, a[1], log=print), flush=True)
        except Exception as e:
            print("ошибка:", e, flush=True)
        return True
    if sub == "wait":
        t_end, last = time.time() + float(A._opt(a, "--max", 100)), ""
        while True:
            refs = [r for r in A.load(key).get("refs") or [] if r.get("kind") == "video"]
            live = [r for r in refs if is_live(r.get("parse") or {}) or is_live((r.get("parse") or {}).get("base") or {})]
            line = " | ".join(f"{r['id']}: {(r.get('parse') or {}).get('msg') or '…'}" for r in live)
            if line != last:
                print(line or "готово", flush=True)
                last = line
            if not live or time.time() > t_end:
                break
            time.sleep(5)
        if live:
            print(f"Ещё идут: {len(live)} — запусти ref wait {a[0]} снова.")
        print(list_text(A, key))
        return True
    if sub == "base":
        if len(a) < 2:
            sys.exit("ref base <видео> <rid> [--off]")
        print(set_base(A, key, a[1], "--off" not in a, cli=True))
        return True
    if sub == "read":
        r = A._by_id(A.load(key).get("refs"), a[1]) if len(a) > 1 else None
        ps = (r or {}).get("parse") or {}
        if ps.get("status") != "done":
            sys.exit("референс не разобран (ref list / ref parse)")
        t = open(P.resolve(ps["transcript"]), encoding="utf-8").read()
        f, n = int(A._opt(a, "--from", 0)), int(A._opt(a, "--chars", 20000))
        print(t[f:f + n])
        if f + n < len(t):
            print(f"\n…(ещё {len(t) - f - n} знаков: ref read {a[0]} {a[1]} --from {f + n})")
        return True
    sys.exit(__doc__)
