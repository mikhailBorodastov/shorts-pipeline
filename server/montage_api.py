"""Монтаж видео (S6 Claude Studio, docs/studio/stage6-montage.md): video.json → montage — юниты сцен редактора, голос, субтитры, звуки, музыка, надписи;
генератор montage → project (assets/studio/…, src/montage.js, src/scenes.js, src/index.html, vo_timing.js без голоса, build/music.json) и сборка (build.sh).
CLI: studio.py montage show|gen|build <видео>."""
import glob, json, os, re, shutil, subprocess, sys, time

import paths as P  # noqa: E402

STUDIO_DIR = "assets/studio"
ENGINE_SYNC = ("lib.js", "stage3d.js", "moves3d.js", "props3d.js", "rig.js", "scene.js", "paper.js")


def now_ms():
    return int(time.time() * 1000)


def vdir(vid):
    return P.video(vid)


def has_project(vid):
    d = vdir(vid)
    return bool(d) and os.path.isfile(os.path.join(d, "build.sh"))


def _scene_doc(A, vid, el):
    try:
        return json.load(open(os.path.join(A.scapi().work_dir(A, vid, el), "scene.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return None


def scenes(A, vid, doc):
    """Сцены редактора этого видео: [{el, name, len, cuts, markers, sounds}]."""
    out = []
    for e in doc.get("elements") or []:
        if e.get("kind") != "scene" or not (e.get("stage") or {}).get("work") or e.get("status") == "drop" or e.get("ws"):   # ws — служебная сцена мастерской
            continue
        s = _scene_doc(A, vid, e["id"])
        if not s:
            continue
        cam = s.get("camera") or {}
        out.append({"el": e["id"], "name": e.get("name") or s.get("name"), "len": s.get("len") or 6, "cuts": [c["t"] for c in cam.get("cuts") or []],
                    "script": (e.get("script") or {}).get("title", ""),          # S11: сцена сценария, по которой сделана
                    "scripts": (e.get("script") or {}).get("titles") or ([(e.get("script") or {}).get("title")] if (e.get("script") or {}).get("title") else []),
                    "markers": [{"t": m["t"], "name": m.get("name", ""), "id": m.get("id")} for m in s.get("markers") or []],
                    "sounds": len(s.get("sounds") or [])})
    for m in doc.get("mscenes") or []:                    # S13: сцены монтажа (оверлеи на локациях) — собранная сцена в work/
        s = _scene_doc(A, vid, m["id"])
        if not s:
            continue
        cam = s.get("camera") or {}
        out.append({"el": m["id"], "name": s.get("name") or m.get("name"), "len": s.get("len") or 6, "cuts": [c["t"] for c in cam.get("cuts") or []],
                    "script": (m.get("sec") or "").split(" | ")[0], "scripts": [x for x in (m.get("sec") or "").split(" | ") if x],
                    "markers": [{"t": x["t"], "name": x.get("name", ""), "id": x.get("id")} for x in s.get("markers") or []],
                    "sounds": len(s.get("sounds") or []), "location": m.get("location")})
    return out


def voice(vid):
    """Голос проекта: секции и слова из src/vo_timing.js (tts.py / align.py) — [{w, t, e, i}] в секундах ролика."""
    d = vdir(vid)
    p = os.path.join(d or "", "src", "vo_timing.js")
    try:
        txt = open(p, encoding="utf-8").read()
        vo = json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
    except (OSError, ValueError):
        return None
    words, i = [], 0
    for s in vo.get("sections") or []:
        for w in s.get("words") or []:
            words.append({"w": w["w"], "t": round(s["start"] + w["t"], 3), "e": round(s["start"] + w["t"] + w.get("d", 0), 3), "i": i})
            i += 1
    return {"total": vo.get("total"), "words": words, "sections": [{"start": s["start"], "dur": s.get("dur"), "file": s.get("file"), "silent": s.get("silent"), "title": s.get("title", "")}
                                                                  for s in vo.get("sections") or []],
            "studio": bool(vo.get("studio"))}


def default(A, vid, doc):
    """Монтаж по умолчанию: сцены редактора подряд, голос — если есть в проекте."""
    sc = scenes(A, vid, doc)
    vo = voice(vid)
    units, at = [], 0.0
    for i, s in enumerate(sc):                               # все сцены редактора подряд (у каждой — свои префабы, см. _scoped)
        units.append({"id": f"u{i + 1}", "scene": s["el"], "at": round(at, 3), "len": s["len"], "map": [[0, 0], [s["len"], s["len"]]], "trans": {"type": "cut", "dur": 0}})
        at += s["len"]
    has_vo = bool(vo and vo["words"] and not vo["studio"])
    return {"units": units, "voice": {"on": has_vo}, "captions": {"on": has_vo}, "sfx": [], "music": [], "overlays": [], "len": round(max(at, (vo or {}).get("total") or 0) if has_vo else at, 3)}


_LIBIDX = {}
_LIBPEAK = {}


def lib_sounds():
    """Библиотека пайплайна: [[id, длина, название]] — для выбора звука и длины полос на таймлайне."""
    p = os.path.join(P.SFXLIB, "index.json")
    m = os.path.getmtime(p) if os.path.isfile(p) else 0
    if _LIBIDX.get("m") != m:
        items = json.load(open(p, encoding="utf-8")).get("sounds", []) if m else []
        _LIBIDX.update(m=m, list=[[s["id"], s.get("dur"), s.get("name", "")] for s in items])
        _LIBPEAK.clear(); _LIBPEAK.update({s["id"]: s.get("peak_t") for s in items})
    return _LIBIDX["list"]


def sources(doc):
    """Звуки препродакшена видео с выбранным слоем: [{src: 'el:<id>', name, dur}]."""
    import preprod
    out = []
    for e in doc.get("elements") or []:
        if e.get("kind") != "sound" or e.get("status") == "drop":
            continue
        mix = preprod.el_mix(e)
        if mix:
            out.append({"src": "el:" + e["id"], "name": e.get("name", ""), "dur": round(max((m["at"] + float(m["s"].get("dur") or 0)) for m in mix), 2)})
    return out


def get(A, vid):
    doc = A.load("plan:" + vid)
    m = doc.get("montage") or default(A, vid, doc)
    return {"montage": m, "saved": bool(doc.get("montage")), "scenes": scenes(A, vid, doc), "voice": voice(vid), "project": has_project(vid),
            "sources": sources(doc), "lib": lib_sounds(), "fixes": doc.get("fixes") or [], "generated": bool(vdir(vid)) and os.path.isfile(os.path.join(vdir(vid), "src", "montage.js")),
            "owned": bool(vdir(vid)) and has_project(vid) and (bool(doc.get("fast")) or studio_owned(vdir(vid))),   # False — рукописный ролик: монтаж его не пересобирает
                                                                                                         # (код ⚡ быстрого монтажа — тоже Studio: «Сделать заново» можно)
            "folder": vdir(vid), "out": [os.path.basename(x) for x in sorted(glob.glob(os.path.join(vdir(vid) or "", "out", "*.mp4")), key=os.path.getmtime) if not x.endswith("_NO_VO.mp4")][-1:] if vdir(vid) else []}


# ---------------------------------------------------------------- генератор
def _copy(src, dst):
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.png", "_shot", "_pins", "*.log", "_blender_wrap.py"))
    elif os.path.isfile(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def _lib_dir(A, vid):
    ch = P.index()["videos"].get(vid, {}).get("channel")
    c = A.stapi().channel_dir(ch)
    return A.stapi().lib_dir(c)


def _sound_files(A, vid, src, pd, tag, base=None):
    """src звука -> [(путь в проекте 'file:…', сдвиг, громкость)]: el:<элемент-звук> (все слои), lib:sounds/<slug>@N (библиотека канала), file:<путь>, lib:<id> (библиотека пайплайна — как есть)."""
    plan = A.load("plan:" + vid)
    if src.startswith("el:"):
        e = A._by_id(plan.get("elements"), src[3:])
        out = []
        for i, m in enumerate(A.pr().el_mix(e) if e else []):
            f = P.resolve(m["s"]["file"])
            rel = f"{STUDIO_DIR}/sfx/{tag}_{i}{os.path.splitext(f)[1]}"
            _copy(f, os.path.join(pd, rel))
            out.append(("file:" + rel, float(m.get("at") or 0), float(m.get("gain") or 1)))
        return out
    m = re.match(r"lib:sounds/([a-z0-9-]+)@(\d+)$", src)
    if m:
        d = os.path.join(_lib_dir(A, vid), "sounds", m.group(1), "v" + m.group(2))
        out = []
        for i, f in enumerate(sorted(x for x in os.listdir(d) if x.lower().endswith((".wav", ".mp3", ".ogg", ".flac")))):
            rel = f"{STUDIO_DIR}/sfx/{tag}_{i}{os.path.splitext(f)[1]}"
            _copy(os.path.join(d, f), os.path.join(pd, rel))
            out.append(("file:" + rel, 0.0, 1.0))
        return out
    if src.startswith("file:"):
        f = src[5:]
        f = f if os.path.isabs(f) else os.path.join(base or vdir(vid), *f.split("/"))   # звук сцены — от её work/, монтажа — от папки видео
        rel = f"{STUDIO_DIR}/sfx/{tag}{os.path.splitext(f)[1]}"
        _copy(f, os.path.join(pd, rel))
        return [("file:" + rel, 0.0, 1.0)]
    return [(src, 0.0, 1.0)]                                 # lib:<id> пайплайна — audio.py найдёт сам


# ---------------------------------------------------------------- S23: звуковой редактор — дорожки и плашки (docs/studio/stage23-audio.md)
CLIP_KEYS = ("in", "out", "dur", "loop", "fadeIn", "fadeOut")
DUCK = {"on": True, "depth": -6.0, "attack": 0.15, "release": 0.4}


def tracks(M):
    """Дорожки монтажа: montage.tracks или по умолчанию — голос, музыка, звуки."""
    T = [dict(t) for t in (M.get("tracks") or []) if isinstance(t, dict) and t.get("id")]
    for kind, tid, name in (("voice", "voice", "Голос"), ("music", "m1", "Музыка"), ("sfx", "s1", "Звуки")):
        if not any(t.get("kind") == kind for t in T):
            T.append({"id": tid, "kind": kind, "name": name})
    return T


def track_of(T, tid, kind):
    """Дорожка плашки: её track, если он того же вида, иначе первая дорожка вида."""
    return next((t for t in T if t["id"] == tid and t.get("kind") == kind), None) or next(t for t in T if t.get("kind") == kind)


def track_gain(t, preview=False):
    """Громкость дорожки множителем; заглушённая — 0. Solo — только в живом звуке окна (в экспорт не идёт: забытый solo не испортит ролик)."""
    if t.get("mute"):
        return 0.0
    return 10 ** (float(t.get("gain") or 0) / 20)


def clip_of(x, music=False):
    """Поля плашки для audio.py: {in, out, dur, loop, fadeIn, fadeOut}; старый звук без них — None (как раньше: целиком, авто-затухание)."""
    if not music and not any(k in x for k in CLIP_KEYS):
        return None
    c = {"in": float(x.get("in") if x.get("in") is not None else x.get("from") or 0), "out": x.get("out"), "dur": x.get("dur"),
         "loop": x.get("loop") or None, "fadeIn": float(x.get("fadeIn") or 0), "fadeOut": x.get("fadeOut")}
    if music:
        c["fadeOut"] = float(c["fadeOut"] or 0)
        c["music"] = True
    return c


def layer_clip(c, dt, layers):
    """Слой звука (el: из нескольких файлов, сдвиг dt) под окно плашки: -> (сдвиг слоя от начала плашки, его clip) или None — слой вне окна."""
    if c is None or dt == 0 and layers == 1:
        return dt, c
    c = dict(c)
    inn = c["in"]
    lin = max(0.0, inn - dt)
    shift = max(0.0, dt - inn)
    if c.get("dur") is not None:
        c["dur"] = float(c["dur"]) - shift
        if c["dur"] <= 0.01:
            return None
    if c.get("out") is not None:
        c["out"] = float(c["out"]) - dt
        if c["out"] <= lin:
            return None
    c["in"] = lin
    if layers > 1:
        c["loop"] = None                                       # цикл составного звука по слоям не повторить — он просто тянется
    return shift, c


def author_changes(old, new):
    """S23: правки агента задевают ручные плашки автора (by: author)? -> [описание]. Без изменений, но без by — by вернётся сам (fix_by)."""
    bad = []
    for lst in ("sfx", "music"):
        nw = {x.get("id"): x for x in (new or {}).get(lst) or [] if isinstance(x, dict)}
        for x in (old or {}).get(lst) or []:
            if x.get("by") != "author":
                continue
            y = nw.get(x.get("id"))
            strip = lambda z: {k: v for k, v in z.items() if k != "by"}
            if y is None:
                bad.append(f"{x.get('id')} «{x.get('note') or x.get('src')}» удалён")
            elif strip(x) != strip(y):
                bad.append(f"{x.get('id')} «{x.get('note') or x.get('src')}» изменён")
    return bad


def fix_by(old, new):
    """Агент переписал монтаж целиком: ручные плашки, которые он не менял, остаются ручными; дорожки и приглушение — как были, если их нет в новом."""
    if not isinstance(new, dict):
        return new
    for lst in ("sfx", "music"):
        mine = {x.get("id"): x for x in (old or {}).get(lst) or [] if x.get("by") == "author"}
        for y in new.get(lst) or []:
            if isinstance(y, dict) and y.get("id") in mine and "by" not in y:
                y["by"] = "author"
    for k in ("tracks", "duck"):
        if k in (old or {}) and k not in new:
            new[k] = old[k]
    return new


def _fwd_map(unit, words):
    """Пары карты -> [(t_сцены, t_ролика абсолютное)], слова 'w:i' — по голосу."""
    out = []
    for ts, tv in unit.get("map") or [[0, 0], [unit.get("len", 6), unit.get("len", 6)]]:
        if isinstance(tv, str) and tv.startswith("w:"):
            i = int(tv[2:])
            if 0 <= i < len(words):
                out.append((float(ts), float(words[i]["t"])))
        else:
            out.append((float(ts), float(unit.get("at", 0)) + float(tv)))
    return sorted(out)


def _scene_to_video(pairs, ts):
    if not pairs:
        return ts
    if ts <= pairs[0][0]:
        return pairs[0][1] + (ts - pairs[0][0])
    for (a0, b0), (a1, b1) in zip(pairs, pairs[1:]):
        if ts <= a1:
            return b0 + (b1 - b0) * (ts - a0) / ((a1 - a0) or 1)
    return pairs[-1][1] + (ts - pairs[-1][0])


def _video_to_scene(pairs, tv):
    """Обратная карта: время ролика -> время сцены (кусочно-линейно, за краями — с шагом 1)."""
    if not pairs:
        return tv
    P_ = sorted(pairs, key=lambda p: p[1])
    if tv <= P_[0][1]:
        return P_[0][0] + (tv - P_[0][1])
    for (a0, b0), (a1, b1) in zip(P_, P_[1:]):
        if tv <= b1:
            return a0 + (a1 - a0) * (tv - b0) / ((b1 - b0) or 1)
    return P_[-1][0] + (tv - P_[-1][1])


def at(A, vid, tv):
    """S8: момент ролика -> {el, ts, unit, name}: какая сцена редактора в кадре и её время (для «✋ поправить кадр» в ревью)."""
    plan = A.load("plan:" + vid)
    M = plan.get("montage") or default(A, vid, plan)
    vo = voice(vid)
    words = (vo or {}).get("words") or [] if (M.get("voice") or {}).get("on") else []
    units = sorted(M.get("units") or [], key=lambda u: float(u.get("at") or 0))
    if not units:
        raise ValueError("в монтаже нет сцен")
    u = next((x for x in reversed(units) if float(x.get("at") or 0) <= tv + 1e-6), units[0])
    ts = max(0.0, _video_to_scene(_fwd_map(u, words), tv))
    sc = _scene_doc(A, vid, u["scene"]) or {}
    return {"el": u["scene"], "ts": round(ts, 3), "unit": u["id"], "name": sc.get("name") or u["scene"], "vt": round(tv, 3)}


def fast_len(pd):
    """Длина ролика быстрого монтажа: по голосу / таймкодам (build/vo_timing.json)."""
    try:
        return float(json.load(open(os.path.join(pd, "build", "vo_timing.json"), encoding="utf-8")).get("total") or 0)
    except (OSError, ValueError):
        return 0.0


def fast_out(pd):
    """Собранный ролик быстрого монтажа (out/<имя>.mp4 без _NO_VO) или ''."""
    outs = sorted((o for o in glob.glob(os.path.join(pd, "out", "*.mp4")) if not o.endswith("_NO_VO.mp4")), key=os.path.getmtime)
    return outs[-1] if outs else ""


def fast_src_mtime(pd):
    """Когда последний раз менялся код или ассеты ролика (src/, assets/, script.md, build/vo_timing.json)."""
    best = 0.0
    for d in ("src", "assets"):
        for root, _, files in os.walk(os.path.join(pd, d)):
            for f in files:
                try:
                    best = max(best, os.path.getmtime(os.path.join(root, f)))
                except OSError:
                    pass
    for f in ("script.md", os.path.join("build", "vo_timing.json")):
        try:
            best = max(best, os.path.getmtime(os.path.join(pd, f)))
        except OSError:
            pass
    return best


def fast_start(A, vid, wish=""):
    """«Сделать монтаж» быстро: задача fastmontage (server/fast_api.py) — план, сцены параллельно, сводка агентом в панели."""
    if not vdir(vid) or not has_project(vid):
        raise ValueError("у видео ещё нет проекта ролика — сначала сценарий («Начать»)")
    par = 4
    try:
        par = max(2, min(5, int(A.max_jobs()) + 1))
    except Exception:
        pass
    j = A.start_job("fastmontage", "plan:" + vid, "fastmontage", {"wish": wish or "", "par": par})
    return {"ok": True, "job": j.info()}


def fast_redo(A, vid, wish=""):
    """«Сделать монтаж заново» у быстрого ролика: код ролика (src/scenes.js, src/scenes/) и собранный out/*.mp4 -> _archive/fast/<видео>-<время>/,
    монтаж обнуляется, и быстрый монтаж запускается с нуля — по сценарию и ТЕКУЩЕМУ препродакшену."""
    pd = vdir(vid)
    if not pd or not has_project(vid):
        raise ValueError("у видео ещё нет проекта ролика")
    if any(j.key == "plan:" + vid and j.kind in ("fastmontage", "automontage", "montagebuild") and j.status in ("running", "queued") for j in A.JOBS.values()):
        raise ValueError("монтаж уже идёт")
    arch = os.path.join(P.ARCHIVE, "fast", f"{vid}-{time.strftime('%y%m%d-%H%M%S')}")
    os.makedirs(arch, exist_ok=True)
    for rel in ("src/scenes.js", "src/scenes", "src/montage.js", *[os.path.relpath(o, pd) for o in glob.glob(os.path.join(pd, "out", "*.mp4"))]):
        src = os.path.join(pd, rel)
        if os.path.exists(src):
            dst = os.path.join(arch, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
    shutil.copy2(os.path.join(P.TPL_SRC, "scenes.js"), os.path.join(pd, "src", "scenes.js"))   # заглушка шаблона — до плана
    A.apply_ops("plan:" + vid, [{"op": "set", "path": ["montage"], "value": None}])
    r = fast_start(A, vid, wish)
    r["archived"] = arch
    return r


def shift(M, frm, delta, what=None):
    """S22: сдвиг монтажа «всё, что начинается с момента frm, — на delta с» (ripple, как в монтажке): юниты, звуки, музыка, надписи, длина ролика.
    Автор: агент двигал 17 звуков по одному (17 ходов) после того, как сократил сцену на 0,85 с. -> (новый монтаж, сколько сдвинуто по видам)."""
    import copy
    M = copy.deepcopy(M or {})
    what = set(what or ("units", "sfx", "music", "overlays"))
    n = {}
    eps = 1e-6
    for k in ("units", "sfx", "music", "overlays"):
        if k not in what:
            continue
        for x in M.get(k) or []:
            at = float(x.get("at") or 0)
            if at >= frm - eps:
                x["at"] = round(max(0.0, at + delta), 3)
                n[k] = n.get(k, 0) + 1
    if M.get("len"):
        M["len"] = round(max(0.1, float(M["len"]) + delta), 3)
    return M, n


def script_drift(pd):
    """S22: сценарий / голос переписали после монтажа — какие сцены быстрого ролика стоят на чужом тексте.
    Снимок build/vo_montage.json: под какой текст секции написан каждый файл сцены src/scenes/sNN.js (SCENES[k] = …; сцена k — секция k).
    Файл сцены изменился с прошлой проверки — его правили, он берёт нынешний текст; не менялся, а текст его секции другой — расхождение
    (держится, пока сцену не поправят). Первая проверка: точка отсчёта — нынешний текст, одной строкой — сцены, чей код старше голоса. -> [строки ⚠]"""
    import difflib
    import hashlib
    vf = os.path.join(pd, "build", "vo_timing.json")
    try:
        vo = json.load(open(vf, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    texts = [" ".join(w.get("w", "") for w in s.get("words") or []).strip() for s in vo.get("sections") or []]
    sd = os.path.join(pd, "src", "scenes")
    if not os.path.isdir(sd):
        return []
    snap_f = os.path.join(pd, "build", "vo_montage.json")
    try:
        snap = json.load(open(snap_f, encoding="utf-8"))
    except (OSError, ValueError):
        snap = None
    first = snap is None
    vo_mt = os.path.getmtime(vf)
    files, out, older, rec_by_k = {}, [], [], {}
    for f in sorted(os.listdir(sd)):
        if not f.endswith(".js"):
            continue
        p = os.path.join(sd, f)
        code = open(p, encoding="utf-8", errors="replace").read()
        ks = [int(m) for m in re.findall(r"SCENES\[\s*(\d+)\s*\]\s*=(?!=)", code)]
        if not ks:
            continue
        h = hashlib.sha1(code.encode("utf-8")).hexdigest()
        was = ((snap or {}).get("files") or {}).get(f)
        if first or not was or was.get("hash") != h:         # первая проверка или сцену правили — под нынешний текст
            rec = {"hash": h, "ks": ks, "texts": {str(k): texts[k] if k < len(texts) else None for k in ks}}
            if first and os.path.getmtime(p) < vo_mt:
                older += ks
        else:
            rec = was
        files[f] = rec
        for k in ks:
            rec_by_k[k] = (f, rec["texts"].get(str(k)))
    # вставили / убрали секцию: текст, под который написаны сцены (по k), против нынешнего
    ks_all = sorted(rec_by_k)
    seq_old = [rec_by_k[k][1] or "" for k in ks_all]
    shifted = set()
    for op, a0, a1, b0, b1 in difflib.SequenceMatcher(a=seq_old, b=texts, autojunk=False).get_opcodes():
        if op == "insert":
            out.append(f"⚠ добавлена секция {b0}{'–' + str(b1 - 1) if b1 - b0 > 1 else ''} — сцены с {ks_all[a0] if a0 < len(ks_all) else '?'} и дальше стоят на чужом тексте (сдвиг на {b1 - b0})")
            shifted |= set(ks_all[a0:])
        elif op == "delete":
            out.append(f"⚠ убрана секция под сценой {', '.join(str(k) for k in ks_all[a0:a1])} — сцены после неё стоят на чужом тексте (сдвиг на {a1 - a0})")
            shifted |= set(ks_all[a0:])
    for k in ks_all:
        f, old = rec_by_k[k]
        if k >= len(texts):
            out.append(f"⚠ сцена {k} ({f}): секции {k} нет (секций {len(texts)}) — сцена без голоса")
        elif old is not None and old != texts[k] and k not in shifted:
            out.append(f"⚠ сцена {k} ({f}): текст секции изменился после монтажа — было «{old[:60]}…», стало «{texts[k][:60]}…»")
    if shifted:
        out.append(f"⚠ сцены на сдвинутом тексте: {', '.join(str(k) for k in sorted(shifted))}")
    if older:
        out.insert(0, f"⚠ первая проверка: код сцен {', '.join(str(k) for k in sorted(older))} старше голоса — проверь их по тексту; дальше проверка точная")
    os.makedirs(os.path.join(pd, "build"), exist_ok=True)
    P.write_atomic(snap_f, json.dumps({"files": files, "sections": len(texts)}, ensure_ascii=False, indent=1))
    return out


def project_check(A, vid, run_wt=False):
    """S22: проверка ролика перед сборкой / по запросу: сценарий новее сцен (script_drift) + промахи WT() (build/wt_check.json от render.js).
    run_wt — прогнать render.js check сейчас (иначе — то, что записал последний рендер кадров). -> (строки, {"drift": [...], "wt": [...]})"""
    pd = vdir(vid)
    drift = script_drift(pd) if A.load("plan:" + vid).get("fast") else []
    if run_wt:
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", REVIEW_PORT=str(A.stapi().project_port(pd)))
        subprocess.run(["node", "render.js", "check"], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    wt = []
    try:
        r = json.load(open(os.path.join(pd, "build", "wt_check.json"), encoding="utf-8"))
        for m in r.get("miss") or []:
            who = ", ".join(f"сцена {k}" for k in m.get("scenes") or []) or "код вне сцен"
            wt.append(f"❌ {who}: WT({m['i']}, {json.dumps(m['key'], ensure_ascii=False)}) — "
                      + (f"секции {m['i']} нет (секций {r.get('sections')})" if m.get("why") == "секции нет" else f"в секции {m['i']} нет такого слова — событие встало на начало секции"))
        for w in (r.get("warn") or [])[:12]:                  # S22: предупреждения и упавшие кадры страницы по сценам («ppObj: нет объекта …»)
            who = ", ".join(f"сцена {k}" for k in w.get("scenes") or []) or "загрузка / звуки"
            wt.append(f"{'❌' if w.get('kind') == 'error' else '⚠'} {who}: {w.get('msg')}")
    except (OSError, ValueError):
        pass
    return drift + wt, {"drift": drift, "wt": wt}


def fast_done(A, vid):
    """После сборки быстрого монтажа: длина ролика -> montage (таймлайн окна знает длину, шаг «Монтаж» — готов)."""
    pd = vdir(vid)
    out = fast_out(pd)
    dur = fast_len(pd)
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], capture_output=True, text=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        dur = float(r.stdout.strip() or dur)
    except (OSError, ValueError):
        pass
    A.apply_ops("plan:" + vid, [{"op": "set", "path": ["montage"], "value": {"fast": True, "units": [], "len": round(dur, 2), "voice": {"on": False},
                                                                            "captions": {"on": False}, "sfx": [], "music": [], "overlays": []}}])


def studio_owned(pd):
    """Можно ли генератору писать src/scenes.js проекта: файла нет, он уже сгенерирован монтажом или это нетронутая заглушка шаблона.
    Рукописные ролики (до Studio: PS6, «Коты сыщики 3D» …) генератор не трогает — иначе он затирает их сцены и движок (случай 2 окт 2026)."""
    f = os.path.join(pd, "src", "scenes.js")
    if not os.path.isfile(f):
        return True
    with open(f, encoding="utf-8", errors="replace") as fh:
        head = fh.read(600)
    if "СГЕНЕРИРОВАНО монтажом" in head:
        return True
    try:
        with open(os.path.join(P.TPL_SRC, "scenes.js"), encoding="utf-8", errors="replace") as a, open(f, encoding="utf-8", errors="replace") as b:
            return a.read() == b.read()
    except OSError:
        return False


def generate(A, vid, montage=None):
    """montage -> файлы проекта. Возвращает сводку: что скопировано, длина, сцены."""
    pd = vdir(vid)
    if not has_project(vid):
        raise ValueError("у видео ещё нет проекта ролика — «🚀 Начать производство»")
    if A.load("plan:" + vid).get("fast"):                 # быстрый монтаж: ролик — код агента (src/scenes.js), генератор его не трогает
        return {"len": fast_len(pd), "fast": True, "scenes": [], "report": []}
    if not studio_owned(pd):
        raise ValueError("src/scenes.js этого ролика написан руками (сделан до монтажа Studio) — монтаж его не перезапишет. "
                         "Чтобы монтировать в Studio, сначала переведи сцены в редактор (препродакшен) и сохрани копию scenes.js.")
    plan = A.load("plan:" + vid)
    M = montage or plan.get("montage") or default(A, vid, plan)
    lib = _lib_dir(A, vid)
    S = os.path.join(pd, STUDIO_DIR)
    os.makedirs(S, exist_ok=True)
    for f in ENGINE_SYNC:                                     # проект собирается на том же движке, что показывал редактор сцены
        src = os.path.join(P.STANDS if f == "paper.js" else P.ENGINE, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(pd, "src", f))
    for f in ("review.js", "main.js", "script.html", "script.js", "refs.js"):   # ревью отвечает окну приложения (S8); main.js — субтитры (S9); раскадровка — окно «Сценарий» (S12.5)
        shutil.copy2(os.path.join(P.TPL_SRC, f), os.path.join(pd, "src", f))
    for f in ("render.js", "build.sh"):                       # S12.8: быстрый рендер (H.264 в браузере) и склейка без x264
        shutil.copy2(os.path.join(P.TEMPLATE, f), os.path.join(pd, f))
    vo = voice(vid)
    words = (vo or {}).get("words") or [] if (M.get("voice") or {}).get("on") else []
    report = {"copied": [], "units": [], "warn": []}
    unit_js, prefab_scripts, sfx_cues = [], [], []
    T = tracks(M)                                             # S23: дорожки — громкость и mute каждой плашки

    def cues(x, t0, src_files, gain0, tg, tag_music=False):
        """плашка (звук монтажа или сцены) -> сигналы audio.py; слои el: — каждый со своим сдвигом под окном плашки."""
        c = clip_of(x)
        for f, dt, g in src_files:
            lc = layer_clip(c, dt, len(src_files))
            if lc is None:
                continue
            sh, cc = lc
            cue = {"t": round(t0 + sh, 3), "src": f, "gain": round(gain0 * g * tg, 4), "align": x.get("align") or ""}
            if cc:
                cue["clip"] = cc
            sfx_cues.append(cue)
    for u in M.get("units") or []:
        el = u["scene"]
        wd = A.scapi().work_dir(A, vid, el)
        sc = _scene_doc(A, vid, el)
        if not sc:
            report["warn"].append(f"нет сцены {el}"); continue
        dst = _pack_scene(A, vid, el, sc, wd, S, prefab_scripts, report, lib)
        pairs = _fwd_map(u, words)
        # звуки сцены — по карте времени в ролик
        for s in sc.get("sounds") or []:
            tg = track_gain(track_of(T, s.get("track"), "sfx"))
            if not tg:
                continue
            cues(s, _scene_to_video(pairs, float(s.get("t") or 0)), _sound_files(A, vid, s.get("src") or "", pd, f"{el}_{s.get('id')}", wd),
                 float(s.get("gain") if s.get("gain") is not None else 1), tg)
        A.write_text(os.path.join(dst, "scene.json"), json.dumps(sc, ensure_ascii=False))
        unit_js.append({"id": u["id"], "el": el, "name": sc.get("name") or el, "at": float(u.get("at", 0)), "len": float(u.get("len", sc.get("len") or 6)),
                        "map": u.get("map") or [[0, 0], [u.get("len", 6), u.get("len", 6)]], "trans": u.get("trans") or {"type": "cut", "dur": 0}})
        report["units"].append(u["id"])
    for x in M.get("sfx") or []:
        tg = track_gain(track_of(T, x.get("track"), "sfx"))
        if tg:
            cues(x, float(x.get("at") or 0), _sound_files(A, vid, x.get("src") or "", pd, "m_" + x["id"]), float(x.get("gain") if x.get("gain") is not None else 1), tg)
    music = []
    duck = dict(DUCK, **(M.get("duck") or {}))
    for x in M.get("music") or []:
        tr = track_of(T, x.get("track"), "music")
        tg = track_gain(tr)
        if not tg:
            continue
        files = _sound_files(A, vid, x.get("src") or "", pd, "mu_" + x["id"])
        for f, dt, g in files:
            lc = layer_clip(clip_of(x, music=True), dt, len(files))
            if lc is None:
                continue
            sh, cc = lc
            if f.startswith("file:"):
                music.append({"file": f[5:], "at": float(x.get("at") or 0) + sh, "gain": float(x.get("gain") if x.get("gain") is not None else 1) * g * tg,
                              "clip": cc, "duck": tr["id"] not in (duck.get("off") or [])})
            else:                                             # музыка из библиотеки пайплайна (lib:id) — как звук, без приглушения
                sfx_cues.append({"t": round(float(x.get("at") or 0) + sh, 3), "src": f, "gain": round(float(x.get("gain") if x.get("gain") is not None else 1) * g * tg, 4), "align": "", "clip": cc})
    vt_ = track_of(T, "voice", "voice")
    mixcfg = {"voice": track_gain(vt_), "duck": {k: duck[k] for k in ("on", "depth", "attack", "release")}}
    total = float(M.get("len") or 0) or max([u["at"] + u["len"] for u in unit_js] + [1])
    # --- голос: без голоса — «тихий» vo_timing на длину ролика (tts.py его перепишет, если появится сценарий с голосом)
    if not (M.get("voice") or {}).get("on"):
        vt = os.path.join(pd, "src", "vo_timing.js")
        cur = voice(vid)
        if not cur or cur["studio"] or not cur["words"]:
            vo_silent = {"total": total, "studio": True, "sections": [{"title": "монтаж без голоса", "start": 0, "dur": total, "silent": True, "words": []}]}
            A.write_text(vt, "window.VO = " + json.dumps(vo_silent, ensure_ascii=False, indent=1) + ";\n")
            os.makedirs(os.path.join(pd, "build"), exist_ok=True)             # audio.py читает build/vo_timing.json (как после tts.py)
            A.write_text(os.path.join(pd, "build", "vo_timing.json"), json.dumps(vo_silent, ensure_ascii=False, indent=1))
        else:
            report["warn"].append("в проекте есть голос, а в монтаже он выключен — голос останется в vo_timing.js (выключи его там или включи в монтаже)")
    os.makedirs(os.path.join(pd, "build"), exist_ok=True)
    A.write_text(os.path.join(pd, "build", "music.json"), json.dumps(music, ensure_ascii=False, indent=1))
    A.write_text(os.path.join(pd, "build", "mixcfg.json"), json.dumps(mixcfg, ensure_ascii=False, indent=1))
    _sync_audio_py(pd, report)
    vj = os.path.join(pd, "build", "vo_timing.json")              # монтаж длиннее голоса — ролик длиной в монтаж (звук: audio.py читает total отсюда)
    try:
        vo_j = json.load(open(vj, encoding="utf-8"))
        if float(vo_j.get("total") or 0) < total:
            vo_j["total"] = total
            A.write_text(vj, json.dumps(vo_j, ensure_ascii=False, indent=1))
    except (OSError, ValueError):
        pass
    # --- src/montage.js + src/scenes.js
    scene_data = {x["el"]: json.load(open(os.path.join(S, "scenes", x["el"], "scene.json"), encoding="utf-8")) for x in unit_js}
    cap_style, cap_fonts = {}, []                              # S9: субтитры по стилю канала (style/captions.json) и свои шрифты канала (style/fonts -> assets/fonts)
    try:
        import channel_api
        cdir = P.channel(P.index()["videos"].get(vid, {}).get("channel"))["dir"]
        cap_style = json.load(open(os.path.join(cdir, "style", "captions.json"), encoding="utf-8"))
        for fam, fp in channel_api.channel_fonts({"dir": cdir}):
            os.makedirs(os.path.join(pd, "assets", "fonts"), exist_ok=True)
            shutil.copy2(fp, os.path.join(pd, "assets", "fonts", os.path.basename(fp)))
            cap_fonts.append([fam, "../assets/fonts/" + os.path.basename(fp)])
    except (OSError, ValueError, TypeError, KeyError):
        pass
    mj = {"units": unit_js, "overlays": M.get("overlays") or [], "len": total, "captions": (M.get("captions") or {}).get("on", True), "plan": vid,
          "capStyle": {k: v for k, v in cap_style.items() if k != "note"}, "fonts": cap_fonts}
    A.write_text(os.path.join(pd, "src", "montage.js"),
                 "// СГЕНЕРИРОВАНО монтажом Claude Studio (S6, server/montage_api.py) — не правь руками, правь монтаж в приложении.\n"
                 f"const MONTAGE = {json.dumps(mj, ensure_ascii=False)};\n"
                 f"const MONTAGE_SFX = {json.dumps(sfx_cues, ensure_ascii=False)};\n"
                 f"const STUDIO_SCENES = {json.dumps(scene_data, ensure_ascii=False)};\n"
                 f"const SCENE_URLS = {{ lib: '../{STUDIO_DIR}/lib/', el: '../{STUDIO_DIR}/el/', anims: '../{STUDIO_DIR}/anims/', env: '../{STUDIO_DIR}/env/' }};\n"
                 "const SCENE_B = MONTAGE.units.map(u => u.at);\n"
                 "if (window.VO && VO.total < MONTAGE.len) VO.total = MONTAGE.len;   // монтаж длиннее голоса — ролик длиной в монтаж\n")
    A.write_text(os.path.join(pd, "src", "scenes.js"), SCENES_JS)
    A.write_text(os.path.join(pd, "src", "format.js"), A.lkapi().format_js(A, plan))   # кадр по формату видео + визуал канала (window.LOOK, S14)
    _patch_format(pd)
    _patch_index(pd, prefab_scripts)
    report.update(len=total, sfx=len(sfx_cues), music=len(music), voice=bool(words))
    return report


def _sync_audio_py(pd, report):
    """S23: audio.py проекта без плашек монтажа (render_clip) — обновить из шаблона, сохранив TALK и MUSIC проекта; старый — в build/audio_old.py."""
    cur = os.path.join(pd, "audio.py")
    try:
        old = open(cur, encoding="utf-8").read()
    except OSError:
        old = ""
    if "def render_clip" in old:
        return
    new = open(os.path.join(P.TEMPLATE, "audio.py"), encoding="utf-8").read()
    for name in ("TALK", "MUSIC"):                              # блок «NAME = {…}» до закрывающей скобки в начале строки
        rx = re.compile(r"^" + name + r" = \{.*?^\}\n", re.S | re.M)
        mo, mn = rx.search(old), rx.search(new)
        if mo and mn:
            new = new[:mn.start()] + mo.group(0) + new[mn.end():]
    if old:
        os.makedirs(os.path.join(pd, "build"), exist_ok=True)
        shutil.copy2(cur, os.path.join(pd, "build", "audio_old.py"))
    open(cur, "w", encoding="utf-8", newline="\n").write(new)
    report.setdefault("copied", []).append("audio.py (S23: плашки звука)")


def _pack_scene(A, vid, el, sc, wd, S, prefab_scripts, report, lib=None):
    """Сцена редактора -> проект ролика: prefabs.js (в своей области видимости), картинки, библиотека и черновики (lib: / el:), клипы, огибающие липсинка.
    Общее для генератора монтажа и быстрого монтажа (fast_api: препродакшен в коде)."""
    lib = lib or _lib_dir(A, vid)
    dst = os.path.join(S, "scenes", el)
    _copy(os.path.join(wd, "prefabs.js"), os.path.join(dst, "prefabs.js"))
    if el not in [x.split("/")[-2] for x in prefab_scripts]:  # у каждой сцены свои префабы — в своей области видимости (одинаковые имена не мешают)
        code = _scoped(os.path.join(dst, "prefabs.js"), el)
        # файлы черновиков по адресу сервера Studio ('/rscene/<plan>/<эл>/vN/model.glb' — агент сцены вписал пропс прямо в prefabs.js):
        # у страницы ролика такого адреса нет (404, «Земля не грузится») -> копия в assets/studio/rscene/… и адрес от корня проекта
        rrefs = set(re.findall(r"/rscene/" + re.escape(vid) + r"/([^'\"\s`)]+)", code))
        for ref in rrefs:
            if ".." not in ref:
                _copy(os.path.join(P.render(vid), *ref.split("/")), os.path.join(S, "rscene", *ref.split("/")))
        if rrefs:
            code = code.replace(f"/rscene/{vid}/", f"/{STUDIO_DIR}/rscene/")   # от корня проекта: модели грузятся относительно папки сцены, не страницы
        P.write_atomic(os.path.join(dst, "prefabs.scoped.js"), code)   # одной записью: тот же текст не трогает файл и кэш кадров
        prefab_scripts.append(f"../{STUDIO_DIR}/scenes/{el}/prefabs.scoped.js")
    # картинки префабов: '/files/<plan>/…' -> assets/studio/files/…
    pf = open(os.path.join(wd, "prefabs.js"), encoding="utf-8").read()
    for ref in set(re.findall(r"/files/" + re.escape(vid) + r"/([^'\"\s]+)", pf)):
        _copy(os.path.join(P.files(vid), *ref.split("/")), os.path.join(S, "files", *ref.split("/")))
    # библиотека и черновики: lib: / el: (объекты и scene.libs), клипы, огибающие липсинка
    refs = {(o.get("src") or {}).get("prefab") for o in sc.get("objects") or []} | set(sc.get("libs") or [])
    for o in sc.get("objects") or []:                    # предметы в руках (S10.2) и видео экранов (S10.3) — тоже из библиотеки
        refs |= {v for v in (o.get("hold") or {}).values() if isinstance(v, str)}
        for k, lst in (o.get("keys") or {}).items():
            for x in lst or []:
                v = x.get("v")
                if k.startswith("hold.") and isinstance(v, str):
                    refs.add(v)
                if k.startswith("ch.") and isinstance(v, dict) and isinstance(v.get("media"), str):
                    refs.add(v["media"])
        refs |= {v["media"] for v in (o.get("params") or {}).values() if isinstance(v, dict) and isinstance(v.get("media"), str)}
    for ref in filter(None, refs):
        m = re.match(r"lib:([a-z]+)/([a-z0-9-]+)@(\d+)$", ref)
        if m:
            kind, slug, v = m.groups()
            _copy(os.path.join(lib, kind, slug, "v" + v), os.path.join(S, "lib", kind, slug, "v" + v))
            _copy(os.path.join(lib, kind, slug, "emotions.json"), os.path.join(S, "lib", kind, slug, "emotions.json"))
            report["copied"].append(ref)
        m = re.match(r"el:([A-Za-z0-9_-]+)@v?(\d+)$", ref)
        if m:
            _copy(os.path.join(P.render(vid), m.group(1), "v" + m.group(2)), os.path.join(S, "el", m.group(1), "v" + m.group(2)))
            report["copied"].append(ref)
    anims = set()
    for o in sc.get("objects") or []:
        for c in o.get("clips") or []:
            anims.add(c["anim"])
        if o.get("walk") not in (None, "auto", "off"):
            anims.add(o["walk"])
    for a in anims:
        _copy(os.path.join(lib, "anims", *a.split("/")) + ".json", os.path.join(S, "anims", *a.split("/")) + ".json")
    cues = {c["id"]: c for c in A.scapi().sound_cues(A, "plan:" + vid, dict(sc, _el=el))}
    for o in sc.get("objects") or []:
        sid = (o.get("lipsync") or {}).get("sound")
        if sid and sid in cues:
            env = A.scapi().envelope(cues[sid]["file"])
            os.makedirs(os.path.join(S, "env"), exist_ok=True)
            P.write_atomic(os.path.join(S, "env", sid + ".json"), json.dumps({"sid": sid, "t0": cues[sid]["t"], "fps": 30, "env": env}))
    return dst


def _scoped(src, el):
    """prefabs.js сцены -> своя область видимости: window.SCENE_PREFABS[el] = { PREFABS, PICS } (const и function внутри — свои у каждой сцены). Возвращает текст."""
    code = open(src, encoding="utf-8").read()
    return (
        "// СГЕНЕРИРОВАНО монтажом (server/montage_api.py _scoped): prefabs.js сцены в своей области видимости — разные локации в одном ролике.\n"
        "window.SCENE_PREFABS = window.SCENE_PREFABS || {};\n"
        f"window.SCENE_PREFABS[{json.dumps(el)}] = (function () {{\n{code}\n;return {{ PREFABS: typeof PREFABS !== 'undefined' ? PREFABS : {{}}, PICS: typeof PICS !== 'undefined' ? PICS : {{}} }};\n}})();\n")


def _patch_format(pd):
    """Старые проекты: подключить src/format.js перед lib.js (index.html, review.html)."""
    for f in ("index.html", "review.html"):
        p = os.path.join(pd, "src", f)
        if os.path.isfile(p):
            s = open(p, encoding="utf-8").read()
            if "format.js" not in s and '<script src="lib.js"></script>' in s:
                P.write_atomic(p, s.replace('<script src="lib.js"></script>', '<script src="format.js"></script>\n<script src="lib.js"></script>', 1))


def _patch_index(pd, prefabs):
    """src/index.html: движок сцен редактора и монтаж между <!-- studio --> … <!-- /studio --> (вместо chars.js)."""
    p = os.path.join(pd, "src", "index.html")
    s = open(p, encoding="utf-8").read()
    block = "<!-- studio: монтаж Claude Studio (S6) -->\n" + "".join(f'<script src="{x}"></script>\n' for x in
             ["paper.js", "props3d.js", "rig.js", "scene.js", *prefabs, "montage.js"]) + "<!-- /studio -->\n"
    if "<!-- studio" in s:
        s = re.sub(r"<!-- studio.*?<!-- /studio -->\n", block, s, flags=re.S)
    else:
        s = s.replace('<script src="chars.js"></script>\n', "")
        s = s.replace('<script src="scenes.js"></script>', block + '<script src="scenes.js"></script>')
    P.write_atomic(p, s)


SCENES_JS = r"""// ======================================================================
// СГЕНЕРИРОВАНО монтажом Claude Studio (S6, server/montage_api.py) — не правь руками: правь монтаж в приложении (этап «Монтаж»).
// Юнит монтажа = сцена редактора (STUDIO_SCENES, prefabs.js) на отрезке ролика; карта времени MONTAGE.units[].map: [время сцены, время ролика | "w:<слово>"].
// ======================================================================
const ASSETS = { images: {}, sequences: {} };
(() => {                                                     // картинки префабов всех сцен (PICS: '/files/<plan>/…') — из assets/studio/files/
  for (const S of Object.values(window.SCENE_PREFABS || {}))
    for (const [k, v] of Object.entries(S.PICS || {})) ASSETS.images[k] = String(v).replace(/^\/files\/[^/]+\//, '../assets/studio/files/');
})();
const CAPTION_STYLE = MONTAGE.captions ? (MONTAGE.capStyle || undefined) : { off: true };   // стиль субтитров канала (S9)

// слова голоса (абсолютные моменты) — для карты «маркер к слову»
function montageWords() { const out = []; for (const s of VO.sections || []) for (const w of s.words || []) out.push(s.start + w.t); return out; }
function montagePairs(u) {
  const W = montageWords(), out = [];
  for (const [ts, tv] of u.map) {
    if (typeof tv === 'string' && tv.startsWith('w:')) { const t = W[+tv.slice(2)]; if (t != null) out.push([ts, t]); }
    else out.push([ts, u.at + tv]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}
// время ролика -> время сцены (кусочно-линейно, за краями — с шагом 1)
function montageSceneTime(u, T) {
  const P = u._pairs || (u._pairs = montagePairs(u));
  if (!P.length) return T - u.at;
  if (T <= P[0][1]) return P[0][0] + (T - P[0][1]);
  for (let i = 0; i < P.length - 1; i++) { const [a0, b0] = P[i], [a1, b1] = P[i + 1]; if (T <= b1) return a0 + (a1 - a0) * (T - b0) / ((b1 - b0) || 1); }
  const L = P[P.length - 1]; return L[0] + (T - L[1]);
}
// надписи монтажа (POV, заметки) — поверх кадра по времени ролика
function montageOverlays(ctx, T) {
  for (const o of MONTAGE.overlays || []) {
    const lt = T - o.at; if (lt < 0 || lt > o.dur) continue;
    const a = Math.min(1, lt / 0.35, (o.dur - lt) / 0.35);
    ctx.save(); ctx.globalAlpha *= Math.max(0, a);
    if (o.kind === 'pov' || o.kind === 'title') {
      ctx.font = font(o.size || 64, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
      const lines = wrapLines(ctx, o.text || '', W - 140), y0 = o.y || 150, lh = (o.size || 64) * 1.15;
      lines.forEach((l, i) => { ctx.lineWidth = 14; ctx.strokeStyle = '#000'; ctx.strokeText(l, W / 2, y0 + i * lh); ctx.fillStyle = '#fff'; ctx.fillText(l, W / 2, y0 + i * lh); });
    } else if (typeof note === 'function') note(ctx, o.pos ? o.pos[0] : W / 2, o.pos ? o.pos[1] : 400, o.text || '', { rot: -0.03 });
    ctx.restore();
  }
}
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) { let line = ''; for (const w of para.split(' ')) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; } out.push(line); }
  return out;
}

// миры сцен: библиотека (lib: / el:), клипы, липсинк — до построения (main.js ждёт STUDIO_READY)
const MONTAGE_WORLDS = {};
window.STUDIO_READY = async () => {
  for (const [fam, url] of MONTAGE.fonts || []) { try { const ff = new FontFace(fam, `url(${url})`); document.fonts.add(ff); await ff.load(); } catch (e) { console.warn('шрифт канала', fam, e); } }
  const load = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('не загрузилось: ' + src)); document.head.append(s); });
  for (const u of MONTAGE.units) {
    if (MONTAGE_WORLDS[u.el]) continue;
    const sc = STUDIO_SCENES[u.el];
    const LIB = await loadSceneProps(scenePropRefs(sc), MONTAGE.plan, load, {}, sc);
    await loadSceneEnvs(sc, MONTAGE.plan, u.el);
    MONTAGE_WORLDS[u.el] = sceneWorld(sc, ((window.SCENE_PREFABS || {})[u.el] || {}).PREFABS || {}, LIB);
  }
};

const SCENES = MONTAGE.units.map((u, k) => ({
  name: u.name,
  trans: (u.trans || {}).type || 'cut',
  transDur: (u.trans || {}).dur,
  draw(ctx, lt, D, T) {
    const w = MONTAGE_WORLDS[u.el]; if (!w) return;
    const ts = Math.max(0, montageSceneTime(u, T));
    w.draw(ctx, ts, D, ts);
    if (w.S) drawSceneOverlays(w.S, ctx, ts);
    montageOverlays(ctx, T);
  },
  sfx(add) { if (k === 0) for (const c of MONTAGE_SFX) add(c.t, c.src, c.gain, c.align || undefined, c.clip); },
}));
"""


# ---------------------------------------------------------------- сборка
def bash_env(env):
    """build.sh зовёт python, node, ffmpeg: у процесса Studio (окно-приложение, ярлык) PATH бывает без Python — тогда «python: command not found».
    Папка того Python, на котором работает сервер, — первой в PATH."""
    return P.tool_env(env)                                    # S22: + утилиты Git Bash, node, ffmpeg (paths.tool_env)


def _bash():
    # S22: сначала Git Bash. shutil.which("bash") при урезанном PATH окна-приложения находит C:\Windows\System32\bash.exe — это WSL (Linux):
    # build.sh шёл внутри Linux, где Windows-Python нет, — отсюда 71 «python: command not found». WSL-обёртку не берём никогда.
    for c in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe", shutil.which("bash")):
        if c and os.path.isfile(c) and "system32" not in c.lower() and "windowsapps" not in c.lower():
            return c
    raise RuntimeError("не найден bash (Git Bash) для build.sh")


def build(A, job):
    """🔨 монтаж -> проект -> build.sh (кадры, звук, mp4) с прогрессом."""
    vid = job.key[5:]
    if A.load("plan:" + vid).get("locations"):             # S13: видео на локациях — сборка = клипы сцен (кэш окна видео) + склейка со звуком
        job.cancelled = getattr(job, "cancelled", False)
        job.meta = {}
        out = A.clapi().render(A, job, export=True)
        job.result = {"file": out, "report": {"len": (A.load("plan:" + vid).get("montage") or {}).get("len") or 0}}
        job.summary = f"готово: {os.path.basename(out)} · " + job.summary
        return
    rep = generate(A, vid)
    pd = vdir(vid)
    job.summary = "собираю: звук…"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    if A.load("plan:" + vid).get("fast"):
        env["FPS"] = "30"                                    # быстрый монтаж: черновая сборка 30 к/с (вдвое меньше кадров); финал — «Экспорт»
    proc = subprocess.Popen([_bash(), "build.sh"], cwd=pd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=bash_env(env), text=True, encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    job.proc = proc
    log = []
    for line in proc.stdout:
        line = line.rstrip()
        log.append(line)
        m = re.match(r"(\d+)/(\d+)\s", line)
        if m:
            job.summary = f"кадры {m.group(1)} из {m.group(2)}"
        elif "music ok" in line or "sfx ok" in line:
            job.summary = "собираю: звук…"
        elif line.startswith("frames done"):
            job.summary = "кодирую mp4…"
        elif line.startswith("[gpu]"):                         # S22: ждёт замок видеокарты
            job.summary = line[6:]
    proc.wait()
    if proc.returncode:
        raise RuntimeError("build.sh: " + "\n".join(log[-12:]))
    if A.load("plan:" + vid).get("fast"):
        fast_done(A, vid)
    outs = sorted(glob.glob(os.path.join(pd, "out", "*.mp4")), key=os.path.getmtime)
    main = [o for o in outs if not o.endswith("_NO_VO.mp4")]
    lines, chk = project_check(A, vid)                       # S22: сценарий новее сцен + промахи WT() (их записал рендер кадров)
    job.result = {"file": (main or outs)[-1] if outs else "", "report": rep, "check": chk}
    job.summary = f"готово: {os.path.basename(job.result['file'])} · {rep['len']:.1f} с" + (f" · ⚠ проверка: {len(lines)}" if lines else "")
    if lines:
        try:
            import notify_api
            notify_api.add("error", f"Сборка: {len(chk['wt'])} ❌ привязок, {len(chk['drift'])} ⚠ сценарий новее сцен", "\n".join(lines[:6]), vid, None, None, "⚠",
                           dedup=f"check:{vid}:{hash(tuple(lines))}")
        except Exception:
            pass


def run_job(A, job):
    if job.kind == "montagebuild":
        build(A, job)
        return True
    return False


# ---------------------------------------------------------------- S11: живой звук монтажа — страница сводит сама (Web Audio), правки слышны сразу
def _src_urls(A, vid, src, plan, scene_el=None):
    """src звука -> [{url, at, gain, lib, peak}] — те же источники, что у генератора (_sound_files), но адресами для страницы, без копирования."""
    if src.startswith("el:"):
        e = A._by_id(plan.get("elements"), src[3:])
        return [{"url": "/" + m["s"]["file"], "at": float(m.get("at") or 0), "gain": float(m.get("gain") or 1)} for m in (A.pr().el_mix(e) if e else []) if m.get("s", {}).get("file")]
    m = re.match(r"lib:sounds/([a-z0-9-]+)@(\d+)$", src)
    if m:
        d = os.path.join(_lib_dir(A, vid), "sounds", m.group(1), "v" + m.group(2))
        try:
            fs = sorted(x for x in os.listdir(d) if x.lower().endswith((".wav", ".mp3", ".ogg", ".flac")))
        except OSError:
            fs = []
        return [{"url": f"/api/lib/file/video:{vid}/sounds/{m.group(1)}/v{m.group(2)}/{f}", "at": 0.0, "gain": 1.0} for f in fs]
    if src.startswith("file:"):
        f = src[5:]
        if scene_el:                                            # звук сцены — от её work/
            return [{"url": f"/rscene/{vid}/{scene_el}/work/{f}", "at": 0.0, "gain": 1.0}]
        return [{"url": f"/api/montage/file?video={vid}&p={f}", "at": 0.0, "gain": 1.0}]
    m = re.match(r"lib:([^|]+)(?:\|([\d.]+)\|([\d.]+))?$", src)
    if m:                                                       # библиотека пайплайна: нормируется к пику 0.9, пик — из index.json
        _ = lib_sounds()
        peak = _LIBPEAK.get(m.group(1))
        return [{"url": f"/sfxlib/{m.group(1)}.wav", "at": 0.0, "gain": 1.0, "lib": True, "peak": peak,
                 **({"off": float(m.group(2)), "len": float(m.group(3))} if m.group(2) else {})}]
    return []


def audiomap(A, vid):
    """Всё, что нужно странице, чтобы играть звук монтажа живьём: источники (адреса и слои), звуки сцен (во времени сцены), голос по секциям."""
    plan = A.load("plan:" + vid)
    M = plan.get("montage") or {}
    srcs, scenes_ = {}, {}
    want = {x.get("src") for x in (M.get("sfx") or []) + (M.get("music") or []) if x.get("src")}
    for s in scenes(A, vid, plan):
        doc = _scene_doc(A, vid, s["el"]) or {}
        lst = []
        own = None                                              # S13: сцена монтажа — править можно только звуки её оверлея (звуки локации — в локации)
        if s.get("location"):
            try:
                own = {x.get("id") for x in json.load(open(os.path.join(P.render(vid), s["el"], "overlay.json"), encoding="utf-8")).get("sounds") or []}
            except (OSError, ValueError):
                own = set()
        for x in doc.get("sounds") or []:
            sr = x.get("src") or ""
            key = f"{s['el']}|{sr}" if sr.startswith("file:") else sr
            if key not in srcs:
                srcs[key] = _src_urls(A, vid, sr, plan, s["el"] if sr.startswith("file:") else None)
            lst.append({"id": x.get("id"), "t": float(x.get("t") or 0), "src": key, "raw": sr, "gain": float(x.get("gain") if x.get("gain") is not None else 1), "align": x.get("align") or "",
                        "note": x.get("note") or "", "by": x.get("by") or "", **({"loc": True} if own is not None and x.get("id") not in own else {}),
                        **{k: x[k] for k in CLIP_KEYS + ("track",) if k in x}})
        scenes_[s["el"]] = lst
    for sr in want:
        if sr not in srcs:
            srcs[sr] = _src_urls(A, vid, sr, plan)
    vo = voice(vid) or {}
    pd = vdir(vid) or ""
    vsec = []
    if not vo.get("studio"):
        for x in vo.get("sections") or []:
            f = x.get("file")
            if f and not x.get("silent"):
                rel = os.path.relpath(f, pd).replace("\\", "/") if os.path.isabs(f) else f
                vsec.append({"at": x["start"], "url": f"/api/montage/file?video={vid}&p={rel}"})
    return {"srcs": srcs, "scenes": scenes_, "voice": vsec}


# ---------------------------------------------------------------- S11: раскладка по сценарию (без Claude)
def _tnorm(s):
    s = re.sub(r"^[\s\d:.,–—-]+", "", s or "")                  # «0:04–0:07.15 — ДВОЙНОЙ КЛИК» -> «ДВОЙНОЙ КЛИК»
    return re.sub(r"[^\wа-яё]+", "", s.lower().replace("ё", "е"))


def auto_layout(A, vid):
    """Каждой сцене сценария (секции голоса) — сцена препродакшена (по e.script.title, иначе по порядку); юнит стоит там, где звучит
    его секция, и длится до следующей; сцена растягивается / ускоряется под эту длину (map). Без голоса — сцены подряд своей длиной.
    Возвращает (монтаж, отчёт). Звуки сцен идут сами; sfx / музыку — агент или руками."""
    doc = A.load("plan:" + vid)
    sc = scenes(A, vid, doc)
    if not sc:
        raise ValueError("нет сцен в редакторе — в препродакшене нарисуй сцены (3D-сцена сама уходит в редактор)")
    old = doc.get("montage") or {}
    vo = voice(vid)
    secs = [s for s in ((vo or {}).get("sections") or [])] if vo and not vo.get("studio") else []
    report = []
    units = []
    if not secs:
        at = 0.0
        for i, s in enumerate(sc):
            units.append({"id": f"u{i + 1}", "scene": s["el"], "at": round(at, 3), "len": s["len"], "map": [[0, 0], [s["len"], s["len"]]], "trans": {"type": "cut", "dur": 0}})
            at += s["len"]
        report.append("голоса нет — сцены подряд своей длиной")
        total = at
    else:
        by_title = {}
        for s in sc:
            for t in s.get("scripts") or []:                    # сцена может покрывать несколько сцен сценария подряд
                by_title.setdefault(_tnorm(t), s)
        st = [_tnorm(x.get("title")) for x in secs]
        free = [s for s in sc if not any(_tnorm(t) in st for t in s.get("scripts") or [])]
        total = float(vo.get("total") or 0)
        pick = []                                               # секция -> (сцена, как)
        for sec in secs:
            s = by_title.get(_tnorm(sec.get("title")))
            how = "по сценарию"
            if not s and free:
                s, how = free.pop(0), "по порядку"
            pick.append((s, how))
        i = 0
        while i < len(secs):
            sec, (s, how) = secs[i], pick[i]
            if not s:
                report.append(f"«{sec.get('title')}» — нет сцены (сделай в препродакшене или отметь в карточке сцены «📝 сцены сценария»)"); i += 1; continue
            j = i
            while j + 1 < len(secs) and pick[j + 1][0] is s:    # подряд та же сцена — один юнит на все её секции
                j += 1
            at = 0.0 if not units else float(sec["start"])
            end = float(secs[j + 1]["start"]) if j + 1 < len(secs) else max(total, float(secs[j]["start"]) + float(secs[j].get("dur") or 0))
            if j > i:
                how += f", секции {i + 1}–{j + 1}"
            i = j
            ln = round(max(0.3, end - at), 3)
            k = s["len"] / ln if ln else 1
            if k > 1.45:                                       # сцена сильно длиннее голоса: не гоним в 2–3 раза — играет как есть, хвост обрезан
                mp, note = [[0, 0], [ln, ln]], f" — сцена длиннее на {s['len'] - ln:.1f} с: обрезана (ускорить / укоротить — в сцене или «✨ Смонтировать»)"
            else:
                mp, note = [[0, 0], [s["len"], ln]], (f" — скорость ×{k:.2f}" + (" ⚠ медленно" if k < 0.7 else "") if abs(k - 1) > 0.03 else "")
            units.append({"id": f"u{len(units) + 1}", "scene": s["el"], "at": round(at, 3), "len": ln, "map": mp, "trans": {"type": "cut", "dur": 0}})
            report.append(f"«{sec.get('title')}» ← «{s['name']}» ({how}), {ln:.2f} с" + note)
            i += 1
    spoken = any(not x.get("silent") for x in secs)               # только тихие биты (ролик без диктора) — голос и субтитры выключены
    M = {"units": units, "voice": {"on": spoken}, "captions": {"on": spoken and (old.get("captions") or {"on": True}).get("on", True)},
         "sfx": old.get("sfx") or [], "music": old.get("music") or [], "overlays": old.get("overlays") or [],
         "len": round(max([total] + [u["at"] + u["len"] for u in units]), 3)}
    return M, report


def handle_get(A, h, p, q):
    if p == "/api/montage/out":                              # готовый ролик: имя и время (страница монтажа ловит новый mp4 сразу, кто бы его ни собрал)
        pd = vdir((q.get("video") or [""])[0])
        outs = [x for x in sorted(glob.glob(os.path.join(pd or "", "out", "*.mp4")), key=os.path.getmtime) if not x.endswith("_NO_VO.mp4")]
        h._json({"file": os.path.basename(outs[-1]) if outs else "", "mtime": int(os.path.getmtime(outs[-1]) * 1000) if outs else 0}); return True
    if p == "/api/montage/audiomap":                         # S11: живой звук монтажа
        h._json(audiomap(A, (q.get("video") or [""])[0])); return True
    if p == "/api/montage/file":                             # файл проекта ролика (голос по секциям, звуки монтажа file:) — только внутри папки видео
        pd = vdir((q.get("video") or [""])[0]) or ""
        rel = os.path.normpath((q.get("p") or [""])[0]).replace("\\", "/")
        f = os.path.join(pd, rel)
        if not pd or rel.startswith("..") or os.path.isabs(rel) or not os.path.isfile(f):
            h.send_error(404); return True
        A._send_file(h, f); return True
    if p == "/api/montage/mix":                              # S11: звук предпросмотра — сведённый микс проекта (build/mix.wav: голос, звуки сцен, sfx, музыка)
        f = os.path.join(vdir((q.get("video") or [""])[0]) or "", "build", "mix.wav")
        if not os.path.isfile(f):
            h.send_error(404); return True
        A._send_file(h, f); return True
    if p == "/api/montage/video":                            # S11: готовый ролик (out/*.mp4) — смотреть прямо на монтаже
        pd = vdir((q.get("video") or [""])[0])
        outs = [x for x in sorted(glob.glob(os.path.join(pd or "", "out", "*.mp4")), key=os.path.getmtime) if not x.endswith("_NO_VO.mp4")]
        if not outs:
            h.send_error(404); return True
        A._send_file(h, outs[-1]); return True
    if p == "/api/montage":
        h._json(get(A, (q.get("video") or [""])[0])); return True
    if p == "/api/montage/at":
        h._json(at(A, (q.get("video") or [""])[0], float((q.get("t") or ["0"])[0] or 0))); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/montage/redo":                             # ⚡ сделать заново: старый код ролика — в архив, быстрый монтаж с нуля
        h._json(fast_redo(A, body["video"], body.get("wish") or "")); return True
    if p == "/api/montage/fast":                             # ⚡ быстрый монтаж: агент пишет ролик кодом (2D и 3D), без препродакшена
        h._json(fast_start(A, body["video"], body.get("wish") or "")); return True
    if p == "/api/montage/gen":                              # предпросмотр: монтаж -> файлы проекта (без рендера)
        h._json({"ok": True, "report": generate(A, body["video"])}); return True
    if p == "/api/montage/fix":                              # S8: ✋ правка в кадре ревью -> пометка с точными операциями сцены и «почему»
        ops = body.get("ops") or []
        if not ops:
            raise ValueError("в кадре ничего не поменяно")
        item = {"id": A.new_id("f"), "el": body["el"], "vt": float(body.get("vt") or 0), "ts": float(body.get("ts") or 0), "ops": ops,
                "why": (body.get("why") or "").strip(), "status": "open", "created": now_ms(), "desc": (body.get("desc") or "")[:300]}
        A.apply_ops("plan:" + body["video"], [{"op": "add", "path": ["fixes"], "item": item}])
        h._json({"ok": True, "fix": item}); return True
    if p == "/api/montage/audio":                            # S11: пересвести звук для предпросмотра (build.sh audio: звуки сцен + audio.py, секунды)
        vid = body["video"]
        pd = vdir(vid)
        if not pd or not has_project(vid):
            raise ValueError("нет проекта ролика")
        t0 = time.time()
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        r = subprocess.run([_bash(), "build.sh", "audio"], cwd=pd, env=bash_env(env), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode != 0 or not os.path.isfile(os.path.join(pd, "build", "mix.wav")):
            raise ValueError("звук не свёлся: " + (r.stdout + r.stderr)[-400:])
        h._json({"ok": True, "ms": int((time.time() - t0) * 1000)}); return True
    if p == "/api/montage/auto":                             # S11: ⚡ разложить по сценарию — сохраняет монтаж и файлы предпросмотра
        M, rep = auto_layout(A, body["video"])
        A.apply_ops("plan:" + body["video"], [{"op": "set", "path": ["montage"], "value": M}])
        generate(A, body["video"])
        h._json({"montage": M, "report": rep}); return True
    if p == "/api/montage/guard":                            # S21 🛡 сторож (без Claude): итог — в video.json guard, засечки на таймлайне
        text, G = guard(A, body["video"], body.get("args") or [])
        g = A.load("plan:" + body["video"]).get("guard") or {}                # n — открытые (без «✓ так задумано»)
        h._json({"ok": G is not None, "text": text, "n": g.get("n", 0), "bad": g.get("bad", 0), "note": (G or {}).get("note") or ""}); return True
    if p == "/api/montage/build":
        j = A.start_job("montagebuild", "plan:" + body["video"], "montage", {})
        h._json({"job": j.info()}); return True
    return False


def guard_bad(x):
    """серьёзная находка: персонаж застрял, рывок, мерцание (z-fighting, моргание объекта, мерцание по mp4 — 2+ вспышки)"""
    return x.get("type") in ("pop", "zfight", "blink") or (x.get("type") == "flicker" and (x.get("n") or 1) > 1) or bool(x.get("char"))


def guard(A, vid, args=(), save=True):
    """S21 «Сторож монтажа» (docs/studio/stage21-guard.md): stands/guard.js в папке проекта — 3D-объекты не входят друг в друга и не пропадают рывком.
    args: --scenes 3,5 | --from a --to b | --fps 10 | --no-shots | --no-fix (не раздвигать самому) | --no-video (без проверки мерцания по mp4). Итог -> video.json guard {at, n, bad, issues[], sheet} (засечки на таймлайне). -> (текст, json)."""
    pd = vdir(vid)
    if not pd or not has_project(vid):
        return "у видео нет проекта ролика — studio.py produce " + vid, None
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", REVIEW_PORT=str(A.stapi().project_port(pd)))
    try:
        r = subprocess.run(["node", os.path.join(P.STUDIO, "stands", "guard.js"), *args], cwd=pd, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=900, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        text = (r.stdout + ("\n" + r.stderr if r.returncode else "")).strip()
    except subprocess.TimeoutExpired:
        return "сторож не уложился в 15 минут", None
    try:
        G = json.load(open(os.path.join(pd, "build", "guard.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return text or "сторож не отработал", None
    # «Авто + отчёт»: сцены монтажа из данных — пересечения раздвигаются операцией сцены (не анимированный объект, по полу; ручное автора — нет),
    # потом монтаж пересобирается и сторож проходит ещё раз. Быстрый монтаж (код) — только отчёт: чинит писатель.
    fixes = [x["fix"] for x in G.get("issues") or [] if x.get("fix")]
    if fixes and "--no-fix" not in args and not A.load("plan:" + vid).get("fast"):
        done, skip = [], []
        for f in fixes:
            try:
                r = A.scapi().apply(A, "plan:" + vid, f["el"], [{"op": "set", "path": ["objects", f["id"], "pos"], "value": f["pos"]}],
                                    by="claude", desc=f"🛡 сторож: «{f['name']}» отодвинут на {round(f['by'] * 100)} см — застревал")
                (done if r.get("ops") else skip).append(f"«{f['name']}» на {round(f['by'] * 100)} см" if r.get("ops") else f"«{f['name']}»: без изменений")
            except Exception as e:
                skip.append(f"«{f['name']}»: {str(e)[:120]}")
        if done:
            try:
                generate(A, vid)
            except Exception as e:
                skip.append(f"montage gen: {str(e)[:120]}")
            text2, G2 = guard(A, vid, [a for a in args if a != "--fix"] + ["--no-fix"], save)
            return (f"🔧 поправил сам (сдвиг по полу): {', '.join(done)}" + (f"\nне тронул: {'; '.join(skip)}" if skip else "") +
                    "\nПовторная проверка:\n" + text2), G2
        if skip:
            text += "\nавтоисправление не вышло: " + "; ".join(skip)
    partial = any(a in args for a in ("--scenes", "--from", "--to"))
    # S21.2 мерцание по ГОТОВОМУ ролику (пиксели: видит и 2D, и 3D, и эффекты) — stands/flicker.py
    mp4 = fast_out(pd)
    if mp4 and not partial and "--no-video" not in args:
        fj = os.path.join(pd, "build", "flicker.json")
        try:
            r = subprocess.run([sys.executable, os.path.join(P.STUDIO, "stands", "flicker.py"), mp4, "--json", fj, "--sheet", os.path.join(pd, "build", "flicker.png")],
                               cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            stale = os.path.getmtime(mp4) < fast_src_mtime(pd)
            text += "\n" + (r.stdout.strip() or r.stderr.strip()[-400:]) + ("\n⚠ ролик собран до последних правок кода — мерцание проверено по старой сборке; пересоберите и проверьте снова" if stale else "")
            FL = json.load(open(fj, encoding="utf-8"))
            Bs = G.get("B") or [0]
            for x in FL.get("issues") or []:
                k = max([i for i, b in enumerate(Bs) if b <= x["t0"]] or [0])
                x.update({"k": k, "scene": (G.get("names") or [""] * (k + 1))[k] if k < len(G.get("names") or []) else "", "a": x["where"], "stale": stale})
                G.setdefault("issues", []).append(x)
            G["sheet2"] = FL.get("sheet")
        except Exception as e:
            text += f"\nмерцание по mp4 не проверилось: {str(e)[:200]}"
    elif not mp4 and not partial:
        text += "\nмерцание по mp4: ролик ещё не собран — проверю после сборки"
    if save and not partial:   # частичный прогон не затирает общий итог
        keep = ("type", "k", "scene", "a", "b", "t", "t0", "t1", "lt", "lt0", "lt1", "depth", "dir", "area", "dist", "char", "shot", "tShot",
                "n", "len", "where", "x", "y", "box", "share", "parts", "stale")
        iss = [{k: x[k] for k in keep if k in x} for x in G.get("issues") or []]
        # находки — правки (вкладка «Правки», «Исправить все»): постоянный id (что, кто, сцена) — «✓ так задумано» (status ok) переживает новые прогоны
        import hashlib
        was = {x.get("id"): x.get("status") for x in ((A.load("plan:" + vid).get("guard") or {}).get("issues") or []) if x.get("id")}
        seen = set()
        for x in iss:
            ks = ("type", "where", "k") if x.get("type") == "flicker" else ("type", "a", "b", "k", "dir")       # мерцание — место и сцена (время плавает после правок)
            base = "g" + hashlib.md5("|".join(str(x.get(k, "")) for k in ks).encode("utf-8")).hexdigest()[:8]
            i, n = base, 2
            while i in seen:
                i, n = f"{base}{n}", n + 1
            seen.add(i)
            x["id"] = i
            if was.get(i) == "ok":
                x["status"] = "ok"
        live = [x for x in iss if x.get("status") != "ok"]
        sheet = G.get("sheet") and os.path.join(pd, G["sheet"]).replace("\\", "/")
        A.apply_ops("plan:" + vid, [{"op": "set", "path": ["guard"], "value": {
            "at": int(time.time()), "n": len(live), "bad": sum(1 for x in live if guard_bad(x)), "issues": iss[:100], "sheet": sheet,
            "sheet2": G.get("sheet2") and os.path.join(pd, G["sheet2"]).replace("\\", "/"),
            "info": G.get("info") or {}, "note": G.get("note") or ""}}])
    return text, G


def cli(A, argv):
    """montage show <видео> | gen <видео> | build <видео> | pp <видео> (быстрый ролик: препродакшен заново в код) | guard <видео> [--scenes 3,5] (сторож: застревания и рывки в 3D)
    | tracks <видео> (S23: дорожки звука и плашки) | clip <видео> add '<json>' | set <id> '<json>' | del <id> [--force] (S23: плашка звука; 🔒 автора — только с --force)"""
    if len(argv) < 2:
        print(cli.__doc__); return True
    cmd, vid = argv[0], argv[1]
    if cmd == "brief":                                       # S7: монтаж для агента — коротко, со словами голоса по номерам
        g = get(A, vid)
        M, vo = g["montage"], g["voice"] or {}
        print(f"Проект: {g['folder']} ({'есть' if g['project'] else 'нет — studio.py produce'}) · монтаж {'сохранён' if g['saved'] else 'по умолчанию'} · длина {M.get('len')} с")
        print("Монтаж:", json.dumps({k: M.get(k) for k in ("units", "voice", "captions", "sfx", "music", "overlays", "len", "tracks", "duck") if k in M or k not in ("tracks", "duck")}, ensure_ascii=False))
        print("Дорожки звука (S23): " + "; ".join(f"{t['id']} «{t.get('name')}» {t['kind']}" + (f" {t.get('gain')} dB" if t.get("gain") else "") + (" M" if t.get("mute") else "")
                                                 for t in tracks(M)) + " · у плашки: track, at, src, gain (множитель), in, out, dur, loop {a, xf}, fadeIn, fadeOut, align, note")
        mine = [f"{x.get('id')} «{x.get('note') or x.get('src')}»" for lst in ("sfx", "music") for x in M.get(lst) or [] if x.get("by") == "author"]
        if mine:
            print("🔒 Поставил / поправил автор (не меняй и не удаляй без его «да» — [[выбор: Меняй | Не трогай]], потом --force): " + ", ".join(mine))
        for s in g["scenes"]:
            print(f"Сцена EL={s['el']} «{s['name']}» {s['len']} с" + (f" · 📝 сцена сценария «{s['script']}»" if s.get("script") else "")
                  + f" · склейки {s['cuts']} · маркеры {[(m['t'], m['name']) for m in s['markers']]} · звуков {s['sounds']}")
        if vo.get("sections") and not vo.get("studio"):
            print("Секции голоса (сцены сценария): " + "; ".join(f"[{i}] {x.get('title')} {x['start']}–{round(x['start'] + (x.get('dur') or 0), 2)} с" + (" (тихий бит)" if x.get("silent") else "")
                                                         for i, x in enumerate(vo["sections"])))
        W = [w for w in vo.get("words") or []] if not vo.get("studio") else []
        print(f"Голос: {'нет (python tts.py / montage tts)' if not W else str(vo.get('total')) + ' с'}")
        if W:
            print("Слова (номер:слово@время): " + " ".join(f"{w['i']}:{w['w']}@{w['t']}" for w in W))
        print("Звуки препродакшена:", "; ".join(f"{s['src']} «{s['name']}» {s['dur']} с" for s in g["sources"]) or "—")
        print("Собранный ролик:", (g["out"] or ["ещё нет"])[0])
        return True
    if cmd == "tracks":                                      # S23: дорожки и плашки звука коротко
        M = (A.load("plan:" + vid).get("montage") or {})
        for t in tracks(M):
            items = [x for lst in ("sfx", "music") for x in M.get(lst) or [] if track_of(tracks(M), x.get("track"), "music" if lst == "music" else "sfx")["id"] == t["id"]]
            print(f"{t['id']} «{t.get('name')}» {t['kind']} {t.get('gain') or 0} dB{' · заглушена' if t.get('mute') else ''}: "
                  + ("; ".join(f"{x['id']}{'🔒' if x.get('by') == 'author' else ''} {x.get('at')} с {x.get('src')}" + (f" dur {x['dur']}" if x.get("dur") else "") + (" ↻" if x.get("loop") else "") for x in items) or "—"))
        print("приглушение под голос:", json.dumps(dict(DUCK, **(M.get("duck") or {})), ensure_ascii=False))
        return True
    if cmd == "clip":                                        # S23: montage clip <видео> add '<json>' | set <id> '<json>' | del <id> [--force]
        key, M = "plan:" + vid, (A.load("plan:" + vid).get("montage") or {})
        if not M:
            print("монтажа ещё нет"); return True
        import copy as _cp
        N, act = _cp.deepcopy(M), argv[2] if len(argv) > 2 else ""
        if act == "add":
            it = json.loads(argv[3])
            lst = "music" if (it.pop("kind", "") == "music" or track_of(tracks(M), it.get("track"), "music")["id"] == it.get("track")) else "sfx"
            it.setdefault("id", A.new_id("x"))
            N.setdefault(lst, []).append(it)
        elif act in ("set", "del"):
            cid = argv[3]
            lst = next((l for l in ("sfx", "music") if any(x.get("id") == cid for x in N.get(l) or [])), None)
            if not lst:
                print(f"нет плашки {cid} (звуки сцен правятся scene ops <видео> <сцена>)"); return True
            if act == "del":
                N[lst] = [x for x in N[lst] if x.get("id") != cid]
            else:
                x = next(x for x in N[lst] if x.get("id") == cid)
                for k, v in json.loads(argv[4]).items():
                    if v is None:
                        x.pop(k, None)
                    else:
                        x[k] = v
        else:
            print(cli.__doc__); return True
        bad = author_changes(M, N)
        if bad and "--force" not in argv:
            print("⛔ Это автор поставил или поправил руками (🔒): " + "; ".join(bad) + ". Спроси [[выбор: Меняй | Не трогай]], после «Меняй» — тот же вызов с --force."); return True
        A.apply_ops(key, [{"op": "set", "path": ["montage"], "value": N}])
        print("ок:", act, "— montage gen, чтобы услышать в проекте")
        return True
    if cmd == "pp":                                          # быстрый ролик: препродакшен видео заново в код проекта (src/montage.js: PP_ALL, ppAdd, PP2D, звуки) — после lib import / нового элемента
        if not has_project(vid):
            print("у видео нет проекта ролика"); return True
        text, n = A.fsapi().pack_preprod(A, vid)
        print(f"препродакшен в проекте обновлён: {n} строк\n{text}")
        return True
    if cmd in ("tts", "check", "snap"):                      # S7: голос, проверка сценария, кадры ролика — в папке проекта
        pd = vdir(vid)
        if not has_project(vid):
            print("у видео нет проекта ролика — studio.py produce " + vid); return True
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if cmd == "snap":                                    # кадры ролика: страница проекта через его локальный скрипт ревью
            ts = argv[2] if len(argv) > 2 else "1,3,5"
            env["REVIEW_PORT"] = str(A.stapi().project_port(pd))
            out = os.path.join(pd, "build", "snap_agent.png")
            r = subprocess.run(["node", "render.js", "snap", ts, "build/snap_agent.png"], cwd=pd, env=env, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=300, creationflags=cf)
            err = [ln for ln in (r.stdout + r.stderr).splitlines() if "pageerror" in ln or "Error" in ln]
            print(out.replace("\\", "/") if os.path.isfile(out) else "кадры не снялись", *err[:5], sep="\n")
            return True
        script = "tts.py" if cmd == "tts" else "check_script.py"
        if cmd == "check":                                   # S16: свежая карта подачи для сверки сценария с ней
            try:
                A.rbapi().export(A, vid)
            except Exception as e:
                print("! карта подачи:", e)
        if cmd == "tts":                                     # S11: голос — запись диктора: нейросеть её не затирает (переозвучить — на этапе «Голос»)
            try:
                if json.load(open(os.path.join(pd, "build", "vo", "source.json"), encoding="utf-8")).get("kind") == "rec":
                    print("голос — запись диктора: tts не запускаю (после правки VO — voice align " + vid + "; вернуть нейросеть — этап «Голос»)"); return True
            except (OSError, ValueError):
                pass
        r = subprocess.run([sys.executable, script], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, creationflags=cf)
        print((r.stdout + r.stderr)[-4000:])
        return True
    if cmd == "show":
        print(json.dumps(get(A, vid), ensure_ascii=False, indent=1)); return True
    if cmd == "auto":                                        # S11: разложить по сценарию (без Claude); --save — записать в видео
        M, rep = auto_layout(A, vid)
        print("\n".join(rep))
        if "--save" in argv:
            A.apply_ops("plan:" + vid, [{"op": "set", "path": ["montage"], "value": M}])
            print("монтаж сохранён:", len(M["units"]), "юнитов,", M["len"], "с")
        else:
            print(json.dumps(M, ensure_ascii=False))
        return True
    if cmd == "guard":                                       # S21 сторож монтажа: застревания и рывки в 3D (без картинок) -> build/guard.json + лист кадров
        text, _ = guard(A, vid, argv[2:])
        print(text); return True
    if cmd == "gen":
        print(json.dumps(generate(A, vid), ensure_ascii=False, indent=1)); return True
    if cmd in ("needs", "verify", "continuity"):            # S22: чек-лист «🎬 для финала» / проверка по кадрам (Sonnet) / таблица преемственности
        import needs_api
        print(needs_api.needs_text(A, vid) if cmd == "needs" else needs_api.verify(A, vid) if cmd == "verify"
              else needs_api.continuity_text(A, vid, "--rebuild" in argv)); return True
    if cmd == "shift":                                       # S22: montage shift VID FROM DELTA [--only units,sfx,music,overlays] — всё после FROM на DELTA одной командой
        frm, delta = float(argv[2]), float(argv[3])
        only = (A._opt(argv, "--only", "") or "").split(",") if A._opt(argv, "--only") else None
        key = "plan:" + vid
        M, n = shift(A.load(key).get("montage") or {}, frm, delta, [x for x in only or [] if x] or None)
        run = A.agapi().current_run()
        if run:                                              # «↺ отменить» в чате вернёт монтаж целиком
            A._journal_set(run, key, ["montage"], f"сдвиг монтажа с {frm} с на {delta:+} с")
        A.apply_ops(key, [{"op": "set", "path": ["montage"], "value": M}])
        print(f"сдвинуто с {frm} с на {delta:+} с: " + (", ".join(f"{k} {v}" for k, v in n.items()) or "ничего") + f"; длина ролика {M.get('len')} с"); return True
    if cmd == "drift":                                       # S22: сценарий новее сцен + привязки WT(), которые не нашлись (render.js check)
        if not has_project(vid):
            print("у видео нет проекта ролика"); return True
        lines, _ = project_check(A, vid, run_wt=True)
        print("\n".join(lines) or "✓ сцены совпадают со сценарием, все привязки к словам нашлись"); return True
    if cmd == "build":
        class J:
            key, params, summary, result, proc, cancelled, meta = "plan:" + vid, {}, "", None, None, False, {}
        j = J()
        build(A, j)
        print(j.summary, j.result["file"]); return True
    return False


# ---------------------------------------------------------------- 📝 правки сценария (раскадровка src/script.html -> review/script_notes.json)
TEMPLATE_TITLE = "# Зачем ежу иголки"                       # заглушка шаблона: сценарий ещё не писали


def script_state(vid):
    """Для вкладки «Сценарий»: открытые правки раскадровки и не заглушка ли script.md."""
    pd = vdir(vid)
    if not pd or not has_project(vid):
        return {"project": False, "open": 0, "notes": [], "template": False}
    try:
        notes = json.load(open(os.path.join(pd, "review", "script_notes.json"), encoding="utf-8"))
    except (OSError, ValueError):
        notes = []
    op = [n for n in notes if n.get("status", "open") == "open"]
    try:
        head = open(os.path.join(pd, "script.md"), encoding="utf-8").read(400)
    except OSError:
        head = ""
    return {"project": True, "open": len(op), "notes": [{k: n.get(k) for k in ("id", "action", "sceneName", "field", "quote", "text")} for n in op],
            "template": not head.strip() or head.lstrip().startswith(TEMPLATE_TITLE)}


def script_cli(A, argv):
    """script notes VID — открытые правки раскадровки (review/script_notes.md)
    script reply VID N "ответ" [--done] [--field VO --from "старый кусок" --to "новый"] — ответ на правку (как review_server.py script-reply)"""
    if len(argv) < 2:
        print(script_cli.__doc__); return True
    cmd, vid = argv[0], argv[1]
    pd = vdir(vid)
    if not pd or not has_project(vid):
        print("у видео нет проекта ролика — studio.py produce " + vid); return True
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if cmd == "notes":
        st = script_state(vid)
        p = os.path.join(pd, "review", "script_notes.md")
        print(open(p, encoding="utf-8").read() if os.path.isfile(p) else "правок нет")
        print(f"\nОткрытых: {st['open']}" + (" · script.md — ещё заглушка шаблона, сценарий не писали" if st["template"] else ""))
        return True
    if cmd == "reply":
        r = subprocess.run([sys.executable, "review_server.py", "script-reply", *argv[2:]], cwd=pd, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60, creationflags=cf)
        print((r.stdout + r.stderr).strip()[-2000:] or "ok")
        return True
    print(script_cli.__doc__)
    return True
