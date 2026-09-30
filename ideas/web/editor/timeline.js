// Таймлайн (Premiere): линейка и курсор, рабочая область I / O, маркеры, камера (ключи + ✂ склейки), объекты (свёрнутая строка —
// все ключи объекта, раскрытая — pos / rot / scale / hide / яркость), звуки. Ключи: клик, рамка, Shift, перетаскивание с прилипанием
// (кадры, курсор, маркеры; Alt — без), Delete, ПКМ — ease / копировать / вставить, двойной клик — к моменту. Ctrl+колесо — масштаб.
import { find, kindOf, allKeys, animated, moveKeysOps, EASES, EPS } from './keys.js';
import { newId, clone } from './ops.js';

const RULER = 22, ROWH = 20;
const PN = { pos: 'позиция', rot: 'поворот', scale: 'масштаб', hide: 'видимость', intensity: 'яркость', color: 'цвет' };

export function initTimeline(ED) {
  const $ = id => document.getElementById(id);
  const cv = $('tlCanvas'), g = cv.getContext('2d'), names = $('tlNames');
  const T = { t0: 0, pps: 0, fit: true, sy: 0, open: new Set(), rows: [], hits: [], drag: null, clip: null, nameSig: '' };
  ED.keySel = [];

  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function size() {
    const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * d) || cv.height !== Math.round(r.height * d)) { cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); }
    return { w: r.width, h: r.height, d };
  }
  const len = () => ED.doc.len || 6;
  const X = t => 12 + (t - T.t0) * T.pps;
  const Tof = x => T.t0 + (x - 12) / T.pps;

  // which rows: markers, camera, animated or selected things, sounds
  function rows() {
    const d = ED.doc, out = [{ kind: 'markers', label: '⏷ маркеры' }, { kind: 'camera', label: '🎥 камера', id: 'camera' }];
    const show = o => animated(o) || ED.sel.has(o.id);
    for (const o of [...(d.objects || []), ...(d.lights || [])]) {
      if (!show(o)) continue;
      const kind = kindOf(d, o.id), open = T.open.has(o.id);
      out.push({ kind: 'thing', id: o.id, tkind: kind, label: o.name, open });
      if (open) for (const p of kind === 'lights' ? ['pos', 'intensity'] : ['pos', 'rot', 'scale', 'hide']) out.push({ kind: 'prop', id: o.id, tkind: kind, prop: p, label: PN[p] });
    }
    out.push({ kind: 'sounds', label: '🔊 звуки' });
    return out;
  }

  function namesDom() {
    const sig = JSON.stringify([T.rows.map(r => [r.kind, r.id, r.prop, r.label, r.open]), [...ED.sel], T.sy]);
    if (sig === T.nameSig) return;
    T.nameSig = sig;
    names.innerHTML = '';
    T.rows.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'tn' + (r.kind === 'prop' ? ' sub' : '') + (r.id && ED.sel.has(r.id) && r.kind !== 'prop' ? ' sel' : '');
      d.style.top = RULER + i * ROWH - T.sy + 'px';
      d.setAttribute('role', 'listitem');
      if (r.kind === 'thing') {
        const tw = document.createElement('span'); tw.textContent = r.open ? '▾' : '▸'; tw.style.cursor = 'pointer'; tw.title = 'раскрыть по свойствам';
        tw.onclick = e => { e.stopPropagation(); if (T.open.has(r.id)) T.open.delete(r.id); else T.open.add(r.id); ED.tlDirty = true; };
        d.append(tw);
      }
      const s = document.createElement('span'); s.textContent = r.label; s.style.overflow = 'hidden'; s.style.textOverflow = 'ellipsis'; d.append(s);
      if (r.kind === 'sounds') {
        const b = document.createElement('button'); b.textContent = '+ звук'; b.style.cssText = 'margin-left:auto;padding:0 6px;font-size:11px'; b.onclick = e => { e.stopPropagation(); addSound(); }; d.append(b);
      }
      if (r.kind === 'markers') { const b = document.createElement('button'); b.textContent = '+ M'; b.title = 'маркер на курсоре (M)'; b.style.cssText = 'margin-left:auto;padding:0 6px;font-size:11px'; b.onclick = e => { e.stopPropagation(); addMarker(); }; d.append(b); }
      if (r.kind === 'camera') { const b = document.createElement('button'); b.textContent = '✂'; b.title = 'склейка на курсоре (C)'; b.style.cssText = 'margin-left:auto;padding:0 6px;font-size:11px'; b.onclick = e => { e.stopPropagation(); addCut(); }; d.append(b); }
      d.onclick = () => { if (r.id) ED.select([r.id]); };
      names.append(d);
    });
  }

  // ---------------------------------------------------------------- draw
  function diamond(x, y, r, fill, stroke) { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fillStyle = fill; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); } }
  const isSel = (kind, id, prop, kid) => ED.keySel.some(s => s.kid === kid && (s.kind === kind) && (!id || s.id === id));
  function draw() {
    const { w, h, d } = size();
    T.rows = rows();
    if (T.fit || !T.pps) { T.t0 = 0; T.pps = Math.max(10, (w - 30) / Math.max(0.5, len())); }
    g.setTransform(d, 0, 0, d, 0, 0);
    g.fillStyle = css('--panel') || '#262629'; g.fillRect(0, 0, w, h);
    const hits = (T.hits = []);
    const L = len(), fps = ED.fps();
    // work area and «after the end»
    if (ED.work) { g.fillStyle = 'rgba(77,156,255,0.08)'; g.fillRect(X(ED.work[0]), 0, X(ED.work[1]) - X(ED.work[0]), h); }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(X(L), 0, w, h);
    // rows
    g.save(); g.beginPath(); g.rect(0, RULER, w, h - RULER); g.clip();
    T.rows.forEach((r, i) => {
      const y = RULER + i * ROWH - T.sy, cy = y + ROWH / 2;
      if (y > h || y + ROWH < RULER) return;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.06)'; g.fillRect(0, y, w, ROWH);
      if (r.id && ED.sel.has(r.id) && r.kind !== 'prop') { g.fillStyle = 'rgba(77,156,255,0.10)'; g.fillRect(0, y, w, ROWH); }
      if (r.kind === 'markers') {
        for (const m of ED.doc.markers || []) {
          const x = X(m.t), sel = isSel('markers', null, null, m.id);
          g.fillStyle = sel ? '#ffffff' : '#ff9f43'; g.beginPath(); g.moveTo(x - 6, y + 3); g.lineTo(x + 6, y + 3); g.lineTo(x, y + 13); g.fill();
          g.fillStyle = '#e6e6e6'; g.font = '11px Inter, system-ui, sans-serif'; g.fillText(m.name || '', x + 8, y + 13);
          hits.push({ x, y: cy, r: 8, ref: { kind: 'markers', kid: m.id, t0: m.t } });
        }
      } else if (r.kind === 'camera') {
        const c = ED.doc.camera || {};
        for (const k of c.keys || []) { const x = X(k.t); diamond(x, cy, 6, k.t > L ? '#555' : isSel('camera', null, null, k.id) ? '#ffffff' : '#6fe0ff', isSel('camera', null, null, k.id) ? '#4d9cff' : null); hits.push({ x, y: cy, r: 7, ref: { kind: 'camera', kid: k.id, t0: k.t } }); }
        for (const ct of c.cuts || []) {
          const x = X(ct.t), sel = isSel('cuts', null, null, ct.id);
          g.strokeStyle = sel ? '#fff' : '#ff5a5f'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, h); g.stroke(); g.setLineDash([]);
          g.fillStyle = sel ? '#fff' : '#ff5a5f'; g.font = '12px system-ui'; g.fillText('✂', x - 6, cy + 4);
          hits.push({ x, y: cy, r: 8, ref: { kind: 'cuts', kid: ct.id, t0: ct.t } });
        }
      } else if (r.kind === 'thing' || r.kind === 'prop') {
        const o = find(ED.doc, r.id); if (!o) return;
        if (r.kind === 'thing') {
          // collapsed: one diamond per moment (all props), selecting it selects all of them
          const by = new Map();
          for (const { prop, key } of allKeys(o)) { const kt = +key.t.toFixed(4); if (!by.has(kt)) by.set(kt, []); by.get(kt).push({ prop, key }); }
          for (const [kt, list] of by) {
            const x = X(kt), sel = list.every(({ key }) => isSel(r.tkind, r.id, null, key.id));
            diamond(x, cy, 5.5, kt > L ? '#555' : sel ? '#ffffff' : '#ffcc33', sel ? '#4d9cff' : null);
            hits.push({ x, y: cy, r: 7, ref: list.map(({ prop, key }) => ({ kind: r.tkind, id: r.id, prop, kid: key.id, t0: key.t })) });
          }
          // ease between keys: a thin bar
        } else {
          const K = ((o.keys || {})[r.prop] || []).slice().sort((a, b) => a.t - b.t);
          g.strokeStyle = 'rgba(255,204,51,0.35)'; g.lineWidth = 2;
          for (let j = 0; j < K.length - 1; j++) { g.beginPath(); g.moveTo(X(K[j].t), cy); g.lineTo(X(K[j + 1].t), cy); if (K[j].ease === 'hold') g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]); }
          for (const k of K) {
            const x = X(k.t), sel = isSel(r.tkind, r.id, r.prop, k.id);
            diamond(x, cy, 5, k.t > L ? '#555' : sel ? '#ffffff' : k.ease === 'hold' ? '#d9a441' : '#ffcc33', sel ? '#4d9cff' : null);
            hits.push({ x, y: cy, r: 7, ref: { kind: r.tkind, id: r.id, prop: r.prop, kid: k.id, t0: k.t } });
          }
        }
      } else if (r.kind === 'sounds') {
        const cues = ED.cues || [];
        for (const s of ED.doc.sounds || []) {
          const cue = cues.find(c => c.id === s.id), b = cue && ED.audio.bufs.get(cue.url);
          const dur = (s.dur || (cue && cue.dur) || 1.2), x = X(s.t), x2 = X(s.t + dur), sel = isSel('sounds', null, null, s.id);
          g.fillStyle = sel ? 'rgba(77,156,255,0.6)' : cue ? 'rgba(91,209,139,0.45)' : 'rgba(255,90,95,0.35)'; g.fillRect(x, y + 3, Math.max(8, x2 - x), ROWH - 6);
          g.fillStyle = '#e6e6e6'; g.font = '11px Inter, system-ui, sans-serif';
          g.save(); g.beginPath(); g.rect(x, y, Math.max(8, x2 - x), ROWH); g.clip(); g.fillText((cue ? '' : '⚠ ') + (s.note || (cue && cue.name) || s.src), x + 4, y + 14); g.restore();
          hits.push({ x: x + 4, y: cy, r: 8, w: Math.max(8, x2 - x), ref: { kind: 'sounds', kid: s.id, t0: s.t } });
        }
      }
    });
    g.restore();
    // ruler
    g.fillStyle = '#202023'; g.fillRect(0, 0, w, RULER);
    const span = w / T.pps, step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find(s => s * T.pps > 50) || 60;
    g.strokeStyle = '#555'; g.fillStyle = '#9a9aa2'; g.font = '10px Inter, system-ui, sans-serif'; g.lineWidth = 1;
    for (let t = Math.ceil(T.t0 / step) * step; t < T.t0 + span; t += step) { const x = X(t); g.beginPath(); g.moveTo(x + 0.5, 12); g.lineTo(x + 0.5, RULER); g.stroke(); g.fillText(ED.fmt(t).replace(/^0:/, ''), x + 3, 10); }
    if (T.pps / fps > 6) for (let f = Math.ceil(T.t0 * fps); f / fps < T.t0 + span; f++) { const x = X(f / fps); g.beginPath(); g.moveTo(x + 0.5, 18); g.lineTo(x + 0.5, RULER); g.stroke(); }
    // cursor
    const cx = X(ED.t);
    g.strokeStyle = '#4d9cff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();
    g.fillStyle = '#4d9cff'; g.beginPath(); g.moveTo(cx - 6, 0); g.lineTo(cx + 6, 0); g.lineTo(cx + 6, 8); g.lineTo(cx, 14); g.lineTo(cx - 6, 8); g.fill();
    // box selection
    if (T.drag && T.drag.box) { const b = T.drag.box; g.strokeStyle = '#4d9cff'; g.setLineDash([4, 3]); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]); }
    $('twork').textContent = ED.work ? `область ${ED.fmt(ED.work[0])}–${ED.fmt(ED.work[1])}` : '';
    const tl = $('tlen'); if (document.activeElement !== tl) tl.value = L;
    namesDom();
  }

  // ---------------------------------------------------------------- pointer
  const at = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function hitAt(p) {
    for (let i = T.hits.length - 1; i >= 0; i--) { const hh = T.hits[i]; if (hh.w ? p.x >= hh.x - 4 && p.x <= hh.x + hh.w && Math.abs(p.y - hh.y) < 9 : Math.hypot(p.x - hh.x, p.y - hh.y) <= hh.r) return hh; }
    return null;
  }
  const refs = hh => [].concat(hh.ref);
  const selHas = r => ED.keySel.some(s => s.kid === r.kid && s.kind === r.kind);
  function snap(t, e) {
    if (e.altKey) return t;
    const fps = ED.fps();
    let best = Math.round(t * fps) / fps, bd = 1e9;
    for (const c of [ED.t, ...(ED.doc.markers || []).map(m => m.t), 0, len()]) { const d = Math.abs(X(c) - X(t)); if (d < 7 && d < bd) { bd = d; best = c; } }
    return best;
  }
  cv.addEventListener('pointerdown', e => {
    cv.focus({ preventScroll: true });
    const p = at(e);
    if (e.button === 2) return;
    if (p.y < RULER) { T.drag = { scrub: true }; cv.setPointerCapture(e.pointerId); ED.setT(snap(Tof(p.x), e)); return; }
    const hh = hitAt(p);
    if (hh) {
      const rs = refs(hh);
      if (e.shiftKey || e.ctrlKey) { for (const r of rs) { if (selHas(r)) ED.keySel = ED.keySel.filter(s => !(s.kid === r.kid && s.kind === r.kind)); else ED.keySel.push(r); } }
      else if (!rs.every(selHas)) ED.keySel = rs.slice();
      const first = rs[0];
      ED.selKey = first;
      if (first.id && first.kind !== 'markers') ED.select([first.id]);
      else if (first.kind === 'camera') ED.select(['camera']);
      T.drag = { move: true, x0: p.x, sel: ED.keySel.map(s => Object.assign({}, s, { t0: tNow(s) })), moved: false };
      cv.setPointerCapture(e.pointerId);
    } else {
      if (!e.shiftKey) ED.keySel = [];
      T.drag = { box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } };
      cv.setPointerCapture(e.pointerId);
    }
    ED.tlDirty = ED.dirty = true;
  });
  const tNow = s => {
    const d = ED.doc;
    if (s.kind === 'camera') return ((d.camera.keys || []).find(k => k.id === s.kid) || {}).t;
    if (s.kind === 'cuts') return ((d.camera.cuts || []).find(k => k.id === s.kid) || {}).t;
    if (s.kind === 'markers' || s.kind === 'sounds') return ((d[s.kind] || []).find(k => k.id === s.kid) || {}).t;
    const o = find(d, s.id); return (((o && o.keys && o.keys[s.prop]) || []).find(k => k.id === s.kid) || {}).t;
  };
  cv.addEventListener('pointermove', e => {
    const D = T.drag; if (!D) return;
    const p = at(e);
    if (D.scrub) { ED.setT(snap(Tof(p.x), e)); return; }
    if (D.box) { D.box.x1 = p.x; D.box.y1 = p.y; ED.tlDirty = true; return; }
    if (D.move) {
      const lead = D.sel[0]; if (!lead) return;
      const t = snap(lead.t0 + (p.x - D.x0) / T.pps, e), dt = t - lead.t0;
      if (!D.moved && Math.abs(p.x - D.x0) < 3) return;
      D.moved = true;
      ED.live('tlmove', () => moveKeysOps(D.sel, dt), `ключи: сдвиг на ${dt >= 0 ? '+' : ''}${dt.toFixed(2)} с`, 0);
    }
  });
  cv.addEventListener('pointerup', e => {
    const D = T.drag; T.drag = null;
    if (!D) return;
    if (D.move && D.moved) ED.liveEnd('tlmove');
    if (D.box) {
      const b = { x0: Math.min(D.box.x0, D.box.x1), x1: Math.max(D.box.x0, D.box.x1), y0: Math.min(D.box.y0, D.box.y1), y1: Math.max(D.box.y0, D.box.y1) };
      if (b.x1 - b.x0 > 3 || b.y1 - b.y0 > 3) for (const hh of T.hits) if (hh.x >= b.x0 && hh.x <= b.x1 && hh.y >= b.y0 && hh.y <= b.y1) for (const r of refs(hh)) if (!selHas(r)) ED.keySel.push(r);
    }
    ED.tlDirty = true;
  });
  cv.addEventListener('dblclick', e => {
    const hh = hitAt(at(e)); if (!hh) return;
    const r = refs(hh)[0];
    if (r.kind === 'markers') { const m = (ED.doc.markers || []).find(x => x.id === r.kid); const n = prompt('Имя маркера:', m.name || ''); if (n != null) ED.commit([{ op: 'set', path: ['markers', m.id, 'name'], value: n.trim() }], `маркер «${n.trim()}»`); return; }
    ED.setT(r.t0);
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const p = at(e);
    if (e.ctrlKey || e.metaKey) { const t = Tof(p.x); T.fit = false; T.pps = Math.max(8, Math.min(2000, T.pps * Math.exp(-e.deltaY * 0.0015))); T.t0 = Math.max(0, t - (p.x - 12) / T.pps); }
    else if (e.shiftKey) { T.fit = false; T.t0 = Math.max(0, T.t0 + e.deltaY / T.pps * 0.5); }
    else { const max = Math.max(0, T.rows.length * ROWH + RULER - cv.getBoundingClientRect().height + 10); T.sy = Math.max(0, Math.min(max, T.sy + e.deltaY * 0.5)); }
    ED.tlDirty = true;
  }, { passive: false });
  cv.addEventListener('contextmenu', e => {
    e.preventDefault();
    const hh = hitAt(at(e));
    if (hh && !refs(hh).every(selHas)) ED.keySel = refs(hh).slice();
    const S = ED.keySel;
    const items = [];
    const keysOnly = S.filter(s => !['markers', 'cuts', 'sounds'].includes(s.kind));
    if (keysOnly.length) for (const [k, label] of EASES) items.push([`кривая: ${label}`, () => setEase(keysOnly, k, label)]);
    if (S.length) items.push(['копировать (Ctrl+C)', copy], ['удалить (Delete)', delKeys]);
    if (T.clip) items.push([`вставить на курсор (${T.clip.length})`, paste]);
    if (!hh && !S.length) items.push(['+ маркер здесь', () => { ED.setT(Tof(at(e).x)); addMarker(); }], ['✂ склейка здесь', () => { ED.setT(Tof(at(e).x)); addCut(); }], ['вписать всю сцену', () => { T.fit = true; ED.tlDirty = true; }]);
    ctx(e.clientX, e.clientY, items);
    ED.tlDirty = true;
  });
  function ctx(x, y, items) {
    const m = $('menu'); m.innerHTML = ''; m.hidden = false;
    for (const [t, fn] of items) { const b = document.createElement('button'); b.textContent = t; b.setAttribute('role', 'menuitem'); b.onclick = () => { m.hidden = true; fn(); }; m.append(b); }
    m.style.left = Math.min(x, innerWidth - 220) + 'px'; m.style.top = Math.min(y, innerHeight - items.length * 28 - 10) + 'px';
    const off = ev => { if (!m.contains(ev.target)) { m.hidden = true; removeEventListener('pointerdown', off, true); } };
    setTimeout(() => addEventListener('pointerdown', off, true));
    m.onkeydown = ev => { const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement); if (ev.key === 'ArrowDown') { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); } if (ev.key === 'ArrowUp') { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); } if (ev.key === 'Escape') { m.hidden = true; cv.focus(); } };
    const b0 = m.querySelector('button'); if (b0) b0.focus();
  }
  const pathOf = s => (s.kind === 'camera' ? ['camera', 'keys', s.kid] : [s.kind, s.id, 'keys', s.prop, s.kid]);
  function setEase(S, k, label) { ED.commit(S.map(s => ({ op: 'set', path: [...pathOf(s), 'ease'], value: k })), `кривая «${label}»: ${S.length} ключ(а)`); }
  function delKeys() {
    const S = ED.keySel; if (!S.length) { ED.msg('Выдели ключи на таймлайне'); return; }
    const ops = S.map(s => s.kind === 'camera' ? { op: 'del', path: ['camera', 'keys'], id: s.kid } : s.kind === 'cuts' ? { op: 'del', path: ['camera', 'cuts'], id: s.kid }
      : s.kind === 'markers' || s.kind === 'sounds' ? { op: 'del', path: [s.kind], id: s.kid } : { op: 'del', path: [s.kind, s.id, 'keys', s.prop], id: s.kid });
    ED.commit(ops, `удалено на таймлайне: ${S.length}`);
    ED.keySel = [];
    if (S.some(s => s.kind === 'sounds')) ED.refreshCues();
  }
  function copy() {
    const S = ED.keySel.filter(s => !['markers', 'cuts', 'sounds'].includes(s.kind)); if (!S.length) return;
    const t0 = Math.min(...S.map(tNow));
    T.clip = S.map(s => {
      const k = s.kind === 'camera' ? (ED.doc.camera.keys || []).find(x => x.id === s.kid) : ((find(ED.doc, s.id).keys || {})[s.prop] || []).find(x => x.id === s.kid);
      return { kind: s.kind, id: s.id, prop: s.prop, key: Object.assign(clone(k), { t: k.t - t0 }) };
    });
    ED.msg(`Скопировано ключей: ${T.clip.length} — Ctrl+V вставит на курсор`);
  }
  function paste() {
    if (!T.clip) return;
    const ops = T.clip.map(c => {
      const item = Object.assign(clone(c.key), { id: newId(c.kind === 'camera' ? 'c' : 'k'), t: +(ED.t + c.key.t).toFixed(4) });
      return c.kind === 'camera' ? { op: 'add', path: ['camera', 'keys'], item } : { op: 'add', path: [c.kind, c.id, 'keys', c.prop], item };
    });
    ED.commit(ops, `вставлены ключи (${ops.length}) на ${ED.t.toFixed(2)} с`);
  }
  function addMarker() {
    const n = prompt(`Маркер на ${ED.t.toFixed(2)} с — имя (будущий якорь к слову голоса):`, '');
    if (n == null) return;
    ED.commit([{ op: 'add', path: ['markers'], item: { id: newId('m'), t: +ED.t.toFixed(3), name: n.trim() } }], `маркер «${n.trim()}» на ${ED.t.toFixed(2)} с`);
  }
  function addCut() {
    const c = ED.doc.camera || {};
    if ((c.cuts || []).some(x => Math.abs(x.t - ED.t) < EPS)) { ED.msg('Здесь уже склейка'); return; }
    ED.commit([{ op: 'add', path: ['camera', 'cuts'], item: { id: newId('x'), t: +ED.t.toFixed(3), name: `план ${(c.cuts || []).length + 2}` } }], `склейка камеры на ${ED.t.toFixed(2)} с`);
    ED.msg('✂ Склейка: ключи по разные стороны теперь не перетекают друг в друга. Поставь ключ камеры после склейки — это новый план.');
  }
  async function addSound() {
    const els = (ED.info.soundEls || []);
    const p = ED.popup(`<h4>🔊 Звук на ${ED.t.toFixed(2)} с</h4><p class="hint">Звуки препродакшена этой сцены или библиотека пайплайна. Нет подходящего — напиши Claude (/): «подставь звук на 1.2 с (щелчок ЭЛТ)».</p><div id="snEl"></div><div class="row" style="margin-top:8px"><input id="snQ" placeholder="🔎 библиотека: hum, click, wind…" style="flex:1"><button id="snGo">Искать</button></div><div id="snLib"></div>`);
    const box = p.querySelector('#snEl');
    const add = (src, name) => { ED.commit([{ op: 'add', path: ['sounds'], item: { id: newId('s'), t: +ED.t.toFixed(3), src, gain: 0.8, note: name } }], `звук «${name}» на ${ED.t.toFixed(2)} с`); p.hidden = true; ED.refreshCues(); };
    for (const s of els) { const b = document.createElement('button'); b.className = 'mi'; b.textContent = (s.ready ? '🔊 ' : '⚠ ') + s.name + (s.ready ? '' : ' — файл ещё не выбран в препродакшене'); b.onclick = () => add('el:' + s.id, s.name); box.append(b); }
    const lib = p.querySelector('#snLib'), inp = p.querySelector('#snQ');
    const go = async () => {
      lib.textContent = '…';
      const r = await ED.api(`/api/scene/sfxlib?key=${encodeURIComponent(ED.key)}&el=${ED.el}&q=${encodeURIComponent(inp.value)}`);
      lib.innerHTML = '';
      for (const it of r.items) {
        const row = document.createElement('div'); row.className = 'row';
        const pl = document.createElement('button'); pl.textContent = '▶'; pl.title = 'послушать'; pl.onclick = () => new Audio(`/sfxlib/${it.id}.wav`).play();
        const b = document.createElement('button'); b.className = 'mi'; b.textContent = `${it.name} · ${it.dur} с`; b.onclick = () => add('lib:' + it.id, it.name);
        row.append(pl, b); lib.append(row);
      }
      if (!r.items.length) lib.textContent = 'ничего не нашлось';
    };
    p.querySelector('#snGo').onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); e.stopPropagation(); };
    inp.focus();
  }

  new ResizeObserver(() => { ED.tlDirty = true; }).observe(cv);
  return { draw, addMarker, addCut, copy, paste, delKeys, fit() { T.fit = true; ED.tlDirty = true; } };
}
