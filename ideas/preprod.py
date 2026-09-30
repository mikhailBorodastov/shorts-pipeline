"""Препродакшен «Штурма»: модель элементов и экспорт в проект для Claude-реализатора.

Элемент (plan.elements[]):
    id, kind (char | prop | scene | sound), name, desc, why, status ('' предложен | ok утверждён | drop не нужен), by
    refs[]   — картинки автора {id, img, note}
    renders[] + render — черновики {id, v, dir, img, extra, fn, three, summary, note, feedback}; render — выбранный
    fx.main  — правки к СЛЕДУЮЩЕМУ черновику {notes[{id, text}] — «в целом», по пункту на Enter; text — старое одно поле; pins[{id, x, y, text}]}
    final[]  — «Для финала»: что автор хочет от ассета в готовом ролике {id, text, x?, y?} (x, y — пин на выбранном черновике)
    uses[]   — у сцены: id её персонажей и пропсов («Что в сцене»); упомянутые через @ в текстах сцены тоже входят в состав
    assets[] — бесплатные ассеты, взятые «в работу» (🔎 в карточке элемента, assets.py) {id, src, sid, title, kind 3d|2d|tex, fmt,
               license, attr (нужна подпись), author, page, dir, main (files/<plan>/assets/<id>/…), files, size, preview, note, why}
    picks[]  — что предложил Claude («✨ Подобрать», ideas_claude.assets_spec): строки поиска assets.py + {pid, why, use: work|ref}; берёт автор
    aask     — что автор ищет в ассетах («Что нужно» в карточке) — для Claude
    renders[].layout — у 3D-черновика, сохранённого из «✋ Двигать»: расстановка автора {имя объекта: {p, r, s, hide}} (в element.js — WORLD.layout)
    звук: sounds[] кандидаты {id, file, title, src, license, author, page, url, dur, peak_t, start, end, why},
          mix[] слои ролика {id, sid, at (сдвиг, с), gain (0…2), note}, mixNote — как свести; sound — id первого слоя (совместимость)
@-ссылки: в любом тексте штурма «@[Название]» — ссылка на элемент по названию (без учёта регистра и «ё»).

Экспорт (export): refs/препродакшен/ — README.md (как пользоваться), manifest.json (всё машиночитаемо),
<kind>/<slug>/README.md (ТЗ элемента) + ref*.png, vN.png, element.js, final_pins.png; _toolkit/paper.js;
ассеты «в работу»: assets/models/<slug>/… (glTF), assets/img/<slug>/… (картинки и текстуры) — с лицензиями в README элемента;
звуки: assets/sfx/<slug>.wav (готовый микс) и assets/sfx/<slug>/<n>-<слой>.wav (слои по отдельности).
"""
import json, os, re, shutil, subprocess, wave
import numpy as np

KINDS = {"char": "Персонажи", "prop": "Пропсы и реквизит", "scene": "Сцены", "sound": "Звуки"}   # order of work: scenes after what stands in them
ONE = {"char": "персонаж", "prop": "пропс", "scene": "сцена", "sound": "звук"}
ICON = {"char": "🦔", "prop": "🧸", "scene": "🏠", "sound": "🔊"}
STATUS = {"ok": "✓ утверждён", "": "предложен (не проверен автором)", "drop": "не нужен"}
MENTION = re.compile(r"@\[([^\]\n]{1,80})\]")
BASE = "refs/препродакшен"
SR = 44100
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)

TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s",
                                                           "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"]))


def norm(s):
    return " ".join((s or "").lower().replace("ё", "е").split())


def slug(s, n=40):
    s = "".join(TRANSLIT.get(c, c) for c in (s or "").lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:n].strip("-") or "el"


def live(d):
    return [e for e in d.get("elements") or [] if e.get("status") != "drop"]


def el_slugs(d):
    """element id -> unique latin slug (folder and file names in the project)."""
    out, seen = {}, set()
    for e in d.get("elements") or []:
        s = base = slug(e.get("name"))
        k = 2
        while s in seen:
            s, k = f"{base}-{k}", k + 1
        seen.add(s)
        out[e["id"]] = s
    return out


def el_render(e):
    rs = e.get("renders") or []
    return next((r for r in rs if r.get("id") == e.get("render")), rs[-1] if rs else None)


def el_mix(e):
    """Layers of a sound element with their candidate: [{id, sid, at, gain, note, s}]. Old plans: the single chosen `sound`."""
    ss = {s["id"]: s for s in e.get("sounds") or []}
    mix = e.get("mix")
    if mix is None:
        mix = [{"id": "l1", "sid": e["sound"], "at": 0, "gain": 1, "note": ""}] if e.get("sound") else []
    out = []
    for m in mix:
        s = ss.get(m.get("sid"))
        if s:
            out.append({**m, "at": float(m.get("at") or 0), "gain": 1.0 if m.get("gain") in (None, "") else float(m["gain"]), "s": s})
    return out


def el_sound(e):
    m = el_mix(e)
    return m[0]["s"] if m else None


# ---------------- @-links and scene casts ----------------
def by_name(d):
    idx = {}
    for e in d.get("elements") or []:
        if (e.get("name") or "").strip():
            idx.setdefault(norm(e["name"]), []).append(e)
    return idx


def mentions_in(text, d, idx=None):
    """Elements named by @[Название] in a text, in order, once each (dropped ones too: the reader should know they were cut)."""
    idx = idx or by_name(d)
    out, seen = [], set()
    for m in MENTION.finditer(text or ""):
        for e in idx.get(norm(m.group(1)), []):
            if e["id"] not in seen:
                seen.add(e["id"])
                out.append(e)
    return out


def el_texts(e):
    """(label, text) of every text of an element — where @-links can be."""
    fx = (e.get("fx") or {}).get("main") or {}
    out = [("описание", e.get("desc")), ("где в ролике", e.get("why")), ("правка черновика", fx.get("text")),
           *[("правка черновика", n.get("text")) for n in fx.get("notes") or []],
           ("какой звук нужен", e.get("ask")), ("как свести", e.get("mixNote"))]
    out += [("пин правки", p.get("text")) for p in fx.get("pins") or []]
    out += [("для финала", f.get("text")) for f in e.get("final") or []]
    out += [("слой микса", m.get("note")) for m in e.get("mix") or []]
    out += [("ассет", a.get("why")) for a in e.get("assets") or []]
    out.append(("что нужно из ассетов", e.get("aask")))
    return [(k, t) for k, t in out if (t or "").strip()]


def el_mentions(e, d, idx=None):
    idx = idx or by_name(d)
    out, seen = [], {e["id"]}
    for _, t in el_texts(e):
        for x in mentions_in(t, d, idx):
            if x["id"] not in seen:
                seen.add(x["id"])
                out.append(x)
    return out


def cast_of(scene, d, idx=None):
    """[(element, via)] — who and what stands in a scene: «Что в сцене» (uses) + characters and props @-mentioned in its texts."""
    els = {e["id"]: e for e in d.get("elements") or []}
    out, seen = [], set()
    for i in scene.get("uses") or []:
        e = els.get(i)
        if e and e.get("status") != "drop" and i not in seen:
            seen.add(i)
            out.append((e, "uses"))
    for e in el_mentions(scene, d, idx):
        if e.get("kind") in ("char", "prop") and e.get("status") != "drop" and e["id"] not in seen:
            seen.add(e["id"])
            out.append((e, "@"))
    return out


def used_in(e, d, idx=None):
    return [s for s in live(d) if s.get("kind") == "scene" and any(x["id"] == e["id"] for x, _ in cast_of(s, d, idx))]


def linkify(text, d, folder_of, rel_from="", idx=None):
    """@[X] -> [@X](<folder of X>) so a reader (the agent) can follow the link; unknown names stay as they are."""
    idx = idx or by_name(d)

    def rep(m):
        hit = [e for e in idx.get(norm(m.group(1)), [])]
        if not hit:
            return m.group(0)
        e = hit[0]
        f = folder_of(e)
        return f"[@{m.group(1)}]({os.path.relpath(f, rel_from).replace(os.sep, '/') if rel_from else f}/)" if f else f"@{m.group(1)} ({ONE.get(e.get('kind'), '')})"
    return MENTION.sub(rep, text or "")


# ---------------- markdown for штурм.md and for prompts ----------------
def pre_md(d, where=None, folders=None):
    """«Препродакшен» section of штурм.md. folders: element id -> its folder in the project (after export); where(e, what, rel) -> file path."""
    els = d.get("elements") or []
    if not els:
        return []
    where = where or (lambda e, what, rel: rel)
    folder_of = (lambda e: (folders or {}).get(e["id"]))
    idx = by_name(d)
    eng = "3D-диорама (stage3d.js)" if d.get("engine") == "3d" else "2D-аппликация"
    L = ["## Препродакшен",
         f"Движок сцен: {eng}. Всё ниже — черновики и ТЗ: образ и стартовый код, финал делается при сборке ролика по пунктам «для финала». "
         "✓ — утверждён автором, без пометки — предложен, ещё не проверен. @[Название] в любом тексте — ссылка на элемент из указателя."
         + (f" Подробное ТЗ каждого элемента — `{BASE}/<тип>/<папка>/README.md`, всё сразу в JSON — `{BASE}/manifest.json`, как пользоваться — `{BASE}/README.md`." if folders else ""), ""]
    rows = [e for e in els if e.get("status") != "drop"]
    L += ["### Указатель элементов", "| @ | тип | статус | черновик / звук | папка |", "|---|---|---|---|---|"]
    for kind in KINDS:
        for e in rows:
            if e.get("kind") != kind:
                continue
            r = el_render(e)
            mix = el_mix(e)
            what = (f"v{r.get('v')}" + (" 3D" if r.get("three") else "") + (f", `{r['fn']}`" if r.get("fn") else "")) if r else \
                (f"{len(mix)} {'слой' if len(mix) == 1 else 'слоя' if len(mix) < 5 else 'слоёв'}" if mix else "—")
            L.append(f"| @[{_cell(e.get('name'))}] | {ICON.get(kind, '')} {ONE.get(kind, '')} | {'✓' if e.get('status') == 'ok' else 'предложен'} | {what} | {('`' + folder_of(e) + '/`') if folder_of(e) else '—'} |")
    L.append("")
    for kind, label in KINDS.items():
        part = [e for e in rows if e.get("kind") == kind]
        if not part:
            continue
        L.append(f"### {ICON[kind]} {label}")
        for e in part:
            L.append(f"- {'✓ ' if e.get('status') == 'ok' else ''}**{e.get('name', '')}** — {(e.get('desc') or '').strip() or '(без описания)'}"
                     + (f" _Где:_ {e['why'].strip()}" if (e.get("why") or "").strip() else ""))
            if kind == "scene":
                cast = cast_of(e, d, idx)
                if cast:
                    L.append("  - в сцене: " + ", ".join(f"@[{x.get('name', '')}]" + (" (отмечен через @)" if via == "@" else "") for x, via in cast))
            else:
                sc = used_in(e, d, idx)
                if sc:
                    L.append("  - стоит в сценах: " + ", ".join(f"@[{s.get('name', '')}]" for s in sc))
            refs = [where(e, "ref", r["img"]) + (f" ({r['note']})" if r.get("note") else "") for r in e.get("refs") or [] if r.get("img")]
            if refs:
                L.append("  - референсы автора: " + ", ".join(refs))
            r = el_render(e)
            if r:
                L.append(f"  - черновик v{r.get('v')}{' (3D)' if r.get('three') else ''}: {where(e, 'render', r['img'])} · код `{where(e, 'code', 'render/' + r['dir'] + '/element.js')}`"
                         + (f", функция `{r['fn']}`" if r.get("fn") else "") + (f" — {r['summary']}" if r.get("summary") else ""))
                fx = ((e.get("fx") or {}).get("main") or {})
                open_fx = "; ".join(([fx["text"]] if (fx.get("text") or "").strip() else []) + [n["text"].strip() for n in fx.get("notes") or [] if (n.get("text") or "").strip()]
                                    + [p.get("text") or "(пин без текста)" for p in fx.get("pins") or []])
                if open_fx:
                    L.append(f"  - ещё не отправленные правки к черновику: {open_fx}")
            fin = [f for f in e.get("final") or [] if (f.get("text") or "").strip()]
            if fin:
                L.append("  - **для финала** (требования автора к готовому ассету):")
                L += [f"    {n}. {f['text'].strip()}" + (" (📍 пин на черновике — final_pins.png)" if f.get("x") is not None else "") for n, f in enumerate(fin, 1)]
            if kind == "sound":
                mix = el_mix(e)
                if mix:
                    L.append(f"  - звук: `{where(e, 'mix', '')}`" + (" — сведено из слоёв:" if len(mix) > 1 else ""))
                    for n, m in enumerate(mix, 1):
                        s = m["s"]
                        L.append(f"    {n}. +{m['at']:g} с, громкость {round(m['gain'] * 100)}%: «{s.get('title', '')}» `{where(e, 'layer', s['file'])}`"
                                 + (f" — {m['note'].strip()}" if (m.get("note") or "").strip() else "")
                                 + " · " + ", ".join(x for x in (s.get("author"), s.get("src"), s.get("license"), s.get("page")) if x))
                    if (e.get("mixNote") or "").strip():
                        L.append(f"    Как свести: {e['mixNote'].strip()}")
                elif e.get("q"):
                    L.append(f"  - звук ещё не выбран; искать: «{e['q']}»")
        L.append("")
    drop = [e.get("name", "") for e in els if e.get("status") == "drop"]
    if drop:
        L += ["Вычеркнуты (не нужны): " + ", ".join(drop), ""]
    return L


def _cell(s):
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


SRC_NAMES = {"polypizza": "Poly Pizza", "polyhaven": "Poly Haven", "sketchfab": "Sketchfab", "oga": "OpenGameArt", "openverse": "Openverse",
             "commons": "Wikimedia Commons", "ambientcg": "ambientCG"}


def el_assets(e):
    return [a for a in e.get("assets") or [] if a.get("main")]


def is_model(a):
    return a.get("kind") == "3d" and (a.get("fmt") or "").lower() in ("glb", "gltf")


def asset_who(a):
    return ", ".join(x for x in (a.get("license"), a.get("author"), SRC_NAMES.get(a.get("src"), a.get("src"))) if x)


def assets_brief(e, data, three=False, indent=""):
    """Assets the author took «в работу» for a prompt: file, url for the stand, how to use it in our engine."""
    fwd = lambda p: p.replace("\\", "/")
    L = []
    for a in el_assets(e):
        k, url = a["id"], "/" + a["main"]
        nm = (a.get("title") or "Предмет") if e.get("kind") == "scene" else e.get("name", "")     # a scene's own asset is one thing in it
        prev = f"; превью {fwd(os.path.join(data, a['preview']))}" if a.get("preview") else ""
        if is_model(a):
            use = (f"3D-модель glTF: в element.js const MODELS = {{ {k}: '{url}' }}; в build: w.model('{k}', {{ h: <высота, м>, pos: [x, 0, z], name: '{nm}', matte: true }})"
                   " (matte — матовый бумажный вид; модель сама встаёт на пол по центру)" if three
                   else "3D-модель — в 2D-черновик не встанет: смотри её превью как референс формы")
        elif a.get("kind") == "3d":
            use = "3D не в glTF (" + (a.get("fmt") or "?") + ") — только референс формы"
        elif a.get("kind") == "tex":
            use = (f"текстура (карта цвета): PICS.{k} = '{url}' -> IMG.{k}; на пол / стену: w.plane({{ size, draw: (g, cw, ch) => g.drawImage(IMG.{k}, 0, 0, cw, ch) }})" if three
                   else f"текстура: PICS.{k} = '{url}' -> IMG.{k}, заливка узором: g.fillStyle = g.createPattern(IMG.{k}, 'repeat')")
        else:
            use = f"картинка: PICS.{k} = '{url}' -> IMG.{k}; " + ("в 3D — spriteCard(w, '" + k + "', { h, pos, name })" if three else "вырезкой photo / sticker или как образец")
        why = f" — автор: «{a['why'].strip()}»" if (a.get("why") or "").strip() else ""
        L.append(f"{indent}- «{a.get('title', '')}» ({asset_who(a)}){why}\n{indent}  файл {fwd(os.path.join(data, a['main']))}{prev}\n{indent}  {use}")
    return "\n".join(L)


def element_brief(e, d, data):
    """Everything about an element for a prompt: texts, final wishes, @-links with their drafts — Claude reads files by these paths."""
    idx = by_name(d)
    fwd = lambda p: p.replace("\\", "/")
    L = []
    fin = [f for f in e.get("final") or [] if (f.get("text") or "").strip()]
    if fin:
        L.append("Автор уже записал, что хочет от этого ассета в финальном ролике (учти в черновике то, что на нём видно):")
        L += [f"{n}. {f['text'].strip()}" + (f" (место на прошлом черновике: x≈{round(f['x'] * 1080)}, y≈{round(f['y'] * 1920)})" if f.get("x") is not None else "")
              for n, f in enumerate(fin, 1)]
    ms = el_mentions(e, d, idx)
    if ms:
        L.append("Автор отметил через @ (ссылки @[Название] в текстах выше и ниже — это они):")
        for x in ms:
            r = el_render(x)
            line = f"- @[{x.get('name', '')}] — {ONE.get(x.get('kind'), '')}, {STATUS.get(x.get('status') or '', '')}: {x.get('desc') or 'без описания'}"
            if r:
                line += f"\n  черновик {fwd(os.path.join(data, r['img']))}, код {fwd(os.path.join(data, 'render', *r['dir'].split('/'), 'element.js'))}" + (f", функция {r['fn']}" if r.get("fn") else "")
            s = el_sound(x)
            if s:
                line += f"\n  звук {fwd(os.path.join(data, s['file']))} ({s.get('dur')} с)"
            L.append(line)
    return "\n".join(L)


# ---------------- export into the project ----------------
def premix(layers, dst):
    """layers: [(wav path, at seconds, gain)] -> one mono wav. Each layer is peak-normalised like audio.py does with file: sounds."""
    tracks = []
    for path, at, gain in layers:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, creationflags=NOWIN).stdout
        y = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
        if len(y):
            tracks.append((int(max(0.0, at) * SR), y / max(1e-9, np.abs(y).max()) * 0.9 * gain))
    if not tracks:
        return False
    out = np.zeros(max(o + len(y) for o, y in tracks))
    for o, y in tracks:
        out[o:o + len(y)] += y
    peak = np.abs(out).max()
    if peak > 0.98:
        out *= 0.98 / peak
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with wave.open(dst, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    return True


def mark_pins(src, dst, pins, color=(20, 170, 90)):
    try:
        from PIL import Image, ImageDraw, ImageFont
        im = Image.open(src).convert("RGB")
        dr, (w, h) = ImageDraw.Draw(im), im.size
        r = max(26, w // 30)
        try:
            f = ImageFont.truetype("arialbd.ttf", int(r * 1.1))
        except Exception:
            f = ImageFont.load_default()
        for n, x, y in pins:
            X, Y = x * w, y * h
            dr.ellipse([X - r, Y - r, X + r, Y + r], fill=color, outline=(255, 255, 255), width=max(3, r // 7))
            dr.text((X, Y), str(n), fill=(255, 255, 255), font=f, anchor="mm")
        im.save(dst)
        return True
    except Exception as e:
        print("! пины не нарисовались:", e)
        return False


def export(doc, data, dst, toolkit):
    """Preproduction into the project dst. -> (where(e, what, rel), folders{id: folder})."""
    slugs, idx = el_slugs(doc), by_name(doc)
    rows = live(doc)
    folders = {e["id"]: f"{BASE}/{e.get('kind', 'prop')}/{slugs[e['id']]}" for e in rows}
    paths, manifest = {}, []
    full = lambda rel: os.path.join(dst, *rel.split("/"))

    def put(src_rel, dst_rel):
        src = os.path.join(data, *src_rel.split("/"))
        if not os.path.isfile(src):
            return src_rel + " (файл не найден)"
        os.makedirs(os.path.dirname(full(dst_rel)), exist_ok=True)
        shutil.copy2(src, full(dst_rel))
        return dst_rel

    if rows and toolkit and os.path.isfile(toolkit):
        os.makedirs(full(f"{BASE}/_toolkit"), exist_ok=True)
        shutil.copy2(toolkit, full(f"{BASE}/_toolkit/paper.js"))
    for e in rows:
        folder, eid, kind = folders[e["id"]], e["id"], e.get("kind", "prop")
        rec = {"id": eid, "kind": kind, "name": e.get("name", ""), "slug": slugs[eid], "status": e.get("status") or "", "folder": folder + "/",
               "desc": e.get("desc", ""), "why": e.get("why", ""), "readme": folder + "/README.md", "refs": [], "final": []}
        for i, r in enumerate(e.get("refs") or [], 1):
            if r.get("img"):
                p = paths[(eid, "ref", r["img"])] = put(r["img"], f"{folder}/ref{i}{os.path.splitext(r['img'])[1]}")
                rec["refs"].append({"file": p, "note": r.get("note", "")})
        rec["assets"] = []
        for n, a in enumerate(el_assets(e), 1):
            src_dir = os.path.join(data, *a["dir"].split("/"))
            if not os.path.isdir(src_dir):
                continue
            base = f"assets/{'models' if a.get('kind') == '3d' else 'img'}/{slugs[eid]}" + (f"-{n}" if n > 1 else "")
            shutil.copytree(src_dir, full(base), dirs_exist_ok=True)
            main = base + "/" + os.path.relpath(os.path.join(data, *a["main"].split("/")), src_dir).replace(os.sep, "/")
            prev = put(a["preview"], f"{folder}/asset{n}{os.path.splitext(a['preview'])[1]}") if a.get("preview") else ""
            rec["assets"].append({"n": n, "key": slug(a.get("title") or "asset", 20).replace("-", "_") + (f"_{n}" if n > 1 else ""), "title": a.get("title", ""),
                                  "kind": a.get("kind"), "fmt": a.get("fmt"), "file": main, "dir": base + "/", "preview": prev, "model": is_model(a),
                                  "license": a.get("license", ""), "attr": bool(a.get("attr")), "author": a.get("author", ""),
                                  "source": SRC_NAMES.get(a.get("src"), a.get("src", "")), "page": a.get("page", ""), "why": a.get("why", ""), "note": a.get("note", "")})
        r = el_render(e)
        if r:
            png = paths[(eid, "render", r["img"])] = put(r["img"], f"{folder}/v{r.get('v')}.png")
            code_rel = "render/" + r["dir"] + "/element.js"
            code = paths[(eid, "code", code_rel)] = put(code_rel, f"{folder}/element.js")
            rec["draft"] = {"v": r.get("v"), "png": png, "code": code, "fn": r.get("fn", ""), "three": bool(r.get("three")), "summary": r.get("summary", ""),
                            **({"layout": r["layout"]} if r.get("layout") else {}), **({"groups": r["groups"]} if r.get("groups") else {})}
        fin = [f for f in e.get("final") or [] if (f.get("text") or "").strip()]
        pinned = [(n, float(f["x"]), float(f["y"])) for n, f in enumerate(fin, 1) if f.get("x") is not None]
        if pinned and r and os.path.isfile(os.path.join(data, r["img"])) and mark_pins(os.path.join(data, r["img"]), full(f"{folder}/final_pins.png"), pinned):
            rec["final_pins"] = f"{folder}/final_pins.png"
        rec["final"] = [{"n": n, "text": f["text"].strip(), **({"pin": [f["x"], f["y"]]} if f.get("x") is not None else {})} for n, f in enumerate(fin, 1)]
        rec["mentions"] = [{"id": x["id"], "name": x.get("name", ""), "kind": x.get("kind"), "folder": (folders.get(x["id"]) or "") + "/" if folders.get(x["id"]) else None}
                           for x in el_mentions(e, doc, idx)]
        if kind == "scene":
            rec["cast"] = [{"id": x["id"], "name": x.get("name", ""), "kind": x.get("kind"), "via": via, "folder": folders.get(x["id"], "") + "/"} for x, via in cast_of(e, doc, idx)]
        else:
            rec["used_in"] = [{"id": s["id"], "name": s.get("name", "")} for s in used_in(e, doc, idx)]
        if kind == "sound":
            mix = el_mix(e)
            if mix:
                layers = []
                for n, m in enumerate(mix, 1):
                    s = m["s"]
                    lp = paths[(eid, "layer", s["file"])] = put(s["file"], f"assets/sfx/{slugs[eid]}/{n}-{slug(s.get('title') or 'sound', 24)}.wav")
                    layers.append({"n": n, "file": lp, "at": m["at"], "gain": m["gain"], "note": m.get("note", ""), "title": s.get("title", ""),
                                   "dur": s.get("dur"), "peak_t": s.get("peak_t"), "source": s.get("src", ""), "license": s.get("license", ""),
                                   "author": s.get("author", ""), "url": s.get("page") or s.get("url", "")})
                main = f"assets/sfx/{slugs[eid]}.wav"
                if len(mix) == 1 and not mix[0]["at"] and mix[0]["gain"] == 1:
                    put(mix[0]["s"]["file"], main)
                else:
                    premix([(os.path.join(data, m["s"]["file"]), m["at"], m["gain"]) for m in mix], full(main))
                paths[(eid, "mix", "")] = main
                rec["sound"] = {"file": main, "layers": layers, "mixNote": e.get("mixNote", "")}
        write(full(f"{folder}/README.md"), element_readme(e, rec, doc, folders, idx))
        manifest.append(rec)
    if rows:
        write(full(f"{BASE}/README.md"), folder_readme(doc, manifest))
        write(full(f"{BASE}/manifest.json"), json.dumps({"plan": doc.get("id"), "name": doc.get("name", ""), "idea": doc.get("idea", ""),
                                                         "engine": doc.get("engine") or "2d", "toolkit": f"{BASE}/_toolkit/paper.js",
                                                         "mention": "@[Название] в текстах = элемент с таким name", "elements": manifest},
                                                        ensure_ascii=False, indent=1))
    return (lambda e, what, rel: paths.get((e["id"], what, rel), rel)), folders


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def element_readme(e, rec, d, folders, idx):
    kind, folder = e.get("kind"), rec["folder"].rstrip("/")
    link = lambda t: linkify(t, d, lambda x: folders.get(x["id"]), rel_from=folder, idx=idx)
    rel = lambda p: os.path.relpath(p, folder).replace(os.sep, "/")
    L = [f"# {ICON.get(kind, '')} {ONE.get(kind, '').capitalize()}: {e.get('name', '')}",
         f"Статус: **{STATUS.get(e.get('status') or '', '')}** · id `{e['id']}` · штурм `{d.get('id')}` · общий указатель — `../../README.md`, всё в JSON — `../../manifest.json`", ""]
    if e.get("status") != "ok":
        L += ["> Автор ещё не утвердил этот элемент: черновик — только вариант. Если что-то непонятно, спроси автора или делай по описанию.", ""]
    L += ["## Что это", link((e.get("desc") or "").strip()) or "(без описания)"]
    if (e.get("why") or "").strip():
        L.append(f"\n**Где в ролике:** {link(e['why'].strip())}")
    L.append("")
    if rec.get("final"):
        L += ["## Для финала — требования автора", "Черновик ниже — согласованный образ. Эти пункты — что автор хочет увидеть в готовом ролике: выполни каждый."
              + (" Пины с номерами — на `final_pins.png`." if rec.get("final_pins") else ""), ""]
        L += [f"{f['n']}. {link(f['text'])}" + (" 📍" if f.get("pin") else "") for f in rec["final"]]
        L.append("")
    elif e.get("status") == "ok":
        L += ["## Для финала", "Отдельных требований нет: финал — утверждённый черновик, доведённый до качества ролика (анимация, свет, склейки).", ""]
    if kind == "scene" and rec.get("cast"):
        L += ["## Что в сцене", "Собери сцену из этих элементов (их код и ТЗ — в их папках; бери последнюю утверждённую версию оттуда, а не копию из кода сцены):", "",
              "| кто / что | тип | как попал | папка |", "|---|---|---|---|"]
        L += [f"| {c['name']} | {ONE.get(c['kind'], '')} | {'«Что в сцене»' if c['via'] == 'uses' else '@ в тексте сцены'} | [{rel(c['folder'].rstrip('/'))}/]({rel(c['folder'].rstrip('/'))}/) |" for c in rec["cast"]]
        L.append("")
    if rec.get("used_in"):
        L += ["## Стоит в сценах", ", ".join(f"[{s['name']}]({rel(folders[s['id']])}/)" for s in rec["used_in"] if folders.get(s["id"])), ""]
    if rec.get("mentions"):
        L += ["## Отмечено через @", *[f"- [{m['name']}]({rel(m['folder'].rstrip('/'))}/) — {ONE.get(m['kind'], '')}" if m.get("folder") else f"- {m['name']} — {ONE.get(m['kind'], '')} (вычеркнут)"
                                        for m in rec["mentions"]], ""]
    snd = rec.get("sound")
    if snd:
        L += ["## Звук", f"Готовый звук: `{snd['file']}`" + (" — сведён из слоёв ниже с этими сдвигами и громкостью." if len(snd["layers"]) > 1 else "."), ""]
        if len(snd["layers"]) > 1 or snd["layers"][0]["note"]:
            L += ["| # | слой | сдвиг, с | громкость | что это / куда |", "|---|---|---|---|---|"]
            L += [f"| {x['n']} | `{x['file']}` ({x['dur']} с, пик {x['peak_t']} с) | +{x['at']:g} | {round(x['gain'] * 100)}% | {link(x['note']) or '—'} |" for x in snd["layers"]]
            L.append("")
        if (snd.get("mixNote") or "").strip():
            L += [f"**Как свести (автор):** {link(snd['mixNote'].strip())}", ""]
        L += ["В `src/scenes.js`, в `sfx(add)` нужной сцены (t — момент события):", "```js", f"add(t, 'file:{snd['file']}', 1);          // всё сразу"]
        if len(snd["layers"]) > 1:
            L.append("// или слоями, если их надо двигать по отдельности (audio.py нормирует каждый файл по пику, громкость — множитель):")
            L += [f"add(t + {x['at']:g}, 'file:{x['file']}', {x['gain']:g});" for x in snd["layers"]]
        L += ["```", "", "Источники и права (перенеси в «Права» упаковки):"]
        L += [f"- {x['title']}: " + ", ".join(v for v in (x["author"], x["source"], x["license"], x["url"]) if v) for x in snd["layers"]]
        L.append("")
    if rec.get("assets"):
        L += ["## Ассеты (бесплатные, автор взял в работу)", "Скачаны в `assets/` проекта. Используй их вместо того, чтобы рисовать заново, если автор не сказал иначе; "
              "права — в «Права» упаковки (где лицензия требует подписи — укажи автора).", ""]
        for x in rec["assets"]:
            L.append(f"- **{x['title']}** — {x['kind']}, `{x['file']}`" + (f" (превью `{rel(x['preview'])}`)" if x.get("preview") else "")
                     + f"; {', '.join(v for v in (x['license'], x['author'], x['source']) if v)}" + (" — **нужна подпись автора**" if x["attr"] else "")
                     + (f"; автор: «{link(x['why'])}»" if (x.get("why") or "").strip() else "") + (f"; ⚠ {x['note']}" if x.get("note") else ""))
        models = [x for x in rec["assets"] if x["model"]]
        pics = [x for x in rec["assets"] if not x["model"] and x["kind"] != "3d"]
        if models or pics:
            L += ["", "```js"]
            if models:
                L += ["// 3D (stage3d.js): модели грузит stage3dInit, в мире — w.model(ключ, { h: высота в м, pos, rotY, name, matte: true })",
                      "ASSETS.models = { " + ", ".join(f"{x['key']}: '../{x['file']}'" for x in models) + " };"]
            if pics:
                L += ["ASSETS.images = { ...ASSETS.images, " + ", ".join(f"{x['key']}: '../{x['file']}'" for x in pics) + " };   // -> IMG.<ключ>"]
            L.append("```")
        L += ["", "Источники: " + "; ".join(f"{x['title']} — {x['page']}" for x in rec["assets"] if x.get("page")), ""]
    dr = rec.get("draft")
    if dr or rec.get("refs"):
        L.append("## Файлы")
        if dr:
            L.append(f"- `{rel(dr['png'])}` — черновик v{dr['v']}{' (3D-диорама)' if dr['three'] else ''}: так ассет выглядит сейчас")
            if dr["three"]:
                L.append(f"- `element.js` — 3D-мир `world3d` (функция `{dr['fn'] or 'build…'}`): перенеси мир в `src/<проект>3d.js`, `ELEMENT.draw` показывает, как он рисуется в кадр; нужен `src/stage3d.js` шаблона и тулкит с `drawHog`")
                if dr.get("layout") or dr.get("groups"):
                    L.append("- **расстановку автор поправил руками** (3D-просмотр, «✋ Двигать»): в конце `element.js` — блок `// ==== расстановка автора` с группами (`w.groups`) и сдвигами объектов по именам (`w.layout`). "
                             "Перенеси его вместе с миром (`мир.groups = …; мир.layout = …`, stage3d.js собирает группы после build и применяет сдвиги поверх кода) или впиши сдвиги в координаты; имена объектов (`name`) и порядок создания безымянных не меняй")
                if any(x["model"] for x in rec.get("assets") or []):
                    L.append("- в `element.js` модели подключены как `MODELS = { ключ: '/files/…' }` (так их грузит стенд Штурма); в проекте это `ASSETS.models` с путями из раздела «Ассеты»")
            else:
                L.append(f"- `element.js` — код черновика" + (f", функция `{dr['fn']}`" if dr["fn"] else "") + ": скопируй функцию в `src/scenes.js` и вызывай в сцене; "
                         "`ELEMENT.draw` — только лист-витрина, его не переноси")
            L.append("- код вызывает функции бумажного тулкита — он лежит в `../../_toolkit/paper.js` (в проект — `src/paper.js`, подключить перед `scenes.js`)")
            if dr.get("summary"):
                L.append(f"- что нарисовано: {dr['summary']}")
        if rec.get("final_pins"):
            L.append("- `final_pins.png` — черновик с номерами пинов из «Для финала»")
        L += [f"- `{rel(x['file'])}` — референс автора" + (f": {x['note']}" if x.get("note") else "") for x in rec["refs"]]
        L.append("")
    return "\n".join(L)


def folder_readme(d, manifest):
    L = ["# Препродакшен — как пользоваться (для Claude-реализатора)",
         f"Штурм `{d.get('id')}` «{d.get('name', '')}». Автор подготовил это в «Штурме идей» до сценария. Движок сцен: {'3D-диорама' if d.get('engine') == '3d' else '2D-аппликация'}.", "",
         "**Черновики — не финал.** Это согласованный образ и стартовый код. Готовый ассет делаешь ты при сборке ролика: анимация, свет, склейки — "
         "и обязательно пункты «Для финала» из README элемента (это прямые требования автора).", "",
         "Как устроено:",
         "- `<тип>/<папка>/README.md` — ТЗ элемента: что это, где в ролике, требования для финала, состав сцены, файлы, готовые строки кода. **Читай его перед тем, как делать элемент.**",
         "- `manifest.json` — то же для всех элементов в одном JSON (id, тип, статус, тексты, файлы, `cast` у сцен, `used_in`, `mentions`, слои звуков).",
         "- `@[Название]` в любом тексте (штурм.md, README, заметки) — ссылка на элемент из таблицы ниже; в README элементов это уже ссылки на папки.",
         "- Статус: ✓ утверждён — делай по черновику; «предложен» — черновик не проверен автором, уточни или делай по описанию.",
         "- Порядок: персонажи и пропсы → сцены (собираются из них: `cast` / «Что в сцене») → звуки (готовые файлы в `assets/sfx/`).",
         "- 📦 ассеты — бесплатные модели, картинки и текстуры, которые автор нашёл и взял в работу: уже в `assets/models/` и `assets/img/` проекта, "
         "лицензии и готовые строки `ASSETS` — в README элемента.",
         "- `_toolkit/paper.js` — бумажный тулкит, на котором написан код черновиков (`drawHog`, `cut`, `note`…). В проекте подключи его как `src/paper.js` перед `scenes.js`.", "",
         "| элемент | тип | статус | папка | черновик / звук | для финала |", "|---|---|---|---|---|---|"]
    for kind in KINDS:
        for r in manifest:
            if r["kind"] != kind:
                continue
            dr, sn = r.get("draft"), r.get("sound")
            what = (f"v{dr['v']}" + (" 3D" if dr["three"] else "") + (f" `{dr['fn']}`" if dr["fn"] else "")) if dr else (f"`{sn['file']}`" if sn else "—")
            if r.get("assets"):
                what += f" · 📦 {len(r['assets'])}"
            L.append(f"| @[{_cell(r['name'])}] | {ICON.get(kind, '')} {ONE.get(kind, '')} | {'✓' if r['status'] == 'ok' else 'предложен'} | [{kind}/{r['slug']}/]({kind}/{r['slug']}/) | {what} | {len(r['final']) or '—'} |")
    return "\n".join(L) + "\n"
