// «Штурм идей» — app shell: boot, routing, rendering with focus kept across re-renders.
'use strict';

const App = {
  info: {}, plans: [], planSig: null, route: route(),

  async boot() {
    try {
      Object.assign(REF, await (await fetch('/ref.json')).json());
      await this.refreshState();
    } catch (e) { this.banner('⚠ Не удалось загрузить «Штурм»: ' + e.message + '. Запусти «Штурм идей.bat».'); return; }
    Claude.on = !!this.info.claude;
    if (this.info.api !== API) this.banner('⚠ Скрипт «Штурма» старой версии. Закрой его окно и запусти «Штурм идей.bat» заново.');
    window.addEventListener('hashchange', () => this.navigate());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.render(); });   // back to the tab: clear what you now see
    window.addEventListener('beforeunload', e => { if (Store.busy()) { Store.flushAll(); e.preventDefault(); e.returnValue = ''; } });
    await this.navigate();
    Sync.start();
  },

  async refreshState() {
    const s = await api('GET', '/api/state');
    this.info = s; this.plans = s.plans || [];
  },

  // the sidebar and the dashboard show plan summaries: refresh them when any plan file changes,
  // re-render only if what they show changed (our own autosaves bump revs too)
  async plansChanged(docs) {
    const sig = Object.keys(docs).filter(k => k.startsWith('plan:')).sort().map(k => k + '=' + docs[k]).join(',');
    if (this.planSig === null) { this.planSig = sig; return false; }
    if (sig !== this.planSig) {
      this.planSig = sig;
      try { await this.refreshState(); } catch { return false; }
    }
    return this.shownSig() !== this.shown;            // compare with what is on screen now
  },
  shownSig() {
    return this.route.page === 'home' ? JSON.stringify(this.plans) : this.plans.map(p => [p.id, p.name, p.status, p.mode].join('|')).join(',');
  },

  async navigate() {
    this.route = route();
    const r = this.route;
    const need = { home: ['bank', 'stats'], bank: ['bank'], brand: ['brand'], stats: ['stats'], p: ['plan:' + r.id, 'bank', 'stats', 'brand'] }[r.page] || [];
    try { await Promise.all(need.map(k => Store.load(k))); }
    catch (e) {
      if (r.page === 'p' && !Store.get('plan:' + r.id)) { UI.toast('Такого штурма нет — возможно, его удалили', 'err'); go('#/'); return; }
      UI.toast(e.message, 'err');
    }
    this.render({ top: true });
  },

  banner(msg) { const b = $('#banner'); b.textContent = msg; b.classList.toggle('show', !!msg); },

  render(opts = {}) {
    if (this.route.page === 'p' && !document.hidden) { const d = Store.get('plan:' + this.route.id); Unread.seen(this.route.id, this.route.tab || defTab(d && d.flow)); }
    const a = document.activeElement, fk = a && a.dataset ? a.dataset.key : null;
    const range = fk && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    const main = $('#main'), top = main.scrollTop;
    const playing = $$('audio').filter(x => !x.paused).map(x => [x.getAttribute('src'), x.currentTime]);   // a re-render must not cut a sound you listen to
    let page;
    try { page = this.page(); } catch (e) { console.error(e); page = h('div.card.empty', '⚠ Ошибка отрисовки: ' + e.message); }
    $('#view').replaceChildren(page);
    $('#side').replaceChildren(...[Pages.side()].flat(Infinity).filter(x => x instanceof Node));
    this.shown = this.shownSig();
    main.scrollTop = opts.top ? 0 : top;
    if (fk) {
      const e = document.querySelector(`[data-key="${CSS.escape(fk)}"]`);
      if (e && e !== document.activeElement) { e.focus({ preventScroll: true }); if (range && e.setSelectionRange) try { e.setSelectionRange(range[0], range[1]); } catch {} }
    }
    const n = this.focusName && $('input.name');
    if (n) { this.focusName = false; n.focus(); n.select(); }
    Mention.rebind();                                 // an open @-list follows its field into the new DOM
    if (this.focusKey) {                              // e.g. a pin just dropped on a picture: type its text right away
      const e = document.querySelector(`[data-key="${CSS.escape(this.focusKey)}"]`);
      this.focusKey = null;
      if (e) e.focus({ preventScroll: true });
    }
    for (const [src, t] of playing) { const x = $$('audio').find(y => y.getAttribute('src') === src); if (x) { x.currentTime = t; x.play().catch(() => {}); } }
    requestAnimationFrame(() => $$('textarea.auto').forEach(autosize));
    Sync.dirty();
  },

  page() {
    const r = this.route, wait = h('div.empty', 'Загружаю…');
    if (r.page === 'p') {
      const d = Store.get('plan:' + r.id);
      document.title = d ? `${d.name} — Штурм идей` : 'Штурм идей';
      return d ? Plan.view(d, r.tab || defTab(d.flow), r.sub) : wait;
    }
    document.title = 'Штурм идей';
    if (r.page === 'bank') return Store.get('bank') ? Pages.bank() : wait;
    if (r.page === 'brand') return Store.get('brand') ? Pages.brand() : wait;
    if (r.page === 'stats') return Store.get('stats') ? Pages.stats() : wait;
    if (r.page === 'help') return Pages.help();
    return Pages.home();
  },
};

App.boot();
