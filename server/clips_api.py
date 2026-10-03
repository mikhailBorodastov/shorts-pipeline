"""S13.4: клипы сцен — таймлайн видео на локациях играет отрендеренные клипы (полное качество), правка перерендеривает только изменённое.

Ролик делится на сегменты по юнитам монтажа (кадр начала юнита — граница). Ключ сегмента = sha1(юнит + собранная сцена и prefabs.js + движок +
глобальное монтажа: надписи, субтитры, слова голоса на отрезке, формат; у первого сегмента юнита с переходом — ещё сцена предыдущего).
Клип — build/clips/<ключ>.mp4 (H.264 из браузера: render.js RENDER_RANGE + RENDER_OUT, как рендер ролика), склейка — build/clips/playback.mp4 (без звука:
звук в окне ведёт Web Audio), экспорт — склейка + build/mix.wav. Состояние — build/clips/index.json.
"""
import glob
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time

import paths as P

CF = getattr(subprocess, "CREATE_NO_WINDOW", 0)
FPS = 30


def cdir(pd):
    return os.path.join(pd, "build", "clips")


def _h(*parts):
    s = hashlib.sha1()
    for p in parts:
        s.update(p if isinstance(p, bytes) else json.dumps(p, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return s.hexdigest()[:16]


def _file(p):
    try:
        return open(p, "rb").read()
    except OSError:
        return b""


def _engine_sig(A):
    fs = [os.path.join(P.ENGINE, f) for f in ("scene.js", "stage3d.js", "lib.js", "props3d.js", "rig.js", "moves3d.js")] + [os.path.join(P.TPL_SRC, "main.js")]
    return [round(os.path.getmtime(f)) for f in fs if os.path.isfile(f)]


def fps_of(plan):
    return int((plan.get("montage") or {}).get("fps") or FPS)


def segments(A, vid):
    """[{i, a, b, t0, t1, unit, scene, key, fresh}] — по текущему монтажу и собранным сценам (без генерации проекта)."""
    pd = P.video(vid)
    plan = A.load("plan:" + vid)
    M = plan.get("montage") or {}
    fps = fps_of(plan)
    units = sorted(M.get("units") or [], key=lambda u: float(u.get("at") or 0))
    if not units or not pd:
        return [], fps
    vo = A.mnapi().voice(vid) or {}
    words = vo.get("words") or [] if (M.get("voice") or {}).get("on") else []
    total = max(float(M.get("len") or 0), max(float(u.get("at") or 0) + float(u.get("len") or 0) for u in units), float(vo.get("total") or 0) if words else 0)
    N = math.ceil(total * fps)
    glob_sig = _h(M.get("overlays") or [], (M.get("captions") or {}).get("on", True), plan.get("mode"), fps, _engine_sig(A))
    starts = []
    for u in units:
        a = max(0, min(N, round(float(u.get("at") or 0) * fps)))
        if not starts or a > starts[-1][0]:
            starts.append((a, u))
    bounds = ([(0, None)] if starts[0][0] > 0 else []) + starts
    sc_sig = {}

    def scene_sig(sid):
        if sid not in sc_sig:
            try:
                wd = A.scapi().work_dir(A, vid, sid)
                sc_sig[sid] = _h(_file(os.path.join(wd, "scene.json")), _file(os.path.join(wd, "prefabs.js")))
            except ValueError:
                sc_sig[sid] = "?"
        return sc_sig[sid]
    out, done = [], _index(pd).get("clips", {})
    for i, (a, u) in enumerate(bounds):
        b = bounds[i + 1][0] if i + 1 < len(bounds) else N
        if b <= a:
            continue
        t0, t1 = a / fps, b / fps
        w = [x["w"] + "@" + str(x["t"]) for x in words if t0 - 0.5 <= x["t"] < t1 + 0.5]
        prev = None
        if u and (u.get("trans") or {}).get("type", "cut") != "cut":
            k = units.index(u)
            prev = scene_sig(units[k - 1]["scene"]) if k > 0 else None
        key = _h(glob_sig, u or "gap", scene_sig(u["scene"]) if u else "", prev, w, a, b)
        out.append({"i": len(out), "a": a, "b": b, "t0": round(t0, 3), "t1": round(t1, 3), "unit": (u or {}).get("id"), "scene": (u or {}).get("scene"),
                    "key": key, "fresh": os.path.isfile(os.path.join(cdir(pd), key + ".mp4")) and key in done})
    return out, fps


def _index(pd):
    try:
        return json.load(open(os.path.join(cdir(pd), "index.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_index(pd, ix):
    os.makedirs(cdir(pd), exist_ok=True)
    json.dump(ix, open(os.path.join(cdir(pd), "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def state(A, vid):
    pd = P.video(vid)
    segs, fps = segments(A, vid)
    ix = _index(pd) if pd else {}
    pb = os.path.join(cdir(pd), "playback.mp4") if pd else ""
    fresh_pb = bool(segs) and all(s["fresh"] for s in segs) and ix.get("playback") == [s["key"] for s in segs] and os.path.isfile(pb)
    job = next((j.info() for j in A.JOBS.values() if j.kind == "clips" and j.key == "plan:" + vid and j.status in ("running", "queued")), None)
    return {"segments": segs, "fps": fps, "stale": [s["unit"] for s in segs if not s["fresh"]], "playback": fresh_pb or os.path.isfile(pb),
            "playbackFresh": fresh_pb, "stamp": ix.get("stamp", 0), "job": job}


def _bash_env(A, pd):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    env["REVIEW_PORT"] = str(A.stapi().project_port(pd))
    return env


def render(A, job, export=False):
    """Задача clips: файлы проекта -> недостающие клипы -> playback.mp4 (+ звук, если export). Прогресс — job.summary и index.json."""
    vid = job.key[5:]
    pd = P.video(vid)
    mn = A.mnapi()
    job.summary = "файлы проекта…"
    mn.generate(A, vid)
    segs, fps = segments(A, vid)
    if not segs:
        raise ValueError("в монтаже нет сцен")
    ix = _index(pd)
    ix.setdefault("clips", {})
    os.makedirs(cdir(pd), exist_ok=True)
    env = _bash_env(A, pd)
    todo = [s for s in segs if not s["fresh"]]
    if todo:                                                  # все устаревшие клипы — ОДНИМ запуском браузеров (RENDER_SEGS): без 20–30 с старта на каждый
        frames = sum(s["b"] - s["a"] for s in todo)
        job.summary = f"рендер клипов: {len(todo)} из {len(segs)} · кадры 0 из {frames}"
        job.meta = {"done": 0, "total": frames}
        tmp = {s["key"]: os.path.join(cdir(pd), "_tmp_" + s["key"]) for s in todo}
        sf = os.path.join(cdir(pd), "_segs.json")
        json.dump([{"a": s["a"], "b": s["b"], "out": tmp[s["key"]]} for s in todo], open(sf, "w", encoding="utf-8"))
        e = dict(env, RENDER_SEGS=sf)
        proc = subprocess.Popen(["node", "render.js", "frames", str(fps), "4"], cwd=pd, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", creationflags=CF)
        job.proc = proc
        log = []
        for line in proc.stdout:
            log.append(line.rstrip())
            m = re.match(r"(\d+)/(\d+)\s", line)
            if m:
                job.meta = {"done": int(m.group(1)), "total": int(m.group(2))}
                job.summary = f"рендер клипов: {len(todo)} из {len(segs)} · кадры {m.group(1)} из {m.group(2)}"
            if job.cancelled:
                proc.kill()
        proc.wait()
        if job.cancelled:
            raise RuntimeError("отменено")
        if proc.returncode != 0:
            raise RuntimeError("рендер клипов: " + " | ".join(log[-12:]))
        for s in todo:
            src = os.path.join(tmp[s["key"]], "video.h264")
            if not os.path.isfile(src):
                raise RuntimeError("рендер клипа: нет " + src)
            dst = os.path.join(cdir(pd), s["key"] + ".mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-f", "h264", "-i", src, "-c:v", "copy", dst], check=True, creationflags=CF)
            shutil.rmtree(tmp[s["key"]], ignore_errors=True)
            ix["clips"][s["key"]] = {"unit": s["unit"], "scene": s["scene"], "a": s["a"], "b": s["b"], "at": int(time.time())}
        _save_index(pd, ix)
    job.summary = "склейка…"
    lst = os.path.join(cdir(pd), "list.txt")
    open(lst, "w", encoding="utf-8").write("".join(f"file '{s['key']}.mp4'\n" for s in segs))
    pb = os.path.join(cdir(pd), "playback.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", pb], check=True, cwd=cdir(pd), creationflags=CF)
    keep = {s["key"] for s in segs}
    for f in glob.glob(os.path.join(cdir(pd), "*.mp4")):                      # старые клипы — прочь (не держим гигабайты)
        k = os.path.splitext(os.path.basename(f))[0]
        if k not in keep and k != "playback" and time.time() - os.path.getmtime(f) > 600:
            os.remove(f); ix["clips"].pop(k, None)
    ix.update(playback=[s["key"] for s in segs], stamp=int(time.time() * 1000), fps=fps)
    _save_index(pd, ix)
    job.summary = f"клипы готовы: перерендерено {len(todo)} из {len(segs)}"
    if export:
        return export_av(A, vid, pb)
    return pb


def export_av(A, vid, pb):
    """Экспорт: склейка клипов + звук (render.js sfx -> audio.py -> build/mix.wav) -> out/<папка>.mp4 и _NO_VO. Без рендера кадров."""
    pd = P.video(vid)
    env = _bash_env(A, pd)
    subprocess.run(["node", "render.js", "sfx"], cwd=pd, env=env, check=True, capture_output=True, creationflags=CF)
    subprocess.run(["python", "audio.py"], cwd=pd, env=env, check=True, capture_output=True, creationflags=CF)
    os.makedirs(os.path.join(pd, "out"), exist_ok=True)
    name = os.path.basename(pd).replace(" ", "_")
    out = os.path.join(pd, "out", name + ".mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", pb, "-i", os.path.join(pd, "build", "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart", out], check=True, creationflags=CF)
    nv = os.path.join(pd, "build", "mix_no_vo.wav")
    if os.path.isfile(nv):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", out, "-i", nv, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                        out[:-4] + "_NO_VO.mp4"], check=True, creationflags=CF)
    return out


def handle_get(A, h, p, q):
    vid = (q.get("video") or [""])[0]
    if p == "/api/clips/state":
        h._json(state(A, vid)); return True
    if p == "/api/clips/playback":
        f = os.path.join(cdir(P.video(vid) or ""), "playback.mp4")
        if not os.path.isfile(f):
            h._json({"error": "клипов ещё нет"}, 404); return True
        A._send_file(h, f); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/clips/render":
        vid = body.get("video", "")
        try:
            j = A.start_job("clips", "plan:" + vid, "clips", {})
            h._json({"job": j.info()})
        except RuntimeError as e:
            h._json({"ok": False, "error": str(e)})
        return True
    return False
