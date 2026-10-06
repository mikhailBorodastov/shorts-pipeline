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

// kitPhoneRing(ctx, x, y, size, o) — звонящая телефонная трубка из бумаги: изогнутая ручка, чашки, витой шнур, красные дуги звонка над ней.
// size — ширина трубки (≈600); o.t — время (тряска, пульс дуг), o.ring 0..1 — сила звонка (0 — лежит тихо), o.color ('#1d1d22'), o.wave ('#c8202b').
// Нужен paper.js (cutRect). Где впервые: «Какого это работать в Valve» — родители школьника звонят Гейбу.
function kitPhoneRing(ctx, x, y, size, o = {}) {
  const T = o.t || 0, ring = o.ring == null ? 1 : o.ring, s = size / 600, col = o.color || '#1d1d22';
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(Math.sin(T * 32) * 0.07 * ring - 0.35);
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 12; ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const u = i / 40, px = 230 + u * 120 + Math.sin(u * 60) * 14, py = 60 + u * 260 + Math.cos(u * 60) * 14; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.stroke(); ctx.restore();
  ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(-250, 10); ctx.quadraticCurveTo(0, -110, 250, 10); ctx.lineTo(250, 40); ctx.quadraticCurveTo(0, -60, -250, 40); ctx.closePath(); ctx.fill();
  cutRect(ctx, -300, 0, 150, 110, col, { seed: 52, edge: 5 });
  cutRect(ctx, 150, 0, 150, 110, col, { seed: 53, edge: 5 });
  ctx.restore();
  ctx.save(); ctx.strokeStyle = o.wave || '#c8202b'; ctx.lineCap = 'round'; ctx.lineWidth = 12 * s;
  for (let i = 0; i < 3; i++) { ctx.globalAlpha = ring * (0.4 + 0.6 * Math.abs(Math.sin(T * 9 - i * 0.8))); ctx.beginPath(); ctx.arc(x, y - (130 + i * 50) * s, (90 + i * 60) * s, -2.3, -0.84); ctx.stroke(); }
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
