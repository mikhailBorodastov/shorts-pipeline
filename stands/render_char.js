// Кадры персонажа со скелетом (S4): поза покоя с костями, лист проверочных поз, сетка эмоций.
//   node render_char.js <url prefab.js, например /rscene/<plan>/<el>/v<N>/prefab.js> <папка> [--port 8790]
// -> <папка>/element.png — лист поз типа (с костями), rest.png — покой крупно с костями, clean.png — покой без костей, emotions.png — эмоции (если есть).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
let [prefab, dir] = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
if (prefab) prefab = prefab.replace(/\\/g, '/').replace(/^[A-Za-z]:\/Program Files\/Git(?=\/)/i, '').replace(/^(?!\/|https?:)/, '/');   // Git Bash портит «/rscene/…»
if (!prefab || !dir) { console.error('usage: node render_char.js <url prefab.js> <dir> [--port N]'); process.exit(2); }
let port = opt('--port');
if (!port) { try { port = fs.readFileSync(path.join(__dirname, '..', '..', '.studio', '.port'), 'utf8').trim(); } catch (e) { port = '8790'; } }
const base = `http://127.0.0.1:${port}/render/char.html?char=${encodeURIComponent(prefab)}&parts=element`;
fs.mkdirSync(dir, { recursive: true });
const shots = [['element.png', '&poses=1&skel=1&size=1500x1000'], ['rest.png', '&skel=1&size=900x1000'], ['clean.png', '&size=900x1000'], ['emotions.png', '&emotions=1&size=1400x900']];
const errs = new Set();
for (const [name, q] of shots) {
  const tmp = path.join(dir, '_shot');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'render_shot.js'), base + q, tmp], { encoding: 'utf8' });
  for (const l of ((r.stdout || '') + (r.stderr || '')).split('\n')) if (l && !l.startsWith('wrote') && l.trim() !== 'ok') errs.add(l);
  const f = path.join(tmp, 'element.png');
  if (fs.existsSync(f)) fs.renameSync(f, path.join(dir, name));
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (errs.size) console.log([...errs].join('\n'));
console.log(`ok: ${path.join(dir, 'element.png')} (позы с костями), rest.png, clean.png, emotions.png`);
