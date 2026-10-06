"""Разбор видео-референса: контактные листы кадров + расшифровка речи, чтобы Claude «посмотрел» чужой ролик.

    python refvideo.py <ссылка|путь к файлу или папке> <папка результата>
    python refvideo.py --meta <ссылка>          — только название, канал, длина (секунды, без скачивания)
    python refvideo.py --base <видеофайл> <папка> — разбор референса подачи (S16): слова, фразы, кадры с таймкодом, склейки

Ссылка (YouTube, VK, TikTok…) скачивается через yt-dlp (до 720p); локальный файл не копируется.
Субтитры — ОДНА дорожка (ручные ru/en, иначе автосубтитры на языке ролика): YouTube отвечает 429 на вторую дорожку подряд,
и раньше это роняло всё скачивание. Сбой субтитров не фатален — тогда речь расшифрует faster-whisper на CPU.
Результат в папке: sheet1.jpg… — кадры сеткой 6×5 слева направо, сверху вниз, через равные промежутки (1–4 листа по длине ролика);
transcript.txt — речь абзацами по ~30 с с таймкодами; info.json — название, канал, длина, описание, главы, откуда текст.
"""
import glob, json, os, re, subprocess, sys, time

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
COLS, ROWS = 6, 5
WHISPER_MAX = 90 * 60          # дальше — не расшифровываем (и так ~час звука на CPU)
PARA = 30                      # секунд на абзац расшифровки


def run(cmd, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOWIN, timeout=timeout)


def _impersonate():
    try:
        import curl_cffi  # noqa: F401
        return True
    except ImportError:
        return False


def ytdlp(*args, timeout=900):
    # TikTok / Instagram без имитации браузера отвечают «Unexpected response» (S16) — нужен curl_cffi: pip install curl_cffi
    imp = ["--impersonate", "chrome"] if any(re.search(r"tiktok\.com|instagram\.com", str(a)) for a in args) and _impersonate() else []
    return run([sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings", *imp, *args], timeout)


def duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], 60)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def mmss(t):
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def split_urls(s):
    """«https://a…https://b…» (две ссылки, вставленные без пробела) и ссылки через пробел / перенос -> список ссылок."""
    out = []
    for part in re.split(r"\s+", s or ""):
        out += [u for u in re.split(r"(?=https?://)", part) if re.match(r"https?://", u)]
    return out


def meta(url):
    """Название, канал, длина без скачивания (секунды)."""
    r = ytdlp("--skip-download", "--print", "%(title)s\t%(channel,uploader)s\t%(duration)s", url, timeout=90)
    line = (r.stdout or "").strip().splitlines()
    if not line:
        raise RuntimeError("yt-dlp не открыл ссылку: " + (r.stderr or "").strip()[-300:])
    t, ch, d = (line[-1].split("\t") + ["", "", ""])[:3]
    try:
        d = float(d)
    except ValueError:
        d = 0.0
    return {"title": t if t != "NA" else "", "channel": ch if ch != "NA" else "", "dur": d}


# ---------------------------------------------------------------- субтитры
def pick_track(info):
    """-> ('manual'|'auto', язык) или None. Ручные ru/en, ручные на языке ролика, авто «<язык>-orig», авто на языке ролика, авто en/ru."""
    man, auto = info.get("subtitles") or {}, info.get("automatic_captions") or {}
    lang = (info.get("language") or "").split("-")[0]
    man = {k: v for k, v in man.items() if k != "live_chat"}
    for k in [l for l in man if l.split("-")[0] in ("ru", "en")] + [l for l in man if lang and l.split("-")[0] == lang] + list(man):
        return "manual", k
    # «-orig» у YouTube бывает у двух десятков языков (автодубляж) — оригинал ищем по языку ролика
    base = lambda l: l.replace("-orig", "").split("-")[0]
    order = [l for l in auto if lang and base(l) == lang and l.endswith("-orig")] + [l for l in auto if lang and base(l) == lang] \
        + [l for l in ("en-orig", "en", "ru-orig", "ru") if l in auto]
    for k in order:
        return "auto", k
    return None


def fetch_subs(src, out_dir, info, log):
    tr = pick_track(info)
    if not tr:
        return None, ""
    kind, lang = tr
    for attempt in range(3):
        r = ytdlp("--skip-download", "--write-subs" if kind == "manual" else "--write-auto-subs", "--sub-langs", lang, "--sub-format", "vtt",
                  "--sleep-subtitles", "1", "-o", os.path.join(out_dir, "video.%(ext)s"), src, timeout=180)
        f = glob.glob(os.path.join(out_dir, f"video.{glob.escape(lang)}.vtt"))
        if f:
            return f[0], f"субтитры {'автора' if kind == 'manual' else 'YouTube (авто)'}, {lang}"
        if "429" in (r.stderr or ""):
            log(f"субтитры: YouTube просит подождать ({attempt + 1}/3)…")
            time.sleep(6 * (attempt + 1))
            continue
        break
    return None, ""


def vtt_cues(path):
    """VTT -> [(t, строка)] без «скользящих» повторов автосубтитров (каждая строка там приходит дважды)."""
    out, last = [], ""
    with open(path, encoding="utf-8", errors="replace") as f:
        cues = f.read().replace("\r", "").split("\n\n")
    for c in cues:
        m = re.search(r"(?:(\d+):)?(\d+):(\d+)[.,]\d+\s+-->", c)
        if not m:
            continue
        t = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        for s in c.split("\n"):
            if "-->" in s or re.fullmatch(r"\s*\d+\s*", s):
                continue
            s = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).replace("&nbsp;", " ").replace("&amp;", "&").strip()
            if s and s != last:
                out.append((t, s))
                last = s
    return out


def paragraphs(cues):
    """[(t, текст)] -> «[m:ss] абзац» по ~PARA секунд."""
    L, t0, buf = [], None, []
    for t, s in cues:
        if t0 is None:
            t0 = t
        buf.append(s)
        if t - t0 >= PARA and re.search(r"[.!?…]$", s) or t - t0 >= PARA * 1.6:
            L.append(f"[{mmss(t0)}] " + " ".join(buf))
            t0, buf = None, []
    if buf:
        L.append(f"[{mmss(t0 or 0)}] " + " ".join(buf))
    return "\n\n".join(L)


def vtt_text(path):
    return paragraphs(vtt_cues(path))


def whisper_text(path, dur=0):
    from faster_whisper import WhisperModel
    name = os.environ.get("WHISPER_MODEL") or ("small" if dur <= 20 * 60 else "base")    # длинное — моделью попроще, иначе час на CPU
    model = WhisperModel(name, device="cpu", compute_type="int8")
    segs, _ = model.transcribe(path, vad_filter=True)
    return paragraphs([(s.start, s.text.strip()) for s in segs if s.start < WHISPER_MAX]), f"faster-whisper {name}"


# ---------------------------------------------------------------- кадры
def sheets(video, out_dir, dur):
    """30 кадров на лист: 1 лист до 3 мин, 2 — до 15 мин, 3 — до 30 мин, 4 — длиннее."""
    n_sheets = 1 if dur <= 180 else 2 if dur <= 900 else 3 if dur <= 1800 else 4
    n = COLS * ROWS * n_sheets
    step = max(0.5, dur / n) if dur else 2.0
    files = []
    for k in range(n_sheets):
        dst = os.path.join(out_dir, f"sheet{k + 1}.jpg")
        t0 = k * COLS * ROWS * step
        r = run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.2f}", "-i", video, "-vf",
                 f"fps=1/{step:.3f},scale=240:-2,tile={COLS}x{ROWS}:padding=4:color=white", "-frames:v", "1", "-q:v", "4", dst])
        if os.path.isfile(dst):
            files.append(dst)
        elif r.stderr:
            print("! лист кадров:", r.stderr.strip()[-200:])
    return files, step


# ---------------------------------------------------------------- S16: референс подачи — ритм по словам, кадры с таймкодом, склейки
BASE_COLS, BASE_ROWS = 5, 4    # кадров на лист «подачи»: крупнее, чем 6×5, — Claude читает с них текст на экране
PAUSE = 0.6                    # тишина длиннее — пауза подачи


def ts(t):
    return f"{int(t) // 60}:{t % 60:04.1f}"


def whisper_words(path, dur=0):
    """-> ([{t0, t1, w}], язык). Всегда whisper со словами: субтитры не дают ритма."""
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get("WHISPER_MODEL") or ("small" if dur <= 20 * 60 else "base"), device="cpu", compute_type="int8")   # длинное — моделью попроще
    segs, info = model.transcribe(path, vad_filter=True, word_timestamps=True)
    out = []
    for s in segs:
        ws = [w for w in s.words or [] if w.word.strip()]
        for i, w in enumerate(ws):
            out.append({"t0": round(w.start, 2), "t1": round(w.end, 2), "w": w.word.strip(), **({"s": 1} if i == len(ws) - 1 else {})})   # s — конец сегмента whisper
    return out, getattr(info, "language", "")


def phrases(words):
    """Слова -> фразы: конец на . ! ? … или пауза > PAUSE. [{t0, t1, text, n}]"""
    out, buf = [], []
    for i, w in enumerate(words):
        buf.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if not nxt or re.search(r"[.!?…]$", w["w"]) or w.get("s") or nxt["t0"] - w["t1"] > PAUSE:   # на длинном видео whisper теряет точки — режем и по сегментам
            out.append({"t0": buf[0]["t0"], "t1": buf[-1]["t1"], "text": " ".join(x["w"] for x in buf), "n": len(buf)})
            buf = []
    return out


def rhythm(words, ph, dur):
    if not words:
        return {"wps": 0, "phrase": 0, "pauses": 0, "speech": 0, "words": 0}
    speech = sum(p["t1"] - p["t0"] for p in ph) or 1
    pauses = sum(1 for a, b in zip(words, words[1:]) if b["t0"] - a["t1"] > PAUSE)
    return {"wps": round(len(words) / max(1.0, words[-1]["t1"] - words[0]["t0"]), 2), "phrase": round(len(words) / max(1, len(ph)), 1),
            "pauses": pauses, "speech": round(speech, 1), "words": len(words), "dur": round(dur, 1)}


def cuts(video):
    """Склейки (ffmpeg scene > 0.3) -> [секунды]."""
    r = run(["ffmpeg", "-hide_banner", "-i", video, "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"], 600)
    return [round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", r.stderr or "")]


def base_sheets(video, out_dir, dur):
    """Кадры каждые 0,5 с (до 90 с) или 1 с, листами 5×4 с таймкодом в углу кадра -> [пути], шаг."""
    from PIL import Image, ImageDraw, ImageFont
    step = 0.5 if dur <= 90 else 1.0 if dur <= 240 else max(1.0, dur / 240)
    fdir = os.path.join(out_dir, "frames")
    os.makedirs(fdir, exist_ok=True)
    for f in glob.glob(os.path.join(fdir, "f*.jpg")):
        os.remove(f)
    run(["ffmpeg", "-v", "error", "-y", "-i", video, "-vf", f"fps=1/{step},scale=270:-2", "-q:v", "4", os.path.join(fdir, "f%04d.jpg")], 900)
    frames = sorted(glob.glob(os.path.join(fdir, "f*.jpg")))
    try:
        font = ImageFont.truetype("arialbd.ttf", 22)
    except OSError:
        font = ImageFont.load_default()
    per, files = BASE_COLS * BASE_ROWS, []
    for f in glob.glob(os.path.join(out_dir, "beat_sheet*.jpg")):
        os.remove(f)
    for k in range(0, len(frames), per):
        ims = [Image.open(f).convert("RGB") for f in frames[k:k + per]]
        w, h_ = ims[0].size
        sheet = Image.new("RGB", (BASE_COLS * (w + 4) + 4, BASE_ROWS * (h_ + 4) + 4), "white")
        d = ImageDraw.Draw(sheet)
        for i, im in enumerate(ims):
            x, y = 4 + i % BASE_COLS * (w + 4), 4 + i // BASE_COLS * (h_ + 4)
            sheet.paste(im, (x, y))
            lbl = ts((k + i) * step)
            d.rectangle([x, y, x + 78, y + 28], fill="black")
            d.text((x + 5, y + 2), lbl, fill="yellow", font=font)
        dst = os.path.join(out_dir, f"beat_sheet{k // per + 1}.jpg")
        sheet.save(dst, quality=85)
        files.append(dst)
    return files, step


def base_extras(video, out_dir, dur=0, log=print):
    """Разбор референса подачи (S16): words.json, phrases.txt («[0:03.4–0:05.1] фраза · N сл.»), beat_sheet*.jpg, shots.json, rhythm."""
    dur = dur or duration(video)
    log("ритм: расшифровка по словам (whisper)…")
    try:
        words, lang = whisper_words(video, dur)
    except Exception as e:
        words, lang = [], ""
        log(f"слова не расшифровались: {e}")
    ph = phrases(words)
    with open(os.path.join(out_dir, "words.json"), "w", encoding="utf-8") as f:
        json.dump(words, f, ensure_ascii=False)
    with open(os.path.join(out_dir, "phrases.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(f"[{ts(p['t0'])}–{ts(p['t1'])}] {p['text']} · {p['n']} сл." for p in ph) or "(голоса нет — подача текстом на экране и склейками)")
    log("кадры с таймкодом…")
    sheets_, step = base_sheets(video, out_dir, dur)
    log("склейки…")
    sh = cuts(video)
    with open(os.path.join(out_dir, "shots.json"), "w", encoding="utf-8") as f:
        json.dump(sh, f)
    return {"words": os.path.join(out_dir, "words.json"), "phrases": os.path.join(out_dir, "phrases.txt"), "sheets": sheets_, "step": step,
            "shots": os.path.join(out_dir, "shots.json"), "cuts": len(sh), "lang": lang, "rhythm": rhythm(words, ph, dur)}


# ---------------------------------------------------------------- целиком
def parse(src, out_dir, log=print):
    """-> {video, title, channel, dur, sheets: [abs], step, transcript (abs), text, text_from, info (abs)}"""
    os.makedirs(out_dir, exist_ok=True)
    src = src.strip().strip('"')
    title, channel, info, sub, text_from = "", "", {}, None, ""
    if re.match(r"https?://", src):
        log("смотрю ссылку…")
        r = ytdlp("--skip-download", "--write-info-json", "-o", os.path.join(out_dir, "video.%(ext)s"), src, timeout=120)
        try:
            with open(os.path.join(out_dir, "video.info.json"), encoding="utf-8") as f:
                info = json.load(f)
        except (OSError, ValueError):
            raise RuntimeError("yt-dlp не открыл ссылку: " + (r.stderr or r.stdout or "").strip()[-300:])
        title, channel = info.get("title") or "", info.get("channel") or info.get("uploader") or ""
        log(f"«{title[:60]}» — субтитры…")
        sub, text_from = fetch_subs(src, out_dir, info, log)
        vids = [f for f in glob.glob(os.path.join(out_dir, "video.*")) if f.lower().endswith(VIDEO_EXT)]
        if not vids:
            log(f"«{title[:60]}» — скачиваю видео…")
            r = ytdlp("-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4", "--max-filesize", "1500M",
                      "-o", os.path.join(out_dir, "video.%(ext)s"), src, timeout=3600)
            vids = [f for f in glob.glob(os.path.join(out_dir, "video.*")) if f.lower().endswith(VIDEO_EXT)]
        if not vids:
            raise RuntimeError("yt-dlp не скачал видео: " + (r.stderr or r.stdout or "").strip()[-300:])
        video = vids[0]
    else:
        video = os.path.abspath(src)
        if os.path.isdir(video):
            vs = [os.path.join(dp, f) for dp, _, fs in os.walk(video) for f in fs if f.lower().endswith(VIDEO_EXT)]
            if not vs:
                raise ValueError("в папке нет видеофайлов")
            video = max(vs, key=os.path.getsize)
        if not os.path.isfile(video):
            raise ValueError("нет такого файла: " + src)
        title = os.path.splitext(os.path.basename(video))[0]
    dur = duration(video) or float(info.get("duration") or 0)
    log("режу кадры…")
    files, step = sheets(video, out_dir, dur)
    text = vtt_text(sub) if sub else ""
    if not text.strip():
        log(f"расшифровываю речь ({mmss(dur)})…")
        try:
            text, text_from = whisper_text(video, dur)
        except Exception as e:
            text, text_from = f"(расшифровка не получилась: {e})", "ошибка"
    tr = os.path.join(out_dir, "transcript.txt")
    head = f"# {title}\n" + (f"Канал: {channel}\n" if channel else "") + (f"Ссылка: {src}\n" if re.match(r"https?://", src) else f"Файл: {video}\n") \
        + f"Длина: {mmss(dur)} · текст: {text_from}\n\n"
    with open(tr, "w", encoding="utf-8") as f:
        f.write(head + text)
    keep = {"title": title, "channel": channel, "dur": round(dur, 1), "url": src if re.match(r"https?://", src) else "", "text_from": text_from,
            "description": (info.get("description") or "")[:4000], "chapters": [{"t": round(c.get("start_time") or 0), "title": c.get("title") or ""} for c in info.get("chapters") or []],
            "upload_date": info.get("upload_date") or "", "sheets_step": round(step, 2)}
    inf = os.path.join(out_dir, "info.json")
    with open(inf, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False, indent=1)
    return {"video": video, "title": title, "channel": channel, "dur": round(dur, 1), "sheets": files, "step": round(step, 2),
            "transcript": tr, "text": text, "text_from": text_from, "info": inf}


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if len(sys.argv) == 4 and sys.argv[1] == "--base":
        print(json.dumps(base_extras(sys.argv[2], sys.argv[3]), ensure_ascii=False, indent=1))
        sys.exit()
    if len(sys.argv) == 3 and sys.argv[1] == "--meta":
        print(json.dumps(meta(sys.argv[2]), ensure_ascii=False))
        sys.exit()
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    r = parse(sys.argv[1], sys.argv[2])
    r["text"] = r["text"][:1500]
    print(json.dumps(r, ensure_ascii=False, indent=1))
