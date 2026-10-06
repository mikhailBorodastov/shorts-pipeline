// Claude Studio — «📈 YouTube» (S17, docs/studio/stage17-youtube.md, макет — stage17-youtube-mockup.html).
// Канал Studio привязан к одному YouTube-каналу: цифры по дням, ролики, удержание с полосами сцен, комментарии;
// Claude разбирает ролики (сам на вехах 3 и 28 дней или «✨ Разобрать») и предлагает уроки в «Память» («✨ Спросить Claude»).
'use strict';

const YT = { data: null, at: 0, busy: false, per: +(Local.get('yt-per') || 28), typ: Local.get('yt-typ') || 'all', metric: 'views',
  mode: 'total', sort: 'published', dir: -1, q: '', open: null, det: {}, detBusy: {}, ask: '' };
const YT_TRAFFIC = { SHORTS: 'Лента Shorts', SUBSCRIBER: 'Главная и подписки', BROWSE: 'Главная и подписки', YT_SEARCH: 'Поиск YouTube', YT_CHANNEL: 'Страница канала',
  EXT_URL: 'Внешние сайты', RELATED_VIDEO: 'Предложенные', YT_OTHER_PAGE: 'Другие страницы YouTube', NO_LINK_OTHER: 'Прямые и неизвестные', PLAYLIST: 'Плейлисты',
  YT_PLAYLIST_PAGE: 'Плейлисты', NOTIFICATION: 'Уведомления', END_SCREEN: 'Конечные заставки', HASHTAGS: 'Хэштеги', SOUND_PAGE: 'Страница звука', CAMPAIGN_CARD: 'Кампании' };

const ytNum = n => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
const ytDec = (n, d = 1) => n == null ? '—' : (+n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
const ytDur = s => { s = Math.round(s || 0); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ytDay = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
const ytAgo = ms => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'только что' : m < 60 ? m + ' мин назад' : m < 1440 ? Math.round(m / 60) + ' ч назад' : Math.round(m / 1440) + ' дн назад'; };
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(html, vb, cls) { const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', vb); s.setAttribute('preserveAspectRatio', 'none'); if (cls) s.setAttribute('class', cls); s.innerHTML = html; return s; }

const YTPage = {
  async load() {
    if (YT.busy) return; YT.busy = true;
    try { YT.data = await api('GET', '/api/yt'); YT.at = Date.now(); YT.err = null; }
    catch (e) { YT.err = e.message; YT.data = YT.data || {}; }
    finally { YT.busy = false; }
    App.render();
  },
  newCount() { return ((YT.data || {}).lessons || []).filter(x => x.status === 'new').length; },
  syncing() { return !!(YT.data || {}).syncing; },
  set(k, v, save) { YT[k] = v; if (save) Local.set(save, String(v)); App.render(); },

  // ---------------- агрегаты по дням ----------------
  dayOf(d) {
    if (YT.typ === 'all') return d;
    const x = d[YT.typ] || {};
    return { d: d.d, views: x.views || 0, minutes: x.minutes || 0, avgDur: x.avgDur || 0, avgPct: x.avgPct || 0, engaged: x.engaged || 0, subsG: d.subsG, subsL: d.subsL };
  },
  agg(days) {
    const v = days.reduce((s, d) => s + d.views, 0) || 0, w = v || 1;
    return { views: v, hours: days.reduce((s, d) => s + d.minutes, 0) / 60, subs: days.reduce((s, d) => s + (d.subsG || 0) - (d.subsL || 0), 0),
      avgDur: days.reduce((s, d) => s + d.avgDur * d.views, 0) / w, avgPct: days.reduce((s, d) => s + d.avgPct * d.views, 0) / w,
      engaged: v ? 100 * days.reduce((s, d) => s + (d.engaged || 0), 0) / v : null };
  },
  periods() {
    const all = ((YT.data || {}).days || []).map(d => this.dayOf(d)), n = YT.per;
    const cur = all.slice(-n), prev = all.slice(-2 * n, -n);
    return { cur, prev, A: this.agg(cur), B: this.agg(prev) };
  },

  // ---------------- страница ----------------
  page() {
    if (!YT.data || (Date.now() - YT.at > (this.syncing() ? 4000 : 60000))) this.load();
    const D = YT.data;
    if (!D) return h('div.page.yt-page', h('p.dim', h('span.spin'), ' загружаю…'));
    if (!D.youtube) return this.connect(D);
    const y = D.youtube, info = D.info || {};
    return h('div.page.yt-page',
      h('div.yt-head',
        y.thumb ? h('img.yt-ava', { src: y.thumb, alt: '' }) : h('div.yt-ava', '▶'),
        h('div.grow',
          h('h1', y.title || 'YouTube'),
          h('div.yt-sub', h('span', [y.handle, info.subs != null && `${ytNum(info.subs)} ${plural(info.subs, 'подписчик', 'подписчика', 'подписчиков')}`, info.videos != null && `${info.videos} ${plural(info.videos, 'ролик', 'ролика', 'роликов')}`].filter(Boolean).join(' · ')),
            h('a', { href: 'https://studio.youtube.com/channel/' + y.id + '/analytics', target: '_blank', rel: 'noopener' }, 'YouTube Studio ↗'),
            h('span.yt-chip.linked', { title: 'Канал Studio, к которому привязан этот YouTube-канал' }, '🔗 ', D.channel.icon || '', ' ', D.channel.name))),
        h('span.dim.small', this.syncing() ? h('span', h('span.spin'), ' обновляю…') : D.at ? 'обновлено ' + ytAgo(D.at) : ''),
        h('button', { disabled: this.syncing(), onclick: () => api('POST', '/api/yt/sync').then(() => this.load()).catch(e => UI.toast(e.message, 'err')) }, '🔄 Обновить'),
        h('button.icon', { title: 'Ещё', onclick: e => this.more(e) }, '⋯')),
      (D.error || D.login === false) && h('div.yt-warn', '⚠ ', h('b', 'Не всё удалось прочитать. '), D.login === false ? 'К этому YouTube-каналу нет входа в Google. ' : '', D.error || '',
        ' ', Claude.btn({ label: 'Войти через Google', action: 'ytlogin', key: 'yt:login', scope: 'ytlogin', noClaude: true, icon: '🔑', onResult: () => this.load() })),
      !D.days || !D.days.length ? h('div.yt-card.empty', this.syncing() ? [h('span.spin'), ' Первое обновление: канал, ролики и аналитика за полгода — около минуты…'] : 'Данных пока нет — нажмите «Обновить».')
        : [this.filters(D), this.kpis(), this.chart(D),
          h('div.yt-two', this.lessons(D), this.comments(D)),
          this.table(D)],
      YT.open && this.card(D));
  },

  more(e) {
    const D = YT.data, y = D.youtube;
    Menu.open(e.currentTarget, [
      { label: '🔄 Сменить YouTube-канал…', run: () => this.pickChannel() },
      { label: '🔑 Войти в Google заново', run: () => Claude.run({ action: 'ytlogin', key: 'yt:login', scope: 'ytlogin', onResult: () => this.load() }) },
      { label: '⛓ Отвязать от канала Studio', run: () => confirm('Отвязать YouTube-канал? Цифры останутся в кэше, привязки роликов — в видео.') && api('POST', '/api/yt/unlink').then(() => this.load()) },
      { label: '🚪 Выйти из Google', run: () => confirm('Удалить вход в Google для этого канала?') && api('POST', '/api/yt/logout', { ucid: y.id }).then(() => this.load()) },
    ]);
  },
  async pickChannel() {
    let list = [];
    try { list = await api('GET', '/api/yt/channels'); } catch (e) { return UI.toast(e.message, 'err'); }
    const close = UI.modal('YouTube-канал для «' + (YT.data.channel.name || '') + '»', h('div.yt-pick',
      list.length ? list.map(c => h('div.yt-pick-row', c.thumb ? h('img.yt-ava.sm', { src: c.thumb, alt: '' }) : h('div.yt-ava.sm', '▶'),
        h('div.grow', h('b', c.title), h('div.dim.small', [c.handle, c.subs != null && ytNum(c.subs) + ' подп.', c.error].filter(Boolean).join(' · '))),
        h('button.primary', { onclick: () => api('POST', '/api/yt/select', { ucid: c.id }).then(() => { close(); YT.data = null; this.load(); }).catch(e => UI.toast(e.message, 'err')) }, 'Привязать')))
        : h('p.dim', 'Входов пока нет.'),
      h('div.yt-pick-foot', Claude.btn({ label: 'Войти в другой аккаунт Google', action: 'ytlogin', key: 'yt:login', scope: 'ytlogin', noClaude: true, icon: '🔑', onResult: () => { close(); this.load(); } }))));
  },

  connect(D) {
    const ta = h('textarea.box', { rows: 4, placeholder: '{"installed":{"client_id":"…","client_secret":"…"}}' });
    return h('div.page.yt-page',
      h('div.page-head', h('h1', 'YouTube')),
      h('div.yt-card.yt-connect',
        h('h2', 'Подключите YouTube-канал'),
        h('p.dim', `Просмотры, удержание по секундам, «смотрели / пролистали», откуда пришли зрители и комментарии — прямо в Studio. Claude разбирает ролики и складывает уроки в «Память». Доступ только на чтение.`),
        D.tokens && D.tokens.length ? [h('p', 'Вход в Google уже есть — выберите канал для «', D.channel.name, '»:'), h('button.primary', { onclick: () => this.pickChannel() }, 'Выбрать YouTube-канал')]
          : !D.client ? [
            h('ol.yt-steps',
              h('li', 'Откройте ', h('a', { href: 'https://console.cloud.google.com/apis/credentials', target: '_blank', rel: 'noopener' }, 'Google Cloud → Credentials'), ', включите YouTube Data API v3 и YouTube Analytics API.'),
              h('li', 'Create credentials → OAuth client ID → тип «Desktop app» → Download JSON.'),
              h('li', 'Вставьте содержимое файла сюда:')),
            ta, h('div.row', h('button.primary', { onclick: () => api('POST', '/api/yt/client', { json: ta.value }).then(() => this.load()).catch(e => UI.toast(e.message, 'err')) }, 'Сохранить клиента'))]
            : Claude.btn({ label: 'Войти через Google', action: 'ytlogin', key: 'yt:login', scope: 'ytlogin', noClaude: true, icon: '🔑', title: 'Откроется браузер со входом Google (только чтение)', onResult: () => this.load() }),
        D.error && h('p.yt-err', D.error)));
  },

  filters(D) {
    const seg = (cur, opts, k, save) => h('div.seg', opts.map(([v, l]) => h('button', { class: cur === v ? 'sel' : '', onclick: () => this.set(k, v, save) }, l)));
    const last = D.last;
    return h('div.yt-filters',
      seg(YT.per, [[7, '7 дней'], [28, '28 дней'], [90, '90 дней']], 'per', 'yt-per'),
      seg(YT.typ, [['all', 'Всё'], ['short', 'Шорты'], ['long', 'Длинные']], 'typ', 'yt-typ'),
      h('span.dim.small', `по ${ytDay(last)}, сравнение с ${YT.per} ${plural(YT.per, 'днём', 'днями', 'днями')} до этого · Analytics отстаёт на 2–3 дня`));
  },

  kpis() {
    const { cur, A, B } = this.periods();
    const dl = (a, b) => { if (!b) return a ? h('span.yt-delta', 'новое') : null; const p = 100 * (a - b) / Math.abs(b); return h('span.yt-delta', { class: p < 0 ? 'neg' : '' }, (p < 0 ? '↓ ' : '↑ ') + ytDec(Math.abs(p), Math.abs(p) >= 100 ? 0 : 1) + ' %'); };
    const spark = key => {
      const vals = cur.map(d => key === 'hours' ? d.minutes / 60 : key === 'subs' ? (d.subsG || 0) - (d.subsL || 0) : key === 'eng' ? (d.views ? 100 * (d.engaged || 0) / d.views : 0) : key === 'dur' ? d.avgDur : d.views);
      const mx = Math.max(...vals, 1), mn = Math.min(...vals, 0), n = Math.max(1, vals.length - 1);
      return svgEl(`<polyline points="${vals.map((v, i) => `${(i / n * 120).toFixed(1)},${(36 - (v - mn) / (mx - mn || 1) * 32).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--yt-line)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`, '0 0 120 40', 'yt-spark');
    };
    const card = (icon, lab, val, delta, sub, key) => h('div.yt-kpi', h('div.yt-kpi-l', Icon(icon, 14), lab), h('div.yt-kpi-v', val), spark(key), h('div.yt-kpi-s', delta, sub && h('span.dim', sub)));
    const shorts = YT.typ === 'short';
    return h('div.yt-kpis',
      card('eye', 'Просмотры', ytNum(A.views), dl(A.views, B.views), null, 'views'),
      card('clock', 'Часы просмотра', ytDec(A.hours), dl(A.hours, B.hours), null, 'hours'),
      card('users', 'Подписчики', (A.subs >= 0 ? '+' : '') + ytNum(A.subs), dl(A.subs, B.subs), YT.typ === 'all' ? 'пришло минус ушло' : 'весь канал', 'subs'),
      shorts ? card('chart', 'Смотрели', A.engaged == null ? '—' : ytDec(A.engaged, 0) + ' %', B.engaged != null && A.engaged != null ? dl(A.engaged, B.engaged) : null, `не пролистали · ср. просмотр ${ytDur(A.avgDur)}`, 'eng')
        : card('chart', 'Средний просмотр', ytDur(A.avgDur), dl(A.avgDur, B.avgDur), `${ytDec(A.avgPct, 0)} % ролика` + (A.engaged != null && YT.typ !== 'long' ? ` · смотрели ${ytDec(A.engaged, 0)} %` : ''), 'dur'));
  },

  chart(D) {
    const { cur, prev } = this.periods();
    const M = YT.metric, val = d => M === 'hours' ? d.minutes / 60 : M === 'subs' ? (d.subsG || 0) - (d.subsL || 0) : d.views;
    const W = 1000, H = 210, X0 = 44, n = Math.max(1, cur.length - 1);
    const a = cur.map(val), b = prev.map(val);
    const mx0 = Math.max(...a, ...b, M === 'subs' ? 2 : 4), mn = Math.min(0, ...a, ...b);
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000, 100000].find(s => mx0 / s <= 4) || Math.ceil(mx0 / 4);
    const mx = Math.ceil(mx0 / step) * step;
    const sx = i => X0 + i / n * (W - X0 - 8), sy = v => 8 + (H - 16) * (1 - (v - mn) / (mx - mn || 1));
    let g = '';
    for (let v = Math.ceil(mn / step) * step; v <= mx; v += step) g += `<line x1="${X0}" x2="${W}" y1="${sy(v)}" y2="${sy(v)}" class="yt-grid"/><text x="${X0 - 8}" y="${sy(v) + 4}" text-anchor="end" class="yt-ax">${ytNum(v)}</text>`;
    const pts = arr => arr.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    if (a.length) g += `<polygon points="${sx(0)},${sy(Math.max(0, mn))} ${pts(a)} ${sx(a.length - 1)},${sy(Math.max(0, mn))}" class="yt-area"/>`;
    if (b.length === a.length && b.length) g += `<polyline points="${pts(b)}" class="yt-prev"/>`;
    g += `<polyline points="${pts(a)}" class="yt-cur"/>`;
    const idx = Object.fromEntries(cur.map((d, i) => [d.d, i]));
    const pubs = {};
    for (const v of D.videos || []) if (idx[v.published] != null && (YT.typ === 'all' || v.type === YT.typ)) (pubs[v.published] = pubs[v.published] || []).push(v.title);
    for (const [d, ts] of Object.entries(pubs)) g += `<g class="yt-pub"><title>${esc(ytDay(d) + ': ' + ts.join(' · '))}</title><path d="M${sx(idx[d]) - 6},${H + 14} l6,-9 l6,9 z"/></g>`;
    const lbl = 5;
    for (let k = 0; k < lbl && cur.length; k++) { const i = Math.round(k / (lbl - 1) * n); g += `<text x="${sx(i)}" y="${H + 30}" text-anchor="${k === 0 ? 'start' : k === lbl - 1 ? 'end' : 'middle'}" class="yt-ax">${esc(ytDay((cur[i] || {}).d))}</text>`; }
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H + 36}`); svg.setAttribute('class', 'yt-chart'); svg.innerHTML = g;
    const title = { views: 'Просмотры по дням', hours: 'Часы просмотра по дням', subs: 'Подписчики по дням' }[M];
    return h('div.yt-card',
      h('div.yt-ch', h('h3', title), h('span.sp'),
        h('div.seg', [['views', 'Просмотры'], ['hours', 'Часы'], ['subs', 'Подписчики']].map(([k, l]) => h('button', { class: M === k ? 'sel' : '', onclick: () => this.set('metric', k) }, l)))),
      h('div.yt-legend', h('span', h('i.l-cur'), `последние ${YT.per} дн.`), h('span', h('i.l-prev'), `${YT.per} дн. до этого`), h('span', h('i.l-pub'), 'вышел ролик')),
      svg);
  },

  lessons(D) {
    const L = D.lessons || [], ck = 'channel:' + D.channel.id;
    const inp = h('input.box', { placeholder: 'Свой урок…', key: 'yt|lesson', onkeydown: e => { if (e.key === 'Enter') add(); } });
    const add = () => { const t = inp.value.trim(); if (!t) return; api('POST', '/api/yt/lesson', { text: t }).then(() => { UI.toast('Урок добавлен в «Память»'); this.load(); }).catch(e => UI.toast(e.message, 'err')); };
    const op = (body, msg) => api('POST', '/api/memory/op', body).then(() => { if (msg) UI.toast(msg); this.load(); if (window.Memory) Memory.load(); }).catch(e => UI.toast(e.message, 'err'));
    return h('div.yt-card',
      h('div.yt-ch', h('h3', '💡 Что работает'), h('span.sp'),
        Claude.btn({ label: 'Спросить Claude', action: 'ytlearn', key: ck, scope: 'ytlearn', title: 'Claude (Sonnet) сравнит все ролики — темы, хуки, длину, удержание — и предложит 3–5 уроков с цифрами', onResult: () => this.load() })),
      h('p.dim.small', 'Уроки из статистики. Принятые лежат в ', h('a', { href: '#/memory' }, '«Памяти»'), ' — их учитывают сценарист и все кнопки ✨.'),
      L.length ? L.sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || (b.created || 0) - (a.created || 0)).map(r => h('div.yt-lesson', { class: r.status },
        h('div.yt-lesson-h', h('span.yt-tag', r.status === 'new' ? '📊 новое · из статистики' : '📊 из статистики · ' + (r.by === 'author' ? 'ваш' : 'принято')), h('span.sp'),
          r.status === 'new' && [h('button.small.primary', { onclick: () => op({ op: 'set', id: r.id, rule: { status: 'on' } }, '✓ Урок принят — Claude будет его учитывать') }, '✓ Принять'),
            h('button.small', { onclick: () => go('#/memory') }, 'Поправить'),
            h('button.icon.small', { title: 'Отклонить', onclick: () => op({ op: 'del', id: r.id }, 'Отклонено') }, '✕')]),
        h('div', r.text), r.why && h('div.yt-why', r.why)))
        : h('p.dim.small.yt-none', 'Уроков пока нет. Claude предложит их сам после разборов роликов — или нажмите «Спросить Claude».'),
      h('div.yt-add', inp, h('button', { onclick: add }, 'Добавить')));
  },

  comments(D) {
    const C = (D.comments || []).slice(0, 8), I = D.ideas || [];
    return h('div.yt-card',
      h('div.yt-ch', h('h3', '💬 Свежие комментарии')),
      C.length ? C.map(c => h('div.yt-cm', h('div.yt-cm-h', h('b', c.author), ' · ', c.ts ? fmtDate(c.ts) : '', c.likes ? ` · ♥ ${c.likes}` : ''),
        h('div', c.text), h('a.yt-cm-on', { onclick: () => this.openVideo(c.yt) }, 'к «' + c.title.replace(/#\S+/g, '').trim().slice(0, 60) + '»')))
        : h('p.dim.small', 'Комментариев пока нет (они читаются через yt-dlp у роликов, где счётчик изменился).'),
      I.length > 0 && h('div.yt-ideas', h('b.small', '💡 Идеи из комментариев'),
        I.map(i => h('div.yt-idea', h('div.grow', h('div', i.title), i.why && h('div.yt-why', i.why), i.comment && h('div.yt-why', '«' + i.comment.slice(0, 160) + '»')),
          h('button.small', { title: 'Создать видео с этой идеей', onclick: () => api('POST', '/api/yt/idea', { id: i.id }).then(r => { App.refresh && App.refresh(); go('#/v/' + r.id); }).catch(e => UI.toast(e.message, 'err')) }, '➕ видео'),
          h('button.icon.small', { title: 'Убрать', onclick: () => api('POST', '/api/yt/idea/del', { id: i.id }).then(() => this.load()) }, '✕')))));
  },

  // ---------------- таблица роликов ----------------
  val(v, k) {
    const s = YT.mode === 'total' ? v : (v.snaps || {})[YT.mode];
    if (!s) return null;
    if (k === 'views') return s.views; if (k === 'hours') return (s.minutes || 0) / 60; if (k === 'avgPct') return s.avgPct || null;
    if (k === 'engaged') return v.type === 'short' && s.views && s.engaged ? 100 * s.engaged / s.views : null;
    if (k === 'likes') return s.likes; if (k === 'comments') return YT.mode === 'total' ? v.comments : null; if (k === 'subs') return s.subs;
    return null;
  },
  table(D) {
    const q = YT.q.toLowerCase();
    let rows = (D.videos || []).filter(v => (YT.typ === 'all' || v.type === YT.typ) && (!q || v.title.toLowerCase().includes(q)));
    const key = YT.sort, sgn = YT.dir;
    rows = rows.slice().sort((a, b) => key === 'published' ? sgn * (a.pubts - b.pubts) : sgn * ((this.val(a, key) ?? -1) - (this.val(b, key) ?? -1)));
    const th = (k, l, cls, title) => h('th', { class: (cls || '') + (YT.sort === k ? ' on' : ''), title, onclick: () => { if (YT.sort === k) YT.dir = -YT.dir; else { YT.sort = k; YT.dir = -1; } App.render(); } }, l, YT.sort === k ? (YT.dir < 0 ? ' ↓' : ' ↑') : '');
    const showEng = YT.typ !== 'long';
    const cell = (v, k, fmt) => { const x = this.val(v, k); return h('td.r', x == null ? h('span.dim', '—') : fmt ? fmt(x) : ytNum(x)); };
    return h('div.yt-card',
      h('div.yt-ch', h('h3', 'Ролики'), h('span.dim.small', `${rows.length} из ${(D.videos || []).length}`), h('span.sp'),
        h('div.seg', { title: 'Сравнить ролики на равных — за одинаковое время после выхода' }, [['total', 'Всего'], ['d3', 'За 3 дня'], ['d28', 'За 28 дней']].map(([k, l]) => h('button', { class: YT.mode === k ? 'sel' : '', onclick: () => this.set('mode', k) }, l))),
        h('input.box.yt-q', { placeholder: 'Поиск', value: YT.q, key: 'yt|q', oninput: e => { YT.q = e.target.value; clearTimeout(YT.qt); YT.qt = setTimeout(() => App.render(), 200); } })),
      h('div.yt-tw', h('table.yt-table',
        h('thead', h('tr', h('th', 'Ролик'), th('published', 'Вышел'), th('views', 'Просмотры', 'r'), th('hours', 'Часы', 'r'), th('avgPct', 'Средний %'),
          showEng && th('engaged', 'Смотрели', 'r', 'Доля зрителей шорта, которые не пролистали (engaged views)'), th('likes', 'Лайки', 'r'), th('comments', 'Комм.', 'r'), h('th', 'Видео Studio'))),
        h('tbody', rows.map(v => h('tr', { class: YT.open === v.yt ? 'on' : '', onclick: e => { if (!e.target.closest('.yt-chip')) this.openVideo(v.yt); } },
          h('td', h('div.yt-vid', h('div.yt-th', { class: v.type }, v.thumb && h('img', { src: v.thumb, alt: '', loading: 'lazy' }), h('i', ytDur(v.dur))),
            h('div.yt-vt', h('div', v.title), h('span.yt-typ', v.type === 'long' ? 'длинное' : 'шорт')))),
          h('td.dim.nw', ytDay(v.published)),
          cell(v, 'views'), cell(v, 'hours', x => ytDec(x)),
          h('td.nw', (() => { const x = this.val(v, 'avgPct'); return x == null ? h('span.dim', '—') : [h('span.yt-bar', h('b', { style: { width: Math.min(100, x) + '%' } })), ytDec(x, 0) + ' %']; })()),
          showEng && cell(v, 'engaged', x => ytDec(x, 0) + ' %'),
          cell(v, 'likes'), cell(v, 'comments'),
          h('td', this.chip(v, D))))))),
      YT.mode !== 'total' && h('p.dim.small', 'Пусто — ролик ещё не дожил до этой отметки или Analytics её не досчитал.'));
  },
  chip(v, D) {
    const sv = id => (D.studio || []).find(s => s.id === id);
    if (v.studio) return h('span.yt-chip.linked', { title: 'Привязан к видео Studio — клик: изменить', onclick: e => this.linkMenu(e, v, D) }, '🔗 ', (sv(v.studio) || {}).name || v.studio);
    if (v.guess) return h('span.yt-chip.guess', { title: `Похоже на «${v.guess.name}» (уверенность ${Math.round(v.guess.score * 100)} %) — клик: подтвердить`, onclick: e => this.linkMenu(e, v, D) }, '🔗 ', v.guess.name, ' ?');
    if (v.studio === false) return h('span.yt-chip.dim', { onclick: e => this.linkMenu(e, v, D) }, 'не из Studio');
    return h('span.yt-chip.dim', { title: 'Привязать к видео Studio', onclick: e => this.linkMenu(e, v, D) }, '—');
  },
  link(yt, video, msg) {
    return api('POST', '/api/yt/link', { yt, video }).then(() => { UI.toast(msg || 'Готово'); delete YT.det[yt]; this.load(); App.refresh && App.refresh(); }).catch(e => UI.toast(e.message, 'err'));
  },
  linkMenu(e, v, D) {
    e.stopPropagation();
    const items = [];
    if (v.guess && !v.studio) items.push({ label: `✓ Да, это «${v.guess.name}»`, run: () => this.link(v.yt, v.guess.video, 'Привязано — видео отмечено «✅ вышло»') });
    const free = (D.studio || []).filter(s => !s.yt || s.yt === v.yt);
    items.push({ label: 'Выбрать видео Studio…', sub: free.map(s => ({ label: (s.id === v.studio ? '● ' : '') + s.name, run: () => this.link(v.yt, s.id, 'Привязано — видео отмечено «✅ вышло»') })) });
    if (v.studio) items.push({ label: '⛓ Отвязать', run: () => this.link(v.yt, null, 'Отвязано') });
    if (v.studio !== false) items.push({ label: 'Не из Studio', run: () => this.link(v.yt, false, 'Больше не предлагаем') });
    else items.push({ label: 'Снова предлагать', run: () => this.link(v.yt, null, 'Ок') });
    Menu.open(e.currentTarget, items);
  },

  // ---------------- карточка ролика ----------------
  openVideo(id) { YT.open = id; YT.ask = ''; App.render(); },
  async loadDet(id, fresh) {
    if (YT.detBusy[id]) return; YT.detBusy[id] = true; App.render();
    try { YT.det[id] = await api('GET', '/api/yt/video?id=' + encodeURIComponent(id) + (fresh ? '&fresh=1' : '')); }
    catch (e) { YT.det[id] = { error: e.message }; }
    finally { YT.detBusy[id] = false; App.render(); }
  },
  card(D) {
    const id = YT.open, v0 = (D.videos || []).find(x => x.yt === id);
    if (!v0) { YT.open = null; return null; }
    const d = YT.det[id];
    if (!d && !YT.detBusy[id]) this.loadDet(id);
    const close = () => { YT.open = null; App.render(); };
    const v = d && !d.error ? d : v0;
    const short = v.type === 'short';
    const stat = (l, x) => h('div.yt-ms', h('div.yt-ms-l', l), h('div.yt-ms-v', x));
    const eng = short && v.views && v.engaged ? ytDec(100 * v.engaged / v.views, 0) + ' %' : '—';
    const studio = (D.studio || []).find(s => s.id === v.studio);
    const opts = [{ value: '', label: v0.guess && !v0.studio ? `«${v0.guess.name}» ?` : 'Не привязан' }, { value: '__no', label: 'Не из Studio' },
      ...(D.studio || []).filter(s => !s.yt || s.yt === id).map(s => ({ value: s.id, label: s.name }))];
    return h('div.yt-ov', { onclick: e => { if (e.target.classList.contains('yt-ov')) close(); } },
      h('div.yt-modal',
        h('div.yt-mh', h('b', 'Ролик'), h('span.sp'), h('button.icon', { onclick: close, title: 'Закрыть (Esc)' }, '✕')),
        h('div.yt-mtop',
          h('div.yt-mthumb', { class: v.type }, v.thumb && h('img', { src: v.thumb.replace('mqdefault', short ? 'oar2' : 'hqdefault'), alt: '', onerror: e => { e.target.src = v.thumb; } }), h('i', ytDur(v.dur))),
          h('div.grow',
            h('h2', v.title),
            h('div.dim.small', `Вышел ${ytDay(v.published)} · ${short ? 'шорт' : 'длинное'}` + (d && d.at ? ' · обновлено ' + ytAgo(d.at) : '')),
            h('div.row.yt-mbtns',
              h('a.btn', { href: 'https://youtu.be/' + id, target: '_blank', rel: 'noopener' }, '▶ На YouTube'),
              h('a.btn', { href: `https://studio.youtube.com/video/${id}/analytics/tab-overview/period-default`, target: '_blank', rel: 'noopener' }, 'YouTube Studio ↗'),
              h('button', { disabled: YT.detBusy[id], onclick: () => this.loadDet(id, true) }, YT.detBusy[id] ? h('span.spin') : '🔄', ' Обновить')),
            h('div.row.yt-link', h('span.dim.small', 'Видео Studio'),
              sel(opts, v0.studio || (v0.studio === false ? '__no' : ''), x => this.link(id, x === '__no' ? false : x || null, x ? 'Привязано' : 'Отвязано'), { class: 'box' }),
              v0.guess && !v0.studio && h('button.primary.small', { onclick: () => this.link(id, v0.guess.video, 'Привязано — видео отмечено «✅ вышло»') }, '✓ Да, это оно'),
              studio && h('a.small', { href: '#/v/' + studio.id }, 'Открыть видео →')))),
        h('div.yt-mstats', stat('Просмотры', ytNum(v.views)), stat('Часы', ytDec((v.minutes || 0) / 60)), stat('Средний просмотр', ytDur(v.avgDur)),
          stat('Средний %', v.avgPct ? ytDec(v.avgPct, 1) + ' %' : '—'), short && stat('Смотрели', eng), stat('Лайки', ytNum(v.likes)), stat('Комментарии', ytNum(v.comments)), stat('Подписчики', '+' + ytNum(v.subs || 0))),
        !d ? h('p.dim', h('span.spin'), ' читаю удержание, источники и комментарии…')
          : d.error ? h('p.yt-err', d.error)
            : [this.retention(d), h('div.yt-two', this.traffic(d), this.vcomments(d)), this.review(d, D)]));
  },
  retention(d) {
    const R = d.retention || [];
    if (!R.length) return h('div.yt-card', h('h3', 'Удержание'), h('p.dim.small', d.retErr ? 'YouTube не отдал удержание: ' + d.retErr : 'Удержание появится, когда у ролика наберётся достаточно просмотров (Analytics досчитывает 2–3 дня).'));
    const W = 1000, H = 220, X0 = 44, dur = d.dur || 1;
    const top = Math.max(100, ...R.map(p => p.watch));
    const step = top > 150 ? 50 : 25, mx = Math.ceil(top / step) * step;
    const sx = x => X0 + x * (W - X0 - 8), sy = y => 8 + (H - 16) * (1 - y / mx);
    const at = x => { const p = R.reduce((b, p) => Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b, R[0]); return Math.round(p.watch); };
    let g = '';
    for (let y = 0; y <= mx; y += step) g += `<line x1="${X0}" x2="${W}" y1="${sy(y)}" y2="${sy(y)}" class="yt-grid"/><text x="${X0 - 8}" y="${sy(y) + 4}" text-anchor="end" class="yt-ax">${y}%</text>`;
    const pts = R.map(p => `${sx(p.x).toFixed(1)},${sy(p.watch).toFixed(1)}`).join(' ');
    g += `<polygon points="${sx(R[0].x)},${sy(0)} ${pts} ${sx(R[R.length - 1].x)},${sy(0)}" class="yt-rarea"/><polyline points="${pts}" class="yt-rline"/>`;
    for (const x of d.drops || []) g += `<line x1="${sx(x.x)}" x2="${sx(x.x)}" y1="8" y2="${H - 8}" class="yt-drop"/><text x="${sx(x.x) + 5}" y="22" class="yt-dropt">−${ytDec(x.pct, 0)}</text>`;
    for (let k = 0; k <= 4; k++) g += `<text x="${sx(k / 4)}" y="${H + 14}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}" class="yt-ax">${ytDur(dur * k / 4)}</text>`;
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H + 20}`); svg.setAttribute('class', 'yt-chart'); svg.innerHTML = g;
    const sc = d.scenes || [];
    const rev = this.lastReview(d);
    const why = t => ((rev && rev.drops) || []).reduce((b, x) => !b || Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b, null);
    return h('div.yt-card',
      h('div.yt-ch', h('h3', 'Удержание'),
        h('span.small.dim', 'через 3 с — ', h('b', at(3 / dur) + ' %'), ' · середина — ', h('b', at(0.5) + ' %'), ' · конец — ', h('b', at(0.99) + ' %')),
        h('span.sp'), d.rel != null && h('span.small.dim', { title: 'relativeRetentionPerformance: место среди роликов такой же длины на YouTube (0,5 — типично)' },
          `относительно роликов такой длины: ${d.rel >= 0.55 ? 'выше обычного' : d.rel <= 0.45 ? 'ниже обычного' : 'как обычно'} (${ytDec(d.rel, 2)})`)),
      h('p.dim.small.yt-rnote', 'Больше 100 % — зрители пересматривают (у шортов ролик крутится по кругу).'),
      svg,
      sc.length ? h('div.yt-scenes', { style: { marginLeft: (X0 / W * 100) + '%', width: ((W - X0 - 8) / W * 100) + '%' } },
        sc.map(s => h('div', { style: { left: (100 * s.t0 / dur) + '%', width: (100 * Math.max(0, Math.min(dur, s.t1) - s.t0) / dur) + '%' }, title: `${ytDur(s.t0)}–${ytDur(s.t1)} ${s.name}` }, s.name)))
        : h('p.dim.small', d.studio ? 'У видео Studio нет таймингов голоса (src/vo_timing.js) — сцен не видно.' : 'Привяжите ролик к видео Studio — под кривой появятся сцены сценария.'),
      (d.drops || []).length > 0 && h('div.yt-drops', h('b.small', 'Спады'),
        d.drops.map(x => { const w = why(x.t); return h('div.yt-dropr', h('span.yt-dropv', '−' + ytDec(x.pct, 0) + ' п.п.'), h('span.nw', ytDur(x.t)), x.scene && h('span', '«' + x.scene + '»'), x.words && h('span.dim', '«…' + x.words + '…»'), w && h('span.yt-dropw', '— ' + w.why)); })));
  },
  traffic(d) {
    const T = d.traffic || [], tot = T.reduce((s, t) => s + t.views, 0) || 1, mx = Math.max(...T.map(t => t.views), 1);
    return h('div.yt-card', h('h3', 'Откуда пришли зрители'),
      T.length ? T.slice(0, 8).map(t => h('div.yt-src', h('span', YT_TRAFFIC[t.src] || t.src), h('span.yt-srcb', h('b', { style: { width: (100 * t.views / mx) + '%' } })), h('span.r', ytNum(t.views)), h('span.r.dim', Math.round(100 * t.views / tot) + ' %')))
        : h('p.dim.small', 'Пока нет данных.'));
  },
  vcomments(d) {
    const C = (d.commentList || []).filter(c => !c.reply);
    return h('div.yt-card', h('h3', `Комментарии · ${ytNum(d.comments)}`),
      C.length ? h('div.yt-vcm', C.slice(0, 20).map(c => h('div.yt-cm', h('div.yt-cm-h', h('b', c.author), c.ts ? ' · ' + fmtDate(c.ts) : '', c.likes ? ` · ♥ ${c.likes}` : '', c.mine ? ' · вы' : ''), h('div', c.text))))
        : h('p.dim.small', 'Комментариев пока нет.'));
  },
  lastReview(d) {
    const R = d.reviews || {};
    return Object.entries(R).map(([k, r]) => ({ ...r, kind: k })).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
  },
  review(d, D) {
    const r = this.lastReview(d);
    const kindL = { d3: 'сам, на 3-й день', d28: 'сам, на 28-й день', manual: 'по вашей просьбе' };
    const lines = r ? String(r.text || '').split('\n').map(s => s.trim()).filter(Boolean) : [];
    const ask = h('input.box', { placeholder: 'О чём спросить (необязательно): «почему уходят на 0:07?»', key: 'yt|ask|' + d.yt, value: YT.ask, oninput: e => { YT.ask = e.target.value; } });
    return h('div.yt-review',
      h('div.yt-ch', h('b', '🧠 Разбор Claude'), r && h('span.dim.small', `· ${kindL[r.kind] || r.kind} · ${fmtDate(r.at)}`), h('span.sp'),
        Claude.btn({ label: r ? 'Разобрать ещё раз' : 'Разобрать', action: 'ytvideo', key: 'yt:' + d.yt, scope: 'ytvideo', params: () => ({ yt: d.yt, ask: YT.ask }),
          title: 'Claude (Sonnet, один проход) прочитает цифры, удержание по сценам и комментарии', onResult: () => { YT.ask = ''; this.loadDet(d.yt); this.load(); } })),
      r ? h('ul', lines.map(s => h('li', s.replace(/^[-*•]\s*/, '')))) : h('p.dim.small', 'Разбора ещё нет. Claude делает его сам, когда ролику исполняется 3 и 28 дней (если веха наступила после подключения канала), — или нажмите «Разобрать».'),
      r && r.ask && h('p.dim.small', 'Вопрос: ' + r.ask),
      r && (r.rules || []).length > 0 && h('p.small', `В «Память» предложено уроков: ${r.rules.length} → `, h('a', { href: '#/memory' }, 'посмотреть')),
      ask);
  },
};

// ---------------- выпадающее меню (чип привязки, «⋯») ----------------
const Menu = {
  el: null,
  open(anchor, items) {
    this.close();
    const r = anchor.getBoundingClientRect();
    const mk = list => list.map(it => it.sub
      ? h('div.yt-menu-g', h('div.yt-menu-gl', it.label), h('div.yt-menu-sub', it.sub.length ? mk(it.sub) : h('div.dim.small', 'свободных видео нет')))
      : h('div.yt-menu-i', { onclick: e => { e.stopPropagation(); this.close(); it.run(); } }, it.label));
    this.el = h('div.yt-menu', { style: { left: Math.min(r.left, innerWidth - 300) + 'px', top: (r.bottom + 4) + 'px' }, onclick: e => e.stopPropagation() }, mk(items));
    document.body.append(this.el);
    const mb = this.el.getBoundingClientRect();
    if (mb.bottom > innerHeight - 8) this.el.style.top = Math.max(8, r.top - mb.height - 4) + 'px';
    setTimeout(() => addEventListener('click', this._c = () => this.close(), { once: true }), 0);
  },
  close() { if (this.el) this.el.remove(); this.el = null; if (this._c) removeEventListener('click', this._c); },
};
addEventListener('keydown', e => { if (e.key === 'Escape') { if (Menu.el) Menu.close(); else if (YT.open && App.route.page === 'yt' && !$('.modal')) { YT.open = null; App.render(); } } });
addEventListener('hashchange', () => Menu.close());
setInterval(() => { if (App.route && App.route.page !== 'yt' && Date.now() - YT.at > 120000 && !document.hidden) YTPage.load(); }, 30000);   // «N new» в боковой панели
