// Проверочный персонаж рига частей (S4): туловище-гусеница гнётся по трём костям (bend), рука — на булавке (pins), два лица.
character({
  id: 'test-worm', name: 'Проверка рига', skeleton: 'worm', rig: 'parts', h: 0.6,
  parts: {
    body(g) { g.fillStyle = '#6aa84f'; g.beginPath(); g.roundRect(440, 200, 120, 700, 60); g.fill(); g.fillStyle = '#38761d'; for (let y = 260; y < 880; y += 70) g.fillRect(440, y, 120, 12); },
    arm(g) { g.fillStyle = '#e69138'; g.beginPath(); g.roundRect(560, 470, 220, 50, 25); g.fill(); },
    face(g) { g.fillStyle = '#fff'; g.beginPath(); g.arc(475, 280, 22, 0, TAU); g.arc(525, 280, 22, 0, TAU); g.fill(); g.fillStyle = '#000'; g.beginPath(); g.arc(478, 282, 9, 0, TAU); g.arc(528, 282, 9, 0, TAU); g.fill(); },
    face_joy(g) { g.strokeStyle = '#000'; g.lineWidth = 8; g.beginPath(); g.arc(475, 290, 18, Math.PI, 0); g.stroke(); g.beginPath(); g.arc(525, 290, 18, Math.PI, 0); g.stroke(); g.beginPath(); g.arc(500, 320, 30, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke(); },
  },
});
