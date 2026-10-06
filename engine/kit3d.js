// Набор готовых деталей канала — 3D (world3d, stage3d.js). Растёт от ролика к ролику: быстрый монтаж копирует его в src/kit3d.js проекта,
// удачное переиспользуемое (место-диорама, предмет, движение героя, пресет камеры) Claude переносит сюда функцией + строкой в _studio/KIT.md.
// Правила: функция строит деталь в переданном мире w и возвращает объект/группу: kitXxx(w, { pos, rotY, scale, ... }) ; движение — kitMoveXxx(obj, lt, o);
// без глобального состояния; над функцией — комментарий: что это, параметры, где впервые.
'use strict';

// kitMoveCardWalk(c, lt, t0, t1, from[x,z], to[x,z], {ease, stride, idle}) — бумажный герой-карточка (artCard с c.pose / c.inner) идёт из точки в точку:
// позиция по x/z, фаза шага в c.pose.walk, поза 'walk' на ходу и idle после, лёгкое подпрыгивание c.inner. Вернёт true, пока идёт.
// Звать каждый кадр в update. Нужны E.io, clamp, lerp (stage3d / lib). Впервые — «Какого это работать в Valve» (heroWalk).
function kitMoveCardWalk(c, lt, t0, t1, from, to, o = {}) {
  const k = (o.ease || E.io)(clamp((lt - t0) / Math.max(0.01, t1 - t0)));
  c.position.x = lerp(from[0], to[0], k); c.position.z = lerp(from[1], to[1], k);
  const moving = lt > t0 && lt < t1;
  c.pose.walk = moving ? Math.hypot(to[0] - from[0], to[1] - from[1]) * k * (o.stride || 9) : undefined;
  if (moving) c.pose.pose = 'walk'; else if (c.pose.pose === 'walk' || o.idle) c.pose.pose = o.idle || 'idle';
  if (c.inner) c.inner.position.y = moving ? Math.abs(Math.sin(c.pose.walk)) * 0.025 : 0;
  return moving;
}

// ---- S21 «Сторож монтажа» (docs/studio/stage21-guard.md) --------------------------------------------------------------
// Пометки для сторожа (stands/guard.js читает их; в ролике ничего не делают):
//   w.touch('Ёжик', 'Стул') — касание задумано (сидит, держит, обнимает); w.touch('Ёжик') — с чем угодно;
//   w.guard('Учёный', { pop: false }) — рывок задуман (подмена под упавшим автоматом), { stuck: false } — пересечения не проверять.
if (typeof W3API !== 'undefined') {
  if (!W3API.touch) W3API.touch = function (a, b) { (this._touch = this._touch || []).push([a, b || '*']); return this; };
  if (!W3API.guard) W3API.guard = function (name, o) { (this._gOff = this._gOff || {})[name] = Object.assign(this._gOff[name] || {}, o); return this; };
}

// life3(obj, lt, { in, out, enter, exit, dIn, dOut, at, from, to }) — объект появляется и уходит БЕЗ рывка (вместо obj.visible = …). Звать каждый кадр в update,
// ДО hop3 / gait3 / flip3 (life3 сам выставляет obj.inner: scale, rotation.x, position.y — чистая функция времени). Вернёт 0..1 «насколько в кадре».
//   in / out — время сцены (lt) входа и начала ухода (нет — объект уже в кадре / не уходит).
//   enter / exit: 'popUp' (бумажная раскладушка: встаёт из плоскости / ложится) | 'pop' (масштаб с отскоком / сжатие) | 'drop' (падает сверху / улетает вверх)
//                 | 'slide' (въезжает / уезжает: at [x,y,z] — где стоит, from / to [dx,dy,dz] — откуда / куда, по умолчанию из-за левого / за правый край на 3 м)
//                 | 'cut' (жёстко — ТОЛЬКО на склейке камеры: сторож иначе поймает рывок).
//   По умолчанию по типу: персонаж (hogCard, artCard, charCard) — 'popUp', предмет — 'pop'. dIn 0.4 с, dOut 0.35 с.
// enter3(obj, lt, t, move) / exit3(obj, lt, t, move) — то же для одного конца. Впервые — S21.
function life3(c, lt, o = {}) {
  const inn = c.inner || c, ch = c.hog !== undefined || !!c.pose || !!c.cardInfo;
  const mi = o.enter || (ch ? 'popUp' : 'pop'), mo = o.exit || (ch ? 'popUp' : 'pop');
  const di = o.dIn || 0.4, dd = o.dOut || 0.35, tin = o.in == null ? -1e9 : o.in, tout = o.out == null ? 1e9 : o.out;
  const on = lt >= tin && lt < tout + (mo === 'cut' ? 0 : dd);
  c.visible = on;
  inn.rotation.x = 0; inn.position.y = 0; inn.scale.setScalar(1);
  if (o.at && (mi === 'slide' || mo === 'slide')) c.position.set(o.at[0], o.at[1], o.at[2]);
  if (!on) { inn.scale.setScalar(0.0001); return 0; }
  const pi = mi === 'cut' ? 1 : clamp((lt - tin) / di), po = mo === 'cut' ? 0 : clamp((lt - tout) / dd);
  let k = 1;
  if (pi < 1) {
    if (mi === 'popUp') inn.rotation.x = -Math.PI / 2 * (1 - E.outBack(pi));
    else if (mi === 'pop') inn.scale.setScalar(Math.max(0.0001, E.outBackBig(pi)));
    else if (mi === 'drop') inn.position.y = 1.4 * (1 - E.outBack(pi));
    else if (mi === 'slide') { const f = o.from || [-3, 0, 0], q = 1 - E.outC(pi); c.position.x += f[0] * q; c.position.y += f[1] * q; c.position.z += f[2] * q; }
    k = pi;
  }
  if (po > 0) {
    if (mo === 'popUp') inn.rotation.x = -Math.PI / 2 * E.inQ(po);
    else if (mo === 'pop') inn.scale.setScalar(Math.max(0.0001, 1 - E.inC(po)));
    else if (mo === 'drop') inn.position.y = 2 * E.inC(po);
    else if (mo === 'slide') { const t = o.to || [3, 0, 0], q = E.inC(po); c.position.x += t[0] * q; c.position.y += t[1] * q; c.position.z += t[2] * q; }
    k = Math.min(k, 1 - po);
  }
  return k;
}
function enter3(c, lt, t, move, o = {}) { return life3(c, lt, Object.assign({ in: t, enter: move }, o)); }
function exit3(c, lt, t, move, o = {}) { return life3(c, lt, Object.assign({ out: t, exit: move }, o)); }
