// Чистые функции анимации (S5): node engine/test/rig.test.js
const assert = require('assert');
global.TAU = Math.PI * 2;
global.evalKeys = require('../scene.js').evalKeys;
const R = require('../rig.js');
let n = 0, failed = 0;
const test = (name, f) => { n++; try { f(); console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n  ' + e.message); } };
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('дорожка: интерполяция, ступенька у строк, края', () => {
  const L = [[0, 0, 'linear'], [1, 2]];
  near(R.rigTrackAt(L, 0.5), 1); near(R.rigTrackAt(L, -1), 0); near(R.rigTrackAt(L, 5), 2);
  assert.strictEqual(R.rigTrackAt([[0, 'flat'], [1, 'open']], 0.9), 'flat');
  assert.strictEqual(R.rigTrackAt([[0, 'flat'], [1, 'open']], 1), 'open');
  assert.deepStrictEqual(R.rigTrackAt([[0, [0, 0], 'linear'], [2, [2, 4]]], 1), [1, 2]);
});

test('клип -> слой: кости, лицо, IK, карточка', () => {
  const L = R.rigClipLayer({ tracks: { 'armR.rot': [[0, 0, 'linear'], [1, 1]], 'face.mouth': [[0, 'open']], 'ik.armL': [[0, [0.1, 0.5]]], 'card.y': [[0, 0.1]], sit: [[0, true]] } }, 0.5);
  near(L.bones.armR.rot, 0.5); assert.strictEqual(L.face.mouth, 'open'); assert.deepStrictEqual(L.ik.armL, [0.1, 0.5]); near(L.card.y, 0.1); assert.strictEqual(L.sit, true);
});

test('смешивание с весом: числа плавно, строки с середины, длина от 1', () => {
  const b = R.rigBlend({ bones: { armR: { rot: 0 } }, face: { mouth: 'flat' } }, { bones: { armR: { rot: 1, len: 2 } }, face: { mouth: 'open' } }, 0.25);
  near(b.bones.armR.rot, 0.25); near(b.bones.armR.len, 1.25); assert.strictEqual(b.face.mouth, 'flat');
  assert.strictEqual(R.rigBlend({ face: { mouth: 'flat' } }, { face: { mouth: 'open' } }, 0.6).face.mouth, 'open');
});

test('IK две кости: кончик приходит в цель', () => {
  const rig = { foot: [0, 0], height: 100, bones: [
    { id: 'root', joint: [0, 0] }, { id: 'arm', parent: 'root', joint: [0, 0] }, { id: 'fore', parent: 'arm', joint: [60, 0], end: [110, 0] } ] };
  for (const T of [[80, 30], [30, -70], [-50, 40]]) {
    const sol = R.rigIK2(rig, { bones: {} }, 'arm', 'fore', T, 1);
    const M = R.rigPartsBones(rig, { bones: sol });
    const m = M.fore, e = [m.a * 110 + m.c * 0 + m.e, m.b * 110 + m.d * 0 + m.f];
    near(e[0], T[0], 0.05); near(e[1], T[1], 0.05);
  }
});

test('путь по ключам позиции и скорость', () => {
  const o = { pos: [0, 0, 0], keys: { pos: [{ t: 0, v: [0, 0, 0], ease: 'linear' }, { t: 2, v: [2, 0, 0] }] } };
  near(R.rigPath(o, 1).dist, 1, 0.02); near(R.rigPath(o, 1).speed, 1, 0.05); near(R.rigPath(o, 3).speed, 0, 0.01);
});

test('клип в сцене: плавный вход и выход, петля', () => {
  R.rigAnim({ id: 't/up', type: 't', dur: 1, tracks: { 'armR.rot': [[0, 1], [1, 1]] } });
  const ch = { rig: 'parts', skeleton: 't' }, o = { clips: [{ t: 1, dur: 2, anim: 't/up', loop: true }], walk: 'off' };
  near(R.rigSceneLayer(ch, o, 1.1, {}).bones.armR.rot, 0.5);
  near(R.rigSceneLayer(ch, o, 2, {}).bones.armR.rot, 1);
  assert.ok(!(R.rigSceneLayer(ch, o, 3.5, {}).bones || {}).armR);
});

test('ходьба включается сама от ключей позиции', () => {
  const ch = { rig: 'param', skeleton: 'hog' }, o = { pos: [0, 0, 0], keys: { pos: [{ t: 0, v: [0, 0, 0], ease: 'linear' }, { t: 2, v: [1.2, 0, 0] }] } };
  const p = R.rigSceneLayer(ch, o, 1, {});
  assert.ok(p.card && p.card.y >= 0 && p.bones && p.bones.armL);
  assert.ok(!R.rigSceneLayer(ch, Object.assign({}, o, { walk: 'off' }), 1, {}).card);
});

test('ключи позы: IK держится, «отпустить» (null) плавно снимает его', () => {
  const ch = { rig: 'parts', skeleton: 't', rigData: { foot: [0, 0], height: 100, bones: [{ id: 'root', joint: [0, 0] }, { id: 'arm', parent: 'root', joint: [0, 0] }, { id: 'fore', parent: 'arm', joint: [60, 0], end: [110, 0] }] } };
  const o = { walk: 'off', pose: [{ t: 1, ik: { arm: [0.8, 0.3] } }, { t: 2, ik: { arm: null } }] };
  const a = R.rigSceneLayer(ch, o, 1, {}), m = R.rigSceneLayer(ch, o, 1.5, {}), z = R.rigSceneLayer(ch, o, 2.5, {});
  assert.ok(a.bones && Math.abs(a.bones.arm.rot) > 0.1);
  assert.ok(Math.abs(m.bones.arm.rot) < Math.abs(a.bones.arm.rot) && Math.abs(m.bones.arm.rot) > 0.01);
  assert.ok(!z.bones || !z.bones.arm || Math.abs(z.bones.arm.rot || 0) < 1e-6);
});

console.log(`\n${n - failed} / ${n} тестов прошли`);
process.exit(failed ? 1 : 0);
