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
    if (p.stage === 'brief') return { label: 'Бриф', cls: 'amber', title: 'Бриф не закончен — клик по карточке: вопросы Claude' };
    const STEP = { script: 'Сценарий', pre: 'Препродакшен', montage: 'Монтаж', pack: 'Упаковка' };   // этап по факту (videos_api._step)
    if (x && x.work) return { label: x.work, cls: 'live', title: 'Сейчас идёт работа над видео (Claude или сборка)' };   // идёт монтаж / правки — не «Готово»
    if (p.status === 'out') return { label: 'Вышло', cls: 'ok' };
    if (x && x.ready) return { label: 'Готово', cls: 'ok' };
    if (p.status === 'draft') return { label: 'Черновик', cls: '' };
    if (x && STEP[x.step]) return { label: STEP[x.step], cls: 'info' };
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
    const live = VIDS.extra && Object.values(VIDS.extra).some(x => x && x.work);   // что-то идёт — освежаем раз в 5 с, чтобы таблетка сменилась на «Готово» сама
    if (VIDS.busy || (VIDS.extra && VIDS.sig === sig && !(live && Date.now() - (VIDS.at || 0) > 5000))) {
      if (live && !VIDS.timer) VIDS.timer = setTimeout(() => { VIDS.timer = 0; if (Date.now() - (VIDS.shown || 0) < 8000) App.render(); }, 5200);
      return;
    }
    VIDS.at = Date.now();
    VIDS.busy = true; VIDS.sig = sig;
    api('GET', '/api/videos/extra').then(j => { VIDS.extra = j; }).catch(() => { VIDS.extra = VIDS.extra || {}; })
      .finally(() => { VIDS.busy = false; App.render(); });
  },

  page() {
    VIDS.shown = Date.now();                                     // список на экране (для обновления таблеток «Монтаж идёт» → «Готово»)
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
    const resume = p.stage === 'brief' ? e => { e.preventDefault(); Store.load('plan:' + p.id).then(() => NewVideo.resume(Store.get('plan:' + p.id))).catch(er => UI.toast(er.message, 'err')); } : null;
    return h('a.vcard', { href, title: p.chosen || p.name, onclick: resume },
      h('div.vc-cover', src ? [h('img.bg', { src, alt: '' }), h('img.fg', { src, alt: '', loading: 'lazy', onerror: e => e.target.parentNode.replaceChildren(noimg()) })] : noimg(),
        x && x.len ? h('span.vc-len', fmtLen(x.len)) : null,
        h('span.vc-mode', p.mode === 'long' ? '16:9' : '9:16'), dot(Unread.has(p.id))),
      h('div.vc-body',
        h('div.vc-title', p.name),
        h('div.vc-meta', x ? (x.scenes ? `${x.scenes} ${plural(x.scenes, 'сцена', 'сцены', 'сцен')}` : 'сцен пока нет') : '…'),
        h('div.vc-foot',
          h('span.pill', { class: st.cls, title: st.title || null }, h('i'), st.label), h('span.vc-time', relTime(p.updated)), h('span.sp'),
          h('button.icon', { title: 'Открыть папку видео', onclick: stop(() => api('POST', '/api/videos/open', { id: p.id }).catch(e => UI.toast(e.message, 'err'))) }, Icon('folder', 15)),
          h('button.icon', { title: 'Препродакшен', onclick: stop(() => go(`#/v/${p.id}/pre`)) }, Icon('users', 15)),
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
  el: null, step: 1, id: null, f: null, voice: null, err: '', sending: false, edit: false,

  open(force) {
    if (this.el && !force) { this.restore(); return; }                  // свёрнутое окно — развернуть, а не открыть второе
    if (this.el) { this.el.remove(); this.el = null; document.removeEventListener('keydown', this.esc); }
    this.step = 1; this.id = null; this.err = ''; this.voice = null; this.sending = false; this.edit = false;
    const ck = 'channel:' + (App.info.channel || {}).id;
    if (!Store.get(ck)) Store.load(ck).then(() => this.el && this.step === 1 && this.draw()).catch(() => {});   // подачи и визуалы канала
    const LK = Styles.looks(), eng = ((App.info.channel || {}).defaults || {}).engine || '3d';
    this.f = { name: '', mode: 'short', delivery: (Styles.deliveries()[0] || {}).key || 'auto', look: (LK.find(x => (x.engine || '2d') === eng) || LK[0] || {}).key || 'paper', len: '1:00', topic: '', script: '', direction: '', refs: '', refBase: '', flow: 'idea', hint: '' };
    try { const kept = JSON.parse(Local.get('nv-draft') || 'null'); if (kept && kept.name !== undefined) Object.assign(this.f, kept); } catch {}   // S12.13: недописанный бриф — с того же места
    this.min = false; this.dock();
    this.el = h('div.nv', { onmousedown: e => { if (e.target === this.el) this.close(); } });
    document.body.append(this.el);
    this.esc = e => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.mention')) this.close(); };
    document.addEventListener('keydown', this.esc);
    this.draw();
    requestAnimationFrame(() => { const n = this.el && this.el.querySelector('[data-key="nv|name"]'); if (n) n.focus(); });
  },
  // S12.13: то же окно для видео, у которого ещё нет брифа (заведено до поп-апа): бриф из идеи и контекста видео -> вопросы -> «Написать сценарий»
  openFor(d) {
    this.open(true);
    const b = d.brief || {}, mm = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.id = d.id; this.edit = true;
    Object.assign(this.f, { name: d.name || '', mode: d.mode === 'long' ? 'long' : 'short', len: b.len ? mm(b.len) : d.mode === 'long' ? '10:00' : '1:00',
      topic: b.topic != null ? b.topic : (d.idea || ''), direction: b.direction != null ? b.direction : (b.topic == null ? (d.topic || '') : ''), script: b.script || '',
      refs: (d.refs || []).filter(r => r.role !== 'base').map(r => r.url).filter(Boolean).join('\n'), refBase: ((d.refs || []).find(r => r.role === 'base') || {}).url || '' });
    if (b.delivery) this.f.delivery = b.delivery;
    if (b.look) this.f.look = b.look;
    this.draw();
  },
  close() {
    if (!this.el) return;
    if (!this.id && this.step === 1 && (this.f.name || this.f.topic || this.f.script || this.f.direction)) { Local.set('nv-draft', JSON.stringify(this.f)); UI.toast('Бриф сохранён — «Новое видео» продолжит с него'); }
    if (this.id && this.step === 2 && !this.edit) UI.toast('Видео сохранено — продолжить вопросы: клик по нему в списке');
    this.el.remove(); this.el = null; this.min = false; this.dock(); document.removeEventListener('keydown', this.esc);
    if (this.id) App.refreshState().then(() => App.render());
  },
  // «Свернуть»: окно прячется в плашку в углу (можно ходить по Studio), клик по плашке — обратно на то же место
  minimize() {
    if (!this.el) return;
    if (!this.id) Local.set('nv-draft', JSON.stringify(this.f));
    this.min = true; this.el.hidden = true; document.removeEventListener('keydown', this.esc); this.dock();
  },
  restore() {
    if (!this.el) return;
    this.min = false; this.el.hidden = false; document.addEventListener('keydown', this.esc); this.dock(); this.draw();
  },
  dock() {
    let b = document.getElementById('nv-dock');
    if (!this.min) { if (b) b.remove(); return; }
    const name = (this.f && this.f.name) || 'Новое видео';
    const lbl = this.step === 2 ? 'вопросы Claude' : 'бриф';
    const n = h('button#nv-dock', { title: 'Продолжить создание видео', onclick: () => this.restore() }, Icon('plus', 14), h('span', h('b', name), h('small', ' · ' + lbl)), Icon('chevr', 14));
    if (b) b.replaceWith(n); else document.body.append(n);
  },
  // продолжить незаконченное видео (закрыли на вопросах): поп-ап сразу на шаге 2
  resume(d) {
    this.openFor(d); this.edit = false; this.step = 2;
    const T = d.refTopics;                                // ресерч по референсу без выбранной темы — обратно к темам
    if (T && !(T.items || []).some(t => t.pick) && !(d.qa || []).length) { this.f.flow = 'research'; this.step = 1; }
    else if (!(d.qa || []).length && ((d.brief || {}).topic || (d.brief || {}).script) && !Claude.running('plan:' + d.id, 'questions')) Claude.run({ action: 'questions', key: 'plan:' + d.id, params: { n: 15 } });   // черновик темы «на будущее» — вопросы при первом открытии
    this.draw();
  },
  // App.render (каждое сохранение, раз в ~2 с): перерисовать только если поменялось видимое — вопросы, число отвеченных, работа Claude
  refresh() {
    if (this.el && !this.min && this.step === 1 && this.id && this.f.flow === 'research') {          // S16: «💡 Похожие темы» — перерисовать, когда Claude ответил или разбор продвинулся
      const d = Store.get('plan:' + this.id) || {}, b = (d.refs || []).find(r => r.role === 'base') || {};
      const run = Claude.running('plan:' + this.id, 'reftopics');
      const sig = [(d.refTopics || {}).at, !!run, run && run.summary, (b.parse || {}).msg].join('|');
      if (sig !== this.tsig) { this.tsig = sig; this.draw(); }
      return;
    }
    if (!this.el || this.min || this.step !== 2) return;
    const key = 'plan:' + this.id, d = Store.get(key) || {}, qa = d.qa || [];
    const sig = [qa.map(q => q.id + (q.skip ? '-' : '') + ((q.a || '').trim() ? '+' : '') + ((q.opts || []).length ? 'o' : '')).join(','), !!Claude.running(key, 'questions'), !!Claude.running(key, 'qopts'), d.name].join('|');
    if (sig === this.sig) return;
    this.draw();
  },

  secs(v) { const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(v || ''); return m ? (m[2] != null ? +m[1] * 60 + +m[2] : +m[1] * 60) : 0; },

  draw() {
    const same = this.drawnStep === this.step, saved = same ? ScrollKeep.save(this.el) : [];
    const box = this.step === 1 ? this.step1() : this.step2();
    this.el.replaceChildren(box);
    ScrollKeep.restore(this.el, saved);                   // перерисовка не прыгает наверх: ни окно, ни поля в нём (новый шаг — с начала)
    this.drawnStep = this.step;
    if (this.step === 2) { const key = 'plan:' + this.id, d = Store.get(key) || {}, qa = d.qa || [];
      this.sig = [qa.map(q => q.id + (q.skip ? '-' : '') + ((q.a || '').trim() ? '+' : '') + ((q.opts || []).length ? 'o' : '')).join(','), !!Claude.running(key, 'questions'), !!Claude.running(key, 'qopts'), d.name].join('|'); }
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
    const flows = !this.edit && h('div.seg.nv-flow',
      [['idea', 'Есть идея'], ['research', '🔎 Ресерч по референсу']].map(([k, l]) => h('button', { class: (f.flow || 'idea') === k ? 'sel' : '', onclick: () => { f.flow = k; this.err = ''; this.draw(); } }, l)));
    const head = h('div.nv-head', h('h3', this.edit ? 'Бриф видео' : 'Новое видео'),
      f.flow === 'research' ? null : h('span.nv-steps', h('b', '1'), ' Бриф', h('span.dim', ' → '), h('span.dim', '2 Вопросы Claude')), h('span.sp'),
      h('button.icon', { onclick: () => this.minimize(), title: 'Свернуть — вернуться можно плашкой внизу' }, '–'),
      h('button.icon', { onclick: () => this.close(), title: 'Закрыть (Esc) — бриф запомнится' }, Icon('x', 16)));
    if (f.flow === 'research' && !this.edit) return this.research(head, flows);
    return h('div.nv-box',
      head,
      h('div.nv-body',
        flows || null,
        this.field('Название', null, this.inp('name', { placeholder: 'например: Почему PS2 тянула всё на 32 МБ' })),
        h('div.nv-row',
          this.field('Формат', null, h('div.seg', [['short', 'tall', 'Шортс 9:16'], ['long', 'wide', 'Длинное 16:9']].map(([k, ic, l]) =>
            h('button', { class: f.mode === k ? 'sel' : '', onclick: () => { f.mode = k; if (k === 'long' && this.secs(f.len) < 180) f.len = '10:00'; if (k === 'short' && this.secs(f.len) > 180) f.len = '1:00'; this.draw(); } }, Icon(ic, 14), l)))),
          this.field('Ориентировочная длина', null, this.inp('len', { placeholder: '1:00', class: 'len', oninput: () => { const w = this.el.querySelector('.nv-words'); if (w) w.textContent = `≈ ${Math.round(this.secs(f.len) * 2.65)} слов`; } }), h('span.nv-words.dim', `≈ ${words} слов`))),
        this.field('Озвучка', 'по желанию', voice, h('p.hint', 'WAV, MP3, M4A. Можно добавить позже: сначала сценарий и черновой голос нейросетью, потом своя запись.')),
        this.field('Подача', '— как пишется сценарий', pick('delivery', DL), dl && h('p.hint', dl.desc)),
        this.field('Визуал', '— как выглядит; наведи — покажет', (typeof Looks !== 'undefined' && Looks.picker(f.look, v => { f.look = v; this.draw(); })) || pick('look', LK), lk && h('p.hint', lk.desc)),
        this.field('Тема', 'по желанию: Claude поищет и напишет сценарий', this.inp('topic', { placeholder: 'например: как Resident Evil 2 влез в картридж N64' })),
        this.field('Сценарий', 'по желанию: свой текст вместо темы', this.ta('script', 'Вставь текст голоса — Claude не будет его переписывать, только разложит по сценам.', 3)),
        this.field('Указания для Claude', 'по желанию', this.ta('direction', 'Тон, герои, на чём сделать акцент, камера…', 2)),
        this.field('Референсы', 'по желанию: ссылки, по одной в строке — материал и факты', this.ta('refs', 'https://youtu.be/…', 2)),
        this.field('📐 Референс подачи', 'по желанию: шорт / TikTok, в подаче которого расскажем нашу историю',
          this.inp('refBase', { placeholder: 'https://www.tiktok.com/@…/video/…' }),
          h('p.hint', 'Те же биты, приёмы и длина фраз — про нашу тему. Перед сценарием Claude покажет карту «их бит → наш бит», ты её поправишь и утвердишь. Нет темы — вкладка «🔎 Ресерч по референсу» сверху.')),
        this.err && h('div.badline', '⚠ ' + this.err)),
      h('div.nv-foot', h('span.dim.small', 'Дальше Claude задаст вопросы по идее — ответы помогут ему не выдумывать за тебя.'), h('span.sp'),
        h('button', { onclick: () => this.close() }, 'Отмена'),
        h('button.primary', { disabled: this.sending, onclick: () => this.next() }, this.sending ? [h('span.spin'), ' Создаю…'] : ['Далее', Icon('chevRight', 15)])));
  },

  // путь «🔎 Ресерч по референсу»: ссылка на ролик -> Claude смотрит его и предлагает темы канала в той же механике -> клик по теме -> обычный бриф (путь «Есть идея»)
  research(head, flows) {
    const f = this.f, key = this.id && 'plan:' + this.id, run = key && Claude.running(key, 'reftopics');
    const items = key ? (((Store.get(key) || {}).refTopics || {}).items || []) : [];
    return h('div.nv-box',
      head,
      h('div.nv-body',
        flows,
        h('p.hint.nv-rintro', 'Понравился шорт или видео — его подача и тема? Claude скачает и расшифрует его, разберёт, почему он работает, и предложит темы для нашего канала в той же механике — не копию. Выберешь тему — дальше как обычно: бриф, вопросы, карта подачи, сценарий.'),
        this.field('Ссылка на ролик', 'шорт, TikTok, Reels или длинное видео', this.inp('refBase', { placeholder: 'https://www.tiktok.com/@…/video/…' })),
        this.field('Что ищем', 'по желанию', this.inp('hint', { placeholder: 'например: про игры 2000-х, без политики, чтобы был наш ёжик…' })),
        h('div.row', h('span.sp'),
          run ? Claude.btn({ label: 'Ищу темы', action: 'reftopics', key })
            : h('button.claude', { disabled: this.sending, onclick: () => this.topics() }, items.length ? '💡 Ещё темы' : '💡 Найти темы')),
        this.topicList(),
        this.err && h('div.badline', '⚠ ' + this.err)),
      h('div.nv-foot', h('span.dim.small', 'Ролик станет референсом подачи нового видео — его можно будет снять в брифе.'), h('span.sp'),
        h('button', { onclick: () => this.close() }, 'Отмена')));
  },

  // S16 «💡 Похожие темы»: видео заводится сразу (задачам Claude нужна папка), ссылка — референсом подачи; Claude смотрит ролик и предлагает темы
  async topics() {
    const f = this.f, url = (f.refBase || '').trim();
    if (!/^https?:\/\//.test(url)) { this.err = 'Вставь ссылку на шорт / TikTok в «Референс подачи»'; this.draw(); return; }
    this.err = ''; this.sending = true; this.draw();
    try {
      const b = this.body();
      if (!this.id) {
        const hint = (f.hint || '').trim().replace(/\s+/g, ' ');   // имя черновика — из запроса автора (Claude потом даст своё, если имя не трогали)
        if (!b.name) b.name = hint ? 'Ресерч: ' + (hint.length > 48 ? hint.slice(0, 47) + '…' : hint) : 'Ресерч по референсу';
        this.id = (await api('POST', '/api/videos/create', b)).id;
        Local.set('nv-draft', '');
        await Store.load('plan:' + this.id); Store.set('plan:' + this.id, ['stage'], 'brief', false);
        await App.refreshState();
      } else await api('POST', '/api/videos/brief', { id: this.id, ...b });
      await Store.load('plan:' + this.id, true);
      const base = ((Store.get('plan:' + this.id) || {}).refs || []).find(r => r.role === 'base');
      await Claude.run({ action: 'reftopics', key: 'plan:' + this.id, params: { ref: base && base.id, n: 6, hint: (f.hint || '').trim() } });
      UI.toast('Claude скачивает ролик, расшифровывает и ищет похожие темы — 2–6 минут');
    } catch (e) { this.err = e.message; }
    this.sending = false;
    if (this.el) this.draw();
  },
  topicList() {
    if (!this.id) return null;
    const key = 'plan:' + this.id, d = Store.get(key) || {}, T = d.refTopics || {}, run = Claude.running(key, 'reftopics');
    const b = (d.refs || []).find(r => r.role === 'base') || {}, ps = b.parse || {};
    if (run && !(T.items || []).length) return h('div.nv-wait', h('span.spin'), ' ', run.summary && run.summary !== 'в очереди' ? run.summary : ps.msg || 'Claude смотрит ролик…');
    if (!(T.items || []).length) return null;
    return h('div.nv-topics',
      (T.about || T.trick) && h('details.about', h('summary', h('b', 'О референсе и почему он работает')), T.about && [h('b', 'О чём: '), T.about, h('br')], T.trick && [h('b', 'Почему работает: '), T.trick]),
      T.items.map(t => h('div.nv-topic', { class: (t.pick ? 'sel ' : '') + (t.draft ? 'drafted' : '') },
        h('b', t.title), h('span.t', t.topic), h('span.a', h('i', 'механика: '), t.angle), t.why && h('span.a', h('i', 'почему зайдёт: '), t.why),
        t.facts && h('details.f', h('summary', '📎 факты и источники'), t.facts), t.risk && h('span.f', '⚠ ' + t.risk),
        h('div.row.nv-tact',
          t.draft ? h('span.ok.small', { title: 'Отдельное видео-черновик с этой темой и тем же референсом подачи — в списке видео' }, '✓ в черновиках')
            : h('button.small', { disabled: this.busyTopic === t.id, title: 'Завести отдельное видео-черновик на будущее: название, тема, угол и тот же референс подачи (разбор ролика копируется, заново не качается)',
                onclick: () => this.draftTopic(t) }, this.busyTopic === t.id ? [h('span.spin'), ' завожу…'] : '＋ В черновики'),
          h('span.sp'),
          h('button.small.primary', { title: 'Взять эту тему сейчас: название, тема и угол — в бриф этого видео', onclick: () => this.pickTopic(t) }, t.pick ? '✓ Взята' : 'Взять сейчас')))),
      null);
  },
  // «＋ В черновики»: тема на будущее — отдельное видео (бриф: формат, длина, визуал — как в поп-апе; референс подачи — копия разбора из ресерча)
  async draftTopic(t) {
    const key = 'plan:' + this.id, d = Store.get(key) || {}, base = (d.refs || []).find(r => r.role === 'base') || {}, b = this.body();
    this.busyTopic = t.id; this.draw();
    try {
      const r = await api('POST', '/api/videos/create', { ...b, name: t.title, topic: t.topic, direction: 'Угол (по референсу подачи): ' + t.angle, script: '', refs: [],
        refBase: base.url || '', refCopy: { video: this.id, ref: base.id } });
      await api('POST', '/api/op', { key: 'plan:' + r.id, ops: [{ op: 'set', path: ['stage'], value: 'brief' }] });
      Store.set(key, ['refTopics', 'items', t.id, 'draft'], r.id);
      await App.refreshState();
      UI.toast(`«${t.title}» — в черновиках`);
    } catch (e) { UI.toast(e.message, 'err'); }
    this.busyTopic = null;
    if (this.el) this.draw();
  },
  async pickTopic(t) {
    const key = 'plan:' + this.id, f = this.f;
    f.name = t.title; f.topic = t.topic;
    const ang = 'Угол (по референсу подачи): ' + t.angle;
    if (!f.direction.includes(ang)) f.direction = (f.direction.trim() ? f.direction.trim() + '\n' : '') + ang;
    for (const x of ((Store.get(key) || {}).refTopics || {}).items || []) if (x.pick && x.id !== t.id) Store.set(key, ['refTopics', 'items', x.id, 'pick'], false);
    Store.set(key, ['refTopics', 'items', t.id, 'pick'], true);
    Store.set(key, ['name'], t.title);
    Store.set(key, ['idea'], t.topic);
    const qa = (Store.get(key) || {}).qa || [];                // вопросы к прошлой теме, на которые ещё не отвечали, — устарели: «Далее» задаст новые
    if (qa.length && qa.every(q => !(q.a || '').trim() && !q.skip)) Store.set(key, ['qa'], []);
    f.flow = 'idea';
    this.draw();
    try {                                                      // тема сразу в видео, а не только в поп-ап: закрыли / перезагрузили до «Далее» — бриф не теряется
      await Store.flushAll();
      await api('POST', '/api/videos/brief', { id: this.id, ...this.body() });
      await Store.load(key, true);
      UI.toast('Тема в брифе, ролик — референсом подачи. Проверь бриф и жми «Далее»');
    } catch (e) { UI.toast('Тема не сохранилась: ' + e.message, 'err'); }
  },

  body() {
    const f = this.f;
    return { name: f.name.trim(), mode: f.mode, delivery: f.delivery, look: f.look, len: this.secs(f.len), topic: f.topic.trim(), script: f.script.trim(),
      direction: f.direction.trim(), refs: f.refs.split(/\s+/).filter(u => /^https?:\/\//.test(u)), refBase: (f.refBase || '').trim(), channel: (App.info.channel || {}).id };
  },
  async next() {
    const b = this.body();
    if (!b.name) { this.err = 'Нужно название'; this.draw(); return; }
    this.err = ''; this.sending = true; this.draw();
    try {
      const key = () => 'plan:' + this.id;
      if (!this.id) {
        this.id = (await api('POST', '/api/videos/create', b)).id;
        Local.set('nv-draft', '');
        await Store.load(key()); Store.set(key(), ['stage'], 'brief', false);    // клик в списке вернёт на вопросы, пока не нажато «Создать»
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
        if (!((Store.get(key()) || {}).qa || []).length && !Claude.running(key(), 'questions'))
          Claude.run({ action: 'questions', key: key(), params: b.script ? { n: 8, focus: 'У автора уже готовый сценарий (текст голоса). Не спрашивай про сюжет и факты — только про подачу, героев, картинку, тон и финал.' } : { n: 15 } });
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
        h('button.icon', { onclick: () => this.minimize(), title: 'Свернуть — вернуться можно плашкой внизу' }, '–'),
        h('button.icon', { onclick: () => this.close(), title: 'Закрыть — продолжить можно кликом по видео в списке' }, Icon('x', 16))),
      h('div.nv-body',
        h('div.row', h('span.counter', { class: qa.length && answered === qa.length ? 'ok' : '' }, qa.length ? `отвечено ${answered} из ${qa.length}` : ''),
          h('span.sp'),
          qa.some(q => !(q.opts || []).length && !(q.a || '').trim() && !q.skip) && Claude.btn({ label: 'Варианты ответов', action: 'qopts', key, icon: '💡',
            title: 'Claude допишет к неотвеченным вопросам 2–4 варианта ответа — кликом выбрать, своё можно вписать' }),
          Claude.btn({ label: qa.length ? 'Ещё вопросы' : 'Вопросы', action: 'questions', key, params: { n: 8 }, title: 'Уточняющий раунд: Claude учтёт твои ответы' })),
        run && !qa.length ? h('div.nv-wait', h('span.spin'), ' Claude читает бриф и готовит вопросы… обычно 20–60 секунд')
          : qa.length ? h('div.nv-qa', qa.map((q, i) => Plan.qRow(d, key, q, i + 1)))
            : h('div.nv-wait.dim', 'Вопросов нет — можно создавать.'),
        addLine('+ свой вопрос — Enter', q => Store.add(key, ['qa'], { id: uid('q'), q, a: '', why: '', group: '', round: 1, by: 'me' }), key + '|nvaddq'),
        h('p.hint', 'Отвечай коротко, «–» — пропустить, «не знаю, предложи» — Claude решит сам. Ответы — твои решения: Claude не будет их переписывать.')),
      h('div.nv-foot',
        h('button', { onclick: () => { this.step = 1; this.draw(); } }, '← Назад'), h('span.sp'),
        h('button.ghost', { onclick: () => this.create(true), title: this.edit ? 'Писать сценарий без ответов на вопросы' : 'Создать без ответов на вопросы' }, 'Пропустить вопросы'),
        h('button.primary', { disabled: this.sending, onclick: () => this.create() }, this.sending ? [h('span.spin'), ' Готовлю проект…'] : [this.edit ? 'Написать сценарий' : 'Создать', Icon('check', 15)])));
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
      const dd = Store.get(key) || {};
      if ((dd.refs || []).some(r => r.role === 'base') && (dd.beatmap || {}).status !== 'ok') { setTimeout(() => Workspace.beatmap(Store.get(key) || dd), 900); return; }   // S16: сначала карта подачи
      setTimeout(() => {
        if (!window.AgentPanel) return;
        AgentPanel.toggle(true);
        AgentPanel.say('📝 ' + (NewVideo.edit ? 'Бриф видео обновлён в поп-апе' : 'Новое видео из поп-апа') + ': прочитай бриф (тема, подача, визуал, длина, указания, свой сценарий — если есть) и мои ответы на вопросы. Сначала мои референсы (ref list — дождись разбора, прочитай расшифровки целиком), потом ресерч темы (WebSearch → research.md с источниками), потом сценарий. Потом montage check и montage tts.',
          { mode: 'script', model: 'opus' });
      }, 900);
    };
    if ((Store.get(key) || {}).project) write();          // видео уже с проектом (поп-ап для существующего) — сразу сценарий
    else {
      Claude.run({ action: 'produce', key, params: { id, name }, onResult: write });
      UI.toast('Кладу проект ролика в папку видео — потом Claude начнёт сценарий');
    }
    this.el.remove(); this.el = null; document.removeEventListener('keydown', this.esc);
    await App.refreshState();
    go(`#/v/${id}`);
  },
};
