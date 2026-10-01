// 🛠 Мастерская ассета (S10, docs/studio/stage10-workshop.md): служебная сцена с одним персонажем / пропсом (server/ws_api.py).
// Вкладки как режимы Setup / Animate в Spine:
//   🎞 Анимация — ключи позы на таймлайне (ручки IK на лапах, свойства позы) -> «💾 Сохранить как клип» (окно = рабочая область I/O или вся сцена)
//      -> library/anims/<тип скелета>/<slug>.json, клип сразу у всех персонажей этого типа; «📂 Клип -> ключи» — поправить готовый клип;
//      «⇋ Отразить позу» на курсоре (L↔R, как Paste Flipped в Blender).
//   ✋ Предметы (S10.2) — что в руке и как держит (хват: место в кисти, поворот, масштаб, поза руки) -> grips.json версии,
//      как вложение (attachment) на кости в Spine / Child Of в Blender; в сценах — keys["hold.handR"] = предмет.
//   🦴 Сборка — скелет, версии, «📚 в библиотеку» (ws_api.publish), карточка ассета (редактор суставов, «✨ собери / почини»).
import { find } from './keys.js';
import { newId } from './ops.js';

export function initWorkshop(ED) {
  const W = ED.info.ws, OBJ = 'asset';
  const side = document.getElementById('side');
  const box = document.createElement('section');
  box.id = 'ws'; box.setAttribute('aria-label', 'Мастерская');
  side.prepend(box);
  const TABS = W.rigchar ? [['anim', '🎞 Анимация'], ['hold', '✋ Предметы'], ['setup', '🦴 Сборка']] : [['live', '📺 Живое'], ['setup', '🦴 Сборка']];
  let tab = sessionStorage.getItem('ws.tab');
  if (!TABS.some(x => x[0] === tab)) tab = TABS[0][0];
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
  // 👻 калька (onion skin, как в Toon Boom / Spine): позы t − Δ (голубая) и t + Δ (оранжевая) — полупрозрачно поверх 3D-вида, в рамке карточки персонажа
  const ON = { on: false, d: 0.2, cv: null, off: null };
  const mainCard = () => { const rec = ED.S && ED.S.objects.get(OBJ); let c = null; if (rec) rec.holder.traverse(x => { if (!c && x.char) c = x; }); return c; };
  function onionSet(on) {
    ON.on = on;
    if (!ON.cv) {
      ON.cv = document.createElement('canvas'); ON.cv.id = 'onion';
      Object.assign(ON.cv.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 3 });
      document.getElementById('vp').append(ON.cv);
      ON.off = document.createElement('canvas');
    }
    ON.cv.hidden = !on;
  }
  function cardRect(c) {                                      // экранная рамка плоскости карточки (самая большая плоскость внутри неё)
    let mesh = null, best = 0;
    const up = new THREE.Vector3();
    c.traverse(x => {                                          // вертикальная плоскость с картинкой (тень карточки лежит на полу — её пропускаем)
      if (!(x.isMesh && x.geometry && x.geometry.parameters && x.geometry.parameters.width)) return;
      up.set(0, 0, 1).transformDirection(x.matrixWorld);
      if (Math.abs(up.y) > 0.5) return;
      const a = x.geometry.parameters.width * x.geometry.parameters.height; if (a > best) { best = a; mesh = x; }
    });
    if (!mesh) return null;
    const cam = ED.view === 'camera' ? ED.S.w.cam : ED.vp.cam, R = ED.vp.R;
    if (!cam || !R) return null;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox, el = R.domElement, pts = [];          // геометрия карточки сдвинута (низ у пола) — рамка по bounding box
    for (const [x, y] of [[bb.min.x, bb.min.y], [bb.max.x, bb.min.y], [bb.max.x, bb.max.y], [bb.min.x, bb.max.y]]) {
      const v = new THREE.Vector3(x, y, 0).applyMatrix4(mesh.matrixWorld).project(cam);
      pts.push([(v.x + 1) / 2 * el.clientWidth, (1 - v.y) / 2 * el.clientHeight]);
    }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), flip: pts[1][0] < pts[0][0] };
  }
  (function onionTick() {
    const c = ON.on && mainCard();
    if (c && c.cardInfo && ON.cv) {
      const vp = document.getElementById('vp'), dpr = devicePixelRatio || 1, cv = ON.cv;
      if (cv.width !== vp.clientWidth * dpr || cv.height !== vp.clientHeight * dpr) { cv.width = vp.clientWidth * dpr; cv.height = vp.clientHeight * dpr; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
      const r = cardRect(c), I = c.cardInfo;
      ON.cur = ON.cur || document.createElement('canvas');                   // текущая поза — маска: где поза не изменилась, калька почти не видна
      ON.cur.width = I.cw; ON.cur.height = I.ch;
      const cc = ON.cur.getContext('2d'); cc.clearRect(0, 0, I.cw, I.ch);
      try { rigDraw(cc, c.char, c.scenePose(ED.t), I.cw / 2, I.ch - I.foot, I.size, ED.t); } catch (e) {}
      if (r) for (const [sgn, col] of [[-1, '#6fe0ff'], [1, '#ffa060']]) {
        const t = Math.max(0, Math.min(ED.doc.len, ED.t + sgn * ON.d)), off = ON.off;
        off.width = I.cw; off.height = I.ch;
        const o = off.getContext('2d'); o.clearRect(0, 0, I.cw, I.ch);
        try { rigDraw(o, c.char, c.scenePose(t), I.cw / 2, I.ch - I.foot, I.size, t); } catch (e) { continue; }
        o.globalCompositeOperation = 'source-atop'; o.fillStyle = col; o.globalAlpha = 0.55; o.fillRect(0, 0, I.cw, I.ch);
        o.globalCompositeOperation = 'destination-out'; o.globalAlpha = 0.85; o.drawImage(ON.cur, 0, 0);
        o.globalAlpha = 1; o.globalCompositeOperation = 'source-over';
        g.save(); g.globalAlpha = 0.6;
        if (r.flip) { g.translate(r.x + r.w, r.y); g.scale(-1, 1); g.drawImage(off, 0, 0, r.w, r.h); } else g.drawImage(off, r.x, r.y, r.w, r.h);
        g.restore();
      }
    }
    requestAnimationFrame(onionTick);
  })();

  // ✋ предметы: хват живьём правится в char.grips (страница), «💾» пишет grips.json рабочей версии ассета
  let GR = null, gSlot = sessionStorage.getItem('ws.slot') || 'handR';
  const charOf = () => { const rec = ED.S && ED.S.objects.get(OBJ); let c = null; if (rec) rec.holder.traverse(x => { if (!c && x.char) c = x; }); return c; };
  const gKey = ref => (typeof rigGripKey === 'function' ? rigGripKey(ref) : ref);
  const heldRef = () => { const o = find(ED.doc, OBJ); return o ? ((typeof sceneHoldAt === 'function' ? sceneHoldAt(o, gSlot, ED.t) : (o.hold || {})[gSlot]) || null) : null; };
  async function gripsLoad() {
    try { GR = (await ED.api('/api/ws/grips', { key: ED.key, asset: W.asset })).grips || {}; } catch (e) { GR = {}; ED.msg(e.message, 'err'); }
    gripsLive(); draw();
  }
  function gripsLive() { const c = charOf(); if (c && c.char) c.char.grips = JSON.parse(JSON.stringify(GR || {})); ED.dirty = true; }
  async function giveProp(ref) {                              // в мастерской предмет в руке — всё время (o.hold); в сценах — ключами hold.<рука>
    if (ref && ED.lib && !ED.lib[ref] && ED.loadProp && !(await ED.loadProp(ref))) return ED.msg('Предмет не загрузился: ' + ref, 'err');
    const o = find(ED.doc, OBJ), h = Object.assign({}, o.hold || {});
    if (ref) h[gSlot] = ref; else delete h[gSlot];
    ED.commit([{ op: 'set', path: ['objects', OBJ, 'hold'], value: h }], ref ? `в руку (${gSlot}): ${ref}` : `убрать из руки (${gSlot})`);
    if (ref && !GR[gKey(ref)]) { GR[gKey(ref)] = { off: [0, -0.1], rot: 0, scale: 1 }; gripsLive(); }
    setTimeout(draw, 50);
  }
  function gripPoseFromCursor() {                             // поза руки при хвате = ключи позы на курсоре (кости, цели лап, лицо) поверх прошлой
    const ref = heldRef(), c = charOf(); if (!ref || !c) return;
    const k = gKey(ref), g = GR[k] = GR[k] || {};
    const L = c.keyLayer ? c.keyLayer(ED.t) : {}, pose = {};
    for (const f of ['bones', 'ik', 'face']) if (L[f] && Object.keys(L[f]).length) pose[f] = L[f];
    if (!Object.keys(pose).length) return ED.msg('На курсоре нет позы из ключей: поставь лапу ручкой IK (или поверни кость в свойствах ключа), потом жми снова', 'err');
    g.pose = typeof rigPose === 'function' ? rigPose(g.pose || {}, pose) : pose;
    gripsLive(); draw();
    ED.msg('📌 Поза руки — в хвате. Ключи позы этого кадра больше не нужны: удали их, хват сам поднимет лапу, когда предмет в руке');
  }
  function gripBox() {
    const wrap = el('div', 'ws-grip');
    if (!W.rigchar) { wrap.append(el('p', 'dim small', 'Предметы в руках — у персонажей со скелетом.')); return wrap; }
    if (!GR) { gripsLoad(); wrap.append(el('p', 'dim small', 'загружаю хваты…')); return wrap; }
    const seg = el('div', 'seg ws-tabs');
    for (const [k, l] of [['handR', '✋ правая'], ['handL', '🤚 левая']]) { const b = btn(l, 'рука (слот) персонажа', () => { gSlot = k; sessionStorage.setItem('ws.slot', k); draw(); }); if (gSlot === k) b.className = 'sel'; seg.append(b); }
    wrap.append(seg);
    const ref = heldRef(), P3 = ED.info.props3d || [], cur = P3.find(x => x.ref === ref);
    wrap.append(el('p', 'small', ref ? `В руке: ${cur ? cur.name : ref}` : 'Рука пустая — выбери предмет:'));
    const list = el('div', 'ws-props');
    for (const x of P3) {
      const b = btn('', `${x.name} · ${x.from} · ${x.ref}`, () => giveProp(x.ref === ref ? null : x.ref), 'mi' + (x.ref === ref ? ' on' : ''));
      if (x.img) { const im = el('img'); im.src = x.img; im.alt = ''; b.append(im); }
      b.append(el('span', '', x.name)); list.append(b);
    }
    if (!P3.length) list.append(el('p', 'dim small', 'Нет 3D-пропсов: сделай пропс в препродакшене (🖥 TRELLIS / ✨) или возьми из библиотеки.'));
    wrap.append(list);
    if (!ref) return wrap;
    const k = gKey(ref), g = GR[k] = GR[k] || {};
    const slider = (label, title, min, max, step, get, set) => {
      const row = el('label', 'ws-sl small'), r = el('input'), v = el('span', 'dim');
      r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get(); v.textContent = (+get()).toFixed(2); r.title = title;
      r.oninput = () => { set(+r.value); v.textContent = (+r.value).toFixed(2); gripsLive(); };
      row.append(el('span', '', label), r, v); return row;
    };
    const off = () => (g.off = g.off || [0, 0]);
    const chk = (label, title, get, set) => { const l = el('label', 'small'), c = el('input'); c.type = 'checkbox'; c.checked = get(); c.onchange = () => { set(c.checked); gripsLive(); }; l.title = title; l.append(c, document.createTextNode(' ' + label)); return l; };
    wrap.append(
      slider('↔ поперёк', 'сдвиг поперёк предмета (доли роста персонажа)', -0.4, 0.4, 0.005, () => off()[0] || 0, v => { off()[0] = v; }),
      slider('↕ вдоль', 'сдвиг вдоль предмета: −0.1 — кисть выше нижнего края на 10% роста', -0.4, 0.4, 0.005, () => off()[1] || 0, v => { off()[1] = v; }),
      slider('⟳ поворот', 'поворот предмета в кисти, рад', -3.14, 3.14, 0.01, () => g.rot || 0, v => { g.rot = v; }),
      slider('⤢ размер', 'масштаб предмета в руке', 0.2, 3, 0.01, () => g.scale || 1, v => { g.scale = v; }),
      chk('вслед за предплечьем', 'предмет поворачивается вместе с лапой (выкл. — держит ровно, как трубку у уха)', () => g.follow !== false, v => { if (v) delete g.follow; else g.follow = false; }),
      chk('за лапой', 'предмет позади карточки (выкл. — поверх лапы)', () => !!g.back, v => { if (v) g.back = true; else delete g.back; }),
      el('p', 'dim small', g.pose ? 'Поза руки при хвате: ' + Object.entries(g.pose).map(([a, b]) => a + ': ' + Object.keys(b).join(', ')).join(' · ') : 'Поза руки не задана — лапа как в сцене.'),
      btn('📌 Поза руки = поза на курсоре', 'Поставь лапу ручкой IK / поверни кость (ключ позы) — и забери её в хват: теперь персонаж сам так держит этот предмет в любой сцене', gripPoseFromCursor),
      btn('🗑 без позы руки', 'Хват только ставит предмет в кисть, поза — из сцены', () => { delete g.pose; gripsLive(); draw(); }),
      btn('💾 Сохранить хват', 'grips.json рабочей версии персонажа; в библиотеку — «📚 В библиотеку» на вкладке «Сборка»', async () => {
        try { const r = await ED.api('/api/ws/grips', { key: ED.key, asset: W.asset, grips: GR }); ED.msg(`💾 Хваты сохранены (${r.n}) у v${r.v}. В сцене: ключ «hold.${gSlot}» = предмет — возьмёт так же`); } catch (e) { ED.msg(e.message, 'err'); }
      }, 'primary'));
    return wrap;
  }

  // 🦴 сборка: риг частей — редактор суставов (stands/skel.html) прямо здесь; 3D-модель — карта костей «наша ← модели» с осью и знаком
  let SU = null;
  async function setupLoad() { try { SU = await ED.api('/api/ws/setup', { key: ED.key, asset: W.asset }); } catch (e) { SU = { err: e.message }; } draw(); }
  async function afterNewVersion(msg) {                     // новая версия ассета: объект мастерской переключить на неё и перезагрузить страницу
    try { await ED.api('/api/ws/open', { src: 'el:' + W.asset, key: ED.key }); ED.reloadPage(msg); } catch (e) { ED.msg(e.message, 'err'); }
  }
  function jointEditor() {
    const src = `/render/skel.html?char=${encodeURIComponent(SU.prefab)}&key=${encodeURIComponent(ED.key)}&el=${SU.el}&base=${SU.rid}`;
    const p = ED.popup(`<h4>🦴 Суставы · ${W.name} v${SU.v}</h4><iframe src="${src}" style="width:min(1100px,88vw);height:72vh;border:0;border-radius:6px;background:#ece6da"></iframe><p class="dim small">Тяни суставы мышью, проверяй позами. «💾 Сохранить» — новая версия; мастерская переключится на неё сама.</p>`);
    p.style.maxWidth = 'none';
    const onMsg = async ev => {
      if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'skel-saved') return;
      removeEventListener('message', onMsg); p.hidden = true; p.innerHTML = '';
      ED.msg('🦴 Сохраняю скелет — новая версия через полминуты…');
      const id = ev.data.job && ev.data.job.id;
      for (let i = 0; id && i < 120; i++) { await new Promise(r => setTimeout(r, 1500)); const j = await ED.api('/api/job?id=' + id).catch(() => null); if (j && j.status !== 'running') { if (j.status !== 'done') return ED.msg(j.error || j.status, 'err'); break; } }
      afterNewVersion('скелет сохранён');
    };
    addEventListener('message', onMsg);
  }
  function boneTable() {
    const wrap = el('div', 'ws-bones'), M = JSON.parse(JSON.stringify(SU.map || {}));
    const tb = el('table', 'grid small');
    const sel = (opts, v, on) => { const x = el('select'); for (const o of opts) { const op = el('option', '', o === '' ? '—' : o); op.value = o; if (o === v) op.selected = true; x.append(op); } x.onchange = () => on(x.value); return x; };
    for (const b of SU.ours) {
      const m = M[b] || {}, tr = el('tr');
      const td = (...xs) => { const c = el('td'); c.append(...xs); return c; };
      tr.append(td(el('b', '', b)),
        td(sel([''].concat(SU.bones), m.bone || '', v => { if (v) M[b] = Object.assign({ axis: 'x', k: 1 }, M[b] || {}, { bone: v }); else delete M[b]; })),
        td(sel(['x', 'y', 'z'], m.axis || 'x', v => { if (M[b]) M[b].axis = v; })),
        td(sel(['1', '-1'], String(m.k == null ? 1 : (m.k < 0 ? -1 : 1)), v => { if (M[b]) M[b].k = +v; })));
      tb.append(tr);
    }
    wrap.append(el('p', 'dim small', 'Наша кость ← кость модели, ось поворота и знак. Проверка — кадры «руки вверх» и «шаг» новой версии (карточка ассета) и ручки на лапах здесь.'), tb,
      btn('💾 Сохранить карту (новая версия)', 'Та же модель, новый prefab.js; кадры поворотного стола и поз переснимутся', async () => {
        ED.msg('💾 Сохраняю карту костей — новая версия, кадры…');
        try { const r = await ED.api('/api/ws/bonemap', { key: ED.key, asset: W.asset, map: M }); afterNewVersion(`карта костей v${r.v}`); } catch (e) { ED.msg(e.message, 'err'); }
      }, 'primary'));
    return wrap;
  }

  const nm = el('input'); nm.placeholder = 'имя клипа: «машет трубкой»'; nm.style.width = '100%';
  const lp = el('input'); lp.type = 'checkbox';

  // ---- отрисовка
  function draw() {
    box.innerHTML = '';
    const head = el('div', 'phead'); head.append(el('b', '', '🛠 ' + W.name), el('span', 'dim small', ` v${W.v || '?'}${W.lib ? ` · из библиотеки ${W.lib.id}@${W.lib.v}` : ''}`));
    const seg = el('div', 'seg ws-tabs');
    for (const [k, l] of TABS) { const b = btn(l, '', () => { tab = k; sessionStorage.setItem('ws.tab', k); draw(); }); if (tab === k) b.className = 'sel'; seg.append(b); }
    box.append(head, seg);
    const body = el('div', 'ws-body'); box.append(body);
    if (tab === 'anim') {
      if (!W.rigchar) return;
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
      const on = el('label', 'small'), cb = el('input'); cb.type = 'checkbox'; cb.checked = ON.on; cb.onchange = () => onionSet(cb.checked);
      const dd = el('input'); dd.type = 'number'; dd.step = '0.05'; dd.min = '0.03'; dd.value = ON.d; dd.style.width = '60px'; dd.oninput = () => { ON.d = Math.max(0.03, +dd.value || 0.2); };
      on.append(cb, document.createTextNode(' 👻 калька ±'), dd, document.createTextNode(' с (голубая — раньше, оранжевая — позже)'));
      if (!W.model3d) body.append(on);
    } else if (tab === 'live') {                          // S10.3: живые части пропса — каналы префаба (экран, индикатор, курсор)
      const pf = ED.lib && ED.lib[((find(ED.doc, OBJ) || {}).src || {}).prefab], chs = (pf && pf.channels) || null;
      if (!chs) body.append(el('p', 'small', 'У этого пропса нет живых частей (channels в prefab.js). Попроси агента: «сделай экран живым» — он добавит каналы новой версией.'));
      else {
        body.append(el('p', 'small', 'Живые части: ' + Object.entries(chs).map(([n, c]) => `${n} (${c.kind})`).join(', ')),
          el('p', 'dim small', 'Ключи — в свойствах предмета, блок «📺 Живые части» (ставятся на курсоре), строки ch.* на таймлайне. Экран: программа или видео кадрами из библиотеки канала.'),
          btn('🎯 Выбрать предмет', 'Показать блок «📺 Живые части» в свойствах', () => { ED.select([OBJ], OBJ); ED.uiDirty = true; }),
          btn('🎞 + видео по ссылке…', 'YouTube / файл → кадры в библиотеку канала (кусок «с / по»)', () => ED.addMedia && ED.addMedia()));
        const L = ED.info.media || [];
        body.append(el('p', 'dim small', L.length ? 'Видео канала: ' + L.map(m => `«${m.name}» ${m.dur} с`).join(' · ') : 'Видео в библиотеке канала пока нет.'));
      }
    } else if (tab === 'hold') {
      body.append(gripBox());
    } else {
      if (W.rigchar && !SU) { setupLoad(); body.append(el('p', 'dim small', 'загружаю скелет…')); return; }
      if (SU && SU.err) body.append(el('p', 'small', '⚠ ' + SU.err));
      if (SU && SU.rig === 'parts') body.append(btn('🦴 Суставы и части', 'Редактор скелета: суставы мышью, пределы, проверочные позы — сохраняется новой версией', jointEditor, 'primary'));
      if (SU && SU.rig === 'param') body.append(el('p', 'dim small', 'Скелет ёжика параметрический (лапы, ноги, голова, лицо — параметрами): суставы не двигаются, позы и анимации — во вкладке «🎞 Анимация».'));
      if (SU && SU.rig === 'model') body.append(boneTable());
      body.append(el('p', 'small', W.rigchar ? `Скелет: ${(SU && SU.skeleton) || W.skeleton || '—'}${W.model3d ? ' · 3D-модель' : ''} · v${(SU && SU.v) || W.v}` : '3D-пропс'),
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
