// Claude Studio — S12.9: раздел «Обложки» (docs/studio/stage12-redesign.md §10.4).
// Доска на видео (+ свободная доска канала): канвас нод — Картинка, Текст, Промпт, Результат; связи «картинка/текст → промпт → результаты».
// «Сгенерировать» у промпта — новая нода-результат ниже по ветке (Higgsfield или «Claude · кодом»); клик по результату — «Сделать обложкой», скачать, на весь экран.
// Режим «Промпт» — то же без канваса. Сервер — server/thumbs_api.py.
'use strict';

const TB = { b: null, bd: null, R: {}, models: [], key: false, mode: Local.get('tb-mode') || 'canvas', sel: null, boards: null, saveT: 0, busy: false, poll: 0, loaded: '' };
const TB_W = { image: 240, text: 240, prompt: 380, result: 300 };
const TB_DONE = ['completed', 'failed', 'nsfw', 'canceled'];

const Thumbs = {
  // ---------------- данные ----------------
  async loadBoards() { try { TB.boards = await api('GET', '/api/thumbs/boards'); } catch { TB.boards = []; } App.render(); },
  async open(b) {
    TB.b = b; TB.bd = null; TB.sel = null; TB.loaded = b;
    try {
      const r = await api('GET', '/api/thumbs/board?b=' + encodeURIComponent(b));
      if (TB.b !== b) return;
      TB.bd = r.board; TB.R = r.results || {}; TB.models = r.models || []; TB.key = r.key;
      TB.bd.view = TB.bd.view || { x: 0, y: 0, z: 1 };
    } catch (e) { UI.toast(e.message, 'err'); TB.bd = { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }; }
    App.render();
  },
  save() {
    clearTimeout(TB.saveT);
    TB.saveT = setTimeout(() => { if (TB.b && TB.bd) api('POST', '/api/thumbs/board', { b: TB.b, board: TB.bd }).catch(e => UI.toast('Доска не сохранилась: ' + e.message, 'err')); }, 400);
  },
  node(id) { return (TB.bd.nodes || []).find(n => n.id === id); },
  add(n) { n.id = n.id || uid(n.type[0]); n.w = n.w || TB_W[n.type]; TB.bd.nodes.push(n); this.save(); return n; },
  remove(id) {
    TB.bd.nodes = TB.bd.nodes.filter(n => n.id !== id);
    TB.bd.edges = TB.bd.edges.filter(e => e.from !== id && e.to !== id);
    if (TB.sel === id) TB.sel = null;
    this.save(); this.draw();
  },
  file(src) { return `/api/thumbs/file?b=${encodeURIComponent(TB.b)}&f=${encodeURIComponent(src)}`; },
  inputs(p) {                                              // входы промпта: картинки (по порядку сверху вниз) и тексты
    const ins = TB.bd.edges.filter(e => e.to === p.id).map(e => this.node(e.from)).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
    return { imgs: ins.filter(n => n.type === 'image' || (n.type === 'result' && (TB.R[n.id] || {}).file)), texts: ins.filter(n => n.type === 'text') };
  },
  srcOf(n) { return n.type === 'image' ? n.src : (TB.R[n.id] || {}).file; },
  modelOf(id) { return TB.models.find(m => m.id === id) || TB.models[0] || { id: 'hf:sunburst', ar: ['9:16'], q: [], res: [], refs: 16 }; },
  isLong() { const p = App.plans.find(x => x.id === TB.b); return p && p.mode === 'long'; },

  async upload(file, at) {
    try {
      const r = await api('POST', `/api/thumbs/upload?b=${encodeURIComponent(TB.b)}&name=${encodeURIComponent(file.name || 'img.png')}`, undefined, file);
      this.add({ type: 'image', src: r.src, name: file.name || 'картинка', x: at.x, y: at.y });
      this.draw();
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  async fromUrl(url, name, at) {
    try { const r = await api('POST', '/api/thumbs/fromurl', { b: TB.b, url }); this.add({ type: 'image', src: r.src, name, x: at.x, y: at.y }); this.draw(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  async generate(p) {
    const m = this.modelOf(p.model), { imgs, texts } = this.inputs(p);
    let prompt = (p.text || '').trim() + texts.map(t => (t.text || '').trim()).filter(Boolean).map(t => '\n' + t).join('');
    if (!prompt.trim()) return UI.toast('Напишите промпт', 'err');
    prompt = prompt.replace(/@img(\d+)/g, (_, n) => `[image ${n}]`);
    if (imgs.length > m.refs) UI.toast(`${m.label}: берёт до ${m.refs} картинок — лишние пропущу`);
    const k = TB.bd.edges.filter(e => e.from === p.id && (this.node(e.to) || {}).type === 'result').length;
    const r = this.add({ type: 'result', from: p.id, x: p.x + p.w + 90, y: p.y + k * 300 });
    TB.bd.edges.push({ from: p.id, to: r.id });
    TB.R[r.id] = { status: 'queued', label: m.label, model: m.id };
    this.save(); this.draw();
    try { await api('POST', '/api/thumbs/generate', { b: TB.b, rid: r.id, model: m.id, prompt, refs: imgs.map(n => this.srcOf(n)).filter(Boolean), aspect: p.aspect, quality: p.quality, resolution: p.res }); }
    catch (e) { TB.R[r.id] = { status: 'failed', error: e.message, label: m.label }; this.draw(); }
    this.pollSoon();
  },
  pollSoon() {
    clearTimeout(TB.poll);
    TB.poll = setTimeout(async () => {
      if (!TB.b || App.route.page !== 'thumbs') return;
      const pend = Object.values(TB.R).some(r => !TB_DONE.includes(r.status));
      if (!pend) return;
      try { const r = await api('GET', '/api/thumbs/board?b=' + encodeURIComponent(TB.b)); const was = JSON.stringify(TB.R); TB.R = r.results || {}; if (JSON.stringify(TB.R) !== was) this.draw(); } catch {}
      this.pollSoon();
    }, 2000);
  },
  async use(n) {
    const f = (TB.R[n.id] || {}).file || n.src;
    try { await api('POST', '/api/thumbs/use', { b: TB.b, src: f }); UI.toast('★ Обложка видео — на карточке, в упаковке и в экспорте'); TB.bd.cover = f; this.save(); this.draw(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- страница ----------------
  page() {
    if (!TB.boards) { TB.boards = []; this.loadBoards(); }
    const want = App.route.id || (TB.b && TB.loaded) || (Shell.lastVideo() || {}).id || 'ch';
    if (want !== TB.loaded) { setTimeout(() => this.open(want), 0); TB.loaded = want; }
    const list = TB.boards || [];
    return h('div.tb-page',
      h('aside.tb-list', h('div.ws-sec', 'Доски'),
        list.map(x => h('a.tb-b', { class: x.b === TB.b ? 'on' : '', href: '#/thumbs/' + x.b }, x.b === 'ch' ? Icon('grid', 15) : Icon(x.mode === 'long' ? 'wide' : 'tall', 15),
          h('span.lbl', x.name), x.n ? h('span.cnt', String(x.n)) : null))),
      h('section.tb-main',
        h('div.tb-head', h('b', (list.find(x => x.b === TB.b) || {}).name || 'Обложки'),
          h('div.seg', [['canvas', 'Канвас'], ['prompt', 'Промпт']].map(([k, l]) => h('button', { class: TB.mode === k ? 'sel' : '', onclick: () => { TB.mode = k; Local.set('tb-mode', k); App.render(); } }, l))),
          h('span.sp'),
          h('span.tb-key', { class: TB.key ? 'ok' : '' }, TB.key ? 'Higgsfield · ключ задан' : h('a', { href: '#/settings' }, 'Higgsfield: ключ не задан — Настройки')),
          TB.b && TB.b !== 'ch' && h('a.btn.small', { href: '#/v/' + TB.b }, Icon('clapper', 13), 'К видео')),
        !TB.bd ? h('div.tb-wait', h('span.spin'), ' загружаю доску…') : TB.mode === 'prompt' ? this.promptView() : h('div.tb-canvas#tbc')));
  },
  // после App.render: канвас рисуется своим кодом (без пересборки страницы на каждое движение)
  mount() { if (App.route.page === 'thumbs' && TB.mode === 'canvas' && TB.bd && $('#tbc')) this.draw(); },

  // ---------------- канвас ----------------
  draw() {
    const C = $('#tbc');
    if (!C || !TB.bd) { if (TB.mode === 'prompt' && App.route.page === 'thumbs') App.render(); return; }
    const a = document.activeElement, fk = a && a.dataset && a.dataset.tk, sel = fk && [a.selectionStart, a.selectionEnd];
    const V = TB.bd.view;
    const world = h('div.tb-world', { style: { transform: `translate(${V.x}px, ${V.y}px) scale(${V.z})` } },
      (() => { const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('class', 'tb-edges'); sv.setAttribute('width', '1'); sv.setAttribute('height', '1'); return sv; })(),   // слой связей — настоящий SVG
      ...TB.bd.nodes.map(n => this.nodeEl(n)));
    const bar = h('div.tb-bar',
      h('button', { onclick: () => this.addAtCenter('prompt') }, Icon('spark', 14), 'Промпт'),
      h('button', { onclick: () => this.pickFile() }, Icon('image', 14), 'Картинка'),
      TB.b !== 'ch' && h('button', { onclick: () => this.fromVideo() }, Icon('film', 14), 'Из видео'),
      h('button', { onclick: () => this.addAtCenter('text') }, Icon('hash', 14), 'Текст'),
      h('span.sep'),
      h('button.icon', { onclick: () => this.zoom(1 / 1.2) }, '−'), h('span.tb-z', Math.round(V.z * 100) + '%'), h('button.icon', { onclick: () => this.zoom(1.2) }, '+'),
      h('button.icon', { title: 'Вписать всё', onclick: () => this.fit() }, '⤢'));
    const hint = h('div.tb-hint', 'Тянуть пустое — двигать · Ctrl+колесо — масштаб · тянуть от точки — соединить · Delete — удалить · двойной клик — текст · Ctrl+V / перетащить — картинка');
    C.replaceChildren(...[world, bar, hint, !TB.bd.nodes.length && h('div.tb-empty', Icon('image', 26), h('b', 'Перетащите картинки или начните с промпта'),
      h('p', 'Соедините картинки с промптом (их можно упоминать как @img1, @img2 …), нажмите «Сгенерировать» — результат появится рядом. Двойной клик — текст.'),
      h('div.row', h('button.primary', { onclick: () => this.addAtCenter('prompt') }, Icon('spark', 14), 'Новый промпт'), h('button', { onclick: () => this.pickFile() }, Icon('image', 14), 'Добавить картинки')))].filter(Boolean));
    this.bindCanvas(C);
    requestAnimationFrame(() => this.edges());
    if (fk) { const e = C.querySelector(`[data-tk="${fk}"]`); if (e) { e.focus({ preventScroll: true }); try { e.setSelectionRange(sel[0], sel[1]); } catch {} } }
    if (Object.values(TB.R).some(r => !TB_DONE.includes(r.status))) this.pollSoon();
  },
  toWorld(cx, cy) { const C = $('#tbc').getBoundingClientRect(), V = TB.bd.view; return { x: (cx - C.left - V.x) / V.z, y: (cy - C.top - V.y) / V.z }; },
  addAtCenter(type) {
    const C = $('#tbc').getBoundingClientRect(), p = this.toWorld(C.left + C.width / 2 - 150, C.top + C.height / 2 - 120);
    const long = this.isLong();
    const n = this.add(type === 'prompt' ? { type, x: p.x, y: p.y, text: '', model: 'hf:sunburst', aspect: long ? '16:9' : '9:16', quality: 'high', res: '2k' } : { type, x: p.x, y: p.y, text: '' });
    TB.sel = n.id; this.draw();
  },
  pickFile() {
    const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => {
      const C = $('#tbc').getBoundingClientRect(); let k = 0;
      for (const f of inp.files) { const p = this.toWorld(C.left + 60 + k * 30, C.top + 60 + k * 260); this.upload(f, p); k++; }
    } });
    inp.click();
  },
  fromVideo() {
    (async () => { if (!Store.get('plan:' + TB.b)) await Store.load('plan:' + TB.b); this.fromVideoDlg(Store.get('plan:' + TB.b)); })();
  },
  fromVideoDlg(d) {
    const C = $('#tbc').getBoundingClientRect(), at = this.toWorld(C.left + 80, C.top + 80);
    const els = (d.elements || []).filter(e => e.status !== 'drop' && elPic(e));
    const close = UI.modal('Картинка из видео', h('div.tb-pick',
      h('div.tb-pi', { onclick: () => { close(); this.fromUrl(`/api/videos/cover?id=${d.id}`, 'кадр видео', at); } }, h('img', { src: `/api/videos/cover?id=${d.id}&v=${d.updated}` }), h('span', 'Обложка / кадр ролика')),
      els.map(e => h('div.tb-pi', { onclick: () => { close(); this.fromUrl('/' + elPic(e), e.name, at); } }, h('img', { src: '/' + elPic(e) }), h('span', e.name)))), { wide: true });
  },
  zoom(k, cx, cy) {
    const V = TB.bd.view, C = $('#tbc').getBoundingClientRect();
    cx = cx ?? C.left + C.width / 2; cy = cy ?? C.top + C.height / 2;
    const z = Math.max(0.2, Math.min(2.5, V.z * k)), wx = (cx - C.left - V.x) / V.z, wy = (cy - C.top - V.y) / V.z;
    V.x = cx - C.left - wx * z; V.y = cy - C.top - wy * z; V.z = z;
    this.save(); this.draw();
  },
  fit() {
    const N = TB.bd.nodes; if (!N.length) return;
    const C = $('#tbc').getBoundingClientRect(), x0 = Math.min(...N.map(n => n.x)), y0 = Math.min(...N.map(n => n.y)), x1 = Math.max(...N.map(n => n.x + (n.w || 300))), y1 = Math.max(...N.map(n => n.y + 360));
    const z = Math.max(0.2, Math.min(1.2, Math.min((C.width - 80) / (x1 - x0), (C.height - 120) / (y1 - y0))));
    TB.bd.view = { x: 40 - x0 * z, y: 40 - y0 * z, z }; this.save(); this.draw();
  },

  nodeEl(n) {
    const R = TB.R[n.id] || {}, M = this.modelOf(n.model), isSel = TB.sel === n.id;
    const port = (side) => h('span.tb-port', { class: side, 'data-port': side, 'data-id': n.id, onmousedown: side === 'out' ? ev => this.startLink(ev, n) : null });
    let body;
    if (n.type === 'image') body = [h('div.tb-h', h('span', n.name || 'картинка')), h('img.tb-img', { src: this.file(n.src), draggable: false }), port('out')];
    else if (n.type === 'text') body = [h('div.tb-h', h('span', 'Текст')), h('textarea.tb-ta', { 'data-tk': 'tx' + n.id, rows: 3, placeholder: 'Текст для промпта…', oninput: e => { n.text = e.target.value; this.save(); } }, n.text || ''), port('out')];
    else if (n.type === 'prompt') {
      const { imgs } = this.inputs(n);
      const sel2 = (k, opts, v, lbl) => opts.length ? sel(opts.map(o => ({ value: o, label: lbl ? lbl(o) : o })), v, x => { n[k] = x; this.save(); this.draw(); }, { class: 'tb-sel' }) : null;
      const ta = h('textarea.tb-ta.tb-prompt', { 'data-tk': 'pr' + n.id, rows: 7, placeholder: 'Что нарисовать. Картинки слева — @img1, @img2 …', oninput: e => { n.text = e.target.value; this.save(); } });
      ta.value = n.text || '';
      body = [port('in'),
        h('div.tb-h', Icon('spark', 13), h('span', 'Промпт'), h('span.sp'), h('span.dim', `${imgs.length} реф.`)),
        imgs.length > 0 && h('div.tb-chips', imgs.map((x, i) => h('span.tb-chip', { title: 'вставить в промпт', onclick: () => { n.text = (n.text || '') + ` @img${i + 1}`; this.save(); this.draw(); } }, h('img', { src: this.file(this.srcOf(x)) }), '@img' + (i + 1)))),
        ta,
        h('div.tb-model', sel(TB.models.map(m => ({ value: m.id, label: m.label })), M.id, x => { n.model = x; this.save(); this.draw(); }, { class: 'tb-sel', title: 'Модель генерации' })),
        h('div.tb-foot',
          sel2('aspect', M.ar, n.aspect && M.ar.includes(n.aspect) ? n.aspect : M.ar.includes('9:16') && !this.isLong() ? '9:16' : M.ar[0]),
          sel2('res', M.res, n.res && M.res.includes(n.res) ? n.res : M.res[Math.min(1, M.res.length - 1)]),
          sel2('quality', M.q, n.quality && M.q.includes(n.quality) ? n.quality : M.q.includes('high') ? 'high' : M.q[M.q.length - 1]),
          h('span.sp'), h('button.primary.small', { onclick: () => this.generate(n) }, Icon('spark', 13), 'Сгенерировать')),
        port('out')];
    } else {                                               // result
      const st = R.status || 'queued', done = st === 'completed' && R.file;
      body = [port('in'),
        h('div.tb-h', h('span', R.label || 'Результат'), h('span.sp'), h('span.tb-st', { class: st }, { queued: 'в очереди', uploading: 'загружаю рефы', in_progress: 'генерирую', completed: '', failed: 'ошибка', nsfw: 'модерация', canceled: 'отменено' }[st] ?? st)),
        done ? h('div.tb-res', h('img.tb-img', { src: this.file(R.file), draggable: false, ondblclick: () => UI.lightbox(this.file(R.file)) }),
          h('div.tb-tools',
            h('button.icon', { title: 'На весь экран', onclick: () => UI.lightbox(this.file(R.file)) }, '⤢'),
            TB.b !== 'ch' && h('button.small', { class: TB.bd.cover === R.file ? 'on' : '', onclick: () => this.use(n), title: 'Обложка видео: карточка, упаковка, экспорт' }, TB.bd.cover === R.file ? '★ Обложка' : '☆ Сделать обложкой'),
            h('a.btn.icon', { href: this.file(R.file), download: (R.file || '').split('/').pop(), title: 'Скачать' }, Icon('download', 14)),
            TB.b !== 'ch' && h('button.icon', { title: 'В проводнике', onclick: () => api('POST', '/api/videos/open', { id: TB.b, file: 'thumbs/' + R.file }) }, Icon('folder', 14))))
          : st === 'failed' || st === 'nsfw' ? h('div.tb-wait.err', R.error || 'не получилось')
            : h('div.tb-wait', h('span.spin'), ' ', R.model === 'claude' ? 'Claude рисует…' : st === 'queued' ? 'В очереди Higgsfield' : 'Генерирую…'),
        port('out')];
    }
    return h('div.tb-node', { class: n.type + (isSel ? ' sel' : ''), 'data-id': n.id, style: { left: n.x + 'px', top: n.y + 'px', width: (n.w || TB_W[n.type]) + 'px' },
      onmousedown: ev => this.startDrag(ev, n) }, body);
  },
  edges() {
    const W = $('#tbc .tb-world'), svg = W && W.querySelector('svg.tb-edges');
    if (!svg || !TB.bd) return;
    const pos = (id, side) => { const el = W.querySelector(`.tb-node[data-id="${id}"]`), n = this.node(id); if (!el || !n) return null; return { x: n.x + (side === 'out' ? el.offsetWidth : 0), y: n.y + el.offsetHeight / 2 }; };
    const paths = TB.bd.edges.map(e => {
      const a = pos(e.from, 'out'), b = pos(e.to, 'in'); if (!a || !b) return '';
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2), pend = (this.node(e.to) || {}).type === 'result' && !TB_DONE.includes((TB.R[e.to] || {}).status);
      return `<path d="M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}" class="${pend ? 'pend' : ''}"/>`;
    }).join('');
    svg.innerHTML = paths + (TB.link ? `<path d="M${TB.link.a.x},${TB.link.a.y} L${TB.link.b.x},${TB.link.b.y}" class="tmp"/>` : '');
  },

  // ---------------- мышь ----------------
  bindCanvas(C) {
    if (C._bound) return; C._bound = true;
    C.addEventListener('mousedown', ev => {
      if (ev.target !== C && !ev.target.classList.contains('tb-world') && ev.target.tagName !== 'svg') return;
      TB.sel = null; C.querySelectorAll('.tb-node.sel').forEach(x => x.classList.remove('sel'));
      const V = TB.bd.view, x0 = ev.clientX, y0 = ev.clientY, vx = V.x, vy = V.y, W = C.querySelector('.tb-world');
      const mv = e => { V.x = vx + e.clientX - x0; V.y = vy + e.clientY - y0; W.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.z})`; C.style.backgroundPosition = `${V.x}px ${V.y}px`; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); this.save(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
    C.addEventListener('wheel', ev => {
      ev.preventDefault();
      if (ev.ctrlKey) this.zoom(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
      else { const V = TB.bd.view; V.x -= ev.deltaX; V.y -= ev.deltaY; C.querySelector('.tb-world').style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.z})`; C.style.backgroundPosition = `${V.x}px ${V.y}px`; this.save(); }
    }, { passive: false });
    C.addEventListener('dblclick', ev => {
      if (ev.target !== C && !ev.target.classList.contains('tb-world')) return;
      const p = this.toWorld(ev.clientX, ev.clientY); const n = this.add({ type: 'text', x: p.x, y: p.y, text: '' }); TB.sel = n.id; this.draw();
      setTimeout(() => { const t = C.querySelector(`[data-tk="tx${n.id}"]`); if (t) t.focus(); }, 0);
    });
    C.addEventListener('dragover', ev => { ev.preventDefault(); C.classList.add('over'); });
    C.addEventListener('dragleave', () => C.classList.remove('over'));
    C.addEventListener('drop', ev => {
      ev.preventDefault(); C.classList.remove('over');
      const p = this.toWorld(ev.clientX, ev.clientY); let k = 0;
      for (const f of ev.dataTransfer.files) if (f.type.startsWith('image/')) this.upload(f, { x: p.x + k * 30, y: p.y + (k++) * 260 });
    });
    C.style.backgroundPosition = `${TB.bd.view.x}px ${TB.bd.view.y}px`;
  },
  startDrag(ev, n) {
    if (ev.button !== 0 || TB.mode !== 'canvas' || ev.target.closest('textarea,select,button,a,input,.tb-port')) return;
    ev.stopPropagation();
    TB.sel = n.id; $$('#tbc .tb-node.sel').forEach(x => x.classList.remove('sel')); ev.currentTarget.classList.add('sel');
    const el = ev.currentTarget, x0 = ev.clientX, y0 = ev.clientY, nx = n.x, ny = n.y, z = TB.bd.view.z;
    const mv = e => { n.x = nx + (e.clientX - x0) / z; n.y = ny + (e.clientY - y0) / z; el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; this.edges(); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); this.save(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  startLink(ev, n) {
    ev.stopPropagation(); ev.preventDefault();
    const el = ev.currentTarget.closest('.tb-node');
    TB.link = { a: { x: n.x + el.offsetWidth, y: n.y + el.offsetHeight / 2 }, b: this.toWorld(ev.clientX, ev.clientY) };
    const mv = e => { TB.link.b = this.toWorld(e.clientX, e.clientY); this.edges(); };
    const up = e => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      TB.link = null;
      const t = document.elementFromPoint(e.clientX, e.clientY), tn = t && t.closest('.tb-node'), to = tn && this.node(tn.dataset.id);
      if (to && to.id !== n.id && to.type === 'prompt' && !TB.bd.edges.some(x => x.from === n.id && x.to === to.id)) { TB.bd.edges.push({ from: n.id, to: to.id }); this.save(); this.draw(); }
      else this.edges();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },

  // ---------------- режим «Промпт» ----------------
  promptView() {
    let p = TB.bd.nodes.find(n => n.type === 'prompt');
    if (!p) p = this.add({ type: 'prompt', x: 400, y: 80, text: '', model: 'hf:sunburst', aspect: this.isLong() ? '16:9' : '9:16', quality: 'high', res: '2k' });
    const { imgs } = this.inputs(p), images = TB.bd.nodes.filter(n => n.type === 'image');
    const res = TB.bd.nodes.filter(n => n.type === 'result').reverse();
    const toggle = img => { const has = TB.bd.edges.some(e => e.from === img.id && e.to === p.id); TB.bd.edges = has ? TB.bd.edges.filter(e => !(e.from === img.id && e.to === p.id)) : [...TB.bd.edges, { from: img.id, to: p.id }]; this.save(); App.render(); };
    return h('div.tb-pmode',
      h('div.tb-pleft',
        this.nodeEl(p),
        h('div.ws-sec', 'Картинки доски', h('span.dim', ' — клик: в промпт / из промпта')),
        h('div.tb-refs', images.map(img => h('div.tb-ref', { class: imgs.includes(img) ? 'on' : '', onclick: () => toggle(img) }, h('img', { src: this.file(img.src) }), imgs.includes(img) ? h('span', '@img' + (imgs.indexOf(img) + 1)) : null)),
          h('div.tb-ref.add', { onclick: () => { const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => { for (const f of inp.files) this.upload(f, { x: 40, y: 40 + images.length * 260 }).then(() => App.render()); } }); inp.click(); } }, '+'))),
      h('div.tb-pres', res.length ? res.map(n => this.nodeEl(n)) : h('div.tb-wait.dim', 'Результаты появятся здесь.')));
  },
};

addEventListener('keydown', e => {
  if (App.route.page !== 'thumbs' || !TB.sel || TB.mode !== 'canvas') return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); Thumbs.remove(TB.sel); }
});
addEventListener('paste', e => {
  if (App.route.page !== 'thumbs' || !TB.b) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
  const files = [...(e.clipboardData || {}).files || []].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const C = $('#tbc'), r = C ? C.getBoundingClientRect() : { left: 0, top: 0, width: 600, height: 400 };
  files.forEach((f, k) => Thumbs.upload(f, C ? Thumbs.toWorld(r.left + r.width / 2 - 120 + k * 30, r.top + r.height / 2 - 120 + k * 30) : { x: 40, y: 40 }).then(() => TB.mode === 'prompt' && App.render()));
});
