// S22: один «замок» видеокарты на всё приложение — тяжёлая GPU-работа (рендер кадров и клипов, TRELLIS / FLUX в ComfyUI) идёт по очереди:
// два рендера сразу заканчиваются позже, чем по очереди (одна видеокарта), а TRELLIS рядом с рендером не влезает в видеопамять.
// Файл <рабочая папка>/.studio/gpu.lock = {pid, what, since}; занят живым процессом — ждём и пишем «[gpu] жду видеокарту: …»;
// процесс умер (упал, убит) — замок ничей. Снимки черновиков, snap и сторож замок не берут (секунды). Тот же формат — server/gpulock.py.
//   const release = await require('…/stands/gpulock.js').acquire('экспорт «Valve»');  …  release();
// STUDIO_GPU_LOCK=0 — без замка (замеры).
const fs = require('fs');
const path = require('path');

const STALE = 6 * 3600e3;   // страховка от чужого процесса с тем же pid (Windows переиспользует номера)

function lockFile(from) {
  if (process.env.IDEAS_DIR) return path.join(process.env.IDEAS_DIR, 'gpu.lock');
  if (process.env.STUDIO_ROOT) return path.join(process.env.STUDIO_ROOT, '.studio', 'gpu.lock');
  for (let d = path.resolve(from || process.cwd()); ;) {                // рабочая папка — та, где лежит _studio
    if (fs.existsSync(path.join(d, '_studio', 'server'))) return path.join(d, '.studio', 'gpu.lock');
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function holder(f) {   // -> {pid, what, since} живого владельца или null (замок ничей / битый — убран)
  let cur = null, st = null;
  try { st = fs.statSync(f); cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (!st) return null;
    if (Date.now() - st.mtimeMs < 3000) return { pid: 0, what: '…', since: st.mtimeMs };   // только что создан, ещё пишется
  }
  if (cur && cur.pid && alive(cur.pid) && Date.now() - (cur.since || 0) < STALE) return cur;
  try { fs.rmSync(f, { force: true }); } catch (e) {}
  return null;
}

async function acquire(what, log = console.log, from) {
  const f = process.env.STUDIO_GPU_LOCK === '0' ? null : lockFile(from);
  if (!f) return () => {};
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let said = 0;
  for (;;) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, what, since: Date.now() }), { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') return () => {}; }
    const cur = holder(f);
    if (!cur) continue;
    if (cur.pid === process.pid) return () => {};                      // уже наш (вложенный вызов) — отпустит внешний
    if (Date.now() - said > 30000) { log(`[gpu] жду видеокарту: ${cur.what}`); said = Date.now(); }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (said) log('[gpu] видеокарта свободна — начинаю');
  let freed = false;
  const release = () => {
    if (freed) return; freed = true;
    try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.pid === process.pid) fs.rmSync(f, { force: true }); } catch (e) {}
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquire, lockFile, holder };
