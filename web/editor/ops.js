// Операции над scene.json на странице — зеркало scene_api.apply_one (Python): set / unset / add / del / move, пути через id в списках.
// applyBatch возвращает обратную пачку (undo) — отмена = применить её новой пачкой.
export const newId = (p = 'x') => p + Math.random().toString(16).slice(2, 8);
export const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function resolve(doc, path, create) {
  let cur = doc;
  for (const k of path.slice(0, -1)) {
    let nxt;
    if (Array.isArray(cur)) nxt = cur.find(it => it && typeof it === 'object' && it.id === k);
    else if (cur && typeof cur === 'object') { nxt = cur[k]; if (nxt == null && create) nxt = cur[k] = {}; }
    if (nxt == null) return [null, null];
    cur = nxt;
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) { const i = cur.findIndex(it => it && typeof it === 'object' && it.id === last); return i >= 0 ? [cur, i] : [null, null]; }
  return cur && typeof cur === 'object' ? [cur, last] : [null, null];
}

export function applyOne(doc, op) {
  const kind = op.op, path = (op.path || []).map(String);
  if (!path.length || path[0] === 'rev' || path[0] === 'schema') return null;
  if (kind === 'set' || kind === 'unset') {
    const [c, k] = resolve(doc, path, kind === 'set');
    if (c == null) return null;
    const had = Array.isArray(c) || Object.prototype.hasOwnProperty.call(c, k), old = had ? c[k] : undefined;
    if (kind === 'set') c[k] = clone(op.value);
    else if (had && !Array.isArray(c)) delete c[k];
    else return null;
    return had ? [{ op: 'set', path, value: old }] : [{ op: 'unset', path }];
  }
  const [c, k] = resolve(doc, path, true);
  if (c == null) return null;
  let lst = c[k];
  if (!Array.isArray(lst)) { if (Array.isArray(c)) return null; lst = c[k] = []; }
  if (kind === 'add') {
    const item = clone(op.item);
    if (item && typeof item === 'object' && !item.id) item.id = newId();
    op.item = item;
    const i = op.at == null ? lst.length : Math.max(0, Math.min(lst.length, op.at | 0));
    lst.splice(i, 0, item);
    return item && item.id ? [{ op: 'del', path, id: item.id }] : null;
  }
  const i = lst.findIndex(it => it && typeof it === 'object' && it.id === op.id);
  if (i < 0) return null;
  if (kind === 'del') { const it = lst.splice(i, 1)[0]; return [{ op: 'add', path, item: it, at: i }]; }
  if (kind === 'move') {
    const it = lst.splice(i, 1)[0], to = Math.max(0, Math.min(lst.length, op.to | 0));
    lst.splice(to, 0, it);
    return [{ op: 'move', path, id: it.id, to: i }];
  }
  return null;
}

export function applyBatch(doc, ops) {
  const done = [], undo = [];
  for (const op of ops) { const inv = applyOne(doc, op); if (inv) { done.push(op); undo.unshift(...inv); } }
  return { done, undo };
}

// which objects / lights must be rebuilt (not just moved) after these ops
export function structural(ops) {
  const rebuild = new Set();
  let sync = false;
  for (const op of ops) {
    const p = (op.path || []).map(String);
    if ((p[0] === 'objects' || p[0] === 'lights') && p.length === 1) { sync = true; continue; }     // add / del / move of whole things
    if (p[0] === 'objects' && p.length >= 3 && ['src', 'params', 'type'].includes(p[2])) { rebuild.add(p[1]); sync = true; }
    if (p[0] === 'objects' && p.length >= 3 && p[2] === 'parent') sync = true;
    if (p[0] === 'lights' && p.length >= 3 && !['pos', 'intensity', 'keys', 'hide', 'name'].includes(p[2])) { rebuild.add(p[1]); sync = true; }
  }
  return { sync, rebuild: [...rebuild] };
}
