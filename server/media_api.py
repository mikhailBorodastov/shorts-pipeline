"""Медиа библиотеки канала (S10.3): видео кадрами для живых экранов пропсов (монитор, телевизор, телефон).

library/media/<slug>/media.json      — карточка (как у пропсов: versions[], latest)
library/media/<slug>/vN/media.json   — { fps, n, w, h, dur, ext, src, from, to, title }
library/media/<slug>/vN/f0001.jpg …  — кадры (высота 480, своя пропорция; экран сам кадрирует «по размеру»)
library/media/<slug>/vN/license.json — откуда кадры и чьи права (чужие кадры — права у владельца, в «Права» упаковки)
В сцене: keys['ch.screen'] = [{ t, v: { media: 'lib:media/<slug>@N', from, speed, loop } }] (engine/scene.js sceneMediaFrame).

CLI: media add "<ссылка | файл>" --name "Имя" [--from 12] [--to 40] [--fps 15] [--h 480] [--owner "Rockstar Games"] [--channel ID]
     media list [--channel ID]
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, time

import paths as P  # noqa: E402

CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _sa(A):
    return A.stapi()


def _ts(x):
    """'1:23.5' | '83.5' | 83.5 -> секунды."""
    if x in (None, ""):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = 0.0
    for part in str(x).strip().split(":"):
        s = s * 60 + float(part.replace(",", "."))
    return s


def fetch(src, t0=None, t1=None, log=print):
    """Ссылка (YouTube и всё, что умеет yt-dlp) -> временный mp4 (только кусок с/по); локальный файл — как есть."""
    if os.path.isfile(src):
        return src, False
    if not re.match(r"^https?://", src or ""):
        raise ValueError("нужна ссылка или путь к файлу")
    td = tempfile.mkdtemp(prefix="media_")
    out = os.path.join(td, "src.%(ext)s")
    cmd = [sys.executable, "-m", "yt_dlp", "-f", "bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b", "--no-playlist", "--no-part", "-o", out]
    if t0 is not None or t1 is not None:
        cmd += ["--download-sections", f"*{t0 or 0}-{t1 if t1 is not None else 'inf'}", "--force-keyframes-at-cuts"]
    log("yt-dlp: " + src)
    r = subprocess.run(cmd + [src], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=CF)
    files = [f for f in glob.glob(os.path.join(td, "src.*")) if not f.endswith(".part")]
    if r.returncode != 0 or not files:
        raise RuntimeError("yt-dlp не скачал: " + (r.stderr or r.stdout)[-600:])
    return files[0], True


def probe_title(src):
    if os.path.isfile(src):
        return os.path.splitext(os.path.basename(src))[0]
    try:
        r = subprocess.run([sys.executable, "-m", "yt_dlp", "--print", "%(title)s|%(channel)s", "--no-playlist", src], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60, creationflags=CF)
        t, _, ch = (r.stdout.strip().splitlines() or [""])[-1].partition("|")
        return t, ch
    except Exception:
        return "", ""


def add(A, src, name="", t0=None, t1=None, fps=15, h=480, owner="", channel=None, log=print):
    SA = _sa(A)
    c = SA.channel_dir(channel)
    t0, t1 = _ts(t0), _ts(t1)
    title, uploader = ("", "")
    if not os.path.isfile(src):
        title, uploader = probe_title(src)
    name = name or title or "видео"
    path, tmp = fetch(src, t0, t1, log)
    cut = not tmp                                       # yt-dlp уже скачал только кусок; локальный файл режем ffmpeg-ом
    items = SA.lib_index(c)
    base = SA.slug(name)
    lid = f"media/{base}"
    ldir = os.path.join(SA.lib_dir(c), "media", base)
    card_p = os.path.join(ldir, "media.json")
    try:
        card = json.load(open(card_p, encoding="utf-8"))
    except (OSError, ValueError):
        card = {"schema": 1, "id": lid, "kind": "media", "name": name, "desc": "", "tags": [], "versions": [], "latest": 0}
    v = max([x["v"] for x in card["versions"]] + [0]) + 1
    vd = os.path.join(ldir, f"v{v}")
    os.makedirs(vd, exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if cut and t0:
        cmd += ["-ss", str(t0)]
    if cut and t1 is not None:
        cmd += ["-to", str(t1)] if not t0 else ["-t", str(t1 - (t0 or 0))]
    cmd += ["-i", path, "-vf", f"fps={fps},scale=-2:{int(h)}", "-q:v", "4", os.path.join(vd, "f%04d.jpg")]
    log("ffmpeg: кадры " + str(fps) + " к/с")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, creationflags=CF)
    frames = sorted(glob.glob(os.path.join(vd, "f*.jpg")))
    if r.returncode != 0 or not frames:
        shutil.rmtree(vd, ignore_errors=True)
        raise RuntimeError("ffmpeg: " + (r.stderr or "")[-400:])
    from PIL import Image
    w0, h0 = Image.open(frames[0]).size
    meta = {"fps": fps, "n": len(frames), "w": w0, "h": h0, "dur": round(len(frames) / fps, 3), "ext": "jpg", "title": title or name,
            "src": src if not os.path.isfile(src) else os.path.basename(src), "from": t0, "to": t1}
    A.write_text(os.path.join(vd, "media.json"), json.dumps(meta, ensure_ascii=False, indent=1))
    lic = [{"title": title or name, "author": owner or uploader or "", "license": "чужие кадры — права у владельца" if owner or not os.path.isfile(src) else "своё / уточнить",
            "page": src if not os.path.isfile(src) else "", "note": f"кусок {t0 or 0}–{t1 if t1 is not None else 'конец'} с"}]
    A.write_text(os.path.join(vd, "license.json"), json.dumps(lic, ensure_ascii=False, indent=1))
    # превью: 4 кадра листом
    k = len(frames)
    pick = [frames[min(k - 1, int(k * f))] for f in (0.05, 0.35, 0.65, 0.92)]
    tw, th = 480, int(480 * h0 / w0)
    sheet = Image.new("RGB", (tw * 2, th * 2), "#111")
    for i, f in enumerate(pick):
        sheet.paste(Image.open(f).convert("RGB").resize((tw, th)), ((i % 2) * tw, (i // 2) * th))
    sheet.save(os.path.join(vd, "preview.png"))
    A.write_text(os.path.join(vd, "README.md"), f"# {name} — v{v}\n\nВидео кадрами для экранов: {meta['n']} кадров, {fps} к/с, {meta['dur']} с, {w0}×{h0}.\n"
                 f"Источник: {meta['src']}{' (' + str(t0) + '–' + str(t1) + ' с)' if t0 is not None or t1 is not None else ''}.\n"
                 f"В сцене: keys['ch.screen'] = [{{ t, v: {{ media: 'lib:{lid}@{v}', from: 0, loop: true }} }}]\n")
    ver = {"v": v, "ts": int(time.time() * 1000), "files": ["media.json", "preview.png", "license.json"], "preview": f"v{v}/preview.png", "dim": "media",
           "n": meta["n"], "dur": meta["dur"], "src": meta["src"]}
    card["versions"].append(ver)
    card["latest"] = v
    A.write_text(card_p, json.dumps(card, ensure_ascii=False, indent=1))
    row = {"id": lid, "kind": "media", "name": card["name"], "desc": card.get("desc", ""), "tags": card.get("tags", []), "latest": v, "dim": "media",
           "preview": f"{lid}/v{v}/preview.png", "from": {"src": meta["src"]}, "updated": int(time.time() * 1000)}
    items = [i for i in items if i["id"] != lid] + [row]
    SA.lib_save_index(A, c, sorted(items, key=lambda i: (i["kind"], i["name"].lower())))
    if tmp:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)
    return {"ref": f"lib:{lid}@{v}", "n": meta["n"], "dur": meta["dur"], "size": [w0, h0], "dir": vd}


def choices(A, channel=None):
    """Медиа канала для экранов: [{ref, name, dur, img}] (последние версии)."""
    SA = _sa(A)
    try:
        c = SA.channel_dir(channel)
    except Exception:
        return []
    out = []
    for it in SA.lib_index(c):
        if it.get("kind") != "media":
            continue
        try:
            card = json.load(open(os.path.join(SA.lib_dir(c), *it["id"].split("/"), "media.json"), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        v = card["versions"][-1]
        out.append({"ref": f"lib:{it['id']}@{v['v']}", "name": it.get("name", ""), "dur": v.get("dur"),
                    "img": f"/api/lib/file/{c['id']}/{it['id']}/{v['preview']}" if v.get("preview") else ""})
    return out


def run_job(A, job):
    p = job.params
    r = add(A, p.get("src", ""), p.get("name", ""), p.get("from"), p.get("to"), int(p.get("fps") or 15), int(p.get("h") or 480), p.get("owner", ""),
            p.get("channel"), log=lambda m: setattr(job, "summary", m))
    job.result = r
    job.summary = f"🎞 {r['ref']}: {r['n']} кадров, {r['dur']} с"


def cli(A, argv):
    if not argv or argv[0] not in ("add", "list"):
        print(__doc__); return True
    if argv[0] == "list":
        print(json.dumps(choices(A, A._opt(argv, "--channel")), ensure_ascii=False, indent=1)); return True
    a = argv[1:]
    r = add(A, a[0], A._opt(a, "--name", ""), A._opt(a, "--from"), A._opt(a, "--to"), int(A._opt(a, "--fps", 15)), int(A._opt(a, "--h", 480)),
            A._opt(a, "--owner", ""), A._opt(a, "--channel"))
    print(json.dumps(r, ensure_ascii=False, indent=1))
    return True
