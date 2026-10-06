"""Проверка сценария по измеримым пунктам чек-листа _pipeline/prompts/style-guide.md.

    python check_script.py            (script.md в папке проекта)
    python check_script.py путь.md

Читает сцены так же, как tts.py (оба формата). Если уже есть build/vo_timing.json
от tts.py и текст не менялся — берёт реальные тайминги голоса, иначе оценивает
время по темпу 2,65 слова/с (медиана эталона).
Код выхода 1, если что-то не прошло (удобно, чтобы Claude сразу правил).

Длинное видео (S12.12, prompts/longform.md) определяется само: кадр 16:9 в src/format.js или «длина:» в шапке больше 3 минут —
тогда нормы на минуту, главы «## Глава N. …» (3+, каждая ≥ 1 мин), длина — по «длина: м:сс» (±25 %) или 6–20 мин.

По референсу (S16, docs/studio/stage16-refbase.md): строка «по референсу: <ссылка>» в шапке — нормы гайда только справкой (ℹ),
проверяется сверка с картой подачи refs/beatmap.json (пишет студия при утверждении карты и перед montage check):
голос и текст на экране каждого бита есть в сценарии и идут в том же порядке, длина фраз и темп — как у референса, длина — как в брифе.
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tts import parse_script  # noqa: E402

WPS = 2.65
BEATMAP_CHECK = 3                              # S16: версия сверки с картой подачи (студия обновляет check_script.py проекта, если она старее)


def long_info(path):
    """(длинное ли видео, цель в секундах или None) — по src/format.js проекта и строке «длина:» в шапке script.md."""
    d = os.path.dirname(os.path.abspath(path))
    wide = False
    for f in (os.path.join(d, "src", "format.js"), os.path.join(d, "..", "src", "format.js")):
        try:
            m = re.search(r"FRAME_SIZE\s*=\s*\[\s*(\d+)\s*,\s*(\d+)", open(f, encoding="utf-8").read())
            wide = bool(m and int(m.group(1)) > int(m.group(2)))
            break
        except OSError:
            pass
    target = None
    try:
        head = re.split(r"^#{2,3}\s", open(path, encoding="utf-8").read(), maxsplit=1, flags=re.M)[0]
        m = re.search(r"^\s*длина\s*:\s*(\d+):(\d{2})", head, re.M | re.I)
        if m:
            target = int(m.group(1)) * 60 + int(m.group(2))
    except OSError:
        pass
    return wide or (target or 0) > 180, target
NUM = re.compile(r"\d[\d.,]*|(?<![а-яё])(одн|два|две|три|четыр|пят|шест|сем|восем|девят|десят|двадцат|тридцат|сорок|сто|двести|триста|четырест|пятьсот|семьсот|тысяч|миллион|миллиард|триллион|млн|млрд|полтора|половин)[а-яё]*", re.I)
TURN = re.compile(r"(но|однако|тем не менее|хотя|а вот)[ ,:]", re.I)
YOU = re.compile(r"(?<![а-яё])(вы|вам|вас|ваш[а-яё]*)(?![а-яё])", re.I)
CTA = re.compile(r"подпиш|подпис[ыа]|лайк|колокольч|пишите в коммент|напишите в коммент", re.I)


def ref_base(path):
    """(ссылка, карта) — если сценарий «по референсу» (S16), иначе (None, None)."""
    try:
        head = re.split(r"^#{2,3}\s", open(path, encoding="utf-8").read(), maxsplit=1, flags=re.M)[0]
    except OSError:
        return None, None
    m = re.search(r"^\s*по референсу\s*:\s*(\S*)", head, re.M | re.I)
    if not m:
        return None, None
    d = os.path.dirname(os.path.abspath(path))
    try:
        bm = json.load(open(os.path.join(d, "refs", "beatmap.json"), encoding="utf-8"))
    except (OSError, ValueError):
        bm = {}
    return m.group(1) or "(ссылка не указана)", bm


def stems(t):
    return [w[:5] for w in re.findall(r"[а-яёa-z0-9]+", (t or "").lower()) if len(w) > 2]


def beat_checks(path, bm, sections, sents, speech, wps, real):
    """S16: сверка сценария с картой подачи -> [(название, значение, ok)]."""
    beats = [b for b in bm.get("beats") or [] if (b.get("our") or {}).get("vo") or (b.get("our") or {}).get("screen")]
    raw = open(path, encoding="utf-8").read().lower()
    vo_text = " ".join(s.get("text") or "" for s in sections).lower()
    vo_st = stems(vo_text)
    pos, hit, miss = [], 0, []
    for i, b in enumerate(beats, 1):
        st = stems((b.get("our") or {}).get("vo"))
        if not st:
            continue
        need, win = max(1, round(len(st) * 0.6)), len(st) + 4
        best = max(range(max(1, len(vo_st))), key=lambda k: (len(set(st) & set(vo_st[k:k + win])), -k), default=0)   # где в голосе этот бит: окно с наибольшим совпадением
        if len(set(st) & set(vo_st[best:best + win])) >= min(need, len(set(st))):
            hit += 1
            pos.append(best)
        else:
            miss.append(str(i))
    with_vo = sum(1 for b in beats if stems((b.get("our") or {}).get("vo")))
    scr = [b for b in beats if ((b.get("our") or {}).get("screen") or "").strip()]
    scr_hit = sum(1 for b in scr if all(w in raw for w in re.findall(r"[а-яёa-z0-9]{3,}", b["our"]["screen"].lower())[:3]))
    R = bm.get("rhythm") or {}
    phr = sum(len(x.split()) for x in sents) / max(1, len(sents))
    n_sc = len(sections)
    out = [
        (f"голос битов карты в сценарии ≥ 80 % (нет: {', '.join(miss) or '—'})", f"{hit} из {with_vo}", hit >= with_vo * 0.8),
        ("биты идут в том же порядке", "да" if pos == sorted(pos) else "переставлены", pos == sorted(pos)),
        (f"сцен — не больше битов ({len(bm.get('beats') or [])}) и не меньше 60 % (биты можно сливать)", n_sc, len(bm.get("beats") or []) * 0.6 <= n_sc <= len(bm.get("beats") or []) + 1),
    ]
    if scr:
        out.append(("текст на экране там, где он был у референса", f"{scr_hit} из {len(scr)}", scr_hit >= len(scr) * 0.8))
    if R.get("phrase"):
        out.append((f"средняя фраза как у референса ({R['phrase']} ±25 %)", f"{phr:.1f}", abs(phr - R["phrase"]) <= R["phrase"] * 0.25 + 0.5))
    if R.get("wps") and real:
        out.append((f"темп как у референса ({R['wps']} сл/с ±20 %)", f"{wps:.2f}", abs(wps - R["wps"]) <= R["wps"] * 0.2))
    chs = []                                   # главы карты (длинное видео) — столько же «## Глава N» в сценарии
    for b in bm.get("beats") or []:
        if b.get("chapter") and b["chapter"] not in chs:
            chs.append(b["chapter"])
    if chs:
        got = len({s.get("chapter") for s in sections if s.get("chapter")})
        out.append((f"глав как в карте ({len(chs)} ±1)", got, abs(got - len(chs)) <= 1))
    if bm.get("lenOur"):
        L = float(bm["lenOur"])
        out.append((f"длина как в брифе ({L:.0f} с ±25 %)", f"{speech:.0f} с", L * 0.75 <= speech <= L * 1.25))
    return out


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
    if not voiced:                             # сюжетный ролик без диктора: мысли и реплики — субтитрами / звериной речью, голоса нет
        total = sum(s.get("silence") or 0 for s in sections)
        print(f"{path}: ролик БЕЗ ДИКТОРА — сцен {len(sections)}, по таймкодам {total:.1f} с. Нормы речи (темп, фразы, «Но», числа) не проверяются.")
        print(("✅" if 20 <= total <= 900 else "❌") + f" длина по таймкодам: {total:.1f} с")
        print("\nВручную: хук в первые 3 с картинкой, смена кадра каждые 5–10 с, субтитры-мысли читаются за время сцены (≈ 12–15 знаков/с), без тишины перед финалом.")
        return 0 if 20 <= total <= 900 else 1
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
    is_long, target = long_info(path)
    if is_long:                                # S12.12: длинное 16:9 — нормы на минуту и главы (prompts/longform.md)
        mins = max(1.0, speech / 60)
        chs = {}
        for s in sections:
            if s.get("chapter"):
                chs.setdefault(s["chapter"], 0.0)
                chs[s["chapter"]] += s.get("silence") or (len((s.get("text") or "").split()) / WPS + sum(x[1] for x in s.get("pauses") or []))
        short_ch = [k for k, v in chs.items() if v < 55]
        lo, hi = (target * 0.75, target * 1.25) if target else (360, 1200)
        late = [s["title"] for s in sections[int(len(sections) * 0.85):] if s.get("silence")]
        checks = [
            (f"длина речи {lo / 60:.0f}–{hi / 60:.0f} мин" + (f" (цель {target // 60}:{target % 60:02d})" if target else ""), f"{speech / 60:.1f} мин", lo <= speech <= hi),
            ("темп 2,4–2,8 сл/с", f"{wps:.2f}", 2.4 <= wps <= 2.8),
            ("средняя фраза 9–14 слов", f"{words / len(sents):.1f}", 9 <= words / len(sents) <= 14),
            ("самая длинная фраза ≤ 22 слов", max(lens), max(lens) <= 22),
            ("первая фраза 10–15 слов", first, 10 <= first <= 15),
            ("первая фраза укладывается в ~5 с", f"{first / WPS:.1f} с", first / WPS <= 5.5),
            ("глав «## Глава N. …» 3–7", len(chs), 3 <= len(chs) <= 7),
            ("каждая глава ≥ 1 мин", ", ".join(short_ch) or "да", not short_ch and bool(chs)),
            ("чисел ≥ 1 в минуту", f"{nums / mins:.1f}/мин", nums >= mins),
            ("«Но / Однако…» в начале фразы ≥ 1 на 2 мин", f"{turns} за {mins:.0f} мин", turns >= mins / 2),
            ("добивок по 2–5 слов ≥ 1 в минуту", punches, punches >= mins),
            ("обращений к зрителю ≤ 1 на 3 мин", you, you <= max(1, mins / 3)),
            ("нет CTA («подпишись», «лайк»…)", "есть" if CTA.search(text) else "нет", not CTA.search(text)),
            ("нет паузы-тишины в последних 15 %", ", ".join(late) or "нет", not late),
        ]
    if first_start is not None:
        checks.insert(0, ("первое слово ≤ 0,7 с", f"{first_start:.2f} с", first_start <= 0.7))
    ref, bm = ref_base(path)
    if ref:                                    # S16: по референсу — нормы гайда справкой, главное — сверка с картой подачи
        print(f"{path}: ПО РЕФЕРЕНСУ {ref} — нормы стайл-гайда справкой (ℹ), проверяется сверка с картой подачи refs/beatmap.json")
        for name, val, ok in checks:
            print(f"ℹ {name}: {val}")
        if not bm:
            print("❌ нет refs/beatmap.json — утверди карту подачи в студии (окно «Сценарий» → «📐 Карта подачи») или montage check из студии")
            return 1
        bad = 0
        print(f"\nСверка с картой подачи v{bm.get('v', 1)} ({len(bm.get('beats') or [])} битов):")
        for name, val, ok in beat_checks(path, bm, sections, sents, speech, wps, bool(timing)):
            bad += not ok
            print(f"{'✅' if ok else '❌'} {name}: {val}")
        print("\nВручную: приём каждого бита узнаётся (хук, ложная догадка, перечисление, поворот, кода), связки и обороты референса на месте.")
        return 1 if bad else 0

    print(f"{path}: {'ДЛИННОЕ 16:9 · ' if is_long else ''}сцен с голосом {len(voiced)}, фраз {len(sents)}; время — {src}")
    print("длины фраз:", " ".join(map(str, lens)))
    bad = 0
    for name, val, ok in checks:
        bad += not ok
        print(f"{'✅' if ok else '❌'} {name}: {val}")
    long = [s for s in sents if len(s.split()) > (22 if is_long else 20)]
    for s in long:
        print("   длинная фраза:", s)
    print("\nВручную (longform.md): обещание в первые 45 с и оно выполнено, поворот в середине, крючок в конце каждой главы, перехват каждые 60–90 с, кода рифмуется с открытием."
          if is_long else "\nВручную (style-guide.md, п.8): тип хука, смена мысли ≤ 10 с, перечисление по нарастанию, "
          "бытовое сравнение для главной цифры, открытая петля, кода рифмуется с хуком, нет морали.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "script.md"))
