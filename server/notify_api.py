"""S20.5 — лента уведомлений 🔔 (docs/studio/stage20-agent-everywhere.md): что Claude и Studio сделали тут и там.

Хранилище канала — .studio/notify/<канал>.jsonl (append-only), прочитанное — <канал>.read.json {upto, ids}.
Запись: {id, ts, kind: job|ask|render|thumb|yt|error, icon, title, text, video, videoName, el, route, job}.
Источники: завершение задачи Claude (ideas_api._run_job -> on_job), вопрос / план агента (agent.py), рендер ролика (render_api),
картинка на доске «Обложки» (thumbs_api), разбор YouTube (ytvideo — через on_job).

    GET  /api/notify?since=<ts>&ch=<канал>  -> {items (новые сверху, ≤200), unread}
    POST /api/notify/read {ids: [...]} | {all: true} [ch]
    POST /api/notify/clear {ids: [...]} | {video: <id>} | {} (всё) [ch]  -> {unread}  убрать из ленты насовсем
"""
import json, os, threading, time, uuid

import paths as P

DIR = os.path.join(P.STATE, "notify")
KEEP, MAX_DAYS = 600, 60
_lock = threading.Lock()

# задача -> (вкладка окна видео, иконка, что готово)
JOBS = {
    "questions": ("brief", "💬", "Вопросы Claude готовы"), "refparse": ("brief", "🎞", "Референс разобран"),
    "elements": ("pre", "✨", "Препродакшен накидан"), "element": ("pre", "🎨", "Черновик готов"), "make3d": ("pre", "🧊", "3D готово"),
    "charparts": ("pre", "🧩", "Персонаж готов"), "charmodel": ("pre", "🧊", "3D-модель готова"), "trellisfix": ("pre", "🧊", "3D-модель поправлена"),
    "split3d": ("pre", "✂", "Модель разделена"), "vary3d": ("pre", "🎲", "Вариации готовы"), "sound": ("pre", "🔊", "Звуки подобраны"),
    "sndfetch": ("pre", "🔊", "Звук скачан"), "assets": ("pre", "📦", "Ассеты подобраны"), "assetfetch": ("pre", "📦", "Ассет скачан"),
    "layout3d": ("pre", "✋", "Расстановка сохранена"), "brollfetch": ("pre", "🎞", "B-roll скачан"), "sceneconvert": ("pre", "🎬", "Сцена в редакторе"),
    "voicesplit": ("voice", "🎙", "Запись нарезана"), "voicetts": ("voice", "🎙", "Голос готов"),
    "packtext": ("pack", "📝", "Тексты упаковки готовы"), "render": ("pack", "🖼", "Обложка нарисована"), "thumbprompt": ("thumbs", "🖼", "Промпт обложки готов"),
    "montagebuild": ("", "🎞", "Ролик собран"), "fastmontage": ("", "⚡", "Быстрый монтаж готов"), "automontage": ("", "🎞", "Монтаж готов"),
    "produce": ("", "🚀", "Проект ролика создан"), "beatmap": ("brief", "📐", "Карта подачи готова"), "reftopics": ("", "💡", "Похожие темы готовы"),
    "ytvideo": ("yt", "📈", "Разбор ролика на YouTube"), "ytlearn": ("yt", "📈", "«Что работает» — уроки готовы"),
    "libfix": ("lib", "📚", "Предмет библиотеки поправлен"), "changuide": ("style", "📖", "Вариант раздела гайда готов"),
    "memlearn": ("memory", "🧠", "Предложены правила"), "chanstyle": ("style", "🎨", "Стиль канала собран"), "lookbuild": ("style", "🎨", "Визуал собран"),
}
QUIET = {"ytsync", "ytfresh", "ytlogin", "clips", "lookprev", "chanq", "lookq", "qopts", "comfysetup", "assetupload", "mediaadd", "refbase", "charrig", "charemotions"}


def _f(cid, ext="jsonl"):
    return os.path.join(DIR, f"{cid or 'default'}.{ext}")


_names = {}


def video_name(vid):
    if vid in _names:
        return _names[vid]
    n = ""
    try:
        n = json.load(open(P.video_json(vid), encoding="utf-8")).get("name") or ""
    except Exception:
        pass
    _names[vid] = n
    return n


def channel_of(video=None):
    if video:
        v = P.index()["videos"].get(video) or {}
        if v.get("channel"):
            return v["channel"]
    c = P.channel()
    return c.get("id") if c else "default"


def add(kind, title, text="", video=None, el=None, route=None, icon="", job=None, channel=None, dedup=None):
    """Новое уведомление. dedup — ключ: такое уже есть за последний час — не дублировать (тот же вопрос, та же задача)."""
    cid = channel or channel_of(video)
    rec = {"id": "n" + uuid.uuid4().hex[:9], "ts": int(time.time() * 1000), "kind": kind, "icon": icon, "title": title[:160], "text": (text or "")[:400],
           "video": video, "videoName": video_name(video) if video else "", "el": el, "route": route or (f"#/v/{video}" if video else ""), "job": job, "dedup": dedup}
    os.makedirs(DIR, exist_ok=True)
    with _lock:
        if dedup:
            hour = rec["ts"] - 3600_000
            if any(x.get("dedup") == dedup and x["ts"] > hour for x in _read(cid)[-80:]):
                return None
        with open(_f(cid), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        _trim(cid)
    return rec


def _read(cid):
    out = []
    try:
        for ln in open(_f(cid), encoding="utf-8"):
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def _trim(cid):
    try:
        if os.path.getsize(_f(cid)) < 400_000:
            return
    except OSError:
        return
    old = int(time.time() * 1000) - MAX_DAYS * 86400_000
    keep = [x for x in _read(cid) if x["ts"] > old][-KEEP:]
    P.write_atomic(_f(cid), "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in keep))


def _seen(cid):
    try:
        return json.load(open(_f(cid, "read.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {"upto": 0, "ids": []}


def listing(cid, since=0, limit=200):
    s = _seen(cid)
    ids = set(s.get("ids") or [])
    items = _read(cid)
    unread = sum(1 for x in items if x["ts"] > s.get("upto", 0) and x["id"] not in ids)
    out = [dict(x, read=x["ts"] <= s.get("upto", 0) or x["id"] in ids) for x in items if x["ts"] > since][-limit:]
    out.reverse()
    return {"items": out, "unread": unread, "channel": cid}


def mark_read(cid, ids=None, all_=False):
    with _lock:
        s = _seen(cid)
        if all_:
            s = {"upto": int(time.time() * 1000), "ids": []}
        else:
            s["ids"] = list(dict.fromkeys((s.get("ids") or []) + list(ids or [])))[-1000:]
        os.makedirs(DIR, exist_ok=True)
        P.write_atomic(_f(cid, "read.json"), json.dumps(s))
    return listing(cid, 0, 0)["unread"]


def clear(cid, ids=None, video=None):
    """Убрать уведомления из ленты: перечисленные, все одного видео или (без аргументов) все."""
    with _lock:
        drop = set(ids or [])
        keep = [x for x in _read(cid) if not ((x["id"] in drop) if ids else (x.get("video") == video) if video else True)]
        os.makedirs(DIR, exist_ok=True)
        P.write_atomic(_f(cid), "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in keep))
        s = _seen(cid)
        if s.get("ids"):
            have = {x["id"] for x in keep}
            s["ids"] = [i for i in s["ids"] if i in have]
            P.write_atomic(_f(cid, "read.json"), json.dumps(s))
    return listing(cid, 0, 0)["unread"]


# ---------------------------------------------------------------- задачи
def on_job(A, job):
    """Задача Claude / Studio закончилась (done | error): уведомление со ссылкой на вкладку и элемент."""
    kind = job.kind
    orig = getattr(job, "kind0", None) or kind
    if orig in QUIET or kind in QUIET or job.status == "cancelled" or (job.meta or {}).get("silent"):
        return
    vid = job.key[5:] if (job.key or "").startswith("plan:") else None
    el = (job.params or {}).get("el") or (job.params or {}).get("thumb")
    tab, icon, what = JOBS.get(orig) or JOBS.get(kind) or ("", "✨", "Claude закончил")
    name = ""
    if vid and el:
        try:
            e = A._by_id(A.load(job.key).get("elements"), el)
            name = (e or {}).get("name", "")
        except Exception:
            pass
    if tab in ("lib", "style", "memory", "yt", "thumbs") or not vid:
        route = {"lib": "#/lib", "style": "#/style", "memory": "#/memory", "yt": "#/yt", "thumbs": f"#/thumbs/{vid}" if vid else "#/thumbs"}.get(tab, "")
        if tab == "lib" and (job.params or {}).get("id"):
            route = "#/lib/item/" + job.params["id"]          # id = <вид>/<slug>
    else:
        route = f"#/v/{vid}" + (f"/{tab}" if tab else "") + (f"/{el}" if tab == "pre" and el else "")
    if job.status == "error":
        add("error", f"Не получилось: {what.lower()}" + (f" — {name}" if name else ""), job.error, vid, el, route, "⚠", job.id)
    else:
        add("job", what + (f": {name}" if name else ""), job.summary, vid, el, route, icon, job.id)


def handle_get(A, h, p, q):
    if p == "/api/notify":
        cid = (q.get("ch") or [""])[0] or channel_of()
        h._json(listing(cid, int((q.get("since") or ["0"])[0] or 0))); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/notify/read":
        cid = body.get("ch") or channel_of()
        h._json({"unread": mark_read(cid, body.get("ids"), bool(body.get("all")))}); return True
    if p == "/api/notify/clear":
        cid = body.get("ch") or channel_of()
        h._json({"unread": clear(cid, body.get("ids"), body.get("video"))}); return True
    return False
