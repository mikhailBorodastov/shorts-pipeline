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
  def.build = (w, o) => { const c = charCard(w, def, { name: (o && o.name) || def.name, o }); return { obj: c, tick: T => { c.pose = c.scenePose(T); } }; };
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


// ---------------------------------------------------------------- S5: клипы, слои, IK, ходьба, липсинк (docs/studio/stage5-animations.md)
// клип: { id: 'hog/wave', name, type, dur, loop, tracks: { 'armR.rot': [[t, v, ease?]…], 'face.mouth': [[t, 'open']], 'ik.armR': [[t, [x, y]]], 'card.y': …, sit, facing }, proc: 'gait' }
RIG.anims = RIG.anims || {};
function rigAnim(a) { if (a && a.id) RIG.anims[a.id] = a; return a; }
const _RIG_EASE = { linear: p => p, io: p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2), in: p => p * p, out: p => 1 - (1 - p) * (1 - p), hold: () => 0 };
function _rigLerp(a, b, p) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => (typeof x === 'number' && typeof b[i] === 'number' ? x + (b[i] - x) * p : x));
  return p < 1 ? a : b;
}
// значение дорожки [[t, v, ease?]…] в момент t (ступенькой для строк и логических, до первого — первое, после последнего — последнее)
function rigTrackAt(list, t) {
  if (!list || !list.length) return undefined;
  const K = list.slice().sort((a, b) => a[0] - b[0]);
  if (t <= K[0][0]) return K[0][1];
  const last = K[K.length - 1]; if (t >= last[0]) return last[1];
  let i = 0; while (i < K.length - 2 && t >= K[i + 1][0]) i++;
  const a = K[i], b = K[i + 1];
  if (typeof a[1] !== 'number' && !Array.isArray(a[1])) return a[1];
  const e = _RIG_EASE[a[2] || 'io'] || _RIG_EASE.io;
  return _rigLerp(a[1], b[1], e((t - a[0]) / (b[0] - a[0] || 1)));
}
// дорожки клипа в момент lt -> слой позы
function rigClipLayer(anim, lt) {
  const L = {};
  for (const [name, list] of Object.entries(anim.tracks || {})) {
    const v = rigTrackAt(list, lt); if (v === undefined) continue;
    const [a, b] = name.split('.');
    if (a === 'face') (L.face = L.face || {})[b] = v;
    else if (a === 'ik') (L.ik = L.ik || {})[b] = v;
    else if (a === 'card') (L.card = L.card || {})[b] = v;
    else if (b === undefined) L[a] = v;                                  // sit, facing
    else ((L.bones = L.bones || {})[a] = L.bones[a] || {})[b] = v;
  }
  return L;
}
// слой b поверх a с весом w (числа и массивы — плавно, строки и логические — с середины)
const _RIG_DEF = { rot: 0, len: 1, sq: 0, x: 0, y: 0, rz: 0, ry: 0, sy: 0 };
function rigBlend(a, b, w) {
  if (!b || w <= 0) return a;
  const out = JSON.parse(JSON.stringify(a || {}));
  const mixv = (x, y, d) => (w >= 1 ? y : _rigLerp(x === undefined ? d : x, y, w));
  for (const [bn, ch] of Object.entries(b.bones || {})) {
    const o = ((out.bones = out.bones || {})[bn] = out.bones[bn] || {});
    for (const [f, v] of Object.entries(ch)) o[f] = mixv(o[f], v, _RIG_DEF[f] == null ? 0 : _RIG_DEF[f]);
  }
  for (const k of ['face', 'card']) for (const [f, v] of Object.entries(b[k] || {})) { const o = (out[k] = out[k] || {}); o[f] = typeof v === 'number' || Array.isArray(v) ? mixv(o[f], v, k === 'card' ? (_RIG_DEF[f] || 0) : v) : (w >= 0.5 ? v : o[f]); }
  for (const [f, v] of Object.entries(b.ik || {})) { const o = (out.ik = out.ik || {}); o[f] = o[f] ? _rigLerp(o[f], v, w) : v; out._ikw = Object.assign(out._ikw || {}, { [f]: Math.max(w, (out._ikw || {})[f] || 0) }); }
  for (const k of ['sit', 'facing']) if (b[k] !== undefined && w >= 0.5) out[k] = b[k];
  return out;
}

// ---- IK
// ёжик: цель лапы [x, y] в долях роста от ног (y вверх) -> угол и длина (drawHog: одна кость, тянется)
function rigIKHog(char, pose, side, tgt) { return rigHogAim(char, pose, side, tgt[0], -tgt[1]); }
// две кости (плечо a + предплечье b) к цели в координатах листа: закон косинусов; bend — сторона сгиба (+1 / −1)
function rigIK2(R, pose, ida, idb, tgt, bend = 1) {
  const bs = R.bones || [], A = bs.find(x => x.id === ida), B = bs.find(x => x.id === idb); if (!A || !B) return null;
  const end = B.end || (bs.find(x => x.parent === idb) || {}).joint; if (!end) return null;
  const M = rigPartsBones(R, Object.assign({}, pose, { bones: Object.assign({}, pose.bones, { [ida]: {}, [idb]: {} }) }));
  const P = M[A.parent] || _RIG_I, J = _rigApply(P, A.joint[0], A.joint[1]);           // плечо в мире листа
  const la = Math.hypot(B.joint[0] - A.joint[0], B.joint[1] - A.joint[1]), lb = Math.hypot(end[0] - B.joint[0], end[1] - B.joint[1]);
  const dx = tgt[0] - J[0], dy = tgt[1] - J[1], d = Math.max(1e-6, Math.min(la + lb - 1e-3, Math.hypot(dx, dy)));
  const c2 = (d * d - la * la - lb * lb) / (2 * la * lb), q2 = bend * Math.acos(Math.max(-1, Math.min(1, c2)));
  const q1 = Math.atan2(dy, dx) - Math.atan2(lb * Math.sin(q2), la + lb * Math.cos(q2));
  const restA = Math.atan2(B.joint[1] - A.joint[1], B.joint[0] - A.joint[0]), restB = Math.atan2(end[1] - B.joint[1], end[0] - B.joint[0]);
  const parentRot = Math.atan2(P.b, P.a);
  return { [ida]: { rot: q1 - restA - parentRot }, [idb]: { rot: q2 - restB + restA } };   // мировые углы: A = родитель + покой A + a; B = … + покой B + a + b
}
function rigSolveIK(char, pose) {
  if (!pose.ik) return pose;
  const out = JSON.parse(JSON.stringify(pose)); out.bones = out.bones || {};
  for (const [bone, tgt] of Object.entries(pose.ik)) {
    if (!tgt) continue;
    const w = (pose._ikw || {})[bone] == null ? 1 : pose._ikw[bone];
    let sol = null;
    if (char.rig === 'param' || char.skeleton === 'hog') { const r = rigIKHog(char, out, bone === 'armL' ? -1 : 1, tgt); sol = { [bone]: { rot: r.rot, len: r.len } }; }
    else if (char.rigData) {
      const R = char.rigData, ch = (R.bones || []).find(b => b.parent === bone);
      const [fx, fy] = R.foot || [0, 0], hh = R.height || 900;
      const T = [fx + tgt[0] * hh, fy - tgt[1] * hh];
      if (ch) sol = rigIK2(R, out, bone, ch.id, T, (R.bones.find(b => b.id === bone) || {}).bend || 1);
    }
    if (sol) out.bones = rigBlend({ bones: out.bones }, { bones: sol }, w).bones;
  }
  delete out.ik; delete out._ikw;
  return out;
}

// ---- ходьба: фаза от пройденного пути (как hogCard + gait3), для ёжика — встроенный клип 'hog/walk'
rigAnim({ id: 'hog/walk', name: 'Ходьба', type: 'hog', proc: 'gait', stride: 0.32, dur: 1, loop: true });
function rigGaitLayer(char, phase) {
  const s = Math.sin(phase);
  if (char.rig === 'param' || char.skeleton === 'hog')
    return { bones: { legL: { rot: Math.max(0, -s) }, legR: { rot: Math.max(0, s) }, armL: { rot: s * 0.35 }, armR: { rot: -s * 0.35 } }, card: { y: Math.abs(s) * 0.045, rz: s * 0.05 } };
  const a = RIG.anims[(char.skel && char.skel.type) + '/walk'];
  if (a && !a.proc) return rigClipLayer(a, (phase / TAU * (a.dur || 1)) % (a.dur || 1));
  return { card: { y: Math.abs(s) * 0.03, rz: s * 0.04 } };
}
// путь объекта по ключам позиции к моменту T (кэш по 1/30 с) и скорость
function rigPath(o, T) {
  const K = (o.keys || {}).pos; if (!K || K.length < 2) return { dist: 0, speed: 0 };
  const sig = JSON.stringify(K);
  if (!o._path || o._path.sig !== sig) {
    const end = Math.max(...K.map(k => k.t)) + 1, n = Math.ceil(end * 30) + 2, D = new Float32Array(n);
    let prev = evalKeys(K, 0, o.pos || [0, 0, 0]);
    for (let i = 1; i < n; i++) { const p = evalKeys(K, i / 30, prev); D[i] = D[i - 1] + Math.hypot(p[0] - prev[0], p[2] - prev[2]); prev = p; }
    Object.defineProperty(o, '_path', { value: { sig, D }, enumerable: false, configurable: true, writable: true });
  }
  const D = o._path.D, i = Math.max(0, Math.min(D.length - 2, T * 30)), i0 = Math.floor(i), f = i - i0;
  const dist = D[i0] + (D[i0 + 1] - D[i0]) * f;
  const j = Math.min(D.length - 1, Math.floor(T * 30) + 3), k = Math.max(0, Math.floor(T * 30) - 3);
  return { dist, speed: (D[j] - D[k]) / ((j - k) / 30 || 1) };
}

// ---- липсинк: громкость звуков сцены (сервер: /api/scene/env), RIG.envs[sid] = { t0, fps, env }
RIG.envs = RIG.envs || {};
function rigEnvAt(sid, T) { const E = RIG.envs[sid]; if (!E) return 0; const i = Math.floor((T - E.t0) * E.fps); return i >= 0 && i < E.env.length ? E.env[i] : 0; }
async function loadSceneEnvs(scene, plan, el) {
  for (const o of scene.objects || []) {
    const sid = o.lipsync && o.lipsync.sound; if (!sid) continue;
    try { const r = await fetch(`/api/scene/env?key=${encodeURIComponent('plan:' + plan)}&el=${el}&sid=${sid}`); if (r.ok) RIG.envs[sid] = await r.json(); } catch (e) {}
  }
}

// ---- объект сцены -> поза: клипы, ходьба, ключи позы, IK, эмоция, костюмы, липсинк. env(T) — громкость звука липсинка 0..1
function rigSceneLayer(char, o, T, base, env) {
  let p = base || {};
  const FADE = 0.2;
  let legsBusy = false;
  for (const c of (o.clips || []).slice().sort((a, b) => a.t - b.t)) {
    const a = RIG.anims[c.anim]; if (!a) continue;
    const dur = c.dur || a.dur || 1; if (T < c.t || T > c.t + dur) continue;
    const w = Math.max(0, Math.min(1, (T - c.t) / FADE, (c.t + dur - T) / FADE, 1));
    if (a.proc === 'gait') { p = rigBlend(p, rigGaitLayer(char, (T - c.t) * (c.speed || 1) * TAU), w); legsBusy = true; continue; }
    let lt = (T - c.t) * (c.speed || 1); lt = c.loop || a.loop ? lt % (a.dur || 1) : Math.min(lt, a.dur || dur);
    const L = rigClipLayer(a, lt);
    if (L.bones && (L.bones.legL || L.bones.legR)) legsBusy = true;
    p = rigBlend(p, L, w);
  }
  if (o.walk !== 'off' && !legsBusy) {
    const { dist, speed } = rigPath(o, T), w = Math.max(0, Math.min(1, speed / 0.25));
    if (w > 0.01) { const st = (RIG.anims[(o.walk && o.walk !== 'auto') ? o.walk : 'hog/walk'] || {}).stride || 0.32; p = rigBlend(p, rigGaitLayer(char, dist / st * Math.PI), w); }
  }
  // ключи позы: по каналам между ключами, у которых этот канал задан
  const PK = (o.pose || []).slice().sort((a, b) => a.t - b.t);
  if (PK.length) {
    const chans = {};
    for (const k of PK) {
      for (const [b, f] of Object.entries(k.bones || {})) for (const [ff, v] of Object.entries(f)) (chans['b.' + b + '.' + ff] = chans['b.' + b + '.' + ff] || []).push([k.t, v, k.ease || 'io']);
      for (const [b, v] of Object.entries(k.ik || {})) (chans['ik.' + b] = chans['ik.' + b] || []).push([k.t, v, k.ease || 'io']);
      for (const [f, v] of Object.entries(k.face || {})) (chans['f.' + f] = chans['f.' + f] || []).push([k.t, v, k.ease || 'io']);
      for (const f of ['sit', 'facing']) if (k[f] !== undefined) (chans['s.' + f] = chans['s.' + f] || []).push([k.t, k[f]]);   // ступенькой
    }
    const L = {}, IW = {};
    for (const [ch, list] of Object.entries(chans)) {
      const [kind, b, f] = ch.split('.');
      if (kind === 'ik') {                                 // цель лапы; ключ с null — «отпустить»: вес IK плавно уходит в 0
        const K = list.slice().sort((x, y) => x[0] - y[0]);
        let tg = null, wt = 0;
        if (T <= K[0][0]) { tg = K[0][1]; wt = tg ? 1 : 0; }
        else if (T >= K[K.length - 1][0]) { tg = K[K.length - 1][1]; wt = tg ? 1 : 0; }
        else {
          let i = 0; while (i < K.length - 2 && T >= K[i + 1][0]) i++;
          const A0 = K[i], B0 = K[i + 1], e = (_RIG_EASE[A0[2] || 'io'] || _RIG_EASE.io)((T - A0[0]) / (B0[0] - A0[0] || 1));
          if (A0[1] && B0[1]) { tg = _rigLerp(A0[1], B0[1], e); wt = 1; } else if (A0[1]) { tg = A0[1]; wt = 1 - e; } else if (B0[1]) { tg = B0[1]; wt = e; }
        }
        if (tg && wt > 0) { (L.ik = L.ik || {})[b] = tg; IW[b] = wt; }
        continue;
      }
      const v = rigTrackAt(list, T);
      if (kind === 'b') ((L.bones = L.bones || {})[b] = L.bones[b] || {})[f] = v;
      else if (kind === 'ik') (L.ik = L.ik || {})[b] = v;
      else if (kind === 's') L[b] = v;
      else (L.face = L.face || {})[b] = v;
    }
    p = rigBlend(p, L, 1);
    if (L.ik) p._ikw = Object.assign({}, p._ikw, IW);
  }
  p = rigSolveIK(char, p);
  if (env != null && o.lipsync) { const e = env(T); if (e > (o.lipsync.threshold || 0.12)) p = rigPose(p, { face: { mouth: 'open' } }); }
  return p;
}

// 2D-кадр с каналами карточки (подскок, наклон, сжатие, поворот) — то, что в 3D делает charCard (для 2D-роликов, стенда, ленты кадров)
function rigDrawCard(ctx, char, pose, x, y, h, T) {
  const K = pose.card || {}, m = h / (char.h || 0.9);
  ctx.save(); ctx.translate(x, y - (K.y || 0) * m); ctx.rotate(-(K.rz || 0)); ctx.scale(Math.max(0.02, Math.abs(Math.cos(K.ry || 0))), 1 + (K.sy || 0));
  const st = rigDraw(ctx, char, pose, 0, 0, h, T);
  ctx.restore();
  return st;
}
// клип на персонаже в момент lt (для стенда, листа и ленты): база персонажа + клип + IK
function rigClipPose(char, anim, lt, base) {
  if (anim.proc === 'gait') return rigSolveIK(char, rigBlend(base || char.pose || {}, rigGaitLayer(char, lt * TAU), 1));
  return rigSolveIK(char, rigBlend(base || char.pose || {}, rigClipLayer(anim, lt), 1));
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
    state(lt, T) { return JSON.stringify(cur(), (k, v) => (k === 'card' ? undefined : typeof v === 'number' ? Math.round(v * 100) / 100 : v)) + '|' + Math.round(T * 8) + '|' + blinkAt(T, (char.base || {}).seed || 1).toFixed(1); },
    draw(g, cw2, ch2, lt, T) { const st = rigDraw(g, char, cur(), cw2 / 2, ch2 - foot, size, T); if (c) c.lastJoints = st && st.joints; },
  });
  c.char = char;
  c.cardInfo = { cw, ch, size, foot, hM };                   // холст px -> карточка м: редактор ставит ручки IK на кончики лап
  c.pose = rigPose(char.pose, P.pose, P.emotion ? rigEmotion(char, P.emotion) : null);
  c.basePose = c.pose;
  // ключи объекта сцены: pose.<кость>.<rot|len|sq>, face.<поле>, wear.<костюм> — поверх позы (дорожки S5 ложатся сюда же)
  c.keyed = T => rigPose(c.basePose, c.keyLayer(T));
  // S5: всё, что задаёт объект сцены (клипы, ходьба, ключи позы, IK, эмоция, костюмы, липсинк) поверх base (база персонажа или поза поведения)
  c.env = T => (so.lipsync && so.lipsync.sound ? rigEnvAt(so.lipsync.sound, T) : 0);       // липсинк: громкость звука сцены
  c.scenePose = (T, base) => rigPose(rigSceneLayer(char, so, T, base || c.basePose, c.env || null), c.keyLayer(T));
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
    inner.rotation.y = Math.max(-lim, Math.min(lim, d)) + ((c.pose && c.pose.card && c.pose.card.ry) || 0);
  });
  // каналы карточки из клипов и ходьбы (card.y / rz / sy) — поверх того, что делает поведение (gait3 / hop3)
  w.tick(() => {
    const K = (c.pose && c.pose.card) || null, inner = c.inner || c;
    if (!K) { if (c._cardSet) { inner.position.y = 0; inner.rotation.z = 0; inner.scale.y = 1; c._cardSet = false; } return; }
    inner.position.y = K.y || 0; inner.rotation.z = K.rz || 0; inner.scale.y = 1 + (K.sy || 0); c._cardSet = true;
  });
  return c;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { RIG, rigAnim, rigTrackAt, rigClipLayer, rigBlend, rigPose, rigPartsBones, rigIK2, rigSceneLayer, rigPath, rigGaitLayer };
