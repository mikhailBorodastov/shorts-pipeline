"""S22: один «замок» видеокарты на всё приложение — тот же файл и формат, что stands/gpulock.js (рендер кадров и клипов).
STATE/gpu.lock = {pid, what, since}: занят живым процессом — ждём; процесс умер — замок ничей. Берут: TRELLIS / FLUX в ComfyUI.

    with gpulock.hold("TRELLIS «кот»", log):
        ...
"""
import contextlib
import json
import os
import time

import paths as P

STALE = 6 * 3600


def lock_file():
    return os.path.join(P.STATE, "gpu.lock")


def alive(pid):
    if os.name == "nt":                                      # os.kill(pid, 0) на Windows УБИВАЕТ процесс — только OpenProcess
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))           # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return k.GetLastError() == 5                     # нет доступа — процесс есть
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return code.value == 259                             # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def holder():
    """-> {pid, what, since} живого владельца или None (ничей / битый замок убирается)."""
    f = lock_file()
    try:
        st = os.stat(f)
    except OSError:
        return None
    try:
        cur = json.load(open(f, encoding="utf-8"))
    except (OSError, ValueError):
        if time.time() - st.st_mtime < 3:
            return {"pid": 0, "what": "…", "since": st.st_mtime * 1000}
        cur = None
    if cur and cur.get("pid") and alive(cur["pid"]) and time.time() - (cur.get("since") or 0) / 1000 < STALE:
        return cur
    try:
        os.remove(f)
    except OSError:
        pass
    return None


@contextlib.contextmanager
def hold(what, log=lambda s: None, cancelled=lambda: False):
    if os.environ.get("STUDIO_GPU_LOCK") == "0":
        yield
        return
    f = lock_file()
    os.makedirs(os.path.dirname(f), exist_ok=True)
    said = 0
    mine = False
    while not mine:
        try:
            fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"pid": os.getpid(), "what": what, "since": int(time.time() * 1000)}, ensure_ascii=False))
            mine = True
            break
        except FileExistsError:
            pass
        cur = holder()
        if not cur:
            continue
        if cancelled():                                      # (другой поток этого же сервера с замком — ждём, как чужого)
            raise RuntimeError("отменено, пока ждали видеокарту")
        if time.time() - said > 30:
            log(f"жду видеокарту: {cur.get('what')}")
            said = time.time()
        time.sleep(1)
    try:
        yield
    finally:
        try:
            cur = json.load(open(f, encoding="utf-8"))
            if cur.get("pid") == os.getpid() and cur.get("what") == what:
                os.remove(f)
        except (OSError, ValueError):
            pass
