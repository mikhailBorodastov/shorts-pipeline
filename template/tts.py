"""Черновая озвучка из script.md (edge-tts) + тайминги слов для субтитров и анимации.

    python tts.py

Читает script.md: каждая секция "## ..." — одна сцена, её текст берётся из поля "Голос:".
Настройки в шапке script.md (необязательно):
    voice: ru-RU-DmitryNeural      (или ru-RU-SvetlanaNeural)
    rate: +25%
    произношение: Chrono Trigger = Кроно Триггер

Пишет build/vo/sec{N}.mp3, build/vo_timing.json и src/vo_timing.js (window.VO).
"""
import asyncio, difflib, json, os, re, subprocess, sys
import edge_tts

GAP = 0.25          # пауза между секциями, сек
LEAD_IN = 0.6       # тишина в самом начале
TAIL = 2.0          # хвост после последней фразы
OUT = os.path.join("build", "vo")


def parse_script(path="script.md"):
    text = open(path, encoding="utf-8").read()
    cfg = {"voice": "ru-RU-DmitryNeural", "rate": "+25%", "pron": {}}
    head = text.split("\n## ", 1)[0]
    for line in head.splitlines():
        m = re.match(r"\s*(voice|rate)\s*:\s*(.+)", line, re.I)
        if m:
            cfg[m.group(1).lower()] = m.group(2).strip()
        m = re.match(r"\s*произношение\s*:\s*(.+?)\s*=\s*(.+)", line, re.I)
        if m:
            cfg["pron"][m.group(1).strip()] = m.group(2).strip()
    sections = []
    for block in re.split(r"\n## ", "\n" + text)[1:]:
        title = block.splitlines()[0].strip()
        m = re.search(r"(?:^|\n)\s*[-*]?\s*\**Голос\**\s*:\s*(.+?)(?=\n\s*[-*]?\s*\**[А-ЯA-Z][а-яa-z]+\**\s*:|\n## |\Z)", block, re.S)
        if not m:
            continue
        voice = re.sub(r"\s+", " ", m.group(1)).strip().strip("«»\"")
        sections.append({"title": title, "text": voice})
    if not sections:
        sys.exit("В script.md не найдено ни одной секции с полем «Голос:»")
    return cfg, sections


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def _norm(w):
    return re.sub(r"[^\wё]", "", w.lower())


async def synth(i, text, cfg):
    spoken = text
    for k, v in cfg["pron"].items():
        spoken = spoken.replace(k, v)
    comm = edge_tts.Communicate(spoken, cfg["voice"], rate=cfg["rate"], boundary="WordBoundary")
    path = os.path.join(OUT, f"sec{i}.mp3")
    words = []
    with open(path, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({"w": chunk["text"], "t": chunk["offset"] / 1e7, "d": chunk["duration"] / 1e7})
    return path, words, spoken


async def synth_retry(i, text, cfg):
    for attempt in range(6):
        try:
            return await synth(i, text, cfg)
        except Exception as e:  # edge-tts иногда отвечает "No audio received" — просто повторяем
            print(f"  retry {attempt + 1}: {e}")
            await asyncio.sleep(2)
    raise RuntimeError("TTS failed")


def map_display_words(text, spoken_words, spoken_text):
    """Переносит тайминги произнесённых слов на слова оригинального текста (для субтитров)."""
    merged = []
    for w in text.split():
        if w in ("—", "-", "–") and merged:
            merged[-1] += " " + w          # тире не озвучивается — приклеиваем к слову
        else:
            merged.append(w)
    spoken_disp = [w for w in spoken_text.split() if w not in ("—", "-", "–")]
    if len(spoken_disp) != len(merged):     # замена произношения изменила число слов
        merged = spoken_disp
    a = [_norm(w) for w in spoken_disp]
    b = [_norm(w["w"]) for w in spoken_words]
    times = [None] * len(merged)
    for blk in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            sw = spoken_words[blk.b + k]
            times[blk.a + k] = (sw["t"], sw["d"])
    for k in range(len(times)):              # числа и т.п. — интерполируем между соседями
        if times[k] is None:
            prev = next((times[j] for j in range(k - 1, -1, -1) if times[j]), (0, 0))
            nxt = next((times[j] for j in range(k + 1, len(times)) if times[j]), None)
            t0 = prev[0] + prev[1]
            t1 = nxt[0] if nxt else t0 + 0.4
            times[k] = (t0 + 0.02, max(0.1, t1 - t0 - 0.04))
    return [{"w": merged[k], "t": round(times[k][0], 3), "d": round(times[k][1], 3)} for k in range(len(merged))]


async def main():
    cfg, secs = parse_script()
    os.makedirs(OUT, exist_ok=True)
    t = LEAD_IN
    sections = []
    for i, s in enumerate(secs):
        path, words, spoken = await synth_retry(i, s["text"], cfg)
        d = duration(path)
        sections.append({"title": s["title"], "start": round(t, 3), "dur": round(d, 3), "file": path.replace("\\", "/"),
                         "words": map_display_words(s["text"], words, spoken)})
        print(f"sec{i} «{s['title']}»: start {t:.2f}  dur {d:.2f}")
        t += d + GAP
    total = t - GAP + TAIL
    data = {"total": round(total, 3), "sections": sections}
    with open(os.path.join("src", "vo_timing.js"), "w", encoding="utf-8") as f:
        f.write("window.VO = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n")
    with open(os.path.join("build", "vo_timing.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"TOTAL {total:.2f}s")


if __name__ == "__main__":
    asyncio.run(main())
