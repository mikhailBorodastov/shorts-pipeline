// Снимок обложки и первого кадра для «Штурма идей» (вызывает Claude в задаче «Отрисовать»).
//   node render_shot.js <url страницы web/render/page.html?scene=…> <папка> [t1,t2,…]
// -> <папка>/cover.png, frame.png (FRAME.t) и frame_<t>.png для дополнительных моментов; ошибки страницы — в консоль, код выхода 1.
// Элемент препродакшена: в url …&parts=element (стенд 2D page.html или 3D /tpl/stand3d.html) -> element.png (ELEMENT.t) и element_<t>.png.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

(async () => {
  const [url, dir, extra] = process.argv.slice(2);
  if (!url || !dir) { console.error('usage: node render_shot.js <url> <dir> [t1,t2]'); process.exit(2); }
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) { console.error('Не найден Chrome/Edge (CHROME=путь)'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const errors = [];
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, userDataDir: path.join(__dirname, '.render_profile'),
    args: ['--force-device-scale-factor=1', '--disable-gpu-vsync', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(/[?&]fmt=long\b/.test(url) ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 });
    await page.setCacheEnabled(false);                       // the stand and the engine change while we work: never an old copy
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('[console] ' + m.text()); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`[${r.status()}] ${r.url()}`); });
    page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => window.READY);
    const save = (d, f) => { fs.writeFileSync(path.join(dir, f), Buffer.from(d.split(',')[1], 'base64')); console.log('wrote', path.join(dir, f)); };
    const el = new URL(url).searchParams.get('parts') === 'element';
    for (const [kind, file] of el ? [['element', 'element.png']] : [['cover', 'cover.png'], ['frame', 'frame.png']]) {
      try { save(await page.evaluate(k => window.shot(k), kind), file); }
      catch (e) { errors.push(`[${kind}] ${e.message.split('\n')[0]}`); }
    }
    const moving = el ? 'element' : 'frame';
    for (const t of (extra || '').split(',').filter(Boolean).map(Number)) {
      try { save(await page.evaluate((k, t) => window.shot(k, t), moving, t), `${moving}_${t}.png`); } catch (e) { errors.push(`[${moving} ${t}] ${e.message.split('\n')[0]}`); }
    }
  } finally {
    await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  }
  if (errors.length) { console.log(errors.join('\n')); process.exit(1); }
  console.log('ok');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
