// Тесты чистых функций движка сцены (scene.js): node template/src/test/scene.test.js
const assert = require('assert');
const S = require('../scene.js');

let n = 0, failed = 0;
function test(name, fn) {
  n++;
  try { fn(); } catch (e) { failed++; console.log('✗', name, '\n  ', e.message); return; }
  console.log('✓', name);
}
const near = (a, b, eps = 1e-6) => {
  if (Array.isArray(a)) { a.forEach((x, i) => near(x, b[i], eps)); return; }
  assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
};

test('без ключей — статичное значение', () => {
  assert.deepStrictEqual(S.evalKeys([], 3, [1, 2, 3]), [1, 2, 3]);
  assert.strictEqual(S.evalKeys(undefined, 3, 5), 5);
});

test('до первого и после последнего — крайние значения', () => {
  const K = [{ t: 1, v: 10 }, { t: 3, v: 20 }];
  assert.strictEqual(S.evalKeys(K, 0, 0), 10);
  assert.strictEqual(S.evalKeys(K, 9, 0), 20);
});

test('linear — середина', () => {
  near(S.evalKeys([{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 10 }], 0.5, 0), 2.5);
});

test('io по умолчанию, симметрия и середина', () => {
  const K = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
  near(S.evalKeys(K, 0.5, 0), 0.5);
  near(S.evalKeys(K, 0.25, 0) + S.evalKeys(K, 0.75, 0), 1);
  assert.ok(S.evalKeys(K, 0.1, 0) < 0.1, 'плавный вход медленнее линейного');
});

test('in / out', () => {
  const kin = [{ t: 0, v: 0, ease: 'in' }, { t: 1, v: 1 }], kout = [{ t: 0, v: 0, ease: 'out' }, { t: 1, v: 1 }];
  near(S.evalKeys(kin, 0.5, 0), 0.125);
  near(S.evalKeys(kout, 0.5, 0), 0.875);
});

test('hold — стоп-кадр до следующего ключа', () => {
  const K = [{ t: 0, v: 1, ease: 'hold' }, { t: 2, v: 5 }];
  assert.strictEqual(S.evalKeys(K, 1.99, 0), 1);
  assert.strictEqual(S.evalKeys(K, 2, 0), 5);
});

test('ключи в любом порядке, три ключа', () => {
  const K = [{ t: 2, v: 20, ease: 'linear' }, { t: 0, v: 0, ease: 'linear' }, { t: 1, v: 10, ease: 'linear' }];
  near(S.evalKeys(K, 1.5, 0), 15);
  near(S.evalKeys(K, 0.5, 0), 5);
});

test('векторы', () => {
  near(S.evalKeys([{ t: 0, v: [0, 0, 0], ease: 'linear' }, { t: 1, v: [2, 4, 6] }], 0.5, null), [1, 2, 3]);
});

test('логические — без интерполяции', () => {
  const K = [{ t: 0, v: false }, { t: 1, v: true }];
  assert.strictEqual(S.evalKeys(K, 0.99, null), false);
  assert.strictEqual(S.evalKeys(K, 1, null), true);
});

test('цвета #rrggbb интерполируются', () => {
  assert.strictEqual(S.evalKeys([{ t: 0, v: '#000000', ease: 'linear' }, { t: 1, v: '#ffffff' }], 0.5, null), '#808080');
});

test('углы: unwrapAngle без скачка через ±π', () => {
  const a = S.unwrapAngle(3.1, -3.1);                 // 177.6° -> -177.6° = 182.4°
  near(a, 2 * Math.PI - 3.1);
  const K = [{ t: 0, v: [0, 3.1, 0], ease: 'linear' }, { t: 1, v: [0, a, 0] }];
  const mid = S.evalKeys(K, 0.5, null)[1];
  near(mid, Math.PI, 1e-3);                           // через 180°, а не через 0
  near(S.unwrapAngle(0.2, 0.3), 0.3);
  near(S.unwrapAngle(10 * Math.PI + 0.1, 0.1), 10 * Math.PI + 0.1);
});

test('камера: ключи внутри плана, склейка — без интерполяции', () => {
  const cam = { fov: 30, keys: [
    { t: 0, pos: [0, 0, 10], target: [0, 0, 0], ease: 'linear' },
    { t: 4, pos: [0, 0, 6], target: [0, 0, 0] },
    { t: 5, pos: [5, 1, 2], target: [1, 1, 1], fov: 20, ease: 'linear' },
    { t: 7, pos: [5, 1, 0], target: [1, 1, 1], fov: 20 },
  ], cuts: [{ t: 5 }] };
  near(S.sceneCamAt(cam, 2).pos, [0, 0, 8]);
  near(S.sceneCamAt(cam, 4.99).pos, [0, 0, 6]);            // до склейки — крайний ключ своего плана
  near(S.sceneCamAt(cam, 5).pos, [5, 1, 2]);               // сразу после — новый план
  near(S.sceneCamAt(cam, 6).pos, [5, 1, 1]);
  near(S.sceneCamAt(cam, 2).fov, 30);
  near(S.sceneCamAt(cam, 6).fov, 20);
});

test('камера: план без ключей держит последний ключ до него', () => {
  const cam = { keys: [{ t: 0, pos: [1, 1, 1], target: [0, 0, 0] }, { t: 2, pos: [2, 2, 2], target: [0, 0, 0] }], cuts: [{ t: 3 }, { t: 6 }] };
  near(S.sceneCamAt(cam, 4).pos, [2, 2, 2]);
  near(S.sceneCamAt(cam, 7).pos, [2, 2, 2]);
});

test('sceneShotOf — границы плана', () => {
  assert.deepStrictEqual(S.sceneShotOf([{ t: 2 }, { t: 5 }], 3), [2, 5]);
  assert.deepStrictEqual(S.sceneShotOf([{ t: 2 }, { t: 5 }], 1), [-Infinity, 2]);
  assert.deepStrictEqual(S.sceneShotOf([], 1), [-Infinity, Infinity]);
});

test('sceneObjectAt: статичное, ключи, масштаб числом, скрытие', () => {
  const o = { pos: [1, 0, 0], rot: [0, 0.5, 0], scale: 2, keys: { pos: [{ t: 0, v: [0, 0, 0], ease: 'linear' }, { t: 2, v: [2, 0, 0] }], hide: [{ t: 1.5, v: true }] } };
  const a = S.sceneObjectAt(o, 1);
  near(a.pos, [1, 0, 0]); near(a.rot, [0, 0.5, 0]); near(a.scale, [2, 2, 2]);
  assert.strictEqual(a.hide, false);
  assert.strictEqual(S.sceneObjectAt(o, 1.6).hide, true);
});

test('группы: родитель раньше детей, цикл не вешает', () => {
  const order = S.sceneOrder([{ id: 'a', parent: 'g' }, { id: 'b' }, { id: 'g', parent: 'h' }, { id: 'h' }, { id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }]).map(o => o.id);
  assert.ok(order.indexOf('h') < order.indexOf('g') && order.indexOf('g') < order.indexOf('a'));
  assert.strictEqual(order.length, 6);
});

test('keyTimes — все моменты ключей объекта и камеры', () => {
  assert.deepStrictEqual(S.sceneKeyTimes({ keys: { pos: [{ t: 2 }, { t: 1 }], rot: [{ t: 2 }] } }), [1, 2]);
  assert.deepStrictEqual(S.sceneKeyTimes({ keys: [{ t: 3 }, { t: 0 }] }), [0, 3]);
});

test('handheld — детерминирован от t', () => {
  const noise = (x, s) => Math.sin(x * 12.9898 + s);
  assert.deepStrictEqual(S.sceneHandheld(1.5, 0.02, noise), S.sceneHandheld(1.5, 0.02, noise));
  near(S.sceneHandheld(1, 0, noise).p, [0, 0, 0]);
});

test('3D-пропсы: ссылки lib: / el: — адреса prefab.js и список без повторов (S3)', () => {
  assert.strictEqual(S.scenePropUrl('lib:props/elt-monitor@2', '260930-08d8'), '/api/lib/file/video:260930-08d8/props/elt-monitor/v2/prefab.js');
  assert.strictEqual(S.scenePropUrl('el:eee455b0d@v3', '260930-08d8'), '/rscene/260930-08d8/eee455b0d/v3/prefab.js');
  assert.strictEqual(S.scenePropUrl('crt', 'x'), null);
  assert.deepStrictEqual(S.scenePropRefs({ objects: [{ src: { prefab: 'crt' } }, { src: { prefab: 'lib:props/a@1' } }, { src: { prefab: 'lib:props/a@1' } }, {}] }), ['lib:props/a@1']);
});

console.log(`\n${n - failed} / ${n} тестов прошли`);
process.exit(failed ? 1 : 0);
