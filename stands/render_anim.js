// Лента кадров клипа анимации на персонаже (S5): node render_anim.js <url prefab.js персонажа> <url клипа .json> <папка> [--port 8790] [--n 8]
// -> <папка>/strip.png (n кадров по длине клипа, подписи времени) + ошибки страницы.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const fix = p => p && p.replace(/\\/g, '/').replace(/^[A-Za-z]:\/Program Files\/Git(?=\/)/i, '').replace(/^(?!\/|https?:)/, '/');   // Git Bash портит «/api/…»
let [char, anim, dir] = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
char = fix(char); anim = fix(anim);
if (!char || !anim || !dir) { console.error('usage: node render_anim.js <url prefab.js> <url клипа.json> <dir> [--port N] [--n 8]'); process.exit(2); }
let port = opt('--port');
if (!port) { try { port = fs.readFileSync(path.join(__dirname, '..', '..', '.studio', '.port'), 'utf8').trim(); } catch (e) { port = '8790'; } }
const n = opt('--n', '8');
const base = `http://127.0.0.1:${port}/render/char.html?char=${encodeURIComponent(char)}&anim=${encodeURIComponent(anim)}&strip=1&n=${n}&size=${Math.max(1200, n * 230)}x560&parts=element`;
fs.mkdirSync(dir, { recursive: true });
const errs = new Set();
for (const [name, q] of [['strip.png', '']]) {
  const tmp = path.join(dir, '_shot');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'render_shot.js'), base + q, tmp], { encoding: 'utf8' });
  for (const l of ((r.stdout || '') + (r.stderr || '')).split('\n')) if (l && !l.startsWith('wrote') && l.trim() !== 'ok') errs.add(l);
  const f = path.join(tmp, 'element.png');
  if (fs.existsSync(f)) fs.renameSync(f, path.join(dir, name));
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (errs.size) console.log([...errs].join('\n'));
console.log(`ok: ${path.join(dir, 'strip.png')} (кадры клипа)`);
