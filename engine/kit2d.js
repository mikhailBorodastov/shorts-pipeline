// Набор готовых деталей канала — 2D (бумажная аппликация). Растёт от ролика к ролику: быстрый монтаж (server/fast_api.py) копирует его
// в src/kit2d.js проекта, а удачное переиспользуемое из ролика Claude переносит сюда функцией + строкой в _studio/KIT.md.
// Правила: одна функция — одна деталь (место, предмет, эффект), сигнатура (ctx, x, y, size, o = {}) где можно, время — o.t, без глобального состояния,
// цвета — параметрами с умолчаниями канала; над функцией — комментарий: что рисует, параметры, где впервые.
'use strict';

// kitCutFlash(ctx, lt, times, o) — короткая тёплая вспышка на жёстких склейках. times — секунды сцены; o.d (0.14 с), o.a (0.55), o.color.
// Где впервые: «Про металлические штуки» (Доедать будешь), 2026-10.
function kitCutFlash(ctx, lt, times, o = {}) {
  const d = o.d || 0.14; let a = 0;
  for (const t of times) a = Math.max(a, 1 - Math.abs(lt - t) / d);
  if (a <= 0) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.save(); ctx.globalAlpha = a * (o.a == null ? 0.55 : o.a); ctx.fillStyle = o.color || '#fff8ea'; ctx.fillRect(0, 0, cw, ch); ctx.restore();
}

// kitUnderwater(ctx, k, o) — «звук глохнет, герой выпал из мира»: холодная вуаль + тёмная виньетка. k 0..1; o.tint ('#20345a'), o.cy (0.45 высоты).
// Где впервые: «Про металлические штуки» — гомон двора глохнет, ёжик замер у щитовой.
function kitUnderwater(ctx, k, o = {}) {
  if (k <= 0) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height, cy = ch * (o.cy || 0.45);
  ctx.save();
  ctx.globalAlpha = 0.22 * k; ctx.fillStyle = o.tint || '#20345a'; ctx.fillRect(-50, -50, cw + 100, ch + 100);
  ctx.globalAlpha = 0.5 * k;
  const g = ctx.createRadialGradient(cw / 2, cy, ch * 0.25, cw / 2, cy, ch * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(8,12,30,0.9)'); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
  ctx.restore();
}

// kitWhiteVoid(ctx, T, k, o) — белая пустота из матовой бумаги на весь кадр (свет из проёма, «тот свет»): бумажный фон, мутные силуэты в глубине, зерно.
// k 0..1 — насколько залило; o.shapes (true) — силуэты; o.colors — 4 тона бумаги. Нужен paper.js (paperBG, cut, ellP, rng, noise1, grainPat).
// Где впервые: «Про металлические штуки» — проём подсобки, Друг в белом свете.
function kitWhiteVoid(ctx, T, k, o = {}) {
  if (k <= 0) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height, cols = o.colors || ['#f4f2ec', '#e9e7e1', '#dedcd6', '#f8f7f3'];
  ctx.save(); ctx.globalAlpha = Math.min(1, k);
  paperBG(ctx, 'void', cols, T, 0.6);
  if (o.shapes !== false) {
    const r = rng(77);
    for (let i = 0; i < 5; i++) {
      const x = cw * (0.12 + r() * 0.76) + noise1(T * 0.2, i) * 40, y = ch * (0.5 + r() * 0.12), s = 220 + r() * 160;
      ctx.globalAlpha = Math.min(1, k) * (0.07 + 0.05 * Math.sin(T * 0.7 + i));
      cut(ctx, inf => ellP(x, y - s * 0.55, s * 0.18 + inf, s * 0.6 + inf, 0, 22), '#8d8f9a', { seed: 400 + i, amp: 8, edge: 0, shadow: false, blur: 30 });
    }
  }
  ctx.globalAlpha = Math.min(1, k) * 0.35; ctx.fillStyle = grainPat(ctx); ctx.fillRect(0, 0, cw, ch);
  ctx.restore();
}
