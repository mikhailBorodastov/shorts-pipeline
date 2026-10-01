// Редактор сцены (S1 Claude Studio) — оболочка: загрузка сцены, операции и отмена, синхронизация с локальным скриптом,
// время и воспроизведение (Premiere), звуки дорожки, хоткеи (keymap.json), версии, клип, меню, блокировка на время работы агента.
// ТЗ: _pipeline/docs/studio/stage1-editor.md. Модули: viewport.js (3D), panels.js (дерево и свойства), timeline.js, agent.js, ops.js, keys.js.
import { initAnim } from './anim.js';
import { initWorkshop } from './workshop.js';
import { applyBatch, structural, clone, newId } from './ops.js';
import { find, kindOf, keyAllOps, delKeysAtOps, allKeys, setOps, valueAt, EPS } from './keys.js';
import { initViewport } from './viewport.js';
import { initPanels } from './panels.js';
import { initTimeline } from './timeline.js';
import { initAgent } from './agent.js';

const q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ideas': '1' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error || r.statusText); e.data = j; throw e; }
  return j;
};

const ED = window.ED = {
  key: q.get('key'), el: q.get('el'), doc: null, rev: 0, S: null, w: null,
  t: 0, playing: false, speed: 1, work: null, loop: true,
  sel: new Set(), active: null, entered: null, keySel: [], selKey: null,
  autokey: true, view: 'free', zones: true, showMini: true, locked: null, readonly: false,
  undo: [], redo: [], pending: 0, dirty: true, uiDirty: true, tlDirty: true,
  api,
};

// ---------------------------------------------------------------- messages
let msgT = 0;
ED.msg = (text, kind = '') => {
  const m = $('vpMsg');
  m.textContent = text || ''; m.className = text ? 'on ' + kind : '';
  clearTimeout(msgT);
  if (text && !(ED.vp && ED.vp.modal)) msgT = setTimeout(() => { m.className = ''; }, kind === 'err' ? 7000 : 3500);
};
const saved = s => { const e = $('saved'); e.textContent = s; e.classList.toggle('busy', /сохраняю/.test(s)); };

// ---------------------------------------------------------------- operations: local at once, then the server (in order)
let chain = Promise.resolve();
ED.commit = (ops, desc, o = {}) => {
  if (ED.readonly) { ED.msg('Это старая версия — только просмотр. «Сделать рабочей копией» в меню ☰', 'warn'); return null; }
  if (ED.locked && !o.force && !ED.fix) { ED.msg('Claude работает над сценой — подожди или отмени задачу', 'warn'); return null; }
  const { done, undo } = applyBatch(ED.doc, clone(ops));
  if (!done.length) return null;
  const st = structural(done);
  if (st.sync) syncScene(ED.S, st.rebuild);
  const batch = o.batch || newId('b'), kind = o.kind || 'edit';
  if (kind === 'edit') {
    const last = ED.undo[ED.undo.length - 1];
    if (o.merge && last && last.merge === o.merge && Date.now() - last.at < 1200) { last.ops = last.ops.concat(done); last.undo = undo.concat(last.undo); last.at = Date.now(); }
    else ED.undo.push({ batch, desc, ops: done, undo, merge: o.merge, at: Date.now() });
    if (ED.undo.length > 300) ED.undo.shift();
    ED.redo = [];
  }
  if (ED.fix) {                                               // ✋ правка из ревью (S8): правки только на странице — уйдут пометкой с «почему»
    ED.fix.ops.push(...clone(done)); fixBar();
    ED.dirty = ED.uiDirty = ED.tlDirty = true;
    return { batch, done, undo };
  }
  ED.pending++; saved('сохраняю…');
  const exp = ED.rev;
  ED.rev++;
  chain = chain.then(async () => {
    try {
      const r = await api('/api/scene/op', { key: ED.key, el: ED.el, ops: done, desc, batch, kind, undoes: o.undoes, by: 'author' });
      if (r.prev !== exp) await reload('правки из другого места');
      ED.rev = r.rev;
      if (done.some(op => op.path && op.path[0] === 'prefabsRev')) ED.reloadPage('вид предметов вернулся');   // the prefab code changed: a new page
      if (r.warn && r.warn.length && !r.warn.includes('ничего не изменилось')) ED.msg('⚠ ' + r.warn.join('; '), 'warn');
    } catch (e) {
      ED.msg('Не сохранилось: ' + e.message, 'err');
      await reload('откат после ошибки');
    } finally { ED.pending--; if (!ED.pending) saved('сохранено ✓'); }
  });
  ED.dirty = ED.uiDirty = ED.tlDirty = true;
  return { batch, done, undo };
};
// live edit (wheel over a number, dragging a label or a key): only on the page while it goes on, one batch when it stops.
// mk() builds the ops from the doc as it was before the gesture, so keys created on the way get one id.
const LIVE = new Map();
ED.live = (key, mk, desc, wait = 700) => {
  if (ED.readonly || ED.locked) return;
  let L = LIVE.get(key);
  if (!L) { L = { undo: [] }; LIVE.set(key, L); }
  applyBatch(ED.doc, L.undo); L.undo = [];                 // back to the start, then the gesture's current state
  const { done, undo } = applyBatch(ED.doc, clone(mk()));
  L.undo = undo; L.mk = mk; L.desc = desc;
  const st = structural(done); if (st.sync) syncScene(ED.S, st.rebuild);
  clearTimeout(L.timer); if (wait) L.timer = setTimeout(() => ED.liveEnd(key), wait);
  ED.dirty = ED.uiDirty = ED.tlDirty = true;
};
ED.liveEnd = key => {
  const L = LIVE.get(key); if (!L) return;
  LIVE.delete(key); clearTimeout(L.timer);
  applyBatch(ED.doc, L.undo);
  ED.commit(L.mk(), L.desc);
};
ED.undoLast = () => {
  const e = ED.undo.pop();
  if (!e) { ED.msg('Нечего отменять'); return; }
  const r = ED.commit(e.undo, '↺ отмена: ' + e.desc, { kind: 'undo', undoes: e.batch, force: e.agent });
  if (r) { e.undoBatch = r.batch; ED.redo.push(e); ED.msg('↺ ' + e.desc); } else ED.undo.push(e);
};
ED.redoLast = () => {
  const e = ED.redo.pop();
  if (!e) { ED.msg('Нечего возвращать'); return; }
  const r = ED.commit(e.ops, '↻ ' + e.desc, { kind: 'redo', undoes: e.undoBatch });
  if (r) { e.undo = r.undo; ED.undo.push(e); ED.msg('↻ ' + e.desc); } else ED.redo.push(e);
};

// prefabs.js changed (the agent drew things anew, or that was undone): the page loads again, where the author was
ED.reloadPage = why => {
  try { sessionStorage.setItem('editor.keep', JSON.stringify({ el: ED.el, t: ED.t, sel: [...ED.sel], undo: ED.undo.slice(-50), redo: ED.redo.slice(-50), why })); } catch {}
  location.reload();
};
// the whole scene again from the server (the agent or the CLI changed it)
async function reload(why) {
  const j = await api(`/api/scene?key=${encodeURIComponent(ED.key)}&el=${ED.el}${ED.ver ? '&ver=' + ED.ver : ''}`);
  const old = ED.doc, nu = j.scene, rebuild = [];
  const sig = o => JSON.stringify([o.src, o.params, o.type]);
  const oldBy = new Map((old.objects || []).map(o => [o.id, o]));
  for (const o of nu.objects || []) { const p = oldBy.get(o.id); if (p && sig(p) !== sig(o)) rebuild.push(o.id); }
  const oldL = new Map((old.lights || []).map(o => [o.id, JSON.stringify(Object.assign({}, o, { pos: 0, intensity: 0, keys: 0 }))]));
  for (const l of nu.lights || []) if (oldL.has(l.id) && oldL.get(l.id) !== JSON.stringify(Object.assign({}, l, { pos: 0, intensity: 0, keys: 0 }))) rebuild.push(l.id);
  if (!ED.readonly && ((j.prefabsRev && ED.prefabsRev && j.prefabsRev !== ED.prefabsRev) || (j.propsRev && ED.propsRev && j.propsRev > ED.propsRev))) {   // поменялись файлы пропсов / персонажей сцены — тоже   // поменялся вид предметов (prefabs.js): PREFABS — const, только перезагрузкой
    ED.reloadPage('вид предметов поменялся (prefabs.js)' + (why ? ' · ' + why : ''));
    return j;
  }
  const fresh = scenePropRefs(nu).filter(r => !ED.lib[r]);   // новые 3D-пропсы / персонажи (агент поставил lib: / el:) — догрузить до сборки объектов
  if (fresh.length) await loadSceneProps(fresh, ED.key.slice(5), load, ED.lib, ED.doc);
  for (const k of Object.keys(old)) delete old[k];
  Object.assign(old, nu);                                  // keep the object identity: the engine holds it
  syncScene(ED.S, rebuild);
  ED.rev = j.rev; ED.hist = j.history; ED.cues = j.cues; ED.info = j;
  for (const id of [...ED.sel]) if (id !== 'camera' && id !== 'camera:target' && !find(ED.doc, id)) ED.sel.delete(id);
  if (ED.active && !ED.sel.has(ED.active)) ED.active = [...ED.sel][0] || null;
  ED.dirty = ED.uiDirty = ED.tlDirty = true;
  if (why) console.log('сцена перечитана:', why);
  return j;
}
ED.reload = reload;

// ---------------------------------------------------------------- selection
ED.select = (ids, active) => {
  ED.sel = new Set(ids.filter(Boolean));
  ED.active = active || ids[ids.length - 1] || null;
  if (!ED.sel.size) ED.entered = null;
  ED.dirty = ED.uiDirty = ED.tlDirty = true;
};
ED.toggleSel = id => {
  if (ED.sel.has(id)) { ED.sel.delete(id); if (ED.active === id) ED.active = [...ED.sel].pop() || null; }
  else { ED.sel.add(id); ED.active = id; }
  ED.dirty = ED.uiDirty = ED.tlDirty = true;
};
const selObjs = () => [...ED.sel].filter(id => (ED.doc.objects || []).some(o => o.id === id));

// ---------------------------------------------------------------- time
ED.fps = () => ED.doc.fps || 30;
ED.setT = t => {
  const len = ED.doc.len || 6;
  ED.t = Math.max(0, Math.min(len, Math.round(t * 1000) / 1000));
  ED.dirty = ED.tlDirty = ED.uiDirty = true;
  if (ED.playing) audio.restart();
};
ED.play = (speed = 1) => {
  if (ED.playing && ED.speed === speed) { ED.stop(); return; }
  ED.speed = speed; ED.playing = true; ED.last = 0;
  const [a, b] = ED.work || [0, ED.doc.len];
  if (speed > 0 && ED.t >= b - 1e-3) ED.t = a;
  audio.restart();
  $('play').textContent = '⏸';
};
ED.stop = () => { ED.playing = false; ED.speed = 1; audio.stop(); $('play').textContent = '▶'; ED.uiDirty = true; };
ED.fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };

// ↑ / ↓: previous / next key of the selection (or of the whole scene)
ED.keyTimes = () => {
  const ids = ED.sel.size ? [...ED.sel] : [...(ED.doc.objects || []).map(o => o.id), 'camera'];
  const ts = new Set();
  for (const id of ids) {
    const o = id === 'camera' || id === 'camera:target' ? ED.doc.camera : find(ED.doc, id);
    for (const { key } of allKeys(o)) ts.add(+key.t.toFixed(4));
  }
  for (const m of ED.doc.markers || []) ts.add(+m.t.toFixed(4));
  return [...ts].sort((a, b) => a - b);
};

// ---------------------------------------------------------------- sounds on the track (WebAudio, like «▶ Слушать вместе»)
const audio = {
  ctx: null, bufs: new Map(), srcs: [],
  async buf(url) {
    if (this.bufs.has(url)) return this.bufs.get(url);
    const p = fetch(url).then(r => r.arrayBuffer()).then(b => this.ctx.decodeAudioData(b)).catch(() => null);
    this.bufs.set(url, p);
    return p;
  },
  stop() { for (const s of this.srcs) try { s.stop(); } catch {} this.srcs = []; },
  async restart() {
    this.stop();
    const cues = ED.cues || [];
    if (!ED.playing || ED.speed !== 1 || !cues.length) return;
    this.ctx = this.ctx || new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const t0 = ED.t, now = this.ctx.currentTime;
    for (const c of cues) {
      const b = await this.buf(c.url);
      if (!b || !ED.playing) continue;
      const off = t0 - c.t;
      if (off > b.duration) continue;
      const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
      s.buffer = b; g.gain.value = c.gain == null ? 1 : c.gain; s.connect(g).connect(this.ctx.destination);
      s.start(now + Math.max(0, -off), Math.max(0, off)); this.srcs.push(s);
    }
  },
};
ED.audio = audio;
ED.reloadDoc = () => reload('звук добавлен на сервере');
ED.refreshCues = async () => { try { ED.cues = (await api(`/api/scene/cues?key=${encodeURIComponent(ED.key)}&el=${ED.el}`)).cues; ED.tlDirty = true; } catch {} };

// ---------------------------------------------------------------- actions (keymap names)
const ACT = {
  clip_add: () => ED.clipMenu && ED.clipMenu(),
  select_all: () => ED.select((ED.doc.objects || []).filter(o => !o.locked && !o.parent).map(o => o.id)),
  deselect_all: () => ED.select([]),
  grab: () => ED.vp.startModal('translate'), rotate: () => ED.vp.startModal('rotate'), scale: () => ED.vp.startModal('scale'),
  reset_pos: () => ED.vp.reset('translate'), reset_rot: () => ED.vp.reset('rotate'), reset_scale: () => ED.vp.reset('scale'),
  gizmo_move: () => ED.vp.setMode('translate'), gizmo_rotate: () => ED.vp.setMode('rotate'), gizmo_scale: () => ED.vp.setMode('scale'),
  duplicate: () => duplicate(), delete: () => del(), hide: () => hide(), unhide_all: () => unhideAll(), add: () => addMenu(),
  group: () => group(), ungroup: () => ungroup(), link: () => linkSel(), unlink: () => unlinkSel(),
  key: () => { const ops = [...ED.sel].flatMap(id => id === 'camera' ? camKeyNow() : keyAllOps(ED.doc, id, ED.t)); if (ops.length) ED.commit(ops, `ключ на ${ED.t.toFixed(2)} с: ${names([...ED.sel])}`); else ED.msg('Выбери объект, камеру или свет'); },
  unkey: () => { const ops = [...ED.sel].flatMap(id => id === 'camera' ? (ED.doc.camera.keys || []).filter(k => Math.abs(k.t - ED.t) < EPS).map(k => ({ op: 'del', path: ['camera', 'keys'], id: k.id })) : delKeysAtOps(ED.doc, id, ED.t)); if (ops.length) ED.commit(ops, `ключи на ${ED.t.toFixed(2)} с удалены: ${names([...ED.sel])}`); else ED.msg('На этом времени ключей нет'); },
  frame_sel: () => ED.vp.frameSel(), frame_all: () => ED.vp.frameAll(),
  cam_view: () => ED.setView(ED.view === 'camera' ? 'free' : 'camera'), cam_key: () => ED.vp.keyFromView(),
  props: () => { const s = $('side'); s.hidden = !s.hidden; document.getElementById('main').style.gridTemplateColumns = s.hidden ? '1fr 0 0' : ''; },
  tree: () => $('treeList').focus(),
  agent: () => ED.agent.toggle(),
  play: () => ED.play(1), stop: () => ED.stop(),
  shuttle_back: () => ED.play(ED.playing && ED.speed < 0 ? Math.max(-8, ED.speed * 2) : -1),
  shuttle_fwd: () => ED.play(ED.playing && ED.speed > 0 ? Math.min(8, ED.speed * 2) : 1),
  frame_prev: () => ED.setT(ED.t - 1 / ED.fps()), frame_next: () => ED.setT(ED.t + 1 / ED.fps()),
  frame_prev5: () => ED.setT(ED.t - 5 / ED.fps()), frame_next5: () => ED.setT(ED.t + 5 / ED.fps()),
  key_prev: () => { const k = ED.keyTimes().filter(x => x < ED.t - EPS).pop(); if (k != null) ED.setT(k); },
  key_next: () => { const k = ED.keyTimes().find(x => x > ED.t + EPS); if (k != null) ED.setT(k); },
  start: () => ED.setT(ED.work ? ED.work[0] : 0), end: () => ED.setT(ED.work ? ED.work[1] : ED.doc.len),
  work_in: () => { ED.work = [ED.t, ED.work ? Math.max(ED.t + 0.1, ED.work[1]) : ED.doc.len]; ED.tlDirty = ED.uiDirty = true; },
  work_out: () => { ED.work = [ED.work ? Math.min(ED.work[0], ED.t - 0.1) : 0, ED.t]; ED.tlDirty = ED.uiDirty = true; },
  undo: () => ED.undoLast(), redo: () => ED.redoLast(), save: () => saveVersion(),
  comment: () => ED.agent.comment(),
  marker: () => ED.tl.addMarker(), cut: () => ED.tl.addCut(), rename: () => ED.panels.rename(),
  copy_keys: () => ED.tl.copy(), paste_keys: () => ED.tl.paste(), del_keys: () => ED.tl.delKeys(),
};
ED.ACT = ACT;
const names = ids => ids.map(id => (id === 'camera' ? 'камера' : (find(ED.doc, id) || {}).name)).filter(Boolean).slice(0, 3).join(', ') + (ids.length > 3 ? '…' : '');
function camKeyNow() {
  const w = ED.w;
  return (ED.doc.camera.keys || []).some(k => Math.abs(k.t - ED.t) < EPS) ? [] :
    [{ op: 'add', path: ['camera', 'keys'], item: { id: newId('c'), t: +ED.t.toFixed(4), pos: [w.cam.position.x, w.cam.position.y, w.cam.position.z].map(v => +v.toFixed(4)), target: [w.target.x, w.target.y, w.target.z].map(v => +v.toFixed(4)), ease: 'io' } }];
}
ED.setView = v => {
  const prev = ED.view;
  ED.view = v; $('camview').setAttribute('aria-pressed', v === 'camera' ? 'true' : 'false');
  if (v === 'free' && prev === 'camera') ED.vp.fromScene();      // Blender: navigating out of the camera view starts from where the camera is
  ED.dirty = ED.uiDirty = true;
};

// ---- 🔗 привязка (Ctrl+P / Alt+P): выбранные едут за активным с курсора, как Parent в After Effects (engine/scene.js links)
function linkSel() {
  const to = ED.active, ids = [...ED.sel].filter(id => id !== to && find(ED.doc, id));
  if (!to || !find(ED.doc, to) || !ids.length) return ED.msg('Выбери, что привязать (ёжика), и последним — к чему (кресло): Ctrl+клик, потом Ctrl+P', 'err');
  const t = +ED.t.toFixed(3), ops = [];
  for (const id of ids) {
    const o = find(ED.doc, id);
    if ((o.links || []).some(l => l.to === to && l.from <= t && (l.until == null || l.until > t))) continue;
    ops.push({ op: 'set', path: ['objects', id, 'links'], value: (o.links || []).concat([{ id: newId('l'), to, from: t }]) });
  }
  if (!ops.length) return ED.msg('Уже привязаны');
  ED.commit(ops, `привязать к «${find(ED.doc, to).name}» с ${t.toFixed(2)} с: ${names(ids)}`);
  ED.msg(`🔗 С ${t.toFixed(2)} с ${names(ids)} едет за «${find(ED.doc, to).name}»`);
}
function unlinkSel() {
  const t = +ED.t.toFixed(3), ops = [];
  for (const id of ED.sel) {
    const o = find(ED.doc, id); if (!o || !(o.links || []).length) continue;
    const list = o.links.map(l => (l.from < t && (l.until == null || l.until > t) ? Object.assign({}, l, { until: t }) : l));
    if (JSON.stringify(list) !== JSON.stringify(o.links)) ops.push({ op: 'set', path: ['objects', id, 'links'], value: list });
  }
  if (!ops.length) return ED.msg('На курсоре у выбранного нет привязки');
  ED.commit(ops, `отвязать на ${t.toFixed(2)} с: ${names([...ED.sel])}`);
}

// ---- ＋ добавить (Shift+A): предмет из префабов этой сцены, 3D-пропс или персонаж (видео / библиотека канала), пустая группа
function addMenu() {
  if (ED.readonly) return ED.msg('Это сохранённая версия — только просмотр', 'err');
  const I = ED.info || {}, pf = I.prefabInfo || {}, used = {};
  for (const o of ED.doc.objects || []) { const k = (o.src || {}).prefab; if (k) used[k] = (used[k] || 0) + 1; }
  const items = [];
  for (const [k, x] of Object.entries(pf)) {
    if (x.kind === 'env') continue;                                   // стены комнаты — одна на сцену
    items.push({ sec: 'Предметы этой сцены', ref: k, name: x.note ? x.note.split(/[.;(]/)[0].slice(0, 60) : k, sub: k + (used[k] ? ` · в сцене ×${used[k]}` : ''), kind: x.kind });
  }
  for (const x of I.props3d || []) items.push({ sec: '3D-пропсы', ref: x.ref, name: x.name, sub: x.from + (used[x.ref] ? ` · в сцене ×${used[x.ref]}` : ''), img: x.img });
  for (const x of I.chars3d || []) items.push({ sec: 'Персонажи', ref: x.ref, el: x.el, name: x.name, sub: x.from + (used[x.ref] ? ` · в сцене ×${used[x.ref]}` : ''), img: x.img, char: true });
  items.push({ sec: 'Пустое', group: true, name: 'Пустая группа', sub: 'чтобы собрать предметы и двигать вместе' });
  const e = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const p = popup(`<h4>＋ Добавить в сцену</h4><input id="addFind" type="search" placeholder="🔎 найти" style="width:100%;margin-bottom:6px"><div id="addList" class="addlist"></div>
    <p class="dim small">Предмет встанет в центр вида, на пол, и сразу поедет за мышью (как G): клик — поставить, Esc — оставить в центре. Новых предметов по описанию тут нет — их делают в препродакшене (пропс / персонаж) или просят 💬 агента.</p>`);
  const list = p.querySelector('#addList'), find = p.querySelector('#addFind');
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    let html = '', sec = '';
    items.forEach((it, i) => {
      if (q && !(it.name + ' ' + it.sub + ' ' + (it.ref || '')).toLowerCase().includes(q)) return;
      if (it.sec !== sec) { sec = it.sec; html += `<div class="addsec">${e(sec)}</div>`; }
      html += `<button class="mi addi" data-i="${i}">${it.img ? `<img src="${e(it.img)}" alt="">` : `<span class="addic">${it.group ? '▢' : it.char ? '🦔' : it.kind === 'overlay' ? '🅣' : '📦'}</span>`}<span><b>${e(it.name)}</b><br><span class="dim small">${e(it.sub)}</span></span></button>`;
    });
    list.innerHTML = html || '<p class="dim">ничего не нашлось</p>';
    for (const b of list.querySelectorAll('.addi')) b.onclick = () => { p.hidden = true; p.innerHTML = ''; addObject(items[+b.dataset.i]); };
  };
  find.oninput = draw; draw(); setTimeout(() => find.focus(), 0);
  find.onkeydown = ev => { if (ev.key === 'Enter') { const b = list.querySelector('.addi'); if (b) b.click(); } };
}
async function addObject(it) {
  const at = (ED.view === 'camera' || !ED.vp.orbit) ? ED.w.target : ED.vp.orbit.tgt;
  const pos = [+(at.x || 0).toFixed(3), 0, +(at.z || 0).toFixed(3)];
  const par = ED.entered && find(ED.doc, ED.entered) ? ED.entered : null;
  const id = newId(it.group ? 'g' : 'o');
  let item;
  if (it.group) item = { id, name: uniq('Группа'), type: 'group', pos, rot: [0, 0, 0], scale: 1, parent: par };
  else {
    if (/^(lib|el):/.test(it.ref)) {
      ED.msg(`гружу «${it.name}»…`);
      if (!(await ED.loadProp(it.ref))) return ED.msg(`«${it.name}» не загрузился — открой его в карточке и проверь, что он рисуется`, 'err');
    }
    const home = (typeof PREFABS !== 'undefined' && PREFABS[it.ref] && PREFABS[it.ref].home) || null;   // префаб строится «на своём месте»: pos = home (как у перенесённых сцен)
    const nm = it.name.replace(/\s+\d+$/, '');
    item = { id, name: (ED.doc.objects || []).some(o => o.name === nm) ? uniq(nm) : nm, src: Object.assign({ prefab: it.ref }, it.el ? { el: it.el } : {}),
      pos: home ? (home.pos || [0, 0, 0]).slice() : pos, rot: [0, home ? home.rotY || 0 : 0, 0], scale: 1, ...(par ? { parent: par } : {}) };
  }
  ED.commit([{ op: 'add', path: ['objects'], item }], `＋ ${item.name}`);
  ED.select([id]);
  const homed = typeof PREFABS !== 'undefined' && item.src && PREFABS[item.src.prefab] && PREFABS[item.src.prefab].home;
  if (!it.group && !homed) requestAnimationFrame(() => ED.vp.startModal('translate'));
  else ED.msg(`＋ «${item.name}» — на месте из кода префаба; G — сдвинуть`);
}

// ---- duplicate / delete / hide / group
function subtree(id) { const out = [id]; for (const o of ED.doc.objects || []) if (o.parent === id) out.push(...subtree(o.id)); return out; }
function duplicate() {
  const ids = selObjs().filter(id => !selObjs().some(p => p !== id && subtree(p).includes(id)));
  if (!ids.length) return;
  const ops = [], fresh = [], map = {};
  const all = ED.doc.objects;
  for (const id of ids) for (const sid of subtree(id)) map[sid] = newId('o');
  for (const id of ids) for (const sid of subtree(id)) {
    const o = clone(all.find(x => x.id === sid));
    o.id = map[sid];
    if (sid === id) o.name = uniq(o.name); else o.parent = map[o.parent] || o.parent;
    for (const list of Object.values(o.keys || {})) for (const k of list || []) k.id = newId('k');
    for (const k of o.pose || []) k.id = newId('p');                  // ключи позы, клипы, привязки — свои id (id в сцене уникальны)
    for (const c of o.clips || []) c.id = newId('c');
    for (const l of o.links || []) { l.id = newId('l'); if (map[l.to]) l.to = map[l.to]; }   // привязан к тому, что дублируется вместе с ним — к его дублю
    const at = all.findIndex(x => x.id === (subtree(id).slice(-1)[0])) + 1 + fresh.length;
    ops.push({ op: 'add', path: ['objects'], item: o, at });
    fresh.push(o.id);
  }
  ED.commit(ops, `дубль: ${names(ids)}`);
  ED.select(ids.map(id => map[id]));
  requestAnimationFrame(() => ED.vp.startModal('translate'));        // Blender: Shift+D goes straight into G
}
// контекстное меню объекта (ПКМ в 3D-виде без сдвига, ПКМ в дереве): как Object Context Menu в Blender
ED.objCtx = (x, y, id) => {
  const ids = selObjs(); if (!ids.length) return;
  const one = ids.length === 1 ? find(ED.doc, ids[0]) : null;
  const items = [
    !ED.readonly && ED.objMenu && ['💬 Пометка для Claude…', () => ED.objMenu({ clientX: x, clientY: y }, id || ids[0])],   // S7 (agent.js)
    ['⧉ Дублировать — Shift+D / Ctrl+D', duplicate],
    one && one.src && !(ED.info.ws && one.id === 'asset') && /^(lib|el):/.test(one.src.prefab || '') && ['🛠 Мастерская предмета', () => parent.postMessage({ type: 'editor-ws', src: one.src.prefab, key: ED.key }, location.origin)],
    ids.length > 1 && ['▢ Сгруппировать — Ctrl+G', group],
    one && one.type === 'group' && ['⊟ Разгруппировать — Ctrl+Shift+G', ungroup],
    ED.active && ids.length > 1 && ['🔗 Привязать к активному — Ctrl+P', linkSel],
    ['🙈 Скрыть — H', hide],
    ['🗑 Удалить — Delete', del],
  ].filter(Boolean);
  const m = $('menu');
  m.innerHTML = ''; m.hidden = false;
  for (const [t, fn] of items) { const b = document.createElement('button'); b.textContent = t; b.setAttribute('role', 'menuitem'); b.onclick = () => { close(); fn(); }; m.append(b); }
  m.style.left = Math.min(x, innerWidth - 260) + 'px'; m.style.top = Math.min(y, innerHeight - items.length * 30 - 16) + 'px';
  const off = e => { if (!m.contains(e.target)) close(); };
  const close = () => { m.hidden = true; removeEventListener('pointerdown', off, true); };
  setTimeout(() => addEventListener('pointerdown', off, true));
  m.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  m.querySelector('button').focus();
};
ED.duplicate = () => duplicate();
function uniq(name) {
  const base = name.replace(/\s*\d+$/, ''), used = new Set((ED.doc.objects || []).map(o => o.name));
  for (let k = 2; ; k++) if (!used.has(`${base} ${k}`)) return `${base} ${k}`;
}
function del() {
  const ids = selObjs();
  const lights = [...ED.sel].filter(id => (ED.doc.lights || []).some(l => l.id === id));
  if (!ids.length && !lights.length) return;
  const fromEl = ids.filter(id => (find(ED.doc, id).src || {}).el);
  if (fromEl.length && !del.sure) {
    ED.confirm(`Удалить из сцены: ${names(fromEl)}? Это элементы препродакшена (из состава сцены). Отменить можно Ctrl+Z.`, 'Удалить').then(ok => { if (ok) { del.sure = true; del(); del.sure = false; } });
    return;
  }
  const ops = [];
  const gone = new Set(ids.flatMap(subtree));
  for (const id of [...gone].reverse()) ops.push({ op: 'del', path: ['objects'], id });
  for (const id of lights) ops.push({ op: 'del', path: ['lights'], id });
  ED.commit(ops, `удалено: ${names([...ids, ...lights])}`);
  ED.select([]);
}
function hide() {
  const ids = selObjs(); if (!ids.length) return;
  const allHidden = ids.every(id => valueAt(find(ED.doc, id), 'hide', ED.t));
  ED.commit(ids.flatMap(id => setOps(ED.doc, id, 'hide', !allHidden, ED.t, ED.autokey)), `${allHidden ? 'показать' : 'скрыть'}: ${names(ids)}`);
}
function unhideAll() {
  const ids = (ED.doc.objects || []).filter(o => o.hide && !(o.keys && o.keys.hide && o.keys.hide.length)).map(o => o.id);
  if (ids.length) ED.commit(ids.map(id => ({ op: 'set', path: ['objects', id, 'hide'], value: false })), `показать всё (${ids.length})`);
}
function group() {
  const ids = selObjs().filter(id => !selObjs().some(p => p !== id && subtree(p).includes(id)));
  if (ids.length < 1) return;
  const gid = newId('g'), all = ED.doc.objects, first = Math.min(...ids.map(id => all.findIndex(o => o.id === id)));
  const par = find(ED.doc, ids[0]).parent || null;
  const ops = [{ op: 'add', path: ['objects'], item: { id: gid, name: uniq('Группа'), type: 'group', pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, parent: par }, at: first }];
  // the children keep their place in the world: the group sits at the origin of their parent
  for (const id of ids) ops.push({ op: 'set', path: ['objects', id, 'parent'], value: gid });
  ED.commit(ops, `группа из: ${names(ids)}`);
  ED.select([gid]);
  requestAnimationFrame(() => ED.panels.rename(gid));
}
function ungroup() {
  const gs = selObjs().filter(id => find(ED.doc, id).type === 'group');
  if (!gs.length) return;
  const ops = [], kids = [];
  for (const g of gs) {
    const G = find(ED.doc, g);
    const plain = !animatedTransform(G) && isZero(G);
    if (!plain) { ED.msg(`«${G.name}» сдвинута или анимирована — сначала сбрось её (Alt+G, Alt+R, Alt+S), чтобы части не прыгнули`, 'warn'); continue; }
    for (const o of ED.doc.objects) if (o.parent === g) { ops.push({ op: 'set', path: ['objects', o.id, 'parent'], value: G.parent || null }); kids.push(o.id); }
    ops.push({ op: 'del', path: ['objects'], id: g });
  }
  if (ops.length) { ED.commit(ops, `разгруппировать: ${names(gs)}`); ED.select(kids); }
}
const animatedTransform = o => ['pos', 'rot', 'scale'].some(p => o.keys && o.keys[p] && o.keys[p].length);
const isZero = o => JSON.stringify(o.pos || [0, 0, 0]) === '[0,0,0]' && JSON.stringify(o.rot || [0, 0, 0]) === '[0,0,0]' && (o.scale == null || o.scale === 1);

// ---------------------------------------------------------------- version / clip / menu
async function job(path, body, label) {
  const { job: j } = await api(path, body);
  saved(label + '…');
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await fetch('/api/job?id=' + j.id).then(r => r.json());
    if (s.summary) saved(s.summary);
    if (s.status !== 'running') { saved(''); if (s.status !== 'done') throw new Error(s.error || s.status); return s; }
  }
}
async function saveVersion() {
  if (ED.readonly) return;
  const note = await ED.ask('💾 Версия сцены — короткая заметка (можно пусто)', '', { ok: 'Сохранить версию' });
  if (note === null) return;
  $('version').disabled = true;
  try { const s = await job('/api/scene/version', { key: ED.key, el: ED.el, note }, '💾 сохраняю версию'); ED.msg('💾 ' + s.summary); $('sver').textContent = `· рабочая копия (v${s.result.v} сохранена)`; }
  catch (e) { ED.msg('Версия не сохранилась: ' + e.message, 'err'); }
  $('version').disabled = false;
}
async function makeClip() {
  $('clip').disabled = true;
  try {
    const s = await job('/api/scene/clip', { key: ED.key, el: ED.el }, '🎞 клип');
    popup(`<h4>🎞 Клип сцены</h4><video src="${s.result.url}?v=${Date.now()}" controls autoplay></video><p class="hint">Файл: _ideas/${s.result.file}</p>`);
  } catch (e) { ED.msg('Клип не собрался: ' + e.message, 'err'); }
  $('clip').disabled = false;
}
function popup(html, onClose) {
  const p = $('popup'); if (!p.hidden && p._onClose) p._onClose(); p._onClose = onClose || null;
  p.innerHTML = html; p.hidden = false;
  p.style.left = Math.max(10, (innerWidth - Math.min(660, innerWidth - 20)) / 2) + 'px'; p.style.top = '60px';
  const close = e => { if (!p.contains(e.target) || e.key === 'Escape') { const f = p._onClose; p._onClose = null; p.hidden = true; p.innerHTML = ''; removeEventListener('pointerdown', close, true); removeEventListener('keydown', closeK, true); if (f) f(); } };
  const closeK = e => { if (e.key === 'Escape') { e.stopPropagation(); close(e); } };
  setTimeout(() => { addEventListener('pointerdown', close, true); addEventListener('keydown', closeK, true); });
  return p;
}
ED.popup = popup;
// a small question in the page (instead of prompt / confirm): Enter — ok, Esc — cancel
ED.ask = (title, value = '', o = {}) => new Promise(res => {
  const p = popup(`<h4></h4>${o.input === false ? '' : '<input id="askIn" style="width:100%">'}<div class="row" style="margin-top:8px;justify-content:flex-end"><button id="askNo">Отмена</button><button id="askOk">${o.ok || 'OK'}</button></div>`, () => res(o.input === false ? false : null));
  p.querySelector('h4').textContent = title;
  const inp = p.querySelector('#askIn'), done = v => { if (p.hidden) return; p._onClose = null; p.hidden = true; p.innerHTML = ''; res(v); };
  if (inp) { inp.value = value; setTimeout(() => { inp.focus(); inp.select(); }); inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); }; }
  else setTimeout(() => p.querySelector('#askOk').focus());
  p.querySelector('#askOk').onclick = () => done(inp ? inp.value : true);
  p.querySelector('#askNo').onclick = () => done(inp ? null : false);
  p.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(inp ? null : false); } };
});
ED.confirm = (title, ok) => ED.ask(title, '', { input: false, ok });
function menu() {
  const m = $('menu'), b = $('menuBtn').getBoundingClientRect();
  const items = [
    ['📜 История правок', history], ['⌨ Клавиши', keysHelp],
    [(ED.zones ? '☑' : '☐') + ' Безопасные зоны кадра', () => { ED.zones = !ED.zones; ED.dirty = true; }],
    [(ED.showMini ? '☑' : '☐') + ' Мини-вид камеры', () => { ED.showMini = !ED.showMini; ED.dirty = true; }],
    ['🗂 Версии сцены', versions],
  ];
  m.innerHTML = ''; m.hidden = false; $('menuBtn').setAttribute('aria-expanded', 'true');
  for (const [t, fn] of items) { const x = document.createElement('button'); x.textContent = t; x.setAttribute('role', 'menuitem'); x.onclick = () => { hideMenu(); fn(); }; m.append(x); }
  m.style.left = Math.max(8, b.right - 240) + 'px'; m.style.top = b.bottom + 4 + 'px';
  m.querySelector('button').focus();
  const off = e => { if (!m.contains(e.target) && e.target !== $('menuBtn')) hideMenu(); };
  const hideMenu = () => { m.hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false'); removeEventListener('pointerdown', off, true); };
  setTimeout(() => addEventListener('pointerdown', off, true));
  m.onkeydown = e => {
    const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); hideMenu(); $('menuBtn').focus(); }
  };
}
async function history() {
  const H = (await api(`/api/scene/history?key=${encodeURIComponent(ED.key)}&el=${ED.el}&n=300`)).history;
  const p = popup('<h4>📜 История правок</h4><p class="hint">Клик — откатить сцену к этой точке (новой правкой, её тоже можно отменить).</p><div id="hl"></div>');
  const box = p.querySelector('#hl');
  H.slice().reverse().forEach((h, ri) => {
    const i = H.length - 1 - ri, d = document.createElement('div');
    d.className = 'hist ' + (h.by || ''); d.tabIndex = 0;
    d.innerHTML = `<span class="who">${h.by === 'claude' ? 'Claude' : h.by === 'editor' ? 'версия' : 'ты'}</span><span class="dim mono">${new Date(h.ts).toLocaleTimeString().slice(0, 5)}</span><span></span>`;
    d.lastChild.textContent = h.desc + (h.ops && h.ops.length ? ` (${h.ops.length})` : '');
    const go = () => {
      const after = H.slice(i + 1).filter(x => x.undo && x.undo.length);
      if (!after.length) return;
      const ops = after.reverse().flatMap(x => x.undo);
      ED.commit(ops, `↺ откат к: ${h.desc}`);
      p.hidden = true;
    };
    d.onclick = go; d.onkeydown = e => { if (e.key === 'Enter') go(); };
    box.append(d);
  });
}
function keysHelp() {
  const L = { select_all: 'выбрать всё', deselect_all: 'снять выбор', grab: 'двигать', rotate: 'вращать', scale: 'масштаб', reset_pos: 'сбросить позицию', reset_rot: 'сбросить поворот', reset_scale: 'сбросить масштаб',
    gizmo_move: 'гизмо: сдвиг', gizmo_rotate: 'гизмо: поворот', gizmo_scale: 'гизмо: масштаб', duplicate: 'дублировать', add: 'добавить предмет', link: 'привязать к активному', unlink: 'отвязать на курсоре', delete: 'удалить', hide: 'скрыть', unhide_all: 'показать всё', group: 'сгруппировать', ungroup: 'разгруппировать',
    key: 'ключ на текущем времени', unkey: 'удалить ключи на времени', frame_sel: 'показать выбранное', frame_all: 'показать всё', cam_view: 'вид камеры', cam_key: 'камера на этот вид (ключ)',
    props: 'панель свойств', tree: 'дерево', agent: 'агент', play: 'воспроизведение', shuttle_back: 'назад (J)', stop: 'стоп (K)', shuttle_fwd: 'вперёд (L)', frame_prev: 'кадр назад', frame_next: 'кадр вперёд',
    frame_prev5: '5 кадров назад', frame_next5: '5 кадров вперёд', key_prev: 'к прошлому ключу', key_next: 'к следующему ключу', start: 'в начало', end: 'в конец', work_in: 'начало рабочей области', work_out: 'конец рабочей области',
    undo: 'отмена', redo: 'вернуть', save: 'сохранить версию', comment: 'просьба к Claude о выбранном', marker: 'маркер', cut: 'склейка камеры', rename: 'переименовать', copy_keys: 'копировать ключи', paste_keys: 'вставить ключи', del_keys: 'удалить ключи' };
  const rows = Object.entries(KEYMAP).filter(([k]) => k !== '_').map(([k, v]) => `<tr><td>${L[k] || k}</td><td class="mono">${v.map(x => x.replace('tl:', 'таймлайн: ').replace('vp:', '')).join(' · ')}</td></tr>`).join('');
  popup(`<h4>⌨ Клавиши</h4><p class="hint">Объекты — как в Blender, время — как в Premiere. Средняя кнопка — орбита, Shift+средняя — сдвиг вида, колесо — ближе (на ноутбуке: Alt+ЛКМ орбита, ПКМ — сдвиг вида). В полях ввода работают только Ctrl+Z / Ctrl+Shift+Z / Ctrl+S / Esc. Карта — web/editor/keymap.json.</p><table>${rows}</table>`);
}
async function versions() {
  const vs = ((ED.info.element || {}).versions || []);
  const p = popup('<h4>🗂 Версии сцены</h4><div id="vl"></div>');
  const box = p.querySelector('#vl');
  if (!vs.length) box.innerHTML = '<p class="hint">Сохранённых версий редактора пока нет: «💾 версия» или Ctrl+S.</p>';
  for (const v of vs.slice().reverse()) {
    const d = document.createElement('div'); d.className = 'row'; d.style.margin = '4px 0';
    d.innerHTML = `<b>v${v.v}</b><span class="dim grow"></span>`;
    d.querySelector('span').textContent = (v.feedback || '').slice(0, 90);
    const see = document.createElement('button'); see.textContent = '👁 открыть'; see.onclick = () => { location.search = `?key=${encodeURIComponent(ED.key)}&el=${ED.el}&ver=${v.v}`; };
    const mk = document.createElement('button'); mk.textContent = '↺ сделать рабочей копией';
    mk.onclick = async () => {
      p.hidden = true;
      if (!(await ED.confirm(`Рабочая копия станет как v${v.v}? Отменить можно Ctrl+Z.`, 'Сделать рабочей копией'))) return;
      try { const r = await api('/api/scene/restore', { key: ED.key, el: ED.el, v: v.v }); p.hidden = true; await reload('версия v' + v.v); ED.undo.push({ batch: r.batch, desc: `рабочая копия из v${v.v}`, ops: r.ops, undo: r.undo, at: Date.now() }); ED.msg(`↺ Рабочая копия = v${v.v}`); }
      catch (e) { ED.msg(e.message, 'err'); }
    };
    d.append(see, mk); box.append(d);
  }
}

// ---------------------------------------------------------------- keys
let KEYMAP = {};
const CODE = { Space: 'space', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Delete: 'delete', Backspace: 'backspace', Escape: 'esc', Enter: 'enter',
  Home: 'home', End: 'end', Slash: '/', NumpadDecimal: 'numpad.', Period: '.', Tab: 'tab', NumpadDivide: '/' };
function combo(e) {
  let k = CODE[e.code] || (e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Numpad') ? 'numpad' + e.code.slice(6).toLowerCase() : e.code.toLowerCase());
  return (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + k;
}
function actionFor(c, ctx) {
  for (const [act, list] of Object.entries(KEYMAP)) if (act !== '_' && list.includes(ctx + ':' + c)) return act;
  for (const [act, list] of Object.entries(KEYMAP)) if (act !== '_' && list.includes(c)) return act;
  return null;
}
addEventListener('keydown', e => {
  if (!ED.doc) return;
  if (ED.vp && ED.vp.modalKey(e)) { e.preventDefault(); return; }
  const tag = (e.target.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const c = combo(e);
  if (typing) {
    if (['ctrl+z', 'ctrl+shift+z', 'ctrl+y', 'ctrl+s'].includes(c) && !(tag === 'textarea')) { e.preventDefault(); ACT[actionFor(c, '')](); }
    if (c === 'esc') e.target.blur();
    return;
  }
  if (!$('popup').hidden || !$('menu').hidden) return;
  const inTl = e.target === $('tlCanvas') || $('tlNames').contains(e.target), inTree = $('treeList').contains(e.target);
  if (inTree && ED.panels.treeKey(e)) { e.preventDefault(); return; }
  if (c === 'esc') {
    if (ED.entered) { ED.entered = null; ED.msg('Вышел из группы'); return; }
    if (ED.sel.size) { ED.select([]); return; }
    if (ED.view === 'camera') { ED.setView('free'); return; }
    back(); return;
  }
  const act = actionFor(c, inTl ? 'tl' : 'vp');
  if (!act || !ACT[act]) return;
  if (e.target.tagName === 'BUTTON' && (c === 'space' || c === 'enter')) return;     // a focused button gets its own Space / Enter
  e.preventDefault();
  ACT[act]();
});

function back() {
  if (ED.pending) { ED.msg('Ещё сохраняю — секунду'); return; }
  if (window.parent !== window) parent.postMessage({ type: 'editor-close', el: ED.el, ...(ED.fix ? { back: 'review' } : {}), ...(ED.info && ED.info.ws ? { ws: ED.info.ws } : {}) }, location.origin);
  else history.length > 1 ? history.back() : (location.href = '/');
}

// ---------------------------------------------------------------- panel splitters (sizes remembered)
function splitters() {
  const root = document.documentElement.style, L = (() => { try { return JSON.parse(localStorage.getItem('editor.sizes') || '{}'); } catch { return {}; } })();
  for (const [k, v] of Object.entries(L)) root.setProperty('--' + k, v);
  for (const s of document.querySelectorAll('.split')) {
    s.onpointerdown = e => {
      s.setPointerCapture(e.pointerId);
      const kind = s.dataset.split;
      s.onpointermove = ev => {
        if (kind === 'right') root.setProperty('--right', Math.max(200, Math.min(innerWidth * 0.6, innerWidth - ev.clientX)) + 'px');
        if (kind === 'tl') root.setProperty('--tl', Math.max(90, Math.min(innerHeight * 0.7, innerHeight - ev.clientY)) + 'px');
        if (kind === 'props') { const r = $('side').getBoundingClientRect(); root.setProperty('--props', Math.max(15, Math.min(85, (r.bottom - ev.clientY) / r.height * 100)) + '%'); }
        ED.tlDirty = true;
      };
      s.onpointerup = () => {
        s.onpointermove = null;
        try { localStorage.setItem('editor.sizes', JSON.stringify({ right: root.getPropertyValue('--right'), tl: root.getPropertyValue('--tl'), props: root.getPropertyValue('--props') })); } catch {}
      };
    };
  }
}

// ---------------------------------------------------------------- one frame of the scene at ED.t
function step(t) {
  const w = ED.w;
  w.t = t; w.T = t; w.D = 4;
  applyScene(ED.S, t);
  for (const f of w.ticks) f(t, t);
  for (const c of w.dyn) if (c.visible && c.userData.redraw) c.userData.redraw(t, t);
  w.cam.updateProjectionMatrix(); w.cam.lookAt(w.target);
  if (w.dof) w.dof.target = w.focus || w.target;
}

function loop(now) {
  if (ED.playing) {
    const dt = ED.last ? Math.min(0.1, (now - ED.last) / 1000) : 0;
    const [a, b] = ED.work || [0, ED.doc.len];
    let t = ED.t + dt * ED.speed;
    if (t > b) { if (ED.loop) { t = a; ED.t = t; audio.restart(); } else { t = b; ED.stop(); } }
    if (t < a) { t = ED.loop ? b : a; }
    ED.t = t; ED.dirty = ED.tlDirty = ED.uiDirty = true;
  }
  ED.last = now;
  if (ED.dirty) {
    ED.dirty = false;
    try { step(ED.t); ED.vp.render(); } catch (e) { console.error(e); }
  }
  if (ED.tlDirty) { ED.tlDirty = false; ED.tl.draw(); }
  if (ED.uiDirty) { ED.uiDirty = false; ED.panels.refresh(); $('tcur').textContent = ED.fmt(ED.t); }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- ✋ правка из ревью (S8): сцена в моменте кадра, правки -> пометка для пересборки
function fixBar() {
  const b = document.getElementById('fixbar'); if (!b) return;
  const n = ED.fix.ops.length;
  b.querySelector('.n').textContent = n ? `изменений: ${n}` : 'подвинь, поверни, поменяй позу — правки уйдут пометкой';
  b.querySelector('.save').disabled = !n;
}
function startFix() {
  ED.t = Math.max(0, +q.get('t') || 0);
  try { ED.setView('camera'); } catch {}
  for (const id of ['version', 'clip', 'agentBtn']) { const e = document.getElementById(id); if (e) e.disabled = true; }
  const bar = document.createElement('div'); bar.id = 'fixbar';
  bar.innerHTML = `<b>✋ Правка в кадре</b><span class="dim">${ED.fix.vt.toFixed(2)} с ролика → ${ED.t.toFixed(2)} с сцены</span><span class="n dim"></span>
    <input class="why" placeholder="Что не так и почему (например: ёжик застрял в стене)"><button class="save primary">💾 Сохранить пометку</button><button class="cancel">Отмена</button>`;
  document.body.append(bar);
  const close = saved => window.parent.postMessage({ type: 'editor-close', back: 'review', fix: !!saved }, location.origin);
  bar.querySelector('.why').addEventListener('keydown', e => e.stopPropagation());
  bar.querySelector('.cancel').onclick = () => close(false);
  bar.querySelector('.save').onclick = async () => {
    const why = bar.querySelector('.why').value.trim();
    if (!why) { ED.msg('Напиши, что не так, — агенту нужно «почему»', 'warn'); bar.querySelector('.why').focus(); return; }
    try {
      await api('/api/montage/fix', { video: ED.key.slice(5), el: ED.el, vt: ED.fix.vt, ts: ED.t, ops: ED.fix.ops, why, desc: ED.undo.map(u => u.desc).filter(Boolean).join('; ') });
      close(true);
    } catch (e) { ED.msg('Не сохранилось: ' + e.message, 'err'); }
  };
  fixBar();
  ED.msg('✋ Правки здесь не меняют сцену сразу: сохрани их пометкой, агент внесёт при пересборке');
}
// ---------------------------------------------------------------- boot
const load = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src + (src.includes('?') ? '&' : '?') + 'v=' + Date.now(); s.onload = ok; s.onerror = () => bad(new Error('не загрузилось: ' + src)); document.head.append(s); });
const pic = (k, src) => new Promise(ok => { const im = new Image(); im.onload = () => { IMG[k] = im; ok(); }; im.onerror = () => ok(); im.src = src; });

(async () => {
  try {
    if (!ED.key || !ED.el) throw new Error('нет ?key=plan:…&el=…');
    ED.ver = q.get('ver');
    KEYMAP = await fetch('/editor/keymap.json').then(r => r.json());
    let j;
    try { j = await api(`/api/scene?key=${encodeURIComponent(ED.key)}&el=${ED.el}${ED.ver ? '&ver=' + ED.ver : ''}`); }
    catch (e) {
      if (e.data && e.data.missing) { $('boot').textContent = 'Эта сцена ещё в старом формате.\nПереведи её в редактор кнопкой в карточке сцены («Перевести в редактор»).'; return; }
      throw e;
    }
    ED.doc = j.scene; ED.rev = j.rev; ED.hist = j.history; ED.cues = j.cues; ED.info = j; ED.readonly = !!ED.ver; ED.prefabsRev = j.prefabsRev || 0; ED.propsRev = j.propsRev || 0;
    ED.locked = j.locked || null;
    ED.fix = q.get('fix') ? { vt: +q.get('vt') || 0, ops: [] } : null;     // ✋ правка из ревью (S8)
    if (ED.fix) ED.locked = null;
    document.title = `${ED.doc.name} — оформление сцены`;
    $('sname').textContent = ED.doc.name;
    $('sver').textContent = ED.readonly ? `· v${ED.ver} — только просмотр` : `· рабочая копия${j.element && j.element.v ? ` (последняя версия v${j.element.v})` : ''}`;
    await window.THREE_READY;
    await load(j.prefabs);
    const P = typeof PICS !== 'undefined' ? PICS : {};
    await Promise.all(Object.entries(P).map(([k, s]) => pic(k, s)));
    await Promise.all(['900 40px Rubik', '800 40px Nunito', '700 40px Caveat'].map(f => document.fonts.load(f).catch(() => {})));
    if (j.style3d) PROP_STYLE = j.style3d;
    ED.lib = await loadSceneProps(scenePropRefs(ED.doc), ED.key.slice(5), load, {}, ED.doc);          // 3D-пропсы lib: / el: (S3)
    ED.loadProp = async ref => { await loadSceneProps([ref], ED.key.slice(5), load, ED.lib); return !!ED.lib[ref]; };
    await loadSceneEnvs(ED.doc, ED.key.slice(5), ED.el);                                    // липсинк (S5)
    ED.w = sceneWorld(ED.doc, typeof PREFABS !== 'undefined' ? PREFABS : {}, ED.lib);
    await stage3dInit();
    ED.S = ED.w.S;
    initViewport(ED);
    ED.anim = initAnim(ED);                                      // S5: клипы, ключи позы, ручки IK, «+ научить»
    ED.panels = initPanels(ED);
    ED.tl = initTimeline(ED);
    ED.agent = initAgent(ED);
    if (ED.info.ws) initWorkshop(ED);                               // 🛠 мастерская ассета (S10): сборка / анимация, клип из ключей позы
    splitters();
    $('back').onclick = back;
    $('autokey').onclick = () => { ED.autokey = !ED.autokey; $('autokey').setAttribute('aria-pressed', ED.autokey); ED.msg(ED.autokey ? '⏺ Автоключ включён: правка анимированного свойства ставит ключ' : 'Автоключ выключен: правка меняет значение, ключи не ставятся'); };
    $('camkey').onclick = () => ED.vp.keyFromView();
    $('camview').onclick = ACT.cam_view;
    $('clip').onclick = makeClip;
    $('version').onclick = saveVersion;
    $('agentBtn').onclick = () => ED.agent.toggle();
    $('addBtn').onclick = addMenu;
    $('menuBtn').onclick = menu;
    $('play').onclick = () => ED.play(1);
    const tl = $('tlen'); tl.value = ED.doc.len;
    tl.onchange = () => { const v = Math.max(0.5, Math.min(600, +tl.value || ED.doc.len)); if (v !== ED.doc.len) ED.commit([{ op: 'set', path: ['len'], value: v }], `длина сцены ${v} с`); };
    if (ED.readonly) for (const b of ['autokey', 'camkey', 'clip', 'version', 'agentBtn', 'addBtn']) $(b).disabled = true;
    // the agent or the CLI changed the scene: the page follows (every 1.5 s)
    setInterval(async () => {
      if (ED.pending || document.hidden || ED.fix) return;
      try {
        const r = await api(`/api/scene/rev?key=${encodeURIComponent(ED.key)}&el=${ED.el}`);
        ED.agent.setLock(r.locked);
        if (!ED.readonly && ((r.rev > ED.rev) || (r.prefabsRev && ED.prefabsRev && r.prefabsRev !== ED.prefabsRev) || (r.propsRev && ED.propsRev && r.propsRev > ED.propsRev))) await reload('rev ' + r.rev);
      } catch {}
    }, 1500);
    try {                                                        // back after a reload for new prefabs: the same moment, selection and undo stack
      const k = JSON.parse(sessionStorage.getItem('editor.keep') || 'null');
      sessionStorage.removeItem('editor.keep');
      if (k && k.el === ED.el) { ED.t = k.t || 0; ED.select((k.sel || []).filter(id => id === 'camera' || find(ED.doc, id))); ED.undo = k.undo || []; ED.redo = k.redo || []; if (k.why) setTimeout(() => ED.msg('🎨 ' + k.why)); }
    } catch {}
    if (ED.fix) startFix();
    step(ED.t); ED.vp.fromScene();                               // the free camera starts where the scene camera is at t
    document.getElementById('app').classList.remove('loading');
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    $('boot').textContent = '⚠ ' + e.message;
  }
})();
