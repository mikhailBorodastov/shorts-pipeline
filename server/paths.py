"""Где что лежит в Claude Studio. Все пути сервера, CLI и инструментов — только отсюда (docs/studio/stage2-studio.md §1–2).

STUDIO   — папка приложения (_studio, бывший _pipeline): server, web, stands, engine, template, docs, tools, sfx_library…
ROOT     — рабочая папка (родитель STUDIO или STUDIO_ROOT): каналы, _archive, .studio
STATE    — ROOT/.studio: .port, .lock, .jobs, state.json (текущий канал), токены — состояние приложения, вне git
ARCHIVE  — ROOT/_archive: банк, лист проекта, статистика, старые штурмы (только чтение)
Канал    — папка ROOT/<Имя> с channel.json; видео — <канал>/videos/<папка>/video.json {id: '260930-08d8', …}

Документы видео и их файлы адресуются по id (как раньше штурмы): plan:<id> -> video.json,
files/<id>/… -> <видео>/files/…, render/<id>/… -> <видео>/preprod/… (черновики элементов, work/ сцен редактора).
До переезда (каналов нет, есть _ideas) — всё как раньше: _ideas/plans/<id>.json, _ideas/files/<id>, _ideas/render/<id>.
"""
import json, os, re, threading, time

SERVER = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(SERVER)
ROOT = os.path.abspath(os.environ.get("STUDIO_ROOT") or os.path.dirname(STUDIO))
WEB = os.path.join(STUDIO, "web")
STANDS = os.path.join(STUDIO, "stands")
ENGINE = os.path.join(STUDIO, "engine")
TEMPLATE = os.path.join(STUDIO, "template")
TPL_SRC = os.path.join(TEMPLATE, "src")
DOCS = os.path.join(STUDIO, "docs")
PROMPTS = os.path.join(STUDIO, "prompts")
SFXLIB = os.path.join(STUDIO, "sfx_library")
FONTS = os.path.join(TEMPLATE, "assets", "fonts")
ARCHIVE = os.path.join(ROOT, "_archive")
LEGACY = os.path.join(ROOT, "_ideas")                     # до переезда (S0–S1)
STATE = os.path.abspath(os.environ.get("IDEAS_DIR") or os.path.join(ROOT, ".studio"))

_lock = threading.RLock()
_idx = {"t": 0, "videos": {}, "channels": []}


def channels(fresh=False):
    """[{id, name, icon, dir, …channel.json}] — папки рабочей папки с channel.json."""
    index(fresh)
    return _idx["channels"]


def legacy():
    """Переезда ещё не было: каналов нет, данные в _ideas."""
    return not channels() and os.path.isdir(LEGACY)


def index(fresh=False):
    """id видео -> папка видео; каналы. Пересобирается раз в 5 с или по fresh=True (новое видео, переименование)."""
    with _lock:
        if not fresh and time.time() - _idx["t"] < 5:
            return _idx
        chans, vids = [], {}
        try:
            names = sorted(os.listdir(ROOT))
        except OSError:
            names = []
        for n in names:
            d = os.path.join(ROOT, n)
            cj = os.path.join(d, "channel.json")
            if n.startswith((".", "_")) or not os.path.isfile(cj):
                continue
            try:
                c = json.load(open(cj, encoding="utf-8"))
            except ValueError:
                continue
            c["dir"] = d
            chans.append(c)
            vd = os.path.join(d, "videos")
            for v in sorted(os.listdir(vd)) if os.path.isdir(vd) else []:
                vj = os.path.join(vd, v, "video.json")
                if os.path.isfile(vj):
                    try:
                        vid = json.load(open(vj, encoding="utf-8")).get("id")
                    except ValueError:
                        continue
                    if vid:
                        vids[vid] = {"dir": os.path.join(vd, v), "channel": c.get("id"), "folder": v}
        _idx.update(t=time.time(), channels=chans, videos=vids)
        return _idx


def video(vid):
    """Папка видео по id (или None)."""
    v = index()["videos"].get(vid) or index(True)["videos"].get(vid)
    return v["dir"] if v else None


def video_json(vid):
    if legacy():
        return os.path.join(LEGACY, "plans", vid + ".json")
    d = video(vid)
    return os.path.join(d, "video.json") if d else None


def files(vid):
    """Картинки видео (референсы, эскизы, кадры черновиков): документ пишет их как files/<id>/N.png."""
    if legacy():
        return os.path.join(LEGACY, "files", vid)
    d = video(vid)
    return os.path.join(d, "files") if d else os.path.join(STATE, "orphan", vid, "files")


def render(vid):
    """Черновики элементов и сцены редактора: документ пишет их как render/<id>/<el>/v<N>."""
    if legacy():
        return os.path.join(LEGACY, "render", vid)
    d = video(vid)
    return os.path.join(d, "preprod") if d else os.path.join(STATE, "orphan", vid, "preprod")


def resolve(rel):
    """«files/<id>/…» или «render/<id>/…» (как пишут документы) -> путь на диске; иначе — от STATE."""
    rel = rel.replace("\\", "/").lstrip("/")
    m = re.match(r"(files|render)/([a-z0-9-]{3,40})(?:/(.*))?$", rel)
    if m:
        base = files(m.group(2)) if m.group(1) == "files" else render(m.group(2))
        return os.path.join(base, *(m.group(3) or "").split("/")) if m.group(3) else base
    return os.path.join(STATE, *rel.split("/"))


def rel_of(path):
    """Путь на диске -> «files/<id>/…» / «render/<id>/…» (обратно к resolve)."""
    p = os.path.abspath(path)
    for vid, v in index()["videos"].items():
        for kind, sub in (("files", "files"), ("render", "preprod")):
            base = os.path.join(v["dir"], sub)
            if p == base or p.startswith(base + os.sep):
                return f"{kind}/{vid}/" + os.path.relpath(p, base).replace("\\", "/")
    if p.startswith(LEGACY + os.sep):
        return os.path.relpath(p, LEGACY).replace("\\", "/")
    return os.path.relpath(p, STATE).replace("\\", "/")


def state_get(key, default=None):
    try:
        return json.load(open(os.path.join(STATE, "state.json"), encoding="utf-8")).get(key, default)
    except (OSError, ValueError):
        return default


def state_set(key, value):
    os.makedirs(STATE, exist_ok=True)
    p = os.path.join(STATE, "state.json")
    try:
        s = json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    s[key] = value
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def channel(cid=None):
    """Текущий канал (state.json -> channel) или по id; первый, если не выбран."""
    cs = channels()
    cid = cid or state_get("channel")
    return next((c for c in cs if c.get("id") == cid), cs[0] if cs else None)


def project(name):
    """Папка ролика по имени: в каналах (videos/<name>) или, до переезда, в рабочей папке."""
    for c in channels():
        d = os.path.join(c["dir"], "videos", name)
        if os.path.isdir(d):
            return d
    d = os.path.join(ROOT, name)
    return d if os.path.isdir(d) else None


def projects():
    """Все папки роликов (с build.sh): [(имя, путь, канал или None)]."""
    out = []
    for c in channels():
        vd = os.path.join(c["dir"], "videos")
        for n in sorted(os.listdir(vd)) if os.path.isdir(vd) else []:
            if os.path.isfile(os.path.join(vd, n, "build.sh")):
                out.append((n, os.path.join(vd, n), c.get("id")))
    for n in sorted(os.listdir(ROOT)) if os.path.isdir(ROOT) else []:
        if not n.startswith(("_", ".")) and os.path.isfile(os.path.join(ROOT, n, "build.sh")):
            out.append((n, os.path.join(ROOT, n), None))
    return out


def studio_path(*parts):
    """Папка _studio, её же видит пайплайн ролика (sfx_library, animalese.py): рядом, выше по папкам — в скриптах ролика."""
    return os.path.join(STUDIO, *parts)
