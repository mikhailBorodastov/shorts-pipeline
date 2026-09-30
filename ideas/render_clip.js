// Клип сцены редактора в mp4 («🎞 клип», scene_api.clip): кадры 3D-стенда в режиме сцены -> ffmpeg.
//   node render_clip.js <url стенда ?stage=…> <out.mp4> <длина, с> [fps=30] [звуки.json]
// Как рендер ролика (template/render.js): у каждой вкладки свой браузер (свой GPU-процесс), кадры — JPEG q0.95, отрезками.
// звуки.json (необязательно): [{ "file": "D:/…/x.wav", "t": 1.2, "gain": 0.8 }] — сводятся под видео.
// Прогресс — строки «progress N/M» в stdout (scene_api показывает их в задаче).
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

(async () => {
  const [url, out, lenS, fpsS, sndS] = process.argv.slice(2);
  if (!url || !out || !lenS) { console.error('usage: node render_clip.js <url> <out.mp4> <len> [fps] [sounds.json]'); process.exit(2); }
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) { console.error('Не найден Chrome/Edge (CHROME=путь)'); process.exit(2); }
  const fps = +fpsS || 30, N = Math.max(1, Math.round(+lenS * fps));
  const tmp = out.replace(/\.mp4$/i, '') + '_frames';
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const WORKERS = Math.max(1, Math.min(+process.env.WORKERS || 4, Math.ceil(N / 30)));
  const errors = [];
  let next = 0, done = 0;
  const launch = id => puppeteer.launch({ executablePath: exe, headless: true, userDataDir: path.join(__dirname, `.clip_profile_${id}`), protocolTimeout: 120000,
    args: ['--force-device-scale-factor=1', '--disable-gpu-vsync', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const worker = async id => {
    const br = await launch(id);
    try {
      const page = await br.newPage();
      await page.setViewport({ width: 1080, height: 1920 });
      page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.evaluate(() => window.READY);
      while (next < N) {
        const a = next, b = Math.min(N, a + 30); next = b;
        for (let i = a; i < b; i++) {
          const d = await page.evaluate(t => window.shot('element', t, 'jpg'), i / fps);
          fs.writeFileSync(path.join(tmp, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64'));
          done++;
          if (done % 10 === 0 || done === N) console.log(`progress ${done}/${N}`);
        }
      }
    } finally { await Promise.race([br.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]); }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  console.log('encode');
  const args = ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(tmp, 'f%05d.jpg')];
  const snd = sndS && fs.existsSync(sndS) ? JSON.parse(fs.readFileSync(sndS, 'utf8')).filter(s => s.file && fs.existsSync(s.file)) : [];
  snd.forEach(s => args.push('-i', s.file));
  if (snd.length) {
    const parts = snd.map((s, i) => `[${i + 1}:a]adelay=${Math.round(Math.max(0, s.t) * 1000)}:all=1,volume=${s.gain == null ? 1 : s.gain}[a${i}]`);
    args.push('-filter_complex', parts.join(';') + ';' + snd.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${snd.length}:normalize=0,atrim=0:${+lenS}[aout]`,
      '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'fast', '-movflags', '+faststart', '-t', String(+lenS), out);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0 || !fs.existsSync(out)) { console.error('ffmpeg: ' + (r.stderr || r.error || '').toString().slice(-400)); process.exit(1); }
  console.log('wrote ' + out);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
