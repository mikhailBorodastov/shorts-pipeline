"""Упаковка видео (S8, docs/studio/stage8-review-pack.md): «Права» — из лицензий того, что вошло в ролик; тексты (названия, описания, закреп, хэштеги) — кнопка ✨ `packtext`;
`out/packaging.md` проекта; обложки — версии «🎨 Отрисовать» (thumbs[].renders) -> `out/thumbnail_N.png/.jpg`."""
import json, os, re, shutil

import paths as P  # noqa: E402


def _lib_dir(vid):
    ch = P.index()["videos"].get(vid, {}).get("channel")
    c = P.channel(ch) or {}
    return os.path.join(c.get("dir") or "", "library")


def _scene(vid, el):
    try:
        return json.load(open(os.path.join(P.render(vid), el, "work", "scene.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return None


def used_scenes(plan):
    m = plan.get("montage") or {}
    els = [u["scene"] for u in m.get("units") or []]
    if not els:
        els = [e["id"] for e in plan.get("elements") or [] if e.get("kind") == "scene" and (e.get("stage") or {}).get("work") and e.get("status") != "drop"]
    return list(dict.fromkeys(els))


def rights(plan):
    """Что вошло в ролик и чьё оно: [{what, kind, author, license, url, own}] — звуки (препродакшен, библиотеки), пропсы и персонажи библиотеки, ассеты."""
    vid = plan["id"]
    els = {e["id"]: e for e in plan.get("elements") or []}
    out, seen = [], set()

    def add(_k=None, **r):
        k = _k or (r.get("what"), r.get("url") or r.get("author"))
        if k not in seen:
            seen.add(k)
            out.append(r)

    def sound_el(eid, why):
        import preprod
        e = els.get(eid)
        for m in (preprod.el_mix(e) if e else []):
            s = m["s"]
            add(what=f"звук «{e.get('name')}»: {s.get('title') or ''}".strip(), kind="sound", author=s.get("author") or "", license=s.get("license") or "",
                url=s.get("page") or s.get("url") or "", src=s.get("src") or "", why=why)

    lib_sfx, libroot = set(), _lib_dir(vid)
    for el in used_scenes(plan):
        sc = _scene(vid, el) or {}
        for o in sc.get("objects") or []:
            ref = (o.get("src") or {}).get("prefab") or ""
            m = re.match(r"lib:([a-z]+)/([a-z0-9-]+)@(\d+)$", ref)
            if m:
                kind, slug, v = m.groups()
                try:
                    lic = json.load(open(os.path.join(libroot, kind, slug, "v" + v, "license.json"), encoding="utf-8"))
                except (OSError, ValueError):
                    lic = []
                for L in (lic if isinstance(lic, list) else [lic]):
                    add(_k=("lib", kind, slug), what=f"{'персонаж' if kind == 'characters' else 'предмет'} «{o.get('name')}» ({slug})", kind=kind, own=bool(L.get("own")),
                        author=L.get("author") or ("автор канала" if L.get("own") else ""), license=L.get("license") or ("свой" if L.get("own") else ""),
                        url=L.get("url") or L.get("page") or "", note=L.get("note") or "")
        for s in sc.get("sounds") or []:
            src = s.get("src") or ""
            if src.startswith("el:"):
                sound_el(src[3:], "звук сцены")
            elif src.startswith("lib:"):
                lib_sfx.add(src[4:].split("|")[0])
    m = plan.get("montage") or {}
    for x in (m.get("sfx") or []) + (m.get("music") or []):
        src = x.get("src") or ""
        if src.startswith("el:"):
            sound_el(src[3:], "музыка" if x in (m.get("music") or []) else "звук")
        elif src.startswith("lib:") and not src.startswith("lib:sounds/"):
            lib_sfx.add(src[4:].split("|")[0])
    if lib_sfx:
        packs = {}
        try:
            for s in json.load(open(os.path.join(P.SFXLIB, "index.json"), encoding="utf-8")).get("sounds", []):
                if s["id"] in lib_sfx:
                    packs.setdefault(s.get("pack") or "библиотека звуков", []).append(s.get("name") or s["id"])
        except (OSError, ValueError):
            pass
        for pk, names in packs.items():
            add(what="звуки: " + ", ".join(sorted(names)[:8]), kind="sfxlib", author=pk, license="пак звуков пайплайна (лицензия пака)", url="")
    for e in plan.get("elements") or []:
        if e.get("status") == "drop":
            continue
        for a in e.get("assets") or []:
            add(what=f"ассет «{a.get('name') or a.get('title') or ''}» для «{e.get('name')}»", kind="asset", author=a.get("author") or "",
                license=a.get("license") or "", url=a.get("page") or a.get("url") or "")
    return out


def rights_md(rs):
    lines = []
    for r in rs:
        if r.get("own"):
            continue
        lines.append(f"- {r['what']} — {r.get('author') or 'автор не указан'}" + (f", {r['license']}" if r.get("license") else "") + (f" · {r['url']}" if r.get("url") else ""))
    own = [r["what"] for r in rs if r.get("own")]
    if own:
        lines.append("- Своё (нарисовано в Claude Studio): " + "; ".join(own))
    return "\n".join(lines) or "- (сторонних материалов не найдено)"


def packaging_md(plan, pack):
    T = pack.get("titles") or []
    best = [t for t in T if t.get("best")] + [t for t in T if not t.get("best")]
    out = [f"# Упаковка: {plan.get('name')}", ""]
    out += ["## Названия", *[f"{i + 1}. {t['text']}" + (" ⭐ лучшее" if t.get("best") else "") + (f"  _({t['angle']})_" if t.get("angle") else "") for i, t in enumerate(best)], ""]
    out += ["## Описание — короткое (Shorts / Reels)", pack.get("short") or "", "",
            "## Описание — с источниками", pack.get("sources") or "", "",
            "## Описание — провокация для комментариев", pack.get("provoke") or "", "",
            "## Закреп в комментариях", pack.get("pin") or "", "",
            "## Хэштеги", " ".join(pack.get("tags") or []), "",
            "## Права", pack.get("rights_md") or "", ""]
    if pack.get("covers"):
        out += ["## Обложки", *[f"- out/{c}" for c in pack["covers"]], ""]
    return "\n".join(out)


def write_md(A, vid):
    plan = A.load("plan:" + vid)
    d = P.video(vid)
    if not d or not os.path.isfile(os.path.join(d, "build.sh")):
        return None
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    p = os.path.join(d, "out", "packaging.md")
    A.write_text(p, packaging_md(plan, plan.get("pack") or {}))
    return p


def export_covers(A, vid):
    """Обложки-версии (текущая версия каждого концепта с отрисовкой) -> out/thumbnail_N.png + .jpg проекта."""
    plan = A.load("plan:" + vid)
    d = P.video(vid)
    if not d or not os.path.isfile(os.path.join(d, "build.sh")):
        raise ValueError("у видео нет проекта ролика")
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    win = (plan.get("final") or {}).get("thumb")
    cs = sorted([c for c in plan.get("thumbs") or [] if c.get("renders")], key=lambda c: c["id"] != win)
    names = []
    for c in cs:
        rs = c["renders"]
        r = next((x for x in rs if x.get("id") == c.get("render")), rs[-1])
        src = P.resolve(r.get("cover") or "")
        if not src or not os.path.isfile(src):
            continue
        n = len(names) + 1
        png = os.path.join(d, "out", f"thumbnail_{n}.png")
        shutil.copy2(src, png)
        try:
            from PIL import Image
            Image.open(png).convert("RGB").save(png[:-4] + ".jpg", quality=92)
        except Exception:
            pass
        names.append(f"thumbnail_{n}.png")
    if not names:
        raise ValueError("нет отрисованных обложек — «🎨 Отрисовать» у концепта")
    A.apply_ops("plan:" + vid, [{"op": "set", "path": ["pack", "covers"], "value": names}])
    write_md(A, vid)
    return names


def handle_post(A, h, p, body):
    vid = body.get("video", "")
    if p == "/api/pack/covers":
        h._json({"covers": export_covers(A, vid), "md": write_md(A, vid)}); return True
    if p == "/api/pack/rights":
        rs = rights(A.load("plan:" + vid))
        h._json({"rights": rs, "md": rights_md(rs)}); return True
    if p == "/api/pack/md":
        h._json({"md": write_md(A, vid)}); return True
    return False
