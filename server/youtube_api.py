"""S17 — «📈 YouTube»: аналитика канала и уроки для Claude (docs/studio/stage17-youtube.md).

Вход в Google (OAuth PKCE на 127.0.0.1, только чтение: youtube.readonly + yt-analytics.readonly), без сторонних библиотек — только urllib.
Основа — архивный tools/archived/youtube.py (трекер «Просмотров» Штурма).
- OAuth-клиент «Desktop app»: .studio/youtube_client.json (переезжает из _archive/ideas сам); токены — .studio/youtube/<UC…>.json (по YouTube-каналу).
- Канал Studio ↔ YouTube: channel.json → youtube {id, handle, title, thumb, linkedAt}.
- Кэш (перекачивается, вне git канала): <канал>/analytics/channel.json (ряды по дням, 180 дн.), videos.json (ролики, вехи d3/d28, подсказки привязки),
  v/<ytid>.json (удержание, источники, комментарии, разборы Claude), ideas.json (идеи из комментариев), links.json ({ytid: false} — «не из Studio»), probe.json.
- Комментарии: commentThreads.list требует скоуп youtube.force-ssl (запись) — не берём; читаем yt-dlp (как референсы), 2–3 с на ролик, только где счётчик изменился.
- Привязка ролика к видео Studio: автоподбор (названия упаковки, дата экспорта, длина out/*.mp4) -> «?» -> автор ✓ -> video.json → yt, status out.
- Задачи: ytsync / ytlogin — без Claude; ytvideo (разбор ролика: сама на вехах 3 и 28 дней, если веха наступила после подключения канала, или «✨ Разобрать»),
  ytlearn («✨ Что работает» по каналу) — Sonnet, 1 проход, без инструментов; уроки -> «Память» (status new, from.kind = 'yt').

GET  /api/yt                       -> сводка раздела (сам запускает ytsync, если данным больше 6 ч)
GET  /api/yt/video?id=&fresh=1     -> карточка ролика (удержание, источники, комменты, сцены видео Studio, спады, разборы)
POST /api/yt/login | client {json} | select {ucid} | unlink | logout {ucid} | sync | link {yt, video|false|null}
POST /api/yt/learn | review {yt, ask} | lesson {text} | idea {id} | idea/del {id}
CLI: yt status | login | channels | select UC… | unlink | sync | show [ytid] | link ytid видео | unlink-video ytid | learn | review ytid
"""
import base64, datetime as dt, difflib, glob, hashlib, http.server, json, os, re, secrets, shutil, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request, webbrowser

import paths as P

SCOPES = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly"
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
DATA_API = "https://www.googleapis.com/youtube/v3/"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
YT_DIR = os.path.join(P.STATE, "youtube")
CLIENT = os.path.join(P.STATE, "youtube_client.json")
OLD = os.path.join(P.ARCHIVE, "ideas")
SHORT_MAX = 180          # до 3 минут — шорт
STALE = 6 * 3600         # данные старше — обновить при открытии раздела
DAYS = 180               # ряд по дням: 90 + 90 для сравнения
MILESTONES = (("d3", 3), ("d28", 28))
REVIEW_MAX_AGE = 60      # дней: старше — вехи не догоняем
COMMENTS_PER_SYNC = 6    # роликов за синк, у которых качаем комменты (yt-dlp)


class NeedLogin(RuntimeError):
    pass


def _now():
    return int(time.time() * 1000)


def _rj(p, d=None):
    try:
        return json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return d


def _wj(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    P.write_atomic(p, json.dumps(obj, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- вход в Google
def _client():
    if not os.path.isfile(CLIENT) and os.path.isfile(os.path.join(OLD, "youtube_client.json")):
        os.makedirs(P.STATE, exist_ok=True)
        shutil.copy(os.path.join(OLD, "youtube_client.json"), CLIENT)
    c = _rj(CLIENT)
    if not c:
        raise RuntimeError("нет OAuth-клиента Google — вставь JSON клиента «Desktop app» из Google Cloud (раздел YouTube → «Подключить»)")
    c = c.get("installed") or c.get("web") or c
    if not c.get("client_id") or not c.get("client_secret"):
        raise RuntimeError("JSON не похож на OAuth-клиент (нет client_id / client_secret)")
    return c


def set_client(text):
    try:
        d = json.loads(text) if isinstance(text, str) else text
    except ValueError:
        raise RuntimeError("это не JSON — скачай файл клиента в Google Cloud → Credentials → OAuth client (Desktop app) → Download JSON")
    c = (d or {}).get("installed") or (d or {}).get("web") or d or {}
    if not c.get("client_id") or not c.get("client_secret"):
        raise RuntimeError("в JSON нет client_id / client_secret")
    _wj(CLIENT, d)
    return {"ok": True}


def _post(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Google: {e.code} {e.read().decode('utf-8', 'replace')[:300]}")


def _tok_path(ucid):
    return os.path.join(YT_DIR, ucid + ".json")


def tokens():
    """UC-идентификаторы каналов, к которым есть вход. Старый токен Штурма переезжает сам."""
    os.makedirs(YT_DIR, exist_ok=True)
    have = [os.path.basename(p)[:-5] for p in glob.glob(os.path.join(YT_DIR, "UC*.json"))]
    old = os.path.join(OLD, "youtube_token.json")
    if not have and os.path.isfile(old) and not os.path.isfile(os.path.join(YT_DIR, ".migrated")):
        open(os.path.join(YT_DIR, ".migrated"), "w").close()
        try:
            tok = _rj(old)
            for ch in _mine(tok):
                _wj(_tok_path(ch["id"]), tok)
                have.append(ch["id"])
        except Exception as e:
            print("! yt: старый токен не подошёл:", e)
    return have


def _access(tok, save=None):
    if tok.get("expires_at", 0) > time.time():
        return tok["access_token"]
    c = _client()
    try:
        new = _post(TOKEN, {"refresh_token": tok["refresh_token"], "client_id": c["client_id"], "client_secret": c["client_secret"], "grant_type": "refresh_token"})
    except RuntimeError as e:
        if "invalid_grant" in str(e):
            if save and os.path.isfile(save):
                os.remove(save)
            raise NeedLogin("доступ Google истёк или отозван — войди заново (если приложение Google Cloud в режиме Testing, токен живёт 7 дней: переведи его в In production)")
        raise
    tok.update(access_token=new["access_token"], expires_at=time.time() + new.get("expires_in", 3600) - 60)
    if save:
        _wj(save, tok)
    return tok["access_token"]


def _get_tok(tok, url, params, save=None):
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={"Authorization": "Bearer " + _access(tok, save)})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=40).read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 403 and "insufficient" in body.lower():
            raise NeedLogin("не все права выданы — войди ещё раз и отметь обе галочки (YouTube и YouTube Analytics)")
        raise RuntimeError(f"YouTube API {e.code}: {body[:300]}")


def _get(ucid, url, params):
    p = _tok_path(ucid)
    tok = _rj(p)
    if not tok:
        raise NeedLogin("к этому YouTube-каналу нет входа — нажми «Войти через Google»")
    return _get_tok(tok, url, params, p)


def _mine(tok, save=None):
    r = _get_tok(tok, DATA_API + "channels", {"part": "snippet,statistics,contentDetails", "mine": "true"}, save)
    return [_chinfo(it) for it in r.get("items", [])]


def _chinfo(it):
    sn, st = it.get("snippet", {}), it.get("statistics", {})
    th = sn.get("thumbnails", {})
    return {"id": it["id"], "title": sn.get("title", ""), "handle": sn.get("customUrl", ""),
            "thumb": (th.get("medium") or th.get("default") or {}).get("url", ""),
            "subs": int(st.get("subscriberCount", 0) or 0), "views": int(st.get("viewCount", 0) or 0), "videos": int(st.get("videoCount", 0) or 0),
            "uploads": (it.get("contentDetails", {}).get("relatedPlaylists") or {}).get("uploads", "UU" + it["id"][2:])}


def login(A, job=None, timeout=300):
    """Окно входа Google в браузере -> токен -> каналы аккаунта. Если у текущего канала Studio нет привязки — привязать к первому."""
    c = _client()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(40)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] != state:
                self.send_response(400); self.end_headers(); return
            got.update({k: v[0] for k, v in q.items()})
            ok = "code" in got
            body = ("<h2>Готово ✅</h2><p>Доступ к статистике выдан (только чтение). Окно можно закрыть и вернуться в Claude Studio.</p>" if ok
                    else f"<h2>Не вышло</h2><p>{got.get('error', '')}</p>").encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write(b"<meta charset=utf-8><body style='font:18px sans-serif;padding:40px;background:#111;color:#eee'>" + body)

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = AUTH + "?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent select_account", "state": state, "include_granted_scopes": "true",
        "code_challenge": challenge, "code_challenge_method": "S256"})
    webbrowser.open(url)
    if job:
        job.summary = "Жду вход в Google в браузере…"
    srv.timeout = 2
    t0 = time.time()
    while not got and time.time() - t0 < timeout and not (job and job.cancelled):
        srv.handle_request()
    srv.server_close()
    if "code" not in got:
        raise RuntimeError("вход не завершён: " + (got.get("error") or "время вышло"))
    tok = _post(TOKEN, {"code": got["code"], "client_id": c["client_id"], "client_secret": c["client_secret"],
                        "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier})
    if not tok.get("refresh_token"):
        raise RuntimeError("Google не выдал refresh_token — попробуй войти ещё раз")
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    if "yt-analytics" not in (tok.get("scope") or ""):
        raise NeedLogin("Google не дал доступ к YouTube Analytics — войди ещё раз и отметь обе галочки")
    chs = _mine(tok)
    if not chs:
        raise RuntimeError("у этого аккаунта нет YouTube-канала — при входе выбери аккаунт (или бренд-аккаунт) канала")
    for ch in chs:
        _wj(_tok_path(ch["id"]), tok)
    cur = P.channel() or {}
    if not (cur.get("youtube") or {}).get("id"):
        select(A, chs[0]["id"])
    if job:
        job.summary = "Вошли: " + ", ".join(c["title"] for c in chs)
    return chs


def channels_list():
    """Каналы, к которым есть вход: [{id, title, handle, thumb, subs}]."""
    out = []
    for ucid in tokens():
        try:
            r = _get(ucid, DATA_API + "channels", {"part": "snippet,statistics,contentDetails", "id": ucid})
            out += [_chinfo(it) for it in r.get("items", [])]
        except Exception as e:
            out.append({"id": ucid, "title": ucid, "error": str(e)})
    return out


def select(A, ucid, cid=None):
    """Привязать канал Studio к YouTube-каналу."""
    r = _get(ucid, DATA_API + "channels", {"part": "snippet,statistics,contentDetails", "id": ucid})
    if not r.get("items"):
        raise RuntimeError("канал не найден")
    info = _chinfo(r["items"][0])
    ch = P.channel(cid) if cid else P.channel()
    if not ch:
        raise RuntimeError("нет канала Studio")
    y = {"id": info["id"], "handle": info["handle"], "title": info["title"], "thumb": info["thumb"], "linkedAt": _now()}
    A.apply_ops("channel:" + ch["id"], [{"op": "set", "path": ["youtube"], "value": y}])
    P.index(True)
    _gitignore(ch)
    return y


def unlink(A, cid=None):
    ch = P.channel(cid) if cid else P.channel()
    if ch:
        A.apply_ops("channel:" + ch["id"], [{"op": "set", "path": ["youtube"], "value": None}])
        P.index(True)
    return {"ok": True}


def logout(ucid):
    p = _tok_path(ucid)
    if os.path.isfile(p):
        os.remove(p)
    return {"ok": True}


def _gitignore(ch):
    p = os.path.join(ch["dir"], ".gitignore")
    try:
        t = open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
        if "analytics/" not in t:
            with open(p, "a", encoding="utf-8") as f:
                f.write(("" if not t or t.endswith("\n") else "\n") + "analytics/\n")
    except OSError:
        pass


# ---------------------------------------------------------------- кэш канала
def _ch(cid=None):
    ch = P.channel(cid) if cid else P.channel()
    if not ch:
        raise RuntimeError("нет канала Studio")
    return ch


def _adir(ch):
    return os.path.join(ch["dir"], "analytics")


def _ucid(ch):
    y = ch.get("youtube") or {}
    if not y.get("id"):
        raise RuntimeError("канал Studio не привязан к YouTube")
    return y["id"]


def iso_seconds(d):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d or "")
    if not m:
        return 0
    days, hh, mm, ss = (int(x or 0) for x in m.groups())
    return days * 86400 + hh * 3600 + mm * 60 + ss


def _uploads(ucid, uploads):
    ids, tok = [], None
    while True:
        p = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50}
        if tok:
            p["pageToken"] = tok
        r = _get(ucid, DATA_API + "playlistItems", p)
        ids += [i["contentDetails"]["videoId"] for i in r.get("items", [])]
        tok = r.get("nextPageToken")
        if not tok or len(ids) >= 500:
            break
    out = []
    for k in range(0, len(ids), 50):
        r = _get(ucid, DATA_API + "videos", {"part": "snippet,contentDetails,statistics,status", "id": ",".join(ids[k:k + 50])})
        for v in r.get("items", []):
            if v.get("status", {}).get("privacyStatus") != "public":
                continue
            s, sn = v.get("statistics", {}), v["snippet"]
            sec = iso_seconds(v["contentDetails"].get("duration"))
            th = sn.get("thumbnails", {})
            title = sn.get("title", "")
            out.append({"yt": v["id"], "title": title, "published": sn["publishedAt"][:10],
                        "pubts": int(dt.datetime.fromisoformat(sn["publishedAt"].replace("Z", "+00:00")).timestamp() * 1000),
                        "dur": sec, "type": "short" if sec <= SHORT_MAX or "#shorts" in title.lower() else "long",
                        "thumb": (th.get("medium") or th.get("high") or th.get("default") or {}).get("url", ""),
                        "views": int(s.get("viewCount", 0) or 0), "likes": int(s.get("likeCount", 0) or 0), "comments": int(s.get("commentCount", 0) or 0)})
    return out


def _rep(ucid, **p):
    r = _get(ucid, ANALYTICS, dict({"ids": "channel==MINE"}, **p))
    cols = [c["name"] for c in r.get("columnHeaders", [])]
    return [dict(zip(cols, row)) for row in r.get("rows", []) or []]


def _last_day(ucid):
    end = dt.date.today()
    rows = _rep(ucid, startDate=(end - dt.timedelta(days=10)).isoformat(), endDate=end.isoformat(), metrics="views", dimensions="day", sort="day")
    days = [r["day"] for r in rows if r.get("views")]
    return dt.date.fromisoformat(days[-1]) if days else end - dt.timedelta(days=3)


def _f(x, nd=1):
    try:
        return round(float(x or 0), nd)
    except (TypeError, ValueError):
        return 0


def _days(ucid, last):
    start = (last - dt.timedelta(days=DAYS - 1)).isoformat()
    base = "views,estimatedMinutesWatched,subscribersGained,subscribersLost,averageViewDuration,averageViewPercentage"
    try:
        rows = _rep(ucid, startDate=start, endDate=last.isoformat(), metrics=base + ",engagedViews", dimensions="day", sort="day")
    except RuntimeError:
        rows = _rep(ucid, startDate=start, endDate=last.isoformat(), metrics=base, dimensions="day", sort="day")
    by = {}
    try:
        for r in _rep(ucid, startDate=start, endDate=last.isoformat(), metrics="views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,engagedViews",
                      dimensions="day,creatorContentType", sort="day"):
            t = "short" if r.get("creatorContentType") == "shorts" else "long"
            if not r.get("views"):
                continue
            by.setdefault(r["day"], {})[t] = {"views": int(r["views"]), "minutes": _f(r["estimatedMinutesWatched"]), "avgDur": _f(r["averageViewDuration"]),
                                               "avgPct": _f(r["averageViewPercentage"]), "engaged": int(r.get("engagedViews") or 0)}
    except RuntimeError as e:
        print("! yt: creatorContentType:", e)
    out = []
    for r in rows:
        d = {"d": r["day"], "views": int(r["views"] or 0), "minutes": _f(r["estimatedMinutesWatched"]), "subsG": int(r["subscribersGained"] or 0),
             "subsL": int(r["subscribersLost"] or 0), "avgDur": _f(r["averageViewDuration"]), "avgPct": _f(r["averageViewPercentage"]),
             "engaged": int(r.get("engagedViews") or 0)}
        d.update(by.get(r["day"], {}))
        out.append(d)
    return out


def _totals(ucid, vids):
    if not vids:
        return {}
    start, end = min(v["published"] for v in vids), dt.date.today().isoformat()
    base = "views,estimatedMinutesWatched,averageViewPercentage,averageViewDuration,likes,comments,shares,subscribersGained"
    out = {}
    for k in range(0, len(vids), 50):
        chunk = vids[k:k + 50]
        p = dict(startDate=start, endDate=end, dimensions="video", sort="-views", maxResults=200, filters="video==" + ",".join(v["yt"] for v in chunk))
        try:
            rows = _rep(ucid, metrics=base + ",engagedViews", **p)
        except RuntimeError:
            rows = _rep(ucid, metrics=base, **p)
        for r in rows:
            out[r["video"]] = r
    return out


def _snap(ucid, v, n, last):
    """Цифры ролика за первые n дней (день выхода + n-1) — для сравнения «на равных». None, если Analytics ещё не досчитал."""
    pub = dt.date.fromisoformat(v["published"])
    end = pub + dt.timedelta(days=n - 1)
    if end > last:
        return None
    p = dict(startDate=pub.isoformat(), endDate=end.isoformat(), filters="video==" + v["yt"])
    m = "views,estimatedMinutesWatched,averageViewPercentage,averageViewDuration,likes,subscribersGained"
    try:
        rows = _rep(ucid, metrics=m + ",engagedViews", **p)
    except RuntimeError:
        rows = _rep(ucid, metrics=m, **p)
    r = rows[0] if rows else {}
    return {"views": int(r.get("views") or 0), "minutes": _f(r.get("estimatedMinutesWatched")), "avgPct": _f(r.get("averageViewPercentage")),
            "avgDur": _f(r.get("averageViewDuration")), "likes": int(r.get("likes") or 0), "subs": int(r.get("subscribersGained") or 0),
            "engaged": int(r.get("engagedViews") or 0), "at": end.isoformat()}


def _ytdlp():
    exe = shutil.which("yt-dlp")
    return [exe] if exe else [sys.executable, "-m", "yt_dlp"]


def _comments(ytid, n=40):
    """Комментарии через yt-dlp (без ключа и без прав на запись): топ n. -> [{id, author, text, likes, ts, reply}]"""
    tmp = tempfile.mkdtemp(prefix="ytc_")
    try:
        subprocess.run(_ytdlp() + ["--skip-download", "--write-comments", "--no-warnings", "--quiet", "--no-playlist",
                                   "--extractor-args", f"youtube:max_comments={n},all,0,0;comment_sort=top", "-o", os.path.join(tmp, "c"),
                                   "https://www.youtube.com/watch?v=" + ytid],
                       capture_output=True, timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        d = _rj(os.path.join(tmp, "c.info.json"), {}) or {}
        out = []
        for c in d.get("comments") or []:
            out.append({"id": c.get("id"), "author": c.get("author", ""), "text": (c.get("text") or "")[:1000], "likes": int(c.get("like_count") or 0),
                        "ts": int((c.get("timestamp") or 0) * 1000), "reply": c.get("parent") not in (None, "root"), "mine": bool(c.get("author_is_uploader"))})
        return out
    except Exception as e:
        print("! yt: комментарии", ytid, e)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- видео Studio и привязка
def _norm(s):
    s = re.sub(r"#\S+", " ", (s or "").lower().replace("ё", "е"))
    return " ".join(re.sub(r"[^\w\s]", " ", s).split())


def _probe(ch, mp4):
    """Длительность out/*.mp4 (ffprobe, кэш по mtime)."""
    cp = os.path.join(_adir(ch), "probe.json")
    cache = _rj(cp, {}) or {}
    k, m = os.path.basename(os.path.dirname(os.path.dirname(mp4))) + "/" + os.path.basename(mp4), os.path.getmtime(mp4)
    if (cache.get(k) or {}).get("m") == m:
        return cache[k]["dur"]
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        dur = float(r.stdout.strip() or 0)
    except Exception:
        dur = 0
    cache[k] = {"m": m, "dur": dur}
    _wj(cp, cache)
    return dur


def studio_videos(ch):
    """Видео канала Studio для привязки: [{id, name, titles[], out: {ts, dur}|None, yt, mode}]."""
    out = []
    for vid, meta in P.index()["videos"].items():
        if meta.get("channel") != ch["id"]:
            continue
        d = _rj(P.video_json(vid))
        if not d or d.get("service") or d.get("status") == "archived":
            continue
        titles = [d.get("name", "")] + [t.get("text", "") for t in d.get("titles") or [] if isinstance(t, dict)]
        titles += [t.get("text", "") for t in (d.get("pack") or {}).get("titles") or [] if isinstance(t, dict)]
        vd = P.video(vid)
        o = None
        if vd:
            pk = os.path.join(vd, "out", "packaging.md")
            if os.path.isfile(pk):
                for line in open(pk, encoding="utf-8").read().splitlines()[:60]:
                    line = re.sub(r"^[\s>*\-\d.#)]+", "", line).strip(" *_`«»\"")
                    if 6 <= len(line) <= 90:
                        titles.append(line)
            mp4s = [p for p in glob.glob(os.path.join(vd, "out", "*.mp4")) if not re.search(r"NO_VO|без_звука|demo", os.path.basename(p))]
            if mp4s:
                mp4 = max(mp4s, key=os.path.getmtime)
                o = {"ts": int(os.path.getmtime(mp4) * 1000), "dur": _probe(ch, mp4)}
        out.append({"id": vid, "name": d.get("name", "") or vid, "titles": [t for t in titles if t], "out": o, "yt": (d.get("yt") or {}).get("id"),
                    "mode": d.get("mode", "short"), "status": d.get("status", "")})
    return out


def _score(v, s):
    a = _norm(v["title"])
    aw = {w[:5] for w in a.split() if len(w) >= 3}
    best = 0
    for t in s["titles"]:
        b = _norm(t)
        if not b:
            continue
        bw = {w[:5] for w in b.split() if len(w) >= 3}
        j = len(aw & bw) / max(1, min(len(aw), len(bw))) if aw and bw else 0
        if len(b) >= 3 and re.search(r"(^|\s)" + re.escape(b) + r"(\s|$)", a):      # «PS6» целиком в «PS6 дороже, чем…»
            j = max(j, 0.9)
        best = max(best, difflib.SequenceMatcher(None, a, b).ratio(), j)
    date = dur = 0
    if s["out"]:
        lag = (v["pubts"] - s["out"]["ts"]) / 86400000
        date = 1 if -1 <= lag <= 14 else 0.4 if -3 <= lag <= 30 else 0
        dd = abs(v["dur"] - s["out"]["dur"]) if s["out"]["dur"] else 99
        dur = 1 if dd <= 2 else 0.5 if dd <= 5 else 0
    return round(0.55 * best + 0.2 * date + 0.25 * dur, 2), {"title": round(best, 2), "date": date, "dur": dur}


def _guess(ch, vids, svs):
    """Подсказки привязки: жадно по убыванию счёта, каждое видео Studio — одному ролику."""
    links = _rj(os.path.join(_adir(ch), "links.json"), {}) or {}
    linked = {s["yt"]: s for s in svs if s["yt"]}
    free = [s for s in svs if not s["yt"]]
    pairs = []
    for v in vids:
        v["studio"] = linked[v["yt"]]["id"] if v["yt"] in linked else (False if links.get(v["yt"]) is False else None)
        v["guess"] = None
        if v["studio"] is None:
            for s in free:
                sc, why = _score(v, s)
                if sc >= 0.5:
                    pairs.append((sc, v, s, why))
    used_v, used_s = set(), set()
    for sc, v, s, why in sorted(pairs, key=lambda x: -x[0]):
        if v["yt"] in used_v or s["id"] in used_s:
            continue
        used_v.add(v["yt"]); used_s.add(s["id"])
        v["guess"] = {"video": s["id"], "name": s["name"], "score": sc, "why": why}


def link(A, ytid, video, by="author"):
    """video: id видео Studio — привязать (и статус «вышло»); False — «не из Studio»; None — отвязать."""
    ch = _ch()
    lp = os.path.join(_adir(ch), "links.json")
    links = _rj(lp, {}) or {}
    for s in studio_videos(ch):                    # у ролика одно видео Studio
        if s["yt"] == ytid and s["id"] != video:
            A.apply_ops("plan:" + s["id"], [{"op": "set", "path": ["yt"], "value": None}])
    if video:
        ops = [{"op": "set", "path": ["yt"], "value": {"id": ytid, "url": "https://youtu.be/" + ytid, "linkedAt": _now(), "by": by}}]
        d = _rj(P.video_json(video)) or {}
        if d.get("status") != "out":
            ops.append({"op": "set", "path": ["status"], "value": "out"})
        A.apply_ops("plan:" + video, ops)
        links.pop(ytid, None)
    elif video is False:
        links[ytid] = False
    else:
        links.pop(ytid, None)
    _wj(lp, links)
    vp = os.path.join(_adir(ch), "videos.json")
    vids = _rj(vp, []) or []
    _guess(ch, vids, studio_videos(ch))
    _wj(vp, vids)
    return {"ok": True}


# ---------------------------------------------------------------- синк
def sync(A, job=None, cid=None):
    ch = _ch(cid)
    ucid = _ucid(ch)
    ad = _adir(ch)
    say = lambda s: setattr(job, "summary", s) if job else None
    say("YouTube: канал и ролики…")
    r = _get(ucid, DATA_API + "channels", {"part": "snippet,statistics,contentDetails", "id": ucid})
    if not r.get("items"):
        raise RuntimeError("YouTube-канал не найден")
    info = _chinfo(r["items"][0])
    vids = _uploads(ucid, info["uploads"])
    say(f"YouTube: аналитика {len(vids)} роликов…")
    last = _last_day(ucid)
    days = _days(ucid, last)
    tot = _totals(ucid, vids)
    old = {v["yt"]: v for v in _rj(os.path.join(ad, "videos.json"), []) or []}
    y = ch.get("youtube") or {}
    linked_at = y.get("linkedAt") or 0
    reviews, ncom = [], 0
    for v in vids:
        a, o = tot.get(v["yt"], {}), old.get(v["yt"], {})
        v.update(minutes=_f(a.get("estimatedMinutesWatched")), avgDur=_f(a.get("averageViewDuration")), avgPct=_f(a.get("averageViewPercentage")),
                 shares=int(a.get("shares") or 0), subs=int(a.get("subscribersGained") or 0), engaged=int(a.get("engagedViews") or 0) if a else 0)
        v["snaps"] = dict(o.get("snaps") or {})
        v["ms"] = dict(o.get("ms") or {})
        for key, n in MILESTONES:
            if key in v["snaps"]:
                continue
            try:
                s = _snap(ucid, v, n, last)
            except RuntimeError as e:
                print("! yt: веха", v["yt"], e)
                s = None
            if s:
                v["snaps"][key] = s
        age = (time.time() * 1000 - v["pubts"]) / 86400000
        for key, n in MILESTONES:                    # разбор Claude на вехе: только если веха наступила после подключения канала (старые — по кнопке)
            reached = key in v["snaps"]
            ms_ts = v["pubts"] + n * 86400000
            if reached and not v["ms"].get(key) and ms_ts > linked_at and age <= REVIEW_MAX_AGE:
                reviews.append((v["yt"], key))
            elif reached and not v["ms"].get(key) and ms_ts <= linked_at:
                v["ms"][key] = "skip"
        vp = os.path.join(ad, "v", v["yt"] + ".json")
        if v["comments"] and v["comments"] != o.get("comments_seen") and ncom < COMMENTS_PER_SYNC:
            say(f"YouTube: комментарии «{v['title'][:30]}»…")
            cs = _comments(v["yt"])
            ncom += 1
            if cs is not None:
                det = _rj(vp, {}) or {}
                det["comments"], det["commentsAt"] = cs, _now()
                _wj(vp, det)
                v["comments_seen"] = v["comments"]
        else:
            v["comments_seen"] = o.get("comments_seen")
    svs = studio_videos(ch)
    _guess(ch, vids, svs)
    _wj(os.path.join(ad, "videos.json"), vids)
    _wj(os.path.join(ad, "channel.json"), {"at": _now(), "last": last.isoformat(), "info": info, "days": days})
    for ytid, key in reviews[:3]:                    # не больше трёх разборов за раз — бережём лимит
        try:
            A.start_job("ytvideo", "yt:" + ytid, "ytvideo", {"yt": ytid, "why": key, "ch": ch["id"]})
        except Exception as e:
            print("! yt: разбор", ytid, e)
    say(f"YouTube обновлён: {len(vids)} роликов" + (f", разборов Claude: {min(3, len(reviews))}" if reviews else ""))
    return {"videos": len(vids)}


def stale(ch):
    c = _rj(os.path.join(_adir(ch), "channel.json"), {}) or {}
    return time.time() * 1000 - (c.get("at") or 0) > STALE * 1000


def _syncing(A, ch):
    return any(j.kind == "ytsync" and j.key == "yt:" + ch["id"] and j.status in ("running", "queued") for j in A.JOBS.values())


def start_sync(A, ch=None):
    ch = ch or _ch()
    _ucid(ch)
    if _syncing(A, ch):
        return next(j for j in A.JOBS.values() if j.kind == "ytsync" and j.key == "yt:" + ch["id"] and j.status in ("running", "queued"))
    return A.start_job("ytsync", "yt:" + ch["id"], "ytsync", {"ch": ch["id"]})


def tick(A):
    """Каждую минуту из auto_tick: привязанный канал с данными старше 6 ч — тихо обновить (вехи разборов не ждут открытия раздела)."""
    try:
        ch = P.channel()
        if ch and (ch.get("youtube") or {}).get("id") and stale(ch) and not _syncing(A, ch) and _tok_ok(ch):
            start_sync(A, ch)
    except Exception as e:
        print("! yt tick:", e)


def _tok_ok(ch):
    return os.path.isfile(_tok_path((ch.get("youtube") or {}).get("id", "")))


# ---------------------------------------------------------------- карточка ролика
def _scenes(vid, dur):
    """Сцены видео Studio по таймингам голоса (src/vo_timing.js): [{name, t0, t1, text}] в секундах ролика."""
    vd = P.video(vid) if vid else None
    if not vd:
        return []
    p = os.path.join(vd, "src", "vo_timing.js")
    try:
        t = open(p, encoding="utf-8").read()
        VO = json.loads(t[t.index("{"): t.rindex("}") + 1])
    except (OSError, ValueError):
        return []
    secs = VO.get("sections") or []
    out = []
    for i, s in enumerate(secs):
        t0 = float(s.get("start") or 0)
        t1 = float(secs[i + 1]["start"]) if i + 1 < len(secs) else max(t0 + float(s.get("dur") or 0), float(VO.get("total") or 0))
        name = (s.get("title") or f"Сцена {i + 1}")
        name = re.sub(r"^[\d:.\s–\-]+—\s*", "", name).strip() or name
        words = [w.get("w", "") for w in s.get("words") or []]
        out.append({"name": name[:60], "t0": round(t0, 2), "t1": round(t1, 2), "text": " ".join(words)[:400], "words": [[round(t0 + float(w.get("t") or 0), 2), w.get("w", "")] for w in s.get("words") or []]})
    total = float(VO.get("total") or (out[-1]["t1"] if out else 0))
    if dur and total and abs(total - dur) > 1.5:     # голос ≠ ролику (хвост, заставка) — подгоняем пропорцией
        k = dur / total
        for s in out:
            s["t0"], s["t1"] = round(s["t0"] * k, 2), round(s["t1"] * k, 2)
            s["words"] = [[round(t * k, 2), w] for t, w in s["words"]]
    return out


def _drops(ret, dur, k=3):
    """Самые резкие спады удержания: [{x, t, pct}] — x доля ролика, pct потеря в п.п."""
    if len(ret) < 6:
        return []
    w = [p["watch"] for p in ret]
    d = [w[i] - w[i + 2] for i in range(len(w) - 2)]
    cand = sorted(range(len(d)), key=lambda i: -d[i])
    out = []
    for i in cand:
        if d[i] <= 1 or len(out) >= k:
            break
        if any(abs(i - j["i"]) < 6 for j in out):
            continue
        out.append({"i": i, "x": ret[i]["x"], "t": round(ret[i]["x"] * dur, 1), "pct": round(d[i], 1)})
    return sorted(out, key=lambda x: x["x"])


def _scene_at(scenes, t):
    s = next((s for s in scenes if s["t0"] <= t < s["t1"]), None)
    if not s:
        return None, ""
    near = " ".join(w for tt, w in s["words"] if t - 1.5 <= tt <= t + 1.5)
    return s["name"], near


def detail(A, ytid, fresh=False):
    ch = _ch()
    ucid = _ucid(ch)
    ad = _adir(ch)
    vids = _rj(os.path.join(ad, "videos.json"), []) or []
    v = next((x for x in vids if x["yt"] == ytid), None)
    if not v:
        raise RuntimeError("ролика нет в кэше — обнови раздел")
    vp = os.path.join(ad, "v", ytid + ".json")
    det = _rj(vp, {}) or {}
    if fresh or time.time() * 1000 - (det.get("at") or 0) > STALE * 1000 or "retention" not in det:
        start, end = v["published"], dt.date.today().isoformat()
        f = "video==" + ytid
        try:
            det["retention"] = [{"x": _f(r["elapsedVideoTimeRatio"], 3), "watch": _f(100 * float(r["audienceWatchRatio"] or 0)), "rel": _f(r.get("relativeRetentionPerformance"), 3)}
                                for r in _rep(ucid, startDate=start, endDate=end, metrics="audienceWatchRatio,relativeRetentionPerformance", dimensions="elapsedVideoTimeRatio", filters=f)]
        except RuntimeError as e:
            det["retention"], det["retErr"] = [], str(e)[:200]
        try:
            det["traffic"] = [{"src": r["insightTrafficSourceType"], "views": int(r["views"] or 0)}
                              for r in _rep(ucid, startDate=start, endDate=end, metrics="views", dimensions="insightTrafficSourceType", filters=f, sort="-views")]
        except RuntimeError:
            det["traffic"] = []
        try:
            det["days"] = [{"d": r["day"], "views": int(r["views"] or 0)} for r in _rep(ucid, startDate=start, endDate=end, metrics="views", dimensions="day", filters=f, sort="day")][-120:]
        except RuntimeError:
            det["days"] = []
        if fresh or "comments" not in det:
            cs = _comments(ytid)
            if cs is not None:
                det["comments"], det["commentsAt"] = cs, _now()
        det["at"] = _now()
        _wj(vp, det)
    sv = v.get("studio") or (v.get("guess") or {}).get("video")
    scenes = _scenes(sv, v["dur"]) if v.get("studio") else []
    drops = _drops(det.get("retention") or [], v["dur"])
    for d in drops:
        d["scene"], d["words"] = _scene_at(scenes, d["t"])
    rel = [p["rel"] for p in det.get("retention") or [] if p.get("rel") is not None]
    return {**v, **{k: det.get(k) for k in ("retention", "traffic", "days", "commentsAt", "reviews", "retErr", "at")}, "commentList": det.get("comments") or [],
            "scenes": [{k: s[k] for k in ("name", "t0", "t1")} for s in scenes], "drops": drops, "rel": round(sum(rel) / len(rel), 2) if rel else None,
            "avg": _channel_avg(vids, v["type"])}


def _channel_avg(vids, typ):
    xs = [x for x in vids if x["type"] == typ and x.get("views")]
    if not xs:
        return {}
    n = len(xs)
    eng = [100 * x["engaged"] / x["views"] for x in xs if x.get("engaged")]
    return {"views": round(sum(x["views"] for x in xs) / n), "avgPct": round(sum(x.get("avgPct") or 0 for x in xs) / n, 1),
            "engaged": round(sum(eng) / len(eng), 1) if eng else None, "n": n}


# ---------------------------------------------------------------- сводка раздела
def state(A):
    ch = P.channel() or {}
    y = ch.get("youtube") or {}
    out = {"channel": {"id": ch.get("id"), "name": ch.get("name"), "icon": ch.get("icon")}, "youtube": y or None,
           "client": os.path.isfile(CLIENT) or os.path.isfile(os.path.join(OLD, "youtube_client.json")), "tokens": [], "error": None}
    try:
        out["tokens"] = tokens()
    except Exception as e:
        out["error"] = str(e)
    if not y.get("id") or not ch:
        return out
    out["login"] = y["id"] in out["tokens"]
    ad = _adir(ch)
    c = _rj(os.path.join(ad, "channel.json"), {}) or {}
    vids = _rj(os.path.join(ad, "videos.json"), []) or []
    out.update(at=c.get("at"), last=c.get("last"), info=c.get("info"), days=c.get("days") or [])
    for v in vids:
        v.pop("comments_seen", None)
    out["videos"] = vids
    com = []
    for v in vids:
        for cm in (_rj(os.path.join(ad, "v", v["yt"] + ".json"), {}) or {}).get("comments") or []:
            if not cm.get("reply") and not cm.get("mine"):
                com.append({**cm, "yt": v["yt"], "title": v["title"]})
    out["comments"] = sorted(com, key=lambda x: -(x.get("ts") or 0))[:30]
    out["ideas"] = [i for i in _rj(os.path.join(ad, "ideas.json"), []) or [] if not i.get("used")]
    try:
        import memory_api
        R = memory_api.rules(ch.get("id"))
        out["lessons"] = [r for r in R["channel"] + R["all"] if (r.get("from") or {}).get("kind") == "yt" and r.get("status") in ("new", "on")]
    except Exception:
        out["lessons"] = []
    out["studio"] = [{"id": s["id"], "name": s["name"], "yt": s["yt"]} for s in studio_videos(ch)]
    out["syncing"] = _syncing(A, ch)
    if out["login"] and (not c or stale(ch)) and not out["syncing"]:
        try:
            start_sync(A, ch)
            out["syncing"] = True
        except Exception as e:
            out["error"] = str(e)
    return out


# ---------------------------------------------------------------- Claude: разбор ролика и «что работает»
TRAFFIC_RU = {"SHORTS": "лента Shorts", "SUBSCRIBER": "главная и подписки", "YT_SEARCH": "поиск YouTube", "YT_CHANNEL": "страница канала",
              "EXT_URL": "внешние сайты", "RELATED_VIDEO": "предложенные", "YT_OTHER_PAGE": "другие страницы YouTube", "BROWSE": "главная и подписки",
              "NO_LINK_OTHER": "прямые и неизвестные", "PLAYLIST": "плейлисты", "NOTIFICATION": "уведомления", "END_SCREEN": "конечные заставки",
              "HASHTAGS": "хэштеги", "SOUND_PAGE": "страница звука", "YT_PLAYLIST_PAGE": "плейлисты", "CAMPAIGN_CARD": "кампании"}


def _mmss(t):
    t = int(round(t or 0))
    return f"{t // 60}:{t % 60:02d}"


def _row(v):
    e = f"{round(100 * v['engaged'] / v['views'])}%" if v.get("engaged") and v.get("views") and v["type"] == "short" else "—"
    s3 = (v.get("snaps") or {}).get("d3") or {}
    age = (time.time() * 1000 - v["pubts"]) / 86400000
    pct = v.get("avgPct") if v.get("avgPct") else "нет данных"
    fresh = f" · (вышел {age:.0f} дн. назад — Analytics ещё не досчитал, цифры неполные, выводов не делай)" if age < 4 else ""
    return (f"{v['published']} · {v['type']} · {_mmss(v['dur'])} · «{v['title'][:80]}» · просм {v['views']} · ср.% {pct} · смотрели {e} · "
            f"лайки {v['likes']} · комм {v['comments']} · подп +{v.get('subs', 0)}" + (f" · за 3 дня: {s3.get('views')} просм, {s3.get('avgPct')}%" if s3 else "") + fresh)


def _sysp(A, ch):
    try:
        from ideas_claude import system
        return system(A._docs("channel:" + ch["id"]), "short")
    except Exception:
        return "Ты — соавтор YouTube-канала в Claude Studio."


def _script_hook(vid):
    vd = P.video(vid) if vid else None
    if not vd:
        return ""
    try:
        t = open(os.path.join(vd, "script.md"), encoding="utf-8").read()
    except OSError:
        return ""
    m = re.search(r"^>\s*(.+)$", t, re.M)
    return (m.group(1).strip() if m else "")[:200]


def _add_rule(ch, text, why, yts):
    import memory_api
    return memory_api.add(text, why, "channel", "new", "claude", None, ch["id"], frm={"kind": "yt", "videos": yts})


def review(A, job):
    from ideas_claude import S, STR, ARR
    NUM = {"type": "number"}
    ch = _ch(job.params.get("ch"))
    ytid, why = job.params["yt"], job.params.get("why", "manual")
    job.summary = "Claude смотрит статистику ролика…"
    d = detail(A, ytid)
    ad = _adir(ch)
    vids = _rj(os.path.join(ad, "videos.json"), []) or []
    scenes = _scenes(d.get("studio"), d["dur"]) if d.get("studio") else []
    ret = d.get("retention") or []
    pts = " ".join(f"{_mmss(p['x'] * d['dur'])}={round(p['watch'])}%" for p in ret[::5])
    drops = "\n".join(f"- {_mmss(x['t'])}: −{x['pct']} п.п." + (f" · сцена «{x['scene']}» · слова: «{x['words']}»" if x.get("scene") else "") for x in d["drops"]) or "—"
    sc = "\n".join(f"- {_mmss(s['t0'])}–{_mmss(s['t1'])} «{s['name']}»: {s['text'][:220]}" for s in scenes) or "(ролик не привязан к видео Studio — сценария нет)"
    tv = sum(t["views"] for t in d.get("traffic") or []) or 1
    tr = ", ".join(f"{TRAFFIC_RU.get(t['src'], t['src'])} {round(100 * t['views'] / tv)}%" for t in (d.get("traffic") or [])[:6]) or "—"
    cm = "\n".join(f"- ♥{c['likes']} {c['text'][:200]}" for c in d["commentList"][:40] if not c.get("mine")) or "—"
    others = "\n".join("- " + _row(x) for x in vids if x["yt"] != ytid and x["type"] == d["type"])[:5000] or "—"
    import memory_api
    R = memory_api.rules(ch["id"])
    have = "\n".join("- " + x["text"] for x in R["channel"] + R["all"] if x.get("status") in ("on", "new")) or "—"
    ask = (job.params.get("ask") or "").strip()
    prompt = f"""Шаг «YouTube → разбор ролика» ({'веха ' + why[1:] + ' дней' if why.startswith('d') else 'по просьбе автора'}).
Разбери, как зашёл ролик, по цифрам ниже. Пиши по-русски, коротко и конкретно, с цифрами. Не выдумывай данных, которых нет.

## Ролик
{_row(d)}
Среднее по каналу (такой же тип): {json.dumps(d.get('avg') or {}, ensure_ascii=False)}
Удержание (время=доля зрителей, >100% — пересмотры): {pts or '—'}
Относительно роликов такой же длины на YouTube: {d.get('rel')} (0..1, 0.5 — типично)
Самые резкие спады:
{drops}
Источники: {tr}

## Сценарий по сценам (голос)
{sc}

## Комментарии
{cm}

## Другие ролики канала
{others}

## Уже есть правила канала (не повторяй)
{have}
{('## Вопрос автора' + chr(10) + ask) if ask else ''}

Верни:
- review — 3–6 пунктов (markdown-список «- …»): что сработало, где и почему ушли (по сцене и словам), сравнение со средним канала, что попробовать в следующем;
- drops — объяснение каждого спада: t (секунды, как в списке), why (одна фраза: что в этот момент в кадре/тексте и почему уходят);
- rules — 0–2 правила для «Памяти» канала, только если цифры их явно подтверждают (text — указание сценаристу, why — цифры-доказательство);
- ideas — 0–3 идеи новых видео из вопросов и просьб зрителей в комментариях (title — тема ролика, why — почему зайдёт, comment — исходный коммент дословно), только если в комментариях есть реальные просьбы."""
    res = A.run_claude(job, {"system": _sysp(A, ch), "prompt": prompt, "timeout": 300, "model": A.TEXT_MODEL,
                             "schema": S({"review": STR, "drops": ARR(S({"t": NUM, "why": STR}, ["t", "why"])),
                                          "rules": ARR(S({"text": STR, "why": STR}, ["text", "why"])),
                                          "ideas": ARR(S({"title": STR, "why": STR, "comment": STR}, ["title", "why"]))}, ["review", "drops", "rules", "ideas"])}) or {}
    rids = []
    for r in res.get("rules") or []:
        x = _add_rule(ch, r.get("text"), r.get("why", ""), [ytid])
        if x.get("rule"):
            rids.append(x["rule"]["id"])
    ip = os.path.join(ad, "ideas.json")
    ideas = _rj(ip, []) or []
    n_ideas = 0
    for i in res.get("ideas") or []:
        if i.get("title") and not any(_norm(i["title"]) == _norm(o.get("title")) for o in ideas):
            ideas.append({"id": "i" + secrets.token_hex(4), "title": i["title"], "why": i.get("why", ""), "comment": i.get("comment", ""), "yt": ytid, "at": _now()})
            n_ideas += 1
    _wj(ip, ideas)
    vp = os.path.join(ad, "v", ytid + ".json")
    det = _rj(vp, {}) or {}
    det.setdefault("reviews", {})[why] = {"at": _now(), "text": res.get("review", ""), "drops": res.get("drops") or [], "rules": rids, "ideas": n_ideas, "ask": ask}
    _wj(vp, det)
    if why.startswith("d"):
        vp2 = os.path.join(ad, "videos.json")
        vs = _rj(vp2, []) or []
        for x in vs:
            if x["yt"] == ytid:
                x.setdefault("ms", {})[why] = _now()
        _wj(vp2, vs)
    job.result = {"yt": ytid}
    job.summary = f"Разбор готов: «{d['title'][:40]}»" + (f" · уроков в Память: {len(rids)}" if rids else "") + (f" · идей: {n_ideas}" if n_ideas else "")


def learn(A, job):
    from ideas_claude import S, STR, ARR
    ch = _ch(job.params.get("ch"))
    ad = _adir(ch)
    vids = _rj(os.path.join(ad, "videos.json"), []) or []
    if len(vids) < 2:
        job.summary = "Роликов пока мало — учиться не на чем"
        return
    job.summary = f"Claude сравнивает {len(vids)} роликов…"
    rows = []
    for v in vids[:60]:
        r = "- " + _row(v)
        if v.get("studio"):
            hook = _script_hook(v["studio"])
            d = _rj(P.video_json(v["studio"])) or {}
            r += f" · видео Studio «{d.get('name', '')}»" + (f" · хук: «{hook}»" if hook else "")
        det = _rj(os.path.join(ad, "v", v["yt"] + ".json"), {}) or {}
        ret = det.get("retention") or []
        if ret:
            r += " · удержание: " + " ".join(f"{_mmss(p['x'] * v['dur'])}={round(p['watch'])}%" for p in ret[::20])
        rows.append(r)
    import memory_api
    R = memory_api.rules(ch["id"])
    have = "\n".join("- " + x["text"] for x in R["channel"] + R["all"] if x.get("status") in ("on", "new", "off")) or "—"
    prompt = f"""Шаг «YouTube → что работает». Ниже — все публичные ролики канала с цифрами (шорты и длинные отдельно сравнивай только между собой).
Найди закономерности: какие темы, хуки, длина, подача держат лучше и приводят больше просмотров / подписок, а что проваливается.
Сформулируй 3–5 уроков — правил для сценариста и всех кнопок ✨ канала.
- text — одна фраза-указание («Хук — бытовое сравнение цены, а не вопрос»), без воды;
- why — цифры-доказательство из таблицы с названиями роликов (коротко);
- videos — id роликов (yt), на которых основан урок.
Не повторяй правила, которые уже есть (даже другими словами). Если роликов мало или различия в пределах шума — так и скажи в why и дай меньше уроков. Лучше 3 сильных, чем 5 слабых.

## Ролики
{chr(10).join(rows)[:20000]}

## Уже есть правила
{have}"""
    res = A.run_claude(job, {"system": _sysp(A, ch), "prompt": prompt, "timeout": 300, "model": A.TEXT_MODEL,
                             "schema": S({"rules": ARR(S({"text": STR, "why": STR, "videos": ARR(STR)}, ["text", "why"]))}, ["rules"])}) or {}
    n = 0
    for r in res.get("rules") or []:
        x = _add_rule(ch, r.get("text"), r.get("why", ""), [y for y in r.get("videos") or [] if isinstance(y, str)][:8])
        n += 0 if x.get("dup") else 1
    job.summary = f"Claude предложил уроков: {n} — они в «Что работает» и в «Памяти»" if n else "Новых уроков не нашлось — всё уже в «Памяти»"


def run_job(A, job):
    if job.kind == "ytsync":
        sync(A, job, job.params.get("ch"))
    elif job.kind == "ytlogin":
        login(A, job)
    elif job.kind == "ytvideo":
        review(A, job)
    elif job.kind == "ytlearn":
        learn(A, job)
    else:
        raise RuntimeError("нет такой задачи: " + job.kind)


def new_from_idea(A, iid):
    ch = _ch()
    ip = os.path.join(_adir(ch), "ideas.json")
    ideas = _rj(ip, []) or []
    i = next((x for x in ideas if x["id"] == iid), None)
    if not i:
        raise RuntimeError("идеи нет")
    topic = (i.get("why") or "") + (f"\n\nИз комментария зрителя: «{i['comment']}» (https://youtu.be/{i['yt']})" if i.get("comment") else "")
    doc = A.new_plan("short", i["title"][:80], topic.strip(), channel=ch["id"])
    try:
        A.apply_ops("plan:" + doc["id"], [{"op": "set", "path": ["idea"], "value": i["title"]}])
    except Exception:
        pass
    i["used"] = doc["id"]
    _wj(ip, ideas)
    return {"id": doc["id"]}


def del_idea(iid):
    ch = _ch()
    ip = os.path.join(_adir(ch), "ideas.json")
    _wj(ip, [x for x in _rj(ip, []) or [] if x["id"] != iid])
    return {"ok": True}


# ---------------------------------------------------------------- HTTP / CLI
def handle_get(A, h, p, q):
    try:
        return _handle_get(A, h, p, q)
    except Exception as e:
        h._json({"error": str(e) or type(e).__name__, "login": isinstance(e, NeedLogin)}, 400); return True


def _handle_get(A, h, p, q):
    if p == "/api/yt":
        h._json(state(A)); return True
    if p == "/api/yt/video":
        h._json(detail(A, q.get("id", [""])[0], q.get("fresh", [""])[0] == "1")); return True
    if p == "/api/yt/channels":
        h._json(channels_list()); return True
    return False


def handle_post(A, h, p, body):
    ch = P.channel() or {}
    if p == "/api/yt/login":
        _client()
        j = A.start_job("ytlogin", "yt:login", "ytlogin", {})
        h._json({"job": j.info()}); return True
    if p == "/api/yt/client":
        h._json(set_client(body.get("json") or "")); return True
    if p == "/api/yt/select":
        y = select(A, body.get("ucid", ""))
        try:
            start_sync(A)
        except Exception:
            pass
        h._json({"ok": True, "youtube": y}); return True
    if p == "/api/yt/unlink":
        h._json(unlink(A)); return True
    if p == "/api/yt/logout":
        h._json(logout(body.get("ucid") or (ch.get("youtube") or {}).get("id", ""))); return True
    if p == "/api/yt/sync":
        j = start_sync(A)
        h._json({"job": j.info()}); return True
    if p == "/api/yt/link":
        v = body.get("video")
        h._json(link(A, body.get("yt", ""), v if v else (False if v is False else None))); return True
    if p == "/api/yt/learn":
        j = A.start_job("ytlearn", "channel:" + ch.get("id", "ch"), "ytlearn", {"ch": ch.get("id")})
        h._json({"job": j.info()}); return True
    if p == "/api/yt/review":
        y = body.get("yt", "")
        j = A.start_job("ytvideo", "yt:" + y, "ytvideo", {"yt": y, "why": "manual", "ask": body.get("ask", ""), "ch": ch.get("id")})
        h._json({"job": j.info()}); return True
    if p == "/api/yt/lesson":
        import memory_api
        h._json(memory_api.add(body.get("text", ""), body.get("why", ""), "channel", "on", "author", None, ch.get("id"), frm={"kind": "yt", "videos": []})); return True
    if p == "/api/yt/idea":
        h._json(new_from_idea(A, body.get("id", ""))); return True
    if p == "/api/yt/idea/del":
        h._json(del_idea(body.get("id", ""))); return True
    return False


def cli(A, argv):
    """yt status | login | channels | select UC… | unlink | sync | show [ytid] | link ytid видео | unlink-video ytid | not-studio ytid | learn | review ytid ["вопрос"]"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    if cmd == "status":
        ch = P.channel() or {}
        print(f"канал Studio: {ch.get('name')} · YouTube: {(ch.get('youtube') or {}).get('title') or 'не привязан'} · входы: {', '.join(tokens()) or 'нет'}")
        c = _rj(os.path.join(_adir(ch), "channel.json"), {}) if ch else {}
        if c:
            print(f"данные: {time.strftime('%d.%m %H:%M', time.localtime(c['at'] / 1000))}, Analytics по {c.get('last')}")
        return True
    if cmd == "login":
        for c in login(A):
            print("вошли:", c["id"], c["title"], c["handle"])
        return True
    if cmd == "channels":
        for c in channels_list():
            print(c["id"], c.get("title"), c.get("handle", ""), c.get("subs", ""), c.get("error", ""))
        return True
    if cmd == "select" and a:
        print(select(A, a[0])); return True
    if cmd == "unlink":
        print(unlink(A)); return True
    if cmd == "sync":
        j = A.Job("ytsync", "yt:cli", "ytsync", {})
        print(sync(A, j), j.summary); return True
    if cmd == "show":
        ch = _ch()
        vids = _rj(os.path.join(_adir(ch), "videos.json"), []) or []
        if a:
            d = detail(A, a[0])
            print(_row(d))
            print("удержание:", " ".join(f"{_mmss(p['x'] * d['dur'])}={round(p['watch'])}%" for p in (d.get("retention") or [])[::10]))
            for x in d["drops"]:
                print(f"спад {_mmss(x['t'])} −{x['pct']} п.п." + (f" · «{x['scene']}» · {x['words']}" if x.get("scene") else ""))
            tv = sum(t["views"] for t in d.get("traffic") or []) or 1
            print("источники:", ", ".join(f"{TRAFFIC_RU.get(t['src'], t['src'])} {round(100 * t['views'] / tv)}%" for t in d.get("traffic") or []))
            for k, r in (d.get("reviews") or {}).items():
                print(f"== разбор {k}:\n{r.get('text')}")
            return True
        for v in vids:
            st = f" → {v['studio']}" if v.get("studio") else (f" ? {v['guess']['name']} ({v['guess']['score']})" if v.get("guess") else "")
            print(f"{v['yt']} " + _row(v) + st)
        return True
    if cmd == "link" and len(a) >= 2:
        print(link(A, a[0], a[1])); return True
    if cmd == "unlink-video" and a:
        print(link(A, a[0], None)); return True
    if cmd == "not-studio" and a:
        print(link(A, a[0], False)); return True
    if cmd == "learn":
        ch = _ch()
        j = A.Job("ytlearn", "channel:" + ch["id"], "ytlearn", {"ch": ch["id"]})
        learn(A, j)
        print(j.summary); return True
    if cmd == "review" and a:
        ch = _ch()
        j = A.Job("ytvideo", "yt:" + a[0], "ytvideo", {"yt": a[0], "why": "manual", "ask": a[1] if len(a) > 1 else "", "ch": ch["id"]})
        review(A, j)
        print(j.summary)
        print(((_rj(os.path.join(_adir(ch), "v", a[0] + ".json"), {}) or {}).get("reviews") or {}).get("manual", {}).get("text", "")); return True
    print(cli.__doc__); return True
