// Анимация персонажей в редакторе (S5, docs/studio/stage5-animations.md): клипы (Tab — список движений типа скелета), свойства клипа и ключа позы,
// «✨ Claude, доведи», ручки IK на кончиках лап во вьюпорте (тянешь — ключ позы с целью IK на текущем моменте), «+ научить…».
import { find } from './keys.js';
import { newId } from './ops.js';

export function initAnim(ED) {
  const $ = id => document.getElementById(id);
  const cardOf = id => { const rec = ED.S && ED.S.objects.get(id); let c = null; if (rec) rec.holder.traverse(x => { if (!c && x.char) c = x; }); return c; };
  ED.isChar = id => !!cardOf(id);
  const typeOf = id => { const c = cardOf(id); return c && ((c.char.skel && c.char.skel.type) || c.char.skeleton); };
  const plan = ED.key.slice(5);
  const A = { list: {}, drag: null, handles: [] };
  async function anims(type) {
    if (!A.list[type]) A.list[type] = (await ED.api(`/api/anims?type=${encodeURIComponent(type)}&video=${plan}`)).items;
    return A.list[type];
  }
  async function ensure(id) {                                  // клип нужен движку: грузим его JSON
    if (RIG.anims[id] || /^gltf:/.test(id || '')) return true;          // gltf:<имя> — клип самой 3D-модели (S9), грузить нечего
    try { const r = await fetch(`/api/lib/file/video:${plan}/anims/${id}.json?v=${Date.now()}`); if (r.ok) { rigAnim(await r.json()); return true; } } catch (e) {}
    return false;
  }
  for (const o of ED.doc.objects || []) for (const c of o.clips || []) ensure(c.anim);

  // ---- Tab: клип на курсоре
  ED.clipMenu = async () => {
    const id = [...ED.sel].find(x => ED.isChar(x));
    if (!id) { ED.msg('Выбери персонажа — Tab покажет его движения'); return; }
    const o = find(ED.doc, id), type = typeOf(id), card = cardOf(id);
    const own = ((card && card.gltfClips) || []).map(n => ({ id: 'gltf:' + n, name: '🎬 ' + n + ' (из модели)', dur: (card.gltfDur || {})[n] || 1, loop: true }));   // клипы 3D-модели (S9)
    const items = own.concat(await anims(type));
    const p = ED.popup(`<h4>🎞 Движение для «${o.name}» на ${ED.t.toFixed(2)} с</h4><input id="clQ" placeholder="🔎 машет, прыжок, трёт… — ↑↓, Enter" style="width:100%"><div id="clL" class="cl-list"></div>
      <p class="hint">Клипы типа скелета «${type}» — общие для всех персонажей на нём. Нет нужного — «+ научить»: опиши словами, Claude (Opus) выучит движение и положит в библиотеку.</p>`);
    const q = p.querySelector('#clQ'), L = p.querySelector('#clL');
    let sel = 0, shown = [];
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      shown = items.filter(a => !s || (a.name + ' ' + a.id + ' ' + (a.prompt || '')).toLowerCase().includes(s));
      L.innerHTML = '';
      shown.forEach((a, i) => { const b = document.createElement('button'); b.className = 'mi' + (i === sel ? ' on' : ''); b.textContent = `${a.name} · ${a.dur} с${a.loop ? ' ↻' : ''}${a.by === 'claude' ? ' ✨' : ''}`; b.title = a.prompt || a.id; b.onclick = () => add(a); L.append(b); });
      const t = document.createElement('button'); t.className = 'mi' + (sel === shown.length ? ' on' : ''); t.textContent = '+ научить…' + (q.value.trim() ? ` «${q.value.trim()}»` : ''); t.onclick = () => teach(type, q.value.trim(), id); L.append(t);
    };
    const add = async a => {
      p.hidden = true;
      await ensure(a.id);
      ED.commit([{ op: 'add', path: ['objects', id, 'clips'], item: { id: newId('c'), t: +ED.t.toFixed(3), dur: a.proc ? 2 : a.dur, anim: a.id, speed: 1, loop: !!a.loop } }],
        `${o.name}: клип «${a.name}» на ${ED.t.toFixed(2)} с`);
    };
    q.oninput = () => { sel = 0; draw(); };
    q.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length, sel + 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (sel < shown.length) add(shown[sel]); else teach(type, q.value.trim(), id); }
      if (e.key === 'Escape') p.hidden = true;
    };
    draw(); setTimeout(() => q.focus());
  };

  // ---- «+ научить»: Claude (Opus) пишет клип типа скелета, снимает ленту кадров, смотрит, сохраняет в библиотеку
  async function teach(type, text, id) {
    const ask = text || await ED.ask(`Научить движению (тип скелета «${type}») — опиши словами`, '');
    if (!ask) return;
    const o = id && find(ED.doc, id), c = id && cardOf(id);
    try {
      const { job } = await ED.api('/api/char/teach', { type, ask, video: plan, char: c && c.char && c.char.url });
      ED.msg(`✨ Claude учит «${ask}» — 3–10 минут; клип появится в списке (Tab)`);
      for (;;) {
        await new Promise(r => setTimeout(r, 2500));
        const s = await fetch('/api/job?id=' + job.id).then(r => r.json());
        if (s.status === 'running') continue;
        if (s.status !== 'done') { ED.msg('Не выучилось: ' + (s.error || s.status), 'err'); return; }
        A.list[type] = null;
        const a = s.result || {};
        ED.msg(`✨ Выучено: «${a.name}» — ${a.dur} с. Tab — поставить.`);
        if (o && a.id && await ED.confirm(`Поставить «${a.name}» на «${o.name}» на ${ED.t.toFixed(2)} с?`, 'Поставить')) {
          await ensure(a.id);
          ED.commit([{ op: 'add', path: ['objects', id, 'clips'], item: { id: newId('c'), t: +ED.t.toFixed(3), dur: a.dur, anim: a.id, speed: 1, loop: false } }], `${o.name}: клип «${a.name}»`);
        }
        return;
      }
    } catch (e) { ED.msg('Не выучилось: ' + e.message, 'err'); }
  }
  ED.teach = teach;

  // ---- свойства клипа (двойной клик по полосе)
  ED.clipProps = (id, cid) => {
    const o = find(ED.doc, id), c = (o.clips || []).find(x => x.id === cid); if (!c) return;
    const a = RIG.anims[c.anim] || {};
    const p = ED.popup(`<h4>🎞 ${a.name || c.anim}</h4><div class="grid2"><label>начало, с</label><input id="cpT" type="number" step="0.05"><label>длина, с</label><input id="cpD" type="number" step="0.05">
      <label>скорость</label><input id="cpS" type="number" step="0.1"><label>петля</label><input id="cpL" type="checkbox"></div>
      <p class="hint">${a.prompt || ''}</p><div class="row" style="justify-content:space-between;margin-top:8px"><button id="cpDel">🗑 убрать клип</button><button id="cpOk">OK</button></div>`);
    p.querySelector('#cpT').value = c.t; p.querySelector('#cpD').value = c.dur || a.dur || 1; p.querySelector('#cpS').value = c.speed || 1; p.querySelector('#cpL').checked = !!c.loop;
    for (const i of p.querySelectorAll('input')) i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') p.querySelector('#cpOk').click(); };
    p.querySelector('#cpOk').onclick = () => {
      const v = { t: +p.querySelector('#cpT').value, dur: Math.max(0.1, +p.querySelector('#cpD').value), speed: Math.max(0.1, +p.querySelector('#cpS').value), loop: p.querySelector('#cpL').checked };
      const ops = Object.entries(v).filter(([k, x]) => x !== c[k]).map(([k, x]) => ({ op: 'set', path: ['objects', id, 'clips', cid, k], value: x }));
      p.hidden = true; if (ops.length) ED.commit(ops, `${o.name}: клип «${a.name || c.anim}» — ${Object.keys(v).filter(k => v[k] !== c[k]).join(', ')}`);
    };
    p.querySelector('#cpDel').onclick = () => { p.hidden = true; ED.commit([{ op: 'del', path: ['objects', id, 'clips'], id: cid }], `${o.name}: убран клип «${a.name || c.anim}»`); };
  };

  // ---- ключ позы: подпись, «отпустить», «✨ доведи»
  ED.poseProps = (id, kid) => {
    const o = find(ED.doc, id), k = (o.pose || []).find(x => x.id === kid); if (!k) return;
    const what = [k.ik && Object.keys(k.ik).map(b => (k.ik[b] ? `лапа ${b} → цель` : `отпустить ${b}`)).join(', '), k.bones && 'кости: ' + Object.keys(k.bones).join(', '),
      k.face && 'лицо', k.sit != null && (k.sit ? 'сидит' : 'встаёт')].filter(Boolean).join(' · ');
    const p = ED.popup(`<h4>🦴 Поза на ${k.t.toFixed(2)} с</h4><p class="hint">${what || '—'}</p><label>💬 Что здесь происходит (для Claude и для себя)</label><textarea id="ppN" rows="2" style="width:100%"></textarea>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px"><button id="ppRel" title="Через полсекунды лапы плавно вернутся из IK">↩ отпустить через 0.5 с</button><button id="ppRef" class="primary" title="Claude (агент сцены) доведёт позу: наклон тела, подход и отход, лицо — новой пачкой, её можно отменить">✨ Claude, доведи</button>
      <span style="flex:1"></span><button id="ppDel">🗑</button><button id="ppOk">OK</button></div>`);
    const N = p.querySelector('#ppN'); N.value = k.note || ''; N.onkeydown = e => e.stopPropagation();
    const saveNote = () => { const v = N.value.trim(); if (v !== (k.note || '')) ED.commit([{ op: 'set', path: ['objects', id, 'pose', kid, 'note'], value: v }], `${o.name}: подпись позы «${v}»`); };
    p.querySelector('#ppOk').onclick = () => { saveNote(); p.hidden = true; };
    p.querySelector('#ppDel').onclick = () => { p.hidden = true; ED.commit([{ op: 'del', path: ['objects', id, 'pose'], id: kid }], `${o.name}: убран ключ позы`); };
    p.querySelector('#ppRel').onclick = () => {
      p.hidden = true; const bones = Object.keys(k.ik || {}).filter(b => k.ik[b]); if (!bones.length) return;
      ED.commit([{ op: 'add', path: ['objects', id, 'pose'], item: { id: newId('p'), t: +(k.t + 0.5).toFixed(3), ik: Object.fromEntries(bones.map(b => [b, null])) } }], `${o.name}: отпустить ${bones.join(', ')} на ${(k.t + 0.5).toFixed(2)} с`);
    };
    p.querySelector('#ppRef').onclick = async () => {
      saveNote(); p.hidden = true;
      await ED.commit([{ op: 'set', path: ['objects', id, 'pose', kid, 'refine'], value: 'open' }], `${o.name}: просьба «доведи» к позе ${k.t.toFixed(2)} с`);
      ED.setT(k.t); ED.select([id]);
      ED.agent.open(`Доведи позу «${o.name}» на ${k.t.toFixed(2)} с (ключ позы ${kid}${N.value.trim() ? `: «${N.value.trim()}»` : ''}): подход и отход (ключи позы до и после), наклон тела, лицо; цель лапы оставь. Потом поставь этому ключу refine: done. `);
      setTimeout(() => $('agentForm').requestSubmit(), 50);
    };
  };

  // ---- ручки IK: кончики лап выбранного персонажа во вьюпорте
  const vp = ED.vp, cv = document.querySelector('#vp canvas'), ovl = $('ovl'), octx = ovl.getContext('2d');
  const ENDS = { hog: ['armL.end', 'armR.end'] };
  function cardPoint(c, px, py) {                             // холст карточки (px) -> мир
    const I = c.cardInfo, hc = I.hM * I.ch / I.size, wc = hc * I.cw / I.ch, fm = I.foot / I.ch * hc;
    const inner = c.inner || c; inner.updateMatrixWorld(true);
    return inner.localToWorld(new THREE.Vector3((px / I.cw - 0.5) * wc, (1 - py / I.ch) * hc - fm, 0.01));
  }
  function handles() {
    const out = [];
    if (ED.view === 'camera') return out;
    for (const id of ED.sel) {
      const c = cardOf(id); if (!c || !c.lastJoints || !c.cardInfo) continue;
      const J = c.lastJoints, bones = (c.char.rig === 'param' || c.char.skeleton === 'hog') ? ['armL', 'armR']
        : ((c.char.rigData || {}).bones || []).filter(b => !(c.char.rigData.bones || []).some(x => x.parent === b.id) && /arm|fore|hand|лап/i.test(b.id + (b.parent || ''))).map(b => b.parent).filter(Boolean);
      for (const b of bones) {
        const key = J[b + '.end'] ? b + '.end' : (() => { const ch = ((c.char.rigData || {}).bones || []).find(x => x.parent === b); return ch && J[ch.id + '.end'] ? ch.id + '.end' : null; })();
        if (!key || !J[key]) continue;
        const wp = cardPoint(c, J[key][0], J[key][1]).project(vp.cam);
        if (wp.z > 1) continue;
        const r = cv.getBoundingClientRect();
        out.push({ id, bone: b, c, x: (wp.x + 1) / 2 * r.width, y: (1 - wp.y) / 2 * r.height });
      }
    }
    return out;
  }
  const render0 = vp.render;
  vp.render = () => {
    render0();
    A.handles = handles();
    if (!A.handles.length) return;
    const dpr = vp.R.getPixelRatio();
    octx.save(); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const h of A.handles) {
      octx.beginPath(); octx.arc(h.x, h.y, 9, 0, Math.PI * 2); octx.fillStyle = A.drag && A.drag.bone === h.bone ? '#ffcc33' : 'rgba(180,140,255,0.9)'; octx.fill();
      octx.lineWidth = 2; octx.strokeStyle = '#fff'; octx.stroke();
    }
    octx.restore();
  };
  const hit = e => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return A.handles.find(h => Math.hypot(h.x - x, h.y - y) < 12); };
  function ikAt(e, c) {                                        // курсор -> плоскость карточки -> доли роста от ног (y вверх)
    const r = cv.getBoundingClientRect(), ndc = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const inner = c.inner || c; inner.updateMatrixWorld(true);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(inner.matrixWorld), o = inner.getWorldPosition(new THREE.Vector3());
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, vp.cam);
    const hitp = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), new THREE.Vector3()); if (!hitp) return null;
    const L = inner.worldToLocal(hitp), I = c.cardInfo, hc = I.hM * I.ch / I.size, wc = hc * I.cw / I.ch, fm = I.foot / I.ch * hc;
    const px = (L.x / wc + 0.5) * I.cw, py = (1 - (L.y + fm) / hc) * I.ch;
    return [+((px - I.cw / 2) / I.size).toFixed(3), +(((I.ch - I.foot) - py) / I.size).toFixed(3)];
  }
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || vp.modal) return;
    const h = hit(e); if (!h) return;
    e.stopImmediatePropagation(); e.preventDefault();
    A.drag = { id: h.id, bone: h.bone, c: h.c }; cv.setPointerCapture(e.pointerId);
  }, true);
  cv.addEventListener('pointermove', e => {
    if (!A.drag) return;
    e.stopImmediatePropagation();
    const v = ikAt(e, A.drag.c); if (!v) return;
    const { id, bone } = A.drag, t = +ED.t.toFixed(3), kid = (A.drag.kid = A.drag.kid || newId('p'));
    ED.live('ik', () => {
      const o = find(ED.doc, id), k = (o.pose || []).find(x => Math.abs(x.t - t) < 1 / 120);
      if (k) return [{ op: 'set', path: ['objects', id, 'pose', k.id, 'ik'], value: Object.assign({}, k.ik || {}, { [bone]: v }) }];
      return [{ op: 'add', path: ['objects', id, 'pose'], item: { id: kid, t, ik: { [bone]: v } } }];
    }, `${find(ED.doc, id).name}: лапа ${bone} к цели на ${t.toFixed(2)} с`, 0);
  }, true);
  const up = e => { if (!A.drag) return; e.stopImmediatePropagation(); A.drag = null; ED.liveEnd('ik'); ED.dirty = true; };
  cv.addEventListener('pointerup', up, true); cv.addEventListener('pointercancel', up, true);
  return A;
}
