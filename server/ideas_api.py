"""Логика Claude Studio (бывший «Штурм идей»): документы и операции, экспорт для Claude, запуск Claude со страницы, начало производства.

ideas_server.py перезагружает этот модуль при изменении файла (а он сам перезагружает ideas_claude.py, scene_api.py, studio_api.py).
Поднимай API_VERSION, когда меняется то, от чего зависит страница: она покажет плашку «перезапусти».

Где что лежит — paths.py. Документы — JSON с счётчиком rev:
    plan:<id>     -> <канал>/videos/<папка>/video.json (+ video.md — читаемая версия для Claude); до переезда — _ideas/plans/<id>.json
    channel:<id>  -> <канал>/channel.json
    <канал>/index.md — обзор канала для Claude, пересобирается при каждом сохранении.
Правки приходят операциями (set / add / del / move, см. apply_op) и применяются к свежему файлу под блокировкой.
Поэтому страница, Claude на странице и Claude в сессии (CLI) не затирают правки друг друга.

GET  /api/state            -> версия API, доступен ли Claude, каналы, текущий канал и его видео
GET  /api/revs             -> rev всех документов + задачи Claude (страница опрашивает раз в 2 с)
GET  /api/doc?key=…        -> документ целиком
POST /api/op               <- {key, base, ops}          -> {rev, prev}
POST /api/new              <- {mode, name, topic, channel} -> {id}   (+ видео: папка в <канал>/videos)
POST /api/delete           <- {key}  (папка видео уходит в _archive/videos)
POST /api/file?plan=ID     <- картинка (dataURL или байты) -> {path: "files/ID/N.png"}
POST /api/claude           <- {action, key, scope, params} -> {job}
GET  /api/job?id=…         -> задача с результатом;  POST /api/job/cancel?id=…
POST /api/produce          <- {id}                     -> {job}  (🚀 проект ролика в папке видео + refs/штурм.md + препродакшен)
POST /api/refparse, /api/sound/fetch, /api/assets/fetch, /api/layout3d — как раньше; /api/scene… — scene_api; /api/studio…, /api/lib… — studio_api
GET  /files/<id>/…, /rscene/<id>/… (файлы и черновики видео), /fonts/…, /sfxlib/<id>.wav, /tpl/… (движок, потом шаблон), /render/… (стенды), /editor/…
POST-запросы принимаются только со страницы (заголовок X-Ideas и Origin localhost).
"""
import base64, importlib, json, os, re, shutil, subprocess, sys, threading, time, uuid
from urllib.parse import urlparse, parse_qs, unquote

API_VERSION = 32

import paths as P  # noqa: E402  где что лежит: _studio, каналы, видео, архив, .studio (docs/studio/stage2-studio.md)
HERE = P.SERVER                                             # _studio/server
PIPE = P.STUDIO                                             # _studio (бывший _pipeline)
ROOT = P.ROOT                                               # рабочая папка: каналы, _archive, .studio
DATA = P.STATE                                              # состояние приложения: .port, .lock, .jobs, state.json, токены
JOBS_DIR = os.path.join(DATA, ".jobs")
LOCK = os.path.join(DATA, ".lock")
WEB = P.WEB
FONTS = P.FONTS
TPL = P.TPL_SRC
SFXLIB = P.SFXLIB
FILE_MAX = 12 * 1024 * 1024
MODEL = os.environ.get("IDEAS_MODEL", "")                  # пусто — модель по умолчанию из Claude Code
EFFORT = os.environ.get("IDEAS_EFFORT", "")
# модели кнопок ✨: текст (вопросы, биты, названия, список элементов, подбор звука) — Sonnet, визуал (черновики элементов, обложка и первый кадр) — Opus
TEXT_MODEL = os.environ.get("IDEAS_TEXT_MODEL", "sonnet")           # алиас: самый новый Sonnet, который знает установленный Claude Code
VISUAL_MODEL = os.environ.get("IDEAS_VISUAL_MODEL", "claude-opus-5-5")
VISUAL_ACTIONS = ("element", "render", "charparts", "animteach", "libfix")
TEXT_EFFORT = {"elements": "medium", "sound": "medium", "assets": "medium", "reuse": "medium"}              # усилие для текстовых кнопок препродакшена; остальные — по умолчанию Claude Code
VISUAL_EFFORT = os.environ.get("IDEAS_VISUAL_EFFORT", "")           # пусто — по умолчанию Claude Code
MAX_JOBS = 3
MIME = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".pdf": "application/pdf", ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8",
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
        ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/ogg", ".webm": "audio/webm",
        ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".svg": "image/svg+xml"}
STATUS = {"draft": "штурм", "prod": "в работе", "out": "вышло", "archived": "архив"}
BAD_NAME = r'\/:*?"<>|'
os.makedirs(DATA, exist_ok=True)

import ideas_claude  # noqa: E402  промпты и схемы кнопок ✨
import sounds  # noqa: E402  поиск и скачивание звуков препродакшена
import refvideo  # noqa: E402  разбор видео-референсов
import refs_api  # noqa: E402  референсы брифа: добавить, разобрать, CLI ref …
import preprod  # noqa: E402  модель элементов препродакшена и экспорт в проект
import assets  # noqa: E402  поиск и скачивание бесплатных 3D / 2D ассетов
import studio_api  # noqa: E402  Claude Studio: каналы, видео, стиль, библиотека, архив
import char_api  # noqa: E402  персонажи со скелетом (S4): библиотека, позы, версии
import agent  # noqa: E402  агент S7: живая сессия Claude, лог, отмена запуска
import settings_api  # noqa: E402  ⚙ настройки приложения: ключи сервисов, Blender, модели Claude
import models3d  # noqa: E402  3D-модели: нормализация, скелет, «картинка -> 3D»
import channel_api  # noqa: E402  новый канал и его стиль (S9): интервью, файлы стиля, герой
import looks_api  # noqa: E402  визуалы канала (S14): техники → луки, ручки (window.LOOK), герои лука, превью
import looks_jobs  # noqa: E402  задачи визуалов (S14): превью, герой лука, интервью и ✨ сборка по референсам
import pack_api  # noqa: E402  упаковка S8: права, packaging.md, обложки в проект
import montage_api  # noqa: E402  монтаж (S6): video.json → montage → файлы проекта, сборка
import scene_api  # noqa: E402  сцены редактора (S1 Claude Studio): scene.json, операции, история, версии, клип, агент
import ws_api  # noqa: E402  мастерская ассета (S10): служебная сцена, клип из ключей позы, в библиотеку
import media_api  # noqa: E402  медиа библиотеки (S10.3): видео кадрами для живых экранов
import voice_api  # noqa: E402  голос ролика (S11): запись диктора -> нарезка по сценам, черновой голос
import talk_api  # noqa: E402  звериная речь (Animalese): голоса канала, послушать, фраза — звуком препродакшена
import videos_api  # noqa: E402  S12: страница «Видео» (карточки, обложки, папка) и поп-ап «Новое видео»
import render_api  # noqa: E402  S12.8: экспорт, очередь рендеров, готовые ролики
import thumbs_api  # noqa: E402  S12.9: обложки — доски и генерация картинок
import memory_api  # noqa: E402  S12.10: память — правила из правок автора
import youtube_api  # noqa: E402  S17: YouTube — аналитика канала и уроки
import make3d_api  # noqa: E402  S12.11: «✨ Сделать 3D» — Claude выбирает способ
import locations_api  # noqa: E402  S13: локации и сцены монтажа
import reuse_api  # noqa: E402  S15: «Уже было» — поиск готового в библиотеке и прошлых видео перед препродакшеном
import audio_api  # noqa: E402  S23: звуковой редактор монтажа — панель «Звуки», свои файлы, скачивание
import refbase_api  # noqa: E402  S16: «📐 По референсу» — подача чужого шорта, карта битов, похожие темы
import clips_api  # noqa: E402  S13.4: клипы сцен — плейбек и экспорт склейкой
import chime_api  # noqa: E402  звук «готово» силами Windows (winsound)
import fast_api  # noqa: E402  ⚡ быстрый монтаж v2: план -> сцены параллельно -> сводка
import notify_api  # noqa: E402  S20.5: лента уведомлений 🔔
import actions  # noqa: E402  S20.2: реестр действий Claude по вкладкам (агент: studio.py act)
KINDS = preprod.KINDS
# on a hot reload of this file keep the old mark, so a changed ideas_claude.py is still picked up by capi()
_claude_mtime = globals().get("_claude_mtime") or os.path.getmtime(ideas_claude.__file__)
try:                                                         # модели Claude из ⚙ Настроек (переменные окружения важнее)
    settings_api.apply_models(sys.modules[__name__])
except Exception:
    pass

# survives hot reloads: importlib.reload re-runs this file in the same module dict
if globals().get("_loaded_once"):                  # paths.py перечитывается вместе с этим файлом (правка paths — тронь и ideas_api)
    importlib.reload(P)
_loaded_once = True
JOBS = globals().get("JOBS") or {}
_lock = globals().get("_lock") or threading.RLock()
_revc = globals().get("_revc") or {}
_refc = globals().get("_refc") or {}


LOCAL_KINDS = ("fastmontage", "automontage", "clips", "produce", "sndfetch", "refparse", "refbase", "assetfetch", "layout3d", "scenever", "sceneclip", "libpublish", "charrig", "montagebuild", "chanhero", "charmodel", "assetupload", "comfysetup", "mediaadd", "voicesplit", "voicetts", "brollfetch", "lookprev", "lookhero", "ytsync", "ytlogin")   # jobs of this script that do not need Claude


def _fresh(mod, tag):
    """A helper module, reloaded when its file changes."""
    m = os.path.getmtime(mod.__file__)
    seen = getattr(mod, "_fresh_mtime", None)        # отметка живёт на самом модуле: перезагрузка ideas_api её не сбрасывает (раньше модуль «залипал»)
    if seen != m:                                    # первый вызов тоже перечитывает: модуль мог импортироваться раньше, чем файл дописали
        importlib.reload(mod)
        if seen is not None:
            print(mod.__name__, "перезагружен")
        mod._fresh_mtime = m
    _refc[tag] = m
    return mod


def sapi():
    return _fresh(sounds, "snd")


def vapi():
    return _fresh(refvideo, "vid")


def rapi():
    return _fresh(refs_api, "refs")


def pr():
    return _fresh(preprod, "pre")


def aapi():
    return _fresh(assets, "ast")


def chapi():
    return _fresh(char_api, "chr")


def agapi():
    return _fresh(agent, "agt")


def stgapi():
    return _fresh(settings_api, "stg")


def chmapi():
    return _fresh(chime_api, "chime")


def ntapi():
    return _fresh(notify_api, "notify")


def acapi():
    return _fresh(actions, "actions")


def fsapi():
    return _fresh(fast_api, "fast")


def clapi():
    return _fresh(clips_api, "clips")


def lcapi():
    return _fresh(locations_api, "loc")


def mk3d():
    return _fresh(make3d_api, "make3d")


def m3d():
    return _fresh(models3d, "m3d")


def chnapi():
    return _fresh(channel_api, "chn")


def lkapi():
    return _fresh(looks_api, "looks")


def ljapi():
    lkapi()
    return _fresh(looks_jobs, "lookjobs")


def pkapi():
    return _fresh(pack_api, "pak")


def mnapi():
    return _fresh(montage_api, "mnt")


def scapi():
    return _fresh(scene_api, "scn")


def wsapi():
    return _fresh(ws_api, "ws")


def mdapi():
    return _fresh(media_api, "media")


def mmapi():
    return _fresh(memory_api, "memory")


def ytapi():
    return _fresh(youtube_api, "yt")


def thapi():
    return _fresh(thumbs_api, "thumbs")


def rdapi():
    return _fresh(render_api, "renders")


def vdapi():
    return _fresh(videos_api, "videos")


def vcapi():
    return _fresh(voice_api, "voice")


def tkapi():
    return _fresh(talk_api, "talk")


def stapi():
    return _fresh(studio_api, "std")


def rsapi():
    return _fresh(reuse_api, "reuse")


def rbapi():
    return _fresh(refbase_api, "refbase")


def auapi():
    return _fresh(audio_api, "audio")


def capi():
    """ideas_claude, reloaded when its file changes."""
    global _claude_mtime
    pr()                                                   # препродакшен — свежий раньше промптов (состав сцен, вариации)
    m = os.path.getmtime(ideas_claude.__file__)
    if m != _claude_mtime:
        try:
            importlib.reload(ideas_claude)
            print("ideas_claude перезагружен")
        except Exception as e:
            print("! ideas_claude не загрузился:", e)
        _claude_mtime = m
    return ideas_claude


def ref():
    """web/ref.json (modes, tabs, angles, thumbnail map…) — shared by the page, the exports and the prompts."""
    p = os.path.join(WEB, "ref.json")
    m = os.path.getmtime(p)
    if _refc.get("m") != m:
        with open(p, encoding="utf-8") as f:
            _refc.update(m=m, data=json.load(f))
    return _refc["data"]


# ---------------- small utils ----------------
def now_ms():
    return int(time.time() * 1000)


def new_id(prefix=""):
    return prefix + uuid.uuid4().hex[:8]


def write_text(path, text):
    P.write_atomic(path, text)


class FileLock:
    """Cross-process lock (server threads + CLI in a Claude session) on _ideas/.lock."""

    def __init__(self, timeout=8.0, stale=15.0):
        self.timeout, self.stale, self.fd = timeout, stale, None

    def __enter__(self):
        t0 = time.time()
        while True:
            try:
                self.fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode())
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(LOCK) > self.stale:
                        os.remove(LOCK)
                        continue
                except OSError:
                    pass
                if time.time() - t0 > self.timeout:
                    raise TimeoutError("данные заняты другим процессом, попробуй ещё раз")
                time.sleep(0.03)

    def __exit__(self, *a):
        os.close(self.fd)
        try:
            os.remove(LOCK)
        except OSError:
            pass


# ---------------- documents ----------------
def default_plan(pid, mode, name="", topic="", flow="idea", engine="3d"):
    """A new video (video.json, architecture §3.2): idea -> questions -> title -> preproduction -> scenes -> script -> … -> packaging."""
    t = now_ms()
    mode = mode if mode in ("short", "long") else "short"
    return {"schema": 2, "id": pid, "rev": 0, "created": t, "updated": t, "mode": mode, "flow": "idea",
            "name": (name or "").strip() or "Новое видео", "status": "draft", "stage": "idea", "project": "", "web": False,
            "idea": "", "topic": topic or "", "refs": [], "qa": [], "titles": [], "final": {"title": "", "thumb": ""},
            "engine": engine, "elements": [], "thumbs": []}


def is_idea(d):
    return (d or {}).get("flow") == "idea"


DEFAULTS = {}                               # банк, лист проекта и статистика ушли в _archive/ideas (S2)


def doc_path(key):
    """plan:<id> -> <канал>/videos/<папка>/video.json (до переезда — _ideas/plans/<id>.json); channel:<id> -> <канал>/channel.json."""
    if key.startswith("plan:") and re.fullmatch(r"[a-z0-9-]{3,40}", key[5:]):
        p = P.video_json(key[5:])
        if p:
            return p
    if key.startswith("channel:"):
        c = P.channel(key[8:])
        if c and c.get("id") == key[8:]:
            return os.path.join(c["dir"], "channel.json")
    raise KeyError(key)


def load(key):
    p = doc_path(key)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    if key in DEFAULTS:
        return DEFAULTS[key]()
    raise KeyError(key)


def save(key, doc):
    p = doc_path(key)
    P.write_atomic(p, json.dumps(doc, ensure_ascii=False, indent=1))
    try:
        if key.startswith("plan:"):
            write_text(p[:-5] + ".md", plan_md(doc))            # video.md — читаемая версия для Claude
        write_index()
    except Exception as e:                   # the export must never break saving
        print("! экспорт md:", e)


def rev_of(path):
    try:
        m = os.path.getmtime(path)
    except OSError:
        return None
    c = _revc.get(path)
    if c and c[0] == m:
        return c[1]
    try:
        with open(path, encoding="utf-8") as f:
            r = json.load(f).get("rev", 0)
    except Exception:
        r = 0
    _revc[path] = (m, r)
    return r


def _video_files():
    """[(id, video.json)] of all videos (all channels), or the legacy plans before the move."""
    if P.legacy():
        d = os.path.join(P.LEGACY, "plans")
        return [(f[:-5], os.path.join(d, f)) for f in os.listdir(d) if f.endswith(".json")] if os.path.isdir(d) else []
    return [(vid, os.path.join(v["dir"], "video.json")) for vid, v in P.index()["videos"].items()]


def all_revs():
    out = {"plan:" + vid: rev_of(p) or 0 for vid, p in _video_files()}
    for c in P.channels():
        out["channel:" + c["id"]] = rev_of(os.path.join(c["dir"], "channel.json")) or 0
    return out


def plans(channel=None):
    """Videos of a channel (all channels when channel is None), newest first; each gets _channel and _folder."""
    out = []
    for vid, f in _video_files():
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except Exception as e:
            print("! видео не читается:", f, e)
            continue
        v = P.index()["videos"].get(vid) or {}
        if channel and v.get("channel") != channel:
            continue
        d["_channel"], d["_folder"] = v.get("channel"), v.get("folder")
        out.append(d)
    return sorted(out, key=lambda d: -d.get("updated", 0))


# ---------------- operations ----------------
def _resolve(doc, path, create):
    """(container, key) for the last path element. In lists, path elements are item ids."""
    cur = doc
    for k in path[:-1]:
        if isinstance(cur, list):
            nxt = next((it for it in cur if isinstance(it, dict) and it.get("id") == k), None)
        elif isinstance(cur, dict):
            nxt = cur.get(k)
            if nxt is None and create:
                nxt = cur[k] = {}
        else:
            nxt = None
        if nxt is None:
            return None, None
        cur = nxt
    last = path[-1]
    if isinstance(cur, list):
        idx = next((i for i, it in enumerate(cur) if isinstance(it, dict) and it.get("id") == last), None)
        return (cur, idx) if idx is not None else (None, None)
    return (cur, last) if isinstance(cur, dict) else (None, None)


def apply_op(doc, op):
    """set {path, value} | add {path, item, at} | del {path, id} | move {path, id, to}. Mirrors applyOp in core.js."""
    kind, path = op.get("op"), [str(p) for p in (op.get("path") or [])]
    if not path or path[0] in ("rev", "id"):
        return
    if kind == "set":
        c, k = _resolve(doc, path, True)
        if c is not None:
            c[k] = op.get("value")
        return
    c, k = _resolve(doc, path, True)
    if not isinstance(c, dict):
        return
    lst = c.get(k)
    if not isinstance(lst, list):
        lst = c[k] = []
    if kind == "add":
        item = op.get("item")
        if isinstance(item, dict):
            item.setdefault("id", new_id())
        at = op.get("at")
        lst.insert(len(lst) if at is None else max(0, min(len(lst), int(at))), item)
    elif kind in ("del", "move"):
        i = next((i for i, it in enumerate(lst) if isinstance(it, dict) and it.get("id") == op.get("id")), None)
        if i is None:
            return
        it = lst.pop(i)
        if kind == "move":
            lst.insert(max(0, min(len(lst), int(op.get("to", 0)))), it)


def apply_ops(key, ops):
    with _lock, FileLock():
        doc = load(key)
        prev = doc.get("rev", 0)
        for op in ops:
            if isinstance(op, dict):
                apply_op(doc, op)
        doc["rev"] = prev + 1
        doc["updated"] = now_ms()
        save(key, doc)
        res = {"rev": doc["rev"], "prev": prev}
    if key.startswith("plan:") and any(isinstance(o, dict) and o.get("path") == ["status"] and o.get("value") == "out" for o in ops):
        try:                                               # S14: видео вышло — настройки лука замораживаются (lookSnap)
            lkapi().freeze(sys.modules[__name__], key[5:])
        except Exception as e:
            print("lookSnap:", e)
    return res


def folder_name(name, base):
    """A folder name for a video from its name: no forbidden characters, unique inside base."""
    n = re.sub(r'[\/:*?"<>|]+', " ", (name or "").strip()).strip(" .") or "Новое видео"
    n, k, out = n[:80], 2, n[:80]
    while os.path.exists(os.path.join(base, out)):
        out, k = f"{n} {k}", k + 1
    return out


def new_plan(mode, name="", topic="", bank_id="", flow="idea", channel=None):
    """+ видео: <канал>/videos/<Имя>/video.json (+ files/, preprod/, refs/). До переезда — _ideas/plans/<id>.json."""
    pid = time.strftime("%y%m%d") + "-" + uuid.uuid4().hex[:4]
    c = P.channel(channel)
    doc = default_plan(pid, mode, name, topic, flow, engine=((c or {}).get("defaults") or {}).get("engine", "3d"))
    with _lock, FileLock():
        if P.legacy() or not c:
            os.makedirs(os.path.join(P.LEGACY, "plans"), exist_ok=True)
            with open(os.path.join(P.LEGACY, "plans", pid + ".json"), "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, indent=1)
        else:
            base = os.path.join(c["dir"], "videos")
            d = os.path.join(base, folder_name(doc["name"], base))
            for sub in ("files", "preprod", "refs"):
                os.makedirs(os.path.join(d, sub), exist_ok=True)
            with open(os.path.join(d, "video.json"), "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, indent=1)
            P.index(True)
        save("plan:" + pid, doc)
    return doc


# ---------------- summaries & markdown for Claude ----------------
def _by_id(items, i):
    return next((x for x in items or [] if x.get("id") == i), None)


def plan_summary(d):
    ideas, beats, titles = d.get("ideas", []), d.get("beats", []), d.get("titles", [])
    fin = d.get("final") or {}
    ft, ch = _by_id(titles, fin.get("title")), _by_id(ideas, d.get("chosen"))
    slots = (d.get("structure") or {}).get("slots") or {}
    qa, els = d.get("qa") or [], [e for e in d.get("elements") or [] if e.get("status") != "drop"]
    return {
        "id": d["id"], "name": d.get("name", ""), "mode": d.get("mode"), "status": d.get("status"), "flow": d.get("flow") or "storm",
        "project": d.get("project", ""), "updated": d.get("updated", 0), "created": d.get("created", 0),
        "chosen": (d.get("idea") or "") if is_idea(d) else (ch.get("text", "") if ch else ""), "final": ft.get("text", "") if ft else "",
        "p": {"ideas": len(ideas), "stars": sum(1 for i in ideas if i.get("star")), "chosen": bool(ch) or bool((d.get("idea") or "").strip()),
              "beats": len(beats), "kept": sum(1 for b in beats if b.get("keep", True)),
              "titles": len(titles), "finalists": sum(1 for t in titles if t.get("star")),
              "images": sum(1 for g in d.get("images", []) if g.get("text") or g.get("img")),
              "thumbs": len(d.get("thumbs", [])), "win": bool(fin.get("thumb")),
              "slots": sum(1 for v in slots.values() if v), "project": bool(d.get("project")), "out": d.get("status") == "out",
              "qa": len(qa), "answered": sum(1 for q in qa if (q.get("a") or "").strip() or q.get("skip")),
              "elements": len(els), "ready": sum(1 for e in els if e.get("status") == "ok")},
    }


def _cell(s):
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def plan_md(d, img=lambda p: p, where=None, folders=None):
    """The whole brainstorm as markdown: _ideas/plans/<id>.md and <project>/refs/штурм.md read by Claude."""
    R = ref()
    mode = R["modes"].get(d.get("mode"), R["modes"]["short"])
    short = d.get("mode") != "long"
    ideas, beats, titles = d.get("ideas", []), d.get("beats", []), d.get("titles", [])
    idea_flow = is_idea(d)
    L = [f"# Штурм: {d.get('name', '')}",
         f"{mode['icon']} {mode['label']} ({mode['len']}) · "
         + (f"подача: {next((x['label'] for x in R.get('deliveries', []) if x['key'] == (d.get('brief') or {}).get('delivery')), 'авто')}"   # S12: бриф поп-апа
            if d.get("brief") else f"жанр: {next((g['label'] for g in R.get('genres', []) if g['key'] == (d.get('genre') or 'news')), 'новость')}")
         + f" · статус: {STATUS.get(d.get('status'), d.get('status'))} · id `{d['id']}`"
         + (f" · проект: «{d['project']}»" if d.get("project") else "") + (" · путь: есть идея → препродакшен" if idea_flow else ""),
         f"Обновлён {time.strftime('%Y-%m-%d %H:%M', time.localtime(d.get('updated', 0) / 1000))}. "
         f"Сделан в сервисе «Штурм идей» по методике «Мастер-планера». Пути к картинкам — от папки _ideas (в проекте — refs/штурм/).",
         "Как использовать: идея, биты и структура — основа сценария; «Смыслы в образы» — ТЗ на картинку сцен и ассеты; "
         "связка (хук, первый кадр, обложка) — сцена 1 и первая обложка; вырезанные биты — запас для правок."
         + (" Ответы автора на вопросы — его решения, их не переписывать; «Препродакшен» — готовые сцены, персонажи, пропсы и звуки ролика." if idea_flow else ""), ""]
    ch = _by_id(ideas, d.get("chosen"))
    fin = d.get("final") or {}
    ft, fc = _by_id(titles, fin.get("title")), _by_id(d.get("thumbs", []), fin.get("thumb"))
    idea_text = (d.get("idea") or "").strip() if idea_flow else (ch["text"] if ch else "")
    L += ["## Итог штурма", f"- **Идея:** {idea_text or '— (не выбрана)'}",
          f"- **Название:** {ft['text'] if ft else '— (связка не выбрана)'}"]
    if fc:
        L.append(f"- **{'Обложка' if short else 'Превью'}:** {fc.get('desc', '')}"
                 + (f" · тип: {R['thumbTypes'].get(fc.get('type'), {}).get('label', fc.get('type'))}" if fc.get("type") else "")
                 + (f" · текст: «{fc['text']}»" if fc.get("text") else "") + (f" · эскиз: {img(fc['img'])}" if fc.get("img") else ""))
        if short:
            L += [f"- **Хук (первая фраза):** {fc.get('hook') or '—'}",
                  f"- **Первый кадр:** {fc.get('frame') or '—'}" + (f" · эскиз: {img(fc['frameImg'])}" if fc.get("frameImg") else "")]
    L.append("")
    if d.get("topic"):
        L += ["## Контекст" if idea_flow else "## Вводные", d["topic"].strip(), ""]
    refs = d.get("refs") or []
    if refs:
        L.append("## Референсы")
        for r in refs:
            ps = r.get("parse") or {}
            if r.get("kind") == "image":
                if r.get("img"):
                    L.append(f"- картинка {img(r['img'])}" + (f" — {r['note']}" if r.get("note") else ""))
                continue
            L.append(f"- {'📼 видео' if r.get('kind') == 'video' else '🔗 ссылка'}: {r.get('title') or ps.get('title') or ''} {r.get('url') or r.get('path') or ''}".rstrip()
                     + (f" — _что взять:_ {r['note']}" if r.get("note") else ""))
            if ps.get("status") == "done":
                L.append(f"  - {ps.get('dur')} с; кадры (каждые {ps.get('step')} с, сеткой 6×5): " + ", ".join(img(s) for s in ps.get("sheets") or [])
                         + (f"; расшифровка: {img(ps['transcript'])}" if ps.get("transcript") else ""))
        L.append("")
    qa = d.get("qa") or []
    if qa:
        L.append(f"## Вопросы Claude и ответы автора ({sum(1 for q in qa if (q.get('a') or '').strip())} из {len(qa)})")
        for q in qa:
            if (q.get("a") or "").strip():
                L.append(f"- **{q.get('q', '').strip()}** — {q['a'].strip()}")
        rest = [q.get("q", "") for q in qa if not (q.get("a") or "").strip() and not q.get("skip")]
        if rest:
            L.append("- Без ответа: " + " · ".join(rest))
        L.append("")
    chal = d.get("challenge") or {}
    if chal.get("points"):
        L += ["## Челлендж битов (Claude)"] + [f"- {p}" for p in chal["points"]] + [""]
    if ideas:
        L.append(f"## Идеи ({len(ideas)}; ★ финалисты, ● выбрана)")
        for i in ideas:
            mark = ("● " if i["id"] == d.get("chosen") else "") + ("★ " if i.get("star") else "")
            L.append(f"- {mark}{i.get('text', '')}" + (f" — _{i['why']}_" if i.get("why") else "")
                     + (f" ({i['src']})" if i.get("src") else "") + (" 🤖" if i.get("by") == "claude" else "") + (" → в банке" if i.get("banked") else ""))
        L.append("")
    if beats:
        kept = [b for b in beats if b.get("keep", True)]
        L += [f"## Биты (оставлено {len(kept)} из {len(beats)})", "| # | Вопрос / сетап | Ответ / панчлайн | Источник |", "|---|---|---|---|"]
        for n, b in enumerate(kept, 1):
            L.append(f"| {n} | {_cell(b.get('q'))} | {_cell(b.get('a'))} | {_cell(b.get('src'))} |")
        cut = [b for b in beats if not b.get("keep", True)]
        if cut:
            L += ["", "Вырезанные (запас): " + "; ".join(f"{b.get('q', '')} → {b.get('a', '')}".strip(" →") for b in cut)]
        L.append("")
    q7 = d.get("q7") or {}
    if any(q7.values()):
        L.append("## Генератор названий · 7 вопросов")
        for q in R["q7"]:
            if q7.get(q["key"]):
                L.append(f"- **{q['label']}** {q7[q['key']].strip()}")
        L.append("")
    ms = d.get("meanings", [])
    if ms:
        pick = lambda mk: ", ".join(m["text"] for m in ms if (m.get("mark") or "") == mk)
        L += ["## Смыслы", f"- Без этого никак: {pick('must') or '—'}", f"- Остальные: {pick('') or '—'}"]
        if pick("cut"):
            L.append(f"- Вычеркнуты (ложное впечатление): {pick('cut')}")
        L.append("")
    if titles:
        L.append("## Названия по углам атаки (★ — финалисты)")
        for a in R["angles"]:
            ts = [t for t in titles if t.get("angle") == a["key"]]
            if ts:
                L.append(f"- **{a['label']}:** " + " · ".join(("★ " if t.get("star") else "") + f"«{t.get('text', '')}»" for t in ts))
        L.append("")
    imgs = [g for g in d.get("images", []) if g.get("text") or g.get("img")]
    if imgs:
        L += ["## Смыслы в образы", "| Смысл | Образы |", "|---|---|"]
        for m in ms:
            row = sorted((g for g in imgs if g.get("meaning") == m["id"]), key=lambda g: g.get("slot", 0))
            if row:
                cells = [_cell((g.get("text") or "") + (f" [{img(g['img'])}]" if g.get("img") else "")) for g in row]
                L.append(f"| {_cell(m['text'])}{' (без этого никак)' if m.get('mark') == 'must' else ''} | " + " · ".join(cells) + " |")
        L.append("")
    th = d.get("thumbs", [])
    if th:
        L.append(f"## {'Хук и обложка' if short else 'Концепты превью'}")
        for t in titles:
            cs = [c for c in th if c.get("title") == t["id"]]
            if not cs:
                continue
            L.append(f"### «{t.get('text', '')}»")
            for c in cs:
                tt = R["thumbTypes"].get(c.get("type"), {}).get("label", c.get("type") or "тип не выбран")
                L.append(f"- {'🏆 ' if c['id'] == fin.get('thumb') else ''}{c.get('desc', '') or '(без описания)'} · {tt} · образов: {c.get('n') or '?'}"
                         + (f" · текст: «{c['text']}»" if c.get("text") else "") + (f" · эскиз: {img(c['img'])}" if c.get("img") else ""))
                if short and (c.get("hook") or c.get("frame") or c.get("frameImg")):
                    L.append(f"  - хук: {c.get('hook') or '—'} · первый кадр: {c.get('frame') or '—'}" + (f" · эскиз: {img(c['frameImg'])}" if c.get("frameImg") else ""))
                rs = c.get("renders") or []
                r = next((x for x in rs if x.get("id") == c.get("render")), rs[-1] if rs else None)
                if r:
                    L.append(f"  - 🎨 отрисовано движком (v{r.get('v')}): обложка {img(r['cover'])} · первый кадр {img(r['frame'])}"
                             f" · сцена `_ideas/render/{r.get('dir')}/scene.js` — готовый код для THUMBNAILS и сцены 1")
                cr = c.get("critique")
                if isinstance(cr, dict) and cr.get("points"):
                    L.append(f"  - разбор Claude ({cr.get('verdict', '')}): " + "; ".join(cr["points"]))
        L.append("")
    L += pr().pre_md(d, where, folders)
    st = d.get("structure") or {}
    slots = st.get("slots") or {}
    if any(slots.values()) or any((st.get("notes") or {}).values()):
        if short:
            sch = R["schemes"].get(st.get("scheme"), {})
            rows, label = sch.get("blocks", []), sch.get("label", "своя схема")
        elif st.get("scheme") == "steps":
            fixed = R["steps"]
            rows = [s for s in fixed if not s.get("end")] + [{"key": s["id"], "label": s.get("text") or "Шаг", "hint": ""} for s in st.get("steps", [])] + [s for s in fixed if s.get("end")]
            label = "Инструкция по шагам"
        else:
            rows, label = R["acts"], "Три акта (15 точек)"
        L.append(f"## Структура · {label}" + (f" · {st.get('minutes', 12)} мин" if not short else ""))
        for r in rows:
            ids, note = slots.get(r["key"]) or [], (st.get("notes") or {}).get(r["key"], "")
            if not ids and not note:
                continue
            tm = f" ({r['t']})" if r.get("t") else (f" (~{int(r['pct'] * float(st.get('minutes') or 12) * 60 / 100) // 60}:{int(r['pct'] * float(st.get('minutes') or 12) * 60 / 100) % 60:02d})" if "pct" in r else "")
            mk = (st.get("marks") or {}).get(r["key"])
            L.append(f"### {r['label']}{tm}" + (f" · {'сетап' if mk == 'q' else 'панчлайн'}" if mk else ""))
            for b in (_by_id(beats, i) for i in ids):
                if b:
                    L.append(f"- {b.get('q', '')}" + (f" → {b['a']}" if b.get("a") else ""))
            if note:
                L.append(f"- _заметка:_ {note}")
        L.append("")
    re_ = d.get("retro") or {}
    if any(re_.get(k) for k in ("glad", "sorry", "hard", "differ", "improve", "awesome")) or any((d.get("reaction") or {}).values()):
        L.append("## Итоги")
        if re_.get("awesome"):
            L.append(f"- Офигенно получилось? {re_['awesome']}")
        for q in R["retroQ"]:
            if re_.get(q["key"]):
                L.append(f"- {q['label']} {re_[q['key']]}")
        for q in R["reaction"]:
            if (d.get("reaction") or {}).get(q["key"]):
                L.append(f"- {q['icon']} {q['label']}: {d['reaction'][q['key']]}")
        L.append("")
    return "\n".join(L)


STAGES = ["idea", "qa", "title", "script", "pre", "voice", "montage", "review", "pack", "scenes"]   # S11: сценарий до препродакшена; «scenes» — вкладка убрана
STAGE_LABEL = {"idea": "идея", "qa": "вопросы", "title": "название", "pre": "препродакшен", "scenes": "сцены", "script": "сценарий",
               "voice": "голос", "montage": "монтаж", "review": "ревью", "pack": "упаковка"}


def index_md(channel=None):
    """<канал>/index.md — обзор канала для Claude: видео, их этапы и где что лежит."""
    c = P.channel(channel) or {}
    R = ref()
    L = [f"# {c.get('icon', '')} {c.get('name', 'Claude Studio')} — обзор для Claude".strip(), "",
         f"Приложение: `_studio` (Claude Studio). Обновлено {time.strftime('%Y-%m-%d %H:%M')}.",
         "Каждое видео — папка `videos/<Имя>/`: `video.json` (идея, вопросы, название, препродакшен…), `video.md` (читаемая версия), "
         "проект ролика (script.md, src/, build.sh), `preprod/` (черновики элементов, сцены редактора), `files/` (картинки).",
         "Писать в видео — только через CLI: `python _studio/server/studio.py …` (не правь JSON руками). Стиль канала — `style/style-guide.md`.", "",
         "## Видео", "| id | формат | статус | этап | папка | название |", "|---|---|---|---|---|---|"]
    for d in plans(c.get("id")):
        s = plan_summary(d)
        L.append(f"| `{s['id']}` | {R['modes'].get(s['mode'], {}).get('icon', '')} | {STATUS.get(s['status'], s['status'])} | {STAGE_LABEL.get(d.get('stage'), '—')} "
                 f"| {_cell(d.get('_folder') or '')} | {_cell(s['final']) or '—'} |")
    return "\n".join(L) + "\n"


def write_index():
    for c in P.channels():
        write_text(os.path.join(c["dir"], "index.md"), index_md(c["id"]))


# ---------------- files ----------------
def img_ext(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def file_from_url(pid, url):
    """🔎 Картинка, перетащенная из окна поиска (Google Картинки и любой сайт): адрес картинки, data: или ссылка-обёртка (imgres?imgurl=…) -> файл видео."""
    import urllib.request, urllib.parse
    url = (url or "").strip().splitlines()[0] if url else ""
    if url.startswith("data:"):
        return save_file(pid, url.encode())
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    for k in ("imgurl", "mediaurl", "img_url"):                 # обёртки поисковиков: настоящий адрес — в параметре
        if q.get(k):
            url = q[k][0]; break
    if not re.match(r"^https?://", url):
        raise ValueError("это не адрес картинки")
    pr = urllib.parse.urlparse(url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                                               "Referer": f"{pr.scheme}://{pr.netloc}/", "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(FILE_MAX + 1)
    except Exception as ex:                                    # сайт не отдал (защита от скачивания, 403, таймаут) — понятная ошибка, а не обрыв
        raise ValueError(f"сайт не отдал картинку ({getattr(ex, 'code', '') or ex.__class__.__name__}) — «Копировать картинку» в окне поиска и Ctrl+V над слотом") from None
    if not img_ext(data):                                      # avif / bmp / tiff — в png
        try:
            from PIL import Image
            import io
            b = io.BytesIO(); Image.open(io.BytesIO(data)).convert("RGBA").save(b, "PNG"); data = b.getvalue()
        except Exception:
            raise ValueError("по ссылке не картинка (открой картинку крупно и перетащи её, или «Копировать картинку» → Ctrl+V)")
    return save_file(pid, data)


def save_file(pid, data):
    if not re.fullmatch(r"[a-z0-9-]{3,40}", pid or ""):
        raise ValueError("нет id штурма")
    if data[:5] == b"data:":
        data = base64.b64decode(data.split(b",", 1)[1])
    if len(data) > FILE_MAX:
        raise ValueError(f"картинка больше {FILE_MAX // 2**20} МБ")
    ext = img_ext(data)
    if not ext:
        raise ValueError("это не картинка png/jpg/webp/gif")
    d = P.files(pid)
    os.makedirs(d, exist_ok=True)
    with _lock:
        ks = [int(m.group(1)) for f in os.listdir(d) if (m := re.match(r"(\d+)\.", f))]
        name = f"{max(ks, default=0) + 1}.{ext}"
        with open(os.path.join(d, name), "xb") as f:
            f.write(data)
    return f"files/{pid}/{name}"


def plan_images(d):
    """Files of the brainstorm copied to <project>/refs/штурм/ (elements of the preproduction go to refs/препродакшен/)."""
    out = [x[k] for x in d.get("images", []) + d.get("thumbs", []) for k in ("img", "frameImg") if x.get(k)]
    out += [r["img"] for r in d.get("refs") or [] if r.get("img")]
    for r in d.get("refs") or []:
        ps = r.get("parse") or {}
        out += list(ps.get("sheets") or []) + ([ps["transcript"]] if ps.get("transcript") else [])
    return out + [r[k] for c in d.get("thumbs", []) for r in c.get("renders", []) for k in ("cover", "frame") if r.get(k)]


def flat(rel):
    """files/<plan>/ref_x/sheet1.jpg -> ref_x_sheet1.jpg (unique name inside refs/штурм/)."""
    parts = rel.replace("\\", "/").split("/")
    return "_".join(parts[2:]) if len(parts) > 2 and parts[0] == "files" else parts[-1]


# ---------------- Claude ----------------
def _journal_set(run, key, path, desc):
    """S7: обратная операция для set из CLI агента — прежнее значение пути."""
    doc = load(key)
    cur, ok = doc, True
    for p in path:
        if isinstance(cur, list):
            cur = next((x for x in cur if isinstance(x, dict) and x.get("id") == p), None)
        elif isinstance(cur, dict):
            cur = cur.get(p)
        else:
            cur = None
        if cur is None:
            ok = False
            break
    agapi().journal(run, {"key": key, "inverse": [{"op": "set", "path": path, "value": cur if ok else None}], "desc": desc})


def claude_bin():
    """The native claude.exe (the npm .cmd shim would push Russian prompts through cmd.exe and mangle them)."""
    env = os.environ.get("CLAUDE_BIN")
    if env and os.path.isfile(env):
        return env
    for name in ("claude.exe", "claude"):
        p = shutil.which(name)
        if not p:
            continue
        if p.lower().endswith(".exe") or os.name != "nt":
            return p
        exe = os.path.join(os.path.dirname(p), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        if os.path.isfile(exe):
            return exe
    home = os.path.join(os.path.expanduser("~"), ".local", "bin", "claude.exe")
    return home if os.path.isfile(home) else None


def usage_of(data):
    """Токены запуска claude -p по видам (журнал задач): in — новый ввод, cw — запись в кэш, cr — чтение из кэша (каждый ход перечитывает историю), out — ответ и размышления.
    По ним видно, на что уходит лимит: длинная история × много ходов (cr), большие картинки и файлы (cw), длинное мышление (out)."""
    u = data.get("usage") or {}
    out = {"in": u.get("input_tokens"), "cw": u.get("cache_creation_input_tokens"), "cr": u.get("cache_read_input_tokens"), "out": u.get("output_tokens")}
    return {k: v for k, v in out.items() if v}


def run_claude(job, spec):
    """claude -p on the user's subscription: our system prompt, tools off (or web search / reading given files), JSON by schema."""
    exe = claude_bin()
    if not exe:
        raise RuntimeError("не найден Claude Code (claude.exe) — поставь его или задай путь в CLAUDE_BIN")
    os.makedirs(JOBS_DIR, exist_ok=True)
    sysf = os.path.join(JOBS_DIR, job.id + ".system.txt")
    write_text(sysf, spec["system"])
    tools = spec.get("tools") or (["WebSearch", "WebFetch"] if spec.get("web") else []) + (["Read"] if spec.get("read") else [])
    allowed = spec.get("allowed") or tools              # e.g. "Bash(node …/render_shot.js:*)" — one argv item each (may contain spaces)
    cmd = [exe, "-p", "--safe-mode", "--no-session-persistence", "--output-format", "json",
           "--tools", ",".join(tools), "--json-schema", json.dumps(spec["schema"], ensure_ascii=False),
           "--system-prompt-file", sysf]
    if tools:
        cmd += ["--allowedTools", *allowed, "--permission-prompts", "none"]
    for d in {os.path.dirname(f) for f in spec.get("read") or []} | set(spec.get("dirs") or []):
        cmd += ["--add-dir", d]
    model, effort = spec.get("model") or MODEL, spec.get("effort") or EFFORT
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    timeout = spec.get("timeout") or (600 if spec.get("web") else 300)
    try:
        job.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=spec.get("cwd") or JOBS_DIR,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        _persist()                                             # S22: pid claude.exe — чтобы после перезапуска Studio его остановить
        try:
            out, err = job.proc.communicate(spec["prompt"].encode("utf-8"), timeout=timeout)
        except subprocess.TimeoutExpired:
            P.kill_tree(job.proc)                              # S22: со всеми детьми (Blender, node, Chrome)
            raise RuntimeError(f"Claude не ответил за {timeout // 60} мин")
    finally:
        try:
            os.remove(sysf)
        except OSError:
            pass
    if job.cancelled:
        raise RuntimeError("отменено")
    try:
        data = json.loads(out.decode("utf-8", "replace"))
    except ValueError:
        raise RuntimeError((err or out).decode("utf-8", "replace").strip()[-400:] or f"claude завершился с кодом {job.proc.returncode}")
    job.meta = {"cost": data.get("total_cost_usd"), "turns": data.get("num_turns"), "ms": data.get("duration_ms"), **usage_of(data)}
    if data.get("is_error") or data.get("subtype") != "success":
        raise RuntimeError(str(data.get("result") or data.get("subtype") or "ошибка Claude")[:400])
    res = data.get("structured_output")
    if res is None:                        # older CLI: JSON may come back as text
        txt = (data.get("result") or "").strip()
        m = re.search(r"\{.*\}", txt, re.S)
        res = json.loads(m.group(0)) if m else None
    if not isinstance(res, dict):
        raise RuntimeError("Claude ответил не по схеме")
    return res


class Job:
    def __init__(self, kind, key, scope, params):
        self.id = "j" + uuid.uuid4().hex[:10]
        self.kind, self.key, self.scope, self.params = kind, key, scope or kind, params or {}
        self.kind0 = kind                                      # S20.5: make3d и т. п. меняют kind по ходу — уведомление по исходной кнопке
        self.params0 = dict(params or {})                     # S22: как задачу запустили — для повтора и восстановления после перезапуска
        self.status, self.started, self.finished = "running", time.time(), 0.0
        self.result, self.error, self.summary, self.proc, self.cancelled, self.meta = None, "", "", None, False, {}

    def info(self, full=False):
        d = {"id": self.id, "kind": self.kind, "key": self.key, "scope": self.scope, "status": self.status,
             "started": int(self.started * 1000), "elapsed": round((self.finished or time.time()) - self.started, 1),
             "error": self.error, "summary": self.summary}
        if full:
            d["result"] = self.result
        return d


def max_jobs():
    """Сколько задач Claude идут одновременно: ⚙ Настройки → «Claude одновременно» (1–8), по умолчанию MAX_JOBS."""
    try:
        return max(1, min(8, int(P.state_get("max_jobs") or MAX_JOBS)))
    except (TypeError, ValueError):
        return MAX_JOBS


_PUMP = threading.Lock()
_PERSIST = threading.Lock()
JOBS_FILE = os.path.join(JOBS_DIR, "live.json")
SERVER = globals().get("SERVER", False)                    # S22: очередь на диск пишет только процесс сервера (CLI затёр бы её своим пустым JOBS)


def _persist():
    """S22: живые задачи Claude (ждут / идут) -> .jobs/live.json: после перезапуска Studio очередь вернётся, осиротевшие процессы остановятся."""
    if not SERVER:
        return
    rows = []
    for j in list(JOBS.values()):
        if j.status not in ("queued", "running") or j.cancelled or j.kind0 in LOCAL_KINDS:
            continue
        pid = None
        try:
            pid = j.proc.pid if j.proc and j.proc.poll() is None else None
        except Exception:
            pass
        rows.append({"id": j.id, "kind": j.kind0, "key": j.key, "scope": j.scope, "params": getattr(j, "params0", {}), "status": j.status,
                     "started": j.started, "retry_at": getattr(j, "retry_at", 0), "tries": getattr(j, "tries", 0), "pid": pid})
    try:
        with _PERSIST:
            os.makedirs(JOBS_DIR, exist_ok=True)
            P.write_atomic(JOBS_FILE, json.dumps(rows, ensure_ascii=False, indent=1, default=str))
    except OSError as e:
        print("! очередь на диск:", e)


def restore_jobs():
    """S22: старт сервера — задачи прошлого запуска: их claude.exe (и Blender / node / Chrome под ним) останавливаются, задачи — снова в очередь
    тем же порядком. Прерванный черновик начнётся заново (своя новая версия, старые не трогаются)."""
    global SERVER
    SERVER = True
    try:
        rows = json.load(open(JOBS_FILE, encoding="utf-8"))
    except (OSError, ValueError):
        rows = []
    back, killed = 0, 0
    for r in rows:
        if r.get("pid") and P.kill_tree(r["pid"], names=("claude",)):
            killed += 1
        if any(j.key == r.get("key") and j.scope == r.get("scope") and j.status in ("queued", "running") for j in JOBS.values()):
            continue
        job = Job(r.get("kind"), r.get("key"), r.get("scope"), r.get("params") or {})
        job.status, job.started = "queued", float(r.get("started") or time.time())
        job.summary = "после перезапуска Studio — снова в очереди"
        job.tries, job.retry_at = int(r.get("tries") or 0), float(r.get("retry_at") or 0)
        JOBS[job.id] = job
        back += 1
    _persist()
    if back or killed:
        print(f"очередь после перезапуска: вернул {back}, остановил осиротевших процессов {killed}")
        try:
            ntapi().add("job", f"После перезапуска Studio: в очереди снова {back}", (f"остановлено зависших процессов Claude: {killed}" if killed else ""), None, None, None, "🔄")
        except Exception as e:
            print("! notify:", e)
    _pump()


def _held(job):
    """S15: черновик элемента с нерешённой находкой «Нашлось в библиотеке» ждёт решения автора (reuse_api.holds)."""
    try:
        return rsapi().holds(sys.modules[__name__], job)
    except Exception as e:
        print("! reuse holds:", e)
        return False


def _waits_for(job):
    """Сцену / локацию препродакшена рисуем после ВСЕХ персонажей и пропсов видео (автор: «без ассетов локации не соберёшь»): пока у любого из них идёт или ждёт задача — сцена ждёт."""
    if job.kind not in ("element", "make3d") or not job.key.startswith("plan:"):
        return False
    try:
        d = load(job.key)
        e = _by_id(d.get("elements"), job.params.get("el"))
        mo = preprod.main_of(e, d) if e and e.get("kind") in ("char", "prop") and not e.get("renders") else None
        if mo and not preprod.el_render(mo):                # S18: первый черновик вариации — от основного образа: ждём, пока его рисуют
            return any(j is not job and j.key == job.key and j.status in ("running", "queued") and (j.params or {}).get("el") == mo["id"]
                       and j.kind in ("element", "make3d", "charparts", "charmodel") for j in JOBS.values())
        if not e or e.get("kind") != "scene":
            return False
        cast = {x["id"] for x, _ in preprod.cast_of(e, d)}
        assets = {x["id"] for x in d.get("elements") or [] if x.get("kind") in ("char", "prop", "vfx")}   # все персонажи и пропсы видео — сначала они, потом места
    except Exception:
        return False
    scopes = {f"{p}:{i}" for i in cast for p in ("element", "charmodel")}
    if any(_held(Job("element", job.key, "element:" + i, {"el": i})) for i in cast):
        return True                                        # S15: кто-то из состава ждёт решения «Нашлось в библиотеке» — место ждёт его
    return any(j is not job and j.key == job.key and j.status in ("running", "queued")
               and (j.scope in scopes or (j.params or {}).get("el") in assets) for j in JOBS.values())


def _pump():
    """Очередь задач Claude: ждущие (queued) запускаются по порядку, пока свободных мест меньше max_jobs(); сцены — после своего состава."""
    with _PUMP:
        busy = sum(1 for j in JOBS.values() if j.status == "running" and j.kind not in LOCAL_KINDS)
        for job in sorted((j for j in JOBS.values() if j.status == "queued"), key=lambda j: j.started):
            if busy >= max_jobs():
                break
            if getattr(job, "retry_at", 0) > time.time():      # S22: повтор после перегрузки / лимита Claude — ждёт своего времени
                continue
            if _held(job):
                job.summary = "ждёт решения: 📚 нашлось в библиотеке"
                continue
            if _waits_for(job):
                job.summary = "ждёт: сначала основной образ, персонажи и пропсы, потом места"
                continue
            job.status, job.started, job.summary = "running", time.time(), ""
            busy += 1
            threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    _persist()


def start_job(kind, key, scope, params):
    live = [j for j in JOBS.values() if j.status in ("running", "queued")]
    if any(j.key == key and j.scope == (scope or kind) for j in live):
        raise RuntimeError("эта задача уже идёт или ждёт в очереди")
    if kind not in LOCAL_KINDS and not claude_bin():
        raise RuntimeError("не найден Claude Code (claude.exe)")
    job = Job(kind, key, scope, params)
    JOBS[job.id] = job
    if kind in LOCAL_KINDS:
        threading.Thread(target=_run_job, args=(job,), daemon=True).start()
    else:                                                  # S12.13: лишние не отклоняются — ждут в очереди (status queued), _pump запускает по мере освобождения
        job.status, job.summary = "queued", "в очереди"
        _pump()
    _persist()
    for jid in [i for i, j in JOBS.items() if j.finished and time.time() - j.finished > 1800]:
        JOBS.pop(jid, None)
    return job


_RE_BUSY = re.compile(r"\b529\b|overloaded|API Error: 5\d\d|internal server error", re.I)
_RE_LIMIT = re.compile(r"session limit|usage limit|limit reached|hit your [\w ]*limit", re.I)


def _retry_after(err, tries):
    """S22: через сколько секунд повторить задачу Claude, упавшую не по своей вине, или None.
    529 / перегрузка — через 1, 2, 3 мин (3 попытки); лимит сессии — после сброса из текста ошибки («resets 10:10pm») + 2 мин (2 попытки)."""
    if _RE_BUSY.search(err) and tries < 3:
        return 60 * (tries + 1)
    if _RE_LIMIT.search(err) and tries < 2:
        m = re.search(r"resets\s+(\d{1,2})(?::(\d\d))?\s*(am|pm)?", err, re.I)
        if not m:
            return 3600
        h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
        h = h % 12 + (12 if ap == "pm" else 0) if ap else h
        now = time.localtime()
        at = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, h, mi, 0, 0, 0, -1))
        if at <= time.time():
            at += 86400
        return at - time.time() + 120
    return None


def _run_job(job):
    kind0, params0 = job.kind, dict(job.params or {})   # make3d подменяет kind / params по ходу — повтор начинает с исходных
    try:
        if job.kind == "produce":
            produce(job)
        elif job.kind == "sndfetch":
            sound_fetch(job)
        elif job.kind == "refparse":
            ref_parse(job)
        elif job.kind in ("refbase", "beatmap", "reftopics"):  # S16: референс подачи — разбор, карта битов, похожие темы
            rbapi().run_job(sys.modules[__name__], job)
        elif job.kind == "assetfetch":
            asset_fetch(job)
        elif job.kind == "layout3d":
            layout3d(job)
        elif job.kind.startswith("lib"):
            stapi().run_job(sys.modules[__name__], job)
        elif job.kind.startswith("scene"):
            scapi().run_job(sys.modules[__name__], job)
        elif job.kind in ("charmodel", "assetupload", "comfysetup"):              # S9+: герой из 3D-модели (ассет / Meshy / Tripo), своя модель
            m3d().run_job(sys.modules[__name__], job)
        elif job.kind in ("lookprev", "lookhero", "lookq", "lookbuild"):    # S14: визуалы канала — превью, герой лука, интервью, ✨ сборка
            ljapi().run_job(sys.modules[__name__], job)
        elif job.kind in ("chanq", "chanstyle", "chanhero", "chancaps", "changuide"):    # S9: интервью канала, сборка стиля, герой канала; раздел гайда
            chnapi().run_job(sys.modules[__name__], job)
        elif job.kind in ("voicesplit", "voicetts"):          # 🎙 голос ролика (S11): нарезка записи / черновой голос
            vcapi().run_job(sys.modules[__name__], job)
        elif job.kind == "clips":                              # S13.4: клипы сцен (видео на локациях)
            clapi().render(sys.modules[__name__], job)
        elif job.kind == "fastmontage":                        # ⚡ быстрый монтаж: план (Opus) -> сцены параллельно (Sonnet) -> сводка (Opus в панели)
            fsapi().run(sys.modules[__name__], job)
        elif job.kind == "automontage":                        # «Сделать монтаж» без препродакшена: локации -> черновики -> агент -> дорисовка
            lcapi().auto_montage(sys.modules[__name__], job)
        elif job.kind in ("ytsync", "ytlogin", "ytvideo", "ytlearn"):   # S17: YouTube — синк, вход, разбор ролика, «что работает»
            ytapi().run_job(sys.modules[__name__], job)
        elif job.kind == "memlearn":                           # ✨ Научиться на моих правках (Память): Claude предлагает правила
            mmapi().learn(sys.modules[__name__], job)
        elif job.kind == "make3d":                             # ✨ Сделать 3D (S12.11): Claude выбирает способ -> element / charparts / charmodel
            mk3d().run(sys.modules[__name__], job)
        elif job.kind == "brollfetch":                         # 🎞 B-roll элемента (S12.6): кусок видео -> files/<id>/broll_<el>.mp4
            vdapi().run_broll(sys.modules[__name__], job)
        elif job.kind == "mediaadd":                           # 🎞 видео кадрами для экранов (S10.3)
            mdapi().run_job(sys.modules[__name__], job)
        elif job.kind == "montagebuild":                       # монтаж (S6): генератор + build.sh
            mnapi().run_job(sys.modules[__name__], job)
        elif job.kind in ("charrig", "charemotions"):          # персонажи (S4): сохранение скелета, эмоции; charparts — обычная задача Claude ниже
            chapi().run_job(sys.modules[__name__], job)
        else:
            run_action(job)
        job.status = "done"
        try:
            chmapi().on_job_done(sys.modules[__name__], job)    # звук «готово» — сервер сам, через Windows
        except Exception as e:
            print("! chime:", e)
        if job.kind in ("element", "make3d", "charparts", "charmodel", "trellisfix") and job.key.startswith("plan:") and (job.params or {}).get("el"):
            try:                                               # готовый черновик подменяет заглушку в сценах монтажа (S13)
                if load(job.key).get("locations"):
                    lcapi().on_element_ready(sys.modules[__name__], job.key[5:], job.params["el"])
            except Exception as e:
                print("! on_element_ready:", e)
    except Exception as e:
        job.status = "cancelled" if job.cancelled else "error"
        job.error = str(e) or type(e).__name__
        wait = None if job.cancelled or kind0 in LOCAL_KINDS else _retry_after(job.error, getattr(job, "tries", 0))
        if wait:                                            # S22: Claude перегружен / лимит сессии — сама встанет в очередь, а не красная ошибка
            job.tries = getattr(job, "tries", 0) + 1
            job.retry_at = time.time() + wait
            job.kind, job.params, job.status = kind0, params0, "queued"
            job.summary = (f"повтор в {time.strftime('%H:%M', time.localtime(job.retry_at))}: "
                           + ("Claude перегружен" if _RE_BUSY.search(job.error) else "лимит сессии — после сброса"))
            try:
                with open(os.path.join(JOBS_DIR, "log.txt"), "a", encoding="utf-8") as f:
                    f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{kind0}\t{job.key}\tretry\t{time.time() - job.started:.1f}s\t{json.dumps(job.meta, ensure_ascii=False)}\t{job.error}\n")
            except OSError:
                pass
            job.error = None
            t = threading.Timer(wait + 1, lambda: _pump())
            t.daemon = True
            t.start()
            _persist()
            return
    job.finished = time.time()
    try:
        _pump()                                                # (и _persist: задача ушла из живых)
    except Exception:
        pass
    if job.status in ("done", "error"):
        try:
            ntapi().on_job(sys.modules[__name__], job)          # S20.5: лента 🔔
        except Exception as e:
            print("! notify:", e)
    try:
        os.makedirs(JOBS_DIR, exist_ok=True)
        with open(os.path.join(JOBS_DIR, "log.txt"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{job.kind}\t{job.key}\t{job.status}\t{job.finished - job.started:.1f}s"
                    f"\t{json.dumps(job.meta, ensure_ascii=False)}\t{job.error or job.summary}\n")
    except OSError:
        pass


def auto_tick():
    """Every minute from the server: S17 — YouTube-данные старше 6 ч обновляются сами (вехи разборов Claude)."""
    ytapi().tick(sys.modules[__name__])


def _docs(key):
    try:
        port = int(open(os.path.join(DATA, ".port")).read().strip())
    except (OSError, ValueError):
        port = 8790
    plan = load(key) if key.startswith("plan:") else None
    ch = (P.channel(P.index()["videos"].get(key[5:], {}).get("channel")) if plan else None)         or (P.channel(key[8:]) if key.startswith("channel:") and key[8:] else None) or P.channel() or {}   # S20: сессия канала — свой канал
    mem = ""
    try:
        mem = mmapi().prompt_text(ch.get("id"), plan.get("id") if plan else None) if ch else ""   # + правила «одно видео» этого видео
    except Exception:
        pass
    return {"plan": plan, "channel": ch, "brand": channel_brand(ch), "memory": mem, "bank": {"items": []}, "stats": {"items": []},
            "key": key, "data": DATA, "save": save_file, "port": port, "here": HERE, "root": ROOT, "pipe": PIPE, "sound": fetch_sound}


def channel_brand(ch):
    """The channel for the prompts (what the old «лист проекта» gave): name + the first lines of its style guide."""
    guide = ""
    try:
        with open(os.path.join(ch["dir"], "style", "style-guide.md"), encoding="utf-8") as f:
            guide = f.read()[:1500]
    except (OSError, KeyError, TypeError):
        pass
    refs = [(r.get("url") or r.get("img") or "") + (f" — {r['note']}" if r.get("note") else "") for r in (ch or {}).get("refs") or [] if r.get("url") or r.get("img")]
    about = (ch or {}).get("about", "") + (("\nРеференсы канала (вкладка «Обзор»): " + "; ".join(refs)) if refs else "")
    return {"name": (ch or {}).get("name", ""), "bring": about, "differ": "", "killer": guide, "never": ""}


def rel_data(path):
    """A path on disk -> how documents write it (files/<id>/…, render/<id>/…)."""
    return P.rel_of(path)


def fetch_sound(pid, url, start=None, end=None, by="me", why=""):
    """Download a sound into _ideas/files/<plan>/sfx/N.wav -> the element's sound item."""
    r = sapi().fetch(url, os.path.join(P.files(pid), "sfx"), start, end)
    return {"id": new_id("s"), "file": rel_data(r["file"]), "title": (r.get("title") or "")[:160], "author": r.get("author", ""),
            "license": r.get("license", ""), "page": r.get("page", ""), "src": r.get("src", ""), "url": url, "dur": r.get("dur"),
            "peak_t": r.get("peak_t"), "rms_db": r.get("rms_db"), "start": r.get("start"), "end": r.get("end"), "by": by, "why": why, "ts": now_ms()}


def sound_fetch(job):
    """⬇ from the page: a sound by link (or a search result) into an element."""
    key, eid, url = job.key, job.params.get("el"), (job.params.get("url") or "").strip()
    if not url:
        raise ValueError("нет ссылки")
    e = _by_id(load(key).get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    job.summary = "качаю звук…"
    item = fetch_sound(key[5:], url, job.params.get("start"), job.params.get("end"), by="me")
    ops = [{"op": "add", "path": ["elements", eid, "sounds"], "item": item}]
    if not pr().el_mix(_by_id(load(key).get("elements"), eid)):     # nothing chosen yet: this sound becomes the one layer
        ops += [{"op": "set", "path": ["elements", eid, "mix"], "value": [{"id": new_id("l"), "sid": item["id"], "at": 0, "gain": 1, "note": ""}]},
                {"op": "set", "path": ["elements", eid, "sound"], "value": item["id"]}]
    apply_ops(key, ops)
    job.result = item
    job.summary = f"Звук скачан: «{item['title'][:60]}» · {item['dur']} с"


def ref_parse(job):
    """📼 A reference video: title at once, then contact sheets + transcript into <видео>/files/ref_<id>/, summary into refs[].parse (refs_api.run)."""
    def log(t):
        job.summary = t
    job.summary = rapi().run(sys.modules[__name__], job.key, job.params.get("ref"), log)


def asset_fetch(job):
    """🔎 A free asset into an element: «ref» — its preview picture into refs[], «work» — the asset itself into
    _ideas/files/<plan>/assets/<id>/ + assets[] (glTF for w.model, picture for PICS, texture maps)."""
    key, eid, row = job.key, job.params.get("el"), job.params.get("row") or {}
    e = _by_id(load(key).get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    src, aid = row.get("src", ""), str(row.get("id", ""))
    if not src or not aid:
        raise ValueError("нет ассета")
    pid, A = key[5:], aapi()
    who = " · ".join(x for x in (A.NAMES.get(src, src), row.get("license"), row.get("author")) if x)
    if job.params.get("as") == "ref":
        job.summary = "качаю превью…"
        img = save_file(pid, A.preview(row.get("thumb") or row.get("url")))
        item = {"id": new_id("f"), "img": img, "note": f"{row.get('title', '')} — {who}"[:200], "src": row.get("page", ""), "asset": f"{src}:{aid}"}
        apply_ops(key, [{"op": "add", "path": ["elements", eid, "refs"], "item": item}])
        job.result = item
        job.summary = f"В референсы: «{row.get('title', '')[:60]}»"
        return
    iid = new_id("a")
    dst = os.path.join(P.files(pid), "assets", iid)

    def log(t):
        job.summary = t
    try:
        r = A.fetch(src, aid, dst, row, DATA, log)
    except Exception:
        shutil.rmtree(dst, ignore_errors=True)
        raise
    prev = ""
    try:
        if row.get("thumb"):
            prev = save_file(pid, A.preview(row["thumb"]))
    except Exception:
        pass
    item = {"id": iid, "src": src, "sid": aid, "title": (r.get("title") or row.get("title") or "")[:140], "kind": r["kind"], "fmt": r["fmt"],
            "license": r.get("license", ""), "attr": bool(r.get("license")) and not A._free(r.get("license")), "author": r.get("author", ""),
            "page": r.get("page", ""), "dir": rel_data(dst), "main": rel_data(r["main"]), "files": len(r["files"]), "size": r.get("size", 0),
            "preview": prev, "note": r.get("note", ""), "why": "", "ts": now_ms()}
    if r["kind"] == "3d":                                       # S9+: чистый glb + скелет и анимации модели (Draco, fbx, obj — через Blender)
        job.summary = "Blender проверяет модель: скелет, анимации…"
        m3d().asset_item_3d(sys.modules[__name__], pid, dst, r["main"], item)
    apply_ops(key, [{"op": "add", "path": ["elements", eid, "assets"], "item": item}])
    job.result = item
    job.summary = f"Ассет в работе: «{item['title'][:60]}» ({item['fmt']}, {round(item['size'] / 2**20, 1)} МБ)"


LAYOUT_MARK = "// ==== расстановка автора"


def layout_code(lay, auto=(), groups=None):
    """The author's layout as the last lines of element.js (stage3d.js: w.groups -> regroup after build, w.layout on top of the code)."""
    rows = lambda d: ",\n".join(f"    {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in d.items())
    note = (f"\n// Имена без name в коде (по порядку создания): {', '.join(auto)} — правя сцену, дай этим объектам name: '…' как здесь." if auto else "")
    grp = (f"  w.groups = {{   // группы автора: имя -> части (null — автогруппа разобрана)\n{rows(groups)}\n  }};\n" if groups else "")
    return (f"{LAYOUT_MARK} (🧊 «✋ Двигать» в Штурме): p — сдвиг [x, y, z] м, r — поворот по Y (рад), s — масштаб, hide — скрыт;\n"
            f"// группа двигается, крутится вокруг своего центра и масштабируется целиком. Применяется поверх кода выше, каждый кадр после update().\n"
            f"// Перенося сцену в ролик, перенеси и этот блок (мир.groups = …; мир.layout = …).{note}\n"
            f"{{\n  const w = typeof WORLD !== 'undefined' ? WORLD : X3.worlds[0];\n{grp}  w.layout = {{\n{rows(lay)}\n  }};\n}}\n")


def layout_text(lay):
    out = []
    for k, v in lay.items():
        p, bits = v.get("p") or [0, 0, 0], []
        if any(abs(x) > 0.001 for x in p):
            bits.append("сдвиг " + ", ".join(f"{a} {x:+.2f}" for a, x in zip("xyz", p) if abs(x) > 0.001) + " м")
        if abs(v.get("r") or 0) > 0.001:
            bits.append(f"поворот {round(v['r'] * 180 / 3.14159265)}°")
        if abs((v.get("s") or 1) - 1) > 0.001:
            bits.append(f"×{v['s']:.2f}")
        if v.get("hide"):
            bits.append("скрыт")
        out.append(f"{k}: {', '.join(bits)}")
    return "; ".join(out)


def groups_text(groups):
    return "; ".join(f"группа «{k}» ({len(v)})" if isinstance(v, list) else f"«{k}» разгруппирована" for k, v in (groups or {}).items())


def layout3d(job):
    """✋ The author moved things in the 3D viewer: a new draft version = the same element.js + WORLD.layout, shot again (no Claude)."""
    key, eid = job.key, job.params.get("el")
    lay = {str(k): v for k, v in (job.params.get("layout") or {}).items() if isinstance(v, dict)}
    groups = {str(k): ([str(x) for x in v] if isinstance(v, list) else None) for k, v in (job.params.get("groups") or {}).items()
              if v is None or isinstance(v, list)}
    plan = load(key)
    e = _by_id(plan.get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    rs = e.get("renders") or []
    base = _by_id(rs, job.params.get("base")) or _by_id(rs, e.get("render")) or (rs[-1] if rs else None)
    if not base or not base.get("three"):
        raise ValueError("у элемента нет 3D-черновика")
    src = os.path.join(P.resolve("render/" + base["dir"]), "element.js")
    code = open(src, encoding="utf-8").read()
    i = code.find(LAYOUT_MARK)
    if i >= 0:
        code = code[:i].rstrip() + "\n"
    if lay or groups:
        used = set(lay) | {n for v in groups.values() if v for n in v}
        code = code.rstrip() + "\n\n" + layout_code(lay, [a for a in job.params.get("auto") or [] if a in used], groups)
    v = max([r.get("v", 0) for r in rs] + [0]) + 1
    rel = f"{plan['id']}/{eid}/v{v}"
    wd = P.resolve("render/" + rel)
    os.makedirs(wd, exist_ok=True)
    write_text(os.path.join(wd, "element.js"), code)
    job.summary = "снимаю кадры новой расстановки…"
    url = f"http://127.0.0.1:{_docs(key)['port']}/tpl/stand3d.html?scene=/rscene/{rel}/element.js&parts=element"
    r = subprocess.run(["node", os.path.join(P.STANDS, "render_shot.js"), url, wd, "0.2,2.5"], cwd=P.STANDS, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    main = os.path.join(wd, "element.png")
    if not os.path.isfile(main):
        raise RuntimeError("кадр не снялся: " + (r.stdout + r.stderr).strip()[-300:])
    img = save_file(plan["id"], open(main, "rb").read())
    extra = [save_file(plan["id"], open(os.path.join(wd, f), "rb").read()) for f in sorted(os.listdir(wd)) if f.startswith("element_") and f.endswith(".png")]
    txt = "; ".join(t for t in (groups_text(groups), layout_text(lay)) if t)
    item = {"id": new_id("r"), "v": v, "dir": rel, "img": img, "extra": extra, "feedback": "✋ расстановка: " + (txt or "всё как в коде"),
            "fx": {}, "fn": base.get("fn", ""), "summary": base.get("summary", ""), "note": "", "three": True, "layout": lay, "groups": groups, "by": "layout", "ts": now_ms()}
    apply_ops(key, [{"op": "add", "path": ["elements", eid, "renders"], "item": item}, {"op": "set", "path": ["elements", eid, "render"], "value": item["id"]}])
    job.result = item
    job.summary = f"«{e.get('name', '')}» v{v}: расстановка сохранена" + (" · есть ошибки страницы" if "[pageerror]" in r.stdout + r.stderr else "")


def run_action(job):
    C = capi()
    spec = C.build(job.kind, _docs(job.key), job.params)
    if job.kind in VISUAL_ACTIONS:
        spec.setdefault("model", VISUAL_MODEL)
        if VISUAL_EFFORT:
            spec.setdefault("effort", VISUAL_EFFORT)
    else:
        spec.setdefault("model", TEXT_MODEL)
        if job.kind in TEXT_EFFORT:
            spec.setdefault("effort", TEXT_EFFORT[job.kind])
    job.result = run_claude(job, spec)
    changes, job.summary = C.apply(job.kind, _docs(job.key), job.params, job.result)   # fresh docs: the page kept editing
    for key, ops in changes:
        if ops:
            apply_ops(key, ops)
    if job.kind == "element" and not job.cancelled:
        auto_stage(job)
    if job.kind == "elements" and not job.cancelled:      # S15: новые персонажи, пропсы, звуки -> поиск в библиотеке и прошлых видео
        for key, ops in changes:
            rsapi().after_elements(sys.modules[__name__], key, ops)
    for eid in job.params.get("_spawn") or []:             # S12.13: «Разделить модели» / «Вариации» -> черновики новых пропсов в очередь
        try:
            start_job("element", job.key, "element:" + eid, {"el": eid})
        except Exception:
            pass


def auto_stage(job):
    """Нарисованная 3D-сцена сразу уходит в редактор (без кнопки «Перевести в редактор»): тот же перевод scene_api.convert —
    prefabs.js + scene.json и сравнение кадров «было / стало», в этой же задаче (отмена задачи отменяет и перевод)."""
    el = job.params.get("el")
    e = _by_id(load(job.key).get("elements"), el)
    if not e or e.get("kind") != "scene" or (e.get("stage") or {}).get("work"):
        return
    rs = e.get("renders") or []
    r = next((x for x in rs if x.get("id") == e.get("render")), rs[-1] if rs else None)
    if not r or not r.get("three") or r.get("stage"):
        return
    drawn, params = job.summary, job.params
    job.summary = (drawn + " · " if drawn else "") + "переношу в редактор сцены (5–10 мин)…"
    try:
        job.params = {"el": el, "base": r["id"]}
        scapi().convert(sys.modules[__name__], job)
        job.summary = (drawn + " · " if drawn else "") + "🎬 " + job.summary

    except Exception as ex:
        job.summary = (drawn + " · " if drawn else "") + f"в редактор не перенёс ({ex}) — кнопка «🎬 Перевести в редактор»"
    finally:
        job.params = params


def produce(job):
    """«🚀 Начать производство»: проект ролика (шаблон + движок, new_project.py --into) прямо в папке видео,
    всё видео — в refs/штурм.md (+ картинки в refs/штурм/), препродакшен — в refs/препродакшен/. До переезда — отдельная папка, как раньше."""
    pid = job.key[5:]
    doc = load(job.key)
    vdir = None if P.legacy() else P.video(pid)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    if vdir:
        dst, name = vdir, os.path.basename(vdir)
        if not os.path.isfile(os.path.join(dst, "build.sh")):
            job.summary = "кладу шаблон ролика и ставлю зависимости…"
            r = subprocess.run([sys.executable, os.path.join(PIPE, "new_project.py"), "--into", dst], cwd=ROOT, env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if not os.path.isfile(os.path.join(dst, "build.sh")):
                raise RuntimeError("new_project.py: " + (r.stdout + r.stderr).strip()[-400:])
        write_text(os.path.join(dst, "src", "format.js"), lkapi().format_js(sys.modules[__name__], doc))   # кадр (16:9 у длинного) + визуал канала (window.LOOK, S14)
    else:
        name = (job.params.get("name") or "").strip().rstrip(".")
        if not name or any(c in name for c in BAD_NAME):
            raise ValueError("в названии проекта нельзя: " + " ".join(BAD_NAME))
        dst = os.path.join(ROOT, name)
        if os.path.exists(dst) and not job.params.get("attach"):
            raise ValueError(f"папка «{name}» уже есть — можно привязать к ней")
        if not os.path.exists(dst):
            job.summary = "создаю проект и ставлю зависимости…"
            r = subprocess.run([sys.executable, os.path.join(PIPE, "new_project.py"), name], cwd=ROOT, env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if not os.path.isdir(dst):
                raise RuntimeError("new_project.py: " + (r.stdout + r.stderr).strip()[-400:])
    refs = os.path.join(dst, "refs")
    pics = os.path.join(refs, "штурм")
    os.makedirs(refs, exist_ok=True)
    for rel in plan_images(doc):
        src = P.resolve(rel)
        if os.path.isfile(src):
            os.makedirs(pics, exist_ok=True)
            shutil.copy2(src, os.path.join(pics, flat(rel)))
    where, folders = pr().export(doc, DATA, dst, os.path.join(P.STANDS, "paper.js"))
    write_text(os.path.join(refs, "штурм.md"), plan_md(doc, img=lambda p: "refs/штурм/" + flat(p), where=where, folders=folders))
    with open(os.path.join(refs, "штурм.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    ops = [{"op": "set", "path": ["project"], "value": name}, {"op": "set", "path": ["stage"], "value": "script"}]
    if doc.get("status") == "draft":
        ops.append({"op": "set", "path": ["status"], "value": "prod"})
    apply_ops(job.key, ops)
    job.result = {"project": name, "path": dst}
    n = len([e for e in doc.get("elements") or [] if e.get("status") != "drop"])
    job.summary = f"Проект ролика готов в «{name}», видео целиком — в refs/штурм.md" + (f", препродакшен ({n}) — в refs/препродакшен" if n else "")


# ---------------- HTTP ----------------
def trusted(h, post=False):
    """Only the service's own page: Host localhost (DNS rebinding), and for POST a custom header + local Origin (CSRF)."""
    host = (h.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
    if host not in ("localhost", "127.0.0.1"):
        return False
    if post:
        o = h.headers.get("Origin")
        if h.headers.get("X-Ideas") != "1" or (o and urlparse(o).hostname not in ("localhost", "127.0.0.1")):
            return False
    return True


def thumb_path(src, w=240):
    """src — адрес картинки как у страницы (/files/…, /render/…, /api/lib/file/<канал>/…) -> JPEG шириной w (кэш .studio/cache/thumbs)."""
    import hashlib
    w = max(60, min(int(w or 240), 800))
    src = unquote(src or "")
    path = ""
    if src.startswith("/api/lib/file/"):
        m = re.match(r"/api/lib/file/((?:video:)?[a-z0-9-]+)/(.+)$", src)
        if m:
            cid = m.group(1)
            if cid.startswith("video:"):
                cid = P.index()["videos"].get(cid[6:], {}).get("channel")
            st = stapi()
            c = st.channel_dir(cid) if cid else None
            if c:
                base = os.path.realpath(st.lib_dir(c))
                cand = os.path.realpath(os.path.join(base, m.group(2)))
                path = cand if cand.startswith(base) else ""
    else:
        rel = src.lstrip("/").split("?")[0]
        if rel.startswith(("files/", "render/")) and ".." not in rel:
            try:
                path = P.resolve(rel)
            except Exception:
                path = ""
    if not path or not os.path.isfile(path) or os.path.splitext(path)[1].lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        return ""
    key = hashlib.sha1(f"{path}|{os.path.getmtime(path)}|{w}".encode("utf-8")).hexdigest()
    out = os.path.join(P.STATE, "cache", "thumbs", key + ".jpg")
    if not os.path.isfile(out):
        from PIL import Image
        os.makedirs(os.path.dirname(out), exist_ok=True)
        im = Image.open(path)
        im.thumbnail((w, w * 2))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (40, 40, 44))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im.convert("RGB").save(out, "JPEG", quality=82)
    return out


def _send_file(h, path):
    """Whole file, or a byte range (audio/video players seek with Range requests)."""
    size = os.path.getsize(path)
    ctype = MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
    m = re.match(r"bytes=(\d*)-(\d*)", h.headers.get("Range") or "")
    if m and (m.group(1) or m.group(2)) and size:
        a = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
        b = min(size - 1, int(m.group(2))) if m.group(1) and m.group(2) else size - 1
        if a >= size:
            h.send_response(416); h.send_header("Content-Range", f"bytes */{size}"); h.end_headers(); return
        with open(path, "rb") as f:
            f.seek(a)
            data = f.read(b - a + 1)
        h.send_response(206)
        h.send_header("Content-Range", f"bytes {a}-{b}/{size}")
    else:
        with open(path, "rb") as f:
            data = f.read()
        h.send_response(200)
    h.send_header("Content-Type", ctype)
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(len(data)))
    h.end_headers()
    try:
        h.wfile.write(data)
    except (ConnectionError, OSError):             # the player dropped the connection (seek) — fine
        pass


def _static(h, base, rel):
    rel = os.path.normpath(unquote(rel)).replace("\\", "/")
    f = os.path.join(base, rel)
    if rel.startswith("..") or os.path.isabs(rel) or not os.path.isfile(f):
        h.send_error(404)
    else:
        _send_file(h, f)
    return True


def backups_dir(vid):
    """<видео>/.backups (до переезда — _ideas/trash)."""
    d = os.path.join(P.LEGACY, "trash") if P.legacy() else os.path.join(P.video(vid) or os.path.join(DATA, "orphan", vid), ".backups")
    os.makedirs(d, exist_ok=True)
    return d


def web_mtime():
    fs = [os.path.join(WEB, f) for f in os.listdir(WEB)]
    ui = os.path.join(WEB, "ui")                       # S12: оболочка и дизайн-система — web/ui/
    if os.path.isdir(ui):
        fs += [os.path.join(ui, f) for f in os.listdir(ui)]
    return max((os.path.getmtime(f) for f in fs), default=0)


def handle_get(h):
    u = urlparse(h.path)
    p, q = u.path, parse_qs(u.query)
    if p.startswith("/api/") and not trusted(h):
        h.send_error(403); return True
    if p.startswith("/api/talk/") and tkapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p == "/api/thumb":                              # маленькое превью картинки (окна выбора ассетов: сотни черновиков 1080×1920 разом вешали окно)
        f = thumb_path(q.get("src", [""])[0], int((q.get("w") or ["240"])[0] or 240))
        if not f:
            h.send_error(404); return True
        _send_file(h, f); return True
    if p == "/api/voice/state":                        # 🎙 голос: сцены сценария, файлы, откуда голос, записи диктора
        h._json(vcapi().state(sys.modules[__name__], q.get("video", [""])[0])); return True
    if p == "/api/voice/text":                         # 🎤 текст для диктора: сцены, как читать, как записать
        h._json(vcapi().actor_text(sys.modules[__name__], q.get("video", [""])[0])); return True
    if p == "/api/voice/audio":                        # 🎙 послушать: сцена (i) или исходная запись (rec)
        f = vcapi().audio_path(sys.modules[__name__], q.get("video", [""])[0], q.get("i", [None])[0], q.get("rec", [None])[0])
        if not f:
            h.send_error(404); return True
        _send_file(h, f); return True
    if p == "/api/script/state":                       # 📝 вкладка «Сценарий»: открытые правки раскадровки, заглушка ли script.md
        h._json(mnapi().script_state(q.get("video", [""])[0])); return True
    if p == "/api/imgsearch":                          # 🔎 поиск картинок для референсов: Яндекс (без ключа) | свободные (Openverse + Commons)
        try:
            h._json({"items": _fresh(__import__("imgsearch"), "imgsearch").search(q.get("q", [""])[0], q.get("src", ["ya"])[0], int(q.get("p", ["0"])[0] or 0))})
        except Exception as e:
            h._json({"error": str(e) if isinstance(e, ValueError) else f"поиск не ответил: {e}"}, 502)
        return True
    if p.startswith("/api/videos/") and vdapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/renders") and rdapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/thumbs/") and thapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/yt") and ytapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/memory") and mmapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/notify") and ntapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/act") and acapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/make3d/") and mk3d().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p.startswith("/api/clips/") and clapi().handle_get(sys.modules[__name__], h, p, q):
        return True
    if p == "/api/version":
        h._json({"api": API_VERSION, "data": DATA, "web": web_mtime()}); return True
    if p == "/api/state":
        ch = P.channel()
        h._json({"api": API_VERSION, "data": DATA, "root": ROOT, "claude": bool(claude_bin()), "model": MODEL, "legacy": P.legacy(), "blender": bool(P.blender()),
                 "channels": [{k: c.get(k) for k in ("id", "name", "icon", "lang", "formats")} for c in P.channels()],
                 "channel": ch and {k: v for k, v in ch.items() if k != "dir"},
                 "plans": [dict(plan_summary(d), stage=d.get("stage") or "idea", folder=d.get("_folder"), channel=d.get("_channel"))
                           for d in plans(ch["id"] if ch else None) if not d.get("service")]}); return True   # служебное (🛠 Мастерская) — не в списке роликов
    if p == "/api/revs":
        _pump()
        jobs = [j.info() for j in JOBS.values() if j.status in ("running", "queued") or time.time() - j.finished < 90]
        out = {"docs": all_revs(), "jobs": jobs, "web": web_mtime(), "api": API_VERSION}
        try:                                              # S20.5: 🔔 — число непрочитанных и время последнего (страница дочитывает ленту, когда оно меняется)
            nl = ntapi().listing(ntapi().channel_of(), 0, 1)
            out["notify"] = {"unread": nl["unread"], "last": nl["items"][0]["ts"] if nl["items"] else 0}
        except Exception as e:
            print("! notify revs:", e)
        vid = q.get("v", [""])[0]
        if vid:                                           # открытое видео: файлы проекта, которые меняют Claude и скрипты (голос, тайминги, сценарий, сцены)
            vd = P.video(vid) or ""
            out["proj"] = max([os.path.getmtime(f) for f in (os.path.join(vd, "src", "vo_timing.js"), os.path.join(vd, "script.md"), os.path.join(vd, "src", "scenes.js"),
                                                              os.path.join(vd, "build", "vo", "source.json")) if os.path.isfile(f)] or [0])
        h._json(out); return True
    if p == "/api/doc":
        try:
            h._json(load(q.get("key", [""])[0]))
        except (KeyError, ValueError):
            h._json({"error": "нет такого документа"}, 404)
        return True
    if p == "/api/job":
        j = JOBS.get(q.get("id", [""])[0])
        h._json(j.info(full=True) if j else {"error": "нет такой задачи", "status": "gone"}, 200 if j else 404); return True
    if p.startswith("/api/studio/") or p.startswith("/api/lib"):
        try:
            if stapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p in ("/api/settings", "/api/local3d", "/api/flux"):
        stgapi().handle_get(sys.modules[__name__], h, p, q); return True
    if p.startswith("/api/looks/"):
        try:
            if lkapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p.startswith("/api/channel/"):
        try:
            if chnapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p == "/api/agent" or p.startswith("/api/agent/"):   # S12.4: и /api/agent/run, /api/agent/file
        try:
            if agapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p.startswith("/api/audio/"):                         # S23: панель «Звуки» монтажа
        try:
            if auapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p == "/api/montage" or p.startswith("/api/montage/"):
        try:
            if mnapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p in ("/api/char", "/api/chars", "/api/anims"):
        try:
            if chapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p.startswith("/api/scene"):
        try:
            if scapi().handle_get(sys.modules[__name__], h, p, q):
                return True
        except (KeyError, ValueError, OSError) as e:
            h._json({"error": str(e)}, 400); return True
    if p.startswith("/chfile/"):                              # S14: style/… канала простым путём (сцены и look.json визуалов для стендов): /chfile/<канал>/style/…
        m = re.match(r"/chfile/([a-z0-9-]{1,40})/(style/.+)$", unquote(p))
        c = m and P.channel(m.group(1))
        if not c or c["id"] != m.group(1):
            h.send_error(404); return True
        return _static(h, c["dir"], m.group(2))
    if p.startswith("/files/") or p.startswith("/rscene/"):   # files/<id>/… and render/<id>/… of a video (paths.resolve)
        m = re.match(r"/(files|rscene)/([a-z0-9-]{3,40})/(.+)$", unquote(p))
        if not m:
            h.send_error(404); return True
        return _static(h, P.files(m.group(2)) if m.group(1) == "files" else P.render(m.group(2)), m.group(3))
    if p.startswith("/fonts/"):
        return _static(h, FONTS, p[len("/fonts/"):])
    if p == "/api/sound/search":              # ⬇ candidates for a sound element (library, Freesound, Commons) — a few seconds
        q_ = (q.get("q", [""])[0] or "").strip()
        if not q_:
            h._json({"error": "пустой запрос"}, 400); return True
        h._json(sapi().search(q_, int(q.get("n", ["8"])[0]))); return True
    if p == "/api/assets/search":             # 🔎 free 3D / 2D / textures for a preproduction element — a few seconds
        q_ = (q.get("q", [""])[0] or "").strip()
        if not q_:
            h._json({"error": "пустой запрос"}, 400); return True
        h._json(aapi().search(q_, q.get("kind", ["3d"])[0], int(q.get("n", ["12"])[0]), data_dir=DATA)); return True
    if p == "/tpl/stand3d.html":              # 3D render stand is served under /tpl/, so its vendor/… paths resolve (engine/vendor)
        _send_file(h, os.path.join(P.STANDS, "stand3d.html")); return True
    if p.startswith("/render/"):              # the stands: page.html (2D), paper.js (the paper toolkit)
        return _static(h, P.STANDS, p[len("/render/"):])
    if p == "/tpl/editor.html":               # the scene editor (S1 Claude Studio): same trick, vendor/… of the template
        _send_file(h, os.path.join(WEB, "editor", "editor.html")); return True
    if p.startswith("/editor/"):
        return _static(h, os.path.join(WEB, "editor"), p[len("/editor/"):])
    if p.startswith("/tpl/"):                 # the engine (lib.js, stage3d.js, scene.js, vendor/…), then the video template src
        rel = p[len("/tpl/"):]
        return _static(h, P.ENGINE if os.path.exists(os.path.join(P.ENGINE, *unquote(rel).split("/"))) else TPL, rel)
    if p.startswith("/sfxlib/"):              # the pipeline sound library: /sfxlib/<category>/<id>.wav
        return _static(h, SFXLIB, p[len("/sfxlib/"):])
    return False


def handle_post(h):
    u = urlparse(h.path)
    p, q = u.path, parse_qs(u.query)
    if not trusted(h, post=True):
        h.send_error(403); return True
    try:
        if p == "/api/videos/brollup":                 # S12.6: файл B-roll с компьютера (сырые байты) -> files видео
            if int(h.headers.get("Content-Length", 0)) > 2 * 1024 * 2**20:
                h._json({"error": "файл больше 2 ГБ"}, 413); return True
            h._json(vdapi().broll_upload(sys.modules[__name__], q.get("id", [""])[0], q.get("el", [""])[0], q.get("name", ["clip.mp4"])[0], h._body())); return True
        if p == "/api/thumbs/upload":                  # S12.9: картинка на доску обложек (сырые байты)
            if int(h.headers.get("Content-Length", 0)) > 40 * 2**20:
                h._json({"error": "картинка больше 40 МБ"}, 413); return True
            h._json(thapi().upload(q.get("b", [""])[0], q.get("name", ["img.png"])[0], h._body())); return True
        if p == "/api/videos/voice":                   # S12: озвучка из поп-апа «Новое видео» (сырые байты) -> <видео>/refs/voice/
            if int(h.headers.get("Content-Length", 0)) > 600 * 2**20:
                h._json({"error": "запись больше 600 МБ — сожми в mp3 / m4a"}, 413); return True
            h._json(vdapi().save_voice(sys.modules[__name__], q.get("id", [""])[0], q.get("name", ["voice.wav"])[0], h._body())); return True
        if p == "/api/voice/upload":                   # 🎙 запись диктора целиком (сырые байты) -> refs/voice/
            size = int(h.headers.get("Content-Length", 0))
            if size > 600 * 2**20:
                h._json({"error": "запись больше 600 МБ — сожми в mp3 / m4a"}, 413); return True
            h._json({"file": vcapi().save_upload(sys.modules[__name__], q.get("video", [""])[0], q.get("name", ["voice.wav"])[0], h._body())}); return True
        if p == "/api/file":
            size = int(h.headers.get("Content-Length", 0))
            if size > FILE_MAX * 4 // 3 + 4096:
                h._json({"error": "картинка больше 12 МБ"}, 413); return True
            h._json({"path": save_file(q.get("plan", [""])[0], h._body())}); return True
        body = json.loads(h._body() or b"{}")
        if p == "/api/file/url":                       # 🔎 картинка по адресу (панель поиска, окно поиска, сайт); fallback — превью, если оригинал не отдают
            try:
                h._json({"path": file_from_url(body.get("plan", ""), body.get("url", ""))})
            except ValueError:
                if not body.get("fallback"):
                    raise
                h._json({"path": file_from_url(body.get("plan", ""), body["fallback"]), "thumb": True})
            return True
        if p == "/api/op":
            ops = body.get("ops")
            if not isinstance(ops, list):
                h._json({"error": "нет ops"}, 400); return True
            h._json(apply_ops(body.get("key", ""), ops)); return True
        if p.startswith("/api/videos/") and vdapi().handle_post(sys.modules[__name__], h, p, q, body):
            return True
        if p.startswith("/api/renders/") and rdapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/thumbs/") and thapi().handle_post(sys.modules[__name__], h, p, q, body):
            return True
        if (p == "/api/refs/base" or p.startswith("/api/beatmap/")) and rbapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/yt/") and ytapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/memory/") and mmapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/clips/") and clapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p == "/api/new":
            d = new_plan(body.get("mode", "short"), body.get("name", ""), body.get("topic", ""), channel=body.get("channel"))
            h._json({"id": d["id"], "flow": "idea"}); return True
        if (p.startswith("/api/studio/") or p.startswith("/api/lib") or p.startswith("/api/el/")) and stapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p == "/api/refparse":
            j = start_job("refparse", body.get("key", ""), "refparse:" + body.get("ref", ""), {"ref": body.get("ref", "")})
            h._json({"job": j.info()}); return True
        if p == "/api/refs/add":                       # бриф: одна или несколько ссылок / путь -> refs[] (+ разбор видео)
            items = rapi().add(sys.modules[__name__], body.get("key", ""), body.get("src", ""), body.get("note", ""))
            rapi().autoparse(sys.modules[__name__], body.get("key", ""))
            h._json({"items": items}); return True
        if p == "/api/sound/fetch":
            j = start_job("sndfetch", body.get("key", ""), f"sndfetch:{body.get('el', '')}:{body.get('url', '')}",
                          {k: body.get(k) for k in ("el", "url", "start", "end")})
            h._json({"job": j.info()}); return True
        if p == "/api/assets/upload":                   # ⬆ своя 3D-модель (base64)
            j = start_job("assetupload", body.get("key", ""), f"assetupload:{body.get('el', '')}", {k: body.get(k) for k in ("el", "name", "data", "license", "author", "page")})
            h._json({"job": j.info()}); return True
        if p.startswith("/api/talk/") and tkapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p in ("/api/voice/split", "/api/voice/tts"):  # 🎙 нарезать запись по сценам / черновой голос
            kind = "voicesplit" if p.endswith("split") else "voicetts"
            j = start_job(kind, "plan:" + body.get("video", ""), "voice", {"video": body.get("video", ""), "file": body.get("file", "")})
            h._json({"job": j.info()}); return True
        if p == "/api/media/add":                       # 🎞 видео (ссылка / файл, кусок с–по) -> кадры в библиотеку канала (S10.3)
            pr = {k: body.get(k) for k in ("src", "name", "from", "to", "fps", "h", "owner", "channel")}
            if not pr.get("channel") and body.get("key"):
                pr["channel"] = P.index()["videos"].get(body["key"][5:], {}).get("channel")
            j = start_job("mediaadd", body.get("key", ""), "mediaadd:" + (body.get("src") or "")[-40:], pr)
            h._json({"job": j.info()}); return True
        if p == "/api/local3d/setup":                  # 🖥 поставить / докачать ComfyUI Studio и модели TRELLIS.2 / Pixal3D (~23 ГБ)
            j = start_job("comfysetup", "", "comfysetup", {})
            h._json({"job": j.info()}); return True
        if p == "/api/char/model":                      # 🦴 герой из 3D-модели: source asset | meshy | tripo
            j = start_job("charmodel", body.get("key", ""), f"charmodel:{body.get('el', '')}", {k: body.get(k) for k in ("el", "source", "asset", "ref", "h", "skeleton", "body",
                                                                                                          # TRELLIS (локально): режим refine, база, движок, ракурсы, сиды, картинка для текстуры, сетка
                                                                                                          "mode", "base", "engine", "views", "reseed", "texref", "tex", "faces", "pad", "bg", "res", "stage", "why", "feedback", "crops")})
            h._json({"job": j.info()}); return True
        if p == "/api/assets/fetch":
            row = body.get("row") or {}
            j = start_job("assetfetch", body.get("key", ""), f"assetfetch:{body.get('el', '')}:{body.get('as', 'work')}:{row.get('src', '')}:{row.get('id', '')}",
                          {"el": body.get("el"), "as": body.get("as", "work"), "row": row})
            h._json({"job": j.info()}); return True
        if p == "/api/layout3d":
            j = start_job("layout3d", body.get("key", ""), f"layout3d:{body.get('el', '')}", {k: body.get(k) for k in ("el", "base", "layout", "groups", "auto")})
            h._json({"job": j.info()}); return True
        if p == "/api/delete":                  # the whole video folder goes to _archive/videos (nothing is deleted)
            key = body.get("key", "")
            if not key.startswith("plan:"):
                h._json({"error": "нет такого видео"}, 404); return True
            h._json(stapi().archive_video(sys.modules[__name__], key[5:])); return True
        if p == "/api/backup":                  # copy of video.json before «Начать заново» -> <видео>/.backups/<id>-backup-<ts>.json
            key = body.get("key", "")
            src = doc_path(key)
            if not key.startswith("plan:") or not os.path.exists(src):
                h._json({"error": "нет такого видео"}, 404); return True
            bdir = backups_dir(key[5:])
            name = f"{key[5:]}-backup-{now_ms()}.json"
            with _lock, FileLock():
                shutil.copy2(src, os.path.join(bdir, name))
            h._json({"file": name}); return True
        if p == "/api/restore":                 # bring a backup back; the current state is backed up first, so this is undoable too
            key, name = body.get("key", ""), body.get("file", "")
            bdir = backups_dir(key[5:]) if key.startswith("plan:") else ""
            if not bdir or not re.fullmatch(re.escape(key[5:]) + r"-backup-\d+\.json", name) or not os.path.isfile(os.path.join(bdir, name)):
                h._json({"error": "нет такой копии"}, 404); return True
            with open(os.path.join(bdir, name), encoding="utf-8") as f:
                old = json.load(f)
            with _lock, FileLock():
                cur = load(key)
                keep = f"{key[5:]}-backup-{now_ms()}.json"
                shutil.copy2(doc_path(key), os.path.join(bdir, keep))
                backups = [b for b in cur.get("backups", []) if b.get("file") != name]
                backups.append({"id": new_id("v"), "file": keep, "ts": now_ms(), "note": "перед возвратом прошлой версии"})
                old.update(rev=cur.get("rev", 0) + 1, updated=now_ms(), backups=backups, id=cur["id"])
                save(key, old)
            h._json({"ok": True, "rev": old["rev"]}); return True
        if p in ("/api/settings", "/api/local3d/stop", "/api/flux", "/api/flux/setup") and stgapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/ws/") and wsapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/channel/") and chnapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/looks/") and lkapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/pack/") and pkapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/agent/") and agapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/montage/") and mnapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/audio/") and auapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/char/") and chapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/scene/") and scapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p.startswith("/api/notify/") and ntapi().handle_post(sys.modules[__name__], h, p, body):
            return True
        if p == "/api/chime":                                 # послушать звук «готово» (Windows)
            chmapi().handle_post(sys.modules[__name__], h, p, body); return True
        if p == "/api/automontage":                          # «Сделать монтаж» без препродакшена (S13): локации -> черновики -> агент -> дорисовка задним числом
            j = start_job("automontage", "plan:" + body.get("video", ""), "automontage", {"wish": body.get("wish") or ""})
            h._json({"job": j.info()}); return True
        if p == "/api/claude":
            prm = body.get("params") or {}
            if body.get("action") == "element" and prm.get("base"):         # «Поправить» a scene that lives in the editor: the edits go to the scene agent
                e = _by_id(load(body.get("key", "")).get("elements"), prm.get("el")) or {}
                if e.get("kind") == "scene" and (e.get("stage") or {}).get("work"):
                    j = start_job("sceneagent", body.get("key", ""), body.get("scope", ""), scapi().card_edit_params(e))
                    scapi().LOCKS[scapi().skey(body.get("key", ""), e["id"])] = j.id
                    h._json({"job": j.info()}); return True
            if body.get("action") == "charparts" and prm.get("base"):      # S20.3: «Поправить» плоского персонажа словами «сделай объёмным» -> «Сделать 3D» с этими словами
                e = _by_id(load(body.get("key", "")).get("elements"), prm.get("el")) or {}
                cur = _by_id(e.get("renders"), prm.get("base")) or {}
                words = mk3d().author_words(e)
                if not cur.get("model3d") and any(mk3d().VOLUME.search(w) for w in words):
                    E = ["elements", e["id"], "fx", "main"]
                    apply_ops(body.get("key", ""), [{"op": "set", "path": E + ["notes"], "value": []}, {"op": "set", "path": E + ["text"], "value": ""}])
                    j = start_job("make3d", body.get("key", ""), body.get("scope", ""), {"el": e["id"], "wish": "; ".join(words)})
                    h._json({"job": j.info()}); return True
            j = start_job(body.get("action", ""), body.get("key", ""), body.get("scope", ""), prm)
            h._json({"job": j.info()}); return True
        if p == "/api/job/cancel" and q.get("id", [""])[0].startswith("agent:"):   # замок сцены от агента S7: «✕» в редакторе останавливает агента
            s = agapi().SESS.get(q["id"][0][6:])
            if s:
                s.stop()
            h._json({"ok": bool(s)}); return True
        if p == "/api/job/cancel":
            j = JOBS.get(q.get("id", [""])[0])
            if j and j.status == "queued":                      # из очереди — просто снять
                j.cancelled, j.status, j.finished, j.summary = True, "cancelled", time.time(), "снята из очереди"
                _pump()
                _persist()
            elif j and j.status == "running":
                j.cancelled = True
                if j.proc and j.proc.poll() is None:
                    P.kill_tree(j.proc)                        # S22: со всеми детьми
            h._json({"ok": bool(j)}); return True
        if p == "/api/produce":
            j = start_job("produce", "plan:" + body.get("id", ""), "produce", {"name": body.get("name", ""), "attach": bool(body.get("attach"))})
            h._json({"job": j.info()}); return True
    except KeyError:
        h._json({"error": "нет такого документа"}, 404); return True
    except (ValueError, RuntimeError, TimeoutError) as e:
        h._json({"error": str(e)}, 400); return True
    return False


# ---------------- CLI for Claude in a session ----------------
def _opt(argv, k, default=None):
    return argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else default


def _cli_reuse(key, ops=None, ids=None, force=False):
    """CLI add-elements / lib reuse-check -> поиск в библиотеке идёт задачей в очереди запущенной Studio (POST /api/lib/reuse/check):
    задача из процесса CLI умерла бы вместе с ним. Studio не запущена — пропуск (None)."""
    import urllib.request
    if ops is not None:
        ids = [o["item"]["id"] for o in ops if o["item"].get("kind") in rsapi().KINDS]
        if not ids:
            return None
    try:
        port = open(os.path.join(P.STATE, ".port"), encoding="utf-8").read().strip()
    except OSError:
        return None
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/lib/reuse/check", data=json.dumps({"key": key, "els": ids, "force": force}).encode(),
                                 headers={"Content-Type": "application/json", "X-Ideas": "1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        j = (json.loads(r.read()) or {}).get("job")
    return j and j.get("id")


def _plan_key(pid):
    key = "plan:" + pid
    try:
        if os.path.exists(doc_path(key)):
            return key
    except KeyError:
        pass
    sys.exit(f"нет видео {pid} (список: python studio.py list)")


def usage_report(days=7):
    """Сводка расхода Claude за N дней: журнал задач (.jobs/log.txt) + запуски агента (<видео>/agent.jsonl, «done»)."""
    import glob
    since = time.time() - days * 86400
    rows = {}

    def add(kind, m):
        r = rows.setdefault(kind, {"n": 0, "cost": 0.0, "turns": 0, "in": 0, "cw": 0, "cr": 0, "out": 0, "tok": 0})
        r["n"] += 1; r["cost"] += m.get("cost") or 0; r["turns"] += m.get("turns") or 0
        if any(m.get(k) for k in ("in", "cw", "cr", "out")):
            r["tok"] += 1
            for k in ("in", "cw", "cr", "out"):
                r[k] += m.get(k) or 0
    try:
        for ln in open(os.path.join(JOBS_DIR, "log.txt"), encoding="utf-8"):
            p = ln.rstrip("\n").split("\t")
            if len(p) < 6:
                continue
            try:
                if time.mktime(time.strptime(p[0], "%Y-%m-%d %H:%M:%S")) < since:
                    continue
                m = json.loads(p[5])
            except ValueError:
                continue
            if m.get("cost"):
                add(p[1], m)
    except OSError:
        pass
    for f in glob.glob(os.path.join(P.ROOT, "*", "videos", "*", "agent.jsonl")):
        try:
            for ln in open(f, encoding="utf-8"):
                if '"done"' not in ln:
                    continue
                e = json.loads(ln)
                if e.get("kind") == "done" and e.get("cost") and e.get("ts", 0) / 1000 >= since:
                    add("агент (чат видео)", e)
        except (OSError, ValueError):
            pass
    tot = sum(r["cost"] for r in rows.values()) or 1
    L = [f"Расход Claude за {days} дн. (доллары — по ценам API; лимит подписки уходит пропорционально)",
         f"{'вид':26} {'запусков':>8} {'$':>7} {'доля':>5} {'ср.$':>6} {'ходов':>6} | токены на запуск (k): ввод · кэш-запись · кэш-чтение · ответ"]
    for k, r in sorted(rows.items(), key=lambda kv: -kv[1]["cost"]):
        t = r["tok"] or 0
        tk = (" · ".join(f"{r[x] / t / 1000:.0f}" for x in ("in", "cw", "cr", "out"))) if t else "— (до учёта токенов)"
        L.append(f"{k[:26]:26} {r['n']:>8} {r['cost']:>7.1f} {r['cost'] / tot * 100:>4.0f}% {r['cost'] / r['n']:>6.2f} {r['turns'] // max(1, r['n']):>6} | {tk}")
    L.append(f"Всего: {sum(r['cost'] for r in rows.values()):.1f} $")
    return "\n".join(L)


def cli(argv):
    """channels | use CHANNEL | list [CHANNEL] | show ID | new short|long "Имя" [--topic …] [--idea …] [--channel ID]
    | add-questions ID "вопрос" …  | add-elements ID scene|char|prop|sound "название | описание" …
    | set KEY путь.через.точки значение  (KEY: plan:ID | channel:ID; значение — JSON или текст)
    | op KEY '<JSON: операция или список операций set/add/del/move>'
    | produce ID  (🚀 проект ролика в папке видео)
    | scene show|ops|history|undo|version|clip|validate|finish ID EL …  (сцены редактора, scene_api.cli)
    | channel new "Имя" [--icon] [--about] | channel style|hero ID  (S9, channel_api.cli)
    | montage show|gen|build <видео>  (монтаж S6, montage_api.cli)
    | char list|show|pose|skeleton|version …  (персонажи со скелетом, char_api.cli)
    | lib list|show|publish …  (библиотека канала, studio_api.cli)
    | ref list|add|parse|wait|read|base <видео> …  (референсы брифа: разбор видео yt-dlp + расшифровка, refs_api.cli)
    | beatmap show|run|ok|topics <видео>  (S16: карта подачи по референсу, похожие темы — refbase_api.cli)
    | act list [вкладка] · act <видео|channel> <действие> [--el ЭЛ] [--p '{json}'] [--wait]  (S20.2: кнопки ✨ вкладок, actions.py)
    | el <видео> fix|draw|make3d|ok <эл> … · sound <видео> pick|fetch|use|list <эл> … · job wait <id>  (препродакшен из чата: agent_tools.py)
    | usage [дней]  (расход Claude: задачи и агент по видам — $, ходы, токены in/cw/cr/out; по умолчанию 7 дней)"""
    cmd, a = argv[0], argv[1:]
    by = "claude"
    if cmd == "channels":
        cur = (P.channel() or {}).get("id")
        for c in P.channels():
            print(f"{'→' if c['id'] == cur else ' '} {c['id']:<12} {c.get('icon', '')} {c.get('name')}  ({c['dir']})")
        return True
    if cmd == "use":
        if not P.channel(a[0]) or P.channel(a[0]).get("id") != a[0]:
            sys.exit("нет такого канала (список: channels)")
        P.state_set("channel", a[0])
        print("текущий канал:", a[0])
        return True
    if cmd == "list":
        for d in plans(a[0] if a else (P.channel() or {}).get("id")):
            s = plan_summary(d)
            print(f"{s['id']}  {ref()['modes'].get(s['mode'], {}).get('icon', '')} {STATUS.get(s['status'], s['status'])}  {STAGE_LABEL.get(d.get('stage'), '—'):<12} «{s['name']}»"
                  + (f"  → «{s['final']}»" if s["final"] else "") + (f"  [{d.get('_folder')}]" if d.get("_folder") else ""))
        return True
    if cmd == "show":
        print(plan_md(load(_plan_key(a[0]))))
        return True
    if cmd == "new":
        d = new_plan(a[0] if a and a[0] in ("short", "long") else "short", a[1] if len(a) > 1 and not a[1].startswith("--") else "",
                     _opt(a, "--topic", ""), channel=_opt(a, "--channel"))
        if _opt(a, "--idea"):
            apply_ops("plan:" + d["id"], [{"op": "set", "path": ["idea"], "value": _opt(a, "--idea")}])
        print(d["id"])
        return True
    if cmd == "add-questions":
        key = _plan_key(a[0])
        rnd = max([int(q.get("round") or 1) for q in load(key).get("qa") or []] + [0]) + 1
        print(apply_ops(key, [{"op": "add", "path": ["qa"], "item": {"id": new_id("q"), "q": t, "a": "", "why": "", "group": "", "round": rnd, "by": by}}
                              for t in a[1:]]))
        return True
    if cmd == "add-elements":
        key, kind = _plan_key(a[0]), a[1]
        if kind not in KINDS:
            sys.exit("тип: " + " | ".join(KINDS))
        ops = []
        var = _opt(a, "--variant-of")                      # S18: вариация того же персонажа / пропса (id основного)
        for t in [x for i, x in enumerate(a[2:], 2) if not x.startswith("--") and not (i > 2 and a[i - 1] == "--variant-of")]:
            nm, _, ds = t.partition("|")
            ops.append({"op": "add", "path": ["elements"], "item": {"id": new_id("e"), "kind": kind, "name": nm.strip(), "desc": ds.strip(),
                                                                   "why": "", "status": "", "refs": [], "by": by, **({"variantOf": var} if var else {})}})
        print(apply_ops(key, ops))
        for o in ops:
            print(f"+ {o['item']['id']} «{o['item']['name']}»")
        if "--no-reuse" not in a:
            try:                                           # S15: есть ли это уже в библиотеке — задача reuse (нужна запущенная Studio: идёт через её очередь)
                j = _cli_reuse(key, ops)
                if j:
                    print(f"📚 ищу в библиотеке и прошлых видео: {j}")
            except Exception as e:
                print("! поиск в библиотеке:", e)
        return True
    if cmd == "set":
        key, path, raw = a[0], a[1].split("."), a[2]
        if key.startswith("plan:"):
            _plan_key(key[5:])
        try:
            val = json.loads(raw)
        except ValueError:
            val = raw
        run = agapi().current_run()
        if run and key.startswith("plan:") and path and path[0] == "montage":   # S23: ручные плашки звука автора (🔒) агент меняет только с --force
            import copy as _copy
            old = (load(key).get("montage") or {})
            new = _copy.deepcopy(old)
            if len(path) == 1:
                new = mnapi().fix_by(old, val)
                val = new
            else:
                cur = new
                for k in path[1:-1]:
                    cur = next((x for x in cur if isinstance(x, dict) and x.get("id") == k), None) if isinstance(cur, list) else cur.setdefault(k, {})
                    if cur is None:
                        break
                if isinstance(cur, dict):
                    cur[path[-1]] = val
            bad = mnapi().author_changes(old, new)
            if bad and "--force" not in a:
                print("⛔ Это автор поставил или поправил руками (🔒): " + "; ".join(bad) + ".\n"
                      "Спроси автора [[выбор: Меняй | Не трогай]] и только после «Меняй» повтори команду с --force. "
                      "Или оставь эти плашки как были (в монтаже целиком — те же поля).")
                return True
        if run:                                   # агент S7: запомнить, как было, — «↺ отменить» вернёт
            _journal_set(run, key, path, "set " + ".".join(map(str, path)))
        print(apply_ops(key, [{"op": "set", "path": path, "value": val}]))
        return True
    if cmd == "help":                         # S22: группа команд агента по запросу (в системном промпте — только ядро)
        print(agapi().help_text(sys.modules[__name__], a[0] if a else "", a[1] if len(a) > 1 else ""))
        return True
    if cmd == "done":                         # S22: закрыть правки ПАЧКОЙ одной командой (было: два set на каждую — 15 % ходов агента):
        # done <видео> '[{"id": "n…", "reply": "что сделал"}, "f…", …]' — пометки автора (notes), правки ревью (fixes), находки сторожа (guard.issues -> ok)
        key = _plan_key(a[0])
        items = json.loads(a[1]) if len(a) > 1 else []
        items = items if isinstance(items, list) else [items]
        d = load(key)
        where = {x.get("id"): (["notes"], "done") for x in d.get("notes") or []}
        where.update({x.get("id"): (["fixes"], "done") for x in d.get("fixes") or []})
        where.update({x.get("id"): (["guard", "issues"], "ok") for x in (d.get("guard") or {}).get("issues") or []})
        ops, miss = [], []
        for it in items:
            it = {"id": it} if isinstance(it, str) else it
            w = where.get(it.get("id"))
            if not w:
                miss.append(str(it.get("id")))
                continue
            base = w[0] + [it["id"]]
            ops.append({"op": "set", "path": base + ["status"], "value": it.get("status") or w[1]})
            if it.get("reply"):
                ops.append({"op": "set", "path": base + ["reply"], "value": it["reply"]})
        run = agapi().current_run()
        if run:
            for o in ops:
                _journal_set(run, key, o["path"], "set " + ".".join(map(str, o["path"])))
        if ops:
            apply_ops(key, ops)
        print(f"закрыто: {len(items) - len(miss)}" + (f"; не нашлись id: {', '.join(miss)}" if miss else ""))
        return True
    if cmd == "op":                           # op KEY '[{"op": "add", "path": ["items"], "item": {...}}, …]'
        key = a[0]
        if key.startswith("plan:"):
            _plan_key(key[5:])
        ops = json.loads(a[1])
        ops = ops if isinstance(ops, list) else [ops]
        run = agapi().current_run()
        if run:
            inv = []
            for o in ops:
                if o.get("op") == "set":
                    _journal_set(run, key, o["path"], "set " + ".".join(map(str, o["path"])))
                elif o.get("op") == "add":
                    o.setdefault("item", {}).setdefault("id", new_id("x"))
                    inv.append({"op": "del", "path": o["path"], "id": o["item"]["id"]})
            if inv:
                agapi().journal(run, {"key": key, "inverse": inv, "desc": "добавлено в видео"})
        print(apply_ops(key, ops))
        return True
    if cmd == "scene":
        return scapi().cli(sys.modules[__name__], a)
    if cmd == "channel":
        return chnapi().cli(sys.modules[__name__], a)
    if cmd == "looks":
        return lkapi().cli(sys.modules[__name__], a)
    if cmd == "act":                                   # S20.2: любое действие кнопки ✨ по вкладкам (actions.py)
        return acapi().cli(sys.modules[__name__], a)
    if cmd in ("el", "sound", "job"):                  # инструменты препродакшена для агента (agent_tools.py): поправить / нарисовать / 3D, звук — подобрать / скачать / выбрать
        import agent_tools
        try:
            return agent_tools.cli(sys.modules[__name__], [cmd] + a)
        except (ValueError, RuntimeError) as e:
            print("ошибка:", e); return True
    if cmd == "usage":
        print(usage_report(int(a[0]) if a and a[0].isdigit() else 7)); return True
    if cmd == "montage":
        return mnapi().cli(sys.modules[__name__], a)
    if cmd == "script":
        return mnapi().script_cli(sys.modules[__name__], a)
    if cmd == "voice":
        return vcapi().cli(sys.modules[__name__], a)
    if cmd == "talk":
        return tkapi().cli(sys.modules[__name__], a)
    if cmd == "char":
        return chapi().cli(sys.modules[__name__], a)
    if cmd == "lib":
        return stapi().cli(sys.modules[__name__], a)
    if cmd == "ws":
        return wsapi().cli(sys.modules[__name__], a)
    if cmd == "media":
        return mdapi().cli(sys.modules[__name__], a)
    if cmd == "model":
        return m3d().cli(sys.modules[__name__], a)
    if cmd == "mscene":                                # S13: сцены монтажа поверх локаций
        return lcapi().cli(sys.modules[__name__], a)
    if cmd == "yt":                                    # S17: YouTube — status | login | sync | show | link | learn | review
        return ytapi().cli(sys.modules[__name__], a)
    if cmd == "memory":                                # S12.10: правила из правок автора
        return mmapi().cli(sys.modules[__name__], a)
    if cmd == "beatmap":                               # S16: карта подачи по референсу: show | run | ok | topics
        return rbapi().cli(sys.modules[__name__], a)
    if cmd == "ref":                                   # референсы брифа: list | add | parse | wait | read (refs_api.cli)
        return rapi().cli(sys.modules[__name__], a)
    if cmd == "produce":
        job = Job("produce", _plan_key(a[0]), "produce", {"name": a[1] if len(a) > 1 else "", "attach": "--attach" in a})
        produce(job)
        print(job.summary)
        return True
    return False
