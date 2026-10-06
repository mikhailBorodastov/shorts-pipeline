# Локальные обложки — FLUX.2 [klein]

Генерация обложек на своей видеокарте, без облака и ключей: промпт + до 3 картинок-референсов, размер, сид, модель 4B / 9B.
Провайдер раздела «Обложки» (§10.4 `stage12-redesign.md`) рядом с Higgsfield и «Claude · кодом».

## Как устроено
- **Сервис** — тот же ComfyUI Studio, что и для локальной 3D (`tools/comfyui`, v0.38, `127.0.0.1:8199`, без окна; поднимает `comfy3d.start(need3d=False)`).
  Свой ComfyUI автора (`D:\Neuro\ComfyUI` 0.3.26) не годится — узлов FLUX.2 в нём нет. Можно указать адрес любого другого ComfyUI ≥ 0.38 в ⚙ Настройках: тогда Studio его не запускает, только шлёт графы.
- **Адаптер** — `server/flux2.py`: `generate_thumbnail(prompt, refs[], size, seed, model, out, title)` → `(PNG, meta)`. Граф собирается кодом по шаблону Comfy-Org
  «Flux.2 Klein Image Edit (Distilled)»: UNETLoader + CLIPLoader(flux2) + VAELoader → CLIPTextEncode / ConditioningZeroOut → каждый референс
  ImageScaleToTotalPixels(1 Мп) → VAEEncode → ReferenceLatent (в позитив и негатив) → EmptyFlux2LatentImage + Flux2Scheduler(4 шага) + euler + CFGGuider(cfg 1) → SamplerCustomAdvanced → VAEDecode.
  Размер — кратный 16 вверх, затем точная обрезка по центру (1920×1080 выходит ровно).
- **Модель в памяти один раз:** ComfyUI кэширует выходы загрузчиков, пока граф тот же; меняются только промпт, сид, размер, картинки.
  Выгружает «⏹ Освободить видеопамять» (⚙ Настройки → Локальная 3D) или лепка TRELLIS, которой нужна вся память.
- **Асинхронно:** `thumbs_api._run_flux` в фоновом потоке, статусы в `thumbs/results.json` (`queued` → `in_progress` + `note` → `completed` {file, seed, secs, size} | `failed` {error}); страница опрашивает доску.
- **Ошибки** (`flux2.FluxError`, текст — прямо в карточку результата): сервис не отвечает по адресу; ComfyUI Studio не установлен; нет весов (и подсказка, чем скачать;
  «файлы есть, но ComfyUI запущен раньше — перезапусти»); 9B выключена; нехватка видеопамяти (`out of memory` в ошибке исполнения); таймаут — задача снимается из очереди / прерывается (`/interrupt`).
- **Надписи:** кириллицу модель пишет с опечатками (см. замеры). Поле «Надпись на обложке» у локальных моделей: картинка генерируется без текста с местом под заголовок
  (слева у широкой, сверху у вертикальной), заголовок накладывается шрифтом Rubik 900 с белой обводкой (`flux2.draw_title`); рядом — `<rid>_raw.png` без надписи.

## Настройки — `.studio/state.json → flux` (⚙ Настройки → «🖼 Локальные обложки»)
| ключ | по умолчанию | что |
|---|---|---|
| `url` | пусто | адрес ComfyUI; пусто — свой ComfyUI Studio. `STUDIO_FLUX_URL` важнее |
| `weights_dir` | пусто | доп. папка с весами → `.studio/comfy_extra_paths.yaml` (`--extra-model-paths-config`, подхватывается при следующем запуске ComfyUI) |
| `model` | `4b` | модель по умолчанию |
| `allow9b` | `false` | 9B в списке моделей доски (FLUX Non-Commercial — не для монетизируемых роликов) |
| `timeout` | 300 | секунд на одну картинку |
| `steps` | 4 | шаги (distilled-модели рассчитаны на 4) |

## Веса (официальные источники; имена — как в docs.comfy.org/tutorials/flux/flux-2-klein)
| группа | файл | откуда | размер | лицензия |
|---|---|---|---|---|
| 4b | `diffusion_models/flux-2-klein-4b-fp8.safetensors` | huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8 | 4,07 ГБ | Apache 2.0 |
| 4b | `text_encoders/qwen_3_4b.safetensors` | huggingface.co/Comfy-Org/flux2-klein-4B (split_files) | 8,04 ГБ | |
| 4b, 9b-te | `vae/flux2-vae.safetensors` | huggingface.co/Comfy-Org/flux2-dev (split_files) | 0,34 ГБ | |
| 9b-te | `text_encoders/qwen_3_8b_fp8mixed.safetensors` | huggingface.co/Comfy-Org/flux2-klein-9B (split_files) | 8,66 ГБ | |
| 9b | `diffusion_models/flux-2-klein-9b-fp8.safetensors` | huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8 — **gated** | ~9 ГБ | FLUX Non-Commercial |

## Запуск и обновление
```
python _studio/tools/comfy_setup.py --flux 4b          # веса 4B (докачка с места обрыва)
python _studio/tools/comfy_setup.py --flux 9b-te 9b    # 9B: сначала принять лицензию на странице модели и `hf auth login`
python _studio/server/flux2.py status                  # что скачано, отвечает ли сервис
python _studio/server/flux2.py gen "промпт" --ref a.png --size 1280x720 --seed 7 --title "ЖМИ КНОПКУ"
python _studio/server/flux2.py bench --model 4b
```
Сервис отдельно запускать не нужно: первая генерация поднимает ComfyUI Studio сама (~30 с). Остановить — «⏹ Освободить видеопамять».
**Обновить модель:** BFL выпустили новые веса → удалить старый файл в `tools/comfyui/ComfyUI_windows_portable/ComfyUI/models/<папка>/`, поправить url/имя в `tools/comfy_setup.py → FLUX`
и `server/flux2.py → MODELS`, скачать `--flux …`, «⏹ Освободить видеопамять». Новый ComfyUI — `comfy_setup.PORTABLE` (проверь, что узлы из графа выше на месте: `python server/comfy3d.py info Flux2Scheduler ReferenceLatent`).

## Замеры (2026-10-03, RTX 4070 Ti SUPER 16 ГБ, ComfyUI 0.38, torch 2.14 cu130, fp8, 4 шага, 1280×720)
Во время замеров ~6 ГБ видеопамяти держали другие программы (Photoshop, Whisper-CUDA, браузеры) — на свободной карте быстрее.
| | 4B | 9B |
|---|---|---|
| холодный старт (запуск ComfyUI + загрузка + картинка) | 32 с | не замерено — веса gated |
| без референсов, модель в памяти | 1,6–2,9 с (медиана 2,9; при простое карты 1,6–1,9) | — |
| 1 референс | 5,1–6,5 с (медиана 6,4) | — |
| 2 референса | 7,4–11,4 с (медиана 10,8) | — |
| 3 референса | 10,6 с | — |
| 1080×1920 без референсов | 7,3 с | — |

Референс — это ещё ~1 Мп латентов в последовательности внимания, поэтому каждый добавляет 3–4 с.

**Кириллица (4B, 5 заголовков × 2 сида):** форма букв правильная, но без ошибок только 3 из 10
(«СТОТВ» вместо «СТОП», «БУДЕШВ», «КОНЕД», «ПУЗЬРЬ»). Для обложки — поле «Надпись» (заголовок шрифтом).
