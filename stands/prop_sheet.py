"""Лист 3D-пропса: четыре ракурса поворотного стола (element_1/3/5/7.png из render_shot.js) -> element.png 2×2.
   python prop_sheet.py <папка> [--prefix element] [--size 1080]
Из кадра 1080×1920 берётся центральный квадрат (стенд вписывает пропс в него)."""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ANGLES = ["1", "3", "5", "7"]
LABELS = ["¾ спереди", "¾ спереди, другой бок", "¾ сзади", "¾ сзади, другой бок"]


def sheet(d, prefix="element", size=1080, out=None):
    half = size // 2
    img = Image.new("RGB", (size, size), "#ece6da")
    dr = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "template", "assets", "fonts", "Rubik.ttf"), 22)
    except OSError:
        font = ImageFont.load_default()
    n = 0
    for i, a in enumerate(ANGLES):
        p = os.path.join(d, f"{prefix}_{a}.png")
        if not os.path.isfile(p):
            continue
        im = Image.open(p).convert("RGB")
        w, h = im.size
        s = min(w, h)
        top = (h - s) // 2
        im = im.crop(((w - s) // 2, top, (w - s) // 2 + s, top + s)).resize((half, half), Image.LANCZOS)
        x, y = (i % 2) * half, (i // 2) * half
        img.paste(im, (x, y))
        dr.text((x + 12, y + 10), f"{i + 1} · {LABELS[i]}", fill="#6b6456", font=font)
        n += 1
    dr.line([(half, 0), (half, size)], fill="#d6cdbb", width=2)
    dr.line([(0, half), (size, half)], fill="#d6cdbb", width=2)
    out = out or os.path.join(d, f"{prefix}.png")
    img.save(out)
    return out if n else None


if __name__ == "__main__":
    a = sys.argv[1:]
    pre = a[a.index("--prefix") + 1] if "--prefix" in a else "element"
    sz = int(a[a.index("--size") + 1]) if "--size" in a else 1080
    print(sheet(a[0], pre, sz) or "нет кадров")
