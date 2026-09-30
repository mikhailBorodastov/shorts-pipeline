// Script storyboard: edit script.md scene by scene, hear each scene's voice, see reference frames,
// and leave fact-check / rewrite / storyboard notes for Claude (review/script_notes.{json,md}).
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const fmt1 = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const WPS = 2.5;                                 // target speaking pace, words per second
  const VOICE = /^(vo|голос)$/i, FRAMES = /^(кадры|клип|footage|trailer)/i, PICTURE = /^(картинка|визуал)$/i;
  const ACTIONS = {
    factcheck: { label: '🔎 Фактчек', ph: 'Что проверить? Можно оставить пустым — Claude проверит выделенный фрагмент по источникам.' },
    rewrite: { label: '✍️ Переписать', ph: 'Как переписать? Например: «короче», «сильнее хук», «без канцелярита».' },
    visual: { label: '🎨 Картинка', ph: 'Что поменять в раскадровке: что в кадре, какой клип, переход…' },
    comment: { label: '💬 Заметка', ph: 'Любая заметка. Для общей правки — что поменять во всём сценарии: структуру, тон, порядок, длину…' },
  };

  let data = null, notes = [], draft = null, filter = 'open';
  let lastS = 0, lastN = 0, lastT = 0, pendingReload = false;
  const cards = new Map();              // block index -> {el, dirty, timer, hash, conflict}
  const lastSel = new Map();            // block index -> {field, text}
  const audio = new Audio();
  let playingIdx = null, readAll = false;

  const touch = n => { n.updated = Date.now(); return n; };
  const live = () => notes.filter(n => !n.deleted);
  const toast = msg => { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.opacity = 0), 1600); };

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  // ---------- helpers on the parsed script ----------
  const sceneIdx = () => data.blocks.map((b, i) => (b.scene ? i : -1)).filter(i => i >= 0);
  const sceneNo = i => sceneIdx().indexOf(i) + 1;
  const voiceField = b => b.fields.find(f => f.name && VOICE.test(f.name));
  const voiceText = b => (voiceField(b)?.value || '').replace(/\*\([^)]*\)\*/g, ' ').replace(/[*_]{1,2}/g, '').replace(/\s+/g, ' ').trim();
  const words = s => (s.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
  const splitTitle = b => {
    const m = b.title.match(/^\s*(\d+:\d{2}(?:\.\d+)?\s*[–—-]\s*\d+:\d{2}(?:\.\d+)?)\s*[—–-]?\s*(.*)$/);
    return m ? { tc: m[1], name: m[2] } : { tc: '', name: b.title };
  };
  const parseT = s => { const m = s.match(/^(\d+):(\d{2}(?:\.\d+)?)$/); return m ? +m[1] * 60 + +m[2] : null; };

  // timecodes in a "Кадры…" field -> thumbnails (range: start/middle/end, single: freeze frame)
  function frameShots(b) {
    const out = [];
    for (const f of b.fields) {
      if (!f.name || !FRAMES.test(f.name)) continue;
      const srcM = f.value.match(/\[([^\]]+\.(?:mp4|mov|mkv|webm|m4v))\]/i);
      const src = srcM ? srcM[1] : '';
      const re = /(\d{1,2}:\d{2}(?:\.\d+)?)(?:\s*[–—-]\s*(\d{1,2}:\d{2}(?:\.\d+)?))?/g;
      let m;
      while ((m = re.exec(f.value))) {
        const a = parseT(m[1]), z = m[2] ? parseT(m[2]) : null;
        if (a == null) continue;
        const pre = f.value.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
        if (z != null && z > a) {
          out.push({ t: a + 0.15, src, lab: m[1] });
          if (z - a > 2.5) out.push({ t: (a + z) / 2, src, lab: fmt1((a + z) / 2) });
          out.push({ t: Math.max(a, z - 0.2), src, lab: m[2] });
        } else out.push({ t: a, src, lab: m[1], stop: /стоп|freeze/.test(pre) });
      }
    }
    const seen = new Set();
    return out.filter(s => { const k = s.src + s.t.toFixed(1); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7);
  }

  // ---------- tiny markdown for Claude's replies ----------
  function md(src) {
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    const lines = String(src || '').split('\n'), out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        i--;
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const body = rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r));
        out.push('<table>' + body.map((r, k) => `<tr>${cells(r).map(c => k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</table>');
      } else if (/^\s*[-*]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
        i--;
        out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>');
      } else if (/^\s*>/.test(l)) out.push(`<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`);
      else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    }
    return out.join('');
  }

  // ---------- rendering ----------
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }

  function renderAll() {
    const scroll = $('main').scrollTop;
    cards.clear();
    const box = $('scenes'); box.innerHTML = '';
    const other = $('otherlist'); other.innerHTML = '';
    data.blocks.forEach((b, i) => {
      if (b.scene) box.appendChild(sceneCard(b, i));
      else if (!b.hr) other.appendChild(otherBlock(b, i));
    });
    if (!sceneIdx().length) box.innerHTML = '<div class="empty">В script.md пока нет сцен. Сцена — это заголовок «### …» или «## …» с полем VO / Голос.</div>';
    renderPreamble(); renderStats(); renderNotes();
    requestAnimationFrame(() => { document.querySelectorAll('#main textarea').forEach(autosize); $('main').scrollTop = scroll; });
  }

  function renderPreamble() {
    const c = data.cfg, chips = [];
    const title = (data.preamble.match(/^#\s+(.+)$/m) || [])[1];
    $('ptitle').textContent = title || data.root || 'Сценарий';
    document.title = `Сценарий · ${data.root}`;
    if (c.voice) chips.push(c.voice.replace(/^ru-RU-|Neural$/g, ''));
    if (c.rate) chips.push('скорость ' + c.rate);
    const np = Object.keys(c.pron).length;
    if (np) chips.push(`произношение: ${np}`);
    if (c.rise.length) chips.push('вопрос: ' + c.rise.join(', '));
    chips.push(c.video ? '🎞 ' + c.video.split(/[\\/]/).pop() : '🎞 видео не задано');
    $('prechips').innerHTML = chips.map(x => `<span class="chip">${esc(x)}</span>`).join('');
    const body = $('pre').querySelector('.body');
    body.innerHTML = `<div class="hint" style="margin-bottom:6px">Название, формат, стиль и настройки голоса: <code>voice:</code>, <code>rate:</code>, <code>произношение: как пишется = как читать</code>, <code>вопрос: слово</code>, <code>видео: путь к референсу</code> (кадры для раскадровки).</div>`;
    const ta = document.createElement('textarea');
    ta.className = 'rawedit'; ta.value = data.preamble.replace(/\n+$/, '');
    ta.style.cssText = 'font:13px/1.5 ui-monospace,Consolas,monospace;background:#0e0c2a;border-color:var(--line)';
    let h = data.preamble_hash, timer;
    ta.oninput = () => { autosize(ta); clearTimeout(timer); timer = setTimeout(save, 900); };
    ta.onblur = () => { clearTimeout(timer); if (ta.value !== data.preamble.replace(/\n+$/, '')) save(); };
    async function save() {
      const r = await api('/api/script', { op: 'preamble', hash: h, raw: ta.value });
      if (r.status === 409) { toast('Шапка изменилась на диске — обновил'); data = r.j; renderAll(); return; }
      if (r.ok) { data = r.j; h = data.preamble_hash; lastS = data.mtime; renderStats(); saved(); }
    }
    body.appendChild(ta);
    $('pre').ontoggle = () => autosize(ta);
  }

  function renderStats() {
    const idx = sceneIdx();
    let w = 0, real = 0, have = true, stale = 0;
    idx.forEach(i => {
      const b = data.blocks[i], tm = data.timing[i];
      w += words(voiceText(b));
      if (tm) { real = Math.max(real, tm.start + tm.dur); if (tm.stale) stale++; } else have = false;
    });
    const est = w / WPS;
    $('stats').innerHTML = `${idx.length} сцен · ${w} слов · ~<b>${fmt(est)}</b> по тексту` +
      (have && idx.length ? ` · озвучка <b>${fmt(real)}</b>` : ' · озвучки нет') +
      (stale ? ` · <span style="color:var(--acc)">${stale} сцен изменено после озвучки</span>` : '');
  }

  function fieldEl(b, i, f, k) {
    const wrap = document.createElement('div');
    const isVo = f.name && VOICE.test(f.name);
    wrap.className = 'field' + (f.name ? '' : ' raw') + (isVo ? ' vo' : '');
    wrap.innerHTML = `<label>${esc(f.name || 'заметка')}</label>`;
    const ta = document.createElement('textarea');
    ta.value = f.value; ta.dataset.k = k; ta.spellcheck = true;
    ta.oninput = () => { autosize(ta); markDirty(i); if (isVo) updateVoMeta(i); if (FRAMES.test(f.name || '')) refreshThumbs(i); };
    ta.onblur = () => flush(i);
    const remember = () => {
      const s = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
      lastSel.set(i, { field: f.name || 'заметка', text: s, at: Date.now() });
    };
    ta.onmouseup = remember; ta.onkeyup = remember; ta.onselect = remember;
    wrap.appendChild(ta);
    return wrap;
  }

  function sceneCard(b, i) {
    const tm = data.timing[i];
    const el = document.createElement('section');
    el.className = 'scene' + (tm?.silent || !voiceField(b) ? ' silent' : '');
    el.id = 'blk' + i;
    const { tc, name } = splitTitle(b);
    const colA = document.createElement('div'); colA.className = 'col-a';
    colA.innerHTML = `<div class="no">${sceneNo(i)}</div>
      <div class="tm">${tm ? `<b>${fmt1(tm.start)}</b><br>${tm.dur.toFixed(1)} с${tm.silent ? ' · пауза' : ''}` : (tc ? esc(tc) : '—')}</div>
      <div class="row">
        ${tm && !tm.silent ? '<button class="small play" title="Послушать голос сцены">▶</button>' : ''}
        <a class="btn small" title="Открыть ролик на этой сцене" href="review.html#t=${tm ? (tm.start + 0.05).toFixed(2) : 0}">🎬</a>
      </div>
      <div class="row">
        <button class="small up" title="Переставить выше">↑</button><button class="small down" title="Переставить ниже">↓</button>
        <span class="menu"><button class="small more" title="Ещё">⋯</button><span class="pop">
          <button class="ins">➕ Новая сцена ниже</button>
          <button class="rawbtn">✎ Править как markdown</button>
          <button class="del">🗑 Удалить сцену</button>
        </span></span>
      </div>`;
    const colB = document.createElement('div');
    const colC = document.createElement('div');
    colB.innerHTML = `<div class="title">${tc ? `<span class="tc" title="Таймкод из заголовка сценария; реальный — слева, из озвучки">${esc(tc)}</span>` : ''}<input value="${esc(name)}" spellcheck="true"></div><div class="thumbs"></div>`;
    const ti = colB.querySelector('input');
    ti.oninput = () => markDirty(i);
    ti.onblur = () => flush(i);
    ti.onkeydown = e => { if (e.key === 'Enter') ti.blur(); };
    b.fields.forEach((f, k) => {
      const fe = fieldEl(b, i, f, k);
      (f.name && VOICE.test(f.name) ? colC : colB).appendChild(fe);
    });
    if (voiceField(b)) {
      const meta = document.createElement('div'); meta.className = 'meta'; colC.querySelector('.vo').appendChild(meta);
    } else {
      colC.insertAdjacentHTML('beforeend', `<div class="hint">Сцена без голоса — пауза${tm ? ` ${tm.dur.toFixed(1)} с` : ''}.</div>`);
    }
    const acts = document.createElement('div'); acts.className = 'acts';
    acts.innerHTML = Object.entries(ACTIONS).map(([k, a]) => `<button class="small" data-a="${k}" title="Заметка для Claude по этой сцене (с выделенным фрагментом)">${a.label}</button>`).join('');
    acts.querySelectorAll('button').forEach(bt => bt.onmousedown = e => e.preventDefault());   // keep the text selection
    acts.onclick = e => { const a = e.target.closest('button')?.dataset.a; if (a) startDraft(a, i); };
    colC.appendChild(acts);
    const sn = document.createElement('div'); sn.className = 'scene-notes'; colC.appendChild(sn);
    el.append(colA, colB, colC);

    colA.querySelector('.play')?.addEventListener('click', () => play(i));
    colA.querySelector('.up').onclick = () => op({ op: 'move', i, hash: cur(i).hash, dir: -1 });
    colA.querySelector('.down').onclick = () => op({ op: 'move', i, hash: cur(i).hash, dir: 1 });
    const menu = colA.querySelector('.menu');
    menu.querySelector('.more').onclick = e => { e.stopPropagation(); document.querySelectorAll('.menu.open').forEach(m => m !== menu && m.classList.remove('open')); menu.classList.toggle('open'); };
    menu.querySelector('.ins').onclick = () => op({ op: 'insert', i });
    menu.querySelector('.del').onclick = () => { if (confirm(`Удалить сцену ${sceneNo(i)} «${name}»? Копия сохранится в review/script_trash.md.`)) op({ op: 'delete', i, hash: cur(i).hash }); };
    menu.querySelector('.rawbtn').onclick = () => rawEdit(i);

    cards.set(i, { el, dirty: false, timer: null, hash: b.hash });
    setTimeout(() => { refreshThumbs(i); updateVoMeta(i); sceneNotes(i); });
    return el;
  }

  const cur = i => cards.get(i);

  function refreshThumbs(i) {
    const c = cur(i); if (!c) return;
    const box = c.el.querySelector('.thumbs'); if (!box) return;
    const b = collect(i) || data.blocks[i];
    const shots = frameShots(b);
    if (!shots.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    if (!data.cfg.video && !shots.some(s => s.src)) {
      box.innerHTML = `<div class="novideo">Кадры не показать: добавь в шапку строку <code>видео: путь/к/референсу.mp4</code>.</div>`; return;
    }
    const key = shots.map(s => s.src + s.t).join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = shots.map(s => `<div class="thumb${s.stop ? ' stop' : ''}" data-t="${s.t}" data-src="${esc(s.src)}" title="${esc(s.lab)}${s.stop ? ' · стоп-кадр' : ''}"><img loading="lazy" src="/api/frame?t=${s.t.toFixed(2)}&w=360&src=${encodeURIComponent(s.src)}"><span>${esc(s.lab)}${s.stop ? ' ⏸' : ''}</span></div>`).join('');
    box.querySelectorAll('img').forEach(img => img.onerror = () => { const d = img.parentElement; d.classList.add('bad'); d.innerHTML = 'нет кадра<br>' + esc(d.title); });
    box.onclick = e => {
      const th = e.target.closest('.thumb'); if (!th || th.classList.contains('bad')) return;
      $('lbimg').src = `/api/frame?t=${(+th.dataset.t).toFixed(2)}&w=1280&src=${encodeURIComponent(th.dataset.src)}`;
      $('lbcap').textContent = `${th.title} · ${th.dataset.src || data.cfg.video}`;
      $('lightbox').classList.add('show');
    };
  }

  function updateVoMeta(i) {
    const c = cur(i); if (!c) return;
    const meta = c.el.querySelector('.vo .meta'); if (!meta) return;
    const b = collect(i) || data.blocks[i], tm = data.timing[i];
    const vt = voiceText(b), w = words(vt), est = w / WPS;
    const changed = tm && (tm.stale || vt !== voiceText(data.blocks[i]));
    const long = tm && !tm.silent && !changed && tm.dur > 0 && w / tm.dur > 3.3;
    meta.innerHTML = `<span>${w} слов · ~${est.toFixed(1)} с</span>` +
      (tm && !tm.silent ? `<span>озвучка ${tm.dur.toFixed(1)} с</span>` : '') +
      (changed ? '<span class="badge stale" title="Текст отличается от последней озвучки — нажми «Переозвучить»">изменено после озвучки</span>' : '') +
      (long ? '<span class="badge long" title="Больше 3,3 слова в секунду — диктор тараторит">быстро</span>' : '');
  }

  function otherBlock(b, i) {
    const d = document.createElement('div'); d.className = 'oblock'; d.id = 'blk' + i;
    const ta = document.createElement('textarea'); ta.value = b.raw.replace(/\n+$/, '');
    let timer;
    ta.oninput = () => { autosize(ta); clearTimeout(timer); timer = setTimeout(save, 900); };
    ta.onblur = () => { clearTimeout(timer); if (ta.value !== b.raw.replace(/\n+$/, '')) save(); };
    async function save() { await op({ op: 'raw', i, hash: data.blocks[i].hash, raw: ta.value }, { quiet: true }); }
    d.appendChild(ta);
    $('other').ontoggle = () => document.querySelectorAll('#otherlist textarea').forEach(autosize);
    return d;
  }

  function rawEdit(i) {
    const c = cur(i), b = data.blocks[i];
    c.el.innerHTML = '';
    const w = document.createElement('div'); w.className = 'rawedit'; w.style.gridColumn = '1 / -1';
    w.innerHTML = `<div class="hint" style="margin-bottom:6px">Сцена ${sceneNo(i)} как markdown. Заголовок «###», поля «**Имя:** текст», голос — «**VO:**» и строки «> …».</div>`;
    const ta = document.createElement('textarea'); ta.value = b.raw.replace(/\n+$/, '');
    const bar = document.createElement('div'); bar.className = 'acts';
    bar.innerHTML = '<button class="primary">Сохранить</button><button class="ghost">Отмена</button>';
    bar.children[0].onclick = () => op({ op: 'raw', i, hash: b.hash, raw: ta.value });
    bar.children[1].onclick = () => renderAll();
    w.append(ta, bar); c.el.appendChild(w); c.dirty = true;
    requestAnimationFrame(() => { autosize(ta); ta.focus(); });
  }

  // ---------- editing -> script.md ----------
  function collect(i) {
    const c = cur(i); if (!c || !c.el.querySelector('.title input')) return null;
    const b = data.blocks[i];
    const fields = b.fields.map((f, k) => {
      const ta = c.el.querySelector(`textarea[data-k="${k}"]`);
      return { ...f, value: ta ? ta.value : f.value };
    });
    const name = c.el.querySelector('.title input').value.trim();
    const { tc } = splitTitle(b);
    return { ...b, title: tc ? `${tc} — ${name}` : name, fields };
  }

  function markDirty(i) {
    const c = cur(i); if (!c) return;
    c.dirty = true; c.el.classList.add('dirty');
    $('saved').textContent = 'есть несохранённое…';
    clearTimeout(c.timer); c.timer = setTimeout(() => flush(i), 1200);
  }

  async function flush(i, force) {
    const c = cur(i); if (!c || !c.dirty || c.conflict) return;
    clearTimeout(c.timer);
    const nb = collect(i); if (!nb) return;
    c.dirty = false;
    const r = await api('/api/script', { op: 'save', i, hash: force || c.hash, title: nb.title, fields: nb.fields });
    if (r.status === 409) return conflict(i, nb, r.j);
    if (!r.ok) { c.dirty = true; toast('Не сохранилось: ' + (r.j.error || r.status)); return; }
    const old = data;
    data = r.j; lastS = data.mtime;
    if (data.blocks.length !== old.blocks.length) { renderAll(); return saved(); }
    data.blocks.forEach((b, k) => { const cc = cur(k); if (cc) cc.hash = b.hash; });
    if (!c.dirty) c.el.classList.remove('dirty');
    updateVoMeta(i); renderStats(); saved();
    if (pendingReload && ![...cards.values()].some(x => x.dirty)) reloadScript();
  }

  function conflict(i, mine, fresh) {
    const c = cur(i);
    c.conflict = true; c.dirty = true;
    const bar = document.createElement('div'); bar.className = 'conflict';
    bar.innerHTML = `<b>script.md изменился на диске</b> (например, Claude поправил сценарий), пока ты редактировал эту сцену.
      <button class="primary keep">Сохранить мою версию</button><button class="take">Взять версию с диска</button>`;
    bar.querySelector('.keep').onclick = async () => {
      const k = fresh.blocks.findIndex((b, j) => b.scene && j === i) >= 0 ? i
        : fresh.blocks.findIndex(b => b.scene && splitTitle(b).name === splitTitle(mine).name);
      if (k < 0) { toast('Сцену не нашёл — скопируй текст и обнови страницу'); return; }
      const r = await api('/api/script', { op: 'save', i: k, hash: fresh.blocks[k].hash, title: mine.title, fields: mine.fields });
      if (r.ok) { data = r.j; lastS = data.mtime; renderAll(); saved(); } else toast('Не получилось, обнови страницу');
    };
    bar.querySelector('.take').onclick = () => { data = fresh; lastS = data.mtime; renderAll(); };
    c.el.prepend(bar);
  }

  async function op(body, { quiet } = {}) {
    for (const [k, c] of cards) if (c.dirty && !c.conflict && k !== body.i) await flush(k);
    const r = await api('/api/script', body);
    if (r.status === 409) { toast('Сценарий изменился на диске — обновил'); data = r.j; lastS = data.mtime; renderAll(); return; }
    if (!r.ok) { toast('Ошибка: ' + (r.j.error || r.status)); return; }
    const structural = body.op !== 'raw' || !quiet;
    data = r.j; lastS = data.mtime;
    if (structural) renderAll(); else { renderStats(); data.blocks.forEach((b, k) => { const cc = cur(k); if (cc) cc.hash = b.hash; }); }
    if (body.op === 'insert') { const el = $('blk' + (body.i + 1)); el?.scrollIntoView({ block: 'center' }); el?.querySelector('.title input')?.select(); }
    saved();
  }

  function saved() { $('saved').textContent = 'сохранено ' + new Date().toLocaleTimeString().slice(0, 5); }

  // ---------- voice ----------
  function play(i, chain = false) {
    const tm = data.timing[i];
    document.querySelectorAll('.scene.playing').forEach(e => e.classList.remove('playing'));
    if (!chain && playingIdx === i && !audio.paused) { audio.pause(); playingIdx = null; readAll = false; setReadBtn(); return; }
    if (!tm) return;
    playingIdx = i;
    const el = $('blk' + i); el?.classList.add('playing');
    if (chain) el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (tm.silent) { setTimeout(() => (playingIdx === i && next()), tm.dur * 1000); return; }
    audio.src = tm.file + '?v=' + lastT; audio.play().catch(() => {});
  }
  function next() {
    if (!readAll) { document.querySelectorAll('.scene.playing').forEach(e => e.classList.remove('playing')); playingIdx = null; return; }
    const idx = sceneIdx(), k = idx.indexOf(playingIdx);
    if (k >= 0 && k + 1 < idx.length) setTimeout(() => play(idx[k + 1], true), 250);
    else { readAll = false; playingIdx = null; setReadBtn(); document.querySelectorAll('.scene.playing').forEach(e => e.classList.remove('playing')); }
  }
  audio.onended = next;
  function setReadBtn() { $('readall').textContent = readAll ? '■ Стоп' : '▶ Читать подряд'; }
  $('readall').onclick = () => {
    if (readAll) { readAll = false; audio.pause(); playingIdx = null; setReadBtn(); document.querySelectorAll('.scene.playing').forEach(e => e.classList.remove('playing')); return; }
    const idx = sceneIdx().filter(i => data.timing[i]);
    if (!idx.length) { toast('Озвучки ещё нет — нажми «Переозвучить»'); return; }
    readAll = true; setReadBtn(); play(idx[0], true);
  };

  $('tts').onclick = async () => {
    for (const [k, c] of cards) if (c.dirty && !c.conflict) await flush(k);
    const r = await api('/api/script/tts', {});
    toast(r.j.started ? 'Озвучиваю заново…' : 'Озвучка уже идёт');
    ttsStatus(r.j);
  };
  function ttsStatus(s) {
    const el = $('ttsstat'); if (!s) return;
    el.className = s.running ? 'run' : (s.rc ? 'err' : '');
    if (s.running) el.textContent = '⏳ ' + (s.log.trim().split('\n').pop() || 'озвучиваю…');
    else if (s.rc) el.textContent = '✗ tts.py упал: ' + (s.log.trim().split('\n').pop() || s.rc);
    else if (s.finished) el.textContent = '✓ озвучено ' + new Date(s.finished * 1000).toLocaleTimeString().slice(0, 5);
    else el.textContent = '';
    el.title = s.log || '';
    $('tts').disabled = !!s.running;
  }

  // ---------- notes ----------
  async function loadNotes() { const r = await api('/api/script/notes'); notes = Array.isArray(r.j) ? r.j : []; }
  async function saveNotes() {
    const r = await api('/api/script/notes', notes);
    if (r.ok) { notes = r.j.notes; lastN = Date.now() / 1000; saved(); }
    renderNotes();
  }
  const nextId = () => notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  const sceneLabel = i => { if (i == null) return 'весь сценарий'; const b = data.blocks[i]; return b ? `Сцена ${sceneNo(i)} · ${splitTitle(b).name}` : 'сцена удалена'; };
  const findScene = n => {
    if (n.scene == null) return null;
    const idx = sceneIdx();
    const byName = idx.find(i => splitTitle(data.blocks[i]).name === n.sceneName);
    return byName ?? (n.scene < idx.length ? idx[n.scene] : null);
  };

  function startDraft(action, i) {
    let quote = '', field = '';
    if (i != null) {
      const s = lastSel.get(i);
      if (s && s.text && Date.now() - s.at < 60000) { quote = s.text; field = s.field; }
      else if (action === 'factcheck' || action === 'rewrite') { const b = collect(i) || data.blocks[i]; quote = voiceText(b); field = voiceField(b)?.name || ''; }
    }
    draft = { action, block: i, scene: i == null ? null : sceneIdx().indexOf(i), sceneName: i == null ? '' : splitTitle(data.blocks[i]).name, quote, field, text: '' };
    if (filter === 'done') setFilter('open');
    renderNotes();
    const ta = $('notes').querySelector('.card.draft textarea'); ta?.focus();
  }

  async function commitDraft() {
    const id = nextId();
    let refs = [];
    if (draft.refs?.length) {
      try { refs = await Refs.upload(draft.refs, id, 'script'); } catch (e) { toast('📎 Картинки не загрузились: ' + e.message); return; }
    }
    const ta = $('notes').querySelector('.card.draft textarea');
    const n = touch({ id, action: draft.action, scene: draft.scene, sceneName: draft.sceneName, field: draft.field,
                      quote: draft.quote, text: ta ? ta.value.trim() : '', status: 'open', replies: [], created: Date.now() });
    if (refs.length) n.refs = refs;
    notes.push(n); draft = null;
    await saveNotes(); sceneNotesAll();
  }

  function setFilter(f) {
    filter = f;
    document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('sel', x.dataset.f === f));
    renderNotes();
  }
  document.querySelectorAll('#filters button').forEach(b => (b.onclick = () => setFilter(b.dataset.f)));

  function renderNotes() {
    const box = $('notes'); box.innerHTML = '';
    if (!data) return;
    if (draft) {
      const a = ACTIONS[draft.action];
      const c = document.createElement('div'); c.className = 'card draft';
      c.innerHTML = `<div class="top"><span class="act">${a.label}</span><span class="where">${esc(sceneLabel(draft.block))}</span></div>
        <div class="kinds">${Object.entries(ACTIONS).map(([k, x]) => `<button class="small${k === draft.action ? ' sel' : ''}" data-k="${k}">${x.label}</button>`).join('')}</div>
        ${draft.quote ? `<div class="quote">${esc(draft.quote)}</div>` : ''}
        <textarea placeholder="${esc(a.ph)}"></textarea>
        <div class="acts2"><button class="primary">Сохранить</button><button class="ghost">Отмена</button>${draft.quote ? '<button class="ghost noq">Без фрагмента</button>' : ''}</div>`;
      const ta = c.querySelector('textarea');
      draft.refs = draft.refs || [];
      ta.after(Refs.tray(draft.refs, c));
      c.querySelector('.kinds').onclick = e => {
        const k = e.target.closest('button')?.dataset.k; if (!k) return;
        const txt = ta.value; draft.action = k; renderNotes();
        const t2 = $('notes').querySelector('.card.draft textarea'); t2.value = txt; t2.focus();
      };
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitDraft(); if (e.key === 'Escape') { draft = null; renderNotes(); } };
      c.querySelector('.primary').onclick = commitDraft;
      c.querySelector('.ghost').onclick = () => { draft = null; renderNotes(); };
      c.querySelector('.noq')?.addEventListener('click', () => { draft.quote = ''; draft.field = ''; renderNotes(); box.querySelector('textarea')?.focus(); });
      box.appendChild(c);
    }
    const list = live().filter(n => filter === 'all' || (filter === 'done' ? n.status === 'done' : n.status !== 'done'))
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.scene ?? -1) - (b.scene ?? -1) || a.id - b.id);
    if (!list.length && !draft) box.innerHTML = `<div class="empty">${filter === 'done' ? 'Сделанных пока нет.' : 'Открытых правок нет.<br>Выдели текст в сцене и нажми 🔎 / ✍️ / 🎨 / 💬.'}</div>`;
    for (const n of list) box.appendChild(noteCard(n));
    $('copy').disabled = !live().some(n => n.status !== 'done');
  }

  function noteCard(n) {
    const c = document.createElement('div'); c.className = 'card' + (n.status === 'done' ? ' done' : ''); c.id = 'note' + n.id;
    const bi = findScene(n);
    c.innerHTML = `<div class="top"><span class="num">${n.id}</span><span class="act">${ACTIONS[n.action]?.label || n.action}</span>
        <span class="where" title="Показать сцену">${esc(n.scene == null ? 'весь сценарий' : (bi != null ? sceneLabel(bi) : `сцена «${n.sceneName}» (не найдена)`))}</span></div>
      ${n.quote ? `<div class="quote">${esc(n.quote)}</div>` : ''}
      <div class="txt">${esc(n.text || '')}</div>`;
    c.append(Refs.view(n.refs));
    for (const r of n.replies || []) {
      const rd = document.createElement('div'); rd.className = 'reply';
      rd.innerHTML = `<div class="who">${esc(r.who || '')}</div><div class="md">${md(r.text)}</div>`;
      if (r.suggest) {
        const s = r.suggest, sg = document.createElement('div'); sg.className = 'sugg';
        sg.innerHTML = `<div class="hint">Замена в «${esc(s.field || 'VO')}»${s.applied ? ' · <b style="color:var(--ok)">применена</b>' : ' · текст ниже можно поправить перед применением'}</div>
          ${s.from ? `<div class="from">${esc(s.from)}</div>` : '<div class="hint">(всё поле)</div>'}
          ${s.applied ? `<div class="to">${esc(s.to)}</div>` : `<textarea class="to" spellcheck="true"></textarea>`}
          ${s.applied ? '' : `<div class="acts2"><button class="primary small apply">Применить</button><button class="small copyto">Копировать</button>${s.orig && s.orig !== s.to ? '<button class="small ghost reset" title="Вернуть вариант Claude">↺ как у Claude</button>' : ''}</div>`}`;
        const ta = sg.querySelector('textarea.to');
        if (ta) {
          ta.value = s.to;
          requestAnimationFrame(() => autosize(ta));
          let timer;
          const keep = () => {                      // store the user's version in the note (without re-rendering the list)
            if (ta.value === s.to) return;
            if (s.orig == null) s.orig = s.to;
            s.to = ta.value; touch(n);
            api('/api/script/notes', notes).then(res => { if (res.ok) saved(); });
          };
          ta.oninput = () => { autosize(ta); clearTimeout(timer); timer = setTimeout(keep, 700); };
          ta.onblur = () => { clearTimeout(timer); keep(); };
          ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { keep(); applySuggestion(n, r); } };
        }
        sg.querySelector('.apply')?.addEventListener('click', () => { if (ta) { s.to = ta.value; } applySuggestion(n, r); });
        sg.querySelector('.copyto')?.addEventListener('click', () => { navigator.clipboard.writeText(ta ? ta.value : s.to); toast('Скопировано'); });
        sg.querySelector('.reset')?.addEventListener('click', () => { s.to = s.orig; touch(n); saveNotes(); });
        rd.appendChild(sg);
      }
      c.appendChild(rd);
    }
    const acts = document.createElement('div'); acts.className = 'acts2';
    acts.innerHTML = `${n.status === 'done' ? '<button class="small reopen">↺ Открыть</button>' : '<button class="small done">✓ Готово</button>'}
      <button class="small edit">✎</button><button class="small ghost del">🗑</button>`;
    acts.querySelector('.done')?.addEventListener('click', () => { n.status = 'done'; touch(n); saveNotes(); sceneNotesAll(); });
    acts.querySelector('.reopen')?.addEventListener('click', () => { n.status = 'open'; touch(n); saveNotes(); sceneNotesAll(); });
    acts.querySelector('.del').onclick = () => { if (confirm(`Удалить заметку #${n.id}?`)) { n.deleted = true; touch(n); saveNotes(); sceneNotesAll(); } };
    acts.querySelector('.edit').onclick = () => {
      const t = c.querySelector('.txt'); const ta = document.createElement('textarea'); ta.value = n.text || ''; t.replaceWith(ta); ta.focus();
      const items = (n.refs || []).map(path => ({ path }));
      const tr = Refs.tray(items, c);
      if (ta.nextElementSibling?.classList.contains('refs')) ta.nextElementSibling.replaceWith(tr); else ta.after(tr);
      let busy = false;
      const done = async () => {
        if (busy) return; busy = true;
        try { n.refs = await Refs.upload(items, n.id, 'script'); } catch (e) { busy = false; toast('📎 Картинки не загрузились: ' + e.message); return; }
        if (!n.refs.length) delete n.refs;
        n.text = ta.value.trim(); touch(n); saveNotes();
      };
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(); if (e.key === 'Escape') { busy = true; renderNotes(); } };
      // leaving the note saves it; the 📎 file dialog (window loses focus) and clicks inside the card don't
      ta.onblur = () => setTimeout(() => { if (document.hasFocus() && !c.contains(document.activeElement)) done(); }, 0);
    };
    c.appendChild(acts);
    c.querySelector('.where').onclick = () => { if (bi != null) gotoBlock(bi); };
    return c;
  }

  function gotoBlock(i) {
    const el = $('blk' + i); if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  async function applySuggestion(n, r) {
    const s = r.suggest, fname = (s.field || 'VO').toLowerCase();
    const idx = sceneIdx();
    const matchField = f => f.name && (f.name.toLowerCase() === fname || (VOICE.test(fname) && VOICE.test(f.name)));
    let target = null;
    if (s.from) {
      const hits = idx.filter(i => data.blocks[i].fields.some(f => matchField(f) && f.value.includes(s.from)));
      target = hits.length === 1 ? hits[0] : hits.includes(findScene(n)) ? findScene(n) : null;
      if (target == null) { toast(hits.length ? 'Фрагмент встречается в нескольких сценах' : 'Фрагмент уже изменился — скопируй замену вручную'); return; }
    } else target = findScene(n);
    if (target == null) { toast('Сцена не найдена'); return; }
    const c = cur(target); if (c?.dirty) await flush(target);
    const b = data.blocks[target];
    const fields = b.fields.map(f => matchField(f) ? { ...f, value: s.from ? f.value.replace(s.from, s.to) : s.to } : f);
    const res = await api('/api/script', { op: 'save', i: target, hash: b.hash, title: b.title, fields });
    if (!res.ok) { toast('Сценарий изменился — обнови и попробуй ещё раз'); if (res.status === 409) { data = res.j; renderAll(); } return; }
    data = res.j; lastS = data.mtime;
    s.applied = true; n.status = 'done'; touch(n);
    await saveNotes(); renderAll(); gotoBlock(target);
    toast('Применено — не забудь переозвучить');
  }

  function sceneNotes(i) {
    const c = cur(i); if (!c) return;
    const box = c.el.querySelector('.scene-notes'); if (!box) return;
    const mine = live().filter(n => findScene(n) === i);
    box.innerHTML = mine.map(n => `<span class="npill ${n.status === 'done' ? 'done' : 'open'}" data-id="${n.id}">#${n.id} ${ACTIONS[n.action]?.label.split(' ')[0] || ''} ${n.status === 'done' ? '✓' : ''}${(n.replies || []).length ? ' 💬' : ''}</span>`).join('');
    box.onclick = e => {
      const id = e.target.closest('.npill')?.dataset.id; if (!id) return;
      const n = notes.find(x => x.id === +id);
      if (n && filter !== 'all' && (n.status === 'done') !== (filter === 'done')) setFilter('all');
      const el = $('note' + id); el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('draft'); setTimeout(() => el?.classList.remove('draft'), 1200);
    };
  }
  const sceneNotesAll = () => { for (const i of cards.keys()) sceneNotes(i); };

  $('globalnote').onclick = () => startDraft('rewrite', null);

  $('copy').onclick = () => {
    const txt = live().filter(n => n.status !== 'done').map(n => `#${n.id} ${ACTIONS[n.action]?.label || ''} — ${n.scene == null ? 'весь сценарий' : sceneLabel(findScene(n))}\n${n.quote ? '«' + n.quote + '»\n' : ''}${n.text || ''}${n.refs?.length ? '\nРеференсы: ' + n.refs.join(', ') : ''}`).join('\n\n');
    navigator.clipboard.writeText(txt); toast('Скопировано');
  };

  $('lightbox').onclick = () => $('lightbox').classList.remove('show');
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('lightbox').classList.remove('show'); });
  window.addEventListener('beforeunload', e => { if ([...cards.values()].some(c => c.dirty && !c.conflict)) { for (const k of cards.keys()) flush(k); e.preventDefault(); } });

  // ---------- live updates (Claude edits script.md / replies to notes / tts finishes) ----------
  async function reloadScript() {
    const r = await api('/api/script'); if (!r.ok) return;
    data = r.j; lastS = data.mtime; pendingReload = false;
    renderAll();
  }
  async function poll() {
    try {
      const r = await api('/api/script/version');
      if (r.ok) {
        const v = r.j;
        ttsStatus(v.tts);
        const busy = [...cards.values()].some(c => c.dirty) || document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.closest('#main')
          || document.activeElement?.tagName === 'INPUT';
        if (v.s !== lastS || v.t !== lastT) {
          if (busy) pendingReload = true;
          else { lastT = v.t; await reloadScript(); }
        }
        if (v.n !== lastN) {
          lastN = v.n;
          if (!document.activeElement?.closest?.('#notes')) { await loadNotes(); renderNotes(); sceneNotesAll(); }
        }
      }
    } catch {}
    setTimeout(poll, 1500);
  }
  document.addEventListener('focusout', () => setTimeout(() => {
    if (pendingReload && ![...cards.values()].some(c => c.dirty) && !document.activeElement?.closest?.('#main textarea, #main input')) reloadScript();
  }, 300));

  (async () => {
    const v = await api('/api/version');
    if (!v.ok || !(v.j.api >= 3)) { $('srvwarn').classList.add('show'); return; }
    const s = await api('/api/script/version');
    lastN = s.j.n; lastT = s.j.t;
    await reloadScript(); await loadNotes(); renderNotes(); sceneNotesAll(); ttsStatus(s.j.tts);
    poll();
  })();
})();
