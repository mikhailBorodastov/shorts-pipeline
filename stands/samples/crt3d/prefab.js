// Образец 3D-пропса (S3): бежевый ЭЛТ-монитор 17" середины 2000-х, фигурами кодом (props3d.js).
// Смотреть: /tpl/stand3d.html?prop=/render/samples/crt3d/prefab.js&view=1  (&style=toy — игрушечный стиль)
prop3d({
  name: 'ЭЛТ-монитор', h: 0.47,
  params: { screen: 'xp', glow: '#9fd0ff' },
  build(w, o) {
    const G = new THREE.Group();
    const BEIGE = '#d9d0ba', SHADE = '#c4b89d', DARK = '#3b3a37';
    const Y = 0.1;                                       // низ корпуса над столом (ножка)
    // подставка: диск + шейка
    G.add(P3.lathe([[0, 0], [0.13, 0], [0.135, 0.008], [0.11, 0.022], [0.04, 0.03], [0, 0.03]], SHADE));
    G.add(P3.box(0.07, Y - 0.02, 0.09, SHADE, { pos: [0, 0.025, -0.02] }));
    // лицевая рамка
    const FW = 0.42, FH = 0.37, FD = 0.07, FZ = 0.1;
    G.add(P3.box(FW, FH, FD, BEIGE, { pos: [0, Y, FZ] }));
    // кинескоп назад: усечённая пирамида (4 грани), чуть сплюснута по высоте
    // (геометрию поворачиваем до P3.part: линии сгибов строятся по готовой форме)
    const hg = new THREE.CylinderGeometry(0.14, 0.27, 0.3, 4, 1); hg.rotateY(Math.PI / 4); hg.rotateX(-Math.PI / 2); hg.scale(1, 0.88, 1);
    const HY = Y + FH * 0.5, HZ = FZ - FD / 2 - 0.15;
    G.add(P3.part(hg, SHADE, { pos: [0, HY, HZ] }));
    G.add(P3.box(0.2, 0.15, 0.05, SHADE, { pos: [0, HY - 0.075, HZ - 0.17] }));          // задняя крышка
    // экран: утопленная тёмная рамка + светящаяся картинка
    const SW = 0.33, SH = 0.255, SY = Y + FH * 0.55;
    G.add(P3.box(SW + 0.02, SH + 0.02, 0.012, DARK, { pos: [0, SY - (SH + 0.02) / 2, FZ + FD / 2 - 0.004], edges: false }));
    const scr = P3.sticker(SW, SH, (g, cw, ch, T) => drawXP(g, cw, ch, P3.p(o, 'screen', 'xp'), T), { glow: 1.1, px: 640, pos: [0, SY, FZ + FD / 2 + 0.004], grain: false });
    G.add(scr);
    const lamp = new THREE.PointLight(P3.p(o, 'glow', '#9fd0ff'), 0.6, 1.6, 1.8); lamp.position.set(0, SY, FZ + 0.25); G.add(lamp);
    // кнопки и индикатор под экраном — наклейки и маленькие детали
    const BY = Y + 0.035;
    G.add(P3.cyl(0.012, 0.012, 0.008, SHADE, { seg: 16, center: true, rot: [Math.PI / 2, 0, 0], pos: [FW / 2 - 0.05, BY, FZ + FD / 2 + 0.003] }));
    G.add(P3.sticker(0.012, 0.012, (g, cw, ch) => { g.fillStyle = '#6dff7a'; g.beginPath(); g.arc(cw / 2, ch / 2, cw * 0.42, 0, TAU); g.fill(); }, { glow: 2, px: 32, pos: [FW / 2 - 0.08, BY, FZ + FD / 2 + 0.002], grain: false }));
    for (let i = 0; i < 4; i++) G.add(P3.box(0.016, 0.008, 0.006, SHADE, { pos: [-0.02 + i * 0.024, BY - 0.004, FZ + FD / 2 + 0.002], edges: false }));
    G.add(P3.sticker(0.1, 0.018, (g, cw, ch) => { g.fillStyle = '#6c665a'; g.font = `700 ${ch * 0.7}px Rubik`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('SyncMaster 17"', 0, ch / 2); }, { px: 256, pos: [-FW / 2 + 0.075, BY, FZ + FD / 2 + 0.002] }));
    return G;
  },
});

// рабочий стол Windows XP («Безмятежность» + панель задач), рисуется в наклейку экрана
function drawXP(g, cw, ch, mode, T) {
  const sky = g.createLinearGradient(0, 0, 0, ch * 0.7);
  sky.addColorStop(0, '#2f6fd6'); sky.addColorStop(1, '#8cc4f2');
  g.fillStyle = sky; g.fillRect(0, 0, cw, ch);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (const [x, y, r] of [[0.2, 0.18, 0.07], [0.27, 0.16, 0.05], [0.7, 0.26, 0.06], [0.76, 0.24, 0.045]]) { g.beginPath(); g.ellipse(cw * x, ch * y, cw * r, ch * r * 0.6, 0, 0, TAU); g.fill(); }
  const hill = g.createLinearGradient(0, ch * 0.55, 0, ch);
  hill.addColorStop(0, '#6cc04a'); hill.addColorStop(1, '#2f8a2a');
  g.fillStyle = hill; g.beginPath(); g.moveTo(0, ch * 0.72); g.quadraticCurveTo(cw * 0.45, ch * 0.48, cw, ch * 0.66); g.lineTo(cw, ch); g.lineTo(0, ch); g.fill();
  const tb = ch * 0.075;
  const bar = g.createLinearGradient(0, ch - tb, 0, ch); bar.addColorStop(0, '#3b82e6'); bar.addColorStop(1, '#1f55c8');
  g.fillStyle = bar; g.fillRect(0, ch - tb, cw, tb);
  g.fillStyle = '#3aa640'; g.beginPath(); g.roundRect(0, ch - tb, cw * 0.17, tb, [0, tb * 0.5, tb * 0.5, 0]); g.fill();
  g.fillStyle = '#fff'; g.font = `italic 700 ${tb * 0.62}px Rubik`; g.textBaseline = 'middle'; g.fillText('пуск', cw * 0.035, ch - tb / 2);
  for (let i = 0; i < 3; i++) { g.fillStyle = '#fff'; g.fillRect(cw * 0.05, ch * (0.08 + i * 0.13), cw * 0.05, cw * 0.05); }
  // строки развёртки
  g.fillStyle = 'rgba(0,0,0,0.06)'; for (let y = 0; y < ch; y += 3) g.fillRect(0, y, cw, 1);
}
