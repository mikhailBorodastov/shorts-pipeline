// Демо-сцена техники «3D-диорама» (S14, docs/studio/stage14-looks.md §5): превью лука в «Стиль → Визуалы».
// Стенд: /tpl/stand3d.html?scene=/render/looks/diorama.js&parts=element&lookj=<window.LOOK>. Ручки fx.* применяет stage3d.js (lookFx), cards.facing / style3d — rig.js / props3d.js.
// Свет — вечерний (fx 'dusk'): время суток задаёт сцена, не лук. Герои: 'hog' — hogCard, с картинкой — spriteCard; без героев — домики и фонарь.
const LK = window.LOOK || {};
const LPAL = (LK.palette && LK.palette.length >= 3 ? LK.palette : ['#e9dcc0', '#b98c5a', '#6f7f99', '#2c3550', '#c8202b', '#ffd23f']);
const HEROES = (LK.heroes || []).slice(0, 3);
const PICS = Object.fromEntries(HEROES.map((h, i) => [h.img ? 'hero' + i : null, h.img]).filter(x => x[0]));
const WORLD = world3d({
  fx: 'dusk', bg: LPAL[3] || '#2c3550', fov: 30,
  build(w) {
    w.ambient('#9aa8d0', '#5a4a3a', 0.7);
    w.sun({ dir: [-5, 9, 6], intensity: 1.8, color: '#ffe2b8', area: 8 });
    w.plane({ key: 'ld_floor', size: [14, 10], ppm: 40, flat: true, pos: [0, 0, 0], draw(g, cw, ch) { g.fillStyle = LPAL[1] || '#b98c5a'; g.fillRect(0, 0, cw, ch); if (typeof grainOver === 'function') { g.beginPath(); g.rect(0, 0, cw, ch); grainOver(g, 0.5); } } });
    w.plane({ key: 'ld_back', size: [16, 8], ppm: 30, pos: [0, 4, -4], draw(g, cw, ch) { const gr = g.createLinearGradient(0, 0, 0, ch); gr.addColorStop(0, LPAL[2] || '#6f7f99'); gr.addColorStop(1, LPAL[3] || '#2c3550'); g.fillStyle = gr; g.fillRect(0, 0, cw, ch); } });
    w.box({ size: [1.4, 1.6, 1.2], color: LPAL[0], pos: [-1.3, 0, -1.8], name: 'дом 1' });
    w.box({ size: [1.1, 2.3, 1], color: LPAL[2], pos: [1.35, 0, -2.2], name: 'дом 2' });
    w.box({ size: [0.6, 0.5, 0.6], color: LPAL[4] || '#c8202b', pos: [0.9, 0, 0.9], name: 'ящик' });
    w.lamp({ pos: [-0.5, 2.2, -1.2], color: '#ffc36b', intensity: 10, dist: 7 });
    // ёлки-карточки на разной глубине: ближние и дальние — видно глубину резкости и тилт-шифт
    const tree = (g, cw, ch) => { g.fillStyle = '#6b4a2e'; g.fillRect(cw * 0.45, ch * 0.78, cw * 0.1, ch * 0.22);
      for (let k = 0; k < 3; k++) { const y0 = ch * (0.05 + k * 0.22), y1 = ch * (0.42 + k * 0.2); g.beginPath(); g.moveTo(cw / 2, y0); g.lineTo(cw * (0.12 - k * 0.03), y1); g.lineTo(cw * (0.88 + k * 0.03), y1); g.closePath();
        g.fillStyle = ['#3f7a4a', '#356a40', '#2c5a36'][k]; g.fill(); } };
    [[-1.0, 0, 2.4, 0.9], [0.95, 0, 2.9, 1.0], [-2.4, 0, -3.2, 1.8], [2.6, 0, -3.4, 2.1], [0.2, 0, -3.6, 1.5]].forEach(([x, y, z, hh], i) =>
      w.card({ key: 'ld_tree', px: [300, 420], h: hh, rim: 6, draw: tree, pos: [x, y, z], name: 'ёлка ' + (i + 1) }));
    // окна-огоньки (светятся — видно свечение) и табличка с названием лука
    w.lamp({ pos: [-1.3, 1.1, -1.15], color: '#ffd27a', intensity: 3, dist: 2.5 });
    w.lamp({ pos: [1.35, 1.7, -1.65], color: '#ffd27a', intensity: 3, dist: 2.5 });
    w.card({ px: [640, 220], h: 0.42, rim: 8, pos: [0, 1.75, -0.9], name: 'табличка', draw(g, cw, ch) {
      g.fillStyle = '#f4efe3'; g.fillRect(0, 0, cw, ch); g.strokeStyle = 'rgba(80,120,190,.35)'; g.lineWidth = 2;
      for (let y = 30; y < ch; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(cw, y); g.stroke(); }
      g.fillStyle = '#1d1b22'; g.font = '700 88px Caveat, cursive'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(LK.label || 'Визуал', cw / 2, ch / 2 + 4); } });
    w.motes({ n: 120, box: [-4, 0.2, -3, 4, 3, 2], color: '#ffe9b0' });
    const spots = [[0, 0, 0.3], [-0.85, 0, 0.6], [0.8, 0, 0.5]];
    const main = HEROES.findIndex(h => h.role === 'main'), order = main > 0 ? [main, ...HEROES.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...HEROES.keys()];
    w.heroes = order.map((hi, k) => {
      const h = HEROES[hi], pos = spots[k], hh = k ? 0.5 : 0.7;
      if (h.kind === 'hog' && typeof hogCard === 'function') return hogCard(w, { pos, h: hh, name: h.name || 'ёжик' });
      if (IMG['hero' + hi]) return spriteCard(w, 'hero' + hi, { pos, h: hh, pixel: false, name: h.name || 'герой' });
      return w.box({ size: [0.5, hh, 0.3], color: LPAL[5] || '#ffd23f', pos, name: h.name || 'герой' });
    });
  },
  update(w, lt) {
    w.camKeys(lt, [[0, [-0.7, 2.1, 8.6], [0, 0.9, -0.6]], [5, [0.7, 1.8, 7.8], [0, 0.85, -0.6]]], { handheld: 0.02 });
    (w.heroes || []).forEach((c, k) => { if (c && c.position) c.position.y = Math.abs(Math.sin(lt * 2.4 + k)) * 0.06; });
  },
});
const ELEMENT = { t: 1.5, len: 5, draw(ctx, T) {
  WORLD.draw(ctx, T, 5, T);
  if (typeof vignette === 'function') vignette(ctx, LOOKV('post.vignette', 0.45));
  if (typeof lookPost === 'function') lookPost(ctx);
} };
