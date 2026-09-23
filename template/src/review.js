// Review tool: live player + timecoded notes with pins, saved to review/notes.{json,md}
(() => {
  const $ = id => document.getElementById(id);
  const FPS = 60;
  const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  const SEG_COLORS = ['#6d28d9', '#c2410c', '#be185d', '#1d4ed8', '#0e7490', '#a16207'];

  let T = 0, playing = false, clock0 = 0, t0 = 0;
  let notes = [], draft = null, activeId = null, filter = 'open', lastN = 0, codeV = null, loopOn = false;
  const audio = new Audio(); audio.preload = 'auto';

  // ---------- state persisted across hot reloads ----------
  const keep = (() => { try { return JSON.parse(sessionStorage.getItem('review') || '{}'); } catch { return {}; } })();
  const persist = () => { try { sessionStorage.setItem('review', JSON.stringify({ T, draft, filter, snd: $('snd').value, rate: $('rate').value, activeId, loopOn })); } catch {} };

  // ---------- helpers ----------
  const touch = n => { n.updated = Date.now(); return n; };   // every change is stamped; the server merges by this
  const live = () => notes.filter(n => !n.deleted);
  const sceneAt = t => { let k = 0; while (k < SCENES.length - 1 && t >= B[k + 1]) k++; return k; };
  const captionAt = t => { const c = CHUNKS.find(c => t >= c.t0 && t < c.t1); return c ? c.ws.map(w => w.w).join(' ') : ''; };

  const parseT = str => {
    const m = String(str).trim().replace(',', '.').match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    return m ? (+(m[1] || 0)) * 60 + (+m[2]) : null;
  };
  // range used for looping: the draft if it has an end, otherwise the selected note
  function curRange() {
    if (draft && draft.t2) return draft;
    const n = live().find(x => x.id === activeId);
    return n && n.t2 ? n : null;
  }
  function updLoopBtn() {
    const b = $('loopBtn'), r = curRange();
    b.classList.toggle('sel', loopOn && !!r);
    b.style.opacity = r ? 1 : 0.45;
    b.title = r ? `Повтор отрезка ${fmt(r.t)} – ${fmt(r.t2)} (L)` : 'Повтор отрезка: сначала выбери отрезок (Shift+протянуть по таймлайну или I / O)';
  }
  // "От / До" editor; mutates o.t / o.t2 and calls onChange()
  function rangeEditor(o, onChange) {
    const box = el('div', 'range');
    const row = (label, key) => {
      const inp = el('input', 'time');
      inp.value = o[key] ? fmt(o[key]) : '';
      if (key === 't2') inp.placeholder = 'точка';
      inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); };
      inp.onchange = () => {
        const empty = inp.value.trim() === '';
        const v = empty && key === 't2' ? null : parseT(inp.value);
        if (v === null && key === 't') { inp.value = fmt(o.t); return; }
        o[key] = v === null ? null : +clamp(v, 0, TOTAL).toFixed(3);
        if (o.t2 != null && o.t2 <= o.t) o.t2 = null;
        onChange();
        if (key === 't') seek(o.t);
      };
      const now = el('button', '', '⤓ сейчас'); now.title = 'Поставить текущий момент';
      now.onclick = () => {
        if (key === 't') { o.t = +T.toFixed(3); if (o.t2 != null && o.t2 <= o.t) o.t2 = null; }
        else if (T > o.t + 0.02) o.t2 = +T.toFixed(3);
        onChange();
      };
      box.append(el('span', 'lbl', label), inp, now);
      if (key === 't2') {
        const x = el('button', 'ghost', '×'); x.title = 'Убрать конец (правка на один момент)';
        x.onclick = () => { o.t2 = null; onChange(); };
        box.append(x);
      } else box.append(el('span'));
    };
    row('От', 't'); row('До', 't2');
    if (o.t2) box.append(el('span', 'dur', `длина ${(o.t2 - o.t).toFixed(2)} с`));
    return box;
  }

  function draw() {
    renderFrame(T);
    $('time').textContent = `${fmt(T)} / ${fmt(TOTAL)}`;
    const k = sceneAt(T);
    $('hud').textContent = `${fmt(T)} · кадр ${Math.round(T * FPS)} · ${k + 1}. ${SCENES[k].name}`;
    $('caption').textContent = captionAt(T) ? `«${captionAt(T)}»` : '';
    $('head').style.left = (T / TOTAL * 100) + '%';
    drawPins();
  }

  function seek(t, keepPlaying = true) {
    T = clamp(t, 0, TOTAL);
    if (playing && keepPlaying) { clock0 = performance.now(); t0 = T; if (audio.src) audio.currentTime = T; }
    else if (audio.src) audio.currentTime = T;
    draw(); persist();
  }

  function setPlay(on) {
    if (on && T >= TOTAL - 0.01) T = 0;
    playing = on; $('play').textContent = on ? '❚❚' : '▶';
    if (!on && typeof stopPreview === 'function') stopPreview();
    clock0 = performance.now(); t0 = T;
    if (audio.src) {
      audio.currentTime = T; audio.playbackRate = +$('rate').value;
      on ? audio.play().catch(() => {}) : audio.pause();
    }
    persist();
  }

  function loop() {
    if (playing) {
      const useAudio = audio.src && !audio.paused && audio.readyState >= 2;
      T = useAudio ? audio.currentTime : t0 + (performance.now() - clock0) / 1000 * +$('rate').value;
      const r = loopOn ? curRange() : null;
      if (r && (T >= r.t2 || T < r.t - 0.05)) seek(r.t);
      else if (T >= TOTAL) { T = TOTAL; setPlay(false); }
      draw();
    }
    requestAnimationFrame(loop);
  }

  // ---------- pins on the frame ----------
  function drawPins() {
    const box = $('pins'); box.innerHTML = '';
    const add = (n, cls) => {
      if (n.x == null) return;
      const d = document.createElement('div');
      d.className = 'pin ' + cls; d.textContent = cls === 'draft' ? '+' : n.id;
      d.style.left = (n.x / W * 100) + '%'; d.style.top = (n.y / H * 100) + '%';
      if (cls !== 'draft') d.onclick = e => { e.stopPropagation(); focusNote(n.id); };
      box.appendChild(d);
    };
    for (const n of live()) {
      const t2 = n.t2 || n.t;
      if (T >= n.t - 0.4 && T <= t2 + 0.4) add(n, n.status === 'done' ? 'done' : '');
    }
    if (draft) add(draft, 'draft');
  }

  // ---------- timeline ----------
  function buildTimeline() {
    const segs = $('segs'); segs.innerHTML = '';
    SCENES.forEach((s, k) => {
      const d = document.createElement('div'); d.className = 'seg';
      d.style.left = (B[k] / TOTAL * 100) + '%'; d.style.width = ((B[k + 1] - B[k]) / TOTAL * 100) + '%';
      d.style.background = SEG_COLORS[k % SEG_COLORS.length];
      d.textContent = `${k + 1}. ${s.name}`; segs.appendChild(d);
    });
    const words = $('words'); words.innerHTML = '';
    CHUNKS.forEach(c => c.ws.forEach(w => {
      const d = document.createElement('div'); d.className = 'w';
      d.style.left = (w.t / TOTAL * 100) + '%'; d.style.width = Math.max(0.15, (w.e - w.t) / TOTAL * 100) + '%';
      d.title = w.w; words.appendChild(d);
    }));
  }
  function drawMarks() {
    const m = $('marks'); m.innerHTML = '';
    if (draft) {
      const d = document.createElement('div'); d.className = 'selRange' + (draft.t2 ? '' : ' point');
      d.style.left = (draft.t / TOTAL * 100) + '%';
      d.style.width = draft.t2 ? ((draft.t2 - draft.t) / TOTAL * 100) + '%' : '0';
      m.appendChild(d);
    }
    updLoopBtn();
    for (const n of live()) {
      if (n.t2) {
        const r = document.createElement('div'); r.className = 'rangeBar';
        r.style.left = (n.t / TOTAL * 100) + '%'; r.style.width = ((n.t2 - n.t) / TOTAL * 100) + '%'; m.appendChild(r);
      }
      const d = document.createElement('div'); d.className = 'mk' + (n.status === 'done' ? ' done' : '');
      d.style.left = (n.t / TOTAL * 100) + '%'; d.textContent = n.id; d.title = n.text;
      m.appendChild(d);
    }
  }
  const tl = $('timeline');
  const tAtX = e => { const r = tl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width) * TOTAL; };
  let dragging = false, selFrom = null;
  tl.addEventListener('mousedown', e => {
    if (e.shiftKey) { // Shift+drag = select a range
      setPlay(false);
      selFrom = tAtX(e);
      draft = Object.assign(draft || { x: null, y: null, text: '' }, { t: +selFrom.toFixed(3), t2: null });
      renderNotes();
      return;
    }
    dragging = true; seek(tAtX(e));
  });
  window.addEventListener('mousemove', e => {
    if (selFrom !== null) {
      const t = tAtX(e), a = Math.min(selFrom, t), b = Math.max(selFrom, t);
      draft.t = +a.toFixed(3); draft.t2 = b - a > 0.05 ? +b.toFixed(3) : null;
      T = t; draw(); drawMarks();
    }
    if (dragging) seek(tAtX(e));
    const r = tl.getBoundingClientRect(), h = $('hover');
    if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
      h.style.display = 'block'; h.style.left = (e.clientX - r.left) + 'px'; tl.title = fmt(tAtX(e));
    } else h.style.display = 'none';
  });
  window.addEventListener('mouseup', () => {
    if (selFrom !== null) { selFrom = null; seek(draft.t, false); persist(); renderNotes(); }
    dragging = false;
  });

  // ---------- notes panel ----------
  function renderNotes() {
    const box = $('notes'); box.innerHTML = '';
    if (sfxDraft) box.appendChild(sfxCard());
    if (draft) box.appendChild(draftCard());
    const list = live().filter(n => filter === 'all' || (filter === 'done' ? n.status === 'done' : n.status !== 'done')).sort((a, b) => a.t - b.t);
    if (!list.length && !draft && !sfxDraft) {
      const e = document.createElement('div'); e.className = 'empty';
      e.innerHTML = live().length ? 'Тут пусто — смени фильтр.' : 'Правок пока нет.<br>Поставь на паузу и кликни по кадру там, где нужно что-то поменять.';
      box.appendChild(e);
    }
    for (const n of list) box.appendChild(noteCard(n));
    drawMarks(); drawPins(); drawSfxLane();
  }

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function draftCard() {
    const c = el('div', 'card active');
    const top = el('div', 'top');
    top.append(el('span', 'num', '+'));
    const tc = el('span', 'tc', fmt(draft.t) + (draft.t2 ? ' – ' + fmt(draft.t2) : '')); tc.onclick = () => seek(draft.t);
    top.append(tc, el('span', 'scene', `${sceneAt(draft.t) + 1}. ${SCENES[sceneAt(draft.t)].name}`));
    c.append(top);
    const cap = captionAt(draft.t); if (cap) c.append(el('div', 'cap', `«${esc(cap)}»`));
    c.append(rangeEditor(draft, () => { persist(); renderNotes(); }));
    const ta = el('textarea'); ta.placeholder = 'Что поменять? Например: «птица слишком мелкая», «плашку поднять выше», «здесь нужна пауза»…';
    ta.value = draft.text || ''; ta.oninput = () => { draft.text = ta.value; persist(); };
    ta.onkeydown = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDraft(); }
      if (e.key === 'Escape') { draft = null; persist(); renderNotes(); }
      e.stopPropagation();
    };
    c.append(ta);
    const acts = el('div', 'acts');
    const save = el('button', 'primary', 'Сохранить'); save.onclick = saveDraft;
    const cancel = el('button', 'ghost', 'Отмена'); cancel.onclick = () => { draft = null; persist(); renderNotes(); };
    acts.append(save, cancel); c.append(acts);
    setTimeout(() => { if (!(document.activeElement && document.activeElement.tagName === 'INPUT')) ta.focus(); }, 0);
    return c;
  }

  function noteCard(n) {
    const c = el('div', 'card' + (n.status === 'done' ? ' done' : '') + (n.id === activeId ? ' active' : ''));
    c.dataset.id = n.id;
    const top = el('div', 'top');
    top.append(el('span', 'num', n.kind === 'sfx' ? '🔊' : n.id));
    const tc = el('span', 'tc', (n.kind === 'sfx' ? `#${n.id} · ` : '') + fmt(n.t) + (n.t2 ? ' – ' + fmt(n.t2) : '')); tc.onclick = () => { setPlay(false); seek(n.t); activeId = n.id; renderNotes(); };
    top.append(tc, el('span', 'scene', `${n.scene}. ${esc(n.sceneName || '')}`));
    c.append(top);
    if (n.caption) c.append(el('div', 'cap', `«${esc(n.caption)}»`));
    const txt = el('div', 'txt', esc(n.text || ''));
    c.append(txt);
    for (const r of n.replies || []) c.append(el('div', 'cap', `<b>${esc(r.who)}:</b> ${esc(r.text)}`));
    const acts = el('div', 'acts');
    if (n.kind === 'sfx' && n.sfx) {
      const url = n.sfx.replace ? `/sfxlib/${n.sfx.replace.slice(4)}.wav` : (SFXLIST.find(x => x.i === n.sfx.i) || {}).preview;
      if (url) { const pb = el('button', '', '▶'); pb.title = 'Послушать (ещё раз — стоп)'; pb.onclick = () => playBuf(url, n.sfx.gainDb || 0, 0, pb); acts.append(pb); }
    }
    const done = el('button', '', n.status === 'done' ? '↺ Открыть снова' : '✓ Сделано');
    done.onclick = () => { n.status = n.status === 'done' ? 'open' : 'done'; touch(n); save(); renderNotes(); };
    const edit = el('button', 'ghost', 'Изменить');
    edit.onclick = () => {
      const ta = el('textarea'); ta.value = n.text || ''; txt.replaceWith(ta); ta.focus();
      let re = null;
      const onRange = () => { touch(n); save(); const nre = rangeEditor(n, onRange); re.replaceWith(nre); re = nre; drawMarks(); drawPins(); };
      re = rangeEditor(n, onRange);
      ta.before(re);
      const fin = () => { n.text = ta.value; touch(n); save(); renderNotes(); };
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) fin(); if (e.key === 'Escape') renderNotes(); e.stopPropagation(); };
      edit.textContent = 'Готово'; edit.onclick = fin;
    };
    const del = el('button', 'ghost', 'Удалить');
    del.onclick = () => { if (confirm(`Удалить правку #${n.id}?`)) { n.deleted = true; touch(n); save(); renderNotes(); } };
    acts.append(done, edit, del); c.append(acts);
    return c;
  }

  function focusNote(id) {
    const n = live().find(x => x.id === id); if (!n) return;
    activeId = id; setPlay(false); seek(n.t);
    if (filter === 'open' && n.status === 'done') filter = 'all';
    renderNotes();
    const c = document.querySelector(`.card[data-id="${id}"]`); if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function newDraft(x, y) {
    setPlay(false); sfxDraft = null;
    draft = { t: +T.toFixed(3), x, y, text: draft && draft.text || '' };
    persist(); renderNotes();
  }

  async function saveDraft() {
    if (!draft || !draft.text.trim()) return;
    const id = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    const k = sceneAt(draft.t);
    const n = { id, t: draft.t, t2: draft.t2 || null, x: draft.x, y: draft.y, text: draft.text.trim(), status: 'open',
      scene: k + 1, sceneName: SCENES[k].name, caption: captionAt(draft.t), created: new Date().toISOString(), updated: Date.now() };
    notes.push(n); draft = null; activeId = id; persist();
    await save(); renderNotes();
    shot(n);
  }

  async function shot(n) {
    const keepT = T;
    renderFrame(n.t);
    const c = document.createElement('canvas'); c.width = 540; c.height = 960;
    const g = c.getContext('2d');
    g.drawImage($('c'), 0, 0, 540, 960);
    if (n.x != null) {
      g.lineWidth = 6; g.strokeStyle = '#fff'; g.fillStyle = '#ff3fd0';
      g.beginPath(); g.arc(n.x / 2, n.y / 2, 22, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = '800 22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(n.id, n.x / 2, n.y / 2 + 1);
    }
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 0, 540, 36);
    g.fillStyle = '#ffd23f'; g.font = '700 20px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(`#${n.id} · ${fmt(n.t)} · ${n.scene}. ${n.sceneName}`, 10, 18);
    T = keepT; draw();
    await fetch(`/api/shot?id=${n.id}`, { method: 'POST', body: c.toDataURL('image/png') });
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    return new Promise(res => {
      saveTimer = setTimeout(async () => {
        try {
          const r = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notes) });
          const j = await r.json(); lastN = j.n;
          if (j.notes) {   // merged list (may contain Claude's replies)
            notes = j.notes;
            const editing = [...document.querySelectorAll('#notes .card:not(.active) textarea')].length > 0;
            if (!editing) renderNotes(); else { drawMarks(); drawPins(); }
          }
          $('saved').textContent = 'сохранено ' + new Date().toLocaleTimeString().slice(0, 5);
        } catch { $('saved').textContent = '⚠ не сохранилось (сервер?)'; }
        res();
      }, 150);
    });
  }
  async function loadNotes() {
    try { notes = await (await fetch('/api/notes')).json(); } catch { notes = []; }
    renderNotes();
  }

  // copy as text (fallback way to send)
  $('copy').onclick = async () => {
    const lines = live().filter(n => n.status !== 'done').sort((a, b) => a.t - b.t).map(n =>
      `#${n.id} [${fmt(n.t)}${n.t2 ? '–' + fmt(n.t2) : ''}] сцена ${n.scene} «${n.sceneName}»${n.x != null ? ` (точка ${Math.round(n.x)},${Math.round(n.y)})` : ''}: ${n.text}`);
    try { await navigator.clipboard.writeText(lines.join('\n')); $('saved').textContent = 'скопировано ✓'; } catch { prompt('Скопируй:', lines.join('\n')); }
  };

  // ---------- sounds: lane on the timeline + sound card (replace / volume / delete / comment / add) ----------
  let SFXLIST = [], LIBIDX = [], sfxDraft = null, actx = null;
  const bufCache = {};
  const LANE_COLORS = { whoosh: '#22e1ff', hit: '#ff5470', riser: '#ff8a1f', glitch: '#a855f7', electric: '#3b82f6', cinematic: '#e05599',
    anime: '#ff7ac8', fire: '#ff6b2a', meme: '#9ca3af', other: '#ffd23f', camera: '#e4e5ee', synth: '#6b6a9a' };
  const sfxCat = src => src.startsWith('lib:') ? src.slice(4).split('/')[0] : 'synth';
  const dbStr = db => (db > 0 ? '+' : db < 0 ? '−' : '±') + Math.abs(db) + ' dB';
  const libMeta = id => LIBIDX.find(s => s.id === id);

  let SRV = { api: 0, sfxlib: false };
  async function loadSfx() {
    try { SFXLIST = await (await fetch('/build/sfx_resolved.json', { cache: 'no-store' })).json(); }
    catch { SFXLIST = []; }
    try { SRV = await (await fetch('/api/version')).json(); } catch {}
    try { LIBIDX = (await (await fetch('/sfxlib/index.json')).json()).sounds || []; } catch { LIBIDX = []; }
    drawSfxLane();
  }
  function libProblem() {
    if (LIBIDX.length) return '';
    if (!SRV.api || SRV.api < 2) return 'Сервер ревью старой версии. Закрой окно сервера и запусти review.bat заново.';
    if (!SRV.sfxlib) return 'Библиотека звуков не импортирована: python _pipeline/sfx_library.py import "<папка с паком>"';
    return 'Библиотека звуков не загрузилась.';
  }

  function sfxNotesFor(cue) {
    return live().filter(n => n.kind === 'sfx' && n.sfx && !n.sfx.new && n.sfx.i === cue.i && Math.abs(n.sfx.t - cue.t) < 0.01 && n.status !== 'done');
  }

  // sounds are packed onto separate rows (like tracks in a video editor) so overlapping ones don't cover each other
  const LANE_H = 16, LANE_TOP = 46, MAX_LANES = 10;
  function drawSfxLane() {
    const lane = $('sfxlane'); if (!lane) return;
    lane.innerHTML = '';
    const px = tl.getBoundingClientRect().width || 1000;   // sizes in pixels, so zooming in spreads sounds out
    const minW = TOTAL * 16 / px, gap = TOTAL * 3 / px;
    const items = SFXLIST.map(s => ({ s, a: s.start, b: s.start + Math.max(Math.min(s.dur, 4), minW) }));
    for (const n of live().filter(n => n.kind === 'sfx' && n.sfx && n.sfx.new && n.status !== 'done'))
      items.push({ n, a: n.t, b: n.t + minW });
    items.sort((x, y) => x.a - y.a);
    const ends = [];
    for (const it of items) {
      let j = ends.findIndex(e => e <= it.a - gap);
      if (j < 0) { if (ends.length < MAX_LANES) { j = ends.length; ends.push(0); } else j = ends.indexOf(Math.min(...ends)); }
      ends[j] = it.b; it.lane = j;
    }
    const lanes = Math.max(1, ends.length);
    lane.style.height = lanes * LANE_H + 'px';
    tl.style.setProperty('--mt', (LANE_TOP + lanes * LANE_H + 2) + 'px');
    tl.style.height = (LANE_TOP + lanes * LANE_H + 24) + 'px';
    for (const it of items) {
      const d = document.createElement('div');
      d.style.top = (it.lane * LANE_H + 1) + 'px';
      d.style.left = (it.a / TOTAL * 100) + '%';
      if (it.n) {   // new-sound note
        d.className = 'sx new'; d.style.width = ((it.b - it.a) / TOTAL * 100) + '%'; d.title = 'добавить ' + it.n.sfx.replace;
        d.addEventListener('mousedown', e => { e.stopPropagation(); focusNote(it.n.id); });
      } else {
        const s = it.s, pending = sfxNotesFor(s);
        d.className = 'sx' + (pending.length ? ' noted' : '') + (pending.some(n => n.sfx.delete) ? ' del' : '')
          + (sfxDraft && sfxDraft.cue && sfxDraft.cue.i === s.i ? ' sel' : '');
        d.style.width = ((it.b - it.a) / TOTAL * 100) + '%';
        d.style.background = LANE_COLORS[sfxCat(s.src)] || '#ffd23f';
        d.textContent = (s.src.startsWith('lib:') ? s.src.slice(4).split('/').pop() : s.type).replace(/\|.*/, '');
        d.title = `${s.type}${s.src !== s.type ? ' → ' + s.src : ''} · ${fmt(s.t)}${s.origin === 'transition' ? ' · вжух перехода' : ''}`;
        d.addEventListener('mousedown', e => { e.stopPropagation(); openSfx(s); });
      }
      lane.appendChild(d);
    }
  }

  function toast(msg) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg; t.style.opacity = 1; clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.opacity = 0), 3500);
  }

  let curSrc = null, curBtn = null;
  function stopPreview() {
    if (curSrc) { try { curSrc.onended = null; curSrc.stop(); } catch {} curSrc = null; }
    if (curBtn) { curBtn.textContent = curBtn.dataset.label; curBtn.classList.remove('playing'); curBtn = null; }
  }
  async function playBuf(url, db = 0, when = 0, btn = null) {
    if (btn && btn === curBtn) { stopPreview(); return; }      // second click on the same button = stop
    stopPreview();
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') await actx.resume();
      if (!bufCache[url]) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(r.status === 404 && url.startsWith('/sfxlib/') ? (libProblem() || 'звук не найден') : `HTTP ${r.status}`);
        bufCache[url] = await actx.decodeAudioData(await r.arrayBuffer());
      }
      const src = actx.createBufferSource(), g = actx.createGain();
      src.buffer = bufCache[url]; g.gain.value = Math.pow(10, db / 20);
      src.connect(g).connect(actx.destination);
      src.start(actx.currentTime + Math.max(0, when));
      curSrc = src;
      if (btn) {
        btn.dataset.label = btn.dataset.label || btn.textContent;
        btn.textContent = '■'; btn.classList.add('playing'); curBtn = btn;
      }
      src.onended = () => { if (curSrc === src) stopPreview(); };
      return src;
    } catch (e) { toast('🔇 Не проигралось: ' + (e.message || e)); }
  }

  function openSfx(cue) {
    setPlay(false);
    draft = null;
    sfxDraft = { cue, t: cue.t, replace: null, gainDb: 0, delete: false, align: cue.align || null, text: '' };
    seek(cue.start, false);
    renderNotes(); drawSfxLane();
  }
  function newSfxHere() {
    setPlay(false); draft = null;
    sfxDraft = { cue: null, t: +T.toFixed(3), replace: null, gainDb: 0, delete: false, align: 'peak', text: '' };
    renderNotes(); drawSfxLane();
  }

  // audition: the chosen/original sound alone, or the mix around it with the replacement layered on top
  function previewUrl(d) { return d.replace ? `/sfxlib/${d.replace.slice(4)}.wav` : d.cue && d.cue.preview; }
  function previewOffset(d) {   // seconds from sound start to its placement time
    if (!d.replace) return 0;
    const m = libMeta(d.replace.slice(4));
    return d.align === 'peak' && m ? m.peak_t : 0;
  }
  function inContext(d) {
    const at = d.cue ? d.cue.t : d.t;
    const from = Math.max(0, (d.cue ? d.cue.start : at) - 1.5);
    seek(from); setPlay(true);
    if (d.replace || d.gainDb) {
      const url = previewUrl(d); if (!url) return;
      const baseGain = d.cue ? 20 * Math.log10(Math.max(1e-3, d.cue.play_gain || 1)) : 0;
      playBuf(url, baseGain + d.gainDb, (at - previewOffset(d) - from) / (+$('rate').value || 1));
    }
  }

  // library browser: search box + folder chips (categories), always visible in the sound card
  function libPicker(d, onPick) {
    const box = el('div', 'picker');
    const problem = libProblem();
    if (problem) { box.append(el('div', 'warn', esc(problem))); return box; }
    const q = el('input', 'search'); q.placeholder = `поиск по ${LIBIDX.length} звукам: whoosh, hit, pop, glitch…`; q.value = d.q || '';
    const cats = {};
    LIBIDX.forEach(s => (cats[s.category] = (cats[s.category] || 0) + 1));
    const chips = el('div', 'chips');
    const list = el('div', 'plist');
    const render = () => {
      d.q = q.value;
      const ws = q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const found = LIBIDX.filter(s => (!d.cat || s.category === d.cat) && ws.every(w => (s.id + ' ' + s.name).toLowerCase().includes(w)));
      list.innerHTML = '';
      for (const s of found.slice(0, 120)) {
        const row = el('div', 'prow' + (d.replace === 'lib:' + s.id ? ' on' : ''));
        const pb = el('button', '', '▶'); pb.title = 'Послушать (ещё раз — стоп)'; pb.onclick = () => playBuf(`/sfxlib/${s.id}.wav`, d.gainDb, 0, pb);
        const nm = el('span', 'pid', `${esc(s.id)} <i>${s.dur.toFixed(1)}s</i>${s.caution ? ' ⚠' : ''}`);
        nm.title = s.name + (s.caution ? ' — ' + s.caution : '') + ' — клик: выбрать';
        nm.onclick = () => onPick('lib:' + s.id);
        const pick = el('button', 'ghost', 'выбрать'); pick.onclick = () => onPick('lib:' + s.id);
        row.append(pb, nm, pick); list.append(row);
      }
      if (!found.length) list.append(el('div', 'cap', 'ничего не найдено'));
      else if (found.length > 120) list.append(el('div', 'cap', `ещё ${found.length - 120} — уточни поиск`));
    };
    const mk = (key, label) => {
      const b = el('button', 'fchip' + ((d.cat || null) === key ? ' sel' : ''), label);
      b.onclick = () => { d.cat = key; render(); chips.querySelectorAll('.fchip').forEach(x => x.classList.toggle('sel', x === b)); };
      chips.append(b);
    };
    mk(null, `все ${LIBIDX.length}`);
    Object.keys(cats).sort().forEach(c => mk(c, `${c} ${cats[c]}`));
    q.oninput = render; q.onkeydown = e => e.stopPropagation();
    box.append(q, chips, list); render();
    if (!d.cue) setTimeout(() => q.focus(), 0);
    return box;
  }

  function sfxSummary(d) {
    const parts = [];
    if (!d.cue) parts.push(`добавить ${d.replace}` + (d.align === 'peak' ? ' (пик на этот момент)' : ''));
    else {
      if (d.delete) parts.push('удалить');
      if (d.replace) parts.push(`заменить на ${d.replace}`);
    }
    if (d.gainDb) parts.push(`громкость ${dbStr(d.gainDb)}`);
    const what = d.cue ? `🔊 ${d.cue.type}${d.cue.src !== d.cue.type ? ` (${d.cue.src})` : ''}` : '🔊 новый звук';
    return `${what}: ${parts.join(', ') || 'комментарий'}`;
  }

  function sfxCard() {
    if (curBtn && !document.body.contains(curBtn)) curBtn = null;
    const d = sfxDraft;
    const c = el('div', 'card active sfxcard');
    const top = el('div', 'top');
    top.append(el('span', 'num', '🔊'));
    const tc = el('span', 'tc', fmt(d.cue ? d.cue.t : d.t)); tc.onclick = () => seek(d.cue ? d.cue.start : d.t);
    const k = sceneAt(d.cue ? d.cue.t : d.t);
    top.append(tc, el('span', 'scene', `${k + 1}. ${SCENES[k].name}`));
    c.append(top);
    if (d.cue) {
      const src = d.cue.src !== d.cue.type ? ` → <code>${esc(d.cue.src)}</code>` : '';
      c.append(el('div', 'sxname', `<code>${esc(d.cue.type)}</code>${src} <i>${d.cue.dur.toFixed(2)}s · gain ${d.cue.gain}${d.cue.origin === 'transition' ? ' · вжух перехода' : ''}</i>`));
    } else c.append(el('div', 'sxname', 'Новый звук в этот момент'));

    const row1 = el('div', 'acts');
    const pOrig = el('button', '', d.cue ? '▶ звук' : '▶'); pOrig.title = 'Послушать отдельно (с учётом громкости и замены). Ещё раз — стоп';
    pOrig.onclick = () => { const u = previewUrl(d); if (u) playBuf(u, d.gainDb, 0, pOrig); };
    const pCtx = el('button', '', '▶ в контексте'); pCtx.title = 'Проиграть микс вокруг этого места' + (d.cue ? ' (замена накладывается поверх оригинала)' : '');
    pCtx.onclick = () => inContext(d);
    row1.append(pOrig, pCtx); c.append(row1);

    // volume
    const vol = el('div', 'sxrow');
    const lab = el('span', 'lbl', 'Громкость'); const val = el('b', '', dbStr(d.gainDb));
    const rng = el('input'); rng.type = 'range'; rng.min = -24; rng.max = 12; rng.step = 1; rng.value = d.gainDb;
    rng.oninput = () => { d.gainDb = +rng.value; val.textContent = dbStr(d.gainDb); };
    rng.onchange = () => { const u = previewUrl(d); if (u) playBuf(u, d.gainDb); };
    vol.append(lab, rng, val); c.append(vol);

    // replace / pick
    const rep = el('div', 'sxrow');
    rep.append(el('span', 'lbl', d.cue ? 'Заменить' : 'Звук'));
    if (d.replace) {
      const chip = el('span', 'chip', `<code>${esc(d.replace)}</code>`);
      const x = el('button', 'ghost', '✕'); x.onclick = () => { d.replace = null; renderNotes(); };
      rep.append(chip, x);
    } else rep.append(el('span', 'cap', d.cue ? 'оставить как есть' : 'выбери ниже'));
    c.append(rep);
    c.append(libPicker(d, id => { d.replace = id; playBuf(`/sfxlib/${id.slice(4)}.wav`, d.gainDb); renderNotes(); }));
    if (!d.cue || d.replace) {
      const al = el('label', 'sxrow');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = d.align === 'peak';
      cb.onchange = () => { d.align = cb.checked ? 'peak' : null; };
      al.append(cb, el('span', '', 'пик звука ровно на этот момент (для ударов и вжухов)'));
      c.append(al);
    }
    if (d.cue) {
      const dl = el('label', 'sxrow');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = d.delete;
      cb.onchange = () => { d.delete = cb.checked; };
      dl.append(cb, el('span', '', 'удалить этот звук'));
      c.append(dl);
    }
    const ta = el('textarea'); ta.placeholder = 'Комментарий (необязательно): «слишком резко», «нужно что-то мягче», «звук раньше на полсекунды»…';
    ta.value = d.text; ta.oninput = () => { d.text = ta.value; };
    ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveSfx(); } if (e.key === 'Escape') { sfxDraft = null; renderNotes(); drawSfxLane(); } e.stopPropagation(); };
    c.append(ta);
    const acts = el('div', 'acts');
    const sv = el('button', 'primary', 'Сохранить правку'); sv.onclick = saveSfx;
    const cn = el('button', 'ghost', 'Отмена'); cn.onclick = () => { sfxDraft = null; renderNotes(); drawSfxLane(); };
    acts.append(sv, cn); c.append(acts);
    return c;
  }

  async function saveSfx() {
    const d = sfxDraft; if (!d) return;
    if (!d.cue && !d.replace) { alert('Выбери звук из библиотеки'); return; }
    if (d.cue && !d.replace && !d.gainDb && !d.delete && !d.text.trim()) { alert('Ничего не изменено: замени звук, поменяй громкость, удали или напиши комментарий'); return; }
    const id = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    const t = d.cue ? d.cue.t : d.t, k = sceneAt(t);
    const sfx = d.cue
      ? { i: d.cue.i, t: d.cue.t, type: d.cue.type, src: d.cue.src, gain: d.cue.gain, align: d.cue.align || null, scene: d.cue.scene, origin: d.cue.origin || null,
          replace: d.replace, replaceAlign: d.replace ? d.align : undefined, gainDb: d.gainDb, delete: d.delete }
      : { new: true, replace: d.replace, align: d.align, gainDb: d.gainDb };
    const text = sfxSummary(d) + (d.text.trim() ? '\n' + d.text.trim() : '');
    notes.push({ id, kind: 'sfx', t, t2: null, x: null, y: null, text, sfx, status: 'open', scene: k + 1, sceneName: SCENES[k].name,
      caption: captionAt(t), created: new Date().toISOString(), updated: Date.now() });
    sfxDraft = null; activeId = id;
    await save(); renderNotes(); drawSfxLane();
  }

  // ---------- timeline zoom (Ctrl + wheel over the timeline, or the −/+ buttons) ----------
  let zoom = 1;
  function setZoom(z, anchorT) {
    const wrap = $('tlwrap');
    const at = anchorT != null ? anchorT : T;
    const before = tl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const screenX = before.left + at / TOTAL * before.width - wr.left;     // keep this moment under the same x
    zoom = clamp(z, 1, 24);
    tl.style.width = (zoom * 100) + '%';
    $('zoomLbl').textContent = zoom.toFixed(zoom < 10 ? 1 : 0) + '×';
    wrap.scrollLeft = at / TOTAL * tl.getBoundingClientRect().width - screenX;
    drawSfxLane(); persist2();
  }
  function persist2() { try { sessionStorage.setItem('reviewZoom', String(zoom)); } catch {} }
  $('tlwrap').addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.altKey)) return;           // plain wheel scrolls horizontally as usual
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), tAtX(e));
  }, { passive: false });
  $('zoomIn').onclick = () => setZoom(zoom * 1.5);
  $('zoomOut').onclick = () => setZoom(zoom / 1.5);
  // keep the playhead visible while playing when zoomed in
  setInterval(() => {
    if (!playing || zoom <= 1) return;
    const wrap = $('tlwrap'), x = T / TOTAL * tl.getBoundingClientRect().width;
    if (x < wrap.scrollLeft + 40 || x > wrap.scrollLeft + wrap.clientWidth - 40) wrap.scrollLeft = x - wrap.clientWidth * 0.2;
  }, 250);

  // ---------- inputs ----------
  $('sfxAdd').onclick = newSfxHere;
  $('c').addEventListener('click', e => {
    const r = e.target.getBoundingClientRect();
    newDraft((e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H);
  });
  $('play').onclick = () => setPlay(!playing);
  $('loopBtn').onclick = () => {
    loopOn = !loopOn; updLoopBtn(); persist();
    const r = curRange();
    if (loopOn && r) { seek(r.t); if (!playing) setPlay(true); }
  };
  $('prevF').onclick = () => { setPlay(false); seek(Math.round(T * FPS - 1) / FPS); };
  $('nextF').onclick = () => { setPlay(false); seek(Math.round(T * FPS + 1) / FPS); };
  $('snd').onchange = () => { const v = $('snd').value; audio.pause(); if (v) { audio.src = v; audio.currentTime = T; } else audio.removeAttribute('src'); if (playing) setPlay(true); persist(); };
  $('rate').onchange = () => { audio.playbackRate = +$('rate').value; setPlay(playing); };
  document.querySelectorAll('#filters button').forEach(b => b.onclick = () => {
    filter = b.dataset.f; document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('sel', x === b)); persist(); renderNotes();
  });
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA') return;
    const step = e.shiftKey ? 1 : 1 / FPS;
    if (e.key === 'Escape') { stopPreview(); return; }
    if (e.code === 'Space') { e.preventDefault(); setPlay(!playing); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlay(false); seek(e.shiftKey ? T - 1 : Math.round(T * FPS - 1) / FPS); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlay(false); seek(e.shiftKey ? T + 1 : Math.round(T * FPS + 1) / FPS); }
    else if (e.code === 'KeyN') { e.preventDefault(); newDraft(null, null); }
    else if (e.code === 'KeyI') { // in-point
      e.preventDefault();
      if (!draft) newDraft(null, null);
      draft.t = +T.toFixed(3); if (draft.t2 != null && draft.t2 <= draft.t) draft.t2 = null;
      persist(); renderNotes();
    }
    else if (e.code === 'KeyO') { // out-point
      e.preventDefault();
      if (!draft) { newDraft(null, null); draft.t = +Math.max(0, T - 2).toFixed(3); }
      if (T > draft.t + 0.02) draft.t2 = +T.toFixed(3);
      setPlay(false); persist(); renderNotes();
    }
    else if (e.code === 'KeyL') $('loopBtn').click();
    else if (e.key === '[' || e.key === ']' || e.key === 'х' || e.key === 'ъ') {
      const s = live().sort((a, b) => a.t - b.t);
      const n = (e.key === '[' || e.key === 'х') ? s.filter(x => x.t < T - 0.02).pop() : s.find(x => x.t > T + 0.02);
      if (n) focusNote(n.id);
    }
    else if (e.key === 'Home') seek(0);
    void step;
  });

  // ---------- hot reload: code changes -> reload page at same time; notes changed by Claude -> refresh list ----------
  async function poll() {
    try {
      const v = await (await fetch('/api/version')).json();
      if (codeV === null) {
        codeV = v.v;
        if (v.root) { document.title = `${v.root} — ревью`; document.querySelector('aside h1').textContent = `Правки · ${v.root}`; }
        if (!v.api || v.api < 2) $('srvwarn').style.display = 'block';
      }
      else if (v.v !== codeV) { persist(); sessionStorage.setItem('reloaded', '1'); location.reload(); return; }
      if (lastN && v.n !== lastN && !draft && !sfxDraft) { lastN = v.n; loadNotes(); }
      if (!lastN) lastN = v.n;
    } catch {}
    setTimeout(poll, 1000);
  }

  // ---------- boot ----------
  READY.then(async () => {
    if (keep.snd != null) $('snd').value = keep.snd;
    if (keep.rate) $('rate').value = keep.rate;
    if (keep.filter) { filter = keep.filter; document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('sel', x.dataset.f === filter)); }
    if ($('snd').value) audio.src = $('snd').value;
    draft = keep.draft || null; activeId = keep.activeId || null; loopOn = !!keep.loopOn;
    T = keep.T || 0;
    buildTimeline();
    await loadNotes();
    await loadSfx();
    try { const z = +sessionStorage.getItem('reviewZoom'); if (z > 1) setZoom(z); } catch {}
    draw();
    if (sessionStorage.getItem('reloaded')) {
      sessionStorage.removeItem('reloaded');
      $('reloaded').style.opacity = 1; setTimeout(() => ($('reloaded').style.opacity = 0), 1800);
    }
    loop(); poll();
  });
  window.addEventListener('resize', drawPins);
})();
