// Claude Studio — app shell: boot, routing, rendering with focus kept across re-renders.
'use strict';

const App = {
  info: {}, plans: [], planSig: null, route: route(),

  async boot() {
    try {
      Object.assign(REF, await (await fetch('/ref.json')).json());
      await this.refreshState();
    } catch (e) { this.banner('⚠ Не удалось загрузить Claude Studio: ' + e.message + '. Запусти «Claude Studio.bat».'); return; }
    Claude.on = !!this.info.claude;
    if (this.info.api !== API) this.banner('⚠ Локальный скрипт Studio старой версии. Закрой его окно и запусти «Claude Studio.bat» заново.');
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
    const need = { p: ['plan:' + r.id] }[r.page] || [];
    try { await Promise.all(need.map(k => Store.load(k))); }
    catch (e) {
      if (r.page === 'p' && !Store.get('plan:' + r.id)) { UI.toast('Такого штурма нет — возможно, его удалили', 'err'); go('#/'); return; }
      UI.toast(e.message, 'err');
    }
    this.render({ top: true });
    StageEditor.follow(r);
    MontagePreview.follow(r);                          // 🎞 предпросмотр монтажа — своё окно поверх страницы (S6)
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
    MontagePreview.follow(this.route);
    Sync.dirty();
  },

  page() {
    const r = this.route, wait = h('div.empty', 'Загружаю…');
    if (r.page === 'p') {
      const d = Store.get('plan:' + r.id);
      document.title = d ? `${d.name} — Claude Studio` : 'Claude Studio';
      return d ? Plan.view(d, r.tab || defTab(d.flow), r.sub) : wait;
    }
    document.title = 'Claude Studio';
    if (r.page === 'lib') return r.id === 'char' && r.tab ? CharSheet.view(r.tab) : Pages.lib();
    if (r.page === 'style') return Pages.style();
    if (r.page === 'help') return Pages.help();
    return Pages.home();
  },
};

// 🎬 the scene editor (S1 Claude Studio) — full screen over the page at #/p/<plan>/pre/<element>/stage.
// It lives in an iframe outside #main (page re-renders must not reload it); Esc / «← Препродакшен» inside it come back here.
const StageEditor = {
  el: null, frame: null,
  follow(r) {
    const want = r.page === 'p' && r.tab === 'pre' && r.sub && r.sub2 === 'stage' ? `${r.id}/${r.sub}` : null;
    if (want === this.el) return;
    this.close();
    if (!want) return;
    this.el = want;
    const src = `/tpl/editor.html?key=${encodeURIComponent('plan:' + r.id)}&el=${encodeURIComponent(r.sub)}`;
    this.frame = h('div.stage-editor', h('iframe', { src, title: 'Оформление сцены', allow: 'fullscreen' }));
    document.body.append(this.frame);
    requestAnimationFrame(() => { const f = this.frame && this.frame.querySelector('iframe'); if (f) f.focus(); });
  },
  close() { if (this.frame) this.frame.remove(); this.frame = null; this.el = null; },
};
addEventListener('message', ev => {
  if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'editor-close') return;
  const r = App.route;
  go(`#/p/${r.id}/pre/${r.sub}`);
  Store.load('plan:' + r.id).then(() => App.render()).catch(() => {});
});

App.boot();
