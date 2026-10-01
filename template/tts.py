"""Черновая озвучка из script.md (edge-tts) + тайминги слов для субтитров и анимации.

    python tts.py

Читает script.md в любом из двух форматов:
  • пайплайн:  "## 1. Название" + поле "Голос: …"
  • сценарист (_pipeline/prompts/scriptwriter.md): "### 0:00–0:04 — НАЗВАНИЕ" + "**VO:**" и строки "> …"
Каждый заголовок с голосом — одна сцена; разделы без голоса (упаковка, источники) пропускаются.
Настройки до первой сцены (необязательно):
    voice: ru-RU-DmitryNeural      (или ru-RU-SvetlanaNeural)
    rate: +25%
    произношение: Chrono Trigger = Кроно Триггер
    вопрос: верим                  (слово с вопросительной интонацией; «вопрос: DLC @14» — только в сцене 14)
    хвост: 0.1                     (секунд после последней фразы, по умолчанию 2; короткий хвост = резкий обрыв для лупа)
Пауза внутри фразы: «в кусты, в подвал, [пауза 1.5] под машину» — фраза синтезируется целиком (интонация не рвётся),
после слова перед меткой вставляется тишина, тайминги следующих слов сдвигаются.

Пишет build/vo/sec{N}.mp3, build/vo_timing.json и src/vo_timing.js (window.VO).
"""
import asyncio, difflib, json, os, re, subprocess, sys
import edge_tts

GAP = 0.25          # пауза между секциями, сек
LEAD_IN = 0.6       # тишина в самом начале
TAIL = 2.0          # хвост после последней фразы
OUT = os.path.join("build", "vo")


SCENE_HEAD = re.compile(r"^#{2,3}\s+(.+?)\s*$", re.M)
TIMECODE = re.compile(r"(\d+:\d{2}(?:\.\d+)?)\s*[–—-]\s*(\d+:\d{2}(?:\.\d+)?)")


def _secs(tc):
    m, s = tc.split(":")
    return int(m) * 60 + float(s)


def _voice_of(block):
    """Voice-over text of one scene block, in either format:
       pipeline:     'Голос: текст…'                         (until the next 'Поле:' line)
       scriptwriter: '**VO:**' followed by '> текст' lines   (prompts/scriptwriter.md)"""
    # '**VO:**' (optionally followed by a note like '*(шёпотом)*' on the same line) + '> …' quote lines
    m = re.search(r"\**VO\**\s*:\**[ \t]*([^\n]*)\n((?:[ \t]*>.*\n?)+)", block, re.I)
    if m:
        lines = [re.sub(r"^\s*>\s?", "", l) for l in m.group(2).splitlines() if l.strip()]
        return " ".join(lines)
    m = re.search(r"\**VO\**\s*:\**\s*(\S.+)", block, re.I)          # '**VO:** текст' on one line
    if m:
        return m.group(1)
    m = re.search(r"(?:^|\n)\s*[-*]?\s*\**Голос\**\s*:\s*(.+?)(?=\n\s*[-*]?\s*\**[А-ЯA-Z][а-яa-z]+\**\s*:|\Z)", block, re.S)
    return m.group(1) if m else None


PAUSE = re.compile(r"\[\s*пауза\s+([\d.]+)\s*(?:с|сек)?\s*\]", re.I)


def split_pauses(voice):
    """'…в подвал, [пауза 1.5] под машину' -> clean text + [(display words before the pause, seconds)]"""
    pauses, out, pos = [], [], 0
    for m in PAUSE.finditer(voice):
        out.append(voice[pos:m.start()]); pos = m.end()
        pauses.append((len(_merge_dashes(" ".join(out).split())), float(m.group(1))))
    out.append(voice[pos:])
    return re.sub(r"\s+", " ", " ".join(out)).strip(), pauses


def insert_pauses(path, words, pauses):
    """Вставляет тишину после слова pauses[i][0]-1 (в середину паузы между словами), сдвигает тайминги."""
    import numpy as np
    SR = 24000
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.int16)
    words = [dict(w) for w in words]
    for n, sec in sorted(pauses, key=lambda p: -p[0]):          # from the end, so earlier cut points stay valid
        if n <= 0 or n > len(words): continue
        end = words[n - 1]["t"] + words[n - 1]["d"]
        at = (end + words[n]["t"]) / 2 if n < len(words) else end + 0.05
        c = min(len(a), int(at * SR))
        a = np.concatenate([a[:c], np.zeros(int(sec * SR), dtype=np.int16), a[c:]])
        for w in words[n:]: w["t"] = round(w["t"] + sec, 3)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-b:a", "96k", path],
                   input=a.tobytes(), check=True)
    return words


def parse_script(path="script.md"):
    """Scenes = '## ' or '### ' headings that contain a voice-over; everything else (packaging, sources…) is ignored.
       Settings (voice, rate, произношение, вопрос) are read from the lines before the first scene."""
    text = open(path, encoding="utf-8").read()
    cfg = {"voice": "ru-RU-DmitryNeural", "rate": "+25%", "pitch": "+0Hz", "pron": {}, "rise": []}
    # голос канала Claude Studio (S9): <канал>/style/voice.json — по умолчанию; строки voice: / rate: в шапке script.md важнее
    chv = os.path.join(os.path.dirname(os.path.abspath(path)), "..", "..", "style", "voice.json")
    if os.path.isfile(chv):
        try:
            v = json.load(open(chv, encoding="utf-8"))
            cfg.update({k: v[k] for k in ("voice", "rate", "pitch") if v.get(k)})
        except ValueError:
            pass
    heads = list(SCENE_HEAD.finditer(text))
    head = text[:heads[0].start()] if heads else text
    for line in head.splitlines():
        m = re.match(r"\s*(voice|rate)\s*:\s*(.+)", line, re.I)
        if m:
            cfg[m.group(1).lower()] = m.group(2).strip()
        m = re.match(r"\s*хвост\s*:\s*(-?[\d.]+)", line, re.I)
        if m:                                   # 'хвост: 0.1' — seconds after the last spoken word (short = hard cut for a loop)
            cfg["tail"] = float(m.group(1))
        m = re.match(r"\s*вопрос\s*:\s*(.+?)\s*(?:@\s*(\d+))?\s*$", line, re.I)
        if m:                                   # 'вопрос: слово' or 'вопрос: слово @14' (only in scene 14)
            cfg["rise"].append((m.group(1).strip(), int(m.group(2)) if m.group(2) else None))
        m = re.match(r"\s*произношение\s*:\s*(.+?)\s*=\s*(.+)", line, re.I)
        if m:
            cfg["pron"][m.group(1).strip()] = m.group(2).strip()
    sections = []
    for k, h in enumerate(heads):
        block = text[h.end():heads[k + 1].start() if k + 1 < len(heads) else len(text)]
        voice = _voice_of(block)
        if not voice:
            # a scene with a timecode and a picture but no voice = a silent beat of that length
            tc = TIMECODE.search(h.group(1))
            if tc and re.search(r"\**(Картинка|Визуал)\**\s*:", block, re.I):
                dur = _secs(tc.group(2)) - _secs(tc.group(1))
                if dur > 0:
                    sections.append({"title": h.group(1).replace("**", "").strip(), "text": "", "silence": round(dur, 3)})
            continue
        voice = re.sub(r"\*\([^)]*\)\*", " ", voice)                   # director's notes *(…)* are not spoken
        voice = re.sub(r"[*_]{1,2}", "", voice)                          # markdown emphasis
        voice = re.sub(r"\s+", " ", voice).strip().strip("«»\"")
        voice, pauses = split_pauses(voice)
        if voice:
            sections.append({"title": h.group(1).replace("**", "").strip(), "text": voice, "pauses": pauses})
    if not sections:
        sys.exit("В script.md не найдено ни одной сцены с голосом (поле «Голос:» или «**VO:**» с цитатой «> …»)")
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
    comm = edge_tts.Communicate(spoken, cfg["voice"], rate=cfg["rate"], pitch=cfg.get("pitch") or "+0Hz", boundary="WordBoundary")
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


MAX_PAUSE = 0.32   # паузы между фразами длиннее этого ужимаются (edge-tts делает ~1 с)


def tighten(path, words):
    """Вырезает лишнюю тишину между словами; сдвигает тайминги."""
    import numpy as np
    SR = 24000
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.int16)
    keep, cur, shift = [], 0, 0.0
    out_words = []
    for k, w in enumerate(words):
        w = dict(w); w["t"] -= shift; out_words.append(w)
        if k + 1 < len(words):
            end = words[k]["t"] + words[k]["d"]; gap = words[k + 1]["t"] - end
            if gap > MAX_PAUSE:
                cut = gap - MAX_PAUSE
                c0 = int((end + MAX_PAUSE / 2) * SR); c1 = int((end + MAX_PAUSE / 2 + cut) * SR)
                keep.append(a[cur:c0]); cur = c1; shift += cut
    keep.append(a[cur:])
    b = np.concatenate(keep)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-b:a", "96k", path],
                   input=b.tobytes(), check=True)
    return out_words


def _f0_track(y, sr, hop):
    """F0 по кадрам (автокорреляция); 0 = глухой кадр."""
    import numpy as np
    n = int(0.03 * sr); lo, hi = sr // 350, sr // 65; out = []
    thr = 0.02 * (np.abs(y).max() + 1e-9)
    for i in range(0, len(y), hop):
        w = y[i:i + n]
        if len(w) < n or np.sqrt(np.mean(w ** 2)) < thr: out.append(0.0); continue
        w = w - w.mean(); ac = np.correlate(w, w, "full")[n - 1:]
        lag = lo + int(np.argmax(ac[lo:hi]))
        out.append(sr / lag if ac[lag] > 0.25 * ac[0] else 0.0)
    return np.array(out)


def psola(y, sr, a, b, factor):
    """TD-PSOLA: меняет высоту тона на отрезке [a, b] c (factor(u), u = 0..1 по отрезку), не меняя длительность."""
    import numpy as np
    A, Bi = int(a * sr), int(b * sr)
    seg = y[A:Bi].astype(float); hop = int(0.005 * sr)
    f0 = _f0_track(seg, sr, hop)
    per = lambda i: sr / f0[min(len(f0) - 1, i // hop)] if f0[min(len(f0) - 1, i // hop)] > 0 else None
    marks, i = [], 0                                       # analysis pitch marks on local maxima
    while i < len(seg):
        P = per(i) or int(0.006 * sr)
        j0, j1 = max(0, i - int(P * 0.3)), min(len(seg), i + int(P * 0.3) + 1)
        m = j0 + int(np.argmax(seg[j0:j1])) if per(i) else i
        if marks and m <= marks[-1]: m = marks[-1] + int(P * 0.5)
        marks.append(m); i = m + int(P)
    marks = np.array([m for m in marks if m < len(seg)])
    out = np.zeros(len(seg) + sr // 10); wsum = np.zeros_like(out)
    ts = float(marks[0]) if len(marks) else 0.0
    while len(marks) and ts < len(seg):
        k = int(np.argmin(np.abs(marks - ts))); m = marks[k]
        P = int(marks[k + 1] - m) if k + 1 < len(marks) else int(0.006 * sr)
        P = max(20, min(P, int(0.016 * sr)))
        voiced = per(m) is not None
        f = factor(ts / len(seg)) if voiced else 1.0
        w = np.hanning(2 * P + 1); s0 = m - P
        src = np.zeros(2 * P + 1); lo_, hi_ = max(0, s0), min(len(seg), s0 + 2 * P + 1)
        src[lo_ - s0:hi_ - s0] = seg[lo_:hi_]
        d0 = int(ts) - P
        if d0 >= 0: out[d0:d0 + 2 * P + 1] += src * w; wsum[d0:d0 + 2 * P + 1] += w
        ts += P / f
    out = out[:len(seg)]; wsum = wsum[:len(seg)]
    res = np.where(wsum > 0.2, out / np.maximum(wsum, 1e-9), seg)
    fade = min(len(seg) // 4, int(0.012 * sr))           # crossfade into the untouched audio
    ramp = np.linspace(0, 1, fade)
    res[:fade] = seg[:fade] * (1 - ramp) + res[:fade] * ramp
    res[-fade:] = res[-fade:] * (1 - ramp) + seg[-fade:] * ramp
    y = y.copy(); y[A:Bi] = res
    return y


QUESTION = {"peak": 1.3, "tail": 1.45}   # вопрос: пик на ударном слоге ×1.3, конец слова не проваливается (×1.45)


def rise_tail(path, words, keys):
    """Вопросительная интонация для слов из `вопрос:` — плавный контур через PSOLA, без нарезки."""
    import numpy as np
    SR = 24000
    y = None
    for w in words:
        if not any(k in _norm(w["w"]) for k in keys):
            continue
        if y is None:
            raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
            y = np.frombuffer(raw, dtype=np.int16).astype(float)
        pk, tl = QUESTION["peak"], QUESTION["tail"]
        fac = lambda u: 1 + (pk - 1) * np.exp(-((u - 0.3) / 0.18) ** 2) + (tl - 1) * np.clip((u - 0.45) / 0.45, 0, 1)
        y = psola(y, SR, w["t"], w["t"] + w["d"] + 0.12, fac)
    if y is not None:
        y = np.clip(y, -32768, 32767).astype(np.int16)
        tmp = path + ".q.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-b:a", "96k", tmp], input=y.tobytes(), check=True)
        os.replace(tmp, path)


DASHES = ("—", "-", "–")
GLUE = "⁣"            # invisible separator: keeps a multi-word pronunciation as one display word


def _merge_dashes(words):
    merged = []
    for w in words:
        if w in DASHES and merged:
            merged[-1] += " " + w          # тире не озвучивается — приклеиваем к слову
        else:
            merged.append(w)
    return merged


def map_display_words(text, spoken_words, spoken_text, pron=None):
    """Переносит тайминги произнесённых слов на слова оригинального текста (для субтитров).
    Если произношение превращает одно слово в несколько («GTA = гэ, тэ, а»), на экране остаётся исходное слово,
    а его время — от первого до последнего произнесённого куска."""
    merged = _merge_dashes(text.split())
    glued = text
    for k, v in (pron or {}).items():
        n = len(k.split())                  # «Star Wars Outlaws = Стар Ворс Аутлоз»: word for word, no glue
        glued = glued.replace(k, v if n > 1 and len(v.split()) == n else v.replace(" ", GLUE))
    groups = [g for g in glued.split() if g not in DASHES]
    if len(groups) != len(merged):          # не смогли сопоставить — показываем произнесённый текст
        merged = [w for w in spoken_text.split() if w not in DASHES]
        groups = merged
    parts, owner = [], []
    for gi, g in enumerate(groups):
        for piece in g.split(GLUE):
            if _norm(piece) or len(g.split(GLUE)) == 1:
                parts.append(piece); owner.append(gi)
    a = [_norm(w) for w in parts]
    b = [_norm(w["w"]) for w in spoken_words]
    times = [None] * len(parts)
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
    out = []
    for gi in range(len(merged)):
        ts = [times[k] for k in range(len(parts)) if owner[k] == gi]
        t0 = min(x[0] for x in ts); t1 = max(x[0] + x[1] for x in ts)
        out.append({"w": merged[gi], "t": round(t0, 3), "d": round(t1 - t0, 3)})
    return out


async def main():
    cfg, secs = parse_script()
    os.makedirs(OUT, exist_ok=True)
    t = LEAD_IN
    sections = []
    for i, s in enumerate(secs):
        if s.get("silence"):                       # silent beat: a file of pure silence, no words
            path = os.path.join(OUT, f"sec{i}.mp3")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                            "-t", str(s["silence"]), "-b:a", "96k", path], check=True)
            sections.append({"title": s["title"], "start": round(t, 3), "dur": s["silence"], "file": path.replace("\\", "/"),
                             "words": [], "silent": True})
            print(f"sec{i} «{s['title']}»: start {t:.2f}  тишина {s['silence']:.2f}")
            t += s["silence"] + GAP
            continue
        path, words, spoken = await synth_retry(i, s["text"], cfg)
        words = tighten(path, words)
        keys = []
        for word, scene in cfg["rise"]:
            if scene is None or scene == i + 1:     # scene numbers count silent beats too, like the storyboard page
                keys += [_norm(word), _norm(cfg["pron"].get(word, word))]   # words are matched in their spoken form
        if keys:
            rise_tail(path, words, [k for k in keys if k])
        shown = map_display_words(s["text"], words, spoken, cfg["pron"])
        if s.get("pauses"):
            shown = insert_pauses(path, shown, s["pauses"])
        d = duration(path)
        sections.append({"title": s["title"], "start": round(t, 3), "dur": round(d, 3), "file": path.replace("\\", "/"),
                         "words": shown})
        print(f"sec{i} «{s['title']}»: start {t:.2f}  dur {d:.2f}")
        t += d + GAP
    total = t - GAP + cfg.get("tail", TAIL)
    spoken_secs = [x for x in sections if x["words"]]
    if "tail" in cfg and spoken_secs:           # 'хвост:' counts from the end of the last spoken word (mp3 has its own silence)
        lw = spoken_secs[-1]["words"][-1]
        total = spoken_secs[-1]["start"] + lw["t"] + lw.get("d", 0) + cfg["tail"]
    data = {"total": round(total, 3), "sections": sections}
    with open(os.path.join("src", "vo_timing.js"), "w", encoding="utf-8") as f:
        f.write("window.VO = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n")
    with open(os.path.join("build", "vo_timing.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"TOTAL {total:.2f}s")


if __name__ == "__main__":
    asyncio.run(main())
