// Кадры 3D-пропса (S3): четыре ракурса поворотного стола + лист 2×2.
//   node render_prop.js <url prefab.js, например /rscene/<plan>/<el>/v<N>/prefab.js> <папка> [--port 8790] [--style paper|toy] [--pins pins.json] [--params '<JSON>']
// -> <папка>/element.png (лист), element_1.png … element_7.png (ракурсы ¾ спереди, другой бок, ¾ сзади, другой бок) и ошибки страницы.
// С --pins (файл [{n, p: [x, y, z]}] в координатах пропса): pins.png (лист) и pins_1…pins_7.png — номера пинов на модели.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
let [prefab, dir] = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
// Git Bash превращает «/rscene/…» в «C:/Program Files/Git/rscene/…» — возвращаем; путь без слеша тоже годится
if (prefab) prefab = prefab.replace(/\\/g, '/').replace(/^[A-Za-z]:\/Program Files\/Git(?=\/)/i, '').replace(/^(?!\/|https?:)/, '/');
if (!prefab || !dir) { console.error('usage: node render_prop.js <url prefab.js> <dir> [--port N] [--style paper|toy] [--pins pins.json]'); process.exit(2); }
let port = opt('--port');
if (!port) { try { port = fs.readFileSync(path.join(__dirname, '..', '..', '.studio', '.port'), 'utf8').trim(); } catch (e) { port = '8790'; } }
const style = opt('--style'), pinsFile = opt('--pins'), params = opt('--params');   // --params '{"pose": {...}}' — персонаж-модель (S9) в позе
const pins = pinsFile ? fs.readFileSync(pinsFile, 'utf8') : null;
const url = `http://127.0.0.1:${port}/tpl/stand3d.html?prop=${encodeURIComponent(prefab)}&parts=element` + (style ? `&style=${style}` : '')
  + (pins ? `&pins=${encodeURIComponent(JSON.stringify(JSON.parse(pins)))}` : '') + (params ? `&params=${encodeURIComponent(params)}` : '');
const out = pins ? path.join(dir, '_pins') : dir;
fs.mkdirSync(out, { recursive: true });
const r = spawnSync(process.execPath, [path.join(__dirname, 'render_shot.js'), url, out, '1,3,5,7'], { encoding: 'utf8' });
const log = (r.stdout || '') + (r.stderr || '');
const py = process.platform === 'win32' ? 'python' : 'python3';
const s = spawnSync(py, [path.join(__dirname, 'prop_sheet.py'), out], { encoding: 'utf8' });
if (pins) {
  for (const t of ['1', '3', '5', '7']) { const f = path.join(out, `element_${t}.png`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, `pins_${t}.png`)); }
  if (fs.existsSync(path.join(out, 'element.png'))) fs.copyFileSync(path.join(out, 'element.png'), path.join(dir, 'pins.png'));
}
const errs = log.split('\n').filter(l => l && !l.startsWith('wrote') && l.trim() !== 'ok');
if (errs.length) console.log(errs.join('\n'));
if (s.status !== 0) console.log('лист не собран: ' + (s.stderr || s.stdout));
console.log(r.status === 0 ? `ok: ${path.join(dir, pins ? 'pins.png' : 'element.png')} (лист) + 4 ракурса` : 'ошибки при съёмке — смотри выше');
process.exit(r.status === 0 ? 0 : 1);
