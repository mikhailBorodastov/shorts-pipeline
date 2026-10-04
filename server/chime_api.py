"""Звук «готово» силами Windows (а не страницы): сервер Studio сам играет короткий WAV, когда закончилась задача —
окно может быть свёрнуто, закрыто или ещё не «разрешило» звук (WebView2 / браузер глушат звук без жеста).

Ассет препродакшена (element, make3d, …) — тихий «динь»; монтаж (fastmontage, automontage, montagebuild, монтаж агентом)
или последний ассет из очереди видео — светлое трезвучие. WAV синтезируются один раз в .studio/chime_*.wav (stdlib wave),
играются winsound.PlaySound(…, SND_ASYNC) — без окон и PowerShell. Выключается в ⚙ Настройках (state chime = "0").

POST /api/chime <- {kind: small|big}   послушать
"""
import math
import os
import struct
import threading
import time
import wave

import paths as P

ASSET = ("element", "make3d", "charparts", "charmodel", "trellisfix", "split3d", "vary3d", "sound", "sndfetch", "assetfetch",
         "layout3d", "brollfetch", "render", "libfix")
BIG = ("fastmontage", "automontage", "montagebuild")
_last = [0.0]
_lock = threading.Lock()


def on():
    return P.state_get("chime") != "0"


def _wav(kind):
    """Мягкий колокольчик: синус + тихий обертон, быстрая атака, экспоненциальное затухание."""
    f = os.path.join(P.STATE, f"chime_{kind}.wav")
    if os.path.isfile(f):
        return f
    sr, dur = 44100, (1.5 if kind == "big" else 1.0)
    notes = [(784, 0.0), (1047, 0.11), (1319, 0.22)] if kind == "big" else [(1047, 0.0), (1568, 0.09)]
    n = int(sr * dur)
    buf = [0.0] * n
    tail = 1.3 if kind == "big" else 0.9
    for fr, dt in notes:
        s0 = int(dt * sr)
        for i in range(s0, n):
            t = (i - s0) / sr
            env = min(1.0, t / 0.012) * math.exp(-t * 6.9 / tail)
            buf[i] += env * (0.9 * math.sin(2 * math.pi * fr * t) + 0.12 * math.sin(2 * math.pi * fr * 2 * t))
    peak = max(abs(x) for x in buf) or 1
    os.makedirs(P.STATE, exist_ok=True)
    with wave.open(f, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(x / peak * 0.5 * 32767)) for x in buf))
    return f


def play(kind="small", force=False):
    if not force and not on():
        return False
    with _lock:
        if time.time() - _last[0] < 1.2 and not force:
            return False
        _last[0] = time.time()
    try:
        import winsound
        winsound.PlaySound(_wav("big" if kind == "big" else "small"), winsound.SND_FILENAME | winsound.SND_ASYNC)
        return True
    except Exception as e:                                    # не Windows / нет звука — молча
        print("! chime:", e)
        return False


def on_job_done(A, job):
    """Задача кончилась успешно: ассет — «динь» (последний в очереди видео — трезвучие), монтаж — трезвучие."""
    if job.kind in BIG:
        return play("big")
    if job.kind not in ASSET:
        return False
    busy = any(j is not job and j.key == job.key and j.status in ("running", "queued") and j.kind in ASSET for j in A.JOBS.values())
    return play("small" if busy else "big")


def handle_post(A, h, p, body):
    if p == "/api/chime":
        h._json({"ok": play(body.get("kind") or "small", force=True)}); return True
    return False
