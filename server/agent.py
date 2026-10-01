"""Агент Claude Studio (S7, docs/studio/stage7-agent.md): живая сессия `claude -p --input-format stream-json --output-format stream-json` на видео.

- Инструменты агента — команды студии (`python <studio.py> …`: scene brief/ops/frame/undo, montage …, set/op, char, lib) и чтение файлов;
  при «✨ Собрать» ещё Write/Edit (сценарий проекта). Всё, что меняет сцену или видео, идёт через CLI → в историю, с отменой.
- Лог шагов пишется в `<видео>/agent.jsonl` и отдаётся странице по номеру (GET /api/agent?video=&since=): ты / Claude / шаг / результат / готово.
- Сообщение посреди работы уходит в stdin той же сессии (Claude подхватывает его между командами); «■ стоп» — control_request interrupt.
- Запуск (run) = одна просьба автора и всё, что агент сделал до конца ответа; CLI-вызовы знают текущий запуск (STUDIO_AGENT → `.studio/agent/<видео>.run`)
  и помечают им пачки сцены (`run` в history.jsonl) и обратные операции видео (`.studio/agent/runs/<run>.jsonl`) — «↺ отменить» откатывает весь запуск.
- Пока агент работает, сцена, открытая у автора (контекст просьбы), заблокирована (scene_api.LOCKS) — редактор только смотрит.
"""
import json, os, subprocess, sys, threading, time, uuid

import paths as P  # noqa: E402

SESS = globals().get("SESS") or {}                    # id видео -> Session (переживает перезагрузку модуля)
STUDIO_PY = os.path.join(P.STUDIO, "server", "studio.py").replace("\\", "/")
BLENDER_RUN = os.path.join(P.STANDS, "blender_run.py").replace("\\", "/")         # model.py пропса -> model.glb (Blender)
RENDER_PROP = os.path.join(P.STANDS, "render_prop.js").replace("\\", "/")         # кадры 3D-пропса / персонажа-модели
RENDER_CHAR = os.path.join(P.STANDS, "render_char.js").replace("\\", "/")         # кадры персонажа на скелете частей
AGENT_DIR = os.path.join(P.STATE, "agent")
RULES_REV = 6                                         # права / правила агента: другая — старая сессия перезапускается (2: lib fork, Write/Edit, стенды)
IDLE_MIN = 40                                         # сессия без дела закрывается через столько минут


def now_ms():
    return int(time.time() * 1000)


def run_file(vid):
    return os.path.join(AGENT_DIR, vid + ".run")


def current_run():
    """Для CLI: запуск агента, внутри которого идёт эта команда (или None)."""
    vid = os.environ.get("STUDIO_AGENT")
    if not vid:
        return None
    try:
        return open(run_file(vid), encoding="utf-8").read().strip() or None
    except OSError:
        return None


def journal(run, rec):
    """Обратная операция видео (set / add через CLI) — для отмены запуска."""
    os.makedirs(os.path.join(AGENT_DIR, "runs"), exist_ok=True)
    with open(os.path.join(AGENT_DIR, "runs", run + ".jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def log_path(vid):
    d = P.video(vid)
    return os.path.join(d, "agent.jsonl") if d else os.path.join(AGENT_DIR, vid + ".jsonl")


# ---------------------------------------------------------------- системный промпт
def system_prompt(A, vid, mode):
    C = A.capi()
    docs = A._docs("plan:" + vid)
    plan = docs["plan"] or {}
    vdir = P.video(vid) or ""
    base = C.system(docs, plan.get("mode") or "short")
    base = base.replace("- Отвечай строго JSON по заданной схеме.", "")
    sp = STUDIO_PY
    cmds = f"""Команды студии (Bash, ровно в таком виде; PLAN = {vid}):
- python {sp} show {vid}                                   — видео целиком (идея, ответы, элементы препродакшена)
- python {sp} scene brief {vid} EL                         — сцена редактора: объекты, свет, камера, префабы, authored, комментарии
- python {sp} scene ops {vid} EL '<JSON-массив операций>' --desc "что сделано"  — ОДНА пачка правок сцены (в историю, отменяется)
- python {sp} scene frame {vid} EL 2.5[,4]                  — кадр сцены в момент t → путь PNG; посмотри его через Read
- python {sp} scene history {vid} EL | scene undo {vid} EL  — история / отменить последнюю пачку
- python {sp} set plan:{vid} путь.через.точки '<JSON>'      — поле видео (например montage — монтаж целиком)
- python {sp} montage brief {vid}                          — монтаж: юниты, сцены (маркеры, склейки, длина), слова голоса с номерами, звуки, музыка
- python {sp} montage gen {vid} | montage build {vid}      — файлы проекта из монтажа / собрать mp4 (долго, 1–3 мин)
- python {sp} montage tts {vid} | montage check {vid} | montage snap {vid} 1.5,4,8   — голос по script.md / проверка сценария по гайду / кадры ролика (PNG → Read)
- python {sp} char list | char show SLUG                   — персонажи библиотеки (скелет, костюмы, эмоции, клипы типа)
- python {sp} lib list | lib show KIND/SLUG                — библиотека канала (KIND: props | characters | sounds)
- python {sp} lib fork KIND/SLUG@N [--as "Новое имя"] --note "что меняю"  — НОВАЯ версия копией (с --as — новый предмет) → папка для правки
- python {sp} lib preview KIND/SLUG@N                     — после правки: превью версии на стенде (кадры — через Read)
- python {sp} lib import {vid} KIND/SLUG[@N] --why "что это и где в ролике"  — взять персонажа / пропс из библиотеки в препродакшен видео
  («используй диван из библиотеки»: в сцену его ставь сразу ссылкой lib:KIND/SLUG@N — основная версия из lib list; import — если он нужен элементом видео)
- python {sp} model info ФАЙЛ.glb                          — из каких узлов собрана модель (имена, габариты) — чтобы делить по частям
- python {BLENDER_RUN} ПАПКА/model.py                     — пересобрать model.glb из model.py (Blender)
- node {RENDER_PROP} URL-prefab.js ПАПКА | node {RENDER_CHAR} URL-prefab.js ПАПКА — кадры пропса / персонажа (lib preview делает это сам)
Файлы смотри Read / Glob / Grep, не ls и не cd. Составные команды (&&, ;, |, cd …) не пиши — по одной команде за вызов, иначе её заблокирует.
Файлы правь ТОЛЬКО инструментами Edit / Write — prefabs.js сцены, prefab.js / model.py / rig.json версии библиотеки. Python, node и прочие скрипты
(кроме команд выше) не запускай — их заблокирует; правку, которую хотелось сделать скриптом, сделай Edit-ом по шагам.
Если команду всё же заблокировало — НЕ проси у автора разрешения (подтвердить здесь некому): сделай то же доступными инструментами и доведи дело до конца."""
    rules = f"""Как работать:
- Ты — агент внутри Claude Studio, автор видит каждый твой шаг в панели и может дописать тебе посреди работы или остановить. Пиши по-русски, коротко.
- Сцену и видео меняешь только командами студии — так всё попадает в историю и отменяется. scene.json и video.json руками не правь.
- Файлы (Write / Edit) правишь только: в папке версии, которую сам создал lib fork в этом разговоре; в prefabs.js открытой сцены (её «как выглядят предметы»
  — путь в scene brief), если автор просит поменять или разделить предмет сцены; в проекте ролика при «✨ Собрать».
  Разделить предмет из prefabs.js на части: Edit — новые префабы в PREFABS (каждая часть строится на прежнем месте, home как у исходного), исходный
  префаб без вынесенных частей; потом scene ops — новые объекты с этими префабами (ключи движения — копией, если части ездят вместе), переименовать исходный.
  Редактор автора сам перезагрузит страницу, когда prefabs.js поменяется. Посмотри кадр (scene frame) — части на месте, ничего не задвоилось. Код Studio (_studio/…), старые версии библиотеки,
  чужие видео и каналы не трогай — если без этого никак, скажи автору, что и где поменять.
- Одна просьба — одна пачка операций сцены (если просьба большая — 2–3 пачки по смыслу), у каждой понятный --desc.
- Ручные правки автора (authored в scene brief) не трогай без прямой просьбы; если просьба прямо про них — добавь --allow <id>.<путь>.
- После правки сцены посмотри кадр (scene frame → Read) и поправь, если вышло не так. Координаты считай по pos других предметов, не на глаз.
- Библиотеку канала (персонажи, пропсы, клипы) меняешь только после «да» автора (или если он сам прямо просит изменить / разделить предмет) — и только
  НОВОЙ версией: lib fork → правишь файлы в выданной папке (prefab.js, model.py → blender_run, rig.json) → lib preview → смотришь кадры → в сцене
  scene ops: src.prefab объекта = новая ссылка lib:KIND/SLUG@N. Старые версии остаются — их держат другие видео; отмена — scene undo.
  Разделить предмет на части — lib fork --as для каждой части (или параметр part в prefab.js, если части в одной модели — смотри model info) и отдельные объекты в сцене на тех же местах.
- Новые предметы — из префабов сцены (scene brief → prefabs), 3D-пропсов и персонажей видео / библиотеки; нового по описанию не выдумывай — предложи сделать его в препродакшене.
- Если просьба непонятна — спроси одной фразой и жди ответа. В конце — 1–2 фразы, что сделано.
- Автор присылает контекст в начале сообщения: этап, открытая сцена (EL), момент курсора, выбранные объекты. «Здесь», «этот» — это оно.

{C.SCENE_RULES}"""
    build = ""
    if mode == "build":
        build = f"""

Режим «✨ Собрать» — доведи видео до собранного ролика в ревью, как Claude Code по _studio/CLAUDE.md (шаги 0 и A), но без викторины:
1. Прочитай видео (show) и сцены редактора (scene brief каждой). Проект ролика — {vdir.replace(chr(92), '/')} (если его нет — python {sp} produce {vid}).
2. Сценарий — script.md проекта в формате сценариста (### 0:00–0:04 — НАЗВАНИЕ, **Картинка:**, **VO:** + строки «> …»); голос — из style/voice.json канала (строки voice / rate в шапке — только если нужен другой),
   подача — стайл-гайд канала (style/style-guide.md) и _studio/prompts/style-guide.md; правила канала (channel.json → rules / ruleDefs) соблюдай.
   Картинку пиши сценами редактора (их названия). Длина — как просит видео (коротко, если не сказано). Проверь: montage check, исправь ❌.
3. Голос: montage tts. Потом montage brief — слова с номерами.
4. Монтаж: set plan:{vid} montage '<JSON>' — юниты сцен по порядку сценария (at, len, map [[0,0],[t маркера,"w:i"],…,[len сцены, len юнита]], trans), voice/captions on,
   звуки сцен идут сами; sfx / music — из звуков препродакшена (el:<id>) или библиотеки (lib:<id>), если они есть. Маркеры сцен тяни к словам, которые их описывают.
5. montage gen → montage snap на 3–5 моментах → посмотри PNG, поправь сцены / монтаж, если что-то не так.
6. montage build — дождись конца; в ответе — что получилось и что автору стоит посмотреть в «Ревью»."""
    return base + "\n\n" + cmds + "\n\n" + rules + build


def spawn(A, vid, model, mode):
    exe = A.claude_bin()
    if not exe:
        raise RuntimeError("не найден Claude Code (claude.exe)")
    os.makedirs(AGENT_DIR, exist_ok=True)
    sysf = os.path.join(AGENT_DIR, f"{vid}.{mode}.system.txt")
    A.write_text(sysf, system_prompt(A, vid, mode))
    # Bash — только команды студии и стенды; файлы — Read/Glob/Grep, правка — Write/Edit (где можно — в правилах промпта: версии lib fork, prefabs.js сцены, проект ролика)
    allowed = [f"Bash(python {STUDIO_PY}:*)", f"Bash(python {BLENDER_RUN}:*)", f"Bash(node {RENDER_PROP}:*)", f"Bash(node {RENDER_CHAR}:*)",
               "Read", "Grep", "Glob", "Write", "Edit"]
    tools = ["Bash", "Read", "Grep", "Glob", "Write", "Edit"]
    vdir = P.video(vid) or P.ROOT
    cmd = [exe, "-p", "--safe-mode", "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--tools", ",".join(tools), "--allowedTools", *allowed, "--permission-prompts", "none", "--system-prompt-file", sysf,
           "--add-dir", P.STUDIO, "--add-dir", os.path.dirname(os.path.dirname(vdir)),       # движок и промпты; канал (библиотека)
           "--model", model]
    env = dict(os.environ, STUDIO_AGENT=vid, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=vdir, env=env,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


class Session:
    def __init__(self, A, vid, model, mode):
        self.A, self.vid, self.model, self.mode = A, vid, model, mode
        self.proc = spawn(A, vid, model, mode)
        self.rules = RULES_REV
        self.lock = threading.Lock()
        self.busy, self.run, self.last, self.ctx_scene, self.ending, self.acc = False, None, time.time(), None, None, None
        self.entries = self._load()
        self.pending = {}                              # tool_use_id -> индекс записи шага
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._err, daemon=True).start()

    def _load(self):
        out = []
        try:
            for ln in open(log_path(self.vid), encoding="utf-8"):
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    pass
        except OSError:
            pass
        return out[-400:]

    def add(self, kind, text="", **kw):
        with self.lock:
            e = {"i": (self.entries[-1]["i"] + 1) if self.entries else 1, "ts": now_ms(), "kind": kind, "text": text, "run": self.run, **kw}
            self.entries.append(e)
            try:
                with open(log_path(self.vid), "a", encoding="utf-8") as f:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
            except OSError:
                pass
            return e

    def patch(self, i, **kw):                            # результат шага дописывается к шагу (в файл — отдельной строкой «res»)
        with self.lock:
            for e in reversed(self.entries):
                if e["i"] == i:
                    e.update(kw); break
        self.add("res", kw.get("res", "")[:400], of=i, err=kw.get("err", False))

    def alive(self):
        return self.proc and self.proc.poll() is None

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def say(self, text, ctx=None):
        self.last = time.time()
        head = ctx_text(self.A, self.vid, ctx)
        if not self.busy:
            self.run = "r" + uuid.uuid4().hex[:8]
            A = self.A
            os.makedirs(AGENT_DIR, exist_ok=True)
            A.write_text(run_file(self.vid), self.run)
            self.busy = True
            self.ctx_scene = (ctx or {}).get("el")
            if self.ctx_scene:
                A.scapi().LOCKS[A.scapi().skey("plan:" + self.vid, self.ctx_scene)] = "agent:" + self.vid
        self.add("you", text, ctx=head)
        self.send({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": (head + "\n\n" if head else "") + text}]}})

    def stop(self):
        if self.busy and self.alive():
            self.send({"type": "control_request", "request_id": "int" + uuid.uuid4().hex[:6], "request": {"subtype": "interrupt"}})
            self.add("note", "■ остановлено автором")

    def close(self):
        try:
            if self.alive():
                self.proc.stdin.close()
                self.proc.wait(timeout=5)
        except Exception:
            pass
        try:
            if self.alive():
                self.proc.kill()
        except Exception:
            pass
        self._unlock()

    def _unlock(self):
        if self.ctx_scene:
            L = self.A.scapi().LOCKS
            L.pop(self.A.scapi().skey("plan:" + self.vid, self.ctx_scene), None)
        self.ctx_scene = None

    def _finish(self, ok, text="", meta=None):
        run = self.run
        self.busy = False
        self._unlock()
        try:
            os.remove(run_file(self.vid))
        except OSError:
            pass
        self.add("done", text, ok=ok, undo=run_changes(self.A, self.vid, run) if run else {}, **(meta or {}))

    def _err(self):
        for ln in self.proc.stderr:
            s = ln.decode("utf-8", "replace").strip()
            if s:
                self.add("err", s[:400])

    def _read(self):
        for ln in self.proc.stdout:
            try:
                e = json.loads(ln)
            except ValueError:
                continue
            try:
                self._event(e)
            except Exception as ex:                      # a strange event must not kill the log
                self.add("err", f"лог: {ex}")
        if self.busy:
            self._finish(False, "сессия Claude закрылась")
        self.add("note", "сессия закрыта")

    def _event(self, e):
        ty = e.get("type")
        if ty == "assistant":
            for c in (e.get("message") or {}).get("content") or []:
                if c.get("type") == "text" and c.get("text", "").strip():
                    self.add("claude", c["text"].strip())
                elif c.get("type") == "tool_use":
                    x = self.add("step", step_text(c), tool=c.get("name"), cmd=tool_cmd(c))
                    self.pending[c.get("id")] = x["i"]
        elif ty == "user":
            for c in (e.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    i = self.pending.pop(c.get("tool_use_id"), None)
                    body = c.get("content")
                    if isinstance(body, list):
                        body = " ".join(b.get("text", "") for b in body if isinstance(b, dict) and b.get("type") == "text")
                    if i:
                        self.patch(i, res=str(body or "")[:1500], err=bool(c.get("is_error")))
        elif ty == "system" and e.get("subtype") == "init":
            self.ending = None                            # следующий ход начался сразу (автор дописал, пока агент заканчивал) — тот же запуск
        elif ty == "result":
            ok = e.get("subtype") == "success"
            sec = round((e.get("duration_ms") or 0) / 1000)
            self.acc = {"cost": (self.acc or {}).get("cost", 0) + (e.get("total_cost_usd") or 0), "turns": (self.acc or {}).get("turns", 0) + (e.get("num_turns") or 0),
                        "sec": (self.acc or {}).get("sec", 0) + sec}
            text = "" if ok else ("прервано" if e.get("subtype") == "error_during_execution" else str(e.get("subtype")))
            token = self.ending = uuid.uuid4().hex
            def later():                                  # ждём 2.5 с: если автор дописал под конец, Claude сразу начнёт новый ход (init) — запуск продолжается
                time.sleep(2.5)
                if self.ending == token and self.busy:
                    acc, self.acc = self.acc, None
                    self._finish(ok, text, acc)
            threading.Thread(target=later, daemon=True).start()


def tool_cmd(c):
    x = c.get("input") or {}
    return (x.get("command") or x.get("file_path") or x.get("pattern") or "")[:600]


def step_text(c):
    """Шаг лога человеческими словами."""
    name, x = c.get("name"), c.get("input") or {}
    if name == "Bash":
        cmd = x.get("command") or ""
        if STUDIO_PY in cmd:
            import re, shlex
            try:
                a = shlex.split(cmd.split(STUDIO_PY, 1)[1])
            except ValueError:
                a = cmd.split(STUDIO_PY, 1)[1].split()
            k = " ".join(a[:2])
            desc = next((a[i + 1] for i, w in enumerate(a[:-1]) if w == "--desc"), "")
            if k == "scene ops":
                return "✏️ " + (desc or "правлю сцену")
            if k == "scene frame":
                return f"📷 снимаю кадр {a[4] if len(a) > 4 else ''} с"
            if k == "scene brief":
                return "читаю сцену"
            if k == "scene history":
                return "смотрю историю правок"
            if k == "scene undo":
                return "↺ отменяю свою последнюю пачку"
            if a[:1] == ["set"]:
                return "✏️ меняю видео: " + (a[2] if len(a) > 2 else "")
            M = {"montage brief": "читаю монтаж", "montage gen": "обновляю файлы проекта", "montage build": "🔨 собираю ролик (1–3 мин)", "montage tts": "🎙 озвучиваю сценарий",
                 "montage check": "проверяю сценарий по гайду", "montage snap": "📷 снимаю кадры ролика", "show " + (a[1] if len(a) > 1 else ""): "читаю видео"}
            return M.get(k) or x.get("description") or "studio " + " ".join(a[:3])
        return x.get("description") or cmd[:80]
    if name == "Read":
        f = os.path.basename(x.get("file_path") or "")
        return ("смотрю кадр " if f.lower().endswith(".png") else "читаю ") + f
    if name in ("Write", "Edit"):
        return ("пишу " if name == "Write" else "правлю ") + os.path.basename(x.get("file_path") or "")
    return name or "шаг"


def ctx_text(A, vid, ctx):
    if not ctx:
        return ""
    bits = []
    if ctx.get("stage"):
        bits.append(f"этап «{ctx['stage']}»")
    if ctx.get("el"):
        name = ""
        try:
            name = A.scapi().load_scene(A, "plan:" + vid, ctx["el"]).get("name", "")
        except Exception:
            pass
        bits.append(f"открыта сцена EL={ctx['el']} «{name}»")
    if ctx.get("t") is not None:
        bits.append(f"курсор {float(ctx['t']):.2f} с")
    if ctx.get("sel"):
        bits.append("выбрано: " + ", ".join(ctx["sel"][:8]))
    if ctx.get("target"):
        bits.append(f"комментарий к {ctx['target']}")
    return "[контекст: " + "; ".join(bits) + "]" if bits else ""


# ---------------------------------------------------------------- отмена запуска
def run_changes(A, vid, run):
    """Что сделал запуск: пачки сцен (history с run) и правки видео (журнал) — для «↺ отменить»."""
    out = {"scenes": {}, "plan": 0}
    S = A.scapi()
    for e in (A.load("plan:" + vid).get("elements") or []):
        if e.get("kind") != "scene" or not (e.get("stage") or {}).get("work"):
            continue
        n = sum(1 for h in S.history(A, "plan:" + vid, e["id"], 400) if h.get("run") == run and h.get("kind") != "undo")
        if n:
            out["scenes"][e["id"]] = n
    try:
        out["plan"] = sum(1 for _ in open(os.path.join(AGENT_DIR, "runs", run + ".jsonl"), encoding="utf-8"))
    except OSError:
        pass
    return out


def undo_run(A, vid, run):
    """↺ всё, что сделал запуск: пачки сцен в обратном порядке (как Ctrl+Z), правки видео — обратными операциями."""
    S, key, done = A.scapi(), "plan:" + vid, []
    for e in (A.load(key).get("elements") or []):
        if e.get("kind") != "scene" or not (e.get("stage") or {}).get("work"):
            continue
        H = S.history(A, key, e["id"], 400)
        gone = {h.get("undoes") for h in H if h.get("kind") == "undo"}
        for h in reversed([h for h in H if h.get("run") == run and h.get("kind") != "undo" and h.get("undo") and h.get("batch") not in gone]):
            S.apply(A, key, e["id"], h["undo"], by="author", desc="↺ отмена агента: " + (h.get("desc") or ""), kind="undo", undoes=h.get("batch"))
            done.append(h.get("desc"))
    jp = os.path.join(AGENT_DIR, "runs", run + ".jsonl")
    if os.path.isfile(jp):
        recs = [json.loads(ln) for ln in open(jp, encoding="utf-8") if ln.strip()]
        for r in reversed(recs):
            A.apply_ops(r["key"], r["inverse"])
            done.append(r.get("desc") or "правка видео")
        os.replace(jp, jp + ".undone")
    s = SESS.get(vid)
    if s:
        s.add("note", f"↺ отменено: {len(done)} " + ("правка" if len(done) == 1 else "правок"), undone=run)
    return done


# ---------------------------------------------------------------- HTTP
def get_session(A, vid, model, mode):
    s = SESS.get(vid)
    if s and s.alive() and s.model == model and s.mode == mode and getattr(s, "rules", 0) == RULES_REV:
        return s
    if s:
        if s.busy:
            raise RuntimeError("агент ещё работает — дождись или останови")
        s.close()
    s = SESS[vid] = Session(A, vid, model, mode)
    s.add("note", f"новая сессия · {model}" + (" · ✨ сборка" if mode == "build" else ""))
    return s


def reap():
    for vid, s in list(SESS.items()):
        if not s.busy and time.time() - s.last > IDLE_MIN * 60:
            s.close()
            SESS.pop(vid, None)


def state(A, vid, since=0):
    s = SESS.get(vid)
    if s:
        ents = [e for e in s.entries if e["i"] > since]
        return {"entries": ents, "busy": s.busy, "run": s.run, "model": s.model, "mode": s.mode, "alive": s.alive()}
    ents = []
    try:
        for ln in open(log_path(vid), encoding="utf-8"):
            try:
                e = json.loads(ln)
                if e["i"] > since:
                    ents.append(e)
            except ValueError:
                pass
    except OSError:
        pass
    return {"entries": ents[-300:], "busy": False, "run": None, "alive": False}


def handle_get(A, h, p, q):
    if p == "/api/agent":
        reap()
        h._json(state(A, (q.get("video") or [""])[0], int((q.get("since") or ["0"])[0] or 0))); return True
    return False


def handle_post(A, h, p, body):
    vid = body.get("video", "")
    if not vid or not P.video(vid):
        raise ValueError("нет такого видео")
    if p == "/api/agent/say":
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("пустое сообщение")
        s = SESS.get(vid)
        model = body.get("model") or (s.model if s else "sonnet")
        mode = body.get("mode") or "chat"
        if s and s.busy and s.alive():                    # посреди работы: в ту же сессию, тем же запуском
            s.say(text, body.get("ctx"))
        else:
            s = get_session(A, vid, A.VISUAL_MODEL if model == "opus" else A.TEXT_MODEL if model == "sonnet" else model, mode)
            s.say(text, body.get("ctx"))
        h._json({"ok": True, "run": s.run}); return True
    if p == "/api/agent/stop":
        s = SESS.get(vid)
        if s:
            s.stop()
        h._json({"ok": True}); return True
    if p == "/api/agent/undo":
        h._json({"done": undo_run(A, vid, body.get("run", ""))}); return True
    if p == "/api/agent/reset":                         # новая сессия (забыть разговор)
        s = SESS.pop(vid, None)
        if s:
            if s.busy:
                SESS[vid] = s
                raise RuntimeError("агент ещё работает — сначала останови")
            s.close()
        h._json({"ok": True}); return True
    return False
