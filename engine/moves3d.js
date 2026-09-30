// ======================================================================
// moves3d.js — library of reusable 3D moves and effects (stage3d.js). Каталог с описаниями: _pipeline/ANIMATIONS.md.
// Rule: a move invented for a short goes here (generalised) + a line in ANIMATIONS.md, so the next short can reuse it.
// All functions are pure functions of time: call them every frame from world.update(w, lt, D, T).
// Basic ones live in stage3d.js: popUp3 (pop-up book), pop3, flip3 (Paper Mario turn), hop3, gait3 (walk).
// ======================================================================

// ---- motion along an arc: a card / box flies from `a` to `b` (cassettes into a phone, a notification to the hero)
// o: arc (extra height at the middle, m), shrink (0..1 scale lost at the end), spin (turns around z), ease
// returns p (0..1); the object is hidden after arrival when o.hideAfter
function flyTo3(obj, T, t0, d, a, b, o = {}) {
  const raw = remap(T, t0, t0 + d), p = (o.ease || E.inQ)(raw);
  obj.position.set(lerp(a[0], b[0], p), lerp(a[1], b[1], p) + Math.sin(p * Math.PI) * (o.arc || 0), lerp(a[2], b[2], p));
  const s = 1 - p * (o.shrink || 0); obj.scale.setScalar(Math.max(0.0001, s * (o.scale || 1)));
  if (o.spin) obj.rotation.z = p * o.spin * TAU;
  if (o.hideAfter) obj.visible = raw < 1;
  return p;
}

// ---- a paper sheet falls fluttering (cats dropping out of a clock, leaves, flyers)
// p: 0..1 progress of the fall; from [x, y, z]; o: fall (m), drift (m sideways), side (±1), seed
function flutterFall3(c, p, from, o = {}) {
  const side = o.side || 1, sd = o.seed || 0, fall = o.fall || 5;
  c.visible = p > 0 && p < 1;
  c.position.set(from[0] + side * p * (o.drift || 0.9) + Math.sin(p * 8 + sd) * 0.1, from[1] - p * p * fall, from[2] + p * (o.toward || 1.2));
  c.inner.rotation.set(Math.sin(p * 7 + sd) * 0.5, p * 7 * side, p * 3 * side);
  c.inner.scale.setScalar(Math.max(0.0001, Math.min(1, p * 5)));
}

// ---- happy hopping on its own beat (party, celebration); i = index so neighbours are out of phase
function partyHop3(c, T, i = 0, o = {}) {
  const p = ((T * (o.rate || 1.8) + i * 0.37) % 1), y = Math.sin(Math.PI * p) * (o.height || 0.18);
  const sq = p < 0.08 ? 0.08 : 0;
  c.inner.position.y = y; c.inner.scale.set(1 + sq, 1 - sq, 1); c.inner.rotation.z = Math.sin(T * 6 + i) * (o.sway || 0.06);
}

// ---- jump up onto something, then off the edge and out of the frame (the cat leaves the roof)
// t0: start; onto: height of the ledge; dz: distance to the ledge; returns true while visible
function jumpOff3(c, T, t0, from, o = {}) {
  const onto = o.onto == null ? 0.55 : o.onto, dz = o.dz == null ? -1.25 : o.dz;
  const j1 = remap(T, t0, t0 + 0.4), j2 = remap(T, t0 + 0.5, t0 + 1.05);
  c.position.set(from[0], j1 > 0 && j1 < 1 ? Math.sin(Math.PI * j1) * 0.6 + j1 * onto : j1 >= 1 ? onto : from[1], from[2] + dz * E.io(j1));
  if (j2 > 0) { c.position.y = onto + Math.sin(Math.PI * Math.min(1, j2 * 1.3)) * 0.5 - E.inQ(j2) * 4; c.position.z = from[2] + dz - j2 * 1.5; }
  c.visible = j2 < 1;
  return c.visible;
}

// ---- something rises and fades (hearts, notes, «Zzz»); p: 0..1
function riseFade3(c, p, base, o = {}) {
  c.visible = p > 0 && p < 1;
  c.position.set(base[0] + Math.sin(p * 6 + (o.seed || 0)) * (o.wobble || 0.06), base[1] + p * (o.rise || 0.9), base[2]);
  c.inner.scale.setScalar(Math.max(0.0001, Math.sin(Math.PI * p) * (o.scale || 1.2)));
}

// ---- glue a card to a point of another card (party hat on a monster's head, a prop in a paw)
// parent: card with .pt (spriteCard) or any card with [fx, fy] converted by cardPt3; child moves / hops with the parent
function attach3(parent, child, fx, fy, o = {}) {
  const [x, y] = parent.pt ? parent.pt(fx, fy) : [(fx - 0.5) * parent.wW, (1 - fy) * parent.hW - (parent.footW || 0)];
  parent.inner.add(child); child.position.set(x + (o.dx || 0), y + (o.dy || 0), o.dz == null ? 0.015 : o.dz);
  if (o.tilt) child.rotation.z = o.tilt;
  return child;
}

// ---- camera keys that dive onto a flat screen (CRT, phone, poster) and come back
// screen: world centre, normal: facing direction [x, 0, z], dist: distance that fits the screen's width in 9:16
// returns keys for w.camKeys: [.., [tIn, wide], [tIn + 0.4, onto], [tOut, onto], [tOut + 0.45, wide]]
function screenDive3(wide, screen, normal, tIn, tOut, dist = 1.35, fov = 30) {
  const onto = [screen[0] + normal[0] * dist, screen[1] + 0.02, screen[2] + normal[2] * dist];
  return [[tIn, wide[0], wide[1], wide[2]], [tIn + 0.4, onto, screen, fov], [tOut, [onto[0] + 0.01, onto[1], onto[2] - 0.05], screen, fov], [tOut + 0.45, wide[0], wide[1], wide[2]]];
}

// ---- windows light up one after another (the «407» moment); use as buildYard / facade glow `lit(o, lt, seed)`
// order: 0..1 per window (e.g. its random), p: 0..1 progress; returns light 0..1 and marks o.cat for a silhouette
function cascadeLit(order, p, o = {}) {
  if (order < (o.always || 0)) return 1;
  if (order < p) { if (o.mark) o.mark.cat = true; return clamp((p - order) * 12); }
  return 0;
}

// ---- mini-locations inside one voice section: hard paper cuts between worlds (flash + small bounce)
// cuts: [[tStart, world], ...] in absolute time, tEnd: end of the section. Draws into ctx, returns the active index.
function cutSeq3(ctx, T, cuts, tEnd) {
  let i = 0; while (i < cuts.length - 1 && T >= cuts[i + 1][0]) i++;
  const [t0, world] = cuts[i], t1 = i < cuts.length - 1 ? cuts[i + 1][0] : tEnd, q = T - t0;
  ctx.save();
  if (i > 0 && q < 0.22) { const s = lerp(1.12, 1, E.outBack(q / 0.22)); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.rotate((1 - q / 0.22) * 0.025); ctx.translate(-W / 2, -H / 2); }
  world.draw(ctx, q, t1 - t0, T);
  ctx.restore();
  if (i > 0 && q < 0.2) { ctx.fillStyle = `rgba(250,248,240,${0.75 * (1 - q / 0.2)})`; ctx.fillRect(0, 0, W, H); }
  return i;
}

// ---- 2D effects for dynamic card textures (screens, glass) ----
// pixel censorship over a small region of what is already drawn in g (fractions of the canvas)
function mosaic2d(g, fx, fy, fw, fh, blocks = 8) {
  const w = g.canvas.width, h = g.canvas.height, rw = w * fw, rh = h * fh, rx = w * fx - rw / 2, ry = h * fy - rh / 2;
  const m = Math.max(2, Math.round(blocks * rh / rw)), t = scratch('mosaic2d', blocks, m);
  t.getContext('2d').drawImage(g.canvas, rx, ry, rw, rh, 0, 0, blocks, m);
  g.save(); g.imageSmoothingEnabled = false; g.drawImage(t, 0, 0, blocks, m, rx, ry, rw, rh); g.restore();
}
// cracked glass growing from an impact point; p: 0..1
function crackGlass2d(g, cx, cy, p, seed = 77, o = {}) {
  if (p <= 0) return;
  const r = rng(seed), rays = o.rays || 16, seg = o.segments || 7;
  g.save(); g.strokeStyle = o.color || 'rgba(255,255,255,0.9)'; g.lineWidth = o.width || 2.2; g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 3;
  for (let i = 0; i < rays; i++) { let a = i / rays * TAU + r() * 0.3, x = cx, y = cy; g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < seg * p; k++) { a += (r() - 0.5) * 0.5; const L = 30 + r() * 70; x += Math.cos(a) * L; y += Math.sin(a) * L; g.lineTo(x, y); } g.stroke(); }
  for (let k = 1; k <= 3; k++) { if (p < k / 3.2) break; g.beginPath(); for (let i = 0; i <= rays; i++) { const a = i / rays * TAU, rr2 = k * 34 + (r() - 0.5) * 16; g.lineTo(cx + Math.cos(a) * rr2, cy + Math.sin(a) * rr2); } g.stroke(); }
  g.restore();
}
// CRT look: scanlines + REC + running timecode over a video frame
function crtOverlay2d(g, T, o = {}) {
  const w = g.canvas.width, h = g.canvas.height;
  g.fillStyle = 'rgba(0,0,0,0.28)'; for (let y = 0; y < h; y += 5) g.fillRect(0, y, w, 2);
  if (o.rec !== false) { g.font = font(h * 0.08, 800); g.fillStyle = '#ff3a3a'; g.textAlign = 'left'; g.fillText('● REC', w * 0.06, h * 0.12); }
  if (o.timecode !== false) { const s = Math.floor(T * 7 + 7200); g.font = font(h * 0.08, 800); g.fillStyle = '#e8e8e8'; g.textAlign = 'right';
    g.fillText(`${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, w * 0.95, h * 0.94); }
}

// ---- from «Не жми эту кнопку в лифте детской поликлиники» (2026-09-27)
// Paper Mario turn from front (p = 0) to a real back view (p = 1): the card swaps to drawHog({ backView: true })
// (quills instead of the face) at the edge-on moment, so no flat silhouette is ever seen. Needs the toolkit's drawHog with backView.
function turnHog3(h, p) { p = E.io(clamp(p)); h.inner.rotation.y = p < 0.5 ? Math.PI * p : Math.PI * (p - 1); h.hog.backView = p >= 0.5; }
// walk a hogCard from a = [x, z] to b during [t0, t1] (gait + feet); returns the distance walked
function walkTo3(h, lt, t0, t1, a, b, o = {}) {
  const p = (o.ease || (x => x))(remap(lt, t0, t1));
  h.position.x = lerp(a[0], b[0], p); h.position.z = lerp(a[1], b[1], p);
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]) * p;
  if (lt > t0 && lt < t1) h.hog.walk = gait3(h, dist, { stride: o.stride || 0.22, bob: o.bob || 0.03, sway: 0.05 });
  else { h.hog.walk = null; h.inner.position.y = 0; h.inner.rotation.z = 0; }
  return dist;
}
// dolly zoom (Vertigo): camera closes in from dist0 to dist1 on `at` while fov widens so the subject keeps its size.
// call after camKeys: dollyZoom3(w, p, [x, y, z] of the subject, dist0, dist1, fov0)
function dollyZoom3(w, p, at, d0, d1, fov0 = 38, dir = [0, 0, -1], camY = 0.45) {
  const d = lerp(d0, d1, E.io(clamp(p)));
  w.cam.position.set(at[0] - dir[0] * d, camY, at[2] - dir[2] * d); w.target.set(at[0], at[1], at[2]);
  w.cam.fov = 2 * Math.atan(Math.tan(fov0 / 2 * Math.PI / 180) * d0 / d) * 180 / Math.PI;
}

// paper card for any 2D character function of the preproduction: fn(ctx, x, yFeet, size, pose). Change c.pose in update;
// pose.fn swaps the drawing (e.g. costume change on flip3). k = size / canvas height. First used in «Про лыжника».
function artCard(w, fn, o = {}) {
  const px = o.px || [720, 820], foot = o.foot == null ? 24 : o.foot, k = o.k || 0.72;
  let c = null;
  c = w.card({ px, h: o.h || 1.2, pos: o.pos, rotY: o.rotY, rim: o.rim == null ? 7 : o.rim, thick: 0.02, glow: o.glow == null ? 0.3 : o.glow, dynamic: true, foot,
    state: (lt, T) => { const p = (c && c.pose) || {}; return JSON.stringify(p) + (p.fn ? p.fn.name : '') + '|' + Math.round(T * (o.fps || 8)); },
    draw: (g, cw, ch, lt, T) => { const p = (c && c.pose) || {}; (p.fn || fn)(g, cw / 2 + (o.dx || 0) * cw, ch - foot, ch * k, Object.assign({ t: T }, p)); } });
  c.pose = Object.assign({}, o.pose || {});
  c.redraw(0, 0);
  return c;
}
