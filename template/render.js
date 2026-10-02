// node render.js snap 1.2,5,9.5 [out.png]   -> contact sheet of given times
// node render.js frames [fps] [workers]      -> build/frames/video.h264 (S12.8: H.264 прямо в браузере, WebCodecs) или %05d.jpg / .png (RENDER_FMT=jpg|png; env options in the frames branch)
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

// отпечаток проекта для возобновления рендера: настройки + размер и время изменения файлов src/ и assets/ (vo_timing.js, scenes.js, картинки, модели)
function projectSig(o) {
  const crypto = require('crypto'), hsh = crypto.createHash('sha1').update(JSON.stringify(o));
  const walk = d => { let L = []; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) L = L.concat(walk(f)); else { const st = fs.statSync(f); L.push(`${f}|${st.size}|${Math.round(st.mtimeMs)}`); } } } catch (e) {} return L; };
  for (const x of [...walk('src'), ...walk('assets')].sort()) hsh.update(x);
  return hsh.digest('hex');
}
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
      const cols = Math.min(times.length, fmt0()[0] > fmt0()[1] ? 3 : 6);   // 16:9 — по 3 в ряд
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
      //   S12.12 возобновление: build/frames/sig.json — отпечаток (кадр, fps, формат, файлы src/ и assets/). Совпал — готовые куски не рендерятся заново
      //   (сбой, отмена, закрытое окно на 20-минутном ролике), всё готово — рендер пропускается. RENDER_FRESH=1 — начать с нуля.
      await closeB(browser);
      const fps = +(a1 || 30); let workers = +(a2 || 4);
      let fmt = process.env.RENDER_FMT === 'png' ? 'png' : process.env.RENDER_FMT === 'jpg' ? 'jpg' : 'h264';   // S12.8: по умолчанию H.264 в браузере (видеокарта)
      const dir = 'build/frames';
      const probeB = await launch(0), probe = await openPage(probeB);   // первый работник: страница уже загружена — не грузим её второй раз
      const total = await probe.evaluate(() => window.TOTAL);
      // S12.8 замер (Ностальгия, 3D, 1080×1920): кадр + JPEG + base64 через CDP — ~39 мс; кадр + аппаратный H.264 (WebCodecs) — ~16 мс и ~66 КБ вместо ~650 КБ;
      // x264 в конце не нужен — только склейка со звуком. Нет VideoEncoder / не поддерживает размер — старый путь JPEG.
      const BITRATE = +(process.env.RENDER_BITRATE || (+(a1 || 30) > 40 ? 20e6 : 14e6));
      if (fmt === 'h264') {
        const ok = await probe.evaluate(async (fps, br) => {
          try { const c = document.getElementById('c'); return typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640033', width: c.width, height: c.height, bitrate: br, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' } })).supported; }
          catch (e) { return false; }
        }, +(a1 || 30), BITRATE).catch(() => false);
        if (!ok) { fmt = 'jpg'; console.log('[render] WebCodecs H.264 недоступен — кадры JPEG'); }
      }
      if (!process.env.WORKERS && !process.env.RENDER_WORKERS_FORCE && await probe.evaluate(() => typeof X3 !== 'undefined' && !!X3.R))
        workers = Math.min(workers, 4);                   // 3D-сцены (WebGL): видеокарта одна — 4 окна быстрее 6 (замер: 1044 кадра 31 с против 48 с)
      const N = Math.ceil(total * fps), CH0 = fmt === 'h264' ? 120 : 60;
      const [r0, r1] = (process.env.RENDER_RANGE || `0:${N}`).split(':').map(Number);
      const sig = projectSig({ fps, fmt, N, size: fmt0(), br: fmt === 'h264' ? BITRATE : 0 });
      const sigF = path.join(dir, 'sig.json');
      const old = (() => { try { return JSON.parse(fs.readFileSync(sigF, 'utf8')); } catch (e) { return null; } })();
      const same = !process.env.RENDER_FRESH && !process.env.RENDER_RANGE && old && old.sig === sig;
      if (same && old.complete && fs.existsSync(path.join(dir, fmt === 'h264' ? 'video.h264' : `${String(N - 1).padStart(5, '0')}.${fmt}`))) {
        console.log(`[render] кадры уже готовы (проект не менялся) — пропускаю`);
        console.log(`frames done ${N} in 0.0s (0.0 fps, 0 workers, cached, ${fmt})`);
        await closeB(probeB); return;
      }
      if (!process.env.RENDER_RANGE && !same) { fs.rmSync(dir, { recursive: true, force: true }); }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'format.txt'), fmt);
      if (!process.env.RENDER_RANGE) fs.writeFileSync(sigF, JSON.stringify({ sig, N, fps, fmt, started: Date.now() }));
      const chunkF = c0 => path.join(dir, `c${String(c0).padStart(6, '0')}.h264`), frameF = i => path.join(dir, `${String(i).padStart(5, '0')}.${fmt}`);
      const have = c0 => (fmt === 'h264' ? (fs.existsSync(chunkF(c0)) && fs.statSync(chunkF(c0)).size > 0)
        : Array.from({ length: Math.min(CH0, r1 - c0) }, (_, k) => fs.existsSync(frameF(c0 + k))).every(Boolean));
      const CH = CH0, RECYCLE = +(process.env.RENDER_RECYCLE || 900), TIMEOUT = 30000;
      let nextChunk = r0, done = 0; const t0 = Date.now(), todo = r1 - r0;
      let reused = 0;
      if (same) for (let c = r0; c < r1; c += CH) if (have(c)) reused += Math.min(CH, r1 - c);
      if (reused) { done = reused; console.log(`[render] продолжаю: ${reused} из ${todo} кадров уже готовы`); console.log(`${done}/${todo}  0s`); }
      const grabF = (page, t) => page.evaluate((t, fmt) => { renderFrame(t); return document.getElementById('c').toDataURL(fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.95); }, t, fmt);
      // кусок кадров a..b-1 -> один поток H.264 Annex B (начинается с ключевого кадра, SPS/PPS внутри) -> base64; куски склеиваются по порядку
      const encChunk = (page, a, b) => page.evaluate(async (a, b, fps, br) => {
        const c = document.getElementById('c'), parts = []; let err = null;
        const enc = new VideoEncoder({ output: ch => { const u = new Uint8Array(ch.byteLength); ch.copyTo(u); parts.push(u); }, error: e => { err = e; } });
        enc.configure({ codec: 'avc1.640033', width: c.width, height: c.height, bitrate: br, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' }, latencyMode: 'quality' });
        for (let i = a; i < b; i++) {
          renderFrame(i / fps);
          const f = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
          enc.encode(f, { keyFrame: i === a }); f.close();
          if (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0));
        }
        await enc.flush(); enc.close();
        if (err) throw err;
        let n = 0; for (const q of parts) n += q.length;
        const all = new Uint8Array(n); let o = 0; for (const q of parts) { all.set(q, o); o += q.length; }
        let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
        return btoa(s);
      }, a, b, fps, BITRATE);
      const withTimeout = (p, ms) => { let tm; return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('frame timeout')), ms); })]).finally(() => clearTimeout(tm)); };   // сторож кадра снимается — иначе процесс ждал ещё 30 с после последнего кадра
      await Promise.all(Array.from({ length: workers }, async (_, w) => {
        await new Promise(r => setTimeout(r, w * 400));   // stagger browser starts
        let br, page, since = 0;
        if (w === 0) { br = probeB; page = probe; } else { br = await launch(w); page = await openPage(br); }
        const fresh = async () => { await closeB(br); br = await launch(w); page = await openPage(br); since = 0; };
        while (true) {
          const c0 = nextChunk; if (c0 >= r1) break; nextChunk += CH;
          if (same && have(c0)) continue;                 // готово с прошлого запуска
          if (fmt === 'h264') {                          // S12.8: весь кусок — одним вызовом, наружу только сжатый поток
            const c1 = Math.min(c0 + CH, r1);
            for (let attempt = 0; ; attempt++) {
              try { const buf = Buffer.from(await withTimeout(encChunk(page, c0, c1), TIMEOUT + (c1 - c0) * 500), 'base64'); fs.writeFileSync(chunkF(c0) + '.tmp', buf); fs.renameSync(chunkF(c0) + '.tmp', chunkF(c0)); break; }   // целиком или никак — для возобновления
              catch (e) { if (attempt >= 3) throw e; console.log(`[render] worker ${w}: chunk ${c0} ${e.message}, restarting browser`); await fresh(); }
            }
            since += c1 - c0; if (since >= RECYCLE) await fresh();
            done += c1 - c0; console.log(`${done}/${todo}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            continue;
          }
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
      if (fmt === 'h264') {                              // куски по порядку -> build/frames/video.h264
        const fd = fs.openSync(path.join(dir, 'video.h264'), 'w');
        for (const f of fs.readdirSync(dir).filter(f => /^c\d{6}\.h264$/.test(f)).sort()) { fs.writeSync(fd, fs.readFileSync(path.join(dir, f))); fs.rmSync(path.join(dir, f)); }
        fs.closeSync(fd);
      }
      if (!process.env.RENDER_RANGE) fs.writeFileSync(sigF, JSON.stringify({ sig, N, fps, fmt, complete: Date.now() }));
      console.log(`frames done ${todo} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(todo / ((Date.now() - t0) / 1000)).toFixed(1)} fps, ${workers} workers, ${process.env.RENDER_GPU === '0' ? 'cpu' : 'gpu'}, ${fmt})`);
      return;
    }
  } finally { await closeB(browser); }
})();
