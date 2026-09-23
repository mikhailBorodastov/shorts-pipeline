"""Музыка + SFX + сведение с озвучкой.

    python audio.py

Вход:  build/vo_timing.json (из tts.py), build/sfx.json (из `node render.js sfx`), build/vo/*.mp3
Выход: build/mix.wav (всё), build/mix_no_vo.wav (музыка+SFX, под свою озвучку), build/vo.wav

Музыкальные настройки — в блоке MUSIC ниже (доли от общей длины ролика).
"""
import json, subprocess, wave
import numpy as np

SR = 44100
VO = json.load(open("build/vo_timing.json", encoding="utf-8"))
TOTAL = VO["total"]
N = int(TOTAL * SR) + SR
rng = np.random.default_rng(1)

MUSIC = {
    "bpm": 100,
    # аккорды: (бас, [ноты аккорда]) в MIDI; по 2 такта на аккорд. Am F C G
    "prog": [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [55, 60, 64]), (55, [55, 59, 62])],
    "bass_from": 0.12,        # доли от TOTAL
    "arp_from": 0.30,
    "drums": (0.60, 0.80),    # отрезок с битом (кульминация)
    "level": 0.5,             # громкость музыки под голосом
}


def t_arr(d):
    return np.arange(int(d * SR)) / SR


def lowpass(x, cutoff):
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); s = 0.0
    for i in range(len(x)):
        s = (1 - a[i]) * x[i] + a[i] * s
        y[i] = s
    return y


def env_ad(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)


def note(f):
    return 440 * 2 ** ((f - 69) / 12)


# ---------------- SFX (имена = типы в sfx.json) ----------------
def sfx_pop():
    t = t_arr(0.12); f = 380 + 700 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 30) * 0.8


def sfx_whoosh():
    d = 0.9; n = int(d * SR); t = np.arange(n) / SR
    nz = rng.standard_normal(n)
    cut = 300 + 3500 * np.sin(np.pi * t / d) ** 2
    y = lowpass(nz, cut) - lowpass(nz, cut * 0.25)
    return y * np.sin(np.pi * t / d) ** 2 * 1.3


def sfx_thud():
    t = t_arr(0.35); f = 45 + 80 * np.exp(-t * 25)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 12)


def sfx_blip():
    out = []
    for f, d in ((880, 0.07), (1320, 0.12)):
        t = t_arr(d); out.append(np.sign(np.sin(2 * np.pi * f * t)) * 0.25 * np.exp(-t * 15))
    return np.concatenate(out)


def sfx_tick():
    t = t_arr(0.05)
    return (np.sin(2 * np.pi * 2400 * t) + 0.5 * rng.standard_normal(len(t))) * np.exp(-t * 120) * 0.5


def sfx_click():
    t = t_arr(0.08)
    return (np.sin(2 * np.pi * 1600 * t) * np.exp(-t * 90) + np.sin(2 * np.pi * 420 * t) * np.exp(-t * 40)) * 0.6


def sfx_boing():
    t = t_arr(0.4); f = 180 + 220 * np.sin(2 * np.pi * 9 * t) * np.exp(-t * 6)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7) * 0.7


def sfx_rumble():
    n = int(1.6 * SR); t = np.arange(n) / SR
    y = lowpass(rng.standard_normal(n), 140) * 6
    return y * np.minimum(1, t / 0.3) * np.exp(-np.maximum(0, t - 0.5) * 2.5)


def sfx_impact():
    a = sfx_thud() * 1.2
    n = int(1.2 * SR); t = np.arange(n) / SR
    out = lowpass(rng.standard_normal(n), 2500) * np.exp(-t * 4) * 0.5
    out[:len(a)] += a
    return out


def sfx_chime():
    t = t_arr(2.2); y = np.zeros_like(t)
    for f, g in ((note(88), 1), (note(95), 0.6), (note(100), 0.45), (note(107), 0.3)):
        y += g * np.sin(2 * np.pi * f * t) * np.exp(-t * 2.2)
    return y * 0.35


def sfx_crash():
    n = int(1.1 * SR); t = np.arange(n) / SR
    y = lowpass(rng.standard_normal(n), 1800) * np.exp(-t * 4) * 1.2
    th = sfx_thud(); y[:len(th)] += th
    return y


def sfx_zap():
    t = t_arr(0.45); f = 300 + 900 * (0.5 + 0.5 * np.sin(2 * np.pi * 18 * t))
    ph = np.cumsum(f) / SR
    return lowpass((2 * (ph % 1) - 1) * np.exp(-t * 5), 3500) * 0.45


def sfx_thunder():
    n = int(1.8 * SR); t = np.arange(n) / SR
    return rng.standard_normal(n) * np.exp(-t * 18) * 0.8 + lowpass(rng.standard_normal(n), 200) * 5 * np.exp(-t * 2)


def sfx_shimmer():
    out = np.zeros(int(1.6 * SR))
    for i, m in enumerate((81, 84, 88, 91, 93, 96)):
        t = t_arr(1.0); s = int(i * 0.08 * SR)
        out[s:s + len(t)] += np.sin(2 * np.pi * note(m) * t) * np.exp(-t * 4) * 0.25
    return out


SFX = {k[4:]: v for k, v in list(globals().items()) if k.startswith("sfx_")}


def build_sfx():
    out = np.zeros(N)
    try:
        events = json.load(open("build/sfx.json"))
    except FileNotFoundError:
        events = []
    for e in events:
        fn = SFX.get(e["type"])
        if not fn:
            print("  ! неизвестный звук:", e["type"]); continue
        y = fn() * e.get("gain", 1)
        s = int(e["t"] * SR); y = y[:max(0, N - s)]
        out[s:s + len(y)] += y
    return out


def put(out, t, y):
    si = int(t * SR)
    if 0 <= si < N:
        y = y[:N - si]; out[si:si + len(y)] += y


# ---------------- music ----------------
def build_music():
    M = MUSIC
    beat = 60 / M["bpm"]; bar = beat * 4
    bass_from, arp_from = M["bass_from"] * TOTAL, M["arp_from"] * TOTAL
    d0, d1 = M["drums"][0] * TOTAL, M["drums"][1] * TOTAL
    out = np.zeros(N)
    for b in range(int(TOTAL / bar) + 2):
        root, chord = M["prog"][(b // 2) % len(M["prog"])]
        t0 = b * bar
        if t0 > TOTAL: break
        n = int(bar * 1.15 * SR); t = np.arange(n) / SR
        e = np.minimum(1, t / 0.6) * np.minimum(1, np.maximum(0, (bar * 1.15 - t)) / 0.5)
        pad = np.zeros(n)
        for m in chord + [chord[0] + 12]:
            for dt in (-0.12, 0.12):
                f = note(m) * 2 ** (dt / 12)
                pad += np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
        put(out, t0, pad * e * 0.05)
        for k in range(8):                                   # bass 8ths
            ts = t0 + k * beat / 2
            if ts >= bass_from:
                tt = t_arr(beat / 2 * 0.95)
                put(out, ts, np.sin(2 * np.pi * note(root - 24) * tt) * env_ad(len(tt), 0.01, 0.18) * 0.28)
        notes = chord + [chord[0] + 12]
        for k in range(16):                                  # arpeggio 16ths with echo
            ts = t0 + k * beat / 4
            if ts < arp_from: continue
            m = notes[[0, 1, 2, 3, 2, 1, 0, 2][k % 8] % 4] + 12
            tt = t_arr(0.35); ph = note(m) * tt
            y = (2 * np.abs(2 * (ph % 1) - 1) - 1) * env_ad(len(tt), 0.003, 0.09) * 0.07
            for d, g in ((0, 1), (beat * 0.75, 0.4), (beat * 1.5, 0.18)):
                put(out, ts + d, y * g)
        for k in range(4):                                   # kick + hat in the climax
            ts = t0 + k * beat
            if d0 <= ts < d1:
                put(out, ts, sfx_thud() * 0.5)
                tt = t_arr(0.06)
                put(out, ts + beat / 2, rng.standard_normal(len(tt)) * np.exp(-tt * 70) * 0.06)
    t_all = np.arange(N) / SR
    return out * np.minimum(1, t_all / 1.0) * np.minimum(1, np.maximum(0, TOTAL + 0.3 - t_all) / 2.5)


def load_vo():
    out = np.zeros(N)
    for s in VO["sections"]:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", s["file"], "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                             capture_output=True).stdout
        put(out, s["start"], np.frombuffer(raw, dtype=np.float32).astype(float))
    return out


def duck(music, vo):
    k = int(0.15 * SR)
    env = np.convolve(np.abs(vo), np.ones(k) / k, mode="same")
    env = env / (env.max() + 1e-9)
    return music * (1 - 0.45 * np.clip(env * 4, 0, 1))


def write(path, x):
    x = x / max(1.0, np.abs(x).max() / 0.97)
    st = np.stack([x, x], axis=1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())


if __name__ == "__main__":
    music = build_music(); print("music ok")
    sfx = build_sfx(); print("sfx ok")
    vo = load_vo(); print("vo ok")
    write("build/mix_no_vo.wav", music * 0.55 + sfx * 0.45)
    write("build/vo.wav", vo)
    write("build/mix.wav", duck(music * MUSIC["level"], vo) + sfx * 0.4 + vo)
    print("done")
