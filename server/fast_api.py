"""⚡ Быстрый монтаж v2 (задача fastmontage): ролик кодом по сценарию, как до Studio, но параллельно.

1. prep — флаг video.fast, в проект: stands/paper.js, engine/kit2d.js + kit3d.js (набор готовых деталей канала, растёт от ролика к ролику),
   голос (tts.py), если его нет или сценарий новее.
2. plan — Opus (claude -p): читает сценарий, тайминги, prompts/fastkit.md (шпаргалка движка — вместо чтения движка), пишет ОБЩЕЕ в src/scenes.js
   (ASSETS, палитра, общие функции, 3D-мир и места; `const SCENES = []`, `const SCENE_COUNT = N`) и отдаёт план сцен + группы для писателей.
3. write — писатели параллельно (по умолчанию Sonnet, 3–5 сразу): каждая группа сцен -> src/scenes/sNN.js (`SCENES[k] = {…}`), проверка своими кадрами.
   Недописанная сцена не ломает ролик: заглушка-заполнитель в index.html.
4. review — Opus-агент в панели Claude (режим fast, автор видит шаги и пишет правки): стыки и кадры, правка ошибок, переиспользуемое -> kit*.js + KIT.md,
   montage build (черновик: 30 к/с).
5. Препродакшен задним числом — элементы из плана (персонажи, предметы, места), без дублей.
"""
import concurrent.futures as cf
import json
import os
import re
import shutil
import subprocess
import time

import paths as P

FASTKIT = os.path.join(P.STUDIO, "prompts", "fastkit.md")
KIT = os.path.join(P.STUDIO, "KIT.md")
STUDIO_PY = os.path.join(P.STUDIO, "server", "studio.py").replace("\\", "/")
CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)
PARTS_A, PARTS_B = "<!-- fast:parts -->", "<!-- /fast:parts -->"


def _read(p, n=None):
    try:
        s = open(p, encoding="utf-8").read()
        return s[:n] if n else s
    except OSError:
        return ""


# ---------------------------------------------------------------- 1. подготовка проекта
def set_parts(pd, n):
    """index.html: после scenes.js — части сцен src/scenes/sNN.js и заполнитель дыр (недописанная сцена — тёмный кадр с подписью, а не падение)."""
    for page in ("index.html", "review.html"):
        _set_parts(os.path.join(pd, "src", page), n)


def _set_parts(ih, n):
    html = _read(ih)
    if not html:
        return
    tags ="".join(f'<script src="scenes/s{k:02d}.js"></script>\n' for k in range(n))
    fill = ("<script>for (let k = 0; k < (typeof SCENE_COUNT !== 'undefined' ? SCENE_COUNT : SCENES.length); k++) if (!SCENES[k]) SCENES[k] = { name: 'сцена ' + (k + 1) + ' пишется',\n"
            "  draw(c) { c.fillStyle = '#16161c'; c.fillRect(0, 0, W, H); c.fillStyle = '#8a8a99'; c.font = '600 54px sans-serif'; c.textAlign = 'center'; c.fillText('сцена ' + (k + 1) + ' — Claude пишет…', W / 2, H / 2); } };</script>\n")
    block = PARTS_A + "\n" + tags + fill + PARTS_B
    if PARTS_A in html:
        html = re.sub(re.escape(PARTS_A) + r".*?" + re.escape(PARTS_B), lambda m: block, html, flags=re.S)
    else:
        html = html.replace('<script src="scenes.js"></script>', '<script src="scenes.js"></script>\n' + block)
    open(ih, "w", encoding="utf-8").write(html)


def prep(A, job, vid):
    key = "plan:" + vid
    pd = P.video(vid)
    A.apply_ops(key, [{"op": "set", "path": ["fast"], "value": True}, {"op": "set", "path": ["locations"], "value": False}])
    src = os.path.join(pd, "src")
    os.makedirs(os.path.join(src, "scenes"), exist_ok=True)
    for f, frm in (("paper.js", os.path.join(P.STUDIO, "stands", "paper.js")), ("kit2d.js", os.path.join(P.STUDIO, "engine", "kit2d.js")),
                   ("kit3d.js", os.path.join(P.STUDIO, "engine", "kit3d.js"))):
        if os.path.isfile(frm) and (f != "paper.js" or not os.path.isfile(os.path.join(src, f))):
            shutil.copy2(frm, os.path.join(src, f))
    for page in ("index.html", "review.html"):              # paper.js (бумажный ёжик) после chars.js — иначе drawHog старый круглый; review.html грузит сцены сам
        ih = os.path.join(src, page)
        html = _read(ih)
        need = [t for t in ("paper.js", "kit2d.js", "kit3d.js") if f'src="{t}"' not in html]
        if need and '<script src="scenes.js"></script>' in html:
            html = html.replace('<script src="scenes.js"></script>', "".join(f'<script src="{t}"></script>\n' for t in need) + '<script src="scenes.js"></script>')
            open(ih, "w", encoding="utf-8").write(html)
    # голос: нет таймингов или сценарий новее — tts (запись диктора не трогаем)
    vt, sm = os.path.join(pd, "build", "vo_timing.json"), os.path.join(pd, "script.md")
    rec = False
    try:
        rec = json.load(open(os.path.join(pd, "build", "vo", "source.json"), encoding="utf-8")).get("kind") == "rec"
    except (OSError, ValueError):
        pass
    try:
        stub = bool(json.load(open(vt, encoding="utf-8")).get("studio"))     # «пустые» тайминги монтажа Studio (одна секция на весь ролик) — пересчитать по сценарию
    except (OSError, ValueError):
        stub = True
    if not rec and (stub or os.path.getmtime(sm) > os.path.getmtime(vt)):
        job.summary = "озвучиваю сценарий…"
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        r = subprocess.run(["python", "tts.py"], cwd=pd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, creationflags=CF)
        if r.returncode != 0:
            raise RuntimeError("озвучка: " + (r.stdout + r.stderr)[-400:])


def sections(pd):
    try:
        d = json.load(open(os.path.join(pd, "build", "vo_timing.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return [], 0
    out = []
    for i, s in enumerate(d.get("sections") or []):
        ws = s.get("words") or []
        out.append({"k": i, "title": s.get("title", ""), "start": round(s.get("start", 0), 2), "dur": round(s.get("dur", 0), 2),
                    "text": " ".join(w["w"] for w in ws), "words": " ".join(f"{w['w']}@{round(s.get('start', 0) + w['t'], 2)}" for w in ws)})
    return out, d.get("total") or 0



# ---------------------------------------------------------------- препродакшен в коде: есть — берём, нет — рисуем сами
PP_JS = r"""// СГЕНЕРИРОВАНО быстрым монтажом (server/fast_api.py) — препродакшен видео для кода сцен. Не правь руками: пересоздаётся при каждом запуске.
// ppWorld(el, {build(w), update(w, lt, D, T), sceneTime}) — 3D-мир из сцены / локации препродакшена (как в редакторе) + своё действие поверх;
// ppShot(el, 'sh1') -> {pos, target, fov} — ракурс локации; ppAdd(w, ref, {pos, rotY, scale, name, params}) -> {S, holder, tick(lt)} — 3D-пропс / персонаж препродакшена в любой мир;
// PP2D[el].<функция>(…) — 2D-черновик препродакшена; PP_IMAGES — картинки препродакшена для ASSETS.images.
const SCENE_URLS = { lib: '../assets/studio/lib/', el: '../assets/studio/el/', anims: '../assets/studio/anims/', env: '../assets/studio/env/' };
const PP_LIB = {};
let PP_LIBALL = {};
const PP_IMAGES = {};
(() => {
  const fix = v => String(v).replace(/^\/files\/[^/]+\//, '../assets/studio/files/').replace(/^\/render\/[^/]+\//, '../assets/studio/el/');
  for (const S of Object.values(window.SCENE_PREFABS || {})) for (const [k, v] of Object.entries(S.PICS || {})) PP_IMAGES[k] = fix(v);
  for (const S of Object.values(window.PP2D || {})) for (const [k, v] of Object.entries(S.PICS || {})) PP_IMAGES[k] = fix(v);
  Object.assign(PP_IMAGES, typeof PP_OWN !== 'undefined' ? PP_OWN : {});   // свои ассеты автора (как есть)
})();
const ppLoad = async () => {
  const load = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('не загрузилось: ' + src)); document.head.append(s); });
  for (const [el, sc] of Object.entries(PP_SCENES)) {
    PP_LIB[el] = await loadSceneProps(scenePropRefs(sc), PP_PLAN, load, {}, sc);
    await loadSceneEnvs(sc, PP_PLAN, el);
  }
  if (PP_ALL.objects.length) PP_LIBALL = await loadSceneProps(scenePropRefs(PP_ALL), PP_PLAN, load, {}, PP_ALL);
};
// загрузка препродакшена — всегда первой; если сцены задают свой window.STUDIO_READY, он выполнится после неё (а не вместо)
let ppUserReady = null;
Object.defineProperty(window, 'STUDIO_READY', { configurable: true, get() { return async () => { await ppLoad(); if (ppUserReady) await ppUserReady(); }; }, set(f) { ppUserReady = f; } });
function ppWorld(el, o = {}) {
  const sc = PP_SCENES[el];
  if (!sc) throw new Error('ppWorld: нет сцены препродакшена ' + el);
  const pf = ((window.SCENE_PREFABS || {})[el] || {}).PREFABS || {};
  return sceneWorld(sc, pf, {}, {
    build(w) { w.S = buildFromScene(w, sc, pf, PP_LIB[el] || {}); if (o.build) o.build(w); },
    update(w, lt, D, T) { if (o.sceneTime !== false) applyScene(w.S, typeof o.sceneTime === 'function' ? o.sceneTime(lt) : lt); if (o.update) o.update(w, lt, D, T); },
  });
}
function ppShot(el, id) {
  const sc = PP_SCENES[el] || {}, sh = sc.shots || [];
  const s = sh.find(x => x.id === id) || sh[0];
  if (s) return { pos: s.pos, target: s.target, fov: s.fov };
  const k = ((sc.camera || {}).keys || [])[0];
  return k ? { pos: k.pos, target: k.target, fov: k.fov } : null;
}
function ppAdd(w, ref, o = {}) {
  ppAdd.n = (ppAdd.n || 0) + 1;
  const id = 'pp' + ppAdd.n;
  const S = buildFromScene(w, { objects: [{ id, name: o.name || ref, src: { prefab: ref }, pos: o.pos || [0, 0, 0], rot: o.rot || [0, o.rotY || 0, 0], scale: o.scale || 1, params: o.params || {} }] },
    {}, Object.assign({}, PP_LIBALL, ...Object.values(PP_LIB)));
  const rec = S.objects.get(id);
  return { S, holder: rec && rec.holder, tick(lt) { applyScene(S, lt); } };
}
"""


def _fn_names(code):
    return sorted(set(re.findall(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", code, flags=re.M)))


def _head_comment(code, n=8):
    out = []
    for line in code.splitlines():
        if line.startswith("//"):
            out.append(line[2:].strip())
            if len(out) >= n:
                break
        elif out:
            break
    return " / ".join(out)


def pack_preprod(A, vid):
    """Препродакшен видео -> проект ролика для кода сцен (src/montage.js + assets/studio/…). -> (текст «что есть и как звать», сколько)."""
    import montage_api as M
    key = "plan:" + vid
    pd = P.video(vid)
    plan = A.load(key)
    S = os.path.join(pd, M.STUDIO_DIR)
    os.makedirs(S, exist_ok=True)
    for f in M.ENGINE_SYNC:                                   # движок сцен редактора — тот же, что показывал редактор
        src = os.path.join(P.STANDS if f == "paper.js" else P.ENGINE, f)
        if os.path.isfile(src) and (f != "paper.js" or not os.path.isfile(os.path.join(pd, "src", f))):
            shutil.copy2(src, os.path.join(pd, "src", f))
    lines, prefab_scripts, report = [], [], {"copied": [], "warn": []}
    scenes = {}
    els = [e for e in plan.get("elements") or [] if e.get("status") != "drop"]
    # 1) сцены / локации редактора
    for e in els:
        if e.get("kind") != "scene" or not (e.get("stage") or {}).get("work"):
            continue
        sc = M._scene_doc(A, vid, e["id"])
        if not sc:
            continue
        wd = A.scapi().work_dir(A, vid, e["id"])
        M._pack_scene(A, vid, e["id"], sc, wd, S, prefab_scripts, report)
        scenes[e["id"]] = sc
        shots = ", ".join(f"{x['id']}" + (f" «{x.get('name')}»" if x.get("name") and not str(x.get("name")).startswith("ракурс") else "") for x in sc.get("shots") or []) or "камера сцены"
        objs = ", ".join((o.get("name") or o["id"]) for o in (sc.get("objects") or [])[:25])
        lines.append(f"- МЕСТО «{e.get('name')}»{' ✓' if e.get('status') == 'ok' else ''} — ppWorld('{e['id']}', {{ update(w, lt) {{ /* камера, герои */ }} }}); ракурсы ppShot('{e['id']}', id): {shots}. "
                     f"Внутри: {objs}. {(e.get('desc') or '')[:160]}")
    # 2) 3D-пропсы и персонажи (видео и библиотека канала)
    S_ = A.scapi()
    objs = []
    for c in S_.props3d_choices(A, key, plan) + S_.chars3d_choices(A, key, plan):
        objs.append({"id": "o" + str(len(objs)), "name": c.get("name"), "src": {"prefab": c["ref"]}, "pos": [0, 0, 0]})
        kind = "персонаж" if "characters" in c["ref"] or c in S_.chars3d_choices(A, key, plan) else "3D-пропс"
        lines.append(f"- {kind.upper()} «{c.get('name')}» ({c.get('from', '')}) — ppAdd(w, '{c['ref']}', {{ pos: [x, 0, z], rotY, scale }})")
    pp_all = {"objects": objs}
    if objs:
        tmp = os.path.join(S, "_pp_all_src")
        os.makedirs(tmp, exist_ok=True)
        open(os.path.join(tmp, "prefabs.js"), "w", encoding="utf-8").write("const PREFABS = {};\n")
        M._pack_scene(A, vid, "_pp_all", pp_all, tmp, S, [], report)
    # 3а) СВОИ АССЕТЫ АВТОРА (e.own[]: картинка + состояние) — в ролик как есть, не рисовать
    own, owned = {}, set()
    for e in els:
        st = [x for x in e.get("own") or [] if x.get("img")]
        if not st:
            continue
        owned.add(e["id"])
        keys = []
        for i, x in enumerate(st):
            src = P.resolve(x["img"]) if hasattr(P, "resolve") else ""
            if not src or not os.path.isfile(src):
                continue
            ext = os.path.splitext(src)[1].lower() or ".png"
            dst = os.path.join(pd, "assets", "own", e["id"], f"{i}{ext}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            k = f"own_{e['id']}_{i}"
            own[k] = f"../assets/own/{e['id']}/{i}{ext}"
            keys.append(f"«{x.get('state') or ('основное' if not i else 'состояние ' + str(i + 1))}» → IMG.{k}")
        if keys:
            lines.append(f"- СВОЙ АССЕТ АВТОРА «{e.get('name')}» ({e['kind']}) — ВКЛЕИТЬ КАК ЕСТЬ, НЕ РИСОВАТЬ И НЕ ПЕРЕРИСОВЫВАТЬ: состояния: {'; '.join(keys)}. "
                         "2D: cut(ctx, IMG.<ключ>, …) / photo(…) / ctx.drawImage — вырезкой с бумажной обводкой, по сценарию переключай состояния (можно с переворотом-флипом); "
                         "3D: spriteCard с этой картинкой. Можно двигать, масштабировать, качать, но не менять сам рисунок.")
    # 3) 2D-черновики (element.js) — в своей области видимости: PP2D[el].<функция>
    pp2d = []
    for e in els:
        if e["id"] in owned:
            continue
        rs = e.get("renders") or []
        r = next((x for x in rs if x.get("id") == e.get("render")), rs[-1] if rs else None)
        if not r or r.get("three3") or r.get("rigchar") or r.get("model3d") or r.get("three") or e.get("kind") == "sound":
            continue
        ej = os.path.join(P.render(vid), e["id"], f"v{r.get('v')}", "element.js")
        if not os.path.isfile(ej) or (e.get("stage") or {}).get("work"):
            continue
        code = _read(ej)
        if "world3d(" in code:                                # 3D-черновик сцены без редактора — не переносится, только образ
            continue
        M._copy(os.path.dirname(ej), os.path.join(S, "el", e["id"], f"v{r.get('v')}"))
        for ref in set(re.findall(r"/files/" + re.escape(vid) + r"/([^'\"\s]+)", code)):
            M._copy(os.path.join(P.files(vid), *ref.split("/")), os.path.join(S, "files", *ref.split("/")))
        fns = [f for f in _fn_names(code) if f not in ("draw",)]
        dst = os.path.join(S, "pp2d", e["id"] + ".js")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        ret = ", ".join(fns + ["ELEMENT: typeof ELEMENT !== 'undefined' ? ELEMENT : null", "PICS: typeof PICS !== 'undefined' ? PICS : {}"])
        open(dst, "w", encoding="utf-8").write(f"// СГЕНЕРИРОВАНО быстрым монтажом: 2D-черновик «{e.get('name')}» v{r.get('v')} в своей области видимости.\n"
                                               f"window.PP2D = window.PP2D || {{}};\nwindow.PP2D[{json.dumps(e['id'])}] = (function () {{\n{code}\n;return {{ {ret} }};\n}})();\n")
        pp2d.append(f"../{M.STUDIO_DIR}/pp2d/{e['id']}.js")
        lines.append(f"- 2D {'ПЕРСОНАЖ' if e['kind'] == 'char' else 'МЕСТО' if e['kind'] == 'scene' else 'ПРЕДМЕТ'} «{e.get('name')}»{' ✓' if e.get('status') == 'ok' else ''} — "
                     f"PP2D['{e['id']}'].{fns[0] if fns else 'ELEMENT.draw'}(…); функции: {', '.join(fns[:8])}. {_head_comment(code)[:400]}")
    # 4) звуки
    for e in els:
        if e.get("kind") != "sound":
            continue
        try:
            fs = M._sound_files(A, vid, "el:" + e["id"], pd, "pp_" + e["id"])
        except Exception:
            fs = []
        if fs:
            lines.append(f"- ЗВУК «{e.get('name')}» — " + "; ".join(f"add(t + {round(dt, 2)}, '{f}', {round(g, 2)})" for f, dt, g in fs[:3]))
    # src/montage.js: препродакшен для кода (заменяет сгенерированный монтажом — у fast-видео его SCENE_B ломал границы сцен)
    A.write_text(os.path.join(pd, "src", "montage.js"),
                 f"const PP_PLAN = {json.dumps(vid)};\nconst PP_OWN = {json.dumps(own, ensure_ascii=False)};\nconst PP_SCENES = {json.dumps(scenes, ensure_ascii=False)};\nconst PP_ALL = {json.dumps(pp_all, ensure_ascii=False)};\n" + PP_JS)
    M._patch_index(pd, prefab_scripts + pp2d)
    ih = os.path.join(pd, "src", "index.html")                # paper.js — только внутри блока studio (дважды const-объявления ломают страницу)
    h0 = _read(ih)
    m0 = re.search(r"<!-- studio.*?<!-- /studio -->\n", h0, flags=re.S)
    if m0:
        out = h0[:m0.start()].replace('<script src="paper.js"></script>\n', "") + m0.group(0) + h0[m0.end():].replace('<script src="paper.js"></script>\n', "")
        open(ih, "w", encoding="utf-8").write(out)
    rv = os.path.join(pd, "src", "review.html")              # ревью грузит те же скрипты
    if os.path.isfile(rv):
        h_ = _read(rv)
        blk = re.search(r"<!-- studio.*?<!-- /studio -->\n", _read(os.path.join(pd, "src", "index.html")), flags=re.S)
        if blk:
            if "<!-- studio" in h_:
                h_ = re.sub(r"<!-- studio.*?<!-- /studio -->\n", lambda m: blk.group(0), h_, flags=re.S)
            elif '<script src="scenes.js"></script>' in h_:
                h_ = h_.replace('<script src="scenes.js"></script>', blk.group(0) + '<script src="scenes.js"></script>')
            open(rv, "w", encoding="utf-8").write(h_)
    head = ("ПРЕПРОДАКШЕН ВИДЕО — что уже есть (✓ — утверждено автором). ОБЯЗАТЕЛЬНО бери это, а не рисуй своё: места — ppWorld, герои и предметы — ppAdd / PP2D, звуки — add(...). "
            "Рисуй сам только то, чего здесь нет. ASSETS.images дополни PP_IMAGES: const ASSETS = { images: Object.assign({ /* свои */ }, PP_IMAGES), sequences: {} };")
    return (head + "\n" + "\n".join(lines)) if lines else "ПРЕПРОДАКШЕН ВИДЕО: пусто — всё рисуй сам.", len(lines)


# ---------------------------------------------------------------- 2–3. план и писатели
def _sys(A, key):
    from ideas_claude import system
    try:
        return system(A._docs(key), "short")
    except Exception:
        return "Ты — соавтор YouTube-канала в Claude Studio."


def plan(A, job, vid, wish, inv=""):
    key = "plan:" + vid
    pd = P.video(vid)
    d = A.load(key)
    secs, total = sections(pd)
    if not secs:
        raise RuntimeError("нет таймингов голоса (build/vo_timing.json) — сценарий без сцен?")
    from ideas_claude import S, STR, ARR
    els = inv or "—"
    eng = d.get("engine") or "2d"
    prompt = f"""⚡ Быстрый монтаж — ШАГ 1 из 3 (план и общий код). Ролик «{d.get('name')}», движок: {eng} ({'бумажная аппликация 2D' if eng != '3d' else '3D-диорама (world3d) + 2D поверх'}).
Проект: {pd.replace(chr(92), '/')}. Шпаргалка движка — {FASTKIT.replace(chr(92), '/')} (прочитай её ЦЕЛИКОМ; движок и чужие ролики не читай — всё нужное там).
Набор готовых деталей канала — src/kit2d.js, src/kit3d.js и каталог {KIT.replace(chr(92), '/')}: что там есть — используй, не пиши заново.

Сделай:
1. Прочитай script.md (сценарий: «Картинка», «Текст», VO) и секции голоса ниже.
2. Напиши src/scenes.js — ТОЛЬКО ОБЩЕЕ для всех сцен (Write целиком): ASSETS, палитра/константы, общие функции рисования героев, предметов и мест,
   {'3D-мир(ы) world3d с местами действия и камерами — функции, которые сцены вызывают' if eng == '3d' else 'фоны мест — функциями'}; CAPTION_STYLE/TRANS_WHOOSH при нужде;
   и в конце строго: const SCENES = []; const SCENE_COUNT = {len(secs)};
   Сцен здесь НЕ пиши — их пишут параллельно другие писатели в src/scenes/sNN.js (SCENES[k] = {{…}}), опираясь на твои функции. Поэтому общие функции
   делай полноценными (персонажи, места, ключевые предметы, движения), с понятными параметрами и комментарием-сигнатурой над каждой.
3. Ответь планом: для каждой секции k — что в кадре и что происходит по словам (brief: 3–6 фраз: место, герои, действия к словам, переходы trans, звуки lib:…),
   какие общие функции звать; groups — разбей сцены на 3–5 групп подряд идущих (примерно поровну по длительности) для параллельных писателей;
   elements — персонажи, предметы и места, которые есть в ролике (для препродакшена задним числом).
{els}
(Общие функции в scenes.js строй ПОВЕРХ препродакшена: место есть — функция возвращает ppWorld('<id>', …), герой есть — ppAdd / PP2D; своё — только для того, чего нет.)
Пожелания автора: {wish or '—'}

Секции голоса (k · начало · длина · текст):
{chr(10).join(f"[{s['k']}] {s['start']} с · {s['dur']} с · {s['title']} — {s['text'][:300]}" for s in secs)}"""
    spec = {"system": _sys(A, key), "prompt": prompt, "timeout": 1800, "model": A.VISUAL_MODEL, "effort": "medium", "cwd": pd, "dirs": [P.STUDIO],
            "tools": ["Read", "Write", "Edit", "Glob", "Grep"], "allowed": ["Read", "Write", "Edit", "Glob", "Grep"],
            "schema": S({"scenes": ARR(S({"k": {"type": "integer"}, "brief": STR, "uses": STR}, ["k", "brief"])),
                         "groups": ARR(ARR({"type": "integer"})),
                         "elements": ARR(S({"kind": {"type": "string", "enum": ["char", "prop", "scene"]}, "name": STR, "desc": STR}, ["kind", "name", "desc"]))},
                        ["scenes", "groups", "elements"])}
    job.summary = f"план и общий код (Opus)… секций {len(secs)}"
    return A.run_claude(job, spec), secs


def write_group(A, job, vid, grp, P_, secs, inv=""):
    key = "plan:" + vid
    pd = P.video(vid)
    from ideas_claude import S, STR
    briefs = {s["k"]: s for s in P_["scenes"]}
    files = ", ".join(f"src/scenes/s{k:02d}.js" for k in grp)
    prompt = f"""⚡ Быстрый монтаж — ШАГ 2 (писатель сцен). Ты пишешь сцены {', '.join(str(k) for k in grp)} ролика параллельно с другими писателями.
Проект: {pd.replace(chr(92), '/')}. Шпаргалка движка — {FASTKIT.replace(chr(92), '/')} (прочитай целиком). Общий код уже написан — src/scenes.js (прочитай: функции, мир, палитра);
готовые детали — src/kit2d.js, src/kit3d.js. Сценарий — script.md (найди свои секции по заголовкам).
Каждую сцену k — ОТДЕЛЬНЫМ файлом src/scenes/sNN.js (NN = k двумя цифрами): `SCENES[k] = {{ name, trans, draw(ctx, lt, D, T) {{…}}, sfx(add) {{…}} }};`
Только свои файлы ({files}); src/scenes.js и чужие сцены НЕ меняй — нужна общая функция, которой нет, — объяви её в своём файле с префиксом s{grp[0]:02d}_.
События — к словам: WT(k, 'кусок слова') (берёт первое слово с подстрокой — уникальные куски). Стиль, раскладка кадра, плавные появления — по шпаргалке.
Проверь себя: python {STUDIO_PY} montage snap {vid} <3–5 секунд внутри твоих сцен через запятую> → Read PNG; ошибки страницы — в выводе. Поправь и проверь ещё раз (максимум 3 круга).

План сцен:
{chr(10).join(f"[{k}] {secs[k]['start']}–{round(secs[k]['start'] + secs[k]['dur'], 2)} с «{secs[k]['title']}». Слова: {secs[k]['words'][:900]}" + chr(10) + f"    что в кадре: {briefs.get(k, {}).get('brief', '')}" + (f" · общие функции: {briefs[k].get('uses')}" if briefs.get(k, {}).get('uses') else '') for k in grp if k < len(secs))}

{inv}

Ответ: ok и note — 1–2 фразы, что сделано и что не вышло."""
    spec = {"system": _sys(A, key), "prompt": prompt, "timeout": 1500, "model": job.params.get("writer") or A.TEXT_MODEL, "effort": "medium", "cwd": pd, "dirs": [P.STUDIO],
            "tools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            "allowed": ["Read", "Write", "Edit", "Glob", "Grep", f"Bash(python {STUDIO_PY} montage snap:*)"],
            "schema": S({"ok": {"type": "boolean"}, "note": STR}, ["ok", "note"])}

    class Sub:                                                  # своя «задача» для run_claude (свой процесс, отмена — общая)
        def __init__(s):
            s.id = f"{job.id}-w{grp[0]}"; s.proc = None; s.cancelled = False; s.summary = ""; s.meta = {}
    sj = Sub()
    job.subs.append(sj)
    try:
        r = A.run_claude(sj, spec) or {}
    except Exception as e:
        r = {"ok": False, "note": str(e)[:300]}
    return grp, r


def run(A, job):
    vid = job.key[5:]
    key = job.key
    pd = P.video(vid)
    if not pd:
        raise ValueError("у видео ещё нет проекта ролика — сначала сценарий («Начать»)")
    t0 = time.time()
    job.subs = []
    prep(A, job, vid)
    job.summary = "беру препродакшен: места, героев, предметы, звуки…"
    inv, n_pp = pack_preprod(A, vid)
    res, secs = plan(A, job, vid, job.params.get("wish") or "", inv)
    res = res or {}
    n = len(secs)
    set_parts(pd, n)
    groups = [g for g in (res.get("groups") or []) if g] or [list(range(n))]
    seen = {k for g in groups for k in g}
    if len(seen) < n:                                           # потерянные секции — к последней группе
        groups[-1] += [k for k in range(n) if k not in seen]
    groups = [sorted(k for k in g if 0 <= k < n) for g in groups]
    par = max(1, min(int(job.params.get("par") or 4), len(groups)))
    job.summary = f"сцены пишут {len(groups)} писателей параллельно ({par} сразу)…"
    notes = []
    with cf.ThreadPoolExecutor(par) as ex:
        futs = [ex.submit(write_group, A, job, vid, g, res, secs, inv) for g in groups]
        done = 0
        for f in cf.as_completed(futs):
            if job.cancelled:
                for s in job.subs:
                    s.cancelled = True
                    try:
                        s.proc and s.proc.kill()
                    except Exception:
                        pass
                raise RuntimeError("отменено")
            g, r = f.result()
            done += 1
            notes.append(f"сцены {g[0] + 1}–{g[-1] + 1}: " + (r.get("note") or ("готово" if r.get("ok") else "не вышло")))
            job.summary = f"сцены: готово групп {done} из {len(groups)}"
    t_write = time.time() - t0
    # препродакшен задним числом (без дублей по имени)
    have = {(e.get("kind"), (e.get("name") or "").strip().lower()) for e in A.load(key).get("elements") or []}
    ops = []
    for e in res.get("elements") or []:
        k = (e.get("kind"), (e.get("name") or "").strip().lower())
        if k in have or not k[1]:
            continue
        have.add(k)
        ops.append({"op": "add", "path": ["elements"], "item": {"id": A.new_id("e"), "kind": e["kind"], "name": e["name"].strip(), "desc": e.get("desc", ""),
                                                                 "why": "из быстрого монтажа", "status": "", "refs": [], "by": "claude"}})
    if ops:
        A.apply_ops(key, ops)
    # сводка и проверка — Opus в панели Claude: автор видит и пишет правки по ходу
    text = (f"⚡ Быстрый монтаж — ШАГ 3 (сводка). Общий код (src/scenes.js) и сцены (src/scenes/sNN.js) уже написаны параллельно за {int(t_write // 60)} мин. "
            "НЕ переписывай их заново и не улучшай то, что работает: ОДИН montage snap на все сцены (по кадру из середины каждой) → поправь только явные ошибки — пустые и сломанные кадры, "
            "ошибки страницы, наложения на субтитры (Edit), ещё один snap по исправленным — и всё. Не больше 2 снимков. "
            f"Что вышло переиспользуемым (место, предмет, движение героя) — перенеси функцией в {P.STUDIO.replace(chr(92), '/')}/engine/kit2d.js или kit3d.js и строкой в KIT.md. "
            "Потом montage build (черновик, 30 к/с). В ответе — что поправил и что автору посмотреть.\nОтчёты писателей:\n" + "\n".join("- " + x for x in notes))
    s = A.agapi().get_session(A, vid, A.VISUAL_MODEL, "fast")
    s.say(text, None)
    time.sleep(5)
    while s.busy and s.alive():
        if job.cancelled:
            s.stop(); raise RuntimeError("отменено")
        job.summary = "Claude сводит ролик и собирает черновик (панель справа)…"
        time.sleep(5)
    job.summary = f"готово за {int((time.time() - t0) // 60)} мин · в препродакшен добавлено: {len(ops)}"
