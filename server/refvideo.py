"""Разбор видео-референса для «Штурма»: контактные листы кадров + расшифровка речи, чтобы Claude «посмотрел» чужой ролик.

    python refvideo.py <ссылка|путь к файлу или папке> <папка результата>

Ссылка (YouTube, VK, TikTok…) скачивается через yt-dlp (до 720p) вместе с субтитрами; локальный файл не копируется.
Результат в папке: sheet1.jpg[, sheet2.jpg] — кадры сеткой 6×5 слева направо, сверху вниз, через равные промежутки;
transcript.txt — речь с таймкодами (субтитры площадки, иначе faster-whisper small на CPU, до 15 минут звука).
"""
import glob, json, os, re, subprocess, sys

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
COLS, ROWS = 6, 5
WHISPER_MAX = 15 * 60


def run(cmd, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOWIN, timeout=timeout)


def duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], 60)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def mmss(t):
    return f"{int(t) // 60}:{int(t) % 60:02d}"


def vtt_text(path):
    """Subtitles -> «[m:ss] text» lines, without the rolling duplicates of auto-captions."""
    out, last = [], ""
    with open(path, encoding="utf-8", errors="replace") as f:
        cues = f.read().split("\n\n")
    for c in cues:
        m = re.search(r"(\d+):(\d+):(\d+)[.,]\d+\s+-->", c) or re.search(r"(\d+):(\d+)[.,]\d+\s+-->", c)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        t = g[0] * 3600 + g[1] * 60 + g[2] if len(g) == 3 else g[0] * 60 + g[1]
        lines = [re.sub(r"<[^>]+>", "", s).strip() for s in c.split("\n") if "-->" not in s and not re.fullmatch(r"\d+", s.strip())]
        text = " ".join(s for s in lines if s)
        if text and text != last and not last.endswith(text):
            out.append(f"[{mmss(t)}] {text}")
            last = text
    return "\n".join(out)


def whisper_text(path):
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
    segs, _ = model.transcribe(path, vad_filter=True)
    return "\n".join(f"[{mmss(s.start)}] {s.text.strip()}" for s in segs if s.start < WHISPER_MAX)


def sheets(video, out_dir, dur):
    """1 sheet (30 frames) for short videos, 2 sheets (60 frames) for longer than 3 minutes."""
    n_sheets = 1 if dur <= 180 else 2
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


def parse(src, out_dir, log=print):
    """-> {video, title, dur, sheets: [abs], step, transcript (abs or ''), text}"""
    os.makedirs(out_dir, exist_ok=True)
    src = src.strip().strip('"')
    title, subs = "", []
    if re.match(r"https?://", src):
        log("скачиваю видео…")
        r = run([sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings", "-f", "bv*[height<=720]+ba/b[height<=720]/b",
                 "--merge-output-format", "mp4", "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", "ru.*,en.*",
                 "--sub-format", "vtt", "--max-filesize", "600M", "-o", os.path.join(out_dir, "video.%(ext)s"), src], 1800)
        vids = [f for f in glob.glob(os.path.join(out_dir, "video.*")) if f.lower().endswith(VIDEO_EXT)]
        if not vids:
            raise RuntimeError("yt-dlp не скачал видео: " + (r.stderr or r.stdout).strip()[-300:])
        video = vids[0]
        try:
            with open(os.path.join(out_dir, "video.info.json"), encoding="utf-8") as f:
                title = json.load(f).get("title") or ""
        except (OSError, ValueError):
            pass
        subs = sorted(glob.glob(os.path.join(out_dir, "video.*.vtt")), key=lambda p: (".ru" not in p, "orig" not in p))
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
    dur = duration(video)
    log("режу кадры…")
    files, step = sheets(video, out_dir, dur)
    text = ""
    if subs:
        text = vtt_text(subs[0])
    if not text.strip():
        log("расшифровываю речь…")
        try:
            text = whisper_text(video)
        except Exception as e:
            text = f"(расшифровка не получилась: {e})"
    tr = os.path.join(out_dir, "transcript.txt")
    with open(tr, "w", encoding="utf-8") as f:
        f.write(text)
    return {"video": video, "title": title, "dur": round(dur, 1), "sheets": files, "step": round(step, 2), "transcript": tr, "text": text}


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    r = parse(sys.argv[1], sys.argv[2])
    r["text"] = r["text"][:1500]
    print(json.dumps(r, ensure_ascii=False, indent=1))
