"""🎙 Голос ролика (S11 ч.2): готовая запись диктора или черновой голос нейросетью.

Запись: один файл (весь сценарий подряд) -> refs/voice/<время>-<имя> -> задача voicesplit:
  распознать целиком (faster-whisper, слова с временем, на процессоре) -> сопоставить со словами сцен script.md (difflib)
  -> резать между сценами в самой тихой точке паузы -> build/vo/sec<N>.wav (края без тишины) -> align.py (тайминги слов, src/vo_timing.js).
  Старые файлы нейросети уезжают в build/vo_tts/. Расхождения «в сценарии / сказал» — в build/vo/source.json (diff) -> страница показывает,
  «✨ поправить сценарий под запись» — агенту (субтитры должны совпасть с голосом).
Черновой голос: задача voicetts -> tts.py (записи уезжают в build/vo_rec/).
Сцены без голоса (тихие биты сценария) пропускаются — у них нет файла.
Текст для диктора на стороне (озвучка «на аутсорс»): actor_text -> GET /api/voice/text, кнопка 🎤 в шапке окна видео.
CLI: voice show VID | voice text VID | voice split VID <файл> | voice tts VID | voice align VID (после правки VO под запись)
"""
import difflib, glob, importlib.util, json, os, re, shutil, subprocess, sys, time

import paths as P  # noqa: E402

CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)
AUDIO = (".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".opus", ".webm")
MODEL = os.environ.get("WHISPER_MODEL", "small")


def _mn(A):
    return A.mnapi()


def _pd(A, vid):
    pd = _mn(A).vdir(vid)
    if not pd or not _mn(A).has_project(vid):
        raise ValueError("у видео ещё нет проекта ролика — этап «Сценарий» → «🚀 Начать производство»")
    return pd


def _tts(pd):
    """tts.py проекта как модуль (parse_script, duration) — тот же разбор script.md, что у озвучки."""
    spec = importlib.util.spec_from_file_location("proj_tts_" + str(abs(hash(pd))), os.path.join(pd, "tts.py"))
    m = importlib.util.module_from_spec(spec)
    sys.path.insert(0, pd)
    try:
        spec.loader.exec_module(m)
    finally:
        sys.path.remove(pd)
    return m


def sections(pd):
    T = _tts(pd)
    cfg, secs = T.parse_script(os.path.join(pd, "script.md"))
    return cfg, secs


def _src(pd):
    try:
        return json.load(open(os.path.join(pd, "build", "vo", "source.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def state(A, vid):
    pd = _mn(A).vdir(vid)
    if not pd or not _mn(A).has_project(vid):
        return {"project": False}
    try:
        cfg, secs = sections(pd)
    except SystemExit as e:
        return {"project": True, "error": str(e), "sections": []}
    except Exception as e:
        return {"project": True, "error": f"script.md не читается: {e}", "sections": []}
    vo = _mn(A).voice(vid) or {}
    vs = vo.get("sections") or []
    out = []
    for i, s in enumerate(secs):
        f = next((p for p in (os.path.join(pd, "build", "vo", f"sec{i}{e}") for e in AUDIO) if os.path.isfile(p)), None)
        t = vs[i] if i < len(vs) else {}
        out.append({"i": i, "title": s["title"], "text": s.get("text", ""), "silent": bool(s.get("silence")), "dur": t.get("dur") or s.get("silence"),
                    "start": t.get("start"), "file": bool(f), "ext": os.path.splitext(f)[1] if f else ""})
    recs = sorted([os.path.basename(p) for p in glob.glob(os.path.join(pd, "refs", "voice", "*")) if p.lower().endswith(AUDIO)], reverse=True)
    return {"project": True, "sections": out, "total": vo.get("total"), "source": _src(pd), "recordings": recs, "voice": cfg.get("voice"), "rate": cfg.get("rate")}


def _scene_notes(T, pd):
    """Пометки режиссёра у VO каждой сцены — *(шёпотом)* после «**VO:**» и внутри текста (tts.py их выкидывает, диктору они нужны)."""
    text = open(os.path.join(pd, "script.md"), encoding="utf-8").read()
    heads = list(T.SCENE_HEAD.finditer(text))
    out = {}
    for k, hd in enumerate(heads):
        block = text[hd.end():heads[k + 1].start() if k + 1 < len(heads) else len(text)]
        raw = T._voice_of(block)
        if not raw:
            continue
        m = re.search(r"\**VO\**\s*:\**[ \t]*([^\n]*)\n[ \t]*>", block, re.I)
        lead = re.sub(r"[*_]", "", m.group(1)).strip() if m else ""
        raw = re.sub(r"\*\(([^)]*)\)\*", r"(\1)", raw)                   # *(с паузой)* -> (с паузой) — прямо в тексте, где стоит
        raw = re.sub(r"[*_]{1,2}", "", raw)
        raw = T.PAUSE.sub(lambda p: f"[пауза {p.group(1)} с]", raw)
        out[hd.group(1).replace("**", "").strip()] = (lead, re.sub(r"\s+", " ", raw).strip().strip("«»\""))
    return out


def actor_text(A, vid):
    """Текст для диктора (озвучка на стороне): сцены по порядку, как читать, темп, произношение, как записать и прислать.
    Запись потом кидают в «🎙 Голос» одним файлом — нарежется по сценам сама (split)."""
    pd = _pd(A, vid)
    T = _tts(pd)
    cfg, secs = T.parse_script(os.path.join(pd, "script.md"))
    notes = _scene_notes(T, pd)
    vs = (_mn(A).voice(vid) or {}).get("sections") or []
    voiced = [(i, s) for i, s in enumerate(secs) if not s.get("silence")]
    words = sum(len(s["text"].split()) for _, s in voiced)
    total = sum((vs[i] or {}).get("dur") or 0 for i, _ in voiced if i < len(vs))
    name = os.path.basename(pd.rstrip("\\/"))
    L = [f"ОЗВУЧКА: {name}", ""]
    L.append(f"Сцен с голосом: {len(voiced)} · слов: {words} · по времени ≈ {round(total or words / 2.65)} с (темп ≈ 2,6 слова в секунду — бодро, как в шортсах, без растягивания).")
    if cfg.get("pron"):
        L += ["", "Как произносить:"] + [f"  • {a} — читать «{b}»" for a, b in cfg["pron"].items()]
    if cfg.get("rise"):
        L += ["", "С вопросительной интонацией:"] + [f"  • «{w}»" + (f" (в сцене {n})" if n else "") for w, n in cfg["rise"]]
    L += ["", "Как записать:",
          "  • весь текст одним файлом, сцены подряд по порядку; между сценами пауза 1–2 секунды;",
          "  • [пауза N с] — помолчать столько секунд; в скобках ( ) — как читать, вслух не произносить;",
          "  • оговорился — перечитай фразу заново, чтобы в файле остался один чистый дубль; слова не меняй — они же субтитры;",
          "  • тихая комната, без музыки, микрофон в 15–20 см; формат любой: wav, mp3, m4a.",
          "", "—" * 20]
    for n, (i, s) in enumerate(voiced, 1):
        title = re.sub(r"^[\d:.\s–—-]+(?:—\s*)?", "", s["title"]).strip() or s["title"]
        lead, txt = notes.get(s["title"], ("", s["text"]))
        dur = (vs[i] or {}).get("dur") if i < len(vs) else None
        L += ["", f"{n}. {title}" + (f"  (≈ {dur:.0f} с)" if dur else "") + (f"  ({lead.strip('()')})" if lead else ""), txt]
    return {"text": "\n".join(L) + "\n", "scenes": len(voiced), "words": words, "dur": round(total, 1)}


def audio_path(A, vid, i=None, rec=None):
    pd = _pd(A, vid)
    if rec:
        p = os.path.join(pd, "refs", "voice", os.path.basename(rec))
        return p if os.path.isfile(p) else None
    return next((p for p in (os.path.join(pd, "build", "vo", f"sec{int(i)}{e}") for e in AUDIO) if os.path.isfile(p)), None)


def save_upload(A, vid, name, data):
    pd = _pd(A, vid)
    ext = os.path.splitext(name or "")[1].lower()
    if ext not in AUDIO:
        raise ValueError("нужен звук: " + " ".join(AUDIO))
    d = os.path.join(pd, "refs", "voice")
    os.makedirs(d, exist_ok=True)
    base = re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(name))[0])[:40] or "voice"
    fn = time.strftime("%m%d-%H%M") + "-" + base + ext
    with open(os.path.join(d, fn), "wb") as f:
        f.write(data)
    return fn


# ---------------------------------------------------------------- нарезка записи по сценам
def _norm(w):
    w = (w or "").lower().replace("ё", "е")
    return re.sub(r"[^\w]+", "", w)


def _decode(path, sr=16000):
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, creationflags=CF)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg не прочитал запись: " + r.stderr.decode("utf-8", "replace")[-300:])
    return np.frombuffer(r.stdout, dtype=np.float32), sr


def _quietest(y, sr, a, b):
    """Самая тихая точка в окне [a, b] секунд (RMS окнами 20 мс)."""
    import numpy as np
    a, b = max(0.0, a), min(len(y) / sr, b)
    if b - a < 0.06:
        return (a + b) / 2
    hop, win = int(sr * 0.01), int(sr * 0.02)
    i0, i1 = int(a * sr), int(b * sr)
    best, bt = None, (a + b) / 2
    for i in range(i0, max(i0 + 1, i1 - win), hop):
        e = float(np.sqrt(np.mean(y[i:i + win] ** 2) + 1e-12))
        if best is None or e < best:
            best, bt = e, (i + win / 2) / sr
    return bt


def split(A, job):
    vid, src = job.params.get("video"), job.params.get("file")
    pd = _pd(A, vid)
    path = os.path.join(pd, "refs", "voice", os.path.basename(src or ""))
    if not os.path.isfile(path):
        raise ValueError("нет файла записи " + str(src))
    cfg, secs = sections(pd)
    voiced = [i for i, s in enumerate(secs) if not s.get("silence")]
    if not voiced:
        raise ValueError("в сценарии нет сцен с голосом (VO)")
    job.summary = "распознаю запись (faster-whisper, на процессоре — минута-две)…"
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    prompt = " ".join(secs[i]["text"] for i in voiced)[:800]
    segs, info = model.transcribe(path, language="ru", word_timestamps=True, initial_prompt=prompt, vad_filter=False)
    rec = [{"w": w.word.strip(), "t": w.start, "e": w.end} for sg in segs for w in sg.words if w.word.strip()]
    if not rec:
        raise RuntimeError("в записи не распознано ни слова")
    job.summary = f"распознано {len(rec)} слов — сопоставляю со сценарием…"
    stok = []                                                # (секция, слово сценария) — как написано: распознавание пишет имена латиницей, как в подсказке
    for i in voiced:
        for w in re.findall(r"\S+", secs[i]["text"]):
            if _norm(w):
                stok.append((i, w))
    rn = [_norm(r["w"]) for r in rec]
    sm = difflib.SequenceMatcher(None, [_norm(w) for _, w in stok], rn, autojunk=False)
    s2r = {}
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            s2r[blk.a + k] = blk.b + k
    # первое и последнее распознанное слово каждой сцены
    span = {}
    for si, (sec, _) in enumerate(stok):
        if si in s2r:
            a, b = span.get(sec, (None, None))
            r = s2r[si]
            span[sec] = (r if a is None else min(a, r), r if b is None else max(b, r))
    miss = [secs[i]["title"] for i in voiced if i not in span]
    if miss:
        raise RuntimeError("не нашёл в записи сцены: " + "; ".join(miss) + " — диктор их пропустил или текст сильно другой (поправь сценарий и попробуй ещё раз)")
    y, sr = _decode(path)
    total = len(y) / sr
    cuts = {}                                               # секция -> [начало, конец] в записи
    for n, i in enumerate(voiced):
        a, b = span[i]
        prev_end = rec[span[voiced[n - 1]][1]]["e"] if n else 0.0
        nxt_start = rec[span[voiced[n + 1]][0]]["t"] if n + 1 < len(voiced) else total
        start = 0.0 if n == 0 else _quietest(y, sr, prev_end, rec[a]["t"])
        end = total if n + 1 == len(voiced) else _quietest(y, sr, rec[b]["e"], nxt_start)
        cuts[i] = [start, end]
    vo = os.path.join(pd, "build", "vo")
    os.makedirs(vo, exist_ok=True)
    keep = os.path.join(pd, "build", "vo_tts")                # прошлый голос (нейросеть) — не удаляем
    os.makedirs(keep, exist_ok=True)
    for p in glob.glob(os.path.join(vo, "sec*.*")):
        shutil.move(p, os.path.join(keep, os.path.basename(p)))
    trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse"
    for i, (a, b) in cuts.items():
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", path, "-ac", "1", "-ar", "44100", "-af", trim,
                            os.path.join(vo, f"sec{i}.wav")], capture_output=True, creationflags=CF)
        if r.returncode != 0:
            raise RuntimeError("ffmpeg: " + r.stderr.decode("utf-8", "replace")[-300:])
    # расхождения «в сценарии / сказал» — по сценам
    diff = []
    for i in voiced:
        a, b = span[i]
        said = rec[a:b + 1]
        st = [w for (sec, w) in stok if sec == i]
        m = difflib.SequenceMatcher(None, [_norm(w) for w in st], [_norm(r["w"]) for r in said], autojunk=False)
        for op, i1, i2, j1, j2 in m.get_opcodes():
            sa, sb = " ".join(st[i1:i2]), " ".join(r["w"] for r in said[j1:j2])
            if op != "equal" and _norm(sa.replace(" ", "")) != _norm(sb.replace(" ", "")):     # «Ghosts'n» = «Ghosts 'n», тире и знаки — не расхождение
                diff.append({"sec": i, "title": secs[i]["title"], "script": " ".join(st[i1:i2]), "said": " ".join(r["w"] for r in said[j1:j2])})
    job.summary = "тайминги слов (align.py)…"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "align.py"], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=CF)
    if r.returncode != 0:
        raise RuntimeError("align.py: " + (r.stdout + r.stderr)[-600:])
    src_info = {"kind": "rec", "file": os.path.basename(path), "ts": int(time.time() * 1000), "diff": diff[:60],
                "cuts": {str(i): [round(a, 2), round(b, 2)] for i, (a, b) in cuts.items()}}
    json.dump(src_info, open(os.path.join(vo, "source.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    vt = _mn(A).voice(vid) or {}
    job.result = {"sections": len(cuts), "diff": len(diff), "total": vt.get("total")}
    job.summary = f"🎙 запись разрезана по {len(cuts)} сценам · ролик {vt.get('total', 0):.1f} с" + (f" · расхождений с текстом: {len(diff)}" if diff else " · слова совпали со сценарием ✓")


def tts(A, job):
    vid = job.params.get("video")
    pd = _pd(A, vid)
    vo = os.path.join(pd, "build", "vo")
    os.makedirs(vo, exist_ok=True)
    if _src(pd).get("kind") == "rec":                        # запись диктора — в сторону (вернуть: «нарезать» её снова)
        keep = os.path.join(pd, "build", "vo_rec")
        os.makedirs(keep, exist_ok=True)
        for p in glob.glob(os.path.join(vo, "sec*.*")):
            shutil.move(p, os.path.join(keep, os.path.basename(p)))
    job.summary = "озвучиваю сценарий нейросетью (tts.py)…"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "tts.py"], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=CF)
    if r.returncode != 0:
        raise RuntimeError("tts.py: " + (r.stdout + r.stderr)[-600:])
    json.dump({"kind": "tts", "ts": int(time.time() * 1000)}, open(os.path.join(vo, "source.json"), "w", encoding="utf-8"), ensure_ascii=False)
    vt = _mn(A).voice(vid) or {}
    job.summary = f"🎙 черновой голос готов · ролик {vt.get('total', 0):.1f} с"


def align(A, vid):
    """Сценарий поправили под запись — заново тайминги слов (align.py), файлы те же."""
    pd = _pd(A, vid)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    r = subprocess.run([sys.executable, "align.py"], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=CF)
    return (r.stdout + r.stderr)[-1500:]


def run_job(A, job):
    if job.kind == "voicesplit":
        split(A, job)
    elif job.kind == "voicetts":
        tts(A, job)
    else:
        return False
    return True


def cli(A, argv):
    if not argv or len(argv) < 2:
        print(__doc__); return True
    cmd, vid = argv[0], argv[1]
    if cmd == "show":
        print(json.dumps(state(A, vid), ensure_ascii=False, indent=1)); return True
    if cmd == "text":
        print(actor_text(A, vid)["text"]); return True
    if cmd == "align":
        print(align(A, vid)); return True
    if cmd in ("split", "tts"):
        j = A.Job("voice" + cmd, "plan:" + vid, "voice", {"video": vid, "file": argv[2] if len(argv) > 2 else ""})
        (split if cmd == "split" else tts)(A, j)
        print(j.summary); return True
    print(__doc__); return True
