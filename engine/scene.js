// ======================================================================
// scene.js — сцена из данных: scene.json (где что стоит, как движется, как снята) + PREFABS (как выглядит, код Claude).
// Формат — _pipeline/docs/studio/architecture.md §3.3–3.5. Движок поверх stage3d.js (world3d, card, box, lamp, model).
//
//   const WORLD = sceneWorld(SCENE, PREFABS);             // world3d из scene.world (fx, bg, fog, fov) + сборка + applyScene
//   WORLD.draw(ctx, t, D, t); drawSceneOverlays(WORLD.S, ctx, t);   // кадр + 2D-накладки сцены (заголовки поверх 3D)
// или вручную внутри своего мира:
//   build(w)  { S = buildFromScene(w, SCENE, PREFABS); }
//   update(w, lt) { applyScene(S, lt); }
//
// Время — чистая функция: кадр в момент t считается только из данных и t (ключи, шум камеры, префабы от T).
// Ключи: keys.<свойство> = [{ id, t, v, ease }], ease у ЛЕВОГО ключа задаёт кривую до следующего:
//   linear | io (плавно, по умолчанию) | in | out | hold (стоп-кадр). До первого и после последнего ключа — крайнее значение,
//   без ключей — статичное значение объекта. Логические (hide) и строки не интерполируются, цвета '#rrggbb' — да;
//   у логических до первого ключа — статичное значение («скрыть с 1.5 с» не прячет объект раньше).
// Углы хранятся «развёрнутыми»: редактор ставит новый ключ поворота ближе к прошлому (unwrapAngle), поэтому 179° → −179°
//   идёт через 180°, а не через ноль; движок интерполирует числа как есть.
// Поворот объекта rot = [x, y, z] в радианах, порядок 'YXZ' (сначала курс по Y, потом наклон) — удобно для карточек.
// Камера: keys [{ t, pos, target, fov?, ease }] + cuts [{ t }] — склейки: ключи по разные стороны склейки не интерполируются.
//
// Префабы (PREFABS[key]) — kind:
//   card    { px: [cw, ch], h, foot, rim, thick, back, glow, dynamic, draw(g, cw, ch, T, o), state(T, o) }  бумажная карточка (w.card)
//   box     { size, ppm, faces, color, glow, … }                                                        коробка (w.box)
//   group   { build(w, o) -> THREE.Object3D | { obj?, tick(T, o)? } }   всё, что build добавит в w.scene, уезжает в объект
//   model   { model: key, h, matte, color }                                                             glTF (w.model)
//   env     { build(w, o) }   окружение (стены, пол) — через scene.world.env: строится один раз, в дереве его нет
//   overlay { draw(ctx, T, o) }  2D поверх кадра (заголовок, плашка) — рисует drawSceneOverlays
// home: { pos, rotY } — место, где код префаба строит предмет (перенос старых сцен «как было»): движок сдвигает построенное
//   обратно в начало координат объекта, а в scene.json у объекта pos = home.pos, rot = [0, home.rotY, 0].
// У любого префаба может быть tick(T, o, root) — анимация «внутри» предмета (экран мигает, метель); движение по сцене — только ключами.
// o — объект сцены целиком (o.params — параметры префаба: цвет, надпись, вариант).
// ======================================================================

const SCN_EASE = {
  linear: t => t,
  io: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: t => t * t * t,
  out: t => 1 - Math.pow(1 - t, 3),
  hold: () => 0,
};

// ---------------------------------------------------------------- чистые функции (тесты: test/scene.test.js)
function scnHex(s) { const m = /^#([0-9a-f]{6})$/i.exec(s || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function scnLerpV(a, b, p) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => (typeof x === 'number' && typeof b[i] === 'number' ? x + (b[i] - x) * p : x));
  if (typeof a === 'string' && typeof b === 'string') {
    const A = scnHex(a), B = scnHex(b);
    if (A && B) return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * p).toString(16).padStart(2, '0')).join('');
  }
  return p < 1 ? a : b;
}
const scnSorted = keys => (keys || []).filter(k => k && typeof k.t === 'number').slice().sort((a, b) => a.t - b.t);

// value of a key track at time t; field — what to read from a key (v by default; the camera reads pos / target / fov)
function evalKeys(keys, t, base, field = 'v') {
  const K = scnSorted(keys).filter(k => k[field] !== undefined);
  if (!K.length) return base;
  if (t < K[0].t && typeof K[0][field] === 'boolean') return typeof base === 'boolean' ? base : !K[0][field];   // «скрыть с 1.5 с»: до ключа — как было
  if (t <= K[0].t) return K[0][field];
  const last = K[K.length - 1];
  if (t >= last.t) return last[field];
  let i = 0;
  while (i < K.length - 2 && t >= K[i + 1].t) i++;
  const a = K[i], b = K[i + 1], va = a[field], vb = b[field];
  if (typeof va === 'boolean' || typeof vb === 'boolean') return va;
  const ease = SCN_EASE[a.ease || 'io'] || SCN_EASE.io;
  if (a.ease === 'hold') return va;
  const p = b.t > a.t ? ease((t - a.t) / (b.t - a.t)) : 1;
  return scnLerpV(va, vb, p);
}

// the angle equal to a (mod 2π) that is closest to prev: keys of rotation never jump across ±π
function unwrapAngle(prev, a) {
  if (typeof prev !== 'number') return a;
  const TAU_ = Math.PI * 2;
  return a + Math.round((prev - a) / TAU_) * TAU_;
}

// [start, end) of the camera shot (between cuts) that holds t
function sceneShotOf(cuts, t) {
  let s = -Infinity, e = Infinity;
  for (const c of cuts || []) { if (c.t <= t && c.t > s) s = c.t; if (c.t > t && c.t < e) e = c.t; }
  return [s, e];
}

// camera at t: { pos, target, fov } from keys inside the current shot; no keys in the shot — the last key before it holds
function sceneCamAt(cam, t) {
  const fov0 = cam.fov || 30;
  const K = scnSorted(cam.keys);
  if (!K.length) return { pos: cam.pos || [0, 1.5, 6], target: cam.target || [0, 1, 0], fov: fov0 };
  const [s, e] = sceneShotOf(cam.cuts, t);
  let inShot = K.filter(k => k.t >= s && k.t < e);
  if (!inShot.length) { const before = K.filter(k => k.t < s); inShot = [before.length ? before[before.length - 1] : K[0]]; }
  return { pos: evalKeys(inShot, t, cam.pos, 'pos'), target: evalKeys(inShot, t, cam.target, 'target'), fov: evalKeys(inShot, t, fov0, 'fov') };
}

// handheld drift of the camera, the same formula as w.camKeys (stage3d.js)
function sceneHandheld(t, hh, noise) {
  if (!hh || !noise) return { p: [0, 0, 0], q: [0, 0, 0] };
  return { p: [noise(t * 0.35, 3) * hh, noise(t * 0.3, 5) * hh * 0.6, 0], q: [noise(t * 0.3, 9) * hh * 0.5, noise(t * 0.27, 11) * hh * 0.4, 0] };
}

const scnVec3 = (v, d) => (Array.isArray(v) ? [v[0] ?? d, v[1] ?? d, v[2] ?? d] : typeof v === 'number' ? [v, v, v] : [d, d, d]);

// transform of one object at t (local to its parent): { pos, rot, scale [x,y,z], hide }
function sceneObjectAt(o, t) {
  const k = o.keys || {};
  return {
    pos: scnVec3(evalKeys(k.pos, t, o.pos || [0, 0, 0]), 0),
    rot: scnVec3(evalKeys(k.rot, t, o.rot || [0, 0, 0]), 0),
    scale: scnVec3(evalKeys(k.scale, t, o.scale == null ? 1 : o.scale), 1),
    hide: !!evalKeys(k.hide, t, !!o.hide),
  };
}

// ---------------------------------------------------------------- привязки (links): «как Parent в After Effects / Child Of в Blender», но с момента
// o.links = [{ id, to: <id объекта>, from: t0, until?: t1 }] — с t0 объект едет за `to`: всё, что `to` сделал после t0, добавляется поверх своих ключей объекта
// (свои ключи и клипы работают как раньше). В t0 ничего не прыгает; после until набранный сдвиг остаётся (объект не телепортируется назад), следующая
// привязка добавляется сверху. Мир объекта = D · G · L: L — свои ключи, G — группа-родитель, D — произведение сдвигов привязок.
function scnLocalMatrix(o, t) {
  const st = sceneObjectAt(o, t);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(st.rot[0], st.rot[1], st.rot[2], 'YXZ'));
  return new THREE.Matrix4().compose(new THREE.Vector3(st.pos[0], st.pos[1], st.pos[2]), q, new THREE.Vector3(st.scale[0], st.scale[1], st.scale[2]));
}
function sceneLinksActive(o) { return (o.links || []).filter(l => l && l.to && typeof l.from === 'number'); }
function scnLinkDelta(byId, o, t, memo, stack) {
  const D = new THREE.Matrix4();
  for (const l of sceneLinksActive(o).filter(l => l.from <= t).sort((a, b) => a.from - b.from)) {
    if (!byId.get(l.to) || stack.has(l.to)) continue;                     // нет такого или цикл — пропустить
    const end = l.until != null ? Math.min(t, l.until) : t;
    const Pa = scnWorldAt(byId, l.to, end, memo, stack), Pf = scnWorldAt(byId, l.to, l.from, memo, stack);
    D.premultiply(Pa.clone().multiply(Pf.clone().invert()));
  }
  return D;
}
function scnWorldAt(byId, id, t, memo, stack = new Set()) {
  const k = id + '@' + t;
  if (memo.has(k)) return memo.get(k);
  const o = byId.get(id);
  if (!o) return new THREE.Matrix4();
  stack.add(id);
  const G = o.parent && byId.get(o.parent) && !stack.has(o.parent) ? scnWorldAt(byId, o.parent, t, memo, stack) : new THREE.Matrix4();
  const W = scnLinkDelta(byId, o, t, memo, stack).multiply(G).multiply(scnLocalMatrix(o, t));
  stack.delete(id);
  memo.set(k, W);
  return W;
}
// матрица узла привязки в пространстве группы-родителя: G⁻¹ · D · G
function scnPivotMatrix(byId, o, t, memo) {
  if (!sceneLinksActive(o).some(l => l.from <= t)) return null;
  const stack = new Set([o.id]);
  const D = scnLinkDelta(byId, o, t, memo, stack);
  const G = o.parent && byId.get(o.parent) ? scnWorldAt(byId, o.parent, t, memo, new Set([o.id])) : new THREE.Matrix4();
  return G.clone().invert().multiply(D).multiply(G);
}
// мир объекта в момент t (для редактора: «где он сейчас», привязать без прыжка)
function sceneWorldMatrixAt(scene, id, t) {
  return scnWorldAt(new Map((scene.objects || []).map(o => [o.id, o])), id, t, new Map());
}

// parents before children (a group is built before what is inside it); broken parent links fall back to the root
function sceneOrder(objects) {
  const byId = new Map(objects.map(o => [o.id, o])), out = [], seen = new Set();
  const visit = (o, stack) => {
    if (seen.has(o.id)) return;
    if (stack.has(o.id)) return;                       // a cycle: treat as root
    stack.add(o.id);
    const p = o.parent && byId.get(o.parent);
    if (p) visit(p, stack);
    seen.add(o.id); out.push(o);
  };
  for (const o of objects) visit(o, new Set());
  return out;
}

// all times with a key of an object / the camera / a light — for the timeline and for ↑ / ↓
function sceneKeyTimes(item) {
  const ts = new Set(), K0 = (item && item.keys) || {};
  for (const K of Array.isArray(K0) ? [K0] : Object.values(K0)) for (const k of K || []) if (k && typeof k.t === 'number') ts.add(+k.t.toFixed(4));
  return [...ts].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- сборка (браузер, three.js + stage3d.js)
// Everything a prefab's build adds to w.scene is moved into the object's holder group; the holder carries the object's transform.
function scnCapture(w, fn) {
  const before = new Set(w.scene.children);
  const ret = fn();
  const added = w.scene.children.filter(c => !before.has(c));
  return { ret, added };
}

// 3D-пропсы из библиотеки канала и препродакшена (S3, props3d.js): src.prefab = 'lib:props/<slug>@<N>' | 'el:<элемент>@v<N>'.
// Их prefab.js грузятся до сборки мира (loadSceneProps) и лежат в S.lib; prefabs.js сцены их не содержит.
// ---------------------------------------------------------------- предметы в руках (S10.2)
// o.hold = { handR: ref } — всё время; o.keys['hold.handR'] = [{ id, t, v: ref | null }] — с момента (ступенькой: взял в 4.2 с, положил в 7 с)
function sceneHoldSlots(o) {
  const s = new Set(Object.keys((o && o.hold) || {}));
  for (const k of Object.keys((o && o.keys) || {})) if (k.startsWith('hold.')) s.add(k.slice(5));
  return [...s];
}
function sceneHoldAt(o, slot, t) {
  const K = ((o.keys || {})['hold.' + slot] || []).slice().sort((a, b) => a.t - b.t);
  let v = ((o.hold || {})[slot]) || null;
  for (const k of K) if (k.t <= t + 1e-6) v = k.v || null;
  return v;
}
function sceneHoldRefs(o) {
  const out = Object.values((o && o.hold) || {});
  for (const [k, list] of Object.entries((o && o.keys) || {})) if (k.startsWith('hold.')) for (const x of list || []) out.push(x.v);
  return out.filter(Boolean);
}
// точка кисти на карточке: ёжик — кончик лапы (armL.end), риг частей — кость слота (slots) и её конец
function scnHandJoints(char, slot, J) {
  const sl = ((char.skel && char.skel.slots) || {})[slot] || (slot === 'handL' ? 'armL' : slot === 'handR' ? 'armR' : slot);
  if (J[sl + '.end']) return [J[sl + '.end'], J[sl]];
  const bones = (char.rigData && char.rigData.bones) || [];
  const ch = bones.find(b => b.parent === sl && J[b.id + '.end']);
  if (ch) return [J[ch.id + '.end'], J[ch.id]];
  return [J[sl], null];
}
// 2D-карточка: предмет в точку кисти, по направлению предплечья (зовётся и после перерисовки карточки — суставы того же кадра)
function scnHoldPlaceCard(card, rec) {
  const I = card.cardInfo, J = card.lastJoints, hc = I.hM * I.ch / I.size, wc = hc * I.cw / I.ch, fm = I.foot / I.ch * hc;
  for (const [slot, h] of Object.entries(rec.holds || {})) {
    if (!h) continue;
    const [P, A] = J ? scnHandJoints(card.char, slot, J) : [null, null];
    if (!P) { h.holder.visible = false; continue; }
    const inner = card.inner || card, grip = h.grip || {};
    if (h.holder.parent !== inner) inner.add(h.holder);
    const off = grip.off || [0, 0], ang = A ? -Math.atan2(P[1] - A[1], P[0] - A[0]) : -Math.PI / 2;
    const rz = (grip.follow === false ? 0 : ang + Math.PI / 2) + (grip.rot || 0), sc = grip.scale || 1;   // как висит лапа (вниз) — так стоит предмет без поворота
    const ox = off[0] * I.hM * sc, oy = off[1] * I.hM * sc, cz = Math.cos(rz), sz = Math.sin(rz);         // off — в осях предмета (как крепление в Spine): [0, -0.1] — кисть выше низа предмета
    h.holder.visible = true;
    h.holder.position.set((P[0] / I.cw - 0.5) * wc + ox * cz - oy * sz, (1 - P[1] / I.ch) * hc - fm + ox * sz + oy * cz, grip.back ? -0.03 : 0.03);
    h.holder.rotation.set(0, 0, rz);
    h.holder.scale.setScalar(sc);
  }
}
function scnHoldTick(S, o, rec, t) {
  rec.holds = rec.holds || {};
  if (rec.card === undefined) { rec.card = null; rec.holder.traverse(x => { if (!rec.card && x.char) rec.card = x; }); }
  const card = rec.card;
  for (const slot of sceneHoldSlots(o)) {
    const ref = sceneHoldAt(o, slot, t);
    let h = rec.holds[slot];
    if (h && h.ref !== ref) { h.holder.removeFromParent(); h = rec.holds[slot] = null; }
    if (!ref) continue;
    if (!h) {
      const holder = new THREE.Group(); holder.name = 'hold:' + slot;
      const r = scnBuildPrefab(S.w, S, { id: o.id + '#' + slot, name: (o.name || o.id) + ' · ' + slot, src: { prefab: ref }, params: {} }, holder);
      holder.traverse(x => { x.userData.sid = x.userData.sid || o.id; });       // клик по предмету в руке выбирает персонажа
      h = rec.holds[slot] = { ref, holder, tick: r.tick };
    }
    const char = card ? card.char : (rec.model && rec.model.char) || null, grip = (typeof rigGrip === 'function' && char) ? rigGrip(char, ref, slot) : {};
    h.grip = grip;
    if (card && card.cardInfo) {                                             // 2D-карточка: ставим после перерисовки (суставы этого кадра) — card.onJoints
      card.onJoints = () => scnHoldPlaceCard(card, rec);
      if (card.lastJoints) scnHoldPlaceCard(card, rec);
    } else {                                                                  // 3D-модель: к кости кисти (карта костей персонажа)
      const B = (char && char.bones) || {}, m = B[slot] || B[slot === 'handL' ? 'forearmL' : 'forearmR'];
      const bone = m && rec.holder.getObjectByName(String(m.bone).replace(/[\[\].:\/]/g, ''));
      if (!bone) { h.holder.visible = false; continue; }
      if (h.holder.parent !== bone) bone.add(h.holder);
      const ws = new THREE.Vector3(); bone.getWorldScale(ws);
      const off = grip.off || [0, 0, 0];
      h.holder.visible = true;
      h.holder.position.set((off[0] || 0) / ws.x, (off[1] || 0) / ws.y, (off[2] || 0) / ws.z);
      h.holder.rotation.set(0, 0, grip.rot || 0);
      h.holder.scale.set((grip.scale || 1) / ws.x, (grip.scale || 1) / ws.y, (grip.scale || 1) / ws.z);
    }
    if (h.tick) h.tick(t);
  }
}

function scenePropRefs(scene) {
  const refs = (scene.objects || []).map(o => (o.src || {}).prefab).concat(scene.libs || []).concat(...(scene.objects || []).map(sceneHoldRefs));   // libs — что нужно коду prefabs.js; предметы в руках (S10.2)
  return [...new Set(refs.filter(k => /^(lib|el):/.test(k || '')))];
}
function scenePropUrl(ref, plan) {
  const U = typeof SCENE_URLS !== 'undefined' ? SCENE_URLS : null;   // проект ролика (монтаж S6): файлы скопированы в assets/studio/
  let m = /^lib:([a-z]+)\/([a-z0-9-]+)@(\d+)$/.exec(ref || '');
  if (m) return U ? `${U.lib}${m[1]}/${m[2]}/v${m[3]}/prefab.js` : `/api/lib/file/video:${plan}/${m[1]}/${m[2]}/v${m[3]}/prefab.js`;
  m = /^el:([A-Za-z0-9_-]+)@v?(\d+)$/.exec(ref || '');
  if (m) return U ? `${U.el}${m[1]}/v${m[2]}/prefab.js` : `/rscene/${plan}/${m[1]}/v${m[2]}/prefab.js`;
  return null;
}
// load(src) — загрузчик скриптов страницы; into — уже загруженные (S.lib). Модели glb догружаются, если движок уже поднят
async function loadSceneProps(refs, plan, load, into = {}, scene = null) {
  if (scene) Object.defineProperty(into, '__scene', { value: scene, enumerable: false, configurable: true, writable: true });
  for (const ref of refs) {
    if (into[ref]) continue;
    const u = scenePropUrl(ref, plan);
    if (!u) continue;
    try {
      await load(u);
      // префаб регистрируется под путём от корня (def.url), а в проекте ролика адрес относительный ('../assets/studio/…') — сравниваем по пути от корня
      const abs = typeof location !== 'undefined' ? new URL(u, location.href).pathname : u;
      const def = (typeof PROPS3D !== 'undefined' && (PROPS3D[abs] || PROPS3D[u])) || (typeof CHAR_LAST !== 'undefined' && CHAR_LAST && (CHAR_LAST.url === abs || CHAR_LAST.url === u) ? CHAR_LAST : null) || PROP3D_LAST;
      for (const n of (def && def.needs) || []) await load(n);         // персонаж: его костюмы (costumes/*.js рядом)
      if (def && (def.extrasUrl || def.rigUrl || def.gripsUrl) && typeof rigLoadExtras === 'function') await rigLoadExtras(def);
      into[ref] = def;
    }
    catch (e) { console.warn('scene: пропс не загрузился', ref, e.message); }
  }
  // клипы анимаций (S5): id 'hog/wave' -> library/anims/hog/wave.json канала видео
  if (typeof RIG !== 'undefined' && typeof rigAnim === 'function' && into.__scene) {
    for (const id of sceneAnimRefs(into.__scene)) {
      if (RIG.anims[id]) continue;
      const u = typeof SCENE_URLS !== 'undefined' ? `${SCENE_URLS.anims}${id}.json` : `/api/lib/file/video:${plan}/anims/${id}.json?v=${Date.now()}`;
      try { const r = await fetch(u); if (r.ok) rigAnim(await r.json()); } catch (e) { console.warn('scene: клип не загрузился', id); }
    }
  }
  if (typeof X3 !== 'undefined' && X3.R && typeof loadModels3 === 'function') await loadModels3();
  return into;
}
// клипы, которые нужны персонажам сцены: clips[].anim и walk (кроме auto / off)
function sceneAnimRefs(scene) {
  const ids = [];
  for (const o of scene.objects || []) { for (const c of o.clips || []) ids.push(c.anim); if (o.walk && o.walk !== 'auto' && o.walk !== 'off') ids.push(o.walk); }
  return [...new Set(ids.filter(x => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(x || '')))];
}

function scnBuildPrefab(w, S, o, holder) {
  const key = o.src && o.src.prefab, pf = key && (S.prefabs[key] || S.lib[key]);
  const out = { tick: null, overlay: null };
  if (!pf) { if (key) console.warn('scene: нет префаба', key, 'у', o.name); return out; }
  const kind = pf.kind || (pf.build ? 'group' : pf.draw && pf.px ? 'card' : 'group');
  if (kind === 'overlay') { out.overlay = pf; return out; }
  const { ret, added } = scnCapture(w, () => {
    if (kind === 'card') {
      const c = Object.assign({}, pf, {
        pos: [0, 0, 0], rotY: 0, noItem: true, name: o.name,
        draw: pf.draw ? (g, cw, ch, lt, T) => pf.draw(g, cw, ch, T, o) : null,
        state: pf.state ? (lt, T) => pf.state(T, o) : null,
      });
      delete c.kind; delete c.tick;
      return w.card(c);
    }
    if (kind === 'box') { const b = Object.assign({}, pf, { pos: [0, 0, 0] }); delete b.kind; delete b.tick; return w.box(b); }
    if (kind === 'model' && !pf.build) return w.model(pf.model, Object.assign({}, pf, { pos: [0, 0, 0], name: o.name }));   // 3D-пропс (prop3d) собирает себя сам: ключ модели и детали
    return pf.build ? pf.build(w, o) : null;
  });
  // home: where the prefab code builds the thing (old scenes build «in place»): an inverse transform brings it to the object's origin,
  // so the object's pos / rot turn it around its own foot, not around the room centre
  let into = holder;
  if (pf.home) {
    const hp = pf.home.pos || [0, 0, 0], ry = pf.home.rotY || 0, c = Math.cos(-ry), s = Math.sin(-ry);
    into = new THREE.Group(); into.rotation.y = -ry;
    into.position.set(-(hp[0] * c + hp[2] * s), -hp[1], -(-hp[0] * s + hp[2] * c));
    holder.add(into);
  }
  for (const c of added) into.add(c);
  let obj = ret && ret.isObject3D ? ret : ret && ret.obj && ret.obj.isObject3D ? ret.obj : null;
  if (obj && !obj.parent) into.add(obj);
  const tick = (ret && !ret.isObject3D && typeof ret.tick === 'function' && ret.tick) || null;
  if (tick || pf.tick) out.tick = T => { if (tick) tick(T, o); if (pf.tick) pf.tick(T, o, holder); };
  // lights inside a prefab (w.lamp) keep running through w.ticks; they now move with the holder
  return out;
}

function scnMakeObject(w, S, o) {
  const holder = new THREE.Group();
  holder.name = o.name || o.id;
  holder.rotation.order = 'YXZ';
  holder.userData.sid = o.id;
  // узел привязки (links): между родителем-группой и holder — «едет вместе с креслом» поверх своих ключей; без привязок — единичная матрица
  const pivot = new THREE.Group();
  pivot.name = 'link:' + (o.name || o.id); pivot.userData.pivotOf = o.id; pivot.matrixAutoUpdate = false;
  pivot.add(holder);
  const r = o.type === 'group' ? {} : scnBuildPrefab(w, S, o, holder);
  const rec = { id: o.id, holder, pivot, tick: r.tick || null, overlay: r.overlay || null, prefab: o.src && o.src.prefab, parent: o.parent || null };
  S.objects.set(o.id, rec);
  return rec;
}

function scnAttach(S, rec) {
  const p = rec.parent && S.objects.get(rec.parent);
  (p ? p.holder : S.w.scene).add(rec.pivot || rec.holder);
}

function scnMakeLight(w, S, L) {
  let rec;
  const { added, ret } = scnCapture(w, () => {
    if (L.type === 'ambient') return w.ambient(L.sky || L.color || '#8090c0', L.ground || '#403028', L.intensity == null ? 0.6 : L.intensity);
    if (L.type === 'sun') return w.sun(Object.assign({}, L, { at: L.target || [0, 0, 0], dir: L.dir }));
    return w.lamp(Object.assign({}, L, { pos: [0, 0, 0], name: L.name }));      // lamp / point: light + halo + bulb
  });
  const holder = new THREE.Group(); holder.name = L.name || L.id; holder.userData.sid = L.id;
  if (L.type === 'lamp' || L.type === 'point' || !L.type) for (const c of added) holder.add(c);
  w.scene.add(holder);
  rec = { id: L.id, holder, type: L.type || 'lamp', obj: ret, base: L.intensity == null ? (L.type === 'ambient' ? 0.6 : 12) : L.intensity };
  S.lights.set(L.id, rec);
  return rec;
}

function buildFromScene(w, scene, PREFABS, LIB) {
  const S = { w, scene, prefabs: PREFABS || {}, lib: LIB || {}, objects: new Map(), lights: new Map(), env: [], t: 0 };
  for (const k of [].concat((scene.world && scene.world.env) || [])) {
    const pf = S.prefabs[k];
    if (!pf || !pf.build) { console.warn('scene: нет окружения', k); continue; }
    const r = pf.build(w, { id: 'env:' + k, params: (scene.world.params || {})[k] || {} });
    if (r && typeof r.tick === 'function') S.env.push(r.tick);
    if (pf.tick) S.env.push(T => pf.tick(T, {}, null));
  }
  for (const L of scene.lights || []) scnMakeLight(w, S, L);
  for (const o of sceneOrder(scene.objects || [])) scnAttach(S, scnMakeObject(w, S, o));
  w.S = S;
  return S;
}

// after structural edits (add / delete / duplicate / regroup / prefab change): build what is new, drop what is gone, re-parent
function syncScene(S, rebuild = []) {
  const w = S.w, objs = S.scene.objects || [], ids = new Set(objs.map(o => o.id));
  for (const [id, rec] of [...S.objects]) {
    if (!ids.has(id) || rebuild.includes(id)) {
      // children of a removed group are re-parented below; take them out first so they are not lost
      for (const ch of [...rec.holder.children]) if (ch.userData && ((ch.userData.sid && ch.userData.sid !== id) || ch.userData.pivotOf)) w.scene.add(ch);
      (rec.pivot || rec.holder).removeFromParent(); S.objects.delete(id);
    }
  }
  for (const o of sceneOrder(objs)) {
    let rec = S.objects.get(o.id);
    if (!rec) rec = scnMakeObject(w, S, o);
    rec.parent = o.parent && ids.has(o.parent) ? o.parent : null;
    const want = rec.parent ? S.objects.get(rec.parent).holder : w.scene;
    const node = rec.pivot || rec.holder;
    if (node.parent !== want) want.add(node);
  }
  const lids = new Set((S.scene.lights || []).map(l => l.id));
  for (const [id, rec] of [...S.lights]) if (!lids.has(id) || rebuild.includes(id)) { rec.holder.removeFromParent(); if (rec.obj && rec.obj.isLight) rec.obj.removeFromParent(); S.lights.delete(id); }
  for (const L of S.scene.lights || []) if (!S.lights.has(L.id)) scnMakeLight(w, S, L);
}

// every frame: prefab ticks, objects by their keys, lights, camera
function applyScene(S, t) {
  S.t = t;
  const w = S.w, scene = S.scene;
  for (const f of S.env) f(t);
  const byId = new Map((scene.objects || []).map(o => [o.id, o])), memo = new Map();
  for (const [id, rec] of S.objects) {
    const o = byId.get(id);
    if (!o) continue;
    const st = sceneObjectAt(o, t), h = rec.holder;
    if (!(S.hold && S.hold.has(id))) {                     // the editor is dragging it: the pointer owns the transform until release
      h.position.set(st.pos[0], st.pos[1], st.pos[2]);
      h.rotation.set(st.rot[0], st.rot[1], st.rot[2], 'YXZ');
      h.scale.set(st.scale[0], st.scale[1], st.scale[2]);
    }
    h.visible = !st.hide && !(S.editHidden && S.editHidden.has(id));
    rec.hidden = st.hide;
    if (rec.pivot) {                                         // привязки (links): сдвиг «за родителем» поверх своих ключей
      const M = o.links && o.links.length ? scnPivotMatrix(byId, o, t, memo) : null;
      if (M) rec.pivot.matrix.copy(M); else rec.pivot.matrix.identity();
      rec.pivot.matrixWorldNeedsUpdate = true;
    }
    if (rec.tick && h.visible) rec.tick(t);
    if (o.hold || (o.keys && Object.keys(o.keys).some(k => k.startsWith('hold.')))) scnHoldTick(S, o, rec, t);
  }
  for (const L of scene.lights || []) {
    const rec = S.lights.get(L.id);
    if (!rec) continue;
    const k = L.keys || {};
    const I = evalKeys(k.intensity, t, L.intensity == null ? rec.base : L.intensity);
    const on = !evalKeys(k.hide, t, !!L.hide);
    if (rec.type === 'ambient' || rec.type === 'sun') {
      if (rec.obj) { rec.obj.intensity = on ? I : 0; const c = evalKeys(k.color, t, L.color); if (c && rec.type === 'sun') rec.obj.color.set(c); }
      continue;
    }
    const p = scnVec3(evalKeys(k.pos, t, L.pos || [0, 2, 0]), 0);
    if (!(S.hold && S.hold.has(L.id))) rec.holder.position.set(p[0], p[1], p[2]);
    if (rec.obj) {
      rec.obj.k = on ? I / (rec.base || 1) : 0;
      const c = evalKeys(k.color, t, L.color);
      if (c && rec.obj.light) rec.obj.light.color.set(c);
    }
  }
  const cam = scene.camera || {};
  const c = sceneCamAt(cam, t), hh = sceneHandheld(t, cam.handheld, typeof noise1 === 'function' ? noise1 : null);
  w.cam.position.set(c.pos[0] + hh.p[0], c.pos[1] + hh.p[1], c.pos[2] + hh.p[2]);
  w.target.set(c.target[0] + hh.q[0], c.target[1] + hh.q[1], c.target[2] + hh.q[2]);
  w.cam.fov = c.fov;
  const f = cam.focus;
  w.focus = Array.isArray(f) ? new THREE.Vector3(f[0], f[1], f[2]) : null;
  if (S.camOverride) S.camOverride(w);                      // the editor's free camera
}

// 2D overlays (kind: 'overlay') in scene order, after the 3D frame
function drawSceneOverlays(S, ctx, t) {
  for (const o of S.scene.objects || []) {
    const rec = S.objects.get(o.id);
    if (!rec || !rec.overlay || rec.hidden || (S.editHidden && S.editHidden.has(o.id))) continue;
    ctx.save(); rec.overlay.draw(ctx, t, o); ctx.restore();
  }
}

// a whole world from a scene: fx / bg / fog / fov from scene.world
function sceneWorld(scene, PREFABS, LIB, extra = {}) {
  const wd = scene.world || {};
  const w = world3d(Object.assign({
    fx: wd.fx || 'night', bg: wd.bg, fog: wd.fog || null, fov: (scene.camera && scene.camera.fov) || wd.fov || 30,
    build(w) { w.S = buildFromScene(w, scene, PREFABS, LIB); },
    update(w, lt) { applyScene(w.S, lt); },
  }, extra));
  return w;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sceneWorldMatrixAt, scnPivotMatrix, scenePropRefs, sceneHoldSlots, sceneHoldAt, sceneHoldRefs, scenePropUrl, sceneAnimRefs, SCN_EASE, evalKeys, unwrapAngle, sceneShotOf, sceneCamAt, sceneHandheld, sceneObjectAt, sceneOrder, sceneKeyTimes, scnLerpV };
}
