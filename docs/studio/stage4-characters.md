# S4. Персонажи и скелеты — ТЗ реализации

Цель ([roadmap](roadmap.md#s4-персонажи-и-скелеты), формат — [architecture §3.6](architecture.md#36-скелет-риг-анимации)): персонаж — не картинка, а **скелет + риг + костюмы + эмоции** в библиотеке канала.
Анимации по типу скелета, клипы, IK — S5; здесь — поза костей и лицо, которые S5 будет анимировать.

**Готово, когда:** в «Комнате» ёжик в пижаме — персонаж библиотеки со скелетом `hog` (пижама — костюм); новый персонаж — **бумажный кот** (решение автора вместо мамы:
проверяет новый тип скелета) — получает предложенный скелет, автор двигает сустав, проверяет позами, утверждает; у ёжика надета и снята кепка; в сцене ёжик доворачивается к облетающей камере.

## 1. Решение по рендеру (уточнение architecture §3.6)

Оба рига рисуют персонажа **в 2D-холст** (`engine/rig.js`): `rigDraw(ctx, char, pose, x, yНог, рост)`. В 3D он живёт на бумажной карточке (`charCard` — как `hogCard`),
в 2D-роликах рисуется прямо в кадр. Так бумажный вид (рваная кромка, зерно, тени) остаётся одним и тем же в стенде, редакторе, 2D- и 3D-роликах.
`SkinnedMesh` из архитектуры не нужен: сгибание частей (`bend`) — сетка треугольников с аффинной текстурой в canvas, как в рантаймах Spine.

## 2. Данные библиотеки

- **Тип скелета** `library/skeletons/<type>.json` (architecture §3.6): `bones[]` `{id, parent, pos: [x, y] — сустав в «единицах» рисунка (0 — ноги, рост = 1, y вверх), len, limits}`,
  `slots` (точки крепления костюмов: `head`, `handL`, `handR`, `back`, `belt`), `face` (что умеет лицо), `poses` — пять проверочных поз, `map` — только у `param`.
- **Персонаж** `library/characters/<slug>/character.json` + `vN/`: `{ schema: 2, id, name, skeleton, rig: 'param' | 'parts', mode: 'pins' | 'bend', base: {…}, costumes: [slug…],
  emotions: { имя: { eyes, brows, mouth, look, lid… , ok: true } }, versions[], latest }`. Старые записи (`schema: 1`, 2D-лист `element.js`) остаются версиями v1.
- **Костюм** `library/costumes/<slug>/costume.js` + `costume.json` `{ id, name, skeleton, slots: ['body', 'handL'…] }`: слои поверх персонажа (§3.3).
- **Позы** — `{ bones: { armL: { rot, len }, body: { rot, sq }, legL: { rot }… }, face: { eyes, brows, mouth, look: [x, y], lid, blink }, costumes: { head: 'cap' | null }, facing: 'front' | 'back' }`.
  Углы — радианы от позы покоя, `len` — множитель длины.

## 3. Движок — `engine/rig.js`

### 3.1 `param` — ёжик (`drawHog`)
- `skeletons/hog.json`: кости `root, body, head, armL, armR, legL, legR`; `map` кость ↔ параметр: `armL.rot → armL`, `armL.len → lenL`, `body.rot → rot`, `body.sq → sq`,
  `legL.rot / legR.rot` — шаг (подъём лапы) или посадка (ноги вперёд, `sit`), `face.* → look / lid / blink / mouth / brows / tired / wink`.
- `drawHog` дополняется (обратно совместимо): брови `brows: 'up' | 'angry' | 'sad' | 'worried'`, рот `open`, подъём каждой лапы `liftL / liftR`; ножки из `hogCard` переезжают в риг.
- База персонажа — параметры `drawHog` (`kind: 'kid'`, цвета) + ножки. Сидит — поза `sit` (тело ниже, ноги вперёд, как в пижамном ёжике «Комнаты»).

### 3.2 `parts` — нарисованные части (кот)
- Части — PNG с прозрачностью (`vN/parts/<id>.png`) + `parts.json`: `[{ id, bone, pivot: [px, py] в рисунке, z, bend: [кость-родитель, кость] }]`, размер листа рисунка.
- `pins`: каждая часть целиком на своей кости (кукла на булавках, стыки прикрыты перекрытием). `bend`: часть на двух костях — сетка 8×8, веса по расстоянию до сустава, каждый треугольник рисуется
  своей аффинной матрицей (`ctx.setTransform` + `clip`) — часть гнётся в суставе.
- Лицо у `parts`: эмоции — отдельные части-лица (`face/<emotion>.png`) на кости головы, рисует Claude.

### 3.3 Костюмы
- Контракт `costume.js`: `costume({ id, name, layers: { under(ctx, st), body(ctx, st), over(ctx, st), legs(ctx, st) } })` — `st` даёт систему координат тела ёжика (`S` = HOG_PX),
  мировые точки лап `st.paws`, позу. Слоты: `body` (пижама), `head` (кепка — рисуется в системе головы), `handL / handR` (предмет в лапе).
- Пижама «Комнаты» → костюм `pijama-mishki`: `pajamaTop` (слой `body`), рукава по лапам (`over`), штанины при посадке (`legs`) — код из `prefabs.js` сцены, без изменений вида.
- Кепка — костюм `kepka` (слот `head`), надеть / снять — `pose.costumes.head`.

### 3.4 В сцене и в 3D
- `charCard(w, char, o)` — карточка с холстом рига; `c.pose` меняется — перерисовка (как `hogCard`, по состоянию).
- **Paper Mario**: `channel.json → rules: { paperFacing: true, facingMaxDeg: 40 }` — карточка персонажа доворачивается к камере (по оси Y) не больше `facingMaxDeg`;
  спина (`facing: 'back'`) — только по сюжету или когда объект повёрнут от камеры больше чем на 90°.
- Объект сцены с `src.prefab = 'lib:characters/<slug>@N'` — персонаж; его поза — `params.pose` (база) + ключи `pose.<кость>.<rot|len>`, `face.<поле>`, `costume.<слот>` (дорожки S5 ложатся сюда же).
  В «Комнате» префаб `hogPajama` остаётся «поведением» (его tick пока задаёт позу кодом — клипы S5), но рисует персонажа из библиотеки.

## 4. Приложение

- **Лист персонажа** (библиотека → персонаж): превью в позе покоя со скелетом поверх, вкладки **Костюмы** (надеть / снять на превью), **Эмоции** (сетка лиц, ✓ / ✗, «✨ предложить эмоции»),
  **Анимации** (S5), **Версии**; тип скелета и кто ещё его наследует.
- **Новый персонаж со скелетом** (карточка персонажа препродакшена, «🦴 Собрать персонажа»): задача Claude (Opus) `charparts` — рисует персонажа частями
  (тулкит `paper.js`, каждая часть — своя функция и свой PNG), предлагает скелет (`skeleton propose`): похож на ёжика — тип `hog` (тогда `param`, частей не нужно), иначе новый тип.
- **Редактор скелета** (окно поверх карточки): рисунок частями, кости поверх; сустав тянется мышью, список костей (имя, родитель, пределы), «▶ проверить позами» (5 поз типа),
  «✨ поправить промптом» («добавь хвост из 3 костей»), ✓ → библиотека (тип скелета + персонаж). Всё — операциями, с отменой.
- **Эмоции**: «✨ предложить эмоции» — Claude (Sonnet для `param`: наборы параметров; Opus для `parts`: лица частями) — 6 базовых (радость, удивление, грусть, злость, сонный, испуг)
  + по запросу; превью сеткой, автор утверждает ✓ по одной.

## 5. CLI

`studio.py char list | show <slug> | pose <slug> '<поза JSON>' out.png | skeleton <type>` — посмотреть персонажа в позе (рендер через стенд), для Claude и проверок.

## 5а. Как сделано (для реализатора)

- **Движок** `engine/rig.js`: `character()`, `costume()`, `rigPose()`, `rigEmotion()`, `rigDraw()`, `rigHog` (param), `rigParts` (pins / bend, сетка 10×10, веса — обратное расстояние до отрезков костей в покое,
  степень 4), `charCard` (карточка + ключи `pose.* / face.* / wear.* / emotion` + Paper Mario `PAPER_RULES`). `rigHogAim` — угол и длина лапы к точке (для поведения, до IK S5).
  `rigLoadExtras` подгружает `rig.json` (риг частей) и `emotions.json` библиотеки. Персонаж регистрируется и как префаб сцены (`PROPS3D[url]`) — `lib:characters/<slug>@N` грузится как 3D-пропс;
  `scene.libs` — персонажи, нужные коду `prefabs.js` («поведение» ёжика «Комнаты»).
- **Файлы версии**: `prefab.js` (+ `costumes/*.js` у param, `rig.json` у parts: `type, typeName, mode, sheet, foot, height, bones[{id, parent, joint, end, limits}], parts[{id, bone | bones, z, front}],
  slots, face {base, emotions}, emotions, poses`). Углы позы — радианы, «+» — по часовой.
- **Стенды**: `stands/char.html?char=…` (`&pose / &emotion / &wear / &skel=1 / &poses=1 / &emotions=1 / &size`), `stands/skel.html` (редактор скелета), `stands/render_char.js`
  (element.png — позы с костями, rest.png, clean.png, emotions.png). Тест «было / стало» пижамного ёжика — `stands/samples/rig_pajama_test.html` (0 отличающихся пикселей в 21 состоянии);
  проверочный персонаж частей — `stands/samples/testchar/`. `stand3d.html …&orbit=x,y,z,r,a0,a1` — облёт камеры (Paper Mario).
- **Сервер** `server/char_api.py`: библиотека персонажей (`chars`, `add_version`, `skeleton_hog` — скелет ёжика берётся из rig.js), `/api/char`, `/api/chars`, `/api/char/emotion(s)`, `/api/char/rig`,
  задачи `charemotions` (Sonnet), `charrig` (без Claude, новая версия с rig.json); CLI `studio.py char list | show | pose | skeleton | version`. Задача Claude `charparts` (Opus) — `ideas_claude.charparts_spec`,
  публикация — `studio_api.publish_rigged` (персонаж + `skeletons/<type>.json`, если типа ещё нет).
- **Страница**: лист персонажа `web/charsheet.js` (`#/lib/char/<slug>`); карточка персонажа препродакшена — «🖼 лист / 🦴 со скелетом» (`form: 'rig'`), «🦴 Собрать персонажа», «🦴 Редактор скелета»;
  редактор сцены — галочки костюмов и эмоция у персонажа (`panels.js`, `charBox`).

## 6. Порядок работ

1. `rig.js` + `skeletons/hog.json` + доработки `drawHog`; стенд `stands/char.html?char=…&pose=…` (картинка персонажа в позе, скелет поверх); тест — пижамный ёжик
   из рига против `drawHogPajama` (кадры «было / стало» совпадают).
2. Библиотека: персонаж `ejik-v-pijame` v2 (`param`) + костюм пижамы + кепка; лист персонажа в приложении (превью, костюмы, версии).
3. Сцена: `charCard`, персонаж в «Комнате» из библиотеки, кепка вкл / выкл ключом, Paper Mario к облетающей камере.
4. Эмоции ёжика: brows / open в `drawHog`, «✨ предложить эмоции», сетка ✓.
5. Кот: `charparts` (части + предложенный скелет), риг `parts` (pins / bend), редактор скелета, проверочные позы, правка промптом, ✓ → библиотека.
