// S20.5 — лента уведомлений 🔔 (docs/studio/stage20-agent-everywhere.md): что Claude и Studio сделали тут и там.
// Сервер: server/notify_api.py (.studio/notify/<канал>.jsonl). Счётчик приходит с /api/revs (Sync.tick -> Bell.update), лента — GET /api/notify.
// Клик по уведомлению: прочитано, переход на вкладку и элемент (подсветка 2 с); вопрос Claude — ещё и открыть чат.
'use strict';

const Bell = {
  items: [], unread: 0, last: -1, open: false, filter: 'all', el: null, loading: false,
  KIND: { job: ['checkcircle', 'ok'], ask: ['help', 'ask'], error: ['alert', 'bad'], render: ['film', 'ren'], thumb: ['image', 'thumb'], yt: ['chart', 'yt'] },

  update(n) {                                              // из Sync.tick: {unread, last}
    if (!n) return;
    const changed = n.unread !== this.unread;
    this.unread = n.unread;
    if (n.last !== this.last) { const first = this.last === -1; this.last = n.last; if (this.open || !first) this.load(); }
    if (changed) this.badge();
  },
  async load() {
    if (this.loading) return;
    this.loading = true;
    try { const r = await api('GET', '/api/notify'); this.items = r.items || []; this.unread = r.unread || 0; this.badge(); if (this.open) this.draw(); }
    catch (e) {} finally { this.loading = false; }
  },
  badge() {
    for (const b of $$('.bell-cnt')) { b.textContent = this.unread > 99 ? '99+' : String(this.unread || ''); b.hidden = !this.unread; }
  },
  // пункт сайдбара (shell.js)
  navItem() {
    return h('a.nav.bell-nav', { href: 'javascript:void 0', class: this.open ? 'on' : '', title: 'Уведомления: что Claude сделал тут и там',
      onclick: ev => { ev.preventDefault(); this.toggle(); } },
      Icon('bell', 17), h('span.lbl', 'Уведомления'), h('span.bell-cnt', { hidden: !this.unread }, this.unread > 99 ? '99+' : String(this.unread || '')));
  },
  toggle(on) {
    this.open = on == null ? !this.open : on;
    if (this.open) { this.load(); this.draw(); } else if (this.el) { this.el.remove(); this.el = null; }
    $$('.bell-nav').forEach(a => a.classList.toggle('on', this.open));
  },
  vid() { const r = App.route; return (r.page === 'v' || r.page === 'p') ? r.id : null; },
  when(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'сейчас';
    if (s < 3600) return Math.round(s / 60) + ' мин';
    if (s < 86400) return Math.round(s / 3600) + ' ч';
    if (s < 172800) return 'вчера';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  },
  draw() {
    if (!this.open) return;
    if (!this.el) {
      this.el = h('div#bellpanel', { role: 'dialog', 'aria-label': 'Уведомления' });
      document.body.append(this.el);
      setTimeout(() => {
        const out = e => { if (this.el && !this.el.contains(e.target) && !e.target.closest('.bell-nav')) { this.toggle(false); removeEventListener('pointerdown', out, true); removeEventListener('keydown', esc, true); } };
        const esc = e => { if (e.key === 'Escape') { this.toggle(false); removeEventListener('pointerdown', out, true); removeEventListener('keydown', esc, true); } };
        addEventListener('pointerdown', out, true); addEventListener('keydown', esc, true);
      }, 0);
    }
    const vid = this.vid(), list = this.items.filter(x => this.filter === 'all' || !vid || x.video === vid);
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const today = list.filter(x => x.ts >= +day), older = list.filter(x => x.ts < +day);
    const row = x => {
      const [ic, cls] = this.KIND[x.kind] || ['spark', 'ok'];
      return h('div.bell-it', { class: x.read ? '' : 'new', title: x.text || '', onclick: () => this.go(x) },
        h('span.bell-k', { class: cls }, Icon(ic, 15)),
        h('div.grow', h('b', x.title), h('div.dim.small.clamp2', [x.videoName, x.text].filter(Boolean).join(' · '))),
        h('span.bell-t', this.when(x.ts)),
        h('button.bell-x', { title: 'Убрать', 'aria-label': 'Убрать уведомление', onclick: ev => { ev.stopPropagation(); this.clear([x]); } }, Icon('x', 13)));
    };
    this.el.replaceChildren(
      h('div.bell-h',
        h('div.bell-row', h('b', 'Уведомления'), h('span.sp'),
          this.unread > 0 && h('button.link.small', { onclick: () => this.readAll() }, 'Прочитать все'),
          list.length > 0 && h('button.link.small', { title: this.filter === 'video' && vid ? 'Убрать уведомления этого видео' : 'Убрать все уведомления',
            onclick: () => this.clear(null, this.filter === 'video' && vid ? vid : null) }, 'Очистить')),
        vid && h('div.seg.small.bell-seg', [['all', 'Все'], ['video', 'Это видео']].map(([k, l]) => h('button', { class: this.filter === k ? 'sel' : '', onclick: () => { this.filter = k; this.draw(); } }, l)))),
      h('div.bell-list',
        !list.length && h('p.dim.small.bell-empty', 'Пока пусто. Здесь будет всё, что сделал Claude: черновики, 3D, звуки, обложки, рендеры, вопросы к вам.'),
        today.length > 0 && [h('div.bell-g', 'Сегодня'), today.map(row)],
        older.length > 0 && [h('div.bell-g', 'Раньше'), older.map(row)]));
  },
  async go(x) {
    if (!x.read) {
      x.read = true; this.unread = Math.max(0, this.unread - 1); this.badge();
      api('POST', '/api/notify/read', { ids: [x.id] }).catch(() => {});
    }
    this.toggle(false);
    if (x.route && location.hash !== x.route) go(x.route);
    if (x.kind === 'ask' || /^Claude в чате/.test(x.title)) setTimeout(() => AgentPanel.toggle(true), 300);
    setTimeout(() => this.flash(x), 700);
  },
  flash(x) {                                               // подсветить то, о чём уведомление: карточку элемента / доску / страницу
    const t = (x.el && $('.elwork')) || $('.tb-canvas, .tb-wrap') || (x.kind === 'render' && $('.rd-list, .page')) || null;
    if (!t) return;
    t.classList.remove('bell-flash'); void t.offsetWidth; t.classList.add('bell-flash');
    setTimeout(() => t.classList.remove('bell-flash'), 2200);
  },
  async clear(items, video) {                              // убрать из ленты: пункты / всё видео / всё
    const body = items ? { ids: items.map(x => x.id) } : video ? { video } : {};
    const gone = items ? new Set(items.map(x => x.id)) : null;
    const keep = this.items.filter(x => gone ? !gone.has(x.id) : video ? x.video !== video : false);
    this.unread = Math.max(0, this.unread - this.items.filter(x => !x.read && !keep.includes(x)).length);
    this.items = keep; this.badge(); this.draw();
    try { const r = await api('POST', '/api/notify/clear', body); this.unread = r.unread || 0; this.badge(); }
    catch (e) { UI.toast(e.message, 'err'); this.load(); }
  },
  async readAll() {
    try { const r = await api('POST', '/api/notify/read', { all: true }); this.unread = r.unread || 0; this.items.forEach(x => (x.read = true)); this.badge(); this.draw(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
};
window.Bell = Bell;
