// Бип — бумажный робот демо-канала Claude Studio. Вырезан из цветной бумаги: бирюзовая голова-экран,
// оранжевый корпус, серые руки и ноги, антенна с красным шариком. Лицо горит на экране (4 эмоции).
// Части — на листе 1000×1000 в координатах покоя (rig.json, риг 'pins': каждая часть на своей кости).
(() => {
  const TEAL = '#7cc7c0', TEAL2 = '#5aa9a3', ORG = '#f0a046', ORG2 = '#d9822c', GR = '#b8c1c8', GR2 = '#8e99a3',
    SCR = '#26313d', GLOW = '#8ff3ff', INK = '#1d2530', RED = '#e2574c', CREAM = '#fbf3e2';
  const o = (seed, x = {}) => Object.assign({ seed, amp: 2.4, step: 10, edge: 4, edgeColor: CREAM, blur: 9 }, x);
  const flat = (seed, x = {}) => Object.assign({ seed, amp: 1.2, step: 8, edge: 0, shadow: false }, x);
  const rr = (x, y, w, h, r) => inf => {                      // скруглённый прямоугольник (по часовой)
    const X = x - inf, Y = y - inf, Wd = w + 2 * inf, Hd = h + 2 * inf, R = Math.max(2, r + inf), pts = [];
    const c = [[X + Wd - R, Y + R, -Math.PI / 2], [X + Wd - R, Y + Hd - R, 0], [X + R, Y + Hd - R, Math.PI / 2], [X + R, Y + R, Math.PI]];
    for (const [cx, cy, a0] of c) for (let i = 0; i <= 6; i++) { const a = a0 + i / 6 * Math.PI / 2; pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
    return pts;
  };
  const capsule = (ax, ay, bx, by, ra, rb) => inf => {
    const a = Math.atan2(by - ay, bx - ax), pts = [], n = 12;
    for (let i = 0; i <= n; i++) { const t = a + Math.PI / 2 + i / n * Math.PI; pts.push([ax + Math.cos(t) * (ra + inf), ay + Math.sin(t) * (ra + inf)]); }
    for (let i = 0; i <= n; i++) { const t = a - Math.PI / 2 + i / n * Math.PI; pts.push([bx + Math.cos(t) * (rb + inf), by + Math.sin(t) * (rb + inf)]); }
    return pts;
  };
  const bolt = (g, x, y, r = 9) => { circle(g, x, y, r, GR2); circle(g, x - r * 0.25, y - r * 0.25, r * 0.45, '#dfe5ea'); };
  const glowOn = g => { g.shadowColor = GLOW; g.shadowBlur = 18; };
  const stroke = (g, w, col, fn) => { g.save(); glowOn(g); g.strokeStyle = col; g.lineWidth = w; g.lineCap = g.lineJoin = 'round'; g.beginPath(); fn(); g.stroke(); g.restore(); };
  const fillG = (g, col, fn) => { g.save(); glowOn(g); g.fillStyle = col; g.beginPath(); fn(); g.fill(); g.restore(); };
  const EY = 295, EX = [445, 555];

  const arm = (g, sx) => {
    const x0 = 500 + sx * 118, x1 = 500 + sx * 150;
    cut(g, capsule(x0, 490, x1, 600, 30, 26), GR, o(40 + sx));
    g.fillStyle = GR2; for (const d of [0, 1]) g.fillRect(x0 + (x1 - x0) * (0.35 + d * 0.3) - 26, 525 + d * 34, 52, 5);
  };
  const fore = (g, sx) => {
    const x0 = 500 + sx * 150, x1 = 500 + sx * 155;
    cut(g, capsule(x0, 600, x1, 690, 26, 22), GR, o(50 + sx));
    bolt(g, x0, 600, 10);
    cut(g, capsule(x1 - 22, 700, x1 - 30, 735, 12, 10), GR2, o(55 + sx, { edge: 3 }));   // клешня: два пальца
    cut(g, capsule(x1 + 22, 700, x1 + 30, 735, 12, 10), GR2, o(57 + sx, { edge: 3 }));
  };
  const leg = (g, sx) => {
    const x = 500 + sx * 52;
    cut(g, capsule(x, 740, x, 880, 30, 28), GR, o(60 + sx));
    for (const y of [785, 825]) { g.fillStyle = GR2; g.fillRect(x - 28, y, 56, 6); }
  };
  const foot = (g, sx) => {
    const x = 500 + sx * 62;
    cut(g, rr(x - 62, 885, 124, 50, 22), ORG2, o(70 + sx));
    bolt(g, x + sx * 30, 910, 7);
  };

  character({
    id: 'eed5ab5f3', name: 'Бип', skeleton: 'robot', rig: 'parts', h: 0.7,
    parts: {
      legL(g) { leg(g, -1); },
      legR(g) { leg(g, 1); },
      footL(g) { foot(g, -1); },
      footR(g) { foot(g, 1); },
      body(g) {
        cut(g, rr(470, 410, 60, 60, 10), GR2, o(8, { edge: 3 }));                       // шея
        const b = cut(g, rr(375, 445, 250, 310, 46), ORG, o(10, { edge: 6 }));
        g.save(); path(g, b); g.clip();
        cut(g, rr(375, 690, 250, 80, 10), ORG2, flat(11, { amp: 2.4 }));                   // нижняя полоса
        g.restore();
        cut(g, rr(425, 500, 150, 120, 22), CREAM, o(12, { edge: 0, blur: 5 }));          // панель на груди
        cut(g, inf => ellP(470, 560, 26 + inf, 26 + inf), RED, o(13, { edge: 3 }));      // кнопка
        ['#79c26a', '#f2d04a', GLOW].forEach((c, i) => circle(g, 535, 530 + i * 30, 9, c));      // лампочки
        for (const [x, y] of [[395, 470], [605, 470], [395, 735], [605, 735]]) bolt(g, x, y, 8);
      },
      armL(g) { arm(g, -1); },
      foreL(g) { fore(g, -1); },
      armR(g) { arm(g, 1); },
      foreR(g) { fore(g, 1); },
      antenna(g) {
        cut(g, capsule(500, 172, 500, 100, 8, 7), GR2, o(20, { edge: 3, amp: 1 }));
        cut(g, inf => ellP(500, 86, 24 + inf, 24 + inf), RED, o(21, { edge: 4 }));
        circle(g, 492, 78, 7, '#ffb3a8');
      },
      head(g) {
        cut(g, rr(330, 270, 40, 70, 14), TEAL2, o(30, { edge: 3 }));                     // уши-динамики
        cut(g, rr(630, 270, 40, 70, 14), TEAL2, o(31, { edge: 3 }));
        cut(g, rr(355, 170, 290, 250, 60), TEAL, o(1, { edge: 6 }));
        cut(g, rr(390, 215, 220, 165, 38), SCR, o(2, { edge: 0, blur: 4, amp: 1.2 }));  // экран
        g.save(); g.globalAlpha = 0.18; g.fillStyle = '#fff'; g.beginPath(); g.ellipse(445, 240, 40, 12, -0.3, 0, TAU); g.fill(); g.restore();
        bolt(g, 375, 190, 7); bolt(g, 625, 190, 7);
      },
      face(g) {                                                                           // покой: круглые глаза, ровная улыбка
        for (const x of EX) fillG(g, GLOW, () => g.ellipse(x, EY, 22, 28, 0, 0, TAU));
        stroke(g, 8, GLOW, () => g.arc(500, 318, 34, 0.2 * Math.PI, 0.8 * Math.PI));
      },
      face_joy(g) {                                                                       // радость: глаза-дуги, широкая улыбка
        for (const x of EX) stroke(g, 10, GLOW, () => g.arc(x, EY + 10, 22, 1.1 * Math.PI, 1.9 * Math.PI));
        fillG(g, GLOW, () => { g.moveTo(455, 322); g.quadraticCurveTo(500, 375, 545, 322); g.closePath(); });
      },
      face_wow(g) {                                                                       // удивление: большие глаза, рот «о»
        for (const x of EX) { fillG(g, GLOW, () => g.arc(x, EY - 4, 30, 0, TAU)); circle(g, x, EY - 4, 11, SCR); }
        stroke(g, 8, GLOW, () => g.ellipse(500, 345, 13, 17, 0, 0, TAU));
      },
      face_sad(g) {                                                                       // грусть: глаза вниз, брови домиком
        for (const [i, x] of EX.entries()) {
          fillG(g, GLOW, () => g.ellipse(x, EY + 8, 18, 20, 0, 0, TAU));
          stroke(g, 7, GLOW, () => { g.moveTo(x - 24, EY - 22 + (i ? -8 : 8)); g.lineTo(x + 24, EY - 22 + (i ? 8 : -8)); });
        }
        stroke(g, 8, GLOW, () => g.arc(500, 362, 28, 1.2 * Math.PI, 1.8 * Math.PI));
      },
    },
  });
})();
