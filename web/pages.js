// Claude Studio — экраны вне одного видео: боковая панель (канал, видео), проект-канал (видео + библиотека), библиотека, ⚙ стиль, справочник.
'use strict';

const STAGES = [['idea', '💡', 'Идея'], ['qa', '❓', 'Вопросы'], ['title', '🎯', 'Название'], ['pre', '🎬', 'Препродакшен'], ['scenes', '🎥', 'Сцены'],
  ['script', '📝', 'Сценарий'], ['voice', '🎙', 'Голос'], ['montage', '🎞', 'Монтаж'], ['review', '👀', 'Ревью'], ['pack', '📦', 'Упаковка']];
const STAGE_OF = Object.fromEntries(STAGES.map(([k, i, l]) => [k, { icon: i, label: l }]));
const STATUS_L = { draft: '💡 черновик', prod: '🛠 в работе', out: '✅ вышло', archived: '📦 архив' };
const LIB = { items: null, q: '', kind: '', cand: null, busy: false };
const KIND_ICON = { char: '🧑', prop: '📦', sound: '🔊' };

const Pages = {
  side() {
    const r = App.route, C = App.info.channel || {}, cs = App.info.channels || [];
    const nav = (href, icon, label, on) => h('a', { href, class: on ? 'on' : '' }, icon, ' ', label);
    const recent = App.plans.filter(p => p.status !== 'archived').slice(0, 12);
    return [
      h('a.logo', { href: '#/' }, h('span.l1', 'Claude'), h('span.l2', 'Studio')),
      cs.length > 0 && h('label.chan', { title: 'Канал (проект): у каждого свой стиль, библиотека и видео' },
        sel(cs.map(c => ({ value: c.id, label: `${c.icon || '📺'} ${c.name}` })), C.id, v => Pages.useChannel(v), { class: 'box', 'aria-label': 'Канал' })),
      h('div.newbtns',
        h('button.new.short', { onclick: () => Pages.newPlan('short'), title: 'Идея → вопросы → название → препродакшен → сцены → сценарий → … → упаковка' }, '⚡ + шортс'),
        h('button.new.long', { onclick: () => Pages.newPlan('long'), title: 'Длинное видео на 8–15 минут' }, '🎬 + длинное видео')),
      h('nav', nav('#/', '🏠', 'Проект', r.page === 'home'), nav('#/lib', '📚', 'Библиотека', r.page === 'lib'), nav('#/style', '⚙', 'Стиль канала', r.page === 'style')),
      recent.length > 0 && h('div', h('div.sec', 'Видео'), recent.map(p => h('a.rp', { class: r.page === 'p' && r.id === p.id ? 'on' : '', href: `#/p/${p.id}/${p.stage || 'idea'}`, title: p.name },
        (REF.modes[p.mode] || {}).icon + ' ' + p.name, dot(Unread.has(p.id))))),
      h('div.foot', h('span#saved', 'всё сохранено'), !App.info.claude && h('span.warn-small', 'Claude Code не найден — кнопки ✨ выключены'),
        App.info.legacy ? h('span.warn-small', 'Переезд ещё не сделан: данные в _ideas') : h('span', 'Канал: ' + (C.name || '—')),
        h('a', { href: '#/help', class: 'dim' }, '📖 справочник')),
    ];
  },

  async useChannel(id) {
    try { await api('POST', '/api/studio/use', { channel: id }); LIB.items = null; Pages._style = undefined; await App.refreshState(); go('#/'); App.render(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  async newPlan(mode) {
    try {
      const r = await api('POST', '/api/new', { mode, name: `Новое ${mode === 'long' ? 'длинное видео' : 'видео'}`, channel: (App.info.channel || {}).id });
      await App.refreshState();
      App.focusName = true;                           // rename right away (see App.render)
      go(`#/p/${r.id}/idea`);
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- проект-канал: видео слева, библиотека справа ----------------
  home() {
    const C = App.info.channel || {}, ps = App.plans, showArch = Local.get('arch') === '1';
    const group = (st, label) => { const list = ps.filter(p => p.status === st); return list.length > 0 && [h('div.sec', label + ` · ${list.length}`), list.map(Pages.card)]; };
    if (!LIB.items && !LIB.busy) Pages.loadLib();
    return h('div.project',
      h('div.phead', h('h1', `${C.icon || '📺'} ${C.name || 'Claude Studio'}`), h('span.sp'),
        h('a.btn', { href: '#/style', title: 'Стиль канала: стайл-гайд, по которому пишутся сценарии и рисуется всё' }, '⚙ стиль'),
        h('button.primary', { onclick: () => Pages.newPlan('short') }, '+ видео')),
      C.about && h('p.dim', C.about),
      h('div.cols',
        h('section.card.videos',
          h('div.card-head', h('h3', '🎬 Видео'), h('span.dim', `${ps.length}`)),
          ps.length ? [group('prod', '🛠 В работе'), group('draft', '💡 Черновики'), group('out', '✅ Вышли'), showArch && group('archived', '📦 Архив'),
            ps.some(p => p.status === 'archived') && h('p', h('a', { href: 'javascript:void 0', onclick: () => { Local.set('arch', showArch ? '0' : '1'); App.render(); } }, showArch ? 'Скрыть архив' : 'Показать архив'))]
            : h('div.empty', 'Видео пока нет. «+ видео» — идея, вопросы Claude, название, препродакшен…')),
        h('section.card.libside', Pages.libPanel(true))));
  },

  card(p) {
    const M = REF.modes[p.mode] || REF.modes.short, st = STAGE_OF[p.stage] || STAGE_OF.idea;
    return h('a.vrow', { href: `#/p/${p.id}/${p.stage || 'idea'}` },
      h('span.mode', { class: p.mode }, M.icon), h('span.t.grow', p.name, dot(Unread.has(p.id))),
      h('span.stage', { title: 'Этап, на котором остановились' }, st.icon + ' ' + st.label),
      h('span.dim.small', STATUS_L[p.status] || p.status), h('span.dim.small', fmtDate(p.updated)));
  },

  // ---------------- 📚 библиотека канала ----------------
  async loadLib() {
    LIB.busy = true;
    try { const j = await api('GET', `/api/lib?q=${encodeURIComponent(LIB.q)}&kind=${LIB.kind}`); LIB.items = j.items; LIB.kinds = j.kinds; LIB.channel = j.channel; }
    catch (e) { LIB.items = []; LIB.err = e.message; }
    LIB.busy = false; App.render();
  },
  libPanel(compact) {
    const items = LIB.items || [], K = LIB.kinds || {};
    const q = h('input.box.grow', { key: 'libq', placeholder: '🔎 ёжик, стол, гул…', value: LIB.q, oninput: e => { LIB.q = e.target.value; clearTimeout(LIB.t); LIB.t = setTimeout(() => Pages.loadLib(), 250); } });
    return [
      h('div.card-head', h('h3', '📚 Библиотека'), h('span.dim', compact ? 'утверждённое ✓ из видео' : 'персонажи, пропсы, 3D-модели и звуки канала'), h('span.sp'), compact && h('a', { href: '#/lib' }, 'вся →')),
      h('div.row', q, h('div.seg', [['', 'всё'], ...Object.entries(K)].map(([k, l]) => h('button', { class: LIB.kind === k ? 'sel' : '', onclick: () => { LIB.kind = k; Pages.loadLib(); } }, l)))),
      LIB.items === null ? h('p.dim', 'Загружаю…') : items.length ? h('div.libgrid', { class: compact ? 'compact' : '' }, items.map(Pages.libCard))
        : h('p.dim', LIB.q || LIB.kind ? 'Ничего не нашлось.' : 'Пока пусто. Утверждённые ✓ персонажи, пропсы и звуки из препродакшена публикуются сюда: «📚 в библиотеку» на странице библиотеки.'),
    ];
  },
  libCard(it) {
    const src = it.preview ? `/api/lib/file/${LIB.channel}/${it.preview}` : '';
    return h('div.libcard', { title: (it.desc || '') + (it.from ? `\nиз видео «${it.from.videoName || it.from.video}»` : '') },
      src ? h('img', { src, alt: '', onclick: () => UI.lightbox(src) }) : h('div.noimg', it.kind === 'sounds' ? '🔊' : '📦'),
      h('b', it.name), h('span.dim.small', `lib:${it.id}@${it.latest}`));
  },
  lib() {
    if (!LIB.items && !LIB.busy) Pages.loadLib();
    if (!LIB.cand && !LIB.cbusy) { LIB.cbusy = true; api('GET', '/api/lib/candidates').then(j => { LIB.cand = j.items; LIB.cbusy = false; App.render(); }).catch(() => { LIB.cand = []; LIB.cbusy = false; }); }
    const cand = (LIB.cand || []).filter(x => x.ready);
    return h('div',
      h('div.phead', h('h1', '📚 Библиотека канала'), h('span.dim', (App.info.channel || {}).name || '')),
      h('section.card', Pages.libPanel(false)),
      h('section.card',
        h('div.card-head', h('h3', '✓ Утверждено в видео'), h('span.dim', 'опубликуй в библиотеку, чтобы брать в другие ролики (новой версией, если уже есть)')),
        !LIB.cand ? h('p.dim', 'Смотрю видео…') : !cand.length ? h('p.dim', 'Утверждённых ✓ персонажей, пропсов и звуков с черновиком пока нет.')
          : h('div.cands', cand.map(x => h('div.row.cand',
            h('span', KIND_ICON[x.kind] || '•'), h('b', x.name), h('span.dim.small', 'из «' + x.videoName + '»'), h('span.sp'),
            x.lib && h('span.dim.small', `уже: lib:${x.lib.id}@${x.lib.v}`),
            h('button', { onclick: () => Pages.publish(x, x.lib ? x.lib.id : 'new') }, x.lib ? '⬆ новая версия' : '📚 в библиотеку'))))));
  },
  async publish(x, as) {
    try {
      const r = await api('POST', '/api/lib/publish', { key: 'plan:' + x.video, el: x.el, as });
      UI.toast('Публикую «' + x.name + '»…');
      const poll = async () => {
        const j = await api('GET', '/api/job?id=' + r.job.id);
        if (j.status === 'running') return setTimeout(poll, 800);
        if (j.status === 'done') { UI.toast('📚 ' + j.summary); LIB.items = null; LIB.cand = null; App.render(); } else UI.toast(j.error || j.status, 'err');
      };
      poll();
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- ⚙ стиль канала ----------------
  style() {
    const C = App.info.channel || {};
    if (Pages._style === undefined) { Pages._style = null; api('GET', '/api/studio/style').then(j => { Pages._style = j; App.render(); }).catch(e => { Pages._style = { text: '', err: e.message }; App.render(); }); }
    const S = Pages._style;
    const ta = h('textarea.box.styleedit', { key: 'styletext', spellcheck: false, placeholder: '# Стайл-гайд канала…' });
    if (S) ta.value = S.text;
    const save = async () => {
      try { await api('POST', '/api/studio/style', { channel: C.id, text: ta.value }); Pages._style.text = ta.value; UI.toast('Стиль сохранён'); }
      catch (e) { UI.toast(e.message, 'err'); }
    };
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } });
    const ckey = 'channel:' + C.id;
    if (C.id && !Store.get(ckey) && !Pages._ch) { Pages._ch = true; Store.load(ckey).then(() => App.render()).catch(() => {}); }
    return h('div',
      h('div.phead', h('h1', '⚙ Стиль канала'), h('span.dim', C.name || ''), h('span.sp'), h('button.primary', { onclick: save, title: 'Ctrl+S' }, '💾 Сохранить')),
      h('section.card',
        h('div.card-head', h('h3', 'Канал')),
        Store.get(ckey) ? h('div.chanform',
          h('label', 'Название', line(ckey, ['name'], { cls: 'box' })), h('label', 'Иконка', line(ckey, ['icon'], { cls: 'box' })),
          h('label.wide', 'О канале (одной строкой — Claude читает её во всех кнопках ✨)', line(ckey, ['about'], { cls: 'box' })))
          : h('p.dim', 'Загружаю…')),
      h('section.card',
        h('div.card-head', h('h3', '📝 Стайл-гайд'), h('span.dim.small', S && S.path ? S.path : ''), h('span.sp'), h('span.dim.small', 'markdown · Ctrl+S — сохранить')),
        S ? ta : h('p.dim', 'Загружаю…')),
      h('p.dim', 'По стайл-гайду Claude пишет сценарии (темп, хук, подача) и держит стиль картинок. Интервью по стилю для нового канала — этап S9.'));
  },

  help() {
    const T = REF.thumbTypes, Z = Object.fromEntries(REF.thumbZones.map(z => [z.key, z]));
    const zone = k => h('div.zonebox', { class: k }, h('h3', Z[k].icon + ' ' + Z[k].label), h('div.dim', Z[k].sub),
      Z[k].types.map(t => h('div.ttype', h('b', T[t].label), h('span', T[t].desc), h('em', 'С ёжиком: ' + T[t].hog))));
    return h('div',
      h('div.phead', h('h1', '📚 Справочник'), h('span.dim', REF.source)),
      h('h2', 'Карта превью'),
      h('p.dim', 'Типы превью по двум осям: насколько кликают и насколько загружен кадр. Категории не строгие — одно превью бывает сразу нескольких типов. Но заметь: чистое превью почти никогда не бывает слабым.'),
      h('div.map',
        h('div.axis.v', 'чистые'), zone('big'), zone('grail'),
        h('div.axis.v', 'сложные'), zone('no'), zone('ok'),
        h('div'), h('div.axis', '← слабо кликают'), h('div.axis', 'хорошо кликают →')),
      h('h2', 'Сильные слова', App.info.pdf && h('a', { href: '/planner.pdf#page=200', target: '_blank', style: { fontSize: '13px', fontWeight: 500 } }, '📖 полный словарь — в тетради, стр. 200–201')),
      h('div.wordcards', REF.words.map(w => h('div', { style: { borderColor: w.color } }, h('b', { style: { color: w.color } }, w.label), h('p', w.hint), h('small.dim', 'например: ' + w.ex.join(', '))))),
      h('h2', 'Правила'),
      h('div.rules',
        h('div', h('b', 'Правило трёх'), h('p', 'Один вариант — не выбор, а ловушка. Два — дилемма, которая легко оказывается ложной. Настоящий выбор начинается с трёх. После третьего варианта придумывать становится легче — разгоняйся до пяти-шести.')),
        h('div', h('b', 'Сначала название'), h('p', 'Нет смысла писать, снимать и монтировать, если нет сильного названия и превью. Поэтому сначала идея, биты, название и превью — и только потом сценарий.')),
        h('div', h('b', 'Принцип пещерного человека'), h('p', 'Смыслы — самыми простыми словами, понятными первокласснику. Не «применить инструмент к оппоненту», а «ДУБИНА, БИТЬ».')),
        h('div', h('b', 'Сильный образ'), h('p', 'Слышишь слово — и сразу видишь картинку. Три разных образа на смысл, а не три фото одного и того же.')),
        h('div', h('b', 'Не делай ребус'), h('p', 'Если смысл превью надо собирать из отдельных картинок, это провал. 1 образ — победа, 3 — хорошо, больше 7 — что-то пошло не так.')),
        h('div', h('b', 'Текст не повторяет название'), h('p', 'Текст читают сознательно и медленно, картинку считывают сразу. Числа, суммы и «СТОП!» — уже образы.')),
        h('div', h('b', 'Плохих идей нет'), h('p', 'Есть неподходящие сейчас. Перед тем как выкинуть: точно не подходит? как изменить? может, не идея плохая, а наш формат?')),
        h('div', h('b', '«Как было бы прикольно?»'), h('p', 'Вместо «как правильно?». Хочется шутку — вставляем, хочется странную тему — крутим её до названия. Резать будем на редактуре.'))),
      h('h2', 'Структуры шортсов'),
      h('div.rules', Object.values(REF.schemes).map(s => h('div', h('b', s.label), h('p.dim', 'для: ' + s.for), h('table.grid', s.blocks.map(b => h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, b.t), h('td', h('b', b.label), ' — ', b.hint))))))),
      h('h2', 'Три акта для длинного видео'),
      h('div.card', h('table.grid', REF.acts.map(a => h('tr', h('td', a.act + ' акт'), h('td', h('b', a.label)), h('td', a.hint), h('td.dim', `~${a.pct}%`))))),
      h('p.dim', 'Видео до 20 минут можно делать и как инструкцию — шаг за шагом от названия к выводу. Но открывающий образ, кульминация и завершающий образ нужны всегда.'));
  },
};
