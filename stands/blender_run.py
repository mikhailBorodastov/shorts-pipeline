"""Blender в фоне для 3D-пропса (S3): python blender_run.py model.py [out.glb]
model.py — скрипт bpy: строит меши, модификаторы и материалы в пустой сцене. Экспорт делает эта обёртка:
все объекты сцены -> out.glb (по умолчанию model.glb рядом со скриптом), модификаторы применяются, +Y вверх.
Единицы — метры; низ модели на z = 0 Blender (станет y = 0), перед — к -Y Blender (станет +z в three.js).
Лог Blender — model.log рядом; в консоль — только итог и ошибки Python."""
import os, subprocess, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import paths  # noqa: E402

WRAP = r'''
import bpy, sys, traceback, runpy
src, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    runpy.run_path(src, run_name="__main__")
except Exception:
    traceback.print_exc()
    print("MODEL_PY_FAILED")
    sys.exit(3)
for o in list(bpy.data.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    print("NO_MESHES"); sys.exit(4)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True, use_selection=False,
                          export_cameras=False, export_lights=False)
dims = [0, 0, 0]
import mathutils
lo, hi = mathutils.Vector((1e9,) * 3), mathutils.Vector((-1e9,) * 3)
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        lo = mathutils.Vector(map(min, lo, w)); hi = mathutils.Vector(map(max, hi, w))
print("GLB_OK %.3f x %.3f x %.3f m (ширина x глубина x высота), объектов: %d" % (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, len(meshes)))
'''


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(os.path.dirname(src), "model.glb")
    exe = paths.blender()
    if not exe:
        sys.exit("Blender не найден (_studio/tools/blender, PATH или .studio/state.json → blender)")
    wrap = os.path.join(os.path.dirname(src), "_blender_wrap.py")
    open(wrap, "w", encoding="utf-8").write(WRAP)
    log = os.path.splitext(src)[0] + ".log"
    r = subprocess.run([exe, "-b", "--factory-startup", "--python", wrap, "--", src, out], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=600)
    text = (r.stdout or "") + (r.stderr or "")
    open(log, "w", encoding="utf-8").write(text)
    ok = [l for l in text.splitlines() if l.startswith("GLB_OK")]
    if ok and os.path.isfile(out):
        print(ok[-1].replace("GLB_OK", "готово: " + os.path.basename(out) + " —"))
        return
    tb = text[text.find("Traceback"):] if "Traceback" in text else "\n".join(text.splitlines()[-25:])
    print("Blender не собрал модель:\n" + tb[:4000])
    sys.exit(1)


if __name__ == "__main__":
    main()
