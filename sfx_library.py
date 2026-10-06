"""Библиотека звуков для всех шортов.

    python sfx_library.py import "C:/путь/к/паку"     — добавить пак (можно несколько раз, разные паки)
    python sfx_library.py import "C:/путь/к/паку" --fresh   — очистить библиотеку и импортировать заново
    python sfx_library.py import "C:/пак.zip" --auto --license "Sonniss GDC: royalty-free, без атрибуции"
        --auto — категории по смыслу из имён (whoosh, impact, ui, ambience…; для больших паков), --folders — по папкам; без флага — само
        повторный запуск того же пака продолжает с места (уже импортированное пропускается)
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


# S23: категории по смыслу из имени файла и пути (большие паки вроде Sonniss GDC раскладывают по студиям, а не по типу звука).
# Порядок важен: первое совпадение. Ключи — слова и коды UCS (WHSH, IMPCT, AMB…), с которых начинаются имена в профессиональных паках.
AUTO_CAT = [
    ("meme", r"\bmeme|bruh|vine boom|airhorn|mlg"),
    ("whoosh", r"whoosh|woosh|swoosh|swish|swipe|\bwhsh|pass ?by|passby|fly ?by|\bwhoo"),
    ("riser", r"riser|uplift|build ?up|buildup|\brise\b|rising|tension|\bsweep"),
    ("glitch", r"glitch|\bgltch|data ?err|digital ?err|bitcrush|corrupt|stutter"),
    ("ui", r"\bui\b|\bui[_ -]|button|click|beep|blip|notif|menu|interface|\buser ?int|select|confirm|\bpop\b|bubble ?pop"),
    ("explosion", r"explo|\bexpl|blast|boom\b|detonat|\bkaboom"),
    ("impact", r"impact|\bimpct|\bhit\b|hits\b|punch|slam|thud|smash|bang|crash|\bknock|\bstomp|\bbody ?fall"),
    ("cartoon", r"cartoon|\btoon|boing|comed|squeak|slide ?whistle|zany|wacky"),
    ("magic", r"magic|\bmagc|spell|sparkle|shimmer|chime|fairy|enchant"),
    ("horror", r"horror|creep|scary|haunt|ghost|monster|demon|eerie"),
    ("weapon", r"\bgun|gunshot|rifle|pistol|shot\b|sword|blade|\bweap|reload|bullet|laser"),
    ("weather", r"\brain|thunder|storm|\bwind\b|\bwind[_ -]|\bwthr|hail|blizzard"),
    ("water", r"water|splash|\bwatr|liquid|drip|pour|underwater|wave|bubble"),
    ("fire", r"\bfire|flame|burn|crackl|\bfire_"),
    ("electric", r"electric|\belec|spark|zap|buzz|hum\b|static|power ?(up|down)"),
    ("footsteps", r"footstep|\bfeet|\bstep|\bfstp|walk|run(ning)?\b|\bjog"),
    ("door", r"\bdoor|\bdoor_|gate|lock|latch|drawer|cabinet"),
    ("vehicle", r"\bcar\b|\bcar_|engine|vehicle|\bveh|truck|motor ?bike|\bbike|train|plane|aircraft|helicopter|\btire|horn"),
    ("animal", r"\bdog|\bcat\b|\bcat_|bird|horse|\banml|animal|cow|pig|chicken|wolf|insect|frog"),
    ("human", r"laugh|scream|crowd|breath|voice|\bvox|\bhmn|cheer|applause|clap|cough|sigh|gasp|kid|baby|walla"),
    ("foley", r"foley|\bfoly|cloth|rustle|paper|\bbag|zipper|cup|glass|plate|keys|phone|typing|keyboard|chair|book"),
    ("mechanical", r"machine|mechan|\bmech|servo|gear|robot|motor|ratchet|metal"),
    ("ambience", r"ambien|\bamb\b|\bamb_|\bamb[a-z]{2}_|atmos|room ?tone|roomtone|background|forest|city|street|night|nature|drone"),
    ("music", r"\bmusic|\bmus_|stinger|jingle|loop ?\d|\bbpm"),
]


def auto_cat(path):
    """категория по пути и имени файла; не нашлось — misc"""
    s = re.sub(r"[_\-.]+", " ", path.replace("\\", "/").lower())
    s2 = path.replace("\\", "/").lower()
    for cat, rx in AUTO_CAT:
        if re.search(rx, s) or re.search(rx, s2):
            return cat
    return "misc"


def _unzip(src):
    """zip -> временная папка рядом с библиотекой (удаляется после импорта)"""
    import tempfile, zipfile
    d = tempfile.mkdtemp(prefix="pack_", dir=os.path.dirname(LIB))
    with zipfile.ZipFile(src) as z:
        for m in z.infolist():
            if m.filename.lower().endswith(AUDIO_EXT) and not m.filename.startswith("__MACOSX"):
                z.extract(m, d)
    return d


def import_pack(src, auto=None, pack=None, license=None, progress=None, workers=6):
    """Пак (папка или .zip) -> библиотека. auto — категории по смыслу (по умолчанию: если в паке нет знакомых папок-категорий).
    Уже импортированные файлы этого пака пропускаются (можно продолжить прерванный импорт). progress(i, n, added) — для окна Studio."""
    from concurrent.futures import ThreadPoolExecutor
    os.makedirs(LIB, exist_ok=True)
    tmp = None
    if src.lower().endswith(".zip") and os.path.isfile(src):
        pack = pack or os.path.splitext(os.path.basename(src))[0]
        tmp = src = _unzip(src)
    idx = load_index()
    have = {s["id"] for s in idx["sounds"]}
    pack = pack or os.path.basename(os.path.normpath(src))
    done_src = {s.get("source") for s in idx["sounds"] if s.get("pack") == pack}
    files = []
    for root, _, names in os.walk(src):
        for n in names:
            if n.lower().endswith(AUDIO_EXT) and not n.startswith("._"):
                files.append(os.path.join(root, n))
    files.sort()
    if auto is None:                                      # знакомые папки (как в первом паке) — по ним, иначе — по смыслу
        auto = not any(os.path.basename(os.path.dirname(f)).lower() in CATEGORY for f in files[:500])
    print(f"Найдено {len(files)} аудиофайлов · категории: {'по смыслу из имён' if auto else 'по папкам'}")

    def cat_of(f):
        rel = os.path.relpath(f, src)
        if auto:
            return auto_cat(rel)
        folder = os.path.basename(os.path.dirname(f))
        return CATEGORY.get(folder.lower(), slug(folder)) if os.path.normpath(os.path.dirname(f)) != os.path.normpath(src) else "misc"

    todo = [f for f in files if os.path.relpath(f, src).replace("\\", "/") not in done_src]
    if len(todo) < len(files):
        print(f"  уже в библиотеке: {len(files) - len(todo)} — пропускаю")

    def work(f):
        try:
            raw = subprocess.run(["ffmpeg", "-v", "error", "-t", str(MAX_LEN + 2), "-i", f, "-vn", "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True).stdout
            return f, analyse_and_trim(np.frombuffer(raw, dtype=np.float32).astype(np.float64))
        except Exception:
            return f, (None, None)

    added = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, (f, (y, info)) in enumerate(ex.map(work, todo)):
            if y is None:
                print("  пропуск (тишина/не читается):", f)
            else:
                cat = cat_of(f)
                name = os.path.splitext(os.path.splitext(os.path.basename(f))[0])[0]
                base = f"{cat}/{slug(name)}"
                sid, k = base, 2
                while sid in have:
                    sid = f"{base}-{k}"; k += 1
                out = os.path.join(LIB, sid + ".wav")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                write_wav(out, y)
                entry = {"id": sid, "category": cat, "name": name, "pack": pack, "source": os.path.relpath(f, src).replace("\\", "/"), **info}
                if license:
                    entry["license"] = license
                if cat in CAUTION:
                    entry["caution"] = CAUTION[cat]
                idx["sounds"].append(entry); have.add(sid); added += 1
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(todo)}")
            if (i + 1) % 500 == 0:
                save(idx)                                    # прервётся — продолжит с этого места
            if progress:
                progress(i + 1, len(todo), added)
    save(idx)
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"Добавлено {added}. Всего в библиотеке: {len(idx['sounds'])}")
    return added


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
        a = sys.argv[2:]
        opt = lambda k: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else None
        pos = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] not in ("--pack", "--license"))]
        import_pack(pos[0], auto=True if "--auto" in a else False if "--folders" in a else None, pack=opt("--pack"), license=opt("--license"))
    elif cmd == "rebuild":
        save(load_index())
    elif cmd == "find":
        find(sys.argv[2:])
    else:
        sys.exit(__doc__)
