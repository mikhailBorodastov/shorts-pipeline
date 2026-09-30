"""Создать новый проект шорта из шаблона.

    python new_project.py "Название шорта"        (или new.bat "Название шорта")

Создаёт <рабочая папка>/<Название шорта>/ (рабочая папка = родитель _pipeline) с движком, пустыми refs/ и review/, ставит зависимости.
"""
import os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

name = " ".join(sys.argv[1:]).strip() or input("Название шорта: ").strip()
if not name:
    sys.exit("Название не введено — ничего не создано.")
BAD = r'\/:*?"<>|'
if any(c in name for c in BAD):
    sys.exit("В названии нельзя использовать символы: " + " ".join(BAD))
dst = os.path.join(ROOT, name)
if os.path.exists(dst):
    sys.exit(f"Уже существует: {dst}")
shutil.copytree(os.path.join(HERE, "template"), dst, ignore=shutil.ignore_patterns("node_modules", "build", "out", "__pycache__"))
for d in ("refs", "review/shots", "build", "out", "assets"):
    os.makedirs(os.path.join(dst, d), exist_ok=True)
stub = os.path.join(ROOT, "CLAUDE.md")          # makes Claude load _pipeline/CLAUDE.md in the work folder
if not os.path.exists(stub):
    with open(stub, "w", encoding="utf-8") as f:
        f.write("@_pipeline/CLAUDE.md\n")
print("npm install ...")
subprocess.run("npm install --silent", cwd=dst, shell=True, check=False)
print(f"""
Готово: {dst}

Дальше:
  1. Вставь сценарий в  {os.path.join(dst, 'script.md')}  (формат — в комментарии внутри файла)
  2. Положи референсы (видео, картинки) в  {os.path.join(dst, 'refs')}
  3. Раскадровка сценария (текст, голос по сценам, кадры, заметки для Claude): script.bat в папке проекта
  4. Напиши Claude: «сделай шорт по сценарию в папке {name}»
""")
