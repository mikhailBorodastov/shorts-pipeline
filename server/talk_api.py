"""🐾 Звериная речь (Animalese) в Студии: голоса канала, «послушать», фраза — звуком препродакшена.

Движок — _studio/animalese.py (слоги «согласная + гласная», кэш _studio/animalese_cache/<голос>/, тот же, что у audio.py ролика: talk:<who>:<текст>).
Голоса канала — <канал>/style/animalese.json = {"voices": {"ёжик": {voice, pitch, rate, …}, …}}; по умолчанию — «мама» и «ёжик» из шаблона (TALK в audio.py).
  GET  /api/talk/voices?video=            -> {voices, params: [описание ползунков], defaults}
  POST /api/talk/voices {video, name, p}  -> сохранить голос канала (p = null — убрать)
  POST /api/talk/say {video, text, p}     -> {url} — WAV во временной папке видео (послушать)
  POST /api/talk/keep {video, text, p, name} -> звук препродакшена «🐾 …» (файл в files/<видео>/sfx/), его ставят в сцены и монтаж как el:<id>
"""
import json, os, sys, time, hashlib

import paths as P  # noqa: E402

DEF_VOICES = {
    "мама": {"voice": "ru-RU-SvetlanaNeural", "pitch": 1.6, "rate": 8.5, "clip": 170, "cclip": 60, "jitter": 6, "sing": 3, "question": 16, "exclaim": 8, "cons": 0.7,
             "space": 0.5, "comma": 1.6, "stop": 2.6, "tail": 35, "volume": 0.9},
    "ёжик": {"voice": "ru-RU-DmitryNeural", "pitch": 2.05, "rate": 9.5, "clip": 150, "cclip": 55, "jitter": 8, "sing": 4, "question": 22, "exclaim": 10, "cons": 0.7,
             "space": 0.5, "comma": 1.6, "stop": 2.6, "tail": 30, "volume": 0.9},
}
PARAMS = [  # ключ, подпись, мин, макс, шаг, подсказка
    ["pitch", "тон ×", 1.0, 3.0, 0.05, "выше — мельче зверёк"],
    ["rate", "слогов в секунду", 4, 16, 0.5, "скорость лепета"],
    ["clip", "длина слога, мс", 60, 300, 5, "короче — отрывистее"],
    ["cclip", "одиночная согласная, мс", 20, 150, 5, ""],
    ["jitter", "разброс тона, %", 0, 25, 1, "живость: каждый слог чуть выше / ниже"],
    ["sing", "напевность, %", 0, 15, 1, "волна тона по фразе"],
    ["question", "вопрос: подъём, %", 0, 40, 1, "конец фразы с «?» вверх"],
    ["exclaim", "восклицание, %", 0, 30, 1, "«!» — выше и громче"],
    ["cons", "согласные ×", 0.2, 1.5, 0.05, "громкость одиночных согласных"],
    ["space", "пробел (шагов)", 0, 2, 0.1, "пауза между словами"],
    ["comma", "запятая (шагов)", 0, 4, 0.1, ""],
    ["stop", "точка (шагов)", 0, 6, 0.1, ""],
    ["tail", "хвост слога, мс", 0, 120, 5, "плавное затухание"],
    ["volume", "громкость ×", 0.2, 1.5, 0.05, ""],
]
VOICES = [["ru-RU-SvetlanaNeural", "Светлана (жен.)"], ["ru-RU-DmitryNeural", "Дмитрий (муж.)"]]


def _eng():
    if P.STUDIO not in sys.path:
        sys.path.insert(0, P.STUDIO)
    import animalese
    return animalese


def _chan(A, vid):
    return A.stapi().channel_dir(P.index()["videos"].get(vid, {}).get("channel"))


def _vfile(c):
    return os.path.join(c["dir"], "style", "animalese.json")


def voices(A, vid):
    c = _chan(A, vid)
    try:
        v = json.load(open(_vfile(c), encoding="utf-8")).get("voices") or {}
    except (OSError, ValueError):
        v = {}
    return {"voices": v or DEF_VOICES, "params": PARAMS, "defaults": _eng().DEFAULTS, "engines": VOICES, "saved": bool(v)}


def save_voice(A, vid, name, p):
    c = _chan(A, vid)
    cur = voices(A, vid)["voices"]
    name = (name or "").strip()[:40]
    if not name:
        raise ValueError("назови голос")
    if p is None:
        cur.pop(name, None)
    else:
        cur[name] = _clean(p)
    os.makedirs(os.path.dirname(_vfile(c)), exist_ok=True)
    A.write_text(_vfile(c), json.dumps({"voices": cur}, ensure_ascii=False, indent=1))
    return {"voices": cur}


def _clean(p):
    out = {"voice": p.get("voice") if p.get("voice") in dict(VOICES) else "ru-RU-SvetlanaNeural"}
    for k, _, lo, hi, _, _ in PARAMS:
        if p.get(k) is not None:
            out[k] = max(lo, min(hi, float(p[k])))
    return out


def render(A, vid, text, p, path):
    text = (text or "").strip()
    if not text:
        raise ValueError("напиши фразу")
    E = _eng()
    q = _clean(p or {})
    y = E.speak(text[:600], q.pop("voice"), **q)
    E.write(path, y)
    return round(len(y) / E.SR, 2)


def say(A, vid, text, p):
    d = os.path.join(P.files(vid), "_talk")
    os.makedirs(d, exist_ok=True)
    h = hashlib.md5(json.dumps([text, _clean(p or {})], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    f = os.path.join(d, h + ".wav")
    dur = render(A, vid, text, p, f) if not os.path.isfile(f) else None
    return {"url": f"/files/{vid}/_talk/{h}.wav", "dur": dur}


def keep(A, vid, text, p, name):
    """Фраза -> звук препродакшена: файл в files/<видео>/sfx/, элемент kind sound с выбранным кандидатом (как «⬇ по ссылке»)."""
    d = os.path.join(P.files(vid), "sfx")
    os.makedirs(d, exist_ok=True)
    fn = f"talk-{int(time.time())}.wav"
    dur = render(A, vid, text, p, os.path.join(d, fn))
    sid, eid = A.new_id("s"), A.new_id("e")
    who = (name or "").strip() or "голос"
    short = text.strip().replace("\n", " ")[:40]
    snd = {"id": sid, "file": f"files/{vid}/sfx/{fn}", "title": f"🐾 {who}: {short}", "dur": dur, "src": "animalese", "license": "своё (Animalese Claude Studio)",
           "author": "Claude Studio", "page": ""}
    el = {"id": eid, "kind": "sound", "name": f"🐾 {who}: «{short}»", "desc": f"звериная речь, голос «{who}»: {text.strip()[:300]}", "why": "", "q": "",
          "status": "ok", "refs": [], "by": "me", "sounds": [snd], "mix": [{"id": "l1", "sid": sid, "at": 0, "gain": 1, "note": ""}], "talk": {"text": text, "p": _clean(p or {}), "name": who}}
    A.apply_ops("plan:" + vid, [{"op": "add", "path": ["elements"], "item": el}])
    return {"el": eid, "dur": dur}


def handle_get(A, h, p, q):
    if p == "/api/talk/voices":
        h._json(voices(A, (q.get("video") or [""])[0])); return True
    return False


def handle_post(A, h, p, body):
    vid = body.get("video", "")
    if p == "/api/talk/voices":
        h._json(save_voice(A, vid, body.get("name"), body.get("p"))); return True
    if p == "/api/talk/say":
        h._json(say(A, vid, body.get("text"), body.get("p"))); return True
    if p == "/api/talk/keep":
        h._json(keep(A, vid, body.get("text"), body.get("p"), body.get("name"))); return True
    return False


def cli(A, argv):
    """talk voices VID | talk keep VID "текст" [--voice ёжик] — реплика звериной речью -> звук препродакшена «🐾 …» (el:<id>)"""
    if len(argv) < 2:
        print(cli.__doc__); return True
    cmd, vid = argv[0], argv[1]
    if cmd == "voices":
        print(json.dumps(voices(A, vid)["voices"], ensure_ascii=False, indent=1)); return True
    if cmd == "keep":
        V = voices(A, vid)["voices"]
        name = A._opt(argv, "--voice") or next(iter(V))
        if name not in V:
            raise ValueError("нет голоса «" + name + "»: " + ", ".join(V))
        print(json.dumps(keep(A, vid, argv[2], V[name], name), ensure_ascii=False)); return True
    print(cli.__doc__); return True
