// ======================================================================
// stage3d.js — 3D layer for the paper shorts: cardboard dioramas (Paper Mario) + HD-2D post effects (Octopath Traveler).
// three.js r186 + postprocessing 6.39 live in src/vendor and are loaded by vendor/boot3d.js (see index.html).
//
// A world = THREE.Scene + camera + post chain. It is rendered into one shared WebGL canvas and then drawn into the
// 2D frame, so captions, 2D overlays and the transitions of main.js keep working as before.
//
//   const yard = world3d({
//     fx: 'night',                                   // preset from FX3, or { preset: 'night', bloom: {...}, dof: {...} }
//     build(w) { w.card({...}); w.box({...}); w.lamp({...}); w.motes({...}); },
//     update(w, lt, D, T) { /* move things */ w.camKeys(lt, [[0, [0, 2, 9], [0, 1, 0]], [3, [1, 1.5, 6], [0, 1, 0]]]); },
//   });
//   const S0 = { name, draw(ctx, lt, D, T) { yard.draw(ctx, lt, D, T); /* 2D on top */ } };
//
// API (w = world): w.card (paper cut-out from a 2D drawing, dynamic = redrawn every frame), w.box (cardboard box with painted faces
//   and emissive windows), w.plane (ground / backdrops / sky), w.sun / w.ambient / w.lamp (lights with halo + flicker), w.motes (dust,
//   fireflies, embers, confetti), w.shaft (volumetric light beam), w.glow (soft sprite), w.camKeys (camera keys), w.shake;
//   heroes: hogCard (the paper hedgehog, walk / legs / fedora), pixelHogCard (HD-2D pixel hedgehog), spriteCard (photo / sprite);
//   animation: popUp3 (pop-up book), pop3, flip3 (Paper Mario turn), hop3 (jump + squash), gait3 (walking bob);
//   mirrors: new Reflector(geometry, { color, textureWidth, textureHeight }) from vendor/reflector.js.
//   glTF models: ASSETS.models = { key: '../assets/models/x.glb' } (in the Штурм stand: const MODELS = {...}) are loaded by stage3dInit,
//   w.model(key, { h, pos, rotY, name, matte, color, anim }) puts one in (scaled to height h, pivot at the bottom centre).
// Names and the author's layout: every object made by card / box / lamp / model / hogCard / spriteCard (and a plane with `name`) is
//   an item of w.items with a name (o.name, or 'карточка 3' by creation order). w.layout = { name: { p: [dx, dy, dz], r: радианы по Y,
//   s: масштаб, hide: true } } moves items ON TOP of the scene code, every frame after update(), so animations keep working.
//   Groups (w.regroup, after build): the author's w.groups = { 'Ели слева': ['карточка 3', 'spruce 2'] } + automatic ones over unnamed
//   items made in a row on one spot ('spruce 12' — by the card key, else 'группа 3'); a group's layout entry moves / turns / scales it whole.
//   The Штурм 3D viewer («✋ Двигать») writes such a layout; give scene objects stable names (name: 'Лифт') so it survives code edits.
//   Several objects that move together: put them into a THREE.Group and w.add(group, pos, 'Ель слева') — the group is one item
//   (a click on any of its parts picks the outermost named item).
// Example of a whole short: «Коты сыщики 3D» (src/yard3d.js = the courtyard diorama, src/shots.js = scenes).
// Units: 1 ≈ a metre, y up, the camera looks along -z. Cards stand on their bottom edge (pivot at the feet).
// GLSL: never pow(0.0, y) — NaN on D3D, bloom spreads it over the whole frame (black frames). Hide sprites instead of scaling to 0.
// Everything is a pure function of time: particles and flicker are computed from lt, so frames render in any order.
// ======================================================================

const X3 = { worlds: [], R: null, ok: false, tc: {}, models: {} };   // tc: textures shared between worlds by key; models: key -> loaded glTF
// texture from a drawing, shared between worlds when `key` is given
function ktex(key, cw, ch, draw, o = {}) {
  if (key && X3.tc[key]) return X3.tc[key];
  const c = cnv(cw, ch); draw(c.getContext('2d'), cw, ch);
  const t = tex3(c, o); if (key) X3.tc[key] = t; return t;
}

// post-processing presets. bloom: HDR glow (things brighter than `threshold` glow), dof: bokeh depth of field
// focused on w.focus (range = sharp zone in metres), tilt: screen-space tilt-shift blur at the top and bottom,
// grade: saturation / contrast / brightness after tone mapping, vignette, ca: chromatic aberration at the edges.
const FX3 = {
  night: { bloom: { intensity: 1.5, threshold: 0.6, smooth: 0.35, radius: 0.78 }, dof: { range: 2.2, bokeh: 3.2 },
    tone: 'aces', grade: { sat: 0.18, contrast: 0.12, bright: 0.0 }, vignette: { offset: 0.22, darkness: 0.72 }, ca: 0.0012 },
  dusk: { bloom: { intensity: 1.1, threshold: 0.72, smooth: 0.3, radius: 0.72 }, dof: { range: 2.8, bokeh: 2.6 },
    tone: 'aces', grade: { sat: 0.2, contrast: 0.1, bright: 0.02 }, vignette: { offset: 0.25, darkness: 0.6 }, ca: 0.001 },
  day: { bloom: { intensity: 0.7, threshold: 0.85, smooth: 0.25, radius: 0.6 }, dof: { range: 3.5, bokeh: 2 },
    tone: 'aces', grade: { sat: 0.12, contrast: 0.06, bright: 0.03 }, vignette: { offset: 0.3, darkness: 0.45 }, ca: 0 },
};

function world3d(o) {
  const w = Object.create(W3API);
  Object.assign(w, { o, ticks: [], dyn: [], t: 0, T: 0, items: [], layout: o.layout || null });
  X3.worlds.push(w);
  return w;
}

// glTF models from ASSETS.models (video) or MODELS (Штурм stand): key -> url. Needs vendor/GLTFLoader.js (boot3d.js loads it).
async function loadModels3() {
  const M = Object.assign({}, (typeof ASSETS !== 'undefined' && ASSETS && ASSETS.models) || {}, typeof MODELS !== 'undefined' ? MODELS : {}, typeof PROP_MODELS !== 'undefined' ? PROP_MODELS : {});
  const todo = Object.entries(M).filter(([k]) => !X3.models[k]);
  if (!todo.length) return;
  if (!window.GLTFLoader) { console.error('stage3d: GLTFLoader is missing (vendor/GLTFLoader.js) — models are not loaded'); return; }
  const L = new GLTFLoader();
  await Promise.all(todo.map(([k, url]) => L.loadAsync(url).then(g => (X3.models[k] = g)).catch(e => console.error('model not loaded: ' + url, e))));
}

// called from main.js READY after fonts and assets are loaded
async function stage3dInit() {
  if (!X3.worlds.length) return;
  if (!window.THREE || !window.PP) { console.error('stage3d: three.js / postprocessing not loaded'); return; }
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const R = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', stencil: false });
  R.setPixelRatio(1); R.setSize(W, H, false);
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFShadowMap;
  R.outputColorSpace = THREE.SRGBColorSpace;
  X3.R = R;
  await loadModels3();
  for (const w of X3.worlds) w._build();
  X3.ok = true;
}

// ---------------------------------------------------------------- canvas helpers
function cnv(cw, ch) { const c = document.createElement('canvas'); c.width = cw; c.height = ch; return c; }
function tex3(canvas, o = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (o.pixel) { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  else { t.anisotropy = 8; }
  if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.repeat[0], o.repeat[1]); }
  return t;
}
const _tmpC = {};
function scratch(key, cw, ch) {
  let c = _tmpC[key];
  if (!c || c.width !== cw || c.height !== ch) c = _tmpC[key] = cnv(cw, ch);
  const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, cw, ch);
  return c;
}
// white (or any) outline around everything drawn in canvas c: the Paper Mario border
function outline2d(c, r, color = '#f7f5ef') {
  const s = scratch('ol', c.width, c.height), g = s.getContext('2d');
  g.drawImage(c, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  const o = scratch('ol2', c.width, c.height), q = o.getContext('2d');
  for (let a = 0; a < TAU - 1e-6; a += TAU / 16) q.drawImage(s, Math.cos(a) * r, Math.sin(a) * r);
  q.drawImage(c, 0, 0);
  const cg = c.getContext('2d'); cg.save(); cg.setTransform(1, 0, 0, 1, 0, 0); cg.clearRect(0, 0, c.width, c.height); cg.drawImage(o, 0, 0); cg.restore();
}
// silhouette of c filled with a flat paper colour (back side of a card)
function silhouette2d(src, dst, color) {
  const g = dst.getContext('2d'); g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, dst.width, dst.height);
  g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, dst.width, dst.height);
  if (typeof grainPat === 'function') { g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.35; g.fillStyle = grainPat(g); g.fillRect(0, 0, dst.width, dst.height); }
  g.restore();
}
// soft radial sprite texture (halos, glows)
let _haloTex = null;
function haloTex() {
  if (_haloTex) return _haloTex;
  const c = cnv(256, 256), g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  _haloTex = new THREE.CanvasTexture(c); return _haloTex;
}
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const ITEM3 = { card: 'карточка', box: 'коробка', lamp: 'лампа', model: 'модель', plane: 'плоскость', group: 'группа' };   // auto names of unnamed items
// blink curve: the toolkit's blinkAt when it is there, otherwise a plain one (the engine must work without scenes.js helpers)
const blink3 = (T, seed = 0) => (typeof blinkAt === 'function' ? blinkAt(T, seed) : ((T + seed * 1.7) % 3.7 < 0.13 ? 1 : 0));
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------- world API
const W3API = {
  _build() {
    const o = this.o, s = (this.scene = new THREE.Scene());
    s.background = new THREE.Color(o.bg || '#101428');
    if (o.fog) s.fog = new THREE.Fog(o.fog[0], o.fog[1], o.fog[2]);
    this.cam = new THREE.PerspectiveCamera(o.fov || 30, W / H, 0.1, 500);
    this.cam.position.set(0, 2, 10); this.target = new THREE.Vector3(0, 1, 0);
    this.focus = null;
    o.build && o.build(this);
    this.regroup();
    this._post();
    // first render compiles all shaders: do it now, not on the first rendered frame
    try { X3.R.compile(s, this.cam); } catch (e) {}
  },
  _post() {
    const P = PP, o = this.o;
    let fx = o.fx || 'night';
    if (typeof fx === 'string') fx = FX3[fx];
    else fx = Object.assign({}, FX3[fx.preset || 'night'], fx);
    this.fxCfg = fx;
    const comp = (this.comp = new P.EffectComposer(X3.R, { frameBufferType: THREE.HalfFloatType, multisampling: fx.msaa == null ? 4 : fx.msaa }));
    comp.addPass(new P.RenderPass(this.scene, this.cam));
    const list = [];
    if (fx.dof) { this.dof = new P.DepthOfFieldEffect(this.cam, { focusDistance: fx.dof.dist || 8, focusRange: fx.dof.range, bokehScale: fx.dof.bokeh, resolutionScale: 0.5 }); list.push(this.dof); }
    if (fx.tilt) { this.tilt = new P.TiltShiftEffect({ offset: fx.tilt.offset || 0, focusArea: fx.tilt.area || 0.45, feather: fx.tilt.feather || 0.3, kernelSize: P.KernelSize.MEDIUM }); }
    if (fx.bloom) { this.bloom = new P.BloomEffect({ mipmapBlur: true, luminanceThreshold: fx.bloom.threshold, luminanceSmoothing: fx.bloom.smooth, intensity: fx.bloom.intensity, radius: fx.bloom.radius }); list.push(this.bloom); }
    const modes = { aces: P.ToneMappingMode.ACES_FILMIC, agx: P.ToneMappingMode.AGX, neutral: P.ToneMappingMode.NEUTRAL };
    list.push((this.toneFx = new P.ToneMappingEffect({ mode: modes[fx.tone || 'aces'] })));
    if (fx.grade) {
      list.push((this.satFx = new P.HueSaturationEffect({ saturation: fx.grade.sat || 0, hue: 0 })));
      list.push((this.bcFx = new P.BrightnessContrastEffect({ brightness: fx.grade.bright || 0, contrast: fx.grade.contrast || 0 })));
    }
    // film grain on the GPU (fx.noise = opacity 0..1): ~free per frame, BUT random per frame -> the mp4 gets ~5x bigger; prefer a tiled 2D grain
    if (fx.noise) { this.noiseFx = new P.NoiseEffect({ premultiply: false, blendFunction: P.BlendFunction.OVERLAY }); this.noiseFx.blendMode.opacity.value = fx.noise; list.push(this.noiseFx); }
    if (fx.vignette) list.push((this.vigFx = new P.VignetteEffect({ offset: fx.vignette.offset, darkness: fx.vignette.darkness })));
    comp.addPass(new P.EffectPass(this.cam, ...list));
    // convolution effects can't share a pass with DoF
    if (this.tilt) comp.addPass(new P.EffectPass(this.cam, this.tilt));
    if (fx.ca) { this.caFx = new P.ChromaticAberrationEffect({ offset: new THREE.Vector2(fx.ca, fx.ca), radialModulation: true, modulationOffset: 0.35 }); comp.addPass(new P.EffectPass(this.cam, this.caFx)); }
  },
  // render the world at local time lt and draw it into the 2D context
  draw(ctx, lt, D, T) {
    if (!X3.ok) { ctx.fillStyle = '#301018'; ctx.fillRect(0, 0, W, H); return; }
    this.t = lt; this.T = T; this.D = D;
    this._lay(false);                                 // the scene code sees its own positions…
    this.o.update && this.o.update(this, lt, D, T);
    for (const f of this.ticks) f(lt, T);
    this._lay(true);                                  // …and the author's layout goes on top
    for (const c of this.dyn) if (c.visible && c.userData.redraw) c.userData.redraw(lt, T);
    this.cam.updateProjectionMatrix(); this.cam.lookAt(this.target);
    if (this.dof) this.dof.target = this.focus || this.target;
    this.comp.render(1 / 60);
    ctx.drawImage(X3.R.domElement, 0, 0);
  },
  // add any three.js object; with a name it becomes one layout item (a THREE.Group of cards = a tree, a shelf with its things)
  add(obj, pos, name) { if (pos) obj.position.set(pos[0], pos[1], pos[2]); this.scene.add(obj); if (name) this.item(name, 'group', obj); return obj; },
  tick(f) { this.ticks.push(f); return f; },

  // ---- named items + the author's layout (see the header). objs: the three.js objects that move together (a lamp = light + halo + bulb)
  item(name, kind, main, objs, key) {
    let nm = name || `${ITEM3[kind] || kind} ${this.items.filter(i => i.kind === kind).length + 1}`;
    for (let k = 2; this.items.some(i => i.name === nm); k++) nm = `${name || nm} ${k}`;
    const it = { name: nm, auto: !name, kind, main, objs: (objs || [main]).filter(Boolean), key };
    for (const o of it.objs) o.userData.item = it;
    this.items.push(it);
    return it;
  },
  // ---- groups ('set' items): the author's w.groups = { 'Имя': ['член', …] } (a name: null disbands an automatic group) +
  // automatic ones: unnamed items made one after another that stand on one spot (a tree of crossed cards, a post with its lamp).
  // A group moves, turns (around its centre) and scales as a whole; its members keep their own layout under it.
  regroup() {
    this.items = this.items.filter(i => i.kind !== 'set');
    for (const it of this.items) it.group = null;
    this.scene.updateMatrixWorld(true);
    const G = this.groups || {}, byName = new Map(this.items.map(i => [i.name, i])), taken = new Set();
    const mk = (name, ms, auto) => {
      const g = { name, auto, kind: 'set', members: ms, objs: ms.flatMap(m => m.objs), main: ms[0].main };
      for (const m of ms) { m.group = g; taken.add(m); }
      this.items.push(g);
    };
    // automatic candidates first, over ALL unnamed items: their names ('spruce 12') must not depend on what the author regrouped
    const box = it => {
      const b = new THREE.Box3();
      for (const o of it.objs) if (o.isMesh || o.isGroup || o.isSprite) b.expandByObject(o);
      if (b.isEmpty()) { const c = it.main.getWorldPosition(new THREE.Vector3()); b.setFromCenterAndSize(c, new THREE.Vector3(0.05, 0.05, 0.05)); }
      return b;
    };
    const runs = [], count = {};
    let cur = null;
    const flush = () => {
      if (cur && cur.ms.length > 1) {
        const k = cur.ms.map(m => m.key).find(Boolean), base = k ? String(k).replace(/[\s_\-]*\d+$/, '') || String(k) : 'группа';
        let nm;
        do { count[base] = (count[base] || 0) + 1; nm = `${base} ${count[base]}`; } while (byName.has(nm));
        runs.push([nm, cur.ms]);
      }
      cur = null;
    };
    for (const it of this.items) {
      if (!it.auto || it.main.parent !== this.scene) { flush(); continue; }
      const b = box(it), c = b.getCenter(new THREE.Vector3());
      if (cur && c.x >= cur.b.min.x - 0.1 && c.x <= cur.b.max.x + 0.1 && c.z >= cur.b.min.z - 0.1 && c.z <= cur.b.max.z + 0.1) { cur.ms.push(it); cur.b.union(b); }
      else { flush(); cur = { ms: [it], b }; }
    }
    flush();
    for (const [name, list] of Object.entries(G)) {                    // the author's groups win
      const ms = Array.isArray(list) ? list.map(n => byName.get(n)).filter(m => m && !taken.has(m)) : [];
      if (ms.length) mk(name, ms, false);
    }
    for (const [nm, ms] of runs) {
      const left = ms.filter(m => !taken.has(m));
      if (G[nm] !== null && !Array.isArray(G[nm]) && left.length > 1) mk(nm, left, true);
    }
  },
  // on = false restores what the layout changed (before update), on = true puts the current layout on (after update and ticks):
  // items first, then groups on top of them
  _lay(on) {
    if (!on) {
      const st = this._st;
      if (st) for (let i = st.length - 1; i >= 0; i--) { const [o, p, r, sc, v] = st[i]; o.position.copy(p); o.rotation.y = r; o.scale.copy(sc); o.visible = v; }
      this._st = null; return;
    }
    const L = this.layout;
    if (!L) return;
    const st = (this._st = []);
    for (const pass of [0, 1]) for (const it of this.items) {
      if ((it.kind === 'set') !== (pass === 1)) continue;
      const l = L[it.name];
      if (!l) continue;
      const p = l.p || [0, 0, 0], r = l.r || 0, sc = l.s || 1;
      let pv = null;
      if (it.kind === 'set' && (r || sc !== 1)) {                  // a group turns and scales around the centre of its members' feet
        pv = new THREE.Vector3();
        for (const m of it.members) pv.add(m.main.position);
        pv.divideScalar(it.members.length);
      }
      const c = Math.cos(r), sn = Math.sin(r);
      for (const o of it.objs) {
        st.push([o, o.position.clone(), o.rotation.y, o.scale.clone(), o.visible]);
        if (pv) {
          const dx = o.position.x - pv.x, dz = o.position.z - pv.z;
          o.position.set(pv.x + (dx * c + dz * sn) * sc, pv.y + (o.position.y - pv.y) * sc, pv.z + (-dx * sn + dz * c) * sc);
        }
        o.position.x += p[0]; o.position.y += p[1]; o.position.z += p[2];
        if (!o.isLight) { o.rotation.y += r; o.scale.multiplyScalar(sc); }
        if (l.hide) o.visible = false;
      }
    }
  },

  // ---- glTF model (see loadModels3): scaled to height o.h (m, default 1) or width o.w, pivot at the bottom centre, casts shadows.
  // o: pos, rotY, name, matte (paper look: roughness 1, no metal), color (tint), anim (clip name or index, plays by lt), speed, shadow
  // returns a Group: .inner (flip / pop / hop like a card), .size [w, h, d] in metres
  model(key, o = {}) {
    const g = X3.models[key], G = new THREE.Group(), inner = new THREE.Group(), fit = new THREE.Group();
    G.add(inner); inner.add(fit); G.inner = inner; G.size = [0, 0, 0];
    if (!g) console.warn('model: not loaded', key);
    else {
      const obj = window.SkeletonUtils ? SkeletonUtils.clone(g.scene) : g.scene.clone(true);
      const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const k = o.w ? o.w / Math.max(1e-6, size.x) : (o.h || 1) / Math.max(1e-6, size.y);
      obj.position.set(-c.x, -box.min.y, -c.z); fit.add(obj); fit.scale.setScalar(k);
      const tint = o.color && new THREE.Color(o.color);
      obj.traverse(m => {
        if (!m.isMesh) return;
        m.castShadow = o.shadow !== false; m.receiveShadow = true;
        if (o.matte || tint) {
          m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
          for (const x of [].concat(m.material)) { if (o.matte) { x.roughness = 1; x.metalness = 0; } if (tint && x.color) x.color.multiply(tint); }
        }
      });
      if (o.anim != null && g.animations && g.animations.length) {
        const clip = typeof o.anim === 'number' ? g.animations[o.anim] : THREE.AnimationClip.findByName(g.animations, o.anim) || g.animations[0];
        const mix = new THREE.AnimationMixer(obj); mix.clipAction(clip).play();
        this.tick(lt => mix.setTime(lt * (o.speed || 1)));
      }
      G.size = [size.x * k, size.y * k, size.z * k];
    }
    if (o.pos) G.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.rotY) G.rotation.y = o.rotY;
    this.scene.add(G);
    this.item(o.name || key, 'model', G);
    return G;
  },

  // ---- camera: keys = [[t, pos, target, fov?], ...], eased between keys; o.handheld adds a slow drift
  camKeys(lt, keys, o = {}) {
    let i = 0; while (i < keys.length - 1 && lt >= keys[i + 1][0]) i++;
    const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
    const p = a === b ? 0 : (o.ease || E.io)(remap(lt, a[0], b[0]));
    const pos = lerp3(a[1], b[1], p), tg = lerp3(a[2], b[2], p);
    const hh = o.handheld == null ? 0.04 : o.handheld;
    this.cam.position.set(pos[0] + noise1(lt * 0.35, 3) * hh, pos[1] + noise1(lt * 0.3, 5) * hh * 0.6, pos[2]);
    this.target.set(tg[0] + noise1(lt * 0.3, 9) * hh * 0.5, tg[1] + noise1(lt * 0.27, 11) * hh * 0.4, tg[2]);
    const fa = a[3] || this.o.fov || 30, fb = b[3] || this.o.fov || 30;
    this.cam.fov = lerp(fa, fb, p);
  },
  shake(lt, t0, amp = 0.08, d = 0.35) {
    if (lt < t0 || lt > t0 + d) return;
    const k = 1 - (lt - t0) / d;
    this.cam.position.x += Math.sin(lt * 91) * amp * k; this.cam.position.y += Math.cos(lt * 77) * amp * k;
  },

  // ---- lights
  // sun/moon: directional light with soft shadows over area `area` (metres) around `at`
  sun(o = {}) {
    const L = new THREE.DirectionalLight(o.color || '#ffffff', o.intensity == null ? 2 : o.intensity);
    const at = o.at || [0, 0, 0], dir = o.dir || [-4, 8, 5];
    L.position.set(at[0] + dir[0], at[1] + dir[1], at[2] + dir[2]); L.target.position.set(at[0], at[1], at[2]);
    if (o.shadow !== false) {
      L.castShadow = true; const a = o.area || 12, sm = L.shadow;
      sm.mapSize.set(o.res || 2048, o.res || 2048); sm.camera.left = -a; sm.camera.right = a; sm.camera.top = a; sm.camera.bottom = -a;
      sm.camera.near = 0.5; sm.camera.far = 60; sm.bias = -0.0004; sm.normalBias = 0.02; sm.radius = o.soft || 4; sm.blurSamples = 12;
    }
    this.scene.add(L, L.target);
    return L;
  },
  ambient(sky = '#8090c0', ground = '#403028', intensity = 0.6) { const L = new THREE.HemisphereLight(sky, ground, intensity); this.scene.add(L); return L; },
  // lamp: point light + bright bulb + soft halo sprite; flicker = 0..1 (torches), returns { light, halo, bulb, set(k) }
  lamp(o = {}) {
    const pos = o.pos || [0, 3, 0], col = new THREE.Color(o.color || '#ffc36b');
    const light = new THREE.PointLight(col, o.intensity == null ? 12 : o.intensity, o.dist || 9, o.decay || 1.6);
    light.position.set(pos[0], pos[1], pos[2]);
    if (o.shadow) { light.castShadow = true; light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.002; light.shadow.radius = 3; }
    this.scene.add(light);
    const hm = new THREE.SpriteMaterial({ map: haloTex(), color: col.clone().multiplyScalar(o.haloI || 1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    const halo = new THREE.Sprite(hm); halo.scale.setScalar(o.halo || 1.6); halo.position.copy(light.position); this.scene.add(halo);
    let bulb = null;
    if (o.bulb !== false) {
      bulb = new THREE.Mesh(new THREE.SphereGeometry(o.bulb || 0.09, 16, 12), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(o.bulbI || 6), fog: false }));
      bulb.position.copy(light.position); this.scene.add(bulb);
    }
    const base = light.intensity, hs = halo.scale.x, seed = pos[0] * 13.1 + pos[2] * 7.7;
    const lp = { light, halo, bulb, k: 1, set(k) { this.k = k; } };
    lp.item = this.item(o.name, 'lamp', light, [light, halo, bulb]);
    this.tick(lt => {
      const f = o.flicker ? 1 + o.flicker * (0.55 * noise1(lt * 7, seed) + 0.3 * noise1(lt * 17, seed + 1)) : 1;
      const k = lp.k * f;
      light.intensity = base * k; halo.material.opacity = clamp(k); halo.scale.setScalar(hs * (0.85 + 0.15 * f)); halo.visible = lp.k > 0.001;
      if (bulb) bulb.visible = lp.k > 0.02;
      light.visible = lp.k > 0.001;
    });
    return lp;
  },

  // ---- paper card: a flat cutout standing on its bottom edge.
  // o: px [cw, ch] canvas size; h world height (width from aspect); draw(g, cw, ch, lt, T); dynamic (redraw every frame);
  //    foot (px from the canvas bottom to the feet); rim (px of white outline); thick (m, card thickness);
  //    back: 'mirror' (default, turning shows the mirrored front) | paper colour string; pixel (nearest filter);
  //    glow (emissive strength, the card lights itself); shadow (cast, default true); pos, rotY, scale; name (an item of the layout)
  // returns a Group: .inner (flip / squash this one), .front, .canvas, .redraw(lt)
  card(o = {}) {
    const [cw, ch] = o.px || [512, 512], h = o.h || 1, w = h * cw / ch;
    const shared = !o.dynamic && o.key && X3.tc['card_' + o.key];
    const c = shared ? shared.image : o.canvas || cnv(cw, ch);
    const paint = (lt, T) => {
      if (shared) return;
      if (!o.draw) return;
      const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cw, ch);
      g.save(); o.draw(g, cw, ch, lt || 0, T || 0); g.restore();
      if (o.rim) outline2d(c, o.rim, o.rimColor);
    };
    paint(0, 0);
    const map = shared || tex3(c, { pixel: o.pixel });
    if (!o.dynamic && o.key) X3.tc['card_' + o.key] = map;
    const foot = (o.foot || 0) / ch * h;
    const geo = new THREE.PlaneGeometry(w, h); geo.translate(0, h / 2 - foot, 0);
    const matO = { map, alphaTest: o.alphaTest || 0.5, side: THREE.FrontSide, roughness: 0.92, metalness: 0, alphaToCoverage: !o.pixel };
    if (o.glow) Object.assign(matO, { emissive: new THREE.Color('#ffffff'), emissiveMap: map, emissiveIntensity: o.glow });
    const G = new THREE.Group(), inner = new THREE.Group(); G.add(inner);
    const front = new THREE.Mesh(geo, o.unlit ? new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, fog: o.fog !== false }) : new THREE.MeshStandardMaterial(matO));
    front.castShadow = o.shadow !== false; front.receiveShadow = o.receive !== false;
    inner.add(front);
    const thick = o.thick == null ? 0.015 : o.thick;
    let backC = null, backMap = map;
    if (o.back && o.back !== 'mirror') { backC = cnv(cw, ch); silhouette2d(c, backC, o.back); backMap = tex3(backC); }
    if (thick > 0 || o.back) {
      const bm = new THREE.MeshStandardMaterial({ map: backMap, alphaTest: 0.5, roughness: 0.95, color: backC ? '#ffffff' : '#cfcfcf' });
      if (o.glow) Object.assign(bm, { emissive: new THREE.Color('#ffffff'), emissiveMap: backMap, emissiveIntensity: o.glow * 0.8 });   // self-lit cards stay readable from behind (and in mirrors)
      const back = new THREE.Mesh(geo, bm); back.rotation.y = Math.PI; back.position.z = -thick; back.receiveShadow = true; inner.add(back);
      // stacked silhouettes between the faces = visible cardboard edge when the card turns
      const n = Math.max(0, Math.min(4, Math.round(thick / 0.005)) - 1);
      for (let i = 1; i <= n; i++) {
        const em = new THREE.MeshStandardMaterial({ map: backMap, alphaTest: 0.5, roughness: 1, color: '#9c9486', side: THREE.DoubleSide });
        const e = new THREE.Mesh(geo, em); e.position.z = -thick * i / (n + 1); inner.add(e);
      }
    }
    G.inner = inner; G.front = front; G.canvas = c; G.cw = cw; G.ch = ch; G.hW = h; G.wW = w; G.footW = foot;
    // o.state(lt, T) -> string: a dynamic card is repainted (and re-uploaded to the GPU) only when it changes.
    // Repainting a 640x700 card every frame cost ~12 ms in the review page (the upload, not the drawing).
    let lastState = null;
    G.redraw = (lt, T) => {
      if (o.state) { const st = o.state(lt, T); if (st === lastState) return; lastState = st; }
      paint(lt, T); map.needsUpdate = true; if (backC) { silhouette2d(c, backC, o.back); backMap.needsUpdate = true; }
    };
    if (o.dynamic) { G.userData.redraw = G.redraw; this.dyn.push(G); }
    if (o.pos) G.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.rotY) G.rotation.y = o.rotY;
    if (o.scale) G.scale.setScalar(o.scale);
    this.scene.add(G);
    if (!o.noItem) this.item(o.name, 'card', G, null, o.key);
    return G;
  },

  // ---- textured plane (ground, backdrops, sky). o: size [w, h], draw(g, cw, ch) or color, px (pixels per metre, default 96),
  //      flat (lies on the ground), unlit (sky: no lighting, no fog), repeat, pos, rotY, emissive draw
  plane(o = {}) {
    const [w, h] = o.size || [10, 10], ppm = o.ppm || 96;
    let mat;
    if (o.draw) {
      const cw = Math.min(4096, Math.round(w * ppm)), ch = Math.min(4096, Math.round(h * ppm));
      const map = ktex(o.key, cw, ch, o.draw, { repeat: o.repeat, pixel: o.pixel });
      mat = o.unlit ? new THREE.MeshBasicMaterial({ map, fog: false, transparent: !!o.transparent, depthWrite: !o.transparent })
        : new THREE.MeshStandardMaterial({ map, roughness: 0.95, alphaTest: o.alpha ? 0.5 : 0, transparent: false });
      if (o.intensity && o.unlit) mat.color.setScalar(o.intensity);
    } else mat = new THREE.MeshStandardMaterial({ color: o.color || '#888', roughness: 0.95 });
    const geo = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(geo, mat);
    if (o.flat) m.rotation.x = -Math.PI / 2;
    if (o.rotY) m.rotation.y = o.rotY;
    m.receiveShadow = !o.unlit; m.castShadow = !!o.cast;
    if (o.pos) m.position.set(o.pos[0], o.pos[1], o.pos[2]);
    this.scene.add(m);
    if (o.name) this.item(o.name, 'plane', m);          // ground and sky stay put; a named plane (a wall, a backdrop) can be moved
    return m;
  },

  // ---- cardboard box. o: size [w, h, d] (pivot at the bottom centre), ppm (texture pixels per metre),
  //      faces: { front, back, left, right, top } -> colour string or draw(g, cw, ch); default colour o.color;
  //      glow: { front: draw(g, cw, ch, lt) } emissive layer (lit windows), glowI, dynamicGlow (redraw every frame)
  box(o = {}) {
    const [w, h, d] = o.size || [1, 1, 1], ppm = o.ppm || 96, F = o.faces || {};
    const dims = { right: [d, h], left: [d, h], top: [w, d], bottom: [w, d], front: [w, h], back: [w, h] };
    const glowTex = {};
    const mk = (name) => {
      const f = F[name] == null ? o.color || '#b98c5a' : F[name];
      const [fw, fh] = dims[name];
      const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
      if (typeof f === 'function') {
        m.map = ktex(o.key && o.key + '_' + name, Math.max(8, Math.min(4096, Math.round(fw * ppm))), Math.max(8, Math.min(4096, Math.round(fh * ppm))), f);
      } else m.color = new THREE.Color(f);
      const gf = o.glow && o.glow[name];
      if (gf) {
        const c = cnv(Math.round(fw * ppm), Math.round(fh * ppm)); gf(c.getContext('2d'), c.width, c.height, 0);
        const t = tex3(c); m.emissive = new THREE.Color('#ffffff'); m.emissiveMap = t; m.emissiveIntensity = o.glowI || 2;
        glowTex[name] = { c, t, f: gf };
      }
      return m;
    };
    const mats = ['right', 'left', 'top', 'bottom', 'front', 'back'].map(mk);
    const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, h / 2, 0);
    const m = new THREE.Mesh(geo, mats); m.castShadow = o.shadow !== false; m.receiveShadow = true;
    if (o.pos) m.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.rotY) m.rotation.y = o.rotY;
    m.glow = glowTex;
    this.item(o.name, 'box', m, null, o.key);
    if (o.dynamicGlow) this.tick(lt => { for (const k in glowTex) { const G = glowTex[k], g = G.c.getContext('2d'); g.clearRect(0, 0, G.c.width, G.c.height); G.f(g, G.c.width, G.c.height, lt); G.t.needsUpdate = true; } });
    this.scene.add(m);
    return m;
  },

  // ---- floating particles (dust in light, fireflies, embers, snow). All positions are a function of time.
  // o: n, box [x0, y0, z0, x1, y1, z1], color, size (px at 1 m), vel [vx, vy, vz] (m/s, wraps inside the box),
  //    wobble (m), twinkle (0..1), intensity (HDR multiplier -> bloom), seed, fade (fade near box edges)
  motes(o = {}) {
    const n = o.n || 200, r = rng(o.seed || 7), b = o.box || [-5, 0, -5, 5, 4, 5];
    const pos = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = lerp(b[0], b[3], r()); pos[i * 3 + 1] = lerp(b[1], b[4], r()); pos[i * 3 + 2] = lerp(b[2], b[5], r());
      rnd[i * 4] = r(); rnd[i * 4 + 1] = r(); rnd[i * 4 + 2] = 0.4 + r() * 0.8; rnd[i * 4 + 3] = r();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
    const v = o.vel || [0.05, 0.08, 0];
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uB0: { value: new THREE.Vector3(b[0], b[1], b[2]) }, uBS: { value: new THREE.Vector3(b[3] - b[0], b[4] - b[1], b[5] - b[2]) },
        uVel: { value: new THREE.Vector3(v[0], v[1], v[2]) }, uSize: { value: (o.size || 6) * H / 1920 * 1.6 }, uWob: { value: o.wobble == null ? 0.15 : o.wobble },
        uCol: { value: new THREE.Color(o.color || '#ffe7b0').multiplyScalar(o.intensity || 2) }, uTw: { value: o.twinkle || 0 }, uA: { value: o.alpha == null ? 1 : o.alpha } },
      vertexShader: `
        uniform float uTime, uSize, uWob, uTw; uniform vec3 uB0, uBS, uVel; attribute vec4 aRnd; varying float vA;
        void main() {
          vec3 p = position + uVel * uTime * (0.6 + aRnd.z * 0.8);
          p = uB0 + mod(p - uB0, uBS);
          float ph = aRnd.x * 6.2831;
          p += vec3(sin(uTime * (0.4 + aRnd.y) + ph), sin(uTime * (0.5 + aRnd.w * 0.6) + ph * 1.7) * 0.6, cos(uTime * (0.35 + aRnd.x) + ph)) * uWob;
          vec3 q = (p - uB0) / uBS; float edge = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)); edge = min(edge, min(q.z, 1.0 - q.z));
          vA = smoothstep(0.0, 0.12, edge) * mix(1.0, 0.5 + 0.5 * sin(uTime * (2.0 + aRnd.y * 4.0) + ph * 3.0), uTw);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * aRnd.z * (10.0 / max(0.5, -mv.z));
        }`,
      fragmentShader: `
        uniform vec3 uCol; uniform float uA; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); a = a * a * vA * uA; if (a < 0.003) discard; gl_FragColor = vec4(uCol * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
    this.scene.add(pts);
    this.tick(lt => { mat.uniforms.uTime.value = lt + (o.t0 || 0); });
    return pts;
  },

  // ---- volumetric light shaft: open cone from `top` going down along `dir`, additive, fades with length and at the rim
  // o: top [x,y,z], len, r0 (radius at the source), r1 (radius at the end), color, opacity, tilt [rx, rz] radians
  shaft(o = {}) {
    const len = o.len || 4, geo = new THREE.CylinderGeometry(o.r0 || 0.15, o.r1 || 1.2, len, 40, 1, true);
    geo.translate(0, -len / 2, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(o.color || '#ffd9a0') }, uA: { value: o.opacity == null ? 0.35 : o.opacity }, uTime: { value: 0 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying float vY;
        void main() { vY = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uCol; uniform float uA, uTime; varying vec3 vN; varying vec3 vV; varying float vY;
        void main() { float d = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0); float y = clamp(vY, 0.0, 1.0); float a = d * sqrt(d) * y * sqrt(y) * uA * (0.85 + 0.15 * sin(uTime * 1.3 + y * 9.0)); a = clamp(a, 0.0, 1.0); gl_FragColor = vec4(uCol * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    const m = new THREE.Mesh(geo, mat);
    const t = o.top || [0, 4, 0]; m.position.set(t[0], t[1], t[2]);
    if (o.tilt) { m.rotation.x = o.tilt[0]; m.rotation.z = o.tilt[1]; }
    this.scene.add(m);
    this.tick(lt => { mat.uniforms.uTime.value = lt; });
    return m;
  },
  // big soft glow sprite (moon halo, screen glow)
  glow(pos, size, color, intensity = 1) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex(), color: new THREE.Color(color).multiplyScalar(intensity), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    s.position.set(pos[0], pos[1], pos[2]); s.scale.setScalar(size); this.scene.add(s); return s;
  },
};

// ---------------------------------------------------------------- card animation helpers
// pop-up book: card lies flat on the ground and stands up (pivot at its bottom edge)
function popUp3(c, lt, t0, d = 0.45) { const p = lt < t0 ? 0 : E.outBack(remap(lt, t0, t0 + d)); c.inner.rotation.x = -Math.PI / 2 * (1 - p); c.visible = lt >= t0 - 0.001; return p; }
// scale pop with bounce
function pop3(c, lt, t0, d = 0.35, s = 1) { const p = lt < t0 ? 0 : E.outBackBig(remap(lt, t0, t0 + d)); c.inner.scale.setScalar(Math.max(0.0001, p * s)); c.visible = p > 0.001; return p; }
// Paper Mario turn: rotate the card around its vertical axis by half a turn (dir = 1 or -1), p = 0..1
function flip3(c, p, dir = 1) { c.inner.rotation.y = Math.PI * E.io(clamp(p)) * dir; }
// hop: vertical offset for a jump [t0, t0 + d] with squash on landing
function hop3(c, lt, t0, d = 0.45, hgt = 0.35) {
  const p = remap(lt, t0, t0 + d);
  if (lt < t0 || lt > t0 + d + 0.18) { return 0; }
  const y = p < 1 ? Math.sin(Math.PI * p) * hgt : 0;
  const sq = p >= 1 ? Math.sin(remap(lt, t0 + d, t0 + d + 0.18) * Math.PI) * 0.12 : (p < 0.15 ? -0.06 * Math.sin(p / 0.15 * Math.PI) : 0.05 * Math.sin(Math.PI * p));
  c.inner.position.y = y; c.inner.scale.set(1 + sq * 0.8, 1 - sq, 1);
  return y;
}
// walking gait: bob + sway for a card moving at `speed` m/s; returns step phase for drawHog({walk})
function gait3(c, dist, o = {}) {
  const ph = dist / (o.stride || 0.32) * Math.PI;
  c.inner.position.y = Math.abs(Math.sin(ph)) * (o.bob == null ? 0.045 : o.bob);
  c.inner.rotation.z = Math.sin(ph) * (o.sway == null ? 0.05 : o.sway);
  return ph;
}

// ---------------------------------------------------------------- the paper hedgehog as a 3D card
// Uses drawHog() from the paper toolkit (scenes.js). Set c.hog = { mouth, look, armL, armR, walk, ... } in update();
// c.hog.walk = step phase from gait3 lifts the feet and swings the arms.
function hogCard(w, o = {}) {
  if (typeof drawHog !== 'function') throw new Error('hogCard: drawHog() is missing — copy the paper toolkit into scenes.js');
  const size = o.size || 460, cw = o.cw || 640, ch = o.ch || 700, foot = 34;
  let c = null;
  c = w.card({
    name: o.name || 'ёжик', px: [cw, ch], h: (o.h || 1.05) * ch / (size * 1.05), foot, rim: o.rim == null ? 7 : o.rim, dynamic: true, thick: 0.02, pos: o.pos, glow: o.self == null ? 0.32 : o.self, back: o.back,
    // repaint only when the pose changes: breathing time quantised to 1/5 s, walk phase to 1/16 of a step
    state(lt, T) { const s = (c && c.hog) || {}; return JSON.stringify(s, (k, v) => (k === 'walk' ? undefined : typeof v === 'number' ? Math.round(v * 100) / 100 : typeof v === 'function' ? undefined : v)) + '|' + Math.round(T * 5) + '|' + (s.walk == null ? '' : Math.round(s.walk / Math.PI * 8)) + '|' + blinkAt(T, o.seed || 0).toFixed(1); },
    draw(g, cw2, ch2, lt, T) {
      const s = (c && c.hog) || {};
      const walk = s.walk;
      const opts = Object.assign({ kind: o.kind || 'adult', t: T, blink: blinkAt(T, o.seed || 0) }, s);
      if (walk != null) {
        opts.armL = (s.armL == null ? 0.15 : s.armL) + Math.sin(walk) * 0.35;
        opts.armR = (s.armR == null ? 0.15 : s.armR) - Math.sin(walk) * 0.35;
      }
      s.pre && s.pre(g, cw2, ch2, lt, T);
      // short legs with paw pads under the body (they lift in turn while walking), the body stands on them
      const L = size * 0.1, base = ch2 - foot, cx = cw2 / 2, col = (HOG_KINDS[o.kind || 'adult'] || HOG_KINDS.adult).mask;
      for (const sx of [-1, 1]) {
        const lift = walk != null ? Math.max(0, Math.sin(walk) * sx) * size * 0.05 : 0, lx = cx + sx * size * 0.1;
        cut(g, inf => rectP(lx - size * 0.038, base - L - size * 0.06, size * 0.076, L + size * 0.05 - lift, inf), col, { seed: 610 + sx, edge: 0, amp: 1.5, shadow: false });
        cut(g, inf => ellP(lx + sx * size * 0.018, base - lift - size * 0.022, size * 0.066 + inf, size * 0.032 + inf, 0, 18), col, { seed: 612 + sx, edge: 0, amp: 1.5, shadow: false });
        for (let k = -1; k <= 1; k++) circle(g, lx + sx * size * 0.018 + k * size * 0.03, base - lift - size * 0.012, size * 0.012, '#8e8e94');
      }
      if (s.fedora) opts.prop = (ctx, S) => { s.prop && s.prop(ctx, S); fedora(ctx, 0.02 * S, -0.9 * S, 0.66 * S, -0.1); };
      drawHog(g, cx, base - L, size, opts);
    },
  });
  c.hog = Object.assign({}, o.hog || {});
  c.redraw(0, 0);
  return c;
}

// ---------------------------------------------------------------- the pixel hedgehog (HD-2D sprite of our paper hog)
// 34 x 38 px procedural sprite: grey quills, dark mask, big eyes, light muzzle. frame: 'idle' | 'walk'; step 0..3; o.look -1..1
const PIX_HOG = { w: 34, h: 38 };
function pixelHog(g, o = {}) {
  const Wd = PIX_HOG.w, Hd = PIX_HOG.h, step = o.step || 0, walk = o.frame === 'walk';
  const bob = walk ? (step % 2 ? 1 : 0) : (o.breath ? 1 : 0);
  const C = { ol: '#141418', d: '#3a3a40', m: '#505058', l: '#6c6c74', h: '#8e8e96', tip: '#b4b4bb', mask: '#1e1e23', face: '#a4a4aa', face2: '#d0d0d4', eye: '#f6f4ee', pup: '#101013', paw: '#c0c0c6' };
  const grid = Array.from({ length: Hd }, () => Array(Wd).fill(null));
  const put = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < Wd && y < Hd) grid[y][x] = c; };
  const cx = 17, cy = 20 + bob, rx = 11.5, ry = 13;
  const r = rng(11);
  // body with spiky rim (quills stick out at the top and sides)
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, a = Math.atan2(dy, dx);
    const spike = dy < 0.35 ? Math.pow(Math.max(0, Math.sin(a * 13 + 1.57)), 4) * 0.3 * (1 - Math.abs(dx) * 0.4) : 0;
    const d = Math.pow(Math.abs(dx), 2.4) + Math.pow(Math.abs(dy), 2.4);
    if (d > 1.02 && d <= 1 + spike) { put(x, y, C.tip); continue; }            // light quill tips sticking out
    if (d <= 1 + spike) {
      const streak = ((x * 3 + y * 2 + ((r() * 3) | 0)) % 7);
      const light = (dx < -0.2 && dy < 0) ? 1 : dx > 0.45 ? -1 : 0;
      put(x, y, [C.d, C.m, C.m, C.l, C.l, C.m, C.h][Math.max(0, Math.min(6, streak + light))]);
    }
  }
  // mask band, eyes, muzzle, nose, mouth
  const lx = Math.round((o.look || 0) * 1);
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    const ex = (x + 0.5 - cx) / 8.5, ey = (y + 0.5 - (cy - 5)) / 3.2;
    if (ex * ex + ey * ey <= 1) put(x, y, C.mask);
    const fx = (x + 0.5 - cx) / 5.2, fy = (y + 0.5 - (cy + 1.5)) / 3.6;
    if (fx * fx + fy * fy <= 1) put(x, y, fx * fx + fy * fy < 0.45 ? C.face2 : C.face);
  }
  for (const sx of [-1, 1]) {
    const ex = cx + sx * 4.5 - 2, ey = cy - 8;                         // big round eyes: 4 x 5 with a 2 x 3 pupil and a glint
    const EYE = ['.XX.', 'XXXX', 'XXXX', 'XXXX', '.XX.'];
    EYE.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'X') put(ex + x, ey + y, o.blink && y !== 3 ? C.mask : o.blink ? C.pup : C.eye); }));
    if (!o.blink) { const px = ex + 1 + lx + (lx === 0 ? (sx < 0 ? 1 : 0) : 0); for (let y = 1; y < 4; y++) { put(px, ey + y, C.pup); put(px + 1 - (px + 1 > ex + 3 ? 2 : 0), ey + y, C.pup); } put(px, ey + 1, C.eye); }
  }
  put(cx - 1, cy - 1, C.pup); put(cx, cy - 1, C.pup); put(cx - 1, cy - 2, C.pup); put(cx, cy - 2, C.pup);   // nose
  if (o.mouth === 'smile') { put(cx - 2, cy + 1, C.pup); put(cx - 1, cy + 2, C.pup); put(cx, cy + 2, C.pup); put(cx + 1, cy + 1, C.pup); }
  else put(cx - 0.5, cy + 1.5, C.pup);
  // arms (swing while walking) and feet (lift in turn)
  const sw = walk ? [0, 1, 0, -1][step] : 0;
  for (const sx of [-1, 1]) {
    const ax = sx < 0 ? cx - 12 : cx + 11, ay = cy + 1 + sw * sx;
    for (let y = 0; y < 5; y++) put(ax, ay + y, C.mask), put(ax + (sx < 0 ? 1 : -1) * 0, ay + y, C.mask);
    put(ax, ay + 5, C.paw);
    const lift = walk && ((step === 1 && sx < 0) || (step === 3 && sx > 0)) ? 1 : 0;
    const fx = cx + sx * 4 - 1, fy = Hd - 3 - lift;
    for (let x = 0; x < 3; x++) { put(fx + x, fy, C.mask); put(fx + x, fy + 1, C.mask); }
  }
  // 1 px dark outline around the silhouette
  const out = grid.map(row => row.slice());
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (!grid[y][x]) {
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => grid[y + b] && grid[y + b][x + a]);
    if (n) out[y][x] = C.ol;
  }
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (out[y][x]) { g.fillStyle = out[y][x]; g.fillRect(x, y, 1, 1); }
}
// pixel hog card: c.pix = { frame, step, look, blink, mouth }
function pixelHogCard(w, o = {}) {
  let c = null;
  c = w.card({ name: o.name || 'пиксельный ёжик', px: [PIX_HOG.w, PIX_HOG.h], h: o.h || 0.95, pixel: true, dynamic: true, pos: o.pos, thick: 0.02, glow: o.self == null ? 0.45 : o.self,
    draw(g, cw, ch, lt, T) { pixelHog(g, Object.assign({ blink: blink3(T, 3) > 0.5 }, (c && c.pix) || {})); } });
  c.pix = Object.assign({}, o.pix || {});
  c.redraw(0, 0);
  return c;
}

// ---------------------------------------------------------------- image / sprite as a paper card
// key: IMG key (photo cut-out with alpha, pixel sprite...). o: h (height of the image in metres), pos, rotY, flip (mirror),
// pixel (true = nearest-neighbour upscale, keeps pixel art crisp), rim (paper edge px, default 7), self (self-light), shadow.
// c.pt(fx, fy) -> [x, y] in the card's inner group for a point of the image (fractions): glue hats, glows, props there
//   const hat = w.card({...}); mon.inner.add(hat); const [x, y] = mon.pt(0.52, 0.02); hat.position.set(x, y, 0.015);
function spriteCard(w, key, o = {}) {
  const im = IMG[key]; if (!im) console.warn('spriteCard: no image', key);
  const iw = im ? im.width : 100, ih = im ? im.height : 100;
  const k = o.pixel === false ? 1 : Math.max(1, Math.round((o.px || 700) / Math.max(iw, ih)));
  const pad = 24, cw = iw * k + pad * 2, ch = ih * k + pad * 2;
  const c = w.card({ name: o.name || key, key: o.key, px: [cw, ch], h: (o.h || 1) * ch / (ih * k), foot: pad, rim: o.rim == null ? 7 : o.rim, thick: o.thick == null ? 0.02 : o.thick,
    glow: o.self == null ? 0.3 : o.self, pos: o.pos, rotY: o.rotY, shadow: o.shadow,
    draw(g) { if (!im) return; g.imageSmoothingEnabled = o.pixel === false; g.save(); if (o.flip) { g.translate(cw, 0); g.scale(-1, 1); } g.drawImage(im, pad, pad, iw * k, ih * k); g.restore(); } });
  c.pt = (fx, fy) => [((pad + (o.flip ? 1 - fx : fx) * iw * k) / cw - 0.5) * c.wW, (1 - (pad + fy * ih * k) / ch) * c.hW - c.footW];
  return c;
}
