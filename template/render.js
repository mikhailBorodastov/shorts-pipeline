// node render.js snap 1.2,5,9.5 [out.png]   -> contact sheet of given times
// node render.js frames [fps] [workers]      -> build/frames/%05d.png (or .jpg with RENDER_FMT=jpg; env options in the frames branch)
// node render.js sfx                          -> build/sfx.json
// node render.js thumb [out.png]              -> out/thumbnail.png (+ .jpg) from THUMBNAIL (or thumbnail_N from THUMBNAILS) in scenes.js
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
const URL = `http://localhost:${process.env.REVIEW_PORT || 8765}/src/${process.env.RENDER_PAGE || 'index.html'}`;   // RENDER_PAGE=demo.html renders another page

const fmt0 = () => { try { return JSON.parse((fs.readFileSync('src/format.js', 'utf8').match(/FRAME_SIZE\s*=\s*(\[[^\]]+\])/) || [])[1]) || [1080, 1920]; } catch (e) { return [1080, 1920]; } };   // кадр проекта (src/format.js)
async function openPage(browser) {
  const page = await browser.newPage();
  const fmt = (() => { try { return JSON.parse((fs.readFileSync('src/format.js', 'utf8').match(/FRAME_SIZE\s*=\s*(\[[^\]]+\])/) || [])[1]); } catch (e) { return null; } })() || [1080, 1920];
  await page.setViewport({ width: fmt[0], height: fmt[1] });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') console.log('[page]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  // the local server sometimes refuses a request when 4 pages load at once: reload until scripts and assets are all there
  for (let attempt = 0; ; attempt++) {
    await page.goto(URL, { waitUntil: 'load' });
    const ok = await page.evaluate(async () => {
      if (typeof window.renderFrame !== 'function' || typeof SCENES === 'undefined') return false;
      await window.READY;
      const A = (typeof ASSETS !== 'undefined' && ASSETS) || {};
      const seqOk = Object.keys(A.sequences || {}).every(k => SEQ[k] && SEQ[k].length === A.sequences[k].count && SEQ[k].every(Boolean));
      // a font that failed to download silently falls back to another face -> text "jumps" between render chunks
      const fontsOk = [...document.fonts].every(f => f.status !== 'error' && f.status !== 'loading');
      return Object.keys(A.images || {}).every(k => IMG[k]) && seqOk && fontsOk;
    }).catch(() => false);
    if (ok) break;
    if (attempt >= 5) throw new Error('page did not load cleanly: ' + URL);
    console.log('[render] page reload', attempt + 1);
    await new Promise(r => setTimeout(r, 400 + attempt * 400));
  }
  return page;
}
const grab = (page, t) => page.evaluate(t => { renderFrame(t); return document.getElementById('c').toDataURL('image/png'); }, t);
const save = (dataUrl, file) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

// one browser per render worker: separate GPU processes, and a stalled one can be killed without touching the others
// closing a headless browser sometimes hangs for minutes: give it 3 s, then kill the process
const closeB = b => Promise.race([b.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]).then(() => { try { const pr = b.process(); if (pr && pr.exitCode === null) pr.kill('SIGKILL'); } catch (e) {} });
const launch = id => puppeteer.launch({ executablePath: EDGE, headless: true, userDataDir: path.resolve(`build/.profile_${id}`), protocolTimeout: 120000,
  args: [process.env.RENDER_GPU === '0' ? '--disable-gpu' : '--disable-gpu-vsync', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

(async () => {
  const [mode, a1, a2] = process.argv.slice(2);
  const browser = await launch('main');
  try {
    if (mode === 'snap') {
      const times = a1.split(',').map(Number);
      const out = a2 || 'build/snap.png';
      const dir = 'build/snap_tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const page = await openPage(browser);
      for (let i = 0; i < times.length; i++) save(await grab(page, times[i]), path.join(dir, `s${String(i).padStart(3, '0')}.png`));
      const cols = Math.min(times.length, 6);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(dir, 's%03d.png'), '-vf', `scale=${fmt0()[0] > fmt0()[1] ? '640:360' : '360:640'},tile=${cols}x${Math.ceil(times.length / cols)}`, '-frames:v', '1', out]);
      console.log('wrote', out);
    } else if (mode === 'thumb') {
      const out = a1 || 'out/thumbnail.png';
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const page = await openPage(browser);
      const n = await page.evaluate(() => window.THUMB_COUNT());
      for (let i = 0; i < n; i++) {                     // THUMBNAILS = [...] -> thumbnail_1.png, thumbnail_2.png, …
        const file = n > 1 ? out.replace(/\.png$/, `_${i + 1}.png`) : out;
        save(await page.evaluate(i => { renderThumb(i); return document.getElementById('c').toDataURL('image/png'); }, i), file);
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-q:v', '2', file.replace(/\.png$/, '.jpg')]);
        console.log('wrote', file);
      }
    } else if (mode === 'sfx') {
      const page = await openPage(browser);
      // SFX events are registered lazily by scenes; sweep the timeline once
      const sfx = await page.evaluate(() => window.getSFX());
      fs.writeFileSync('build/sfx.json', JSON.stringify(sfx));
    } else if (mode === 'frames') {
      // Parallel render. Each worker = its own browser (own GPU process), takes contiguous chunks of frames,
      // every frame has a watchdog: a stalled page is killed and the frame is rendered again in a fresh browser.
      //   RENDER_GPU=0      software raster (slower, fallback)       RENDER_FMT=png   lossless PNG frames (2.5x slower)
      //   RENDER_RANGE=a:b  only frames a..b-1 (benchmarks)           RENDER_RECYCLE=N fresh browser every N frames (default 900)
      await closeB(browser);
      const fps = +(a1 || 30), workers = +(a2 || 4);
      const fmt = process.env.RENDER_FMT === 'png' ? 'png' : 'jpg';   // JPEG q0.95: PNG encoding was the bottleneck (27 vs 68 fps)
      const dir = 'build/frames';
      const probeB = await launch('probe'), probe = await openPage(probeB);
      const total = await probe.evaluate(() => window.TOTAL); await closeB(probeB);
      const N = Math.ceil(total * fps);
      const [r0, r1] = (process.env.RENDER_RANGE || `0:${N}`).split(':').map(Number);
      if (!process.env.RENDER_RANGE) { fs.rmSync(dir, { recursive: true, force: true }); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'format.txt'), fmt);
      const CH = 60, RECYCLE = +(process.env.RENDER_RECYCLE || 900), TIMEOUT = 30000;
      let nextChunk = r0, done = 0; const t0 = Date.now(), todo = r1 - r0;
      const grabF = (page, t) => page.evaluate((t, fmt) => { renderFrame(t); return document.getElementById('c').toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.95); }, t, fmt);
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('frame timeout')), ms))]);
      await Promise.all(Array.from({ length: workers }, async (_, w) => {
        await new Promise(r => setTimeout(r, w * 400));   // stagger browser starts
        let br = await launch(w), page = await openPage(br), since = 0;
        const fresh = async () => { await closeB(br); br = await launch(w); page = await openPage(br); since = 0; };
        while (true) {
          const c0 = nextChunk; if (c0 >= r1) break; nextChunk += CH;
          for (let i = c0; i < Math.min(c0 + CH, r1); i++) {
            for (let attempt = 0; ; attempt++) {
              try { save(await withTimeout(grabF(page, i / fps), TIMEOUT), path.join(dir, `${String(i).padStart(5, '0')}.${fmt}`)); break; }
              catch (e) { if (attempt >= 3) throw e; console.log(`[render] worker ${w}: frame ${i} ${e.message}, restarting browser`); await fresh(); }
            }
            if (++since >= RECYCLE) await fresh();
            if (++done % 100 === 0) console.log(`${done}/${todo}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          }
        }
        await closeB(br);
      }));
      console.log(`frames done ${todo} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(todo / ((Date.now() - t0) / 1000)).toFixed(1)} fps, ${workers} workers, ${process.env.RENDER_GPU === '0' ? 'cpu' : 'gpu'}, ${fmt})`);
      return;
    }
  } finally { await closeB(browser); }
})();
