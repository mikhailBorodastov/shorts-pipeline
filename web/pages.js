// «Штурм идей» — pages outside one planner: sidebar, штурмы, банк идей, лист проекта, просмотры, справочник.
'use strict';

const BANK_STATUS = [{ value: 'new', label: '💡 новая' }, { value: 'plan', label: '🧠 в штурме' }, { value: 'later', label: '⏳ отложена' },
  { value: 'done', label: '✅ снята' }, { value: 'dropped', label: '🚫 не подошла' }];
const SPEED = [{ value: '1', label: '⚡ за день' }, { value: '2', label: '🕐 неделя' }, { value: '3', label: '🗓 месяц+' }];
const MODE_OPT = [{ value: 'any', label: 'любой' }, { value: 'short', label: '⚡ шортс' }, { value: 'long', label: '🎬 длинное' }];

function stars(value, onSet, hot) {
  return h('span.stars', { class: hot && value >= 3 ? 'hot' : '', title: 'Крутость: насколько горишь идеей (3 — «в разы круче»)' },
    [1, 2, 3].map(n => h('span', { class: n <= value ? 'on' : '', onclick: () => onSet(n === value ? n - 1 : n) }, '★')));
}
function dots(p, flow) {
  const half = (a, b) => (a ? true : b ? 'half' : false);
  const s = flow === 'idea'
    ? [p.chosen, half(p.qa && p.answered >= Math.min(10, p.qa) && p.kept > 0, p.qa > 0), p.finalists > 0, half(p.elements && p.ready === p.elements, p.elements > 0), half(p.win, p.thumbs > 0), p.project, p.out]
    : [p.chosen, p.kept > 0, half(p.finalists >= 3, p.finalists > 0), p.images > 0, half(p.win, p.thumbs > 0), p.slots > 0, p.project, p.out];
  const title = flow === 'idea' ? 'Идея · Вопросы и биты · Название · Препродакшен · Обложка · В работу · Итоги' : 'Идеи · Биты · Название · Образы · Превью · Структура · В работу · Итоги';
  return h('span.dots', { title }, s.map(v => h('i', { class: v === true ? 'ok' : v === 'half' ? 'half' : '' })));
}

const Pages = {
  side() {
    const r = App.route;
    const nav = (href, icon, label, on) => h('a', { href, class: on ? 'on' : '' }, icon, ' ', label);
    const recent = App.plans.filter(p => p.status !== 'archived').slice(0, 10);
    return [
      h('a.logo', { href: '#/' }, h('span.l1', 'Штурм'), h('span.l2', 'идей')),
      h('div.newbtns', h('button.new.short', { onclick: () => Pages.newPlan('short'), title: 'Есть идея: вопросы → биты → название → препродакшен → обложка' }, '⚡ Новый шортс'),
        h('button.new.long', { onclick: () => Pages.newPlan('long'), title: 'Есть идея: вопросы → биты → название → препродакшен → превью' }, '🎬 Новое длинное видео'),
        h('button.new.storm', { onclick: () => Pages.newPlan('short', { flow: 'storm' }), title: 'Идеи нет: 10 идей → ★3 → ●1 → биты → название → образы → превью → структура' }, '💡 Штурм идей')),
      h('nav', nav('#/', '🏠', 'Штурмы', r.page === 'home'), nav('#/bank', '💡', 'Банк идей', r.page === 'bank'), nav('#/brand', '📋', 'Лист проекта', r.page === 'brand'),
        nav('#/stats', '📈', 'Просмотры', r.page === 'stats'), nav('#/help', '📚', 'Справочник', r.page === 'help')),
      recent.length > 0 && h('div', h('div.sec', 'Недавние'), recent.map(p => h('a.rp', { class: r.page === 'p' && r.id === p.id ? 'on' : '', href: `#/p/${p.id}`, title: p.name },
        (REF.modes[p.mode] || {}).icon + ' ' + p.name, dot(Unread.has(p.id))))),
      h('div.foot', h('span#saved', 'всё сохранено'), !App.info.claude && h('span.warn-small', 'Claude Code не найден — кнопки ✨ выключены'),
        h('span', 'Данные: _ideas')),
    ];
  },

  async newPlan(mode, extra = {}) {
    try {
      const name = extra.flow === 'storm' ? 'Штурм идей' : `Новый ${mode === 'long' ? 'длинный ролик' : 'шортс'}`;
      const r = await api('POST', '/api/new', { mode, name: extra.bank ? '' : name, ...extra });
      await App.refreshState();
      if (!extra.bank) App.focusName = true;          // rename right away (see App.render)
      go(`#/p/${r.id}/${defTab(r.flow)}`);
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- штурмы ----------------
  home() {
    const ps = App.plans, showArch = Local.get('arch') === '1';
    const group = (st, label) => {
      const list = ps.filter(p => p.status === st);
      return list.length > 0 && [h('h2', label, h('span.badge', list.length)), h('div.plancards', list.map(Pages.card))];
    };
    const bank = Store.get('bank'), hot = bank ? bank.items.filter(i => ['new', 'later'].includes(i.status)).sort((a, b) => (b.cool || 0) - (a.cool || 0)).slice(0, 5) : [];
    return h('div.home',
      h('div.hero', h('h1', 'Штурм идей'),
        h('p', 'Разработка ролика до сценария по методике «Мастер-планера»: идея → вопросы и биты → смыслы и название → препродакшен (сцены, персонажи, пропсы, звуки) → обложка → в работу → итоги. Кнопки ✨ — это Claude на твоей подписке Claude Code, без API-ключей. Всё сохраняется само в папку _ideas.')),
      h('div.starts',
        ...['short', 'long'].map(m => { const M = REF.modes[m]; return h('div.start', { class: m, onclick: () => Pages.newPlan(m) }, h('span.big', `${M.icon} Новый ${m === 'short' ? 'шортс' : 'длинный ролик'}`), h('span.dim', `есть идея · ${M.len} · ${M.about}`)); })),
      h('div.start.storm', { onclick: () => Pages.newPlan('short', { flow: 'storm' }) }, h('span.big', '💡 Идеи нет — штурм идей'),
        h('span.dim', 'напиши мысль, про что хочется снять, и Claude накидает 10 идей → ★3 → ●1 → биты → название → образы → превью → структура')),
      h('div.flow',
        h('div', h('b', '1. Есть идея (и референс)?'), 'Новый шортс → запиши идею, вставь чужой ролик-референс → Claude задаст 15–20 вопросов → биты и челлендж → смыслы и название.'),
        h('div', h('b', '2. Препродакшен'), 'Сцены, персонажи, пропсы и звуки: накидываешь референсы, Claude рисует черновики нашим движком и подбирает звуки, ты правишь пинами. Потом обложка и первый кадр.'),
        h('div', h('b', '3. Готово?'), 'Вкладка «В работу» → 🚀 Создать проект. Потом скажи мне: «Сценарий по штурму в папке …» — всё нарисованное и скачанное уже будет в проекте.')),
      group('draft', '💡 В штурме'), group('prod', '🛠 В работе'), group('out', '✅ Вышли'),
      showArch && group('archived', '📦 Архив'),
      ps.some(p => p.status === 'archived') && h('p', h('a', { href: 'javascript:void 0', onclick: () => { Local.set('arch', showArch ? '0' : '1'); App.render(); } }, showArch ? 'Скрыть архив' : 'Показать архив')),
      !ps.length && h('div.card.empty', 'Штурмов пока нет. Начни с кнопки выше — или загляни в банк идей.'),
      hot.length > 0 && [h('h2', '💡 Горячее в банке идей', h('a', { href: '#/bank', style: { fontSize: '13px', fontWeight: 500 } }, 'весь банк →')),
        h('div.card', hot.map(i => h('div.row', { style: { padding: '4px 0' } }, stars(i.cool || 0, () => {}), h('b.grow', i.title), h('span.dim', (REF.modes[i.mode] || {}).icon || ''),
          h('button', { onclick: () => Pages.newPlan(i.mode === 'long' ? 'long' : 'short', { bank: i.id }) }, '🚀 В штурм'))))],
      h('p.philo', '«Как было бы прикольно?» вместо «как правильно?». Резать лишнее будем на редактуре.'));
  },

  card(p) {
    const M = REF.modes[p.mode] || REF.modes.short;
    return h('a.pc', { href: `#/p/${p.id}` },
      h('div.row', h('span.mode', { class: p.mode }, M.icon + ' ' + M.label), p.flow !== 'idea' && h('span.dim', { style: { fontSize: '12px' } }, '💡 штурм'), h('span.sp'), dots(p.p, p.flow)),
      h('span.t', p.name, dot(Unread.has(p.id))),
      p.final ? h('span.f', '🏆 ' + p.final) : p.chosen && h('span.c', '● ' + p.chosen),
      h('div.row', h('span.dim', { style: { fontSize: '12px' } }, 'обновлён ' + fmtDate(p.updated)), p.project && h('span.dim', { style: { fontSize: '12px' } }, '· проект «' + p.project + '»')));
  },

  // ---------------- банк идей ----------------
  bank() {
    const key = 'bank', b = Store.get(key);
    const fm = Local.get('bankMode') || 'all', fs = Local.get('bankStatus') || 'live', srt = Local.get('bankSort') || 'cool';
    let items = b.items.filter(i => (fm === 'all' || i.mode === fm || i.mode === 'any') && (fs === 'all' || (fs === 'live' ? ['new', 'later'].includes(i.status) : i.status === fs)));
    const cmp = { cool: (x, y) => (y.cool || 0) - (x.cool || 0) || (y.created || 0) - (x.created || 0), new: (x, y) => (y.created || 0) - (x.created || 0),
      fresh: (x, y) => String(y.fresh || '').localeCompare(String(x.fresh || '')), speed: (x, y) => (x.speed || 2) - (y.speed || 2) };
    items = items.slice().sort(cmp[srt] || cmp.cool);
    const focus = h('input.box', { key: 'bank|focus', placeholder: 'тема для Claude (можно пусто)', value: Local.get('bankFocus') || '', oninput: e => Local.set('bankFocus', e.target.value), style: { width: '220px' } });
    return h('div',
      h('div.phead', h('h1', '💡 Банк идей'), h('span.counter', `${b.items.length} всего · ${b.items.filter(i => ['new', 'later'].includes(i.status)).length} живых`)),
      hint('bank', `<p>Сюда попадает всё, что не прошло отбор, и всё, что пришло в голову просто так. Плохих идей нет — есть неподходящие сейчас. Прежде чем выкинуть, спроси себя: точно не подходит? как её изменить, чтобы подошла? может, дело не в идее, а в формате канала или в том, что мы сами себе врём, о чём ролик?</p>
<p><b>Крутость</b> ★ — насколько горишь идеей: три звезды (красные) значат «в разы круче». <b>Скорость</b> — сколько готовить: за день, неделю или месяц сбора материала. <b>Свежесть</b> — дата инфоповода: новости стареют быстро.</p>`),
      h('div.toolbar',
        sel([{ value: 'all', label: 'все форматы' }, { value: 'short', label: '⚡ шортсы' }, { value: 'long', label: '🎬 длинные' }], fm, v => { Local.set('bankMode', v); App.render(); }, { class: 'box' }),
        sel([{ value: 'live', label: 'живые' }, { value: 'all', label: 'все статусы' }, ...BANK_STATUS], fs, v => { Local.set('bankStatus', v); App.render(); }, { class: 'box' }),
        sel([{ value: 'cool', label: 'сначала крутые' }, { value: 'new', label: 'сначала новые' }, { value: 'fresh', label: 'по свежести' }, { value: 'speed', label: 'сначала быстрые' }], srt, v => { Local.set('bankSort', v); App.render(); }, { class: 'box' }),
        h('span.sp'),
        h('label.row', { title: 'Claude ищет свежие новости (1–3 минуты)' }, h('input', { type: 'checkbox', checked: !!b.web, onchange: e => Store.set(key, ['web'], e.target.checked, true) }), '🌐 свежие новости'),
        focus,
        Claude.btn({ label: '10 идей в банк', action: 'bank', key, params: () => ({ n: 10, focus: focus.value }) })),
      Pages.autoNews(b),
      h('div.card', items.length ? h('table.grid.bank',
        h('tr', h('th', '★'), h('th', 'Идея и описание'), h('th', 'Формат'), h('th', 'Скорость'), h('th', 'Свежесть'), h('th', 'Источник'), h('th', 'Статус'), h('th')),
        items.map(i => h('tr',
          h('td', stars(i.cool || 0, n => Store.set(key, ['items', i.id, 'cool'], n, true), true)),
          h('td.t', area(key, ['items', i.id, 'title'], { ph: 'идея' }), area(key, ['items', i.id, 'desc'], { ph: 'описание, крючок…', cls: 'dim' }),
            i.by === 'claude' && h('small.dim', i.auto ? '📰 из новостей · ' + fmtDate(i.created) : '🤖 Claude')),
          h('td', sel(MODE_OPT, i.mode || 'any', v => Store.set(key, ['items', i.id, 'mode'], v, true), { class: 'box' })),
          h('td', sel(SPEED, String(i.speed || 2), v => Store.set(key, ['items', i.id, 'speed'], Number(v), true), { class: 'box' })),
          h('td', line(key, ['items', i.id, 'fresh'], { ph: 'дата / вечно', cls: 'box' })),
          h('td', line(key, ['items', i.id, 'src'], { ph: 'ссылка', cls: 'box' }), /^https?:/.test(i.src || '') && h('a', { href: i.src, target: '_blank', rel: 'noopener' }, '🔗')),
          h('td', sel(BANK_STATUS, i.status || 'new', v => Store.set(key, ['items', i.id, 'status'], v, true), { class: 'box' }), i.plan && h('div', h('a', { href: `#/p/${i.plan}` }, 'к штурму'))),
          h('td', h('button', { title: 'Новый штурм по этой идее', onclick: () => Pages.newPlan(i.mode === 'long' ? 'long' : 'short', { bank: i.id }) }, '🚀'),
            h('button.icon.del', { title: 'Удалить', onclick: () => confirm('Удалить идею из банка?') && Store.del(key, ['items'], i.id) }, '×')))))
        : h('div.empty', 'Тут пусто. Добавь идею ниже или попроси Claude.'),
        addLine('+ идея — Enter', title => Store.add(key, ['items'], { id: uid('k'), title, desc: '', mode: fm === 'all' ? 'any' : fm, cool: 1, speed: 2, fresh: '', src: '', status: 'new', by: 'me', created: Date.now() }), 'bank|add')));
  },

  // news sites -> fresh ideas on a timer (ideas_api.auto_tick, while the script window is open)
  autoNews(b) {
    const key = 'bank', A = b.auto || {}, srcs = b.sources || [];
    const opt = list => list.map(n => ({ value: String(n), label: String(n) }));
    return h('section.card',
      h('div.card-head', h('h3', '📰 Автообновление из новостей'),
        h('label.row', h('input', { type: 'checkbox', checked: !!A.on, onchange: e => Store.set(key, ['auto', 'on'], e.target.checked, true) }), 'включено'),
        h('span.row', 'каждые', sel(opt([3, 6, 12, 24, 48]), String(A.hours || 12), v => Store.set(key, ['auto', 'hours'], Number(v), true), { class: 'box' }), 'ч'),
        h('span.row', 'по', sel(opt([3, 5, 10]), String(A.n || 5), v => Store.set(key, ['auto', 'n'], Number(v), true), { class: 'box' }), 'идей'),
        h('span.sp'),
        Claude.btn({ label: 'Обновить сейчас', action: 'bank', key, scope: 'auto', params: () => ({ auto: true, n: A.n || 5 }) })),
      h('p.dim', A.last ? `Последнее обновление: ${new Date(A.last).toLocaleString('ru-RU')}${A.summary ? ' — ' + A.summary : ''}. ` : 'Ещё не запускалось. ',
        'Claude открывает эти сайты, находит самые обсуждаемые новости последних дней и добавляет в банк подходящие каналу идеи с пометкой 📰. ',
        'Работает, пока открыто окно «Штурм идей.bat»; если компьютер был выключен, обновится через минуту после запуска. Один прогон — 1–3 минуты.'),
      srcs.map(s => h('div.row', { style: { margin: '3px 0' } },
        line(key, ['sources', s.id, 'url'], { cls: 'box', ph: 'https://…' }),
        line(key, ['sources', s.id, 'note'], { cls: 'box', ph: 'что там брать (необязательно): «только игры», «раздел Tech»…' }),
        /^https?:/.test(s.url || '') && h('a', { href: s.url, target: '_blank', rel: 'noopener' }, '🔗'),
        h('button.icon.del', { title: 'Убрать сайт', onclick: () => Store.del(key, ['sources'], s.id) }, '×'))),
      !srcs.length && h('p.dim', 'Сайтов пока нет — тогда Claude ищет новости по тематике канала сам.'),
      addLine('+ сайт с новостями: ссылка — Enter', url => Store.add(key, ['sources'], { id: uid('s'), url, note: '' }), 'bank|addsrc'));
  },

  // ---------------- лист проекта ----------------
  brand() {
    const key = 'brand', b = Store.get(key);
    const f = (path, label, ph) => h('div.q', h('label', label), area(key, path, { ph }));
    return h('div',
      h('div.phead', h('h1', '📋 Лист проекта')),
      hint('brand', `<p>Всё про канал: что несём зрителю, чем отличаемся, главная фишка и чего не делаем никогда. Если можешь коротко и чётко объяснить, о чём канал, зритель тоже это считает — и запомнит. Иначе выйдет ещё один безликий канал из тех, что видел у конкурентов.</p>
<p>Проговори это вслух: другу, родственнику или себе на запись — и послушай со стороны. Claude опирается на этот лист в каждой кнопке ✨. План по часам помогает выходить регулярно; в «Итогах» каждого ролика его сравнишь с тем, сколько вышло на самом деле.</p>`),
      h('section.card', h('div.q', h('label', 'Название проекта'), line(key, ['name'], { ph: 'канал', cls: 'box' })),
        h('div', { style: { marginTop: '10px' } }, h('label', h('b', 'Участники (имя — роль)')),
          (b.team || []).map(t => h('div.row', { style: { margin: '4px 0' } }, line(key, ['team', t.id, 'name'], { ph: 'имя', cls: 'box' }), '—', line(key, ['team', t.id, 'role'], { ph: 'роль', cls: 'box' }),
            h('button.icon.del', { onclick: () => Store.del(key, ['team'], t.id) }, '×'))),
          addLine('+ участник: имя — роль — Enter', t => { const [n, ...r] = t.split(/[—-]/); Store.add(key, ['team'], { id: uid('p'), name: n.trim(), role: r.join('—').trim() }); }, 'brand|team'))),
      h('section.card', h('div.q7', f(['bring'], 'Что мы несём зрителям?', 'польза, эмоция, картина мира…'), f(['differ'], 'Чем отличаемся от конкурентов?', '…'),
        f(['killer'], 'Наша убийственная фишка', '…'), f(['never'], 'Чего не делаем ни в коем случае?', '…'), f(['ritual'], 'Наш ритуал перед стартом', 'как команда заряжается перед роликом'))),
      h('section.card', h('h3', 'План по часам на один ролик'), h('p.dim', 'Пусто — берётся значение по умолчанию (серым).'),
        h('table.grid', h('tr', h('th', 'Этап'), h('th', '⚡ Шортс, ч'), h('th', '🎬 Длинное, ч')),
          REF.stages.map(s => h('tr', h('td', s.label), h('td.num', line(key, ['hours', s.key, 'short'], { type: 'number', num: true, ph: String(s.short), cls: 'box' })),
            h('td.num', line(key, ['hours', s.key, 'long'], { type: 'number', num: true, ph: String(s.long), cls: 'box' })))))),
      h('p.philo', 'Мы ручаемся по мере сил регулярно делать лучшие видео для нашего зрителя. ', (b.team || []).map(t => t.name).filter(Boolean).join(', ')));
  },

  // ---------------- просмотры ----------------
  stats() {
    const key = 'stats', s = Store.get(key);
    const table = mode => {
      const rows = s.items.filter(r => (r.mode || 'short') === mode), cols = [...REF.views, ...REF.viewsExtra[mode]];
      return h('section.card',
        h('div.card-head', h('h3', `${REF.modes[mode].icon} ${REF.modes[mode].label}`), h('span.counter', `${rows.length} ${plural(rows.length, 'ролик', 'ролика', 'роликов')}`)),
        rows.length ? h('div.scrollx', h('table.grid.stats', h('tr', h('th', '#'), h('th', 'Ролик'), h('th', 'Вышел'), h('th', 'Офигенно?'), cols.map(c => h('th', c.label)), h('th')),
          rows.map((r, n) => h('tr', h('td', n + 1),
            h('td', line(key, ['items', r.id, 'name'], { cls: 'box' }), h('div.row', r.plan && h('a', { href: `#/p/${r.plan}`, style: { fontSize: '12px' } }, 'штурм'),
              /^https?:/.test(r.url || '') && h('a', { href: r.url, target: '_blank', rel: 'noopener', style: { fontSize: '12px' } }, 'ролик'))),
            h('td', line(key, ['items', r.id, 'date'], { type: 'date', cls: 'box' })),
            h('td', sel([{ value: '', label: '—' }, { value: 'Да', label: 'да' }, { value: 'Средне', label: 'средне' }, { value: 'Нет', label: 'нет' }], r.awesome || '', v => Store.set(key, ['items', r.id, 'awesome'], v, true), { class: 'box' })),
            cols.map(c => h('td.num', line(key, ['items', r.id, c.key], { cls: 'box' }))),
            h('td', h('button.icon.del', { title: 'Удалить строку', onclick: () => confirm('Удалить строку?') && Store.del(key, ['items'], r.id) }, '×'))))))
          : h('p.dim', 'Строки появятся, когда отметишь ролик «вышел» в его штурме, — или добавь вручную.'),
        addLine('+ ролик вручную — Enter', name => Store.add(key, ['items'], { id: uid('r'), name, mode, date: '', awesome: '' }), 'stats|add' + mode),
        h('h3', { style: { margin: '14px 0 6px' } }, 'Выводы'),
        h('div.concl', REF.checkpoints.map(cp => h('div', { class: rows.length >= Number(cp) ? '' : 'off' },
          h('div.card-head', h('b', `После ${cp}-го ролика`), h('span.sp'),
            Claude.btn({ label: 'Выводы', action: 'conclusions', key, scope: `concl:${mode}:${cp}`, params: { mode, cp }, cls: 'mini',
              onResult: (r, job) => { if (/уже написан/.test(job.summary || '')) UI.modal('Вариант Claude', h('div', h('ul', (r.points || []).map(p => h('li', p))), h('p', 'Вывод: ' + r.verdict))); } })),
          area(key, ['conclusions', mode, cp], { ph: 'зря или не зря, что меняем…' })))));
    };
    return h('div',
      h('div.phead', h('h1', '📈 Трекер просмотров'), h('span.sp'), h('button', { onclick: () => Pages.importProjects() }, '➕ Готовые ролики из рабочей папки')),
      Pages.youtube(s),
      hint('stats', `<p>Заполняй после каждого выхода — нельзя терять общую картину. «Офигенно?» — это твоя оценка ДО прихода цифр. Выводы делай после 1-го, 3-го, 5-го и 10-го ролика: к пятому уже видно, работает ли гипотеза.</p>
<p>Всё мимо — закрываем гипотезу и берём следующую. Туговато, но есть надежда — корректируемся и едем дальше. Туго и после десятого — сворачиваем и не тратим силы. Что считать «хорошо» и «плохо», у каждого проекта своё.</p>
<p class="dim">Вопросы для выводов: ${REF.statsQ.join(' · ')}</p>`),
      table('short'), table('long'));
  },

  // YouTube Data + Analytics API (youtube.py): login once, then sync by hand or every 6 h
  youtube(s) {
    const st = App.info.yt || {}, yt = s.yt || {};
    const after = () => App.refreshState().then(() => App.render());
    let body;
    if (!st.client) body = [h('p', 'Чтобы цифры подтягивались сами, нужен ключ Google: положи файл ', h('code', 'youtube_client.json'), ' в папку ', h('code', '_ideas'),
      ' (инструкция — в чате у Claude: проект в Google Cloud → YouTube Data API v3 + YouTube Analytics API → OAuth-клиент «Desktop app»).'),
      h('button', { onclick: after }, '🔄 Я положил файл')];
    else if (!st.token) body = [h('p', 'Ключ на месте. Войди в Google-аккаунт канала и разреши доступ только на чтение — откроется окно браузера. «Приложение не проверено» → «Дополнительно» → «Перейти».'),
      Claude.btn({ label: 'Войти в Google', icon: '🔑', action: 'ytlogin', key: 'stats', scope: 'ytlogin', noClaude: true, onResult: after })];
    else body = [h('div.row',
        h('span', '✅ Подключено', yt.channel ? h('b', ' — «' + yt.channel + '»') : ''),
        h('span.dim', yt.last ? '· обновлено ' + new Date(yt.last).toLocaleString('ru-RU') : '· ещё не обновлялось'),
        h('span.sp'),
        Claude.btn({ label: 'Подтянуть из YouTube', icon: '📥', action: 'ytsync', key: 'stats', scope: 'ytsync', noClaude: true }),
        Claude.btn({ label: 'Войти заново', icon: '🔑', action: 'ytlogin', key: 'stats', scope: 'ytlogin', noClaude: true, cls: 'ghost', onResult: after })),
      yt.summary && h('p.dim', yt.summary),
      h('p.dim', 'Обновляется само раз в 6 часов, пока открыто окно «Штурм идей.bat». Analytics отдаёт данные с задержкой 2–3 дня и по дням: «сутки» ≈ день выхода и следующий, «1 час» и CTR превью API не даёт — их вписывай руками. Новые ролики канала добавляются строками сами.')];
    return h('section.card', h('div.card-head', h('h3', '▶ YouTube')), body);
  },

  async importProjects() {
    let list = [];
    try { list = await api('GET', '/api/projects'); } catch (e) { return UI.toast(e.message, 'err'); }
    const s = Store.get('stats'), have = new Set(s.items.map(r => r.project || r.name));
    list = list.filter(p => p.video && !have.has(p.name));
    if (!list.length) return UI.toast('Все собранные ролики уже в трекере');
    const picked = new Set(list.map(p => p.name));
    const close = UI.modal('Готовые ролики из рабочей папки', h('div',
      h('p.dim', 'Отметь те, что уже вышли. Цифры заполнишь потом, по YouTube Studio.'),
      h('div.pick', list.map(p => h('label', h('input', { type: 'checkbox', checked: true, onchange: e => (e.target.checked ? picked.add(p.name) : picked.delete(p.name)) }),
        h('b.grow', p.name), h('span.dim', 'собран ' + fmtDate(p.built))))),
      h('div.row', { style: { marginTop: '10px' } }, h('span.sp'), h('button.primary', { onclick: () => {
        for (const p of list.filter(x => picked.has(x.name)))
          Store.add('stats', ['items'], { id: uid('r'), name: p.name, project: p.name, mode: 'short', date: new Date(p.built).toISOString().slice(0, 10), awesome: '' }, false);
        close(); App.render();
      } }, 'Добавить'))));
  },

  // ---------------- справочник ----------------
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
