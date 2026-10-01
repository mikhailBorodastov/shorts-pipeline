// Claude Studio — core: DOM helper, API of the local script, documents with ops (+ sync), Claude jobs, small UI parts.
'use strict';
const API = 19;                     // must match ideas_api.API_VERSION
const REF = {};                     // web/ref.json, loaded at boot
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = (p = '') => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
const clone = o => JSON.parse(JSON.stringify(o));
const Local = {
  get(k) { try { return localStorage.getItem('shturm:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('shturm:' + k, v); } catch {} },
};

// h('div.card#x', {onclick, key, value, ...}, ...children) — `key` becomes data-key (focus survives re-render)
function h(tag, attrs, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const p of (m[2] || '').match(/[.#][\w-]+/g) || []) p[0] === '.' ? el.classList.add(p.slice(1)) : (el.id = p.slice(1));
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || (k === 'class' && !v)) continue;
    if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'key') el.dataset.key = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== '') el.append(k instanceof Node ? k : String(k));
  if (value !== undefined) el.value = value;          // after children: <select> needs its options first
  return el;
}

async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (method !== 'GET') {
    opt.headers['X-Ideas'] = '1';
    if (raw !== undefined) opt.body = raw;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  const r = await fetch(url, opt);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

// ---------- documents: local copy + operations queued to the script (mirrors ideas_api.apply_op) ----------
function resolvePath(doc, path, create) {
  let cur = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    let nx;
    if (Array.isArray(cur)) nx = cur.find(it => it && it.id === k);
    else if (cur && typeof cur === 'object') { nx = cur[k]; if (nx == null && create) nx = cur[k] = {}; }
    if (nx == null) return [null, null];
    cur = nx;
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) { const i = cur.findIndex(it => it && it.id === last); return i < 0 ? [null, null] : [cur, i]; }
  return cur && typeof cur === 'object' ? [cur, last] : [null, null];
}
function getPath(doc, path) { const [c, k] = resolvePath(doc, path, false); return c ? c[k] : undefined; }
function applyOp(doc, op) {
  const path = (op.path || []).map(String);
  if (!path.length || path[0] === 'rev' || path[0] === 'id') return;
  if (op.op === 'set') { const [c, k] = resolvePath(doc, path, true); if (c) c[k] = op.value; return; }
  const [c, k] = resolvePath(doc, path, true);
  if (!c || Array.isArray(c)) return;
  if (!Array.isArray(c[k])) c[k] = [];
  const list = c[k];
  if (op.op === 'add') {
    if (op.item && typeof op.item === 'object' && !op.item.id) op.item.id = uid();
    const at = op.at == null ? list.length : Math.max(0, Math.min(list.length, op.at));
    list.splice(at, 0, op.item);
    return;
  }
  const i = list.findIndex(it => it && it.id === op.id);
  if (i < 0) return;
  const [it] = list.splice(i, 1);
  if (op.op === 'move') list.splice(Math.max(0, Math.min(list.length, op.to)), 0, it);
}

const Store = {
  docs: {}, revs: {}, pending: {}, inflight: {}, timers: {}, stale: new Set(),
  get(key) { return this.docs[key]; },
  async load(key, force) {
    if (!force && this.docs[key]) return this.docs[key];
    const d = await api('GET', '/api/doc?key=' + encodeURIComponent(key));
    this.docs[key] = d; this.revs[key] = d.rev || 0;
    return d;
  },
  op(key, op, rerender = true) {
    const d = this.docs[key];
    if (!d) return;
    if (op.op === 'add' && op.item && !op.item.id) op.item.id = uid();
    applyOp(d, clone(op));
    const q = this.pending[key] || (this.pending[key] = []);
    if (op.op === 'set') {                            // typing: keep only the latest value per path
      const s = JSON.stringify(op.path), i = q.findIndex(o => o.op === 'set' && JSON.stringify(o.path) === s);
      if (i >= 0) q.splice(i, 1);
    }
    q.push(clone(op));
    Sync.dirty();
    this.schedule(key, op.op === 'set' && !rerender ? 500 : 60);
    if (rerender) App.render();
  },
  set(key, path, value, rerender = false) { this.op(key, { op: 'set', path, value }, rerender); },
  add(key, path, item, rerender = true) { this.op(key, { op: 'add', path, item }, rerender); },
  del(key, path, id, rerender = true) { this.op(key, { op: 'del', path, id }, rerender); },
  schedule(key, ms) { clearTimeout(this.timers[key]); this.timers[key] = setTimeout(() => this.flush(key), ms); },
  async flush(key) {
    if (this.inflight[key]) return this.schedule(key, 150);
    const ops = this.pending[key];
    if (!ops || !ops.length) return;
    this.pending[key] = []; this.inflight[key] = true;
    try {
      const r = await api('POST', '/api/op', { key, base: this.revs[key], ops });
      if (r.prev !== this.revs[key]) this.stale.add(key);   // Claude or the CLI wrote in between: refetch when idle
      this.revs[key] = r.rev;
    } catch (e) {
      this.pending[key] = ops.concat(this.pending[key] || []);
      UI.toast('Не сохранилось: ' + e.message, 'err');
      this.schedule(key, 4000);
    } finally { this.inflight[key] = false; Sync.dirty(); }
  },
  async flushAll() {
    for (let n = 0; n < 40 && this.busy(); n++) {
      for (const k of Object.keys(this.pending)) { clearTimeout(this.timers[k]); await this.flush(k); }
      if (this.busy()) await new Promise(r => setTimeout(r, 50));
    }
  },
  idle(key) { return !this.inflight[key] && !(this.pending[key] || []).length; },
  busy() { return Object.keys(this.pending).some(k => !this.idle(k)); },
  async sync(revs) {                                  // pull documents that changed on disk (Claude, CLI, another tab)
    let changed = false;
    for (const key of Object.keys(this.docs)) {
      const rev = revs[key];
      if (rev == null) continue;
      if ((rev > this.revs[key] || this.stale.has(key)) && this.idle(key)) {
        this.stale.delete(key);
        try { await this.load(key, true); changed = true; } catch {}
      }
    }
    return changed;
  },
};

const Sync = {
  web: null, ok: true,
  dirty() {
    const el = $('#saved');
    if (!el) return;
    const b = Store.busy();
    el.textContent = !this.ok ? '⚠ нет связи со скриптом' : b ? 'сохраняю…' : 'всё сохранено';
    el.classList.toggle('busy', b || !this.ok);
  },
  async tick() {
    try {
      const r = await api('GET', '/api/revs');
      if (!this.ok) { this.ok = true; App.banner(''); }
      if (this.web == null) this.web = r.web;
      else if (r.web !== this.web && !Store.busy()) { await Store.flushAll(); location.reload(); return; }
      if (r.api !== API) App.banner('⚠ Локальный скрипт Studio старой версии. Закрой его окно и запусти «Claude Studio.bat» заново.');
      await Claude.update(r.jobs);
      const changed = await Store.sync(r.docs);
      const plans = await App.plansChanged(r.docs);
      if (changed || plans) App.render();
    } catch (e) {
      if (this.ok) { this.ok = false; App.banner('⚠ Нет связи с локальным скриптом Studio. Запусти «Claude Studio.bat» — правки, сделанные сейчас, не сохранятся.'); }
    }
    this.dirty();
  },
  start() { this.tick(); setInterval(() => this.tick(), 2000); },
};

// ---------- Claude (claude -p through the local script, on the user's Claude Code subscription) ----------
const Claude = {
  on: false, jobs: {}, cbs: {},
  running(key, scope) { return Object.values(this.jobs).find(j => j.status === 'running' && j.key === key && j.scope === scope); },
  async run({ action, key, scope = action, params = {}, onResult, confirm: q }) {
    const local = { produce: '/api/produce', ytlogin: '/api/yt/login', ytsync: '/api/yt/sync', sndfetch: '/api/sound/fetch', refparse: '/api/refparse', assetfetch: '/api/assets/fetch', montagebuild: '/api/montage/build' }[action];
    if (!this.on && !local) return UI.toast('Claude Code не найден — кнопки ✨ не работают', 'err');
    if (q && !confirm(q)) return;
    Unread.ask();                                     // browser notifications: asked once, on a click (browsers require a gesture)
    await Store.flushAll();                           // Claude must see the latest text
    try {
      const r = await api('POST', local || '/api/claude', local ? params : { action, key, scope, params });
      this.jobs[r.job.id] = r.job;
      if (onResult) this.cbs[r.job.id] = onResult;
      App.render();
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  async update(list) {
    const now = {};
    for (const j of list || []) now[j.id] = j;
    let flip = false;
    for (const [id, old] of Object.entries(this.jobs)) {
      const j = now[id];
      if (old.status !== 'running') continue;
      if (!j) { flip = true; continue; }
      if (j.status === 'running') continue;
      flip = true;
      if (j.status === 'done' || j.status === 'error') Unread.done(j);
      if (j.status === 'done') {
        if (j.kind !== 'ytfresh') UI.toast(j.summary || 'Claude закончил');   // the 10-minute live counter stays quiet
        if (this.cbs[id]) { const full = await api('GET', '/api/job?id=' + id).catch(() => null); if (full) this.cbs[id](full.result || {}, full); }
      } else if (j.status === 'error') UI.toast('Claude: ' + j.error, 'err');
      delete this.cbs[id];
    }
    for (const [id, j] of Object.entries(now)) if (!this.jobs[id] && j.status === 'running') flip = true;
    this.jobs = now;
    if (flip) App.render();
  },
  // ✨ button: while the job runs it turns into «Claude думает… 12 с ✕» (click cancels)
  // noClaude: a job of the local script that does not need Claude (project creation)
  btn({ label, action, key, scope = action, params = {}, onResult, confirm: q, cls = '', title, icon = '✨', noClaude = false }) {
    const j = this.running(key, scope);
    if (j) return h('button.claude.run', { class: cls, title: 'Отменить', onclick: () => api('POST', '/api/job/cancel?id=' + j.id).catch(() => {}) },
      h('span.spin'), label ? (noClaude ? ' Делаю… ' : ' Claude думает… ') : ' ', h('span.elapsed', { 'data-start': j.started }, fmtSec(j.elapsed)), ' ✕');
    return h(noClaude ? 'button.primary' : 'button.claude', { class: cls, disabled: !this.on && !noClaude, title: title || 'Сделает Claude (подписка Claude Code, без API-ключей)',
      onclick: () => this.run({ action, key, scope, params: typeof params === 'function' ? params() : params, onResult, confirm: q }) }, icon, label ? ' ' + label : '');
  },
};
// finished Claude jobs: a dot on the plan (sidebar, card, tab) until you look at it + a browser notification when the tab is not in view
const Unread = {
  TAB: { ideas: 'ideas', beats: 'beats', q7: 'title', meanings: 'title', titles: 'title', strengthen: 'title', images: 'images',
    thumbs: 'thumbs', critique: 'thumbs', render: 'thumbs', structure: 'structure', produce: 'prod',
    questions: 'qa', challenge: 'qa', elements: 'pre', element: 'pre', sound: 'pre', sndfetch: 'pre', assets: 'pre', assetfetch: 'pre', layout3d: 'pre', refparse: 'idea', montagebuild: 'montage' },
  tabOf(kind, flow) { return flow === 'idea' && kind === 'beats' ? 'qa' : this.TAB[kind] || (flow === 'idea' ? 'idea' : 'ideas'); },
  get() { try { return JSON.parse(Local.get('unread') || '{}'); } catch { return {}; } },
  put(u) { Local.set('unread', JSON.stringify(u)); },
  has(id, tab) { const u = this.get()[id]; return !!(u && (tab ? u[tab] : Object.keys(u).length)); },
  ask() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} },
  done(j) {
    if (!j.key || !j.key.startsWith('plan:') || j.kind === 'ytfresh') return;
    const id = j.key.slice(5), plan = (App.plans || []).find(p => p.id === id), flow = plan ? plan.flow : 'storm';
    const tab = this.tabOf(j.kind, flow), r = App.route;
    const looking = !document.hidden && r.page === 'p' && r.id === id && (r.tab || defTab(flow)) === tab;
    if (!looking) { const u = this.get(); (u[id] = u[id] || {})[tab] = Date.now(); this.put(u); }
    const long = j.kind === 'render' || j.kind === 'element' || j.kind === 'produce' || (j.elapsed || 0) > 25;
    if ((document.hidden || !looking) && long && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(j.status === 'error' ? '⚠ Claude: не получилось' : j.kind === 'render' || j.kind === 'element' ? '🎨 Отрисовка готова' : '✨ Claude закончил',
          { body: (plan ? `«${plan.name}» — ` : '') + (j.status === 'error' ? j.error : j.summary || ''), tag: j.id });
        n.onclick = () => { window.focus(); go(`#/p/${id}/${tab}`); n.close(); };
      } catch {}
    }
  },
  seen(id, tab) {                                     // called on navigation: looking at the tab clears its dot
    const u = this.get();
    if (u[id] && u[id][tab]) { delete u[id][tab]; if (!Object.keys(u[id]).length) delete u[id]; this.put(u); }
  },
};
const dot = on => on && h('span.udot', { title: 'Есть обновления от Claude' });

const fmtSec = s => (s < 60 ? Math.round(s) + ' с' : Math.floor(s / 60) + ' мин ' + String(Math.round(s % 60)).padStart(2, '0') + ' с');
setInterval(() => $$('.elapsed').forEach(e => (e.textContent = fmtSec((Date.now() - +e.dataset.start) / 1000))), 1000);

// ---------- UI bits ----------
const UI = {
  toast(msg, kind = 'ok') {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show ' + kind;
    clearTimeout(this._t); this._t = setTimeout(() => (t.className = kind), kind === 'err' ? 7000 : 3200);
  },
  modal(title, body, { wide, onClose } = {}) {
    const close = () => { m.remove(); document.removeEventListener('keydown', esc); onClose && onClose(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    const m = h('div.modal', { onclick: e => { if (e.target === m) close(); } },
      h('div.box', { class: wide ? 'wide' : '' }, h('div.mh', h('h3', title), h('span.sp'), h('button.icon', { onclick: () => close() }, '✕')), body));
    document.addEventListener('keydown', esc);
    document.body.append(m);
    return close;
  },
  lightbox(src) { const l = h('div.lightbox', { onclick: () => l.remove() }, h('img', { src, alt: '' })); document.body.append(l); },
  copy(text) { navigator.clipboard.writeText(text).then(() => this.toast('Скопировано'), () => prompt('Скопируй:', text)); },
};

function autosize(ta) { if (!ta.isConnected) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }
// textarea bound to doc path: typing saves (debounced), no re-render
function area(key, path, { ph = '', cls = '', onInput } = {}) {
  const ta = h('textarea.auto', { class: cls, key: key + '|' + path.join('.'), placeholder: ph, rows: 1,
    oninput: e => { Store.set(key, path, e.target.value); autosize(e.target); onInput && onInput(e.target.value, e.target); } });
  ta.value = getPath(Store.get(key), path) ?? '';
  return ta;
}
function line(key, path, { ph = '', cls = '', type = 'text', onInput, num = false, title } = {}) {
  const v = getPath(Store.get(key), path);
  return h('input', { class: cls, type, key: key + '|' + path.join('.'), placeholder: ph, title, value: v ?? '',
    oninput: e => { const x = num && e.target.value !== '' ? Number(e.target.value.replace(',', '.')) : e.target.value; Store.set(key, path, x); onInput && onInput(e.target.value, e.target); } });
}
// text typed into inputs that are not bound to a document («+ …» lines, search, links) — survives re-renders (App.render rebuilds the page)
const Drafts = {};
function draftInput(k, attrs = {}) {
  return h('input', { ...attrs, key: k, value: Drafts[k] ?? attrs.value ?? '', oninput: e => { Drafts[k] = e.target.value; if (attrs.oninput) attrs.oninput(e); } });
}
// one-line input that adds an item on Enter
function addLine(ph, onAdd, key) {
  const k = key || 'add|' + ph;
  return h('div.addline', draftInput(k, { placeholder: ph, onkeydown: e => {
    if (e.key === 'Enter' && !e.isComposing && e.target.value.trim()) { const v = e.target.value.trim(); e.target.value = ''; delete Drafts[k]; onAdd(v); }
  } }));
}
function hint(id, html) {
  return h('details.hint', { open: Local.get('hint:' + id) !== '0', ontoggle: e => Local.set('hint:' + id, e.target.open ? '1' : '0') },
    h('summary', '💡 Как заполнять'), h('div.hint-body', { html }));
}
function sel(options, value, onChange, attrs = {}) {
  return h('select', { ...attrs, value, onchange: e => onChange(e.target.value) },
    options.map(o => Array.isArray(o.group) ? h('optgroup', { label: o.label }, o.group.map(g => h('option', { value: g.value }, g.label))) : h('option', { value: o.value }, o.label)));
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => { const m = n % 10, mm = n % 100; return m === 1 && mm !== 11 ? a : m >= 2 && m <= 4 && (mm < 10 || mm >= 20) ? b : c; };
const fmtDate = ms => ms ? new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';

// ---------- pictures: paste / drop / file / sketch ----------
const Paste = { target: null };
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const hasImgUrl = e => [...(e.dataTransfer?.types || [])].some(t => t === 'text/uri-list' || t === 'text/html');
const imageFiles = dt => [...(dt?.files || [])].filter(f => f.type.startsWith('image/'));
// картинка, перетащенная из окна поиска / с сайта: адрес из uri-list (обёртка поисковика с imgurl=…) или <img src> из html
function dropImageUrl(dt) {
  if (!dt) return '';
  const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find(s => s && !s.startsWith('#')) || '';
  if (/[?&](imgurl|mediaurl|img_url)=/.test(uri)) return uri;
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(dt.getData('text/html') || '');
  const src = m ? m[1].replace(/&amp;/g, '&') : '';
  if (/^(https?:|data:image\/)/.test(src)) return src;
  return /^https?:/.test(uri) ? uri : '';
}
const isImgUrl = s => /^https?:\/\/\S+\.(png|jpe?g|webp|gif|avif)(\?\S*)?$/i.test((s || '').trim()) || /^data:image\//.test((s || '').trim());
async function uploadImageUrl(planId, url) {
  return (await api('POST', '/api/file/url', { plan: planId, url })).path;
}
document.addEventListener('paste', e => {
  const f = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile())[0];
  if (!Paste.target) return;
  const txt = (e.clipboardData?.getData('text/plain') || '').trim();
  if (!f && isImgUrl(txt) && !/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) { e.preventDefault(); Paste.target(txt); return; }   // адрес картинки — тоже картинка
  if (!f) return;
  if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName) && txt) return;
  e.preventDefault();
  Paste.target(f);
});
// 🔎 поиск картинок не выходя из приложения: Google / Яндекс Картинки — окно «🔎 Картинки» (в окне-приложении; в браузере — всплывающее окно).
// Найденное перетаскивают в слот или «Копировать картинку» → Ctrl+V над слотом.
const ImgSearch = {
  open(q = '') {
    const inp = h('input.box', { value: q, placeholder: 'что ищем: «ЭЛТ монитор 2006», «бабушкин ковёр»…', style: { width: '100%' } });
    const go_ = eng => {
      const s = inp.value.trim(); if (!s) return inp.focus();
      const url = eng === 'ya' ? 'https://yandex.ru/images/search?text=' + encodeURIComponent(s) : 'https://www.google.com/search?udm=2&hl=ru&q=' + encodeURIComponent(s);
      window.open(url, 'imgsearch', `popup,width=760,height=900,left=${Math.max(0, screen.availWidth - 780)},top=40`);
      Local.set('imgq', s); close();
      UI.toast('🔎 Окно картинок открыто: перетащи картинку в слот (лучше — открыв её крупно) или «Копировать картинку» → Ctrl+V над слотом');
    };
    inp.onkeydown = e => { if (e.key === 'Enter') go_('g'); if (e.key === 'Escape') close(); };
    const box = h('div.imgsearch', h('b', '🔎 Найти картинку'), inp,
      h('div.row', h('button.primary', { onclick: () => go_('g') }, 'Google Картинки'), h('button', { onclick: () => go_('ya') }, 'Яндекс Картинки'), h('span.sp'), h('button', { onclick: () => close() }, 'Отмена')),
      h('p.dim.small', 'Откроется окно поиска рядом. Картинку оттуда перетащи в слот референса — или правой кнопкой «Копировать картинку» и Ctrl+V над слотом. Права на чужие картинки — у их авторов: это референсы, не кадры ролика.'));
    const ov = h('div.imgsearch-ov', { onclick: e => { if (e.target === ov) close(); } }, box);
    const close = () => ov.remove();
    document.body.append(ov); setTimeout(() => { inp.focus(); inp.select(); }, 30);
  },
};
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
function pickFile(cb) { const i = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onchange: () => i.files[0] && cb(i.files[0]) }); i.click(); }
const readAsDataURL = f => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
async function uploadImage(planId, fileOrDataURL) {
  const data = typeof fileOrDataURL === 'string' ? fileOrDataURL : await readAsDataURL(fileOrDataURL);
  return (await api('POST', '/api/file?plan=' + encodeURIComponent(planId), undefined, data)).path;
}
// picture slot bound to a path; onSet(path) is used when the item does not exist yet
function imgSlot({ key, path, planId, aspect = '16/9', label = '', onSet, small, compact, q }) {
  const src = (path && getPath(Store.get(key), path)) || '';
  const set = p => (onSet ? onSet(p) : Store.set(key, path, p, true));
  const upload = async f => {                              // файл / data: — как раньше; адрес картинки (из окна поиска) — качает локальное приложение
    try { set(typeof f === 'string' && !f.startsWith('data:') ? (UI.toast('⬇ беру картинку…'), await uploadImageUrl(planId, f)) : await uploadImage(planId, f)); }
    catch (e) { UI.toast(e.message, 'err'); }
  };
  const search = () => ImgSearch.open(q || Local.get('imgq') || '');
  const box = h('div.slot', { class: (src ? '' : 'empty') + (small ? ' small' : '') + (compact && !src ? ' compact' : ''), tabindex: 0,
    style: { aspectRatio: compact && !src ? 'auto' : aspect }, title: 'Ctrl+V — вставить картинку сюда' });
  if (src) box.append(h('img', { src: '/' + src, alt: '', onclick: () => UI.lightbox('/' + src) }),
    h('div.slot-acts', h('button.icon', { title: 'Дорисовать', onclick: e => { e.stopPropagation(); Sketch.open({ aspect, bg: '/' + src, planId, onSave: set }); } }, '✏️'),
      h('button.icon', { title: 'Убрать картинку', onclick: e => { e.stopPropagation(); set(''); } }, '×')));
  else if (compact) box.append(h('div.slot-empty.row', h('button.icon', { title: 'Файл с диска', onclick: () => pickFile(upload) }, '📎'),
    h('button.icon', { title: 'Найти в Google / Яндекс Картинках — окно рядом, картинку оттуда перетащи сюда', onclick: search }, '🔎'),
    h('button.icon', { title: 'Нарисовать эскиз', onclick: () => Sketch.open({ aspect, planId, onSave: set }) }, '✏️'), h('span', 'картинка: Ctrl+V')));
  else box.append(h('div.slot-empty', label && h('b', label), h('span', 'Ctrl+V · перетащи'),
    h('div.row', h('button.icon', { title: 'Файл с диска', onclick: () => pickFile(upload) }, '📎'),
      h('button.icon', { title: 'Найти в Google / Яндекс Картинках — окно рядом, картинку оттуда перетащи сюда', onclick: search }, '🔎'),
      h('button.icon', { title: 'Нарисовать эскиз', onclick: () => Sketch.open({ aspect, planId, onSave: set }) }, '✏️'))));
  box.addEventListener('mouseenter', () => (Paste.target = upload));
  box.addEventListener('mouseleave', () => { if (Paste.target === upload) Paste.target = null; });
  box.addEventListener('focus', () => (Paste.target = upload));
  box.addEventListener('dragover', e => { if (hasFiles(e) || hasImgUrl(e)) { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', e => {
    box.classList.remove('drop');
    const f = imageFiles(e.dataTransfer)[0], u = !f && dropImageUrl(e.dataTransfer);
    if (f || u) { e.preventDefault(); e.stopPropagation(); upload(f || u); }
  });
  return box;
}

// sketch pad: pen / eraser on a layer above an optional background picture; saved as a new PNG
const Sketch = {
  open({ aspect = '16/9', bg = '', planId, onSave }) {
    const [aw, ah] = aspect.split('/').map(Number);
    const W = aw >= ah ? 1280 : 720, H = Math.round(W * ah / aw);
    const cv = h('canvas', { width: W, height: H }), ctx = cv.getContext('2d');
    const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
    const lx = layer.getContext('2d');
    let strokes = [], cur = null, color = '#111111', size = 6, tool = 'pen', bgImg = null;   // tool: pen | fill | erase
    const comp = () => {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      if (bgImg) { const s = Math.min(W / bgImg.width, H / bgImg.height), w = bgImg.width * s, hh = bgImg.height * s; ctx.drawImage(bgImg, (W - w) / 2, (H - hh) / 2, w, hh); }
      ctx.drawImage(layer, 0, 0);
    };
    const seg = (s, a, b) => {
      lx.save(); lx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      lx.strokeStyle = s.color; lx.lineWidth = s.size; lx.lineCap = lx.lineJoin = 'round';
      lx.beginPath(); lx.moveTo(a[0], a[1]); lx.lineTo(b[0] + (a === b ? 0.1 : 0), b[1]); lx.stroke(); lx.restore();
    };
    // 🪣 flood fill of what is visible (background + drawing) from a point, painted into the drawing layer
    const fill = s => {
      comp();
      const img = ctx.getImageData(0, 0, W, H).data, x0 = Math.floor(s.x), y0 = Math.floor(s.y);
      if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;
      const i0 = (y0 * W + x0) * 4, r0 = img[i0], g0 = img[i0 + 1], b0 = img[i0 + 2], TOL = 60;
      const same = i => Math.abs(img[i] - r0) + Math.abs(img[i + 1] - g0) + Math.abs(img[i + 2] - b0) <= TOL;
      const mask = new Uint8Array(W * H), stack = [x0, y0];
      while (stack.length) {                                        // scanline flood fill
        const y = stack.pop(); let x = stack.pop();
        while (x > 0 && !mask[y * W + x - 1] && same((y * W + x - 1) * 4)) x--;
        let up = false, dn = false;
        for (; x < W && !mask[y * W + x] && same((y * W + x) * 4); x++) {
          mask[y * W + x] = 1;
          if (y > 0) { const u = !mask[(y - 1) * W + x] && same(((y - 1) * W + x) * 4); if (u && !up) stack.push(x, y - 1); up = u; }
          if (y < H - 1) { const d = !mask[(y + 1) * W + x] && same(((y + 1) * W + x) * 4); if (d && !dn) stack.push(x, y + 1); dn = d; }
        }
      }
      const out = lx.getImageData(0, 0, W, H), o = out.data;
      const cr = parseInt(s.color.slice(1, 3), 16), cg = parseInt(s.color.slice(3, 5), 16), cb = parseInt(s.color.slice(5, 7), 16);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {       // grow by 1 px so the fill tucks under anti-aliased line edges
        const k = y * W + x;
        if (!(mask[k] || (x > 0 && mask[k - 1]) || (x < W - 1 && mask[k + 1]) || (y > 0 && mask[k - W]) || (y < H - 1 && mask[k + W]))) continue;
        o[k * 4] = cr; o[k * 4 + 1] = cg; o[k * 4 + 2] = cb; o[k * 4 + 3] = 255;
      }
      lx.putImageData(out, 0, 0);
    };
    const redraw = () => {
      lx.clearRect(0, 0, W, H);
      for (const s of strokes) { if (s.fill) fill(s); else s.pts.forEach((p, i) => seg(s, s.pts[Math.max(0, i - 1)], p)); }
      comp();
    };
    const setBg = src => { const im = new Image(); im.onload = () => { bgImg = im; redraw(); }; im.src = src; };
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
    cv.onpointerdown = e => {
      const p = pos(e);
      if (tool === 'fill') { const s = { fill: true, color, x: p[0], y: p[1] }; strokes.push(s); fill(s); comp(); return; }
      cv.setPointerCapture(e.pointerId);
      const erase = tool === 'erase';
      cur = { color, size: erase ? size * 3 : size, erase, pts: [p] }; strokes.push(cur); seg(cur, p, p); comp();
    };
    cv.onpointermove = e => { if (!cur) return; const p = pos(e), a = cur.pts[cur.pts.length - 1]; cur.pts.push(p); seg(cur, a, p); comp(); };
    cv.onpointerup = cv.onpointercancel = () => (cur = null);
    const colors = ['#111111', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#ffffff'];
    const tools = h('div.tools');
    const paint = () => {
      tools.replaceChildren(
        h('button', { class: tool === 'pen' ? 'sel' : '', onclick: () => { tool = 'pen'; paint(); } }, '✏️ Кисть'),
        h('button', { class: tool === 'fill' ? 'sel' : '', title: 'Клик по замкнутой области — залить её цветом', onclick: () => { tool = 'fill'; paint(); } }, '🪣 Заливка'),
        h('button', { class: tool === 'erase' ? 'sel' : '', onclick: () => { tool = 'erase'; paint(); } }, '🧽 Ластик'),
        ...colors.map(c => h('button.sw', { class: tool !== 'erase' && c === color ? 'sel' : '', style: { background: c }, title: c,
          onclick: () => { color = c; if (tool === 'erase') tool = 'pen'; paint(); } })),
        h('input', { type: 'color', value: color, title: 'Свой цвет', style: { width: '34px', height: '28px', padding: '0', border: 'none', background: 'none' },
          onchange: e => { color = e.target.value; if (tool === 'erase') tool = 'pen'; paint(); } }),
        ...[3, 6, 12, 24].map(s => h('button', { class: s === size ? 'sel' : '', disabled: tool === 'fill', onclick: () => { size = s; paint(); } }, '● ' + s)),
        h('button', { onclick: () => { strokes.pop(); redraw(); } }, '↶ Отменить'),
        h('button', { onclick: () => { strokes = []; redraw(); } }, 'Очистить'),
        h('button', { title: 'Картинка-подложка (или Ctrl+V)', onclick: () => pickFile(async f => setBg(await readAsDataURL(f))) }, '🖼 Подложка'),
        h('span.sp'),
        h('button.primary', { onclick: async () => {
          try { const p = await uploadImage(planId, cv.toDataURL('image/png')); close(); onSave(p); } catch (e) { UI.toast(e.message, 'err'); }
        } }, '💾 Сохранить'));
    };
    paint();
    const prev = Paste.target;
    Paste.target = async f => setBg(await readAsDataURL(f));
    const close = UI.modal('Эскиз ' + aspect.replace('/', ':'), h('div.sketch', cv, tools,
      h('p.dim', 'Рисуй мышкой, пером или пальцем. Ctrl+V — подложить картинку-референс. Схематично — нормально: это макет, а не финал.')),
    { wide: true, onClose: () => (Paste.target = prev) });
    if (bg) setBg(bg); else comp();
  },
};

// ---------- @-links: in any text field of a plan type «@» and pick an element of the preproduction -> «@[Название]» ----------
// The same token is read by preprod.py (exports, prompts): @[Название] = the element with this name (case and «ё» do not matter).
const MENTION_RE = /@\[([^\]\n]{1,80})\]/g;
const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const Mention = {
  box: null, field: null, start: 0, list: [], sel: 0,
  plan() { return App.route.page === 'p' ? Store.get('plan:' + App.route.id) : null; },
  items(q) {
    const d = this.plan(), n = normName(q);
    const els = ((d && d.elements) || []).filter(e => e.status !== 'drop' && (e.name || '').trim() && (!n || normName(e.name).includes(n)));
    return els.sort((a, b) => normName(a.name).indexOf(n) - normName(b.name).indexOf(n)).slice(0, 8);
  },
  check(el) {
    if (!el || !/^(TEXTAREA|INPUT)$/.test(el.tagName) || el.type !== 'text' && el.tagName === 'INPUT' || !/^plan:/.test(el.dataset.key || '')) return this.close();
    const c = el.selectionStart, m = /(^|[\s(«"'—-])@([^@\n[\]]{0,30})$/.exec(el.value.slice(0, c));
    if (!m) return this.close();
    this.list = this.items(m[2]);
    if (!this.list.length) return this.close();
    this.field = el; this.start = c - m[2].length - 1; this.sel = Math.min(this.sel, this.list.length - 1); this.show();
  },
  // listbox pattern: focus stays in the field, the highlighted option is aria-activedescendant; ↑↓ move, Tab / Enter pick, Esc closes
  show() {
    const r = this.field.getBoundingClientRect(), below = r.bottom + 240 < innerHeight;
    if (!this.box) { this.box = h('div.mention#mention-list', { role: 'listbox', 'aria-label': 'Элементы препродакшена: стрелки — выбрать, Tab или Enter — вставить, Esc — закрыть' }); document.body.append(this.box); }
    Object.assign(this.box.style, { left: Math.min(r.left + 6, innerWidth - 330) + 'px', top: below ? r.bottom + 2 + 'px' : '', bottom: below ? '' : innerHeight - r.top + 2 + 'px' });
    const K = k => (REF.kinds || []).find(x => x.key === k) || {};
    this.box.replaceChildren(h('div.mh2', { 'aria-hidden': 'true' }, '@ — элемент препродакшена · ↑↓ · Tab — вставить · Esc'), ...this.list.map((e, i) => {
      const rs = e.renders || [], r0 = rs.find(x => x.id === e.render) || rs[rs.length - 1], pic = r0 ? r0.img : ((e.refs || []).find(f => f.img) || {}).img;
      return h('div.mi', { id: 'mention-opt-' + i, role: 'option', 'aria-selected': i === this.sel ? 'true' : 'false', class: i === this.sel ? 'on' : '',
        onmouseenter: () => { if (this.sel !== i) { this.sel = i; this.show(); } }, onmousedown: ev => { ev.preventDefault(); this.pick(e); } },
        pic ? h('img', { src: '/' + pic, alt: '' }) : h('span.mico', { 'aria-hidden': 'true' }, K(e.kind).icon || '•'), h('span.grow', e.name),
        h('small.dim', (K(e.kind).one || '') + (e.status === 'ok' ? ' ✓ утверждён' : '')));
    }));
    const f = this.field;
    f.setAttribute('aria-autocomplete', 'list'); f.setAttribute('aria-controls', 'mention-list'); f.setAttribute('aria-expanded', 'true');
    f.setAttribute('aria-activedescendant', 'mention-opt-' + this.sel);
    const on = this.box.querySelector('.mi.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  },
  pick(e) {
    const el = this.field, v = el.value, c = el.selectionStart, ins = '@[' + e.name + '] ';
    el.value = v.slice(0, this.start) + ins + v.slice(c);
    const p = this.start + ins.length;
    el.setSelectionRange(p, p);
    this.close();
    el.dispatchEvent(new Event('input', { bubbles: true }));      // the field's own handler saves it
    el.focus();
    App.render();                                                // links shown elsewhere (scene cast, «Отмечено через @») update at once; focus and caret survive
  },
  // App.render replaces the field with a new one (same data-key) — e.g. when a Claude job finishes while the list is open: follow it
  rebind() {
    if (!this.box || !this.field || this.field.isConnected) return;
    const k = this.field.dataset.key, n = k && document.querySelector(`[data-key="${CSS.escape(k)}"]`);
    if (n) { this.field = n; this.show(); } else this.close();
  },
  close() {
    if (this.field) { this.field.setAttribute('aria-expanded', 'false'); this.field.removeAttribute('aria-activedescendant'); }
    if (this.box) this.box.remove();
    this.box = null; this.field = null; this.sel = 0;
  },
};
document.addEventListener('input', e => Mention.check(e.target));
document.addEventListener('keydown', e => {                      // capture: Tab / Enter pick instead of moving focus or submitting an «add» line
  if (!Mention.box) return;
  Mention.rebind();
  if (!Mention.box || e.isComposing) return;
  if (e.target !== Mention.field) {                               // the same field re-created by a render: take it over
    if (!e.target.dataset || e.target.dataset.key !== Mention.field.dataset.key) return;
    Mention.field = e.target;
  }
  const n = Mention.list.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { Mention.sel = (Mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; Mention.show(); }
  else if (e.key === 'PageDown' || e.key === 'PageUp') { Mention.sel = e.key === 'PageDown' ? n - 1 : 0; Mention.show(); }
  else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') Mention.pick(Mention.list[Mention.sel]);
  else if (e.key === 'Escape') Mention.close();
  else return;                                                   // Shift+Tab leaves the field as usual
  e.preventDefault(); e.stopPropagation();
}, true);
document.addEventListener('focusout', e => { if (e.target === Mention.field) setTimeout(() => { if (document.activeElement !== Mention.field) Mention.close(); }, 120); });
// elements named in a text by @[…]
function mentionsIn(text, d) {
  const els = (d && d.elements) || [], out = [];
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const n = normName(m[1]);
    for (const e of els) if (normName(e.name) === n && !out.includes(e)) out.push(e);
  }
  return out;
}

// ---------- routing ----------
function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { page: p[0] || 'home', id: p[1] || '', tab: p[2] || '', sub: p[3] || '', sub2: p[4] || '' };
}
const defTab = flow => (flow === 'idea' ? 'idea' : 'ideas');       // first tab of a plan: «Идея» in the new path, «Идеи» in the brainstorm
const go = hash => { location.hash = hash; };
