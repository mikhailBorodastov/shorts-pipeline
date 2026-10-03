// S13: редактор в режиме ЛОКАЦИИ (docs/studio/stage13-locations.md): без времени — таймлайна, автоключа, ключей камеры и клипа нет;
// панель «Ракурсы» — именованные точки съёмки локации (scene.shots[] {id, name, pos, target, fov, note}): сцены монтажа строят от них камеру.
import { newId } from './ops.js';

export function initShots(ED) {
  if (!ED.info.location) return;
  const $ = id => document.getElementById(id);
  $('app').classList.add('loc');
  const t = $('sname'); if (t) t.textContent = '🏠 ' + (ED.info.element && ED.info.element.name || 'Локация');
  const box = document.createElement('section');
  box.id = 'shots'; box.setAttribute('aria-label', 'Ракурсы');
  $('side').append(box);
  const VP = ED.vp;
  // свободная камера -> в точку ракурса (та же математика, что «из камеры сцены»)
  const look = s => {
    const [px, py, pz] = s.pos, [tx, ty, tz] = s.target, dx = px - tx, dy = py - ty, dz = pz - tz, dist = Math.max(0.3, Math.hypot(dx, dy, dz));
    if (ED.view === 'camera' && ED.setView) ED.setView('free');
    VP.orbit.tgt.set(tx, ty, tz); VP.orbit.dist = dist; VP.orbit.yaw = Math.atan2(dx, dz); VP.orbit.pitch = Math.asin(Math.max(-1, Math.min(1, dy / dist)));
    VP.cam.fov = s.fov || VP.cam.fov; VP.cam.updateProjectionMatrix(); VP.place(); ED.dirty = true;
  };
  const here = () => ({ pos: [VP.cam.position.x, VP.cam.position.y, VP.cam.position.z].map(v => +v.toFixed(3)), target: [VP.orbit.tgt.x, VP.orbit.tgt.y, VP.orbit.tgt.z].map(v => +v.toFixed(3)), fov: Math.round(VP.cam.fov) });
  const shots = () => ED.doc.shots || [];
  const commit = (ops, desc) => ED.commit(ops, desc);
  function add() {
    const n = shots().length + 1, name = prompt('Название ракурса (например «общий план двора», «у щитовой»):', `ракурс ${n}`);
    if (!name) return;
    const item = Object.assign({ id: newId('sh'), name: name.trim(), note: '' }, here());
    commit(ED.doc.shots ? [{ op: 'add', path: ['shots'], item }] : [{ op: 'set', path: ['shots'], value: [item] }], `ракурс «${item.name}»`);
    ED.msg('🎥 Ракурс «' + item.name + '» сохранён — сцены монтажа будут снимать от него');
  }
  let sig = '';
  function draw() {
    const S = shots();
    sig = JSON.stringify(S);
    box.innerHTML = '';
    const head = document.createElement('div'); head.className = 'phead';
    head.innerHTML = '<b>Ракурсы</b><span class="dim small">точки съёмки — от них сцены монтажа</span>';
    box.append(head);
    if (!S.length) { const p = document.createElement('p'); p.className = 'dim small'; p.textContent = 'Ракурсов нет. Покрутите свободную камеру и сохраните хороший кадр.'; box.append(p); }
    for (const s of S) {
      const row = document.createElement('div'); row.className = 'shot';
      const go = document.createElement('button'); go.textContent = '▶'; go.title = 'Посмотреть с этого ракурса'; go.onclick = () => look(s);
      const nm = document.createElement('input'); nm.value = s.name || ''; nm.title = 'Название ракурса';
      nm.onchange = () => nm.value.trim() && commit([{ op: 'set', path: ['shots', s.id, 'name'], value: nm.value.trim() }], 'ракурс: имя');
      const upd = document.createElement('button'); upd.textContent = '⟳'; upd.title = 'Перезаписать: ракурс = текущий вид';
      upd.onclick = () => { const h = here(); commit(['pos', 'target', 'fov'].map(k => ({ op: 'set', path: ['shots', s.id, k], value: h[k] })), `ракурс «${s.name}» = этот вид`); };
      const del = document.createElement('button'); del.textContent = '×'; del.title = 'Удалить ракурс';
      del.onclick = () => confirm(`Удалить ракурс «${s.name}»? Сцены, которые от него снимают, возьмут первый ракурс.`) && commit([{ op: 'del', path: ['shots'], id: s.id }], `ракурс «${s.name}» удалён`);
      row.append(go, nm, upd, del); box.append(row);
    }
    const addB = document.createElement('button'); addB.className = 'primary'; addB.textContent = '＋ Ракурс с этого вида'; addB.onclick = add;
    const life = document.createElement('button'); life.textContent = '▶ фоновая жизнь'; life.title = 'Проиграть петлю локации: мерцание, дым, экраны';
    life.onclick = () => { ED.t = 0; ED.play && ED.play(1); };
    const bar = document.createElement('div'); bar.className = 'row'; bar.append(addB, life); box.append(bar);
  }
  draw();
  setInterval(() => { if (JSON.stringify(shots()) !== sig && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#shots'))) draw(); }, 800);   // правка от Claude / отмена — список обновляется (не во время ввода)
  ED.shots = { look, draw };
}
