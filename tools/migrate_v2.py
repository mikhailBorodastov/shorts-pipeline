"""Переезд рабочей папки в Claude Studio (S2, docs/studio/stage2-studio.md).

    python tools/migrate_v2.py              сухой прогон: печатает каждый шаг «что → куда», ничего не трогает
    python tools/migrate_v2.py --apply      выполнить; журнал — _archive/migrate_v2.log.json
    python tools/migrate_v2.py --undo       откатить по журналу (в обратном порядке)
    --root <папка>                          рабочая папка (по умолчанию — родитель _studio/_pipeline)

Перед --apply закрой «Штурм» / Claude Studio (папки заняты). Ничего не удаляется: всё, что уходит, — в _archive.
Шаги:
  1. канал «Доедать будешь»: channel.json, style/ (style-guide.md, toolkit.js), library/, videos/;
  2. ролики -> <канал>/videos/, тестовые и копии -> _archive/projects/;
  3. штурмы пути «Есть идея» с проектом -> video.json в папке ролика (+ их files/ и render/ -> files/ и preprod/),
     без проекта -> новое видео-черновик, пустые и старого пути -> _archive/ideas;
     у роликов без штурма — короткий video.json (статус по out/*.mp4);
  4. _ideas -> _archive/ideas (банк, лист проекта, статистика, токены, старые штурмы), токен Sketchfab -> .studio/;
  5. скрипты роликов (audio.py, review_api.py) ищут _studio вверх по папкам, а не только рядом;
  6. _pipeline -> _studio + связка _pipeline -> _studio, CLAUDE.md и «Claude Studio.bat» в рабочей папке;
  7. git в канале (без тяжёлого) и первый коммит.
"""
import argparse, json, os, re, shutil, subprocess, sys, time, uuid

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(HERE)

CHANNEL = {"schema": 1, "id": "doedat", "name": "Доедать будешь", "icon": "🦔", "lang": "ru", "formats": ["short", "long"],
           "style": "style/style-guide.md", "toolkit": "style/toolkit.js",
           "rules": {"paperFacing": True, "facingMaxDeg": 35, "hero": "lib:characters/hog"},
           "models": {"text": "sonnet", "visual": "claude-opus-5-5"}, "defaults": {"engine": "3d", "mode": "short"},
           "about": "Бумажная аппликация: наш серый ёжик из рваных полосок, техно-новости и истории, подача по style-guide."}
ARCHIVE_PROJECTS = ("_test_3d_tpl", "_test_hogs", "_test_hogs2", "_test_штурм", "PS6_Dima", "PS6_Dima_live")
DROP_FIELDS = ("ideas", "chosen", "beats", "q7", "meanings", "images", "structure", "retro", "reaction", "stats", "genre", "challenge", "backups")
CHANNEL_GITIGNORE = """# Канал Claude Studio: в git — json, код, сценарии, сцены, библиотека. Тяжёлое — нет.
**/node_modules/
videos/*/build/
videos/*/out/
videos/*/.backups/
**/__pycache__/
videos/**/*.mp4
videos/**/*.mov
videos/**/*.webm
videos/**/*.wav
videos/**/*.mp3
videos/**/*.png
videos/**/*.jpg
videos/**/*.jpeg
videos/**/*.webp
videos/**/*.gif
videos/**/*.glb
videos/**/*.gltf
videos/**/*.bin
videos/**/*.zip
videos/**/*.ttf
"""
FINDER = '''
def _studio_dir(start=None):
    """_studio (бывший _pipeline) — вверх по папкам от ролика: рядом с ним, у канала или в рабочей папке (Claude Studio)."""
    d = os.path.abspath(start or ".")
    for _ in range(6):
        for n in ("_studio", "_pipeline"):
            if os.path.isdir(os.path.join(d, n, "sfx_library")) or os.path.isfile(os.path.join(d, n, "sfx_library.py")):
                return os.path.join(d, n)
        d = os.path.dirname(d)
    return os.path.join(os.path.dirname(os.path.abspath(start or ".")), "_pipeline")
'''
PATCHES = {   # file of a video project -> [(old, new)]; FINDER goes after the imports
    "audio.py": [('os.path.join(os.path.dirname(os.path.abspath(".")), "_pipeline", "sfx_library")', 'os.path.join(_studio_dir(), "sfx_library")'),
                 ('sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(".")), "_pipeline"))', 'sys.path.insert(0, _studio_dir())')],
    "review_api.py": [('os.path.join(os.path.dirname(ROOT), "_pipeline", "sfx_library")', 'os.path.join(_studio_dir(ROOT), "sfx_library")')],
}


class Plan:
    def __init__(self, root):
        self.root, self.steps = root, []

    def add(self, kind, what, **kw):
        self.steps.append(dict(kind=kind, what=what, **kw))


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def safe_name(n):
    n = re.sub(r"\s*:\s*", " — ", n or "")                  # «Ностальгия: утро» -> «Ностальгия — утро»
    n = re.sub(r'[\\/*?"<>|]+', " ", n)
    return re.sub(r"\s+", " ", n).strip(" .—")[:80] or "Видео"


def build_plan(root):
    P = Plan(root)
    ideas, arch = os.path.join(root, "_ideas"), os.path.join(root, "_archive")
    chan = os.path.join(root, CHANNEL["name"])
    vids = os.path.join(chan, "videos")
    studio_name = os.path.basename(STUDIO)
    if os.path.isfile(os.path.join(chan, "channel.json")):
        P.add("note", "канал уже есть — переезд, похоже, был")
    # 1. the channel
    P.add("mkdir", f"канал «{CHANNEL['name']}»: videos/, library/, style/", paths=[vids, os.path.join(chan, "library"), os.path.join(chan, "style")])
    P.add("write", "channel.json", path=os.path.join(chan, "channel.json"), text=json.dumps(CHANNEL, ensure_ascii=False, indent=1))
    P.add("write", "library/index.json (пустая библиотека)", path=os.path.join(chan, "library", "index.json"), text="[]")
    P.add("copy", "стиль канала: style-guide.md", src=os.path.join(STUDIO, "prompts", "style-guide.md"), dst=os.path.join(chan, "style", "style-guide.md"))
    P.add("copy", "тулкит канала: бумажный paper.js", src=os.path.join(STUDIO, "stands", "paper.js"), dst=os.path.join(chan, "style", "toolkit.js"))
    # 2. projects
    projects = sorted(n for n in os.listdir(root) if not n.startswith((".", "_")) and os.path.isfile(os.path.join(root, n, "build.sh")))
    projects += [n for n in ARCHIVE_PROJECTS if n not in projects and os.path.isdir(os.path.join(root, n))]
    moved = {}
    for n in projects:
        if n in ARCHIVE_PROJECTS:
            P.add("move", f"в архив: {n}", src=os.path.join(root, n), dst=os.path.join(arch, "projects", n))
        else:
            P.add("move", f"ролик → канал: {n}", src=os.path.join(root, n), dst=os.path.join(vids, n))
            moved[n] = os.path.join(vids, n)
    # 3. brainstorms
    plans = {}
    pdir = os.path.join(ideas, "plans")
    for f in sorted(os.listdir(pdir)) if os.path.isdir(pdir) else []:
        if f.endswith(".json"):
            d = load(os.path.join(pdir, f))
            plans[d["id"]] = d
    with_video = set()
    for pid, d in plans.items():
        idea = d.get("flow") == "idea"
        proj = d.get("project")
        empty = not (d.get("idea") or "").strip() and not d.get("elements") and not d.get("qa")
        if idea and proj and proj in moved:
            vd = moved[proj]
            P.add("video", f"штурм «{d['name']}» ({pid}) → video.json ролика «{proj}»", dst=os.path.join(vd, "video.json"), plan=pid, status=d.get("status"))
            with_video.add(proj)
            for sub, to in (("files", "files"), ("render", "preprod")):
                if os.path.isdir(os.path.join(ideas, sub, pid)):
                    P.add("move", f"  {sub}/{pid} → {proj}/{to}", src=os.path.join(ideas, sub, pid), dst=os.path.join(vd, to), merge=True)
        elif idea and not empty:
            name = safe_name(d.get("name") or pid)
            vd = os.path.join(vids, name)
            P.add("mkdir", f"новое видео-черновик «{name}» из штурма {pid}", paths=[vd, os.path.join(vd, "refs")])
            P.add("video", f"  {pid} → video.json", dst=os.path.join(vd, "video.json"), plan=pid, status=d.get("status"))
            for sub, to in (("files", "files"), ("render", "preprod")):
                if os.path.isdir(os.path.join(ideas, sub, pid)):
                    P.add("move", f"  {sub}/{pid} → {name}/{to}", src=os.path.join(ideas, sub, pid), dst=os.path.join(vd, to), merge=True)
        else:
            P.add("note", f"штурм «{d['name']}» ({pid}, {'старый путь' if not idea else 'пустой'}) — в архив вместе с _ideas")
    for n, vd in moved.items():
        if n not in with_video:
            P.add("video", f"короткий video.json для «{n}»", dst=os.path.join(vd, "video.json"), plan=None, name=n)
    # 4. _ideas -> archive
    tok = os.path.join(ideas, "sketchfab_token.txt")
    if os.path.isfile(tok):
        P.add("copy", "токен Sketchfab → .studio/", src=tok, dst=os.path.join(root, ".studio", "sketchfab_token.txt"))
    if os.path.isdir(ideas):
        P.add("move", "_ideas → _archive/ideas (банк, лист проекта, статистика, старые штурмы, токены YouTube)", src=ideas, dst=os.path.join(arch, "ideas"))
    P.add("write", ".studio/state.json (текущий канал)", path=os.path.join(root, ".studio", "state.json"), text=json.dumps({"channel": CHANNEL["id"]}))
    # 5. video scripts look for _studio upwards
    for n, vd in moved.items():
        for f in PATCHES:
            P.add("patch", f"  {n}/{f}: _studio ищется вверх по папкам", path=os.path.join(vd, f), file=f)
    # 6. the app folder
    if studio_name == "_pipeline":
        P.add("move", "_pipeline → _studio", src=STUDIO, dst=os.path.join(root, "_studio"))
        P.add("junction", "связка _pipeline → _studio (переходный период)", path=os.path.join(root, "_pipeline"), target=os.path.join(root, "_studio"))
    else:
        P.add("note", f"папка приложения уже {studio_name}")
    P.add("write", "CLAUDE.md рабочей папки → @_studio/CLAUDE.md", path=os.path.join(root, "CLAUDE.md"), text="@_studio/CLAUDE.md\n")
    old_bat = os.path.join(root, "Штурм идей.bat")
    if os.path.isfile(old_bat):
        P.add("move", "«Штурм идей.bat» → _archive", src=old_bat, dst=os.path.join(arch, "Штурм идей.bat"))
    P.add("write", "«Claude Studio.bat» в рабочей папке", path=os.path.join(root, "Claude Studio.bat"),
          text='@echo off\r\ncd /d "%~dp0_studio\\server"\r\npython studio.py --open\r\npause\r\n')
    # 7. git of the channel
    P.add("write", "канал: .gitignore (без тяжёлого)", path=os.path.join(chan, ".gitignore"), text=CHANNEL_GITIGNORE)
    P.add("git", "git в канале + первый коммит", path=chan)
    return P, plans


def video_doc(plans, step, vd):
    """video.json from a brainstorm (without the removed fields) or a short one for a video without a brainstorm."""
    t = int(time.time() * 1000)
    if step.get("plan"):
        d = dict(plans[step["plan"]])
        for k in DROP_FIELDS:
            d.pop(k, None)
        d.update(schema=2, flow="idea", project=os.path.basename(vd) if d.get("project") else "")
        d.setdefault("stage", "script" if d.get("project") else ("pre" if d.get("elements") else "idea"))
        d.setdefault("engine", "3d")
        return d
    out = os.path.join(vd, "out")
    done = os.path.isdir(out) and any(f.lower().endswith(".mp4") for f in os.listdir(out))
    return {"schema": 2, "id": time.strftime("%y%m%d") + "-" + uuid.uuid4().hex[:4], "rev": 0, "created": int(os.path.getctime(vd) * 1000), "updated": t,
            "mode": "short", "flow": "idea", "name": step["name"], "status": "out" if done else "prod", "stage": "review" if done else "script",
            "project": step["name"], "idea": "", "topic": "", "refs": [], "qa": [], "titles": [], "final": {"title": "", "thumb": ""},
            "engine": "2d", "elements": [], "thumbs": [], "migrated": "ролик сделан до Claude Studio: идея и препродакшен — в refs/ и script.md"}


def patch_text(text, file):
    if "_studio_dir(" in text:
        return text
    for old, new in PATCHES[file]:
        text = text.replace(old, new)
    if "_studio_dir(" not in text:
        return None
    m = list(re.finditer(r"^(?:import|from) [^\n]+\n", text, re.M))
    at = m[-1].end() if m else 0
    return text[:at] + FINDER + text[at:]


def merge_move(src, dst):
    """Move src into dst; when dst exists, move the children one by one (render/<id> into an existing preprod/)."""
    if not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        return [(src, dst)]
    done = []
    for n in os.listdir(src):
        s, d = os.path.join(src, n), os.path.join(dst, n)
        if os.path.exists(d):
            done += merge_move(s, d) if os.path.isdir(s) else []
        else:
            shutil.move(s, d)
            done.append((s, d))
    return done


def run(P, plans, apply):
    log = []
    journal = os.path.join(P.root, "_archive", "migrate_v2.log.json")
    for i, s in enumerate(P.steps, 1):
        k = s["kind"]
        line = f"{i:>3}. {s['what']}"
        if k == "move":
            line += f"\n       {s['src']}\n    →  {s['dst']}"
        print(line)
        if not apply or k == "note":
            continue
        try:
            if k == "mkdir":
                for p in s["paths"]:
                    if not os.path.isdir(p):
                        os.makedirs(p)
                        log.append({"undo": "rmdir", "path": p})
            elif k == "write":
                old = open(s["path"], encoding="utf-8").read() if os.path.isfile(s["path"]) else None
                os.makedirs(os.path.dirname(s["path"]), exist_ok=True)
                with open(s["path"], "w", encoding="utf-8", newline="") as f:
                    f.write(s["text"])
                log.append({"undo": "restore", "path": s["path"], "text": old})
            elif k == "copy":
                if os.path.isfile(s["src"]) and not os.path.exists(s["dst"]):
                    os.makedirs(os.path.dirname(s["dst"]), exist_ok=True)
                    shutil.copy2(s["src"], s["dst"])
                    log.append({"undo": "restore", "path": s["dst"], "text": None})
            elif k == "move":
                if os.path.exists(s["src"]):
                    for a, b in (merge_move(s["src"], s["dst"]) if s.get("merge") else [(s["src"], s["dst"])]):
                        if not s.get("merge"):
                            os.makedirs(os.path.dirname(b), exist_ok=True)
                            shutil.move(a, b)
                        log.append({"undo": "move", "src": b, "dst": a})
            elif k == "video":
                vd = os.path.dirname(s["dst"])
                if not os.path.isfile(s["dst"]):
                    with open(s["dst"], "w", encoding="utf-8") as f:
                        json.dump(video_doc(plans, s, vd), f, ensure_ascii=False, indent=1)
                    log.append({"undo": "restore", "path": s["dst"], "text": None})
                for sub in ("files", "preprod", "refs"):
                    if not os.path.isdir(os.path.join(vd, sub)):
                        os.makedirs(os.path.join(vd, sub))
                        log.append({"undo": "rmdir", "path": os.path.join(vd, sub)})
            elif k == "patch":
                if os.path.isfile(s["path"]):
                    old = open(s["path"], encoding="utf-8").read()
                    new = patch_text(old, s["file"])
                    if new and new != old:
                        with open(s["path"], "w", encoding="utf-8", newline="") as f:
                            f.write(new)
                        log.append({"undo": "restore", "path": s["path"], "text": old})
            elif k == "junction":
                if not os.path.exists(s["path"]):
                    subprocess.run(["cmd", "/c", "mklink", "/J", s["path"], s["target"]], check=True, capture_output=True)
                    log.append({"undo": "unjunction", "path": s["path"]})
            elif k == "git":
                d = s["path"]
                if not os.path.isdir(os.path.join(d, ".git")):
                    subprocess.run(["git", "init", "-q"], cwd=d, check=True)
                    subprocess.run(["git", "add", "-A"], cwd=d, check=True)
                    subprocess.run(["git", "commit", "-q", "-m", "Канал «Доедать будешь»: переезд в Claude Studio (migrate_v2)"], cwd=d, check=False)
                    log.append({"undo": "rmgit", "path": d})
        except Exception as e:
            print(f"   ✗ {e}")
            log.append({"error": str(e), "step": i})
            os.makedirs(os.path.dirname(journal), exist_ok=True)
            json.dump({"ts": time.time(), "log": log, "failed": i}, open(journal, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print(f"\nОстановлено на шаге {i}. Журнал: {journal}. Откат: python tools/migrate_v2.py --undo")
            sys.exit(1)
    if apply:
        os.makedirs(os.path.dirname(journal), exist_ok=True)
        json.dump({"ts": time.time(), "log": log}, open(journal, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"\nГотово. Журнал: {journal}")
    else:
        print(f"\nСухой прогон: {len(P.steps)} шагов, ничего не тронуто. Выполнить: python tools/migrate_v2.py --apply")


def undo(root):
    journal = os.path.join(root, "_archive", "migrate_v2.log.json")
    j = load(journal)
    for e in reversed(j["log"]):
        u = e.get("undo")
        try:
            if u == "move" and os.path.exists(e["src"]):
                os.makedirs(os.path.dirname(e["dst"]), exist_ok=True)
                shutil.move(e["src"], e["dst"])
            elif u == "restore":
                if e["text"] is None:
                    if os.path.isfile(e["path"]):
                        os.remove(e["path"])
                else:
                    open(e["path"], "w", encoding="utf-8", newline="").write(e["text"])
            elif u == "rmdir" and os.path.isdir(e["path"]) and not os.listdir(e["path"]):
                os.rmdir(e["path"])
            elif u == "rmgit" and os.path.isdir(os.path.join(e["path"], ".git")):
                shutil.rmtree(os.path.join(e["path"], ".git"), onerror=lambda f, p, x: (os.chmod(p, 0o700), f(p)))
            elif u == "unjunction" and os.path.exists(e["path"]):
                os.rmdir(e["path"])
            print("↺", u, e.get("path") or e.get("src"))
        except Exception as ex:
            print("✗", u, e.get("path") or e.get("src"), ex)
    os.rename(journal, journal + f".undone-{int(time.time())}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--undo", action="store_true")
    ap.add_argument("--root", default=os.environ.get("STUDIO_ROOT") or os.path.dirname(STUDIO))
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    if a.undo:
        undo(root); return
    if a.apply and os.path.abspath(os.getcwd()).startswith(os.path.abspath(STUDIO)):
        sys.exit("Запусти из рабочей папки, не изнутри _pipeline: cd .. && python _pipeline/tools/migrate_v2.py --apply")
    P, plans = build_plan(root)
    print(f"Рабочая папка: {root}\n")
    run(P, plans, a.apply)


if __name__ == "__main__":
    main()
