"""Сцены редактора (S1 Claude Studio): документ scene.json, операции с отменой, история, authored, версии, клип, задачи Claude.

ideas_api.py перезагружает этот модуль при изменении файла (как sounds.py). Формат — _pipeline/docs/studio/architecture.md §3.3–3.5, §5;
ТЗ этапа — _pipeline/docs/studio/stage1-editor.md.

Рабочая копия сцены элемента препродакшена: _ideas/render/<plan>/<el>/work/
    scene.json     — документ (rev, правится только операциями)
    prefabs.js     — код предметов (пишет Claude)
    history.jsonl  — одна строка = одна пачка {ts, by, desc, ops, undo, rev, batch}
    clip.mp4       — «🎞 клип сцены»
Версии: _ideas/render/<plan>/<el>/v<N>/ = scene.json + prefabs.js + кадры element*.png, запись в renders[] элемента (stage: true).

Операции (как apply_op в ideas_api, пути через id в списках) + unset:
    set {path, value} | unset {path} | add {path, item, at} | del {path, id} | move {path, id, to}
Каждая пачка получает обратную (undo) — отмена = применить undo новой пачкой. Правка агента — одна пачка.
authored: {цель: [подпути]} — что автор трогал руками (цель — id объекта, света, ключа, маркера или 'camera').
Операции Claude по этим путям отклоняются, если в задании нет allow: ['o7.keys.pos', …].

HTTP (ideas_api.handle_get / handle_post передают сюда всё, что начинается с /api/scene):
    GET  /api/scene?key=plan:ID&el=EL          -> {scene, rev, base, work, history[-40:], prefabs: url, stage: url}
    GET  /api/scene/rev?key=…&el=…             -> {rev, locked}
    POST /api/scene/op      {key, el, base, ops, desc, batch, by}   -> {rev, prev, undo, batch}
    POST /api/scene/version {key, el, note}                          -> {job}  (снапшот v<N> + кадры + renders[])
    POST /api/scene/clip    {key, el}                                -> {job}  (work/clip.mp4)
    POST /api/scene/convert {key, el, base}                          -> {job}  (Claude, Opus: element.js -> prefabs.js + scene.json)
    POST /api/scene/agent   {key, el, ask, t, sel, model}            -> {job}  (Claude: одна просьба -> одна пачка)
"""
import copy, json, os, re, shutil, subprocess, sys, threading, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
import paths as P  # noqa: E402  где что лежит (Claude Studio)
SCHEMA_PATH = os.path.join(P.ENGINE, "scene.schema.json")
LIM = {"xz": 12, "y0": -2, "y1": 6, "s0": 0.25, "s1": 4}      # «разумные пределы» — как в стенде: предупреждение, а не запрет
LOCKS = globals().get("LOCKS") or {}                           # scene key -> job id (агент работает — редактор только смотрит)
_lock = globals().get("_lock") or threading.RLock()


def new_id(prefix=""):
    return prefix + uuid.uuid4().hex[:6]


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- where
def work_dir(A, pid, el):
    if not re.fullmatch(r"[a-z0-9-]{3,40}", pid or "") or not re.fullmatch(r"e[0-9a-f]{4,12}", el or ""):
        raise ValueError("плохой ключ сцены")
    return os.path.join(P.render(pid), el, "work")


def skey(key, el):
    return f"scene:{key[5:]}/{el}"


def _pid(key):
    if not (key or "").startswith("plan:"):
        raise ValueError("нужен key=plan:<id>")
    return key[5:]


def scene_path(A, key, el):
    return os.path.join(work_dir(A, _pid(key), el), "scene.json")


def exists(A, key, el):
    return os.path.isfile(scene_path(A, key, el))


def load_scene(A, key, el):
    with open(scene_path(A, key, el), encoding="utf-8") as f:
        return json.load(f)


def save_scene(A, key, el, doc):
    p = scene_path(A, key, el)
    A.write_text(p, json.dumps(doc, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- schema (подмножество JSON Schema: type, required, properties, items, enum, const, min/max, $ref)
_schema = globals().get("_schema") or {}


def schema():
    m = os.path.getmtime(SCHEMA_PATH)
    if _schema.get("m") != m:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            _schema.update(m=m, s=json.load(f))
    return _schema["s"]


_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def _is(v, t):
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    return isinstance(v, _TYPES[t])


def validate(v, s=None, path="scene", root=None, errs=None):
    root = root or schema()
    s = root if s is None else s
    errs = [] if errs is None else errs
    if "$ref" in s:
        s = root["definitions"][s["$ref"].split("/")[-1]]
    if "type" in s:
        ts = s["type"] if isinstance(s["type"], list) else [s["type"]]
        if not any(_is(v, t) for t in ts):
            errs.append(f"{path}: ждали {'/'.join(ts)}"); return errs
    if "const" in s and v != s["const"]:
        errs.append(f"{path}: должно быть {s['const']}")
    if "enum" in s and v not in s["enum"]:
        errs.append(f"{path}: одно из {', '.join(map(str, s['enum']))}")
    if _is(v, "number"):
        if "minimum" in s and v < s["minimum"]:
            errs.append(f"{path}: меньше {s['minimum']}")
        if "maximum" in s and v > s["maximum"]:
            errs.append(f"{path}: больше {s['maximum']}")
    if isinstance(v, dict):
        for k in s.get("required", []):
            if k not in v:
                errs.append(f"{path}: нет поля {k}")
        for k, sub in (s.get("properties") or {}).items():
            if k in v:
                validate(v[k], sub, f"{path}.{k}", root, errs)
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]:
            errs.append(f"{path}: меньше {s['minItems']} элементов")
        if "maxItems" in s and len(v) > s["maxItems"]:
            errs.append(f"{path}: больше {s['maxItems']} элементов")
        if "items" in s:
            for i, x in enumerate(v):
                validate(x, s["items"], f"{path}[{x.get('id', i) if isinstance(x, dict) else i}]", root, errs)
    return errs


def check_ids(doc):
    """ids unique across objects / lights / keys / markers…; parents exist; no parent cycles."""
    errs, seen = [], set()

    def walk(x):
        if isinstance(x, dict):
            i = x.get("id")
            if isinstance(i, str):
                if i in seen:
                    errs.append(f"повтор id {i}")
                seen.add(i)
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    for k in ("objects", "lights", "camera", "markers", "sounds", "comments"):
        walk(doc.get(k))
    objs = {o.get("id"): o for o in doc.get("objects") or []}
    for o in objs.values():
        p, n = o.get("parent"), 0
        if p and p not in objs:
            errs.append(f"{o.get('name')}: нет группы {p}")
        while p and n < 50:
            if p == o.get("id"):
                errs.append(f"{o.get('name')}: группа внутри самой себя"); break
            p, n = (objs.get(p) or {}).get("parent"), n + 1
        if o.get("parent") and objs.get(o["parent"], {}).get("type") != "group":
            errs.append(f"{o.get('name')}: родитель не группа")
    return errs


def limits(doc):
    """Warnings, not errors: things far outside the room or tiny / huge."""
    out = []
    for o in doc.get("objects") or []:
        vals = [o.get("pos")] + [k.get("v") for k in ((o.get("keys") or {}).get("pos") or [])]
        for p in vals:
            if isinstance(p, list) and len(p) == 3 and (abs(p[0]) > LIM["xz"] or abs(p[2]) > LIM["xz"] or p[1] < LIM["y0"] or p[1] > LIM["y1"]):
                out.append(f"«{o.get('name')}» далеко: {[round(x, 2) for x in p]}"); break
        s = o.get("scale")
        for x in (s if isinstance(s, list) else [s]):
            if isinstance(x, (int, float)) and not (LIM["s0"] <= x <= LIM["s1"]):
                out.append(f"«{o.get('name')}» размер ×{x}"); break
    return out


# ---------------------------------------------------------------- operations with undo
def _resolve(doc, path, create):
    cur = doc
    for k in path[:-1]:
        if isinstance(cur, list):
            nxt = next((it for it in cur if isinstance(it, dict) and it.get("id") == k), None)
        elif isinstance(cur, dict):
            nxt = cur.get(k)
            if nxt is None and create:
                nxt = cur[k] = {}
        else:
            nxt = None
        if nxt is None:
            return None, None
        cur = nxt
    last = path[-1]
    if isinstance(cur, list):
        idx = next((i for i, it in enumerate(cur) if isinstance(it, dict) and it.get("id") == last), None)
        return (cur, idx) if idx is not None else (None, None)
    return (cur, last) if isinstance(cur, dict) else (None, None)


_MISSING = object()


def apply_one(doc, op):
    """Apply one op in place and return its inverse (a list of ops) or None if it did nothing. Mirrors web/editor/ops.js."""
    kind, path = op.get("op"), [str(p) for p in (op.get("path") or [])]
    if not path or path[0] in ("rev", "schema"):
        return None
    if kind in ("set", "unset"):
        c, k = _resolve(doc, path, kind == "set")
        if c is None:
            return None
        old = c[k] if (isinstance(c, list) or k in c) else _MISSING
        if kind == "set":
            c[k] = copy.deepcopy(op.get("value"))
        elif old is not _MISSING and isinstance(c, dict):
            del c[k]
        else:
            return None
        return [{"op": "unset", "path": path}] if old is _MISSING else [{"op": "set", "path": path, "value": old}]
    c, k = _resolve(doc, path, True)
    if not isinstance(c, dict) and not isinstance(c, list):
        return None
    lst = c[k] if isinstance(c, list) else c.get(k)
    if not isinstance(lst, list):
        if isinstance(c, list):
            return None
        lst = c[k] = []
    if kind == "add":
        item = copy.deepcopy(op.get("item"))
        if isinstance(item, dict):
            item.setdefault("id", new_id("x"))
            op["item"] = item                      # the id is now fixed: redo adds the same thing
        at = op.get("at")
        i = len(lst) if at is None else max(0, min(len(lst), int(at)))
        lst.insert(i, item)
        return [{"op": "del", "path": path, "id": item.get("id")}] if isinstance(item, dict) else None
    i = next((i for i, it in enumerate(lst) if isinstance(it, dict) and it.get("id") == op.get("id")), None)
    if i is None:
        return None
    if kind == "del":
        it = lst.pop(i)
        return [{"op": "add", "path": path, "item": it, "at": i}]
    if kind == "move":
        it = lst.pop(i)
        to = max(0, min(len(lst), int(op.get("to", 0))))
        lst.insert(to, it)
        return [{"op": "move", "path": path, "id": it.get("id"), "to": i}]
    return None


def apply_batch(doc, ops):
    """-> (applied ops, undo ops). Undo is in reverse order."""
    done, undo = [], []
    for op in ops:
        if not isinstance(op, dict):
            continue
        inv = apply_one(doc, op)
        if inv is not None:
            done.append(op)
            undo[:0] = inv
    return done, undo


# ---------------------------------------------------------------- authored
def target_of(path):
    """(target, subpath) of an op path: ['objects', 'o7', 'keys', 'pos', 'k5', 't'] -> ('o7', 'keys.pos')."""
    p = [str(x) for x in path]
    if not p:
        return None, None
    if p[0] == "camera":
        return "camera", (p[1] if len(p) > 1 else "*")
    if p[0] in ("objects", "lights") and len(p) > 1:
        rest = p[2:]
        if not rest:
            return p[1], "*"
        if rest[0] == "keys" and len(rest) > 1:
            return p[1], "keys." + rest[1]
        return p[1], rest[0]
    if p[0] in ("markers", "sounds", "comments") and len(p) > 1:
        return p[1], (p[2] if len(p) > 2 else "*")
    return p[0], "*"


def op_targets(op):
    t, sub = target_of(op.get("path") or [])
    path = [str(x) for x in op.get("path") or []]
    if op.get("op") in ("add", "del", "move") and len(path) == 1 and path[0] in ("objects", "lights", "markers", "sounds"):
        iid = (op.get("item") or {}).get("id") if op.get("op") == "add" else op.get("id")
        return [(iid, "*")] if iid else []
    if op.get("op") in ("add", "del", "move") and path[:2] == ["camera", "keys"]:
        return [("camera", "keys")]
    return [(t, sub)] if t else []


def mark_authored(doc, ops):
    A = doc.setdefault("authored", {})
    for op in ops:
        for t, sub in op_targets(op):
            if op.get("op") == "del" and sub == "*":
                A.pop(t, None); continue
            lst = A.setdefault(t, [])
            if sub not in lst and "*" not in lst:
                lst.append(sub)


def authored_conflicts(doc, ops, allow=()):
    A, allow = doc.get("authored") or {}, set(allow or ())
    bad = []
    for op in ops:
        for t, sub in op_targets(op):
            got = A.get(t) or []
            if not got:
                continue
            if sub == "*" and op.get("op") == "del":
                hit = True                                  # deleting something the author touched
            else:
                hit = "*" in got or sub in got or (sub == "*" and bool(got))
            if hit and f"{t}.{sub}" not in allow and f"{t}.*" not in allow and "*" not in allow:
                bad.append(f"{t}.{sub}")
    return sorted(set(bad))


# ---------------------------------------------------------------- history
def hist_path(A, key, el):
    return os.path.join(work_dir(A, _pid(key), el), "history.jsonl")


def history(A, key, el, n=40):
    p = hist_path(A, key, el)
    if not os.path.isfile(p):
        return []
    with open(p, encoding="utf-8") as f:
        lines = f.readlines()[-n:]
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


def _log(A, key, el, rec):
    with open(hist_path(A, key, el), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _agent_run():
    try:
        import agent
        return agent.current_run()
    except Exception:
        return None


def apply(A, key, el, ops, by="author", desc="", batch=None, allow=(), kind="edit", undoes=None, prefabs=None):
    """One batch under the lock: apply, validate (schema + ids), authored, rev, history. -> {rev, prev, undo, batch, warn}."""
    if not isinstance(ops, list) or not ops:
        raise ValueError("нет операций")
    with _lock, A.FileLock():
        doc = load_scene(A, key, el)
        if by == "claude":
            bad = authored_conflicts(doc, ops, allow)
            if bad:
                raise ValueError("это автор правил руками, без прямой просьбы не трогаю: " + ", ".join(bad))
        prev = doc.get("rev", 0)
        work = copy.deepcopy(doc)
        done, undo = apply_batch(work, ops)
        if not done:
            return {"rev": prev, "prev": prev, "undo": [], "batch": batch, "warn": ["ничего не изменилось"]}
        errs = validate(work) + check_ids(work)
        if errs:
            raise ValueError("сцена не прошла проверку: " + "; ".join(errs[:6]))
        if by == "author" and kind != "undo":
            mark_authored(work, done)
        work["rev"] = prev + 1
        work["updated"] = now_ms()
        save_scene(A, key, el, work)
        batch = batch or new_id("b")
        if undoes:                                          # undoing a batch that changed the look: the code comes back too
            prev_b = next((h_ for h_ in reversed(history(A, key, el, 400)) if h_.get("batch") == undoes and h_.get("prefabs")), None)
            if prev_b and os.path.isfile(prev_b["prefabs"]):
                cur = os.path.join(work_dir(A, _pid(key), el), "prefabs.js")
                keep = os.path.join(work_dir(A, _pid(key), el), "_prefabs", f"{batch or 'undo'}-{now_ms()}.js")
                shutil.copy2(cur, keep); shutil.copy2(prev_b["prefabs"], cur)
                prefabs = keep                                  # and redo of this undo brings the new look back
        run = _agent_run() if by == "claude" else None      # S7: пачка агента помнит свой запуск — «↺ отменить» откатит его целиком
        _log(A, key, el, {"ts": now_ms(), "by": by, "desc": (desc or "правка")[:300], "ops": done, "undo": undo, "rev": work["rev"], "batch": batch, "kind": kind,
                              **({"run": run} if run else {}),
                              **({"undoes": undoes} if undoes else {}), **({"prefabs": prefabs} if prefabs else {})})
        return {"rev": work["rev"], "prev": prev, "undo": undo, "ops": done, "batch": batch, "warn": limits(work)}


# ---------------------------------------------------------------- prefabs.js: what things there are and their parameters
def props3d_choices(A, key, plan):
    """Чем можно заменить предмет сцены (S3): 3D-пропсы этого видео (el:<id>@v<N>, выбранная версия) и библиотеки канала (lib:props/<slug>@<N>)."""
    pid = _pid(key)
    out = []
    for x in plan.get("elements") or []:
        rs = [r for r in x.get("renders") or [] if r.get("three3")]
        if x.get("kind") != "prop" or not rs or x.get("status") == "drop":
            continue
        r = next((y for y in rs if y.get("id") == x.get("render")), rs[-1])
        out.append({"ref": f"el:{x['id']}@v{r['v']}", "name": x.get("name", ""), "img": "/" + r["img"] if r.get("img") else "",
                    "from": "видео" + (" ✓" if x.get("status") == "ok" else ""), "h": r.get("h")})
    ch = P.index()["videos"].get(pid, {}).get("channel")
    try:
        c = A.stapi().channel_dir(ch)
        ld = A.stapi().lib_dir(c)
        for it in A.stapi().lib_index(c):
            if it.get("kind") != "props":
                continue
            try:
                card = json.load(open(os.path.join(ld, *it["id"].split("/"), "prop.json"), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            v3 = [v for v in card.get("versions") or [] if v.get("dim") == "3d"]
            if v3:
                v = v3[-1]
                out.append({"ref": f"lib:{it['id']}@{v['v']}", "name": it.get("name", ""), "from": "библиотека",
                            "img": f"/api/lib/file/{c['id']}/{it['id']}/{v['preview']}" if v.get("preview") else ""})
    except Exception as e:
        print("! props3d_choices:", e)
    return out


def props_rev(A, key, doc):
    """Время правки файлов 3D-пропсов и персонажей сцены (lib: / el:) — агент поправил prefab.js / модель версии -> редактор перезагружает страницу."""
    pid = _pid(key)
    dirs = set()
    for o in doc.get("objects") or []:
        ref = (o.get("src") or {}).get("prefab") or ""
        m = re.match(r"^lib:([a-z]+)/([a-z0-9-]+)@(\d+)$", ref)
        if m:
            try:
                c = A.stapi().channel_dir(P.index()["videos"].get(pid, {}).get("channel"))
                dirs.add(os.path.join(A.stapi().lib_dir(c), m.group(1), m.group(2), "v" + m.group(3)))
            except Exception:
                pass
            continue
        m = re.match(r"^el:([A-Za-z0-9_-]+)@v?(\d+)$", ref)
        if m:
            dirs.add(P.resolve(f"render/{pid}/{m.group(1)}/v{m.group(2)}"))
    best = 0
    for d in dirs:
        for sub in ("", "costumes"):
            try:
                for f in os.scandir(os.path.join(d, sub)):
                    if f.is_file() and f.name.endswith((".js", ".json", ".glb")):
                        best = max(best, int(f.stat().st_mtime * 1000))
            except OSError:
                pass
    return best


def ws_info(A, plan, e):
    """Служебная сцена мастерской (S10): ассет — элемент видео (его id, вид, версия, откуда из библиотеки)."""
    w = e.get("ws")
    if not w:
        return None
    a = A._by_id(plan.get("elements"), w.get("el")) or {}
    rs = a.get("renders") or []
    r = next((x for x in rs if x.get("id") == a.get("render")), rs[-1] if rs else {}) or {}
    return {"asset": a.get("id"), "name": a.get("name", ""), "kind": a.get("kind"), "lib": a.get("lib"), "v": r.get("v"), "skeleton": r.get("fn") if r.get("rigchar") else None,
            "model3d": bool(r.get("model3d")), "rigchar": bool(r.get("rigchar")), "service": plan.get("service")}


def prefabs_rev(A, key, el):
    """Время правки prefabs.js рабочей копии (агент или автор поменяли вид предметов -> редактор перезагружает страницу)."""
    try:
        return int(os.path.getmtime(os.path.join(work_dir(A, _pid(key), el), "prefabs.js")) * 1000)
    except OSError:
        return 0


def chars3d_choices(A, key, plan):
    """Кого можно поставить в сцену (＋ Добавить): персонажи этого видео со скелетом (el:<id>@v<N>, выбранная версия) и персонажи библиотеки канала (lib:characters/<slug>@<N>)."""
    pid = _pid(key)
    out = []
    for x in plan.get("elements") or []:
        rs = [r for r in x.get("renders") or [] if r.get("rigchar")]
        if x.get("kind") != "char" or not rs or x.get("status") == "drop":
            continue
        r = next((y for y in rs if y.get("id") == x.get("render")), rs[-1])
        out.append({"ref": f"el:{x['id']}@v{r['v']}", "el": x["id"], "name": x.get("name", ""), "img": "/" + r["img"] if r.get("img") else "",
                    "from": "видео" + (" ✓" if x.get("status") == "ok" else "") + (" · 3D" if r.get("model3d") else "")})
    ch = P.index()["videos"].get(pid, {}).get("channel")
    try:
        c = A.stapi().channel_dir(ch)
        ld = A.stapi().lib_dir(c)
        for it in A.stapi().lib_index(c):
            if it.get("kind") != "characters":
                continue
            try:
                card = json.load(open(os.path.join(ld, *it["id"].split("/"), "character.json"), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            vs = [v for v in card.get("versions") or [] if v.get("rig") or "prefab.js" in (v.get("files") or [])]
            if vs:
                v = vs[-1]
                out.append({"ref": f"lib:{it['id']}@{v['v']}", "name": it.get("name", ""), "from": "библиотека",
                            "img": f"/api/lib/file/{c['id']}/{it['id']}/{v['preview']}" if v.get("preview") else ""})
    except Exception as e:
        print("! chars3d_choices:", e)
    return out


def prefab_info(path):
    """{key: {kind, note, params: {name: default}}} from prefabs.js: entries «  key: { kind: '…'» of PREFABS, the comment lines above
    an entry are its note, P_(o, 'name', default) / o.params.name inside it are its parameters."""
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return {}
    i = src.find("const PREFABS")
    if i < 0:
        return {}
    lines, out, cur, note = src[i:].splitlines(), {}, None, []
    for ln in lines[1:]:
        m = re.match(r"^  (\w+):\s*\{\s*kind:\s*'(\w+)'", ln)
        if m:
            cur = out[m.group(1)] = {"kind": m.group(2), "note": " ".join(note)[:240], "params": {}}
            note = []
        elif re.match(r"^  //", ln):
            note.append(ln.strip()[2:].strip().lstrip("-").strip())
        elif re.match(r"^};", ln):
            break
        if cur is not None:
            for pm in re.finditer(r"P_\(o,\s*'(\w+)',\s*([^)]+?)\)", ln):
                d = pm.group(2).strip()
                try:
                    d = json.loads(d.replace("'", '"'))
                except ValueError:
                    pass
                cur["params"].setdefault(pm.group(1), d)
    return out


# ---------------------------------------------------------------- element links, versions
def element(A, key, el):
    e = A._by_id(A.load(key).get("elements"), el)
    if not e:
        raise ValueError("элемент не найден")
    return e


def stage_url(port, rel):
    return f"http://127.0.0.1:{port}/tpl/stand3d.html?stage=/rscene/{rel}/scene.json&parts=element"


def shoot(A, key, url, wd, ts="0.6,2.5"):
    r = subprocess.run(["node", os.path.join(P.STANDS, "render_shot.js"), url, wd, ts], cwd=P.STANDS, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return r.stdout + r.stderr


def version(A, job):
    """💾 версия: work/ -> v<N>/ (scene.json + prefabs.js) + кадры + renders[] элемента."""
    key, el = job.key, job.params.get("el")
    pid, e = _pid(key), element(A, key, el)
    wd0 = work_dir(A, pid, el)
    if not os.path.isfile(os.path.join(wd0, "scene.json")):
        raise ValueError("у сцены нет рабочей копии")
    rs = e.get("renders") or []
    v = max([r.get("v", 0) for r in rs] + [0]) + 1
    rel = f"{pid}/{el}/v{v}"
    wd = os.path.join(P.render(pid), el, f"v{v}")
    os.makedirs(wd, exist_ok=True)
    doc = load_scene(A, key, el)
    for f in ("scene.json", "prefabs.js"):
        shutil.copy2(os.path.join(wd0, f), os.path.join(wd, f))
    job.summary = "снимаю кадры версии…"
    ln = float(doc.get("len") or 6)
    ts = ",".join(str(round(x, 2)) for x in (0.6, ln * 0.35, ln * 0.7, max(0.1, ln - 0.5)))
    out = shoot(A, key, stage_url(A._docs(key)["port"], rel), wd, ts)
    main = os.path.join(wd, "element.png")
    if not os.path.isfile(main):
        raise RuntimeError("кадр не снялся: " + out.strip()[-300:])
    img = A.save_file(pid, open(main, "rb").read())
    extra = [A.save_file(pid, open(os.path.join(wd, f), "rb").read()) for f in sorted(os.listdir(wd), key=lambda f: float((re.search(r"_([\d.]+)\.png$", f) or [0, 0])[1]))
             if f.startswith("element_") and f.endswith(".png")]
    note = (job.params.get("note") or "").strip()
    hist = history(A, key, el, 400)
    since = [h for h in hist if h.get("ts", 0) > (e.get("stage") or {}).get("saved", 0) and h.get("kind") != "version"]
    what = "; ".join(dict.fromkeys(h.get("desc", "") for h in since if h.get("desc")))[:600]
    item = {"id": A.new_id("r"), "v": v, "dir": rel, "img": img, "extra": extra, "three": True, "stage": True, "scene": f"v{v}/scene.json",
            "feedback": "🎬 редактор: " + (note or what or "версия сцены"), "fx": {}, "by": job.params.get("by") or "editor", "rev": doc.get("rev", 0), "ts": now_ms()}
    A.apply_ops(key, [{"op": "add", "path": ["elements", el, "renders"], "item": item}, {"op": "set", "path": ["elements", el, "render"], "value": item["id"]},
                      {"op": "set", "path": ["elements", el, "stage", "saved"], "value": now_ms()}, {"op": "set", "path": ["elements", el, "stage", "v"], "value": v}])
    _log(A, key, el, {"ts": now_ms(), "by": item["by"], "desc": f"💾 версия v{v}" + (f": {note}" if note else ""), "ops": [], "undo": [], "rev": doc.get("rev", 0), "kind": "version"})
    job.result = item
    job.summary = f"«{e.get('name', '')}» v{v}: версия сцены сохранена" + (" · есть ошибки страницы" if "[pageerror]" in out else "")


def sound_cues(A, key, doc):
    """scene.sounds -> [{file, url, t, gain, name}]: 'el:<id>' — the chosen layers of a sound element of the plan, 'lib:<id>' — the pipeline library."""
    plan, out = A.load(key), []
    for s in doc.get("sounds") or []:
        src, t, g = str(s.get("src") or ""), float(s.get("t") or 0), float(1 if s.get("gain") is None else s.get("gain"))
        if src.startswith("el:"):
            e = A._by_id(plan.get("elements"), src[3:])
            for m in (A.pr().el_mix(e) if e else []):
                f = P.resolve(m["s"]["file"])
                out.append({"id": s.get("id"), "file": f, "url": "/" + m["s"]["file"], "t": t + m["at"], "gain": g * m["gain"], "name": e.get("name", "")})
        elif src.startswith("file:"):                        # свой файл сцены (work/sounds/…): тестовая фраза для липсинка и т. п.
            rel = src[5:]
            f = os.path.join(work_dir(A, _pid(key), doc.get("_el") or ""), *rel.split("/")) if doc.get("_el") else ""
            if f and os.path.isfile(f):
                out.append({"id": s.get("id"), "file": f, "url": f"/rscene/{_pid(key)}/{doc['_el']}/work/{rel}", "t": t, "gain": g, "name": s.get("note") or rel})
        elif src.startswith("lib:"):
            rel = src[4:].split("|")[0]
            f = os.path.join(P.SFXLIB, *rel.split("/")) + ".wav"
            if os.path.isfile(f):
                out.append({"id": s.get("id"), "file": f, "url": f"/sfxlib/{rel}.wav", "t": t, "gain": g, "name": rel})
    return out


_ENV = {}


def envelope(path):
    """Громкость звука окнами 1/30 с (RMS), нормирована на 95-й перцентиль — для липсинка (S5). Кэш по времени файла."""
    import numpy as np
    m = os.path.getmtime(path)
    if _ENV.get(path, (0,))[0] == m:
        return _ENV[path][1]
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True, timeout=120)
    x = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768
    hop = 16000 // 30
    n = max(1, len(x) // hop)
    rms = np.sqrt(np.array([np.mean(x[i * hop:(i + 1) * hop] ** 2) if (i + 1) * hop <= len(x) else 0 for i in range(n)]) + 1e-12)
    ref = float(np.percentile(rms, 95)) or 1
    env = [round(float(min(1, v / ref)), 3) for v in rms]
    _ENV[path] = (m, env)
    return env


def say(A, key, el, text, voice="ru-RU-DmitryNeural", rate="+20%"):
    """Тестовая фраза голосом (edge-tts) -> work/sounds/say-<ts>.wav: звук сцены для проверки липсинка до настоящего голоса (S5)."""
    import asyncio, edge_tts
    wd = work_dir(A, _pid(key), el)
    os.makedirs(os.path.join(wd, "sounds"), exist_ok=True)
    name = f"say-{now_ms()}"
    mp3, wav = os.path.join(wd, "sounds", name + ".mp3"), os.path.join(wd, "sounds", name + ".wav")
    asyncio.run(edge_tts.Communicate(text, voice, rate=rate).save(mp3))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-ac", "1", "-ar", "44100", wav], capture_output=True, timeout=120)
    os.remove(mp3)
    return f"sounds/{name}.wav"


def clip(A, job):
    """🎞 клип сцены: кадры стенда -> work/clip.mp4 (render_clip.js)."""
    key, el = job.key, job.params.get("el")
    pid = _pid(key)
    wd = work_dir(A, pid, el)
    doc = load_scene(A, key, el)
    rel = f"{pid}/{el}/work"
    url = stage_url(A._docs(key)["port"], rel)
    out = os.path.join(wd, "clip.mp4")
    job.summary = "снимаю кадры клипа…"
    doc["_el"] = el
    cues = [c for c in sound_cues(A, key, doc) if os.path.isfile(c["file"])]
    sj = os.path.join(wd, "_clip_sounds.json")
    A.write_text(sj, json.dumps(cues, ensure_ascii=False))
    p = subprocess.Popen(["node", os.path.join(P.STANDS, "render_clip.js"), url, out, str(doc.get("len") or 6), str(doc.get("fps") or 30), sj], cwd=P.STANDS,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    job.proc = p
    tail = []
    for ln in p.stdout:
        ln = ln.strip()
        tail = (tail + [ln])[-12:]
        m = re.match(r"progress (\d+)/(\d+)", ln)
        if m:
            job.summary = f"кадры клипа: {m.group(1)} / {m.group(2)}"
        elif ln.startswith("encode"):
            job.summary = "собираю mp4…"
    p.wait()
    if job.cancelled:
        raise RuntimeError("отменено")
    if p.returncode or not os.path.isfile(out):
        raise RuntimeError("клип не собрался: " + " | ".join(tail)[-400:])
    job.result = {"file": f"render/{rel}/clip.mp4", "url": f"/rscene/{rel}/clip.mp4"}
    A.apply_ops(key, [{"op": "set", "path": ["elements", el, "stage", "clip"], "value": {"file": job.result["file"], "ts": now_ms(), "rev": doc.get("rev", 0)}}])
    job.summary = f"Клип сцены готов: {doc.get('len')} с"


# ---------------------------------------------------------------- Claude: convert / agent
def convert(A, job):
    """Перевести старый 3D-черновик (element.js + расстановка) в редактор: Claude (Opus) пишет work/prefabs.js + work/scene.json,
    сам сравнивает кадры «было / стало» (scene_diff.py), до 3 проходов. Потом сервер проверяет ещё раз."""
    key, el = job.key, job.params.get("el")
    pid, e = _pid(key), element(A, key, el)
    rs = e.get("renders") or []
    base = A._by_id(rs, job.params.get("base")) or A._by_id(rs, e.get("render")) or (rs[-1] if rs else None)
    if not base or not base.get("three") or base.get("stage"):
        raise ValueError("нужна 3D-версия старого формата (element.js)")
    wd = work_dir(A, pid, el)
    if os.path.isfile(os.path.join(wd, "scene.json")) and not job.params.get("force"):
        raise ValueError("сцена уже в редакторе")
    os.makedirs(wd, exist_ok=True)
    src = P.resolve("render/" + base["dir"])
    cmp_dir = os.path.join(wd, "_convert")
    os.makedirs(os.path.join(cmp_dir, "old"), exist_ok=True)
    port = A._docs(key)["port"]
    ln = 6.0
    m = re.search(r"len\s*:\s*([\d.]+)", open(os.path.join(src, "element.js"), encoding="utf-8").read())
    if m:
        ln = float(m.group(1))
    ts = ",".join(str(round(x, 2)) for x in (0.6, min(2.5, ln / 2), max(0.1, ln - 0.5)))
    job.summary = "снимаю кадры старой версии…"
    shoot(A, key, f"http://127.0.0.1:{port}/tpl/stand3d.html?scene=/rscene/{base['dir']}/element.js&parts=element", os.path.join(cmp_dir, "old"), ts)
    C = A.capi()
    spec = C.sceneconvert_spec(A._docs(key), e, base, {"src": src, "work": wd, "cmp": cmp_dir, "ts": ts, "port": port, "rel": f"{pid}/{el}/work",
                                                       "here": HERE, "len": ln})
    spec.setdefault("model", A.VISUAL_MODEL)
    spec.setdefault("timeout", 1800)
    job.summary = "Claude переводит сцену в редактор (5–10 мин)…"
    job.result = A.run_claude(job, spec)
    if not os.path.isfile(os.path.join(wd, "scene.json")) or not os.path.isfile(os.path.join(wd, "prefabs.js")):
        raise RuntimeError("Claude не записал scene.json и prefabs.js")
    doc = load_scene(A, key, el)
    errs = validate(doc) + check_ids(doc)
    if errs:
        raise RuntimeError("scene.json не прошёл проверку: " + "; ".join(errs[:5]))
    diff = finish_convert(A, key, el, base, cmp_dir, ts, port)
    job.summary = (f"Сцена в редакторе: {len(doc.get('objects') or [])} объектов · кадры " + ("похожи ✓" if diff.get("ok") else "отличаются — посмотри «было / стало»"))


def finish_convert(A, key, el, base, cmp_dir, ts, port, by="claude"):
    """After a conversion: shoot the new scene, diff against the old frames, mark the author's old layout as authored,
    write the first history line and e.stage."""
    pid = _pid(key)
    new = os.path.join(cmp_dir, "new")
    shutil.rmtree(new, ignore_errors=True)
    os.makedirs(new, exist_ok=True)
    shoot(A, key, stage_url(port, f"{pid}/{el}/work"), new, ts)
    sheet = os.path.join(cmp_dir, "compare.png")
    r = subprocess.run([sys.executable, os.path.join(P.STANDS, "scene_diff.py"), os.path.join(cmp_dir, "old"), new, "--out", sheet, "--json"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        diff = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        diff = {"ok": False, "error": (r.stdout + r.stderr)[-300:]}
    img = A.save_file(pid, open(sheet, "rb").read()) if os.path.isfile(sheet) else ""
    for f in diff.get("frames") or []:
        f.pop("old", None); f.pop("new", None)
    doc = load_scene(A, key, el)
    stage = {"work": f"{pid}/{el}/work", "from": base.get("id"), "fromV": base.get("v"), "diff": diff, "compare": img, "ts": now_ms(), "by": by}
    A.apply_ops(key, [{"op": "set", "path": ["elements", el, "stage"], "value": stage}])
    if not os.path.isfile(hist_path(A, key, el)):
        _log(A, key, el, {"ts": now_ms(), "by": by, "desc": f"перевод в редактор из v{base.get('v')}: {len(doc.get('objects') or [])} объектов", "ops": [], "undo": [],
                          "rev": doc.get("rev", 0), "kind": "convert"})
    return diff


def card_edit_params(e):
    """«Поправить» in the preproduction card for a scene in the editor: pins and notes -> one request to the scene agent (Opus)."""
    fx = (e.get("fx") or {}).get("main") or {}
    parts = [(fx.get("text") or "").strip()] + [(n.get("text") or "").strip() for n in fx.get("notes") or []]
    for i, p in enumerate(fx.get("pins") or [], 1):
        parts.append(f"пин {i} в кадре (x≈{round(float(p.get('x') or 0) * 1080)}, y≈{round(float(p.get('y') or 0) * 1920)} из 1080×1920 на моменте 0.6 с): {(p.get('text') or '').strip() or 'автор отметил это место'}")
    ask = "; ".join(x for x in parts if x)
    return {"el": e["id"], "ask": ask or "посмотри сцену и поправь, что выглядит не так", "t": 0.6, "sel": [], "model": "opus", "fromCard": True}


def agent(A, job):
    """💬 одна просьба -> одна пачка операций Claude (Sonnet / Opus). Сцена заблокирована, пока идёт задача."""
    key, el = job.key, job.params.get("el")
    sk = skey(key, el)
    LOCKS[sk] = job.id
    try:
        pid = _pid(key)
        wd = work_dir(A, pid, el)
        doc = load_scene(A, key, el)
        frame_dir = os.path.join(wd, "_agent")
        os.makedirs(frame_dir, exist_ok=True)
        t = float(job.params.get("t") or 0)
        job.summary = "смотрю кадр сцены…"
        for f in os.listdir(frame_dir):
            if f.endswith(".png"):
                os.remove(os.path.join(frame_dir, f))
        shoot(A, key, stage_url(A._docs(key)["port"], f"{pid}/{el}/work"), frame_dir, str(round(t, 2)))
        frame = os.path.join(frame_dir, f"element_{round(t, 2)}.png")
        C = A.capi()
        model = job.params.get("model")
        pf = os.path.join(wd, "prefabs.js")
        bak = os.path.join(wd, "_prefabs", f"{job.id}.js")
        os.makedirs(os.path.dirname(bak), exist_ok=True)
        shutil.copy2(pf, bak)                                    # Opus may change the look: keep the code as it was, for undo
        before = open(pf, encoding="utf-8").read()
        spec = C.sceneagent_spec(A._docs(key), element(A, key, el), doc, {"work": wd, "frame": frame if os.path.isfile(frame) else "", "t": t,
                                  "sel": job.params.get("sel") or [], "ask": job.params.get("ask") or "", "history": history(A, key, el, 25),
                                  "prefabs": model == "opus", "url": stage_url(A._docs(key)["port"], f"{pid}/{el}/work"), "check": os.path.join(wd, "_agent", "check")})
        spec["model"] = A.VISUAL_MODEL if model == "opus" else A.TEXT_MODEL
        job.summary = "Claude думает над сценой…"
        res = A.run_claude(job, spec)
        ops = [o for o in (res.get("ops") or []) if isinstance(o, dict)]
        # Claude may touch the author's own edits only for things the author picked or named in this very request
        ask = (job.params.get("ask") or "").lower().replace("ё", "е")
        names = {o["id"]: (o.get("name") or "").lower().replace("ё", "е") for o in (doc.get("objects") or []) + (doc.get("lights") or [])}
        sel = set(job.params.get("sel") or [])
        named = lambda i: i in sel or ("камер" in ask and i == "camera") or any(len(w) > 3 and w[:5] in ask for w in names.get(i, "").split())
        allow = [a for a in res.get("allow") or [] if isinstance(a, str) and named(a.split(".")[0])]
        out = {"reply": res.get("reply") or "", "desc": res.get("desc") or "", "rev": doc.get("rev", 0), "applied": False}
        changed = open(pf, encoding="utf-8").read() != before
        if ops or changed:
            desc = "💬 " + (res.get("desc") or job.params.get("ask") or "правка агента")
            if changed:                                          # the look changed: a marker op, so the batch is in the history and undo brings the code back
                ops = ops + [{"op": "set", "path": ["prefabsRev"], "value": job.id}]
                desc += " · вид предметов: " + (res.get("prefabs") or "prefabs.js")[:160]
            if not changed:
                os.remove(bak)
            r = apply(A, key, el, ops, by="claude", desc=desc, allow=allow, kind="agent", prefabs=bak if changed else None)
            out.update(applied=True, rev=r["rev"], batch=r["batch"], undo=r["undo"], ops=r["ops"], warn=r.get("warn"), prefabs=changed)
        else:
            os.remove(bak)
        if job.params.get("fromCard"):                           # from the card: the sent edits are done, and the result is a new version with frames
            A.apply_ops(key, [{"op": "set", "path": ["elements", el, "fx", "main"], "value": {}}])
            if out["applied"]:
                job.summary = "снимаю новую версию…"
                vj = A.Job("scenever", key, "scenever", {"el": el, "note": "💬 " + (out["desc"] or job.params.get("ask", ""))[:200], "by": "claude"})
                version(A, vj)
        chat = {"id": A.new_id("c"), "ask": job.params.get("ask") or "", "reply": out["reply"], "desc": out["desc"], "batch": out.get("batch"),
                "n": len(out.get("ops") or []), "ts": now_ms(), "model": model or "sonnet"}
        A.apply_ops(key, [{"op": "add", "path": ["elements", el, "stage", "chat"], "item": chat}])
        job.result = out
        job.summary = (out["desc"] or out["reply"] or "готово")[:200]
    finally:
        LOCKS.pop(sk, None)


# ---------------------------------------------------------------- HTTP
def _q1(q, k, d=""):
    return (q.get(k) or [d])[0]


def handle_get(A, h, p, q):
    key, el = _q1(q, "key"), _q1(q, "el")
    if p == "/api/scene":
        ver = _q1(q, "ver")
        if ver:                                                        # an old version, read-only
            if not re.fullmatch(r"\d{1,4}", ver):
                raise ValueError("плохая версия")
            rel = f"{_pid(key)}/{el}/v{ver}"
            f = os.path.join(P.resolve("render/" + rel), "scene.json")
            if not os.path.isfile(f):
                raise ValueError(f"у v{ver} нет scene.json (это версия старого формата)")
            doc = json.load(open(f, encoding="utf-8"))
        elif not exists(A, key, el):
            h._json({"error": "сцена ещё не в редакторе", "missing": True}, 404); return True
        else:
            doc = load_scene(A, key, el)
            rel = f"{_pid(key)}/{el}/work"
        plan = A.load(key)
        e = A._by_id(plan.get("elements"), el) or {}
        sounds = [{"id": x["id"], "name": x.get("name", ""), "ready": bool(A.pr().el_mix(x))} for x in plan.get("elements") or [] if x.get("kind") == "sound" and x.get("status") != "drop"]
        h._json({"scene": doc, "rev": doc.get("rev", 0), "work": rel, "prefabs": f"/rscene/{rel}/prefabs.js", "history": history(A, key, el, 60),
                 "locked": LOCKS.get(skey(key, el)), "limits": LIM, "cues": sound_cues(A, key, dict(doc, _el=el)), "soundEls": sounds,
                 "ws": ws_info(A, plan, e),
                 "element": {"id": el, "name": e.get("name", ""), "stage": e.get("stage") or {}, "plan": plan.get("name", ""), "v": (e.get("stage") or {}).get("v"),
                             "versions": [{"v": r.get("v"), "id": r.get("id"), "feedback": r.get("feedback", ""), "img": r.get("img", "")} for r in e.get("renders") or [] if r.get("stage")]},
                 "elNames": {x["id"]: x.get("name", "") for x in plan.get("elements") or []},
                 "prefabInfo": prefab_info(os.path.join(P.resolve("render/" + rel), "prefabs.js")),
                 "prefabsRev": prefabs_rev(A, key, el) if not ver else 0,
                 "propsRev": props_rev(A, key, doc) if not ver else 0,
                 "props3d": props3d_choices(A, key, plan),
                 "chars3d": chars3d_choices(A, key, plan),
                 "style3d": ((P.channel(P.index()["videos"].get(_pid(key), {}).get("channel")) or {}).get("style3d")) or "paper",
                 "clip": f"/rscene/{rel}/clip.mp4" if os.path.isfile(os.path.join(work_dir(A, _pid(key), el), "clip.mp4")) else ""})
        return True
    if p == "/api/scene/rev":
        rev = 0
        if exists(A, key, el):
            rev = A.rev_of(scene_path(A, key, el)) or 0
        h._json({"rev": rev, "locked": LOCKS.get(skey(key, el)), "prefabsRev": prefabs_rev(A, key, el),
                 "propsRev": props_rev(A, key, load_scene(A, key, el)) if exists(A, key, el) else 0}); return True
    if p == "/api/scene/cues":
        h._json({"cues": sound_cues(A, key, dict(load_scene(A, key, el), _el=el))}); return True
    if p == "/api/scene/env":                                       # липсинк (S5): громкость звука сцены по id — {t0, fps, env}
        key, el, sid = _q1(q, "key"), _q1(q, "el"), _q1(q, "sid")
        doc = load_scene(A, key, el)
        doc["_el"] = el
        cues = [c for c in sound_cues(A, key, doc) if c.get("id") == sid and os.path.isfile(c["file"])]
        if not cues:
            h._json({"error": "нет такого звука или файла"}, 404); return True
        c = cues[0]
        h._json({"sid": sid, "t0": c["t"], "fps": 30, "env": envelope(c["file"])}); return True
    if p == "/api/scene/sfxlib":                                    # the pipeline sound library for «+ звук»: search by words
        words = [w for w in _q1(q, "q").lower().split() if w]
        idx = os.path.join(P.SFXLIB, "index.json")
        rows = json.load(open(idx, encoding="utf-8")) if os.path.isfile(idx) else []
        rows = rows if isinstance(rows, list) else rows.get("sounds") or rows.get("items") or []
        hit = [r for r in rows if all(w in json.dumps(r, ensure_ascii=False).lower() for w in words)][:40]
        h._json({"items": hit}); return True
    if p == "/api/scene/history":
        h._json({"history": history(A, key, el, int(_q1(q, "n", "200")))}); return True
    return False


def handle_post(A, h, p, body):
    key, el = body.get("key", ""), body.get("el", "")
    if p == "/api/scene/say":                                       # тестовая фраза для липсинка: файл + звук сцены на моменте t
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("нет текста")
        rel = say(A, key, el, text, body.get("voice") or "ru-RU-DmitryNeural")
        sid = new_id("s")
        r = apply(A, key, el, [{"op": "add", "path": ["sounds"], "item": {"id": sid, "t": round(float(body.get("t") or 0), 3), "src": "file:" + rel, "gain": 1, "note": "🗣 " + text[:60]}}],
                  by="author", desc=f"тестовая фраза «{text[:40]}» на {float(body.get('t') or 0):.2f} с")
        h._json({"sid": sid, "rev": r["rev"], "src": "file:" + rel}); return True
    if p == "/api/scene/op":
        if LOCKS.get(skey(key, el)) and body.get("by", "author") == "author":
            h._json({"error": "Claude работает над сценой — подожди или отмени задачу", "locked": True}, 409); return True
        r = apply(A, key, el, body.get("ops"), by="author", desc=body.get("desc", ""), batch=body.get("batch"), kind=body.get("kind") or "edit",
                  undoes=body.get("undoes"))
        h._json(r); return True
    if p == "/api/scene/restore":                                   # a saved version becomes the working copy (one undoable batch)
        v = int(body.get("v") or 0)
        src = os.path.join(P.render(_pid(key)), el, f"v{v}")
        if not os.path.isfile(os.path.join(src, "scene.json")):
            raise ValueError(f"у v{v} нет scene.json")
        old = json.load(open(os.path.join(src, "scene.json"), encoding="utf-8"))
        wd = work_dir(A, _pid(key), el)
        if os.path.isfile(os.path.join(src, "prefabs.js")):
            shutil.copy2(os.path.join(src, "prefabs.js"), os.path.join(wd, "prefabs.js"))
        ops = [{"op": "set", "path": [k], "value": old[k]} for k in ("name", "len", "fps", "world", "camera", "lights", "objects", "sounds", "markers", "comments") if k in old]
        r = apply(A, key, el, ops, by="author", desc=f"↺ рабочая копия из v{v}", kind="restore")
        h._json(r); return True
    if p == "/api/scene/version":
        j = A.start_job("scenever", key, f"scenever:{el}", {"el": el, "note": body.get("note", ""), "by": body.get("by") or "editor"})
        h._json({"job": j.info()}); return True
    if p == "/api/scene/clip":
        j = A.start_job("sceneclip", key, f"sceneclip:{el}", {"el": el})
        h._json({"job": j.info()}); return True
    if p == "/api/scene/convert":
        j = A.start_job("sceneconvert", key, f"sceneconvert:{el}", {"el": el, "base": body.get("base"), "force": bool(body.get("force"))})
        h._json({"job": j.info()}); return True
    if p == "/api/scene/agent":
        if LOCKS.get(skey(key, el)):
            h._json({"error": "Claude уже работает над этой сценой"}, 409); return True
        j = A.start_job("sceneagent", key, f"sceneagent:{el}", {k: body.get(k) for k in ("el", "ask", "t", "sel", "model")})
        LOCKS[skey(key, el)] = j.id                    # lock right away: the page must not send edits before the job thread starts
        h._json({"job": j.info()}); return True
    return False


def run_job(A, job):
    if job.kind == "scenever":
        version(A, job)
    elif job.kind == "sceneclip":
        clip(A, job)
    elif job.kind == "sceneconvert":
        convert(A, job)
    elif job.kind == "sceneagent":
        try:
            agent(A, job)
        finally:
            LOCKS.pop(skey(job.key, job.params.get("el")), None)
    else:
        return False
    return True


# ---------------------------------------------------------------- CLI (python ideas_server.py scene …)
def cli(A, argv):
    """scene show PLAN EL | scene brief PLAN EL | scene frame PLAN EL t[,t2] | scene ops PLAN EL '<JSON>' --desc "…" [--by claude|author] | scene history PLAN EL [n]
    | scene undo PLAN EL | scene version PLAN EL ["заметка"] | scene clip PLAN EL | scene validate PLAN EL | scene finish PLAN EL"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    key, el = "plan:" + a[0], a[1]
    if cmd == "show":
        d = load_scene(A, key, el)
        print(f"«{d.get('name')}» · {d.get('len')} с · rev {d.get('rev', 0)} · объектов {len(d.get('objects') or [])} · свет {len(d.get('lights') or [])}")
        by = {o['id']: o for o in d.get("objects") or []}
        for o in d.get("objects") or []:
            depth, p = 0, o.get("parent")
            while p and depth < 10:
                depth, p = depth + 1, (by.get(p) or {}).get("parent")
            ks = {k: len(v) for k, v in (o.get("keys") or {}).items() if v}
            print(f"{'  ' * depth}{o['id']:<6} {'🔗 ' if o.get('type') == 'group' else ''}{o.get('name')}  pos {o.get('pos')}"
                  + (f"  ключи {ks}" if ks else "") + ("  [автор]" if (d.get("authored") or {}).get(o["id"]) else ""))
        c = d.get("camera") or {}
        print(f"камера: {len(c.get('keys') or [])} ключей, склеек {len(c.get('cuts') or [])}, fov {c.get('fov')}")
        return True
    if cmd == "ops":
        ops = json.loads(a[2])
        print(apply(A, key, el, ops if isinstance(ops, list) else [ops], by=A._opt(a, "--by", "claude"), desc=A._opt(a, "--desc", ""),
                    allow=(A._opt(a, "--allow", "") or "").split(",") if A._opt(a, "--allow") else ()))
        return True
    if cmd == "history":
        for h_ in history(A, key, el, int(a[2]) if len(a) > 2 else 30):
            print(time.strftime("%d.%m %H:%M", time.localtime(h_["ts"] / 1000)), h_.get("by"), "·", h_.get("desc"), f"({len(h_.get('ops') or [])})")
        return True
    if cmd == "undo":
        H = history(A, key, el, 400)
        gone = {h_.get("undoes") for h_ in H if h_.get("kind") == "undo"}
        last = next((h_ for h_ in reversed(H) if h_.get("undo") and h_.get("kind") not in ("undo", "version") and h_.get("batch") not in gone), None)
        if not last:
            sys.exit("нечего отменять")
        print(apply(A, key, el, last["undo"], by="author", desc="↺ отмена: " + last.get("desc", ""), kind="undo", undoes=last.get("batch")))
        return True
    if cmd == "brief":                         # S7: всё о сцене для агента — объекты, свет, камера, префабы, authored, комментарии
        d = load_scene(A, key, el)
        info = prefab_info(os.path.join(work_dir(A, key[5:], el), "prefabs.js"))
        print(f"EL={el} · файл {os.path.join(work_dir(A, key[5:], el), 'scene.json')} · как выглядят предметы — {os.path.join(work_dir(A, key[5:], el), 'prefabs.js')}".replace("\\", "/"))
        print(A.capi()._scene_summary(d, info))
        au = d.get("authored") or {}
        names = {o["id"]: o.get("name") for o in (d.get("objects") or []) + (d.get("lights") or [])}
        print("Правил руками автор (authored):", "; ".join(f"{names.get(k, k)} ({k}): {', '.join(v)}" for k, v in au.items()) or "—")
        cm = [c for c in d.get("comments") or [] if c.get("status", "open") == "open"]
        print("Комментарии автора:", "; ".join(f"[{c.get('mode', 'note')}] {names.get(c.get('target'), c.get('target') or 'сцена')} t={c.get('t')}: {c.get('text')} (id {c.get('id')})" for c in cm) or "—")
        print("Последние правки:", "; ".join(f"{'автор' if h_.get('by') == 'author' else 'Claude'}: {h_.get('desc')}" for h_ in history(A, key, el, 12)) or "—")
        return True
    if cmd == "frame":                         # S7: кадр сцены в момент t (или несколько через запятую) -> пути PNG
        wd = os.path.join(work_dir(A, key[5:], el), "_agent")
        os.makedirs(wd, exist_ok=True)
        ts = a[2] if len(a) > 2 else "0"
        tl = ["%g" % round(float(x), 2) for x in ts.split(",") if x.strip()]     # как имена файлов стенда: 1 -> element_1.png, 2.5 -> element_2.5.png
        for f in os.listdir(wd):
            if f.startswith("element_") and f.endswith(".png"):
                os.remove(os.path.join(wd, f))
        out = shoot(A, key, stage_url(A._docs(key)["port"], f"{key[5:]}/{el}/work"), wd, ",".join(tl))
        files = [os.path.join(wd, f"element_{t}.png") for t in tl]
        ok = [f for f in files if os.path.isfile(f)]
        print("\n".join(f.replace("\\", "/") for f in ok) or ("кадр не снялся: " + out[-400:]))
        if "[pageerror]" in out:
            print("ошибки страницы:", out[-600:])
        return True
    if cmd == "validate":
        d = load_scene(A, key, el)
        errs = validate(d) + check_ids(d)
        print("\n".join(errs) or "ok", *limits(d), sep="\n")
        return True
    if cmd in ("version", "clip"):
        job = A.Job("scenever" if cmd == "version" else "sceneclip", key, cmd, {"el": el, "note": a[2] if len(a) > 2 else "", "by": "claude"})
        (version if cmd == "version" else clip)(A, job)
        print(job.summary)
        return True
    if cmd == "finish":                        # after a conversion written by hand / in a session: shoot, diff, e.stage
        e = element(A, key, el)
        rs = e.get("renders") or []
        base = A._by_id(rs, A._opt(a, "--base")) or next((r for r in reversed(rs) if r.get("three") and not r.get("stage")), None)
        wd = work_dir(A, key[5:], el)
        cmp_dir = os.path.join(wd, "_convert")
        os.makedirs(os.path.join(cmp_dir, "old"), exist_ok=True)
        port = A._docs(key)["port"]
        ts = A._opt(a, "--ts", "0.6,2.5,9.5")
        shoot(A, key, f"http://127.0.0.1:{port}/tpl/stand3d.html?scene=/rscene/{base['dir']}/element.js&parts=element", os.path.join(cmp_dir, "old"), ts)
        print(json.dumps(finish_convert(A, key, el, base, cmp_dir, ts, port, by=A._opt(a, "--by", "claude")), ensure_ascii=False))
        return True
    return False
