"""S12.8 — экспорт и «Рендеры» (docs/studio/stage12-redesign.md §9).

Очередь рендеров студии — по одному (видеокарта одна), переживает перезагрузку страницы; .studio/renders.json — история.
Рендер = (ролик Studio: montage gen) → build.sh (звук, кадры H.264 в браузере, склейка) → в out/ всё для загрузки на YouTube:
<имя>.mp4 · <имя>.srt (галка) · <имя>_thumbnail.jpg/.png (обложка) · <имя>.txt (название, описание, главы, права).

GET  /api/renders                     -> {queue: [...], done: [...готовые ролики канала...]}
GET  /api/renders/thumb?vid=&file=    -> кадр ролика (кэш .studio/cache/renders)
GET  /api/renders/chapters?id=        -> {chapters: [{t, title}], text}
GET  /api/renders/file?vid=&file=     -> сам ролик (плеер)
POST /api/renders/start   <- {id, name, srt, fps}
POST /api/renders/cancel  <- {rid}
POST /api/renders/open    <- {vid, file}      проводник с выделенным файлом
POST /api/renders/delete  <- {vid, file}      ролик (и его .srt / .txt / обложку) -> _archive/renders/…
"""
import glob, json, os, re, shutil, subprocess, threading, time, uuid

import paths as P

STATE = os.path.join(P.STATE, "renders.json")
CACHE = os.path.join(P.STATE, "cache", "renders")
_lock = threading.Lock()
Q = globals().get("Q") or {"items": [], "worker": None, "proc": None}     # переживает перезагрузку модуля
CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _save():
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump([{k: v for k, v in it.items() if k != "log"} for it in Q["items"][-200:]], f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def _load():
    if Q["items"]:
        return
    try:
        Q["items"] = json.load(open(STATE, encoding="utf-8"))
    except (OSError, ValueError):
        Q["items"] = []
    for it in Q["items"]:                                # сервер перезапускали посреди рендера
        if it.get("status") in ("queued", "running"):
            it["status"], it["error"] = "error", "прерван: Studio перезапускали"


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|]+', " ", (s or "").strip()).strip(" .")
    return re.sub(r"\s+", "_", s)[:90] or "video"


# ---------------------------------------------------------------- очередь
def start(A, body):
    _load()
    vid = body.get("id", "")
    vdir = P.video(vid)
    if not vdir or not os.path.isfile(os.path.join(vdir, "build.sh")):
        raise ValueError("у видео нет проекта ролика")
    if any(it["vid"] == vid and it["status"] in ("queued", "running") for it in Q["items"]):
        raise ValueError("этот ролик уже в очереди")
    d = A.load("plan:" + vid)
    fps = 30 if int(body.get("fps") or 60) == 30 else 60
    it = {"rid": "R" + uuid.uuid4().hex[:8], "vid": vid, "video": d.get("name", ""), "name": safe_name(body.get("name") or d.get("name")),
          "srt": bool(body.get("srt")), "fps": fps, "mode": d.get("mode") or "short", "status": "queued", "phase": "в очереди",
          "done": 0, "total": 0, "fpsr": 0, "eta": None, "created": int(time.time() * 1000), "started": None, "finished": None, "out": [], "error": ""}
    with _lock:
        Q["items"].append(it)
        _save()
        if not (Q["worker"] and Q["worker"].is_alive()):
            Q["worker"] = threading.Thread(target=_work, args=(A,), daemon=True)
            Q["worker"].start()
    return it


def cancel(rid):
    _load()
    it = next((x for x in Q["items"] if x["rid"] == rid), None)
    if not it:
        raise ValueError("нет такого рендера")
    if it["status"] == "queued":
        it["status"], it["phase"] = "cancelled", "отменён"
    elif it["status"] == "running":
        it["cancel"] = True
        pr = Q.get("proc")
        if pr and pr.poll() is None:
            subprocess.run(["taskkill", "/PID", str(pr.pid), "/T", "/F"], capture_output=True, creationflags=CF) if os.name == "nt" else pr.kill()
    _save()
    return {"ok": True}


def _work(A):
    while True:
        with _lock:
            it = next((x for x in Q["items"] if x["status"] == "queued"), None)
            if not it:
                Q["worker"] = None
                return
            it["status"], it["started"], it["phase"] = "running", int(time.time() * 1000), "готовлю"
            _save()
        try:
            _render(A, it)
            it["status"], it["phase"] = "done", "готово"
            _notify("Рендер готов", f"«{it['video']}» → out/{it['name']}.mp4")
        except Exception as e:
            if it.get("cancel"):
                it["status"], it["phase"] = "cancelled", "отменён"
            else:
                it["status"], it["error"], it["phase"] = "error", str(e)[-500:], "ошибка"
                _notify("Рендер не получился", f"«{it['video']}»: {str(e)[-120:]}")
        it["finished"] = int(time.time() * 1000)
        Q["proc"] = None
        _save()


def _render(A, it):
    vdir, vid = P.video(it["vid"]), it["vid"]
    mn = A.mnapi()
    if mn.studio_owned(vdir) and (A.load("plan:" + vid).get("montage") or {}).get("units"):
        it["phase"] = "файлы проекта"
        mn.generate(A, vid)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", FPS=str(it["fps"]))
    env["REVIEW_PORT"] = str(A.stapi().project_port(vdir))
    it["phase"] = "звук"
    t0 = None
    pr = Q["proc"] = subprocess.Popen([mn._bash(), "build.sh"], cwd=vdir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True,
                                      encoding="utf-8", errors="replace", creationflags=CF)
    log = []
    for line in pr.stdout:
        line = line.rstrip()
        log.append(line)
        m = re.match(r"^(\d+)/(\d+)\s", line)
        if m:
            t0 = t0 or time.time()
            it["phase"], it["done"], it["total"] = "кадры", int(m.group(1)), int(m.group(2))
            el = max(0.5, time.time() - t0)
            it["fpsr"] = round(it["done"] / el, 1)
            it["eta"] = round((it["total"] - it["done"]) / max(0.1, it["fpsr"]))
        elif line.startswith("frames done"):
            it["phase"], it["done"], it["eta"] = "склейка", it["total"] or it["done"], 3
            mm = re.search(r"\(([\d.]+) fps", line)
            if mm:
                it["fpsr"] = float(mm.group(1))
        elif "render.js" in line and "frames" in line:
            it["phase"] = "кадры"
    rc = pr.wait()
    if it.get("cancel"):
        raise RuntimeError("отменён")
    if rc != 0:
        raise RuntimeError("build.sh: " + "\n".join(log[-10:]))
    it["phase"] = "файлы для YouTube"
    it["out"] = finish(A, it)


# ---------------------------------------------------------------- out/: всё для загрузки на YouTube
def finish(A, it):
    vdir = P.video(it["vid"])
    out = os.path.join(vdir, "out")
    built = os.path.join(out, os.path.basename(vdir).replace(" ", "_") + ".mp4")
    name = it["name"]
    dst = os.path.join(out, name + ".mp4")
    files = []
    if os.path.isfile(built) and os.path.abspath(built) != os.path.abspath(dst):
        shutil.move(built, dst)                         # под именем экспорта (без дубля в «Рендерах»)
        nv, nvd = built[:-4] + "_NO_VO.mp4", dst[:-4] + "_NO_VO.mp4"
        if os.path.isfile(nv):
            shutil.move(nv, nvd)
    files.append(name + ".mp4")
    d = A.load("plan:" + it["vid"])
    if it.get("srt"):
        srt = make_srt(A, it["vid"])
        if srt:
            open(os.path.join(out, name + ".srt"), "w", encoding="utf-8").write(srt)
            files.append(name + ".srt")
    th = next((os.path.join(out, n) for n in ("thumbnail_1.jpg", "thumbnail_1.png", "thumbnail.jpg", "thumbnail.png") if os.path.isfile(os.path.join(out, n))), None)
    pk = d.get("pack") or {}
    pick = pk.get("thumb")
    if pick and os.path.isfile(os.path.join(out, pick)):
        th = os.path.join(out, pick)
    if th:
        ext = os.path.splitext(th)[1]
        shutil.copy2(th, os.path.join(out, name + "_thumbnail" + ext))
        files.append(name + "_thumbnail" + ext)
    open(os.path.join(out, name + ".txt"), "w", encoding="utf-8").write(youtube_text(A, d, it))
    files.append(name + ".txt")
    return files


def _title(d):
    pk = d.get("pack") or {}
    if pk.get("title"):
        return pk["title"]
    ts = pk.get("titles") or []
    st = next((t for t in ts if t.get("star")), ts[0] if ts else None)
    return (st or {}).get("text") or d.get("name", "")


def youtube_text(A, d, it):
    pk = d.get("pack") or {}
    L = ["НАЗВАНИЕ", _title(d), "", "ОПИСАНИЕ", (pk.get("desc") or pk.get("short") or "").strip() or "(описание не задано — шаг «Упаковка»)"]
    if pk.get("tags"):
        L += ["", " ".join(pk["tags"]) if isinstance(pk["tags"], list) else str(pk["tags"])]
    ch = chapters(A, it["vid"])
    if it.get("mode") == "long" and ch["chapters"]:
        L += ["", "ГЛАВЫ", ch["text"]]
    if (pk.get("rights_md") or "").strip():
        L += ["", "ПРАВА", pk["rights_md"].strip()]
    return "\n".join(L) + "\n"


def _fmt(t, ms=False):
    t = max(0.0, float(t))
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    if ms:
        return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)) % 1000:03d}"
    return (f"{h}:{m:02d}:{int(s):02d}" if h else f"{m}:{int(s):02d}")


def make_srt(A, vid):
    """Субтитры из таймингов слов голоса: фразы до ~7 слов / 3 с, разрыв на знаках препинания и паузах."""
    vo = A.mnapi().voice(vid) or {}
    W = [w for w in vo.get("words") or [] if not vo.get("studio")]
    if not W:
        return ""
    cues, cur = [], []
    for i, w in enumerate(W):
        cur.append(w)
        nxt = W[i + 1] if i + 1 < len(W) else None
        end = (len(cur) >= 7 or (cur[-1]["e"] - cur[0]["t"]) > 3.0 or re.search(r"[.!?…:;]$", w["w"]) or (len(cur) >= 3 and re.search(r",$", w["w"]))
               or nxt is None or nxt["t"] - w["e"] > 0.45)
        if end:
            cues.append(cur); cur = []
    out = []
    for n, c in enumerate(cues, 1):
        end = c[-1]["e"] + 0.05
        if n < len(cues):
            end = min(end, cues[n][0]["t"] - 0.01)         # фразы не наезжают друг на друга
        out += [str(n), f"{_fmt(c[0]['t'], True)} --> {_fmt(end, True)}", " ".join(x["w"] for x in c), ""]
    return "\n".join(out)


def chapters(A, vid):
    """Главы YouTube: начала сцен монтажа с их названиями (первая — 0:00)."""
    d = A.load("plan:" + vid)
    M = d.get("montage") or {}
    names = {e["id"]: e.get("name", "") for e in d.get("elements") or []}
    units = sorted(M.get("units") or [], key=lambda u: u.get("at") or 0)
    ch = []
    for u in units:
        t = float(u.get("at") or 0)
        title = names.get(u.get("scene")) or "Сцена"
        if ch and t - ch[-1]["t"] < 10:                  # YouTube: глава не короче 10 с — короткие сливаются с предыдущей
            continue
        ch.append({"t": 0.0 if not ch else t, "title": title})
    if not ch:
        vo = A.mnapi().voice(vid) or {}
        for s in vo.get("sections") or []:
            if not ch or s["start"] - ch[-1]["t"] >= 10:
                ch.append({"t": 0.0 if not ch else s["start"], "title": re.sub(r"^[\d:.,–—\s-]+—\s*", "", s.get("title") or "")})
    text = "\n".join(f"{_fmt(c['t'])} {c['title']}" for c in ch)
    return {"chapters": ch, "text": text, "ok": len(ch) >= 3}


# ---------------------------------------------------------------- готовые ролики
def done_list(A, channel=None):
    out = []
    for d in A.plans(channel):
        if d.get("service"):
            continue
        vdir = P.video(d["id"])
        for f in glob.glob(os.path.join(vdir or "", "out", "*.mp4")):
            n = os.path.basename(f)
            if n.endswith("_NO_VO.mp4") or n.startswith("demo"):
                continue
            st = os.stat(f)
            base = n[:-4]
            out.append({"vid": d["id"], "video": d.get("name", ""), "file": n, "size": st.st_size, "mtime": int(st.st_mtime * 1000),
                        "srt": os.path.isfile(os.path.join(vdir, "out", base + ".srt")), "txt": os.path.isfile(os.path.join(vdir, "out", base + ".txt")),
                        "mode": d.get("mode") or "short", **_probe(f)})
    return sorted(out, key=lambda x: -x["mtime"])


_PROBE = {}


def _probe(f):
    k = (f, os.path.getmtime(f))
    if k not in _PROBE:
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", f], capture_output=True, text=True, timeout=15, creationflags=CF)
            j = json.loads(r.stdout or "{}")
            s = next((x for x in j.get("streams") or [] if x.get("width")), {})
            _PROBE[k] = {"dur": round(float((j.get("format") or {}).get("duration") or 0), 2), "w": s.get("width"), "h": s.get("height")}
        except Exception:
            _PROBE[k] = {"dur": 0, "w": None, "h": None}
    return _PROBE[k]


def _file(vid, name):
    vdir = P.video(vid)
    f = vdir and os.path.abspath(os.path.join(vdir, "out", os.path.basename(name or "")))
    if not f or not os.path.isfile(f):
        raise ValueError("нет такого файла")
    return f


def thumb(vid, name):
    f = _file(vid, name)
    os.makedirs(CACHE, exist_ok=True)
    t = os.path.join(CACHE, f"{vid}-{re.sub(r'[^\\w.-]', '_', name)}-{int(os.path.getmtime(f))}.jpg")
    if not os.path.isfile(t):
        dur = _probe(f).get("dur") or 2
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(1.5, dur / 3):.2f}", "-i", f, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", t], capture_output=True, timeout=30, creationflags=CF)
    return t


def delete(vid, name):
    f = _file(vid, name)
    base = f[:-4]
    dst = os.path.join(P.ARCHIVE, "renders", vid, time.strftime("%y%m%d-%H%M%S"))
    os.makedirs(dst, exist_ok=True)
    moved = []
    for g in [f] + [base + x for x in (".srt", ".txt", "_thumbnail.jpg", "_thumbnail.png")]:
        if os.path.isfile(g):
            shutil.move(g, os.path.join(dst, os.path.basename(g)))
            moved.append(os.path.basename(g))
    return {"ok": True, "to": dst, "moved": moved}


def _notify(title, text):
    """Уведомление Windows (тост от имени PowerShell — работает без модулей)."""
    if os.name != "nt":
        return
    esc = lambda s: str(s).replace("'", "''").replace("<", "").replace(">", "").replace("&", "и")
    ps = ("[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
          "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
          f"$t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('{esc(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('{esc(text)}')) > $null;"
          "$n = [Windows.UI.Notifications.ToastNotification]::new($x);"
          "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)")
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], creationflags=CF, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


# ---------------------------------------------------------------- HTTP
def handle_get(A, h, p, q):
    g = lambda k: q.get(k, [""])[0]
    if p == "/api/renders":
        _load()
        ch = P.channel()
        items = [{k: v for k, v in it.items() if k not in ("log", "cancel")} for it in Q["items"][-40:]]
        h._json({"queue": [x for x in items if x["status"] in ("queued", "running")], "recent": [x for x in items if x["status"] not in ("queued", "running")][-12:],
                 "done": done_list(A, ch["id"] if ch else None)}); return True
    if p == "/api/renders/thumb":
        A._send_file(h, thumb(g("vid"), g("file"))); return True
    if p == "/api/renders/file":
        A._send_file(h, _file(g("vid"), g("file"))); return True
    if p == "/api/renders/chapters":
        h._json(chapters(A, g("id"))); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/renders/start":
        h._json(start(A, body)); return True
    if p == "/api/renders/cancel":
        h._json(cancel(body.get("rid", ""))); return True
    if p == "/api/renders/open":
        f = _file(body.get("vid", ""), body.get("file", ""))
        if os.name == "nt":
            subprocess.Popen(["explorer", "/select,", f], creationflags=CF)
        h._json({"ok": True}); return True
    if p == "/api/renders/delete":
        h._json(delete(body.get("vid", ""), body.get("file", ""))); return True
    return False
