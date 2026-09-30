"""Иконка окна Claude Studio: бумажная хлопушка на тёмной плитке -> app/icon.png (1024).
Потом `npx tauri icon icon.png` раскладывает её по src-tauri/icons."""
import math, os, random
from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(7)


def torn(pts, amp=10, step=18):
    """Рваная кромка: дробим отрезки и шевелим точки."""
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(n):
            t = i / n
            out.append((x0 + (x1 - x0) * t + rnd.uniform(-amp, amp) * 0.5,
                        y0 + (y1 - y0) * t + rnd.uniform(-amp, amp)))
    return out


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((40, 40, S - 40, S - 40), 210, fill=(33, 35, 41, 255))

shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
body = torn([(215, 430), (815, 430), (815, 800), (215, 800)])
top = torn([(205, 300), (800, 205), (822, 330), (225, 425)], amp=8)
for poly in (body, top):
    sd.polygon([(x + 14, y + 22) for x, y in poly], fill=(0, 0, 0, 150))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))

d = ImageDraw.Draw(img)
d.polygon(body, fill=(240, 226, 200, 255))          # крафт-бумага
d.polygon(top, fill=(240, 226, 200, 255))
# полосы хлопушки
for i in range(4):
    x = 250 + i * 150
    d.polygon([(x, 300 - i * 24), (x + 70, 288 - i * 24), (x + 20, 410 - i * 24), (x - 50, 422 - i * 24)],
              fill=(45, 47, 54, 255))
for i in range(5):
    x = 245 + i * 125
    d.polygon([(x, 440), (x + 62, 440), (x + 12, 520), (x - 50, 520)], fill=(45, 47, 54, 255))
# искра Claude
cx, cy, r = 515, 665, 95
star = []
for k in range(16):
    a = math.pi * k / 8
    rr = r if k % 2 == 0 else r * 0.28
    star.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
d.polygon(star, fill=(217, 119, 87, 255))

img.save(os.path.join(HERE, "icon.png"))
print("icon.png")
