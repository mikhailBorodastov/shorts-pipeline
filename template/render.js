// node render.js snap 1.2,5,9.5 [out.png]   -> contact sheet of given times
// node render.js frames [fps] [workers]      -> build/frames/video.h264 (S12.8: H.264 прямо в браузере, WebCodecs) или %05d.jpg / .png (RENDER_FMT=jpg|png; env options in the frames branch)
// node render.js sfx                          -> build/sfx.json (S22: код сцен и тайминги не менялись — без браузера, из кэша)
// node render.js audio                        -> sfx + audio.py -> build/mix.wav; ничего не менялось — ничего не делает (S22)
// node render.js check                        -> build/wt_check.json: привязки к словам WT(), которые не нашлись (S22)
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

// отпечаток проекта для возобновления рендера: настройки + src/ ПО СОДЕРЖИМОМУ (генератор монтажа переписывает тот же текст — время меняется, кадры нет)
// + assets/ по размеру и времени (модели и видео хэшировать долго). Страницы ревью и раскадровки ролик не грузит — не в счёт.
const SIG_SKIP = new Set(['review.js', 'review.html', 'script.html', 'script.js', 'refs.js', 'animalese.html']);
function projectSig(o) {
  const crypto = require('crypto'), hsh = crypto.createHash('sha1').update(JSON.stringify(o));
  const walk = (d, byContent) => { let L = []; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) L = L.concat(walk(f, byContent)); else if (!(byContent && d === 'src' && SIG_SKIP.has(e.name))) { const st = fs.statSync(f); L.push(byContent ? `${f}|${crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')}` : `${f}|${st.size}|${Math.round(st.mtimeMs)}`); } } } catch (e) {} return L; };
  for (const x of [...walk('src', true), ...walk('assets', false)].sort()) hsh.update(x);
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

// ---------- S22: кэш кадров по сценам ----------
// Кадры режутся на куски по сценам: тело сцены k ('s<k>') и переход в сцену k ('t<k>': рисует k-1 и k), кусок не длиннее CH0 кадров.
// Подпись куска = общий код (движок, общий scenes.js, препродакшен, картинки, модели; звуки не в счёт) + код его сцен
// (быстрый монтаж — src/scenes/sNN.js с SCENES[k] = …; монтаж Studio — юнит, scene.json и папка сцены) + их время (границы, переходы,
// слова голоса рядом, субтитры и надписи монтажа на отрезке) + fps, кадр, битрейт. Кэш — build/segcache/<fps>_<подпись>.h264: 30 и 60 к/с живут рядом.
// Связи сцен по коду (быстрый монтаж): имя, объявленное в файле одной сцены и встреченное в другой; SCENES[n] и paperTurnIn(…, n, …) —
// чтение чужой сцены; первый кусок сцены зависит и от предыдущей (вход «последним кадром прошлой сцены»). Сверка пикселей не годится:
// сцены помнят прошлые кадры (сглаживание), кадр «прыжком» отличается от кадра подряд.
const sha1 = (...xs) => { const h = require('crypto').createHash('sha1'); for (const x of xs) h.update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x === undefined ? null : x)); return h.digest('hex'); };
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|flac|aac|opus)$/i;
function filesSig(skip) {   // src/ по содержимому, assets/ по размеру и времени; skip(путь) — не в счёт
  const L = [];
  const walk = (d, byContent) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const f = `${d}/${e.name}`;
      if (e.isDirectory()) { if (!skip(f + '/')) walk(f, byContent); continue; }
      if (skip(f) || AUDIO_EXT.test(f) || (d === 'src' && SIG_SKIP.has(e.name))) continue;
      const st = fs.statSync(f); L.push(byContent ? `${f}|${sha1(fs.readFileSync(f))}` : `${f}|${st.size}|${Math.round(st.mtimeMs)}`);
    }
  };
  walk('src', true); walk('assets', false);
  return sha1(L.sort().join('\n'));
}
function dirSig(d) {
  const L = [], walk = x => { let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const f = `${x}/${e.name}`; if (e.isDirectory()) walk(f); else L.push(`${f}|${sha1(fs.readFileSync(f))}`); } };
  walk(d); return sha1(L.sort().join('\n'));
}
const withTO = (p, ms) => { let tm; return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('frame timeout')), ms); })]).finally(() => clearTimeout(tm)); };
// кусок a..b-1 -> H.264 Annex B (с ключевого кадра)
const encSeg = (page, a, b, fps, br) => page.evaluate(async (a, b, fps, br) => {
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
}, a, b, fps, br);

// ---------- S22: проверка привязок к словам ----------
// Звуки всех сцен + 4 кадра каждой сцены; промахи WT() (слова нет / секции нет) -> build/wt_check.json и строки «[check] ❌ …» в лог сборки.
async function wtSweep(page) {
  // S22: заодно — предупреждения и ошибки страницы по сценам («ppObj: нет объекта ёжик», упавший кадр): раньше их видно было только глазами в ролике
  const r = await page.evaluate(() => {
    const n = SCENES.length, warn = {};
    let cur = null;
    const note = (kind, k, msg) => { msg = String(msg).slice(0, 200); const w = warn[kind + '|' + msg] || (warn[kind + '|' + msg] = { kind, msg, scenes: [] }); if (k != null && !w.scenes.includes(k)) w.scenes.push(k); };
    const ow = console.warn, oe = console.error;
    console.warn = (...a) => { note('warn', cur, a.join(' ')); ow.apply(console, a); };
    console.error = (...a) => { note('error', cur, a.join(' ')); oe.apply(console, a); };
    try {
      try { if (window.getSFX) window.getSFX(); } catch (e) { note('error', null, 'звуки: ' + e.message); }
      for (let k = 0; k < n; k++) { cur = k; const a = B[k], b = k + 1 < n ? B[k + 1] : TOTAL; for (const f of [0.02, 0.35, 0.65, 0.98]) { try { renderFrame(a + (b - a) * f); } catch (e) { note('error', k, 'кадр упал: ' + e.message); } } }
    } finally { console.warn = ow; console.error = oe; }
    return { miss: typeof WT_MISS === 'undefined' ? [] : Object.values(WT_MISS), warn: Object.values(warn).slice(0, 30),
             sections: VO.sections.length, scenes: n, names: SCENES.map(x => (x && x.name) || '') };
  }).catch(e => ({ error: e.message }));
  if (!r) return null;
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync('build/wt_check.json', JSON.stringify(Object.assign({ t: Date.now() }, r), null, 1));
  for (const m of r.miss || []) {
    const who = m.scenes.length ? m.scenes.map(k => `сцена ${k}${r.names[k] ? ` «${r.names[k]}»` : ''}`).join(', ') : 'код вне сцен';
    console.log(`[check] ❌ ${who}: WT(${m.i}, ${JSON.stringify(m.key)}) — ${m.why === 'секции нет' ? `секции ${m.i} нет (секций ${r.sections}) — событие ушло в конец ролика` : `в секции ${m.i} нет такого слова — событие встало на начало секции`}`);
  }
  for (const w of r.warn || []) {
    const who = w.scenes.length ? w.scenes.map(k => `сцена ${k}${r.names[k] ? ` «${r.names[k]}»` : ''}`).join(', ') : 'загрузка / звуки';
    console.log(`[check] ${w.kind === 'error' ? '❌' : '⚠'} ${who}: ${w.msg}`);
  }
  if (r.error) console.log('[check] проверка привязок не прошла: ' + r.error);
  return r;
}

async function renderBySegments({ fps, workers, N, CH0, BITRATE, dir, probeB, probe }) {
  const t0 = Date.now(), CDIR = 'build/segcache', RECYCLE = +(process.env.RENDER_RECYCLE || 900);
  fs.mkdirSync(CDIR, { recursive: true });
  const I = await probe.evaluate(() => {
    const S6 = typeof MONTAGE !== 'undefined' && typeof STUDIO_SCENES !== 'undefined';
    return {
      B: B.slice(), TOTAL, TD, n: SCENES.length, tr: SCENES.map(s => [s.trans || 'iris', s.transDur || TD]),
      vo: VO.sections.map(s => [s.start, s.dur, (s.words || []).map(w => [w.w, w.t, w.d])]),
      cap: CAPTIONS.off ? null : CHUNKS.map(c => [c.t0, c.t1, c.ws.map(w => [w.w, w.t])]), capStyle: CAPTIONS,
      s6: S6 ? { units: MONTAGE.units, scenes: MONTAGE.units.map(u => JSON.stringify(STUDIO_SCENES[u.el] || null)), overlays: MONTAGE.overlays || [],
        rest: Object.assign({}, MONTAGE, { units: 0, overlays: 0 }) } : null,
    };
  });
  // свой код сцен
  const own = Array(I.n).fill(''), ownFiles = new Set(), ownDirs = [];
  const SF = [];   // файлы сцен: { p, code, h, ks — какие SCENES[k] задаёт, defs — имена верхнего уровня }
  if (fs.existsSync('src/scenes')) for (const f of fs.readdirSync('src/scenes').filter(f => f.endsWith('.js')).sort()) {
    const p = 'src/scenes/' + f, code = fs.readFileSync(p, 'utf8'), ks = [...code.matchAll(/SCENES\[\s*(\d+)\s*\]\s*=(?!=)/g)].map(m => +m[1]);
    if (ks.length) SF.push({ p, code, h: sha1(code), ks, defs: [...code.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]) });
  }
  const fileOf = {}; SF.forEach((F, j) => { ownFiles.add(F.p); F.ks.forEach(k => { fileOf[k] = j; }); });
  const argN = (code, fn, n) => [...code.matchAll(new RegExp('\\b' + fn + '\\s*\\(', 'g'))].map(m => {   // n-й аргумент вызова, если это число
    let d = 0, i = m.index + m[0].length, a = 0, st = i;
    for (; i < code.length; i++) { const ch = code[i]; if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { if (!d) break; d--; } else if (ch === ',' && !d) { if (a === n) break; a++; st = i + 1; } }
    return a === n ? +code.slice(st, i).trim() : NaN;
  }).filter(Number.isInteger);
  const deps = SF.map((F, j) => {
    const ids = new Set(F.code.match(/[A-Za-z_$][\w$]*/g) || []), d = new Set([j]);
    SF.forEach((G, g) => { if (g !== j && G.defs.some(x => ids.has(x))) d.add(g); });            // общие функции и миры
    const reads = [...F.code.matchAll(/SCENES\[\s*(\d+)\s*\](?!\s*=(?!=))/g)].map(m => +m[1]).concat(argN(F.code, 'paperTurnIn', 2));
    for (const k of reads) if (fileOf[k] != null) d.add(fileOf[k]);                                 // рисует чужую сцену
    return d;
  });
  for (let changed = true; changed;) { changed = false; for (const d of deps) for (const g of [...d]) for (const x of deps[g]) if (!d.has(x)) { d.add(x); changed = true; } }
  SF.forEach((F, j) => { const h = sha1([...deps[j]].sort((x, y) => x - y).map(g => SF[g].h)); F.ks.forEach(k => { if (k < I.n) own[k] += h; }); });
  const links = SF.map((F, j) => [...deps[j]].filter(g => g !== j).map(g => `${F.ks.join('+')}←${SF[g].ks.join('+')}`)).flat();
  if (links.length) console.log(`[render] связи сцен по коду: ${links.join(', ')}`);
  if (I.s6) I.s6.units.forEach((u, k) => { if (k < I.n) { own[k] += sha1(u, I.s6.scenes[k], dirSig('assets/studio/scenes/' + u.el)); ownDirs.push('assets/studio/scenes/' + u.el + '/'); } });
  const skip = f => f === 'src/vo_timing.js' || ownFiles.has(f) || (!!I.s6 && (f === 'src/montage.js' || ownDirs.some(d => f.startsWith(d))));
  const G = sha1(filesSig(skip), { fps, BITRATE, size: fmt0(), rest: I.s6 && I.s6.rest, cap: I.capStyle });
  // кадр -> кусок: та же логика, что в renderFrame (main.js)
  const lab = new Array(N);
  for (let i = 0; i < N; i++) {
    const T = Math.min(Math.max(i / fps, 0), I.TOTAL); let k = 0;
    while (k < I.n - 1 && T >= I.B[k + 1]) k++;
    let L = 's' + k;
    for (const kb of [k, k + 1]) { if (kb <= 0 || kb >= I.n) continue; const td = I.tr[kb][1], a0 = I.B[kb] - td / 2; if (T >= a0 && T < a0 + td) { L = 't' + kb; break; } }
    lab[i] = L;
  }
  const end = k => (k + 1 < I.n ? I.B[k + 1] : I.TOTAL), memo = {};
  const sceneKey = k => memo[k] || (memo[k] = (() => {
    const a = I.B[k] - 1, b = end(k) + 1;
    const vo = I.vo.map((s, j) => ((j >= k - 1 && j <= k + 1) || (s[0] < b && s[0] + s[1] > a) ? [j, s] : null)).filter(Boolean);   // WT() сцены — её секция и соседние
    return sha1(own[k], I.B[k], end(k), I.tr[k], I.tr[k + 1] || null, k === I.n - 1 ? I.TOTAL : 0, vo);
  })());
  const chunks = [];
  for (let i = 0; i < N;) { let j = i; while (j < N && lab[j] === lab[i] && j - i < CH0) j++; chunks.push({ a: i, b: j, L: lab[i] }); i = j; }
  for (const c of chunks) {
    const k = +c.L.slice(1), first = c.L[0] === 's' && k > 0 && (c.a === 0 || lab[c.a - 1] !== c.L);
    const ks = c.L[0] === 't' || first ? [k - 1, k] : [k], ta = c.a / fps, tb = c.b / fps;
    const cap = I.cap && I.cap.filter(x => x[1] > ta - 0.1 && x[0] < tb + 0.1);
    const ov = I.s6 && I.s6.overlays.filter(o => o.at < tb + 0.1 && o.at + o.dur > ta - 0.1);
    c.key = sha1(G, c.L, c.a, c.b, ks.map(sceneKey), cap, ov);
    c.file = `${CDIR}/${fps}_${c.key}.h264`;
  }
  const todo = [], hit = [];
  for (const c of chunks) (!process.env.RENDER_FRESH && fs.existsSync(c.file) && fs.statSync(c.file).size > 0 ? hit : todo).push(c);
  const total = todo.reduce((s, c) => s + c.b - c.a, 0), nTodo = todo.length, nW = Math.max(1, Math.min(workers, nTodo)); let done = 0;
  const scenes = [...new Set(todo.map(c => c.L))].map(L => (L[0] === 't' ? `${+L.slice(1) - 1}→${L.slice(1)}` : L.slice(1)));
  console.log(`[render] по сценам: кусков ${chunks.length}, из кэша ${hit.length}, рендер ${todo.length} — ${total} из ${N} кадров${scenes.length ? ` (сцены ${scenes.join(', ')})` : ''}`);
  if (nTodo) await Promise.all(Array.from({ length: nW }, async (_, w) => {
    await new Promise(r => setTimeout(r, w * 400));   // stagger browser starts
    let br, page, since = 0, next;
    if (w === 0) { br = probeB; page = probe; } else { br = await launch(w); page = await openPage(br); }
    const restart = async () => { await closeB(br); br = await launch(w); page = await openPage(br); since = 0; };
    while ((next = todo.shift())) {
      const c = next;
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await withTO(encSeg(page, c.a, c.b, fps, BITRATE), 30000 + (c.b - c.a) * 500);
          fs.writeFileSync(c.file + '.tmp', Buffer.from(data, 'base64')); fs.renameSync(c.file + '.tmp', c.file);   // целиком или никак
          break;
        } catch (e) { if (attempt >= 3) throw e; console.log(`[render] worker ${w}: кусок ${c.a} ${e.message}, перезапуск браузера`); await restart(); }
      }
      since += c.b - c.a; if (since >= RECYCLE) await restart();
      done += c.b - c.a; console.log(`${done}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await closeB(br);
  }));
  else await closeB(probeB);
  // склейка по порядку -> build/frames/video.h264 (build.sh), старые куски и кадры — прочь
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^c\d{6}\.h264$|^\d{5}\.(jpg|png)$|\.tmp$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  const out = path.join(dir, 'video.h264'), fd = fs.openSync(out + '.tmp', 'w');
  for (const c of chunks) fs.writeSync(fd, fs.readFileSync(c.file));
  fs.closeSync(fd); fs.renameSync(out + '.tmp', out);
  fs.writeFileSync(path.join(dir, 'format.txt'), 'h264');
  fs.writeFileSync(path.join(dir, 'sig.json'), JSON.stringify({ segments: true, N, fps, chunks: chunks.length, complete: Date.now() }));
  // кэш этой частоты кадров — куски этой и прошлой сборки («верни как было» — без рендера), другая частота не трогается
  const lastF = `${CDIR}/${fps}_last.json`, now = chunks.map(c => path.basename(c.file, '.h264'));
  let prev = []; try { prev = JSON.parse(fs.readFileSync(lastF, 'utf8')); } catch (e) {}
  const keep = new Set([...now, ...prev]);
  fs.writeFileSync(lastF, JSON.stringify(now));
  for (const f of fs.readdirSync(CDIR)) { const m = f.match(/^(\d+)_([0-9a-f]+)\.(h264|json|h264\.tmp)$/); if (m && +m[1] === fps && !keep.has(`${m[1]}_${m[2]}`)) fs.rmSync(`${CDIR}/${f}`, { force: true }); }
  const sec = (Date.now() - t0) / 1000;
  console.log(`frames done ${total} in ${sec.toFixed(1)}s (${(total / sec).toFixed(1)} fps, ${nTodo ? nW : 0} workers, ${process.env.RENDER_GPU === '0' ? 'cpu' : 'gpu'}, h264, ${N - total} cached)`);
}

(async () => {
  const [mode, a1, a2] = process.argv.slice(2);
  const browser = ['snap', 'thumb', 'check'].includes(mode) ? await launch('main') : null;   // S22: кадрам и звуку он не нужен (было: лишний запуск Chrome)   // S22: кадрам он не нужен — у каждого работника свой браузер (было: лишний запуск Chrome на каждую сборку)
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
    } else if (mode === 'check') {                       // S22: только проверка привязок к словам -> build/wt_check.json
      const r = await wtSweep(await openPage(browser));
      console.log(r ? `check: промахов WT ${(r.miss || []).length}, сцен ${r.scenes}, секций голоса ${r.sections}` : 'check: lib.js проекта без проверки привязок (старый движок)');
    } else if (mode === 'sfx' || mode === 'audio') {
      // S22: звук — только если менялись его входы. sfx.json зависит от кода сцен и таймингов (src/ по содержимому, assets/ по времени),
      // микс — от sfx.json, музыки, голоса (build/vo), файлов звуков и самого audio.py. Было: страница + полное сведение на каждой сборке (~10 с, при экспорте локаций — дважды).
      const rd = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
      fs.mkdirSync('build', { recursive: true });
      const sg = sha1(filesSig(() => false), fmt0());
      if (!process.env.AUDIO_FRESH && fs.existsSync('build/sfx.json') && rd('build/sfx.sig') === sg) console.log('sfx: без изменений');
      else {
        const b2 = await launch('main');
        try {
          const page = await openPage(b2);
          // SFX events are registered lazily by scenes; sweep the timeline once
          const sfx = await page.evaluate(() => window.getSFX());
          fs.writeFileSync('build/sfx.json', JSON.stringify(sfx));
          fs.writeFileSync('build/sfx.sig', sg);
        } finally { await closeB(b2); }
      }
      if (mode === 'audio') {
        const L = [];
        for (const f of ['build/sfx.json', 'build/music.json', 'build/mixcfg.json', 'build/vo_timing.json', 'audio.py']) L.push(f + '|' + sha1(rd(f)));
        const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const f = `${d}/${e.name}`; if (e.isDirectory()) walk(f); else if (AUDIO_EXT.test(f)) { const st = fs.statSync(f); L.push(`${f}|${st.size}|${Math.round(st.mtimeMs)}`); } } };
        walk('build/vo'); walk('assets');
        const ag = sha1(L.sort().join('\n'));
        const outs = ['build/mix.wav', 'build/mix_no_vo.wav', 'build/sfx_resolved.json'];
        if (!process.env.AUDIO_FRESH && outs.every(f => fs.existsSync(f)) && rd('build/audio.sig') === ag) console.log('audio: без изменений — микс готов');
        else {
          const r = require('child_process').spawnSync(process.env.PYTHON || 'python', ['audio.py'], { stdio: 'inherit' });
          if (r.status !== 0) { console.error('audio.py: ошибка' + (r.error ? ' ' + r.error.message : '')); process.exitCode = 1; }
          else fs.writeFileSync('build/audio.sig', ag);
        }
      }
    } else if (mode === 'frames') {
      // Parallel render. Each worker = its own browser (own GPU process), takes contiguous chunks of frames,
      // every frame has a watchdog: a stalled page is killed and the frame is rendered again in a fresh browser.
      //   RENDER_GPU=0      software raster (slower, fallback)       RENDER_FMT=png   lossless PNG frames (2.5x slower)
      //   RENDER_RANGE=a:b  only frames a..b-1 (benchmarks)           RENDER_RECYCLE=N fresh browser every N frames (default 900)
      //   S12.12 возобновление: build/frames/sig.json — отпечаток (кадр, fps, формат, файлы src/ и assets/). Совпал — готовые куски не рендерятся заново
      //   (сбой, отмена, закрытое окно на 20-минутном ролике), всё готово — рендер пропускается. RENDER_FRESH=1 — начать с нуля.
      //   S13: RENDER_SEGS=<файл.json> [{a, b, out}] — несколько отрезков за ОДИН запуск браузеров (клипы сцен): каждый -> <out>/video.h264
      // S22: замок видеокарты — тяжёлый рендер по очереди со всем приложением (_studio/stands/gpulock.js; нет его — без замка)
      const GL = (() => { for (let d = process.cwd(); ;) { const f = path.join(d, '_studio', 'stands', 'gpulock.js'); if (fs.existsSync(f)) return require(f); const up = path.dirname(d); if (up === d) return null; d = up; } })();
      global.__gpuFree = GL ? await GL.acquire(process.env.STUDIO_GPU_WHAT || `рендер «${path.basename(process.cwd())}»${process.env.RENDER_SEGS ? ' (клипы)' : ''}`) : null;
      const fps = +(a1 || 30); let workers = +(a2 || 4);
      let fmt = process.env.RENDER_FMT === 'png' ? 'png' : process.env.RENDER_FMT === 'jpg' ? 'jpg' : 'h264';   // S12.8: по умолчанию H.264 в браузере (видеокарта)
      const dir = process.env.RENDER_OUT || 'build/frames';   // S13.4: клипы сцен — каждый кусок в свой каталог
      const probeB = await launch(0), probe = await openPage(probeB);   // первый работник: страница уже загружена — не грузим её второй раз
      const total = await probe.evaluate(() => window.TOTAL);
      if (!process.env.RENDER_SEGS && !process.env.RENDER_RANGE) await wtSweep(probe);   // S22: промахи WT() — до рендера, в лог сборки
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
      {
        workers = Math.min(workers, 4);                   // 3D-сцены (WebGL): видеокарта одна — 4 окна быстрее 6 (замер: 1044 кадра 31 с против 48 с)
        // S13: тяжёлые сцены (локации на 50+ объектов) упираются в видеокарту — окна мешают друг другу: «Металлические штуки» 1 окно 27 к/с, 2 — 22, 4 — 12.
        // Замер кадра в пробной странице: дороже ~12 мс — одно окно.
        const tot = await probe.evaluate(() => window.TOTAL), fps0 = +(a1 || 30);
        const ms = await probe.evaluate((tot, fps) => {
          let sum = 0, n = 0;
          for (const f of [0.2, 0.5, 0.8]) { const t = tot * f; renderFrame(t); const s = performance.now(); for (let i = 1; i <= 6; i++) renderFrame(t + i / fps); sum += performance.now() - s; n += 6; }
          return sum / n;
        }, tot, fps0).catch(() => 0);
        if (ms > 12) workers = 1;
        console.log(`[render] 3D: кадр ~${ms.toFixed(0)} мс — окон: ${workers}`);
      }
      const N = Math.ceil(total * fps), CH0 = fmt === 'h264' ? 120 : 60;
      const SEGS = process.env.RENDER_SEGS ? JSON.parse(fs.readFileSync(process.env.RENDER_SEGS, 'utf8')) : null;
      if (SEGS) process.env.RENDER_RANGE = process.env.RENDER_RANGE || 'segs';   // как RENDER_RANGE: без отпечатка и возобновления
      const [r0, r1x] = (SEGS ? '0:0' : (process.env.RENDER_RANGE || `0:${N}`)).split(':').map(Number), r1 = Math.min(N, Number.isFinite(r1x) && r1x > 0 ? r1x : N);
      if (fmt === 'h264' && !SEGS && !process.env.RENDER_RANGE) {   // S22: кэш по сценам — рендерятся только куски изменённых сцен
        await renderBySegments({ fps, workers, N, CH0, BITRATE, dir, probeB, probe });
        return;
      }
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
      if (SEGS) for (const g of SEGS) { fs.rmSync(g.out, { recursive: true, force: true }); fs.mkdirSync(g.out, { recursive: true }); }
      fs.writeFileSync(path.join(dir, 'format.txt'), fmt);
      if (!process.env.RENDER_RANGE) fs.writeFileSync(sigF, JSON.stringify({ sig, N, fps, fmt, started: Date.now() }));
      const chunkF = c0 => path.join(dir, `c${String(c0).padStart(6, '0')}.h264`), frameF = i => path.join(dir, `${String(i).padStart(5, '0')}.${fmt}`);
      const have = c0 => (fmt === 'h264' ? (fs.existsSync(chunkF(c0)) && fs.statSync(chunkF(c0)).size > 0)
        : Array.from({ length: Math.min(CH0, r1 - c0) }, (_, k) => fs.existsSync(frameF(c0 + k))).every(Boolean));
      const CH = CH0, RECYCLE = +(process.env.RENDER_RECYCLE || 900), TIMEOUT = 30000;
      // очередь кусков: обычный рендер — r0..r1 подряд; RENDER_SEGS — куски каждого отрезка в его каталог (кусок не пересекает границу отрезка)
      const JOBS = [];
      for (const g of (SEGS || [{ a: r0, b: r1, out: dir }])) for (let c = Math.max(0, g.a); c < Math.min(N, g.b); c += CH0) JOBS.push({ c0: c, c1: Math.min(c + CH0, g.b, N), dir: g.out });
      let nextJob = 0, done = 0; const t0 = Date.now(), todo = JOBS.reduce((n, j) => n + j.c1 - j.c0, 0);
      const chunkIn = (d, c0) => path.join(d, `c${String(c0).padStart(6, '0')}.h264`);
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
          const J = JOBS[nextJob++]; if (!J) break;
          const c0 = J.c0;
          if (same && have(c0)) continue;                 // готово с прошлого запуска
          if (fmt === 'h264') {                          // S12.8: весь кусок — одним вызовом, наружу только сжатый поток
            const c1 = J.c1, cf = chunkIn(J.dir, c0);
            for (let attempt = 0; ; attempt++) {
              try { const buf = Buffer.from(await withTimeout(encChunk(page, c0, c1), TIMEOUT + (c1 - c0) * 500), 'base64'); fs.writeFileSync(cf + '.tmp', buf); fs.renameSync(cf + '.tmp', cf); break; }   // целиком или никак — для возобновления
              catch (e) { if (attempt >= 3) throw e; console.log(`[render] worker ${w}: chunk ${c0} ${e.message}, restarting browser`); await fresh(); }
            }
            since += c1 - c0; if (since >= RECYCLE) await fresh();
            done += c1 - c0; console.log(`${done}/${todo}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            continue;
          }
          for (let i = c0; i < J.c1; i++) {
            for (let attempt = 0; ; attempt++) {
              try { save(await withTimeout(grabF(page, i / fps), TIMEOUT), path.join(J.dir, `${String(i).padStart(5, '0')}.${fmt}`)); break; }
              catch (e) { if (attempt >= 3) throw e; console.log(`[render] worker ${w}: frame ${i} ${e.message}, restarting browser`); await fresh(); }
            }
            if (++since >= RECYCLE) await fresh();
            if (++done % 100 === 0) console.log(`${done}/${todo}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          }
        }
        await closeB(br);
      }));
      if (fmt === 'h264') for (const d of [...new Set(JOBS.map(j => j.dir))]) {   // куски по порядку -> <каталог>/video.h264
        const fd = fs.openSync(path.join(d, 'video.h264'), 'w');
        for (const f of fs.readdirSync(d).filter(f => /^c\d{6}\.h264$/.test(f)).sort()) { fs.writeSync(fd, fs.readFileSync(path.join(d, f))); fs.rmSync(path.join(d, f)); }
        fs.closeSync(fd);
      }
      if (!process.env.RENDER_RANGE) fs.writeFileSync(sigF, JSON.stringify({ sig, N, fps, fmt, complete: Date.now() }));
      console.log(`frames done ${todo} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${(todo / ((Date.now() - t0) / 1000)).toFixed(1)} fps, ${workers} workers, ${process.env.RENDER_GPU === '0' ? 'cpu' : 'gpu'}, ${fmt})`);
      return;
    }
  } finally { if (browser) await closeB(browser); if (global.__gpuFree) global.__gpuFree(); }
})();
