// Claude Studio — S12.2: страница «Видео» (сетка карточек) и поп-ап «Новое видео» в два шага (docs/studio/stage12-redesign.md §3–4).
'use strict';

const VIDS = { q: '', f: Local.get('vfilter') || 'all', extra: null, sig: '', busy: false };

const relTime = ms => {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  if (s < 2 * 86400) return 'вчера';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' дн назад';
  return fmtDate(ms);
};
const fmtLen = s => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

const Videos = {
  // стадия производства для таблетки карточки
  stage(p, x) {
    if (p.status === 'out') return { label: 'Вышло', cls: 'ok' };
    if (x && x.ready) return { label: 'Готово', cls: 'ok' };
    if (p.status === 'draft') return { label: 'Черновик', cls: '' };
    const st = STAGE_OF[p.stage] || STAGE_OF.idea;
    return { label: st.label, cls: 'info' };
  },
  bucket(p, x) {
    if (p.status === 'out') return 'out';
    if (x && x.ready) return 'ready';
    return p.status === 'draft' ? 'draft' : 'prod';
  },
  loadExtra() {
    const sig = App.plans.map(p => p.id + ':' + p.updated).join(',');
    if (VIDS.busy || (VIDS.extra && VIDS.sig === sig)) return;
    VIDS.busy = true; VIDS.sig = sig;
    api('GET', '/api/videos/extra').then(j => { VIDS.extra = j; }).catch(() => { VIDS.extra = VIDS.extra || {}; })
      .finally(() => { VIDS.busy = false; App.render(); });
  },

  page() {
    this.loadExtra();
    const X = VIDS.extra || {}, all = App.plans.filter(p => p.status !== 'archived');
    const n = k => all.filter(p => this.bucket(p, X[p.id]) === k).length;
    const words = VIDS.q.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const hit = p => { const t = (p.name + ' ' + (p.chosen || '')).toLowerCase().replace(/ё/g, 'е'); return words.every(w => t.includes(w)); };
    const list = all.filter(p => (VIDS.f === 'all' || this.bucket(p, X[p.id]) === VIDS.f) && hit(p));
    const F = [['all', 'Все', all.length], ['draft', 'Черновики', n('draft')], ['prod', 'В работе', n('prod')], ['ready', 'Готовые', n('ready')], ['out', 'Вышли', n('out')]];
    return h('div.page.videos-page',
      h('div.page-head',
        h('div.grow', h('h1', 'Видео'), h('p.sub', 'Каждое видео — папка в канале «' + ((App.info.channel || {}).name || '') + '» со своей историей.')),
        h('button.primary', { onclick: () => NewVideo.open() }, Icon('plus', 15), 'Новое видео')),
      h('div.vbar',
        h('label.vsearch', Icon('search', 15), draftInput('vids|q', { placeholder: 'Поиск по видео', value: VIDS.q,
          oninput: e => { VIDS.q = e.target.value; clearTimeout(VIDS.t); VIDS.t = setTimeout(() => App.render(), 120); } })),
        h('div.seg.vfilters', F.map(([k, l, c]) => h('button', { class: VIDS.f === k ? 'sel' : '', onclick: () => { VIDS.f = k; Local.set('vfilter', k); App.render(); } },
          l, c ? h('span.c', String(c)) : null)))),
      list.length ? h('div.vgrid', list.map(p => this.card(p, X[p.id])))
        : all.length ? h('div.empty-state', h('b', 'Ничего не нашлось'), h('p', 'Поменяй фильтр или поиск.'))
          : h('div.empty-state', h('div.es-ico', Icon('clapper', 24)), h('b', 'Видео пока нет'), h('p', 'Название, тема или свой сценарий — Claude задаст вопросы и напишет сценарий.'),
            h('button.primary', { onclick: () => NewVideo.open() }, Icon('plus', 15), 'Новое видео')));
  },

  card(p, x) {
    const st = this.stage(p, x), href = `#/v/${p.id}`;
    const src = x && x.cover ? `/api/videos/cover?id=${p.id}&v=${p.updated}` : '';
    const stop = fn => e => { e.preventDefault(); e.stopPropagation(); fn(); };
    const noimg = () => h('div.vc-noimg', Icon(p.mode === 'long' ? 'wide' : 'tall', 26));
    return h('a.vcard', { href, title: p.chosen || p.name },
      h('div.vc-cover', src ? [h('img.bg', { src, alt: '' }), h('img.fg', { src, alt: '', loading: 'lazy', onerror: e => e.target.parentNode.replaceChildren(noimg()) })] : noimg(),
        x && x.len ? h('span.vc-len', fmtLen(x.len)) : null,
        h('span.vc-mode', p.mode === 'long' ? '16:9' : '9:16'), dot(Unread.has(p.id))),
      h('div.vc-body',
        h('div.vc-title', p.name),
        h('div.vc-meta', x ? (x.scenes ? `${x.scenes} ${plural(x.scenes, 'сцена', 'сцены', 'сцен')}` : 'сцен пока нет') : '…'),
        h('div.vc-foot',
          h('span.pill', { class: st.cls }, h('i'), st.label), h('span.vc-time', relTime(p.updated)), h('span.sp'),
          h('button.icon', { title: 'Открыть папку видео', onclick: stop(() => api('POST', '/api/videos/open', { id: p.id }).catch(e => UI.toast(e.message, 'err'))) }, Icon('folder', 15)),
          h('button.icon', { title: 'Препродакшен', onclick: stop(() => go(`#/p/${p.id}/pre`)) }, Icon('users', 15)),
          h('button.icon.del', { title: 'Удалить (в архив)', onclick: stop(() => this.remove(p)) }, Icon('trash', 15)))));
  },
  async remove(p) {
    if (!confirm(`Удалить «${p.name}»? Папка видео уйдёт в _archive/videos — ничего не пропадёт.`)) return;
    try { await api('POST', '/api/delete', { key: 'plan:' + p.id }); await App.refreshState(); UI.toast('«' + p.name + '» — в архиве'); App.render(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
};

// ---------------- поп-ап «Новое видео»: 1) бриф → 2) вопросы Claude → «Создать» ----------------
const NewVideo = {
  el: null, step: 1, id: null, f: null, voice: null, err: '', sending: false,

  open() {
    this.step = 1; this.id = null; this.err = ''; this.voice = null; this.sending = false;
    const ck = 'channel:' + (App.info.channel || {}).id;
    if (!Store.get(ck)) Store.load(ck).then(() => this.el && this.step === 1 && this.draw()).catch(() => {});   // подачи и визуалы канала
    const LK = Styles.looks(), eng = ((App.info.channel || {}).defaults || {}).engine || '3d';
    this.f = { name: '', mode: 'short', delivery: (Styles.deliveries()[0] || {}).key || 'auto', look: (LK.find(x => (x.engine || '2d') === eng) || LK[0] || {}).key || 'paper', len: '1:00', topic: '', script: '', direction: '', refs: '' };
    this.el = h('div.nv', { onmousedown: e => { if (e.target === this.el) this.close(); } });
    document.body.append(this.el);
    this.esc = e => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.mention')) this.close(); };
    document.addEventListener('keydown', this.esc);
    this.draw();
    requestAnimationFrame(() => { const n = this.el && this.el.querySelector('[data-key="nv|name"]'); if (n) n.focus(); });
  },
  close() {
    if (!this.el) return;
    if (this.id && this.step === 2) UI.toast('Видео сохранено черновиком — вопросы ждут в нём');
    this.el.remove(); this.el = null; document.removeEventListener('keydown', this.esc);
    if (this.id) App.refreshState().then(() => App.render());
  },
  refresh() { if (this.el && this.step === 2) this.draw(); },            // App.render: пришли вопросы Claude / ответы сохранились

  secs(v) { const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(v || ''); return m ? (m[2] != null ? +m[1] * 60 + +m[2] : +m[1] * 60) : 0; },

  draw() {
    const box = this.step === 1 ? this.step1() : this.step2();
    this.el.replaceChildren(box);
    requestAnimationFrame(() => this.el && this.el.querySelectorAll('textarea.auto').forEach(autosize));
  },

  field(label, opt, ...kids) { return h('div.nv-field', h('label', label, opt ? h('span.opt', ' ' + opt) : null), ...kids); },
  inp(k, attrs = {}) { return h('input.box', { ...attrs, key: 'nv|' + k, value: this.f[k], oninput: e => { this.f[k] = e.target.value; attrs.oninput && attrs.oninput(e); } }); },
  ta(k, ph, rows = 3) { const t = h('textarea.box', { key: 'nv|' + k, placeholder: ph, rows, oninput: e => { this.f[k] = e.target.value; } }); t.value = this.f[k]; return t; },

  step1() {
    const f = this.f, R = REF, words = Math.round(this.secs(f.len) * 2.65);
    const DL = Styles.deliveries(), LK = Styles.looks(), dl = DL.find(x => x.key === f.delivery), lk = LK.find(x => x.key === f.look);
    const pick = (k, list) => sel(list.map(x => ({ value: x.key, label: x.label })), f[k], v => { f[k] = v; this.draw(); }, { class: 'box' });
    const voice = h('label.nv-drop', { class: this.voice ? 'has' : '',
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('over'); }, ondragleave: e => e.currentTarget.classList.remove('over'),
      ondrop: e => { e.preventDefault(); const file = [...e.dataTransfer.files].find(x => /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(x.name)); if (file) { this.voice = file; this.draw(); } else UI.toast('Нужен звук: WAV, MP3, M4A', 'err'); } },
      h('input', { type: 'file', accept: '.wav,.mp3,.m4a,.ogg,.flac,.aac', hidden: true, onchange: e => { this.voice = e.target.files[0] || null; this.draw(); } }),
      h('span.btn', Icon('download', 15), this.voice ? this.voice.name : 'Выбрать аудиофайл…'),
      h('span.dim', this.voice ? `${(this.voice.size / 2 ** 20).toFixed(1)} МБ` : 'или перетащи сюда'),
      this.voice && h('button.icon', { title: 'Убрать', onclick: e => { e.preventDefault(); this.voice = null; this.draw(); } }, Icon('x', 14)));
    return h('div.nv-box',
      h('div.nv-head', h('h3', 'Новое видео'), h('span.nv-steps', h('b', '1'), ' Бриф', h('span.dim', ' → '), h('span.dim', '2 Вопросы Claude')), h('span.sp'),
        h('button.icon', { onclick: () => this.close(), title: 'Закрыть (Esc)' }, Icon('x', 16))),
      h('div.nv-body',
        this.field('Название', null, this.inp('name', { placeholder: 'например: Почему PS2 тянула всё на 32 МБ' })),
        h('div.nv-row',
          this.field('Формат', null, h('div.seg', [['short', 'tall', 'Шортс 9:16'], ['long', 'wide', 'Длинное 16:9']].map(([k, ic, l]) =>
            h('button', { class: f.mode === k ? 'sel' : '', onclick: () => { f.mode = k; if (k === 'long' && this.secs(f.len) < 180) f.len = '10:00'; if (k === 'short' && this.secs(f.len) > 180) f.len = '1:00'; this.draw(); } }, Icon(ic, 14), l)))),
          this.field('Ориентировочная длина', null, this.inp('len', { placeholder: '1:00', class: 'len', oninput: () => { const w = this.el.querySelector('.nv-words'); if (w) w.textContent = `≈ ${Math.round(this.secs(f.len) * 2.65)} слов`; } }), h('span.nv-words.dim', `≈ ${words} слов`))),
        this.field('Озвучка', 'по желанию', voice, h('p.hint', 'WAV, MP3, M4A. Можно добавить позже: сначала сценарий и черновой голос нейросетью, потом своя запись.')),
        h('div.nv-row',
          this.field('Подача', '— как пишется сценарий', pick('delivery', DL), dl && h('p.hint', dl.desc)),
          this.field('Визуал', '— как выглядит', pick('look', LK), lk && h('p.hint', lk.desc))),
        this.field('Тема', 'по желанию: Claude поищет и напишет сценарий', this.inp('topic', { placeholder: 'например: как Resident Evil 2 влез в картридж N64' })),
        this.field('Сценарий', 'по желанию: свой текст вместо темы', this.ta('script', 'Вставь текст голоса — Claude не будет его переписывать, только разложит по сценам.', 3)),
        this.field('Указания для Claude', 'по желанию', this.ta('direction', 'Тон, герои, на чём сделать акцент, камера…', 2)),
        this.field('Референсы', 'по желанию: ссылки, по одной в строке', this.ta('refs', 'https://youtu.be/…', 2)),
        this.err && h('div.badline', '⚠ ' + this.err)),
      h('div.nv-foot', h('span.dim.small', 'Дальше Claude задаст вопросы по идее — ответы помогут ему не выдумывать за тебя.'), h('span.sp'),
        h('button', { onclick: () => this.close() }, 'Отмена'),
        h('button.primary', { disabled: this.sending, onclick: () => this.next() }, this.sending ? [h('span.spin'), ' Создаю…'] : ['Далее', Icon('chevRight', 15)])));
  },

  body() {
    const f = this.f;
    return { name: f.name.trim(), mode: f.mode, delivery: f.delivery, look: f.look, len: this.secs(f.len), topic: f.topic.trim(), script: f.script.trim(),
      direction: f.direction.trim(), refs: f.refs.split(/\s+/).filter(u => /^https?:\/\//.test(u)), channel: (App.info.channel || {}).id };
  },
  async next() {
    const b = this.body();
    if (!b.name) { this.err = 'Нужно название'; this.draw(); return; }
    this.err = ''; this.sending = true; this.draw();
    try {
      const key = () => 'plan:' + this.id;
      if (!this.id) {
        this.id = (await api('POST', '/api/videos/create', b)).id;
        if (this.voice) await api('POST', `/api/videos/voice?id=${this.id}&name=${encodeURIComponent(this.voice.name)}`, undefined, this.voice);
        await Store.load(key());
        await App.refreshState();
        const qa = (Store.get(key()) || {}).qa || [];
        if (!qa.length) Claude.run({ action: 'questions', key: key(), params: b.script ? { n: 8, focus: 'У автора уже готовый сценарий (текст голоса). Не спрашивай про сюжет и факты — только про подачу, героев, картинку, тон и финал.' } : { n: 15 } });
      } else {                                         // вернулись с шага 2 и что-то поменяли
        await api('POST', '/api/videos/brief', { id: this.id, ...b });
        const d = Store.get(key());
        if (d && d.name !== b.name) Store.set(key(), ['name'], b.name);
        if (d && d.mode !== b.mode) Store.set(key(), ['mode'], b.mode);
        await Store.load(key(), true);
      }
      this.step = 2;
    } catch (e) { this.err = e.message; }
    this.sending = false;
    if (this.el) this.draw();
  },

  step2() {
    const key = 'plan:' + this.id, d = Store.get(key) || { qa: [] }, qa = d.qa || [];
    const answered = qa.filter(q => (q.a || '').trim() || q.skip).length;
    const run = Claude.running(key, 'questions');
    return h('div.nv-box.wide',
      h('div.nv-head', h('h3', d.name || 'Новое видео'), h('span.nv-steps', h('span.dim', '1 Бриф → '), h('b', '2'), ' Вопросы Claude'), h('span.sp'),
        h('button.icon', { onclick: () => this.close(), title: 'Закрыть — видео останется черновиком' }, Icon('x', 16))),
      h('div.nv-body',
        h('div.row', h('span.counter', { class: qa.length && answered === qa.length ? 'ok' : '' }, qa.length ? `отвечено ${answered} из ${qa.length}` : ''),
          h('span.sp'),
          Claude.btn({ label: qa.length ? 'Ещё вопросы' : 'Вопросы', action: 'questions', key, params: { n: 8 }, title: 'Уточняющий раунд: Claude учтёт твои ответы' })),
        run && !qa.length ? h('div.nv-wait', h('span.spin'), ' Claude читает бриф и готовит вопросы… обычно 20–60 секунд')
          : qa.length ? h('div.nv-qa', qa.map((q, i) => Plan.qRow(d, key, q, i + 1)))
            : h('div.nv-wait.dim', 'Вопросов нет — можно создавать.'),
        addLine('+ свой вопрос — Enter', q => Store.add(key, ['qa'], { id: uid('q'), q, a: '', why: '', group: '', round: 1, by: 'me' }), key + '|nvaddq'),
        h('p.hint', 'Отвечай коротко, «–» — пропустить, «не знаю, предложи» — Claude решит сам. Ответы — твои решения: Claude не будет их переписывать.')),
      h('div.nv-foot',
        h('button', { onclick: () => { this.step = 1; this.draw(); } }, '← Назад'), h('span.sp'),
        h('button.ghost', { onclick: () => this.create(true), title: 'Создать без ответов на вопросы' }, 'Пропустить вопросы'),
        h('button.primary', { disabled: this.sending, onclick: () => this.create() }, this.sending ? [h('span.spin'), ' Готовлю проект…'] : ['Создать', Icon('check', 15)])));
  },

  // «Создать»: проект ролика в папке видео → Claude пишет сценарий (панель агента, режим script)
  async create() {
    const id = this.id, key = 'plan:' + id;
    this.sending = true; this.draw();
    await Store.flushAll();
    Store.set(key, ['status'], 'prod');
    Store.set(key, ['stage'], 'script');
    await Store.flushAll();
    const name = (Store.get(key) || {}).name;
    const write = () => {
      go(`#/v/${id}`);
      setTimeout(() => {
        if (!window.AgentPanel) return;
        AgentPanel.toggle(true);
        AgentPanel.say('📝 Новое видео из поп-апа: прочитай бриф (тема, подача, визуал, длина, указания, свой сценарий — если есть) и мои ответы на вопросы. Сначала ресерч темы (WebSearch → research.md с источниками), потом сценарий. Потом montage check и montage tts.',
          { mode: 'script', model: 'opus' });
      }, 900);
    };
    Claude.run({ action: 'produce', key, params: { id, name }, onResult: write });
    UI.toast('Кладу проект ролика в папку видео — потом Claude начнёт сценарий');
    this.el.remove(); this.el = null; document.removeEventListener('keydown', this.esc);
    await App.refreshState();
    go(`#/v/${id}`);
  },
};
