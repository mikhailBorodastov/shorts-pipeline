"""«✨ Сделать 3D» у персонажа и пропса препродакшена (S12.11, docs/studio/stage12-redesign.md, В2).

Одна кнопка вместо россыпи (Blender, TRELLIS, Meshy, Tripo, «собрать со скелетом», «фигурами»): Claude (Sonnet, без инструментов)
смотрит на элемент, его референсы, найденные модели и на то, что установлено, выбирает способ и одной фразой пишет почему —
и в той же задаче запускается прежняя сборка (element / charparts / charmodel). «▾ способ» на странице — выбрать самому (params.method).
Способы без ключа (Meshy, Tripo) или без программы (Blender, TRELLIS) не предлагаются вовсе.
"""
import os
import re

import paths as P
import preprod

# key -> (для кого, подпись, что это)
WAYS = {
    "shapes": ("prop", "Фигурами кодом", "Claude собирает предмет из коробок, цилиндров и выдавливаний (prop3d) — быстро, бумажный вид; для простых форм"),
    "model": ("prop", "Из найденной модели", "glTF из «📦 ассетов» элемента, матовый, бумажный; нужен ассет «в работе»"),
    "parts": ("char", "Бумажная карточка из частей", "Claude рисует героя частями на костях, как нашего ёжика: позы, эмоции, анимации"),
    "asset": ("char", "Из найденной модели", "3D-модель из «📦 ассетов» (лучше со скелетом): готовый скелет подстроится, нет — встанет авто-скелет"),
    "blender": ("both", "Blender", "Claude строит детальную модель в Blender кодом по референсам (и ставит скелет персонажу) — 15–40 минут"),
    "trellis": ("both", "TRELLIS на видеокарте", "Pixal3D / TRELLIS.2 лепит модель по картинке локально, бесплатно — 1–3 минуты черновик"),
    "meshy": ("both", "Meshy", "сервис «картинка → 3D» + авто-скелет (платно, ключ в ⚙ Настройках)"),
    "tripo": ("both", "Tripo", "сервис «картинка → 3D» + авто-скелет (платно, ключ в ⚙ Настройках)"),
}


def _secret(A, name):
    try:
        import settings_api
        return bool(settings_api.secret(name))
    except Exception:
        return False


def _pic(e):
    """Картинка для «картинка → 3D»: первый референс автора, иначе последний 2D-черновик."""
    for r in e.get("refs") or []:
        if r.get("img"):
            return r["img"]
    for r in reversed(e.get("renders") or []):
        if r.get("img") and not (r.get("three3") or r.get("rigchar") or r.get("model3d")):
            return r["img"]
    return None


def ways(A, e):
    """[{key, label, desc, ok, why}] — все способы для этого элемента; ok=False — почему нельзя (ключа нет, нет картинки…)."""
    kind = e.get("kind")
    models = [a for a in e.get("assets") or [] if a.get("kind") == "3d"]
    try:
        import comfy3d
        trellis = not comfy3d.installed().get("missing") and comfy3d.installed().get("comfy")
    except Exception:
        trellis = False
    out = []
    for k, (who, label, desc) in WAYS.items():
        if who not in ("both", kind):
            continue
        why = ""
        if k in ("model", "asset") and not models:
            why = "нет 3D-модели в «📦 ассетах» элемента"
        elif k == "blender" and not P.blender():
            why = "Blender не найден"
        elif k == "trellis" and not trellis:
            why = "TRELLIS не поставлен (⚙ Настройки → Локальная 3D)"
        elif k in ("meshy", "tripo") and not _secret(A, k):
            continue                                       # без ключа — не показываем вовсе (платные)
        elif k in ("trellis", "meshy", "tripo") and not _pic(e):
            why = "нужна картинка: референс или 2D-черновик"
        out.append({"key": k, "label": label, "desc": desc, "ok": not why, "why": why})
    return out


# S20: «по-настоящему 3D» — бумажная карточка (parts) не годится, автор просит объём
VOLUME = re.compile(r"объ[её]м|по[- ]настоящему|настоящ\w* 3d|не плоск|не карточк|не бумажн|полноценн\w* 3d|3d[- ]модел|volumetric|real 3d", re.I)
# S22: персонаж в 3D по умолчанию — НАСТОЯЩИЙ объём (автор, 6 окт 2026: «бумажная 2D-карточка в 3D-пространстве мне вообще не понравилась»);
# карточка на костях — только если автор сам так сказал
CARD = re.compile(r"карточк|плоск|на костях|как [её]жик|бумажн\w* (персонаж|геро|фигур)|2d[- ]карточ|flat|paper card", re.I)
CHAR_ORDER = ("asset", "blender", "trellis", "meshy", "tripo")       # своя модель автора из ассетов -> Blender (качество, скелет) -> TRELLIS -> платные


def author_words(e, wish=""):
    """Что автор сказал про этот элемент: просьба из чата / кнопки (wish), правки «в целом», «какой нужен»."""
    fx = (e.get("fx") or {}).get("main") or {}
    out = [wish.strip()] if (wish or "").strip() else []
    out += [n.get("text", "").strip() for n in fx.get("notes") or [] if isinstance(n, dict) and (n.get("text") or "").strip()]
    out += [t.strip() for t in (fx.get("text"), e.get("ask")) if (t or "").strip()]
    return out


def _decide(A, job, e, plan, avail, words):
    """Claude выбирает способ из доступных: {method, asset, why}."""
    from ideas_claude import S, STR, system
    docs = A._docs(job.key)
    models = "\n".join(f"- ассет {a['id']}: «{a.get('title', '')}» ({a.get('src')}, {(a.get('fmt') or '').upper()}"
                       + (f", скелет {a.get('bones') or '?'} костей" if a.get("rigged") else ", без скелета")
                       + (f", анимации: {', '.join(a['anims'][:6])}" if a.get("anims") else "") + ")" + (f" — автор: {a['why']}" if a.get("why") else "")
                       for a in e.get("assets") or [] if a.get("kind") == "3d") or "(нет)"
    ch = docs.get("channel") or {}
    style3d = ch.get("style3d") or ""
    prompt = f"""Шаг «Сделать 3D». Выбери ОДИН способ сделать объёмную версию элемента для 3D-сцены ролика (бумажный макет, Paper Mario + Octopath).
Элемент: {'персонаж' if e.get('kind') == 'char' else 'пропс'} «{e.get('name', '')}» — {e.get('desc') or '(описания нет)'}
Где в ролике: {e.get('why') or '—'}
{('ЧТО ПРОСИТ АВТОР (главнее стиля канала и правил ниже): ' + ' / '.join('«' + w + '»' for w in words)) if words else ''}
Стиль 3D канала (по умолчанию, если автор не сказал иначе): {style3d or 'бумажный макет: матовые цвета, карточки, мягкий свет'}
Референсов-картинок у автора: {sum(1 for r in e.get('refs') or [] if r.get('img'))}; 2D-черновиков: {sum(1 for r in e.get('renders') or [] if not (r.get('three3') or r.get('rigchar') or r.get('model3d')))}
3D-модели в «📦 ассетах»:
{models}

{preprod.element_brief(e, plan, docs["data"])}

Доступные способы (выбирай только из них):
{chr(10).join(f"- {w['key']}: {w['label']} — {w['desc']}" for w in avail)}

Как выбирать: простой предмет (мебель, коробка, табличка, лампа) — shapes; есть подходящая модель — model / asset (asset — её id);
parts — ПЛОСКАЯ карточка на костях: только если автор прямо просит плоского / карточку;
объёмный персонаж или сложная органическая форма, «как на картинке» — trellis (быстро и бесплатно), blender (дольше, аккуратнее, кодом, со скелетом) или asset.
Если автор просит объёмного / настоящего 3D — НЕ parts.
Платные сервисы (meshy, tripo) — только если они есть в списке и бесплатные явно хуже подходят.
why — одной фразой по-русски, почему этот способ."""
    spec = {"system": system(docs, "short"), "prompt": prompt, "timeout": 300, "model": A.TEXT_MODEL,
            "schema": S({"method": {"type": "string", "enum": [w["key"] for w in avail]}, "asset": STR, "why": STR}, ["method", "why"])}
    return A.run_claude(job, spec)


def run(A, job):
    key, el = job.key, job.params.get("el")
    plan = A.load(key)
    e = A._by_id(plan.get("elements"), el)
    if not e or e.get("kind") not in ("char", "prop"):
        raise ValueError("3D делается у персонажа или пропса")
    avail = [w for w in ways(A, e) if w["ok"]]
    if not avail:
        raise ValueError("нет доступного способа: добавьте референс или 3D-модель в ассеты, поставьте Blender или TRELLIS")
    method, asset, why = job.params.get("method"), "", "выбрано вручную"
    wish = (job.params.get("wish") or "").strip()
    words = author_words(e, wish)
    if not method and any(VOLUME.search(w) for w in words):      # автор просит объём: плоская карточка не в счёт
        flat = [w for w in avail if w["key"] == "parts"]
        avail = [w for w in avail if w["key"] != "parts"]
        if not avail:
            raise ValueError("объёмного способа нет: " + "; ".join(f"{w['label']} — {w['why']}" for w in ways(A, e) if not w["ok"] and w["key"] != "parts")
                             + ". Поставьте Blender или TRELLIS (⚙ Настройки) или возьмите 3D-модель в «📦 ассеты»" + (" — либо выберите «Бумажная карточка» сами" if flat else ""))
    if not method and e["kind"] == "char":                    # S22: персонаж — объём по умолчанию, способ без вызова Claude
        if any(CARD.search(w) and not VOLUME.search(w) for w in words) and any(w["key"] == "parts" for w in avail):
            method, why = "parts", "автор просит плоскую карточку на костях"
        else:
            vol = [k for k in CHAR_ORDER if any(w["key"] == k for w in avail)]
            if not vol:
                raise ValueError("объёмного способа нет: " + "; ".join(f"{w['label']} — {w['why']}" for w in ways(A, e) if not w["ok"] and w["key"] != "parts")
                                 + ". Поставьте Blender или TRELLIS (⚙ Настройки) или возьмите 3D-модель в «📦 ассеты»; плоская карточка — только если попросить словами")
            method = vol[0]
            why = {"asset": "есть 3D-модель в ассетах элемента", "blender": "объёмная модель со скелетом в Blender — по умолчанию для персонажей",
                   "trellis": "объёмная модель по картинке (Blender не найден)"}.get(method, "объёмная модель")
    if method:
        if method not in [w["key"] for w in avail]:
            raise ValueError("этот способ сейчас недоступен: " + next((w["why"] for w in ways(A, e) if w["key"] == method), method))
    else:
        job.summary = "Claude выбирает способ…"
        r = _decide(A, job, e, plan, avail, words) or {}
        method, asset, why = r.get("method"), r.get("asset") or "", r.get("why") or ""
        if method not in [w["key"] for w in avail]:
            method = avail[0]["key"]
    label = WAYS[method][1]
    models = [a for a in e.get("assets") or [] if a.get("kind") == "3d"]
    if method in ("model", "asset") and not any(a["id"] == asset for a in models):
        asset = next((a["id"] for a in models if a.get("rigged")), models[0]["id"])
    E = ["elements", el]
    ops = [{"op": "set", "path": E + ["make3d"], "value": {"method": method, "why": why, "at": A.now_ms(), **({"wish": wish} if wish else {})}}]
    if e["kind"] == "prop":
        ops.append({"op": "set", "path": E + ["dim"], "value": "3d"})
        if method in ("shapes", "model", "blender"):
            ops.append({"op": "set", "path": E + ["how"], "value": method})
    else:
        ops.append({"op": "set", "path": E + ["form"], "value": "rig"})
    A.apply_ops(key, ops)
    head = f"{label} — {why}" if why else label
    job.summary = head + " · делаю…"
    params = job.params
    try:
        if e["kind"] == "prop" and method in ("shapes", "model", "blender"):
            job.kind, job.params = "element", {"el": el}
            A.run_action(job)
        elif e["kind"] == "char" and method in ("parts", "blender"):
            job.kind, job.params = "charparts", {"el": el, **({"make": "blender"} if method == "blender" else {})}
            A.run_action(job)
        else:
            job.kind = "charmodel"
            job.params = {"el": el, "source": method}
            if method in ("asset", "model"):
                job.params.update(source="asset", asset=asset)
            if method == "trellis":
                job.params.update(mode="draft", engine="pixal3d", ref=_pic(e), **({"h": e.get("h") or 0.6} if e["kind"] == "prop" else {}))
            A.m3d().run_job(A, job)
    finally:
        job.params = params
    job.summary = f"{head} · " + (job.summary or "готово")


def handle_get(A, h, p, q):
    if p == "/api/make3d/ways":                            # «▾ способ»: что можно для этого элемента
        e = A._by_id(A.load(q.get("key", [""])[0]).get("elements"), q.get("el", [""])[0])
        if not e:
            h._json({"error": "элемент не найден"}, 404); return True
        h._json({"ways": ways(A, e)}); return True
    return False
