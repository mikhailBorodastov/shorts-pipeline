// Дерево объектов (виртуальный список, группы, перетаскивание в группу, F2, 👁 и 🔒) и свойства выбранного
// (числа с колёсиком и перетаскиванием по подписи, ◆ ключи, источник, параметры префаба; камера, свет, сцена целиком).
import { find, kindOf, setOps, valueAt, track, keyAt, animated, camKeyOps, EPS } from './keys.js';
import { clone } from './ops.js';

const ROW = 22;
const RAD = Math.PI / 180;

export function initPanels(ED) {
  const $ = id => document.getElementById(id);
  const list = $('treeList'), props = $('props'), findBox = $('treeFind');
  const open = new Set(), P = { rows: [], cursor: 0, renaming: null, sig: '', drag: null };

  // ---------------------------------------------------------------- tree
  function rows() {
    const d = ED.doc, qy = findBox.value.trim().toLowerCase(), out = [];
    out.push({ id: 'camera', name: 'Камера', icon: '🎥', depth: 0, kind: 'camera', anim: (d.camera.keys || []).length > 1 });
    const L = d.lights || [];
    if (L.length) {
      out.push({ id: '#lights', name: `Свет · ${L.length}`, icon: '💡', depth: 0, kind: 'folder', open: open.has('#lights'), kids: true });
      if (open.has('#lights') || qy) for (const l of L) if (!qy || (l.name || '').toLowerCase().includes(qy)) out.push({ id: l.id, name: l.name || l.type, icon: l.type === 'ambient' ? '☁' : '💡', depth: 1, kind: 'light', anim: animated(l) });
    }
    const objs = d.objects || [], kids = new Map();
    for (const o of objs) { const p = o.parent && objs.some(x => x.id === o.parent) ? o.parent : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(o); }
    const match = o => !qy || (o.name || '').toLowerCase().includes(qy) || (kids.get(o.id) || []).some(match);
    const walk = (p, depth) => {
      for (const o of kids.get(p) || []) {
        if (!match(o)) continue;
        const g = o.type === 'group', isOpen = open.has(o.id) || !!qy;
        const ov = (ED.S.objects.get(o.id) || {}).overlay;
        out.push({ id: o.id, name: o.name, icon: g ? '🔗' : ov ? '🅰' : iconOf(o), depth, kind: g ? 'group' : 'object', open: isOpen, kids: g && (kids.get(o.id) || []).length > 0,
          anim: animated(o), hid: valueAt(o, 'hide', ED.t), locked: !!o.locked, n: g ? (kids.get(o.id) || []).length : 0 });
        if (g && isOpen) walk(o.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }
  const iconOf = o => { const p = ((o.src || {}).prefab || '').toLowerCase(), n = (o.name || '').toLowerCase(); return /hog|ёжик/.test(p + n) ? '🦔' : /lamp|ламп/.test(p + n) ? '💡' : /window|окно/.test(p + n) ? '🪟' : /clock|час/.test(p + n) ? '🕒' : /chair|кресл/.test(p + n) ? '🪑' : /crt|монитор/.test(p + n) ? '🖥' : '▫'; };

  function drawTree() {
    P.rows = rows();
    const sig = JSON.stringify([P.rows.map(r => [r.id, r.name, r.open, r.anim, r.hid, r.locked, r.depth]), [...ED.sel], ED.active, P.cursor, P.renaming, P.dropOn]);
    if (sig === P.sig && list.childElementCount) return;
    P.sig = sig;
    const top = list.scrollTop, h = list.clientHeight || 300, a = Math.max(0, Math.floor(top / ROW) - 10), b = Math.min(P.rows.length, Math.ceil((top + h) / ROW) + 10);
    list.innerHTML = '';
    const spacer = document.createElement('div'); spacer.style.height = P.rows.length * ROW + 'px'; spacer.style.position = 'relative'; list.append(spacer);
    for (let i = a; i < b; i++) spacer.append(rowEl(P.rows[i], i));
  }
  list.addEventListener('scroll', () => { P.sig = ''; drawTree(); });

  function rowEl(r, i) {
    const d = document.createElement('div');
    d.className = 'trow' + (ED.sel.has(r.id) ? ' sel' : '') + (ED.active === r.id ? ' active' : '') + (P.cursor === i ? ' cursor' : '') + (r.hid ? ' hid' : '') + (P.dropOn === r.id ? ' drop' : '');
    d.style.cssText = `position:absolute;left:0;right:0;top:${i * ROW}px;padding-left:${4 + r.depth * 14}px`;
    d.setAttribute('role', 'treeitem'); d.setAttribute('aria-selected', ED.sel.has(r.id)); if (r.kids) d.setAttribute('aria-expanded', !!r.open);
    const tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = r.kids ? (r.open ? '▾' : '▸') : '';
    tw.onclick = e => { e.stopPropagation(); toggleOpen(r.id); };
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = r.icon;
    const nm = document.createElement('span'); nm.className = 'nm';
    if (P.renaming === r.id) {
      const inp = document.createElement('input'); inp.value = r.name; nm.append(inp);
      setTimeout(() => { inp.focus(); inp.select(); });
      const done = ok => {
        if (P.renaming !== r.id) return;
        P.renaming = null; P.sig = '';
        const v = inp.value.trim().slice(0, 80);
        if (ok && v && v !== r.name) ED.commit([{ op: 'set', path: [r.kind === 'light' ? 'lights' : 'objects', r.id, 'name'], value: v }], `переименовано: «${r.name}» → «${v}»`);
        ED.uiDirty = true; list.focus();
      };
      inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(true);
    } else nm.textContent = r.name + (r.n ? ` · ${r.n}` : '');
    d.append(tw, ic, nm);
    if (r.anim) { const k = document.createElement('span'); k.className = 'k'; k.textContent = '◆'; k.title = 'есть ключи'; d.append(k); }
    if (r.kind === 'object' || r.kind === 'group') {
      const eye = document.createElement('span'); eye.className = 'tb' + (r.hid ? '' : ' on'); eye.textContent = '👁'; eye.title = r.hid ? 'показать (H)' : 'скрыть (H)';
      eye.onclick = e => { e.stopPropagation(); const o = find(ED.doc, r.id); ED.commit(setOps(ED.doc, r.id, 'hide', !valueAt(o, 'hide', ED.t), ED.t, ED.autokey), `${r.hid ? 'показать' : 'скрыть'}: ${r.name}`); };
      const lk = document.createElement('span'); lk.className = 'tb' + (r.locked ? ' on' : ''); lk.textContent = '🔒'; lk.title = r.locked ? 'разблокировать' : 'блок: не выбирается в 3D-виде';
      lk.onclick = e => { e.stopPropagation(); ED.commit([{ op: 'set', path: ['objects', r.id, 'locked'], value: !r.locked }], `${r.locked ? 'разблокировать' : 'заблокировать'}: ${r.name}`); };
      d.append(eye, lk);
      d.draggable = true;
      d.ondragstart = e => { P.drag = r.id; e.dataTransfer.effectAllowed = 'move'; };
      d.ondragend = () => { P.drag = null; P.dropOn = null; P.sig = ''; ED.uiDirty = true; };
    }
    d.ondragover = e => { if (!P.drag || P.drag === r.id) return; if (r.kind === 'group' || r.kind === 'object') { e.preventDefault(); if (P.dropOn !== r.id) { P.dropOn = r.id; P.sig = ''; ED.uiDirty = true; } } };
    d.ondrop = e => { e.preventDefault(); e.stopPropagation(); if (P.drag) reparent(P.drag, r.kind === 'group' ? r.id : (find(ED.doc, r.id) || {}).parent || null); };
    d.onclick = e => {
      if (r.kind === 'folder') { toggleOpen(r.id); return; }
      P.cursor = i;
      if (e.shiftKey || e.ctrlKey) ED.toggleSel(r.id); else ED.select([r.id]);
    };
    d.ondblclick = () => { if (r.kind === 'group') { ED.entered = r.id; open.add(r.id); ED.msg(`Внутри «${r.name}»: клик в 3D выбирает её части. Esc — выйти`); P.sig = ''; ED.uiDirty = true; } else if (r.kind !== 'folder' && r.kind !== 'camera') rename(r.id); };
    return d;
  }
  list.ondragover = e => { if (P.drag) e.preventDefault(); };
  list.ondrop = e => { e.preventDefault(); if (P.drag) reparent(P.drag, null); };
  function toggleOpen(id) { if (open.has(id)) open.delete(id); else open.add(id); P.sig = ''; ED.uiDirty = true; }
  function reparent(id, to) {
    P.drag = null; P.dropOn = null;
    const o = find(ED.doc, id);
    if (!o || (o.parent || null) === to) return;
    for (let p = to; p; p = (find(ED.doc, p) || {}).parent) if (p === id) { ED.msg('Группу нельзя положить в саму себя', 'warn'); return; }
    // keep the place in the world: the new parent chain's transform is undone into the object's own
    const rec = ED.S.objects.get(id), dst = to ? ED.S.objects.get(to).holder : ED.w.scene;
    const m = dst.matrixWorld.clone().invert().multiply(rec.holder.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const ops = [{ op: 'set', path: ['objects', id, 'parent'], value: to }];
    if (!animated(o)) ops.push({ op: 'set', path: ['objects', id, 'pos'], value: [p.x, p.y, p.z].map(r4) }, { op: 'set', path: ['objects', id, 'rot'], value: [e.x, e.y, e.z].map(r4) });
    ED.commit(ops, to ? `«${o.name}» → в группу «${find(ED.doc, to).name}»` : `«${o.name}» — из группы`);
    if (to) open.add(to);
  }
  const r4 = v => Math.round(v * 10000) / 10000;
  function rename(id) { id = id || ED.active; if (!id || id === 'camera') return; P.renaming = id; P.sig = ''; drawTree(); const i = P.rows.findIndex(r => r.id === id); if (i >= 0) list.scrollTop = Math.max(0, i * ROW - 60); }

  function treeKey(e) {
    if (P.renaming) return false;
    const n = P.rows.length, r = P.rows[P.cursor];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      P.cursor = Math.max(0, Math.min(n - 1, P.cursor + (e.key === 'ArrowDown' ? 1 : -1)));
      const x = P.rows[P.cursor]; if (x && x.kind !== 'folder') { if (e.shiftKey) ED.toggleSel(x.id); else ED.select([x.id]); }
      const y = P.cursor * ROW; if (y < list.scrollTop) list.scrollTop = y; if (y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW - list.clientHeight;
      P.sig = ''; ED.uiDirty = true; return true;
    }
    if (e.key === 'ArrowRight' && r && r.kids && !r.open) { toggleOpen(r.id); return true; }
    if (e.key === 'ArrowLeft' && r) {
      if (r.kids && r.open) toggleOpen(r.id);
      else { const par = (find(ED.doc, r.id) || {}).parent || (r.depth && r.kind === 'light' ? '#lights' : null); const i = P.rows.findIndex(x => x.id === par); if (i >= 0) { P.cursor = i; P.sig = ''; ED.uiDirty = true; } }
      return true;
    }
    if (e.key === 'Enter' && r) { if (r.kind === 'folder') toggleOpen(r.id); else ED.select([r.id]); return true; }
    if (e.key === 'F2') { rename(r && r.id); return true; }
    return false;
  }

  // ---------------------------------------------------------------- properties
  let propSig = '';
  function refreshProps(force) {
    const id = ED.active, d = ED.doc;
    const o = id && id !== 'camera' && id !== 'camera:target' ? find(d, id) : null;
    const sig = JSON.stringify([id, ED.t, o, id && id.startsWith && id.startsWith('camera') ? d.camera : null, !id ? [d.name, d.len, d.fps, d.world, d.authored] : 0, ED.sel.size, ED.readonly]);
    if (!force && sig === propSig) return;
    if (props.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && !force) return;    // do not steal what the author is typing
    propSig = sig;
    props.innerHTML = '';
    if (ED.sel.size > 1) { h3(`Выбрано: ${ED.sel.size}`); hint('G / R / S двигают всё выбранное; Ctrl+G — в группу; I — ключ всем.'); }
    if (!id) return sceneProps();
    if (id === 'camera' || id === 'camera:target') return cameraProps();
    if (!o) return;
    const kind = kindOf(d, id);
    h3((o.type === 'group' ? '🔗 ' : kind === 'lights' ? '💡 ' : '') + o.name);
    if (kind === 'lights') return lightProps(o);
    vec(o, 'pos', 'позиция', 'м', 0.01);
    rot(o);
    scale(o);
    const row = div('grp');
    row.append(check('видимость', !valueAt(o, 'hide', ED.t), v => ED.commit(setOps(d, id, 'hide', !v, ED.t, ED.autokey), `${v ? 'показать' : 'скрыть'}: ${o.name}`)),
      check('блок 🔒', !!o.locked, v => ED.commit([{ op: 'set', path: ['objects', id, 'locked'], value: v }], `${v ? 'заблокировать' : 'разблокировать'}: ${o.name}`)));
    props.append(row);
    if (o.type !== 'group') params(o);
    const src = o.src || {}, els = (ED.info.elNames || {});
    const s = div('src');
    s.textContent = o.type === 'group' ? `группа · частей: ${(d.objects || []).filter(x => x.parent === id).length}` :
      `источник: ${src.el ? `элемент «${els[src.el] || src.el}» (${src.el})` : '—'} · префаб ${src.prefab || '—'}${src.lib ? ' · ' + src.lib : ''}`;
    props.append(s);
    const au = (d.authored || {})[id];
    if (au && au.length) props.append(Object.assign(div('hint'), { textContent: '✋ правил руками: ' + au.join(', ') + ' — Claude не трогает без просьбы' }));
  }

  // one numeric row: label (drag to scrub), inputs, ◆
  function numRow(label, unit, vals, step, onSet, keyed, keyInfo, fmt = v => +v.toFixed(3)) {
    if (onSet.length < 2) {                                 // a plain setter: the wheel settles for half a second, a drag lands on release
      const f = onSet; let tm;
      onSet = (nv, live) => { if (!live) return f(nv); clearTimeout(tm); if (live === 'end') return f(nv); if (live === 'wheel') tm = setTimeout(() => f(nv), 500); };
    }
    const row = div('prop'), lab = document.createElement('label'), box = div('vals');
    lab.textContent = label; lab.title = 'Потяни влево-вправо — плавно менять';
    const ins = vals.map((v, i) => {
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = step; inp.value = fmt(v);
      inp.setAttribute('aria-label', `${label} ${vals.length > 1 ? 'xyz'[i] : ''} ${unit}`.trim());
      if (keyed) inp.className = keyInfo && keyInfo.at ? 'keyed' : 'anim';
      inp.onchange = () => { const nv = vals.slice(); nv[i] = +inp.value; onSet(nv, false); };
      inp.onwheel = e => { if (document.activeElement !== inp) return; e.preventDefault(); const nv = vals.slice(); nv[i] = +(+inp.value - Math.sign(e.deltaY) * step * (e.shiftKey ? 10 : 1)).toFixed(4); inp.value = fmt(nv[i]); vals = nv; onSet(nv, 'wheel'); };
      box.append(inp); return inp;
    });
    lab.onpointerdown = e => {
      lab.setPointerCapture(e.pointerId);
      const x0 = e.clientX, v0 = vals.slice();
      // drag the label: the first number (x of a vector), Shift — finer
      lab.onpointermove = ev => { const dv = (ev.clientX - x0) * step * (ev.shiftKey ? 0.1 : 1); const nv = v0.slice(); nv[0] = +(v0[0] + dv).toFixed(4); ins[0].value = fmt(nv[0]); vals = nv; onSet(nv, 'drag'); };
      lab.onpointerup = () => { lab.onpointermove = null; onSet(vals, 'end'); };
    };
    const kb = document.createElement('button'); kb.className = 'kb' + (keyed ? ' on' : '') + (keyInfo && keyInfo.at ? ' at' : ''); kb.textContent = '◆';
    kb.title = keyInfo && keyInfo.at ? 'ключ на этом времени — клик удалит' : keyed ? 'анимировано — клик поставит ключ' : 'клик — начать анимацию: ключ на текущем времени';
    kb.onclick = () => keyInfo && keyInfo.toggle();
    row.append(lab, box, kb); props.append(row);
    return row;
  }
  function keyToggle(o, prop, t) {
    const kind = kindOf(ED.doc, o.id), k = keyAt(track(o, prop), t);
    return { at: !!k, toggle: () => {
      if (k) ED.commit([{ op: 'del', path: [kind, o.id, 'keys', prop], id: k.id }], `${o.name}: ключ ${PN[prop] || prop} на ${t.toFixed(2)} с удалён`);
      else ED.commit(setOps(ED.doc, o.id, prop, valueAt(o, prop, t), t, true, true), `${o.name}: ключ ${PN[prop] || prop} на ${t.toFixed(2)} с`);
    } };
  }
  const PN = { pos: 'позиции', rot: 'поворота', scale: 'масштаба', hide: 'видимости', intensity: 'яркости' };
  function vec(o, prop, label, unit, step) {
    const v = valueAt(o, prop, ED.t) || [0, 0, 0];
    numRow(label, unit, v.slice(), step, (nv, live) => edit(o, prop, nv, live, `${o.name}: ${label}`), track(o, prop).length > 0, keyToggle(o, prop, ED.t));
  }
  function rot(o) {
    const v = (valueAt(o, 'rot', ED.t) || [0, 0, 0]).slice(), keyed = track(o, 'rot').length > 0, kt = keyToggle(o, 'rot', ED.t);
    const full = P.rotFull || Math.abs(v[0]) > 1e-4 || Math.abs(v[2]) > 1e-4;
    const deg = full ? v.map(x => x / RAD) : [v[1] / RAD];
    const row = numRow(full ? 'поворот' : 'поворот Y', '°', deg, 1, (nv, live) => {
      const r = full ? nv.map(x => x * RAD) : [v[0], nv[0] * RAD, v[2]];
      edit(o, 'rot', r, live, `${o.name}: поворот`);
    }, keyed, kt, x => +x.toFixed(1));
    if (!full) { const more = document.createElement('button'); more.textContent = 'X Z'; more.title = 'показать наклон по X и Z'; more.style.cssText = 'font-size:10px;padding:0 4px'; more.onclick = () => { P.rotFull = true; refreshProps(true); }; row.querySelector('.vals').append(more); }
  }
  function scale(o) {
    const v = valueAt(o, 'scale', ED.t), arr = Array.isArray(v) ? v : [v == null ? 1 : v];
    numRow('масштаб', '×', arr.slice(), 0.01, (nv, live) => edit(o, 'scale', nv.length === 1 ? nv[0] : nv, live, `${o.name}: масштаб`), track(o, 'scale').length > 0, keyToggle(o, 'scale', ED.t));
    const s = arr.length === 1 ? arr[0] : Math.max(...arr);
    if (s < 0.25 || s > 4) props.append(Object.assign(div('hint'), { textContent: '⚠ далеко за обычными пределами (×0.25…4)' }));
  }
  // live = wheel / scrub: many small steps, one undo entry (merge)
  // live: 'wheel' / 'drag' — only on the page until it stops ('end' or a pause), then one batch
  function put(key, mk, desc, live) {
    if (live === 'end') { ED.liveEnd(key); return; }
    if (live) ED.live(key, mk, desc, live === 'wheel' ? 700 : 0); else ED.commit(mk(), desc);
  }
  function edit(o, prop, v, live, desc) {
    const t = ED.t;
    put(o.id + ':' + prop, () => setOps(ED.doc, o.id, prop, v, t, ED.autokey), desc, live);
    const p = Array.isArray(v) ? v : null;
    if (prop === 'pos' && p && (Math.abs(p[0]) > 12 || Math.abs(p[2]) > 12 || p[1] < -2 || p[1] > 6)) ED.msg(`⚠ «${o.name}» далеко от комнаты — так и задумано?`, 'warn');
  }
  function params(o) {
    const info = ((ED.info.prefabInfo || {})[(o.src || {}).prefab]) || {};
    const pr = Object.assign({}, info.params || {}, o.params || {});
    const keys = Object.keys(pr);
    if (info.note) props.append(Object.assign(div('hint'), { textContent: info.note }));
    if (!keys.length) return;
    const g = div('grp'); g.append(Object.assign(document.createElement('b'), { textContent: 'Параметры предмета' })); props.append(g);
    for (const k of keys) {
      const v = pr[k], row = div('prop'), lab = document.createElement('label'); lab.textContent = k; lab.style.cursor = 'default';
      if (!(o.params && k in o.params)) lab.title = 'по умолчанию из префаба';
      const box = div('vals');
      let inp;
      if (typeof v === 'boolean') { inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = v; inp.onchange = () => set(inp.checked); }
      else if (typeof v === 'number') { inp = document.createElement('input'); inp.type = 'number'; inp.step = 0.05; inp.value = v; inp.onchange = () => set(+inp.value); }
      else if (/^#[0-9a-f]{6}$/i.test(v)) { inp = document.createElement('input'); inp.type = 'color'; inp.value = v; inp.onchange = () => set(inp.value); }
      else { inp = document.createElement('input'); inp.value = typeof v === 'string' ? v : JSON.stringify(v); inp.onchange = () => { let x = inp.value; try { x = JSON.parse(x); } catch {} set(x); }; }
      inp.setAttribute('aria-label', k);
      const set = x => ED.commit([{ op: 'set', path: ['objects', o.id, 'params', k], value: x }], `${o.name}: ${k} = ${JSON.stringify(x)}`);
      box.append(inp); row.append(lab, box, document.createElement('span')); props.append(row);
    }
  }
  function lightProps(l) {
    if (l.type !== 'ambient') vec(l, 'pos', 'позиция', 'м', 0.01);
    const I = valueAt(l, 'intensity', ED.t);
    numRow('яркость', '', [I == null ? 1 : I], 0.05, (nv, live) => { const t = ED.t; put(l.id + ':I', () => setOps(ED.doc, l.id, 'intensity', Math.max(0, nv[0]), t, ED.autokey), `${l.name}: яркость`, live); },
      track(l, 'intensity').length > 0, keyToggle(l, 'intensity', ED.t));
    const row = div('prop'), lab = document.createElement('label'); lab.textContent = 'цвет'; lab.style.cursor = 'default';
    const c = document.createElement('input'); c.type = 'color'; c.value = (l.type === 'ambient' ? l.sky : l.color) || '#ffffff'; c.setAttribute('aria-label', 'цвет');
    c.onchange = () => ED.commit([{ op: 'set', path: ['lights', l.id, l.type === 'ambient' ? 'sky' : 'color'], value: c.value }], `${l.name}: цвет ${c.value}`);
    const box = div('vals'); box.append(c); row.append(lab, box, document.createElement('span')); props.append(row);
    if (l.dist != null) numRow('дальность', 'м', [l.dist], 0.1, nv => ED.commit([{ op: 'set', path: ['lights', l.id, 'dist'], value: Math.max(0.1, nv[0]) }], `${l.name}: дальность`), false, null);
  }
  function cameraProps() {
    const c = ED.doc.camera, w = ED.w;
    h3('🎥 Камера');
    const pos = [w.cam.position.x, w.cam.position.y, w.cam.position.z], tg = [w.target.x, w.target.y, w.target.z];
    const k = keyAt(c.keys, ED.t);
    const setKey = (p, t) => ED.commit(camKeyOps(ED.doc, ED.t, p, t), `камера: ключ на ${ED.t.toFixed(2)} с`);
    numRow('позиция', 'м', pos, 0.01, nv => setKey(nv, tg), (c.keys || []).length > 0, { at: !!k, toggle: () => (k ? ED.commit([{ op: 'del', path: ['camera', 'keys'], id: k.id }], `камера: ключ на ${ED.t.toFixed(2)} с удалён`) : setKey(pos, tg)) });
    numRow('цель', 'м', tg, 0.01, nv => setKey(pos, nv), (c.keys || []).length > 0, null);
    numRow('угол fov', '°', [w.cam.fov], 1, nv => { if (k) ED.commit([{ op: 'set', path: ['camera', 'keys', k.id, 'fov'], value: nv[0] }], `камера: fov ${nv[0]}°`); else ED.commit([{ op: 'set', path: ['camera', 'fov'], value: nv[0] }], `камера: fov ${nv[0]}°`); }, false, null, x => +x.toFixed(1));
    numRow('дрожь', '', [c.handheld || 0], 0.002, nv => ED.commit([{ op: 'set', path: ['camera', 'handheld'], value: Math.max(0, +nv[0].toFixed(4)) }], `камера: дрожь ${nv[0].toFixed(3)}`), false, null, x => +x.toFixed(4));
    const f = c.focus;
    numRow('фокус', 'м', f || tg, 0.01, nv => ED.commit([{ op: 'set', path: ['camera', 'focus'], value: nv.map(r4) }], 'камера: точка фокуса'), false, null);
    const row = div('row'); row.style.margin = '6px 0';
    const b1 = document.createElement('button'); b1.textContent = '🎥 ключ с этого вида'; b1.onclick = () => ED.vp.keyFromView();
    const b2 = document.createElement('button'); b2.textContent = '✂ склейка здесь'; b2.onclick = () => ED.tl.addCut();
    const b3 = document.createElement('button'); b3.textContent = f ? 'фокус = цель' : ''; b3.hidden = !f; b3.onclick = () => ED.commit([{ op: 'set', path: ['camera', 'focus'], value: null }], 'камера: фокус на цель');
    row.append(b1, b2, b3); props.append(row);
    hint(`Ключей: ${(c.keys || []).length}, склеек: ${(c.cuts || []).length}. Numpad 0 — смотреть глазами камеры; Ctrl+Alt+Numpad 0 — камера сюда. Тяни конус в 3D-виде — ключ на курсоре.`);
  }
  function sceneProps() {
    const d = ED.doc;
    h3('Сцена');
    const row = div('prop'), lab = document.createElement('label'); lab.textContent = 'имя'; lab.style.cursor = 'default';
    const n = document.createElement('input'); n.value = d.name || ''; n.setAttribute('aria-label', 'имя сцены');
    n.onchange = () => ED.commit([{ op: 'set', path: ['name'], value: n.value.trim() || d.name }], `сцена: имя «${n.value.trim()}»`);
    const box = div('vals'); box.append(n); row.append(lab, box, document.createElement('span')); props.append(row);
    numRow('длина', 'с', [d.len], 0.5, nv => ED.commit([{ op: 'set', path: ['len'], value: Math.max(0.5, nv[0]) }], `длина сцены ${nv[0]} с`), false, null);
    numRow('кадров/с', '', [d.fps || 30], 1, nv => ED.commit([{ op: 'set', path: ['fps'], value: Math.max(1, Math.round(nv[0])) }], `кадров в секунду: ${nv[0]}`), false, null, x => x);
    hint(`Объектов: ${(d.objects || []).length} · свет: ${(d.lights || []).length} · маркеров: ${(d.markers || []).length} · звуков: ${(d.sounds || []).length}`);
    hint('Клик по объекту — выбрать. G / R / S — двигать / вращать / масштаб (X Y Z — ось), I — ключ, Shift+D — дубль, Ctrl+G — группа, Numpad 0 — камера, / — Claude. Полный список — ☰ → Клавиши.');
  }
  // small DOM helpers
  function div(c) { const d = document.createElement('div'); d.className = c; return d; }
  function h3(t) { const e = document.createElement('h3'); e.textContent = t; props.append(e); }
  function hint(t) { props.append(Object.assign(div('hint'), { textContent: t })); }
  function check(label, v, on) { const l = document.createElement('label'); l.style.marginRight = '12px'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = v; c.onchange = () => on(c.checked); l.append(c, ' ' + label); return l; }

  findBox.oninput = () => { P.sig = ''; ED.uiDirty = true; };
  findBox.onkeydown = e => { if (e.key === 'Enter') { const r = P.rows.find(x => x.kind !== 'folder' && x.id !== 'camera'); if (r) ED.select([r.id]); } e.stopPropagation(); };

  return {
    refresh() {
      if (ED.active) { const i = P.rows.findIndex(r => r.id === ED.active); if (i >= 0 && i !== P.cursor && !list.contains(document.activeElement)) P.cursor = i; }
      drawTree(); refreshProps();
    },
    treeKey, rename,
  };
}
