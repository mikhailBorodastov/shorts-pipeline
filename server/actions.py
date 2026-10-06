"""S20.2 — реестр действий Claude по вкладкам (docs/studio/stage20-agent-everywhere.md): всё, что умеют кнопки ✨, — агенту одной командой.

    studio.py act list [вкладка]                                         — что можно (по вкладкам, вес, параметры)
    studio.py act <видео|channel> <действие> [--el ЭЛ] [--p '{json}'] [--wait]   — запустить, как кнопку (очередь Studio, страница подхватит результат)
    studio.py job wait <id>                                              — дождаться

weight: light — агент делает сразу; heavy — сначала план автору [[план: Делай | Изменить]] (Opus, 3D, много элементов).
GET /api/act?tab=pre — короткий список для подсказки «Умеет здесь» в чате.
"""
import json
import sys

import paths as P

# id: (вкладки, вес, что делает, параметры, нужен элемент (kind или '*' | ''), адрес без Claude (или ''))
A_ = {
    # бриф и сценарий
    "questions": (["brief"], "light", "вопросы Claude к идее (раунд уточнений)", '{"n": 8, "focus": "о чём спросить"}', "", ""),
    "beatmap": (["brief", "script"], "heavy", "карта подачи по референсу 📐 (Opus)", '{}', "", ""),
    # препродакшен
    "elements": (["pre"], "light", "«Накидать»: новые персонажи / пропсы / сцены / звуки по сценарию и идее", '{"kind": "char|prop|scene|sound (необязательно)", "focus": "чего не хватает"}', "", ""),
    "element": (["pre"], "heavy", "🎨 нарисовать черновик элемента (Opus); с base — новая версия от текущей по правкам «в целом»", '{"base": "id версии (для правки)"}', "*", ""),
    "make3d": (["pre"], "heavy", "✨ сделать 3D персонажа / пропса; wish — что просит автор («по-настоящему объёмный» → не бумажная карточка); method — сам: shapes|model|parts|asset|blender|trellis", '{"wish": "слова автора", "method": "необязательно"}', "char,prop", ""),
    "split3d": (["pre"], "heavy", "разделить 3D-модель пропса на отдельные модели", '{"base": "id версии"}', "prop", ""),
    "vary3d": (["pre"], "heavy", "вариации 3D-пропса (2–8 штук)", '{"base": "id версии", "n": 3, "wish": "какие"}', "prop", ""),
    "assets": (["pre"], "light", "📦 подобрать бесплатные 3D / 2D ассеты (кладёт предложения, автор берёт)", '{}', "*", ""),
    "sound": (["pre"], "light", "✨ подобрать звук: 3–5 кандидатов (YouTube, базы)", '{}', "sound", ""),
    "sndfetch": (["pre"], "light", "⬇ скачать звук по ссылке (YouTube — кусок start/end)", '{"url": "…", "start": 1.5, "end": 4}', "sound", "/api/sound/fetch"),
    "brollfetch": (["pre"], "light", "🎞 B-roll элемента: кусок видео по ссылке", '{"src": "ссылка", "from": "0:12", "to": "0:20", "owner": "чьё"}', "broll", "/api/videos/broll"),
    "sceneconvert": (["pre"], "heavy", "перевести нарисованную 3D-сцену в редактор (Opus)", '{"base": "id версии"}', "scene", ""),
    # голос, монтаж, упаковка
    "montagebuild": (["montage", "pack"], "light", "собрать ролик mp4 по монтажу (1–3 мин)", '{}', "", "/api/montage/build"),
    "guard": (["montage", "pack"], "light", "🛡 сторож: проверить ролик — застревания, рывки, мерцание (3D + готовый mp4), без Claude; находки — в «Правки»", '{}', "", "/api/montage/guard"),
    "packtext": (["pack"], "light", "тексты упаковки: 5 названий, описания, закреп, хэштеги, «Права»", '{}', "", ""),
    "render": (["pack", "thumbs"], "heavy", "🎨 нарисовать обложку по концепту thumbs[] (Opus)", '{"thumb": "id концепта", "part": "cover"}', "", ""),
    "thumbprompt": (["thumbs"], "light", "промпт картинки обложки по видео", '{"note": "id узла доски"}', "", ""),
    # канал
    "libfix": (["lib"], "heavy", "поправить предмет библиотеки → новая версия", '{"id": "props/<slug>", "v": 1, "notes": ["что поменять"]}', "", "/api/lib/fix"),
    "ytvideo": (["yt"], "light", "разбор ролика на YouTube (вопрос — ask)", '{"yt": "id ролика", "ask": "вопрос"}', "", "/api/yt/review"),
    "ytlearn": (["yt"], "light", "«💡 Что работает»: уроки из статистики канала", '{}', "", "/api/yt/learn"),
    "memlearn": (["memory"], "light", "предложить правила канала по правкам автора", '{}', "", ""),
}
TAB_NAMES = {"brief": "Бриф", "script": "Сценарий", "pre": "Препродакшен", "voice": "Озвучка", "montage": "Монтаж", "pack": "Упаковка",
             "thumbs": "Обложки", "lib": "Библиотека", "yt": "YouTube", "memory": "Память", "style": "Стиль", "renders": "Рендеры", "videos": "Видео"}
# короткие подписи для чата «Умеет здесь»
SHORT = {"questions": "вопросы", "beatmap": "карта подачи", "elements": "накидать элементы", "element": "нарисовать / поправить",
         "make3d": "сделать 3D", "split3d": "разделить модель", "vary3d": "вариации", "assets": "подобрать ассеты", "sound": "подобрать звук",
         "sndfetch": "звук по ссылке", "brollfetch": "B-roll", "sceneconvert": "сцена → редактор", "montagebuild": "собрать mp4", "guard": "проверить сторожем", "packtext": "тексты упаковки",
         "render": "нарисовать обложку", "thumbprompt": "промпт обложки", "libfix": "поправить предмет", "ytvideo": "разбор ролика", "ytlearn": "что работает",
         "memlearn": "правила канала"}
EXTRA = {"brief": ["разобрать референсы (ref parse)"], "pre": ["утвердить (по просьбе)", "выбрать звук"], "montage": ["сцены и монтаж командами"], "script": ["сценарий", "голос"], "style": ["разделы гайда — словами"]}


def for_tab(tab):
    return [k for k, v in A_.items() if tab in v[0]]


def tab_line(tab):
    """«Умеет здесь: …» — подсказка в чате и строка в контексте реплики."""
    ks = for_tab(tab)
    return ", ".join([SHORT.get(k, k) for k in ks] + EXTRA.get(tab, []))


def doc(tab=None):
    tabs = [tab] if tab else list(TAB_NAMES)
    out = []
    for t in tabs:
        ks = for_tab(t)
        if not ks:
            continue
        out.append(f"[{TAB_NAMES.get(t, t)}]")
        for k in ks:
            tb, w, desc, prm, el, _ = A_[k]
            out.append(f"  {k:<13} {'⚠ heavy' if w == 'heavy' else 'light  '} {desc}" + (f" · --el (элемент: {el})" if el else "") + (f" · --p '{prm}'" if prm != "{}" else ""))
    return "\n".join(out)


def start(A, target, action, el=None, params=None):
    """Запустить действие как кнопку. target — id видео или 'channel'. -> id задачи (печатает строку)."""
    import agent_tools as T
    if action not in A_:
        raise ValueError(f"нет действия «{action}» — studio.py act list")
    tabs, w, desc, prm, need, local = A_[action]
    params = dict(params or {})
    if target in ("channel", "ch") or target.startswith("ch-"):
        c = P.channel(target[3:] if target.startswith("ch-") else None) or {}
        key, vid = "channel:" + c.get("id", ""), None
    else:
        key, vid = "plan:" + target, target
        if not P.video(target):
            raise ValueError(f"нет видео {target}")
    e = None
    if need:
        if not (el and vid):
            raise ValueError(f"«{action}» — для элемента видео: --el <id или название>")
        _, e = T._el(A, vid, el)
        if need != "*" and e.get("kind") not in need.split(","):
            raise ValueError(f"«{action}» — для {need}, а «{e.get('name')}» — {e.get('kind')}")
        params["el"] = e["id"]
    if action in ("split3d", "vary3d", "sceneconvert") and e and not params.get("base"):     # от текущей версии элемента
        cur = T._cur(e)
        if cur:
            params["base"] = cur.get("id")
    scope = {"element": "element:", "make3d": "element:", "sound": "sound:", "assets": "assets:", "split3d": "split3d:", "vary3d": "vary3d:",
             "sceneconvert": "sceneconvert:"}.get(action, action + ":") + (e["id"] if e else "")
    if action == "elements":
        scope = "elements:" + (params.get("kind") or "all")
    if action == "render":
        scope = "render:" + str(params.get("thumb") or "")
    if local:
        body = dict(params)
        if action in ("sndfetch", "brollfetch"):
            body.setdefault("key", key)
        if action in ("montagebuild", "guard"):
            body.setdefault("video", vid)
        if action == "sndfetch" and "url" in body:
            body.setdefault("start", body.pop("from", None)); body.setdefault("end", body.pop("to", None))
        r = T._api(A, "POST", local, body)
        j = r.get("job") or r
    else:
        j = T._api(A, "POST", "/api/claude", {"action": action, "key": key, "scope": scope, "params": params}).get("job") or {}
    jid = j.get("id")
    print(f"задача {jid or '?'} · {action}{' · ' + e.get('name', '') if e else ''} · {j.get('status') or 'запущена'}")
    return jid


def cli(A, argv):
    if not argv or argv[0] in ("list", "help"):
        print(doc(argv[1] if len(argv) > 1 else None)); return True
    if len(argv) < 2:
        print(__doc__); return True
    target, action, rest = argv[0], argv[1], argv[2:]
    opt = lambda k: rest[rest.index(k) + 1] if k in rest and rest.index(k) + 1 < len(rest) else None
    params = {}
    if opt("--p"):
        try:
            params = json.loads(opt("--p"))
        except ValueError as ex:
            raise ValueError(f"--p — не JSON: {ex}")
    jid = start(A, target, action, opt("--el"), params)
    if jid and "--wait" in rest:
        import agent_tools as T
        T.wait(A, jid)
    elif jid:
        print(f"идёт в фоне — дождаться: studio.py job wait {jid}")
    return True


def handle_get(A, h, p, q):
    if p == "/api/act":
        tab = (q.get("tab") or [""])[0]
        h._json({"tab": tab, "line": tab_line(tab), "actions": [{"id": k, "short": SHORT.get(k, k), "weight": A_[k][1]} for k in for_tab(tab)]}); return True
    return False
