// Characters: round hedgehogs (a ball body with spikes, big joined eyes, thin limbs).
// drawHog(ctx, x, y, s, opts) — (x, y) is the body centre, s is the body radius. Faces right; dir:-1 mirrors.
const HOG_SKINS = {
  main:   { body: '#f0954a', rim: '#ffd3a1', shade: '#c56a2a', spike: '#8a4524', spike2: '#a85a30', face: '#ffe6c2', limb: '#8a4524', nose: '#3a1d2e', shoe: '#e0403f' },
  blue:   { body: '#5aa9ff', rim: '#c9e4ff', shade: '#3a7ad6', spike: '#2a4fb5', spike2: '#3a63cc', face: '#e3f1ff', limb: '#2a4fb5', nose: '#1a2350', shoe: '#ffd23f' },
  pink:   { body: '#ff8fc0', rim: '#ffd6e9', shade: '#d9669a', spike: '#b23a72', spike2: '#c9508a', face: '#ffe8f2', limb: '#b23a72', nose: '#4a1330', shoe: '#7b2ff7' },
  green:  { body: '#5fd27a', rim: '#c8f7d0', shade: '#3aa55a', spike: '#23804a', spike2: '#2f9a58', face: '#eaffdf', limb: '#23804a', nose: '#123a20', shoe: '#ff8a1f' },
  violet: { body: '#9b7bff', rim: '#ddd1ff', shade: '#7458e0', spike: '#4f36b8', spike2: '#6146cc', face: '#f1ebff', limb: '#4f36b8', nose: '#221447', shoe: '#22e1ff' },
  shadow: { body: '#0d1020', rim: '#3a5aa8', shade: '#05060d', spike: '#080a16', spike2: '#0e1226', face: '#0d1020', limb: '#0d1020', nose: '#000', shoe: '#0d1020' },
  tan:    { body: '#e8b08a', rim: '#ffe2cc', shade: '#c4855e', spike: '#6b4a3a', spike2: '#7d5846', face: '#ffe0c6', limb: '#e0a27a', nose: '#3a1d2e', shoe: '#1c1c28' },
  grey:   { body: '#b9bdd4', rim: '#f2f3fa', shade: '#8e93b0', spike: '#5f6488', spike2: '#71769a', face: '#f5f6fb', limb: '#5f6488', nose: '#23253a', shoe: '#ff3b5c' },
};

function hogSpikes(ctx, s, sk, t, wob) {
  // spikes over the back and the top of the head, swept backwards
  const n = 12, a0 = -0.1 * Math.PI, a1 = -1.25 * Math.PI;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = lerp(a0, a1, (i + pass * 0.5) / n);
      const len = (pass ? 1.26 : 1.4) + (i % 2 ? -0.06 : 0.04) + Math.sin(t * 6 + i) * 0.02 * wob;
      const w = 0.17, sweep = -0.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - w) * 0.8 * s, Math.sin(a - w) * 0.8 * s);
      ctx.lineTo(Math.cos(a + sweep) * len * s, Math.sin(a + sweep) * len * s);
      ctx.lineTo(Math.cos(a + w) * 0.8 * s, Math.sin(a + w) * 0.8 * s);
      ctx.closePath();
      ctx.fillStyle = pass ? sk.spike2 : sk.spike; ctx.strokeStyle = ctx.fillStyle;
      ctx.lineJoin = 'round'; ctx.lineWidth = 0.08 * s;
      ctx.fill(); ctx.stroke();
    }
  }
}

function hogLimb(ctx, x0, y0, ang, len, s, sk, end) {
  const x1 = x0 + Math.sin(ang) * len * s, y1 = y0 + Math.cos(ang) * len * s;
  ctx.strokeStyle = sk.limb; ctx.lineWidth = 0.1 * s; ctx.lineCap = 'round';
  if (sk.tat && end === 'hand') ctx.lineWidth = 0.16 * s;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  if (end === 'hand') circle(ctx, x1, y1, (sk.tat ? 0.15 : 0.12) * s, sk.limb);
  if (sk.tat && end === 'hand') {           // tattoo sleeve: ink bands and stars along the arm
    ctx.save(); ctx.strokeStyle = sk.tat; ctx.lineWidth = 0.035 * s;
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    for (let k = 1; k <= 4; k++) {
      const f = k / 5, cx = x0 + dx * f, cy = y0 + dy * f, hw = 0.07 * s;
      if (k % 2) { ctx.beginPath(); ctx.moveTo(cx - nx * hw, cy - ny * hw); ctx.lineTo(cx + nx * hw, cy + ny * hw); ctx.stroke(); }
      else starShape(ctx, cx, cy, 0.05 * s, 0.022 * s, sk.tat);
    }
    ctx.restore();
  }
  if (end === 'shoe') { ellipse(ctx, x1 + 0.08 * s, y1 + 0.02 * s, 0.2 * s, 0.11 * s, 0, sk.shoe); ellipse(ctx, x1 + 0.12 * s, y1 - 0.02 * s, 0.08 * s, 0.035 * s, 0, 'rgba(255,255,255,0.45)'); }
  return [x1, y1];
}

/**
 * o: { skin, dir(1|-1), rot, sq (squash -1..1), look:[x,y], eye (scale), blink(0..1),
 *      mouth(0..1 open), sad(bool), brows (-1 angry .. 1 surprised),
 *      armF, armB (rad: 0 = hanging down, + = swing forward/up, ~2.8 = raised over the head; armB negative = backward),
 *      walk (phase, sec), prop:'gavel'|'sword'|'scythe'|'mic'|'flag'|'wand', propRot, hat:'cap'|'crown'|'cowboy'|'party'|'top' (+hatBand),
 *      glasses(bool), scarf(color), sparkle(0..1), t, alpha, feet(bool) }
 */
function drawHog(ctx, x, y, s, o = {}) {
  let sk = HOG_SKINS[o.skin || 'main'] || HOG_SKINS.main;
  if (o.tattoo) sk = Object.assign({}, sk, { tat: o.tattoo === true ? '#26314f' : o.tattoo });
  const faceless = !!o.faceless;
  const t = o.t || 0;
  ctx.save();
  ctx.translate(x, y);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  ctx.rotate(o.rot || 0);
  const sq = o.sq || 0;
  ctx.scale((o.dir || 1) * (1 + sq * 0.5), 1 - sq * 0.5);

  const walk = o.walk != null ? Math.sin(o.walk * TAU * 1.6) : 0;
  const armF = o.armF != null ? o.armF : 0.75 + walk * 0.3;
  const armB = o.armB != null ? o.armB : -0.75 - walk * 0.3;

  // back limbs
  if (o.feet !== false) hogLimb(ctx, -0.25 * s, 0.82 * s, -walk * 0.45, 0.3, s, sk, 'shoe');
  const behind = !!o.armsBehind;
  if (behind) hogLimb(ctx, -0.8 * s, 0.3 * s, armB, 0.6, s, sk, 'hand');
  else hogLimb(ctx, -0.62 * s, 0.5 * s, armB, 0.55, s, sk, 'hand');   // shoulders sit on the ball's edge
  const handBehind = behind ? hogLimb(ctx, 0.82 * s, 0.3 * s, armF, 0.6, s, sk, 'hand') : null;

  if (!o.bald) hogSpikes(ctx, s, sk, t, 1);

  // body with rim light
  ctx.save();
  circle(ctx, 0, 0, s); ctx.fillStyle = sk.rim; ctx.fill();
  ctx.clip();
  circle(ctx, 0.05 * s, 0.05 * s, s, sk.body);
  ctx.globalAlpha *= 0.5;
  ellipse(ctx, 0.1 * s, 0.75 * s, 1.1 * s, 0.45 * s, 0, sk.shade);
  ctx.globalAlpha /= 0.5;
  // face patch
  if (!faceless) ellipse(ctx, 0.33 * s, 0.14 * s, 0.66 * s, 0.64 * s, 0, sk.face);
  if (o.bald) {                                 // shaved head: shine + stubble
    ctx.save(); ctx.globalAlpha *= 0.55; ellipse(ctx, -0.2 * s, -0.62 * s, 0.32 * s, 0.14 * s, -0.5, '#fff'); ctx.restore();
    ctx.fillStyle = 'rgba(80,50,40,0.35)';
    for (let k = 0; k < 26; k++) { const a = -2.9 + k * 0.1, r = 0.9 + (k % 3) * 0.03; ctx.fillRect(Math.cos(a) * r * s, Math.sin(a) * r * s, 0.025 * s, 0.025 * s); }
  }
  if (o.tattoo && !faceless) {                  // body tattoos on the back/side
    ctx.save(); ctx.strokeStyle = sk.tat; ctx.lineWidth = 0.035 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(-0.55 * s, 0.1 * s, 0.18 * s, 0.3, 5.5); ctx.stroke();
    starShape(ctx, -0.5 * s, -0.45 * s, 0.1 * s, 0.045 * s, sk.tat);
    ctx.beginPath(); ctx.moveTo(-0.85 * s, 0.35 * s); ctx.quadraticCurveTo(-0.6 * s, 0.55 * s, -0.3 * s, 0.4 * s); ctx.stroke();
    ctx.restore();
  }
  if (o.suit) {                                 // dark jacket + shirt + tie
    poly(ctx, [[-1.2 * s, 0.35 * s], [1.2 * s, 0.35 * s], [1.2 * s, 1.2 * s], [-1.2 * s, 1.2 * s]], o.suit);
    poly(ctx, [[0.25 * s, 0.35 * s], [0.75 * s, 0.35 * s], [0.5 * s, 0.85 * s]], '#e8ecf7');
    if (o.tie !== false) poly(ctx, [[0.45 * s, 0.4 * s], [0.55 * s, 0.4 * s], [0.58 * s, 0.75 * s], [0.5 * s, 0.85 * s], [0.42 * s, 0.75 * s]], o.tie || C.red);
  }
  if (o.vest) {                                 // tactical vest with pouches
    poly(ctx, [[-1.2 * s, 0.3 * s], [1.2 * s, 0.3 * s], [1.2 * s, 1.2 * s], [-1.2 * s, 1.2 * s]], o.vest);
    for (const px of [-0.2, 0.15, 0.5]) { rr(ctx, px * s, 0.42 * s, 0.26 * s, 0.24 * s, 0.05 * s); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill(); }
  }
  if (o.scarf) { ctx.fillStyle = o.scarf; ctx.fillRect(-1.2 * s, 0.62 * s, 2.4 * s, 0.16 * s); }
  ctx.restore();
  if (faceless) {                               // silhouette: only the snout shape, no face
    ellipse(ctx, 0.78 * s, 0.12 * s, 0.26 * s, 0.2 * s, 0, sk.body);
    circle(ctx, 0.98 * s, 0.06 * s, 0.13 * s, sk.body);
  } else {

  if (o.beard) {                                // beard around the jaw
    ctx.beginPath(); ctx.moveTo(0.3 * s, 0.3 * s);
    ctx.quadraticCurveTo(0.32 * s, 0.68 * s, 0.62 * s, 0.68 * s);
    ctx.quadraticCurveTo(0.92 * s, 0.64 * s, 0.98 * s, 0.24 * s);
    ctx.quadraticCurveTo(0.64 * s, 0.5 * s, 0.3 * s, 0.3 * s); ctx.closePath();
    ctx.fillStyle = o.beard; ctx.fill();
  }
  // snout + nose
  ellipse(ctx, 0.78 * s, 0.12 * s, 0.26 * s, 0.2 * s, 0, sk.face);
  circle(ctx, 0.98 * s, 0.06 * s, 0.13 * s, sk.nose);
  circle(ctx, 0.94 * s, 0.02 * s, 0.04 * s, 'rgba(255,255,255,0.7)');

  // cheek
  ctx.save(); ctx.globalAlpha *= 0.45; ellipse(ctx, 0.2 * s, 0.25 * s, 0.14 * s, 0.09 * s, 0, '#ff6f91'); ctx.restore();

  // mouth
  const m = o.mouth || 0;
  ctx.strokeStyle = sk.nose; ctx.lineWidth = 0.06 * s; ctx.lineCap = 'round';
  if (m > 0.05) {
    ctx.beginPath();
    ctx.moveTo(0.42 * s, 0.34 * s);
    ctx.quadraticCurveTo(0.62 * s, (0.34 + 0.5 * m) * s, 0.84 * s, 0.3 * s);
    ctx.closePath();
    ctx.fillStyle = '#7a1f3a'; ctx.fill();
    ctx.save(); ctx.clip(); ellipse(ctx, 0.63 * s, (0.36 + 0.4 * m) * s, 0.14 * s, 0.1 * s, 0, '#ff7a9a'); ctx.restore();
  } else {
    ctx.beginPath();
    if (o.sad) { ctx.moveTo(0.48 * s, 0.42 * s); ctx.quadraticCurveTo(0.63 * s, 0.3 * s, 0.8 * s, 0.4 * s); }
    else { ctx.moveTo(0.45 * s, 0.32 * s); ctx.quadraticCurveTo(0.63 * s, 0.46 * s, 0.82 * s, 0.3 * s); }
    ctx.stroke();
  }

  // eyes: two big ovals touching each other
  const es = o.eye || 1, bl = o.blink || 0, lk = o.look || [0.3, 0];
  const eye = (ex, ey, rx, ry) => {
    ctx.save(); ctx.translate(ex, ey); ctx.scale(1, Math.max(0.08, 1 - bl));
    ellipse(ctx, 0, 0, rx, ry, 0, '#fff');
    ctx.lineWidth = 0.035 * s; ctx.strokeStyle = 'rgba(40,20,60,0.25)'; ctx.stroke();
    const pr = rx * 0.52 / Math.sqrt(es);
    const px = lk[0] * rx * 0.4, py = lk[1] * ry * 0.4 + ry * 0.12;
    circle(ctx, px, py, pr, '#1a0f2e');
    circle(ctx, px - pr * 0.35, py - pr * 0.4, pr * 0.38, '#fff');
    ctx.restore();
  };
  eye(0.2 * s, -0.3 * s, 0.2 * s * es, 0.28 * s * es);
  eye(0.6 * s, -0.3 * s, 0.22 * s * es, 0.3 * s * es);
  if (o.shades) {
    ctx.fillStyle = '#0a0a12';
    rr(ctx, 0.0, -0.46 * s, 0.42 * s, 0.3 * s, 0.1 * s); ctx.fill();
    rr(ctx, 0.42 * s, -0.46 * s, 0.4 * s, 0.3 * s, 0.1 * s); ctx.fill();
    ctx.fillStyle = 'rgba(120,160,255,0.5)'; ctx.fillRect(0.08 * s, -0.42 * s, 0.12 * s, 0.05 * s); ctx.fillRect(0.5 * s, -0.42 * s, 0.12 * s, 0.05 * s);
  }
  if (o.glasses) {
    ctx.lineWidth = 0.06 * s; ctx.strokeStyle = '#2a1a3e';
    ellipse(ctx, 0.2 * s, -0.3 * s, 0.26 * s, 0.32 * s); ctx.stroke();
    ellipse(ctx, 0.6 * s, -0.3 * s, 0.27 * s, 0.33 * s); ctx.stroke();
  }
  if (o.brows != null) {
    ctx.strokeStyle = sk.spike; ctx.lineWidth = 0.07 * s; ctx.lineCap = 'round';
    const b = o.brows;
    for (const [bx, dirB] of [[0.2, -1], [0.6, 1]]) {
      ctx.beginPath();
      ctx.moveTo((bx - 0.14) * s, (-0.66 - (dirB < 0 ? b : -b) * 0.06 - b * 0.06) * s);
      ctx.lineTo((bx + 0.14) * s, (-0.66 - (dirB > 0 ? b : -b) * 0.06 - b * 0.06) * s);
      ctx.stroke();
    }
  }

  }
  if (o.payot) {                                // curled sidelocks at the temple
    ctx.save(); ctx.strokeStyle = o.payot === true ? '#2a1a12' : o.payot; ctx.lineWidth = 0.055 * s; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k <= 40; k++) {
      const u = k / 40, a = u * TAU * 3, px = 0.0 + Math.cos(a) * 0.07, py = -0.15 + u * 0.65 + Math.sin(a) * 0.035;
      ctx[k ? 'lineTo' : 'moveTo'](px * s, py * s);
    }
    ctx.stroke(); ctx.restore();
  }
  if (o.chain) {                                // gold chain + pendant
    ctx.save(); ctx.strokeStyle = C.gold; ctx.lineWidth = 0.07 * s; glow(ctx, C.gold, 0.3 * s);
    ctx.setLineDash([0.08 * s, 0.04 * s]);
    ctx.lineWidth = 0.05 * s;
    ctx.beginPath(); ctx.moveTo(-0.55 * s, 0.62 * s); ctx.quadraticCurveTo(0.2 * s, 1.05 * s, 0.8 * s, 0.68 * s); ctx.stroke();
    ctx.setLineDash([]); circle(ctx, 0.2 * s, 0.92 * s, 0.09 * s, C.gold); ctx.restore();
  }
  if (o.badge) {                                // name badge on the chest
    rr(ctx, 0.0, 0.5 * s, 0.62 * s, 0.2 * s, 0.05 * s); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = C.red; ctx.fillRect(0.0, 0.5 * s, 0.62 * s, 0.05 * s);
    ctx.font = font(0.11 * s, 900); ctx.fillStyle = '#141a2e'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(o.badge, 0.31 * s, 0.63 * s);
  }
  // hats
  if (o.hat === 'fedora') {                     // black wide-brim hat
    ellipse(ctx, 0.2 * s, -0.8 * s, 0.95 * s, 0.15 * s, -0.06, '#0d0d12');
    rr(ctx, -0.25 * s, -1.35 * s, 0.9 * s, 0.58 * s, 0.22 * s); ctx.fillStyle = '#15151c'; ctx.fill();
    ctx.fillStyle = '#26263a'; ctx.fillRect(-0.25 * s, -0.95 * s, 0.9 * s, 0.1 * s);
  } else if (o.hat === 'chef') {
    rr(ctx, -0.1 * s, -1.0 * s, 0.7 * s, 0.25 * s, 0.05 * s); ctx.fillStyle = '#fff'; ctx.fill();
    for (const [cx, cy, r] of [[0.0, -1.15, 0.25], [0.25, -1.3, 0.3], [0.5, -1.15, 0.25]]) circle(ctx, cx * s, cy * s, r * s, '#fff');
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 0.03 * s; ctx.beginPath(); ctx.moveTo(-0.1 * s, -0.95 * s); ctx.lineTo(0.6 * s, -0.95 * s); ctx.stroke();
  } else if (o.hat === 'straw') {
    ellipse(ctx, 0.25 * s, -0.85 * s, 0.95 * s, 0.16 * s, -0.08, '#e9c46a');
    ctx.beginPath(); ctx.ellipse(0.25 * s, -0.88 * s, 0.45 * s, 0.35 * s, -0.08, Math.PI, 0); ctx.fillStyle = '#f2d27f'; ctx.fill();
    ctx.fillStyle = '#c0392b'; ctx.fillRect(-0.2 * s, -0.98 * s, 0.9 * s, 0.08 * s);
  } else if (o.hat === 'kippah') {
    ctx.beginPath(); ctx.ellipse(-0.05 * s, -0.9 * s, 0.4 * s, 0.2 * s, -0.25, Math.PI, 0); ctx.fillStyle = '#1e2a6e'; ctx.fill();
    ctx.strokeStyle = '#e8ecf7'; ctx.lineWidth = 0.03 * s; ctx.beginPath(); ctx.ellipse(-0.05 * s, -0.92 * s, 0.3 * s, 0.1 * s, -0.25, Math.PI, 0); ctx.stroke();
  } else if (o.hat === 'helmet') {
    ctx.beginPath(); ctx.arc(0.1 * s, -0.35 * s, 0.95 * s, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fillStyle = '#20263a'; ctx.fill();
    rr(ctx, -0.85 * s, -0.45 * s, 1.9 * s, 0.14 * s, 0.07 * s); ctx.fillStyle = '#161b2b'; ctx.fill();
    ctx.save(); glow(ctx, C.cyan, 0.4 * s); rr(ctx, 0.05 * s, -0.4 * s, 0.9 * s, 0.1 * s, 0.05 * s); ctx.fillStyle = 'rgba(34,225,255,0.85)'; ctx.fill(); ctx.restore();
  } else if (o.hat === 'cap') {
    ctx.beginPath(); ctx.arc(0.25 * s, -0.72 * s, 0.5 * s, Math.PI, 0); ctx.fillStyle = C.red; ctx.fill();
    ellipse(ctx, 0.75 * s, -0.72 * s, 0.35 * s, 0.08 * s, 0, '#b8123e');
  } else if (o.hat === 'crown') {
    poly(ctx, [[-0.15 * s, -0.8 * s], [-0.1 * s, -1.25 * s], [0.1 * s, -1.0 * s], [0.3 * s, -1.3 * s], [0.5 * s, -1.0 * s], [0.7 * s, -1.25 * s], [0.75 * s, -0.8 * s]], C.gold);
  } else if (o.hat === 'cowboy') {
    ellipse(ctx, 0.3 * s, -0.86 * s, 0.9 * s, 0.14 * s, -0.08, '#a0522d');
    rr(ctx, -0.05 * s, -1.35 * s, 0.7 * s, 0.52 * s, 0.2 * s); ctx.fillStyle = '#b8652a'; ctx.fill();
  } else if (o.hat === 'top') {                 // magician's top hat (o.hatBand: text on the band)
    ellipse(ctx, 0.25 * s, -0.84 * s, 0.85 * s, 0.13 * s, -0.06, '#0d0b18');
    rr(ctx, -0.18 * s, -1.75 * s, 0.86 * s, 0.95 * s, 0.06 * s); ctx.fillStyle = '#171429'; ctx.fill();
    ctx.fillStyle = o.hatBandColor || C.magenta; ctx.fillRect(-0.18 * s, -1.02 * s, 0.86 * s, 0.16 * s);
    if (o.hatBand) { ctx.font = font(0.13 * s, 900); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.hatBand, 0.25 * s, -0.935 * s); }
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(-0.1 * s, -1.7 * s, 0.1 * s, 0.6 * s);
  } else if (o.hat === 'party') {
    poly(ctx, [[0.0, -0.8 * s], [0.25 * s, -1.55 * s], [0.5 * s, -0.8 * s]], C.magenta);
    circle(ctx, 0.25 * s, -1.58 * s, 0.1 * s, C.yellow);
  }

  // front limbs + prop
  if (o.feet !== false) hogLimb(ctx, 0.25 * s, 0.86 * s, walk * 0.45, 0.3, s, sk, 'shoe');
  const sh = o.shoulderF || [0.66, 0.52];
  const hand = handBehind || hogLimb(ctx, sh[0] * s, sh[1] * s, armF, 0.55, s, sk, 'hand');
  if (o.prop) drawProp(ctx, o.prop, hand[0], hand[1], s, o.propRot || 0, t);
  ctx.restore();

  if (o.sparkle) {
    for (let i = 0; i < 4; i++) {
      const ang = t * 1.5 + i * TAU / 4;
      sparkle(ctx, x + Math.cos(ang) * s * 1.8, y - s * 0.3 + Math.sin(ang) * s * 1.2, s * 0.18 * (0.6 + 0.4 * Math.sin(t * 5 + i)), C.yellow, o.sparkle);
    }
  }
}

function sparkle(ctx, x, y, r, color, a = 1) {
  ctx.save(); ctx.globalAlpha *= a;
  glow(ctx, color, r * 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r); ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r); ctx.fill();
  ctx.restore();
}

// hand-held props, drawn at the hand position (x, y)
function drawProp(ctx, kind, x, y, s, rot, t) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  if (kind === 'wand') {                        // magic wand with a glowing tip
    rr(ctx, -0.04 * s, -0.95 * s, 0.08 * s, 0.95 * s, 0.03 * s); ctx.fillStyle = '#111'; ctx.fill();
    rr(ctx, -0.045 * s, -0.95 * s, 0.09 * s, 0.18 * s, 0.03 * s); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.save(); glow(ctx, C.yellow, 0.5 * s); circle(ctx, 0, -1.0 * s, 0.07 * s, '#fff8c0'); ctx.restore();
  } else if (kind === 'gavel') {
    rr(ctx, -0.05 * s, -0.9 * s, 0.1 * s, 0.9 * s, 0.04 * s); ctx.fillStyle = '#8a4b1f'; ctx.fill();
    rr(ctx, -0.32 * s, -1.12 * s, 0.64 * s, 0.3 * s, 0.08 * s); ctx.fillStyle = '#b8652a'; ctx.fill();
  } else if (kind === 'sword') {
    glow(ctx, '#bfe9ff', 25);
    poly(ctx, [[-0.07 * s, -0.25 * s], [0.07 * s, -0.25 * s], [0.07 * s, -1.9 * s], [0, -2.1 * s], [-0.07 * s, -1.9 * s]], '#e8f6ff');
    noGlow(ctx);
    rr(ctx, -0.3 * s, -0.3 * s, 0.6 * s, 0.1 * s, 0.05 * s); ctx.fillStyle = C.gold; ctx.fill();
    rr(ctx, -0.05 * s, -0.22 * s, 0.1 * s, 0.35 * s, 0.04 * s); ctx.fillStyle = '#5b3a1a'; ctx.fill();
  } else if (kind === 'scythe') {
    rr(ctx, -0.04 * s, -1.9 * s, 0.08 * s, 2.3 * s, 0.04 * s); ctx.fillStyle = '#3b2a6b'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -1.85 * s);
    ctx.quadraticCurveTo(-0.9 * s, -2.1 * s, -1.3 * s, -1.35 * s);
    ctx.quadraticCurveTo(-0.8 * s, -1.75 * s, 0, -1.6 * s); ctx.closePath();
    ctx.fillStyle = '#e3d6ff'; ctx.fill();
  } else if (kind === 'mic') {
    rr(ctx, -0.06 * s, -0.5 * s, 0.12 * s, 0.55 * s, 0.05 * s); ctx.fillStyle = '#2d2d38'; ctx.fill();
    circle(ctx, 0, -0.58 * s, 0.16 * s, '#b9bdd9');
  } else if (kind === 'rifle') {              // stylised carbine, barrel pointing forward
    ctx.fillStyle = '#1a1e2c';
    rr(ctx, -0.5 * s, -0.12 * s, 1.5 * s, 0.2 * s, 0.05 * s); ctx.fill();
    rr(ctx, 0.9 * s, -0.08 * s, 0.7 * s, 0.08 * s, 0.03 * s); ctx.fill();
    poly(ctx, [[-0.5 * s, -0.1 * s], [-0.95 * s, 0.0], [-0.95 * s, 0.28 * s], [-0.45 * s, 0.1 * s]], '#1a1e2c');
    ctx.fillStyle = '#1a1e2c'; rr(ctx, 0.25 * s, 0.05 * s, 0.16 * s, 0.4 * s, 0.04 * s); ctx.fill();
    ctx.fillStyle = C.red; ctx.globalAlpha *= 0.8; ctx.fillRect(-0.45 * s, -0.12 * s, 1.4 * s, 0.03 * s);
  } else if (kind === 'shears') {            // garden shears
    ctx.strokeStyle = '#c9d2e0'; ctx.lineWidth = 0.09 * s; ctx.lineCap = 'round';
    for (const a of [-0.25, 0.25]) { ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -1.0 * s); ctx.stroke(); ctx.restore(); }
    ctx.strokeStyle = '#2f9a58'; ctx.lineWidth = 0.13 * s;
    for (const a of [-0.25, 0.25]) { ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(0, 0.05 * s); ctx.lineTo(0, 0.45 * s); ctx.stroke(); ctx.restore(); }
  } else if (kind === 'mop') {
    rr(ctx, -0.04 * s, -1.6 * s, 0.08 * s, 2.0 * s, 0.04 * s); ctx.fillStyle = '#c28a4e'; ctx.fill();
    rr(ctx, -0.35 * s, -1.72 * s, 0.7 * s, 0.14 * s, 0.05 * s); ctx.fillStyle = '#3b82f6'; ctx.fill();
    ctx.strokeStyle = '#e8ecf7'; ctx.lineWidth = 0.07 * s; ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) { const x = (-0.3 + k * 0.1) * s; ctx.beginPath(); ctx.moveTo(x, -1.72 * s); ctx.quadraticCurveTo(x + 0.05 * s, -1.95 * s, x - 0.02 * s, -2.1 * s); ctx.stroke(); }
  } else if (kind === 'ladle') {
    rr(ctx, -0.04 * s, -1.0 * s, 0.08 * s, 1.1 * s, 0.04 * s); ctx.fillStyle = '#c9d2e0'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, -1.05 * s, 0.22 * s, Math.PI, 0, true); ctx.closePath(); ctx.fillStyle = '#c9d2e0'; ctx.fill();
  } else if (kind === 'phone') {
    glow(ctx, '#9fd4ff', 0.8 * s);
    rr(ctx, -0.16 * s, -0.55 * s, 0.32 * s, 0.56 * s, 0.06 * s); ctx.fillStyle = '#cfe8ff'; ctx.fill();
  } else if (kind === 'glass') {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 0.04 * s;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -0.35 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-0.16 * s, -0.75 * s); ctx.quadraticCurveTo(0, -0.2 * s, 0.16 * s, -0.75 * s); ctx.closePath();
    ctx.fillStyle = 'rgba(255,190,90,0.85)'; ctx.fill(); ctx.stroke();
  } else if (kind === 'book') {
    poly(ctx, [[-0.45 * s, -0.1 * s], [0, 0.0], [0, -0.45 * s], [-0.45 * s, -0.55 * s]], '#f4efe2');
    poly(ctx, [[0.45 * s, -0.1 * s], [0, 0.0], [0, -0.45 * s], [0.45 * s, -0.55 * s]], '#fffaf0');
    ctx.strokeStyle = '#1e2a6e'; ctx.lineWidth = 0.05 * s; ctx.beginPath(); ctx.moveTo(-0.47 * s, -0.08 * s); ctx.lineTo(0, 0.02 * s); ctx.lineTo(0.47 * s, -0.08 * s); ctx.stroke();
  } else if (kind === 'flag') {
    ctx.fillStyle = '#ddd'; ctx.fillRect(-0.03 * s, -1.4 * s, 0.06 * s, 1.45 * s);
    poly(ctx, [[0.03 * s, -1.4 * s], [(0.75 + Math.sin(t * 6) * 0.05) * s, -1.2 * s], [0.03 * s, -0.95 * s]], C.red);
  }
  ctx.restore();
}
