"""Очистка автосубтитров YouTube (.ru.vtt) и метрики пейсинга.

Запуск:  python clean_vtt.py            (из папки с .vtt)
Выход:   clean/<id>.txt  — фразы с таймкодом начала
         words/<id>.tsv  — слова с таймкодами (для точного разбора)
         metrics.csv     — сводка по всем роликам

Как устроены автосубтитры: каждая «новая» строка приходит один раз с тегами
<00:00:01.234><c> слово</c> (пословные тайминги), а потом повторяется в
следующих кьюшках уже без тегов, как «катящаяся» верхняя строка. Поэтому берём
только последнюю строку «длинных» кьюшек (кьюшки по 10 мс — чистые повторы).
Так каждое слово попадает ровно один раз и с его временем.
"""
import csv
import re
import statistics
import sys
from pathlib import Path

TS = r"(\d+):(\d{2}):(\d{2})\.(\d{3})"
CUE_RE = re.compile(TS + r"\s*-->\s*" + TS)
TAG_RE = re.compile(r"<" + TS + r">")
ANY_TAG = re.compile(r"</?[^>]+>")
SENT_END = re.compile(r"[.!?…]+[»\"')]*$")


def secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def fmt(t):
    m, s = divmod(t, 60)
    return f"{int(m):02d}:{s:05.2f}"


def parse(path):
    """-> (words [(t, word)], duration)"""
    lines = path.read_text(encoding="utf-8").splitlines()
    words, end = [], 0.0
    i = 0
    while i < len(lines):
        m = CUE_RE.search(lines[i])
        if not m:
            i += 1
            continue
        start, stop = secs(*m.groups()[:4]), secs(*m.groups()[4:])
        end = max(end, stop)
        i += 1
        body = []
        while i < len(lines) and lines[i] != "" and not CUE_RE.search(lines[i]):
            body.append(lines[i])
            i += 1
        # в «настоящей» кьюшке последняя строка — новая (с тегами, а если в ней
        # одно слово — без тегов); кьюшки по 10 мс только повторяют текст
        if stop - start > 0.05 and body and body[-1].strip():
            ln = body[-1]
            # первое слово без тега получает время начала кьюшки
            parts = re.split(r"(<" + TS + r">)", ln)
            t = start
            j = 0
            while j < len(parts):
                p = parts[j]
                if TAG_RE.fullmatch(p or ""):
                    t = secs(*parts[j + 1:j + 5])
                    j += 5
                    continue
                for w in ANY_TAG.sub("", p).split():
                    words.append((t, w))
                j += 1
    return words, end


def sentences(words):
    out, cur = [], []
    for t, w in words:
        cur.append((t, w))
        if SENT_END.search(w):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def main(root):
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(root)
    (root / "clean").mkdir(exist_ok=True)
    (root / "words").mkdir(exist_ok=True)
    rows = []
    for f in sorted(root.glob("*.vtt")):
        vid = f.name.split(".")[0]
        words, dur = parse(f)
        if not words:
            print("пусто:", f.name)
            continue
        sents = sentences(words)
        (root / "clean" / f"{vid}.txt").write_text(
            "\n".join(f"[{fmt(s[0][0])}] " + " ".join(w for _, w in s) for s in sents) + "\n",
            encoding="utf-8")
        (root / "words" / f"{vid}.tsv").write_text(
            "\n".join(f"{t:.3f}\t{w}" for t, w in words) + "\n", encoding="utf-8")
        n = len(words)
        first3 = sum(1 for t, _ in words if t < 3)
        last5 = sum(1 for t, _ in words if t >= dur - 5)
        lens = [len(s) for s in sents]
        speech_end = words[-1][0] + 0.4  # последнее слово + его примерная длина
        last5s = sum(1 for t, _ in words if t >= speech_end - 5)
        rows.append({
            "id": vid,
            "duration_s": round(dur, 1),
            "words": n,
            "wps": round(n / dur, 2),
            "wps_first3": round(first3 / 3, 2),
            "wps_last5": round(last5 / 5, 2),
            "speech_end_s": round(speech_end, 1),
            "tail_silence_s": round(max(0, dur - speech_end), 1),
            "wps_last5_speech": round(last5s / 5, 2),
            "sentences": len(sents),
            "avg_sentence_words": round(n / len(sents), 1),
            "median_sentence_words": statistics.median(lens),
            "first_word_at_s": round(words[0][0], 2),
            "first_sentence": " ".join(w for _, w in sents[0]),
        })
    with open(root / "metrics.csv", "w", newline="", encoding="utf-8-sig") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(rows[0]), delimiter=";")
        wr.writeheader()
        wr.writerows(rows)
    print(f"обработано: {len(rows)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
