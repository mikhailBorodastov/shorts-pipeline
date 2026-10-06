"""Инструменты препродакшена для агента в чате видео (монтаж, правки): то же, что кнопки карточки элемента, но командами studio.py.

Раньше агент на монтаже не мог ни подобрать / скачать звук, ни перерисовать персонажа или пропс — отвечал автору «скачивать нечем», «нужно ТЗ».
Задачи запускает сервер Studio (как кнопки ✨): команда зовёт его по HTTP (/api/claude, порт — .studio/.port) и, с --wait, ждёт конца (/api/job).

  studio.py el <видео> fix <эл> "что поправить" ["ещё пункт" …] [--wait]   — «Поправить»: пункты правки в элемент + новая версия от текущей
  studio.py el <видео> draw <эл> [--wait]                                    — «🎨 Нарисовать черновик» (элемента ещё нет)
  studio.py el <видео> make3d <эл> [shapes|blender|model|trellis|asset|parts] [--wish "слова автора"] [--wait]  — «✨ Сделать 3D»
  studio.py el <видео> ok <эл>                                               — утвердить элемент (статус ✓)
  studio.py sound <видео> pick <эл> [--wait]                                 — «✨ Подобрать звук»: Claude ищет и скачивает 3–5 кандидатов
  studio.py sound <видео> fetch <эл> <ссылка> [--from С] [--to С] [--wait]    — «⬇ по ссылке»: страница со звуком, файл, YouTube (кусок с–по)
  studio.py sound <видео> use <эл> <id кандидата>                             — выбрать кандидата (✓) — им звук и станет
  studio.py sound <видео> list <эл>                                          — кандидаты элемента
  studio.py job wait <id>                                                    — дождаться задачи
"""
import json
import os
import sys
import time
import urllib.request

import paths as P


def _port(A):
    try:
        return int(open(os.path.join(A.DATA, ".port")).read().strip())
    except (OSError, ValueError):
        raise RuntimeError("Studio не запущена (нет .studio/.port) — запусти «Claude Studio.bat»")


def _api(A, method, path, body=None):
    url = f"http://localhost:{_port(A)}{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", "X-Ideas": "1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def _start(A, action, key, scope, params):
    if action == "sndfetch":                                   # скачивание звука — свой адрес, без Claude (как кнопка «⬇ по ссылке»)
        j = _api(A, "POST", "/api/sound/fetch", params).get("job") or {}
    else:
        j = _api(A, "POST", "/api/claude", {"action": action, "key": key, "scope": scope, "params": params}).get("job") or {}
    print(f"задача {j.get('id')} · {action} · {j.get('status')}")
    return j.get("id")


WAIT_LIMIT = int(os.environ.get("STUDIO_WAIT_S") or 540)    # S22: агенту команды разрешены до 10 мин (BASH_DEFAULT_TIMEOUT_MS в agent.spawn) — ждём до 9 мин
                                                             # за вызов: было 100 с, и 5-минутный черновик стоил агенту 3–4 лишних хода (каждый перечитывает весь контекст)


def wait(A, jid, limit=None):
    limit = limit or WAIT_LIMIT
    t0, last, said = time.time(), "", 0.0
    while time.time() - t0 < limit:
        try:
            j = _api(A, "GET", f"/api/job?id={jid}") or {}
        except Exception as e:
            print("! не достучался до Studio:", e); return None
        j = j.get("job", j)
        st, sm = j.get("status"), j.get("summary") or ""
        if sm and sm != last and time.time() - said > 60:     # ход задачи — не чаще строки в минуту: каждая строка оседает в контексте агента
            print(f"… {sm}"); last, said = sm, time.time()
        if st in ("done", "error", "cancelled"):
            print(f"{'готово' if st == 'done' else st}: {sm or j.get('error') or ''}")
            res = j.get("result")
            if res:
                print("результат:", json.dumps(res, ensure_ascii=False)[:1500])
            return j
        time.sleep(4)
    print(f"задача ещё идёт ({int(limit // 60)} мин) — повтори: studio.py job wait {jid}")
    return None


def _el(A, vid, el):
    d = A.load("plan:" + vid)
    els = [x for x in d.get("elements") or [] if x.get("status") != "drop"]
    q = el.strip().lower()
    e = next((x for x in els if x.get("id") == el or (x.get("name") or "").strip().lower() == q), None)
    if not e:                                                   # по части названия — если совпадение одно
        hit = [x for x in els if q and q in (x.get("name") or "").lower()]
        if len(hit) > 1:
            raise ValueError(f"«{el}» подходит к нескольким: " + "; ".join(f"{x['id']} «{x.get('name')}»" for x in hit[:8]) + " — укажи id")
        e = hit[0] if hit else None
    if not e:
        raise ValueError(f"нет элемента «{el}» — studio.py show {vid} (elements: id, name)")
    return d, e


def _renders(e):
    rs = e.get("renders") or []
    if e.get("kind") == "char":
        rg = e.get("form") == "rig"
        rs = [r for r in rs if bool(r.get("rigchar")) == rg]
    elif e.get("kind") == "prop":
        d3 = e.get("dim") == "3d"
        rs = [r for r in rs if bool(r.get("three3")) == d3]
    return rs


def _cur(e):
    rs = _renders(e)
    return next((r for r in rs if r.get("id") == e.get("render")), rs[-1] if rs else None)


def cli(A, argv):
    if not argv:
        print(__doc__); return True
    if argv[0] == "job":
        if len(argv) > 2 and argv[1] == "wait":                # job wait ID [ID …] — дождаться всех (общий предел на вызов)
            t0 = time.time()
            for jid in argv[2:]:
                left = WAIT_LIMIT - (time.time() - t0)
                if left < 5 or wait(A, jid, left) is None:
                    rest = argv[argv.index(jid):]
                    print("ещё не готовы — повтори: studio.py job wait " + " ".join(rest)); break
            return True
        print(__doc__); return True
    group = argv[0]
    if len(argv) < 4:
        print(__doc__); return True
    vid, cmd, el = argv[1], argv[2], argv[3]
    rest = argv[4:]
    w = "--wait" in rest
    rest = [x for x in rest if x != "--wait"]
    key = "plan:" + vid
    d, e = _el(A, vid, el)
    if group == "el":
        if cmd == "fix":
            notes = [x for x in rest if x.strip()]
            if not notes:
                raise ValueError("что поправить? studio.py el <видео> fix <эл> \"пункт\" [\"пункт\" …]")
            cur = _cur(e)
            if not cur:
                raise ValueError(f"у «{e.get('name')}» ещё нет черновика — сначала el {vid} draw {e['id']} (или make3d)")
            fx = ((e.get("fx") or {}).get("main") or {})
            if "notes" not in fx:
                A.apply_ops(key, [{"op": "set", "path": ["elements", e["id"], "fx", "main", "notes"], "value": []}])
            A.apply_ops(key, [{"op": "add", "path": ["elements", e["id"], "fx", "main", "notes"], "item": {"id": A.new_id("n"), "text": t}} for t in notes])
            act = "trellisfix" if cur.get("source") == "trellis" and cur.get("meta") else "charparts" if e.get("kind") == "char" and e.get("form") == "rig" else "element"
            jid = _start(A, act, key, "el:" + e["id"], {"el": e["id"], "base": cur.get("id")})
        elif cmd == "draw":
            jid = _start(A, "element", key, "el:" + e["id"], {"el": e["id"]})
        elif cmd == "make3d":
            m = next((x for x in rest if x in ("shapes", "blender", "model", "trellis", "parts", "asset")), None)
            wish = rest[rest.index("--wish") + 1] if "--wish" in rest and rest.index("--wish") + 1 < len(rest) else ""   # S20.3: слова автора главнее стиля
            jid = _start(A, "make3d", key, "element:" + e["id"], {"el": e["id"], **({"method": m} if m else {}), **({"wish": wish} if wish else {})})
        elif cmd == "ok":
            print(A.apply_ops(key, [{"op": "set", "path": ["elements", e["id"], "status"], "value": "ok"}])); return True
        else:
            print(__doc__); return True
    elif group == "sound":
        if e.get("kind") != "sound":
            raise ValueError(f"«{e.get('name')}» — не звук ({e.get('kind')})")
        if cmd == "list":
            for s in e.get("sounds") or []:
                print(f"{s.get('id')} · {'✓ ' if s.get('id') == e.get('sound') else ''}{s.get('name') or s.get('title') or ''} · {s.get('dur', '?')} с · {s.get('src') or s.get('url') or ''}")
            return True
        if cmd == "use":
            sid = rest[0] if rest else ""
            if not any(s.get("id") == sid for s in e.get("sounds") or []):
                raise ValueError(f"нет кандидата {sid} — sound {vid} list {e['id']}")
            print(A.apply_ops(key, [{"op": "set", "path": ["elements", e["id"], "sound"], "value": sid},
                                    {"op": "set", "path": ["elements", e["id"], "mix"], "value": [{"id": "l1", "sid": sid, "at": 0, "gain": 1, "note": ""}]}]))
            return True
        if cmd == "pick":
            jid = _start(A, "sound", key, "sound:" + e["id"], {"el": e["id"]})
        elif cmd == "fetch":
            if not rest:
                raise ValueError("нужна ссылка: sound <видео> fetch <эл> <ссылка> [--from С] [--to С]")
            url = rest[0]
            opt = lambda k: (rest[rest.index(k) + 1] if k in rest and rest.index(k) + 1 < len(rest) else None)
            jid = _start(A, "sndfetch", key, f"sndfetch:{e['id']}:{url}", {"key": key, "el": e["id"], "url": url, "start": opt("--from"), "end": opt("--to")})
        else:
            print(__doc__); return True
    else:
        print(__doc__); return True
    if w and jid:
        wait(A, jid)
    elif jid:
        print(f"идёт в фоне — дождаться: studio.py job wait {jid}")
    return True
