"""S21.2 «Сторож»: мерцание в ГОТОВОМ ролике (mp4) — по пикселям, значит видит и 2D, и 3D, и эффекты.

    python flicker.py <ролик.mp4> [--json out.json] [--sheet out.png] [--thr 34]

Что ищем (кадр уменьшается до ~1/12, 8 бит яркости):
  вспышка — участок кадра на 1–2 кадра стал другим и вернулся обратно (|F[t]−F[t−1]| и |F[t+k]−F[t+k+1]| большие, а |F[t−1]−F[t+k+1]| — нет);
  мерцание — такие вспышки в одном месте 2+ раза за секунду.
Не считаем: склейки и переходы (меняется больше 20 % кадра разом — это «весь кадр», а не мерцание), крошки меньше ~0.05 % кадра.
Задуманные мигания (лампа с flicker, глитч, телевизор с помехами) тоже найдутся — автор отмечает их «✓ так задумано».
-> JSON {fps, total, issues: [{type: 'flicker', t0, t1, n, len, area, x, y, where, tShot, box}]}; лист кадров с рамками — --sheet.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", path],
                       capture_output=True, text=True)
    s = json.loads(r.stdout)["streams"][0]
    a, b = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(a) / float(b or 1)


def where(cx, cy):
    v = "сверху" if cy < 0.33 else "снизу" if cy > 0.66 else ""
    h = "слева" if cx < 0.33 else "справа" if cx > 0.66 else ""
    return f"{h} {v}".strip() or "в центре"


def blobs(m, min_px):
    """связные пятна маски (8 соседей) -> [(box в долях, пикселей)] — пылинки и зерно (меньше min_px) отпадают"""
    h, w = m.shape
    seen = np.zeros_like(m)
    out = []
    for y, x in zip(*np.nonzero(m)):
        if seen[y, x]:
            continue
        st, n, x0, y0, x1, y1 = [(y, x)], 0, x, y, x, y
        seen[y, x] = True
        while st:
            cy, cx = st.pop()
            n += 1
            x0, y0, x1, y1 = min(x0, cx), min(y0, cy), max(x1, cx), max(y1, cy)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        st.append((ny, nx))
        if n >= min_px:
            out.append(([x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h], n))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--json")
    ap.add_argument("--sheet")
    ap.add_argument("--thr", type=float, default=34)
    a = ap.parse_args()
    W, H, fps = probe(a.video)
    sw = 90 if H >= W else 160
    sh = int(round(sw * H / W / 2)) * 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", a.video, "-vf", f"scale={sw}:{sh}:flags=area,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    F = np.frombuffer(raw, np.uint8).reshape(-1, sh, sw).astype(np.int16)
    # зона субтитров (караоке перекрашивает слова — не мерцание): 9:16 — y 0.70–0.84 (центр H·0.765), 16:9 — y 0.79–0.93
    cap = np.zeros((sh, sw), bool)
    y0, y1 = (0.70, 0.84) if H >= W else (0.79, 0.93)
    cap[int(sh * y0):int(sh * y1) + 1, :] = True
    N = len(F)
    thr = a.thr
    ev = []                                                     # (кадр, маска) — вспышки длиной k кадров
    if N >= 4:
        d1 = np.abs(np.diff(F, axis=0))                           # d1[t] = |F[t+1] − F[t]|
        big = d1 > thr
        glob = big.mean(axis=(1, 2)) > 0.20                       # склейка / переход / вспышка всего кадра
        # камера едет — тонкие линии проскакивают через пиксель и похожи на вспышки; мерцание глубины в 3D на ходу ловит guard3d (геометрия + картинка)
        moving = (big & ~cap).mean(axis=(1, 2)) > 0.06
        for k in (1, 2):
            # кадры t..t+k−1 отличаются от t−1 и от t+k, а t−1 и t+k похожи
            for t in range(1, N - k):
                if glob[t - 1] or glob[t + k - 1] or moving[t - 1] or moving[t + k - 1]:
                    continue
                m = big[t - 1] & big[t + k - 1] & (np.abs(F[t + k] - F[t - 1]) < thr * 0.5) & ~cap
                if k == 2:
                    m &= np.abs(F[t + 1] - F[t]) < thr * 0.6
                if m.sum() >= 6:
                    for box, n in blobs(m, max(6, int(m.size * 0.0005))):
                        ev.append((t, k, box, n))
    # события в одном месте (рамка пересекается с рамкой ПРОШЛОЙ вспышки этого места, пауза ≤ 0.5 с) — одно «место»
    groups = []
    iou = lambda a, b: max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1])) / max(1e-9, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))
    for t, k, box, n in sorted(ev, key=lambda e: e[0]):
        hit = None
        for g in groups:                                     # то же место — пятно перекрывается с ПЕРВЫМ пятном места хотя бы на 30 %
            if t / fps - g["tl"] <= 0.5 and iou(box, g["anchor"]) >= 0.3:
                hit = g
                break
        if hit:
            if t / fps - hit["tl"] > 1.5 / fps:
                hit["n"] += 1
            hit["tl"] = t / fps
            hit["t1"] = round((t + k) / fps, 2)
            hit["box"] = [min(hit["box"][0], box[0]), min(hit["box"][1], box[1]), max(hit["box"][2], box[2]), max(hit["box"][3], box[3])]
            hit["_px"] = max(hit["_px"], n)
        else:
            groups.append({"type": "flicker", "t0": round(t / fps, 2), "t1": round((t + k) / fps, 2), "n": 1, "len": k, "tShot": round(t / fps, 3),
                           "box": list(box), "anchor": list(box), "tl": t / fps, "_px": n})
    # мерцание — 3+ вспышки в одном месте не реже 2 раз в секунду; разовая вспышка — только крупная (≥ 1.5 % кадра: объект на кадр);
    # реже — моргание глаз, покачивание, мигание лампы по задумке
    issues = []
    # соседние места одного момента (кромка коробки мерцает кусками) — одно замечание: время пересекается, рамки ближе 10 % кадра
    near = lambda a, b: not (a[2] + 0.1 < b[0] or b[2] + 0.1 < a[0] or a[3] + 0.1 < b[1] or b[3] + 0.1 < a[1])
    groups = [g for g in groups if g["n"] >= 3 or g["_px"] >= sw * sh * 0.015]
    merged = []
    for g in sorted(groups, key=lambda g: g["t0"]):
        m = next((x for x in merged if g["t0"] <= x["t1"] + 0.3 and near(g["box"], x["box"])), None)
        if m:
            m["n"] = max(m["n"], g["n"]); m["t1"] = max(m["t1"], g["t1"]); m["_px"] = max(m["_px"], g["_px"])
            m["box"] = [min(m["box"][0], g["box"][0]), min(m["box"][1], g["box"][1]), max(m["box"][2], g["box"][2]), max(m["box"][3], g["box"][3])]
            m["_rate"] = max(m.get("_rate", 0), (g["n"] - 1) / max(1e-3, g["t1"] - g["t0"]))
        else:
            g["_rate"] = (g["n"] - 1) / max(1e-3, g["t1"] - g["t0"])
            merged.append(g)
    groups = merged
    for g in groups:
        g["area"] = round(g.pop("_px") / (sw * sh) * 100, 2)
        rate = g.pop("_rate")
        if not ((g["n"] >= 3 and rate >= 2) or (g["n"] == 1 and g["area"] >= 1.5)):
            continue
        g.pop("anchor"); g.pop("tl")
        g["x"], g["y"] = round((g["box"][0] + g["box"][2]) / 2, 3), round((g["box"][1] + g["box"][3]) / 2, 3)
        g["where"] = where(g["x"], g["y"])
        g["box"] = [round(v, 3) for v in g["box"]]
        issues.append(g)
    out = {"fps": fps, "total": round(N / fps, 2), "frames": N, "issues": issues}
    if a.sheet and issues:
        sheet(a.video, issues[:12], a.sheet, W, H)
        out["sheet"] = a.sheet
    if a.json:
        json.dump(out, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    bad = sum(1 for x in issues if x["n"] > 1)
    print(f"мерцание (по mp4, {N} кадров): {'чисто ✅' if not issues else f'мест {len(issues)} (мерцает {bad}, разовых вспышек {len(issues) - bad})'}")
    for i, x in enumerate(issues, 1):
        print(f"{i}. {'❌' if x['n'] > 1 else '⚠️'} {x['t0']}–{x['t1']} с: {x['where']} — "
              + (f"мерцает, {x['n']} вспышек" if x["n"] > 1 else f"вспышка на {x['len']} кадр.") + f", {x['area']}% кадра")


def FONT():
    from PIL import ImageFont
    for f in (os.path.join(os.path.dirname(__file__), "..", "template", "assets", "fonts", "Rubik.ttf"), r"C:\Windows\Fontsrial.ttf"):
        try:
            return ImageFont.truetype(f, 16)
        except OSError:
            pass
    return ImageFont.load_default()


def sheet(video, issues, out, W, H):
    from PIL import Image, ImageDraw
    tiles = []
    tw = 360 if H >= W else 640
    th = int(tw * H / W)
    for x in issues:
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{x['tShot']:.3f}", "-i", video, "-frames:v", "1", "-vf", f"scale={tw}:{th}", "-f", "image2pipe", "-vcodec", "png", "-"],
                           capture_output=True)
        if not r.stdout:
            continue
        import io
        im = Image.open(io.BytesIO(r.stdout)).convert("RGB")
        d = ImageDraw.Draw(im)
        b = x["box"]
        d.rectangle([b[0] * tw - 4, b[1] * th - 4, b[2] * tw + 4, b[3] * th + 4], outline=(255, 40, 40), width=4)
        d.rectangle([0, 0, tw, 22], fill=(200, 20, 30))
        d.text((6, 2), f"{x['t0']} с · {'мерцает' if x['n'] > 1 else 'вспышка'}", fill=(255, 255, 255), font=FONT())
        tiles.append(im)
    if not tiles:
        return
    cols = min(len(tiles), 4 if H >= W else 3)
    rows = (len(tiles) + cols - 1) // cols
    S = Image.new("RGB", (cols * tw, rows * th), (0, 0, 0))
    for i, im in enumerate(tiles):
        S.paste(im, ((i % cols) * tw, (i // cols) * th))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    S.save(out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
