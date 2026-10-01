"""🔎 Поиск картинок для референсов прямо в приложении (core.js ImgSearch): без ключей.

ya   — Яндекс Картинки (страница выдачи, данные serp-item: превью, оригинал, сайт). Неофициально: при частых запросах Яндекс может спросить капчу —
       тогда ошибка с советом открыть окно поиска; ключ Yandex Search API (Yandex Cloud) — запасной путь, если понадобится.
free — свободные картинки: Openverse + Wikimedia Commons (лицензии CC, assets.py).
Ответ: [{thumb, full, title, page, domain, w, h, license}] — превью грузит страница, оригинал качает /api/file/url (с запасным превью).
CLI: python imgsearch.py "запрос" [ya|free] [страница]
"""
import html, json, re, sys, urllib.parse, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8"}


def _get(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read(8 << 20).decode("utf-8", "replace")


def _abs(u):
    return ("https:" + u) if (u or "").startswith("//") else (u or "")


def yandex(q, page=0):
    t = html.unescape(_get("https://yandex.ru/images/search?" + urllib.parse.urlencode({"text": q, "p": int(page)})))
    if "img_href" not in t:
        if "captcha" in t.lower() or "showcaptcha" in t.lower():
            raise ValueError("Яндекс просит капчу (слишком много поисков подряд) — подожди минуту или открой окно поиска «↗ в окне»")
        return []
    out, seen = [], set()
    # у каждой картинки: "thumb":{"url":…,"w","h"}, "snippet":{"title","url","domain"}, "img_href":…
    for m in re.finditer(r'"thumb":\{"url":"([^"]+)","w":(\d+),"h":(\d+)\},"snippet":\{(.*?)\},"detail_url":"[^"]*","img_href":"([^"]+)"', t):
        thumb, w, hgt, snip, full = m.groups()
        if full in seen:
            continue
        seen.add(full)
        sn = {}
        for k in ("title", "url", "domain"):
            mm = re.search(r'"%s":"((?:[^"\\]|\\.)*)"' % k, snip)
            if mm:
                try:
                    sn[k] = json.loads('"' + mm.group(1) + '"')
                except ValueError:
                    sn[k] = mm.group(1)
        out.append({"thumb": _abs(thumb), "full": full, "title": re.sub(r"<[^>]+>", "", sn.get("title", ""))[:140], "page": sn.get("url", ""),
                    "domain": sn.get("domain", ""), "w": int(w), "h": int(hgt), "license": ""})
    return out


def free(q, page=0):
    import assets
    n = 30
    rows = []
    for fn in (assets.s_openverse, assets.s_commons):
        try:
            rows += fn(q, "2d", n)
        except Exception as e:
            print("! imgsearch free:", fn.__name__, e)
    out = []
    for r in rows:
        out.append({"thumb": r.get("thumb"), "full": r.get("url") or r.get("thumb"), "title": r.get("title", ""), "page": r.get("page", ""),
                    "domain": {"openverse": "Openverse", "commons": "Wikimedia Commons"}.get(r.get("src"), r.get("src", "")), "w": 0, "h": 0,
                    "license": r.get("license", "")})
    return out if not page else []


def search(q, src="ya", page=0):
    q = (q or "").strip()
    if not q:
        return []
    return (free if src == "free" else yandex)(q, page)


if __name__ == "__main__":
    a = sys.argv[1:]
    r = search(a[0], a[1] if len(a) > 1 else "ya", int(a[2]) if len(a) > 2 else 0)
    print(len(r)); print(json.dumps(r[:3], ensure_ascii=False, indent=1))
