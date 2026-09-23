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
    if (draft) box.appendChild(draftCard());
    const list = live().filter(n => filter === 'all' || (filter === 'done' ? n.status === 'done' : n.status !== 'done')).sort((a, b) => a.t - b.t);
    if (!list.length && !draft) {
      const e = document.createElement('div'); e.className = 'empty';
      e.innerHTML = live().length ? 'Тут пусто — смени фильтр.' : 'Правок пока нет.<br>Поставь на паузу и кликни по кадру там, где нужно что-то поменять.';
      box.appendChild(e);
    }
    for (const n of list) box.appendChild(noteCard(n));
    drawMarks(); drawPins();
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
    top.append(el('span', 'num', n.id));
    const tc = el('span', 'tc', fmt(n.t) + (n.t2 ? ' – ' + fmt(n.t2) : '')); tc.onclick = () => { setPlay(false); seek(n.t); activeId = n.id; renderNotes(); };
    top.append(tc, el('span', 'scene', `${n.scene}. ${esc(n.sceneName || '')}`));
    c.append(top);
    if (n.caption) c.append(el('div', 'cap', `«${esc(n.caption)}»`));
    const txt = el('div', 'txt', esc(n.text || ''));
    c.append(txt);
    for (const r of n.replies || []) c.append(el('div', 'cap', `<b>${esc(r.who)}:</b> ${esc(r.text)}`));
    const acts = el('div', 'acts');
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
    setPlay(false);
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

  // ---------- inputs ----------
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
      }
      else if (v.v !== codeV) { persist(); sessionStorage.setItem('reloaded', '1'); location.reload(); return; }
      if (lastN && v.n !== lastN && !draft) { lastN = v.n; loadNotes(); }
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
    draw();
    if (sessionStorage.getItem('reloaded')) {
      sessionStorage.removeItem('reloaded');
      $('reloaded').style.opacity = 1; setTimeout(() => ($('reloaded').style.opacity = 0), 1800);
    }
    loop(); poll();
  });
  window.addEventListener('resize', drawPins);
})();
