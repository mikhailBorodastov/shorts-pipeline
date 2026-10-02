// Claude Studio — экраны вне одного видео: библиотека, ⚙ стиль, справочник. Боковая панель — ui/shell.js, «Видео» — ui/videos.js (S12).
'use strict';

const STAGES = [['idea', '💡', 'Идея'], ['qa', '❓', 'Вопросы'], ['title', '🎯', 'Название'], ['script', '📝', 'Сценарий'], ['pre', '🎬', 'Препродакшен'],
  ['voice', '🎙', 'Голос'], ['montage', '🎞', 'Монтаж'], ['review', '👀', 'Ревью'], ['pack', '📦', 'Упаковка'], ['scenes', '🎥', 'Сцены']];   // S11: сценарий до препродакшена; «Сцены» — старые видео
const STAGE_OF = Object.fromEntries(STAGES.map(([k, i, l]) => [k, { icon: i, label: l }]));
const STATUS_L = { draft: '💡 черновик', prod: '🛠 в работе', out: '✅ вышло', archived: '📦 архив' };
const LIB = { items: null, q: '', kind: '', cand: null, busy: false };
const KIND_ICON = { char: '🧑', prop: '📦', sound: '🔊' };

const Pages = {
  async useChannel(id) {
    try { await api('POST', '/api/studio/use', { channel: id }); LIB.items = null; Pages._style = undefined; if (window.CH) CH.files = null; await App.refreshState(); go('#/'); App.render(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- 📚 библиотека канала ----------------
  async loadLib() {
    LIB.busy = true;
    try { const j = await api('GET', `/api/lib?q=${encodeURIComponent(LIB.q)}&kind=${LIB.kind}&channel=${(App.info.channel || {}).id || ''}`); LIB.items = j.items; LIB.kinds = j.kinds; LIB.channel = j.channel; }
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
    const ch = () => go('#/lib/item/' + it.id);              // страница предмета: покрутить, версии, правки, где стоит, архив (libitem.js); у персонажа оттуда — лист со скелетом
    return h('div.libcard', { title: (it.desc || '') + (it.from ? `\nиз видео «${it.from.videoName || it.from.video}»` : '') + '\nклик — открыть: покрутить, версии, правки, где стоит' },
      src ? h('img', { src, alt: '', onclick: ch }) : h('div.noimg', { onclick: ch }, it.kind === 'sounds' ? '🔊' : '📦'),
      it.rig && h('span.small', { title: `скелет ${it.skeleton}` }, '🦴 ' + it.skeleton),
      h('b', it.name, it.d3 ? h('span.small', { title: `есть 3D-версия v${it.d3}` }, ' 🧊') : ''), h('span.dim.small', `lib:${it.id}@${it.latest}`));
  },
  // S12.10: библиотека в новом виде — вкладки видов, поиск, сетка плиток; ниже — готовое к публикации из видео
  libTile(it) {
    const src = it.preview ? `/api/lib/file/${LIB.channel}/${it.preview}` : '';
    const K = LIB.kinds || {};
    return h('a.lib-tile', { href: '#/lib/item/' + it.id, title: (it.desc || '') + (it.from ? `\nиз видео «${it.from.videoName || it.from.video}»` : '') },
      h('div.pv', src ? { style: { backgroundImage: `url("${src}")` } } : {}, !src && Icon(it.kind === 'sounds' ? 'music' : 'library', 28)),
      h('div.nm', it.name, it.d3 ? h('span.dim', { title: `есть 3D-версия v${it.d3}` }, ' · 3D') : ''),
      h('div.mt', (K[it.kind] || it.kind || '') + ` · v${it.latest}` + (it.from && it.from.videoName ? ' · ' + it.from.videoName : '')));
  },
  lib() {
    const cid = (App.info.channel || {}).id;
    if (LIB.items && LIB.channel && LIB.channel !== cid) { LIB.items = null; LIB.cand = null; }   // канал сменился не через переключатель — библиотека другого канала
    if (!LIB.items && !LIB.busy) Pages.loadLib();
    if (!LIB.cand && !LIB.cbusy) { LIB.cbusy = true; api('GET', '/api/lib/candidates').then(j => { LIB.cand = j.items; LIB.cbusy = false; App.render(); }).catch(() => { LIB.cand = []; LIB.cbusy = false; }); }
    const cand = (LIB.cand || []).filter(x => x.ready), items = LIB.items || [], K = LIB.kinds || {};
    const q = h('input.box', { key: 'libq', placeholder: 'Поиск: ёжик, стол, гул…', value: LIB.q, oninput: e => { LIB.q = e.target.value; clearTimeout(LIB.t); LIB.t = setTimeout(() => Pages.loadLib(), 250); } });
    return h('div.page.lib-page',
      h('div.page-head', h('div.grow', h('h1', 'Библиотека'),
        h('p.sub', `Утверждённые персонажи, предметы, 3D-модели, звуки и видео канала «${(App.info.channel || {}).name || ''}» — их можно брать в любой ролик. Открой предмет, чтобы покрутить, сравнить версии или поправить с Claude.`))),
      h('div.lib-tabs', [['', 'Всё'], ...Object.entries(K)].map(([k, l]) => h('button', { class: LIB.kind === k ? 'sel' : '', onclick: () => { LIB.kind = k; Pages.loadLib(); } }, l)), q),
      LIB.items === null ? h('p.dim', 'Загружаю…') : items.length ? h('div.lib-grid', items.map(Pages.libTile))
        : h('p.dim', LIB.q || LIB.kind ? 'Ничего не нашлось.' : 'Пока пусто. Утверждённое ✓ в препродакшене появится ниже — опубликуйте его сюда.'),
      LIB.cand && cand.length > 0 && [h('div.ws-sec', 'Утверждено в видео — можно в библиотеку', h('span.cnt', String(cand.length))),
        h('div.cands', cand.map(x => h('div.row.cand',
          h('span', KIND_ICON[x.kind] || '•'), h('b', x.name), x.d3 && h('span.small', { title: '3D-пропс: в сцене встанет объёмным' }, '3D'), h('span.dim.small', 'из «' + x.videoName + '»'), h('span.sp'),
          x.lib && h('span.dim.small', `уже: lib:${x.lib.id}@${x.lib.v}`),
          h('button.small', { onclick: () => Pages.publish(x, x.lib ? x.lib.id : 'new') }, x.lib ? 'Новая версия' : 'В библиотеку'))))]);
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
