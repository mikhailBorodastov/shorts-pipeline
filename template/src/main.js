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
  return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => { console.warn('missing asset', src); res(null); }; im.src = src; });
}
const READY = (async () => {
  const A = (typeof ASSETS !== 'undefined' && ASSETS) || {};
  const jobs = [];
  for (const k in A.images || {}) jobs.push(loadImg(A.images[k]).then(im => (IMG[k] = im)));
  for (const k in A.sequences || {}) {
    const { pattern, count } = A.sequences[k];
    SEQ[k] = [];
    for (let i = 0; i < count; i++) {
      const src = pattern.replace(/%0(\d)d/, (_, n) => String(i).padStart(+n, '0'));
      jobs.push(loadImg(src).then(im => (SEQ[k][i] = im)));
    }
  }
  await Promise.all(jobs);
  await Promise.all([font(40, 900), font(40, 800), font(40, 600)].map(f => document.fonts.load(f, 'Абв')));
  await document.fonts.load('20px PressStart', 'A');
  await document.fonts.ready;
  return true;
})();
// frame i of a sequence (wraps around)
function seqFrame(key, i) { const s = SEQ[key]; if (!s || !s.length) return null; return s[((i % s.length) + s.length) % s.length]; }

// ---------- timeline ----------
// scene k covers [B[k], B[k+1]); boundaries follow the voice-over sections (scene k <-> section k)
const B = SCENES.map((_, k) => (k === 0 ? 0 : VO.sections[Math.min(k, VO.sections.length - 1)].start - 0.2));
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

// Transition types (set `trans` on the INCOMING scene): iris | push | slide | zoom | zoomOut | wipe | cut
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
  ch.ws.forEach((w, i) => {
    if (T >= w.t - 0.06) {
      const p = remap(T, w.t - 0.06, w.t + 0.16);
      const s = lerp(0.6, 1, E.outBackBig(p));
      ctx.save();
      ctx.translate(x + widths[i] / 2, y + (1 - E.outC(p)) * 18); ctx.scale(s, s);
      ctx.textAlign = 'center'; ctx.lineJoin = 'round';
      ctx.lineWidth = 16; ctx.strokeStyle = 'rgba(12,8,40,0.85)'; ctx.strokeText(clean(w.w), 0, 4);
      ctx.fillStyle = T < w.e + 0.05 ? C.yellow : '#ffffff'; ctx.fillText(clean(w.w), 0, 0);
      ctx.restore();
    }
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
    if (typeof TRANS_WHOOSH !== 'undefined') add(B[k], TRANS_WHOOSH, 0.5, 'peak'); else add(B[k] - 0.45, 'whoosh', 0.9);
    ev[ev.length - 1].origin = 'transition';
  }
  SCENES.forEach((s, k) => { scene = k; s.sfx && s.sfx(add, B[k], B[k + 1]); });
  return ev.sort((a, b) => a.t - b.t);
}

window.renderFrame = renderFrame;
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
