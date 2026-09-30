"""Animalese: «звериная речь» как в Animal Crossing: New Horizons, но по-русски.

Фраза режется на слоги «согласная + её гласная» («ка-же-ца»), одиночные гласные и одиночные согласные. Каждый слог
озвучен edge-tts один раз и закэширован; при сборке звуки обрезаются, ускоряются (это же поднимает тон) и
склеиваются подряд. Так гласные остаются свои, и фразу можно разобрать, но звучит она как лепет зверька.
(Первая версия брала «согласная + а» для каждой буквы — лишние «а» съедали слова.)

  python _pipeline/animalese.py "Будь другом, сбегай наверх!" out.wav [--voice ru-RU-SvetlanaNeural] [--pitch 1.6] [--rate 9]
  python _pipeline/animalese.py "Фраза" out.wav --json '{"voice": "...", "pitch": 1.6, ...}'   # настройки со страницы-конструктора
  python _pipeline/animalese.py --cache ru-RU-SvetlanaNeural        # озвучить все слоги заранее (нужно странице-конструктору)
  из кода:  from animalese import speak; y = speak(text, voice, **params)   # numpy float32, 44100 Гц, моно

Параметры — см. DEFAULTS; подбирать их удобно на странице-конструкторе src/animalese.html (тот же разбор, тот же RNG).
Кэш: _pipeline/animalese_cache/<voice>/<слог>.mp3
"""
import asyncio, os, subprocess, sys, json
import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
VOWELS = "аоуыэиеёюя"
CONS = "бвгджзклмнпрстфхцчшщй"
# what to ask the TTS for each token: syllables as they are, a lone consonant with a short «ы» (the burst is cut out later)
def say(tok):
    if len(tok) == 1 and tok in CONS: return tok + "ы"
    return tok
SIMILAR = {"ц": "с", "щ": "ш", "ж": "ш", "й": "и", "ё": "о", "ы": "и", "э": "е", "ю": "у", "я": "а", "ф": "в", "х": "к", "ч": "ш"}
ALL_TOKENS = [c + v for c in CONS for v in VOWELS] + list(VOWELS) + list(CONS)

# spoken spelling (the subtitles keep the normal text): «кажется» -> «кажеца». Same rules: PHON in src/animalese.html.
PHON = [("ться", "ца"), ("тся", "ца"), ("чтобы", "штобы"), ("что", "што"), ("сч", "щ"), ("жч", "щ"), ("здн", "зн"), ("стн", "сн"),
        ("вств", "ств"), ("лнц", "нц"), ("его ", "ево "), ("ого ", "ова "), ("ь", ""), ("ъ", "")]


def phonetic(text):
    t = " " + " ".join(text.lower().splitlines()) + " "
    for a, b in PHON: t = t.replace(a, b)
    return t.strip()


def tokens(text):
    """[(token, kind)] where kind: 'cv' syllable, 'v' vowel, 'c' lone consonant, ' ' space, ',' comma, '.' stop"""
    t, out, i = phonetic(text), [], 0
    while i < len(t):
        ch = t[i]
        if ch in CONS and i + 1 < len(t) and t[i + 1] in VOWELS: out.append((ch + t[i + 1], "cv")); i += 2; continue
        if ch in CONS: out.append((ch, "c"))
        elif ch in VOWELS: out.append((ch, "v"))
        elif ch == " ": out.append((" ", " "))
        elif ch in ",:;—-": out.append((",", ","))
        elif ch in ".!?…": out.append((ch, "."))
        i += 1
    return out


def _cache(voice):
    d = os.path.join(HERE, "animalese_cache", voice)
    os.makedirs(d, exist_ok=True)
    return d


async def _tts(text, path, voice):
    """A lone sound sometimes gets "No audio received": retry, then try other spellings of the same sound."""
    import edge_tts
    for t in (text, text + ".", text * 2, text + "!"):
        for k in range(2):
            try:
                await edge_tts.Communicate(t, voice, rate="-10%").save(path + ".tmp")
                os.replace(path + ".tmp", path); return
            except Exception:
                await asyncio.sleep(1.0)
    raise RuntimeError("edge-tts: no audio for " + text)


def ensure(voice, toks):
    d = _cache(voice)
    todo = [t for t in dict.fromkeys(toks) if not os.path.exists(os.path.join(d, t + ".mp3"))]
    if not todo: return
    async def run():
        for i, t in enumerate(todo):
            try: await _tts(say(t), os.path.join(d, t + ".mp3"), voice)
            except RuntimeError as e: print("  animalese:", e, "-> похожий звук")
            if len(todo) > 20 and i % 20 == 0: print(f"  animalese {voice}: {i}/{len(todo)}")
            await asyncio.sleep(0.2)
    asyncio.run(run())


def _load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


_mem = {}
def sample(voice, tok):
    """onset-trimmed, peak-normalised samples of a token (0.4 s max); falls back to a similar sound"""
    key = (voice, tok)
    if key in _mem: return _mem[key]
    d = _cache(voice)
    f = os.path.join(d, tok + ".mp3")
    if not os.path.exists(f):
        alt = "".join(SIMILAR.get(c, c) for c in tok)
        f = os.path.join(d, alt + ".mp3")
        if not os.path.exists(f): f = os.path.join(d, tok[-1] + ".mp3")
        if not os.path.exists(f): _mem[key] = None; return None
    y = _load(f); a = np.abs(y); pk = a.max() if a.max() > 0 else 1.0
    on = max(0, int(np.argmax(a > pk * 0.02)) - int(0.008 * SR))
    _mem[key] = y[on:on + int(0.4 * SR)] / pk
    return _mem[key]


def _speed(y, k):
    """Play k times faster (pitch goes up with it, like the game)."""
    n = max(2, int(len(y) / k))
    return np.interp(np.linspace(0, len(y) - 1, n), np.arange(len(y)), y)


# defaults = the «Мама» preset of the constructor page (src/animalese.html in the project)
DEFAULTS = dict(pitch=1.6, rate=8.5, clip=170, cclip=60, jitter=6, sing=3, question=16, exclaim=8, cons=0.7,
                space=0.5, comma=1.6, stop=2.6, tail=35, volume=0.9)


def speak(text, voice="ru-RU-SvetlanaNeural", **params):
    """Same parsing and RNG as the constructor page. params: see DEFAULTS (pitch ×, rate syllables/s, clip ms per syllable,
    cclip ms per lone consonant, jitter %, sing %, question %, exclaim %, cons ×, space / comma / stop × step, tail ms, volume ×).
    Returns samples: float32, 44100 Hz, mono."""
    P = dict(DEFAULTS); P.update({k: v for k, v in params.items() if v is not None and k in DEFAULTS})
    toks = tokens(text)
    ensure(voice, [t for t, k in toks if k in ("cv", "v", "c")])
    rs = [1]
    def rnd():
        rs[0] = (rs[0] * 16807) % 2147483647; return rs[0] / 2147483647
    step = 1.0 / P["rate"]
    txt = phonetic(text)
    q, ex = txt.rstrip().endswith("?"), txt.rstrip().endswith("!")
    n = sum(k in ("cv", "v", "c") for _, k in toks)
    t, i, events = 0.05, 0, []
    for tok, kind in toks:
        if kind in ("cv", "v", "c"):
            i += 1
            k = P["pitch"] * (1 + (rnd() * 2 - 1) * P["jitter"] / 100) * (1 + np.sin(i * 0.55) * P["sing"] / 100)
            fe = n - i
            if q and fe < 3: k *= 1 + P["question"] / 100 * (3 - fe) / 3
            g = (P["cons"] if kind == "c" else 1.0) * P["volume"]
            if ex and fe < 2: k *= 1 + P["exclaim"] / 100 * (2 - fe) / 2; g *= 1.15
            events.append((t, tok, kind, k, g))
            t += step * (0.45 if kind == "c" else 1.0)
        elif kind == " ": t += step * P["space"]
        elif kind == ",": t += step * P["comma"]
        elif kind == ".": t += step * P["stop"]
    out = np.zeros(int((t + 0.5) * SR))
    for t_, tok, kind, k, g in events:
        s = sample(voice, tok)
        if s is None: continue
        y = s[:int((P["cclip"] if kind == "c" else P["clip"]) / 1000 * SR)].copy()
        f = min(len(y), int(P["tail"] / 1000 * SR)); y[len(y) - f:] *= np.linspace(1, 0, f)
        y = _speed(y, k) * g
        s0 = int(t_ * SR); out[s0:s0 + len(y)] += y[:len(out) - s0]
    out *= 0.9
    return np.clip(out, -1, 1).astype(np.float32)


def write(path, y):
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype(np.int16).tobytes())


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--cache"]:
        for v in a[1:] or ["ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"]: ensure(v, ALL_TOKENS); print("ok", v)
        sys.exit(0)
    if len(a) < 2: print(__doc__); sys.exit(1)
    opt = {k.lstrip("-"): v for k, v in zip(a[2::2], a[3::2])}
    if "json" in opt: opt.update(json.loads(opt.pop("json")))
    voice = opt.pop("voice", "ru-RU-SvetlanaNeural")
    y = speak(a[0], voice=voice, **{k: float(v) for k, v in opt.items() if k in DEFAULTS})
    write(a[1], y); print("ok", a[1], round(len(y) / SR, 2), "s")
