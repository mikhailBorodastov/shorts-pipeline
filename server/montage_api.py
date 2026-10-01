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
        if e.get("kind") != "scene" or not (e.get("stage") or {}).get("work") or e.get("status") == "drop":
            continue
        s = _scene_doc(A, vid, e["id"])
        if not s:
            continue
        cam = s.get("camera") or {}
        out.append({"el": e["id"], "name": e.get("name") or s.get("name"), "len": s.get("len") or 6, "cuts": [c["t"] for c in cam.get("cuts") or []],
                    "markers": [{"t": m["t"], "name": m.get("name", ""), "id": m.get("id")} for m in s.get("markers") or []],
                    "sounds": len(s.get("sounds") or [])})
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
    return {"total": vo.get("total"), "words": words, "sections": [{"start": s["start"], "dur": s.get("dur"), "file": s.get("file"), "silent": s.get("silent")} for s in vo.get("sections") or []],
            "studio": bool(vo.get("studio"))}


def default(A, vid, doc):
    """Монтаж по умолчанию: сцены редактора подряд, голос — если есть в проекте."""
    sc = scenes(A, vid, doc)
    vo = voice(vid)
    units, at = [], 0.0
    for s in sc[:1]:                                         # одна prefabs.js на проект (ТЗ §2) — пока одна сцена
        units.append({"id": "u1", "scene": s["el"], "at": 0, "len": s["len"], "map": [[0, 0], [s["len"], s["len"]]], "trans": {"type": "cut", "dur": 0}})
        at += s["len"]
    has_vo = bool(vo and vo["words"] and not vo["studio"])
    return {"units": units, "voice": {"on": has_vo}, "captions": {"on": has_vo}, "sfx": [], "music": [], "overlays": [], "len": round(max(at, (vo or {}).get("total") or 0) if has_vo else at, 3)}


_LIBIDX = {}


def lib_sounds():
    """Библиотека пайплайна: [[id, длина, название]] — для выбора звука и длины полос на таймлайне."""
    p = os.path.join(P.SFXLIB, "index.json")
    m = os.path.getmtime(p) if os.path.isfile(p) else 0
    if _LIBIDX.get("m") != m:
        items = json.load(open(p, encoding="utf-8")).get("sounds", []) if m else []
        _LIBIDX.update(m=m, list=[[s["id"], s.get("dur"), s.get("name", "")] for s in items])
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


def generate(A, vid, montage=None):
    """montage -> файлы проекта. Возвращает сводку: что скопировано, длина, сцены."""
    pd = vdir(vid)
    if not has_project(vid):
        raise ValueError("у видео ещё нет проекта ролика — «🚀 Начать производство»")
    plan = A.load("plan:" + vid)
    M = montage or plan.get("montage") or default(A, vid, plan)
    lib = _lib_dir(A, vid)
    S = os.path.join(pd, STUDIO_DIR)
    os.makedirs(S, exist_ok=True)
    for f in ENGINE_SYNC:                                     # проект собирается на том же движке, что показывал редактор сцены
        src = os.path.join(P.STANDS if f == "paper.js" else P.ENGINE, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(pd, "src", f))
    for f in ("review.js", "main.js"):                        # ревью отвечает окну приложения (S8); main.js — субтитры по стилю канала (S9)
        shutil.copy2(os.path.join(P.TPL_SRC, f), os.path.join(pd, "src", f))
    vo = voice(vid)
    words = (vo or {}).get("words") or [] if (M.get("voice") or {}).get("on") else []
    report = {"copied": [], "units": [], "warn": []}
    unit_js, prefab_scripts, sfx_cues = [], [], []
    for u in M.get("units") or []:
        el = u["scene"]
        wd = A.scapi().work_dir(A, vid, el)
        sc = _scene_doc(A, vid, el)
        if not sc:
            report["warn"].append(f"нет сцены {el}"); continue
        dst = os.path.join(S, "scenes", el)
        _copy(os.path.join(wd, "prefabs.js"), os.path.join(dst, "prefabs.js"))
        prefab_scripts.append(f"../{STUDIO_DIR}/scenes/{el}/prefabs.js")
        # картинки префабов: '/files/<plan>/…' -> assets/studio/files/…
        pf = open(os.path.join(wd, "prefabs.js"), encoding="utf-8").read()
        for ref in set(re.findall(r"/files/" + re.escape(vid) + r"/([^'\"\s]+)", pf)):
            _copy(os.path.join(P.files(vid), *ref.split("/")), os.path.join(S, "files", *ref.split("/")))
        # библиотека и черновики: lib: / el: (объекты и scene.libs), клипы, огибающие липсинка
        refs = {(o.get("src") or {}).get("prefab") for o in sc.get("objects") or []} | set(sc.get("libs") or [])
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
                json.dump({"sid": sid, "t0": cues[sid]["t"], "fps": 30, "env": env}, open(os.path.join(S, "env", sid + ".json"), "w"))
        pairs = _fwd_map(u, words)
        # звуки сцены — по карте времени в ролик
        for s in sc.get("sounds") or []:
            for f, dt, g in _sound_files(A, vid, s.get("src") or "", pd, f"{el}_{s.get('id')}", wd):
                sfx_cues.append({"t": round(_scene_to_video(pairs, float(s.get("t") or 0) + dt), 3), "src": f, "gain": round(float(s.get("gain") if s.get("gain") is not None else 1) * g, 3), "align": s.get("align") or ""})
        json.dump(sc, open(os.path.join(dst, "scene.json"), "w", encoding="utf-8"), ensure_ascii=False)
        unit_js.append({"id": u["id"], "el": el, "name": sc.get("name") or el, "at": float(u.get("at", 0)), "len": float(u.get("len", sc.get("len") or 6)),
                        "map": u.get("map") or [[0, 0], [u.get("len", 6), u.get("len", 6)]], "trans": u.get("trans") or {"type": "cut", "dur": 0}})
        report["units"].append(u["id"])
    pf_text = {open(os.path.join(S, "scenes", e, "prefabs.js"), encoding="utf-8").read() for e in {x["el"] for x in unit_js}
               if os.path.isfile(os.path.join(S, "scenes", e, "prefabs.js"))}
    if len(pf_text) > 1:                                      # копии одной локации (одинаковые prefabs.js) собираются вместе; разные — пока нет
        report["warn"].append("у сцен разные prefabs.js — в ролике пока работает prefabs.js первой сцены (ТЗ S6 §2)")
    for x in M.get("sfx") or []:
        for f, dt, g in _sound_files(A, vid, x.get("src") or "", pd, "m_" + x["id"]):
            sfx_cues.append({"t": round(float(x.get("at") or 0) + dt, 3), "src": f, "gain": round(float(x.get("gain") if x.get("gain") is not None else 1) * g, 3), "align": x.get("align") or ""})
    music = []
    for x in M.get("music") or []:
        for f, dt, g in _sound_files(A, vid, x.get("src") or "", pd, "mu_" + x["id"]):
            if f.startswith("file:"):
                music.append({"file": f[5:], "at": float(x.get("at") or 0) + dt, "gain": float(x.get("gain") if x.get("gain") is not None else 1) * g,
                              "from": x.get("from") or 0, "dur": x.get("dur"), "fadeIn": x.get("fadeIn") or 0, "fadeOut": x.get("fadeOut") or 0})
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
                 "const SCENE_B = MONTAGE.units.map(u => u.at);\n")
    A.write_text(os.path.join(pd, "src", "scenes.js"), SCENES_JS)
    _patch_index(pd, prefab_scripts[:1])
    report.update(len=total, sfx=len(sfx_cues), music=len(music), voice=bool(words))
    return report


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
    open(p, "w", encoding="utf-8").write(s)


SCENES_JS = r"""// ======================================================================
// СГЕНЕРИРОВАНО монтажом Claude Studio (S6, server/montage_api.py) — не правь руками: правь монтаж в приложении (этап «Монтаж»).
// Юнит монтажа = сцена редактора (STUDIO_SCENES, prefabs.js) на отрезке ролика; карта времени MONTAGE.units[].map: [время сцены, время ролика | "w:<слово>"].
// ======================================================================
const ASSETS = { images: {}, sequences: {} };
(() => {                                                     // картинки префабов (PICS: '/files/<plan>/…') — из assets/studio/files/
  const P = typeof PICS !== 'undefined' ? PICS : {};
  for (const [k, v] of Object.entries(P)) ASSETS.images[k] = String(v).replace(/^\/files\/[^/]+\//, '../assets/studio/files/');
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
    MONTAGE_WORLDS[u.el] = sceneWorld(sc, typeof PREFABS !== 'undefined' ? PREFABS : {}, LIB);
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
  sfx(add) { if (k === 0) for (const c of MONTAGE_SFX) add(c.t, c.src, c.gain, c.align || undefined); },
}));
"""


# ---------------------------------------------------------------- сборка
def _bash():
    for c in (shutil.which("bash"), r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
        if c and os.path.isfile(c):
            return c
    raise RuntimeError("не найден bash (Git Bash) для build.sh")


def build(A, job):
    """🔨 монтаж -> проект -> build.sh (кадры, звук, mp4) с прогрессом."""
    vid = job.key[5:]
    rep = generate(A, vid)
    pd = vdir(vid)
    job.summary = "собираю: звук…"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.Popen([_bash(), "build.sh"], cwd=pd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, text=True, encoding="utf-8", errors="replace",
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
    proc.wait()
    if proc.returncode:
        raise RuntimeError("build.sh: " + "\n".join(log[-12:]))
    outs = sorted(glob.glob(os.path.join(pd, "out", "*.mp4")), key=os.path.getmtime)
    main = [o for o in outs if not o.endswith("_NO_VO.mp4")]
    job.result = {"file": (main or outs)[-1] if outs else "", "report": rep}
    job.summary = f"готово: {os.path.basename(job.result['file'])} · {rep['len']:.1f} с"


def run_job(A, job):
    if job.kind == "montagebuild":
        build(A, job)
        return True
    return False


def handle_get(A, h, p, q):
    if p == "/api/montage":
        h._json(get(A, (q.get("video") or [""])[0])); return True
    if p == "/api/montage/at":
        h._json(at(A, (q.get("video") or [""])[0], float((q.get("t") or ["0"])[0] or 0))); return True
    return False


def handle_post(A, h, p, body):
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
    if p == "/api/montage/build":
        j = A.start_job("montagebuild", "plan:" + body["video"], "montage", {})
        h._json({"job": j.info()}); return True
    return False


def cli(A, argv):
    """montage show <видео> | gen <видео> | build <видео>"""
    if len(argv) < 2:
        print(cli.__doc__); return True
    cmd, vid = argv[0], argv[1]
    if cmd == "brief":                                       # S7: монтаж для агента — коротко, со словами голоса по номерам
        g = get(A, vid)
        M, vo = g["montage"], g["voice"] or {}
        print(f"Проект: {g['folder']} ({'есть' if g['project'] else 'нет — studio.py produce'}) · монтаж {'сохранён' if g['saved'] else 'по умолчанию'} · длина {M.get('len')} с")
        print("Монтаж:", json.dumps({k: M.get(k) for k in ("units", "voice", "captions", "sfx", "music", "overlays", "len")}, ensure_ascii=False))
        for s in g["scenes"]:
            print(f"Сцена EL={s['el']} «{s['name']}» {s['len']} с · склейки {s['cuts']} · маркеры {[(m['t'], m['name']) for m in s['markers']]} · звуков {s['sounds']}")
        W = [w for w in vo.get("words") or []] if not vo.get("studio") else []
        print(f"Голос: {'нет (python tts.py / montage tts)' if not W else str(vo.get('total')) + ' с'}")
        if W:
            print("Слова (номер:слово@время): " + " ".join(f"{w['i']}:{w['w']}@{w['t']}" for w in W))
        print("Звуки препродакшена:", "; ".join(f"{s['src']} «{s['name']}» {s['dur']} с" for s in g["sources"]) or "—")
        print("Собранный ролик:", (g["out"] or ["ещё нет"])[0])
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
        r = subprocess.run([sys.executable, script], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, creationflags=cf)
        print((r.stdout + r.stderr)[-4000:])
        return True
    if cmd == "show":
        print(json.dumps(get(A, vid), ensure_ascii=False, indent=1)); return True
    if cmd == "gen":
        print(json.dumps(generate(A, vid), ensure_ascii=False, indent=1)); return True
    if cmd == "build":
        class J:
            key, params, summary, result, proc = "plan:" + vid, {}, "", None, None
        j = J()
        build(A, j)
        print(j.summary, j.result["file"]); return True
    return False
