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
// 3D-персонаж (rig: 'model', S9+): лента — кадры 3D-стенда в неподвижном ракурсе по длине клипа
const model3d = (() => { try { const r = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}${char}').then(r=>r.text()).then(t=>process.stdout.write(/rig:\\s*'model'/.test(t)?'1':'0')).catch(()=>process.stdout.write('0'))`], { encoding: 'utf8' }); return r.stdout.trim() === '1'; } catch (e) { return false; } })();
if (model3d) {
  const dur = (() => { try { const r = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}${anim}').then(r=>r.json()).then(a=>process.stdout.write(String(a.dur||1)))`], { encoding: 'utf8' }); return +r.stdout || 1; } catch (e) { return 1; } })();
  const N = +n, ts = Array.from({ length: N }, (_, i) => (dur * i / Math.max(1, N - 1)).toFixed(2));
  const url = `http://127.0.0.1:${port}/tpl/stand3d.html?prop=${encodeURIComponent(char)}&anim=${encodeURIComponent(anim)}&still=1&parts=element`;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '_shot3d');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'render_shot.js'), url, tmp, ts.join(',')], { encoding: 'utf8' });
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const s = spawnSync(py, ['-c', `
import sys, glob, os
from PIL import Image, ImageDraw
d, ts = sys.argv[1], sys.argv[2].split(',')
ims = []
for t in ts:
    f = os.path.join(d, 'element_' + str(float(t)).rstrip('0').rstrip('.') + '.png')
    if not os.path.isfile(f):
        f = os.path.join(d, 'element_' + t + '.png')
    if os.path.isfile(f):
        im = Image.open(f).convert('RGB'); w, h = im.size; im = im.crop((0, int(h * 0.12), w, int(h * 0.88))).resize((230, int(230 * h * 0.76 / w)))
        ImageDraw.Draw(im).text((8, 8), t + ' s', fill=(40, 40, 40)); ims.append(im)
if ims:
    out = Image.new('RGB', (230 * len(ims), ims[0].height), 'white')
    for i, im in enumerate(ims): out.paste(im, (230 * i, 0))
    out.save(sys.argv[3])
`, tmp, ts.join(','), path.join(dir, 'strip.png')], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  const log = ((r.stdout || '') + (r.stderr || '') + (s.stderr || '')).split('\n').filter(l => l && !l.startsWith('wrote') && l.trim() !== 'ok');
  if (log.length) console.log(log.join('\n'));
  console.log(`ok: ${path.join(dir, 'strip.png')} (кадры клипа, 3D)`);
  process.exit(0);
}
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
