"""S23 «Звуковой редактор монтажа» (docs/studio/stage23-audio.md): панель «🔊 Звуки» окна видео.
GET  /api/audio/list?video=&tab=lib|channel|video&q=&cat=   — звуки вкладки: [{src, name, dur, url, cat, peak?}] (src — как в монтаже: lib:<id>, lib:sounds/<slug>@N, el:<id>, file:<путь>)
GET  /api/audio/search?q=                                   — интернет (YouTube первым, Freesound, Commons) — sounds.search
GET  /api/audio/similar?video=&src=&q=                      — похожие в библиотеке пайплайна (категория + слова названия) — «Заменить похожим…» без Claude
POST /api/audio/upload {video, name, data}                  — свой файл (base64 / dataURL; звук или видео — берётся звук) -> <видео>/files/sfx/own/<имя>.wav
POST /api/audio/fetch {video, url, start, end, title}       — скачать найденное в интернете -> <видео>/files/sfx/net/<N>.wav (+ .json: источник, лицензия); фоном
GET  /api/audio/fetchstate?id=                              — {status: run|done|error, item|error}
"""
import base64, json, os, re, subprocess, tempfile, threading, time, uuid, wave

import paths as P  # noqa: E402

AUDIO_EXT = (".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".opus")
CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_DUR = {}
FETCH = {}
IMPORT = {}                                                    # «＋ Пак»: {cur: {path, i, n, added, status, error}}


def _dur(f):
    try:
        m = os.path.getmtime(f)
    except OSError:
        return 0
    hit = _DUR.get(f)
    if hit and hit[0] == m:
        return hit[1]
    d = 0.0
    try:
        if f.lower().endswith(".wav"):
            with wave.open(f) as w:
                d = w.getnframes() / float(w.getframerate())
    except Exception:
        d = 0.0
    if not d:
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], capture_output=True, text=True, creationflags=CF, timeout=20)
            d = float((r.stdout or "0").strip() or 0)
        except Exception:
            d = 0.0
    _DUR[f] = (m, round(d, 2))
    return _DUR[f][1]


SYN = {"woosh": "whoosh", "swoosh": "whoosh", "swish": "whoosh", "вжух": "whoosh", "удар": "hit", "дождь": "rain", "шаги": "footsteps", "шаг": "footsteps",
       "дверь": "door", "взрыв": "explosion", "клик": "click", "поп": "pop", "ветер": "wind", "толпа": "crowd", "смех": "laugh", "гром": "thunder"}


def _words(s):
    return [SYN.get(w, w) for w in re.split(r"[^\wа-яё]+", (s or "").lower().replace("ё", "е")) if w]


def _match(q, hay):
    ws = _words(q)
    if not ws:
        return True
    h = " ".join(_words(hay))
    return all(w in h for w in ws)


def _lib():
    p = os.path.join(P.SFXLIB, "index.json")
    try:
        return json.load(open(p, encoding="utf-8")).get("sounds", [])
    except (OSError, ValueError):
        return []


def _lib_row(s):
    return {"src": "lib:" + s["id"], "name": s.get("name") or s["id"], "dur": s.get("dur"), "url": f"/sfxlib/{s['id']}.wav",
            "cat": s.get("category") or s["id"].split("/")[0], "peak": s.get("peak_t"), "tags": s.get("tags") or ""}


def own_dir(vid, sub="own"):
    return os.path.join(P.video(vid), "files", "sfx", sub)


def list_tab(A, vid, tab, q="", cat="", pack=""):
    if tab == "lib":
        lib = _lib()
        rows = [dict(_lib_row(s), pack=s.get("pack") or "") for s in lib]
        cats = sorted({r["cat"] for r in rows})
        packs = sorted({r["pack"] for r in rows if r["pack"]})
        rows = [r for r in rows if (not cat or r["cat"] == cat) and (not pack or r["pack"] == pack) and _match(q, f"{r['src']} {r['name']} {r['cat']} {r['tags']} {r['pack']}")]
        return {"items": rows[:300], "cats": cats, "packs": packs, "n": len(rows), "import": IMPORT.get("cur")}
    if tab == "channel":
        st = A.stapi()
        ch = P.index()["videos"].get(vid, {}).get("channel")
        c = st.channel_dir(ch)
        out = []
        for it in st.lib_index(c):
            if it.get("kind") != "sounds" or not _match(q, f"{it.get('name')} {it.get('desc')} {it.get('tags')}"):
                continue
            slug, v = it["id"].split("/", 1)[1], it.get("latest") or 1
            d = os.path.join(st.lib_dir(c), "sounds", slug, f"v{v}")
            try:
                fs = sorted(x for x in os.listdir(d) if x.lower().endswith(AUDIO_EXT))
            except OSError:
                fs = []
            if not fs:
                continue
            out.append({"src": f"lib:sounds/{slug}@{v}", "name": it.get("name") or slug, "dur": max(_dur(os.path.join(d, f)) for f in fs),
                        "url": f"/api/lib/file/video:{vid}/sounds/{slug}/v{v}/{fs[0]}", "cat": "канал", "desc": it.get("desc") or "", "layers": len(fs)})
        return {"items": out, "cats": [], "n": len(out)}
    # видео: звуки препродакшена + свои файлы и скачанные
    plan = A.load("plan:" + vid)
    mn = A.mnapi()
    out = []
    for s in mn.sources(plan):
        if not _match(q, s["name"]):
            continue
        urls = mn._src_urls(A, vid, s["src"], plan)
        out.append({"src": s["src"], "name": s["name"], "dur": s["dur"], "url": urls[0]["url"] if urls else "", "cat": "препродакшен", "layers": len(urls)})
    for sub, label in (("own", "мои"), ("net", "из интернета"), ("edit", "обработанные")):
        d = own_dir(vid, sub)
        try:
            fs = sorted(os.listdir(d), key=lambda f: -os.path.getmtime(os.path.join(d, f)))
        except OSError:
            continue
        for f in fs:
            if not f.lower().endswith(AUDIO_EXT):
                continue
            meta = {}
            try:
                meta = json.load(open(os.path.join(d, os.path.splitext(f)[0] + ".json"), encoding="utf-8"))
            except (OSError, ValueError):
                pass
            name = meta.get("title") or os.path.splitext(f)[0]
            if not _match(q, name):
                continue
            rel = f"files/sfx/{sub}/{f}"
            out.append({"src": "file:" + rel, "name": name, "dur": _dur(os.path.join(d, f)), "url": f"/api/montage/file?video={vid}&p={rel}", "cat": label,
                        "license": meta.get("license") or "", "page": meta.get("page") or ""})
    return {"items": out, "cats": [], "n": len(out)}


def _safe(name):
    n = re.sub(r"[^\wа-яё .-]+", "", os.path.splitext(os.path.basename(name or "звук"))[0], flags=re.I).strip()[:60] or "звук"
    return n


def _to_wav(src, dst):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-ar", "44100", "-ac", "2", dst], capture_output=True, text=True, creationflags=CF)
    if r.returncode or not os.path.isfile(dst):
        raise ValueError("не получилось прочитать звук: " + (r.stderr or "")[-300:])


def upload(A, vid, name, data, sub="own", meta=None):
    if not P.video(vid):
        raise ValueError("нет такого видео")
    if "," in data[:200] and data.startswith("data:"):
        data = data.split(",", 1)[1]
    raw = base64.b64decode(data)
    if len(raw) > 400 * 2**20:
        raise ValueError("файл больше 400 МБ")
    d = own_dir(vid, sub)
    os.makedirs(d, exist_ok=True)
    base = _safe(name)
    dst, k = os.path.join(d, base + ".wav"), 2
    while os.path.exists(dst):
        dst = os.path.join(d, f"{base} {k}.wav"); k += 1
    tmp = os.path.join(tempfile.gettempdir(), "studio_up_" + uuid.uuid4().hex + (os.path.splitext(name or "")[1] or ".bin"))
    try:
        open(tmp, "wb").write(raw)
        _to_wav(tmp, dst)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    if meta:
        A.write_text(os.path.splitext(dst)[0] + ".json", json.dumps(meta, ensure_ascii=False, indent=1))
    rel = f"files/sfx/{sub}/{os.path.basename(dst)}"
    return {"src": "file:" + rel, "name": os.path.splitext(os.path.basename(dst))[0], "dur": _dur(dst), "url": f"/api/montage/file?video={vid}&p={rel}"}


def _fetch_run(A, fid, vid, body):
    try:
        snd = A.sapi()
        d = own_dir(vid, "net")
        r = snd.fetch(body["url"], d, body.get("start"), body.get("end"))
        f = r["file"]
        title = (body.get("title") or r.get("title") or os.path.splitext(os.path.basename(f))[0])[:80]
        meta = {"title": title, "author": r.get("author", ""), "license": r.get("license", ""), "page": r.get("page") or body["url"], "url": body["url"],
                "start": r.get("start"), "end": r.get("end"), "at": int(time.time())}
        A.write_text(os.path.splitext(f)[0] + ".json", json.dumps(meta, ensure_ascii=False, indent=1))
        rel = f"files/sfx/net/{os.path.basename(f)}"
        FETCH[fid] = {"status": "done", "item": {"src": "file:" + rel, "name": title, "dur": r.get("dur") or _dur(f), "url": f"/api/montage/file?video={vid}&p={rel}",
                                                  "license": meta["license"], "page": meta["page"]}}
    except Exception as e:
        FETCH[fid] = {"status": "error", "error": str(e)[:400]}


_MIX = {}


def search_mixkit(q, n=12):
    """Mixkit (бесплатно, без атрибуции, Mixkit Sound Effects Free License): страница тега mixkit.co/free-sound-effects/<тег>/ — превью mp3 = весь звук.
    Русские слова — через SYN (дождь -> rain); пробуем «слова-через-дефис», потом каждое слово."""
    import html as _h
    import urllib.request
    ws = [w for w in _words(q) if not w.isdigit()]
    tries = (["-".join(ws)] if len(ws) > 1 else []) + ws
    out, seen = [], set()
    for tag in tries[:3]:
        if tag in _MIX and time.time() - _MIX[tag][0] < 3600:
            page = _MIX[tag][1]
        else:
            try:
                req = urllib.request.Request(f"https://mixkit.co/free-sound-effects/{tag}/", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"})
                page = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "replace")
            except Exception:
                page = ""
            _MIX[tag] = (time.time(), page)
        for card in re.split(r'class="item-grid-card ', page)[1:]:
            t = re.search(r"item-grid-card__title[^>]*>\s*([^<]+)", card)
            u = re.search(r'preview-url-value="([^"]+)"', card)
            dm = re.search(r">\s*(\d+):(\d\d)\s*<", card)
            if not (t and u) or u.group(1) in seen:
                continue
            seen.add(u.group(1))
            out.append({"src": "mixkit", "title": _h.unescape(t.group(1).strip()), "url": u.group(1), "page": f"https://mixkit.co/free-sound-effects/{tag}/",
                        "dur": int(dm.group(1)) * 60 + int(dm.group(2)) if dm else None, "license": "Mixkit Free License — без атрибуции", "author": "Mixkit", "tags": tag})
        if len(out) >= n:
            break
    return out[:n]


def similar(A, vid, src, q=""):
    """Похожие звуки библиотеки пайплайна: та же категория и общие слова названия / тегов; без Claude."""
    lib = _lib()
    m = re.match(r"lib:([^|]+)", src or "")
    me = next((s for s in lib if m and s["id"] == m.group(1)), None)
    cat = (me.get("category") or me["id"].split("/")[0]) if me else ""
    ws = set(_words(q) + _words(" ".join(str((me or {}).get(k, "")) for k in ("name", "tags"))) + _words(re.sub(r"^[a-z]+:", "", src or "").replace("/", " ")))
    cats = {(x.get("category") or x["id"].split("/")[0]).lower() for x in lib}
    ws = {w for w in ws if len(w) > 2 and not w.isdigit() and w not in cats - {"whoosh", "rain", "door", "hit", "footsteps", "explosion", "wind", "crowd", "thunder", "click", "pop", "laugh"}}
    out = []
    for s in lib:
        if me and s["id"] == me["id"]:
            continue
        hay = set(_words(" ".join(str(s.get(k, "")) for k in ("id", "name", "tags", "category"))))
        hit = len(ws & hay) + 0.5 * sum(1 for w in ws if len(w) >= 4 and any(x.startswith(w[:4]) for x in hay if x not in ws))
        sc = 3 * hit + (1 if cat and (s.get("category") or s["id"].split("/")[0]) == cat else 0)
        if sc > 0:
            out.append((sc, s))
    out.sort(key=lambda x: -x[0])
    return {"items": [_lib_row(s) for _, s in out[:12]]}


def handle_get(A, h, p, q):
    g = lambda k, d="": (q.get(k) or [d])[0]
    if p == "/api/audio/list":
        h._json(list_tab(A, g("video"), g("tab", "lib"), g("q"), g("cat"), g("pack"))); return True
    if p == "/api/audio/importstate":
        h._json(IMPORT.get("cur") or {}); return True
    if p == "/api/audio/search":
        if not g("q").strip():
            raise ValueError("пустой запрос")
        r = A.sapi().search(g("q").strip(), int(g("n", "8")), srcs=("youtube", "freesound", "commons"))
        try:
            r["results"] = search_mixkit(g("q").strip()) + r["results"]          # Mixkit первым: без атрибуции, слушается прямо в панели
        except Exception as e:
            r.setdefault("errors", []).append(f"mixkit: {e}")
        h._json(r); return True
    if p == "/api/audio/similar":
        h._json(similar(A, g("video"), g("src"), g("q"))); return True
    if p == "/api/audio/fetchstate":
        h._json(FETCH.get(g("id")) or {"status": "error", "error": "нет такой загрузки"}); return True
    return False


def _import_run(path, license_):
    import importlib, sys
    sys.path.insert(0, P.STUDIO)
    L = importlib.import_module("sfx_library")
    cur = IMPORT["cur"]

    def prog(i, n, added):
        cur.update(i=i, n=n, added=added)
    try:
        cur["added"] = L.import_pack(path, license=license_ or None, progress=prog)
        cur["status"] = "done"
    except Exception as e:
        cur.update(status="error", error=str(e)[:400])


def handle_post(A, h, p, body):
    if p == "/api/audio/import":                       # «＋ Пак»: папка или .zip -> библиотека звуков Studio (sfx_library.py import), фоном
        path = (body.get("path") or "").strip().strip('"')
        if not (os.path.isdir(path) or (path.lower().endswith(".zip") and os.path.isfile(path))):
            raise ValueError("нет такой папки или zip: " + path)
        if (IMPORT.get("cur") or {}).get("status") == "run":
            raise ValueError("уже импортирую пак — дождитесь конца")
        IMPORT["cur"] = {"path": path, "i": 0, "n": 0, "added": 0, "status": "run", "pack": os.path.splitext(os.path.basename(os.path.normpath(path)))[0]}
        threading.Thread(target=_import_run, args=(path, body.get("license") or ""), daemon=True).start()
        h._json(IMPORT["cur"]); return True
    if p == "/api/audio/upload":
        h._json(upload(A, body["video"], body.get("name") or "звук", body.get("data") or "", meta=body.get("meta"),
                       sub="edit" if body.get("edit") else "own")); return True
    if p == "/api/audio/fetch":
        if not (body.get("url") or "").strip():
            raise ValueError("нет ссылки")
        fid = uuid.uuid4().hex[:10]
        FETCH[fid] = {"status": "run"}
        threading.Thread(target=_fetch_run, args=(A, fid, body["video"], body), daemon=True).start()
        h._json({"id": fid}); return True
    return False
