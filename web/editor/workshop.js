// 🛠 Мастерская ассета (S10, docs/studio/stage10-workshop.md): служебная сцена с одним персонажем / пропсом (server/ws_api.py).
// Вкладки как режимы Setup / Animate в Spine:
//   🎞 Анимация — ключи позы на таймлайне (ручки IK на лапах, свойства позы) -> «💾 Сохранить как клип» (окно = рабочая область I/O или вся сцена)
//      -> library/anims/<тип скелета>/<slug>.json, клип сразу у всех персонажей этого типа; «📂 Клип -> ключи» — поправить готовый клип;
//      «⇋ Отразить позу» на курсоре (L↔R, как Paste Flipped в Blender).
//   🦴 Сборка — скелет, версии, «📚 в библиотеку» (ws_api.publish), карточка ассета (редактор суставов, «✨ собери / почини»).
import { find } from './keys.js';
import { newId } from './ops.js';

export function initWorkshop(ED) {
  const W = ED.info.ws, OBJ = 'asset';
  const side = document.getElementById('side');
  const box = document.createElement('section');
  box.id = 'ws'; box.setAttribute('aria-label', 'Мастерская');
  side.prepend(box);
  let tab = (sessionStorage.getItem('ws.tab') || (W.rigchar ? 'anim' : 'setup'));
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const btn = (text, title, on, cls) => { const b = el('button', cls || '', text); b.title = title || ''; b.onclick = on; return b; };
  const typeOf = () => {                                      // тип скелета ассета: из карточки персонажа на сцене
    const rec = ED.S && ED.S.objects.get(OBJ); let c = null;
    if (rec) rec.holder.traverse(x => { if (!c && x.char) c = x; });
    return (c && ((c.char.skel && c.char.skel.type) || c.char.skeleton)) || W.skeleton || 'hog';
  };
  const win = () => (ED.work ? ED.work.slice() : [0, ED.doc.len]);

  // ---- 🎞 анимация
  async function saveClip(name, loop) {
    const [t0, t1] = win();
    try {
      const r = await ED.api('/api/ws/clip', { key: ED.key, el: ED.el, obj: OBJ, name, t0, t1, loop, type: typeOf() });
      ED.msg(`💾 Клип «${name}» (${r.id}, ${r.dur} с, дорожек ${r.tracks}) — в Tab у всех персонажей типа ${typeOf()}`);
    } catch (e) { ED.msg(e.message, 'err'); }
  }
  function clipToPose(clip, t0) {                             // дорожки клипа -> ключи позы (обратное ws_api.pose_to_tracks)
    const at = new Map();
    const key = t => { const k = +(t0 + t).toFixed(4); if (!at.has(k)) at.set(k, { id: newId('p'), t: k }); return at.get(k); };
    for (const [name, list] of Object.entries(clip.tracks || {})) for (const [t, v, ease] of list) {
      const k = key(t), [a, b] = name.split('.');
      if (ease) k.ease = ease;
      if (a === 'ik') (k.ik = k.ik || {})[b] = v;
      else if (a === 'face') (k.face = k.face || {})[b] = v;
      else if (a === 'card') (k.card = k.card || {})[b] = v;
      else if (b) ((k.bones = k.bones || {})[a] = k.bones[a] || {})[b] = v;
      else k[a] = v;
    }
    return [...at.values()].sort((x, y) => x.t - y.t);
  }
  async function loadClip() {
    const type = typeOf();
    let items = [];
    try { items = (await ED.api(`/api/anims?type=${encodeURIComponent(type)}&video=${ED.key.slice(5)}`)).items || []; } catch (e) { return ED.msg(e.message, 'err'); }
    if (!items.length) return ED.msg(`У типа ${type} пока нет клипов`);
    const p = ED.popup(`<h4>📂 Клип → ключи позы (тип ${type})</h4><div id="wsClips"></div><p class="dim small">Ключи клипа встанут с курсора (${ED.t.toFixed(2)} с), прошлые ключи позы в этом окне заменятся. Поправь и «💾 Сохранить как клип» — новым или с тем же именем.</p>`);
    const L = p.querySelector('#wsClips');
    for (const it of items) L.append(btn(`${it.name} · ${it.dur || '?'} с`, it.id, async () => {
      p.hidden = true; p.innerHTML = '';
      try {
        const r = await fetch(`/api/lib/file/video:${ED.key.slice(5)}/anims/${it.id}.json?v=${Date.now()}`); const clip = await r.json();
        const keys = clipToPose(clip, ED.t), t1 = ED.t + (clip.dur || 0) + 1e-3, o = find(ED.doc, OBJ);
        const keep = (o.pose || []).filter(k => k.t < ED.t - 1e-3 || k.t > t1);
        ED.commit([{ op: 'set', path: ['objects', OBJ, 'pose'], value: keep.concat(keys).sort((a, b) => a.t - b.t) }], `клип «${clip.name}» → ключи позы с ${ED.t.toFixed(2)} с`);
        ED.work = [+ED.t.toFixed(3), +(ED.t + (clip.dur || 0)).toFixed(3)]; ED.tlDirty = true;
        nm.value = clip.name; lp.checked = !!clip.loop;
        ED.msg(`📂 «${clip.name}»: ${keys.length} ключей; рабочая область = клип`);
      } catch (e) { ED.msg(e.message, 'err'); }
    }, 'mi'));
  }
  function mirror() {                                         // отразить позу на курсоре: L↔R (кости xxxL / xxxR, цели IK), знак поворота — по пределам костей
    const o = find(ED.doc, OBJ), k = (o.pose || []).find(x => Math.abs(x.t - ED.t) < 1 / 60);
    if (!k) return ED.msg('На курсоре нет ключа позы — поставь его (ручка на лапе) или встань курсором на ключ');
    const rec = ED.S.objects.get(OBJ); let c = null; if (rec) rec.holder.traverse(x => { if (!c && x.char) c = x; });
    const bones = ((c && c.char.skel && c.char.skel.bones) || []).reduce((m, b) => (m[b.id] = b, m), {});
    const twin = n => (/L$/.test(n) ? n.slice(0, -1) + 'R' : /R$/.test(n) ? n.slice(0, -1) + 'L' : n);
    const neg = n => { const a = bones[n], b = bones[twin(n)]; return !!(a && b && a.limits && b.limits && Math.abs(a.limits[0] + b.limits[1]) < 0.05 && Math.abs(a.limits[1] + b.limits[0]) < 0.05); };
    const out = JSON.parse(JSON.stringify(k));
    if (k.bones) { out.bones = {}; for (const [n, ch] of Object.entries(k.bones)) { const m = Object.assign({}, ch); if (neg(n) && typeof m.rot === 'number') m.rot = -m.rot; out.bones[twin(n)] = m; } }
    if (k.ik) { out.ik = {}; for (const [n, v] of Object.entries(k.ik)) out.ik[twin(n)] = Array.isArray(v) ? [-v[0], v[1]] : v; }
    if (k.face && Array.isArray(k.face.look)) out.face = Object.assign({}, k.face, { look: [-k.face.look[0], k.face.look[1]] });
    ED.commit([{ op: 'set', path: ['objects', OBJ, 'pose', k.id], value: out }], `отразить позу на ${ED.t.toFixed(2)} с (L↔R)`);
  }
  const nm = el('input'); nm.placeholder = 'имя клипа: «машет трубкой»'; nm.style.width = '100%';
  const lp = el('input'); lp.type = 'checkbox';

  // ---- отрисовка
  function draw() {
    box.innerHTML = '';
    const head = el('div', 'phead'); head.append(el('b', '', '🛠 ' + W.name), el('span', 'dim small', ` v${W.v || '?'}${W.lib ? ` · из библиотеки ${W.lib.id}@${W.lib.v}` : ''}`));
    const seg = el('div', 'seg ws-tabs');
    for (const [k, l] of [['anim', '🎞 Анимация'], ['setup', '🦴 Сборка']]) { const b = btn(l, '', () => { tab = k; sessionStorage.setItem('ws.tab', k); draw(); }); if (tab === k) b.className = 'sel'; seg.append(b); }
    box.append(head, seg);
    const body = el('div', 'ws-body'); box.append(body);
    if (tab === 'anim') {
      if (!W.rigchar) { body.append(el('p', 'dim small', 'У пропса анимация — ключами объекта (сдвиг, поворот, видимость) и его параметрами; каналы (экран, индикаторы) — S10.3.')); return; }
      const [t0, t1] = win();
      body.append(el('p', 'dim small', 'Ключи позы: ручки на кончиках лап (IK), поворот костей и лицо — в свойствах ключа (клик по ромбу «поза»). Tab — готовые движения. I / O на таймлайне — окно клипа.'));
      const row = el('div', 'row'); row.append(nm);
      const lb = el('label', 'small'); lb.append(lp, document.createTextNode(' петля'));
      body.append(row, lb,
        btn(`💾 Сохранить как клип (${t0.toFixed(2)}–${t1.toFixed(2)} с)`, 'Ключи позы в окне → клип библиотеки (тип скелета ' + typeOf() + ') — сразу у всех персонажей этого типа', () => {
          const n = nm.value.trim(); if (!n) { nm.focus(); return ED.msg('Назови клип', 'err'); } saveClip(n, lp.checked);
        }, 'primary'),
        btn('📂 Клип → ключи', 'Открыть готовый клип ключами позы — поправить и сохранить', loadClip),
        btn('⇋ Отразить позу', 'Ключ позы на курсоре: левое ↔ правое (кости и цели лап, взгляд)', mirror));
    } else {
      body.append(el('p', 'small', W.rigchar ? `Скелет: ${W.skeleton || '—'}${W.model3d ? ' · 3D-модель' : ''}` : '3D-пропс'),
        el('p', 'dim small', 'Суставы, части, пределы, «✨ собери / почини скелет», версии — в карточке ассета. Новая версия ассета сама появится здесь при следующем открытии мастерской.'),
        btn('↗ Карточка: скелет, версии', 'Открыть карточку ассета — редактор суставов, «✨ Claude, поправь», версии', () => parent.postMessage({ type: 'editor-close', el: ED.el, ws: Object.assign({}, W, { lib: null }) }, location.origin)),
        btn('📚 В библиотеку', W.lib ? `Новая версия ${W.lib.id} (сцены держат свою @N, основной станет новая)` : 'Опубликовать ассет в библиотеку канала', async () => {
          try { const r = await ED.api('/api/ws/publish', { key: ED.key, asset: W.asset }); ED.msg('📚 ' + r.summary); } catch (e) { ED.msg(e.message, 'err'); }
        }, 'primary'));
    }
  }
  draw();
  let wk = JSON.stringify(win());
  setInterval(() => { const n = JSON.stringify(win()); if (n !== wk) { wk = n; if (tab === 'anim' && document.activeElement !== nm) draw(); } }, 400);   // окно I/O поменяли на таймлайне — подпись кнопки
  ED.workshop = { draw };
}
