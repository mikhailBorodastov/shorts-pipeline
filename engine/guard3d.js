// S21 «Сторож монтажа» (docs/studio/stage21-guard.md): страница ролика без картинок прогоняет таймлайн и ищет в 3D-мирах
//   stuck — персонаж / пропс / декорация вошли друг в друга (карточка сквозь карточку, карточка в коробке или модели, коробки внахлёст);
//   pop   — объект в кадре пропал или появился за один кадр (без масштаба, прозрачности, ухода за край);
//   jump  — объект в кадре перескочил на другое место за один кадр.
// Внедряется stands/guard.js (page.addScriptTag) — в html проекта его нет. Чистая функция времени: кадры в любом порядке.
// Не ругается на: склейки сцен и окна переходов, склейки ракурсов внутри мира (камера прыгнула, или разом сменилось 3+ объекта),
// декор, расставленный внахлёст (оба неподвижны всю сцену), прицепы (едут вместе), пары из w.touch('A', 'B') / w.touch('A'), userData.guard = false.
// Только 3D (world3d / ppWorld / сцены монтажа): 2D-рисунок на холсте сторож не видит.
(function () {
  if (window.GUARD) return;
  const V = () => new THREE.Vector3();
  const G = window.GUARD = { dry: true, drawn: [], tracks: new Map(), pairs: new Map(), zf: new Map(), cands: [], dt: 0.1, info: { decor: 0, attached: 0, touch: 0 } };
  if (typeof W3API === 'undefined') { G.none = true; return; }
  if (!W3API.touch) W3API.touch = function (a, b) { (this._touch = this._touch || []).push([a, b || '*']); return this; };
  if (!W3API.guard) W3API.guard = function (name, o) { (this._gOff = this._gOff || {})[name] = Object.assign((this._gOff || {})[name] || {}, o); return this; };
  const off = (w, name, what) => !!(w && w._gOff && w._gOff[name] && w._gOff[name][what] === false);
  const draw0 = W3API.draw;
  W3API.draw = function (ctx, lt, D, T) {
    const c = this.comp, r = c && c.render;
    if (G.dry && c) c.render = () => {};               // проверке картинка не нужна — только позы
    else if (G.jit && c) c.render = (...a) => {        // подтверждение мерцания глубины: камера сдвинута на доли мм
      const cam = this.cam, p0 = cam.position.clone();
      cam.position.x += G.jit[0]; cam.position.y += G.jit[1]; cam.position.z += G.jit[2]; cam.updateMatrixWorld(true);
      try { r.apply(c, a); } finally { cam.position.copy(p0); cam.updateMatrixWorld(true); }
    };
    try { draw0.call(this, ctx, lt, D, T); } finally { if (c) c.render = r; }
    if (X3.ok && !G.drawn.includes(this)) { G.drawn.push(this); try { this._gXf = ctx.getTransform(); } catch (e) { this._gXf = null; } }   // 2D-масштаб поверх мира (наезд, склейка зумом)
  };

  // ---------------------------------------------------------------- сцены и переходы (main.js: B, SCENES, TD)
  const sceneOf = T => { let k = 0; while (k < SCENES.length - 1 && T >= B[k + 1]) k++; return k; };
  const inTrans = T => {
    const k = sceneOf(T);
    for (const kb of [k, k + 1]) {
      if (kb <= 0 || kb >= SCENES.length) continue;
      const td = SCENES[kb].transDur || (typeof TD !== 'undefined' ? TD : 0.7), a0 = B[kb] - td / 2;
      if (T >= a0 - 0.02 && T < a0 + td + 0.02) return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- объекты мира -> единицы проверки
  const visChain = (o, stop) => { for (let x = o; x && x !== stop; x = x.parent) if (!x.visible) return false; return true; };
  const isChar = (root, name) => !!(root.hog !== undefined || root.cardInfo || root.pose || (root.userData && root.userData.char) ||
    (root.children[0] && root.children[0].userData && root.children[0].userData.char) || /ёж|кот|кош|пёс|собак|гейб|персонаж|герой|char|hog/i.test(name || ''));
  // маска непрозрачности картинки карточки (48×48, строки сверху вниз) + рамка непрозрачной части [u0, v0, u1, v1]
  function opaqueMask(img, dyn, T) {
    const N = 48;
    if (!img || !(img.width > 0)) return null;
    const bucket = dyn ? Math.floor(T * 2) : 0, c = G._oc = G._oc || new WeakMap(), hit = c.get(img);
    if (hit && hit.b === bucket) return hit.m;
    let m = null;
    try {
      const cv = G._cv = G._cv || document.createElement('canvas'); cv.width = N; cv.height = N;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.clearRect(0, 0, N, N); g.drawImage(img, 0, 0, N, N);
      const d = g.getImageData(0, 0, N, N).data, a = new Uint8Array(N * N); let x0 = N, y0 = N, x1 = -1, y1 = -1;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (d[(y * N + x) * 4 + 3] > 128) { a[y * N + x] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      m = { N, a, r: x1 >= 0 ? [x0 / N, y0 / N, (x1 + 1) / N, (y1 + 1) / N] : [0, 0, 0, 0] };
    } catch (e) { /* чужая картинка без CORS — считаем всю */ }
    c.set(img, { b: bucket, m });
    return m;
  }
  const maskAt = (mk, u, v) => !mk || mk.a[Math.min(mk.N - 1, Math.max(0, Math.floor(v * mk.N))) * mk.N + Math.min(mk.N - 1, Math.max(0, Math.floor(u * mk.N)))] === 1;
  function scan(w) {
    const units = [];
    const add = (root, name) => {
      if (root.userData && root.userData.guard === false) return;
      const parts = [], seen = new Set();
      root.updateMatrixWorld(true);
      root.traverse(m => {
        if (!m.isMesh || m.isSprite || m.isPoints || m.isLine) return;
        if (m.userData && m.userData.guard === false) return;
        const g = m.geometry; if (!g) return;
        const sk = (m.parent ? m.parent.uuid : '') + g.uuid; if (seen.has(sk)) return; seen.add(sk);   // обратная сторона и кромка карточки — та же геометрия
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox; if (!bb || bb.isEmpty()) return;
        const s = bb.getSize(V()), dims = [s.x, s.y, s.z].sort((a, b) => a - b);
        const ws = m.getWorldScale(V()), wmax = Math.max(s.x * ws.x, s.y * ws.y, s.z * ws.z);
        if (wmax < 0.03) return;                         // лампочки, пуговицы
        const mat = [].concat(m.material)[0] || {};
        if (mat.depthWrite === false || (mat.blending != null && mat.blending !== THREE.NormalBlending) || (mat.transparent && !mat.map && (mat.opacity == null ? 1 : mat.opacity) < 0.6) || mat.colorWrite === false) return;   // лучи, ореолы, стекло
        const flat = dims[0] < Math.max(1e-4, dims[2] * 0.02) && s.z === dims[0];
        const zsafe = !!(mat.polygonOffset || mat.depthTest === false);   // наклейка со сдвигом глубины — мерцать не будет
        const vol = Math.max(1e-6, s.x * ws.x) * Math.max(1e-6, s.y * ws.y) * Math.max(0.05, s.z * ws.z);
        if (flat) parts.push({ m, flat: true, bb: bb.clone(), vol, zsafe, map: mat.map && mat.map.image, alpha: mat.alphaTest > 0 || mat.transparent });
        else parts.push({ m, flat: false, bb: bb.clone(), vol, zsafe, model: !(g.type === 'BoxGeometry') });
      });
      if (!parts.length) return;
      // земля и небо — не участники застреваний и рывков (огромные плоскости), но мерцать с ними можно (коврик ровно на полу) — bg
      let bg = false;
      if (parts.every(p => p.flat && !p.alpha)) {
        const p = parts[0], n = V().set(0, 0, 1).transformDirection(p.m.matrixWorld), sz = p.bb.getSize(V()).multiply(p.m.getWorldScale(V()));
        if (Math.abs(n.y) > 0.8 && Math.max(sz.x, sz.y) > 2.5) bg = true;   // пол
        if (Math.max(sz.x, sz.y) > 12) bg = true;                           // задник-небо
      }
      const P = parts.length > 40 ? parts.sort((a, b) => b.vol - a.vol).slice(0, 40) : parts;   // сложная модель — 40 крупнейших частей, без общей коробки (она глотает соседей)
      const it = root.userData && root.userData.item;
      const nm = name || (it && it.name) || root.name || `объект ${units.length + 1}`;
      units.push({ i: units.length, root, name: nm, parts: P, bg, char: !bg && isChar(root, nm), dyn: !!(root.userData && root.userData.redraw) });
    };
    for (const o of w.scene.children) {
      if (o.isLight || o.isCamera || o.isSprite || o.isPoints) continue;
      if (o.userData && o.userData.pivotOf && o.children[0]) { add(o, o.children[0].name); continue; }   // сцена редактора: узел привязки -> holder
      add(o);
    }
    w._gUnits = units; w._gN = w.scene.children.length;
    return units;
  }

  // ---------------------------------------------------------------- геометрия частей в мире
  const _p = V(), _q = V();
  function quadPts(p, T, nx = 8, ny = 10) {            // точки НАРИСОВАННОЙ части карточки (мир) + её плоскость
    const bb = p.bb, mk = p.alpha ? opaqueMask(p.map, true, T) : null, r = mk ? mk.r : [0, 0, 1, 1];
    const X = u => bb.min.x + (bb.max.x - bb.min.x) * u, Y = v => bb.max.y - (bb.max.y - bb.min.y) * v, z = (bb.min.z + bb.max.z) / 2;
    const pts = [], pv = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u = lerp(r[0], r[2], (i + 0.5) / nx), v = lerp(r[1], r[3], (j + 0.5) / ny);
      if (maskAt(mk, u, v)) { pts.push(V().set(X(u), Y(v), z).applyMatrix4(p.m.matrixWorld)); pv.push((j + 0.5) / ny); }
    }
    const corners = [[r[0], r[3]], [r[2], r[3]], [r[2], r[1]], [r[0], r[1]]].map(([u, v]) => V().set(X(u), Y(v), z).applyMatrix4(p.m.matrixWorld));
    return { pts, pv, corners, mk, rect: [bb.min.x, bb.min.y, bb.max.x, bb.max.y, z] };
  }
  function boxCorners(p) {
    const b = p.bb, sh = p.model ? 0.1 : 0;             // модели: коробка рыхлая — ужимаем на 10 %
    const s = b.getSize(V()), mn = b.min.clone().addScaledVector(s, sh), mx = b.max.clone().addScaledVector(s, -sh);
    const out = [];
    for (const x of [mn.x, mx.x]) for (const y of [mn.y, mx.y]) for (const z of [mn.z, mx.z]) out.push(V().set(x, y, z).applyMatrix4(p.m.matrixWorld));
    return { corners: out, mn, mx };
  }
  function geomOf(u, T) {
    return u.parts.map(p => { const g = Object.assign({ p }, p.flat ? quadPts(p, T) : boxCorners(p)); g.bb = new THREE.Box3().setFromPoints(g.corners); if (p.flat) g.bb.expandByScalar(0.01); return g; });
  }
  // сколько нарисованных точек карточки B прошло сквозь нарисованную часть карточки A: глубина = min(с одной стороны, с другой)
  const normalOf = X => V().set(0, 0, 1).transformDirection(X.p.m.matrixWorld);
  const isLying = X => Math.abs(normalOf(X).y) > 0.7;
  // сколько нарисованных точек карточки B прошло сквозь нарисованную часть карточки A: глубина = min(с одной стороны, с другой)
  function quadQuad(A, B) {
    const inv = A.p.m.matrixWorld.clone().invert(), [x0, y0, x1, y1, z] = A.rect;
    const n = normalOf(A), o = V().set(x0, y0, z).applyMatrix4(A.p.m.matrixWorld);
    let pos = 0, neg = 0;
    for (const w of B.pts) {
      _p.copy(w).applyMatrix4(inv);
      const u = (_p.x - x0) / (x1 - x0), v = (y1 - _p.y) / (y1 - y0);
      if (u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97 || !maskAt(A.mk, u, v)) continue;
      const d = _q.copy(w).sub(o).dot(n);
      if (d > pos) pos = d; if (-d > neg) neg = -d;
    }
    return Math.min(pos, neg);
  }
  // стоящая карточка S на лежачей L (пол, ковёр, ступенька, столешница): сколько S ушла ПОД L. Низ (нижняя четверть) до 20 см — стоит / сидит, не застрял
  function sink(S, L) {
    const inv = L.p.m.matrixWorld.clone().invert(), [x0, y0, x1, y1, z] = L.rect;
    const n = normalOf(L), up = n.y > 0 ? 1 : -1, o = V().set(x0, y0, z).applyMatrix4(L.p.m.matrixWorld);
    let below = 0, low = true;
    for (let i = 0; i < S.pts.length; i++) {
      const w = S.pts[i];
      _p.copy(w).applyMatrix4(inv);
      const u = (_p.x - x0) / (x1 - x0), v = (y1 - _p.y) / (y1 - y0);
      if (u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97 || !maskAt(L.mk, u, v)) continue;
      const d = -_q.copy(w).sub(o).dot(n) * up;
      if (d > 0.02) { if (d > below) below = d; if (!(S.pv && S.pv[i] >= 0.75)) low = false; }
    }
    return low && below < 0.2 ? 0 : below;
  }
  function flatFlat(A, B) {
    const la = isLying(A), lb = isLying(B);
    if (la && !lb) return sink(B, A);
    if (lb && !la) return sink(A, B);
    return Math.max(quadQuad(A, B), quadQuad(B, A));
  }
  // точки карточки внутри коробки: глубина до ближайшей грани. Не застревание:
  //   коробка-оболочка (комната, небо) целиком вокруг карточки; низ карточки (нижняя четверть) чуть в опоре — стоит / сидит на ней (до 20 см)
  function quadBox(Q, Bx) {
    const inv = Bx.p.m.matrixWorld.clone().invert(), ws = Bx.p.m.getWorldScale(V()), m = 0.02;
    let best = 0, cnt = 0, all = 0, low = true;
    for (let i = 0; i < Q.pts.length; i++) {
      _p.copy(Q.pts[i]).applyMatrix4(inv);
      const dx = Math.min(_p.x - Bx.mn.x, Bx.mx.x - _p.x) * ws.x, dy = Math.min(_p.y - Bx.mn.y, Bx.mx.y - _p.y) * ws.y, dz = Math.min(_p.z - Bx.mn.z, Bx.mx.z - _p.z) * ws.z;
      const d = Math.min(dx, dy, dz);
      if (d > 0) all++;
      if (d > m) { cnt++; if (d > best) best = d; if (Q.pv[i] < 0.75) low = false; }
    }
    if (cnt < 2) return 0;
    const bs = Bx.mx.clone().sub(Bx.mn).multiply(ws), qh = Q.bb.max.y - Q.bb.min.y;
    if (all === Q.pts.length && Math.max(bs.x, bs.y, bs.z) > 2.5 * qh) return 0;          // оболочка
    if (low && best < 0.2) return 0;                                                         // стоит / сидит
    return best;
  }
  function axesOf(c) { const o = c[0]; return [V().subVectors(c[4], o), V().subVectors(c[2], o), V().subVectors(c[1], o)].map(v => v.normalize()); }
  const inside = (C, X) => {                             // все углы C внутри коробки X?
    const inv = X.p.m.matrixWorld.clone().invert();
    return C.corners.every(c => { _p.copy(c).applyMatrix4(inv); return _p.x >= X.mn.x - 0.01 && _p.x <= X.mx.x + 0.01 && _p.y >= X.mn.y - 0.01 && _p.y <= X.mx.y + 0.01 && _p.z >= X.mn.z - 0.01 && _p.z <= X.mx.z + 0.01; });
  };
  const volOf = X => X.bb.getSize(V()).toArray().reduce((a, b) => a * Math.max(b, 0.01), 1);
  function boxBox(A, B) {                                // SAT по 15 осям: минимальное перекрытие = глубина
    const aa = axesOf(A.corners), ba = axesOf(B.corners), axes = [...aa, ...ba];
    for (const a of aa) for (const b of ba) { const c = V().crossVectors(a, b); if (c.lengthSq() > 1e-6) axes.push(c.normalize()); }
    let depth = Infinity;
    for (const ax of axes) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of A.corners) { const d = p.dot(ax); if (d < a0) a0 = d; if (d > a1) a1 = d; }
      for (const p of B.corners) { const d = p.dot(ax); if (d < b0) b0 = d; if (d > b1) b1 = d; }
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      if (ov <= 0) return 0;
      if (ov < depth) depth = ov;
    }
    const va = volOf(A), vb = volOf(B);                   // оболочка (комната, небо, шкаф вокруг мелочи) — не застревание
    if ((va > 6 * vb && inside(B, A)) || (vb > 6 * va && inside(A, B))) return 0;
    return depth;
  }
  const partName = x => { const m = x.p.m, s = x.bb.getSize(V()); return `${m.name || (x.p.flat ? 'карточка' : 'коробка')} ${[s.x, s.y, s.z].map(v => Math.round(v * 100)).join('×')} см`; };
  function pairDepth(ga, gb) {
    let d = 0, pa = null, pb = null;
    for (const A of ga) for (const B of gb) {
      if (!A.bb.intersectsBox(B.bb)) continue;
      let x = 0;
      if (A.p.flat && B.p.flat) x = flatFlat(A, B);
      else if (A.p.flat) x = quadBox(A, B);
      else if (B.p.flat) x = quadBox(B, A);
      else x = boxBox(A, B);
      if (x > d) { d = x; pa = A; pb = B; }
    }
    return { d, pa: pa && partName(pa), pb: pb && partName(pb) };
  }
  // ---- мерцание глубины (z-fighting): две поверхности в одной плоскости, смотрят в одну сторону, перекрываются — кадр за кадром «рябит»
  const ZEPS = 0.0005;                                  // глубина 24 бит различает доли мм: мерцает только «ровно в одной плоскости»
  function faceList(B) {                                // грани коробки: центр, нормаль наружу, полуоси (мир)
    const M = B.p.m.matrixWorld, c = B.mn.clone().add(B.mx).multiplyScalar(0.5), h = B.mx.clone().sub(B.mn).multiplyScalar(0.5), out = [];
    const ax = [V().set(1, 0, 0), V().set(0, 1, 0), V().set(0, 0, 1)], hh = [h.x, h.y, h.z];
    for (let a = 0; a < 3; a++) for (const sg of [1, -1]) {
      const iu = (a + 1) % 3, iv = (a + 2) % 3;
      const cl = c.clone().addScaledVector(ax[a], sg * hh[a]);
      const wc = cl.clone().applyMatrix4(M), n = ax[a].clone().multiplyScalar(sg).transformDirection(M);
      const wu = cl.clone().addScaledVector(ax[iu], hh[iu]).applyMatrix4(M).sub(wc), wv = cl.clone().addScaledVector(ax[iv], hh[iv]).applyMatrix4(M).sub(wc);
      out.push({ c: wc, n, u: wu, v: wv });                // точка грани: c + u·s + v·t, s,t ∈ [-1, 1]
    }
    return out;
  }
  const inFace = (f, p) => { const d = _p.copy(p).sub(f.c), s = d.dot(f.u) / Math.max(1e-9, f.u.lengthSq()), t = d.dot(f.v) / Math.max(1e-9, f.v.lengthSq()); return Math.abs(s) < 0.97 && Math.abs(t) < 0.97; };
  function facePts(f, n = 5) { const o = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) o.push(f.c.clone().addScaledVector(f.u, (i + 0.5) / n * 2 - 1).addScaledVector(f.v, (j + 0.5) / n * 2 - 1)); return o; }
  function zfight(A, B) {                               // -> доля перекрытия (0 — нет)
    if (A.p.zsafe || B.p.zsafe) return 0;
    const look = X => { const m = [].concat(X.p.m.material)[0] || {}; return m.map ? 'map:' + (m.map.uuid || '') : 'c:' + (m.color ? m.color.getHexString() : '') + (m.emissive ? m.emissive.getHexString() : ''); };
    if (look(A) === look(B)) return 0;                   // одинаковый цвет без текстуры — мерцание не видно
    const cnt = (pts, test) => pts.filter(q => test(q)).map(q => q.clone());
    if (A.p.flat && B.p.flat) {
      const na = normalOf(A), nb = normalOf(B); if (na.dot(nb) < 0.9995) return 0;
      const oa = V().set(A.rect[0], A.rect[1], A.rect[4]).applyMatrix4(A.p.m.matrixWorld);
      const inv = A.p.m.matrixWorld.clone().invert(), [x0, y0, x1, y1] = A.rect;
      const hit = [];
      for (const w of B.pts) {
        if (Math.abs(_q.copy(w).sub(oa).dot(na)) > ZEPS) continue;
        _p.copy(w).applyMatrix4(inv); const u = (_p.x - x0) / (x1 - x0), v = (y1 - _p.y) / (y1 - y0);
        if (u > 0.02 && u < 0.98 && v > 0.02 && v < 0.98 && maskAt(A.mk, u, v)) hit.push(w.clone());
      }
      return hit.length >= 4 ? { f: hit.length / Math.max(1, B.pts.length), pts: hit } : 0;
    }
    if (A.p.flat !== B.p.flat) {
      const Q = A.p.flat ? A : B, X = A.p.flat ? B : A, nq = normalOf(Q);
      for (const f of faceList(X)) {
        if (f.n.dot(nq) < 0.9995) continue;
        const k = cnt(Q.pts, q => Math.abs(_q.copy(q).sub(f.c).dot(f.n)) < ZEPS && inFace(f, q));
        if (k.length >= 4) return { f: k.length / Math.max(1, Q.pts.length), pts: k };
      }
      return 0;
    }
    const fa = faceList(A), fb = faceList(B);
    for (const f of fa) for (const g of fb) {
      if (f.n.dot(g.n) < 0.9995 || Math.abs(_q.copy(g.c).sub(f.c).dot(f.n)) > ZEPS) continue;
      const k = cnt(facePts(g), q => inFace(f, q));
      if (k.length >= 4) return { f: k.length / 25, pts: k };
    }
    return 0;
  }
  const aabb = g => { const b = new THREE.Box3(); for (const x of g) b.union(x.bb); return b; };

  // ---------------------------------------------------------------- экран
  function camOf(w) {
    const c = w.cam; c.updateMatrixWorld(true); c.matrixWorldInverse.copy(c.matrixWorld).invert();
    const x = w._gXf; return { cam: c, pos: V().setFromMatrixPosition(c.matrixWorld), dir: c.getWorldDirection(V()), fov: c.fov, xf: x ? [x.a, x.d, x.e / W, x.f / H] : [1, 1, 0, 0] };
  }
  function screen(g, cam) {                              // рамка на экране в долях кадра: area — видимая площадь, frac — сколько её в кадре
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const x of g) for (const c of x.corners) {
      _p.copy(c).applyMatrix4(cam.matrixWorldInverse); if (_p.z > -0.05) continue;   // за камерой
      _p.copy(c).project(cam); n++;
      const sx = (_p.x + 1) / 2, sy = (1 - _p.y) / 2;
      if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (!n) return { area: 0, frac: 0, cx: 0.5, cy: 0.5, box: null };
    const full = Math.max(1e-9, (x1 - x0) * (y1 - y0));
    const cl = Math.max(0, Math.min(1, x1) - Math.max(0, x0)) * Math.max(0, Math.min(1, y1) - Math.max(0, y0));
    return { area: cl, frac: cl / full, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, box: [x0, y0, x1, y1] };
  }
  const opacityOf = u => { let a = 0; for (const p of u.parts) for (const m of [].concat(p.m.material || [])) a = Math.max(a, m && m.transparent ? (m.opacity == null ? 1 : m.opacity) : 1); return u.parts[0].m.isMesh ? a : 1; };
  const sigOf = u => { const e = u.parts[0].m.matrixWorld.elements, r = u.root.matrixWorld.elements; let s = ''; for (let i = 12; i < 15; i++) s += Math.round(r[i] * 500) + ','; for (let i = 0; i < 11; i++) s += Math.round(e[i] * 200) + ','; for (let i = 12; i < 15; i++) s += Math.round(e[i] * 500) + ','; return s; };
  const relSig = (a, b) => { const m = a.parts[0].m.matrixWorld.clone().invert().multiply(b.parts[0].m.matrixWorld).elements; return m.map(x => Math.round(x * 100)).join(','); };
  const touches = (w, a, b) => (w._touch || []).some(([x, y]) => (x === a.name && (y === '*' || y === b.name)) || (x === b.name && (y === '*' || y === a.name)));

  // какая доля объекта видна камере (лучи к точкам частей; первым попался чужой объект — закрыт)
  const _ray = { r: null };
  function seenFrac(w, u, g, cam) {
    if (!_ray.r) _ray.r = new THREE.Raycaster();
    const pts = [];
    for (const x of g) { if (x.pts) for (let i = 0; i < x.pts.length; i += Math.max(1, Math.floor(x.pts.length / 6))) pts.push(x.pts[i]); else pts.push(x.bb.getCenter(V())); }
    if (!pts.length) return 1;
    const mine = new Set(); u.root.traverse(o => mine.add(o));
    const eye = V().setFromMatrixPosition(cam.matrixWorld);
    let seen = 0, n = 0;
    for (const p of pts.slice(0, 16)) {
      _p.copy(p).project(cam); if (Math.abs(_p.x) > 1 || Math.abs(_p.y) > 1 || _p.z > 1) continue;
      n++;
      const dir = V().subVectors(p, eye), dist = dir.length(); dir.normalize();
      _ray.r.set(eye, dir); _ray.r.far = dist - 0.03; _ray.r.camera = cam;
      const hit = _ray.r.intersectObjects(w.scene.children, true).find(h => h.object.visible && h.object.isMesh && !mine.has(h.object) && visChain(h.object, w.scene) &&
        !([].concat(h.object.material)[0] || {}).transparent && ([].concat(h.object.material)[0] || {}).depthWrite !== false);
      if (!hit) seen++;
    }
    return n ? seen / n : 0;
  }

  function seenAt(wi, ui, T) {                          // доля видимой части в кадре T (кадр рисуется заново — мир в позе T)
    const fr = frame(T).find(x => x.wi === wi); if (!fr || !fr.st[ui].g) return 0;
    return seenFrac(fr.w, fr.units[ui], fr.st[ui].g, fr.cam.cam);
  }

  // ---------------------------------------------------------------- один кадр
  function frame(T) {
    G.drawn = [];
    renderFrame(T);
    const out = [];
    for (const w of G.drawn) {
      const wi = X3.worlds.indexOf(w);
      if (!w.scene) continue;
      w.scene.updateMatrixWorld(true);
      const units = (w._gUnits && w._gN === w.scene.children.length) ? w._gUnits : scan(w), cam = camOf(w);
      const st = units.map(u => {
        const vis = visChain(u.root, w.scene) && u.parts.some(p => visChain(p.m, u.root.parent));
        if (!vis) return { vis: false, pres: false, area: 0, frac: 0 };
        const g = geomOf(u, T), sc = screen(g, cam.cam), op = opacityOf(u);
        const bb = aabb(g), wp = bb.getCenter(V());
        return { vis, pres: op > 0.05, op, g, area: sc.area * op, frac: sc.frac, cx: sc.cx, cy: sc.cy, box: sc.box, bb, wp, hgt: bb.max.y - bb.min.y, sig: sigOf(u) };
      });
      out.push({ w, wi, units, st, cam });
    }
    return out;
  }
  // склейка камерой: за 1/60 с камера сдвинулась > 12 см, повернулась > 4° или fov > 2.5°
const camCut = (a, b) => !a || !b || a.pos.distanceTo(b.pos) > 0.12 || a.dir.angleTo(b.dir) > 0.07 || Math.abs(a.fov - b.fov) > 2.5 ||
    Math.abs(a.xf[0] / b.xf[0] - 1) > 0.04 || Math.abs(a.xf[1] / b.xf[1] - 1) > 0.04 || Math.abs(a.xf[2] - b.xf[2]) > 0.03 || Math.abs(a.xf[3] - b.xf[3]) > 0.03;   // + 2D-зум холста

  // ---------------------------------------------------------------- грубый проход: кадры каждые dt
  G.step = function (t0, t1, dt) {
    G.dt = dt = dt || G.dt;
    for (let t = t0; t < t1 - 1e-6; t += dt) {
      const T = Math.round(t * 1000) / 1000, k = sceneOf(T), tr = inTrans(T);
      for (const F of frame(T)) {
        const { w, wi, units, st } = F;
        for (const u of units) {
          if (u.bg) continue;
          const key = wi + '|' + u.i, s = st[u.i];
          if (!G.tracks.has(key)) G.tracks.set(key, { wi, u: u.i, name: u.name, char: u.char, s: [] });
          G.tracks.get(key).s.push({ T, k, tr, pres: s.pres, area: s.area || 0, frac: s.frac || 0, cx: s.cx, cy: s.cy, wp: s.wp, hgt: s.hgt, sig: s.sig || '' });
        }
        // столкновения: видимые и в кадре
        const live = units.filter(u => !u.bg && st[u.i].pres && st[u.i].area > 0);
        // мерцание глубины — раз в 0.5 с: все видимые в кадре (и пол / задник, и части одного предмета, и декор)
        if (Math.round(T / dt) % 5 === 0) {
          const zl = units.filter(u => st[u.i].pres && st[u.i].area > 0.0005);
          const zhit = (A, Bu, ga, gb) => {
            for (const x of ga) for (const y of gb) {
              if (x === y || (A === Bu && ga.indexOf(x) > gb.indexOf(y)) || !x.bb.clone().expandByScalar(ZEPS).intersectsBox(y.bb)) continue;
              const zr = zfight(x, y); if (!zr) continue;
              const f = zr.f, sc = screen([{ corners: zr.pts }], F.cam.cam);
              if (!sc.box || sc.area < 0.00015) continue;      // стык в пару пикселей или за кадром — не видно
              const key = 'z|' + wi + '|' + A.i + '|' + Bu.i;
              if (!G.zf.has(key)) G.zf.set(key, { wi, a: A.i, b: Bu.i, A: A.name, B: Bu.name, hits: [] });
              G.zf.get(key).hits.push({ T, k, f, pa: partName(x), pb: partName(y), box: sc.box });
              return;
            }
          };
          for (let a = 0; a < zl.length; a++) {
            const A = zl[a], ga = st[A.i].g;
            if (ga.length > 1 && ga.length <= 40) zhit(A, A, ga, ga);
            for (let b = a + 1; b < zl.length; b++) { const Bu = zl[b]; if (st[A.i].bb.clone().expandByScalar(ZEPS).intersectsBox(st[Bu.i].bb)) zhit(A, Bu, ga, st[Bu.i].g); }
          }
        }
        for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
          const A = live[a], Bu = live[b], sa = st[A.i], sb = st[Bu.i];
          if (!sa.bb.intersectsBox(sb.bb)) continue;
          if (touches(w, A, Bu) || off(w, A.name, 'stuck') || off(w, Bu.name, 'stuck')) { G.info.touch++; continue; }
          const pd = pairDepth(sa.g, sb.g), d = pd.d;
          const ha = sa.bb.max.y - sa.bb.min.y, hb = sb.bb.max.y - sb.bb.min.y;
          if (d < Math.max(0.03, 0.05 * Math.min(ha, hb))) continue;
          const key = wi + '|' + A.i + '|' + Bu.i;
          if (!G.pairs.has(key)) G.pairs.set(key, { wi, a: A.i, b: Bu.i, A: A.name, B: Bu.name, char: A.char || Bu.char, hits: [] });
          G.pairs.get(key).hits.push({ T, k, d, pa: pd.pa, pb: pd.pb, rel: relSig(A, Bu), vis: Math.min(sa.area, sb.area), fr: Math.min(sa.frac, sb.frac) });
        }
      }
    }
    return { tracks: G.tracks.size, pairs: G.pairs.size };
  };

  // ---------------------------------------------------------------- итоги: столкновения + уточнение рывков по 60 к/с
  const r2 = x => Math.round(x * 100) / 100;
  G.finish = function (opt = {}) {
    const issues = [], dt = G.dt, maxRef = opt.maxRefine || 160;
    const trackOf = (wi, u) => G.tracks.get(wi + '|' + u);
    const staticIn = (tr, k) => { const xs = tr.s.filter(s => s.k === k && s.pres); return xs.length > 1 && xs.every(s => s.sig === xs[0].sig); };
    // --- застревания
    for (const P of G.pairs.values()) {
      const byK = {};
      for (const h of P.hits) (byK[h.k] = byK[h.k] || []).push(h);
      for (const k in byK) {
        const hs = byK[k], ta = trackOf(P.wi, P.a), tb = trackOf(P.wi, P.b);
        if (staticIn(ta, +k) && staticIn(tb, +k)) { G.info.decor++; continue; }           // декор внахлёст — так расставили
        if (hs.length > 2 && hs.every(h => h.rel === hs[0].rel)) { G.info.attached++; continue; }   // едут вместе — прицеп
        let run = [hs[0]];
        const spans = [];
        const flush = () => {
          const top = run.reduce((m, h) => (h.d > m.d ? h : m));
          const seen = Math.max(...run.map(h => (h.fr >= 0.25 ? h.vis : 0)));   // крошка вдали или за краем кадра — зритель не заметит
          if ((run.length >= 2 || top.d >= 0.08) && seen >= 0.0015) spans.push({ t0: run[0].T, t1: run[run.length - 1].T + dt, top });
        };
        for (let i = 1; i < hs.length; i++) { if (hs[i].T - hs[i - 1].T <= Math.max(dt * 1.6, 0.6)) run.push(hs[i]); else { flush(); run = [hs[i]]; } }
        flush();
        if (!spans.length) continue;                     // одно и то же пересечение с паузами — одно замечание с отрезками
        const top = spans.reduce((m, x) => (x.top.d > m.top.d ? x : m)).top, t0 = spans[0].t0, t1 = spans[spans.length - 1].t1;
        issues.push({ type: 'stuck', wi: P.wi, k: +k, scene: SCENES[k] && SCENES[k].name, a: P.A, b: P.B, ua: P.a, ub: P.b, char: P.char,
          t0: r2(t0), t1: r2(t1), lt0: r2(t0 - B[k]), lt1: r2(t1 - B[k]), depth: r2(top.d), tShot: top.T, parts: [top.pa, top.pb],
          spans: spans.length > 1 ? spans.map(x => [r2(x.t0), r2(x.t1)]) : undefined });
      }
    }
    // --- мерцание глубины: кандидаты по геометрии подтверждаются картинкой (3 кадра с камерой, сдвинутой на 0.05 мм:
    //     стык «скачет», а кадр в целом — нет). Одна пара в сцене — одно замечание
    G.info.zSuspect = 0; G.info.zChecked = 0;
    const zconfirm = h => {
      const cv = document.getElementById('c'), g = cv.getContext('2d', { willReadFrequently: true });
      const [x0, y0, x1, y1] = h.box, X0 = Math.max(0, Math.floor(x0 * cv.width) - 2), Y0 = Math.max(0, Math.floor(y0 * cv.height) - 2);
      const w_ = Math.min(cv.width, Math.ceil(x1 * cv.width) + 2) - X0, h_ = Math.min(cv.height, Math.ceil(y1 * cv.height) + 2) - Y0;
      if (w_ < 2 || h_ < 2) return false;
      const shots = [];
      for (const j of [[0, 0, 0], [5e-5, 3e-5, 0], [-4e-5, 5e-5, 3e-5]]) {
        G.dry = false; G.jit = j; G.drawn = [];
        try { renderFrame(h.T); } finally { G.jit = null; G.dry = true; }
        shots.push(g.getImageData(X0, Y0, w_, h_).data);
      }
      let n = 0, bad = 0;
      for (let i = 0; i < shots[0].length; i += 4) {
        n++;
        const d = (a, b) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (Math.max(d(shots[0], shots[1]), d(shots[0], shots[2])) > 60) bad++;
      }
      return n > 0 && bad >= Math.max(6, n * 0.02);                // от 2 % пикселей стыка заметно меняются от сдвига на долю пикселя
    };
    for (const Z of G.zf.values()) {
      const byK = {};
      for (const h of Z.hits) (byK[h.k] = byK[h.k] || []).push(h);
      for (const k in byK) {
        const hs = byK[k], top = hs.reduce((m, h) => (h.f > m.f ? h : m)), self = Z.a === Z.b;
        if (G.info.zChecked >= (opt.maxZ || 60)) { G.info.zSuspect++; continue; }
        G.info.zChecked++;
        if (!hs.slice(0, 3).some(zconfirm)) { G.info.zSuspect++; continue; }   // геометрия «в одной плоскости», но на картинке не мерцает
        issues.push({ type: 'zfight', wi: Z.wi, k: +k, scene: SCENES[k] && SCENES[k].name, a: Z.A, b: self ? null : Z.B, ua: Z.a, ub: self ? null : Z.b,
          t0: r2(hs[0].T), t1: r2(hs[hs.length - 1].T + dt * 5), lt0: r2(hs[0].T - B[k]), lt1: r2(hs[hs.length - 1].T + dt * 5 - B[k]), tShot: top.T, parts: [top.pa, top.pb], share: r2(top.f) });
      }
    }
    // --- мигание: объект в кадре 3+ раза сменил видимость за 1.2 с (не склейки сцен) — «моргает»
    for (const tr of G.tracks.values()) {
      const fl = [];
      for (let i = 1; i < tr.s.length; i++) { const a = tr.s[i - 1], b = tr.s[i]; if (a.k === b.k && !a.tr && !b.tr && b.T - a.T <= dt * 1.6 && a.pres !== b.pres && Math.max(a.area, b.area) >= 0.002) fl.push(b.T); }
      for (let i = 0; i + 2 < fl.length; i++) {
        if (fl[i + 2] - fl[i] > 1.2) continue;
        let j = i + 2; while (j + 1 < fl.length && fl[j + 1] - fl[j] < 0.7) j++;
        const k = sceneOf(fl[i]);
        if (!off(X3.worlds[tr.wi], tr.name, 'pop')) issues.push({ type: 'blink', wi: tr.wi, k, scene: SCENES[k] && SCENES[k].name, a: tr.name, ua: tr.u, char: tr.char,
          t0: r2(fl[i] - dt), t1: r2(fl[j]), lt0: r2(fl[i] - dt - B[k]), lt1: r2(fl[j] - B[k]), n: j - i + 1, tShot: fl[i] });
        i = j;
      }
    }
    // --- автоисправление (только сцены монтажа из данных, MONTAGE_WORLDS): сдвинуть по полу НЕ анимированный объект на глубину + 6 см
    const MW = window.MONTAGE_WORLDS || {};
    for (const x of issues) {
      if (x.type !== 'stuck') continue;
      const w = X3.worlds[x.wi], el = Object.keys(MW).find(k => MW[k] === w);
      if (!el || !w.S || !w._gUnits) continue;
      const pick = ui => { const u = w._gUnits[ui], r = u && u.root, sid = r && ((r.userData && r.userData.pivotOf) || (r.children[0] && r.children[0].userData.sid));
        const o = sid && (w.S.scene.objects || []).find(q => q.id === sid);
        return o && !o.parent && !(o.keys && o.keys.pos) && !(o.links && o.links.length) ? { u, o } : null; };
      const A = pick(x.ua), Bq = pick(x.ub);
      const mv = A && Bq ? ((A.u.char && !Bq.u.char) ? Bq : (Bq.u.char && !A.u.char) ? A : A) : (A || Bq);
      if (!mv) continue;
      const other = mv === A ? x.ub : x.ua;
      frame(x.tShot);
      const ca = new THREE.Box3().setFromObject(mv.u.root).getCenter(V()), cb = new THREE.Box3().setFromObject(w._gUnits[other].root).getCenter(V());
      const d = V().set(ca.x - cb.x, 0, ca.z - cb.z); if (d.lengthSq() < 1e-6) d.set(1, 0, 0); d.normalize().multiplyScalar(x.depth + 0.06);
      const p0 = mv.o.pos || [0, 0, 0];
      x.fix = { el, id: mv.o.id, name: mv.u.name, pos: [r2(p0[0] + d.x), p0[1], r2(p0[2] + d.z)], by: r2(x.depth + 0.06) };
    }
    // --- кандидаты на рывок: соседние грубые кадры одной сцены, где объект сменил видимость или сильно сдвинулся
    const cands = [];
    for (const tr of G.tracks.values()) {
      const maxA = {};
      for (const s of tr.s) if (s.pres) maxA[s.k] = Math.max(maxA[s.k] || 0, s.area);
      for (let i = 1; i < tr.s.length; i++) {
        const a = tr.s[i - 1], b = tr.s[i];
        if (a.k !== b.k || a.tr || b.tr || b.T - a.T > dt * 1.6) continue;
        const flip = a.pres !== b.pres, mv = a.pres && b.pres && a.wp.distanceTo(b.wp) > Math.max(0.6, a.hgt) && Math.hypot(a.cx - b.cx, a.cy - b.cy) > 0.15;   // объект сдвинулся в МИРЕ (камера на ходу — не прыжок)
        if (!flip && !mv) continue;
        const big = Math.max(a.pres ? a.area : 0, b.pres ? b.area : 0);
        if (flip && big < 0.002) continue;                                                   // мелочь или за кадром
        cands.push({ tr, a, b, maxA: maxA[a.k] || big });
      }
    }
    cands.sort((x, y) => (y.tr.char - x.tr.char) || (y.maxA - x.maxA));
    // кадры с 3+ сменами видимости в одном мире разом — смена декораций (склейка ракурса), не рывок
    const flipsAt = {};
    for (const c of cands) { const key = c.tr.wi + '|' + c.a.T; flipsAt[key] = (flipsAt[key] || 0) + (c.a.pres !== c.b.pres); }
    let refined = 0;
    for (const c of cands) {
      if (refined >= maxRef) break;
      if (off(X3.worlds[c.tr.wi], c.tr.name, 'pop')) continue;
      refined++;
      const F = [], n = Math.max(2, Math.round((c.b.T - c.a.T) * 60));
      for (let j = 0; j <= n; j++) {
        const T = c.a.T + (c.b.T - c.a.T) * j / n;
        const fr = frame(T).find(x => x.wi === c.tr.wi);
        F.push(fr ? { T, cam: fr.cam, s: fr.st[c.tr.u], flips: fr.st, units: fr.units } : { T, cam: null, s: null });
      }
      for (let j = 1; j < F.length; j++) {
        const p = F[j - 1], q = F[j];
        if (!p.s || !q.s || camCut(p.cam, q.cam)) continue;
        // разом сменились 3+ объекта — смена декораций
        let nflip = 0; for (let i = 0; i < p.flips.length; i++) if (p.flips[i].pres !== q.flips[i].pres) nflip++;
        if (nflip >= 3) continue;
        const k = sceneOf(q.T);
        const base = { wi: c.tr.wi, k, scene: SCENES[k] && SCENES[k].name, a: c.tr.name, ua: c.tr.u, char: c.tr.char, t: r2(q.T), lt: r2(q.T - B[k]) };
        if (p.s.pres !== q.s.pres) {
          const s = p.s.pres ? p.s : q.s;                                                    // видимая сторона рывка
          const Fv = p.s.pres ? p : q;
          if (s.area >= 0.003 && s.area >= 0.3 * c.maxA && s.frac >= 0.3 && seenAt(c.tr.wi, c.tr.u, Fv.T) >= 0.3) {
            issues.push(Object.assign(base, { type: 'pop', dir: p.s.pres ? 'out' : 'in', area: r2(s.area * 100), tShot: p.s.pres ? p.T : q.T }));
            break;
          }
        } else if (p.s.pres && q.s.pres && p.s.area > 0.002 && q.s.area > 0.002) {
          const d = Math.hypot(p.s.cx - q.s.cx, p.s.cy - q.s.cy), dw = p.s.wp.distanceTo(q.s.wp);
          if (d > 0.08 && dw > Math.max(0.25, 0.4 * p.s.hgt)) { issues.push(Object.assign(base, { type: 'jump', dist: r2(d * 100), tShot: q.T })); break; }
        }
      }
    }
    // одно и то же — один раз (рывок на тех же объекте и секунде из двух соседних кандидатов)
    const seen = new Set(), out = [];
    for (const x of issues) { const key = [x.type, x.wi, x.a, x.b, x.t || x.t0].join('|'); if (!seen.has(key)) { seen.add(key); out.push(x); } }
    out.sort((x, y) => (x.t0 != null ? x.t0 : x.t) - (y.t0 != null ? y.t0 : y.t));
    return { issues: out, info: Object.assign({ refined, candidates: cands.length, worlds: X3.worlds.length }, G.info) };
  };

  // ---------------------------------------------------------------- кадр с пометками для листа
  G.shot = function (iss) {
    G.dry = false; G.drawn = [];
    renderFrame(iss.tShot);
    G.dry = true;
    const w = X3.worlds[iss.wi]; if (!w || !w._gUnits) return null;
    w.scene.updateMatrixWorld(true);
    const cam = camOf(w).cam, cv = document.getElementById('c'), g = cv.getContext('2d');
    const mark = (ui, col) => {
      const u = w._gUnits[ui]; if (!u) return;
      const sc = screen(geomOf(u, iss.tShot), cam); if (!sc.box) return;
      const [x0, y0, x1, y1] = sc.box.map((v, i) => v * (i % 2 ? cv.height : cv.width));
      g.save(); g.lineWidth = 8; g.strokeStyle = col; g.setLineDash([26, 14]); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.restore();
    };
    mark(iss.ua, '#ff2a2a'); if (iss.ub != null) mark(iss.ub, '#ffb000');
    const txt = iss.type === 'stuck' ? `${iss.a} ⟷ ${iss.b}` : iss.type === 'zfight' ? `мерцает: ${iss.a}${iss.b ? ' / ' + iss.b : ''}` : `${iss.a}: ${iss.type === 'pop' ? (iss.dir === 'out' ? 'пропал' : 'возник') : iss.type === 'blink' ? 'мигает' : 'прыжок'}`;
    g.save(); g.font = `900 ${Math.round(cv.width * 0.045)}px Rubik, sans-serif`; g.textBaseline = 'top';
    const tw = g.measureText(txt).width; g.fillStyle = 'rgba(200,20,30,0.9)'; g.fillRect(20, 20, tw + 40, cv.width * 0.065);
    g.fillStyle = '#fff'; g.fillText(txt, 40, 30); g.restore();
    return cv.toDataURL('image/jpeg', 0.85);
  };
  G.reset = () => { G.tracks.clear(); G.pairs.clear(); G.zf.clear(); G.info = { decor: 0, attached: 0, touch: 0 }; };
})();
