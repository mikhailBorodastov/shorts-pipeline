// Engine: asset loading, timeline, transitions, captions, SFX cue export.
// Project-specific content lives in scenes.js (SCENES, ASSETS). Nothing here should need editing per project.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const TOTAL = VO.total;

// ---------- assets (declared in scenes.js as ASSETS) ----------
// ASSETS = { images: { key: 'path' }, sequences: { key: { pattern: '../assets/x/f%03d.jpg', count: 120 } } }
const IMG = {};   // IMG.key -> HTMLImageElement
const SEQ = {};   // SEQ.key -> [HTMLImageElement...]
function loadImg(src) {
  // retries: during a render several pages load assets at once, a single failed request used to blank an image on every Nth frame
  return new Promise(res => {
    const go = n => { const im = new Image(); im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => res(im));
      im.onerror = () => { if (n > 0) setTimeout(() => go(n - 1), 250); else { console.warn('missing asset', src); res(null); } }; im.src = src; };
    go(4);
  });
}
const READY = (async () => {
  const A = (typeof ASSETS !== 'undefined' && ASSETS) || {};
  const jobs = [];
  for (const k in A.images || {}) jobs.push(loadImg(A.images[k]).then(im => (IMG[k] = im)));
  for (const k in A.sequences || {}) {
    const { pattern, count, start = 0 } = A.sequences[k];   // start: first file number (ffmpeg writes f001…)
    SEQ[k] = [];
    for (let i = 0; i < count; i++) {
      const src = pattern.replace(/%0(\d)d/, (_, n) => String(i + start).padStart(+n, '0'));
      jobs.push(loadImg(src).then(im => (SEQ[k][i] = im)));
    }
  }
  await Promise.all(jobs);
  await Promise.all([font(40, 900), font(40, 800), font(40, 600)].map(f => document.fonts.load(f, 'Абв')));
  await document.fonts.load('20px PressStart', 'A');
  await document.fonts.ready;
  // 3D worlds (stage3d.js): wait for three.js, then build scenes (textures need fonts and images)
  if (window.THREE_READY) await window.THREE_READY;
  if (typeof window.STUDIO_READY === 'function') await window.STUDIO_READY();   // монтаж Claude Studio: персонажи, пропсы, клипы — до построения миров
  if (typeof stage3dInit === 'function') await stage3dInit();
  return true;
})();
// frame i of a sequence (wraps around)
function seqFrame(key, i) { const s = SEQ[key]; if (!s || !s.length) return null; return s[((i % s.length) + s.length) % s.length]; }

// ---------- timeline ----------
// scene k covers [B[k], B[k+1]); boundaries follow the voice-over sections (scene k <-> section k)
// монтаж Claude Studio (S6, src/montage.js) задаёт границы сам: SCENE_B = [начало каждой сцены…]
const B = typeof SCENE_B !== 'undefined' ? SCENE_B.slice(0, SCENES.length) : SCENES.map((_, k) => (k === 0 ? 0 : VO.sections[Math.min(k, VO.sections.length - 1)].start - 0.2));
B.push(TOTAL);
const TD = 0.7; // default transition length

const bufA = document.createElement('canvas'); bufA.width = W; bufA.height = H;
const bufB = document.createElement('canvas'); bufB.width = W; bufB.height = H;
const ctxA = bufA.getContext('2d'), ctxB = bufB.getContext('2d');

function drawScene(c, k, T) {
  c.save();
  c.clearRect(0, 0, W, H);
  SCENES[k].draw(c, T - B[k], B[k + 1] - B[k], T);
  c.restore();
}

// Transition types (set `trans` on the INCOMING scene): iris | push | slide | zoom | zoomOut | wipe | pop | crumple | cut
// ---------- crumple transition: frame as a triangle mesh folding into a paper ball ----------
const CRUMPLE_BG = '#e7dfcf';
const CRM = (() => {
  const nx = 9, ny = 16, r = rng(17), v = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const a = r() * TAU, rr = Math.sqrt(r());
    v.push({ x: i / nx * W, y: j / ny * H, bx: Math.cos(a) * rr, by: Math.sin(a) * rr, sh: r() });
  }
  return { nx, ny, v };
})();
// textured triangle: source points s0..s2 of img mapped to d0..d2
function texTri(img, s0, s1, s2, d0, d1, d2, shade) {
  const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2, [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
  const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0; if (!den) return;
  const a = -(y0 * (u2 - u1) - y1 * u2 + y2 * u1 + (y1 - y2) * u0) / den;
  const b = (y1 * v2 + y0 * (v1 - v2) - y2 * v1 + (y2 - y1) * v0) / den;
  const c = (x0 * (u2 - u1) - x1 * u2 + x2 * u1 + (x1 - x2) * u0) / den;
  const d = -(x1 * v2 + x0 * (v1 - v2) - x2 * v1 + (x2 - x1) * v0) / den;
  const e = (x0 * (y2 * u1 - y1 * u2) + y0 * (x1 * u2 - x2 * u1) + (x2 * y1 - x1 * y2) * u0) / den;
  const f = (x0 * (y2 * v1 - y1 * v2) + y0 * (x1 * v2 - x2 * v1) + (x2 * y1 - x1 * y2) * v0) / den;
  const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3, g = pt => [pt[0] + Math.sign(pt[0] - cx) * 1.2, pt[1] + Math.sign(pt[1] - cy) * 1.2];
  const q0 = g(d0), q1 = g(d1), q2 = g(d2);
  ctx.save(); ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]); ctx.closePath(); ctx.clip();
  ctx.save(); ctx.transform(a, b, c, d, e, f); ctx.drawImage(img, 0, 0); ctx.restore();
  if (shade) { ctx.fillStyle = shade > 0 ? `rgba(0,0,0,${shade})` : `rgba(255,255,255,${-shade})`; ctx.fill(); }
  ctx.restore();
}
// c: 0 flat .. 1 ball; dir -1 = crumpling (ball drifts up), +1 = unfolding
function crumpleDraw(img, c, dir) {
  const { nx, ny, v } = CRM, R = 190, rot = c * 1.3 * dir;
  const cx = W / 2, cy = H * 0.45 + dir * c * 60, k = (R * 1.7) / H, wr = Math.sin(Math.PI * Math.min(1, c * 1.4));
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const P = v.map(q => {
    const fx = (q.x - W / 2) * k, fy = (q.y - H / 2) * k;
    const bx = cx + (fx * cs - fy * sn) + q.bx * R * 0.55, by = cy + (fx * sn + fy * cs) + q.by * R * 0.55;
    const e = E.io(c);
    return [lerp(q.x, bx, e) + q.bx * 40 * wr, lerp(q.y, by, e) + q.by * 40 * wr];
  });
  if (c > 0.3) { ctx.save(); ctx.globalAlpha = (c - 0.3) * 0.5; ctx.fillStyle = 'rgba(40,30,20,1)'; ctx.beginPath(); ctx.ellipse(cx, cy + R * 1.05, R * 0.9, R * 0.18, 0, 0, TAU); ctx.fill(); ctx.restore(); }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const i0 = j * (nx + 1) + i, i1 = i0 + 1, i2 = i0 + nx + 1, i3 = i2 + 1, s = n => [v[n].x, v[n].y];
    const sh = (v[i0].sh - 0.45) * 0.55 * Math.min(1, c * 1.6);
    texTri(img, s(i0), s(i1), s(i2), P[i0], P[i1], P[i2], sh);
    texTri(img, s(i1), s(i3), s(i2), P[i1], P[i3], P[i2], -sh * 0.8);
  }
}

function composite(type, p, T, kb) {
  const zc = (kb && SCENES[kb - 1].zoomAt) || [W / 2, H * 0.4];
  ctx.save();
  if (type === 'iris') {
    ctx.drawImage(bufA, 0, 0);
    const r = E.io(p) * Math.hypot(W, H) * 0.6;
    ctx.save(); circle(ctx, W / 2, H * 0.45, r); ctx.clip(); ctx.drawImage(bufB, 0, 0); ctx.restore();
    ctx.lineWidth = 26 * (1 - p) + 4; ctx.strokeStyle = C.yellow; glow(ctx, C.yellow, 40);
    circle(ctx, W / 2, H * 0.45, r); ctx.stroke();
  } else if (type === 'push') {
    const e = E.io(p);
    ctx.drawImage(bufA, 0, -e * H); ctx.drawImage(bufB, 0, H - e * H);
  } else if (type === 'slide') {
    const e = E.io(p);
    ctx.drawImage(bufB, 0, (1 - e) * H * 0.35);
    ctx.globalAlpha = 1 - E.inQ(p); ctx.drawImage(bufA, 0, -e * H * 0.5);
  } else if (type === 'zoom') {   // dive into point zoomAt of the outgoing scene
    const e = E.inC(p);
    ctx.drawImage(bufB, 0, 0);
    ctx.globalAlpha = 1 - E.outQ(remap(p, 0.4, 1));
    const s = 1 + e * 5;
    ctx.translate(zc[0], zc[1]); ctx.scale(s, s); ctx.translate(-zc[0], -zc[1]);
    ctx.drawImage(bufA, 0, 0);
  } else if (type === 'zoomOut') {
    const e = E.io(p);
    ctx.drawImage(bufB, 0, 0);
    ctx.globalAlpha = 1 - E.inQ(remap(p, 0.3, 1));
    const s = lerp(1, 0.08, e);
    ctx.translate(W / 2, H * 0.45); ctx.scale(s, s); ctx.translate(-W / 2, -H * 0.45);
    ctx.drawImage(bufA, 0, 0);
  } else if (type === 'pop') {    // collage cut: hard cut on the word, incoming frame bounces in with a paper-white flash
    if (p < 0.5) ctx.drawImage(bufA, 0, 0);
    else {
      const q = remap(p, 0.5, 1), s = lerp(1.14, 1, E.outBack(q));
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.rotate((1 - E.outC(q)) * 0.03); ctx.translate(-W / 2, -H / 2);
      ctx.drawImage(bufB, 0, 0); ctx.restore();
      ctx.fillStyle = `rgba(250,248,240,${0.85 * (1 - E.outQ(q))})`; ctx.fillRect(0, 0, W, H);
    }
  } else if (type === 'crumple') {  // paper: the outgoing frame crumples into a ball, the incoming one unfolds from a ball
    ctx.fillStyle = CRUMPLE_BG; ctx.fillRect(0, 0, W, H);
    if (p < 0.5) crumpleDraw(bufA, E.inQ(remap(p, 0, 0.5)), -1);
    else crumpleDraw(bufB, 1 - E.outC(remap(p, 0.5, 1)), 1);
  } else if (type === 'wipe') {
    const e = E.io(p), x = lerp(-400, W + 400, e);
    ctx.drawImage(bufA, 0, 0);
    ctx.save(); ctx.beginPath();
    ctx.moveTo(x - 400, 0); ctx.lineTo(W + 800, 0); ctx.lineTo(W + 800, H); ctx.lineTo(x + 400, H); ctx.closePath();
    ctx.clip(); ctx.drawImage(bufB, 0, 0); ctx.restore();
  } else {
    ctx.drawImage(p < 0.5 ? bufA : bufB, 0, 0);
  }
  ctx.restore();
}

// ---------- captions (word by word, from VO timings) ----------
const CAPTIONS = Object.assign({ size: 70, y: 0.765, maxWords: 3, maxChars: 17 }, (typeof CAPTION_STYLE !== 'undefined' && CAPTION_STYLE) || {});
const CHUNKS = (() => {
  const words = [];
  VO.sections.forEach(s => s.words.forEach(w => words.push({ w: w.w, t: s.start + w.t, e: s.start + w.t + w.d })));
  const chunks = []; let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  for (const w of words) {
    const len = cur.reduce((a, x) => a + x.w.length + 1, 0);
    if (cur.length && (cur.length >= CAPTIONS.maxWords || len + w.w.length > CAPTIONS.maxChars)) flush();
    cur.push(w);
    if (/[.,?!:;—]$/.test(w.w)) flush();
  }
  flush();
  return chunks.map((ws, i) => {
    const next = chunks[i + 1], last = ws[ws.length - 1];
    let end = next ? next[0].t : last.e + 0.8;
    if (end - last.e > 0.7) end = last.e + 0.5;
    return { ws, t0: ws[0].t - 0.05, t1: end };
  });
})();

function drawCaptions(T) {
  if (CAPTIONS.off) return;
  const ch = CHUNKS.find(c => T >= c.t0 && T < c.t1);
  if (!ch) return;
  const size = CAPTIONS.size, y = H * CAPTIONS.y;
  ctx.save();
  ctx.font = font(size, 800); ctx.textBaseline = 'middle';
  const clean = w => w.replace(/\s[—–-]$/, '');
  const widths = ch.ws.map(w => ctx.measureText(clean(w.w)).width);
  const gap = size * 0.38;
  let x = W / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (ch.ws.length - 1)) / 2;
  // karaoke: the whole chunk is visible, a word turns yellow when it is spoken and stays yellow
  const pin = E.outC(remap(T, ch.t0, ch.t0 + 0.15));
  ch.ws.forEach((w, i) => {
    const p = remap(T, w.t - 0.06, w.t + 0.16), said = T >= w.t - 0.06;
    const s = said ? lerp(1.12, 1, E.outC(p)) : 1;
    ctx.save();
    ctx.translate(x + widths[i] / 2, y + (1 - pin) * 18); ctx.scale(s, s); ctx.globalAlpha = pin;
    ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    ctx.lineWidth = 16; ctx.strokeStyle = 'rgba(12,8,40,0.85)'; ctx.strokeText(clean(w.w), 0, 4);
    ctx.fillStyle = said ? C.yellow : '#ffffff'; ctx.fillText(clean(w.w), 0, 0);
    ctx.restore();
    x += widths[i] + gap;
  });
  ctx.restore();
}

// ---------- frame ----------
function renderFrame(T) {
  T = clamp(T, 0, TOTAL);
  ctx.save();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  let k = 0;
  while (k < SCENES.length - 1 && T >= B[k + 1]) k++;
  let handled = false;
  for (const kb of [k, k + 1]) {
    if (kb <= 0 || kb >= SCENES.length) continue;
    const td = SCENES[kb].transDur || TD, a0 = B[kb] - td / 2;
    if (T >= a0 && T < a0 + td) {
      drawScene(ctxA, kb - 1, T); drawScene(ctxB, kb, T);
      composite(SCENES[kb].trans || 'iris', (T - a0) / td, T, kb);
      handled = true; break;
    }
  }
  if (!handled) drawScene(ctx, k, T);
  vignette(ctx, 0.45);
  drawCaptions(T);
  ctx.restore();
}

// ---------- SFX cues: whoosh on every transition + scene.sfx(add). Library sounds: _pipeline/sfx_library/index.md ----------
function buildSFX() {
  const ev = [];
  // add(t, 'pop' | 'lib:whoosh/15-quick-a', gain, 'peak'?) — 'peak' puts the library sound's loudest point at t
  let scene = 0;   // which scene is adding cues (0-based) — the review UI shows it and Claude uses it to find the cue
  const add = (t, type, gain = 1, align) => ev.push(Object.assign({ t: +Math.max(0, t).toFixed(3), type, gain, scene }, align ? { align } : {}));
  for (let k = 1; k < SCENES.length; k++) {   // automatic transition whooshes (origin 'transition'; scene.noWhoosh turns one off)
    scene = k;
    if (SCENES[k].trans === 'cut' || SCENES[k].noWhoosh) continue;
    // TRANS_WHOOSH (optional, in scenes.js) = library sound with its peak on the cut, e.g. 'lib:whoosh/15-quick-a'
    if (SCENES[k].trans === 'crumple') add(B[k] - (SCENES[k].transDur || TD) / 2, 'lib:other/paper-crumble-1|0.25|0.9', 0.35);
    else if (typeof TRANS_WHOOSH !== 'undefined') add(B[k], TRANS_WHOOSH, 0.5, 'peak'); else add(B[k] - 0.45, 'whoosh', 0.9);
    ev[ev.length - 1].origin = 'transition';
  }
  SCENES.forEach((s, k) => { scene = k; s.sfx && s.sfx(add, B[k], B[k + 1]); });
  return ev.sort((a, b) => a.t - b.t);
}

// ---------- thumbnail: THUMBNAIL = { draw(ctx) } in scenes.js, or { t: seconds } to reuse a frame ----------
function renderThumb(i = 0) {
  const list = typeof THUMBNAILS !== 'undefined' ? THUMBNAILS : [(typeof THUMBNAIL !== 'undefined' && THUMBNAIL) || { t: 0 }];
  const TH = list[i] || list[0];
  ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (TH.draw) { TH.draw(ctx); vignette(ctx, 0.35); }
  else { let k = 0; while (k < SCENES.length - 1 && TH.t >= B[k + 1]) k++; drawScene(ctx, k, TH.t || 0); vignette(ctx, 0.45); }
  ctx.restore();
}

window.renderFrame = renderFrame;
window.renderThumb = renderThumb;
window.THUMB_COUNT = () => (typeof THUMBNAILS !== 'undefined' ? THUMBNAILS.length : 1);
window.READY = READY;
window.TOTAL = TOTAL;
window.getSFX = buildSFX;

// ---------- simple preview (index.html?preview) ----------
if (location.search.includes('preview')) {
  document.body.classList.add('preview');
  const scrub = document.getElementById('scrub'), tl = document.getElementById('tl'), btn = document.getElementById('play');
  scrub.max = TOTAL;
  let playing = false, t0 = 0, tStart = 0;
  const show = T => { renderFrame(T); tl.textContent = T.toFixed(2); };
  scrub.oninput = () => show(+scrub.value);
  btn.onclick = () => { playing = !playing; btn.textContent = playing ? '❚❚' : '▶'; t0 = performance.now(); tStart = +scrub.value; };
  const loop = () => {
    if (playing) { const T = tStart + (performance.now() - t0) / 1000; scrub.value = T; show(T); if (T >= TOTAL) playing = false; }
    requestAnimationFrame(loop);
  };
  READY.then(() => { show(0); loop(); });
}
