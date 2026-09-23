// ---------- math / easing ----------
const W = 1080, H = 1920;
const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const remap = (t, a, b) => clamp((t - a) / (b - a));
const E = {
  lin: t => t,
  inQ: t => t * t,
  outQ: t => 1 - (1 - t) * (1 - t),
  io: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inC: t => t * t * t,
  outC: t => 1 - Math.pow(1 - t, 3),
  outExpo: t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: t => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBackBig: t => { const c1 = 2.6, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: t => { const c4 = TAU / 3; return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1; },
};
// progress of t inside [a, a+d] with easing
const P = (t, a, d, e = E.io) => e(remap(t, a, a + d));
// in-hold-out envelope
const env = (t, a, b, fin = 0.3, fout = 0.3) => Math.min(E.outC(remap(t, a, a + fin)), 1 - E.inQ(remap(t, b - fout, b)));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const noise1 = (x, seed = 0) => {
  // cheap smooth value noise
  const i = Math.floor(x), f = x - i;
  const h = n => { const s = Math.sin((n + seed * 131.7) * 127.1) * 43758.5453; return s - Math.floor(s); };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
};

// ---------- palette ----------
const C = {
  night: '#0b0a2e', night2: '#16125a', indigo: '#231a7a', deep: '#2b1fa3',
  blue: '#2f4bff', blue2: '#3b82f6', cyan: '#22e1ff', teal: '#14c8b8',
  purple: '#7b2ff7', violet: '#a855f7', magenta: '#ff3fd0', pink: '#ff7ac8',
  yellow: '#ffd23f', gold: '#ffb800', orange: '#ff8a1f', red: '#ff3b5c',
  green: '#3ee07a', green2: '#12a45a', white: '#ffffff', ink: '#120c3a',
  pill: '#6d28d9', pillDark: '#241672',
};

// ---------- drawing helpers ----------
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function circle(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function ellipse(ctx, x, y, rx, ry, rot, fill) {
  ctx.beginPath(); ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot || 0, 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function poly(ctx, pts, fill, close = true) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}
function glow(ctx, color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
function noGlow(ctx) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
function vgrad(ctx, y0, y1, stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}
function radial(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(s => g.addColorStop(s[0], s[1]));
  return g;
}
function softGlow(ctx, x, y, r, color, a = 1) {
  ctx.save(); ctx.globalAlpha *= a;
  ctx.fillStyle = radial(ctx, x, y, 0, r, [[0, color], [1, 'rgba(0,0,0,0)']]);
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}
function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(h1, h2, t) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, t));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, t));
  const bl = Math.round(lerp(a & 255, b & 255, t));
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

const FONT = '"Rubik", "Nunito", sans-serif';
function font(size, weight = 800) { return `${weight} ${size}px ${FONT}`; }

// Kurzgesagt-style label pill
function pill(ctx, x, y, text, opts = {}) {
  const size = opts.size || 44, padX = opts.padX || size * 0.75, h = size * 1.9;
  const a = opts.a == null ? 1 : opts.a, s = opts.scale == null ? 1 : opts.scale;
  if (a <= 0 || s <= 0) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha *= a;
  ctx.font = font(size, opts.weight || 800);
  const lines = String(text).split('\n');
  const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
  const hh = h + (lines.length - 1) * size * 1.1;
  const w = tw + padX * 2;
  if (opts.glow) glow(ctx, opts.glow, 40);
  rr(ctx, -w / 2, -hh / 2, w, hh, hh / 2 > 60 ? 50 : hh / 2);
  ctx.fillStyle = opts.bg || C.pill; ctx.fill();
  noGlow(ctx);
  if (opts.border) { ctx.lineWidth = 6; ctx.strokeStyle = opts.border; ctx.stroke(); }
  ctx.fillStyle = opts.color || '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * size * 1.1 + size * 0.06));
  ctx.restore();
}

// Bold title with thick outline (Kurzgesagt short title card)
function titleText(ctx, text, x, y, size, opts = {}) {
  ctx.save();
  ctx.font = font(size, 900);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const ly = y + (i - (lines.length - 1) / 2) * size * 1.02;
    ctx.lineWidth = size * 0.34;
    ctx.strokeStyle = opts.outline || C.pill;
    if (opts.glow) glow(ctx, opts.glow, 50);
    ctx.strokeText(l, x, ly);
    noGlow(ctx);
    ctx.fillStyle = opts.color || '#fff';
    ctx.fillText(l, x, ly);
  });
  ctx.restore();
}

// ---------- backgrounds ----------
const _stars = {};
function stars(ctx, t, seed, n, opts = {}) {
  if (!_stars[seed]) {
    const r = rng(seed);
    _stars[seed] = Array.from({ length: n }, () => ({
      x: r() * W, y: r() * H, s: r() * r() * 5 + 1, p: r() * TAU, sp: 0.5 + r() * 2,
      c: r() < 0.15 ? C.cyan : r() < 0.25 ? C.pink : '#ffffff',
    }));
  }
  const drift = opts.drift || 0, par = opts.par || [0, 0];
  ctx.save();
  for (const s of _stars[seed]) {
    const tw = 0.55 + 0.45 * Math.sin(t * s.sp + s.p);
    let x = (s.x + par[0] * s.s + t * drift * s.s) % W; if (x < 0) x += W;
    let y = (s.y + par[1] * s.s) % H; if (y < 0) y += H;
    ctx.globalAlpha = (opts.a == null ? 1 : opts.a) * tw * (0.35 + s.s / 8);
    circle(ctx, x, y, s.s * (opts.scale || 1), s.c);
    if (s.s > 4.2) {
      ctx.fillStyle = s.c;
      ctx.fillRect(x - s.s * 3, y - 1, s.s * 6, 2);
      ctx.fillRect(x - 1, y - s.s * 3, 2, s.s * 6);
    }
  }
  ctx.restore();
}

function rays(ctx, x, y, n, len, rot, color, a = 1, widthFrac = 0.5) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha *= a;
  const g = radial(ctx, 0, 0, 0, len, [[0, color], [1, 'rgba(0,0,0,0)']]);
  ctx.fillStyle = g;
  const step = TAU / n;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a0 = i * step, a1 = a0 + step * widthFrac;
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, len, a0, a1);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

function vignette(ctx, a = 0.55) {
  ctx.save();
  ctx.fillStyle = radial(ctx, W / 2, H / 2, H * 0.3, H * 0.75, [[0, 'rgba(5,3,25,0)'], [1, `rgba(5,3,25,${a})`]]);
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// word timing helpers
function secOf(i) { return VO.sections[i]; }
// absolute time of the k-th word (or first word matching a substring) in section i
function WT(i, key, which = 't') {
  const s = VO.sections[i];
  let w;
  if (typeof key === 'number') w = s.words[Math.min(key, s.words.length - 1)];
  else w = s.words.find(x => x.w.toLowerCase().includes(key.toLowerCase()));
  if (!w) { console.warn('word not found', i, key); return s.start; }
  return s.start + (which === 'end' ? w.t + w.d : w.t);
}

// SFX event registry (collected once, exported for the audio mix)
const SFX = [];
function sfx(time, type, gain = 1) { SFX.push({ t: +time.toFixed(3), type, gain }); }

// ---------- more shared helpers ----------
function starShape(ctx, x, y, R, r, fill, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot - Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r : R;
    ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
}

function lightning(ctx, x0, y0, x1, y1, seed, color, width = 10, jag = 40) {
  const r = rng(seed), n = 10, pts = [[x0, y0]];
  const nx = -(y1 - y0), ny = x1 - x0, L = Math.hypot(nx, ny) || 1;
  for (let i = 1; i < n; i++) {
    const t = i / n, off = (r() - 0.5) * 2 * jag;
    pts.push([lerp(x0, x1, t) + nx / L * off, lerp(y0, y1, t) + ny / L * off]);
  }
  pts.push([x1, y1]);
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; glow(ctx, color, 40);
  ctx.strokeStyle = color; ctx.lineWidth = width; poly(ctx, pts, null, false); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = width * 0.4; poly(ctx, pts, null, false); ctx.stroke();
  ctx.restore();
}

// rolling hills silhouette (drawn wide so camera zoom-outs never show the edge)
function hills(ctx, y, amp, color, seed, off = 0) {
  ctx.beginPath(); ctx.moveTo(-900, H * 3);
  for (let x = -900; x <= W + 900; x += 30)
    ctx.lineTo(x, y + noise1((x + off) / 260, seed) * amp + noise1((x + off) / 90, seed + 3) * amp * 0.25);
  ctx.lineTo(W + 900, H * 3); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}

// play an image sequence (from ASSETS.sequences) inside a rect, pixel-crisp, with scanlines
function screenSeq(ctx, key, x, y, w, h, lt, fps = 15, scan = true) {
  const im = seqFrame(key, Math.floor(lt * fps));
  ctx.save(); ctx.imageSmoothingEnabled = false;
  if (im) ctx.drawImage(im, x, y, w, h);
  if (scan) { ctx.fillStyle = 'rgba(0,0,20,0.22)'; for (let yy = y; yy < y + h; yy += 6) ctx.fillRect(x, yy, w, 3); }
  ctx.restore();
}

// fit an image (png/svg) into a box, centred
function imgFit(ctx, im, cx, cy, w, h) {
  if (!im) return;
  const iw = im.naturalWidth || im.width || 1, ih = im.naturalHeight || im.height || 1;
  const s = Math.min(w / iw, h / ih);
  ctx.drawImage(im, cx - iw * s / 2, cy - ih * s / 2, iw * s, ih * s);
}
