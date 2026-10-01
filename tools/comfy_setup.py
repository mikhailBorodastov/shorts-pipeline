"""ComfyUI для Studio: портативная сборка + модели TRELLIS.2 / Pixal3D (image → 3D).
  python tools/comfy_setup.py            — скачать недостающее (докачка с места обрыва) и распаковать
  python tools/comfy_setup.py --check    — что уже есть
Ставится в _studio/tools/comfyui (в git не лежит). Свой ComfyUI автора не трогаем: у Studio отдельный, на своём порту.
Модели — Hugging Face Comfy-Org (MIT), состав — как в шаблоне «Pixal3D & TRELLIS.2: Image to Model» (workflow_templates)."""
import os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "comfyui")
ZIP = os.path.join(DIR, "ComfyUI_windows_portable_nvidia.7z")
PORTABLE = "https://github.com/comfyanonymous/ComfyUI/releases/download/v0.38.0/ComfyUI_windows_portable_nvidia.7z"
HF = "https://huggingface.co/Comfy-Org"
MODELS = [   # (папка models/, файл, url)
    ("diffusion_models", "trellis_2_int8_convrot.safetensors", f"{HF}/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors"),
    ("diffusion_models", "pixal3d_int8_convrot.safetensors", f"{HF}/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors"),
    ("diffusion_models", "pixal3d_multiview_int8_convrot.safetensors", f"{HF}/Pixal3D/resolve/main/diffusion_models/pixal3d_multiview_int8_convrot.safetensors"),
    ("vae", "trellis_2_shape_vae_bf16.safetensors", f"{HF}/TRELLIS.2/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors"),
    ("vae", "trellis_2_texture_vae_bf16.safetensors", f"{HF}/TRELLIS.2/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors"),
    ("clip_vision", "dino_v3_L_naf_fp32.safetensors", f"{HF}/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors"),
    ("background_removal", "birefnet.safetensors", f"{HF}/BiRefNet/resolve/main/background_removal/birefnet.safetensors"),
    ("geometry_estimation", "moge_2_vitl_normal_fp16.safetensors", f"{HF}/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors"),
]


def comfy_root():
    return os.path.join(DIR, "ComfyUI_windows_portable")


def fetch(url, dst):
    """Докачка: .part + Range. Печатает прогресс раз в ~5 %."""
    part = dst + ".part"
    for attempt in range(8):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        req = urllib.request.Request(url, headers={"User-Agent": "claude-studio", **({"Range": f"bytes={have}-"} if have else {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                total = have + int(r.headers.get("Content-Length") or 0)
                if have and r.status != 206:
                    have = 0
                mode, done, last = ("ab" if have else "wb"), have, -1
                with open(part, mode) as f:
                    while True:
                        b = r.read(1 << 20)
                        if not b:
                            break
                        f.write(b); done += len(b)
                        pc = int(done * 20 / total) if total else 0
                        if pc != last:
                            last = pc; print(f"  {os.path.basename(dst)}: {done / 1e9:.2f}/{total / 1e9:.2f} ГБ", flush=True)
            os.replace(part, dst)
            return
        except Exception as e:
            print(f"  обрыв ({e}), попытка {attempt + 2}", flush=True); time.sleep(5)
    raise SystemExit("не скачалось: " + url)


def extract():
    if os.path.isfile(os.path.join(comfy_root(), "python_embeded", "python.exe")):
        return
    print("распаковка ComfyUI…", flush=True)
    r = subprocess.run(["tar", "-xf", ZIP, "-C", DIR], capture_output=True, text=True)
    if r.returncode or not os.path.isdir(comfy_root()):
        sz = r"C:\Program Files\7-Zip\7z.exe"
        if os.path.isfile(sz):
            subprocess.run([sz, "x", "-y", ZIP, f"-o{DIR}"], check=True, capture_output=True)
        else:
            raise SystemExit("не распаковалось: " + (r.stderr or "")[-400:])


def status():
    root = comfy_root()
    out = {"comfy": os.path.isfile(os.path.join(root, "python_embeded", "python.exe")), "models": {}}
    for sub, name, _ in MODELS:
        out["models"][name] = os.path.isfile(os.path.join(root, "ComfyUI", "models", sub, name))
    return out


if __name__ == "__main__":
    os.makedirs(DIR, exist_ok=True)
    if "--check" in sys.argv:
        print(status()); sys.exit()
    if not status()["comfy"]:
        if not os.path.isfile(ZIP):
            print("ComfyUI portable…", flush=True); fetch(PORTABLE, ZIP)
        extract()
    for sub, name, url in MODELS:
        dst = os.path.join(comfy_root(), "ComfyUI", "models", sub, name)
        if not os.path.isfile(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            print(name + "…", flush=True); fetch(url, dst)
    print("готово:", status(), flush=True)
