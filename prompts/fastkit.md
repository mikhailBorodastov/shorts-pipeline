# Fastkit: шпаргалка движка шортов (2D-аппликация + 3D-слой)

Сводка, чтобы писать `src/scenes.js` и 3D-мир без чтения `main.js`, `lib.js`, `paper.js`, `stage3d.js` и `moves3d.js`.
Сигнатуры сверены с исходниками: `_studio/template/src/*`, `_studio/engine/*`, `_studio/stands/paper.js`.
Если чего-то здесь нет, этого нет и в движке. Не выдумывай API, загляни в шапку `stage3d.js` или в `moves3d.js`.

## 1. Как устроен проект

Проект ролика (`new_project.py`): `script.md` → `tts.py` → `src/vo_timing.js` (`VO`) → кадры `render.js` → `build.sh` → `out/*.mp4`.
`src/` после создания: `index.html`, `review.html`, `format.js`, `lib.js`, `chars.js` (СТАРЫЙ круглый ёжик), `paper.js` (бумажный тулкит, скопирован из `stands/`), `stage3d.js`, `moves3d.js`, `vendor/` (three r186, postprocessing, reflector, GLTFLoader), `scenes.js` (твой), `main.js` (движок, не трогать).

**Порядок скриптов** в `index.html` (и так же в `review.html`):
`boot3d.js (module) → vo_timing.js → format.js → lib.js → chars.js → stage3d.js → moves3d.js → scenes.js → main.js`.
**`paper.js` в шаблонном html НЕ подключён.** Добавь `<script src="paper.js"></script>` после `chars.js` и до `stage3d.js`/`scenes.js` в ОБА файла (`index.html` и `review.html`). Оба файла объявляют `function drawHog`, побеждает тот, что загружен позже, поэтому `paper.js` должен идти после `chars.js`. Свои модули (`src/<проект>3d.js`, `shots.js`) подключай после `moves3d.js` и до `main.js`.

**Что делает `main.js` за тебя:**
- грузит `ASSETS` (картинки → `IMG.key`, секвенции → `SEQ.key`, glb → `X3.models`), шрифты (Rubik, Nunito, PressStart, Caveat через paper.js), ждёт three.js и строит все миры `world3d`;
- таймлайн: сцена k = секция голоса k. Границы `B[k] = VO.sections[k].start - 0.2`, `B[last+1] = TOTAL`; если есть монтаж Studio, берётся `SCENE_B`. Глобальные `B`, `TOTAL` есть при отрисовке, но не при разборе scenes.js;
- переходы: окно `transDur` (по умолчанию 0.7 с) с центром на `B[k]`, внутри рисует обе сцены;
- после сцены сам рисует виньетку (`LOOK`), цветокор `lookPost` и **субтитры** (караоке по словам VO). Сам субтитры не рисуй;
- звуки: собирает `sfx(add)` всех сцен плюс вжух на каждом переходе (кроме `trans:'cut'` и `noWhoosh:true`) → `build/sfx.json`;
- обложки: `THUMBNAILS` / `THUMBNAIL` → `node render.js thumb`.

**Что даёшь ты (globals в scenes.js):** `ASSETS`, `SCENES = [S0, S1, …]` (длина = числу секций VO), по желанию `CAPTION_STYLE`, `TRANS_WHOOSH`, `THUMBNAILS`.
Если в проекте есть `src/montage.js` (монтаж Studio), то `scenes.js` СГЕНЕРИРОВАН (`montage gen`), руками его не правь.

```js
const ASSETS = {
  images: { logo: '../assets/img/logo.png' },                         // → IMG.logo (HTMLImageElement или null)
  sequences: { clip: { pattern: '../assets/clip/f%03d.jpg', count: 120, start: 1 } },  // → seqFrame('clip', i)
  models: { chair: '../assets/models/chair.glb' },                    // → w.model('chair', …)
};
const TRANS_WHOOSH = 'lib:whoosh/15-quick-a';   // вжух переходов из библиотеки, пик на склейке (или 'lib:other/multiple-paper-turn')
const CAPTION_STYLE = { size: 70, y: 0.765 };   // ключи: size y maxWords maxChars off font weight color highlight stroke strokeWidth shadow box boxAlpha upper anim('rise'|'none')
```
Субтитры по умолчанию: шортс `{size:70, y:0.765, maxWords:3, maxChars:17}`, 16:9 `{size:58, y:0.86, maxWords:6, maxChars:38}`.

## 2. API сцены

```js
const S3 = {
  name: 'Ставка',              // для ревью
  trans: 'pop',                // как ЭТА сцена ВХОДИТ: iris | push | slide | zoom | zoomOut | wipe | pop | crumple | cut (по умолчанию iris)
  transDur: 0.4,               // длина перехода, с (по умолчанию 0.7)
  zoomAt: [540, 800],          // на ВЫХОДЯЩЕЙ сцене: точка нырка, если следующая сцена с trans:'zoom'
  noWhoosh: true,              // убрать авто-вжух перехода на эту сцену
  draw(ctx, lt, D, T) { … },   // lt — время от начала сцены (в окне перехода бывает <0 или >D), D — длина, T — абсолютное время
  sfx(add, t0, t1) { … },      // t0 = B[k], t1 = B[k+1]
};
```
- Переходы: любимые — `pop` (склейка со вспышкой, `transDur 0.4`), `slide`, `zoom`, `push`, `iris`. `crumple` (комок бумаги) ставь редко. Внутри одного блока склеивай без шва. Кривые и диагональные переходы пользователю не нравятся, `wipe` тоже лучше не брать.
- **Синхрон с голосом:** `WT(i, 'слово')` возвращает абсолютное время слова секции i. `WT(i, n)` — n-е слово, `WT(i, 'слово', 'end')` — его конец. Сравнивай с `T`. В 3D `camKeys` ждёт `lt`, переводи так: `WT(k,'x') - B[k]`.
- **Грабля WT:** берётся ПЕРВОЕ слово, где встречается подстрока (`'кот'` найдёт «котов»). Бери уникальные куски. Ненайденное слово даёт начало секции и `console.warn`.
- **Звук:** `add(t, name, gain = 1, align)`. `name`: `'pop'|'whoosh'|'boing'|'thud'|'blip'|'tick'|'click'|'chime'|'crash'|'zap'|'thunder'|'shimmer'|'impact'|'rumble'` или `'lib:<id>'` (каталог `_studio/sfx_library/index.md`, поиск `python _studio/sfx_library.py find <слово>`) или срез `'lib:<id>|<смещение>|<длина>'`. `align='peak'` ставит пик звука на `t` (удары, вжухи). Свой файл — `'file:assets/x.wav'`. Звуки длиннее 3 с ставь только срезом. Не больше 2–3 звуков в секунду, общий фон тихий (gain 0.3–0.6). Райзер ставь так, чтобы пик пришёлся на смену сцены. Мемы (`meme/*`) — только если пользователь просил.
- **Пауза в кадре:** `[пауза 1.5]` пиши прямо в строке VO в script.md (tts.py вставит тишину после слова). Отдельную секцию ради паузы не заводи. Перед финалом тишины не делай, обрезай сразу после последнего слова.
- Всё должно быть **чистой функцией времени** (рендер идёт кусками в нескольких браузерах, кадры в любом порядке). Состояние между кадрами не копи; случайность бери из `rng(seed)` или `noise1`.

## 3. Хелперы lib.js (глобальные)

| Сигнатура | Что делает |
|---|---|
| `W, H, WIDE, TAU` | размер кадра (1080×1920 или 1920×1080 из `format.js`), `WIDE = W > H`, 2π |
| `clamp(v, a=0, b=1)`, `lerp(a,b,t)`, `remap(t,a,b)` | remap даёт 0..1 с clamp |
| `E.lin/inQ/outQ/io/inC/outC/outExpo/inExpo/outBack/outBackBig/outElastic` | изинги |
| `P(t, a, d, e=E.io)` | прогресс t в окне [a, a+d] с изингом. Основной инструмент анимации |
| `env(t, a, b, fin=0.3, fout=0.3)` | огибающая «появился, держится, ушёл» 0..1: для плавного входа и выхода |
| `rng(seed)` → `()=>0..1`, `noise1(x, seed=0)` → -1..1 | детерминированный рандом и гладкий шум |
| `C.{night,blue,cyan,purple,magenta,yellow,gold,orange,red,green,white,ink,pill…}` | старая неоновая палитра (для бумаги бери `PAL`/`RED,CREAM,INK,YEL,GRN,BLU` из paper.js) |
| `rr(ctx,x,y,w,h,r)` | путь скруглённого прямоугольника (без заливки) |
| `circle(ctx,x,y,r,fill?)`, `ellipse(ctx,x,y,rx,ry,rot,fill?)`, `poly(ctx,pts,fill?,close=true)` | фигуры (fill — сразу залить) |
| `glow(ctx,color,blur)` / `noGlow(ctx)` | тень-свечение вкл/выкл |
| `vgrad(ctx,y0,y1,[c…])`, `radial(ctx,x,y,r0,r1,[[0,c],[1,c]])` | градиенты |
| `softGlow(ctx,x,y,r,color,a=1)` | мягкое радиальное пятно |
| `withAlpha('#hex',a)`, `mix('#a','#b',t)` | цвета |
| `FONT`, `font(size, weight=800)` | Rubik/Nunito: `ctx.font = font(90, 900)` |
| `pill(ctx,x,y,text,{size,bg,color,glow,border,scale,a})` | плашка-таблетка (старый стиль; для бумаги — `label`) |
| `titleText(ctx,text,x,y,size,{outline,color,glow})` | жирный текст с толстой обводкой, `\n` — строки |
| `stars(ctx,t,seed,n,{drift,par,a,scale})`, `rays(ctx,x,y,n,len,rot,color,a,widthFrac)` | звёзды, лучи |
| `vignette(ctx,a)` | виньетка (main.js кладёт её сам) |
| `starShape(ctx,x,y,R,r,fill,rot)`, `lightning(ctx,x0,y0,x1,y1,seed,color,width,jag)` | звезда, молния |
| `hills(ctx,y,amp,color,seed,off)` | холмы шире кадра (−900…W+900) |
| `seqFrame(key,i)`, `screenSeq(ctx,key,x,y,w,h,lt,fps=15,scan=true)` | кадр секвенции (по кругу) и клип в прямоугольнике с развёрткой, pixel-crisp |
| `imgFit(ctx,im,cx,cy,w,h)` | вписать картинку по центру |
| `WT(i,key,which)`, `secOf(i)`, `VO.sections[i] = {start, words:[{w,t,d}]}`, `VO.total` | тайминги голоса |
| `LOOKV(path, def)` | ручки визуала канала (`paper.grain`, `post.vignette`, `fx.bloom.k`…) |

## 4. Бумажный тулкит paper.js

Шрифт от руки: `HAND`, `hand(size, w=700)` (Caveat). Палитры: `PAL` (paper, fog1-3, ink, grey1-4, warm, cool, gridBlue, pen, red, green), `RED='#c8202b' CREAM INK='#1d1b22' YEL='#ffd23f' GRN BLU`, `DESK` (grid, kraft, white, night, red, matrix).

**Вырезки и фоны**
- `torn(pts, seed, amp=4, step=12)` → рваный контур из многоугольника. `rectP(x,y,w,h,inf)`, `ellP(cx,cy,rx,ry,inf,n=40)` дают точки, `path(ctx,pts)` строит путь.
- `cut(ctx, inf => pts, fill, {seed, amp=3.5, step, edge=5, edgeColor, shadow, blur, grain, grainA, noEdge})` — бумажная вырезка: тень, белая рваная кромка, тело, зерно. Форма — функция от раздутия `inf`. Возвращает контур тела.
- `cutRect(ctx,x,y,w,h,fill,o)`, `cutEll(ctx,cx,cy,rx,ry,fill,o)` — то же для прямоугольника и эллипса.
- `grainPat(ctx)` (паттерн зерна), `grainOver(ctx,a)` (зерно по текущему пути), `cached(key,w,h,fn)` (офскрин-кэш), `tint(ctx,color,a)` (multiply на весь кадр), `light(ctx,x,y,r,color,a)` (аддитивный свет).
- `desk(ctx, T, kind='grid'|'kraft'|'white'|'night'|'red'|'matrix', {rot, zoom})` — фон-стол шире кадра, всегда чуть дрейфует. Основной фон 2D.
- `paperBG(ctx, key, [base, …sheets], t, drift)` — рваные листы тумана (PS6). `grassBand(ctx, y, key, cols, t, h)` — бумажная трава.
- `hypno(ctx, cx, cy, T, {c1, c2, gap, speed, sx, sy, a})` — гипно-волны на весь кадр. `flakes(ctx,T,seed,n,col,{speed,drift,size,wind,a})` — падающие хлопья.

**Надписи, фото, стикеры**
- `handText(ctx,text,x,y,size,color=PAL.pen,{align,w,maxW,maxH})` — текст от руки.
- `note(ctx,x,y,w,h,rot,text,{scale,a,bg,grid,cell,tape,size,color,ty,seed,extra})` — тетрадный листок со скотчем, центр в (x,y).
- `label(ctx,x,y,text,{size=72,bg,color=INK,rot,scale,a,edge=0,seed})` — бумажная плашка с жирным текстом (заголовки, цены, цифры). При `scale≤0` не рисуется.
- `srcTag(ctx,x,y,text,a)` — маленькая плашка источника («ПО ДАННЫМ СМИ»).
- `scrawl(ctx,text,x,y,size,T,t0,{dur=0.45,rot,color=YEL,stroke,a})` — жёлтый маркер, проявляется слева направо с t0.
- `stackWords(ctx,[строки],x,y,size,T,[время каждой],{colors,outline})` — крупные слова влетают по очереди.
- `photo(ctx,im,cx,cy,w,h,rot,{scale,cover,zoom,ox,oy,tint,edge=10,seed,shape})` — фото, вклеенное рваной вырезкой с белой кромкой.
- `sticker(ctx,im,cx,cy,w,rot,s,{key})` — PNG с прозрачностью как стикер с белой обводкой (логотипы).
- `polaroid(ctx,key,cx,cy,w,rot,lt,{ar,cap,pin,pinCol,scale,a,seed,zoom,ox,oy,drawIn})` — полароид: key секвенции (живой клип), картинки или своя отрисовка.
- `pin(ctx,x,y,col,s)`, `thread(ctx,x0,y0,x1,y1,p,col)`, `stamp(ctx,x,y,text,col,s,rot,size)`, `HEART(ctx,x,y,s,col)`, `countNum(v)` («1 234 567»).

**Анимация 2D**
- `slam(T, t0, d=0.28, from=1.7)` → масштаб: влетает крупно и садится с отскоком, до t0 даёт 0. Передавай в `scale` плашек.
- `popIn(T, t0, d=0.35)` → 0..1 с перелётом (outBackBig).
- `shake(ctx, T, t0, amp=14, d=0.35)` — трясти (вызывать внутри `save/restore`).
- `camAt(ctx, fx, fy, s)` — «камера»: масштаб s вокруг точки. Используй для медленного наезда.
- `blinkAt(T, seed)` → моргание 0..1 (каждые ~3.7 с).

**Ёжик** — `drawHog(ctx, x, yНог, рост, o)` → `{L:[x,y], R:[x,y]}` (мировые координаты лапок).
`o`:
- `kind`: `'adult'` (тёмный, по умолчанию) | `'kid'` (светлее, глаза больше, без века) | `'friend'` (коричневатый);
- `t` (дыхание, передавай `T`), `ph` (фаза дыхания), `sq` (сплющивание 0..0.2), `rot`;
- глаза: `look:[x,y]` (−1..1), `blink` 0..1 (`blinkAt(T, seed)`), `wink` (левый), `lid` (веко, по умолчанию 0.28 у adult, 0 — испуг), `tired` (мешки под глазами);
- `mouth`: `'o'` (по умолчанию) | `'smile'` | `'open'` | `'sad'` | `'flat'` (любое другое значение тоже рисует прямую);
- `brows`: `'up'|'angry'|'sad'|'worried'|'none'`;
- лапы: `armL/armR` (рад; 0 — вниз, + — внутрь и вверх, − — наружу; 0.15 по умолчанию; ~2.3–2.95 — вверх над головой, −2.4 — «испуг», в стороны), `lenL/lenR` (множитель длины, 1.3–1.9 — длинные), `liftL/liftR` (0..1, поднять ногу), `walk` (фаза шага, ноги по очереди);
- одежда и аксессуары: `hoodie:'#цвет'`, `cap:'#цвет'` + `capBack`, `glasses: true|'#цвет'`, `phones:'#цвет'`, `beard:'#цвет'`, `badge:'L5'`;
- `prop: (ctx, S) => {…}` — свой рисунок в системе ёжика (S = 520 — внутренний размер; голова около y = −0.62·S, лапы на уровне y ≈ −0.46·S, ноги — y = 0);
- `backView: true` — спина из иголок без лица (для `turnHog3`).
- `aim(x, y, рост, side, tx, ty, kind)` → `{ang, len}`: side −1 левая / +1 правая лапа, тянется к точке (tx,ty). Дальше `armR: a.ang, lenR: a.len`.
- Внимание: в `stands/paper.js` НЕТ `fedora()`. `hogCard` с `hog.fedora:true` упадёт. Шляпу бери из `Не жми эту кнопку…/src/paper.js`.

## 5. 3D (stage3d.js): Paper Mario + Octopath

Бери 3D, только если пользователь просит 3D, диораму или «как Paper Mario / Octopath». По умолчанию ролик 2D.
Единицы — метры, y вверх, камера смотрит вдоль −z, карточки стоят на нижней кромке (опора в ногах). THREE появляется асинхронно: **`THREE.*` трогай только внутри `build`/`update`**, не на верхнем уровне scenes.js. `world3d(...)` объявляй на верхнем уровне (до `stage3dInit`).

```js
const WK = world3d({
  fx: { preset: 'dusk', dof: { range: 1.8, bokeh: 2.6 } },   // 'night'|'dusk'|'day' или {preset, bloom, dof, tilt, grade, vignette, ca, tone, msaa}
  bg: '#1a1530', fog: ['#2a2350', 10, 40], fov: 30,          // фон, туман [цвет, near, far], fov по умолчанию
  build(w) { /* создаём объекты один раз, сохраняем в w.xxx */ },
  update(w, lt, D, T) { /* каждый кадр: камера, позы, появления */ },
});
// в сцене: draw(ctx, lt, D, T) { WK.draw(ctx, lt, D, T); /* 2D поверх: плашки, scrawl */ }
```

**Объекты мира** (все `pos:[x,y,z]`, `rotY`, `name` — для расстановки автора; вернувшийся Group имеет `.inner` — его крути, плющи и переворачивай):
- `w.card({px:[cw,ch], h, draw(g,cw,ch,lt,T), dynamic, state(lt,T)→строка, foot, rim, rimColor, thick=0.015, back:'mirror'|'#цвет', pixel, glow, unlit, fog, shadow, receive, alphaTest, key, scale, noItem, pos, rotY, name})` — бумажная карточка из 2D-рисунка. `key` — общая текстура для одинаковых; `dynamic` перерисовывает каждый кадр, если нет `state` (с ним — только при смене строки). Свойства: `.inner .front .canvas .wW .hW .footW .redraw(lt,T)`.
- `w.plane({size:[w,h], draw(g,cw,ch) | color, ppm=96, flat, unlit, repeat, pos, rotY, key, name, intensity, transparent, alpha, cast})` — пол (`flat:true`), задник, небо (`unlit:true`).
- `w.box({size:[w,h,d], color, faces:{front,back,left,right,top,bottom: '#цвет' | draw}, glow:{front: draw(g,cw,ch,lt)}, glowI=2, dynamicGlow, ppm, key, pos, rotY, name})` — картонная коробка, опора внизу по центру. Светящиеся окна делай через `glow`.
- `w.model(key, {h=1 | w, pos, rotY, name, matte, color, anim, speed, shadow})` — glTF из `ASSETS.models`, встаёт на пол. `matte:true` делает модель бумажной. Свойства `.inner`, `.size`.
- `w.add(obj3d, pos, 'Имя')` — любой THREE-объект или группа как один элемент расстановки. `w.tick(fn(lt,T))` — колбэк каждый кадр.
- Свет: `w.ambient(sky, ground, i=0.6)` (hemisphere), `w.sun({color, intensity=2, dir=[-4,8,5], at, area=12, soft=4, res, shadow})`, `w.lamp({pos, color, intensity=12, dist=9, decay, halo=1.6, haloI, bulb, bulbI, flicker, shadow, name})` → `{light, halo, bulb, set(k)}` (`set(0)` гасит).
- Воздух: `w.motes({n, box:[x0,y0,z0,x1,y1,z1], color, size, vel, wobble, twinkle, intensity, alpha, seed})` (пыль, светлячки, снег), `w.shaft({top, len, r0, r1, color, opacity, tilt:[rx,rz]})` (луч света), `w.glow(pos, size, color, intensity)` (ореол-спрайт).
- Зеркало: `new Reflector(new THREE.PlaneGeometry(w,h), {color, textureWidth, textureHeight, clipBias, multisample})`.

**Камера и эффекты**
- `w.camKeys(lt, [[t, [камера], [цель], fov?], …], {ease=E.io, handheld=0.04})` — ключи во ВРЕМЕНИ СЦЕНЫ (lt). Можно задавать напрямую: `w.cam.position.set(...)`, `w.target.set(...)`, `w.cam.fov`.
- `w.shake(lt, t0, amp=0.08, d=0.35)` — тряска (вызывать после camKeys). `w.focus = new THREE.Vector3(...)` или `obj.position` — куда фокус DoF (по умолчанию цель камеры).
- На лету: `w.bloom.intensity`, `w.dof.bokehScale`, `w.fxCfg` (исходные значения). `w.bloom`/`w.dof` = null, если в fx их нет.
- Ширина кадра 9:16 на расстоянии d: ≈ 0.30·d при fov 30, ≈ 0.34·d при fov 34. Герой и предметы должны влезать по ширине: группы ставь сеткой, камеру поднимай.

**Герои**
- `hogCard(w, {pos, h=1.05, kind, name='ёжик', hog:{…}, back, self=0.32, rim=7, seed, size, cw, ch})` — бумажный ёжик (нужен paper.js), с ножками. Поза — `c.hog = {mouth, look, lid, armL, armR, lenL, lenR, brows, walk, prop, backView, hoodie, cap, glasses, …}`, меняй её в `update`.
- `spriteCard(w, imgKey, {h, pos, rotY, flip, pixel, px=700, rim, self, shadow, thick, name})` — фото или спрайт как карточка; `c.pt(fx, fy)` даёт точку картинки внутри `c.inner` (туда клей шапки и свечения).
- `artCard(w, fn, {pos, h, px, foot, k, pose, dx, glow, fps})` — любая 2D-функция персонажа `fn(ctx, x, yFeet, size, pose)` как карточка; меняй `c.pose`, а `pose.fn` подменяет рисунок.
- `pixelHogCard` НЕ использовать (пользователю не зашёл).

**Движения** (вызывать каждый кадр из `update`; t — в той же шкале, что передаёшь):
| Вызов | Что делает |
|---|---|
| `popUp3(c, t, t0, d=0.45)` | лежит плашмя → встаёт (книжка-раскладушка), до t0 скрыт |
| `pop3(c, t, t0, d=0.35, s=1)` | выскакивает масштабом |
| `flip3(c, p, dir=1)` | переворот на 180° (p 0..1), сзади `back` |
| `turnHog3(h, p)` | ёжик поворачивается спиной, на ребре меняет рисунок на спину из иголок |
| `hop3(c, t, t0, d=0.45, hgt=0.35)` | прыжок со сплющиванием |
| `gait3(c, dist, {stride, bob, sway})` → фаза | покачивание шага, фазу клади в `c.hog.walk` |
| `walkTo3(h, lt, t0, t1, [x,z], [x,z], {ease, stride, bob})` | ёжик идёт из точки в точку, шаг сам |
| `flyTo3(obj, t, t0, d, a, b, {arc, shrink, spin, hideAfter, ease, scale})` | перелёт по дуге |
| `flutterFall3(c, p, from, {fall, drift, side, seed, toward})` | лист падает, кувыркаясь |
| `partyHop3(c, T, i, {rate, height, sway})` | радостные прыжки вразнобой |
| `jumpOff3(c, T, t0, from, {onto, dz})` | запрыгнуть на край и спрыгнуть из кадра |
| `riseFade3(c, p, base, {rise, scale, wobble, seed})` | поднимается и тает (сердечки, Zzz) |
| `attach3(parent, child, fx, fy, {dx, dy, dz, tilt})` | приклеить карточку к точке другой |
| `screenDive3(wide=[pos,target,fov], screen, normal, tIn, tOut, dist, fov)` → ключи | нырок камеры в экран и обратно |
| `dollyZoom3(w, p, at, d0, d1, fov0, dir, camY)` | «Вертиго» (после camKeys) |
| `cascadeLit(order, p, {always, mark})` | окна загораются по очереди |
| `cutSeq3(ctx, T, [[tAbs, world], …], tEnd)` | мини-локации внутри одной секции: жёсткие склейки со вспышкой |
| `mosaic2d(g,fx,fy,fw,fh,blocks)`, `crackGlass2d(g,cx,cy,p,seed,{rays,color,width})`, `crtOverlay2d(g,T,{rec,timecode})` | эффекты для текстур карточек |

Каталог и рецепты: `_studio/ANIMATIONS.md`. Придумал удачное движение — обобщи его в `engine/moves3d.js` и допиши строку в каталог.
**Расстановка автора:** `мир.layout = {'Имя': {p:[dx,dy,dz], r, s, hide}}`, `мир.groups = {'Группа': ['имя', …]}` (из блока `// ==== расстановка автора` в `element.js` препродакшена). Переноси блок как есть, `name` объектов не меняй.
**Грабли 3D:** в GLSL нельзя `pow(0.0, y)` (NaN на D3D, bloom заливает кадр чёрным). Прятать — `visible = false`, а не масштабом 0 (`pop3` и `flutterFall3` уже ставят 0.0001). Ошибки WebGL видны в выводе `render.js snap` (`[pageerror]`). Кадры клипов бывают 480×360, считай кроп по реальному размеру картинки. Рендер 3D идёт максимум в 4 вкладки.

## 6. Раскладка кадра и стиль

**Шортс 1080×1920:** плашка-заголовок y ≈ 170–250; главное действие y 400–1350; зона субтитров y 1400–1540 — пустая; отступ по бокам ≥ 60 px. Фоны, холмы и сетки рисуй шире кадра. На обложке важное держи в y 260–1400 (низ и правый край закрывает интерфейс Shorts).
**16:9 1920×1080 (`WIDE`):** субтитры y ≈ 0.86·H; плашки сверху (y 110–190); действие в центральных 60 % ширины и y 180–860; отступ ≥ 90 px. Используй ширину: две вещи рядом, панорамы. Карточка главы — на первые ~2 с.
Координаты считай от `W`/`H`, а не от 1080/1920, если сцена должна работать в обоих форматах.

**Стиль:** бумажная аппликация. Рваная кромка, зерно, тени; фото и логотипы вклеены вырезками с белой обводкой; надписи — на тетрадных листках и от руки (Caveat); фон всё время слегка движется (`desk`, `paperBG`, `camAt` с наездом). Герой — бумажный ёжик `drawHog` из paper.js; круглого из `chars.js` не брать. Палитру подбирай под историю (тетрадь и крафт, серый туман, нуар).
- Плавно появляется и уходит ВСЁ: `slam`/`popIn`/`P`/`env`, уход — за край кадра или в 0. Жёстких «хлопков» объектов нет.
- Каждой смене мысли — своя локация или свой кадр. Перечисление — отдельные мини-сцены с жёсткими склейками (`cutSeq3` или ветки по `T`).
- Пользователь любит узнаваемую конкретику: реальные логотипы, кадры, спрайты эпохи (вырезками). Абстракции нравятся меньше.
- Плашки и лапки не должны закрывать лица. Лапы растут из боков.
- Пиксель-арт рисуй с `ctx.imageSmoothingEnabled = false`.

## 7. Минимальные рабочие шаблоны

**2D-сцена** (нужен paper.js в html; `IMG.logo` объявлен в `ASSETS`):
```js
const S1 = {
  name: 'Цена выросла',
  trans: 'pop', transDur: 0.4,
  draw(ctx, lt, D, T) {
    const tP = WT(1, 'стоит'), tX = WT(1, 'вдвое');
    desk(ctx, T, 'grid');                                              // фон дрейфует сам
    ctx.save(); camAt(ctx, W / 2, 900, 1 + 0.04 * E.io(remap(lt, 0, D)));   // медленный наезд
    note(ctx, 300, 520, 420, 300, -0.06, 'было\n$200', { scale: popIn(T, tP - 0.3), seed: 3 });
    ctx.save(); shake(ctx, T, tX, 16);
    label(ctx, 760, 560, '$400', { size: 150, bg: RED, color: '#fff', rot: 0.05, scale: slam(T, tX), seed: 9, edge: 6 });
    ctx.restore();
    if (IMG.logo) sticker(ctx, IMG.logo, 770, 880, 260, -0.08, popIn(T, tP));
    const x = 360, y = 1340, hs = 380, shock = T > tX;                  // ноги на y 1340, голова ~ y 940
    const k = E.outBack(remap(T, tP, tP + 0.4)), a = aim(x, y, hs, 1, 640, 900);
    drawHog(ctx, x, y, hs, { t: T, blink: blinkAt(T, 1), look: [0.7, -0.5], lid: shock ? 0 : 0.28,
      mouth: shock ? 'o' : 'flat', brows: shock ? 'up' : 'none', armL: shock ? -2.4 : 0.15,
      armR: lerp(0.15, a.ang, k), lenR: lerp(1, a.len, k) });
    ctx.restore();
    scrawl(ctx, 'вдвое!', W / 2, 1180, 110, T, tX + 0.1);
  },
  sfx(add) {
    add(WT(1, 'стоит') - 0.3, 'pop', 0.5);
    add(WT(1, 'вдвое'), 'lib:hit/05-impact', 0.4, 'peak');
  },
};
```

**3D-сцена с миром** (секция 2; paper.js подключён):
```js
const WK = world3d({
  fx: { preset: 'dusk', dof: { range: 1.8, bokeh: 2.6 } },
  bg: '#1a1530', fog: ['#2a2350', 10, 40],
  build(w) {
    w.ambient('#9aa0e0', '#3a2a24', 0.8);
    w.sun({ color: '#ffd2a0', intensity: 1.6, dir: [-5, 7, 4], at: [0, 0, 0], area: 6 });
    w.plane({ key: 'floor', size: [20, 20], ppm: 48, flat: true, draw: (g, cw, ch) => {
      g.fillStyle = '#c9a57a'; g.fillRect(0, 0, cw, ch); g.globalAlpha = 0.4; g.fillStyle = grainPat(g); g.fillRect(0, 0, cw, ch); } });
    w.plane({ key: 'wall', size: [20, 10], ppm: 32, pos: [0, 5, -4], color: '#3d4a7a' });
    w.hog = hogCard(w, { name: 'Ёжик', pos: [-0.6, 0, 0], h: 0.95, hog: { mouth: 'flat' } });
    w.sign = w.card({ name: 'Табличка', px: [600, 400], h: 0.7, pos: [0.45, 0, -0.4], thick: 0.02,
      draw: (g, cw, ch) => label(g, cw / 2, ch / 2, 'СТОП', { size: 140, bg: RED, color: '#fff' }) });
    w.lampA = w.lamp({ name: 'Лампа', pos: [0.3, 2.2, 0.6], intensity: 10, dist: 6, flicker: 0.2 });
    w.motes({ n: 120, box: [-3, 0.2, -3, 3, 3, 2], color: '#ffe2a8', size: 3, twinkle: 0.5 });
  },
  update(w, lt, D, T) {
    const tS = WT(2, 'стоп') - B[2];                                   // слово → локальное время сцены
    w.camKeys(lt, [[0, [0, 1.6, 7], [0, 0.7, 0], 34], [tS, [-0.2, 1.1, 4], [-0.1, 0.6, 0], 30]]);
    w.focus = w.hog.position;
    walkTo3(w.hog, lt, 0.3, tS - 0.2, [-0.6, 0], [-0.3, 0.2]);
    w.hog.hog.look = lt > tS ? [0.8, -0.2] : [0.6, 0];
    w.hog.hog.mouth = lt > tS ? 'o' : 'flat';
    popUp3(w.sign, lt, tS - 0.25, 0.45);
    turnHog3(w.hog, remap(lt, tS + 0.8, tS + 1.2));                    // вызывать КАЖДЫЙ кадр, remap сам даёт 0 до начала
    w.shake(lt, tS, 0.05);
  },
});
const S2 = {
  name: 'Стоп', trans: 'slide',
  draw(ctx, lt, D, T) {
    WK.draw(ctx, lt, D, T);
    label(ctx, W / 2, 230, 'ВСЁ, СТОП', { size: 84, bg: YEL, color: INK, rot: 0.02, scale: slam(T, WT(2, 'стоп') - 0.05), seed: 16, edge: 7 });
  },
  sfx(add) { add(WT(2, 'стоп') - 0.25, 'lib:other/paper-flip-1', 0.5, 'peak'); },
};
const SCENES = [S0, S1, S2];
```
Мини-локации внутри секции — список задавай функцией, потому что `B` появляется только в main.js:
`const CUTS = () => [[B[3], WA], [WT(3,'подвал') - 0.1, WB]]; draw(ctx, lt, D, T) { cutSeq3(ctx, T, CUTS(), B[4]); }`.
Обложка из 3D-кадра: `{ draw(ctx) { WK.draw(ctx, 1.2, 4, B[2] + 1.2); label(…); } }`.

## 8. Частые ошибки

1. Взят шаблонный пример `drawHog(..., {armF, armB, eye, brows: 0.6})` — это API круглого ёжика из `chars.js`. Правильный — бумажный (`armL/armR`, `y` = ноги, `size` = рост) из paper.js, и paper.js должен быть подключён после chars.js в обоих html.
2. `WT` поймал не то слово (подстрока, первое вхождение). Проверяй уникальность ключа и длительность: событие на последнем слове фразы может провисеть меньше секунды, начинай его раньше по предыдущим словам.
3. Время перепутано: `WT` — абсолютное (сравнивай с `T`), а `camKeys` и `walkTo3` ждут `lt`, переводи через `- B[k]`. Абсолютные секунды в коде ломаются после переозвучки, привязывай всё к словам.
4. Состояние копится между кадрами (`+=`, флаги, `if (lt > t) obj.rotation…` без else). Каждый кадр выставляй всё заново из времени.
5. `THREE.*`, `B`, `TOTAL`, `IMG.x` используются на верхнем уровне файла. THREE есть только внутри `build/update`, `B`/`IMG` — только во время отрисовки.
6. `trans` поставлен на выходящую сцену. Он задаётся на ВХОДЯЩЕЙ, а `zoomAt` — на выходящей.
7. Объект появляется или исчезает рывком, уходит не до конца за кадр. Нужны `slam/popIn/P/env` и выезд за край.
8. Перекрытия: плашки в зоне субтитров (y 1400–1540), лица закрыты лапами или плашками, предметы вылезают за ширину 9:16 в 3D.
9. В составном пути часть фигуры нарисована против часовой стрелки — при заливке nonzero получается дыра. Все подпути веди в одну сторону.
10. Длинный звук (эмбиент, мем-трек на 20 с) без среза тянется через полролика. Ставь `'lib:id|смещение|длина'`.
11. Края фона видны при наезде или тряске: фон рисуй шире кадра (`desk`, `hills` уже рисуют шире).
12. `SCENES.length` не совпадает с числом секций VO. Сцена k = секция k (`## `/сцена с VO в script.md).
13. `hogCard` без paper.js падает, `hog.fedora` без `fedora()` тоже. Пиксельного ёжика не бери.
14. После правок проверяй глазами: `REVIEW_PORT=$(python review_server.py port) node render.js snap 1.5,4,8.2 build/snap.png` → Read. Снимай кадры и внутри окон переходов. Обложки — `node render.js thumb`.

## 9. Препродакшен в коде (быстрый монтаж кладёт его в src/montage.js)
Есть в препродакшене — бери оттуда, не рисуй своё (список «ПРЕПРОДАКШЕН ВИДЕО» в задании):
- `ppWorld(el, { build(w), update(w, lt, D, T), sceneTime })` — 3D-мир из сцены / локации редактора (всё, как расставил автор) + своё поверх: камера `w.camKeys`, герои `ppAdd`.
- `ppShot(el, 'sh1')` → `{pos, target, fov}` — ракурс локации: `w.camKeys(lt, [[0, s.pos, s.target]])`.
- `ppAdd(w, 'el:<id>@vN' | 'lib:…', { pos, rotY, scale, params })` → `{ holder, tick(lt) }` — 3D-пропс / персонаж в любой мир (holder — THREE.Group: двигай `holder.position`).
- `PP2D['<id>'].<функция>(ctx, …)` — 2D-черновик препродакшена (функции и их параметры — в списке задания).
- Свой ассет автора — картинки `IMG.own_<id>_<n>` по состояниям: вклеивать как есть (cut / photo / drawImage, в 3D — spriteCard), не перерисовывать.
- `const ASSETS = { images: Object.assign({ /* свои */ }, PP_IMAGES), sequences: {} };` — иначе картинки препродакшена не загрузятся.
- Своя загрузка `window.STUDIO_READY = async () => {…}` можно — она выполнится ПОСЛЕ загрузки препродакшена.
