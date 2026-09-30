"""Сравнение кадров «было / стало» при переводе сцены в редактор (конвертер S1).

    python scene_diff.py <папка было> <папка стало> [--out сравнение.png] [--json]

В папках — кадры стенда element_<t>.png (render_shot.js …&parts=element <папка> 0.6,2.5,9.5); сравниваются общие.
Для каждого кадра: средняя разница по пикселям и 95-й перцентиль (0–255, максимум по каналам).
Порог по ТЗ: средняя < 4 и перцентиль < 24 — иначе «не похоже», код выхода 1.
--out — одна картинка: пары кадров «было | стало | разница ×4» по строкам (уменьшенные), для показа автору.
"""
import argparse, glob, json, os, re, sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MEAN_MAX, P95_MAX = 4.0, 24.0


def frames(d):
    out = {}
    for p in glob.glob(os.path.join(d, "element_*.png")):
        m = re.search(r"element_([\d.]+)\.png$", p)
        if m:
            out[m.group(1)] = p
    return out


def diff(a, b):
    A = np.asarray(Image.open(a).convert("RGB"), dtype=np.int16)
    B = np.asarray(Image.open(b).convert("RGB"), dtype=np.int16)
    if A.shape != B.shape:
        B = np.asarray(Image.open(b).convert("RGB").resize((A.shape[1], A.shape[0])), dtype=np.int16)
    D = np.abs(A - B).max(axis=2)
    return float(D.mean()), float(np.percentile(D, 95)), D


def compare(old, new):
    fo, fn = frames(old), frames(new)
    rows = []
    for t in sorted(set(fo) & set(fn), key=float):
        mean, p95, D = diff(fo[t], fn[t])
        rows.append({"t": float(t), "mean": round(mean, 2), "p95": round(p95, 1), "ok": mean < MEAN_MAX and p95 < P95_MAX,
                     "old": fo[t], "new": fn[t], "_D": D})
    return rows


def sheet(rows, out, scale=0.3):
    if not rows:
        return
    w0, h0 = Image.open(rows[0]["old"]).size
    w, h = int(w0 * scale), int(h0 * scale)
    pad, head = 8, 26
    S = Image.new("RGB", (pad + 3 * (w + pad), len(rows) * (h + head + pad) + pad), (24, 24, 26))
    dr = ImageDraw.Draw(S)
    try:
        fnt = ImageFont.truetype("arial.ttf", 16)
    except OSError:
        fnt = ImageFont.load_default()
    for i, r in enumerate(rows):
        y = pad + i * (h + head + pad)
        mark = "OK" if r["ok"] else "РАЗНИЦА"
        dr.text((pad, y + 4), f"t = {r['t']} с · средняя {r['mean']} · 95% {r['p95']} · {mark}", fill=(230, 230, 230) if r["ok"] else (255, 90, 95), font=fnt)
        y += head
        dimg = Image.fromarray(np.clip(r["_D"] * 4, 0, 255).astype(np.uint8)).convert("RGB")
        for j, im in enumerate((Image.open(r["old"]).convert("RGB"), Image.open(r["new"]).convert("RGB"), dimg)):
            S.paste(im.resize((w, h)), (pad + j * (w + pad), y))
    dr.text((pad, S.height - 4), "", fill=(0, 0, 0))
    S.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old"); ap.add_argument("new")
    ap.add_argument("--out"); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    rows = compare(a.old, a.new)
    if not rows:
        print("нет общих кадров element_<t>.png"); sys.exit(2)
    if a.out:
        sheet(rows, a.out)
    ok = all(r["ok"] for r in rows)
    clean = [{k: v for k, v in r.items() if k != "_D"} for r in rows]
    if a.json:
        print(json.dumps({"ok": ok, "frames": clean, "limits": {"mean": MEAN_MAX, "p95": P95_MAX}}, ensure_ascii=False))
    else:
        for r in clean:
            print(f"t={r['t']:<5} средняя {r['mean']:>6} · 95% {r['p95']:>5}  {'✓' if r['ok'] else '✗'}")
        print("похоже" if ok else f"не похоже (порог: средняя < {MEAN_MAX}, 95% < {P95_MAX})")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
