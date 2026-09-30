"""YouTube → трекер просмотров «Штурма идей»: вход в Google (OAuth, только чтение) и сбор статистики роликов канала.

Файлы в DATA (_ideas, вне git):
    youtube_client.json  — OAuth-клиент типа «Desktop app» из Google Cloud (кладёт пользователь)
    youtube_token.json   — refresh-токен после входа (создаётся здесь)
login()  — открывает браузер со входом Google, ловит ответ на 127.0.0.1:<свободный порт> (PKCE)
sync()   — все ролики канала -> stats.json: всего просмотров, накопленные за сутки/7/14/28 дней (по дням из Analytics,
           «сутки» ≈ день выхода + следующий), средний % и время просмотра, лайки, комментарии, репосты, подписки,
           у шортсов ещё доля «не пролистали» (engagedViews / views), если API её отдаёт. 1 час API не даёт — руками.
Данные Analytics приходят с задержкой 2–3 дня. Никаких сторонних библиотек: только urllib.
"""
import base64, datetime as dt, hashlib, http.server, json, os, re, secrets, threading, time, urllib.error, urllib.parse, urllib.request, webbrowser

SCOPES = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly"
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
DATA_API = "https://www.googleapis.com/youtube/v3/"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
SHORT_MAX = 180            # роликы до 3 минут считаем шортсами
LAG = 2                    # дней задержки данных Analytics


def paths(data):
    return os.path.join(data, "youtube_client.json"), os.path.join(data, "youtube_token.json")


def client(data):
    p = paths(data)[0]
    if not os.path.isfile(p):
        raise RuntimeError("нет _ideas/youtube_client.json — скачай JSON клиента «Desktop app» из Google Cloud")
    c = json.load(open(p, encoding="utf-8"))
    c = c.get("installed") or c.get("web") or c
    if not c.get("client_id") or not c.get("client_secret"):
        raise RuntimeError("youtube_client.json не похож на OAuth-клиент (нет client_id / client_secret)")
    return c


def status(data):
    cp, tp = paths(data)
    return {"client": os.path.isfile(cp), "token": os.path.isfile(tp)}


def _post(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Google: {e.code} {e.read().decode('utf-8', 'replace')[:300]}")


# ---------------- login ----------------
def login(data, timeout=300):
    c = client(data)
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
            body = ("<h2>Готово ✅</h2><p>Доступ к статистике выдан. Окно можно закрыть и вернуться в «Штурм идей».</p>" if ok
                    else f"<h2>Не вышло</h2><p>{got.get('error', '')}</p>").encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write(b"<meta charset=utf-8><body style='font:18px sans-serif;padding:40px'>" + body)

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = AUTH + "?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    webbrowser.open(url)
    srv.timeout = 2
    t0 = time.time()
    while not got and time.time() - t0 < timeout:
        srv.handle_request()
    srv.server_close()
    if "code" not in got:
        raise RuntimeError("вход не завершён: " + (got.get("error") or "время вышло"))
    tok = _post(TOKEN, {"code": got["code"], "client_id": c["client_id"], "client_secret": c["client_secret"],
                        "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier})
    if not tok.get("refresh_token"):
        raise RuntimeError("Google не выдал refresh_token — попробуй войти ещё раз")
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    json.dump(tok, open(paths(data)[1], "w", encoding="utf-8"), indent=1)
    ch = channel(data)
    return {"channel": ch["title"]}


def access(data):
    tp = paths(data)[1]
    if not os.path.isfile(tp):
        raise RuntimeError("сначала войди в Google (кнопка «🔑 Войти в Google» в «Просмотрах»)")
    tok = json.load(open(tp, encoding="utf-8"))
    if tok.get("expires_at", 0) > time.time():
        return tok["access_token"]
    c = client(data)
    try:
        new = _post(TOKEN, {"refresh_token": tok["refresh_token"], "client_id": c["client_id"],
                            "client_secret": c["client_secret"], "grant_type": "refresh_token"})
    except RuntimeError as e:
        if "invalid_grant" in str(e):
            os.remove(tp)
            raise RuntimeError("доступ Google истёк или отозван — войди заново (если приложение в режиме Testing, переведи его в In production)")
        raise
    tok.update(access_token=new["access_token"], expires_at=time.time() + new.get("expires_in", 3600) - 60)
    json.dump(tok, open(tp, "w", encoding="utf-8"), indent=1)
    return tok["access_token"]


def get(data, url, params):
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={"Authorization": "Bearer " + access(data)})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=40).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"YouTube API {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")


# ---------------- data ----------------
def channel(data):
    r = get(data, DATA_API + "channels", {"part": "snippet,contentDetails", "mine": "true"})
    if not r.get("items"):
        raise RuntimeError("у этого аккаунта нет канала — при входе выбери аккаунт канала")
    it = r["items"][0]
    return {"id": it["id"], "title": it["snippet"]["title"], "uploads": it["contentDetails"]["relatedPlaylists"]["uploads"]}


def iso_seconds(d):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", d or "")
    if not m:
        return 0
    days, hh, mm, ss = (int(x or 0) for x in m.groups())
    return days * 86400 + hh * 3600 + mm * 60 + ss


def videos(data, ch, pages=None):
    ids, tok = [], None
    while True:
        if pages is not None:
            if pages <= 0:
                break
            pages -= 1
        p = {"part": "contentDetails", "playlistId": ch["uploads"], "maxResults": 50}
        if tok:
            p["pageToken"] = tok
        r = get(data, DATA_API + "playlistItems", p)
        ids += [i["contentDetails"]["videoId"] for i in r.get("items", [])]
        tok = r.get("nextPageToken")
        if not tok:
            break
    out = []
    for k in range(0, len(ids), 50):
        r = get(data, DATA_API + "videos", {"part": "snippet,contentDetails,statistics,status", "id": ",".join(ids[k:k + 50])})
        for v in r.get("items", []):
            if v.get("status", {}).get("privacyStatus") != "public":
                continue
            s = v.get("statistics", {})
            sec = iso_seconds(v["contentDetails"].get("duration"))
            out.append({"id": v["id"], "title": v["snippet"]["title"], "date": v["snippet"]["publishedAt"][:10],
                        "pubts": int(dt.datetime.fromisoformat(v["snippet"]["publishedAt"].replace("Z", "+00:00")).timestamp() * 1000),
                        "sec": sec, "mode": "short" if sec <= SHORT_MAX else "long",
                        "views": int(s.get("viewCount", 0)), "likes": int(s.get("likeCount", 0)), "comments": int(s.get("commentCount", 0))})
    return out


def totals(data, vids):
    """Analytics per video over its whole life; engagedViews is tried and dropped if the API refuses it."""
    if not vids:
        return {}
    start = min(v["date"] for v in vids)
    end = dt.date.today().isoformat()
    base = "views,averageViewPercentage,averageViewDuration,likes,comments,shares,subscribersGained"
    out = {}
    for k in range(0, len(vids), 50):
        chunk = vids[k:k + 50]
        p = {"ids": "channel==MINE", "startDate": start, "endDate": end, "dimensions": "video", "sort": "-views",
             "maxResults": 200, "filters": "video==" + ",".join(v["id"] for v in chunk)}
        try:
            r = get(data, ANALYTICS, dict(p, metrics=base + ",engagedViews"))
        except RuntimeError:
            r = get(data, ANALYTICS, dict(p, metrics=base))
        cols = [c["name"] for c in r.get("columnHeaders", [])]
        for row in r.get("rows", []):
            out[row[0]] = dict(zip(cols, row))
    return out


def last_day(data):
    """The latest day Analytics has already processed for this channel (data lags 2–3 days)."""
    end = dt.date.today()
    r = get(data, ANALYTICS, {"ids": "channel==MINE", "startDate": (end - dt.timedelta(days=10)).isoformat(),
                              "endDate": end.isoformat(), "metrics": "views", "dimensions": "day", "sort": "day"})
    days = [row[0] for row in r.get("rows", []) if row[1]]
    return dt.date.fromisoformat(days[-1]) if days else end - dt.timedelta(days=LAG + 1)


def daily(data, v, last):
    """Cumulative views after 1 (≈ the first two calendar days), 7, 14 and 28 days — only for periods already processed."""
    pub = dt.date.fromisoformat(v["date"])
    if last < pub:
        return {}
    end = min(pub + dt.timedelta(days=27), last)
    r = get(data, ANALYTICS, {"ids": "channel==MINE", "startDate": pub.isoformat(), "endDate": end.isoformat(),
                              "metrics": "views", "dimensions": "day", "filters": "video==" + v["id"], "sort": "day"})
    per = {row[0]: row[1] for row in r.get("rows", [])}
    out = {}
    for key, n in (("d1", 2), ("d7", 7), ("d14", 14), ("d28", 28)):
        if pub + dt.timedelta(days=n - 1) <= last:
            out[key] = sum(views for day, views in per.items() if dt.date.fromisoformat(day) < pub + dt.timedelta(days=n))
    return out


def norm(s):
    return " ".join(re.sub(r"[^\w\s]", " ", (s or "").lower().replace("ё", "е")).split())


def find_row(items, v):
    return next((r for r in items if r.get("ytid") == v["id"]), None) \
        or next((r for r in items if v["id"] in (r.get("url") or "")), None) \
        or next((r for r in items if not r.get("ytid") and norm(r.get("name")) == norm(v["title"])), None)


def at(snaps, t, tol):
    """Views at moment t (ms) by linear interpolation between live snapshots; None if no snapshot within tol ms."""
    before = [s for s in snaps if s[0] <= t]
    after = [s for s in snaps if s[0] >= t]
    if before and after:
        a, b = before[-1], after[0]
        if t - a[0] <= tol and b[0] - t <= tol:
            return a[1] if b[0] == a[0] else round(a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]))
    return None


def fresh(data, stats):
    """Every 10 min: the public view counter of videos younger than 30 h -> snapshots -> real «1 час» and «сутки».
    Returns ops (or [] if nothing is young)."""
    now = int(time.time() * 1000)
    ch = channel(data)
    vids = [v for v in videos(data, ch, pages=1) if now - v["pubts"] < 30 * 3600 * 1000]
    items, ops = stats.get("items", []), []
    for v in vids:
        row = find_row(items, v)
        if not row:
            ops.append({"op": "add", "path": ["items"], "item": {"id": "r" + secrets.token_hex(4), "name": v["title"], "mode": v["mode"],
                        "date": v["date"], "awesome": "", "ytid": v["id"], "url": f"https://youtu.be/{v['id']}", "pubts": v["pubts"],
                        "views": v["views"], "snaps": [[now, v["views"]]]}})
            continue
        snaps = (row.get("snaps") or []) + [[now, v["views"]]]
        f = {"snaps": snaps, "pubts": v["pubts"], "views": v["views"], "ytid": v["id"]}
        for key, hours, tol in (("h1", 1, 25 * 60 * 1000), ("d1", 24, 90 * 60 * 1000)):
            if row.get(key + "src") != "live":
                val = at([[v["pubts"], 0]] + snaps, v["pubts"] + hours * 3600 * 1000, tol)
                if val is not None:
                    f[key], f[key + "src"] = val, "live"
        ops += [{"op": "set", "path": ["items", row["id"], k], "value": val} for k, val in f.items()]
    return ops


def sync(data, stats):
    """Returns (ops for the stats doc, summary). Rows are matched by video id, then url, then title; new videos add rows."""
    ch = channel(data)
    vids = videos(data, ch)
    tot = totals(data, vids)
    last = last_day(data)
    items = stats.get("items", [])
    ops, added, updated = [], 0, 0
    now = int(time.time() * 1000)
    for v in vids:
        row = find_row(items, v)
        a = tot.get(v["id"], {})
        f = {"ytid": v["id"], "url": f"https://youtu.be/{v['id']}", "views": v["views"], "likes": v["likes"],
             "comments": v["comments"], "pubts": v["pubts"], "pulled": now}
        if a:
            f.update(avg=round(float(a.get("averageViewPercentage") or 0), 1), dur=int(a.get("averageViewDuration") or 0),
                     shares=int(a.get("shares") or 0), subs=int(a.get("subscribersGained") or 0))
            if v["mode"] == "short" and a.get("engagedViews") is not None and a.get("views"):
                f["viewed"] = round(100 * float(a["engagedViews"]) / float(a["views"]), 1)
        try:
            d = daily(data, v, last)
            if row and row.get("d1src") == "live":      # the live 24 h snapshot is more exact than two calendar days
                d.pop("d1", None)
            f.update(d)
        except RuntimeError as e:
            print("! дневная статистика", v["id"], e)
        if row:
            if not row.get("date"):
                f["date"] = v["date"]
            ops += [{"op": "set", "path": ["items", row["id"], k], "value": val} for k, val in f.items()]
            updated += 1
        else:
            ops.append({"op": "add", "path": ["items"], "item": dict(f, id="r" + secrets.token_hex(4), name=v["title"],
                                                                     mode=v["mode"], date=v["date"], awesome="")})
            added += 1
    summary = f"канал «{ch['title']}»: {len(vids)} роликов, обновлено {updated}, новых {added}"
    ops.append({"op": "set", "path": ["yt"], "value": {"channel": ch["title"], "last": now, "summary": summary}})
    return ops, summary
