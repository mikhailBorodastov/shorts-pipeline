"""Звуки для препродакшена «Штурма»: поиск (библиотека пайплайна, Freesound, Wikimedia Commons) и скачивание по ссылке.

    python sounds.py search "elevator door" [--n 8] [--src lib,freesound,commons]   -> JSON: кандидаты (так ищет Claude в «Подобрать»)
    python sounds.py fetch <ссылка|lib:id> <папка> [--start 1.5] [--end 4]            -> скачать, обрезать, сохранить wav

Кандидат: {src, title, url (что качать), page, dur, license, author, tags}.
Ссылка для fetch: lib:<id> (библиотека _pipeline/sfx_library), прямой аудиофайл, страница Freesound или Commons,
любая страница со звуком (ищем og:audio, <audio>, data-mp3, ссылки на .mp3/.ogg/.wav), YouTube и прочие видеосайты (yt-dlp).
Искать лучше по-английски: у Freesound и Commons почти все описания английские.
"""
import html, json, os, re, shutil, subprocess, sys, tempfile, urllib.parse, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(os.path.dirname(HERE), "sfx_library")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ShturmIdeas/1.0 (local tool of a YouTube creator)"
AUDIO_EXT = (".mp3", ".ogg", ".oga", ".wav", ".m4a", ".flac", ".opus", ".aac", ".webm", ".mp4")
VIDEO_SITES = ("youtube.com", "youtu.be", "vk.com", "vkvideo.ru", "rutube.ru", "tiktok.com", "vimeo.com", "twitter.com", "x.com",
               "instagram.com", "soundcloud.com", "bandcamp.com", "dailymotion.com", "twitch.tv", "ok.ru", "coub.com")
MAX_BYTES = 80 * 1024 * 1024
MAX_LEN = 180.0                       # longer sounds are cut (ambience / music: take a piece)
STREAM_FROM = 4 * 1024 * 1024         # direct files bigger than this (or cut with start/end) are streamed by ffmpeg, smaller ones downloaded whole
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _get(url, timeout=25, limit=MAX_BYTES):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,ru;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"файл больше {limit // 2**20} МБ")
        return data, (r.headers.get("Content-Type") or "").lower(), r.geturl()


def _words(s):
    return re.findall(r"[a-zа-яё0-9]+", (s or "").lower().replace("ё", "е"))


# ---------------- search ----------------
def _lib_index():
    try:
        with open(os.path.join(LIB, "index.json"), encoding="utf-8") as f:
            d = json.load(f)
        return d.get("sounds", d) if isinstance(d, dict) else d
    except (OSError, ValueError):
        return []


def search_lib(q, n=6):
    qs = [w for w in _words(q) if len(w) > 1]
    if not qs:
        return []
    out = []
    for s in _lib_index():
        hay = set(_words(" ".join(str(s.get(k, "")) for k in ("id", "name", "category", "tags"))))
        score = sum(1 if w in hay else 0.6 if len(w) >= 4 and any(x.startswith(w[:4]) for x in hay) else 0 for w in qs)
        if score >= max(1, len(qs) * 0.6):
            out.append((score, s))
    out.sort(key=lambda x: -x[0])
    return [{"src": "lib", "title": s.get("name") or s["id"], "url": "lib:" + s["id"], "page": "", "dur": s.get("dur"),
             "license": "библиотека пайплайна", "author": s.get("pack", ""), "tags": s.get("category", "")} for _, s in out[:n]]


def search_freesound(q, n=8):
    data, _, _ = _get("https://freesound.org/search/?" + urllib.parse.urlencode({"q": q}), limit=4 * 2**20)
    s = data.decode("utf-8", "replace")
    parts = s.split('class="bw-search__result"')[1:]
    out = []
    for blk in parts:
        a = lambda k: (re.search(k + r'="([^"]*)"', blk) or [None, ""])[1]
        mp3, sid, user = a("data-mp3"), a("data-sound-id"), a("data-username")
        if not mp3:
            continue
        lic = re.search(r'title="License: ([^"]+)"', blk)
        desc = re.search(r'<p class="text-grey[^"]*"[^>]*>(.*?)</p>', blk, re.S)
        out.append({"src": "freesound", "title": html.unescape(a("data-title")), "url": mp3.replace("-lq.mp3", "-hq.mp3"),
                    "page": f"https://freesound.org/people/{user}/sounds/{sid}/", "dur": float(a("data-duration") or 0) or None,
                    "license": html.unescape(lic.group(1)) if lic else "", "author": user,
                    "tags": re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", desc.group(1)))).strip()[:160] if desc else ""})
        if len(out) >= n:
            break
    return out


def _commons_info(titles):
    qs = urllib.parse.urlencode({"action": "query", "titles": "|".join(titles), "prop": "imageinfo", "iiprop": "url|mediatype|extmetadata",
                                 "iiextmetadatafilter": "LicenseShortName|Artist|ImageDescription", "format": "json"})
    data, _, _ = _get("https://commons.wikimedia.org/w/api.php?" + qs, limit=2 * 2**20)
    return (json.loads(data).get("query") or {}).get("pages") or {}


def _commons_row(p):
    ii = (p.get("imageinfo") or [{}])[0]
    md = ii.get("extmetadata") or {}
    strip = lambda v: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", v or ""))).strip()
    return {"src": "commons", "title": p.get("title", "").replace("File:", ""), "url": (ii.get("url") or "").split("?")[0],
            "page": ii.get("descriptionurl") or "", "dur": None, "license": strip((md.get("LicenseShortName") or {}).get("value")),
            "author": strip((md.get("Artist") or {}).get("value"))[:80], "tags": strip((md.get("ImageDescription") or {}).get("value"))[:160]}


def search_commons(q, n=5):
    qs = urllib.parse.urlencode({"action": "query", "generator": "search", "gsrsearch": q + " filetype:audio", "gsrnamespace": 6,
                                 "gsrlimit": n, "prop": "imageinfo", "iiprop": "url|mediatype|extmetadata",
                                 "iiextmetadatafilter": "LicenseShortName|Artist|ImageDescription", "format": "json"})
    data, _, _ = _get("https://commons.wikimedia.org/w/api.php?" + qs, limit=2 * 2**20)
    pages = sorted(((json.loads(data).get("query") or {}).get("pages") or {}).values(), key=lambda p: p.get("index", 0))
    return [r for r in (_commons_row(p) for p in pages) if r["url"]]


def search(q, n=8, srcs=("lib", "freesound", "commons")):
    out, errs = [], []
    for name, fn, k in (("lib", search_lib, max(3, n // 2)), ("freesound", search_freesound, n), ("commons", search_commons, max(3, n // 2))):
        if name not in srcs:
            continue
        try:
            out += fn(q, k)
        except Exception as e:
            errs.append(f"{name}: {e}")
    return {"query": q, "results": out, "errors": errs}


# ---------------- fetch ----------------
def _ffmpeg_wav(src, dst, start=None, end=None, trim_silence=True):
    """src — a local file or an http(s) URL of an audio file: ffmpeg reads only what it needs (-t stops the download early)."""
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if re.match(r"https?://", src):
        cmd += ["-user_agent", UA, "-rw_timeout", "30000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", src]
    length = min(MAX_LEN, float(end) - float(start or 0)) if end else MAX_LEN
    af = ["silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.05"] if trim_silence and not start else []
    af.append(f"afade=t=out:st={max(0.0, MAX_LEN - 1.5)}:d=1.5")
    cmd += ["-vn", "-t", str(max(0.05, length)), "-af", ",".join(af), "-ar", "44100", "-sample_fmt", "s16", dst]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOWIN, timeout=600)
    if r.returncode or not os.path.isfile(dst) or os.path.getsize(dst) < 1000:
        raise RuntimeError("ffmpeg не смог прочитать звук: " + (r.stderr or "").strip()[-300:])


def analyze(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "22050", "-"],
                         capture_output=True, creationflags=NOWIN).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    if not len(x):
        return {"dur": 0, "peak_t": 0, "rms_db": -99}
    env = np.convolve(np.abs(x), np.ones(441) / 441, mode="same")
    rms = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    return {"dur": round(len(x) / 22050, 2), "peak_t": round(int(np.argmax(env)) / 22050, 2), "rms_db": round(20 * np.log10(rms), 1)}


def _probe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
                       capture_output=True, text=True, creationflags=NOWIN)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def _is_video_site(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return any(host == s or host.endswith("." + s) for s in VIDEO_SITES)


def _ytdlp(url, tmp, start=None, end=None):
    cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings", "-f", "bestaudio/best", "--max-filesize", "200M",
           "--write-info-json", "-o", os.path.join(tmp, "src.%(ext)s")]
    if start or end:
        cmd += ["--download-sections", f"*{float(start or 0)}-{float(end) if end else 'inf'}", "--force-keyframes-at-cuts"]
    r = subprocess.run(cmd + [url], capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOWIN, timeout=600)
    files = [f for f in os.listdir(tmp) if f.startswith("src.") and not f.endswith((".json", ".part"))]
    if not files:
        raise RuntimeError("yt-dlp не скачал звук: " + (r.stderr or r.stdout or "").strip()[-300:])
    info = {}
    try:
        with open(os.path.join(tmp, "src.info.json"), encoding="utf-8") as f:
            j = json.load(f)
        info = {"title": j.get("title") or "", "author": j.get("uploader") or j.get("channel") or "", "license": j.get("license") or "",
                "page": j.get("webpage_url") or url}
    except (OSError, ValueError):
        pass
    return os.path.join(tmp, files[0]), info


def _freesound_meta(sid):
    try:
        data, _, final = _get(f"https://freesound.org/s/{sid}/", limit=3 * 2**20)
        page = data.decode("utf-8", "replace")
        t = re.search(r'<meta property="og:title" content="([^"]+)"', page) or re.search(r"<title[^>]*>(.*?)</title>", page, re.S)
        lic = re.search(r'title="License: ([^"]+)"', page) or re.search(r"(Creative Commons 0|Attribution NonCommercial[^<\"]{0,12}|Attribution[^<\"]{0,12})", page)
        user = re.search(r"/people/([^/]+)/sounds/", final)
        return {k: v for k, v in {"title": html.unescape(t.group(1)).replace("Freesound - ", "").strip()[:120] if t else "", "author": user.group(1) if user else "",
                                   "license": html.unescape(lic.group(1)).strip() if lic else "", "page": final, "src": "freesound"}.items() if v}
    except Exception:
        return {"page": f"https://freesound.org/s/{sid}/", "src": "freesound"}


def _audio_links(page_html, base):
    s = page_html
    cands = []
    for pat in (r'<meta[^>]+property="og:audio(?::secure_url|:url)?"[^>]+content="([^"]+)"', r'content="([^"]+)"[^>]+property="og:audio',
                r'data-mp3="([^"]+)"', r'<(?:audio|source)[^>]+src="([^"]+)"', r'(?:href|src|data-url|data-src)="([^"]+\.(?:mp3|ogg|oga|wav|m4a|flac|opus)(?:\?[^"]*)?)"',
                r'(https?://[^\s"\'<>]+\.(?:mp3|ogg|wav|m4a|flac)(?:\?[^\s"\'<>]*)?)'):
        for m in re.finditer(pat, s, re.I):
            u = urllib.parse.urljoin(base, html.unescape(m.group(1)))
            if u not in cands and u.count("://") == 1 and "/download/" not in u:   # Freesound's og:audio is glued twice; /download/ needs a login
                cands.append(u)
    return cands


def _probe_url(url):
    """-> total size in bytes (0 if unknown) when the link answers with a file, None when it is dead or an HTML page."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-1023"})
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status not in (200, 206) or "text/html" in (r.headers.get("Content-Type") or ""):
                return None
            m = re.search(r"/(\d+)$", r.headers.get("Content-Range") or "")
            return int(m.group(1)) if m else int(r.headers.get("Content-Length") or 0) if r.status == 200 else 0
    except Exception:
        return None


def _download(url, tmp, start=None, end=None):
    """-> (local file, meta). Handles library ids, direct audio, pages with audio, video sites."""
    meta = {"page": url}
    if url.startswith("lib:"):
        sid = url[4:]
        p = os.path.join(LIB, *sid.split("/")) + ".wav"
        if not os.path.isfile(p):
            raise ValueError("нет такого звука в библиотеке: " + sid)
        s = next((x for x in _lib_index() if x.get("id") == sid), {})
        return p, {"title": s.get("name") or sid, "author": s.get("pack", ""), "license": "библиотека пайплайна", "page": "", "src": "lib"}
    if not re.match(r"https?://", url):
        raise ValueError("нужна ссылка http(s)://… или lib:<id>")
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host.endswith("commons.wikimedia.org") and "/File:" in url:
        pages = _commons_info([urllib.parse.unquote(url.split("/wiki/", 1)[1])])
        row = next((_commons_row(p) for p in pages.values() if p.get("imageinfo")), None)
        if row:
            f, _ = _download(row["url"], tmp)
            return f, {**row, "page": url}
    if _is_video_site(url):
        f, info = _ytdlp(url, tmp, start, end)
        return f, {**meta, **info, "src": host, "sectioned": bool(start or end)}
    fs = re.search(r"cdn\.freesound\.org/previews/\d+/(\d+)_", url)
    if fs:                                                    # a Freesound preview: title, author and license from the sound page
        meta.update(_freesound_meta(fs.group(1)))
    if urllib.parse.urlparse(url).path.lower().endswith(AUDIO_EXT):
        size = _probe_url(url)
        if size is None:
            raise RuntimeError("ссылка не отдаёт файл")
        if size == 0 or size > STREAM_FROM or end:           # a long recording or a piece of it: ffmpeg streams just what it needs
            return url, {"title": urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(url).path)), "src": host, **meta}
    data, ctype, final = _get(url)
    path = urllib.parse.urlparse(final).path.lower()
    if ctype.startswith(("audio/", "video/", "application/ogg", "application/octet-stream")) or path.endswith(AUDIO_EXT):
        f = os.path.join(tmp, "src" + (os.path.splitext(path)[1] or ".bin"))
        with open(f, "wb") as fh:
            fh.write(data)
        return f, {"title": urllib.parse.unquote(os.path.basename(path)), "src": host, **meta}
    page = data.decode("utf-8", "replace")
    title = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
    meta["title"] = html.unescape(title.group(1)).strip()[:120] if title else host
    if "freesound.org" in host:
        user = re.search(r"/people/([^/]+)/", url)
        lic = re.search(r'title="License: ([^"]+)"', page) or re.search(r'(Creative Commons[^<"]{0,60}|Attribution[^<"]{0,40}|Creative Commons 0)', page)
        meta.update(author=user.group(1) if user else "", license=html.unescape(lic.group(1)) if lic else "", src="freesound")
    for u in _audio_links(page, final)[:6]:
        u = u.replace("-lq.mp3", "-hq.mp3")
        if urllib.parse.urlparse(u).path.lower().endswith(AUDIO_EXT) and _probe_url(u) is None:
            continue
        try:
            f, m2 = _download(u, tmp)
            return f, {**m2, **{k: v for k, v in meta.items() if v}}
        except Exception:
            continue
    f, info = _ytdlp(url, tmp)                               # the generic extractor of yt-dlp knows many players
    return f, {**meta, **{k: v for k, v in info.items() if v}, "src": host}


def fetch(url, out_dir, start=None, end=None, name=None):
    """Download a sound into out_dir/<N>.wav (or name.wav). -> {file (abs), dur, peak_t, rms_db, title, author, license, page, src}"""
    os.makedirs(out_dir, exist_ok=True)
    start = float(start) if start not in (None, "") else None
    end = float(end) if end not in (None, "") else None
    tmp = tempfile.mkdtemp(prefix="snd_", dir=out_dir)
    try:
        src, meta = _download(url.strip(), tmp, start, end)
        if not name:
            ks = [int(m.group(1)) for f in os.listdir(out_dir) if (m := re.match(r"(\d+)\.wav$", f))]
            name = str(max(ks, default=0) + 1)
        dst = os.path.join(out_dir, name + ".wav")
        # yt-dlp may have cut the section already (--download-sections); if the file is still long, cut it here
        cut = True
        if meta.get("sectioned") and (start or end):
            want = (end or 0) - (start or 0) if end else None
            have = _probe_dur(src)
            cut = not (want and have and have <= want + 1.5)
        _ffmpeg_wav(src, dst, start if cut else None, end if cut else None)
        return {"file": dst, **analyze(dst), "title": meta.get("title", ""), "author": meta.get("author", ""),
                "license": meta.get("license", ""), "page": meta.get("page", url), "src": meta.get("src", ""), "url": url,
                "start": start, "end": end}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _opt(a, k, d=None):
    return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    a = sys.argv[1:]
    if a and a[0] == "search" and len(a) > 1:
        srcs = tuple((_opt(a, "--src") or "lib,freesound,commons").split(","))
        print(json.dumps(search(a[1], int(_opt(a, "--n", "8")), srcs), ensure_ascii=False, indent=1))
    elif a and a[0] == "fetch" and len(a) > 2:
        print(json.dumps(fetch(a[1], a[2], _opt(a, "--start"), _opt(a, "--end")), ensure_ascii=False, indent=1))
    else:
        sys.exit(__doc__)
