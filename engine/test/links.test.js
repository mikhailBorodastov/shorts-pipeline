// Привязки объектов (links, engine/scene.js): ёжик садится на кресло и едет вместе с ним, клавиатура едет с выдвижной полкой.
//   node engine/test/links.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  global.THREE = await import(pathToFileURL(path.join(__dirname, '..', 'vendor', 'three.core.js')).href);
  const S = require('../scene.js');
  const pos = (scene, id, t) => { const m = S.sceneWorldMatrixAt(scene, id, t), v = new THREE.Vector3(); v.setFromMatrixPosition(m); return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]; };

  // кресло едет по x с 0 до 2 (t 0..2), потом стоит; ёжик сам стоит в [5,0,0]; привязан к креслу с t=1
  const chair = { id: 'c', pos: [0, 0, 0], keys: { pos: [{ id: 'k1', t: 0, v: [0, 0, 0] }, { id: 'k2', t: 2, v: [2, 0, 0], ease: 'linear' }] } };
  const hog = { id: 'h', pos: [5, 0, 0], links: [{ id: 'l1', to: 'c', from: 1 }] };
  const scene = { objects: [chair, hog] };
  chair.keys.pos[0].ease = 'linear';
  assert.deepStrictEqual(pos(scene, 'h', 0.5), [5, 0, 0], 'до привязки — на своём месте');
  assert.deepStrictEqual(pos(scene, 'h', 1), [5, 0, 0], 'в момент привязки не прыгает');
  const c1 = pos(scene, 'c', 1)[0], c2 = pos(scene, 'c', 2)[0];
  assert.deepStrictEqual(pos(scene, 'h', 2), [+(5 + c2 - c1).toFixed(4), 0, 0], 'после — едет за креслом');

  // отвязали в 1.5: набранный сдвиг остаётся, дальше кресло его не тащит
  hog.links[0].until = 1.5;
  const c15 = pos(scene, 'c', 1.5)[0];
  assert.deepStrictEqual(pos(scene, 'h', 2), [+(5 + c15 - c1).toFixed(4), 0, 0], 'после отвязки — без прыжка назад и без движения за креслом');
  delete hog.links[0].until;

  // кресло поворачивается вокруг Y на 90° — ёжик в 1 м от него обходит кресло по дуге
  const chair2 = { id: 'c', pos: [0, 0, 0], keys: { rot: [{ id: 'r1', t: 0, v: [0, 0, 0], ease: 'linear' }, { id: 'r2', t: 1, v: [0, Math.PI / 2, 0], ease: 'linear' }] } };
  const hog2 = { id: 'h', pos: [1, 0, 0], links: [{ id: 'l', to: 'c', from: 0 }] };
  const p2 = pos({ objects: [chair2, hog2] }, 'h', 1);
  assert.ok(Math.abs(p2[0]) < 1e-3 && Math.abs(Math.abs(p2[2]) - 1) < 1e-3, 'поворот кресла уносит ёжика по кругу: ' + p2);

  // своя анимация ёжика поверх привязки: он сдвигается на 0.3 по z, пока кресло едет
  const hog3 = { id: 'h', pos: [5, 0, 0], keys: { pos: [{ id: 'a', t: 1, v: [5, 0, 0], ease: 'linear' }, { id: 'b', t: 2, v: [5, 0, 0.3], ease: 'linear' }] }, links: [{ id: 'l', to: 'c', from: 1 }] };
  const p3 = pos({ objects: [chair, hog3] }, 'h', 2);
  assert.deepStrictEqual(p3, [+(5 + c2 - c1).toFixed(4), 0, 0.3], 'свои ключи работают поверх привязки');

  // цикл (кресло привязано к ёжику, ёжик к креслу) не вешает
  const a = { id: 'a', pos: [0, 0, 0], links: [{ id: 'x', to: 'b', from: 0 }] }, b = { id: 'b', pos: [1, 0, 0], links: [{ id: 'y', to: 'a', from: 0 }] };
  pos({ objects: [a, b] }, 'a', 1);
  console.log('links.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
