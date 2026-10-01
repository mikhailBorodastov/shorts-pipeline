// Пустая сцена канала (S9, channel_api.EMPTY_PREFABS): пол и задник цветами палитры канала. Предметы и персонажи — из библиотеки (lib:…).
const PICS = {};
const STAGE_COL = {"floor": "#6b5a48", "back": "#2c3550", "top": "#4d6085"};
function stageFloor(g, cw, ch) {
  g.fillStyle = STAGE_COL.floor; g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${0.03 + (i % 5) * 0.01})`; g.fillRect((i * 97) % cw, (i * 53) % ch, 6 + (i % 7) * 4, 2); }
}
function stageBack(g, cw, ch) {
  const gr = g.createLinearGradient(0, 0, 0, ch); gr.addColorStop(0, STAGE_COL.top); gr.addColorStop(1, STAGE_COL.back);
  g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
}
const PREFABS = {
  stage: { kind: 'env', build(w) {
    w.plane({ key: 'st_floor', size: [8, 6], ppm: 60, draw: stageFloor, flat: true, pos: [0, 0, 0] });
    w.plane({ key: 'st_back', size: [10, 5], ppm: 40, draw: stageBack, pos: [0, 2.5, -2.5] });
  } },
};
