"""Проверка сценария по измеримым пунктам чек-листа _pipeline/prompts/style-guide.md.

    python check_script.py            (script.md в папке проекта)
    python check_script.py путь.md

Читает сцены так же, как tts.py (оба формата). Если уже есть build/vo_timing.json
от tts.py и текст не менялся — берёт реальные тайминги голоса, иначе оценивает
время по темпу 2,65 слова/с (медиана эталона).
Код выхода 1, если что-то не прошло (удобно, чтобы Claude сразу правил).
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tts import parse_script  # noqa: E402

WPS = 2.65
NUM = re.compile(r"\d[\d.,]*|(?<![а-яё])(одн|два|две|три|четыр|пят|шест|сем|восем|девят|десят|двадцат|тридцат|сорок|сто|двести|триста|четырест|пятьсот|семьсот|тысяч|миллион|миллиард|триллион|млн|млрд|полтора|половин)[а-яё]*", re.I)
TURN = re.compile(r"(но|однако|тем не менее|хотя|а вот)[ ,:]", re.I)
YOU = re.compile(r"(?<![а-яё])(вы|вам|вас|ваш[а-яё]*)(?![а-яё])", re.I)
CTA = re.compile(r"подпиш|подпис[ыа]|лайк|колокольч|пишите в коммент|напишите в коммент", re.I)


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?…])\s+", text) if s.strip()]


def real_timing(sections):
    """[(start, dur)] по сценам с голосом из build/vo_timing.json, если текст совпадает."""
    path = os.path.join("build", "vo_timing.json")
    if not os.path.exists(path):
        return None
    try:
        data = json.load(open(path, encoding="utf-8"))["sections"]
    except Exception:
        return None
    voiced = [s for s in sections if s.get("text")]
    spoken = [d for d in data if d.get("words")]
    if len(voiced) != len(spoken):
        return None
    for s, d in zip(voiced, spoken):          # тире и числа считаются по-разному — допускаем расхождение
        n = len([w for w in s["text"].split() if re.search(r"\w", w)])
        if abs(n - len(d["words"])) > max(2, n * 0.15):
            return None
    return [(d["start"] + d["words"][0]["t"], d["words"][-1]["t"] + d["words"][-1]["d"] - d["words"][0]["t"]) for d in spoken]


def main(path="script.md"):
    sys.stdout.reconfigure(encoding="utf-8")
    _, sections = parse_script(path)
    voiced = [s for s in sections if s.get("text")]
    text = " ".join(s["text"] for s in voiced)
    sents = sentences(text)
    lens = [len(s.split()) for s in sents]
    words = sum(lens)
    first = len(sents[0].split())

    timing = real_timing(sections)
    if timing:
        speech = timing[-1][0] + timing[-1][1] - timing[0][0]
        first_start = timing[0][0]
        src = "реальные тайминги из build/vo_timing.json"
    else:
        speech, first_start = words / WPS, None
        src = f"оценка по темпу {WPS} сл/с (запусти tts.py для реальных)"
    wps = words / speech

    # тишина-пауза ближе к финалу (фидбек пользователя: без пауз перед финалом)
    late_silence = [s["title"] for s in sections[len(sections) // 2:] if s.get("silence")]
    turns = sum(bool(TURN.match(s)) for s in sents)
    nums = len(NUM.findall(text))
    you = len(YOU.findall(text))
    punches = sum(2 <= n <= 5 for n in lens)

    checks = [
        ("длина речи 45–75 с (медиана эталона 60)", f"{speech:.0f} с", 45 <= speech <= 75),
        ("слов 120–190 (≈150–165 на 60 с)", words, 120 <= words <= 190),
        ("темп 2,5–2,8 сл/с", f"{wps:.2f}", 2.5 <= wps <= 2.8),
        ("средняя фраза 9–12 слов", f"{words / len(sents):.1f}", 9 <= words / len(sents) <= 12),
        ("самая длинная фраза ≤ 20 слов", max(lens), max(lens) <= 20),
        ("первая фраза 10–15 слов", first, 10 <= first <= 15),
        ("первая фраза укладывается в ~5 с", f"{first / WPS:.1f} с", first / WPS <= 5.5),
        ("чисел ≥ 4 (техно и деньги — 6+)", nums, nums >= 4),
        ("фраз с «Но / Однако…» в начале ≥ 2", turns, turns >= 2),
        ("добивок по 2–5 слов ≥ 2", punches, punches >= 2),
        ("обращений к зрителю ≤ 1", you, you <= 1),
        ("нет CTA («подпишись», «лайк»…)", "есть" if CTA.search(text) else "нет", not CTA.search(text)),
        ("нет паузы-тишины во второй половине", ", ".join(late_silence) or "нет", not late_silence),
    ]
    if first_start is not None:
        checks.insert(0, ("первое слово ≤ 0,7 с", f"{first_start:.2f} с", first_start <= 0.7))

    print(f"{path}: сцен с голосом {len(voiced)}, фраз {len(sents)}; время — {src}")
    print("длины фраз:", " ".join(map(str, lens)))
    bad = 0
    for name, val, ok in checks:
        bad += not ok
        print(f"{'✅' if ok else '❌'} {name}: {val}")
    long = [s for s in sents if len(s.split()) > 20]
    for s in long:
        print("   длинная фраза:", s)
    print("\nВручную (style-guide.md, п.8): тип хука, смена мысли ≤ 10 с, перечисление по нарастанию, "
          "бытовое сравнение для главной цифры, открытая петля, кода рифмуется с хуком, нет морали.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "script.md"))
