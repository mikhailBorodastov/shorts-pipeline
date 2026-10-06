// S21: вход и уход на ключах hide (node engine/test/life.test.js)
const assert = require('assert');
global.THREE = require('../vendor/three.core.js');
const { sceneLifeAt } = require('../scene.js');
const prop = { id: 'a', src: { prefab: 'lib:props/cup@1' }, keys: { hide: [{ t: 2, v: true }, { t: 5, v: false }] } };
assert.strictEqual(sceneLifeAt(prop, 1), null);
let r = sceneLifeAt(prop, 1.8); assert.strictEqual(r.dir, 'out'); assert.strictEqual(r.move, 'pop'); assert.ok(r.p > 0 && r.p < 1);
assert.strictEqual(sceneLifeAt(prop, 3), null);
r = sceneLifeAt(prop, 5.1); assert.strictEqual(r.dir, 'in'); assert.ok(Math.abs(r.p - 0.25) < 1e-9);
const hog = { id: 'h', src: { prefab: 'lib:characters/hog@2' }, keys: { hide: [{ t: 3, v: true }] } };
assert.strictEqual(sceneLifeAt(hog, 2.8).move, 'popUp');
assert.strictEqual(sceneLifeAt(Object.assign({}, hog, { life: { out: 'cut' } }), 2.8), null);
assert.strictEqual(sceneLifeAt(Object.assign({}, hog, { life: false }), 2.8), null);
assert.strictEqual(sceneLifeAt(hog, 2.8, t => t === 3), null);                 // склейка камеры — жёстко
const start = { id: 's', keys: { hide: [{ t: 0, v: true }, { t: 0.0, v: true }] }, hide: false };
assert.strictEqual(sceneLifeAt(start, 0.01), null);                           // исходное состояние — без анимации
console.log('life ok');
