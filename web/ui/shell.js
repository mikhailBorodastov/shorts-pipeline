// Claude Studio — оболочка S12 (docs/studio/stage12-redesign.md §2): боковая панель, Ctrl K (поиск и команды), разделы-заглушки.
// Старые экраны рисуются в #view как раньше; эта часть меняет только то, что вокруг них.
'use strict';

const Shell = {
  mini: Local.get('side-mini') === '1',

  // ---------------- боковая панель ----------------
  side() {
    const r = App.route, C = App.info.channel || {}, cs = App.info.channels || [];
    document.body.classList.toggle('side-mini', this.mini);
    const last = this.lastVideo();
    const item = (href, icon, label, on, extra) => h('a.nav', { href, class: on ? 'on' : '', title: label }, Icon(icon, 17), h('span.lbl', label), extra || null);
    const agentBusy = window.AgentPanel && AgentPanel.busy && last && AgentPanel.vid === last.id;
    return [
      h('div.side-top',
        h('a.logo', { href: '#/' }, h('span.l1', 'Claude'), h('span.l2', 'Studio')),
        h('button.icon.side-fold', { title: this.mini ? 'Развернуть панель' : 'Свернуть панель', onclick: () => this.fold() }, Icon('panel', 16))),
      cs.length > 0 && h('label.side-chan', { title: 'Канал: у каждого свой стиль, библиотека и видео' },
        sel([...cs.map(c => ({ value: c.id, label: `${c.icon || '📺'} ${c.name}` })), { value: '__new', label: '+ новый канал…' }], C.id,
          v => v === '__new' ? go('#/newchan') : Pages.useChannel(v), { class: 'box', 'aria-label': 'Канал' })),
      h('button.side-search', { onclick: () => Palette.open(), title: 'Поиск по каналу и команды (Ctrl K)' },
        Icon('search', 15), h('span.lbl.ss-t', 'Поиск или команда…'), h('kbd.lbl', 'Ctrl K')),
      h('nav.side-nav',
        item('#/lib', 'library', 'Библиотека', r.page === 'lib'),
        item('#/videos', 'grid', 'Видео', r.page === 'home' || r.page === 'videos', h('span.cnt.lbl', String(App.plans.filter(p => p.status !== 'archived').length || ''))),
        last ? item(`#/v/${last.id}`, 'clapper', 'Редактор', r.page === 'p' || r.page === 'v', agentBusy ? h('span.live', { title: 'Claude работает' }) : null)
          : h('span.nav.off', { title: 'Откройте видео — здесь будет последнее открытое' }, Icon('clapper', 17), h('span.lbl', 'Редактор'))),
      h('div.side-sec.lbl', 'Студия'),
      h('nav.side-nav',
        item('#/style', 'sliders', 'Стиль', r.page === 'style'),
        item('#/memory', 'bulb', 'Память', r.page === 'memory'),
        item('#/thumbs', 'image', 'Обложки', r.page === 'thumbs'),
        item('#/renders', 'film', 'Рендеры', r.page === 'renders')),
      h('div.side-foot',
        h('nav.side-nav',
          item('#/settings', 'settings', 'Настройки', r.page === 'settings'),
          item('#/help', 'book', 'Справочник', r.page === 'help')),
        h('div.side-status.lbl',
          h('span#saved', 'всё сохранено'),
          !App.info.claude && h('span.warn-small', 'Claude Code не найден — кнопки ✨ выключены'),
          App.info.legacy && h('span.warn-small', 'Переезд ещё не сделан: данные в _ideas'))),
    ];
  },
  fold() { this.mini = !this.mini; Local.set('side-mini', this.mini ? '1' : '0'); App.render(); },

  // «Редактор» — последнее открытое видео (если его не удалили)
  remember(r) { if ((r.page === 'p' || r.page === 'v') && r.id) Local.set('last-video', r.id); },
  lastVideo() {
    const id = Local.get('last-video');
    return id && App.plans.find(p => p.id === id && p.status !== 'archived') || null;
  },

  // ---------------- разделы, которые появятся в следующих частях ----------------
  soon(icon, title, text, part) {
    return h('div.page',
      h('div.page-head', h('h1', title)),
      h('div.empty-state', h('div.es-ico', Icon(icon, 26)), h('b', title + ' — скоро'), h('p', text), h('span.dim.small', 'S12, часть ' + part)));
  },
  page(r) {
    if (r.page === 'memory') return this.soon('bulb', 'Память', 'Правила, которые Claude выносит из твоих правок. Ты подтверждаешь — и он помнит их во всех следующих видео канала.', '12.10');
    if (r.page === 'thumbs') return this.soon('image', 'Обложки', 'Доска для обложек: картинки, промпты и генерации (Higgsfield), «Сделать обложкой». Можно работать, пока идёт монтаж.', '12.9');
    if (r.page === 'renders') return this.soon('film', 'Рендеры', 'Очередь рендера и все готовые ролики канала: посмотреть, открыть папку, .srt.', '12.8');
    return null;
  },
};

// ---------------- Ctrl K: поиск по каналу и команды ----------------
const Palette = {
  el: null, q: '', i: 0, items: [],
  norm: s => String(s || '').toLowerCase().replace(/ё/g, 'е'),

  all() {
    const r = [], C = App.info.channel || {};
    const nav = (label, href, icon, kw = '') => r.push({ group: 'Разделы', label, icon, kw, run: () => go(href) });
    nav('Видео', '#/videos', 'grid', 'проекты ролики главная');
    nav('Библиотека', '#/lib', 'library', 'ассеты персонажи пропсы звуки');
    const last = Shell.lastVideo();
    if (last) nav('Редактор — ' + last.name, `#/v/${last.id}`, 'clapper', 'активное видео');
    nav('Стиль канала', '#/style', 'sliders', 'гайд палитра голос субтитры герой');
    nav('Память', '#/memory', 'bulb', 'правила');
    nav('Обложки', '#/thumbs', 'image', 'тамбнейл thumbnail');
    nav('Рендеры', '#/renders', 'film', 'экспорт mp4');
    nav('Настройки', '#/settings', 'settings', 'ключи модели');
    nav('Справочник', '#/help', 'book', 'карта превью');
    const cmd = (label, icon, run, kw = '') => r.push({ group: 'Команды', label, icon, kw, run });
    cmd('Новое видео', 'plus', () => NewVideo.open(), 'создать short long шортс длинное');
    for (const c of App.info.channels || []) if (c.id !== C.id) cmd('Канал: ' + c.name, 'tv', () => Pages.useChannel(c.id), 'переключить сменить');
    cmd('Новый канал…', 'tv', () => go('#/newchan'));
    for (const p of App.plans.filter(p => p.status !== 'archived'))
      r.push({ group: 'Видео', label: p.name, icon: p.mode === 'long' ? 'wide' : 'tall', kw: (STAGE_OF[p.stage] || {}).label || '', hint: (STATUS_L[p.status] || '').replace(/^\S+\s/, ''), run: () => go(`#/v/${p.id}`) });
    for (const it of (window.LIB && LIB.items) || [])
      r.push({ group: 'Библиотека', label: it.name, icon: 'library', kw: (it.desc || '') + ' ' + (it.tags || []).join(' '), hint: it.kind, run: () => go('#/lib/item/' + it.id) });
    return r;
  },
  filter() {
    const q = this.norm(this.q).trim(), words = q.split(/\s+/).filter(Boolean);
    const all = this.all();
    const hit = x => { const t = this.norm(x.label + ' ' + x.kw + ' ' + x.group); return words.every(w => t.includes(w)); };
    this.items = (q ? all.filter(hit) : all.filter(x => x.group !== 'Библиотека')).slice(0, 60);
    this.i = Math.min(this.i, Math.max(0, this.items.length - 1));
  },

  open() {
    if (this.el) return;
    if (window.LIB && !LIB.items && !LIB.busy) Pages.loadLib();          // ассеты библиотеки — тоже в поиске
    this.q = ''; this.i = 0;
    const input = h('input.pal-q', { placeholder: 'Видео, ассет, раздел или команда…', spellcheck: false,
      oninput: e => { this.q = e.target.value; this.i = 0; this.draw(); },
      onkeydown: e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.i = Math.min(this.i + 1, this.items.length - 1); this.draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.i = Math.max(this.i - 1, 0); this.draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.items[this.i]); }
        else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      } });
    this.list = h('div.pal-list');
    this.el = h('div.pal', { onmousedown: e => { if (e.target === this.el) this.close(); } },
      h('div.pal-box', h('div.pal-in', Icon('search', 17), input, h('kbd', 'Esc')), this.list,
        h('div.pal-foot', h('span', h('kbd', '↑'), h('kbd', '↓'), ' выбрать'), h('span', h('kbd', 'Enter'), ' открыть'))));
    document.body.append(this.el);
    this.draw();
    input.focus();
  },
  draw() {
    if (!this.el) return;
    this.filter();
    const rows = []; let g = null;
    this.items.forEach((x, k) => {
      if (x.group !== g) { g = x.group; rows.push(h('div.pal-g', g)); }
      rows.push(h('div.pal-row', { class: k === this.i ? 'on' : '', onmousemove: () => { if (this.i !== k) { this.i = k; this.draw(); } }, onclick: () => this.pick(x) },
        Icon(x.icon, 16), h('span.grow', x.label), x.hint && h('span.dim.small', x.hint), k === this.i && Icon('enter', 14, 'dim')));
    });
    this.list.replaceChildren(...(rows.length ? rows : [h('div.pal-empty', 'Ничего не нашлось')]));
    const on = this.list.querySelector('.pal-row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  },
  pick(x) { if (!x) return; this.close(); x.run(); },
  close() { if (this.el) this.el.remove(); this.el = null; },
};
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK') { e.preventDefault(); Palette.el ? Palette.close() : Palette.open(); }
});
addEventListener('hashchange', () => Palette.close());   // перешли куда-то (в т.ч. не из палитры) — палитра не висит поверх
