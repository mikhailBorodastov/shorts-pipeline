// Claude Studio — app shell: boot, routing, rendering with focus kept across re-renders.
'use strict';

const App = {
  info: {}, plans: [], planSig: null, route: route(), scrolls: new Map(), lastHash: null,

  async boot() {
    AgentPanel.init();                                 // 💬 панель агента справа (S7)
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
    return this.route.page === 'home' || this.route.page === 'videos' ? JSON.stringify(this.plans) : this.plans.map(p => [p.id, p.name, p.status, p.mode].join('|')).join(',');
  },

  async navigate() {
    // прокрутка каждой страницы запоминается по адресу: вернулся в список препродакшена из элемента — стоишь там же, где заходил
    if (this.lastHash != null) { this.scrolls.set(this.lastHash, ScrollKeep.save($('#main'))); if (this.scrolls.size > 60) this.scrolls.delete(this.scrolls.keys().next().value); }
    this.lastHash = location.hash;
    this.route = route();
    const r = this.route;
    Shell.remember(r);                                 // «Редактор» в боковой панели — последнее открытое видео
    if (r.page === 'p') { go(this.oldRoute(r)); return; }   // S12.11: старые вкладки видео (#/p/<id>/<этап>) — окно видео и его панели
    if (r.page !== 'v') Workspace.leave();
    document.body.classList.toggle('ws-mode', r.page === 'v');
    const need = r.page === 'v' ? ['plan:' + r.id] : [];
    try { await Promise.all(need.map(k => Store.load(k))); }
    catch (e) {
      if (r.page === 'v' && !Store.get('plan:' + r.id)) { UI.toast('Такого видео нет — возможно, его убрали в архив', 'err'); go('#/'); return; }
      UI.toast(e.message, 'err');
    }
    this.render({ top: true });
    const back = this.scrolls.get(location.hash);
    if (back) ScrollKeep.restore($('#main'), back);
    StageEditor.follow(r);
    MontagePreview.follow(r);                          // 🎞 предпросмотр монтажа — своё окно поверх страницы (S6)
    AgentPanel.follow(r);
  },

  // #/p/<id>/<этап> из старых ссылок, уведомлений и заметок -> окно видео: этап -> панель
  oldRoute(r) {
    if (!App.plans.some(p => p.id === r.id)) return '#/lib';          // служебное видео (мастерская) — их больше нет в интерфейсе
    const tab = { idea: 'brief', qa: 'brief', title: 'brief', ideas: 'brief', beats: 'brief', images: 'brief', structure: 'brief',
      voice: 'voice', pack: 'pack', results: 'pack', pre: 'pre', scenes: 'pre' }[r.tab] || '';
    if (r.tab === 'script') setTimeout(() => { const d = Store.get('plan:' + r.id); if (d && typeof ScriptWin !== 'undefined') ScriptWin.open(d); }, 600);
    if (r.tab === 'thumbs') return '#/thumbs/' + r.id;
    return `#/v/${r.id}` + (tab ? '/' + tab : '') + (tab === 'pre' && r.sub ? '/' + r.sub + (r.sub2 ? '/' + r.sub2 : '') : '');
  },

  banner(msg) { const b = $('#banner'); b.textContent = msg; b.classList.toggle('show', !!msg); },

  resume() {
    if (typeof Workspace !== 'undefined' && Workspace.holding()) return;
    if (this.deferred) this.render();
    else if (typeof Montage !== 'undefined' && Montage.redrawPending) Montage.redraw();
  },
  render(opts = {}) {
    // окно видео: пока открыта карточка правки или тянется правка на таймлайне — не перестраиваем страницу (опрос раз в 2 с, работа Claude),
    // иначе таймлайн мигает и перетаскивание слетает; отложенное догоняет App.resume() после действия
    if (!opts.top && !opts.force && this.route.page === 'v' && typeof Workspace !== 'undefined' && Workspace.holding && Workspace.holding()) { this.deferred = true; return; }
    this.deferred = false;
    if (this.route.page === 'v' && !document.hidden) Unread.seen(this.route.id, this.route.tab || 'montage');
    const a = document.activeElement, fk = a && a.dataset ? a.dataset.key : null;
    const range = fk && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    const main = $('#main');
    const playing = $$('audio').filter(x => !x.paused).map(x => [x.getAttribute('src'), x.currentTime]);   // a re-render must not cut a sound you listen to
    let page;
    try { page = this.page(); } catch (e) { console.error(e); page = h('div.card.empty', '⚠ Ошибка отрисовки: ' + e.message); }
    // keepScroll: прокрутка #main И внутренних панелей (бриф, препродакшен, списки, поля) переживает перерисовку — раньше прыгала наверх
    if (opts.top) $('#view').replaceChildren(page); else keepScroll(main, () => $('#view').replaceChildren(page));   // переход — с начала новой страницы
    keepScroll($('#side'), () => $('#side').replaceChildren(...[Shell.side()].flat(Infinity).filter(x => x instanceof Node)));   // S12: новая боковая панель (ui/shell.js)
    NewVideo.refresh();                               // поп-ап «Новое видео» (шаг 2: вопросы Claude) — до восстановления фокуса
    if (typeof ScriptWin !== 'undefined') ScriptWin.refresh();        // S16: окно «Сценарий» — вкладка «📐 Карта подачи» (задача Claude закончилась)
    this.shown = this.shownSig();
    if (opts.top) main.scrollTop = 0;
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
    AgentPanel.follow(this.route);
    if (this.route.page === 'v') requestAnimationFrame(() => Workspace.fit());
    if (this.route.page === 'thumbs') Thumbs.mount();     // канвас обложек рисуется своим кодом
    Sync.dirty();
  },

  page() {
    const r = this.route, wait = h('div.empty', 'Загружаю…');
    if (r.page === 'v') {                              // S12.3: рабочее окно видео (ui/workspace.js)
      const d = Store.get('plan:' + r.id);
      document.title = d ? `${d.name} — Claude Studio` : 'Claude Studio';
      return d ? Workspace.page(d) : wait;
    }
    document.title = 'Claude Studio';
    if (r.page === 'lib') return r.id === 'item' && r.tab && r.sub ? LibItem.view(r.tab, r.sub) : Pages.lib();
    if (r.page === 'style') return Pages.style();
    if (r.page === 'newchan') return Pages.newChannel();
    if (r.page === 'settings') return Pages.settings();
    if (r.page === 'help') return Pages.help();
    const soon = Shell.page(r);                        // S12: Память, Обложки, Рендеры — разделы следующих частей
    if (soon) return soon;
    return Videos.page();                              // S12.2: «Видео» — сетка карточек (ui/videos.js)
  },
};

// 🎬 the scene editor (S1 Claude Studio) — full screen over the page at #/p/<plan>/pre/<element>/stage.
// It lives in an iframe outside #main (page re-renders must not reload it); Esc / «← Препродакшен» inside it come back here.
const StageEditor = {
  el: null, frame: null,
  follow(r) {
    const want = r.page === 'v' && r.tab === 'pre' && r.sub && r.sub2 === 'stage' ? `${r.id}/${r.sub}` : null;
    if (want === this.el) return;
    this.close();
    if (!want) return;
    this.el = want;
    const dd = Store.get('plan:' + r.id) || {};
    const src = `/tpl/editor.html?key=${encodeURIComponent('plan:' + r.id)}&el=${encodeURIComponent(r.sub)}` + (dd.mode === 'long' ? '&fmt=long' : '');   // длинное видео — кадр 16:9
    this.frame = h('div.stage-editor', h('iframe', { src, title: 'Оформление сцены', allow: 'fullscreen' }));
    document.body.append(this.frame);
    requestAnimationFrame(() => { const f = this.frame && this.frame.querySelector('iframe'); if (f) f.focus(); });
  },
  close() { if (this.frame) this.frame.remove(); this.frame = null; this.el = null; },
  // 🎞 из монтажа (S11): обычная правка сцены в моменте; закрыл — назад в монтаж, он пересобирается сам
  openScene(vid, el, ts) {
    this.close();
    this.el = `mt:${vid}/${el}`;
    const src = `/tpl/editor.html?key=${encodeURIComponent('plan:' + vid)}&el=${encodeURIComponent(el)}&t=${(+ts || 0).toFixed(2)}&back=montage` + ((Store.get('plan:' + vid) || {}).mode === 'long' ? '&fmt=long' : '');
    this.frame = h('div.stage-editor', h('iframe', { src, title: 'Оформление сцены', allow: 'fullscreen' }));
    document.body.append(this.frame);
    requestAnimationFrame(() => { const f = this.frame && this.frame.querySelector('iframe'); if (f) f.focus(); });
  },
  // ✋ правка в кадре из ревью (S8): сцена в моменте кадра; правки уходят пометкой (fixes[] видео), страница остаётся на «Ревью»
  openFix(vid, el, ts, vt) {
    this.close();
    this.el = `fix:${vid}/${el}`;
    const src = `/tpl/editor.html?key=${encodeURIComponent('plan:' + vid)}&el=${encodeURIComponent(el)}&fix=1&t=${ts}&vt=${vt}` + ((Store.get('plan:' + vid) || {}).mode === 'long' ? '&fmt=long' : '');
    this.frame = h('div.stage-editor', h('iframe', { src, title: 'Правка в кадре', allow: 'fullscreen' }));
    document.body.append(this.frame);
  },
};
addEventListener('message', ev => {
  if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'editor-close') return;
  const r = App.route;
  if (ev.data.back === 'montage') {                   // S11: из монтажа — назад, ролик пересобирается под новую сцену
    StageEditor.close();
    if (window.Montage && Montage.afterEdit) Montage.afterEdit(r.id, ev.data.el);
    return;
  }
  if (ev.data.back === 'review') {                    // из «✋ правки в кадре»: назад в ревью, пометка — в списке над ним
    StageEditor.close();
    if (ev.data.fix) UI.toast('✋ Пометка сохранена — «🔨 Пересобрать с правками», когда соберёшь все');
    Store.load('plan:' + r.id, true).then(() => App.render()).catch(() => {});
    return;
  }
  go(`#/v/${r.id}/pre/${r.sub}`);
  Store.load('plan:' + r.id).then(() => App.render()).catch(() => {});
});

App.boot();
