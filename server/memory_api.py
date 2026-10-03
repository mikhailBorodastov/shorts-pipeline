"""S12.10 — «Память» (docs/studio/stage12-redesign.md §10.3): правила, которые Claude выносит из правок автора.

Правила канала — <канал>/memory/rules.json (в git канала), общие для всех каналов — .studio/memory_all.json.
Правило: {id, text, why, scope: all|channel|video, video (для scope video — id видео), status: new|on|off, from: {video, name}, by: claude|author, created, updated}.
Уровни: all — все каналы, channel — все видео канала, video — одно видео (лежит в файле канала, в промпт идёт только для этого видео).
«✨ Научиться на моих правках» — задача memlearn (learn()): Claude (Sonnet) читает пины и правки окна видео (fixes[]), заметки раскадровки
(review/script_notes.json) и просьбы в чате Claude (agent.jsonl, kind you) всех видео канала и предлагает правила (status new, вкладка «Предложенные»).
new — Claude предложил (автор видит «N new» в боковой панели и принимает / правит / отклоняет), on — действует (уходит в системный промпт
всех кнопок ✨ и агента — ideas_claude.system), off — выключено.

GET  /api/memory               -> {channel: […], all: […], new: N, channelName, videos: [{id, name}]}
POST /api/memory/op  <- {op: add|set|del, id, rule{…}}      rule.scope all|channel|video (+ rule.video)
POST /api/memory/learn                                      -> {job}  (задача memlearn)
CLI: memory list | memory propose "правило" --why "почему" [--all | --one] [--video ID] | memory add "правило" [--all | --one --video ID] | memory on|off|del ID
"""
import json, os, time, uuid

import paths as P

GLOBAL = os.path.join(P.STATE, "memory_all.json")


def _cpath(ch=None):
    c = P.channel(ch) if ch else P.channel()
    return os.path.join(c["dir"], "memory", "rules.json") if c else None


def _read(p):
    try:
        return json.load(open(p, encoding="utf-8")) if p else []
    except (OSError, ValueError):
        return []


def _write(p, rules):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def rules(ch=None):
    return {"channel": _read(_cpath(ch)), "all": _read(GLOBAL)}


def _vname(vid):
    try:
        return json.load(open(P.video_json(vid), encoding="utf-8")).get("name", "") or vid
    except (OSError, ValueError, TypeError):
        return vid


def videos(ch=None):
    """Видео канала для выбора «одно видео»: [{id, name}] (свежие сверху, без служебных и архива)."""
    c = (P.channel(ch) if ch else P.channel()) or {}
    out = []
    for vid, v in P.index()["videos"].items():
        if c and v.get("channel") != c.get("id"):
            continue
        try:
            d = json.load(open(P.video_json(vid), encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if d.get("service") or d.get("status") == "archived":
            continue
        out.append({"id": vid, "name": d.get("name", "") or vid, "updated": d.get("updated", 0)})
    return sorted(out, key=lambda x: -(x["updated"] or 0))


def state(ch=None):
    R = rules(ch)
    for x in R["channel"]:
        if x.get("scope") == "video" and x.get("video"):
            x["videoName"] = _vname(x["video"])
    c = (P.channel(ch) if ch else P.channel()) or {}
    return {**R, "new": sum(1 for x in R["channel"] + R["all"] if x.get("status") == "new"), "channelName": c.get("name", ""), "channelId": c.get("id", ""), "videos": videos(ch)}


def _norm(s):
    return " ".join((s or "").lower().split())


def add(text, why="", scope="channel", status="on", by="author", video=None, ch=None):
    text = (text or "").strip()
    if not text:
        raise ValueError("пустое правило")
    if scope == "video" and not video:
        raise ValueError("правило для одного видео — выберите видео")
    p = GLOBAL if scope == "all" else _cpath(ch)
    if not p:
        raise ValueError("нет канала")
    R = _read(p)
    if any(_norm(x.get("text")) == _norm(text) for x in R):
        return {"ok": True, "dup": True}
    frm = None
    if video:
        try:
            v = json.load(open(P.video_json(video), encoding="utf-8"))
            frm = {"video": video, "name": v.get("name", "")}
        except (OSError, ValueError, TypeError):
            frm = {"video": video}
    t = int(time.time() * 1000)
    r = {"id": "m" + uuid.uuid4().hex[:7], "text": text, "why": (why or "").strip(), "scope": scope, "status": status, "by": by, "from": frm, "created": t, "updated": t}
    if scope == "video":
        r["video"] = video
    R.append(r)
    _write(p, R)
    return {"ok": True, "rule": r}


def _find(rid, ch=None):
    for p in (_cpath(ch), GLOBAL):
        R = _read(p)
        for i, x in enumerate(R):
            if x.get("id") == rid:
                return p, R, i
    raise ValueError("нет такого правила")


def set_rule(rid, patch, ch=None):
    p, R, i = _find(rid, ch)
    r = R[i]
    for k in ("text", "why", "status"):
        if k in patch:
            r[k] = patch[k]
    r["updated"] = int(time.time() * 1000)
    if patch.get("scope") == "video" and not (patch.get("video") or r.get("video")):
        raise ValueError("правило для одного видео — выберите видео")
    if patch.get("scope") in ("channel", "video") and r.get("scope", "channel") != "all":   # канал <-> одно видео: тот же файл
        r["scope"] = patch["scope"]
        if patch["scope"] == "video":
            r["video"] = patch.get("video") or r.get("video")
        else:
            r.pop("video", None)
        _write(p, R)
        return {"ok": True}
    if patch.get("scope") in ("channel", "all", "video") and patch["scope"] != r.get("scope"):   # перенос между каналом и «для всех»
        R.pop(i)
        _write(p, R)
        r["scope"] = patch["scope"]
        if r["scope"] == "video":
            r["video"] = patch.get("video") or r.get("video")
        else:
            r.pop("video", None)
        q = GLOBAL if r["scope"] == "all" else _cpath(ch)
        Q = _read(q)
        Q.append(r)
        _write(q, Q)
        return {"ok": True}
    _write(p, R)
    return {"ok": True}


def delete(rid, ch=None):
    p, R, i = _find(rid, ch)
    R.pop(i)
    _write(p, R)
    return {"ok": True}


def prompt_text(ch=None, video=None):
    """Действующие правила — в системный промпт (ideas_claude.system): все каналы + канал + правила этого видео (если video)."""
    R = rules(ch)
    mine = lambda x: x.get("scope") != "video" or (video and x.get("video") == video)
    on = [x for x in R["channel"] if x.get("status") == "on" and mine(x)] + [x for x in R["all"] if x.get("status") == "on"]
    if not on:
        return ""
    return "\n".join(f"- {x['text']}" + (f" (почему: {x['why']})" if x.get("why") else "") for x in on)


# ---------------------------------------------------------------- ✨ Научиться на моих правках
def _edits(ch=None, limit=160):
    """Правки автора по видео канала: пины и правки окна видео, заметки раскадровки, просьбы в чате Claude. -> {vid: [строки]}"""
    out = {}
    for v in videos(ch)[:25]:
        vid, L = v["id"], []
        try:
            d = json.load(open(P.video_json(vid), encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        for f in d.get("fixes") or []:
            t = " — ".join(x for x in ((f.get("desc") or f.get("text") or "").strip(), ("почему: " + f["why"].strip()) if (f.get("why") or "").strip() else "") if x)
            if t:
                L.append("правка кадра: " + t[:300])
        vd = P.video(vid)
        try:
            for n in json.load(open(os.path.join(vd, "review", "script_notes.json"), encoding="utf-8")) if vd else []:
                t = (n.get("text") or "").strip()
                if t:
                    L.append(f"заметка сценария ({n.get('type') or 'заметка'}" + (f", к «{(n.get('frag') or '')[:80]}»" if n.get("frag") else "") + "): " + t[:300])
        except (OSError, ValueError):
            pass
        try:
            for line in open(os.path.join(vd, "agent.jsonl"), encoding="utf-8") if vd else []:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                t = (e.get("text") or "").strip()
                if e.get("kind") == "you" and t and not t.startswith(("📝", "✍️", "🎞", "✨", "🔨", "📦", "🎙", "🛠", "🔎")):   # кнопки — не правки автора
                    L.append("просьба в чате: " + t[:300])
        except OSError:
            pass
        if L:
            out[vid] = L[-limit:]
    return out


def learn(A, job):
    """Задача memlearn: Claude читает правки автора и предлагает правила (status new)."""
    from ideas_claude import S, STR, ARR
    ch = (P.channel() or {}).get("id")
    E = _edits(ch)
    if not E:
        job.summary = "Правок пока нет — учиться не на чем"
        return
    names = {v["id"]: v["name"] for v in videos(ch)}
    R = rules(ch)
    have = [x for x in R["channel"] + R["all"] if x.get("status") in ("on", "new", "off")]
    body = "\n\n".join(f"### Видео {vid} «{names.get(vid, vid)}»\n" + "\n".join("- " + l for l in L) for vid, L in E.items())
    prompt = f"""Шаг «Память». Ниже — правки автора по видео канала: пины на кадрах, заметки к сценарию, просьбы в чате.
Найди в них ПРЕДПОЧТЕНИЯ, которые повторяются или явно общие (как автор любит, чего не терпит), и сформулируй правила, которые Claude будет соблюдать дальше.
- Правило — одна фраза-указание («Звуки на переходах — тише голоса», «Камера не за спиной у героя, о котором говорят»), без воды.
- scope: all — про подачу и монтаж вообще (годится любому каналу); channel — про стиль этого канала; video — только про одно видео (тогда video = id видео): разовые решения сюжета.
- why — из какой правки или повтора вывел (коротко, с названием видео).
- Не предлагай то, что уже есть в правилах ниже (даже другими словами), и разовые мелочи («сдвинь на 2 см»). Лучше 3 сильных, чем 10 слабых; до 8.

Уже есть правила:
{chr(10).join('- ' + x['text'] for x in have) or '—'}

{body[:24000]}"""
    docs = A._docs("channel:" + ch) if ch else {"brand": {}}
    try:
        from ideas_claude import system
        sysp = system(docs, "short")
    except Exception:
        sysp = "Ты — соавтор YouTube-канала в Claude Studio."
    job.summary = f"Claude читает правки: видео {len(E)}…"
    res = A.run_claude(job, {"system": sysp, "prompt": prompt, "timeout": 300, "model": A.TEXT_MODEL,
                             "schema": S({"rules": ARR(S({"text": STR, "why": STR, "scope": {"type": "string", "enum": ["all", "channel", "video"]}, "video": STR},
                                                          ["text", "why", "scope"]))}, ["rules"])}) or {}
    n = 0
    for r in res.get("rules") or []:
        sc, vid = r.get("scope") or "channel", (r.get("video") or "").strip()
        if sc == "video" and vid not in E:
            sc, vid = "channel", ""
        x = add(r.get("text"), r.get("why", ""), sc, "new", "claude", vid or None, ch)
        n += 0 if x.get("dup") else 1
    job.summary = f"Claude предложил правил: {n}" if n else "Новых правил не нашлось — всё уже в памяти"


# ---------------------------------------------------------------- HTTP / CLI
def handle_get(A, h, p, q):
    if p == "/api/memory":
        h._json(state()); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/memory/op":
        op, r = body.get("op"), body.get("rule") or {}
        if op == "add":
            h._json(add(r.get("text"), r.get("why", ""), r.get("scope", "channel"), "on", "author", r.get("video"))); return True
        if op == "set":
            h._json(set_rule(body.get("id", ""), r)); return True
        if op == "del":
            h._json(delete(body.get("id", ""))); return True
        raise ValueError("нет такой операции")
    if p == "/api/memory/learn":
        ch = (P.channel() or {}).get("id") or "ch"
        j = A.start_job("memlearn", "channel:" + ch, "memlearn", {})
        h._json({"job": j.info()}); return True
    return False


def cli(A, argv):
    """memory list | propose "правило" --why "почему" [--all] [--video ID] | add "правило" [--why …] [--all] | on|off|del ID"""
    if not argv:
        print(cli.__doc__); return True
    cmd, a = argv[0], argv[1:]
    opt = lambda k: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else None
    if cmd == "list":
        R = rules()
        for scope, lst in (("канал", R["channel"]), ("для всех каналов", R["all"])):
            print(f"== {scope}")
            for x in lst:
                print(f"[{x['id']}] {x.get('status')} · " + (f"(видео {x.get('video')}) " if x.get("scope") == "video" else "") + x["text"] + (f" — {x['why']}" if x.get("why") else ""))
        return True
    if cmd in ("propose", "add"):
        text = next((x for x in a if not x.startswith("--") and a.index(x) == 0), "") if a else ""
        res = add(text, opt("--why") or "", "all" if "--all" in a else "video" if "--one" in a else "channel", "new" if cmd == "propose" else "on",
                  "claude" if cmd == "propose" else "author", opt("--video"))
        print("уже есть такое правило" if res.get("dup") else ("предложено автору: " if cmd == "propose" else "добавлено: ") + res["rule"]["id"])
        return True
    if cmd in ("on", "off") and a:
        print(set_rule(a[0], {"status": cmd})); return True
    if cmd == "del" and a:
        print(delete(a[0])); return True
    print(cli.__doc__); return True
