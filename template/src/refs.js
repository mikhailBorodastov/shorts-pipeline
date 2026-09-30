// Reference images for notes (review.html and script.html): paste (Ctrl+V), drag-and-drop or 📎 -> thumbnails in the form,
// uploaded on save to review/refs/<id>_<k>.<ext> (script notes: s<id>_<k>); paths go to the note's `refs` field.
window.Refs = (() => {
  const MAX = 10 * 1024 * 1024;
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const url = p => '/' + String(p).replace(/^\/+/, '');
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  document.head.appendChild(el('style', null, `
    .refs { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; align-items: center; }
    .refs:empty { display: none; }
    .refs .rt { position: relative; width: 64px; height: 64px; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); background: #000; cursor: zoom-in; flex: none; }
    .refs .rt img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .refs .rt.new { border-color: var(--acc); }
    .refs .rt .x { position: absolute; right: 2px; top: 2px; width: 18px; height: 18px; padding: 0; border-radius: 50%; font-size: 11px; line-height: 16px;
                   display: grid; place-items: center; background: rgba(0,0,0,.75); color: #fff; border: 1px solid rgba(255,255,255,.5); cursor: pointer; }
    .refs .rt .x:hover { background: var(--red, #ff5470); }
    .refs .radd { font-size: 12px; padding: 2px 8px; background: transparent; }
    .refs .radd:hover { background: var(--panel2); }
    .refs .rhint { color: var(--dim); font-size: 11px; }
    .refs .rerr { color: var(--red, #ff5470); font-size: 12px; }
    .refdrop { outline: 2px dashed var(--acc) !important; outline-offset: -2px; }
    #refbox { position: fixed; inset: 0; background: rgba(0,0,0,.85); display: none; place-items: center; z-index: 60; cursor: zoom-out; }
    #refbox.show { display: grid; }
    #refbox img { max-width: 92vw; max-height: 86vh; border-radius: 10px; display: block; }
    #refbox div { color: #fff; text-align: center; margin-top: 8px; font-size: 13px; }
  `));

  // full-size view
  let box = null;
  function show(src, cap) {
    if (!box) {
      box = el('div', null, '<figure style="margin:0"><img alt=""><div></div></figure>'); box.id = 'refbox';
      box.onclick = () => box.classList.remove('show');
      document.addEventListener('keydown', e => { if (e.key === 'Escape') box.classList.remove('show'); });
      document.body.appendChild(box);
    }
    box.querySelector('img').src = src; box.querySelector('div').textContent = cap || '';
    box.classList.add('show');
  }

  function thumb(src, cap, onRemove, isNew) {
    const t = el('div', 'rt' + (isNew ? ' new' : '')); t.title = cap + ' — открыть крупно';
    const img = el('img'); img.src = src; img.loading = 'lazy'; img.alt = '';
    t.append(img);
    t.onmousedown = e => e.preventDefault();             // clicking a thumbnail doesn't take focus from the note's text
    t.onclick = () => show(src, cap);
    if (onRemove) {
      const x = el('button', 'x', '×'); x.title = 'Убрать картинку из правки';
      x.onclick = e => { e.stopPropagation(); onRemove(); };
      t.append(x);
    }
    return t;
  }

  // read-only thumbnails of a saved note
  function view(paths) {
    const b = el('div', 'refs');
    for (const p of paths || []) b.append(thumb(url(p), p));
    return b;
  }

  // ----- editable tray: items = [{path}] (already on the server) and [{data, name}] (pasted, dataURL, uploaded on save) -----
  const trays = [];                        // live trays, the newest last (paste outside any form goes there)
  const imageFiles = dt => {
    if (!dt) return [];
    const out = [...(dt.files || [])];
    for (const it of dt.items || []) if (it.kind === 'file') { const f = it.getAsFile(); if (f && !out.some(o => o.name === f.name && o.size === f.size)) out.push(f); }
    return out.filter(f => f.type.startsWith('image/'));
  };

  function tray(items, zone, onChange = () => {}) {
    const b = el('div', 'refs tray');
    const inp = el('input'); inp.type = 'file'; inp.accept = TYPES.join(','); inp.multiple = true; inp.style.display = 'none';
    const err = msg => { const e = b.querySelector('.rerr'); if (e) { e.textContent = msg; clearTimeout(err.t); err.t = setTimeout(() => (e.textContent = ''), 5000); } };
    const render = () => {
      b.innerHTML = '';
      items.forEach((it, k) => b.append(thumb(it.data || url(it.path), it.path || it.name || 'картинка', () => { items.splice(k, 1); render(); onChange(); }, !it.path)));
      const add = el('button', 'radd', '📎 референс'); add.type = 'button';
      add.title = 'Приложить картинку-референс (или Ctrl+V / перетащи файл на заметку)';
      add.onmousedown = e => e.preventDefault();          // keep focus / text selection where it was
      add.onclick = () => inp.click();
      b.append(add, inp);
      if (!items.length) b.append(el('span', 'rhint', 'Ctrl+V или перетащи картинку'));
      b.append(el('span', 'rerr'));
    };
    const addFiles = files => {
      files = [...files];
      if (!files.length) return;
      for (const f of files) {
        if (!TYPES.includes(f.type)) { err(`«${f.name || 'файл'}» — не png/jpg/webp/gif`); continue; }
        if (f.size > MAX) { err(`«${f.name || 'картинка'}» больше 10 МБ`); continue; }
        const r = new FileReader();
        r.onload = () => { items.push({ data: r.result, name: f.name || 'из буфера' }); render(); onChange(); };
        r.readAsDataURL(f);
      }
    };
    inp.onchange = () => { addFiles(inp.files); inp.value = ''; };
    b.addFiles = addFiles;
    b.zone = zone || b;
    const z = b.zone;
    z.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); z.classList.add('refdrop'); } });
    z.addEventListener('dragleave', e => { if (!z.contains(e.relatedTarget)) z.classList.remove('refdrop'); });
    z.addEventListener('drop', e => {
      z.classList.remove('refdrop');
      const files = imageFiles(e.dataTransfer);
      if (files.length) { e.preventDefault(); e.stopPropagation(); addFiles(files); }
    });
    trays.push(b);
    render();
    return b;
  }

  // Ctrl+V anywhere: an image goes to the form the cursor is in, otherwise to the most recently opened one.
  // Plain text (including image URLs) is pasted as usual and never downloaded.
  document.addEventListener('paste', e => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    // text copied from Word/Excel also carries a picture of itself: into a text field it goes as text
    if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName) && e.clipboardData.getData('text/plain').trim()) return;
    for (let k = trays.length - 1; k >= 0; k--) if (!trays[k].isConnected) trays.splice(k, 1);
    const t = trays.find(t => t.zone.contains(e.target)) || trays[trays.length - 1];
    if (!t) return;
    e.preventDefault();
    t.addFiles(files);
  });

  // a file dropped outside the note form must not make the browser leave the page to show it
  document.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    const t = trays.filter(t => t.isConnected).pop(), files = imageFiles(e.dataTransfer);
    if (t && files.length) t.addFiles(files);
  });

  // upload the pending items of a tray for note `id`; returns the list of paths (kind: '' — video notes, 'script')
  async function upload(items, id, kind = '') {
    const out = [];
    for (const it of items) {
      if (!it.path) {
        const r = await fetch(`/api/ref?id=${id}${kind ? '&kind=' + kind : ''}`, { method: 'POST', body: it.data });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.path) throw new Error(j.error || (r.status === 404 ? 'сервер ревью старой версии — перезапусти review.bat' : `HTTP ${r.status}`));
        it.path = j.path; delete it.data;                  // uploaded: a retry won't send it twice
      }
      out.push(it.path);
    }
    return out;
  }

  return { view, tray, upload, show, url };
})();
