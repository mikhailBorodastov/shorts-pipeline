// Демо-сцена техники «Бумажная аппликация» (S14, docs/studio/stage14-looks.md §5): превью лука в «Стиль → Визуалы».
// Стенд: /render/page.html?scene=/render/looks/paper.js&parts=element&lookj=<window.LOOK>. Читает LOOK: ручки (paper.*, post.*), palette, heroes, label.
// Герои: kind 'hog' — бумажный ёжик тулкита (drawHog), с картинкой (img) — вклейка-стикер; без героев — бумажные предметы.
const LK = window.LOOK || {};
const LPAL = (LK.palette && LK.palette.length >= 3 ? LK.palette : ['#f3f0e6', '#c9a57a', '#7d8590', '#1d1b22', '#c8202b', '#ffd23f']);
const HEROES = (LK.heroes || []).slice(0, 3);
const PICS = Object.fromEntries(HEROES.map((h, i) => [h.img ? 'hero' + i : null, h.img]).filter(x => x[0]));
const ELEMENT = {
  t: 1.2, len: 5,
  draw(ctx, T) {
    const light = c => { const n = parseInt(c.slice(1), 16); return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) > 140; };
    const bgCols = [LPAL[0], ...LPAL.slice(1, 4)];
    paperBG(ctx, 'lookdemo_' + bgCols.join(''), bgCols, T, 1);
    // заметка с названием лука
    note(ctx, W * 0.5, 300, 720, 190, -0.03 + Math.sin(T * 0.8) * 0.01, LK.label || 'Визуал', { size: 74 });
    // предметы-вырезки: «фото», круг, полоса
    const bob = Math.sin(T * 1.6) * 10;
    cutRect(ctx, 120, 560 + bob, 360, 260, LPAL[2] || '#7d8590', { seed: 4 });
    cutRect(ctx, 150, 590 + bob, 300, 200, light(LPAL[0]) ? '#2b2b33' : '#e8e2d2', { seed: 5, edge: 0 });
    cutEll(ctx, 830, 640 - bob, 130, 130, LPAL[4] || '#c8202b', { seed: 7 });
    label(ctx, 820, 860, 'пример', { size: 46, rot: 0.04, seed: 11 });
    // герои
    const main = HEROES.findIndex(h => h.role === 'main'), order = main > 0 ? [main, ...HEROES.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...HEROES.keys()];
    const spots = [[W * 0.5, 1480, 560], [W * 0.2, 1500, 380], [W * 0.8, 1500, 380]];
    order.forEach((hi, k) => {
      const h = HEROES[hi], [x, y, sz] = spots[k], b2 = Math.sin(T * 2.2 + k) * 8;
      if (h.kind === 'hog' && typeof drawHog === 'function') drawHog(ctx, x, y + b2, sz, { look: [Math.sin(T * 0.7) * 0.4, 0], t: T});
      else if (IMG['hero' + hi]) sticker(ctx, IMG['hero' + hi], x, y - sz * 0.5 + b2, sz * 0.95, Math.sin(T + k) * 0.03);
      else { cutEll(ctx, x, y - sz * 0.45 + b2, sz * 0.32, sz * 0.42, LPAL[3] || '#555', { seed: 20 + k }); label(ctx, x - sz * 0.3, y - sz * 0.05, h.name || 'герой', { size: 40, seed: 30 + k }); }
    });
    if (!HEROES.length) { cutRect(ctx, 300, 1120 + bob, 480, 320, LPAL[1] || '#c9a57a', { seed: 12 }); cutEll(ctx, 540, 1280 + bob, 90, 90, LPAL[5] || '#ffd23f', { seed: 13 }); }
    if (typeof vignette === 'function') vignette(ctx, LOOKV('post.vignette', 0.45));
    if (typeof lookPost === 'function') lookPost(ctx);
  },
};
