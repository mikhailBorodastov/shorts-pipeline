"""Бесплатные ассеты для препродакшена «Штурма»: поиск 3D-моделей, 2D-картинок и текстур и скачивание «в работу».

    python assets.py search "elevator" ["lift door" …] [--kind 3d|2d|tex] [--n 12]   -> JSON: кандидаты (так ищет и Claude; несколько запросов — список)
    python assets.py fetch <src> <id> <папка>                           -> скачать ассет в папку, JSON: {main, files, …}

Источники (все без ключей, кроме скачивания со Sketchfab):
  3D   — Poly Pizza (low-poly .glb, много CC0 от Kenney и Quaternius; CC-BY от Google Poly), Poly Haven (CC0, реалистичные glTF),
         Sketchfab (поиск по скачиваемым; скачать — только с токеном: _ideas/sketchfab_token.txt), OpenGameArt (3D);
  2D   — Openverse (фото и рисунки под CC: Flickr, Wikimedia…), Wikimedia Commons, OpenGameArt (спрайты, 2D);
  tex  — ambientCG (CC0, PBR-текстуры), Poly Haven (CC0 текстуры).
Кандидат: {src, id, title, kind: 3d|2d|tex, thumb, page, license, attr (нужна подпись автора), author, fmt, dl (можно скачать), note}.
Искать лучше по-английски: почти все каталоги английские.
"""
import html, io, json, os, re, shutil, sys, time, urllib.parse, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ShturmIdeas/1.0 (local tool of a YouTube creator)"
MAX_BYTES = 150 * 1024 * 1024
NAMES = {"polypizza": "Poly Pizza", "polyhaven": "Poly Haven", "sketchfab": "Sketchfab", "oga": "OpenGameArt", "openverse": "Openverse",
         "commons": "Wikimedia Commons", "ambientcg": "ambientCG", "quaternius": "Quaternius", "kenney": "Kenney", "smithsonian": "Smithsonian 3D",
         "objaverse": "Objaverse"}
BY_KIND = {"3d": ("polypizza", "quaternius", "kenney", "polyhaven", "sketchfab", "objaverse", "smithsonian", "oga"), "2d": ("openverse", "commons", "oga"),
           "tex": ("ambientcg", "polyhaven")}
CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".studio", "cache")
TOKEN_FILE = "sketchfab_token.txt"


def _get(url, timeout=30, limit=MAX_BYTES, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,ru;q=0.8", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"файл больше {limit // 2**20} МБ")
        return data, (r.headers.get("Content-Type") or "").lower(), r.geturl()


def _json(url, **k):
    return json.loads(_get(url, limit=8 * 2**20, **k)[0])


def _words(s):
    return re.findall(r"[a-zа-яё0-9]+", (s or "").lower().replace("ё", "е"))


def _free(lic):
    l = (lic or "").lower().replace("-", " ")
    return l.startswith("cc0") or "public domain" in l or l in ("pdm", "cc 0")


def _row(src, id, title, kind, thumb, page, license, author, fmt="", dl=True, note=""):
    return {"src": src, "id": str(id), "title": (title or "").strip()[:140], "kind": kind, "thumb": thumb or "", "page": page or "",
            "license": license or "", "attr": bool(license) and not _free(license), "author": (author or "")[:80], "fmt": fmt, "dl": dl, "note": note}


def token(data_dir=None):
    t = os.environ.get("SKETCHFAB_TOKEN", "").strip()
    if not t and data_dir:
        try:
            t = open(os.path.join(data_dir, TOKEN_FILE), encoding="utf-8").read().strip()
        except OSError:
            pass
    return t


# ---------------- search ----------------
def s_polypizza(q, kind, n):
    d = _json("https://poly.pizza/api/search/" + urllib.parse.quote(q))
    out = []
    for r in d.get("results") or []:
        prev = r.get("previewUrl") or ""
        if not prev:
            continue
        out.append(_row("polypizza", r.get("publicID"), r.get("title"), "3d", prev, "https://poly.pizza" + (r.get("url") or ""),
                        r.get("licence"), (r.get("creator") or {}).get("username"), "glb"))
    return out[:n]


_PH = {}


def _ph_list(t):
    c = _PH.get(t)
    if c and time.time() - c[0] < 6 * 3600:
        return c[1]
    d = _json("https://api.polyhaven.com/assets?t=" + t)
    _PH[t] = (time.time(), d)
    return d


def s_polyhaven(q, kind, n):
    qs = [w for w in _words(q) if len(w) > 1]
    out = []
    for aid, a in _ph_list("models" if kind == "3d" else "textures").items():
        hay = set(_words(" ".join([aid, a.get("name", "")] + a.get("tags", []) + a.get("categories", []))))
        score = sum(1 if w in hay else 0.6 if len(w) >= 4 and any(x.startswith(w[:4]) for x in hay) else 0 for w in qs)
        if qs and score >= max(1, len(qs) * 0.6):
            out.append((score, a.get("download_count", 0), aid, a))
    out.sort(key=lambda x: (-x[0], -x[1]))
    return [_row("polyhaven", aid, a.get("name"), kind, f"https://cdn.polyhaven.com/asset_img/thumbs/{aid}.png?width=320&height=320",
                 f"https://polyhaven.com/a/{aid}", "CC0", ", ".join(a.get("authors", {}).keys()), "gltf" if kind == "3d" else "jpg")
            for _, _, aid, a in out[:n]]


def s_sketchfab(q, kind, n, has_token=False):
    d = _json("https://api.sketchfab.com/v3/search?" + urllib.parse.urlencode({"type": "models", "q": q, "downloadable": "true", "count": n}))
    out = []
    for r in d.get("results") or []:
        ims = sorted((r.get("thumbnails") or {}).get("images") or [], key=lambda i: abs((i.get("width") or 0) - 400))
        out.append(_row("sketchfab", r.get("uid"), r.get("name"), "3d", ims[0]["url"] if ims else "", r.get("viewerUrl"),
                        (r.get("license") or {}).get("label"), (r.get("user") or {}).get("displayName"), "gltf", dl=has_token,
                        note="" if has_token else "скачать — с токеном Sketchfab (⚙ Настройки) или через Objaverse; как референс — можно"))
    return out[:n]


# ---- Quaternius и Kenney: их каталоги на Poly Pizza (CC0 / CC-BY; у Quaternius много персонажей со скелетом и анимациями)
_PP_USER = {}


def _pp_user(name):
    c = _PP_USER.get(name)
    if c and time.time() - c[0] < 6 * 3600:
        return c[1]
    d = _json("https://poly.pizza/api/user/" + name, timeout=60)
    _PP_USER[name] = (time.time(), d.get("models") or [])
    return _PP_USER[name][1]


def _s_pp_user(src, user, q, n):
    qs = [w for w in _words(q) if len(w) > 1]
    out = []
    for m in _pp_user(user):
        hay = set(_words(m.get("title", "") + " " + (m.get("alt") or "")))
        score = sum(1 if w in hay else 0.6 if len(w) >= 4 and any(x.startswith(w[:4]) for x in hay) else 0 for w in qs)
        if not qs or score >= max(1, len(qs) * 0.5):
            anim = bool(re.search(r"animated|rigged|character", m.get("title", ""), re.I))
            out.append((score, _row(src, m.get("publicID"), m.get("title"), "3d", m.get("previewUrl"), "https://poly.pizza" + (m.get("url") or ""),
                                    m.get("licence") or "CC0", user, "glb", note="может быть со скелетом и анимациями" if anim else "")))
    out.sort(key=lambda x: -x[0])
    return [r for _, r in out[:n]]


def s_quaternius(q, kind, n):
    return _s_pp_user("quaternius", "Quaternius", q, n)


def s_kenney(q, kind, n):
    return _s_pp_user("kenney", "Kenney", q, n)


# ---- Smithsonian 3D (CC0, сканы реальных предметов; glb сжаты Draco — models3d.normalize распакует)
def s_smithsonian(q, kind, n):
    d = _json("https://3d-api.si.edu/api/v1.0/content/file/search?" + urllib.parse.urlencode({"q": q, "file_type": "glb", "rows": n * 4}), timeout=40)
    pk = {}
    for r in d.get("rows") or []:
        c = r.get("content") or {}
        key = c.get("model_url") or c.get("uri")
        rank = {"Medium": 0, "Low": 1, "High": 2, "Thumb": 3}.get(c.get("quality"), 4)
        if key not in pk or rank < pk[key][0]:
            pk[key] = (rank, r.get("title"), c.get("uri"))
    out = []
    for key, (_, title, uri) in list(pk.items())[:n]:
        out.append(_row("smithsonian", uri, title, "3d", "", "https://3d.si.edu/search/collection?edan_q=" + urllib.parse.quote(title or q),
                        "CC0", "Smithsonian Institution", "glb", note="скан реального предмета (CC0); без превью — смотри после «⬇ в работу»"))
    return out


# ---- Objaverse: модели Sketchfab из датасета allenai/objaverse (Hugging Face) — качаются без токена
def _objaverse_paths(log=None):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, "objaverse-object-paths.json.gz")
    if not os.path.isfile(p):
        (log or (lambda s: None))("Objaverse: первый раз качаю карту моделей (20 МБ)…")
        data = _get("https://huggingface.co/datasets/allenai/objaverse/resolve/main/object-paths.json.gz", timeout=300, limit=60 * 2**20)[0]
        open(p, "wb").write(data)
    import gzip
    c = _PH.get("objaverse")
    if not c:
        c = (time.time(), json.loads(gzip.decompress(open(p, "rb").read())))
        _PH["objaverse"] = c
    return c[1]


def s_objaverse(q, kind, n):
    try:
        paths = _objaverse_paths()
    except Exception as e:
        raise ValueError("карта Objaverse не скачалась: " + str(e)[:100])
    d = _json("https://api.sketchfab.com/v3/search?" + urllib.parse.urlencode({"type": "models", "q": q, "count": 24}))
    out = []
    for r in d.get("results") or []:
        if r.get("uid") not in paths:
            continue
        ims = sorted((r.get("thumbnails") or {}).get("images") or [], key=lambda i: abs((i.get("width") or 0) - 400))
        out.append(_row("objaverse", r.get("uid"), r.get("name"), "3d", ims[0]["url"] if ims else "", r.get("viewerUrl"),
                        (r.get("license") or {}).get("label"), (r.get("user") or {}).get("displayName"), "glb", note="модель Sketchfab из Objaverse — без токена"))
        if len(out) >= n:
            break
    return out


OGA_TYPE = {"3d": 10, "2d": 9, "tex": 7273}


def s_oga(q, kind, n):
    url = "https://opengameart.org/art-search-advanced?" + urllib.parse.urlencode({"keys": q, "field_art_type_tid[]": OGA_TYPE[kind], "sort_by": "count", "sort_order": "DESC"})
    s = _get(url, limit=4 * 2**20)[0].decode("utf-8", "replace")
    out = []
    for blk in s.split('class="views-row')[1:]:
        m = re.search(r'<span class="art-preview-title"><a href="(/content/[^"]+)">(.*?)</a>', blk)
        img = re.search(r"<img [^>]*src=['\"]([^'\"]+)['\"]", blk)
        if m:
            out.append(_row("oga", m.group(1).rsplit("/", 1)[-1], html.unescape(m.group(2)), kind, img.group(1) if img else "",
                            "https://opengameart.org" + m.group(1), "", "", "", note="лицензия — на странице (CC0 / CC-BY / GPL…)"))
        if len(out) >= n:
            break
    return out


def s_openverse(q, kind, n):
    d = _json("https://api.openverse.org/v1/images/?" + urllib.parse.urlencode({"q": q, "page_size": n, "license_type": "commercial,modification"}))
    out = []
    for r in d.get("results") or []:
        lic = (r.get("license") or "").upper()
        lic = "CC0" if lic == "CC0" else "Public Domain" if lic == "PDM" else f"CC {lic} {r.get('license_version') or ''}".strip()
        out.append(_row("openverse", r.get("id"), r.get("title") or "(без названия)", "2d", r.get("thumbnail") or r.get("url"),
                        r.get("foreign_landing_url"), lic, r.get("creator"), (r.get("filetype") or "").lower(), note=r.get("provider") or ""))
        out[-1]["url"] = r.get("url") or ""
    return out


def s_commons(q, kind, n):
    qs = urllib.parse.urlencode({"action": "query", "generator": "search", "gsrsearch": q + " filetype:bitmap|drawing", "gsrnamespace": 6,
                                 "gsrlimit": n, "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 1600,
                                 "iiextmetadatafilter": "LicenseShortName|Artist", "format": "json"})
    d = _json("https://commons.wikimedia.org/w/api.php?" + qs)
    strip = lambda v: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", v or ""))).strip()
    out = []
    for p in sorted(((d.get("query") or {}).get("pages") or {}).values(), key=lambda p: p.get("index", 0)):
        ii = (p.get("imageinfo") or [{}])[0]
        md = ii.get("extmetadata") or {}
        t = ii.get("thumburl") or ii.get("url") or ""
        if not t:
            continue
        r = _row("commons", p.get("title", "").replace("File:", ""), p.get("title", "").replace("File:", ""), "2d",
                 re.sub(r"/\d+px-", "/320px-", t), ii.get("descriptionurl"), strip((md.get("LicenseShortName") or {}).get("value")),
                 strip((md.get("Artist") or {}).get("value")), os.path.splitext(ii.get("url") or "")[1].lstrip(".").lower())
        r["url"] = t
        out.append(r)
    return out


def s_ambientcg(q, kind, n):
    d = _json("https://ambientcg.com/api/v2/full_json?" + urllib.parse.urlencode({"q": q, "type": "Material", "limit": n, "include": "previewData,downloadData"}))
    out = []
    for a in d.get("foundAssets") or []:
        pv = a.get("previewImage") or {}
        out.append(_row("ambientcg", a.get("assetId"), a.get("displayName") or a.get("assetId"), "tex", pv.get("256-PNG") or pv.get("128-PNG"),
                        a.get("shortLink") or f"https://ambientcg.com/view?id={a.get('assetId')}", "CC0", "ambientCG", "jpg"))
    return out


SEARCH = {"polypizza": s_polypizza, "polyhaven": s_polyhaven, "sketchfab": s_sketchfab, "oga": s_oga, "openverse": s_openverse,
          "commons": s_commons, "ambientcg": s_ambientcg}


def search(q, kind="3d", n=12, srcs=None, data_dir=None):
    kind = kind if kind in BY_KIND else "3d"
    srcs = [s for s in (srcs or BY_KIND[kind]) if s in BY_KIND[kind]]
    has_token = bool(token(data_dir))
    per = {s: (n if s in ("polypizza", "openverse", "ambientcg") else max(4, n // 2)) for s in srcs}
    SEARCH.update(quaternius=s_quaternius, kenney=s_kenney, smithsonian=s_smithsonian, objaverse=s_objaverse)

    def one(s):
        return s_sketchfab(q, kind, per[s], has_token) if s == "sketchfab" else SEARCH[s](q, kind, per[s])
    out, errs = [], []
    with ThreadPoolExecutor(max_workers=len(srcs) or 1) as ex:
        futs = {s: ex.submit(one, s) for s in srcs}
        for s in srcs:
            try:
                out += futs[s].result(timeout=40)
            except Exception as e:
                errs.append(f"{NAMES.get(s, s)}: {str(e)[:120]}")
    return {"query": q, "kind": kind, "results": out, "errors": errs,
            "hint": "по-английски находится гораздо больше" if re.search(r"[а-яё]", q.lower()) else ""}


# ---------------- fetch ----------------
def _safe(name):
    name = re.sub(r'[\\/:*?"<>|\s]+', "_", os.path.basename(urllib.parse.unquote(name.split("?")[0]))).strip("._")
    return name[:80] or "file"


def _save(out_dir, rel, data):
    rel = os.path.normpath(rel).replace("\\", "/")
    if rel.startswith("..") or os.path.isabs(rel):
        raise ValueError("плохой путь в архиве: " + rel)
    p = os.path.join(out_dir, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    return p


def _unzip(data, out_dir):
    files = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for i in z.infolist():
            if i.is_dir() or i.file_size > MAX_BYTES or "__MACOSX" in i.filename:
                continue
            files.append(_save(out_dir, i.filename, z.read(i)))
    return files


def _pick(files, exts):
    for e in exts:
        c = [f for f in files if f.lower().endswith(e)]
        if c:
            return sorted(c, key=lambda f: (f.count(os.sep), len(f)))[0]
    return None


def to_png(data):
    """Any picture (webp, gif, jpg…) -> png bytes (Claude and the stands read png / jpg)."""
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def _oga_page(page):
    s = _get(page, limit=4 * 2**20)[0].decode("utf-8", "replace")
    i = s.find("field-name-field-art-licenses")
    lic = ", ".join(dict.fromkeys(re.findall(r"license-name['\"]>([^<]+)<", s[i:i + 3000]))) if i >= 0 else ""
    auth = re.search(r'field-name-author-submitter.*?<a [^>]*>([^<]+)</a>', s, re.S)
    files = list(dict.fromkeys(re.findall(r'href="(https://opengameart\.org/sites/default/files/[^"]+)"', s)))
    return html.unescape(lic), html.unescape(auth.group(1)) if auth else "", files


def fetch(src, aid, out_dir, row=None, data_dir=None, log=None):
    """Download an asset into out_dir. -> {main, files, license, author, title, page, fmt, kind}"""
    row, log = row or {}, log or (lambda s: None)
    os.makedirs(out_dir, exist_ok=True)
    res = {"src": src, "id": aid, "title": row.get("title", ""), "license": row.get("license", ""), "author": row.get("author", ""),
           "page": row.get("page", ""), "kind": row.get("kind", ""), "fmt": row.get("fmt", "")}
    files = []
    if src in ("quaternius", "kenney"):
        src = "polypizza"
    if src == "smithsonian":
        log("качаю модель Smithsonian…")
        files.append(_save(out_dir, _safe(res["title"] or "model")[:60] + ".glb", _get(aid, timeout=120)[0]))
        res.update(kind="3d", fmt="glb", license="CC0", author="Smithsonian Institution")
    elif src == "objaverse":
        paths = _objaverse_paths(log)
        if aid not in paths:
            raise ValueError("этой модели нет в Objaverse")
        log("качаю модель из Objaverse (Hugging Face)…")
        files.append(_save(out_dir, _safe(res["title"] or aid)[:60] + ".glb", _get("https://huggingface.co/datasets/allenai/objaverse/resolve/main/" + paths[aid], timeout=180)[0]))
        res.update(kind="3d", fmt="glb")
    elif src == "polypizza":
        glb = (row.get("thumb") or "").rsplit(".", 1)[0] + ".glb"
        if "static.poly.pizza" not in glb:
            raise ValueError("нет ссылки на модель Poly Pizza")
        log("качаю .glb с Poly Pizza…")
        files.append(_save(out_dir, _safe(res["title"] or aid) + ".glb", _get(glb)[0]))
        res.update(kind="3d", fmt="glb")
    elif src == "polyhaven":
        info = _json("https://api.polyhaven.com/files/" + aid)
        if (row.get("kind") or "3d") == "3d" and "gltf" in info:
            g = info["gltf"].get("1k") or next(iter(info["gltf"].values()))
            g = g["gltf"]
            log("качаю glTF и текстуры 1k с Poly Haven…")
            files.append(_save(out_dir, _safe(g["url"]), _get(g["url"])[0]))
            for rel, f in (g.get("include") or {}).items():
                files.append(_save(out_dir, rel, _get(f["url"])[0]))
            res.update(kind="3d", fmt="gltf")
        else:
            maps = {k: v for k, v in info.items() if k in ("Diffuse", "nor_gl", "Rough", "AO", "Displacement")}
            log("качаю текстуру 1k с Poly Haven…")
            for k, v in maps.items():
                f = (v.get("1k") or next(iter(v.values()))).get("jpg") or (v.get("1k") or {}).get("png")
                if f:
                    files.append(_save(out_dir, _safe(f["url"]), _get(f["url"])[0]))
            res.update(kind="tex", fmt="jpg")
        res.update(license="CC0")
    elif src == "sketchfab":
        tk = token(data_dir)
        if not tk:
            raise ValueError("для скачивания со Sketchfab нужен токен: положи его в ⚙ Настройки приложения (sketchfab.com → Settings → Password & API)")
        d = _json(f"https://api.sketchfab.com/v3/models/{aid}/download", headers={"Authorization": "Token " + tk})
        pick = d.get("glb") or d.get("gltf")
        if not pick:
            raise ValueError("Sketchfab не отдал glTF для этой модели")
        log("качаю модель со Sketchfab…")
        data = _get(pick["url"])[0]
        files += _unzip(data, out_dir) if data[:2] == b"PK" else [_save(out_dir, _safe(aid) + ".glb", data)]
        res.update(kind="3d", fmt="glb" if d.get("glb") else "gltf")
    elif src == "oga":
        lic, auth, links = _oga_page(res["page"] or f"https://opengameart.org/content/{aid}")
        res.update(license=lic or res["license"], author=auth or res["author"])
        if not links:
            raise ValueError("на странице OpenGameArt нет файлов")
        total = 0
        for u in links[:8]:
            log("качаю " + _safe(u) + "…")
            data = _get(u)[0]
            total += len(data)
            if total > MAX_BYTES:
                break
            files += _unzip(data, out_dir) if u.lower().endswith(".zip") and data[:2] == b"PK" else [_save(out_dir, _safe(u), data)]
    elif src in ("openverse", "commons"):
        url = row.get("url") or row.get("thumb")
        log("качаю картинку…")
        try:
            data, ct, _ = _get(url, limit=40 * 2**20)
        except Exception:
            data, ct, _ = _get(row.get("thumb"), limit=40 * 2**20)      # Flickr and co sometimes refuse the original: the preview is still a picture
        ext = ".jpg" if data[:3] == b"\xff\xd8\xff" else ".png"
        if ext == ".png" and data[:8] != b"\x89PNG\r\n\x1a\n":
            data = to_png(data)
        files.append(_save(out_dir, _safe(os.path.splitext(res["title"] or aid)[0])[:60] + ext, data))
        res.update(kind="2d")
    elif src == "ambientcg":
        log("качаю текстуру 1K с ambientCG…")
        files += _unzip(_get(f"https://ambientcg.com/get?file={urllib.parse.quote(aid)}_1K-JPG.zip")[0], out_dir)
        res.update(kind="tex", fmt="jpg", license="CC0")
    else:
        raise ValueError("неизвестный источник: " + src)
    if not files:
        raise ValueError("ничего не скачалось")
    k = res.get("kind") or row.get("kind")
    main = (_pick(files, (".glb", ".gltf")) if k == "3d" else None) \
        or (_pick([f for f in files if re.search(r"(color|diff|albedo|basecolor)", os.path.basename(f), re.I)], (".jpg", ".png")) if k == "tex" else None) \
        or _pick(files, (".glb", ".gltf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")) or files[0]
    ext = os.path.splitext(main)[1].lower().lstrip(".")
    res.update(main=main, files=files, fmt=ext or res.get("fmt", ""), kind=k or ("3d" if ext in ("glb", "gltf") else "2d"),
               size=sum(os.path.getsize(f) for f in files))
    if res["kind"] == "3d" and ext not in ("glb", "gltf"):
        res["note"] = "модель не в glTF (" + ", ".join(sorted({os.path.splitext(f)[1].lower() for f in files})) + ") — в сцену напрямую не встанет, только как референс или через Blender"
    return res


def preview(url):
    """A result's picture as png bytes — for «📌 в референсы»."""
    data = _get(url, limit=20 * 2**20)[0]
    return data if data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff" else to_png(data)


def _opt(a, k, d=None):
    return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    if a and a[0] == "search" and len(a) > 1:
        qs = []                                         # several queries at once: search "a" "b" "c" --kind 3d
        for x in a[1:]:
            if x.startswith("--"):
                break
            qs.append(x)
        k, n = _opt(a, "--kind", "3d"), int(_opt(a, "--n", "12"))
        out = [search(q, k, n) for q in qs]
        for r in out:                                   # Claude reads this: drop what it does not need to choose
            for x in r["results"]:
                x.pop("thumb", None)
        print(json.dumps(out[0] if len(out) == 1 else out, ensure_ascii=False, separators=(",", ":")))
    elif a and a[0] == "fetch" and len(a) > 3:
        r = fetch(a[1], a[2], a[3], json.loads(_opt(a, "--row", "{}")), log=print)
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print(__doc__)
