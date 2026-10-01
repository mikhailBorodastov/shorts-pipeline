// Бумажный тулкит канала для отрисовки обложек и первых кадров в «Штурме идей».
// Вынесен из «Похищенный режиссер/src/scenes.js» (строки 45–581): вырезки torn/cut/cutRect/cutEll, paperBG, note, photo, sticker,
// label, scrawl, stamp, polaroid, pin, thread, HEART, light, tint, flakes, desk, hypno, бумажный ёжик drawHog + aim.
// drawHog/hogBody — из «Не жми эту кнопку в лифте…/src/paper.js» (o.walk — фаза шага, o.backView — спина из иголок для flip3).
// Нужны helpers из template/src/lib.js (W, H, TAU, lerp, remap, clamp, E, rng, noise1, rr, circle, font, vgrad, radial, imgFit…).
// Если тулкит в роликах обновился — перенеси сюда свежую версию.
try {
  const fu = /\/src\/[^/]*$/.test(location.pathname) ? '../assets/fonts/Caveat.ttf' : '/fonts/Caveat.ttf';   // проект ролика (src/index.html) или стенд приложения
  const ff = new FontFace('Caveat', `url(${fu})`, { weight: '400 700' });
  document.fonts.add(ff); ff.load().catch(() => {});
} catch (e) {}

const HAND = '"Caveat", "Nunito", cursive';
const hand = (size, w = 700) => `${w} ${size}px ${HAND}`;

// ---------------------------------------------------------------- paper toolkit
const PAL = {
  paper: '#e9e6df', paper2: '#d9d5cc', fog1: '#c9c7c3', fog2: '#b3b2b0', fog3: '#9d9da0',
  ink: '#2b2a2e', grey1: '#3b3b40', grey2: '#5a5a60', grey3: '#7d7d84', grey4: '#a3a3a9',
  warm: '#ffc85a', warm2: '#ff9e3d', cool: '#6fc3ff', cool2: '#2f7dff',
  gridBlue: 'rgba(70,110,190,0.28)', pen: '#243a8a', red: '#d8443a', green: '#3f8f5a',
};

// torn outline: subdivide polygon edges and jitter along the normal (deterministic by seed)
function torn(pts, seed, amp = 4, step = 12) {
  const r = rng(seed * 7919 + 13), out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const n = Math.max(1, Math.ceil(L / step)), nx = -dy / L, ny = dx / L;
    for (let k = 0; k < n; k++) {
      const t = k / n, o = (r() - 0.5) * 2 * amp;
      out.push([a[0] + dx * t + nx * o, a[1] + dy * t + ny * o]);
    }
  }
  return out;
}
const rectP = (x, y, w, h, inf = 0) => [[x - inf, y - inf], [x + w + inf, y - inf], [x + w + inf, y + h + inf], [x - inf, y + h + inf]];
const ellP = (cx, cy, rx, ry, inf = 0, n = 40) => Array.from({ length: n }, (_, i) => { const a = i / n * TAU; return [cx + Math.cos(a) * (rx + inf), cy + Math.sin(a) * (ry + inf)]; });
function path(ctx, pts) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); }

// paper grain pattern (made once)
let _grain = null;
function grainCanvas() {
  if (_grain) return _grain;
  const c = document.createElement('canvas'); c.width = c.height = 384;
  const g = c.getContext('2d'), r = rng(42);
  g.fillStyle = '#808080'; g.fillRect(0, 0, 384, 384);
  const id = g.getImageData(0, 0, 384, 384);
  for (let i = 0; i < id.data.length; i += 4) { const v = 128 + (r() - 0.5) * 46; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; }
  g.putImageData(id, 0, 0);
  g.lineCap = 'round';
  for (let i = 0; i < 260; i++) {                         // fibres / chalk strokes
    const x = r() * 384, y = r() * 384, a = -0.9 + (r() - 0.5) * 0.5, L = 8 + r() * 30;
    g.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)';
    g.lineWidth = 0.6 + r() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
  }
  return (_grain = c);
}
const _pat = new WeakMap();
function grainPat(ctx) { let p = _pat.get(ctx); if (!p) { p = ctx.createPattern(grainCanvas(), 'repeat'); _pat.set(ctx, p); } return p; }
function grainOver(ctx, a = 0.35) {
  ctx.save(); ctx.globalAlpha *= a; ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = grainPat(ctx); ctx.fill(); ctx.restore();
}

// a paper cutout: shadow + white torn edge + coloured torn body + grain
// shape(inf) -> points; o: {seed, amp, step, edge, shadow, grain, noEdge}
function cut(ctx, shape, fill, o = {}) {
  const seed = o.seed || 1, amp = o.amp == null ? 3.5 : o.amp, step = o.step || 12;
  const edge = o.edge == null ? 5 : o.edge;
  const body = torn(shape(0), seed, amp, step);
  ctx.save();
  if (edge > 0 && !o.noEdge) {
    const rim = torn(shape(edge), seed + 101, amp * 1.3, step);
    if (o.shadow !== false) { ctx.shadowColor = 'rgba(20,18,30,0.32)'; ctx.shadowBlur = o.blur || 14; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 7; }
    path(ctx, rim); ctx.fillStyle = o.edgeColor || '#f7f5ef'; ctx.fill();
    noGlow(ctx); ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
  } else if (o.shadow !== false) {
    ctx.shadowColor = 'rgba(20,18,30,0.3)'; ctx.shadowBlur = o.blur || 12; ctx.shadowOffsetY = 6;
  }
  path(ctx, body); ctx.fillStyle = fill; ctx.fill();
  noGlow(ctx); ctx.shadowOffsetY = 0;
  if (o.grain !== false) { path(ctx, body); grainOver(ctx, o.grainA || 0.4); }
  ctx.restore();
  return body;
}
const cutRect = (ctx, x, y, w, h, fill, o = {}) => cut(ctx, inf => rectP(x, y, w, h, inf), fill, o);
const cutEll = (ctx, cx, cy, rx, ry, fill, o = {}) => cut(ctx, inf => ellP(cx, cy, rx, ry, inf), fill, o);

// cached offscreen drawing
const _cache = {};
function cached(key, w, h, fn) {
  if (!_cache[key]) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    fn(c.getContext('2d'), w, h); _cache[key] = c;
  }
  return _cache[key];
}

// full-frame paper background with torn fog sheets (cached per palette)
function paperBG(ctx, key, cols, t = 0, drift = 1) {
  const bg = cached('bg_' + key, W + 400, H + 400, (g, w, h) => {
    g.fillStyle = cols[0]; g.fillRect(0, 0, w, h);
    g.fillStyle = grainPat(g); g.globalAlpha = 0.5; g.globalCompositeOperation = 'overlay'; g.fillRect(0, 0, w, h);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const r = rng(key.length * 31 + 7);
    for (let i = 0; i < 9; i++) {                 // big diagonal torn sheets (like the reference fog)
      const x0 = r() * w, top = -100, wd = 160 + r() * 420, lean = (r() - 0.5) * 500;
      const pts = [[x0, top], [x0 + wd, top], [x0 + wd + lean, h + 100], [x0 + lean, h + 100]];
      g.save(); g.globalAlpha = 0.35 + r() * 0.4;
      cut(g, inf => pts.map(p => [p[0] + (p[0] > x0 + wd / 2 + lean / 2 ? inf : -inf), p[1]]), cols[1 + (i % (cols.length - 1))],
        { seed: i + 3, amp: 9, step: 26, edge: 3, blur: 22, grainA: 0.5 });
      g.restore();
    }
  });
  const dx = -200 + Math.sin(t * 0.13) * 30 * drift, dy = -200 + Math.cos(t * 0.11) * 20 * drift;
  ctx.drawImage(bg, dx, dy);
}

// paper grass band (cached), with slight sway by offset
function grassBand(ctx, y, key, cols, t = 0, h = 260) {
  const band = cached('grass_' + key, W + 300, h + 120, (g, w, hh) => {
    const r = rng(key.length * 97 + 5);
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 70; i++) {
        const x = r() * w, bh = 60 + r() * (h - 40) * (1 - layer * 0.18), bw = 14 + r() * 26, lean = (r() - 0.5) * 70;
        const base = hh - 10 - layer * 18;
        const pts = [[x - bw / 2, base], [x + lean, base - bh], [x + bw / 2, base]];
        g.save(); g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
        path(g, torn(pts, i * 13 + layer, 2.5, 10)); g.fillStyle = cols[(i + layer) % cols.length]; g.fill(); g.restore();
      }
    }
    g.fillStyle = cols[0]; g.fillRect(0, hh - 12, w, 12);
  });
  ctx.drawImage(band, -150 + Math.sin(t * 0.9) * 6, y - band.height + 60);
}

// handwritten text
function handText(ctx, text, x, y, size, color = PAL.pen, o = {}) {
  ctx.save(); ctx.font = hand(size, o.w || 700); ctx.textAlign = o.align || 'center'; ctx.textBaseline = 'middle';
  if (o.maxW || o.maxH) {            // shrink to fit the sheet
    const lines = String(text).split('\n');
    const wmax = Math.max(...lines.map(l => ctx.measureText(l).width));
    let k = 1;
    if (o.maxW && wmax > o.maxW) k = Math.min(k, o.maxW / wmax);
    if (o.maxH && lines.length * size > o.maxH) k = Math.min(k, o.maxH / (lines.length * size));
    size *= k; ctx.font = hand(size, o.w || 700);
  }
  ctx.fillStyle = color;
  String(text).split('\n').forEach((l, i, a) => ctx.fillText(l, x, y + (i - (a.length - 1) / 2) * size * 1.0));
  ctx.restore();
}
// notebook sheet (grid) with handwritten text
function note(ctx, x, y, w, h, rot, text, o = {}) {
  const s = o.scale == null ? 1 : o.scale; if (s <= 0.001) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s); ctx.globalAlpha *= o.a == null ? 1 : o.a;
  const body = cut(ctx, inf => rectP(-w / 2, -h / 2, w, h, inf), o.bg || '#fbfaf5', { seed: o.seed || 5, amp: 3, edge: 0, blur: 16 });
  if (o.grid !== false) {
    ctx.save(); path(ctx, body); ctx.clip();
    ctx.strokeStyle = o.gridColor || PAL.gridBlue; ctx.lineWidth = 2;
    const g = o.cell || 34;
    for (let gx = -w / 2 + 10; gx < w / 2; gx += g) { ctx.beginPath(); ctx.moveTo(gx, -h / 2); ctx.lineTo(gx, h / 2); ctx.stroke(); }
    for (let gy = -h / 2 + 10; gy < h / 2; gy += g) { ctx.beginPath(); ctx.moveTo(-w / 2, gy); ctx.lineTo(w / 2, gy); ctx.stroke(); }
    ctx.restore();
  }
  if (o.tape !== false) {           // strip of tape on top
    ctx.save(); ctx.rotate(-rot * 0.6 + 0.04); ctx.globalAlpha *= 0.55;
    path(ctx, torn(rectP(-55, -h / 2 - 20, 110, 38), (o.seed || 5) + 9, 2, 10)); ctx.fillStyle = '#efe4b8'; ctx.fill(); ctx.restore();
  }
  if (text) handText(ctx, text, 0, o.ty || 4, o.size || 70, o.color || PAL.pen, { maxW: w - 44, maxH: h - 16 });
  if (o.extra) o.extra(ctx);
  ctx.restore();
}
// photo stuck on as a torn cutout with white edge
function photo(ctx, im, cx, cy, w, h, rot = 0, o = {}) {
  if (!im) return;
  const s = o.scale == null ? 1 : o.scale; if (s <= 0.001) return;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(s, s);
  const shape = o.shape || (inf => rectP(-w / 2, -h / 2, w, h, inf));
  const body = cut(ctx, shape, '#222', { seed: o.seed || 17, amp: 4, edge: o.edge == null ? 10 : o.edge, grain: false });
  ctx.save(); path(ctx, body); ctx.clip();
  if (o.cover) { const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, k = Math.max(w / iw, h / ih) * (o.zoom || 1); ctx.drawImage(im, -iw * k / 2 + (o.ox || 0), -ih * k / 2 + (o.oy || 0), iw * k, ih * k); }
  else imgFit(ctx, im, 0, 0, w, h);
  if (o.tint) { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = o.tint; ctx.fillRect(-w, -h, w * 2, h * 2); ctx.globalCompositeOperation = 'source-over'; }
  path(ctx, body); grainOver(ctx, 0.3);
  ctx.restore(); ctx.restore();
}
// transparent PNG as a sticker: white outline via offset copies
function sticker(ctx, im, cx, cy, w, rot = 0, s = 1, o = {}) {
  if (!im || s <= 0.001) return;
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height, h = w * ih / iw;
  const key = 'stk_' + (o.key || im.src) + '_' + Math.round(w);
  const c = cached(key, Math.ceil(w + 40), Math.ceil(h + 40), g => {
    const tmp = document.createElement('canvas'); tmp.width = w + 40; tmp.height = h + 40; const t = tmp.getContext('2d');
    t.drawImage(im, 20, 20, w, h); t.globalCompositeOperation = 'source-in'; t.fillStyle = '#f7f5ef'; t.fillRect(0, 0, w + 40, h + 40);
    for (let a = 0; a < TAU; a += TAU / 16) g.drawImage(tmp, Math.cos(a) * 8, Math.sin(a) * 8);
    g.drawImage(im, 20, 20, w, h);
    g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.25; g.fillStyle = grainPat(g); g.fillRect(0, 0, w + 40, h + 40);
  });
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(s, s);
  ctx.shadowColor = 'rgba(20,18,30,0.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 8;
  ctx.drawImage(c, -c.width / 2, -c.height / 2); ctx.restore();
}
// additive light
function light(ctx, x, y, r, color, a = 1) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; softGlow(ctx, x, y, r, color, a); ctx.restore();
}
function tint(ctx, color, a) { ctx.save(); ctx.globalAlpha = a; ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = color; ctx.fillRect(-50, -50, W + 100, H + 100); ctx.restore(); }
// falling paper flakes (snow / slush)
function flakes(ctx, T, seed, n, col, o = {}) {
  const r = rng(seed); const sp = o.speed || 90, drift = o.drift || 30;
  ctx.save(); ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const x0 = r() * (W + 200) - 100, y0 = r() * H, s = 4 + r() * (o.size || 9), v = sp * (0.6 + r() * 0.8), ph = r() * TAU;
    const y = ((y0 + T * v) % (H + 40)) - 20, x = x0 + Math.sin(T * 1.3 + ph) * drift + (o.wind || 0) * y * 0.2;
    ctx.globalAlpha = (o.a || 0.9) * (0.5 + r() * 0.5);
    ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x - s * 0.2, y - s * 0.8); ctx.lineTo(x + s, y - s * 0.1); ctx.lineTo(x + s * 0.3, y + s * 0.8); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function countNum(v) { return Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' '); }


// ---------------------------------------------------------------- collage helpers (this short)
const RED = '#c8202b', CREAM = '#f4efe3', INK = '#1d1b22', YEL = '#ffd23f', GRN = '#3f8f5a', BLU = '#1f4fa8';
// sticker "slam": scale from big to 1 with a bounce, 0 before t0
const slam = (T, t0, d = 0.28, from = 1.7) => (T < t0 ? 0 : lerp(from, 1, E.outBack(remap(T, t0, t0 + d))));
const popIn = (T, t0, d = 0.35) => (T < t0 ? 0 : E.outBackBig(remap(T, t0, t0 + d)));
function shake(ctx, T, t0, amp = 14, d = 0.35) {
  if (T < t0 || T > t0 + d) return;
  const k = 1 - (T - t0) / d;
  ctx.translate(Math.sin(T * 91) * amp * k, Math.cos(T * 77) * amp * k);
}
function camAt(ctx, fx, fy, s) { ctx.translate(fx, fy); ctx.scale(s, s); ctx.translate(-fx, -fy); }

// desk / paper background, drawn wider than the frame, always drifting a little
const DESK = { grid: '#f3f0e6', kraft: '#c9a57a', white: '#f7f5ef', night: '#15204a', red: '#a81e28', matrix: '#07170d' };
function desk(ctx, T, kind = 'grid', o = {}) {
  const bg = cached('desk_' + kind, W + 700, H + 700, (g, w, h) => {
    g.fillStyle = DESK[kind]; g.fillRect(0, 0, w, h);
    g.fillStyle = grainPat(g); g.globalAlpha = 0.5; g.globalCompositeOperation = 'overlay'; g.fillRect(0, 0, w, h);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    if (kind === 'grid' || kind === 'night') {
      g.strokeStyle = kind === 'grid' ? 'rgba(70,110,190,0.22)' : 'rgba(150,180,255,0.13)'; g.lineWidth = 2;
      for (let x = 0; x < w; x += 54) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y < h; y += 54) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    }
    if (kind === 'kraft' || kind === 'red') {
      const r = rng(3); g.strokeStyle = kind === 'kraft' ? 'rgba(90,60,30,0.14)' : 'rgba(40,0,0,0.18)';
      for (let i = 0; i < 500; i++) { const x = r() * w, y = r() * h; g.lineWidth = 1 + r() * 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + r() * 70 - 35, y + r() * 8); g.stroke(); }
    }
  });
  const rot = (o.rot == null ? 0.018 : o.rot) * Math.sin(T * 0.23), s = 1.02 + (o.zoom == null ? 0.035 : o.zoom) * (0.5 + 0.5 * Math.sin(T * 0.17));
  ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(s, s);
  ctx.drawImage(bg, -bg.width / 2 + Math.sin(T * 0.11) * 25, -bg.height / 2 + Math.cos(T * 0.09) * 18);
  ctx.restore();
}

// red/cream hypnotic waves growing out of (cx, cy) — organic tall ovals like the reference
function hypno(ctx, cx, cy, T, o = {}) {
  const c1 = o.c1 || RED, c2 = o.c2 || CREAM, gap = o.gap || 85, sp = o.speed || 60;
  const u = T * sp / gap, k = Math.floor(u), fr = u - k, n = Math.ceil(2100 / gap) + 2;
  const par = i => (((i - k) % 2) + 2) % 2;
  const shape = a => 1 + 0.085 * Math.sin(a * 3 + T * 0.35) + 0.045 * Math.sin(a * 5 - T * 0.25);
  ctx.save(); if (o.a != null) ctx.globalAlpha *= o.a;
  ctx.fillStyle = par(n + 1) ? c1 : c2; ctx.fillRect(-200, -200, W + 400, H + 400);
  for (let i = n; i >= 0; i--) {
    const R = (i + fr) * gap + 8;
    ctx.beginPath();
    for (let j = 0; j <= 96; j++) {
      const a = j / 96 * TAU, rr2 = R * shape(a);
      ctx.lineTo(cx + Math.cos(a) * rr2 * (o.sx || 0.82), cy + Math.sin(a) * rr2 * (o.sy || 1.25));
    }
    ctx.closePath(); ctx.fillStyle = par(i) ? c1 : c2; ctx.fill();
  }
  ctx.fillStyle = grainPat(ctx); ctx.globalAlpha *= 0.35; ctx.globalCompositeOperation = 'overlay'; ctx.fillRect(-200, -200, W + 400, H + 400);
  ctx.restore();
}
// paper label with bold text (price tags, numbers, title plates)
function label(ctx, x, y, text, o = {}) {
  const s = o.scale == null ? 1 : o.scale; if (s <= 0.001) return;
  const size = o.size || 72;
  ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot || 0); ctx.scale(s, s); if (o.a != null) ctx.globalAlpha *= o.a;
  ctx.font = font(size, 900);
  const lines = String(text).split('\n'), tw = Math.max(...lines.map(l => ctx.measureText(l).width));
  const w = tw + size * 0.8, h = lines.length * size * 1.05 + size * 0.42;
  cut(ctx, inf => rectP(-w / 2, -h / 2, w, h, inf), o.bg || '#fbfaf5', { seed: o.seed || (String(text).length * 7 + 3), amp: 3, edge: o.edge == null ? 0 : o.edge, blur: 16 });
  ctx.fillStyle = o.color || INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * size * 1.05 + size * 0.05));
  ctx.restore();
}
// a small source tag ("ПО ДАННЫМ СМИ")
function srcTag(ctx, x, y, text, a = 1) { label(ctx, x, y, text, { size: 34, bg: INK, color: '#fff', a, rot: -0.02, seed: 77 }); }

// handwritten yellow text, revealed left to right like a marker stroke
function scrawl(ctx, text, x, y, size, T, t0, o = {}) {
  if (T < t0) return;
  const p = E.outQ(remap(T, t0, t0 + (o.dur || 0.45)));
  ctx.save(); ctx.font = hand(size); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (o.a != null) ctx.globalAlpha *= o.a;
  ctx.translate(x, y); ctx.rotate(o.rot || -0.04);
  const w = ctx.measureText(text).width;
  ctx.beginPath(); ctx.rect(-w / 2 - 20, -size, (w + 40) * p, size * 2); ctx.clip();
  ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.16; ctx.strokeStyle = o.stroke || 'rgba(25,15,5,0.85)'; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = o.color || YEL; ctx.fillText(text, 0, 0);
  ctx.restore();
}

// big white stacked words, each line slams in at its time
function stackWords(ctx, lines, x, y, size, T, times, o = {}) {
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  lines.forEach((l, i) => {
    if (T < times[i]) return;
    const s = slam(T, times[i], 0.22, 1.45), ly = y + i * size * 1.02;
    ctx.save(); ctx.translate(x, ly); ctx.scale(s, s); ctx.font = font(size, 900);
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
    ctx.lineWidth = size * 0.2; ctx.strokeStyle = o.outline || INK; ctx.strokeText(l, 0, 0);
    noGlow(ctx); ctx.shadowOffsetY = 0;
    ctx.fillStyle = (o.colors && o.colors[i]) || '#fff'; ctx.fillText(l, 0, 0);
    ctx.restore();
  });
  ctx.restore();
}

// ---------------------------------------------------------------- the paper hedgehog (PS6) + badge, wink, long arms
const HOG_PX = 520;
const HOG_KINDS = {
  kid: { rx: 0.33, ry: 0.47, greys: ['#56565c', '#66666c', '#77777d', '#88888e', '#9a9aa0', '#4a4a50'], base: '#5c5c62', face: '#b9b9bd', mask: '#35353a', n: 700 },
  adult: { rx: 0.31, ry: 0.5, greys: ['#38383d', '#46464b', '#55555a', '#66666b', '#7a7a80', '#2e2e33'], base: '#404045', face: '#9c9ca1', mask: '#252529', n: 900 },
  friend: { rx: 0.31, ry: 0.5, greys: ['#4a4439', '#5a5345', '#6b6353', '#7c7362', '#8d8472', '#3e392f'], base: '#4f493d', face: '#b3ab9a', mask: '#2e2a22', n: 900 },
};
function hogBody(kind, back = false) {
  const K = HOG_KINDS[kind], S = HOG_PX, M = 140;
  return cached('hog_' + kind + (back ? '_back' : ''), Math.ceil(S * 0.66 + M * 2), Math.ceil(S * 1.02 + M * 2), (g, w, h) => {
    const r = rng(kind.length * 1000 + 3);
    g.translate(w / 2, h - M * 0.6);
    const cy = -0.52 * S, rx = K.rx * S, ry = K.ry * S;
    const inside = (x, y) => Math.pow(Math.abs(x / rx), 2.6) + Math.pow(Math.abs((y - cy) / ry), 2.6) <= 1;
    const strip = (x, y, ang, len, wd, col) => {
      const c = Math.cos(ang), s = Math.sin(ang), px = -s * wd / 2, py = c * wd / 2, tip = 0.25 + r() * 0.5;
      const pts = [[x + px, y + py], [x + c * len * 0.5 + px * 1.1, y + s * len * 0.5 + py * 1.1], [x + c * len + px * tip, y + s * len + py * tip],
        [x + c * len - px * tip, y + s * len - py * tip], [x + c * len * 0.5 - px, y + s * len * 0.5 - py], [x - px, y - py]];
      g.fillStyle = col; path(g, torn(pts, (r() * 1e6) | 0, wd * 0.12, 8)); g.fill();
    };
    g.save(); g.shadowColor = 'rgba(10,10,20,0.35)'; g.shadowBlur = 26; g.shadowOffsetY = 10;
    g.beginPath();
    for (let i = 0; i <= 80; i++) { const a = i / 80 * TAU, c = Math.cos(a), s = Math.sin(a);
      g.lineTo(Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.6) * rx, cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.6) * ry); }
    g.closePath(); g.fillStyle = K.base; g.fill(); g.restore();
    for (let i = 0; i < K.n * 0.45; i++) {
      const a = r() * TAU, c = Math.cos(a), s = Math.sin(a);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.6) * rx * 0.9, ey = cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.6) * ry * 0.92;
      if (ey > -0.04 * S) continue;
      const ang = Math.atan2(ey - cy, ex) + (r() - 0.5) * 0.9 + 0.25;
      strip(ex, ey, ang, S * (0.07 + r() * 0.11), S * (0.012 + r() * 0.02), K.greys[(r() * K.greys.length) | 0]);
    }
    for (let i = 0; i < K.n; i++) {
      let x, y, k = 0; do { x = (r() * 2 - 1) * rx; y = cy + (r() * 2 - 1) * ry; k++; } while (!inside(x, y) && k < 20);
      const ang = Math.PI / 2 + (r() - 0.5) * 2.6 + (x / rx) * 0.6;
      strip(x, y, ang, S * (0.05 + r() * 0.09), S * (0.012 + r() * 0.022), K.greys[(r() * K.greys.length) | 0]);
    }
    if (back) {                              // seen from behind: more quills where the face would be, no mask / muzzle
      for (let i = 0; i < K.n * 0.5; i++) { const x = (r() * 2 - 1) * rx * 0.8, y = cy - ry * 0.3 + (r() * 2 - 1) * ry * 0.5;
        strip(x, y, Math.PI / 2 + (r() - 0.5) * 1.6, S * (0.05 + r() * 0.08), S * (0.012 + r() * 0.02), K.greys[(r() * K.greys.length) | 0]); }
      g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.35; g.fillStyle = grainPat(g); g.fillRect(-w, -h, w * 2, h * 2);
      return;
    }
    g.save(); g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
    g.fillStyle = K.mask; path(g, torn(ellP(0, -0.63 * S, 0.2 * S, 0.075 * S), 77, 4, 10)); g.fill();
    g.fillStyle = K.face; path(g, torn(ellP(0, -0.5 * S, 0.14 * S, 0.105 * S), 78, 4, 10)); g.fill();
    g.fillStyle = mix(K.face, '#ffffff', 0.25); path(g, torn(ellP(0, -0.47 * S, 0.08 * S, 0.055 * S), 79, 3, 9)); g.fill();
    g.restore();
    for (let i = 0; i < 40; i++) {
      const a = r() * TAU, x = Math.cos(a) * 0.16 * S, y = -0.52 * S + Math.sin(a) * 0.14 * S;
      if (y > -0.44 * S && Math.abs(x) < 0.1 * S) continue;
      strip(x, y, a + (r() - 0.5) * 0.8, S * (0.04 + r() * 0.05), S * (0.01 + r() * 0.012), K.greys[(r() * K.greys.length) | 0]);
    }
    g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.35; g.fillStyle = grainPat(g); g.fillRect(-w, -h, w * 2, h * 2);
  });
}
// o: kind, t, look, blink, wink, lid, tired, mouth 'o'|'smile'|'flat'|'sad'|'open', brows 'up'|'angry'|'sad'|'worried', armL/armR (0 = down, + = inward/up, - = outward),
//    lenL/lenR (arm length multipliers), liftL/liftR (0..1 — a foot up), badge 'L5', sq, rot. Returns world positions of paws.
//    Персонаж со скелетом (S4): engine/rig.js — поза костей и лица -> эти параметры.
function drawHog(ctx, x, y, size, o = {}) {
  if (size <= 1) return {};
  const kind = o.kind || 'adult', K = HOG_KINDS[kind], S = HOG_PX, k = size / S;
  const t = o.t || 0, breath = 1 + Math.sin(t * 2.2 + (o.ph || 0)) * 0.012;
  const sq = o.sq || 0, rot = (o.rot || 0) + Math.sin(t * 1.3 + (o.ph || 0)) * 0.012;
  const body = hogBody(kind, !!o.backView), M = 140;
  const paws = {}, base = ctx.getTransform().inverse();
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(k * (1 + sq * 0.5), k * breath * (1 - sq));
  for (const sx of [-1, 1]) {        // feet; o.walk = step phase lifts them in turn
    const lift = o.walk != null ? Math.max(0, Math.sin(o.walk) * sx) * 0.07 * S : ((sx < 0 ? o.liftL : o.liftR) || 0) * 0.07 * S;
    cut(ctx, inf => ellP(sx * 0.1 * S, -0.02 * S - lift, 0.06 * S, 0.035 * S, inf), K.mask, { seed: 30 + sx, edge: 0, amp: 3 });
  }
  const arm = (side, ang, len) => {
    ctx.save(); ctx.translate(side * K.rx * S * 0.86, -0.46 * S); ctx.rotate(side * ang);
    const L = 0.24 * S * (len || 1), Wd = 0.065 * S;
    cut(ctx, inf => [[-Wd * 0.5 - inf, -inf], [Wd * 0.55 + inf, -inf], [Wd * 0.42 + inf, L * 0.7], [0, L + inf], [-Wd * 0.4 - inf, L * 0.7]].map(p => [p[0] * side, p[1]]),
      K.mask, { seed: 40 + side, edge: 0, amp: 3, blur: 10 });
    cutEll(ctx, 0, L * 0.95, Wd * 0.45, Wd * 0.4, K.face, { seed: 44 + side, edge: 0, amp: 2 });
    const p = base.transformPoint(ctx.getTransform().transformPoint(new DOMPoint(0, L * 0.95)));
    paws[side < 0 ? 'L' : 'R'] = [p.x, p.y];
    ctx.restore();
  };
  ctx.drawImage(body, -body.width / 2, -(body.height - M * 0.6));
  if (o.hoodie) {          // hoodie over the lower body, with drawstrings
    const hd = inf => [[-K.rx * S * 0.97 - inf, -0.42 * S], [-0.09 * S, -0.45 * S - inf], [0.09 * S, -0.45 * S - inf], [K.rx * S * 0.97 + inf, -0.42 * S], [K.rx * S * 0.9 + inf, -0.02 * S + inf], [-K.rx * S * 0.9 - inf, -0.02 * S + inf]];
    cut(ctx, hd, o.hoodie, { seed: 57, edge: 3, amp: 3 });
    cutRect(ctx, -0.12 * S, -0.2 * S, 0.24 * S, 0.1 * S, mix(o.hoodie, '#000', 0.15), { seed: 59, edge: 0, amp: 2, shadow: false });
    ctx.save(); ctx.strokeStyle = '#f4f2ec'; ctx.lineWidth = 0.01 * S; ctx.lineCap = 'round';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx * 0.05 * S, -0.43 * S); ctx.lineTo(sx * 0.055 * S, -0.33 * S); ctx.stroke(); }
    ctx.restore();
  }
  if (o.badge) {           // lanyard + badge
    ctx.save(); ctx.strokeStyle = '#c8372d'; ctx.lineWidth = 0.012 * S; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(-0.1 * S, -0.44 * S); ctx.lineTo(0.08 * S, -0.3 * S); ctx.lineTo(0.2 * S, -0.44 * S); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.translate(0.08 * S, -0.25 * S); ctx.rotate(0.06);
    cutRect(ctx, -0.07 * S, -0.05 * S, 0.14 * S, 0.1 * S, '#f7f5ef', { seed: 58, edge: 0, amp: 1.5, blur: 6 });
    ctx.font = `900 ${0.055 * S}px Rubik`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#2b2a2e';
    ctx.fillText(o.badge, 0, 0.004 * S);
    ctx.restore();
  }
  if (o.backView) { arm(-1, o.armL == null ? 0.15 : o.armL, o.lenL); arm(1, o.armR == null ? 0.15 : o.armR, o.lenR); ctx.restore(); return paws; }
  const look = o.look || [0, 0], blink = clamp(o.blink || 0), lid = o.lid == null ? (kind === 'kid' ? 0 : 0.28) : o.lid;
  const er = (kind === 'kid' ? 0.058 : 0.05) * S;
  for (const sx of [-1, 1]) {
    const ex = sx * 0.085 * S, ey = -0.625 * S;
    const bl = sx < 0 && o.wink ? Math.max(blink, o.wink) : blink;
    ctx.save(); ctx.translate(ex, ey); ctx.scale(1, 1 - bl * 0.92);
    const eye = torn(ellP(0, 0, er * 0.92, er * 1.05), 60 + sx, 1.6, 6);
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    path(ctx, eye); ctx.fillStyle = '#f4f2ec'; ctx.fill(); noGlow(ctx); ctx.shadowOffsetY = 0;
    ctx.save(); path(ctx, eye); ctx.clip();
    circle(ctx, look[0] * er * 0.45 + sx * er * 0.06, look[1] * er * 0.45 + er * 0.1, er * 0.46, '#141416');
    circle(ctx, look[0] * er * 0.45 + sx * er * 0.06 + er * 0.16, look[1] * er * 0.45 - er * 0.06, er * 0.13, '#ffffff');
    if (lid > 0) { ctx.fillStyle = K.mask; ctx.fillRect(-er * 1.2, -er * 1.2, er * 2.4, er * 2.3 * lid); }
    ctx.restore(); ctx.restore();
    if (o.tired) {         // dark bags under the eyes
      ctx.save(); ctx.strokeStyle = 'rgba(20,20,26,0.8)'; ctx.lineWidth = 0.012 * S; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(ex, ey + er * 0.2, er * 1.05, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke(); ctx.restore();
    }
  }
  if (o.brows && o.brows !== 'none') {   // brows (S4): up | angry | sad | worried — light torn strips on the mask
    const bw = 0.075 * S, bh = 0.02 * S, raise = o.brows === 'up' || o.brows === 'worried' ? 0.35 : 0;
    for (const sx of [-1, 1]) {
      const a = o.brows === 'angry' ? -sx * 0.38 : o.brows === 'sad' || o.brows === 'worried' ? sx * 0.36 : sx * 0.08;
      ctx.save(); ctx.translate(sx * 0.085 * S, -0.625 * S - er * (1.45 + raise)); ctx.rotate(a);
      cut(ctx, inf => [[-bw / 2 - inf, -bh / 2 - inf], [bw / 2 + inf, -bh / 2 - inf * 0.5], [bw / 2 + inf, bh / 2 + inf * 0.5], [-bw / 2 - inf, bh / 2 + inf]], mix(K.face, '#ffffff', 0.15), { seed: 180 + sx, edge: 0, amp: 1.2, shadow: false });
      ctx.restore();
    }
  }
  if (o.beard) {           // scruffy light beard under the muzzle
    for (let i = 0; i < 9; i++) { const a = Math.PI * (0.15 + i / 8 * 0.7);
      cut(ctx, inf => [[Math.cos(a) * 0.09 * S - 0.012 * S, -0.47 * S + Math.sin(a) * 0.05 * S], [Math.cos(a) * 0.14 * S, -0.47 * S + Math.sin(a) * 0.15 * S + inf], [Math.cos(a) * 0.09 * S + 0.012 * S, -0.47 * S + Math.sin(a) * 0.05 * S]], o.beard, { seed: 150 + i, edge: 0, amp: 1.5, shadow: false }); }
  }
  cutEll(ctx, 0, -0.545 * S, 0.028 * S, 0.02 * S, '#1c1c1f', { seed: 70, edge: 0, amp: 1.5, shadow: false });
  const mouth = o.mouth || 'o';
  ctx.save(); ctx.fillStyle = '#1c1c1f'; ctx.strokeStyle = '#1c1c1f'; ctx.lineWidth = 0.012 * S; ctx.lineCap = 'round';
  if (mouth === 'o') { ellipse(ctx, 0, -0.495 * S, 0.018 * S, 0.024 * S, 0, '#1c1c1f'); }
  else if (mouth === 'smile') { ctx.beginPath(); ctx.arc(0, -0.52 * S, 0.04 * S, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke(); }
  else if (mouth === 'open') { ellipse(ctx, 0, -0.49 * S, 0.034 * S, 0.03 * S, 0, '#1c1c1f'); ellipse(ctx, 0, -0.475 * S, 0.02 * S, 0.012 * S, 0, '#c8646a'); }
  else if (mouth === 'sad') { ctx.beginPath(); ctx.arc(0, -0.46 * S, 0.035 * S, 1.2 * Math.PI, 1.8 * Math.PI); ctx.stroke(); }
  else { ctx.beginPath(); ctx.moveTo(-0.03 * S, -0.49 * S); ctx.lineTo(0.03 * S, -0.49 * S); ctx.stroke(); }
  ctx.restore();
  if (o.glasses) {
    ctx.save(); ctx.strokeStyle = o.glasses === true ? '#1a1a1c' : o.glasses; ctx.lineWidth = 0.013 * S;
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * 0.085 * S, -0.625 * S, er * 1.3, er * 1.15, 0, 0, TAU); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-0.085 * S + er * 1.3, -0.63 * S); ctx.lineTo(0.085 * S - er * 1.3, -0.63 * S); ctx.stroke();
    ctx.restore();
  }
  if (o.cap) {             // baseball cap (visor to the back if o.capBack)
    const cy = -0.93 * S;
    cut(ctx, inf => ellP(0, cy + 0.04 * S, 0.21 * S + inf, 0.12 * S + inf, 0, 24).filter(p => p[1] <= cy + 0.04 * S + 1), o.cap, { seed: 160, edge: 3, amp: 2 });
    const bx = o.capBack ? -1 : 1;
    cut(ctx, inf => [[bx * 0.05 * S, cy + 0.03 * S - inf], [bx * 0.33 * S + bx * inf, cy + 0.06 * S], [bx * 0.3 * S, cy + 0.09 * S + inf], [bx * 0.05 * S, cy + 0.07 * S + inf]], mix(o.cap, '#000000', 0.2), { seed: 161, edge: 0, amp: 1.5 });
  }
  if (o.phones) {          // headphones
    ctx.save(); ctx.strokeStyle = '#1c1c1f'; ctx.lineWidth = 0.035 * S; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -0.64 * S, 0.3 * S, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); ctx.restore();
    for (const sx of [-1, 1]) cutEll(ctx, sx * 0.3 * S, -0.6 * S, 0.06 * S, 0.085 * S, o.phones, { seed: 170 + sx, edge: 3, amp: 1.5 });
  }
  if (o.prop) o.prop(ctx, S);
  arm(-1, o.armL == null ? 0.15 : o.armL, o.lenL); arm(1, o.armR == null ? 0.15 : o.armR, o.lenR);
  ctx.restore();
  return paws;
}
const blinkAt = (T, seed = 0) => { const p = (T + seed * 1.7) % 3.7; return p < 0.13 ? Math.sin(p / 0.13 * Math.PI) : 0; };
// arm angle + length so that the paw of `side` (-1 left, +1 right) lands on (tx, ty)
function aim(x, y, size, side, tx, ty, kind = 'adult') {
  const K = HOG_KINDS[kind], k = size / HOG_PX;
  const sx = x + side * K.rx * HOG_PX * 0.86 * k, sy = y - 0.46 * HOG_PX * k, vx = tx - sx, vy = ty - sy;
  return { ang: side * Math.atan2(-vx, vy), len: Math.max(0.6, Math.hypot(vx, vy) / (0.24 * HOG_PX * k * 0.95)) };
}

// ---------------------------------------------------------------- pins, threads, polaroids, stamps, hearts (from «Коты сыщики»)
// red push pin
function pin(ctx, x, y, col = RED, s = 1) {
  if (s <= 0.001) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.save(); ctx.globalAlpha = 0.35; ellipse(ctx, 7, 10, 15, 9, 0.4, '#000'); ctx.restore();
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
  circle(ctx, 0, 0, 17, col); noGlow(ctx);
  circle(ctx, -5, -6, 5, 'rgba(255,255,255,0.65)');
  ctx.restore();
}
// red thread between two pins, drawn from a to b by p (0..1), with a slight sag
function thread(ctx, x0, y0, x1, y1, p = 1, col = '#c8202b') {
  if (p <= 0) return;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + Math.hypot(x1 - x0, y1 - y0) * 0.06;
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 3;
  ctx.beginPath(); ctx.moveTo(x0, y0);
  const n = 30;
  for (let i = 1; i <= n * p; i++) { const t = i / n, u = 1 - t; ctx.lineTo(u * u * x0 + 2 * u * t * mx + t * t * x1, u * u * y0 + 2 * u * t * my + t * t * y1); }
  ctx.stroke(); ctx.restore();
}

// polaroid with a live clip (sequence key), a still image or a custom drawing (o.drawIn)
// o: ar (image h/w), cap (handwritten caption), pin, scale, a, seed, zoom, ox, oy, noPin
function polaroid(ctx, key, cx, cy, w, rot, lt, o = {}) {
  const s = o.scale == null ? 1 : o.scale; if (s <= 0.001) return;
  const ih = w * (o.ar || 0.75), pad = w * 0.055, capH = o.cap ? w * 0.17 : pad * 1.6, fh = ih + pad + capH;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(s, s); if (o.a != null) ctx.globalAlpha *= o.a;
  cut(ctx, inf => rectP(-w / 2 - pad, -fh / 2, w + pad * 2, fh, inf), '#fbfaf5', { seed: o.seed || 7, amp: 1.5, edge: 0, blur: 20 });
  const iy = -fh / 2 + pad;
  ctx.save(); ctx.beginPath(); ctx.rect(-w / 2, iy, w, ih); ctx.clip();
  ctx.fillStyle = '#2a2a2e'; ctx.fillRect(-w / 2, iy, w, ih);
  const im = key ? (SEQ[key] ? seqFrame(key, Math.floor(Math.max(0, lt) * 15)) : IMG[key]) : null;
  if (im) {
    const iw = im.naturalWidth || im.width, ihh = im.naturalHeight || im.height, k = Math.max(w / iw, ih / ihh) * (o.zoom || 1);
    ctx.drawImage(im, -iw * k / 2 + (o.ox || 0), iy + ih / 2 - ihh * k / 2 + (o.oy || 0), iw * k, ihh * k);
  }
  if (o.drawIn) o.drawIn(ctx, -w / 2, iy, w, ih);
  ctx.fillStyle = 'rgba(255,220,160,0.10)'; ctx.fillRect(-w / 2, iy, w, ih);      // warm film tint
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2, iy, w, ih);
  if (o.cap) handText(ctx, o.cap, 0, iy + ih + capH / 2, w * 0.12, INK);
  if (o.pin !== false) pin(ctx, 0, -fh / 2 + 16, o.pinCol || RED);
  ctx.restore();
}

// rubber stamp: outlined rotated text
function stamp(ctx, x, y, text, col, s = 1, rot = -0.15, size = 70) {
  if (s <= 0.001) return;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.font = font(size, 900); const w = ctx.measureText(text).width + size * 0.7, h = size * 1.35;
  ctx.globalAlpha *= 0.9; ctx.strokeStyle = col; ctx.lineWidth = size * 0.1;
  rr(ctx, -w / 2, -h / 2, w, h, size * 0.2); ctx.stroke();
  ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 0, size * 0.04);
  ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 0.25; const r = rng(text.length * 5);
  for (let i = 0; i < 40; i++) circle(ctx, (r() - 0.5) * w, (r() - 0.5) * h, 2 + r() * 5);
  ctx.restore();
}

const HEART = (ctx, x, y, s, col = RED) => {
  if (s <= 0.001) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  cut(ctx, inf => { const p = []; for (let i = 0; i <= 30; i++) { const t = i / 30 * TAU; p.push([16 * Math.pow(Math.sin(t), 3) * (2.2 + inf * 0.1), -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * (2.2 + inf * 0.1)]); } return p; }, col, { seed: 361, edge: 5, amp: 1.5 });
  ctx.restore();
};


