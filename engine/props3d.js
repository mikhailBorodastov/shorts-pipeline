// ======================================================================
// props3d.js — 3D-пропсы препродакшена (S3): материалы в стиле канала, фигуры, наклейки, реестр prop3d().
// Подключается после stage3d.js (стенд, редактор сцены, позже шаблон ролика). Формат файла пропса — docs/studio/stage3-props.md §2:
//
//   prop3d({ name: 'ЭЛТ-монитор', h: 0.45, models: { m1: 'model.glb' }, params: { glow: '#7cc4ff' },
//            build(w, o) { const G = new THREE.Group(); G.add(P3.box(0.4, 0.36, 0.4, '#d8d0bc')); … return G; },
//            tick(T, o, holder) { … } });
//
// Единицы — метры, 0 — центр низа, перед смотрит на +z. Всё из P3 — обычные THREE.Mesh / Group, их можно двигать и вкладывать.
// Стиль канала (PROP_STYLE, channel.json → style3d): 'paper' — бумажный макет (матовый, зерно, грани-сгибы, мало сегментов),
//   'toy' — игрушка (гладкий, мягкий блик, скруглённые края).
//   P3.mat(color, o)                  материал; o: { rough, emissive, style }
//   P3.box(w, h, d, color, o)         ящик со скруглением o.r (по умолчанию — по стилю), низ на y = 0 (o.center — центр в 0)
//   P3.cyl(rTop, rBot, h, color, o)   цилиндр / конус (o.seg), низ на y = 0; P3.lathe(точки [[r, y]…], color, o) — тело вращения
//   P3.extrude(точки [[x, y]…], глубина, color, o)   плоская фигура с толщиной по z (центр по z), o.bevel — фаска
//   P3.sticker(w, h, draw, o)         плоская наклейка из 2D-рисунка (кнопки, логотипы, надписи): draw(g, cw, ch, T); o.edge — белая кромка,
//                                     o.px — разрешение, o.glow — светится (экран), o.dynamic — перерисовка по времени (w.dyn)
//   P3.edges(mesh, o)                 линии сгибов (paper), P3.part(geometry, color, o) — меш из своей геометрии с материалом стиля
//   P3.p(o, 'имя', поУмолчанию)       параметр объекта сцены (o.params) — то, что автор меняет в редакторе
//   S10.3 живые части: prop3d({ channels: { screen: { kind: 'media', programs: ['xp', 'off'], def: 'xp' }, led: { kind: 'blink', def: true } }, build(w, o) { … return { obj: G, tick(T) {…} }; } })
//   P3.ch(o, 'screen', T, def)        значение канала в момент T (ключи сцены keys['ch.screen'] поверх params)
//   P3.screen(w, h, o)                экран-холст: s.userData.show(ключ, (g, cw, ch) => рисунок) перерисует, только если ключ сменился; o.crt — кинескоп
//   P3.media(g, cw, ch, v, T)         кадр видео канала (v = { media: 'lib:media/<slug>@N', from, speed, loop, at }) «по размеру экрана» -> ключ кадра | null
//   P3.blink(v, T)                    индикатор горит? (true | 'off' | { hz, duty })    P3.cursor(g, x, y, s) — стрелка мыши
// Мелочи-детали (кнопки, щели, винты) — лучше наклейкой или маленьким P3.box, чем булевой операцией.
// ======================================================================

const PROPS3D = {};                                 // url файла (без ?v=) -> определение
const PROP_MODELS = {};                             // ключ 'p3:<n>:<k>' -> url glb (stage3d.loadModels3 читает)
let PROP_STYLE = 'paper';
let PROP3D_LAST = null, _p3n = 0;

function prop3d(def) {
  const src = ((document.currentScript && document.currentScript.src) || '').replace(/[?#].*$/, '');
  const base = src.replace(/[^/]*$/, ''), n = ++_p3n;
  def.url = src.replace(location.origin, '');
  def.kind = def.kind || (def.model ? 'model' : 'group');
  const keys = {};
  for (const [k, v] of Object.entries(def.models || {})) {
    const url = /^(\/|https?:|data:)/.test(v) ? v : base + v;
    keys[k] = `p3:${n}:${k}`; PROP_MODELS[keys[k]] = url;
  }
  def.mkey = k => keys[k] || k;
  // kind 'model': glb высотой h + детали кодом (detail); kind 'group': build сам
  if (def.kind === 'model' && !def.build) {
    def.build = (w, o) => {
      const G = new THREE.Group(), m = w.model(def.mkey(def.model), { h: def.h || 1, matte: def.matte !== false, name: (o && o.name) || def.name });
      w.scene.remove(m); G.add(m);
      if (PROP_STYLE === 'paper' && def.matte !== false) m.traverse(x => { if (x.isMesh) P3.papery(x); });
      if (def.detail) def.detail(w, o, G);
      return G;
    };
  }
  const b0 = def.build;                              // динамические наклейки (экраны) — в w.dyn мира, где бы пропс ни собирали
  def.build = (w, o) => { const r = b0(w, o); const G = r && r.isObject3D ? r : r && r.obj; if (G && G.isObject3D) P3.live(w, G); return r; };
  PROPS3D[def.url] = def; PROP3D_LAST = def;
  return def;
}

const P3 = (() => {
  // светлое зерно бумаги (а не серое, как grainCanvas тулкита: карта умножается на цвет)
  let _tex = null;
  function paperTex() {
    if (_tex) return _tex;
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), r = rng(7), id = g.createImageData(S, S);
    for (let i = 0; i < id.data.length; i += 4) { const v = 236 + (r() - 0.5) * 30; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    g.putImageData(id, 0, 0);
    g.lineCap = 'round';
    for (let i = 0; i < 520; i++) {                   // волокна
      const x = r() * S, y = r() * S, a = r() * TAU, L = 6 + r() * 26;
      g.strokeStyle = r() < 0.55 ? 'rgba(255,255,255,0.35)' : 'rgba(90,80,60,0.13)';
      g.lineWidth = 0.6 + r() * 1.4;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + 0.6) * L * 0.5, y + Math.sin(a + 0.6) * L * 0.5, x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
    }
    _tex = new THREE.CanvasTexture(c);
    _tex.colorSpace = THREE.SRGBColorSpace; _tex.wrapS = _tex.wrapT = THREE.RepeatWrapping; _tex.anisotropy = 8;
    return _tex;
  }
  const TILE = 0.22;                                  // метров на один тайл зерна
  // нормали «по углу» (как Auto Smooth в Blender): между гранями круче crease — ребро, мягче — сглаживание.
  // Геометрия становится неиндексной; заодно UV по метрам: проекция каждого треугольника на плоскость его грани — зерно одного размера
  function prep(geo, crease = 40) {
    if (geo.index) geo = geo.toNonIndexed();
    const p = geo.attributes.position, n3 = p.count / 3, fn = new Float32Array(p.count);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), FN = [];
    for (let f = 0; f < n3; f++) {
      a.fromBufferAttribute(p, f * 3); b.fromBufferAttribute(p, f * 3 + 1); c.fromBufferAttribute(p, f * 3 + 2);
      FN.push(c.clone().sub(b).cross(a.clone().sub(b)).normalize());
    }
    const key = i => `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    const at = new Map();
    for (let i = 0; i < p.count; i++) { const k = key(i); (at.get(k) || at.set(k, []).get(k)).push(i); }
    const cos = Math.cos(crease * Math.PI / 180), nrm = new Float32Array(p.count * 3), uv = new Float32Array(p.count * 2), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      const my = FN[Math.floor(i / 3)];
      v.set(0, 0, 0);
      for (const j of at.get(key(i))) { const o = FN[Math.floor(j / 3)]; if (o.dot(my) >= cos) v.add(o); }
      if (v.lengthSq() < 1e-12) v.copy(my);
      v.normalize(); nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z;
      const ax = Math.abs(my.x), ay = Math.abs(my.y), az = Math.abs(my.z);
      let u, w;
      if (ax >= ay && ax >= az) { u = p.getZ(i); w = p.getY(i); } else if (ay >= az) { u = p.getX(i); w = p.getZ(i); } else { u = p.getX(i); w = p.getY(i); }
      uv[i * 2] = u / TILE; uv[i * 2 + 1] = w / TILE;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  }
  const uvMeters = geo => prep(geo, 180);
  const paper = () => PROP_STYLE !== 'toy';
  function mat(color, o = {}) {
    const style = o.style || PROP_STYLE, col = new THREE.Color(color || '#cccccc');
    let m;
    if (style === 'toy') {
      m = new THREE.MeshPhysicalMaterial({ color: col, roughness: o.rough == null ? 0.5 : o.rough, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.45 });
    } else {
      const t = paperTex();
      m = new THREE.MeshStandardMaterial({ color: col, roughness: o.rough == null ? 0.97 : o.rough, metalness: 0, map: t, bumpMap: t, bumpScale: 0.9, flatShading: !!o.flat });
    }
    if (o.emissive) { m.emissive = new THREE.Color(o.emissive); m.emissiveIntensity = o.emissiveI == null ? 1 : o.emissiveI; }
    if (o.side) m.side = o.side;
    return m;
  }
  function papery(mesh) {                            // модель из glb -> бумажная: зерно по метрам, матовая
    const src = mesh.geometry, mats = [].concat(mesh.material), own = mats.some(x => x && x.map) && src.attributes.uv;
    const g = prep(src.clone(), 40);                 // prep пишет UV «в метрах» под зерно — у модели со своей текстурой (TRELLIS, Meshy, ассеты) её развёртку возвращаем
    if (own) g.setAttribute('uv', (src.index ? src.toNonIndexed() : src).attributes.uv.clone());
    mesh.geometry = g;
    const t = paperTex();
    for (const x of mats) { x.map = x.map || t; x.bumpMap = t; x.bumpScale = own ? 0.35 : 0.9; x.roughness = 1; x.metalness = 0; x.needsUpdate = true; }
  }
  function edges(mesh, o = {}) {
    const e = new THREE.LineSegments(o.geo || new THREE.EdgesGeometry(mesh.geometry, o.angle || 28),
      new THREE.LineBasicMaterial({ color: o.color || '#2a241c', transparent: true, opacity: o.opacity == null ? 0.28 : o.opacity }));
    e.raycast = () => {};                             // пины и выбор бьют по поверхности, а не по линиям
    mesh.add(e);
    return e;
  }
  function part(geo, color, o = {}) {
    const lines = paper() && o.edges !== false ? new THREE.EdgesGeometry(geo, (o.edgeO && o.edgeO.angle) || 28) : null;   // по исходной (индексной) форме
    geo = prep(geo, o.crease || 40);
    const m = new THREE.Mesh(geo, o.material || mat(color, o));
    m.castShadow = o.shadow !== false; m.receiveShadow = true;
    if (lines) edges(m, Object.assign({ geo: lines }, o.edgeO));
    if (o.pos) m.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.rot) m.rotation.set(o.rot[0] || 0, o.rot[1] || 0, o.rot[2] || 0);
    if (o.name) m.name = o.name;
    return m;
  }
  // скруглённый ящик: плоский скруглённый прямоугольник, выдавленный с фаской
  function rboxGeo(w, h, d, r, seg) {
    r = Math.max(0.0005, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
    const x = w / 2 - r, y = h / 2 - r, s = new THREE.Shape();
    s.moveTo(-x, -y - r); s.lineTo(x, -y - r); s.quadraticCurveTo(x + r, -y - r, x + r, -y);
    s.lineTo(x + r, y); s.quadraticCurveTo(x + r, y + r, x, y + r); s.lineTo(-x, y + r);
    s.quadraticCurveTo(-x - r, y + r, -x - r, y); s.lineTo(-x - r, -y); s.quadraticCurveTo(-x - r, -y - r, -x, -y - r);
    const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.999, bevelSegments: seg, curveSegments: seg });
    g.translate(0, 0, -(d - 2 * r) / 2);
    return g;
  }
  function box(w, h, d, color, o = {}) {
    const r = o.r != null ? o.r : paper() ? Math.min(w, h, d) * 0.03 : Math.min(w, h, d) * 0.14;
    const geo = r < 0.001 ? new THREE.BoxGeometry(w, h, d) : rboxGeo(w, h, d, r, o.seg || (paper() ? 1 : 4));
    if (!o.center) geo.translate(0, h / 2, 0);
    return part(geo, color, o);
  }
  function cyl(rTop, rBot, h, color, o = {}) {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, o.seg || (paper() ? 10 : 40), 1, !!o.open);
    if (!o.center) geo.translate(0, h / 2, 0);
    return part(geo, color, o);
  }
  function lathe(pts, color, o = {}) {
    return part(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), o.seg || (paper() ? 12 : 48)), color, o);
  }
  function extrude(pts, depth, color, o = {}) {
    const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const bv = o.bevel != null ? o.bevel : paper() ? 0 : Math.min(depth * 0.3, 0.01);
    const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, depth - 2 * bv), bevelEnabled: bv > 0, bevelThickness: bv, bevelSize: bv, bevelSegments: 3, curveSegments: o.curve || 12 });
    g.translate(0, 0, -(depth - 2 * bv) / 2);
    return part(g, color, o);
  }
  // наклейка из 2D-рисунка тулкита. Лицом к +z, центр в 0; ставь на грань: s.position.set(0, y, d / 2 + 0.001)
  function sticker(w, h, draw, o = {}) {
    const px = o.px || 512, cw = Math.round(w >= h ? px : px * w / h), ch = Math.round(w >= h ? px * h / w : px);
    const c = cnv(cw, ch), g = c.getContext('2d');
    const paint = T => {
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw, ch);
      draw(g, cw, ch, T || 0);
      if (o.edge && typeof outline2d === 'function') outline2d(c, Math.max(2, Math.round(cw * 0.012)), o.edge === true ? '#f7f5ef' : o.edge);
      if (paper() && o.grain !== false && typeof grainPat === 'function') {
        g.save(); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.18; g.fillStyle = grainPat(g); g.fillRect(0, 0, cw, ch); g.restore();
      }
    };
    paint(0);
    const t = tex3(c);
    const m = o.glow
      ? new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color('#ffffff'), emissiveIntensity: o.glow === true ? 1.2 : o.glow, roughness: 0.6, transparent: true, alphaTest: 0.05 })
      : new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, transparent: true, alphaTest: 0.3 });
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.receiveShadow = !o.glow; mesh.castShadow = false;
    if (o.pos) mesh.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.rot) mesh.rotation.set(o.rot[0] || 0, o.rot[1] || 0, o.rot[2] || 0);
    mesh.userData.canvas = c; mesh.userData.tex = t;
    if (o.dynamic) { let last = null; mesh.userData.redraw = (lt, T) => { const k = o.state ? o.state(lt, T) : Math.round(lt * 30); if (k === last) return; last = k; paint(lt); t.needsUpdate = true; }; mesh.userData.p3dyn = true; }
    return mesh;
  }
  // собрать динамические наклейки группы в w.dyn (их перерисовывает world.draw)
  function live(w, G) { G.traverse(x => { if (x.userData && x.userData.p3dyn && !w.dyn.includes(x)) w.dyn.push(x); }); return G; }
  const p = (o, k, d) => (o && o.params && o.params[k] != null ? o.params[k] : d);   // параметр объекта сцены (как P_ в prefabs.js)
  // ---- S10.3: каналы, экран, видео кадрами, индикатор, курсор
  const ch = (o, k, T, d) => (typeof sceneChAt === 'function' ? sceneChAt(o, k, T || 0, d) : p(o, k, d));
  const blink = (v, T) => (typeof sceneBlink === 'function' ? sceneBlink(v, T || 0) : !!v);
  function crt(g, cw, ch_, o = {}) {                     // кинескоп: сканлайны, виньетка, лёгкая засветка по центру
    g.save();
    g.globalAlpha = o.scan == null ? 0.16 : o.scan; g.fillStyle = '#000';
    const step = Math.max(2, Math.round(ch_ / 240));
    for (let y = 0; y < ch_; y += step * 2) g.fillRect(0, y, cw, step);
    g.globalAlpha = 1;
    const v = g.createRadialGradient(cw / 2, ch_ / 2, Math.min(cw, ch_) * 0.3, cw / 2, ch_ / 2, Math.hypot(cw, ch_) * 0.56);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)'); g.fillStyle = v; g.fillRect(0, 0, cw, ch_);
    g.globalCompositeOperation = 'screen'; g.globalAlpha = 0.08;
    const l = g.createRadialGradient(cw * 0.45, ch_ * 0.4, 0, cw * 0.45, ch_ * 0.4, cw * 0.5);
    l.addColorStop(0, '#ffffff'); l.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = l; g.fillRect(0, 0, cw, ch_);
    g.restore();
  }
  function screen(w, h, o = {}) {
    const m = sticker(w, h, () => {}, { glow: o.glow || 1.15, px: o.px || 640, grain: false });
    const c = m.userData.canvas, g = c.getContext('2d'); let last = null;
    m.userData.show = (key, draw) => {
      if (key === last) return false;
      last = key; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
      draw(g, c.width, c.height);
      if (o.crt !== false) crt(g, c.width, c.height, o.crt || {});
      m.userData.tex.needsUpdate = true; return true;
    };
    return m;
  }
  function media(g, cw, ch_, v, T) {                      // кадр «по размеру» (cover); нет кадров — «нет сигнала»
    const f = typeof sceneMediaFrame === 'function' ? sceneMediaFrame(v, T || 0) : null;
    if (!f || !f.img || !f.img.naturalWidth) {
      g.fillStyle = '#101418'; g.fillRect(0, 0, cw, ch_);
      g.fillStyle = '#7f8a94'; g.font = `700 ${Math.round(ch_ * 0.07)}px Rubik, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('нет сигнала', cw / 2, ch_ / 2); return 'nosig';
    }
    const iw = f.img.naturalWidth, ih = f.img.naturalHeight, fit = v.fit || 'cover';   // cover — заполнить (края срежутся), contain — целиком с полями, stretch — растянуть (игра 4:3 с HUD)
    g.imageSmoothingEnabled = true;
    if (fit === 'stretch') g.drawImage(f.img, 0, 0, cw, ch_);
    else {
      const k = fit === 'contain' ? Math.min(cw / iw, ch_ / ih) : Math.max(cw / iw, ch_ / ih);
      if (fit === 'contain') { g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch_); }
      g.drawImage(f.img, (cw - iw * k) / 2, (ch_ - ih * k) / 2, iw * k, ih * k);
    }
    return v.media + '#' + f.i;
  }
  function cursor(g, x, y, s) {                          // стрелка мыши XP (белая с чёрной обводкой), x, y — кончик
    const P = [[0, 0], [0, 17], [4, 13], [7, 20], [10, 19], [7, 12], [12, 12]];
    g.save(); g.translate(x, y); g.scale(s / 20, s / 20);
    g.beginPath(); P.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath();
    g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.4; g.strokeStyle = '#000'; g.lineJoin = 'round'; g.stroke(); g.restore();
  }
  return { mat, part, box, cyl, lathe, extrude, sticker, edges, papery, uvMeters, prep, paperTex, live, rboxGeo, p, ch, blink, crt, screen, media, cursor };
})();
