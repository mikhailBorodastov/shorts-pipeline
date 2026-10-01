// 3D-вид редактора: свободная камера (как в Blender), мини-вид «глазами камеры» 9:16, вид камеры (0 или Numpad 0) с безопасными зонами,
// выбор кликом, гизмо TransformControls, модальные G / R / S, путь камеры и рамки кадра на ключах.
// Один WebGLRenderer (X3.R из stage3d.js), два вьюпорта: свободный вид — прямой рендер (быстро, без пост-эффектов),
// кадр камеры — через цепочку пост-эффектов сцены (как в ролике) в свой прямоугольник.
import { TransformControls } from '/tpl/vendor/TransformControls.js';
import { find, kindOf, setOps, valueAt, camKeyOps } from './keys.js';

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const DEG = Math.PI / 180;
export const SAFE = { captions: [1400, 1540], plate: [170, 250], side: 60, right: 150, bottom: 1640 };

export function initViewport(ED) {
  const R = X3.R, w = ED.w, box = document.getElementById('vp'), ovl = document.getElementById('ovl'), octx = ovl.getContext('2d');
  const cv = R.domElement;
  cv.className = 'gl'; cv.tabIndex = 0; cv.setAttribute('aria-label', '3D-вид сцены: клик — выбрать, G R S — двигать, крутить, масштаб');
  box.prepend(cv);
  R.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const cam = new THREE.PerspectiveCamera(ED.doc.camera && ED.doc.camera.fov || 50, 1, 0.02, 300);
  const orbit = { tgt: new THREE.Vector3(0, 1, 0), yaw: 0, pitch: 0.2, dist: 5 };
  const VP = { R, cam, orbit, size: { w: 1, h: 1 }, frame: null, mini: null, compSize: '', helpers: new THREE.Group(), modal: null };
  ED.vp = VP;
  VP.helpers.name = 'editor-helpers';
  w.scene.add(VP.helpers);

  // ---------------------------------------------------------------- the free camera
  function place() {
    const cp = Math.cos(orbit.pitch);
    cam.position.set(orbit.tgt.x + orbit.dist * cp * Math.sin(orbit.yaw), orbit.tgt.y + orbit.dist * Math.sin(orbit.pitch), orbit.tgt.z + orbit.dist * cp * Math.cos(orbit.yaw));
    cam.lookAt(orbit.tgt);
    cam.updateMatrixWorld();
  }
  function fromScene() {                                  // the free camera starts where the scene camera is now
    const p = w.cam.position.clone(), t = w.target.clone(), d = p.clone().sub(t);
    orbit.tgt.copy(t); orbit.dist = Math.max(0.3, d.length());
    orbit.yaw = Math.atan2(d.x, d.z); orbit.pitch = Math.asin(Math.max(-1, Math.min(1, d.y / orbit.dist)));
    cam.fov = w.cam.fov; cam.updateProjectionMatrix(); place();
  }
  VP.fromScene = fromScene; VP.place = place;

  function resize() {
    const r = box.getBoundingClientRect();
    VP.size = { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
    R.setSize(VP.size.w, VP.size.h, false);
    const dpr = R.getPixelRatio();
    ovl.width = Math.round(VP.size.w * dpr); ovl.height = Math.round(VP.size.h * dpr);
    cam.aspect = VP.size.w / VP.size.h; cam.updateProjectionMatrix();
    VP.compSize = '';
    ED.dirty = true;
  }
  new ResizeObserver(resize).observe(box);

  // the 9:16 frame inside the view: whole height (camera view) or a corner (mini view)
  function frameRect(mini) {
    const { w: vw, h: vh } = VP.size;
    if (!mini) { const h = vh - 16, fw = Math.round(h * 9 / 16); return { x: Math.round((vw - fw) / 2), y: 8, w: fw, h }; }
    const h = Math.round(Math.min(vh * 0.42, 360)), fw = Math.round(h * 9 / 16);
    return { x: vw - fw - 10, y: 10, w: fw, h };
  }
  // the post chain of the scene sized to a rect (postprocessing's setSize resizes the renderer too — put it back)
  function compTo(r) {
    const k = r.w + 'x' + r.h;
    if (VP.compSize !== k) { w.comp.setSize(r.w, r.h, false); R.setSize(VP.size.w, VP.size.h, false); VP.compSize = k; }
  }
  function renderFrame(r) {
    const hv = VP.helpers.visible, gv = tc.getHelper().visible;
    VP.helpers.visible = false; tc.getHelper().visible = false;
    compTo(r);
    const y = VP.size.h - r.y - r.h;                     // GL viewport is bottom-up
    R.setViewport(r.x, y, r.w, r.h); R.setScissor(r.x, y, r.w, r.h); R.setScissorTest(true);
    w.comp.render(1 / 60);
    R.setScissorTest(false);
    VP.helpers.visible = hv; tc.getHelper().visible = gv;
  }

  // ---------------------------------------------------------------- helpers: selection boxes, lights, camera path and frames
  const boxes = new Map();
  const lightMat = new THREE.MeshBasicMaterial({ color: '#ffcc33', wireframe: true, depthTest: false, transparent: true, opacity: 0.8 });
  const lightGeo = new THREE.OctahedronGeometry(0.05);
  const lightMarks = new Map();
  const camGroup = new THREE.Group(); VP.helpers.add(camGroup);
  const camProxy = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 4), new THREE.MeshBasicMaterial({ color: '#6fe0ff', wireframe: true, depthTest: false }));
  camProxy.userData.pick = 'camera'; camProxy.rotation.order = 'YXZ';
  const tgtProxy = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: '#6fe0ff', wireframe: true, depthTest: false }));
  tgtProxy.userData.pick = 'camera:target';
  VP.helpers.add(camProxy, tgtProxy);
  let camSig = '';
  function camLines() {
    const c = ED.doc.camera || {}, sig = JSON.stringify([c.keys, c.cuts, ED.selKey]);
    if (sig === camSig) return;
    camSig = sig;
    camGroup.clear();
    const keys = (c.keys || []).slice().sort((a, b) => a.t - b.t);
    if (keys.length > 1) {
      // path: solid inside a shot, a gap across a cut
      const cuts = (c.cuts || []).map(x => x.t);
      const pts = [];
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        if (cuts.some(ct => ct > a.t && ct <= b.t)) continue;
        pts.push(V3(a.pos), V3(b.pos));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      camGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#6fe0ff', depthTest: false, transparent: true, opacity: 0.8 })));
    }
    for (const k of keys) {                                // a small 9:16 frame at every key, big for the selected one
      const big = ED.selKey && ED.selKey.kind === 'camera' && ED.selKey.kid === k.id;
      const d = big ? 0.45 : 0.2, fov = (k.fov || c.fov || 30) * DEG, hh = d * Math.tan(fov / 2), hw = hh * 9 / 16;
      const m = new THREE.Matrix4().lookAt(V3(k.pos), V3(k.target), new THREE.Vector3(0, 1, 0));
      const corner = (x, y) => new THREE.Vector3(x, y, -d).applyMatrix4(m).add(V3(k.pos));
      const A = corner(-hw, hh), B = corner(hw, hh), C = corner(hw, -hh), D = corner(-hw, -hh), P = V3(k.pos);
      const g = new THREE.BufferGeometry().setFromPoints([A, B, B, C, C, D, D, A, P, A, P, B, P, C, P, D]);
      camGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: big ? '#ffffff' : '#6fe0ff', depthTest: false, transparent: true, opacity: big ? 1 : 0.6 })));
    }
  }
  function syncHelpers() {
    const S = ED.S;
    for (const [id, b] of boxes) if (!ED.sel.has(id) || !S.objects.has(id)) { b.removeFromParent(); boxes.delete(id); }
    for (const id of ED.sel) {
      const rec = S.objects.get(id);
      if (!rec) continue;
      let b = boxes.get(id);
      if (!b) { b = new THREE.BoxHelper(rec.holder, id === ED.active ? '#4d9cff' : '#7fb6ff'); b.material.depthTest = false; b.material.transparent = true; VP.helpers.add(b); boxes.set(id, b); }
      b.material.color.set(id === ED.active ? '#4d9cff' : '#2f6fb8');
      b.setFromObject(rec.holder);
    }
    for (const [id, m] of lightMarks) if (!S.lights.has(id)) { m.removeFromParent(); lightMarks.delete(id); }
    for (const [id, rec] of S.lights) {
      if (rec.type === 'ambient' || rec.type === 'sun') continue;
      let m = lightMarks.get(id);
      if (!m) { m = new THREE.Mesh(lightGeo, lightMat.clone()); m.userData.pick = id; VP.helpers.add(m); lightMarks.set(id, m); }
      m.position.copy(rec.holder.getWorldPosition(new THREE.Vector3()));
      m.material.color.set(ED.sel.has(id) ? '#4d9cff' : '#ffcc33');
    }
    camLines();
    if (!(VP.drag && VP.drag.cam)) { camProxy.position.copy(w.cam.position); tgtProxy.position.copy(w.target); camProxy.lookAt(w.target); camProxy.rotateX(-Math.PI / 2); }
    camProxy.material.color.set(ED.sel.has('camera') ? '#ffffff' : '#6fe0ff');
    tgtProxy.material.color.set(ED.sel.has('camera:target') ? '#ffffff' : '#6fe0ff');
  }

  // ---------------------------------------------------------------- gizmo
  const tc = new TransformControls(cam, cv);
  tc.setSize(0.8);
  VP.helpers.add(tc.getHelper());
  VP.tc = tc;
  function attach() {
    const id = ED.active;
    let obj = null;
    if (ED.locked || ED.view === 'camera' || ED.sel.size !== 1) obj = null;
    else if (id === 'camera') obj = camProxy;
    else if (id === 'camera:target') obj = tgtProxy;
    else { const o = find(ED.doc, id); const rec = ED.S.objects.get(id) || ED.S.lights.get(id); obj = o && !o.locked && rec ? rec.holder : null; }
    if (obj !== tc.object) { if (obj) tc.attach(obj); else tc.detach(); }
    const isLight = kindOf(ED.doc, id) === 'lights' || String(id).startsWith('camera');
    if (isLight && tc.mode !== 'translate') tc.setMode('translate');
  }
  VP.attach = attach;
  VP.setMode = m => { if (m === 'translate' || !(kindOf(ED.doc, ED.active) === 'lights' || String(ED.active).startsWith('camera'))) tc.setMode(m); ED.dirty = true; };
  tc.addEventListener('dragging-changed', e => {
    if (e.value) {                                          // grab: the pointer owns the object until release
      const id = ED.active;
      VP.drag = { id, cam: String(id).startsWith('camera'), start: snap(id) };
      if (!VP.drag.cam) ED.S.hold = new Set([id]);
    } else if (VP.drag) {
      const d = VP.drag; VP.drag = null;
      ED.S.hold = null;
      if (d.cam) commitCam(d.id, `камера: ${tc.mode === 'translate' ? 'сдвиг' : 'поворот'}`);
      else commitTransform([d.id], { [d.id]: d.start }, tc.mode);
    }
    ED.dirty = true;
  });
  tc.addEventListener('objectChange', () => {
    if (VP.drag && VP.drag.cam) { w.cam.position.copy(camProxy.position); w.target.copy(tgtProxy.position); }
    ED.dirty = true;
  });

  // local transform of a holder -> data values
  function readHolder(id) {
    const rec = ED.S.objects.get(id) || ED.S.lights.get(id);
    const h = rec.holder, e = new THREE.Euler().setFromQuaternion(h.quaternion, 'YXZ');
    return { pos: [h.position.x, h.position.y, h.position.z], rot: [e.x, e.y, e.z], scale: h.scale.x === h.scale.y && h.scale.y === h.scale.z ? h.scale.x : [h.scale.x, h.scale.y, h.scale.z] };
  }
  function snap(id) { const rec = ED.S.objects.get(id) || ED.S.lights.get(id); return rec ? readHolder(id) : null; }
  const NAMES = { translate: 'сдвиг', rotate: 'поворот', scale: 'масштаб' };
  const PROP = { translate: 'pos', rotate: 'rot', scale: 'scale' };
  function commitTransform(ids, starts, mode) {
    const ops = [], names = [];
    for (const id of ids) {
      const now = readHolder(id), st = starts[id], kind = kindOf(ED.doc, id);
      const props = kind === 'lights' ? ['pos'] : mode ? [PROP[mode]] : ['pos', 'rot', 'scale'];
      for (const p of props) {
        if (st && JSON.stringify(round(st[p])) === JSON.stringify(round(now[p]))) continue;
        ops.push(...setOps(ED.doc, id, p, now[p], ED.t, ED.autokey));
      }
      names.push(find(ED.doc, id).name);
    }
    if (ops.length) ED.commit(ops, `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}: ${NAMES[mode] || 'трансформация'}`);
  }
  const round = v => (Array.isArray(v) ? v.map(x => Math.round(x * 1000) / 1000) : Math.round(v * 1000) / 1000);
  function commitCam(what, desc) {
    const p = [camProxy.position.x, camProxy.position.y, camProxy.position.z], t = [tgtProxy.position.x, tgtProxy.position.y, tgtProxy.position.z];
    ED.commit(camKeyOps(ED.doc, ED.t, p, t), desc);
  }

  // «ключ с этого вида»: the scene camera = the free view, key at the cursor
  VP.keyFromView = () => {
    if (ED.view === 'camera') { ED.msg('Это уже вид камеры — отойди свободной камерой (крути мышью) и нажми снова', 'warn'); return; }
    ED.commit(camKeyOps(ED.doc, ED.t, [cam.position.x, cam.position.y, cam.position.z], [orbit.tgt.x, orbit.tgt.y, orbit.tgt.z], cam.fov), `камера: ключ с вида на ${ED.t.toFixed(2)} с`);
    ED.msg('🎥 Ключ камеры с этого вида на ' + ED.t.toFixed(2) + ' с');
  };

  // ---------------------------------------------------------------- picking
  const rc = new THREE.Raycaster();
  function ndc(e) { const b = cv.getBoundingClientRect(); return new THREE.Vector2((e.clientX - b.left) / b.width * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1); }
  function opaque(hit) {
    const m = hit.object.material, img = m && !Array.isArray(m) && m.map && m.map.image;
    if (!hit.uv || !img || !(img instanceof HTMLCanvasElement)) return true;
    const x = Math.floor(hit.uv.x * img.width), y = Math.floor((1 - hit.uv.y) * img.height);
    try { return img.getContext('2d').getImageData(Math.max(0, Math.min(img.width - 1, x)), Math.max(0, Math.min(img.height - 1, y)), 1, 1).data[3] > 100; } catch { return true; }
  }
  function pick(e) {
    w.scene.updateMatrixWorld(true);
    rc.setFromCamera(ndc(e), cam); rc.params.Points.threshold = 0.01; rc.params.Line.threshold = 0.02;
    const hs = rc.intersectObjects([...lightMarks.values(), camProxy, tgtProxy], false);
    if (hs.length) return hs[0].object.userData.pick;
    for (const hit of rc.intersectObjects(w.scene.children, true)) {
      const o = hit.object;
      if (!o.visible || o.isPoints || o.isLine || o.isSprite || !opaque(hit)) continue;
      let hidden = false;
      for (let p = o; p; p = p.parent) if (!p.visible || p === VP.helpers) { hidden = true; break; }
      if (hidden) continue;
      const chain = [];
      for (let p = o; p; p = p.parent) if (p.userData && p.userData.sid && ED.S.objects.has(p.userData.sid)) chain.unshift(p.userData.sid);
      if (!chain.length) continue;                          // walls, floor (env) are not pickable
      const ok = chain.filter(id => !(find(ED.doc, id) || {}).locked);
      if (!ok.length) continue;
      if (e.altKey) return ok[ok.length - 1];
      const i = ED.entered ? ok.indexOf(ED.entered) : -1;
      return i >= 0 && ok[i + 1] ? ok[i + 1] : ok[0];
    }
    return null;
  }

  // ---------------------------------------------------------------- pointer: orbit / pan / zoom / pick / modal
  let drag = null;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.focus({ preventScroll: true });
    if (VP.modal) { if (e.button === 0) modalEnd(true); else modalEnd(false); e.preventDefault(); return; }
    if (tc.dragging || (tc.axis && e.button === 0)) return;
    const nav = e.button === 1 || (e.button === 0 && e.altKey && !e.shiftKey) || e.button === 2;
    if (nav) {
      // правый щелчок без протяжки — меню «💬 Claude» по предмету (S7); протянул — камера (вид «глазами камеры» уходит в свободный при первом сдвиге)
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, btn: e.button, moved: false, pan: e.shiftKey || e.button === 2 };
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 0 && ED.view !== 'camera') {
      const id = pick(e);
      if (e.shiftKey || e.ctrlKey) { if (id) ED.toggleSel(id); }
      else ED.select(id ? [id] : []);
    }
  });
  cv.addEventListener('pointermove', e => {
    if (VP.modal) { modalMove(e); return; }
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
      if (ED.view === 'camera') ED.setView('free');
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const k = orbit.dist * 0.0018, right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      orbit.tgt.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    } else { orbit.yaw -= dx * 0.007; orbit.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch + dy * 0.006)); }
    place(); ED.dirty = true;
  });
  const up = e => {
    if (drag && drag.btn === 2 && !drag.moved && e && e.type === 'pointerup' && ED.objMenu) ED.objMenu(e, pick(e));
    drag = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (ED.view === 'camera') ED.setView('free');
    orbit.dist = Math.max(0.1, Math.min(120, orbit.dist * Math.exp(e.deltaY * 0.0011)));
    place(); ED.dirty = true;
  }, { passive: false });
  cv.addEventListener('dblclick', e => { const id = pick(e); if (id && ED.S.objects.has(id) && (find(ED.doc, id) || {}).type === 'group') { ED.entered = id; ED.msg(`Внутри группы «${find(ED.doc, id).name}» — клик выбирает её части, Esc — выйти`); } });

  // ---------------------------------------------------------------- modal G / R / S (Blender): mouse, X / Y / Z axis, Shift+axis = plane, typed number, Enter / click, Esc / RMB
  VP.startModal = mode => {
    const ids = [...ED.sel].filter(id => (ED.S.objects.has(id) || ED.S.lights.has(id)) && !(find(ED.doc, id) || {}).locked);
    if (!ids.length || ED.locked) return;
    if (mode !== 'translate' && ids.every(id => kindOf(ED.doc, id) === 'lights')) return;
    const starts = {}, world = {};
    for (const id of ids) { starts[id] = readHolder(id); const rec = ED.S.objects.get(id) || ED.S.lights.get(id); world[id] = rec.holder.getWorldPosition(new THREE.Vector3()); }
    const c = new THREE.Vector3(); for (const id of ids) c.add(world[id]); c.divideScalar(ids.length);
    const sc = c.clone().project(cam);
    VP.modal = { mode, ids, starts, world, center: c, sc: new THREE.Vector2((sc.x + 1) / 2 * VP.size.w, (1 - sc.y) / 2 * VP.size.h), axis: null, plane: false, num: '', m0: null, snap: false };
    ED.S.hold = new Set(ids);
    ED.msg(modalText());
  };
  function modalText() {
    const M = VP.modal, nm = { translate: 'Сдвиг G', rotate: 'Поворот R', scale: 'Масштаб S' }[M.mode];
    const ax = M.axis ? (M.plane ? `плоскость без ${M.axis.toUpperCase()}` : `ось ${M.axis.toUpperCase()}`) : M.mode === 'rotate' ? 'вокруг Y' : M.mode === 'translate' ? 'по полу' : 'равномерно';
    return `${nm} · ${ax}${M.num ? ' · ' + M.num : ''} — X / Y / Z ось, Shift+ось плоскость, число, Ctrl — шаг, Enter / клик — применить, Esc — отмена`;
  }
  let lastMouse = null;
  function modalMove(e) {
    const M = VP.modal, b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
    lastMouse = e;
    if (!M.m0) { M.m0 = { x: mx, y: my, e }; return; }
    M.snap = e.ctrlKey;
    modalApply(mx, my);
  }
  function modalApply(mx, my) {
    const M = VP.modal;
    if (!M || !M.m0) return;
    const num = M.num && !isNaN(parseFloat(M.num)) ? parseFloat(M.num) : null;
    for (const id of M.ids) {
      const rec = ED.S.objects.get(id) || ED.S.lights.get(id), h = rec.holder, st = M.starts[id];
      h.position.set(...st.pos); h.rotation.set(st.rot[0], st.rot[1], st.rot[2], 'YXZ');
      const s0 = Array.isArray(st.scale) ? st.scale : [st.scale, st.scale, st.scale]; h.scale.set(...s0);
    }
    if (M.mode === 'translate') {
      let dw = new THREE.Vector3();
      if (num != null) { const ax = M.axis || 'x'; dw[ax] = num; }
      else {
        // move on the floor plane through the centre (or the chosen axis / plane), following the mouse
        rc.setFromCamera(new THREE.Vector2(mx / VP.size.w * 2 - 1, -(my / VP.size.h) * 2 + 1), cam);
        const r0 = new THREE.Raycaster(); r0.setFromCamera(new THREE.Vector2(M.m0.x / VP.size.w * 2 - 1, -(M.m0.y / VP.size.h) * 2 + 1), cam);
        let n = new THREE.Vector3(0, 1, 0);
        if (M.axis === 'y' && !M.plane) { n = cam.getWorldDirection(new THREE.Vector3()); n.y = 0; if (n.lengthSq() < 1e-6) n.set(0, 0, 1); n.normalize(); }
        else if (M.plane) n = new THREE.Vector3(M.axis === 'x' ? 1 : 0, M.axis === 'y' ? 1 : 0, M.axis === 'z' ? 1 : 0);
        else if (M.axis === 'x' || M.axis === 'z') { n = cam.getWorldDirection(new THREE.Vector3()); n[M.axis] = 0; if (n.lengthSq() < 1e-6) n.set(0, 1, 0); n.normalize(); }
        const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, M.center);
        const a = r0.ray.intersectPlane(pl, new THREE.Vector3()), b2 = rc.ray.intersectPlane(pl, new THREE.Vector3());
        if (a && b2) dw = b2.sub(a);
        if (M.axis && !M.plane) for (const k of ['x', 'y', 'z']) if (k !== M.axis) dw[k] = 0;
        if (M.snap) for (const k of ['x', 'y', 'z']) dw[k] = Math.round(dw[k] / 0.1) * 0.1;
      }
      for (const id of M.ids) {
        const rec = ED.S.objects.get(id) || ED.S.lights.get(id), par = rec.holder.parent;
        const wp = M.world[id].clone().add(dw), lp = par ? par.worldToLocal(wp) : wp;
        rec.holder.position.copy(lp);
      }
    } else if (M.mode === 'rotate') {
      const a0 = Math.atan2(M.m0.y - M.sc.y, M.m0.x - M.sc.x), a1 = Math.atan2(my - M.sc.y, mx - M.sc.x);
      let ang = num != null ? num * DEG : -(a1 - a0);
      if (M.snap && num == null) ang = Math.round(ang / (15 * DEG)) * 15 * DEG;
      const ax = M.axis || 'y';
      const axis = new THREE.Vector3(ax === 'x' ? 1 : 0, ax === 'y' ? 1 : 0, ax === 'z' ? 1 : 0);
      const q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
      for (const id of M.ids) {
        const rec = ED.S.objects.get(id); if (!rec) continue;
        const h = rec.holder; h.quaternion.premultiply(q);
        if (M.ids.length > 1) {                              // several: turn around their common centre
          const par = h.parent, wp = M.world[id].clone().sub(M.center).applyQuaternion(q).add(M.center);
          h.position.copy(par ? par.worldToLocal(wp) : wp);
        }
      }
      M.ang = ang;
    } else {
      const d0 = Math.hypot(M.m0.x - M.sc.x, M.m0.y - M.sc.y) || 1, d1 = Math.hypot(mx - M.sc.x, my - M.sc.y);
      let k = num != null ? num : d1 / d0;
      if (M.snap && num == null) k = Math.round(k * 10) / 10;
      k = Math.max(0.05, k);
      for (const id of M.ids) {
        const rec = ED.S.objects.get(id); if (!rec) continue;
        const st = M.starts[id], s0 = Array.isArray(st.scale) ? st.scale : [st.scale, st.scale, st.scale];
        const s = s0.map((v, i) => (M.axis && !M.plane ? ('xyz'[i] === M.axis ? v * k : v) : M.axis && M.plane ? ('xyz'[i] === M.axis ? v : v * k) : v * k));
        rec.holder.scale.set(...s);
      }
      M.k = k;
    }
    ED.dirty = true;
    ED.msg(modalText());
  }
  function modalEnd(ok) {
    const M = VP.modal; if (!M) return;
    VP.modal = null; ED.S.hold = null;
    if (ok) commitTransform(M.ids, M.starts, M.mode);
    ED.msg(ok ? '' : 'Отменено');
    ED.dirty = true;
  }
  VP.modalKey = e => {                                      // keys while G / R / S is on; true = handled
    const M = VP.modal; if (!M) return false;
    const k = e.key.toLowerCase(), ax = { x: 'x', y: 'y', z: 'z', ч: 'x', н: 'y', я: 'z' }[k];
    if (e.key === 'Escape') { modalEnd(false); return true; }
    if (e.key === 'Enter') { modalEnd(true); return true; }
    if (ax) { if (M.axis === ax && M.plane === e.shiftKey) M.axis = null; else { M.axis = ax; M.plane = e.shiftKey; } }
    else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !M.num)) M.num += e.key;
    else if (e.key === 'Backspace') M.num = M.num.slice(0, -1);
    else if (e.key === 'Control') M.snap = true;
    else return true;
    if (!M.m0) { const b = cv.getBoundingClientRect(); M.m0 = { x: M.sc.x, y: M.sc.y }; }
    const b = cv.getBoundingClientRect();
    modalApply(lastMouse ? lastMouse.clientX - b.left : M.m0.x, lastMouse ? lastMouse.clientY - b.top : M.m0.y);
    return true;
  };

  // Alt+G / Alt+R / Alt+S — reset
  VP.reset = mode => {
    const ids = [...ED.sel].filter(id => ED.S.objects.has(id) && !(find(ED.doc, id) || {}).locked);
    const prop = PROP[mode], v = prop === 'pos' ? [0, 0, 0] : prop === 'rot' ? [0, 0, 0] : 1;
    const ops = ids.flatMap(id => setOps(ED.doc, id, prop, v, ED.t, ED.autokey));
    if (ops.length) ED.commit(ops, `сброс: ${NAMES[mode]} (${ids.length})`);
  };

  // F / . / Numpad . — look at the selection; Home — everything
  VP.frameSel = () => {
    const b = new THREE.Box3();
    for (const id of ED.sel) { const rec = ED.S.objects.get(id) || ED.S.lights.get(id); if (rec) b.expandByObject(rec.holder); }
    if (b.isEmpty()) return VP.frameAll();
    frameBox(b);
  };
  VP.frameAll = () => { const b = new THREE.Box3(); for (const rec of ED.S.objects.values()) b.expandByObject(rec.holder); if (!b.isEmpty()) frameBox(b); };
  function frameBox(b) {
    const c = b.getCenter(new THREE.Vector3()), r = Math.max(0.15, b.getSize(new THREE.Vector3()).length() / 2);
    if (ED.view === 'camera') ED.setView('free');
    orbit.tgt.copy(c); orbit.dist = r / Math.sin(cam.fov * DEG / 2) * 1.1; place(); ED.dirty = true;
  }

  // ---------------------------------------------------------------- one frame
  VP.render = () => {
    syncHelpers();
    attach();
    const { w: vw, h: vh } = VP.size, dpr = R.getPixelRatio();
    octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, ovl.width, ovl.height);
    if (ED.view === 'camera') {
      const r = frameRect(false); VP.frame = r; VP.mini = null;
      compTo(r);
      R.setScissorTest(false); R.setViewport(0, 0, vw, vh); R.setClearColor('#111113'); R.clear();
      renderFrame(r);
      overlay2d(r, true);
    } else {
      if (ED.showMini !== false) compTo(frameRect(true));    // resizing the post chain clears the canvas: before drawing, not after
      R.setScissorTest(false); R.setViewport(0, 0, vw, vh);
      R.toneMapping = THREE.ACESFilmicToneMapping; R.autoClear = true;       // the post chain turns autoClear off for itself
      R.render(w.scene, cam);
      R.toneMapping = THREE.NoToneMapping; R.autoClear = false;
      // the 9:16 guide: what «ключ с этого вида» takes
      const gh = vh, gw = gh * 9 / 16, gx = (vw - gw) / 2;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.strokeStyle = 'rgba(111,224,255,0.35)'; octx.setLineDash([6, 6]); octx.lineWidth = 1; octx.strokeRect(gx + 0.5, 0.5, gw - 1, gh - 1); octx.setLineDash([]);
      if (ED.showMini !== false) {
        const r = frameRect(true); VP.mini = r; VP.frame = null;
        renderFrame(r);
        overlay2d(r, false);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.strokeStyle = '#6fe0ff'; octx.lineWidth = 1; octx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
        octx.fillStyle = 'rgba(0,0,0,0.6)'; octx.fillRect(r.x, r.y + r.h, r.w, 16);
        octx.fillStyle = '#6fe0ff'; octx.font = '11px Inter, system-ui, sans-serif'; octx.fillText('🎥 камера · 0', r.x + 4, r.y + r.h + 12);
      }
    }
  };
  // 2D overlays of the scene (POV title…) + safe zones, mapped from 1080×1920 to the frame rect
  function overlay2d(r, zones) {
    const dpr = R.getPixelRatio(), k = r.w / W;
    octx.setTransform(dpr * k, 0, 0, dpr * k, dpr * r.x, dpr * r.y);
    octx.save(); octx.beginPath(); octx.rect(0, 0, W, H); octx.clip();
    try { drawSceneOverlays(ED.S, octx, ED.t); } catch (e) { console.error(e); }
    if (zones && ED.zones !== false) {
      octx.globalAlpha = 1; octx.lineWidth = 3 / k * 0.6;
      octx.fillStyle = 'rgba(255,90,95,0.13)'; octx.fillRect(0, SAFE.captions[0], W, SAFE.captions[1] - SAFE.captions[0]);
      octx.fillStyle = 'rgba(255,204,51,0.12)'; octx.fillRect(0, SAFE.plate[0], W, SAFE.plate[1] - SAFE.plate[0]);
      octx.fillStyle = 'rgba(0,0,0,0.28)'; octx.fillRect(W - SAFE.right, 0, SAFE.right, H); octx.fillRect(0, SAFE.bottom, W, H - SAFE.bottom);
      octx.strokeStyle = 'rgba(255,255,255,0.45)'; octx.setLineDash([18, 14]); octx.strokeRect(SAFE.side, SAFE.plate[0], W - SAFE.side * 2, SAFE.bottom - SAFE.plate[0]); octx.setLineDash([]);
      octx.fillStyle = 'rgba(255,255,255,0.75)'; octx.font = '600 30px Inter, system-ui, sans-serif';
      octx.fillText('субтитры', 70, SAFE.captions[0] + 44); octx.fillText('плашка', 70, SAFE.plate[0] + 40); octx.fillText('интерфейс Shorts', W - SAFE.right + 6, H / 2);
    }
    octx.restore();
  }

  resize();
  return VP;
}
