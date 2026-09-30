"""Создать проект ролика из шаблона (Claude Studio).

    python new_project.py "Название"            -> <текущий канал>/videos/<Название>/ (до переезда — <рабочая папка>/<Название>/)
    python new_project.py --into "<папка видео>"  -> доложить шаблон в уже созданное видео (кнопка «🚀 начать производство»)

Шаблон — template/ (скрипты сборки, src/ сцен, шрифты); движок (lib.js, stage3d.js, moves3d.js, scene.js, vendor/) — из engine/ в src/.
Существующие файлы не перезаписываются. Потом ставятся зависимости (npm install).
"""
import os, shutil, subprocess, sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "server"))
import paths as P  # noqa: E402

ENGINE_FILES = ("lib.js", "stage3d.js", "moves3d.js", "scene.js", "scene.schema.json", "vendor")


def copy_missing(src, dst, ignore=None):
    """Copy a tree without touching files that are already there."""
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        if ignore:
            dirs[:] = [d for d in dirs if d not in ignore]
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in files:
            t = os.path.join(dst, rel, f)
            if not os.path.exists(t):
                shutil.copy2(os.path.join(root, f), t)


def make(dst, install=True):
    copy_missing(os.path.join(HERE, "template"), dst, ignore={"node_modules", "build", "out", "__pycache__"})
    for f in ENGINE_FILES:
        s = os.path.join(P.ENGINE, f)
        if os.path.isdir(s):
            copy_missing(s, os.path.join(dst, "src", f))
        elif os.path.isfile(s) and not os.path.exists(os.path.join(dst, "src", f)):
            shutil.copy2(s, os.path.join(dst, "src", f))
    for d in ("refs", "review/shots", "build", "out", "assets"):
        os.makedirs(os.path.join(dst, d), exist_ok=True)
    stub = os.path.join(P.ROOT, "CLAUDE.md")          # Claude loads the studio instructions in the work folder
    if not os.path.exists(stub):
        with open(stub, "w", encoding="utf-8") as f:
            f.write(f"@{os.path.basename(P.STUDIO)}/CLAUDE.md\n")
    if install:
        print("npm install ...")
        subprocess.run("npm install --silent", cwd=dst, shell=True, check=False)


def main(argv):
    if argv[:1] == ["--into"]:
        dst = os.path.abspath(" ".join(argv[1:]).strip())
        if not os.path.isdir(dst):
            sys.exit(f"Нет папки: {dst}")
        make(dst)
        print(f"Готово: проект ролика в {dst}")
        return
    name = " ".join(argv).strip() or input("Название: ").strip()
    if not name:
        sys.exit("Название не введено — ничего не создано.")
    BAD = r'\/:*?"<>|'
    if any(c in name for c in BAD):
        sys.exit("В названии нельзя использовать символы: " + " ".join(BAD))
    c = P.channel()
    base = os.path.join(c["dir"], "videos") if c else P.ROOT
    dst = os.path.join(base, name)
    if os.path.exists(dst):
        sys.exit(f"Уже существует: {dst}")
    os.makedirs(dst)
    make(dst)
    print(f"""
Готово: {dst}

Дальше:
  1. Вставь сценарий в  {os.path.join(dst, 'script.md')}  (формат — в комментарии внутри файла)
  2. Положи референсы (видео, картинки) в  {os.path.join(dst, 'refs')}
  3. Раскадровка сценария (текст, голос по сценам, кадры, заметки для Claude): script.bat в папке проекта
  4. Напиши Claude: «сделай шорт по сценарию в папке {name}»
""")


if __name__ == "__main__":
    main(sys.argv[1:])
