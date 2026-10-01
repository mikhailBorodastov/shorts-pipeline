# S2. Claude Studio: каркас и переезд — ТЗ реализации

Цель и критерии — [roadmap.md § S2](roadmap.md#s2-claude-studio-каркас-и-переезд). Здесь — решения, которых не было в спеке (приняты с автором 30.09.2026).

## 1. Раскладка после переезда

```
D:\work\Animations\
  _studio\            бывший _pipeline (git, та же история). _pipeline — связка (junction) на _studio на переходный период
    server\           бывший ideas\*.py: ideas_server.py (ядро), ideas_api.py, scene_api.py, ideas_claude.py, preprod.py, sounds.py, assets.py,
                      refvideo.py, paths.py (все пути — только отсюда), studio.py (вход: окно-сервер и CLI)
    web\              бывший ideas\web (без render\) + editor\
    stands\           page.html, stand3d.html, paper.js, render_shot.js, render_clip.js, scene_diff.py, package.json + node_modules (puppeteer)
    engine\           stage3d.js, scene.js, moves3d.js, lib.js, scene.schema.json, vendor\, test\ — один движок; new_project копирует его в src ролика
    template\         шаблон ролика без файлов движка
    app\              окно Tauri (§5)
    docs\ tools\ prompts\ sfx_library\ animalese_cache\  как было
  _archive\           только чтение: ideas\ (банк, лист проекта, статистика, старые штурмы, токен YouTube), папки _test_*, PS6_Dima, PS6_Dima_live
  .studio\            состояние приложения (вне git): .port, .lock, .jobs\, state.json (текущий канал), токены (sketchfab_token.txt)
  Доедать будешь\     канал: channel.json, style\, library\, videos\, index.md (обзор для Claude), свой git
```

## 2. Видео = папка ролика + бывший штурм

- `videos\<Имя>\video.json` — бывший план штурма пути «Есть идея» (без удалённых полей, architecture §3.2). **id видео = id штурма** (`260930-08d8`); у новых — такой же формат.
- Пути внутри документа не меняются: `files/<id>/N.png`, `render/<id>/<el>/v<N>` (черновики, `work/` сцен редактора). Сервер разрешает их через `paths`:
  `files/<id>/…` → `<видео>\files\…`, `render/<id>/…` → `<видео>\preprod\…`. URL `/files/<id>/…` и `/rscene/<id>/…` — как раньше.
  Поэтому страницы, промпты и уже записанные ссылки работают без переписывания.
- Ключ документа в API остаётся `plan:<id>` (внутреннее имя), в интерфейсе — «видео».
- Проект ролика (build.sh, src, script.md…) — в той же папке. У нового видео до этапа «Сценарий» только `video.json`, `files\`, `preprod\`, `refs\`;
  шаблон ролика докладывается кнопкой «🚀 начать производство» (бывшее «В работу», `new_project.py` в папку видео).
- Скрипты ролика ищут `_studio` (или `_pipeline`) вверх по папкам (`audio.py`, `review_api.py`), а не только рядом — переезд их переписывает.

## 3. Что уходит в архив

Банк идей, лист проекта, статистика и YouTube, итоги, старый путь «Штурм идей», биты, смыслы, 7 вопросов, жанр — из интерфейса и промптов.
Данные — в `_archive\ideas` (ничего не удаляется). Штурмы старого пути → архив; «Про Дэйва» → в видео «Про лыжника»; «Ностальгия» → новое видео-черновик;
пустой «Новый шортс» → архив.

## 4. Переезд — `tools/migrate_v2.py`

`--dry-run` печатает каждый шаг «что → куда»; без него — выполняет и пишет журнал `_archive/migrate_v2.log.json` (для отката: `--undo`).
Перед запуском «Штурм» должен быть закрыт (папки заняты). После — проверка: `snap` одного кадра каждого ролика, `studio.py` открывается.

## 5. Окно — `app/` (Tauri 2)

Автор выбрал Tauri: `.exe` ~10 МБ, окно рисует WebView2 (встроен в Windows 10/11, тот же движок, что Edge), памяти меньше, чем у Electron.
Rust и VS Build Tools нужны **только для сборки**; тому, кто запускает готовый `.exe`, они не нужны.
- `app/src-tauri/src/main.rs`: ищет `_studio` вверх от exe (или `STUDIO_DIR`), проверяет `/api/version` на 8790–8799 (та же рабочая папка — как `probe()` в `ideas_server.py`);
  если приложение не запущено — поднимает `python server/studio.py` без консоли (вывод — `.studio/app.log`), ждёт ответа и переводит окно на `http://localhost:<порт>/`.
  Пока ждёт — заставка `app/dist/index.html`, не запустилось — хвост лога на ней же. Закрыли последнее окно — скрипт останавливается (если его поднимало окно; чужой, из `.bat`, не трогает).
- Ссылки: чужие сайты — в обычном браузере; локальные `target=_blank` (клип, стенд, страница ролика «отдельным окном») — новым окном приложения. Заголовок окна — из страницы.
- Сборка: `cd _studio/app && npm install && npx tauri build` (иконка — `python make_icon.py && npx tauri icon icon.png -o src-tauri/icons`);
  `app/build.bat` делает то же и копирует готовый `claude-studio.exe` в `app/Claude Studio.exe` (8 МБ), ярлыки «Claude Studio» — на рабочем столе и в рабочей папке. `Claude Studio.bat` остаётся запасным входом (обычный браузер).
  `build.bat` собирает только exe (`tauri build --no-bundle`).

### 5.1 Установщик для друзей — `app/build_setup.bat` → `app/Claude Studio Setup.exe`
Решение автора: setup.exe (NSIS) и **только программа + демо-канал** — без каналов автора, ёжика, ключей и его стайл-гайда.
- **Что внутри:** окно (exe) + код `_studio` в `<папка программы>\_studio`. Код собирает `app/stage_bundle.py` в `app/bundle/_studio` (в git не лежит): только файлы репозитория
  (`git ls-files -co --exclude-standard`, ~8 МБ) — `tools/blender`, `sfx_library`, `node_modules`, кэши и сам `app/` не попадают. Tauri кладёт их ресурсами (`tauri.conf.json → bundle.resources`).
  Ставится «для пользователя» (`nsis.installMode: currentUser`, `%LOCALAPPDATA%\Programs\Claude Studio`, без прав администратора), язык — русский. Первая сборка Tauri сама скачивает NSIS (~5 МБ, GitHub tauri-apps).
- **Установленный режим** (`main.rs → workspace()`): рядом с `_studio` нет `.studio` и каналов → рабочая папка — `Документы\Claude Studio` (или путь из `workspace.txt` рядом с exe — для тестов),
  передаётся скрипту через `STUDIO_ROOT`. В режиме разработки (exe внутри `_studio/app`) всё как раньше: рабочая папка — родитель `_studio`.
- **Первый запуск** (`first_run`): если в рабочей папке нет каналов — копирует `_studio/demo/*` (канал «🤖 Демо-канал»: видео «Знакомьтесь: робот Бип» — герой Бип на скелете частей `robot`
  с 4 лицами и 5 позами + сцена «Комната Бипа», где он машет); пишет свой короткий `CLAUDE.md` (без инструкции автора про ёжика).
- **Мастер зависимостей** (`check_deps` / `setup_page` / `run_setup`): проверяет Python, Python-пакеты (edge-tts, numpy, pillow), Node, модули рендера (`stands/node_modules/puppeteer-core`), ffmpeg, Git, Claude Code.
  Чего-то нет — стартовая страница показывает список и кнопки-ссылки `studio://setup` («Установить недостающее» → `tools/setup_deps.ps1`: winget — Python 3.12, Node LTS, ffmpeg, Git; `pip install --user`;
  `npm install` в `stands`; Claude Code — официальный установщик `claude.ai/install.ps1`), `studio://claude-login` (консоль с `claude` — войти в подписку), `studio://skip`. Вывод установки — строками в окне.
  PATH после winget берётся заново из реестра (`fresh_path`). Blender по-прежнему качается по кнопке, когда понадобится.
- **Проверено:** `Claude Studio Setup.exe` (4,6 МБ) тихо ставится (`/S /D=…`), первый запуск создаёт рабочую папку с демо-каналом, скрипт поднимается со своими данными и не цепляется к запущенной Studio автора, сцена с Бипом рендерится из установленной копии; `uninstall.exe /S` убирает программу, ярлык и запись в реестре (рабочую папку с каналами не трогает).
