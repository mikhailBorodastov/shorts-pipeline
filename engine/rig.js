// ======================================================================
// rig.js — персонажи со скелетом (S4 Claude Studio, docs/studio/stage4-characters.md). Подключается после paper.js и stage3d.js.
//
// Персонаж рисуется в 2D-холст (кадр 2D-ролика или холст бумажной карточки в 3D) по ПОЗЕ:
//   pose = { bones: { armL: { rot, len }, body: { rot, sq }, legL: { rot }… }, face: { eyes, lid, blink, look: [x, y], mouth, brows, tired, wink },
//            wear: { 'kepka': true, 'pijama-mishki': false }, sit: true, facing: 'front' | 'back' }
//   Углы — радианы ОТ позы покоя, len — множитель длины. Что надето — char.wear (по умолчанию) поверх wear позы.
//   rigDraw(ctx, char, pose, x, yНог, рост, T)     нарисовать; T — время (дыхание, моргание)
//   rigPose(...слои)                               слить позы (база персонажа, эмоция, ключи сцены)
//   character({ id, name, skeleton: 'hog', rig: 'param', base: {…}, wear: {…}, costumes: ['costumes/x.js'], emotions: {…} })
//                                                  регистрирует персонажа (файл vN/prefab.js библиотеки); он же — префаб сцены (charCard)
//   costume({ id, name, slot, layers: { body(ctx, st), over(ctx, st), legs(ctx, st), head(ctx, st) } })   костюм (vN/costumes/<id>.js)
//   charCard(w, char, o)                           бумажная карточка персонажа в 3D; c.pose — поза, Paper Mario — доворот к камере
// Риги: 'param' — ёжик (drawHog, таблица HOG_SKELETON.map), 'parts' — части на костях (кот; pins / bend) — §3.2 ТЗ.
// ======================================================================

const RIG = { costumes: {}, chars: {}, skeletons: {} };
let CHAR_LAST = null, COSTUME_LAST = null;

// ---------------------------------------------------------------- скелет ёжика (библиотека: skeletons/hog.json — его копия)
const HOG_SKELETON = {
  schema: 1, type: 'hog', name: 'Ёжик', rig: 'param',
  // pos — сустав в долях роста (0 — ноги, y вверх); len — длина кости в долях роста
  bones: [
    { id: 'root', pos: [0, 0] },
    { id: 'body', parent: 'root', pos: [0, 0.02], len: 0.5, limits: [-0.6, 0.6], note: 'наклон и сжатие тела' },
    { id: 'head', parent: 'body', pos: [0, 0.62], len: 0.36, note: 'голова: шапки, очки, наушники' },
    { id: 'armL', parent: 'body', pos: [-0.28, 0.46], len: 0.24, limits: [-2.6, 3.0] },
    { id: 'armR', parent: 'body', pos: [0.28, 0.46], len: 0.24, limits: [-2.6, 3.0] },
    { id: 'legL', parent: 'root', pos: [-0.1, 0.04], len: 0.1, limits: [-1, 1] },
    { id: 'legR', parent: 'root', pos: [0.1, 0.04], len: 0.1, limits: [-1, 1] },
  ],
  slots: { body: 'body', head: 'head', handL: 'armL', handR: 'armR', back: 'body', legs: 'root' },
  face: { eyes: ['open', 'half', 'closed'], brows: ['none', 'up', 'angry', 'sad', 'worried'], mouth: ['o', 'flat', 'smile', 'sad', 'open'], look: [-1, 1] },
  map: { 'armL.rot': 'armL (+0.15 покой)', 'armL.len': 'lenL', 'armR.rot': 'armR', 'armR.len': 'lenR', 'body.rot': 'наклон вокруг таза', 'body.sq': 'sq',
         'legL.rot': 'шаг (подъём) / качание ноги сидя', 'legR.rot': 'то же', 'face.*': 'look, lid, blink, mouth, brows, tired, wink' },
  poses: {
    'покой': {},
    'руки вверх': { bones: { armL: { rot: -2.95 }, armR: { rot: -2.95 } }, face: { mouth: 'open', brows: 'up' } },
    'шаг': { bones: { armL: { rot: 0.35 }, armR: { rot: -0.35 }, legL: { rot: 1 }, body: { rot: 0.05 } } },
    'сидит': { sit: true, bones: { legL: { rot: 0.1 }, legR: { rot: -0.1 } } },
    'наклон': { bones: { body: { rot: -0.18, sq: 0.06 }, armR: { rot: -1.2, len: 1.3 } }, face: { look: [0.8, 0.2] } },
  },
};
RIG.skeletons.hog = HOG_SKELETON;

// ---------------------------------------------------------------- регистрация (файлы библиотеки вызывают их при загрузке)
function _rigSrc() { return ((document.currentScript && document.currentScript.src) || '').replace(/[?#].*$/, ''); }
function costume(def) {
  const src = _rigSrc();
  def.url = src.replace(location.origin, '');
  RIG.costumes[def.id] = def; COSTUME_LAST = def;
  return def;
}
function character(def) {
  const src = _rigSrc(), base = src.replace(/[^/]*$/, '');
  def.url = src.replace(location.origin, '');
  def.needs = (def.costumes || []).map(c => (/^(\/|https?:)/.test(c) ? c : base + c).replace(location.origin, ''));
  def.skel = RIG.skeletons[def.skeleton] || null;
  if (/\/characters\/[^/]+\/v\d+\/$/.test(base)) def.extrasUrl = base + '../emotions.json';   // библиотека: эмоции, утверждённые после публикации — общие для всех версий
  if (def.rig === 'parts') def.rigUrl = base + 'rig.json';           // части: суставы, крепление частей, позы — данными (редактор скелета их двигает)
  // префаб сцены: kind 'group' — engine/scene.js собирает его как 3D-пропс (S.lib), см. charCard
  def.kind = 'group';
  def.build = (w, o) => { const c = charCard(w, def, { name: (o && o.name) || def.name, o }); return { obj: c, tick: T => { c.pose = c.keyed(T); } }; };
  RIG.chars[def.id] = def; CHAR_LAST = def;
  if (typeof PROPS3D !== 'undefined') PROPS3D[def.url] = def;     // loadSceneProps находит его так же, как 3D-пропс
  return def;
}

// эмоции из characters/<slug>/emotions.json поверх тех, что в prefab.js (загрузчики зовут после загрузки персонажа)
async function rigLoadExtras(def) {
  if (!def) return def;
  if (def.rigUrl) {
    try { const r = await fetch(def.rigUrl + '?v=' + Date.now()); if (r.ok) rigUseData(def, await r.json()); } catch (e) { console.error('rig.json: ' + e.message); }
  }
  if (def.extrasUrl) {
    try { const r = await fetch(def.extrasUrl + '?v=' + Date.now()); if (r.ok) def.emotions = Object.assign({}, def.emotions || {}, await r.json()); } catch (e) {}
  }
  return def;
}
// данные рига частей (rig.json) -> персонаж: скелет типа (для листа, поз и редактора) и кэш частей сбрасывается
function rigUseData(def, R) {
  def.rigData = R; def._parts = null;
  def.skel = { type: R.type || def.skeleton, name: R.typeName || R.type, rig: 'parts', bones: (R.bones || []).map(b => ({ id: b.id, parent: b.parent, limits: b.limits })),
    slots: R.slots || {}, poses: R.poses || {} };
  RIG.skeletons[def.skel.type] = RIG.skeletons[def.skel.type] || def.skel;
  if (R.emotions) def.emotions = Object.assign({}, R.emotions, def.emotions || {});
}

// ---------------------------------------------------------------- позы
function _rigMerge(a, b) {
  if (b == null) return a;
  if (typeof b !== 'object' || Array.isArray(b)) return b;
  const out = Object.assign({}, a && typeof a === 'object' && !Array.isArray(a) ? a : {});
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? _rigMerge(out[k], v) : v;
  return out;
}
function rigPose(...layers) { return layers.reduce((a, b) => _rigMerge(a, b || {}), {}); }
const _bone = (pose, id) => (pose.bones && pose.bones[id]) || {};

// эмоция персонажа -> слой позы лица
function rigEmotion(char, name) { const e = (char.emotions || {})[name]; return e ? { face: Object.assign({ name }, e, { ok: undefined, by: undefined, note: undefined }) } : {}; }

// что надето: char.wear + pose.wear (true / false по id костюма)
function rigWorn(char, pose) {
  const w = Object.assign({}, char.wear || {}, pose.wear || {});
  return Object.keys(w).filter(k => w[k]).map(k => RIG.costumes[k]).filter(Boolean);
}

// ---------------------------------------------------------------- риг 'param': ёжик на drawHog
// угол и длина лапы, чтобы кончик пришёл в (tx, ty) — в долях роста от ног персонажа (y вниз, как в canvas); для поведения сцены (S5 — IK)
function rigHogAim(char, pose, side, tx, ty) {
  const kind = (char.base || {}).kind || 'adult', sit = !!pose.sit;
  const yh = sit ? (pose.facing === 'back' ? -0.32 : -0.26) : 0, a = aim(0, yh, 1, side, tx, ty, kind);
  return { rot: a.ang - 0.15, len: a.len };
}

function rigHog(ctx, char, pose, x, y, h, T) {
  const base = char.base || {}, kind = base.kind || 'adult', F = pose.face || {}, S = HOG_PX, k = h / S;
  const sit = !!pose.sit, back = pose.facing === 'back', worn = rigWorn(char, pose);
  const legs = base.legs || 'feet';
  // стоит на коротких ножках (как hogCard) — тело выше на длину ножки
  const L = legs === 'short' && !sit ? h * 0.1 : 0;
  const yh = sit ? y - (back ? 0.32 : 0.26) * h : y - L;
  const bd = _bone(pose, 'body'), aL = _bone(pose, 'armL'), aR = _bone(pose, 'armR'), lL = _bone(pose, 'legL'), lR = _bone(pose, 'legR');
  const eyes = F.eyes || 'open';
  const lid = F.lid != null ? F.lid : eyes === 'half' ? 0.62 : base.lid != null ? base.lid : (kind === 'kid' ? 0 : 0.28);
  const blink = eyes === 'closed' ? 1 : F.blink != null ? F.blink : F.autoBlink === false ? 0 : blinkAt(T || 0, base.seed || 1);
  const st = { char, pose, S, x, y, yh, h, k, sit, back, T: T || 0, paws: null, legSwing: lL.rot || 0, legSwingR: lR.rot || 0 };
  const hopt = {
    kind, t: T || 0, look: F.look || [0, 0], blink, lid, backView: back, mouth: F.mouth || 'o', brows: F.brows, tired: F.tired, wink: F.wink,
    armL: 0.15 + (aL.rot || 0), armR: 0.15 + (aR.rot || 0), lenL: aL.len || 1, lenR: aR.len || 1, sq: bd.sq || 0,
    liftL: sit ? 0 : Math.max(0, lL.rot || 0), liftR: sit ? 0 : Math.max(0, lR.rot || 0),
  };
  const bodyLayers = worn.filter(c => c.layers && c.layers.body), headLayers = worn.filter(c => c.layers && c.layers.head);
  if (!back) hopt.prop = (c, SS) => { const s2 = Object.assign({}, st, { S: SS }); for (const cs of bodyLayers) cs.layers.body(c, s2); for (const cs of headLayers) cs.layers.head(c, s2); };
  for (const cs of worn) if (cs.layers && cs.layers.under) cs.layers.under(ctx, st);
  if (legs === 'short' && !sit) rigHogShortLegs(ctx, x, y, h, kind, hopt.liftL, hopt.liftR);
  ctx.save();
  ctx.translate(x, yh); ctx.rotate(bd.rot || 0); ctx.translate(-x, -yh);          // наклон — вокруг таза, вместе с рукавами
  ctx.save();
  ctx.beginPath(); ctx.rect(x - 2 * h, yh - 3 * h, 4 * h, 3 * h + (sit ? (y - 0.22 * h) - yh : 0.025 * h)); ctx.clip();   // сидя — низ тела прячется в сиденье
  st.paws = drawHog(ctx, x, yh, h, hopt);
  ctx.restore();
  // суставы для показа скелета поверх (в координатах ctx до наклона): тело, голова, плечи и кончики лап, ноги
  const rx = (HOG_KINDS[kind] || HOG_KINDS.adult).rx;
  const cs = Math.cos(bd.rot || 0), sn = Math.sin(bd.rot || 0), rotP = (px, py) => [x + (px - x) * cs - (py - yh) * sn, yh + (px - x) * sn + (py - yh) * cs];
  st.joints = {
    root: [x, y], body: rotP(x, yh - 0.02 * h), head: rotP(x, yh - 0.62 * h),
    armL: rotP(x - rx * 0.86 * h, yh - 0.46 * h), armR: rotP(x + rx * 0.86 * h, yh - 0.46 * h),
    'armL.end': st.paws && st.paws.L ? rotP(st.paws.L[0], st.paws.L[1]) : null, 'armR.end': st.paws && st.paws.R ? rotP(st.paws.R[0], st.paws.R[1]) : null,
    legL: [x - 0.1 * h, y - (sit ? 0.36 * h : 0.04 * h)], legR: [x + 0.1 * h, y - (sit ? 0.36 * h : 0.04 * h)],
  };
  if (back) { ctx.save(); ctx.translate(x, yh); ctx.scale(k, k); for (const cs of bodyLayers) cs.layers.body(ctx, st); for (const cs of headLayers) cs.layers.head(ctx, st); ctx.restore(); }
  for (const cs of worn) if (cs.layers && cs.layers.over) cs.layers.over(ctx, st);
  ctx.restore();
  if (sit && !back) {
    const lg = worn.find(c => c.layers && c.layers.legs);
    if (lg) lg.layers.legs(ctx, st);
    else rigHogLegsFront(ctx, x, y, h, st.legSwing, (HOG_KINDS[kind] || HOG_KINDS.adult).mask);
  }
  return st;
}
// короткие ножки под телом (как у hogCard)
function rigHogShortLegs(ctx, x, y, h, kind, liftL, liftR) {
  const col = (HOG_KINDS[kind] || HOG_KINDS.adult).mask, L = h * 0.1;
  for (const sx of [-1, 1]) {
    const lift = (sx < 0 ? liftL : liftR) * h * 0.05, lx = x + sx * h * 0.1;
    cut(ctx, inf => rectP(lx - h * 0.038, y - L - h * 0.06, h * 0.076, L + h * 0.05 - lift, inf), col, { seed: 610 + sx, edge: 0, amp: 1.5, shadow: false });
    cut(ctx, inf => ellP(lx + sx * h * 0.018, y - lift - h * 0.022, h * 0.066 + inf, h * 0.032 + inf, 0, 18), col, { seed: 612 + sx, edge: 0, amp: 1.5, shadow: false });
    for (let j = -1; j <= 1; j++) circle(ctx, lx + sx * h * 0.018 + j * h * 0.03, y - lift - h * 0.012, h * 0.012, '#8e8e94');
  }
}
// ножки вперёд, когда сидит без костюма со своими штанинами
function rigHogLegsFront(ctx, x, y, h, sw, col) {
  ctx.save(); ctx.translate(x, y);
  [[-1, 0.05 + sw], [1, -0.04 - sw]].forEach(([sx, r], i) => {
    ctx.save(); ctx.translate(sx * 0.12 * h, -0.36 * h); ctx.rotate(r * 0.6);
    const w = 0.12 * h, L = 0.2 * h;
    cut(ctx, inf => [[-w / 2 - inf, -inf], [w / 2 + inf, -inf], [w * 0.45 + inf, L * 0.8], [0, L + inf], [-w * 0.45 - inf, L * 0.8]], col, { seed: 620 + i, edge: 0, amp: 1.5, blur: 8 });
    for (let j = -1; j <= 1; j++) circle(ctx, j * 0.025 * h, L * 0.9, 0.012 * h, '#8e8e94');
    ctx.restore();
  });
  ctx.restore();
}


// ---------------------------------------------------------------- риг 'parts': части на костях (кот и все не-ёжики)
// rig.json: { type, mode: 'pins' | 'bend', sheet: [W, H], foot: [x, y], height: рост на листе (px),
//   bones: [{ id, parent, joint: [x, y], end?: [x, y], limits? }],            суставы — в пикселях листа, покой
//   parts: [{ id, bone | bones: [цепочка], z }],                              часть на одной кости (pins) или гнётся по цепочке (bend)
//   face: { base: 'часть', emotions: { 'радость': 'часть' } }, poses: { имя: поза }, emotions: { имя: { name } } }
// Рисунки частей — функции в prefab.js: character({ …, parts: { имя(g) { … рисует в координатах листа … } } }).
function _rigAff(a, b, c, d, e, f) { return { a, b, c, d, e, f }; }
function _rigMul(m, n) { return _rigAff(m.a * n.a + m.c * n.b, m.b * n.a + m.d * n.b, m.a * n.c + m.c * n.d, m.b * n.c + m.d * n.d, m.a * n.e + m.c * n.f + m.e, m.b * n.e + m.d * n.f + m.f); }
function _rigApply(m, x, y) { return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }
const _RIG_I = _rigAff(1, 0, 0, 1, 0, 0);
// мировые матрицы костей в координатах листа: M_b = M_parent · T(J) · R(rot) · T(-J); root — ещё и сдвиг (x, y px)
function rigPartsBones(R, pose) {
  const B = {}, byId = {}; for (const b of R.bones || []) byId[b.id] = b;
  const get = id => {
    if (B[id]) return B[id];
    const b = byId[id]; if (!b) return _RIG_I;
    const pb = (pose.bones || {})[id] || {}, P = b.parent ? get(b.parent) : _RIG_I;
    const [jx, jy] = b.joint || [0, 0], r = pb.rot || 0, c = Math.cos(r), s = Math.sin(r);
    let m = _rigMul(P, _rigAff(1, 0, 0, 1, jx + (pb.x || 0), jy + (pb.y || 0)));
    m = _rigMul(m, _rigAff(c, s, -s, c, 0, 0));
    if (pb.sx || pb.sy) m = _rigMul(m, _rigAff(pb.sx || 1, 0, 0, pb.sy || 1, 0, 0));
    m = _rigMul(m, _rigAff(1, 0, 0, 1, -jx, -jy));
    return (B[id] = m);
  };
  for (const b of R.bones || []) get(b.id);
  return B;
}
// часть -> холст, обрезанный по непрозрачному (один раз)
function _rigPartCanvas(def, id) {
  def._parts = def._parts || {};
  if (def._parts[id]) return def._parts[id];
  const R = def.rigData, [W0, H0] = R.sheet || [1000, 1000], fn = (def.parts || {})[id];
  const c = document.createElement('canvas'); c.width = W0; c.height = H0;
  if (fn) fn(c.getContext('2d'));
  const d = c.getContext('2d').getImageData(0, 0, W0, H0).data;
  let x0 = W0, y0 = H0, x1 = -1, y1 = -1;
  for (let y = 0; y < H0; y += 2) for (let x = 0; x < W0; x += 2) if (d[(y * W0 + x) * 4 + 3] > 4) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let out = { img: null, x: 0, y: 0 };
  if (x1 >= 0) {
    x0 = Math.max(0, x0 - 4); y0 = Math.max(0, y0 - 4); x1 = Math.min(W0, x1 + 5); y1 = Math.min(H0, y1 + 5);
    const k = document.createElement('canvas'); k.width = x1 - x0; k.height = y1 - y0;
    k.getContext('2d').drawImage(c, -x0, -y0); out = { img: k, x: x0, y: y0 };
  }
  return (def._parts[id] = out);
}
// веса вершин сетки к костям цепочки: обратное расстояние до отрезка кости (в покое), степень 4 — мягкий сгиб у сустава
function _rigSeg(R, id) {
  const bs = R.bones || [], b = bs.find(x => x.id === id); if (!b) return null;
  const ch = bs.find(x => x.parent === id), a = b.joint, e = b.end || (ch && ch.joint) || [a[0], a[1] - 1];
  return [a, e];
}
function _rigDistSeg(x, y, s) {
  const [[ax, ay], [bx, by]] = s, vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L));
  return Math.hypot(x - ax - vx * t, y - ay - vy * t);
}
function _rigMesh(def, part, P) {
  def._mesh = def._mesh || {};
  const key = part.id;
  if (def._mesh[key]) return def._mesh[key];
  const R = def.rigData, n = part.grid || 10, W = P.img.width, H = P.img.height, segs = part.bones.map(b => _rigSeg(R, b));
  const V = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const u = i / n * W, v = j / n * H, sx = P.x + u, sy = P.y + v;
    let ws = segs.map(s => (s ? 1 / Math.pow(_rigDistSeg(sx, sy, s) + 6, 4) : 0)), sum = ws.reduce((a, b) => a + b, 0) || 1;
    V.push({ u, v, sx, sy, w: ws.map(x => x / sum) });
  }
  return (def._mesh[key] = { n, V });
}
// треугольник источника (u, v на холсте части) -> треугольник на экране: аффинная матрица
function _rigTri(ctx, img, s0, s1, s2, d0, d1, d2) {
  const [u0, v0] = s0, [u1, v1] = s1, [u2, v2] = s2, [x0, y0] = d0, [x1, y1] = d1, [x2, y2] = d2;
  const den = u0 * (v2 - v1) - u1 * v2 + u2 * v1 + (u1 - u2) * v0;
  if (Math.abs(den) < 1e-9) return;
  const a = -(v0 * (x2 - x1) - v1 * x2 + v2 * x1 + (v1 - v2) * x0) / den, b = -(v0 * (y2 - y1) - v1 * y2 + v2 * y1 + (v1 - v2) * y0) / den;
  const c = (u0 * (x2 - x1) - u1 * x2 + u2 * x1 + (u1 - u2) * x0) / den, d = (u0 * (y2 - y1) - u1 * y2 + u2 * y1 + (u1 - u2) * y0) / den;
  const e = (u0 * (v2 * x1 - v1 * x2) + v0 * (u1 * x2 - u2 * x1) + (u2 * v1 - u1 * v2) * x0) / den;
  const f = (u0 * (v2 * y1 - v1 * y2) + v0 * (u1 * y2 - u2 * y1) + (u2 * v1 - u1 * v2) * y0) / den;
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, gr = (x, y) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + dx / l * 0.8, y + dy / l * 0.8]; };
  ctx.save(); ctx.beginPath();
  const p0 = gr(x0, y0), p1 = gr(x1, y1), p2 = gr(x2, y2);
  ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath(); ctx.clip();
  ctx.transform(a, b, c, d, e, f); ctx.drawImage(img, 0, 0);
  ctx.restore();
}
function rigParts(ctx, char, pose, x, y, h, T) {
  const R = char.rigData;
  if (!R) { ctx.save(); ctx.fillStyle = '#a33'; ctx.font = '24px Rubik'; ctx.fillText('нет rig.json', x - 60, y - h / 2); ctx.restore(); return null; }
  const [fx, fy] = R.foot || [0, 0], k = h / (R.height || 900), M = rigPartsBones(R, pose);
  const face = pose.face || {}, F = R.face || {}, back = pose.facing === 'back';
  const faceIds = new Set([F.base, ...Object.values(F.emotions || {})].filter(Boolean));
  const faceNow = back ? null : (F.emotions || {})[face.name] || F.base;
  ctx.save();
  ctx.translate(x, y); if (pose.flip) ctx.scale(-1, 1); ctx.scale(k, k); ctx.translate(-fx, -fy);
  const parts = (R.parts || []).slice().sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const part of parts) {
    if (faceIds.has(part.id) && part.id !== faceNow) continue;
    if (back && part.front) continue;
    const P = _rigPartCanvas(char, part.id); if (!P.img) continue;
    const chain = part.bones && part.bones.length > 1 && (R.mode || 'bend') === 'bend' ? part.bones : null;
    if (!chain) {
      const m = M[part.bone || (part.bones || [])[0]] || _RIG_I;
      ctx.save(); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f); ctx.drawImage(P.img, P.x, P.y); ctx.restore();
      continue;
    }
    const mesh = _rigMesh(char, Object.assign({}, part, { bones: chain }), P), n = mesh.n, V = mesh.V;
    const D = V.map(v => { let dx = 0, dy = 0; chain.forEach((b, i) => { if (!v.w[i]) return; const q = _rigApply(M[b] || _RIG_I, v.sx, v.sy); dx += q[0] * v.w[i]; dy += q[1] * v.w[i]; }); return [dx, dy]; });
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      _rigTri(ctx, P.img, [V[a].u, V[a].v], [V[b].u, V[b].v], [V[c].u, V[c].v], D[a], D[b], D[c]);
      _rigTri(ctx, P.img, [V[b].u, V[b].v], [V[d].u, V[d].v], [V[c].u, V[c].v], D[b], D[d], D[c]);
    }
  }
  ctx.restore();
  // суставы для показа скелета (в координатах ctx)
  const tr = (px, py) => { let X = (px - fx) * k, Y = (py - fy) * k; if (pose.flip) X = -X; return [x + X, y + Y]; };
  const joints = {};
  for (const b of R.bones || []) {
    const par = b.parent ? M[b.parent] : _RIG_I, q = _rigApply(par, b.joint[0], b.joint[1]);
    joints[b.id] = tr(q[0], q[1]);
    if (b.end) { const e = _rigApply(M[b.id], b.end[0], b.end[1]); joints[b.id + '.end'] = tr(e[0], e[1]); }
  }
  return { joints, k, M };
}

// ---------------------------------------------------------------- общий вход
function rigDraw(ctx, char, pose, x, y, h, T) {
  if (!char) return null;
  if (char.rig === 'param' || char.skeleton === 'hog') return rigHog(ctx, char, pose || {}, x, y, h, T);
  if (typeof rigParts === 'function') return rigParts(ctx, char, pose || {}, x, y, h, T);
  return null;
}

// ---------------------------------------------------------------- 3D: бумажная карточка персонажа
// o: name, h (рост, м), px ([w, h] холста), size (рост на холсте), o (объект сцены: params.pose / params.emotion, keys pose.* / face.* / wear.*)
// c.pose — текущая поза (поведение сцены или клип S5 пишут сюда); Paper Mario: channel rules — PAPER_RULES
const PAPER_RULES = { paperFacing: true, facingMaxDeg: 40 };
function charCard(w, char, opt = {}) {
  const size = opt.size || 600, cw = opt.px ? opt.px[0] : 800, ch = opt.px ? opt.px[1] : 900, foot = 10;
  const hM = opt.h || char.h || 0.9;                                    // рост персонажа в метрах
  const so = opt.o || {}, P = so.params || {};
  let c = null;
  const cur = () => { const p = (c && c.pose) || {}; return c && c.autoBack ? Object.assign({}, p, { facing: 'back' }) : p; };
  c = w.card({
    name: opt.name || char.name, px: [cw, ch], h: hM * ch / size, foot, rim: 6, dynamic: true, thick: 0.02, glow: opt.self == null ? 0.22 : opt.self, noItem: !!opt.o,
    state(lt, T) { return JSON.stringify(cur(), (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)) + '|' + Math.round(T * 8) + '|' + blinkAt(T, (char.base || {}).seed || 1).toFixed(1); },
    draw(g, cw2, ch2, lt, T) { rigDraw(g, char, cur(), cw2 / 2, ch2 - foot, size, T); },
  });
  c.char = char;
  c.pose = rigPose(char.pose, P.pose, P.emotion ? rigEmotion(char, P.emotion) : null);
  c.basePose = c.pose;
  // ключи объекта сцены: pose.<кость>.<rot|len|sq>, face.<поле>, wear.<костюм> — поверх позы (дорожки S5 ложатся сюда же)
  c.keyed = T => rigPose(c.basePose, c.keyLayer(T));
  c.keyLayer = T => {                                       // только то, что задают ключи (поверх позы поведения или базы)
    const K = (so.keys) || {};
    let p = {};
    for (const [prop, list] of Object.entries(K)) {
      if (!list || !list.length) continue;
      if (prop === 'emotion') { const e = evalKeys(list, T, undefined); if (e) p = rigPose(p, rigEmotion(char, e)); continue; }
      const m = /^(pose|face|wear)\.(.+)$/.exec(prop);
      if (!m) continue;
      const v = evalKeys(list, T, undefined);
      if (v === undefined) continue;
      if (m[1] === 'pose') { const [b, f] = m[2].split('.'); p = rigPose(p, { bones: { [b]: { [f]: v } } }); }
      else if (m[1] === 'face') p = rigPose(p, { face: { [m[2]]: v } });
      else p = rigPose(p, { wear: { [m[2]]: v } });
    }
    return p;
  };
  // Paper Mario: карточка доворачивается к камере не больше facingMaxDeg; спиной — только по сюжету (pose.facing) или если повёрнут от камеры > 90°
  const R = Object.assign({}, PAPER_RULES, opt.rules || {});
  w.tick(() => {
    if (!R.paperFacing || !c.parent) return;
    const inner = c.inner || c;
    const wp = new THREE.Vector3(); c.getWorldPosition(wp);
    const q = new THREE.Quaternion(); (c.parent || c).getWorldQuaternion(q);
    const yaw0 = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    const toCam = Math.atan2(w.cam.position.x - wp.x, w.cam.position.z - wp.z);
    let d = Math.atan2(Math.sin(toCam - yaw0), Math.cos(toCam - yaw0));
    const lim = R.facingMaxDeg * Math.PI / 180;
    const away = Math.abs(d) > Math.PI / 2;
    if (away && !(c.pose && c.pose.facing)) { c.autoBack = true; d = d > 0 ? d - Math.PI : d + Math.PI; } else c.autoBack = false;
    inner.rotation.y = Math.max(-lim, Math.min(lim, d));
  });
  return c;
}
