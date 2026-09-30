"""Проект для Premiere Pro: видео + каждый звук отдельным клипом на дорожках.

    python ../_pipeline/premiere_export.py        (в папке проекта, после ./build.sh)

Берёт звуки так же, как audio.py (тот же порядок и seed, поэтому синтезированные шаги и щелчки
те же, что в миксе), и пишет:
  out/premiere/<проект>.xml    — Final Cut 7 XML: Premiere → File → Import → откроется секвенция
  out/premiere/audio/*.wav     — клипы (громкость уже вшита, фейдеры на 0 dB = как в mix.wav)
Дорожки: голос хука, звериная речь, музыка, гул ламп (если audio.py умеет build_music(parts=True)),
звуки по полосам без наложений (шаги отдельно), в конце выключенный готовый микс для сравнения.
Маркеры секвенции — начала сцен.
"""
import json, os, sys, wave, subprocess, inspect
from urllib.parse import quote
from xml.sax.saxutils import escape
import numpy as np

sys.path.insert(0, os.getcwd())
import audio as A

FPS = 60
SR = A.SR
PROJ = os.path.basename(os.getcwd())
OUT = os.path.join("out", "premiere")
AUD = os.path.join(OUT, "audio")
os.makedirs(AUD, exist_ok=True)
for f in os.listdir(AUD):
    if f.endswith(".wav"): os.remove(os.path.join(AUD, f))

# ---- capture every put() from audio.py
cap = []
real_put = A.put
def spy(out, t, y):
    cap.append((t, np.array(y, dtype=float)))
    real_put(out, t, y)
A.put = spy

# same order as audio.py __main__ (the rng is shared)
if "parts" in inspect.signature(A.build_music).parameters:
    music = A.build_music(parts=True)
else:
    music = {"Музыка": A.build_music()}
cap.clear()
sfx = A.build_sfx()
sfx_caps = cap[:]; cap.clear()
vo = A.load_vo(); cap.clear()
talk = A.build_talk()
talk_caps = cap[:]; cap.clear()
A.put = real_put

# ducking and the master normalisation, exactly like the mix in audio.py
lvl = A.MUSIC["level"]
music_sum = sum(music.values())
duck_env = A.duck(np.ones(A.N), vo + talk)
mix = music_sum * lvl * duck_env + sfx * 0.26 + vo + talk * 0.8
NORM = 1 / max(1.0, np.abs(mix).max() / 0.97)

resolved = json.load(open("build/sfx_resolved.json", encoding="utf-8"))
sfx_meta = [r for r in resolved if r["src"] != "animalese"]
talk_meta = [r for r in resolved if r["src"] == "animalese"]
assert len(sfx_meta) == len(sfx_caps), (len(sfx_meta), len(sfx_caps))


def write_wav(name, y, t):
    """stereo 16-bit; leading silence so the clip starts exactly on a frame -> (file, start frame, frames)"""
    f0 = int(np.floor(t * FPS + 1e-6))
    pad = max(0, int(t * SR) - f0 * SR // FPS)          # same sample as audio.put(): int(t * SR)
    y = np.concatenate([np.zeros(pad), y])
    peak = np.abs(y).max()
    if peak > 0.999: print(f"  ! {name}: пик {peak:.2f} > 0 dB, клиппинг в клипе")
    path = os.path.join(AUD, name + ".wav")
    st = (np.clip(np.stack([y, y], 1), -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
    return path, f0, int(np.ceil(len(y) / SR * FPS))


def safe(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)[:60]


tracks = []          # (name, [clip dicts], enabled)

# hook voice
if np.abs(vo).max() > 0:
    nz = np.nonzero(np.abs(vo) > 1e-6)[0]
    a, b = nz[0], nz[-1] + 1
    p, f0, n = write_wav("vo_hook", vo[a:b] * NORM, a / SR)
    tracks.append(("Голос", [dict(name="Голос (хук)", path=p, start=f0, dur=n)], True))

# animalese lines
clips = []
for i, ((t, y), m) in enumerate(zip(talk_caps, talk_meta)):
    who = m["type"].split(":")[1]
    p, f0, n = write_wav(f"talk_{i:02d}_{who}", y * 0.8 * NORM, t)
    clips.append(dict(name=m["type"][5:], path=p, start=f0, dur=n))
if clips: tracks.append(("Звериная речь", clips, True))

# music stems
for k, y in music.items():
    p, f0, n = write_wav(safe(k), y * lvl * duck_env * NORM, 0)
    tracks.append((k, [dict(name=k, path=p, start=f0, dur=n)], True))

# sfx: lanes without overlaps; steps get their own lanes
def pack(items, title):
    lanes = []
    for c in sorted(items, key=lambda c: c["start"]):
        for L in lanes:
            if L[-1]["start"] + L[-1]["dur"] <= c["start"]:
                L.append(c); break
        else:
            lanes.append([c])
    for j, L in enumerate(lanes):
        tracks.append((f"{title} {j + 1}" if len(lanes) > 1 else title, L, True))

main, steps = [], []
for (t, y), m in zip(sfx_caps, sfx_meta):
    short = m["type"].replace("lib:", "").replace("file:assets/", "").split("|")[0]
    p, f0, n = write_wav(f"sfx_{m['i']:03d}_s{m.get('scene')}_{safe(short)}", y * 0.26 * NORM, t)
    c = dict(name=f"#{m['i']} {short}", path=p, start=f0, dur=n)
    (steps if m["type"] == "step" else main).append(c)
pack(main, "Звуки")
pack(steps, "Шаги")

# reference: the finished mix, track off
if os.path.exists("build/mix.wav"):
    with wave.open("build/mix.wav") as w: nfr = w.getnframes()
    import shutil                        # a copy: Premiere keeps its media open, and a locked build/mix.wav breaks ./build.sh
    shutil.copyfile("build/mix.wav", os.path.join(AUD, "mix_reference.wav"))
    tracks.append(("Готовый микс (сравнить)", [dict(name="mix.wav", path=os.path.abspath(os.path.join(AUD, "mix_reference.wav")),
                   start=0, dur=int(np.ceil(nfr / SR * FPS)))], False))

# ---- xmeml
videos = [f for f in os.listdir("out") if f.endswith(".mp4") and "NO_VO" not in f]
video = os.path.abspath(os.path.join("out", videos[0]))
vdur = int(round(float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                                      capture_output=True, text=True).stdout) * FPS))
seq_dur = max([vdur] + [c["start"] + c["dur"] for _, cl, _ in tracks for c in cl])


def url(p):
    return "file://localhost/" + quote(os.path.abspath(p).replace("\\", "/"), safe="/")


RATE = f"<rate><timebase>{FPS}</timebase><ntsc>FALSE</ntsc></rate>"
ids = {"n": 0}
def nid(pfx):
    ids["n"] += 1; return f"{pfx}-{ids['n']}"


def audio_clip(c):
    fid = nid("file")
    return f"""<clipitem id="{nid('clip')}"><name>{escape(c['name'])}</name><enabled>TRUE</enabled><duration>{c['dur']}</duration>{RATE}
<start>{c['start']}</start><end>{c['start'] + c['dur']}</end><in>0</in><out>{c['dur']}</out>
<file id="{fid}"><name>{escape(os.path.basename(c['path']))}</name><pathurl>{url(c['path'])}</pathurl>{RATE}<duration>{c['dur']}</duration>
<media><audio><samplecharacteristics><depth>16</depth><samplerate>{SR}</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>
<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>"""


secs = A.VO["sections"]
try:
    names = [l.split("—", 1)[1].strip() for l in open("script.md", encoding="utf-8") if l.startswith("### ") and "—" in l]
except Exception:
    names = []
markers = "".join(f"<marker><name>{escape(f'{k}. ' + (names[k] if k < len(names) else ''))}</name><comment></comment>"
                  f"<in>{int(round(s['start'] * FPS))}</in><out>-1</out></marker>" for k, s in enumerate(secs))

atracks = "".join(f"<track><enabled>{'TRUE' if en else 'FALSE'}</enabled><locked>FALSE</locked>"
                  + "".join(audio_clip(c) for c in cl)
                  + f"<outputchannelindex>1</outputchannelindex></track>" for name, cl, en in tracks)

vclip = f"""<clipitem id="{nid('clip')}"><name>{escape(os.path.basename(video))}</name><enabled>TRUE</enabled><duration>{vdur}</duration>{RATE}
<start>0</start><end>{vdur}</end><in>0</in><out>{vdur}</out>
<file id="{nid('file')}"><name>{escape(os.path.basename(video))}</name><pathurl>{url(video)}</pathurl>{RATE}<duration>{vdur}</duration>
<media><video><samplecharacteristics>{RATE}<width>1080</width><height>1920</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video></media></file>
</clipitem>"""

xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1"><name>{escape(PROJ)}</name><duration>{seq_dur}</duration>{RATE}
<timecode>{RATE}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
{markers}
<media>
<video><format><samplecharacteristics>{RATE}<width>1080</width><height>1920</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
<track><enabled>TRUE</enabled><locked>FALSE</locked>{vclip}</track></video>
<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
{atracks}</audio>
</media></sequence>
</xmeml>
"""
dst = os.path.join(OUT, PROJ + ".xml")
open(dst, "w", encoding="utf-8").write(xml)

# track list for the user (Premiere's XML import drops track names)
with open(os.path.join(OUT, "дорожки.txt"), "w", encoding="utf-8") as f:
    for i, (name, cl, en) in enumerate(tracks, 1):
        f.write(f"A{i}: {name} — {len(cl)} клип(ов){'' if en else ' (выключена)'}\n")
print(f"ok: {dst}\n  дорожек: {len(tracks)}, клипов: {sum(len(c) for _, c, _ in tracks)}, нормализация {20*np.log10(NORM):+.1f} dB")
