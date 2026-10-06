# Мультипостинг (YouTube / TikTok / Instagram) — исследование, этап 1

Дата: 5 окт 2026. Код не менялся. Метки: **[✓]** — проверено по официальной документации или исходникам, **[?]** — вторичный источник или не удалось подтвердить. Перед внедрением такие пункты нужно проверить.

---

## 1. Что сейчас есть в Claude Studio (то, что относится к задаче)

| Что | Как устроено | Где |
|---|---|---|
| Стек | Python stdlib (`ThreadingHTTPServer`) на `127.0.0.1:8790`, без фреймворка. Фронт — ванильный JS без сборки. Tauri 2 — только окно WebView2 над локальным сервером | `server/ideas_server.py`, `web/`, `app/` |
| Маршруты | Цепочка префиксов в `ideas_api.handle_get/handle_post` → модули `*_api.py` с `handle_get(A,h,p,q)` / `handle_post(A,h,p,body)`. Модули перезагружаются на лету, `API_VERSION` держится в паре с `web/core.js` | `ideas_api.py:1541`, `:1702` |
| Публичный URL | **Нет.** Сервер слушает только localhost (`trusted()`) | `ideas_api.py:1432` |
| Фоновые задачи | `JOBS` в памяти: `start_job(kind,…)`, очередь `_pump()`, лог `.studio/.jobs/log.txt`. Тикер раз в минуту: `auto_tick()`, сейчас там синк YouTube. Отдельно — очередь рендеров `render_api.Q` (в `.studio/renders.json`). UI опрашивает `/api/revs` каждые 2 с | `ideas_api.py:960–1130`, `render_api.py` |
| Docker | Нет нигде | — |
| Готовое видео | `<видео>/out/<имя>.mp4`: H.264, его кодирует WebCodecs, ffmpeg только упаковывает (`+faststart`, AAC 192k). Шортс — 1080×1920, длинное — 1920×1080 (`src/format.js → FRAME_SIZE`). FPS 60 (шортс) или 30 (длинное). **Битрейт 14–20 Мбит/с** | `template/build.sh`, `template/render.js:105–170` |
| «Рендеры» → экспорт | `render_api.finish()` собирает «всё для YouTube» в `out/`: mp4, `.srt`, `<имя>_thumbnail.jpg`, `<имя>.txt` (название, описание, теги, главы, права), у длинного ещё `_chapters.txt` | `render_api.py:179–331` |
| Метаданные | `video.json → pack`: `titles[] {text, angle, best}`, `short` (описание Shorts/Reels), `sources`, `provoke`, `pin`, `tags[]`, `thumb` (выбранная обложка в `out/`), `covers[]`, `rights_md`. Задел — `pack.title` / `pack.desc` (их читает `render_api`, но никто не пишет). `video.json → yt {id,url}` после привязки → статус «вышло» | `pack_api.py`, `web/pack.js`, `render_api.py:217` |
| YouTube (S17) | OAuth 2 + PKCE, loopback-редирект `127.0.0.1:<случайный>`, клиент «Desktop app» в `.studio/youtube_client.json`, токены — `.studio/youtube/<UC…>.json`. **Права только на чтение** (`youtube.readonly`, `yt-analytics.readonly`), загрузки нет | `youtube_api.py:25, 117–224` |
| Секреты | `.studio/secrets.json` + словарь `SECRETS` в `settings_api.py` (маскируются на странице, подстраховка — `<NAME>_API_KEY` из окружения). Настройки — `.studio/state.json`. `.env` не используется | `settings_api.py:12–125`, `paths.py:133` |

**Что из этого следует:**
- Приложение локальное: Windows и окно Tauri, без Docker и без публичного адреса. Всё, что требует публичного HTTPS (OAuth callback TikTok, `video_url` у Instagram, вебхуки), напрямую не работает.
- Встраивать удобно так: кнопка «📤 Опубликовать» у готового рендера плюс фоновая задача `publish`. Тексты берутся из `pack`, обложка — из `pack.thumb`.
- Вход в Google уже есть. Для загрузки нужно добавить право `youtube.upload` и войти заново.

Попутно: `API_VERSION = 29` на сервере, а `API = 30` в `web/core.js`. Похоже, другая сессия сейчас посреди правки — к этой задаче не относится.

---

## 2. Факты по Postiz и площадкам, и где ТЗ расходится

### 2.1 Postiz (последний релиз v2.25.0 от 2 окт 2026)

| Вопрос | Факт | Сверка с ТЗ |
|---|---|---|
| Авторизация [✓] | `Authorization: <ключ>`, **без** `Bearer`. Облако — `https://api.postiz.com/public/v1`, свой сервер — `https://{домен}/api/public/v1` (в стандартном compose — `http://localhost:4007/api/public/v1`) | ✅ совпадает |
| Лимит [✓ код] | Код по умолчанию — 90 в час, через `API_LIMIT` меняется на своём сервере. **Считаются только `POST /public/v1/posts`** на организацию. Загрузка, списки, удаление и каналы не считаются. Один `POST /posts` с несколькими каналами — один запрос. В `docker-compose.yaml` стоит `API_LIMIT: 30`, текст OpenAPI устарел («30/час»), у облака в документации 90 (в одной строке — 100) | ⚠️ «30 в час» устарело, лимит фактически не мешает |
| Каналы [✓] | `GET /integrations` (`id, name, identifier, picture, disabled`), подключение — `GET /social/{youtube\|tiktok\|instagram…}` → `{url}` OAuth | ✅ |
| Медиа [✓] | `POST /upload` (multipart, поле `file`), `POST /upload-from-url {url}` → `{id, path}`. Принимает **только `video/mp4`**, **видео до 1 ГБ**, картинки до 10 МБ. Рекомендуют H.264 + AAC, **≤30 fps** | ⚠️ 1 ГБ — это граница для длинных роликов (см. §2.5) |
| Посты [✓] | `POST /posts`, `GET /posts?startDate&endDate` (**`GET /posts/{id}` нет**), `DELETE /posts/{id}`, `PUT /posts/{id}/status`, `GET /posts/{id}/missing` + `PUT …/release-id` (дочинить ссылку TikTok), `GET /find-slot/{id}`, `GET /notifications` | ⚠️ статус одного поста — только из выборки по датам |
| Схема `POST /posts` [✓] | `{type: draft\|schedule\|now, date: ISO UTC, shortLink, tags: [], posts: [{integration:{id}, value:[{content, image:[{id,path}]}], settings:{__type, …}}]}` → `[{postId, integration}]` | ✅ `settings` с `__type` у каждого канала |
| YouTube `__type:"youtube"` [✓] | `title` (2–100, обяз.), `type: public\|private\|unlisted`, `selfDeclaredMadeForKids: yes\|no`, `thumbnail {id,path}`, `tags [{value,label}]` (≤500 знаков). Описание — `content`. **Поля Short / обычное нет** — Short определяет YouTube сам. `categoryId` не передаётся | ⚠️ в ТЗ «тип Short/обычное» — такой настройки нет и не нужно |
| TikTok `__type:"tiktok"` [✓] | Обязательные: `privacy_level` (`PUBLIC_TO_EVERYONE\|MUTUAL_FOLLOW_FRIENDS\|FOLLOWER_OF_CREATOR\|SELF_ONLY`), `duet`, `stitch`, `comment`, `autoAddMusic`, `brand_content_toggle`, `brand_organic_toggle`, `content_posting_method: DIRECT_POST\|UPLOAD`. Необязательные: `title` (≤90), `video_made_with_ai` | ✅ |
| Instagram [✓] | `__type: "instagram"` (через FB-страницу) или `"instagram-standalone"` (вход Instagram без страницы). `post_type: post\|story` — **значения `reel` нет**: одно mp4 с `post` уходит как `media_type=REELS`. Есть ещё `is_trial_reel`, `collaborators` | ⚠️ «тип Reel» задаётся неявно |
| Статус [✓] | В `GET /posts`: `state: QUEUE\|PUBLISHED\|ERROR\|DRAFT`, `releaseURL`, `error`. У TikTok `releaseURL` сначала ведёт на профиль, в режиме `UPLOAD` — на `/messages`. Вебхуки: только «опубликовано», настраиваются в UI, адрес должен быть публичным, формат не описан | ⚠️ для локального приложения реально только опрос `GET /posts` |
| Self-host [✓] | **Temporal обязателен с v2.12.0.** Сервисы: postiz, Postgres 17, Redis 7, temporal + своя Postgres + Elasticsearch, temporal-ui. Минимум 2 vCPU / 2 ГБ, рекомендуют 4 vCPU / 8 ГБ, диск 20–50 ГБ. Нужны `FRONTEND_URL` (база OAuth-колбэков `…/integrations/social/<провайдер>`) и свои ключи площадок: `YOUTUBE_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_ID/SECRET`, `INSTAGRAM_APP_ID/SECRET` или `FACEBOOK_APP_ID/SECRET`. TikTok требует HTTPS-редирект и подтверждённый домен с ToS и Privacy. Instagram отдаёт Meta `video_url` — значит, хранилище медиа должно быть доступно извне (R2 или публичный прокси) | ✅ Temporal обязателен; публичный HTTPS фактически обязателен |
| Облако [✓] | Standard $29/мес ($278/год), 5 каналов. Team $39, Pro $49, Ultimate $99. Посты без лимита, **Public API на всех тарифах**, бесплатного тарифа нет (триал 7 дней). **[?] Прошли ли облачные приложения Postiz аудит TikTok Direct Post и ревью Meta — официально нигде не сказано** | ⚠️ ТЗ считает «аудит снят» — не подтверждено |
| Лицензия [✓] | AGPL-3.0. §13 обязывает того, кто **изменил** Postiz и даёт к нему доступ по сети. Отдельная программа, которая зовёт его HTTP API, — не производная работа, свой код открывать не нужно (это толкование, не юридическая консультация). **Не импортировать `@postiz/node`** — SDK тоже под AGPL и к тому же устарел (1.0.8, июль 2025). Звать REST напрямую | ✅ при работе через REST |
| Прочее | Официальный MCP (`mcp.postiz.com`), n8n-нода, CLI `postiz` | — |

Источники: [llms.txt](https://docs.postiz.com/llms.txt), [Public API intro](https://docs.postiz.com/public-api/introduction.md), [OpenAPI](https://docs.postiz.com/public-api/openapi.json), [репозиторий](https://github.com/gitroomhq/postiz-app) (`apps/backend/src/app.module.ts`, `libraries/nestjs-libraries/src/throttler/throttler.provider.ts`, `…/dtos/posts/providers-settings/*.dto.ts`, `…/upload/custom.upload.validation.ts`, `…/integrations/social/*.provider.ts`), [требования self-host](https://docs.postiz.com/self-host/installation/system-requirements.md), [переменные](https://docs.postiz.com/self-host/configuration/reference.md), [TikTok в self-host](https://docs.postiz.com/self-host/providers/tiktok.md), [вебхуки](https://docs.postiz.com/general/automations/webhooks.md), [тарифы](https://docs.postiz.com/cloud/plans.md).

### 2.2 YouTube Data API v3

| Вопрос | Факт | Сверка с ТЗ |
|---|---|---|
| Квота [✓] | 4 дек 2025 загрузка подешевела с ~1600 до ~100 единиц. С 1 июня 2026 у `videos.insert` своё ведро: **100 загрузок в сутки** по умолчанию, плюс 10 000 единиц на остальное. `thumbnails.set` и `videos.update` — по 50 единиц | ❌ «≈6 загрузок в день» больше не так, квота не ограничивает |
| Shorts [✓] | Отдельного эндпоинта нет. Short — вертикальное или квадратное видео **до 3 минут** (с 15 окт 2024). Short длиннее минуты с активной заявкой Content ID блокируется по всему миру | ✅ |
| Неверифицированный проект [✓] | Видео, загруженные через API из непрошедших аудит проектов (созданных после 28 июля 2020), **принудительно private**. Снимается только аудитом — [форма](https://support.google.com/youtube/contact/yt_api_form), идёт неделями. **[?]** Можно ли потом сделать такое видео публичным руками: по отзывам — нет («Locked»), это нужно проверить на тестовом ролике | ✅ проблема реальная и для варианта C, и для варианта A |
| Режим «Testing» [✓] | В «Testing» refresh-токены со скоупом `youtube.upload` **живут 7 дней**. Выход: перевести приложение в «In production» без верификации — пользователь увидит экран «приложение не проверено», лимит 100 пользователей, токены живут долго | ⚠️ в ТЗ не упомянуто |
| Обложки [✓] | `thumbnails.set` (JPEG/PNG ≤50 МБ) — нужен подтверждённый канал. Своя обложка у Shorts — с 25 июля 2026, пока только в десктопной Studio и для каналов в YPP. **[?]** Работает ли она через API — не подтверждено | ⚠️ у шортса обложка через API может не встать |
| Загрузка | Resumable, до 256 ГБ | ✅ |

Источники: [стоимость квоты](https://developers.google.com/youtube/v3/determine_quota_cost), [revision history](https://developers.google.com/youtube/v3/revision_history), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [аудит](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits), [OAuth: срок токенов](https://developers.google.com/identity/protocols/oauth2), [Shorts и Content ID](https://support.google.com/youtube/answer/15424877).

### 2.3 TikTok Content Posting API

| Вопрос | Факт | Сверка с ТЗ |
|---|---|---|
| Без аудита [✓] | Не больше 5 пользователей в сутки, **аккаунт должен быть приватным**, пост только `SELF_ONLY` | ✅ |
| Аудит для личного использования [✓] | **Не проходит.** В правилах прямо записано, что неприемлем «utility tool to help upload contents to the account(s) you or your team manages», а клиент должен быть «для широкой аудитории, не для внутреннего использования». Отклоняют и приложения, которые копируют контент с других площадок | ❌ «как пройти аудит для личного использования» — никак |
| Режим `UPLOAD` (черновик во «Входящих») [✓] | Скоуп `video.upload`: ролик падает в инбокс, автор дописывает и публикует в приложении TikTok. Не больше 5 ожидающих черновиков в сутки. **[?]** Действуют ли без аудита ограничения «аккаунт приватный» — не ясно, проверять тестом | ➕ запасной путь без аудита |
| `creator_info` [✓] | `creator_nickname`, `privacy_level_options`, **`max_video_post_duration_sec`**, флаги `comment/duet/stitch_disabled` | ✅ |
| Обязательный UI [✓] | Показать ник автора; выпадающий список приватности **без значения по умолчанию**; переключатели взаимодействий выключены по умолчанию; раскрытие коммерческого контента; текст «By posting, you agree to TikTok's Music Usage Confirmation» | ⚠️ нужно в форме, если публикуем своим приложением |
| Лимиты [✓] | ~15 постов в сутки на автора (общий на все API-клиенты). MP4/MOV/WebM, H.264/H.265, 23–60 fps, до 4 ГБ, до 10 мин через API, подпись до 2200 знаков. `PULL_FROM_URL` — только с подтверждённого домена | ✅ |
| Сербия [?] | Официального списка стран для Content Posting API нет. Direct Post запущен «глобально», в исключениях Сербии не видно. Проверять регистрацией | — |

Источники: [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines), [Get started](https://developers.tiktok.com/doc/content-posting-api-get-started), [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post), [Upload](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [creator_info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info), [Media transfer](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide).

### 2.4 Instagram

| Вопрос | Факт | Сверка с ТЗ |
|---|---|---|
| Без Facebook-страницы [✓] | Да: **Instagram API with Instagram Login** (июль 2024), Business или **Creator** аккаунт, право `instagram_business_content_publish`. В Postiz это «instagram-standalone» | ✅ страница не нужна |
| App Review [✓] | Для своих аккаунтов (у которых есть роль в приложении, например тестер) хватает **Standard Access** — без App Review и без верификации бизнеса | ➕ проще, чем в ТЗ |
| Публикация Reels [✓] | Контейнер `media_type=REELS` → ждём `status_code` → `media_publish`. Видео — `video_url` (нужен **публичный** URL) **или** `upload_type=resumable` через `rupload.facebook.com` (подходит локальному приложению). Контейнер живёт 24 ч. **100 постов через API за скользящие 24 ч** | ✅ |
| Спецификация Reels [✓] | MP4/MOV, moov в начале, H.264/HEVC, ≤25 Мбит/с, 23–60 fps, ширина ≤1920, **3 с – 15 мин, ≤300 МБ**, AAC ≤48 кГц **≤128 кбит/с**. Обложка — `cover_url` или `thumb_offset` | ⚠️ наш звук — 192 кбит/с, см. §2.5 |

Источники: [обзор платформы](https://developers.facebook.com/docs/instagram-platform/overview), [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing), [IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media).

### 2.5 Водяные знаки и наш файл

- **Водяные знаки [✓].** Instagram с февраля 2021 прячет Reels с чужими водяными знаками, с весны 2024 рекомендует только оригиналы ([tubefilter](https://tubefilter.com/2021/02/10/instagram-reels-with-tiktok-watermark-less-discoverable/)). Официального заявления YouTube о том же нет [?]. Вывод не меняется: на каждую площадку грузим **чистый исходник из `out/`**, скачанный с другой площадки файл — никогда.
- **Наш mp4 не везде проходит как есть:**
  - Шортс 60 fps при 20 Мбит/с занимает ~150 МБ за минуту. Instagram берёт до 300 МБ, значит шортс длиннее ~2 мин туда не влезет.
  - Звук AAC 192k выше лимита Instagram (128k). Может пройти, но это риск.
  - Длинное видео 10 мин при 14 Мбит/с занимает ~1,05 ГБ. **Это больше 1 ГБ — потолка загрузки Postiz.**
  - Отсюда план: делать «копию для публикации» через ffmpeg, когда файл выходит за лимиты площадки (H.264 ~8–10 Мбит/с, 30 fps для Postiz, AAC 128k, `+faststart`). Исходник остаётся нетронутым.

---

## 3. Сравнение вариантов

Цифры для нашего объёма: 1 автор, 3 аккаунта, ~30 роликов в месяц.

| | **A. Postiz self-host** | **B. Postiz Cloud** | **C. Прямые API** | **D. Гибрид** (YT + IG напрямую, TikTok через агрегатор) | **D′. Другой агрегатор на всё** (Upload-Post и др.) | **E. Mixpost** |
|---|---|---|---|---|---|---|
| Что развернуть | Docker Desktop + 8 контейнеров (Temporal, ES…), **публичный HTTPS-домен** (VPS или туннель), R2 или прокси для медиа | Ничего | Ничего, код в Studio | Код YT+IG в Studio + ключ агрегатора | Ничего | Laravel-сервер |
| Сложность внедрения | Высокая (инфраструктура) + средняя (клиент) | **Низкая**: один REST-клиент | Высокая: три OAuth, три загрузки по частям, свой UI TikTok | Средняя | **Низкая** | — |
| Деньги | VPS ~€5–10/мес + домен | **$29/мес** ($278/год) | 0 | $6–24/мес | Upload-Post $24, PostFast €12, Zernio (бывш. Late) ~$6, Buffer — бесплатно (3 канала, бета API) | Pro $299 разово |
| TikTok публично | ❌ свой аудит не пройдёт → `SELF_ONLY` | **[?]** не подтверждено, проверить на триале | ❌ то же. Черновик во «Входящих» — ✅ | Как у агрегатора | Upload-Post прямо пишет про официальный direct post; у остальных [?] | ❌ свои приложения |
| YouTube публично | ❌ без аудита Google — только private | ✅ скорее всего (их проект) [?] | ❌ без аудита Google — private (подать форму, ждать недели) | Как C | ✅ скорее всего [?] | ❌ |
| Instagram | ✅, но нужен публичный URL медиа | ✅ | ✅ Standard Access, resumable-загрузка | ✅ | ✅ | — |
| Длинное видео YT | ⚠️ ≤1 ГБ | ⚠️ ≤1 ГБ | ✅ до 256 ГБ | ✅ | Зависит от сервиса | — |
| Лимит API | Свой (`API_LIMIT`) | 90/час на `POST /posts`, нам хватит с запасом | Нет | Нет | Свой у каждого | — |
| Риски | Обслуживание, обновления Temporal, лицензия ок | Зависимость от сервиса; если их TikTok тоже `SELF_ONLY`, смысла нет | Самая большая поддержка (API площадок меняются); TikTok остаётся ручным | Две схемы сразу | Мелкий сервис может закрыться или поднять цены (Late → Zernio подорожал [?]) | Не наш стек (Python, не PHP) — **отпадает** |

**Вывод по A:** у self-host нет ни одного плюса перед C. Аудиты TikTok и Google всё равно на нас, при этом добавляются Docker, Temporal и публичный домен. **E** отпадает: бэкенд не на Laravel, а в бесплатной Lite нет ни TikTok, ни YouTube, ни API.

---

## 4. Рекомендация

**B: Postiz Cloud через Public API, но за слоем «публикатор» в Studio.** Сначала 7-дневный триал, на котором проверяем главное — TikTok `PUBLIC_TO_EVERYONE`.

Почему так:
1. **Решает обе аудиторные проблемы** (TikTok и YouTube private-lock), если облачные приложения Postiz их прошли. Свой код упирается в эти проблемы в любом варианте A и C. А личный инструмент TikTok не одобрит в принципе.
2. Приложение локальное, а облаку от него ничего не нужно: файл грузится multipart, статус — опросом `GET /posts`. Публичного адреса, Docker и VPS не нужно.
3. Один REST-клиент вместо трёх интеграций, лимит 90 в час нам не мешает. Лицензия AGPL нас не касается, если не тянуть их SDK.
4. Минусы: $29 в месяц, потолок 1 ГБ для длинных (закрывается копией для публикации), YouTube Short определяется только форматом файла.

**Запасной план, если на триале TikTok окажется `SELF_ONLY`.** Тот же слой публикатора, но адаптер **Upload-Post** ($24 в месяц: официальный direct post TikTok, Reels, Shorts с обложкой, REST на всех платных тарифах). Поэтому клиент делаем с интерфейсом `Publisher` и двумя реализациями-кандидатами, а не намертво под Postiz.

**Позже, по желанию, YouTube напрямую.** Вход у нас уже есть, длинным роликам это снимет потолок 1 ГБ. Но только после аудита Google, иначе ролики будут private. Параллельно можно подать форму аудита: она бесплатная и ни к чему не обязывает.

---

## 5. План внедрения (вариант B)

| Файл | Что |
|---|---|
| `server/publish_api.py` (новый) | Маршруты `/api/publish/*`: `GET state` (настроен ли, каналы из кэша), `GET video?id=` (записи публикаций), `POST send`, `POST cancel`, `POST refresh-integrations`. Задача `publish` в общей очереди: копия для публикации → `POST /upload` → один `POST /posts` на все выбранные каналы → запись в `video.json`. Опрос статуса — в `auto_tick()` раз в минуту, пока есть записи `QUEUE` |
| `server/publish/postiz.py` (новый) | `PostizClient`: базовый URL и ключ из настроек, `integrations()` с кэшем на сутки в `.studio/postiz_integrations.json`, `upload()`, `create_post()`, `list_posts(range)`, `delete_post()`. Ретраи с backoff на 5xx и сетевые ошибки, на 429 — ожидание до сброса окна. Счётчик `POST /posts` за час, чтобы не тратить запросы впустую. Типы запросов — dataclass / TypedDict по DTO (§2.1). `Publisher`-интерфейс общий с будущим `uploadpost.py` |
| `server/publish/media.py` (новый) | Проверка файла через ffprobe (размер, длительность, ориентация, fps, битрейт звука) против лимитов площадок, при необходимости — ffmpeg-копия `out/publish/<имя>.mp4` |
| `server/settings_api.py` | Ключ `postiz` в `SECRETS` (маскируется, подстраховка — `POSTIZ_API_KEY`). В `state.json` — `publish {enabled, base_url}`. **Флаг:** нет ключа — кнопок публикации нет |
| `server/ideas_api.py` | Префикс `/api/publish` → `publish_api`, вид задачи `publish` в `_run_job`, вызов опроса в `auto_tick()`, `API_VERSION`+1 |
| `video.json → publish[]` | `{id, at, when, channel:{integrationId, provider, name}, postId, state, url, error, file, settings}`. Через операции `ideas_api`, не руками. Опубликовано на YouTube → заполнить `yt {id,url}` (дальше заработает аналитика S17) |
| `web/ui/publish.js` + `.css` (новые) | Панель `#/v/<id>/publish` и кнопка «📤 Опубликовать» у готового рендера на странице «Рендеры». Чекбоксы каналов, общая подпись из `pack.short` + теги из `pack.tags` с переопределением на каждую площадку. YouTube: title из `pack.titles[best]`, описание из `pack.sources`, теги, privacy, «для детей», обложка `pack.thumb`. TikTok: ник, privacy **без значения по умолчанию**, duet/stitch/comment выключены, брендинг, музыкальное согласие. Instagram: подпись, trial reel. Дальше — «сейчас» или дата и время, статусы со ссылками, предупреждения (горизонтальное в TikTok/Reels, длительность > `max_video_post_duration_sec`, Short > 3 мин станет обычным видео, размер > лимитов) |
| `web/core.js`, `web/ui/shell.js` / `panels.js` | `API`+1, пункт панели в окне видео, иконка `Icon('send')` |
| `server/studio.py` | CLI `publish state\|send\|status <видео>`, чтобы агент Studio мог публиковать из чата (только по слову автора) |
| `docs/studio/stage21-publish.md` (+ мокап), `roadmap.md`, `architecture.md`, `README.md`, `CLAUDE.md` | ТЗ этапа и раздел «Ограничения» (квоты, лимит API, аудит TikTok, 1 ГБ) для критерия приёмки |

Существующий код меняется только точечно: регистрация маршрута, вид задачи, секрет и кнопка. Рендер и упаковка не трогаются.

---

## 6. Что сделать руками

1. **Postiz Cloud:** завести аккаунт, включить триал Standard, подключить в их интерфейсе YouTube, TikTok и Instagram, создать API-ключ (Settings → Public API). Ключ — в ⚙ Настройки Studio, не в чат.
2. **Instagram:** аккаунт перевести в **Creator** или Business (если ещё не). Facebook-страница не нужна.
3. **TikTok:** на триале выложить тестовый ролик публично и проверить, что он **не** приватный. Это решающий тест.
4. **YouTube:** проверить на тестовом unlisted-ролике, что видео не уходит в «Locked private». Если хотите свою обложку — подтвердить канал (телефон).
5. (По желанию, на будущее) Подать форму аудита YouTube API для своего Google-проекта.
6. VPS, домен, Docker для варианта B **не нужны**.

## 7. Открытые вопросы

1. **Бюджет:** нормально ли $29 в месяц (Postiz) или $24 (Upload-Post)? Или хочется бесплатно ценой ручного шага: YouTube и Instagram напрямую, TikTok черновиком во «Входящие»?
2. **Длинные ролики:** их выкладываем только на YouTube? Если да и будем уходить за 1 ГБ — сжимать копию (~8 Мбит/с, качество чуть ниже) или сразу планировать прямую загрузку YouTube?
3. **Какие тексты куда по умолчанию:** YouTube description = `pack.sources` (с источниками), а TikTok и Instagram = `pack.short`. Верно?
4. **Закреплённый комментарий** (`pack.pin`): Postiz умеет постить комментарии (`value[1…]`) — нужно?
5. **Один канал Studio = один набор аккаунтов?** Или когда-нибудь будет несколько YouTube-каналов (у Postiz это «customers» и «groups»)?
6. **Отложенная публикация** — по времени Сербии (Europe/Belgrade)? И подставлять ли «лучший слот» из `find-slot`?

---

## 8. Бесплатная схема: YouTube и Instagram напрямую, TikTok через Buffer (дополнение от 5 окт)

### 8.1 TikTok через Buffer (тариф Free)

| Вопрос | Факт |
|---|---|
| API на Free [✓] | Есть на всех тарифах. GraphQL `POST https://api.buffer.com`, `Authorization: Bearer <ключ>` (ключ — publish.buffer.com/settings/api, срок не ограничен). Free: 1 ключ, 100 запросов / 15 мин, 250 / сутки, **3000 / 30 дней** — нам с опросом статуса хватит |
| **Загрузка файла [✓]** | **Нет.** Видео передаётся только ссылкой: `assets:[{video:{url, metadata:{thumbnailOffset}}}]`. Ссылка должна быть публичной, прямой, HTTPS и **жить до публикации** (presigned/истекающие ссылки нельзя). Buffer рекомендует Cloudflare R2 (публичный бакет) или Cloudinary |
| Автопубликация [✓] | `schedulingType: automatic` — Buffer публикует сам. `notification` — пуш в приложение. Нужно **выключить** у канала «Enable Notifications by default» (`defaultToReminders`). Видео > 10 мин уходит только напоминанием |
| Настройки TikTok [✓] | Только подпись (`text`, ≤2200, ≤5 хэштегов), обложка кадром (`thumbnailOffset`, мс), `isAiGenerated`. **Приватности, duet/stitch/comments в API нет** — Buffer ставит что-то по умолчанию (видимо, публично) [?] |
| Расписание [✓] | `mode: shareNow \| customScheduled (dueAt, UTC) \| addToQueue` |
| Статус [✓] | Вебхуков нет, только опрос: `post { status (scheduled/sending/sent/error), sentAt, externalLink, error{message} }` |
| Лимиты [✓] | Free: 3 канала, 10 запланированных постов на канал. TikTok: 3 с – 10 мин, ≤1 ГБ, 25 постов в сутки на канал |
| Риски [?] | Если Buffer тянет видео в TikTok через `PULL_FROM_URL`, домен хранилища может требовать подтверждения в TikTok. Но есть кейс Buffer от июня 2026: публикация в TikTok из R2 без проблем. Тип аккаунта (личный / Creator / Business) и Сербия — без явных ограничений. **Всё решает один тестовый пост** |

Источники: [getting started](https://developers.buffer.com/guides/getting-started.md), [лимиты](https://developers.buffer.com/guides/api-limits.md), [хостинг медиа](https://developers.buffer.com/guides/hosting-media.md), [видео-пост](https://developers.buffer.com/examples/create-video-post.md), [reference](https://developers.buffer.com/reference.md), [roadmap](https://developers.buffer.com/roadmap.html), [TikTok в Buffer](https://support.buffer.com/articles/using-tiktok-with-buffer-oGEroY9Of2.md), [кейс с R2](https://buffer.com/resources/coding-kitty-case-study/).

**Значит, нужно бесплатное публичное хранилище: Cloudflare R2.** На бесплатном тарифе 10 ГБ хранения и бесплатный исходящий трафик (это цифры Cloudflare, сам не проверял). Загрузка — S3-совместимым запросом из Python. После `sent` файл удаляем. Попутно R2 закрывает и обложку Instagram: `cover_url` тоже требует публичную ссылку.

### 8.2 Instagram напрямую

- **Вход без HTTPS-редиректа [✓].** В кабинете Meta (приложение типа Business → Instagram API with Instagram Login) есть кнопка «Generate token». Она даёт токен на **60 дней**. Автор вставляет его один раз в ⚙, Studio сама продлевает его раз в ~30 дней (`graph.instagram.com/refresh_access_token`). Обычный OAuth требует точного HTTPS-редиректа, так что токен из кабинета проще.
- **Доступ [✓].** Своему аккаунту с ролью «Instagram Tester» в режиме Development хватает Standard Access. **App Review и верификация бизнеса не нужны.**
- **Загрузка с диска [✓]:**
  1. `POST graph.instagram.com/v25.0/{ig_id}/media` с `media_type=REELS&upload_type=resumable&caption…`.
  2. Сам файл — `POST` на выданный `rupload.facebook.com/…` (заголовки `Authorization: OAuth <токен>`, `offset: 0`, `file_size`).
  3. Опрос `status_code`, пока не `FINISHED`.
  4. `media_publish`, затем `permalink`.
- **Ограничения.** Своего расписания в API нет: Studio держит очередь сама и публикует в нужный момент, а значит, **компьютер должен быть включён**. Свою обложку — только через `cover_url` (R2), иначе кадр `thumb_offset`. 100 постов в сутки, ≤300 МБ, AAC ≤128k.

### 8.3 YouTube напрямую

- **Как работает.** Добавить скоуп `youtube.upload` в наш вход (S17) и войти заново. Google-приложение перевести в **«In production» без верификации**: для личного использования (<100 пользователей) это разрешено, будет экран «приложение не проверено», зато токен не сгорает через 7 дней. Загрузка resumable (куски по 256 КБ, докачка после обрыва). Расписание — родное: `privacyStatus: private` + `publishAt`. Есть поля `defaultAudioLanguage: ru` и `containsSyntheticMedia` (раскрытие ИИ). Квота — 100 загрузок в сутки.
- **❌ Главный стоп.** Пока проект не прошёл аудит YouTube API, все загруженные ролики **навсегда** заблокированы как private. Справка YouTube ([7300965](https://support.google.com/youtube/answer/7300965)): обжаловать нельзя, сделать публичным в Studio тоже нельзя. Аудит бесплатный, личные загрузчики его проходят, но нужно:
  - страница политики конфиденциальности (можно бесплатно на GitHub Pages);
  - описание и скринкаст работы;
  - ожидание от нескольких дней до недель.
- **Обложка** — `thumbnails.set` для обычных видео работает (нужен подтверждённый канал). Для Shorts через API — не подтверждено, делаем «по возможности»: при 403 публикация не падает.

### 8.4 Подсказка: Buffer умеет и YouTube, и Instagram

На Free 3 канала — ровно YouTube + TikTok + Instagram. Google-приложение Buffer уже прошло аудит, значит у Buffer **нет блокировки private**. Раз хранилище R2 всё равно нужно для TikTok, разумно на время аудита публиковать YouTube Shorts тоже через Buffer. **[?] Поддерживает ли Buffer длинные YouTube-видео** (раньше он умел только Shorts) — проверить. Длинные ролики — напрямую после аудита.

### 8.5 Итоговая бесплатная схема

| Площадка | Путь | Ручной шаг | Ждём |
|---|---|---|---|
| TikTok | Buffer API (automatic) + видео в R2 | Нет (после настройки) | Один тестовый пост |
| Instagram Reels | Напрямую, токен из кабинета Meta | Продление токена делает Studio | Ничего |
| YouTube Shorts | **Сейчас** через Buffer (R2 уже есть), **после аудита** — напрямую | Нет | Аудит Google (дни–недели) |
| YouTube длинные | Напрямую после аудита. До аудита — Buffer, если он умеет длинные, иначе руками | До аудита — руками | Аудит Google |

Стоимость: **0** (Buffer Free, Cloudflare R2 free tier, Meta и Google бесплатно).

**Что меняется в плане кода (§5):**
- `server/publish/postiz.py` заменяется на три адаптера с общим интерфейсом: `buffer.py` (GraphQL), `instagram.py`, `youtube_up.py` (расширение `youtube_api.py`: скоуп и загрузка).
- Плюс `server/publish/r2.py`: S3 PUT с подписью SigV4 на stdlib, удаление после публикации.
- Плюс собственный планировщик в `auto_tick()` для Instagram (и для YouTube, если не через `publishAt`).
- Секреты в `secrets.json`: `buffer`, `instagram` (токен + срок), `r2` (account id, ключ, бакет, публичный домен).

**Что сделать руками:**
1. **Buffer.** Зарегистрироваться (Free), подключить TikTok (+ YouTube), выключить «Enable Notifications by default», создать API-ключ.
2. **Cloudflare.** Создать аккаунт и бакет R2, включить публичный доступ (`r2.dev` или свой домен), выпустить S3-ключ на этот бакет.
3. **Meta.**
   - Instagram перевести в Creator или Business.
   - На developers.facebook.com создать приложение типа Business, продукт «Instagram API with Instagram Login».
   - Добавить себя в Instagram Testers и принять приглашение в Instagram.
   - Нажать «Generate token».
4. **Google.**
   - В нашем Google-проекте перевести OAuth consent screen в «In production».
   - Сделать страницу политики конфиденциальности (помогу, GitHub Pages).
   - Подать [форму аудита](https://support.google.com/youtube/contact/yt_api_form).

**Новые открытые вопросы:**
1. До аудита Google: YouTube Shorts через Buffer или пока выкладывать руками?
2. Instagram по расписанию требует, чтобы в момент публикации Studio была запущена. Ок? Альтернатива — Instagram тоже через Buffer (это займёт третий канал Free).
3. Устраивает, что в TikTok через Buffer нельзя выбрать приватность, duet, stitch и комментарии — будут настройки аккаунта по умолчанию?
