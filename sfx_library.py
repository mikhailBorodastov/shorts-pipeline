"""Библиотека звуков для всех шортов.

    python sfx_library.py import "C:/путь/к/паку"     — добавить пак (можно несколько раз, разные паки)
    python sfx_library.py import "C:/путь/к/паку" --fresh   — очистить библиотеку и импортировать заново
    python sfx_library.py rebuild                      — пересобрать каталог по уже импортированным файлам
    python sfx_library.py find удар                    — поиск по каталогу

Кладёт звуки в _pipeline/sfx_library/<категория>/<id>.wav (моно, 44.1 кГц, тишина в начале срезана)
и пишет:
    sfx_library/index.json   — данные (id, длительность, момент пика, громкость, теги)
    sfx_library/index.md     — каталог для Claude
    sfx_library/browser.html — страница-прослушка (открыть двойным кликом)

В проекте звук вызывается так:  add(t, 'lib:whoosh/quick-a', gain, 'peak')
('peak' — выровнять пик звука на момент t; по умолчанию звук начинается в t).
"""
import html, json, os, re, shutil, subprocess, sys
import numpy as np

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "sfx_library")
SR = 44100
AUDIO_EXT = (".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac", ".aif", ".aiff")
MAX_LEN = 20.0            # длинные эмбиенты режем до 20 с с затуханием

# имена папок пака -> категории (всё остальное — slug от имени папки)
CATEGORY = {
    "anime sfx": "anime", "camera flash": "camera", "cinematic sfx": "cinematic", "elatric": "electric",
    "electric": "electric", "fire": "fire", "glitches": "glitch", "hits": "hit", "meme sfx": "meme",
    "others": "other", "riser": "riser", "whosh": "whoosh", "wooshes": "whoosh",
}
CAUTION = {"meme": "мем-клипы из игр/фильмов/видео — чужие записи, в публичные ролики с осторожностью"}


def slug(s):
    full = re.sub(r"[^a-z0-9а-яё]+", "-", re.sub(r"^copy of\s+", "", s.lower())).strip("-")
    short = _slug(s)
    # if stripping the noise words left almost nothing ("Sound Effect 2" -> "2"), keep the full name
    return short if len(re.sub(r"[\d-]", "", short)) >= 3 else (full or "sound")


def _slug(s):
    s = s.lower()
    s = re.sub(r"^copy of\s+", "", s)
    s = re.sub(r"\s*-\s*sound\s*-\s*sr\.?", "", s)
    s = re.sub(r"(sound effects?|for editing|free download|hd|\(.*?\)|_[a-z0-9]{11}$)", " ", s)
    s = re.sub(r"[^a-z0-9а-яё]+", "-", s).strip("-")
    return s or "sound"


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def analyse_and_trim(y):
    if len(y) == 0:
        return None, None
    thr = 10 ** (-50 / 20) * max(1e-9, np.abs(y).max())
    nz = np.nonzero(np.abs(y) > thr)[0]
    if len(nz) == 0:
        return None, None
    y = y[max(0, nz[0] - int(0.005 * SR)):]                  # срезаем тишину в начале (оставляем 5 мс)
    end = nz[-1] - nz[0] + int(0.05 * SR)
    y = y[:end]
    if len(y) > MAX_LEN * SR:
        y = y[:int(MAX_LEN * SR)]
        y[-int(SR):] *= np.linspace(1, 0, int(SR))
    win = int(0.02 * SR)
    rms = np.sqrt(np.convolve(y * y, np.ones(win) / win, mode="same"))
    info = {
        "dur": round(len(y) / SR, 3),
        "peak_t": round(int(np.argmax(rms)) / SR, 3),                    # где звук громче всего
        "peak_db": round(20 * np.log10(max(1e-9, np.abs(y).max())), 1),
        "rms_db": round(20 * np.log10(max(1e-9, np.sqrt(np.mean(y * y)))), 1),
    }
    return y, info


def write_wav(path, y):
    import wave
    y = np.clip(y, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())


def load_index():
    p = os.path.join(LIB, "index.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"sounds": []}


def import_pack(src):
    os.makedirs(LIB, exist_ok=True)
    idx = load_index()
    have = {s["id"] for s in idx["sounds"]}
    pack = os.path.basename(os.path.normpath(src))
    files = []
    for root, _, names in os.walk(src):
        for n in names:
            if n.lower().endswith(AUDIO_EXT):
                files.append(os.path.join(root, n))
    print(f"Найдено {len(files)} аудиофайлов")
    added = 0
    for i, f in enumerate(sorted(files)):
        folder = os.path.basename(os.path.dirname(f))
        cat = CATEGORY.get(folder.lower(), slug(folder)) if os.path.normpath(os.path.dirname(f)) != os.path.normpath(src) else "misc"
        name = os.path.splitext(os.path.splitext(os.path.basename(f))[0])[0]
        base = f"{cat}/{slug(name)}"
        sid, k = base, 2
        while sid in have:
            sid = f"{base}-{k}"; k += 1
        y, info = analyse_and_trim(decode(f))
        if y is None:
            print("  пропуск (тишина/не читается):", f); continue
        out = os.path.join(LIB, sid + ".wav")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        write_wav(out, y)
        entry = {"id": sid, "category": cat, "name": name, "pack": pack, "source": os.path.relpath(f, src).replace("\\", "/"), **info}
        if cat in CAUTION:
            entry["caution"] = CAUTION[cat]
        idx["sounds"].append(entry); have.add(sid); added += 1
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(files)}")
    save(idx)
    print(f"Добавлено {added}. Всего в библиотеке: {len(idx['sounds'])}")


def save(idx):
    idx["sounds"].sort(key=lambda s: s["id"])
    with open(os.path.join(LIB, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    # каталог для Claude
    lines = ["# Библиотека звуков", "",
             "Вызов в сцене: `add(t, 'lib:<id>', gain, 'peak')` — 'peak' ставит самый громкий момент звука на t.",
             "Колонки: id · длительность · где пик (с) · громкость (RMS dB) · исходное имя", ""]
    cats = {}
    for s in idx["sounds"]:
        cats.setdefault(s["category"], []).append(s)
    for c in sorted(cats):
        lines.append(f"## {c} ({len(cats[c])})" + (f" — ⚠ {CAUTION[c]}" if c in CAUTION else ""))
        for s in cats[c]:
            lines.append(f"- `{s['id']}` · {s['dur']:.2f}s · пик {s['peak_t']:.2f} · {s['rms_db']:.0f} dB · {s['name']}")
        lines.append("")
    open(os.path.join(LIB, "index.md"), "w", encoding="utf-8").write("\n".join(lines))
    # прослушка для человека
    rows = []
    for s in idx["sounds"]:
        rows.append(f'<tr data-q="{html.escape((s["id"] + " " + s["name"]).lower())}"><td><button onclick="pl(this,\'{s["id"]}.wav\')">▶</button></td>'
                    f'<td><code>{s["id"]}</code> <button class="cp" onclick="cp(\'lib:{s["id"]}\')">копировать</button></td>'
                    f'<td>{s["dur"]:.2f}s</td><td class="n">{html.escape(s["name"])}{" ⚠" if s.get("caution") else ""}</td></tr>')
    page = """<!doctype html><meta charset="utf-8"><title>Библиотека звуков</title>
<style>body{font:14px system-ui,sans-serif;background:#0f0c2e;color:#ece9ff;margin:0;padding:16px}
input{width:100%;max-width:520px;padding:8px 10px;border-radius:8px;border:1px solid #3a3490;background:#1d1a4d;color:#fff;font-size:15px}
table{border-collapse:collapse;margin-top:12px;width:100%}td{padding:4px 8px;border-bottom:1px solid #26215e}
code{color:#ffd23f}.n{color:#9a93d6}button{background:#2b2670;color:#fff;border:1px solid #3a3490;border-radius:6px;cursor:pointer}
button.cp{font-size:11px;margin-left:6px}#msg{position:fixed;right:16px;top:16px;background:#3ee07a;color:#000;padding:6px 10px;border-radius:8px;display:none}</style>
<h2>Библиотека звуков · COUNT</h2><input id="q" placeholder="поиск: whoosh, hit, pop, glitch…" autofocus><div id="msg">скопировано</div>
<table>ROWS</table>
<script>const a=new Audio();let cur=null;
function pl(b,src){if(cur===b&&!a.paused){a.pause();b.textContent='▶';return}if(cur)cur.textContent='▶';a.src=src;a.play();b.textContent='❚❚';cur=b;a.onended=()=>b.textContent='▶'}
function cp(t){navigator.clipboard.writeText(t).catch(()=>{});const m=document.getElementById('msg');m.style.display='block';setTimeout(()=>m.style.display='none',900)}
document.getElementById('q').oninput=e=>{const v=e.target.value.toLowerCase().trim().split(/\\s+/);document.querySelectorAll('tr').forEach(r=>r.style.display=v.every(w=>r.dataset.q.includes(w))?'':'none')}</script>"""
    page = page.replace("COUNT", str(len(idx["sounds"]))).replace("ROWS", "\n".join(rows))
    open(os.path.join(LIB, "browser.html"), "w", encoding="utf-8").write(page)


def find(words):
    ws = [w.lower() for w in words]
    for s in load_index()["sounds"]:
        hay = (s["id"] + " " + s["name"]).lower()
        if all(w in hay for w in ws):
            print(f"lib:{s['id']:45s} {s['dur']:6.2f}s  пик {s['peak_t']:.2f}  {s['name']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "import" and len(sys.argv) > 2:
        if "--fresh" in sys.argv and os.path.isdir(LIB):
            shutil.rmtree(LIB)                   # wipe and re-import from scratch
        import_pack([x for x in sys.argv[2:] if x != "--fresh"][0])
    elif cmd == "rebuild":
        save(load_index())
    elif cmd == "find":
        find(sys.argv[2:])
    else:
        sys.exit(__doc__)
