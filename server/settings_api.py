"""⚙ Настройки приложения (S9+): токены и ключи сервисов, путь к Blender, модели Claude. Хранятся в .studio (вне git каналов и студии).

- секреты — .studio/secrets.json { sketchfab, meshy, tripo } (Sketchfab ещё и в .studio/sketchfab_token.txt — его читает assets.py); страница видит их только замаскированными;
- путь к Blender — state.json → blender (paths.blender); модели — state.json → models { text, visual, effort } (переменные окружения IDEAS_* важнее).
"""
import json, os

import paths as P  # noqa: E402

SECRETS = {"sketchfab": "Sketchfab — скачивание моделей (sketchfab.com → Settings → Password & API → API token)",
           "meshy": "Meshy — «картинка → 3D» и авто-скелет (meshy.ai → API → API Key; бесплатные кредиты каждый месяц)",
           "tripo": "Tripo — «картинка → 3D» и авто-скелет (platform.tripo3d.ai → API Keys; бесплатные кредиты)"}


def _sp():
    return os.path.join(P.STATE, "secrets.json")


def secrets():
    try:
        d = json.load(open(_sp(), encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    if not d.get("sketchfab"):
        try:
            d["sketchfab"] = open(os.path.join(P.STATE, "sketchfab_token.txt"), encoding="utf-8").read().strip()
        except OSError:
            pass
    return d


def secret(name):
    return (secrets().get(name) or os.environ.get(name.upper() + "_API_KEY") or "").strip()


def mask(v):
    return "" if not v else (v[:4] + "…" + v[-3:] if len(v) > 10 else "•••")


def get(A):
    s = secrets()
    m = P.state_get("models") or {}
    return {"secrets": {k: {"set": bool(s.get(k)), "mask": mask(s.get(k, "")), "label": lbl} for k, lbl in SECRETS.items()},
            "blender": {"path": P.state_get("blender") or "", "found": P.blender() or ""},
            "models": {"text": m.get("text") or A.TEXT_MODEL, "visual": m.get("visual") or A.VISUAL_MODEL, "effort": m.get("effort") or A.VISUAL_EFFORT or "",
                       "env": {k: bool(os.environ.get(k)) for k in ("IDEAS_TEXT_MODEL", "IDEAS_VISUAL_MODEL", "IDEAS_VISUAL_EFFORT")}}}


def apply_models(A):
    """Модели из настроек -> ideas_api (если их не задали переменные окружения)."""
    m = P.state_get("models") or {}
    if m.get("text") and not os.environ.get("IDEAS_TEXT_MODEL"):
        A.TEXT_MODEL = m["text"]
    if m.get("visual") and not os.environ.get("IDEAS_VISUAL_MODEL"):
        A.VISUAL_MODEL = m["visual"]
    if "effort" in m and not os.environ.get("IDEAS_VISUAL_EFFORT"):
        A.VISUAL_EFFORT = m.get("effort") or ""


def save(A, body):
    if "secrets" in body:
        s = secrets()
        for k, v in (body["secrets"] or {}).items():
            if k in SECRETS and v is not None:
                v = str(v).strip()
                if v:
                    s[k] = v
                else:
                    s.pop(k, None)
        os.makedirs(P.STATE, exist_ok=True)
        json.dump(s, open(_sp(), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        tf = os.path.join(P.STATE, "sketchfab_token.txt")
        if s.get("sketchfab"):
            open(tf, "w", encoding="utf-8").write(s["sketchfab"])
        elif os.path.isfile(tf):
            os.remove(tf)
    if "blender" in body:
        p = (body.get("blender") or "").strip().strip('"')
        if p and not os.path.isfile(p):
            raise ValueError("нет такого файла: " + p)
        P.state_set("blender", p or None)
    if "models" in body:
        m = dict(P.state_get("models") or {}, **{k: (v or "").strip() for k, v in (body["models"] or {}).items() if k in ("text", "visual", "effort")})
        P.state_set("models", m)
        apply_models(A)
    return get(A)


def local3d():
    """🖥 Локальная 3D (TRELLIS.2 / Pixal3D в ComfyUI Studio, server/comfy3d.py): поставлено ли, запущено ли, видеокарта."""
    import comfy3d as C, subprocess
    st = dict(C.installed(), alive=C.alive())
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip().splitlines()
        st["gpu"] = out[0] if out else ""
    except Exception:
        st["gpu"] = ""
    return st


def handle_get(A, h, p, q):
    if p == "/api/settings":
        h._json(get(A)); return True
    if p == "/api/local3d":
        h._json(local3d()); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/settings":
        h._json(save(A, body)); return True
    if p == "/api/local3d/stop":                       # освободить видеопамять: ComfyUI Studio поднимется сам при следующей лепке
        import comfy3d as C
        C.stop(); h._json(local3d()); return True
    return False
