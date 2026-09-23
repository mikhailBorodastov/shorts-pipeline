// node render.js snap 1.2,5,9.5 [out.png]   -> contact sheet of given times
// node render.js frames [fps] [workers]      -> build/frames/%05d.png
// node render.js sfx                          -> build/sfx.json
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Chrome / Edge / Chromium: set CHROME=path to override, otherwise the first one found is used
const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const EDGE = BROWSERS.find(p => fs.existsSync(p));
if (!EDGE) { console.error('Не найден Chrome/Edge. Укажи путь: CHROME="C:/.../chrome.exe" node render.js ...'); process.exit(1); }
const URL = `http://localhost:${process.env.REVIEW_PORT || 8765}/src/index.html`;

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate(() => window.READY);
  return page;
}
const grab = (page, t) => page.evaluate(t => { renderFrame(t); return document.getElementById('c').toDataURL('image/png'); }, t);
const save = (dataUrl, file) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

(async () => {
  const [mode, a1, a2] = process.argv.slice(2);
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, userDataDir: path.resolve('build/.profile'), args: ['--disable-gpu-vsync', '--force-device-scale-factor=1'] });
  try {
    if (mode === 'snap') {
      const times = a1.split(',').map(Number);
      const out = a2 || 'build/snap.png';
      const dir = 'build/snap_tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const page = await openPage(browser);
      for (let i = 0; i < times.length; i++) save(await grab(page, times[i]), path.join(dir, `s${String(i).padStart(3, '0')}.png`));
      const cols = Math.min(times.length, 6);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 's%03d.png'), '-vf', `scale=360:640,tile=${cols}x${Math.ceil(times.length / cols)}`, '-frames:v', '1', out]);
      console.log('wrote', out);
    } else if (mode === 'sfx') {
      const page = await openPage(browser);
      // SFX events are registered lazily by scenes; sweep the timeline once
      const sfx = await page.evaluate(() => window.getSFX());
      fs.writeFileSync('build/sfx.json', JSON.stringify(sfx));
    } else if (mode === 'frames') {
      const fps = +(a1 || 30), workers = +(a2 || 4);
      const dir = 'build/frames'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const probe = await openPage(browser);
      const total = await probe.evaluate(() => window.TOTAL);
      await probe.close();
      const N = Math.ceil(total * fps);
      let next = 0, done = 0; const t0 = Date.now();
      await Promise.all(Array.from({ length: workers }, async () => {
        const page = await openPage(browser);
        while (true) {
          const i = next++; if (i >= N) break;
          save(await grab(page, i / fps), path.join(dir, `${String(i).padStart(5, '0')}.png`));
          if (++done % 100 === 0) console.log(`${done}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        }
      }));
      console.log('frames done', N);
    }
  } finally { await browser.close(); }
})();
