// Claude Studio — S12.9: раздел «Обложки» (docs/studio/stage12-redesign.md §10.4).
// Доска на видео (+ свободная доска канала): канвас нод — Картинка, Текст, Промпт, Результат; связи «картинка/текст → промпт → результаты».
// «Сгенерировать» у промпта — новая нода-результат ниже по ветке (Higgsfield, «Claude · кодом» или FLUX.2 [klein] локально — с сидом); клик по результату — «Сделать обложкой», скачать, на весь экран.
// «Персонаж» — герой из библиотеки канала: со скелетом — фигура в выбранной эмоции без фона, 2D — его лист (картинка-нода, её можно подать в промпт как @img).
// Режим «Промпт» — то же без канваса. Сервер — server/thumbs_api.py.
// Выделение: клик, Ctrl/Shift+клик — добавить, Shift+тянуть по пустому — рамкой, Ctrl+A — всё; Ctrl+C / Ctrl+X → Ctrl+V — на эту или другую доску (картинки копируются).
'use strict';

const TB = { b: null, bd: null, R: {}, models: [], key: false, mode: Local.get('tb-mode') || 'canvas', sel: null, sels: new Set(), clip: null, boards: null, saveT: 0, busy: false, poll: 0, loaded: '' };
const TB_W = { image: 240, text: 240, prompt: 380, result: 300 };
const TB_DONE = ['completed', 'failed', 'nsfw', 'canceled'];

const Thumbs = {
  // ---------------- данные ----------------
  async loadBoards() { try { TB.boards = await api('GET', '/api/thumbs/boards'); } catch { TB.boards = []; } App.render(); },
  async open(b) {
    TB.b = b; TB.bd = null; TB.sel = null; TB.sels = new Set(); TB.loaded = b;
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
  remove(id) { this.removeMany([id]); },
  removeMany(ids) {
    const del = new Set(ids);
    TB.bd.nodes = TB.bd.nodes.filter(n => !del.has(n.id));
    TB.bd.edges = TB.bd.edges.filter(e => !del.has(e.from) && !del.has(e.to));
    ids.forEach(id => TB.sels.delete(id));
    if (del.has(TB.sel)) TB.sel = null;
    this.save(); this.draw();
  },
  select(ids, add) {                                       // выделение нод: TB.sels — все, TB.sel — последняя
    if (!add) TB.sels = new Set();
    ids.forEach(id => TB.sels.add(id));
    TB.sel = ids.length ? ids[ids.length - 1] : null;
    $$('#tbc .tb-node').forEach(x => x.classList.toggle('sel', TB.sels.has(x.dataset.id)));
  },

  // ---------------- копировать / вставить (в т.ч. на другую доску) ----------------
  copy(cut) {
    const ids = [...TB.sels].filter(id => this.node(id)); if (!ids.length) return;
    const set = new Set(ids), nodes = ids.map(id => JSON.parse(JSON.stringify(this.node(id))));
    const R = {}; nodes.filter(n => n.type === 'result' && TB.R[n.id]).forEach(n => { R[n.id] = TB.R[n.id]; });
    TB.clip = { b: TB.b, nodes, edges: TB.bd.edges.filter(e => set.has(e.from) && set.has(e.to)), results: R, mark: 'claude-studio:thumbs:' + uid() };
    try { Local.set('tb-clip', JSON.stringify(TB.clip)); } catch {}
    try { navigator.clipboard && navigator.clipboard.writeText(TB.clip.mark).catch(() => {}); } catch {}
    if (cut) {
      const cover = TB.bd.cover && nodes.some(n => (R[n.id] || {}).file === TB.bd.cover || n.src === TB.bd.cover);
      this.removeMany(ids);
      if (cover && TB.b !== 'ch') this.unuse(true);
    }
    UI.toast(`${cut ? 'Вырезано' : 'Скопировано'}: ${ids.length} — Ctrl+V на этой или другой доске`);
  },
  clipFor(text) {                                          // наш буфер — если в системном буфере наша метка (или там пусто)
    let c = TB.clip;
    if (!c) { try { c = JSON.parse(Local.get('tb-clip') || 'null'); } catch { c = null; } }
    if (!c || !c.nodes || !c.nodes.length) return null;
    return !text || text === c.mark ? c : null;
  },
  async pasteNodes(c) {
    const C = $('#tbc'); if (!C) return;
    const r = C.getBoundingClientRect(), x0 = Math.min(...c.nodes.map(n => n.x)), y0 = Math.min(...c.nodes.map(n => n.y));
    const at = c.b === TB.b && c.nodes.every(n => this.node(n.id)) ? { x: x0 + 40, y: y0 + 40 } : this.toWorld(r.left + 80, r.top + 80);
    const ids = {}; c.nodes.forEach(n => { ids[n.id] = uid(n.type[0]); });
    const results = {}; Object.entries(c.results || {}).forEach(([id, R]) => { if (ids[id]) results[ids[id]] = R; });
    const files = [...c.nodes.filter(n => n.type === 'image').map(n => n.src), ...Object.values(results).map(R => R.file)].filter(Boolean);
    let res;
    try { res = await api('POST', '/api/thumbs/paste', { from: c.b, to: TB.b, files, results }); }
    catch (e) { return UI.toast('Не вставилось: ' + e.message, 'err'); }
    const nodes = c.nodes.map(n => ({ ...JSON.parse(JSON.stringify(n)), id: ids[n.id], x: at.x + n.x - x0, y: at.y + n.y - y0,
      ...(n.src ? { src: res.map[n.src] || n.src } : {}), ...(n.from ? { from: ids[n.from] || n.from } : {}) }));
    TB.bd.nodes.push(...nodes);
    TB.bd.edges.push(...(c.edges || []).map(e => ({ from: ids[e.from], to: ids[e.to] })));
    Object.assign(TB.R, res.results || {});
    this.save(); this.draw(); this.select(nodes.map(n => n.id));
    UI.toast(`Вставлено: ${nodes.length}` + (c.b !== TB.b ? ' — картинки скопированы на эту доску' : ''));
  },
  file(src) { return `/api/thumbs/file?b=${encodeURIComponent(TB.b)}&f=${encodeURIComponent(src)}`; },
  inputs(p) {                                              // входы промпта: картинки (по порядку сверху вниз) и тексты
    const ins = TB.bd.edges.filter(e => e.to === p.id).map(e => this.node(e.from)).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
    return { imgs: ins.filter(n => n.type === 'image' || (n.type === 'result' && (TB.R[n.id] || {}).file)), texts: ins.filter(n => n.type === 'text') };
  },
  srcOf(n) { return n.type === 'image' ? n.src : (TB.R[n.id] || {}).file; },
  modelOf(id) { return TB.models.find(m => m.id === id) || TB.models[0] || { id: 'hf:sunburst', ar: ['9:16'], q: [], res: [], refs: 16 }; },
  opts(n, M) {                                             // то, что показывают селекты ноды (значение прошлой модели, которого у этой нет, — по умолчанию) — оно же уходит в генерацию
    return { aspect: n.aspect && M.ar.includes(n.aspect) ? n.aspect : M.ar.includes('9:16') && !this.isLong() ? '9:16' : M.ar[0],
      res: n.res && M.res.includes(n.res) ? n.res : M.res[Math.min(1, M.res.length - 1)],
      quality: n.quality && M.q.includes(n.quality) ? n.quality : M.q.includes('high') ? 'high' : M.q[M.q.length - 1] };
  },
  defModel() { return TB.key || !TB.models.some(m => m.local) ? 'hf:sunburst' : TB.models.find(m => m.local).id; },   // без ключа Higgsfield — локальная FLUX.2
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
    try { await api('POST', '/api/thumbs/generate', { b: TB.b, rid: r.id, model: m.id, prompt, refs: imgs.map(n => this.srcOf(n)).filter(Boolean), ...(o => ({ aspect: o.aspect, quality: o.quality, resolution: o.res }))(this.opts(p, m)), seed: m.seed ? p.seed : undefined, title: m.local ? p.title : undefined }); }
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
    if (TB.bd.cover === f) return this.unuse();             // повторный клик по «★ Обложка» — снять
    try { await api('POST', '/api/thumbs/use', { b: TB.b, src: f }); UI.toast('★ Обложка видео — на карточке, в упаковке и в экспорте'); TB.bd.cover = f; this.save(); this.draw(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  async unuse(quiet) {
    try { await api('POST', '/api/thumbs/unuse', { b: TB.b }); delete TB.bd.cover; this.save(); this.draw(); UI.toast(quiet ? 'Обложка этого видео снята (вырезали её картинку)' : 'Обложка видео снята'); }
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
    if (TB.dragging) { TB.redraw = true; return; }         // пока тянут ноду или полотно — не пересобирать DOM (нода «отваливалась» от мыши и связей)
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
      h('button', { title: 'Найти картинку: Яндекс Картинки или свободные (CC) — клик по картинке кладёт её на доску, можно несколько', onclick: () => this.searchImg() }, Icon('search', 14), 'Найти'),
      TB.b !== 'ch' && h('button', { onclick: () => this.fromVideo() }, Icon('film', 14), 'Из видео'),
      h('button', { onclick: () => this.addAtCenter('text') }, Icon('hash', 14), 'Текст'),
      h('button', { title: 'Персонаж из библиотеки канала', onclick: () => this.charDlg() }, Icon('user', 14), 'Персонаж'),
      h('span.sep'),
      h('button.icon', { onclick: () => this.zoom(1 / 1.2) }, '−'), h('span.tb-z', Math.round(V.z * 100) + '%'), h('button.icon', { onclick: () => this.zoom(1.2) }, '+'),
      h('button.icon', { title: 'Вписать всё', onclick: () => this.fit() }, '⤢'));
    const hint = h('div.tb-hint', 'Тянуть пустое — двигать · Shift+тянуть — рамкой · Ctrl+клик — к выделению · Ctrl+C / Ctrl+X → Ctrl+V — копировать, и на другую доску · Delete — удалить · двойной клик — текст · Ctrl+V / перетащить — картинка');
    C.replaceChildren(...[world, bar, hint, !TB.bd.nodes.length && h('div.tb-empty', Icon('image', 26), h('b', 'Перетащите картинки или начните с промпта'),
      h('p', 'Соедините картинки с промптом (их можно упоминать как @img1, @img2 …), нажмите «Сгенерировать» — результат появится рядом. Двойной клик — текст.'),
      h('div.row', h('button.primary', { onclick: () => this.addAtCenter('prompt') }, Icon('spark', 14), 'Новый промпт'), h('button', { onclick: () => this.pickFile() }, Icon('image', 14), 'Добавить картинки'), h('button', { onclick: () => this.searchImg() }, Icon('search', 14), 'Найти картинки')))].filter(Boolean));
    this.bindCanvas(C);
    requestAnimationFrame(() => this.edges());
    if (fk) { const e = C.querySelector(`[data-tk="${fk}"]`); if (e) { e.focus({ preventScroll: true }); try { e.setSelectionRange(sel[0], sel[1]); } catch {} } }
    if (Object.values(TB.R).some(r => !TB_DONE.includes(r.status))) this.pollSoon();
  },
  toWorld(cx, cy) { const C = $('#tbc').getBoundingClientRect(), V = TB.bd.view; return { x: (cx - C.left - V.x) / V.z, y: (cy - C.top - V.y) / V.z }; },
  addAtCenter(type) {
    const C = $('#tbc').getBoundingClientRect(), p = this.toWorld(C.left + C.width / 2 - 150, C.top + C.height / 2 - 120);
    const long = this.isLong();
    const n = this.add(type === 'prompt' ? { type, x: p.x, y: p.y, text: '', model: this.defModel(), aspect: long ? '16:9' : '9:16', quality: 'high', res: '2k' } : { type, x: p.x, y: p.y, text: '' });
    this.select([n.id]); this.draw();
  },
  pickFile() {
    const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => {
      const C = $('#tbc').getBoundingClientRect(); let k = 0;
      for (const f of inp.files) { const p = this.toWorld(C.left + 60 + k * 30, C.top + 60 + k * 260); this.upload(f, p); k++; }
    } });
    inp.click();
  },
  // 🔎 поиск картинок (ImgSearch из core.js: Яндекс / свободные CC): каждая взятая — нодой на доску, лесенкой от центра
  searchImg() {
    const C = $('#tbc'), r = C && C.getBoundingClientRect();
    const base = C ? this.toWorld(r.left + r.width / 2 - 120, r.top + 80) : { x: 40, y: 40 + TB.bd.nodes.filter(n => n.type === 'image').length * 260 };
    let k = 0;
    ImgSearch.open(Local.get('imgq') || '', { multi: true, fetch: async it => {
      const res = await api('POST', '/api/thumbs/fromurl', { b: TB.b, url: it.full, fallback: it.thumb });
      const n = this.add({ type: 'image', src: res.src, name: (it.title || it.domain || 'картинка').slice(0, 40), x: base.x + k * 30, y: base.y + k * 30 }); k++;
      TB.sel = n.id;
      TB.mode === 'prompt' ? App.render() : this.draw();
      return res.src;
    } });
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
  // ---------------- персонаж из библиотеки
  async charDlg() {
    let list;
    try { list = (await api('GET', '/api/thumbs/chars?b=' + encodeURIComponent(TB.b))).items || []; } catch (e) { return UI.toast(e.message, 'err'); }
    if (!list.length) return UI.toast('В библиотеке канала пока нет персонажей — «📚 в библиотеку» на утверждённом персонаже видео');
    const C = $('#tbc'), r = C && C.getBoundingClientRect();
    const at = C ? this.toWorld(r.left + r.width / 2 - 120, r.top + 80) : { x: 40, y: 40 + TB.bd.nodes.filter(n => n.type === 'image').length * 260 };
    const pick = async (x, emotion) => {
      close();
      UI.toast(x.rig ? `Рисую «${x.name}»${emotion ? ' · ' + emotion : ''}…` : `Беру лист «${x.name}»…`);
      try {
        const res = await api('POST', '/api/thumbs/fromlib', { b: TB.b, slug: x.slug, emotion: emotion || '' });
        const n = this.add({ type: 'image', src: res.src, name: res.name, x: at.x, y: at.y });
        TB.sel = n.id;
        TB.mode === 'prompt' ? App.render() : this.draw();
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    const close = UI.modal('Персонаж из библиотеки', h('div.tb-pick.tb-chars', list.map(x => h('div.tb-pi.tb-char',
      h('img', { src: x.preview, onclick: () => pick(x, ''), title: x.rig ? 'обычный' : 'лист персонажа' }), h('b', x.name),
      x.rig ? h('div.tb-emos', h('span.tb-emo', { onclick: () => pick(x, '') }, 'обычный'), x.emotions.map(e => h('span.tb-emo', { onclick: () => pick(x, e) }, e)))
        : h('span.dim.small', 'лист (без скелета)')))), { wide: true });
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
    const R = TB.R[n.id] || {}, M = this.modelOf(n.model), isSel = TB.sels.has(n.id);
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
        h('div.tb-h', Icon('spark', 13), h('span', 'Промпт'), h('span.sp'),
          TB.b !== 'ch' && Claude.btn({ label: 'По видео', action: 'thumbprompt', key: 'plan:' + TB.b, scope: 'thumbprompt:' + n.id, cls: 'small',
            title: 'Claude (Sonnet) прочитает сценарий, название, бриф (визуал и герои канала) и препродакшен и напишет промпт под выбранную модель. Что уже написано в поле — его пожелание.',
            params: () => ({ model: n.model, label: M.label, text: n.text || '', refs: this.inputs(n).imgs.map(x => ({ src: this.srcOf(x), name: x.name || '' })) }),
            onResult: r => { const p = this.node(n.id); if (!p || !r.prompt) return; p.text = r.prompt; if (r.title && this.modelOf(p.model).local) p.title = r.title; this.save();
              TB.mode === 'prompt' ? App.render() : this.draw(); if (r.why) UI.toast('✨ ' + r.why); } }),
          h('span.dim', `${imgs.length} реф.`)),
        imgs.length > 0 && h('div.tb-chips', imgs.map((x, i) => h('span.tb-chip', { title: 'вставить в промпт', onclick: () => { n.text = (n.text || '') + ` @img${i + 1}`; this.save(); this.draw(); } }, h('img', { src: this.file(this.srcOf(x)) }), '@img' + (i + 1)))),
        ta,
        M.local && h('input.tb-title', { 'data-tk': 'tt' + n.id, placeholder: 'Надпись на обложке (1–3 слова) — наложу шрифтом, без опечаток', value: n.title || '',
          title: 'FLUX пишет кириллицу с ошибками. Заполнено — картинка выйдет без текста и с местом под заголовок, а надпись ляжет шрифтом Rubik', oninput: e => { n.title = e.target.value; this.save(); } }),
        h('div.tb-model', sel(TB.models.map(m => ({ value: m.id, label: m.label })), M.id, x => { n.model = x; this.save(); this.draw(); }, { class: 'tb-sel', title: 'Модель генерации' })),
        h('div.tb-foot',
          sel2('aspect', M.ar, this.opts(n, M).aspect),
          sel2('res', M.res, this.opts(n, M).res),
          sel2('quality', M.q, this.opts(n, M).quality),
          M.seed && h('input.tb-seed', { 'data-tk': 'sd' + n.id, type: 'number', min: 0, placeholder: 'сид', title: 'Сид: пусто — случайный; тот же сид + промпт = та же картинка', value: n.seed ?? '',
            oninput: e => { n.seed = e.target.value === '' ? undefined : +e.target.value; this.save(); } }),
          h('span.sp'), h('button.primary.small', { onclick: () => this.generate(n) }, Icon('spark', 13), 'Сгенерировать')),
        port('out')];
    } else {                                               // result
      const st = R.status || 'queued', done = st === 'completed' && R.file;
      body = [port('in'),
        h('div.tb-h', h('span', R.label || 'Результат'), h('span.sp'), h('span.tb-st', { class: st }, { queued: 'в очереди', uploading: 'загружаю рефы', in_progress: 'генерирую', completed: '', failed: 'ошибка', nsfw: 'модерация', canceled: 'отменено' }[st] ?? st)),
        done ? h('div.tb-res', h('img.tb-img', { src: this.file(R.file), draggable: false, ondblclick: () => UI.lightbox(this.file(R.file)) }),
          h('div.tb-tools',
            h('button.icon', { title: 'На весь экран', onclick: () => UI.lightbox(this.file(R.file)) }, '⤢'),
            TB.b !== 'ch' && h('button.small', { class: TB.bd.cover === R.file ? 'on' : '', onclick: () => this.use(n), title: TB.bd.cover === R.file ? 'Обложка этого видео — клик: снять' : 'Обложка видео: карточка, упаковка, экспорт' }, TB.bd.cover === R.file ? '★ Обложка' : '☆ Сделать обложкой'),
            R.seed != null && h('button.small', { title: `Сид ${R.seed}${R.size ? ' · ' + R.size : ''}${R.secs ? ' · ' + R.secs + ' с' : ''} — клик: поставить этот сид в промпт`,
              onclick: () => { const p = this.node(n.from); if (p) { p.seed = R.seed; this.save(); this.draw(); UI.toast('Сид ' + R.seed + ' — в промпте'); } } }, Icon('hash', 13), R.secs ? R.secs + ' с' : 'сид'),
            h('a.btn.icon', { href: this.file(R.file), download: (R.file || '').split('/').pop(), title: 'Скачать' }, Icon('download', 14)),
            TB.b !== 'ch' && h('button.icon', { title: 'В проводнике', onclick: () => api('POST', '/api/videos/open', { id: TB.b, file: 'thumbs/' + R.file }) }, Icon('folder', 14))))
          : st === 'failed' || st === 'nsfw' ? h('div.tb-wait.err', R.error || 'не получилось')
            : h('div.tb-wait', h('span.spin'), ' ', R.model === 'claude' ? 'Claude рисует…' : (R.model || '').startsWith('flux:') ? 'Локально: ' + (R.note || 'в очереди') + '…'
              : st === 'queued' ? 'В очереди Higgsfield' : 'Генерирую…'),
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
      if (ev.shiftKey) return this.boxSelect(ev, C);         // Shift+тянуть по пустому — выделить рамкой
      this.select([]);
      ev.preventDefault();                                   // перетаскивание полотна не выделяет текст страницы
      const V = TB.bd.view, x0 = ev.clientX, y0 = ev.clientY, vx = V.x, vy = V.y;
      TB.dragging = true;
      const mv = e => { V.x = vx + e.clientX - x0; V.y = vy + e.clientY - y0; const W = C.querySelector('.tb-world'); if (W) W.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.z})`; C.style.backgroundPosition = `${V.x}px ${V.y}px`; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); this.endDrag(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
    C.addEventListener('wheel', ev => {
      ev.preventDefault();
      if (ev.ctrlKey) this.zoom(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
      else { const V = TB.bd.view; V.x -= ev.deltaX; V.y -= ev.deltaY; C.querySelector('.tb-world').style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.z})`; C.style.backgroundPosition = `${V.x}px ${V.y}px`; this.save(); }
    }, { passive: false });
    C.addEventListener('dblclick', ev => {
      if (ev.target !== C && !ev.target.classList.contains('tb-world')) return;
      const p = this.toWorld(ev.clientX, ev.clientY); const n = this.add({ type: 'text', x: p.x, y: p.y, text: '' }); this.select([n.id]); this.draw();
      setTimeout(() => { const t = C.querySelector(`[data-tk="tx${n.id}"]`); if (t) t.focus(); }, 0);
    });
    C.addEventListener('dragstart', ev => { if (!ev.target.closest || !ev.target.closest('textarea,input')) ev.preventDefault(); });   // не таскать картинку/текст браузером вместо ноды
    C.addEventListener('dragover', ev => { ev.preventDefault(); C.classList.add('over'); });
    C.addEventListener('dragleave', () => C.classList.remove('over'));
    C.addEventListener('drop', ev => {
      ev.preventDefault(); C.classList.remove('over');
      const p = this.toWorld(ev.clientX, ev.clientY); let k = 0;
      for (const f of ev.dataTransfer.files) if (f.type.startsWith('image/')) this.upload(f, { x: p.x + k * 30, y: p.y + (k++) * 260 });
    });
    C.style.backgroundPosition = `${TB.bd.view.x}px ${TB.bd.view.y}px`;
  },
  boxSelect(ev, C) {
    ev.preventDefault();                                   // иначе Shift+тянуть выделяет текст всей страницы — всё мигает
    try { getSelection().removeAllRanges(); } catch {}
    document.body.classList.add('tb-boxing');
    const r = C.getBoundingClientRect(), x0 = ev.clientX, y0 = ev.clientY, base = new Set(TB.sels);
    const box = h('div.tb-box'); C.append(box);
    let last = '';
    const mv = e => {
      e.preventDefault();
      const a = { x: Math.min(x0, e.clientX), y: Math.min(y0, e.clientY), x1: Math.max(x0, e.clientX), y1: Math.max(y0, e.clientY) };
      Object.assign(box.style, { left: a.x - r.left + 'px', top: a.y - r.top + 'px', width: a.x1 - a.x + 'px', height: a.y1 - a.y + 'px' });
      const hit = [...C.querySelectorAll('.tb-node')].filter(el => { const b = el.getBoundingClientRect(); return b.left < a.x1 && b.right > a.x && b.top < a.y1 && b.bottom > a.y; }).map(el => el.dataset.id);
      const key = hit.join(','); if (key === last) return; last = key;   // классы трогаем, только когда состав поменялся
      TB.sels = new Set([...base, ...hit]); TB.sel = hit[hit.length - 1] || TB.sel;
      $$('#tbc .tb-node').forEach(x => x.classList.toggle('sel', TB.sels.has(x.dataset.id)));
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); box.remove(); document.body.classList.remove('tb-boxing'); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  startDrag(ev, n) {
    if (ev.button !== 0 || TB.mode !== 'canvas' || ev.target.closest('textarea,select,button,a,input,.tb-port')) return;
    ev.stopPropagation();
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {             // Ctrl/Shift+клик — добавить к выделению / убрать
      if (TB.sels.has(n.id)) { TB.sels.delete(n.id); this.select([...TB.sels]); } else this.select([n.id], true);
      return;
    }
    ev.preventDefault();                                   // без этого браузер начинал выделять текст / тащить картинку, и нода отцеплялась от мыши
    try { getSelection().removeAllRanges(); } catch {}
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (!TB.sels.has(n.id)) this.select([n.id]); else TB.sel = n.id;
    const x0 = ev.clientX, y0 = ev.clientY, z = TB.bd.view.z;   // тянем всё выделенное
    const grp = [...TB.sels].map(id => this.node(id)).filter(Boolean).map(m => ({ n: m, nx: m.x, ny: m.y }));
    TB.dragging = true; document.body.classList.add('tb-boxing');
    const mv = e => {
      e.preventDefault();
      for (const g of grp) {
        g.n.x = g.nx + (e.clientX - x0) / z; g.n.y = g.ny + (e.clientY - y0) / z;
        const el = $(`#tbc .tb-node[data-id="${g.n.id}"]`);   // элемент — каждый раз из DOM: доску могли перерисовать
        if (el) { el.style.left = g.n.x + 'px'; el.style.top = g.n.y + 'px'; }
      }
      this.edges();
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); this.endDrag(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  endDrag() {
    TB.dragging = false; document.body.classList.remove('tb-boxing');
    this.save();
    if (TB.redraw) { TB.redraw = false; this.draw(); }
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
    if (!p) p = this.add({ type: 'prompt', x: 400, y: 80, text: '', model: this.defModel(), aspect: this.isLong() ? '16:9' : '9:16', quality: 'high', res: '2k' });
    const { imgs } = this.inputs(p), images = TB.bd.nodes.filter(n => n.type === 'image');
    const res = TB.bd.nodes.filter(n => n.type === 'result').reverse();
    const toggle = img => { const has = TB.bd.edges.some(e => e.from === img.id && e.to === p.id); TB.bd.edges = has ? TB.bd.edges.filter(e => !(e.from === img.id && e.to === p.id)) : [...TB.bd.edges, { from: img.id, to: p.id }]; this.save(); App.render(); };
    return h('div.tb-pmode',
      h('div.tb-pleft',
        this.nodeEl(p),
        h('div.ws-sec', 'Картинки доски', h('span.dim', ' — клик: в промпт / из промпта')),
        h('div.tb-refs', images.map(img => h('div.tb-ref', { class: imgs.includes(img) ? 'on' : '', onclick: () => toggle(img) }, h('img', { src: this.file(img.src) }), imgs.includes(img) ? h('span', '@img' + (imgs.indexOf(img) + 1)) : null)),
          h('div.tb-ref.add', { title: 'Персонаж из библиотеки', onclick: () => this.charDlg() }, Icon('user', 18)),
          h('div.tb-ref.add', { title: 'Найти картинку (Яндекс / свободные CC)', onclick: () => this.searchImg() }, Icon('search', 18)),
          h('div.tb-ref.add', { onclick: () => { const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: () => { for (const f of inp.files) this.upload(f, { x: 40, y: 40 + images.length * 260 }).then(() => App.render()); } }); inp.click(); } }, '+'))),
      h('div.tb-pres', res.length ? res.map(n => this.nodeEl(n)) : h('div.tb-wait.dim', 'Результаты появятся здесь.')));
  },
};

addEventListener('keydown', e => {
  if (App.route.page !== 'thumbs' || TB.mode !== 'canvas' || !TB.bd) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  const k = e.code || { c: 'KeyC', x: 'KeyX', a: 'KeyA', 'с': 'KeyC', 'ч': 'KeyX', 'ф': 'KeyA' }[(e.key || '').toLowerCase()], mod = e.ctrlKey || e.metaKey;   // e.code — и в русской раскладке
  if (mod && k === 'KeyA') { e.preventDefault(); Thumbs.select(TB.bd.nodes.map(n => n.id)); return; }
  if (e.key === 'Escape') { Thumbs.select([]); return; }
  if (!TB.sels.size) return;
  if (mod && (k === 'KeyC' || k === 'KeyX')) { e.preventDefault(); Thumbs.copy(k === 'KeyX'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); Thumbs.removeMany([...TB.sels]); }
});
addEventListener('paste', e => {
  if (App.route.page !== 'thumbs' || !TB.b) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
  const files = [...(e.clipboardData || {}).files || []].filter(f => f.type.startsWith('image/'));
  if (!files.length) {                                     // ноды, скопированные Ctrl+C / Ctrl+X на доске
    const c = TB.mode === 'canvas' && Thumbs.clipFor(((e.clipboardData && e.clipboardData.getData('text')) || '').trim());
    if (c) { e.preventDefault(); Thumbs.pasteNodes(c); }
    return;
  }
  e.preventDefault();
  const C = $('#tbc'), r = C ? C.getBoundingClientRect() : { left: 0, top: 0, width: 600, height: 400 };
  files.forEach((f, k) => Thumbs.upload(f, C ? Thumbs.toWorld(r.left + r.width / 2 - 120 + k * 30, r.top + r.height / 2 - 120 + k * 30) : { x: 40, y: 40 }).then(() => TB.mode === 'prompt' && App.render()));
});
