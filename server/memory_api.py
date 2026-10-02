"""S12.10 — «Память» (docs/studio/stage12-redesign.md §10.3): правила, которые Claude выносит из правок автора.

Правила канала — <канал>/memory/rules.json (в git канала), общие для всех каналов — .studio/memory_all.json.
Правило: {id, text, why, scope: channel|all, status: new|on|off, from: {video, name}, by: claude|author, created, updated}.
new — Claude предложил (автор видит «N new» в боковой панели и принимает / правит / отклоняет), on — действует (уходит в системный промпт
всех кнопок ✨ и агента — ideas_claude.system), off — выключено.

GET  /api/memory               -> {channel: […], all: […], new: N, channelName}
POST /api/memory/op  <- {op: add|set|del, id, rule{…}}
CLI: memory list | memory propose "правило" --why "почему" [--all] [--video ID] | memory add "правило" [--all] | memory on|off|del ID
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


def state(ch=None):
    R = rules(ch)
    c = (P.channel(ch) if ch else P.channel()) or {}
    return {**R, "new": sum(1 for x in R["channel"] + R["all"] if x.get("status") == "new"), "channelName": c.get("name", "")}


def _norm(s):
    return " ".join((s or "").lower().split())


def add(text, why="", scope="channel", status="on", by="author", video=None, ch=None):
    text = (text or "").strip()
    if not text:
        raise ValueError("пустое правило")
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
    if patch.get("scope") in ("channel", "all") and patch["scope"] != r.get("scope"):   # перенос между каналом и «для всех»
        R.pop(i)
        _write(p, R)
        r["scope"] = patch["scope"]
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


def prompt_text(ch=None):
    """Действующие правила — в системный промпт (ideas_claude.system)."""
    R = rules(ch)
    on = [x for x in R["channel"] if x.get("status") == "on"] + [x for x in R["all"] if x.get("status") == "on"]
    if not on:
        return ""
    return "\n".join(f"- {x['text']}" + (f" (почему: {x['why']})" if x.get("why") else "") for x in on)


# ---------------------------------------------------------------- HTTP / CLI
def handle_get(A, h, p, q):
    if p == "/api/memory":
        h._json(state()); return True
    return False


def handle_post(A, h, p, body):
    if p == "/api/memory/op":
        op, r = body.get("op"), body.get("rule") or {}
        if op == "add":
            h._json(add(r.get("text"), r.get("why", ""), r.get("scope", "channel"), "on", "author")); return True
        if op == "set":
            h._json(set_rule(body.get("id", ""), r)); return True
        if op == "del":
            h._json(delete(body.get("id", ""))); return True
        raise ValueError("нет такой операции")
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
                print(f"[{x['id']}] {x.get('status')} · {x['text']}" + (f" — {x['why']}" if x.get("why") else ""))
        return True
    if cmd in ("propose", "add"):
        text = next((x for x in a if not x.startswith("--") and a.index(x) == 0), "") if a else ""
        res = add(text, opt("--why") or "", "all" if "--all" in a else "channel", "new" if cmd == "propose" else "on",
                  "claude" if cmd == "propose" else "author", opt("--video"))
        print("уже есть такое правило" if res.get("dup") else ("предложено автору: " if cmd == "propose" else "добавлено: ") + res["rule"]["id"])
        return True
    if cmd in ("on", "off") and a:
        print(set_rule(a[0], {"status": cmd})); return True
    if cmd == "del" and a:
        print(delete(a[0])); return True
    print(cli.__doc__); return True
