"""Своя озвучка: тайминги слов для субтитров и анимации из записанных файлов.

    python align.py                  (файлы build/vo/sec0.* sec1.* ... — mp3/wav/m4a)

Для каждого файла распознаёт речь локально (faster-whisper, модель скачается один раз),
берёт тайминги слов и сопоставляет их со словами секции из script.md.
Пишет src/vo_timing.js и build/vo_timing.json — дальше ./build.sh как обычно.

Первый запуск: pip install faster-whisper
"""
import glob, json, os, sys
from tts import parse_script, duration, map_display_words, GAP, LEAD_IN, TAIL

sys.stdout.reconfigure(encoding="utf-8")
MODEL = os.environ.get("WHISPER_MODEL", "small")   # tiny/base/small/medium — точнее = медленнее


def find_file(i):
    for ext in ("wav", "mp3", "m4a", "ogg", "flac"):
        p = os.path.join("build", "vo", f"sec{i}.{ext}")
        if os.path.exists(p):
            return p
    return None


def main():
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("Нужно один раз поставить: pip install faster-whisper")
    cfg, secs = parse_script()
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    t = LEAD_IN
    sections = []
    for i, s in enumerate(secs):
        if s.get("silence"):                       # silent beat from the script: nothing to record
            sections.append({"title": s["title"], "start": round(t, 3), "dur": s["silence"], "file": None, "words": [], "silent": True})
            t += s["silence"] + GAP
            continue
        path = find_file(i)
        if not path:
            sys.exit(f"Нет файла для секции {i} «{s['title']}»: положи build/vo/sec{i}.mp3 (или .wav)")
        segs, _ = model.transcribe(path, language="ru", word_timestamps=True, initial_prompt=s["text"])
        words = [{"w": w.word.strip(), "t": w.start, "d": max(0.05, w.end - w.start)} for seg in segs for w in seg.words]
        d = duration(path)
        spoken = s["text"]
        for k, v in cfg["pron"].items():
            spoken = spoken.replace(k, v)
        sections.append({"title": s["title"], "start": round(t, 3), "dur": round(d, 3), "file": path.replace("\\", "/"),
                         "words": map_display_words(s["text"], words, spoken)})
        print(f"sec{i} «{s['title']}»: {len(words)} слов распознано, start {t:.2f} dur {d:.2f}")
        t += d + GAP
    data = {"total": round(t - GAP + cfg.get("tail", TAIL), 3), "sections": sections}
    with open(os.path.join("src", "vo_timing.js"), "w", encoding="utf-8") as f:
        f.write("window.VO = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n")
    with open(os.path.join("build", "vo_timing.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"TOTAL {data['total']:.2f}s — теперь ./build.sh")


if __name__ == "__main__":
    main()
