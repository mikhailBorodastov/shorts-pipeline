// Состояние старого drawHogPajama (pose, mood, look, lean, rub, reach, jig, dangle, t) -> поза персонажа со скелетом hog (S4, engine/rig.js).
// Переходник для «Комнаты зимним утром»: её поведение (tick hogPajama) пока задаёт состояние кодом; клипы S5 заменят его.
function pajamaPose(char, o) {
  const pose = o.pose || 'stand', mood = o.mood || 'calm', t = o.t || 0, lean = o.lean || 0, back = pose === 'back', sit = pose === 'sit' || back;
  const P = { sit, facing: back ? 'back' : 'front', bones: {}, face: {
    look: [o.look == null ? 0 : o.look, mood === 'scare' ? -0.25 : 0.1],
    mouth: mood === 'joy' ? 'smile' : mood === 'scare' ? 'o' : mood === 'sleepy' ? 'o' : 'flat',
    lid: mood === 'scare' ? 0 : mood === 'joy' ? 0.12 : mood === 'sleepy' ? 0.62 : 0.22 } };
  const A = (side, tx, ty) => rigHogAim(char, P, side, tx, ty);
  let armL = { rot: 0 }, armR = { rot: 0 };
  if (pose === 'stand') {
    armL = { rot: 0.07 }; armR = { rot: o.wave ? -2.45 : 0.07 };
    if (o.rub) {                                     // трёт глазки: лапки кругами у глаз
      const rl = o.rub, ph = t * 9;
      const L = A(-1, -0.12 + Math.cos(ph) * 0.025, -0.6 + Math.sin(ph) * 0.02), R = A(1, 0.12 + Math.cos(ph + 2) * 0.025, -0.6 + Math.sin(ph + 2) * 0.02);
      armL = { rot: lerp(0.22, L.rot + 0.15, rl) - 0.15, len: L.len }; armR = { rot: lerp(0.22, R.rot + 0.15, rl) - 0.15, len: R.len };
    }
  }
  if (sit) {
    const ay = -(back ? 0.44 : 0.5), ax = back ? 0.46 : 0.44;
    armL = A(-1, -ax, ay); armR = A(1, ax, ay);
    if (o.reach) {                                   // лапки тянутся к клавиатуре и мыши (jig — дёргает мышку)
      const rc = o.reach, jg = o.jig || 0;
      armL = A(-1, lerp(-ax, 0.3, rc), lerp(ay, -0.63, rc)); armR = A(1, lerp(ax, 0.56 + jg * 0.03, rc), lerp(ay, -0.62 + jg * 0.01, rc));
    }
    if (mood === 'joy' && lean > 0.5) armL = A(-1, -0.2, -0.6);
  }
  P.bones.armL = armL; P.bones.armR = armR;
  P.bones.body = { rot: -0.13 * lean + (o.q ? 0.03 : 0) };
  const sw = mood === 'joy' && lean > 0.5 ? 0.15 : Math.sin(t * (o.dangle ? 6 : 3)) * (o.dangle ? 0.22 : 0.05);
  P.bones.legL = { rot: sit ? sw : 0 };
  return P;
}
