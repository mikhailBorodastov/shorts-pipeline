"""Готовит код для установщика: app/bundle/_studio = файлы репозитория _studio (git ls-files, плюс новые неигнорируемые).
Тяжёлое и личное в git не лежит и сюда не попадает: tools/blender, sfx_library, node_modules, target, кэши.
Само окно (app/) не копируется — его кладёт сборщик Tauri. Запускает build_setup.bat."""
import os, shutil, subprocess, sys

APP = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(APP)
OUT = os.path.join(APP, "bundle", "_studio")
SKIP = ("app/",)                 # окно приложения — отдельно

files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=STUDIO, capture_output=True, check=True).stdout.decode("utf-8").split("\0")
files = [f for f in files if f and not f.startswith(SKIP)]
if os.path.exists(OUT):
    shutil.rmtree(OUT)
size = 0
for f in files:
    src = os.path.join(STUDIO, f)
    if not os.path.isfile(src):
        continue
    dst = os.path.join(OUT, f)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    size += os.path.getsize(src)
print(f"bundle/_studio: {len(files)} файлов, {size / 1e6:.1f} МБ")
if size > 200e6:
    sys.exit("слишком много — проверь .gitignore")
