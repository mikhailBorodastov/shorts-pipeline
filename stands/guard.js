// S21 «Сторож монтажа»: node <_studio>/stands/guard.js [--fps 10] [--scenes 3,5] [--from 0 --to 12] [--no-shots]   (в папке проекта ролика)
// Страница проекта (REVIEW_PORT, как render.js) + engine/guard3d.js -> build/guard.json, build/guard.png (лист кадров с рамками), отчёт в stdout.
// Картинки 3D при проходе не рисуются (только позы) — 60-секундный шорт ~10–30 с.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require(path.resolve('node_modules/puppeteer-core'));

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = k => process.argv.includes('--' + k);
const BROWSERS = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const EXE = BROWSERS.find(p => fs.existsSync(p));
if (!EXE) { console.error('Не найден Chrome/Edge (CHROME=путь)'); process.exit(1); }
const URL = `http://localhost:${process.env.REVIEW_PORT || 8765}/src/${process.env.RENDER_PAGE || 'index.html'}`;
const size = (() => { try { return JSON.parse((fs.readFileSync('src/format.js', 'utf8').match(/FRAME_SIZE\s*=\s*(\[[^\]]+\])/) || [])[1]) || [1080, 1920]; } catch (e) { return [1080, 1920]; } })();

const fmtT = x => (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
const sNN = k => 's' + String(k).padStart(2, '0');
function line(x) {
  const at = `${sNN(x.k)}${x.scene ? ` «${x.scene}»` : ''}`;
  if (x.type === 'stuck') return `${x.char ? '❌' : '⚠️'} ${at} ${fmtT(x.t0)}–${fmtT(x.t1)} с (lt ${fmtT(x.lt0)}–${fmtT(x.lt1)}${x.spans ? `, ${x.spans.length} раза` : ''}): «${x.a}» ⟷ «${x.b}» — вошли друг в друга на ${Math.round(x.depth * 100)} см${x.parts && x.parts[0] ? ` (${x.parts[0]} / ${x.parts[1]})` : ''}. Раздвинь, обведи путь или w.touch('${x.a}', '${x.b}'), если так задумано`;
  if (x.type === 'pop') return `❌ ${at} ${fmtT(x.t)} с (lt ${fmtT(x.lt)}): «${x.a}» ${x.dir === 'out' ? 'пропал' : 'возник'} за один кадр (был ${x.area}% кадра) — ${x.dir === 'out' ? "exit3 / life3 out (popUp, pop, slide за край)" : "enter3 / life3 in (popUp, pop, slide из-за края)"}, задуманная подмена — w.guard('${x.a}', {pop: false})`;
  if (x.type === 'zfight') return `❌ ${at} ${fmtT(x.t0)}–${fmtT(x.t1)} с (lt ${fmtT(x.lt0)}–${fmtT(x.lt1)}): мерцает (z-fighting) — ${x.b ? `«${x.a}» и «${x.b}»` : `части «${x.a}»`} лежат в одной плоскости${x.parts && x.parts[0] ? ` (${x.parts[0]} / ${x.parts[1]})` : ''}. Отодвинь одну на 5–10 мм вдоль нормали (или material.polygonOffset)`;
  if (x.type === 'blink') return `❌ ${at} ${fmtT(x.t0)}–${fmtT(x.t1)} с (lt ${fmtT(x.lt0)}–${fmtT(x.lt1)}): «${x.a}» мигает — ${x.n} раз сменил видимость подряд. Видимость считай из времени один раз (life3), без дребезга условий; задуманное мигание — w.guard('${x.a}', {pop: false})`;
  if (x.type === 'flicker') return `${x.n > 1 ? '❌' : '⚠️'} ${fmtT(x.t0)}–${fmtT(x.t1)} с: мерцание в кадре ${x.where} (${x.n > 1 ? `${x.n} вспышек` : 'вспышка на ' + x.len + ' кадр.'}, ${x.area}% кадра) — по готовому mp4`;
  return `⚠️ ${at} ${fmtT(x.t)} с (lt ${fmtT(x.lt)}): «${x.a}» перескочил за один кадр на ${x.dist}% кадра — плавный путь или склейка камерой`;
}

(async () => {
  const br = await puppeteer.launch({ executablePath: EXE, headless: true, userDataDir: path.resolve('build/.profile_guard'), protocolTimeout: 300000,
    args: ['--disable-gpu-vsync', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await br.newPage();
    await page.setViewport({ width: size[0], height: size[1] });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    for (let attempt = 0; ; attempt++) {
      await page.goto(URL, { waitUntil: 'load' });
      const ok = await page.evaluate(async () => { if (typeof window.renderFrame !== 'function') return false; await window.READY; return true; }).catch(() => false);
      if (ok) break;
      if (attempt >= 4) throw new Error('страница не открылась: ' + URL + (errs.length ? '\n' + errs.slice(0, 3).join('\n') : ''));
      await new Promise(r => setTimeout(r, 500 + attempt * 500));
    }
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'engine', 'guard3d.js'), 'utf8') });
    const meta = await page.evaluate(() => ({ none: !!GUARD.none, worlds: (typeof X3 !== 'undefined' && X3.worlds.length) || 0, total: window.TOTAL, B: typeof B !== 'undefined' ? B : [0],
      names: typeof SCENES !== 'undefined' ? SCENES.map(s => (s && s.name) || '') : [] }));
    fs.mkdirSync('build', { recursive: true });
    const outJ = 'build/guard.json';
    if (meta.none || !meta.worlds) {
      fs.writeFileSync(outJ, JSON.stringify({ at: Date.now(), total: meta.total, issues: [], info: { worlds: 0 }, B: meta.B, names: meta.names, note: 'нет 3D-миров' }));
      console.log('сторож 3D: в ролике нет 3D-миров (2D проверяет только мерцание по mp4)'); return;
    }
    const fps = +arg('fps', 10), dt = 1 / fps;
    let ranges = [[+arg('from', 0), +arg('to', meta.total)]];
    if (arg('scenes')) ranges = arg('scenes').split(',').map(Number).filter(k => k >= 0 && k < meta.B.length).map(k => [meta.B[k], k + 1 < meta.B.length ? meta.B[k + 1] : meta.total]);
    const t0 = Date.now();
    for (const [a, b] of ranges) for (let t = a; t < b; t += 4) await page.evaluate((x, y, d) => GUARD.step(x, y, d), t, Math.min(b, t + 4), dt);
    const R = await page.evaluate(() => GUARD.finish());
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // лист кадров с рамками: красная — кто, жёлтая — во что
    let sheet = null;
    const shots = has('no-shots') ? [] : R.issues.filter(x => x.type !== 'jump' || R.issues.length < 9).slice(0, 12);
    if (shots.length) {
      const dir = 'build/guard'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < shots.length; i++) {
        const url = await page.evaluate(x => GUARD.shot(x), shots[i]).catch(() => null);
        if (url) { fs.writeFileSync(path.join(dir, `g${String(i).padStart(3, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64')); shots[i].shot = `build/guard/g${String(i).padStart(3, '0')}.jpg`; }
      }
      const wide = size[0] > size[1], cols = Math.min(shots.length, wide ? 3 : 4);
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-start_number', '0', '-i', path.join(dir, 'g%03d.jpg'), '-vf', `scale=${wide ? '640:360' : '360:640'},tile=${cols}x${Math.ceil(shots.length / cols)}`, '-frames:v', '1', 'build/guard.png']);
        sheet = 'build/guard.png';
      } catch (e) { console.log('лист кадров не собрался:', e.message.split('\n')[0]); }
    }
    fs.writeFileSync(outJ, JSON.stringify({ at: Date.now(), total: meta.total, fps, ranges, issues: R.issues, info: R.info, sheet, errors: errs.slice(0, 5), B: meta.B, names: meta.names }, null, 1));
    const bad = R.issues.filter(x => ['pop', 'zfight', 'blink'].includes(x.type) || x.char).length;
    console.log(`сторож: ${R.issues.length ? `проблем ${R.issues.length} (серьёзных ${bad})` : 'чисто ✅'} · ${secs} с · миров ${R.info.worlds} · декор внахлёст ${R.info.decor}, прицепы ${R.info.attached}, разрешённые касания ${R.info.touch}`);
    R.issues.forEach((x, i) => console.log(`${i + 1}. ${line(x)}`));
    if (sheet) console.log(`кадры с рамками (красная — кто, жёлтая — во что; по порядку): ${path.resolve(sheet).replace(/\\/g, '/')}`);
    if (errs.length) console.log('[pageerror]', errs.slice(0, 3).join(' | '));
  } finally {
    await Promise.race([br.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    try { const pr = br.process(); if (pr && pr.exitCode === null) pr.kill('SIGKILL'); } catch (e) {}
  }
})().catch(e => { console.error('сторож упал:', e.message); process.exit(2); });
