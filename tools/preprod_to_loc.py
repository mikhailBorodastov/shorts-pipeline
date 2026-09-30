# Converts preproduction element.js files into isolated modules src/loc/<slug>.js
# Each module: const L_<id> = (() => { <element code without PICS/WORLD/ELEMENT>; return { getters for every top-level name } })();
import os, re, sys, json

ROOT = os.getcwd()   # run from the project folder
PRE = os.path.join(ROOT, "refs", "препродакшен")
OUT = os.path.join(ROOT, "src", "loc")
os.makedirs(OUT, exist_ok=True)

def cut_block(src, start_pat):
    """remove `const X = world3d({ ... });` (balanced) — returns (src_without, removed_text)"""
    m = re.search(start_pat, src, re.M)
    if not m:
        return src, ""
    i = src.index("(", m.start())
    depth, j = 0, i
    in_str = None
    while j < len(src):
        c = src[j]
        if in_str:
            if c == "\\": j += 2; continue
            if c == in_str: in_str = None
        elif c in "'\"`": in_str = c
        elif c == "(": depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0: break
        j += 1
    end = src.index(";", j) + 1
    return src[:m.start()] + src[end:], src[m.start():end]

def convert(kind, slug, ident):
    p = os.path.join(PRE, kind, slug, "element.js")
    src = open(p, encoding="utf-8").read()
    src = re.sub(r"^const PICS = .*?;\s*$", "", src, flags=re.M)
    src, world = cut_block(src, r"^const WORLD = world3d\(")
    # ELEMENT: one line `const ELEMENT = {...};` or a multi-line object literal
    m = re.search(r"^const ELEMENT = \{", src, re.M)
    if m:
        i = src.index("{", m.start()); depth = 0; j = i
        while j < len(src):
            if src[j] == "{": depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0: break
            j += 1
        end = src.index(";", j) + 1
        src = src[:m.start()] + src[end:]
    names = []
    for m in re.finditer(r"^(?:async\s+)?(?:function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)", src, re.M):
        if m.group(1) not in names: names.append(m.group(1))
    # `let a = 1, b = 2;` top-level multi-declarations
    for m in re.finditer(r"^(?:let|var)\s+(.+?);\s*$", src, re.M):
        for part in m.group(1).split(","):
            n = part.strip().split("=")[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", n) and n not in names: names.append(n)
    exp = ",\n    ".join(f"get {n}() {{ return {n}; }}" for n in names)
    hdr = f"// авто: {kind}/{slug}/element.js (препродакшен). Оригинальный мир стенда — в комментарии внизу.\n"
    body = f"{hdr}const {ident} = (() => {{\n{src.rstrip()}\n\n  return {{\n    {exp}\n  }};\n}})();\n"
    if world:
        body += "\n/* мир со стенда (для справки):\n" + world.replace("*/", "* /") + "\n*/\n"
    open(os.path.join(OUT, slug + ".js"), "w", encoding="utf-8").write(body)
    return names

MAP = json.loads(sys.argv[1])
for kind, slug, ident in MAP:
    n = convert(kind, slug, ident)
    print(ident, len(n), "names")
