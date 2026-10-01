"""3D-модели для героев и ассетов (S9+): любая модель -> чистый glb + отчёт; готовый скелет -> карта наших костей; авто-скелет; «картинка -> 3D».

- normalize(src, out_dir)  — Blender: импорт glb / gltf / fbx / obj / stl / usd(z) / blend (и Draco) -> out_dir/model.glb + info.json
                             {height, bones: [{name, parent}], animations: [имена], meshes, faces, rigged}
- bone_map(info)           — кости арматуры (Mixamo, Rigify, Tripo, Meshy, Quaternius, наши) -> { armL: {bone, axis, k}, … } для character({ rig: 'model' })
- auto_rig(glb, out_dir)   — Blender: гуманоид без скелета -> арматура наших имён по пропорциям тела + автовеса (не вышло — конверты)
- ai3d(provider, image, key, out_dir) — Meshy / Tripo: картинка -> 3D с текстурой -> авто-скелет у провайдера -> model.glb
- prefab_js(…)             — prefab.js персонажа-модели (engine/rig.js modelChar)
CLI: python models3d.py normalize <файл> <папка> | rig <glb> <папка> | map <info.json>
"""
import base64, json, os, re, shutil, subprocess, sys, time, urllib.request

import paths as P  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 ClaudeStudio/1.0 (local tool of a YouTube creator)"}
EXTS = (".glb", ".gltf", ".fbx", ".obj", ".stl", ".usd", ".usdz", ".usdc", ".usda", ".blend")

NORMALIZE = r'''
import bpy, sys, json, os, mathutils
src, out, info_path = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(src)[1].lower()
if ext in (".glb", ".gltf"): bpy.ops.import_scene.gltf(filepath=src)
elif ext == ".fbx": bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)
elif ext == ".obj": bpy.ops.wm.obj_import(filepath=src)
elif ext == ".stl": bpy.ops.wm.stl_import(filepath=src)
elif ext in (".usd", ".usdz", ".usdc", ".usda"): bpy.ops.wm.usd_import(filepath=src)
elif ext == ".blend":
    with bpy.data.libraries.load(src) as (a, b): b.objects = a.objects
    for o in b.objects:
        if o: bpy.context.scene.collection.objects.link(o)
for o in list(bpy.data.objects):
    if o.type in ("CAMERA", "LIGHT"): bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
lo, hi = mathutils.Vector((1e9,) * 3), mathutils.Vector((-1e9,) * 3)
faces = 0
for o in meshes:
    faces += len(o.data.polygons)
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c); lo = mathutils.Vector(map(min, lo, w)); hi = mathutils.Vector(map(max, hi, w))
bones = []
for a in arms:
    for b in a.data.bones:
        bones.append({"name": b.name, "parent": b.parent.name if b.parent else None, "armature": a.name})
anims = [a.name for a in bpy.data.actions]
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True, export_animations=True, export_skins=True,
                          export_cameras=False, export_lights=False)
json.dump({"height": hi.z - lo.z, "width": hi.x - lo.x, "depth": hi.y - lo.y, "bones": bones, "animations": anims, "meshes": len(meshes),
           "faces": faces, "rigged": bool(bones)}, open(info_path, "w", encoding="utf-8"), ensure_ascii=False)
print("NORMALIZE_OK")
'''

AUTORIG = r'''
import bpy, sys, json, os, mathutils
src, out, info_path = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.data.objects):
    if o.type in ("CAMERA", "LIGHT", "ARMATURE"): bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
V = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
lo = mathutils.Vector((min(v.x for v in V), min(v.y for v in V), min(v.z for v in V)))
hi = mathutils.Vector((max(v.x for v in V), max(v.y for v in V), max(v.z for v in V)))
h = hi.z - lo.z; cx = (lo.x + hi.x) / 2; cy = (lo.y + hi.y) / 2; z0 = lo.z
kind = sys.argv[sys.argv.index("--") + 1:][3] if len(sys.argv[sys.argv.index("--") + 1:]) > 3 else "auto"
if kind == "auto":
    kind = "quadruped" if (hi.y - lo.y) > 1.15 * h and (hi.y - lo.y) > (hi.x - lo.x) else "biped"
if kind == "quadruped":
    def avg(vs, k, d): return sum(getattr(v, k) for v in vs) / len(vs) if vs else d
    L = hi.y - lo.y; feet = [v for v in V if v.z <= z0 + 0.25 * h]
    def foot(sx, sy):
        c = [v for v in feet if (v.x - cx) * sx > 0 and (v.y - cy) * sy > 0]
        return mathutils.Vector((avg(c, "x", cx + sx * 0.15 * h), avg(c, "y", cy + sy * 0.3 * L), z0)) if c else mathutils.Vector((cx + sx * 0.15 * h, cy + sy * 0.3 * L, z0))
    bpy.ops.object.armature_add(location=(0, 0, 0)); A = bpy.context.object; A.name = "Rig"
    bpy.ops.object.mode_set(mode="EDIT"); E = A.data.edit_bones
    zb = z0 + 0.62 * h; yf = lo.y + 0.25 * L; yb = hi.y - 0.22 * L       # перед — к -Y Blender
    r = E[0]; r.name = "root"; r.head = (cx, cy, z0); r.tail = (cx, cy, z0 + 0.1 * h)
    def B(n, a, b, p):
        x = E.new(n); x.head = a; x.tail = b; x.parent = E[p]; return x
    B("hips", (cx, yb, zb), (cx, cy, zb), "root"); B("spine", (cx, cy, zb), (cx, yf, zb), "hips")
    B("neck", (cx, yf, zb), (cx, lo.y + 0.12 * L, z0 + 0.82 * h), "spine"); B("head", (cx, lo.y + 0.12 * L, z0 + 0.82 * h), (cx, lo.y, z0 + 0.9 * h), "neck")
    for nm, sx, sy, par in (("FL", 1, -1, "spine"), ("FR", -1, -1, "spine"), ("BL", 1, 1, "hips"), ("BR", -1, 1, "hips")):
        f = foot(sx, sy); top = mathutils.Vector((f.x, f.y, zb - 0.05 * h)); knee = top.lerp(f, 0.5)
        B("thigh." + nm, tuple(top), tuple(knee), par); B("shin." + nm, tuple(knee), tuple(f), "thigh." + nm)
    tail = [v for v in V if v.y > hi.y - 0.12 * L and v.z > z0 + 0.35 * h]
    if tail:
        tp = mathutils.Vector((avg(tail, "x", cx), max(v.y for v in tail), avg(tail, "z", zb)))
        a = mathutils.Vector((cx, yb, zb))
        B("tail.1", tuple(a), tuple(a.lerp(tp, 0.34)), "hips"); B("tail.2", tuple(a.lerp(tp, 0.34)), tuple(a.lerp(tp, 0.67)), "tail.1"); B("tail.3", tuple(a.lerp(tp, 0.67)), tuple(tp), "tail.2")
    bpy.ops.object.mode_set(mode="OBJECT")
    ok = True
    for m in meshes:
        bpy.ops.object.select_all(action="DESELECT"); m.select_set(True); A.select_set(True); bpy.context.view_layer.objects.active = A
        try:
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        except Exception:
            ok = False; bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True, export_animations=True, export_skins=True, export_cameras=False, export_lights=False)
    json.dump({"height": h, "kind": "quadruped", "bones": [{"name": b.name, "parent": b.parent.name if b.parent else None} for b in A.data.bones], "animations": [],
               "rigged": True, "autorig": True, "weights": "heat" if ok else "envelope"}, open(info_path, "w", encoding="utf-8"), ensure_ascii=False)
    print("AUTORIG_OK"); sys.exit(0)
def band(z1, z2): return [v for v in V if z0 + z1 * h <= v.z <= z0 + z2 * h]
def avg(vs, k, d): return sum(getattr(v, k) for v in vs) / len(vs) if vs else d
# руки: самые дальние по |x| точки в полосе плеч-кистей (T- или A-поза)
arm = band(0.45, 0.85)
hL = max(arm, key=lambda v: v.x - cx, default=mathutils.Vector((cx + 0.4 * h, cy, z0 + 0.6 * h)))
hR = min(arm, key=lambda v: v.x - cx, default=mathutils.Vector((cx - 0.4 * h, cy, z0 + 0.6 * h)))
chest = band(0.68, 0.76); torso_w = (max((abs(v.x - cx) for v in chest if abs(v.x - cx) < 0.25 * h), default=0.12 * h))
sh = z0 + 0.80 * h; sx = min(torso_w * 0.85, 0.16 * h)
legs = band(0.15, 0.35); lx = avg([v for v in legs if v.x > cx], "x", cx + 0.08 * h) - cx; rx = avg([v for v in legs if v.x < cx], "x", cx - 0.08 * h) - cx
bpy.ops.object.armature_add(location=(0, 0, 0)); A = bpy.context.object; A.name = "Rig"
bpy.ops.object.mode_set(mode="EDIT"); E = A.data.edit_bones
r = E[0]; r.name = "root"; r.head = (cx, cy, z0); r.tail = (cx, cy, z0 + 0.1 * h)
def B(n, a, b, p):
    x = E.new(n); x.head = a; x.tail = b; x.parent = E[p]; return x
P = lambda x, z, y=None: (cx + x, cy if y is None else y, z0 + z * h)
B("hips", P(0, 0.50), P(0, 0.58), "root"); B("spine", P(0, 0.58), P(0, 0.70), "hips"); B("chest", P(0, 0.70), P(0, 0.82), "spine")
B("neck", P(0, 0.82), P(0, 0.87), "chest"); B("head", P(0, 0.87), P(0, 1.0), "neck")
for s, hand, sxx in (("L", hL, sx), ("R", hR, -sx)):
    shp = mathutils.Vector((cx + sxx, cy, sh)); hp = mathutils.Vector((hand.x, cy, hand.z)); el = shp.lerp(hp, 0.5)
    B("upper_arm." + s, tuple(shp), tuple(el), "chest"); B("forearm." + s, tuple(el), tuple(shp.lerp(hp, 0.88)), "upper_arm." + s)
    B("hand." + s, tuple(shp.lerp(hp, 0.88)), tuple(hp), "forearm." + s)
for s, x in (("L", lx), ("R", rx)):
    B("thigh." + s, P(x, 0.50), P(x, 0.27), "hips"); B("shin." + s, P(x, 0.27), P(x, 0.05), "thigh." + s); B("foot." + s, P(x, 0.05), P(x, 0.0, cy - 0.08 * h), "shin." + s)
bpy.ops.object.mode_set(mode="OBJECT")
ok = True
for m in meshes:
    bpy.ops.object.select_all(action="DESELECT"); m.select_set(True); A.select_set(True); bpy.context.view_layer.objects.active = A
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except Exception:
        ok = False
    if not any(len(g.name) for g in m.vertex_groups) or all(not any(True for v in m.data.vertices for gg in v.groups if gg.group == g.index) for g in m.vertex_groups):
        ok = False; bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True, export_animations=True, export_skins=True,
                          export_cameras=False, export_lights=False)
json.dump({"height": h, "bones": [{"name": b.name, "parent": b.parent.name if b.parent else None} for b in A.data.bones], "animations": [],
           "rigged": True, "autorig": True, "weights": "heat" if ok else "envelope"}, open(info_path, "w", encoding="utf-8"), ensure_ascii=False)
print("AUTORIG_OK")
'''


MERGE_ANIMS = r'''
import bpy, sys, json, os
args = sys.argv[sys.argv.index("--") + 1:]
src, out, pairs = args[0], args[1], json.loads(args[2])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
main = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if not main: print("NO_ARMATURE"); sys.exit(4)
main.animation_data_create()
if main.animation_data.action:                       # своя анимация модели — тоже дорожкой
    a = main.animation_data.action; t = main.animation_data.nla_tracks.new(); t.name = a.name; t.strips.new(a.name, 0, a); main.animation_data.action = None
done = []
for name, path in pairs:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next((o for o in new if o.type == "ARMATURE" and o.animation_data and o.animation_data.action), None)
    if arm:
        act = arm.animation_data.action; act.name = name
        t = main.animation_data.nla_tracks.new(); t.name = name; t.strips.new(name, 0, act); done.append(name)
    for o in new: bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True, export_animations=True, export_animation_mode="NLA_TRACKS",
                          export_skins=True, export_cameras=False, export_lights=False)
print("MERGE_OK " + json.dumps(done))
'''


def merge_anims(glb, anims, out_dir):
    """Анимации из отдельных glb (тот же скелет) -> клипы основной модели (gltf:<имя>). -> список имён."""
    if not anims:
        return []
    src = os.path.join(out_dir, "_premerge.glb")
    shutil.copy2(glb, src)
    log = _blender(MERGE_ANIMS, src, os.path.join(out_dir, "model.glb"), json.dumps([[k, v] for k, v in anims.items()]))
    m = re.search(r"MERGE_OK (.*)", log)
    if not m:
        shutil.copy2(src, os.path.join(out_dir, "model.glb"))
        return []
    return json.loads(m.group(1))


def _blender(script, *args, timeout=900):
    exe = P.blender()
    if not exe:
        raise RuntimeError("Blender не найден — укажи путь в ⚙ Настройках")
    tmp = os.path.join(P.STATE, "blender_tmp")
    os.makedirs(tmp, exist_ok=True)
    sp = os.path.join(tmp, f"s{os.getpid()}_{int(time.time() * 1000)}.py")
    open(sp, "w", encoding="utf-8").write(script)
    r = subprocess.run([exe, "-b", "--factory-startup", "--python", sp, "--", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        os.remove(sp)
    except OSError:
        pass
    return (r.stdout or "") + (r.stderr or "")


def find_model(path):
    """Файл модели в папке (после распаковки zip): glb > gltf > fbx > obj > …"""
    if os.path.isfile(path):
        return path
    files = [os.path.join(dp, f) for dp, _, fs in os.walk(path) for f in fs]
    for e in EXTS:
        c = [f for f in files if f.lower().endswith(e)]
        if c:
            return sorted(c, key=lambda f: (f.count(os.sep), len(f)))[0]
    return None


def normalize(src, out_dir):
    src = find_model(src)
    if not src:
        raise ValueError("не нашёл файла модели (" + ", ".join(EXTS) + ")")
    os.makedirs(out_dir, exist_ok=True)
    out, info = os.path.join(out_dir, "model.glb"), os.path.join(out_dir, "info.json")
    if os.path.abspath(src) == os.path.abspath(out):                       # уже на месте: перегнать через временный файл
        tmp = os.path.join(out_dir, "_src" + os.path.splitext(src)[1]); shutil.copy2(src, tmp); src = tmp
    log = _blender(NORMALIZE, src, out, info)
    if "NORMALIZE_OK" not in log or not os.path.isfile(out):
        raise RuntimeError("Blender не смог открыть модель: " + log.strip()[-400:])
    d = json.load(open(info, encoding="utf-8"))
    d["map"] = bone_map(d)
    json.dump(d, open(info, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return d


def auto_rig(glb, out_dir, kind="auto"):
    os.makedirs(out_dir, exist_ok=True)
    out, info = os.path.join(out_dir, "model.glb"), os.path.join(out_dir, "info.json")
    src = glb
    if os.path.abspath(glb) == os.path.abspath(out):
        src = os.path.join(out_dir, "_unrigged.glb"); shutil.copy2(glb, src)
    log = _blender(AUTORIG, src, out, info, kind)
    if "AUTORIG_OK" not in log:
        raise RuntimeError("авто-скелет не встал: " + log.strip()[-400:])
    d = json.load(open(info, encoding="utf-8"))
    d["map"] = bone_map(d)
    json.dump(d, open(info, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return d


# ---------------------------------------------------------------- готовый скелет -> наши кости
def sanitize(n):
    """Как three.js PropertyBinding.sanitizeNodeName: пробелы -> _, убираются [ ] . : /"""
    return re.sub(r"[\[\].:/]", "", re.sub(r"\s", "_", n))


def _side(n):
    s = n.lower()
    if re.search(r"(^|[^a-z])(left|l)([^a-z]|$)", re.sub(r"([a-z])([A-Z])", r"\1 \2", n).lower()) or re.search(r"(\.|_|-)l$|left", s) or n.endswith("L") and not n.endswith("LL"):
        return "L"
    if re.search(r"(^|[^a-z])(right|r)([^a-z]|$)", re.sub(r"([a-z])([A-Z])", r"\1 \2", n).lower()) or re.search(r"(\.|_|-)r$|right", s) or n.endswith("R"):
        return "R"
    return ""


ROLES = [  # (наша кость, слова, исключить, ось, k для L / центр, k для R)
    ("head", ("head",), ("headtop", "end", "neck", "nub"), "x", 1, 1),
    ("body", ("spine", "chest", "torso"), ("spine2", "spine3", "upperchest"), "x", 1, 1),
    ("arm", ("upperarm", "uparm", "arm"), ("fore", "lower", "hand", "shoulder", "clavicle", "twist", "armature"), "z", 1, -1),
    ("forearm", ("forearm", "lowerarm", "elbow"), ("twist", "hand"), "x", -1, -1),
    ("leg", ("upleg", "thigh", "upperleg"), ("twist",), "x", -1, -1),
    ("shin", ("shin", "calf", "lowerleg", "knee", "leg"), ("upleg", "upper", "twist", "foot"), "x", 1, 1),
    ("hand", ("hand", "wrist"), ("thumb", "index", "middle", "ring", "pinky", "finger", "end"), "x", 1, 1),
    ("foot", ("foot", "ankle"), ("toe", "end"), "x", 1, 1),
    ("jaw", ("jaw",), (), "x", 1, 1),
]


def quad_map(info):
    names = {sanitize(b["name"]) for b in info.get("bones") or []}
    out = {}
    for k, b, ax, kk in (("body", "spine", "x", 1), ("head", "head", "x", 1), ("neck", "neck", "x", 1), ("root", "root", "y", 1),
                         ("tail", "tail1", "x", -1), ("tail2", "tail2", "x", -1), ("tail3", "tail3", "x", -1)):
        if b in names:
            out[k] = {"bone": b, "axis": ax, "k": kk}
    for leg in ("FL", "FR", "BL", "BR"):
        if "thigh" + leg in names:
            out["leg" + leg] = {"bone": "thigh" + leg, "axis": "x", "k": -1}
        if "shin" + leg in names:
            out["shin" + leg] = {"bone": "shin" + leg, "axis": "x", "k": 1}
    if "legFL" in out:                                          # общие кости позы студии (ходьба, клипы двуногих) — передними лапами
        out["armL"], out["armR"], out["legL"], out["legR"] = out["legFL"], out.get("legFR", out["legFL"]), out.get("legBL", out["legFL"]), out.get("legBR", out["legFL"])
    return out


def bone_map(info):
    if info.get("kind") == "quadruped":
        return quad_map(info)
    """{ head: {bone, axis, k}, body, armL/R, forearmL/R, legL/R, shinL/R, handL/R, footL/R } по именам костей (три.js-имена)."""
    names = [sanitize(b["name"]) for b in info.get("bones") or []]
    raw = {sanitize(b["name"]): b["name"] for b in info.get("bones") or []}
    out = {}
    for role, words, bad, axis, kL, kR in ROLES:
        cand = []
        for n in names:
            core = re.sub(r"^(mixamorig\d*|def|org|mch|bip0?1|bip|armature|rig|bone)[_\-]?", "", n, flags=re.I)
            low = re.sub(r"[^a-z0-9]", "", core.lower())
            if not any(w in low for w in words) or any(b_ in low for b_ in bad):
                continue
            if role == "shin" and ("upleg" in low or "thigh" in low):
                continue
            pri = min(words.index(w) * 10 + low.find(w) for w in words if w in low) + len(low) * 0.01 + (50 if raw[n].upper().startswith(("ORG", "MCH")) else 0)
            cand.append((pri, n))
        cand.sort()
        if role in ("head", "body", "jaw"):
            if cand:
                out[role] = {"bone": cand[0][1], "axis": axis, "k": kL}
            continue
        for side, k in (("L", kL), ("R", kR)):
            c = [n for _, n in cand if _side(raw[n]) == side]
            if c:
                out[role + side] = {"bone": c[0], "axis": axis, "k": k}
    roots = [sanitize(b["name"]) for b in info.get("bones") or [] if not b.get("parent")]
    if roots:
        out["root"] = {"bone": roots[0], "axis": "y", "k": 1}
    return out


# ---------------------------------------------------------------- «картинка -> 3D»
def _req(url, data=None, headers=None, method=None, timeout=60):
    h = dict(UA, **(headers or {}))
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, body, h, method=method or ("POST" if data is not None else "GET"))
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def _download(url, path):
    r = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(r, timeout=300) as resp, open(path, "wb") as f:
        shutil.copyfileobj(resp, f)
    return path


def _data_uri(img):
    ext = os.path.splitext(img)[1].lower().lstrip(".")
    ext = "jpeg" if ext in ("jpg", "jpeg") else "png"
    return f"data:image/{ext};base64," + base64.b64encode(open(img, "rb").read()).decode()


def _poll(fn, log, what, timeout=1800):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, prog, res = fn()
        if st == "ok":
            return res
        if st == "fail":
            raise RuntimeError(f"{what}: не получилось — {res}")
        log(f"{what}… {prog}")
        time.sleep(6)
    raise RuntimeError(f"{what}: не дождался за {timeout // 60} мин")


def meshy(img, key, out_dir, log, height=1.9, rig=True):
    H = {"Authorization": "Bearer " + key}
    base = "https://api.meshy.ai/openapi/v1"
    tid = _req(base + "/image-to-3d", {"image_url": _data_uri(img), "should_texture": True, "enable_pbr": False, "target_formats": ["glb"]}, H)["result"]

    def st(path, tid_):
        def f():
            d = _req(f"{base}/{path}/{tid_}", headers=H)
            s = d.get("status")
            return ("ok" if s == "SUCCEEDED" else "fail" if s in ("FAILED", "CANCELED") else "wait"), f"{d.get('progress', 0)}%", d if s == "SUCCEEDED" else (d.get("task_error") or {}).get("message", s)
        return f
    d = _poll(st("image-to-3d", tid), log, "Meshy лепит модель")
    raw = _download(d["model_urls"]["glb"], os.path.join(out_dir, "meshy_raw.glb"))
    if not rig:
        return raw, {"provider": "meshy", "task": tid}
    log("Meshy ставит скелет…")
    try:
        rid = _req(base + "/rigging", {"input_task_id": tid, "height_meters": height}, H)["result"]
        r = _poll(st("rigging", rid), log, "Meshy ставит скелет")
        res = r.get("result") or r
        rigged = _download(res["rigged_character_glb_url"], os.path.join(out_dir, "meshy_rigged.glb"))
        anims = {}
        for k, u in ((res.get("basic_animations") or {}).items()):
            if k.endswith("_glb_url") and "armature" not in k and u:
                anims[k.replace("_glb_url", "")] = _download(u, os.path.join(out_dir, f"meshy_{k.replace('_glb_url', '')}.glb"))
        return rigged, {"provider": "meshy", "task": tid, "rig": rid, "anims": anims}
    except Exception as e:                                       # не гуманоид или лимит — модель без скелета, скелет поставим сами
        log(f"скелет Meshy не встал ({str(e)[:120]}) — поставлю авто-скелет в Blender")
        return raw, {"provider": "meshy", "task": tid, "rigError": str(e)[:300]}


def tripo(img, key, out_dir, log, height=1.9, rig=True):
    H = {"Authorization": "Bearer " + key}
    base = "https://openapi.tripo3d.com/v3"
    import uuid
    bnd = "----cs" + uuid.uuid4().hex
    ext = os.path.splitext(img)[1].lower().lstrip(".") or "png"
    body = (f"--{bnd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"ref.{ext}\"\r\nContent-Type: image/{'jpeg' if ext in ('jpg', 'jpeg') else 'png'}\r\n\r\n").encode() \
        + open(img, "rb").read() + f"\r\n--{bnd}--\r\n".encode()
    r = urllib.request.Request(base + "/files", body, dict(UA, **H, **{"Content-Type": "multipart/form-data; boundary=" + bnd}), method="POST")
    tok = json.loads(urllib.request.urlopen(r, timeout=120).read())["data"]["file_token"]
    tid = _req(base + "/generation/image-to-model", {"file": {"type": "jpg" if ext in ("jpg", "jpeg") else "png", "file_token": tok},
                                                      "model_version": "v2.5-20250123", "texture": True, "pbr": False}, H)["data"]["task_id"]

    def st(tid_):
        def f():
            d = _req(f"{base}/tasks/{tid_}", headers=H)["data"]
            s = d.get("status")
            return ("ok" if s == "success" else "fail" if s in ("failed", "cancelled") else "wait"), f"{d.get('progress', 0)}%", d if s == "success" else s
        return f
    d = _poll(st(tid), log, "Tripo лепит модель")
    raw = _download(d["output"]["model_url"], os.path.join(out_dir, "tripo_raw.glb"))
    if not rig:
        return raw, {"provider": "tripo", "task": tid}
    try:
        log("Tripo проверяет, можно ли поставить скелет…")
        chk = _poll(st(_req(base + "/animations/rig-check", {"input": tid}, H)["data"]["task_id"]), log, "Tripo: проверка скелета")
        if not (chk.get("output") or {}).get("riggable", True):
            raise RuntimeError("модель нельзя оснастить")
        rt = (chk.get("output") or {}).get("rig_type") or "biped"
        rid = _req(base + "/animations/rig", {"input": tid, "rig_type": rt, "spec": "mixamo", "out_format": "glb"}, H)["data"]["task_id"]
        rr = _poll(st(rid), log, "Tripo ставит скелет")
        rigged = _download(rr["output"]["model_url"], os.path.join(out_dir, "tripo_rigged.glb"))
        return rigged, {"provider": "tripo", "task": tid, "rig": rid, "rigType": rt}
    except Exception as e:
        log(f"скелет Tripo не встал ({str(e)[:120]}) — поставлю авто-скелет в Blender")
        return raw, {"provider": "tripo", "task": tid, "rigError": str(e)[:300]}


# ---------------------------------------------------------------- prefab.js персонажа-модели
def prefab_js(cid, name, skeleton, h, info, note=""):
    m = info.get("map") or {}
    bones = ",\n    ".join(f"{k}: {{ bone: {json.dumps(v['bone'])}, axis: '{v['axis']}', k: {v['k']} }}" for k, v in m.items())
    clips = [a for a in info.get("animations") or []]
    idle = next((a for a in clips if re.search(r"idle|stand|breath", a, re.I)), None)
    return f"""// {name} — 3D-персонаж (models3d.py: {note or 'модель'}). Кости позы -> кости арматуры: bones (axis — ось модели, k — знак); клипы модели — gltf:<имя>.
character({{
  id: {json.dumps(cid)}, name: {json.dumps(name, ensure_ascii=False)}, skeleton: {json.dumps(skeleton)}, rig: 'model', model: 'model.glb', h: {round(float(h or 1.8), 3)}, idle: {json.dumps(idle)},
  gltfClips: {json.dumps(clips, ensure_ascii=False)},
  bones: {{
    {bones}
  }},
  emotions: {{ 'спокойный': {{ face: {{}}, ok: true }} }},
  pose: {{}},
}});
"""


# ---------------------------------------------------------------- задачи приложения
def asset_item_3d(A, pid, dst, main, item):
    """После скачивания / загрузки 3D: чистый model.glb + info (скелет, анимации) рядом. Ошибка — модель остаётся как есть, с заметкой."""
    try:
        info = normalize(main, dst)
        item.update(main=A.rel_data(os.path.join(dst, "model.glb")), fmt="glb", rigged=bool(info.get("rigged")), anims=info.get("animations") or [],
                    bones=len(info.get("bones") or []), height=round(info.get("height") or 0, 3), faces=info.get("faces"),
                    note=((item.get("note") or "") + (" · со скелетом" if info.get("rigged") else "") + (f" · анимации: {', '.join((info.get('animations') or [])[:6])}" if info.get("animations") else "")).strip(" ·"))
    except Exception as e:
        item["note"] = ((item.get("note") or "") + " · Blender не открыл модель: " + str(e)[:160]).strip(" ·")
    return item


def upload_job(A, job):
    """⬆ своя 3D-модель (glb / gltf / fbx / obj / stl / usdz / blend / zip) -> files/<plan>/assets/<id>/ + assets[] элемента."""
    import io, zipfile
    key, eid = job.key, job.params.get("el")
    pid = key[5:]
    e = A._by_id(A.load(key).get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    name = os.path.basename(job.params.get("name") or "model.glb")
    data = base64.b64decode((job.params.get("data") or "").split(",")[-1])
    iid = A.new_id("a")
    dst = os.path.join(P.files(pid), "assets", iid)
    os.makedirs(dst, exist_ok=True)
    job.summary = "сохраняю файл…"
    if name.lower().endswith(".zip") or data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for i in z.infolist():
                if not i.is_dir() and "__MACOSX" not in i.filename:
                    out = os.path.normpath(os.path.join(dst, "src", i.filename))
                    if out.startswith(os.path.normpath(dst)):
                        os.makedirs(os.path.dirname(out), exist_ok=True)
                        open(out, "wb").write(z.read(i))
        main = find_model(os.path.join(dst, "src"))
    else:
        os.makedirs(os.path.join(dst, "src"), exist_ok=True)
        main = os.path.join(dst, "src", name)
        open(main, "wb").write(data)
    if not main:
        raise ValueError("в архиве нет модели (" + ", ".join(EXTS) + ")")
    job.summary = "Blender открывает модель…"
    item = {"id": iid, "src": "upload", "sid": name, "title": os.path.splitext(name)[0][:140], "kind": "3d", "fmt": os.path.splitext(main)[1].lstrip("."),
            "license": job.params.get("license") or "своя / указать", "attr": False, "author": job.params.get("author") or "", "page": job.params.get("page") or "",
            "dir": A.rel_data(dst), "main": A.rel_data(main), "files": 1, "size": len(data), "preview": "", "note": "загружена автором", "why": "", "ts": int(time.time() * 1000)}
    asset_item_3d(A, pid, dst, main, item)
    A.apply_ops(key, [{"op": "add", "path": ["elements", eid, "assets"], "item": item}])
    job.result = item
    job.summary = f"Модель загружена: «{item['title']}»" + (" — со скелетом" if item.get("rigged") else "")


def char_job(A, job):
    """🦴 герой из 3D-модели: ассет элемента (скачанный / загруженный) или «картинка -> 3D» (Meshy / Tripo) -> скелет (готовый — подстроить, нет — авто)
    -> render/<plan>/<el>/v<N>/ model.glb + prefab.js (rig 'model') + кадры поворотного стола и поз -> renders[] (rigchar, model3d)."""
    key, eid, prm = job.key, job.params.get("el"), job.params
    pid = key[5:]
    plan = A.load(key)
    e = A._by_id(plan.get("elements"), eid)
    if not e:
        raise ValueError("элемент не найден")
    rs = e.get("renders") or []
    v = max([r.get("v", 0) for r in rs] + [0]) + 1
    rel = f"{pid}/{eid}/v{v}"
    wd = os.path.join(P.render(pid), eid, f"v{v}")
    os.makedirs(wd, exist_ok=True)
    log = lambda t: setattr(job, "summary", t)
    src, meta = prm.get("source") or "asset", {}
    h = float(prm.get("h") or e.get("h") or 1.9)
    if src == "asset":
        a = A._by_id(e.get("assets"), prm.get("asset")) or next((x for x in reversed(e.get("assets") or []) if x.get("kind") == "3d"), None)
        if not a:
            raise ValueError("у элемента нет 3D-ассета — найди или загрузи модель")
        base = P.resolve(a["main"])
        meta = {"asset": a["id"], "title": a.get("title"), "license": a.get("license"), "author": a.get("author"), "page": a.get("page")}
        log("Blender открывает модель…")
        info = normalize(base, wd)
    elif src == "trellis":                                       # локально: TRELLIS.2 / Pixal3D в ComfyUI Studio (comfy3d.py)
        import comfy3d as C
        base = A._by_id(rs, prm.get("base")) if prm.get("base") else None
        bm = dict((base or {}).get("meta") or {})
        mode = prm.get("mode") or ("final" if base else "draft")
        refs = [r for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
        views = prm.get("views") or bm.get("views") or {}               # {front|left|back|right: путь files/…}
        engine = prm.get("engine") or bm.get("engine") or ("multiview" if len(views) >= 2 else "pixal3d")
        ref = prm.get("ref") or bm.get("ref") or (refs[0]["img"] if refs else None)
        if engine == "multiview" and len(views) < 2:
            raise ValueError("для «по ракурсам» нужны хотя бы 2 картинки: спереди и сбоку/сзади")
        if engine != "multiview" and not ref:
            raise ValueError("нужна картинка-референс персонажа")
        seeds = dict(bm.get("seeds") or {})
        keep = {"draft": () if not base else ("structure", "shape", "upsample", "texture"), "final": ("structure", "shape", "texture"),
                "retex": ("structure", "shape", "upsample"), "fix": tuple(k for k in ("structure", "shape", "upsample", "texture") if k not in (prm.get("reseed") or []))}[mode]
        if mode == "draft" and not base:
            seeds = {}
        seeds = C.new_seeds(seeds, keep)
        stage = prm.get("stage") or ("final" if mode in ("final",) or (mode in ("retex", "fix") and bm.get("stage") == "final") else "draft")
        opts = {k: prm[k] if prm.get(k) is not None else bm.get(k) for k in ("tex", "faces", "pad", "bg", "res", "mv_fov")}   # не задано — как у базы (иначе вход сети другой и фигура поплывёт)
        texref = prm.get("texref") if mode in ("retex", "fix") else bm.get("texref") if mode == "final" else None
        images = ({k: P.resolve(v) for k, v in views.items()} if engine == "multiview" else {"main": P.resolve(ref)})
        if texref:
            images["tex"] = P.resolve(texref)
        what = {"draft": "черновик", "final": "довожу до чистовика", "retex": "перетекстуриваю", "fix": "правлю"}[mode]
        log(f"TRELLIS ({'Pixal3D' if engine == 'pixal3d' else 'по ракурсам' if engine == 'multiview' else 'TRELLIS.2'}): {what}…")
        glb, meta = C.generate(images, wd, log, engine=engine, mode=mode, stage=stage, seeds=seeds, tag=f"{pid}_{eid}_v{v}",
                               **{k: x for k, x in opts.items() if x is not None})
        meta.update(ref=ref, views=views or None, texref=texref, base=(base or {}).get("id"), why=prm.get("why") or "")
        meta = {k: x for k, x in meta.items() if x is not None}
        log("Blender проверяет модель…")
        info = normalize(glb, wd)
    else:
        S = A.stgapi()
        k = S.secret(src)
        if not k:
            raise ValueError(f"нет ключа {src.capitalize()} — добавь его в ⚙ Настройках")
        refs = [P.resolve(r["img"]) for r in e.get("refs") or [] if r.get("img") and os.path.isfile(P.resolve(r["img"]))]
        ref = P.resolve(prm["ref"]) if prm.get("ref") else (refs[0] if refs else None)
        if not ref:
            raise ValueError("нужна картинка-референс персонажа")
        glb, meta = (meshy if src == "meshy" else tripo)(ref, k, wd, log, height=h)
        meta["ref"] = A.rel_data(ref)
        log("Blender проверяет модель…")
        info = normalize(glb, wd)
        if meta.get("anims"):                                   # Meshy: ходьба / бег отдельными glb — в клипы модели
            log("вклеиваю анимации провайдера в модель…")
            got = merge_anims(os.path.join(wd, "model.glb"), meta["anims"], wd)
            info = normalize(os.path.join(wd, "model.glb"), wd)
            meta["merged"] = got
    if not info.get("rigged") or len(info.get("map") or {}) < 6:
        log("скелета нет — ставлю авто-скелет…")
        info = auto_rig(os.path.join(wd, "model.glb"), wd, prm.get("body") or ("quadruped" if (meta.get("rigType") or "") == "quadruped" else "auto"))
        meta["autorig"] = info.get("weights")
    sk = prm.get("skeleton") or e.get("skeleton") or "biped"
    slug = re.sub(r"[^a-z0-9-]+", "-", (e.get("slug") or eid).lower()).strip("-") or eid
    A.write_text(os.path.join(wd, "prefab.js"), prefab_js(slug, e.get("name") or "персонаж", sk, h, info, {"asset": "ассет", "meshy": "Meshy", "tripo": "Tripo", "trellis": "TRELLIS.2 локально"}.get(src, src)))
    json.dump(dict(info, source=src, meta=meta), open(os.path.join(wd, "info.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("снимаю поворотный стол и позы…")
    rp = os.path.join(P.STANDS, "render_prop.js")
    url = f"/rscene/{rel}/prefab.js"
    port = str(A._docs(key)["port"])
    cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(["node", rp, url, wd, "--port", port], capture_output=True, timeout=300, creationflags=cf)
    for name, pose in (("pose_up", {"bones": {"armL": {"rot": 1.2}, "armR": {"rot": 1.2}}}), ("pose_step", {"bones": {"legL": {"rot": 0.5}, "legR": {"rot": -0.4}, "armL": {"rot": -0.3}, "armR": {"rot": 0.3}}})):
        subprocess.run(["node", rp, url, os.path.join(wd, name), "--port", port, "--params", json.dumps({"pose": pose})], capture_output=True, timeout=300, creationflags=cf)
    main = os.path.join(wd, "element.png")
    if not os.path.isfile(main):
        raise RuntimeError("кадры не снялись — модель не открылась на стенде")
    img = A.save_file(pid, open(main, "rb").read())
    extra = [A.save_file(pid, open(os.path.join(wd, f), "rb").read()) for f in ("pose_up/element.png", "pose_step/element.png") if os.path.isfile(os.path.join(wd, f))]
    rid = A.new_id("r")
    what = {"asset": f"из ассета «{meta.get('title', '')}»", "meshy": "Meshy по картинке", "tripo": "Tripo по картинке",
            "trellis": f"TRELLIS локально ({ {'pixal3d': 'Pixal3D', 'trellis': 'TRELLIS.2', 'multiview': 'по ракурсам'}.get(meta.get('engine'), '') }, "
                       f"{'черновик' if meta.get('stage') == 'draft' else 'чистовик'}, {meta.get('secs', '?')} с)"}.get(src, src)
    skel = "авто-скелет" + (" (конверты)" if meta.get("autorig") == "envelope" else "") if meta.get("autorig") else "готовый скелет модели"
    if src == "trellis" and prm.get("feedback"):
        meta["feedback"] = prm["feedback"]
    item = {"id": rid, "v": v, "dir": rel, "img": img, "extra": extra, "fn": sk, "rigchar": True, "model3d": True, "source": src, "meta": meta,
            **({"feedback": prm["feedback"]} if prm.get("feedback") else {}),
            "summary": f"3D-герой {what}; {skel}: {len(info.get('map') or {})} костей позы" + (f"; анимации модели: {', '.join((info.get('animations') or [])[:8])}" if info.get("animations") else ""),
            "note": "проверь позы «руки вверх» и «шаг»: если рука идёт не туда — поменяй k у кости в prefab.js или скажи Claude", "ts": int(time.time() * 1000)}
    ops = [{"op": "add", "path": ["elements", eid, "renders"], "item": item}, {"op": "set", "path": ["elements", eid, "render"], "value": rid}]
    if e.get("form") != "rig":
        ops.append({"op": "set", "path": ["elements", eid, "form"], "value": "rig"})
    A.apply_ops(key, ops)
    job.result = item
    job.summary = item["summary"]


def comfy_setup_job(A, job):
    """🖥 ⚙ Настройки → «Поставить локальную 3D»: tools/comfy_setup.py (ComfyUI portable + модели TRELLIS.2 / Pixal3D), строки вывода — в summary."""
    cf = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    pr = subprocess.Popen([sys.executable, "-u", os.path.join(P.STUDIO, "tools", "comfy_setup.py")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"), creationflags=cf)
    last = ""
    for line in pr.stdout:
        if line.strip():
            last = line.strip(); job.summary = last
        if job.cancelled:
            pr.kill(); raise RuntimeError("остановлено — докачается с того же места")
    if pr.wait():
        raise RuntimeError(last or "установка не удалась")
    job.summary = "Локальная 3D готова: TRELLIS.2 и Pixal3D"


def run_job(A, job):
    if job.kind == "comfysetup":
        comfy_setup_job(A, job); return True
    if job.kind == "charmodel":
        char_job(A, job); return True
    if job.kind == "assetupload":
        upload_job(A, job); return True
    return False


if __name__ == "__main__":
    a = sys.argv[1:]
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a and a[0] == "normalize":
        print(json.dumps(normalize(a[1], a[2]), ensure_ascii=False, indent=1))
    elif a and a[0] == "rig":
        print(json.dumps(auto_rig(a[1], a[2]), ensure_ascii=False, indent=1))
    elif a and a[0] == "map":
        print(json.dumps(bone_map(json.load(open(a[1], encoding="utf-8"))), ensure_ascii=False, indent=1))
    else:
        print(__doc__)
