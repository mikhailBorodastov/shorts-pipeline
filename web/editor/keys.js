// Ключи и автоключ (stage1-editor.md §7). Чистые функции: получают документ сцены, возвращают операции.
// Автоключ: у свойства БЕЗ ключей правка меняет статичное значение; у свойства С ключами — ставит / обновляет ключ на времени t.
import { newId } from './ops.js';

export const TPROPS = ['pos', 'rot', 'scale'];
export const EPS = 1 / 120;                                   // «тот же момент» — полкадра при 60 к/с
export const EASES = [['io', 'плавно'], ['linear', 'линейно'], ['in', 'разгон'], ['out', 'торможение'], ['hold', 'стоп-кадр']];

export const find = (doc, id) => (doc.objects || []).find(o => o.id === id) || (doc.lights || []).find(l => l.id === id) || null;
export const kindOf = (doc, id) => (id === 'camera' ? 'camera' : (doc.objects || []).some(o => o.id === id) ? 'objects' : (doc.lights || []).some(l => l.id === id) ? 'lights' : null);
export const track = (o, prop) => (o && o.keys && o.keys[prop]) || [];
export const hasKeys = (o, prop) => track(o, prop).length > 0;
export const animated = o => !!o && Object.values(o.keys || {}).some(k => k && k.length);
export const keyAt = (list, t) => (list || []).find(k => Math.abs(k.t - t) < EPS) || null;
const r4 = v => (Array.isArray(v) ? v.map(r4) : typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

// value of a property now (with keys)
export function valueAt(o, prop, t) {
  const base = prop === 'scale' ? (o.scale == null ? 1 : o.scale) : prop === 'hide' ? !!o.hide : o[prop];
  return evalKeys(track(o, prop), t, base);
}

// the ease a new key gets: the one of the key before it (the curve of that stretch stays as it was)
function easeFor(list, t) {
  let prev = null;
  for (const k of list) if (k.t < t && (!prev || k.t > prev.t)) prev = k;
  return (prev && prev.ease) || 'io';
}

// ops to set o.<prop> = v at time t. force — start a key even if there are none yet (I, «ключ»)
export function setOps(doc, id, prop, v, t, autokey = true, force = false) {
  const kind = kindOf(doc, id), o = find(doc, id);
  if (!o || !kind) return [];
  v = r4(v);
  const list = track(o, prop);
  if ((autokey && list.length) || force) {
    if (prop === 'rot' && Array.isArray(v)) {                // no jump across ±π against what is there now
      const cur = valueAt(o, 'rot', t) || [0, 0, 0];
      v = v.map((a, i) => r4(unwrapAngle(cur[i], a)));
    }
    const k = keyAt(list, t);
    if (k) return [{ op: 'set', path: [kind, id, 'keys', prop, k.id, 'v'], value: v }];
    const ops = [];
    if (!list.length && force) {                              // the first key: keep the static value as the look before it
      const base = prop === 'scale' ? (o.scale == null ? 1 : o.scale) : o[prop];
      if (base !== undefined && JSON.stringify(r4(base)) !== JSON.stringify(v) && t > EPS) ops.push({ op: 'add', path: [kind, id, 'keys', prop], item: { id: newId('k'), t: 0, v: r4(base), ease: 'io' } });
    }
    ops.push({ op: 'add', path: [kind, id, 'keys', prop], item: { id: newId('k'), t: r4(t), v, ease: easeFor(list, t) } });
    return ops;
  }
  return [{ op: 'set', path: [kind, id, prop], value: v }];
}

// I: a key of every transform of the thing at t (its current values)
export function keyAllOps(doc, id, t) {
  const o = find(doc, id), kind = kindOf(doc, id);
  if (!o) return [];
  const props = kind === 'lights' ? ['pos', 'intensity'] : TPROPS;
  return props.flatMap(p => setOps(doc, id, p, valueAt(o, p, t) ?? (p === 'intensity' ? o.intensity : undefined), t, true, true)).filter(op => op.value !== undefined || op.item);
}

// Alt+I: delete the keys of the thing at t
export function delKeysAtOps(doc, id, t) {
  const o = find(doc, id), kind = kindOf(doc, id), ops = [];
  if (!o) return ops;
  for (const [prop, list] of Object.entries(o.keys || {})) for (const k of list || []) if (Math.abs(k.t - t) < EPS) ops.push({ op: 'del', path: [kind, id, 'keys', prop], id: k.id });
  return ops;
}

// ---- camera
export function camShotKeys(cam, t) {
  const [s, e] = sceneShotOf(cam.cuts, t);
  return (cam.keys || []).filter(k => k.t >= s && k.t < e);
}
export function camKeyOps(doc, t, pos, target, fov) {
  const cam = doc.camera || {}, list = cam.keys || [];
  const k = keyAt(list, t);
  const v = { pos: r4(pos), target: r4(target) };
  if (fov != null) v.fov = r4(fov);
  if (k) return Object.entries(v).map(([f, x]) => ({ op: 'set', path: ['camera', 'keys', k.id, f], value: x }));
  return [{ op: 'add', path: ['camera', 'keys'], item: Object.assign({ id: newId('c'), t: r4(t), ease: easeFor(list, t) }, v) }];
}

// every key of a thing as {prop, key}; for the timeline and «↑ / ↓ к ключу»
export function allKeys(o) {
  const out = [];
  if (!o) return out;
  if (Array.isArray(o.keys)) { for (const k of o.keys) out.push({ prop: '*', key: k }); return out; }
  for (const [prop, list] of Object.entries(o.keys || {})) for (const k of list || []) out.push({ prop, key: k });
  return out;
}

// shift keys in time: [{kind, id, prop, kid, t0}] by dt -> ops
export function moveKeysOps(sel, dt, len) {
  return sel.map(s => {
    const t = r4(Math.max(0, s.t0 + dt));
    const path = s.kind === 'camera' ? ['camera', 'keys', s.kid, 't'] : s.kind === 'cuts' ? ['camera', 'cuts', s.kid, 't'] : s.kind === 'markers' ? ['markers', s.kid, 't']
      : s.kind === 'sounds' ? ['sounds', s.kid, 't'] : [s.kind, s.id, 'keys', s.prop, s.kid, 't'];
    return { op: 'set', path, value: t };
  });
}
