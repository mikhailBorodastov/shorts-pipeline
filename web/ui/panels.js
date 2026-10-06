// Claude Studio — S12.11: панели окна видео вместо старых вкладок #/p/<id>/<этап> (docs/studio/stage12-redesign.md §5, 12.5).
// #/v/<id>/brief — бриф: идея, контекст, референсы, ответы на вопросы Claude; /voice — озвучка и тайминги; /pack — упаковка (название, описание, обложка).
// Встают в центр окна на место превью, как препродакшен (ui/preprod.js); «×» — назад к монтажу.
'use strict';

const Panels = {
  TITLES: { brief: 'Бриф', voice: 'Озвучка и тайминги', pack: 'Упаковка' },
  has(tab) { return tab in this.TITLES; },
  view(d, key, tab) {
    return h('div.ws-pre.ws-panel', h('div.ws-pre-in',
      h('div.ws-panel-head', h('h2', this.TITLES[tab]), h('span.sp'),
        h('button.icon', { title: 'Закрыть — к монтажу (Esc)', onclick: () => go('#/v/' + d.id) }, Icon('x', 16))),
      this[tab](d, key)));
  },

  // ---------------- бриф ----------------
  brief(d, key) {
    const b = d.brief || {}, qa = d.qa || [], answered = qa.filter(q => (q.a || '').trim() || q.skip).length;
    const DL = typeof Styles !== 'undefined' ? Styles.deliveries() : REF.deliveries || [], LK = typeof Styles !== 'undefined' ? Styles.looks() : REF.looks || [];
    const lab = (L, k) => (L.find(x => x.key === k) || {}).label;
    const facts = [b.delivery && ['Подача', lab(DL, b.delivery) || b.delivery], b.look && ['Визуал', lab(LK, b.look) || b.look],
      b.len && ['Длина', typeof b.len === 'number' ? `${Math.floor(b.len / 60)}:${String(b.len % 60).padStart(2, '0')}` : b.len], ['Формат', d.mode === 'long' ? 'длинное 16:9' : 'шортс 9:16']].filter(Boolean);
    const focus = h('input.box', { key: key + '|qfocus', placeholder: 'о чём ещё спросить (можно пусто)', style: { width: '240px' },
      value: Local.get('qfocus:' + d.id) || '', oninput: e => Local.set('qfocus:' + d.id, e.target.value) });
    return [
      this.base(d, key, DL, LK) || h('div.brief-facts', facts.map(([k, v]) => h('span.pill', h('span.dim', k + ' '), v))),
      h('section.card',
        h('div.card-head', h('h3', 'Идея'), h('span.dim.small', 'одна-две фразы: о чём ролик и где крючок')),
        area(key, ['idea'], { cls: 'big', ph: 'Например: детская поликлиника — советские Backrooms…' }),
        h('div.card-head', { style: { marginTop: '12px' } }, h('h3', 'Контекст'), h('span.dim.small', 'тон, что точно должно быть, финал, факты — это читают все кнопки ✨ и агент')),
        area(key, ['topic'], { cls: 'big', ph: 'Хочу в 3D, как Paper Mario. Тон — жутко, но смешно…' })),
      h('section.card',
        h('div.card-head', h('h3', 'Референсы'), h('span.dim.small', 'видео разберутся на кадры и речь — Claude их «посмотрит»')),
        Plan.refAdd(d, key),
        (d.refs || []).filter(r => r.kind !== 'image').map(r => Plan.refRow(d, key, r)),
        h('h4.sub', 'Картинки'), Plan.refImages(d, key)),
      h('section.card',
        h('div.card-head', h('h3', 'Вопросы Claude'),
          h('span.counter', { class: qa.length && answered === qa.length ? 'ok' : '' }, `отвечено ${answered} из ${qa.length}`), h('span.sp'), focus,
          Claude.btn({ label: qa.length ? 'Ещё вопросы' : 'Задать вопросы', action: 'questions', key, params: () => ({ n: qa.length ? 8 : 12, focus: focus.value }),
            title: 'Claude прочитает идею, контекст и референсы и спросит, что ему непонятно; ответы — решения автора для сценария и сборки' })),
        qa.length ? h('div.qround', qa.map((q, i) => Plan.qRow(d, key, q, i + 1)))
          : h('div.empty', 'Вопросов нет. Claude задаёт их на втором шаге поп-апа «Новое видео» — или нажмите «✨ Задать вопросы».'),
        addLine('+ свой вопрос — Enter', q => Store.add(key, ['qa'], { id: uid('q'), q, a: '', why: '', group: '', round: Math.max(1, ...qa.map(x => x.round || 1)), by: 'me' }), key + '|addq')),
    ];
  },

  // ---------------- основа видео: формат, подача, визуал, длина — менять можно до монтажа ----------------
  base(d, key, DL, LK) {
    const b = d.brief || {}, units = ((d.montage || {}).units || []).length;
    if (!d.brief) return null;                         // видео до поп-апа: брифа нет — старые плашки
    const mm = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const secs = v => { const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(v || ''); return m ? (m[2] != null ? +m[1] * 60 + +m[2] : +m[1] * 60) : 0; };
    const drafts = (d.elements || []).filter(e => e.status !== 'drop' && (e.renders || []).length).length;
    const save = async (patch, what) => {
      const lookOf = k => LK.find(x => x.key === k) || {};
      const warn = [];
      if (units) warn.push('Монтаж уже начат — сцены собраны под старую основу.');
      if (patch.look && drafts && (lookOf(patch.look).engine || '2d') !== (lookOf(b.look).engine || '2d')) warn.push(`Черновики препродакшена (${drafts}) нарисованы в другом движке — их придётся перерисовать.`);
      else if (patch.look && drafts) warn.push(`Черновики препродакшена (${drafts}) нарисованы в старом визуале — останутся как есть, перерисуете по желанию.`);
      if (patch.mode && d.project) warn.push('Проект ролика переключится на кадр ' + (patch.mode === 'long' ? '16:9 (1920×1080).' : '9:16 (1080×1920).'));
      if (warn.length && !confirm(`Сменить ${what}?\n\n` + warn.join('\n'))) return App.render();
      try {
        const { script } = await api('POST', '/api/videos/brief', { id: d.id, ...patch, force: units ? true : undefined });
        await Store.load(key, true);
        UI.toast(`✓ ${what[0].toUpperCase() + what.slice(1)} — сменено. Контекст для Claude обновлён`);
        if (d.project && script && confirm(`Сценарий уже написан под старую основу. Переписать его под новую (${what})?\n\nClaude перечитает бриф, референсы и ответы и напишет заново; старая версия останется во «Версиях».`)) {
          AgentPanel.toggle(true);
          AgentPanel.say(`📝 Я сменил основу видео (${what}). Перепиши сценарий заново под новый бриф: перечитай show (подача, визуал, длина, формат), мои референсы (ref list) и ответы; research.md можно взять старый. Потом montage check и montage tts.`, { mode: 'script', model: 'opus' });
        }
      } catch (e) { UI.toast(e.message, 'err'); App.render(); }
    };
    const pick = (list, cur, k, what) => sel(list.map(x => ({ value: x.key, label: x.label })), cur, v => v !== cur && save({ [k]: v }, what), { class: 'box' });
    const dl = DL.find(x => x.key === b.delivery), lk = LK.find(x => x.key === b.look);
    const len = h('input.box.len', { key: key + '|blen', value: b.len ? mm(b.len) : '', placeholder: '1:30', style: { width: '80px' },
      onkeydown: e => { if (e.key === 'Enter') e.target.blur(); },
      onchange: e => { const s = secs(e.target.value); if (!s) { UI.toast('Длина — как 1:30 или 10', 'err'); return App.render(); } if (s !== b.len) save({ len: s }, 'длину'); } });
    return h('section.card.brief-base',
      h('div.card-head', h('h3', 'Основа видео'),
        h('span.dim.small', units ? 'монтаж уже начат — менять можно, но сцены собраны под старую основу' : 'формат, подача, визуал и длина — можно поменять, пока не начат монтаж')),
      h('div.bb-grid',
        h('div.bb-f', h('label', 'Формат'), h('div.seg', [['short', 'tall', 'Шортс 9:16'], ['long', 'wide', 'Длинное 16:9']].map(([k, ic, l]) =>
          h('button', { class: (d.mode === 'long' ? 'long' : 'short') === k ? 'sel' : '', onclick: () => (d.mode === 'long' ? 'long' : 'short') !== k && save({ mode: k, ...(k === 'long' && (b.len || 0) < 180 ? { len: 600 } : k === 'short' && (b.len || 0) > 180 ? { len: 60 } : {}) }, 'формат') }, Icon(ic, 14), l)))),
        h('div.bb-f', h('label', 'Подача'), pick(DL, b.delivery, 'delivery', 'подачу'), dl && h('p.hint', dl.desc)),
        h('div.bb-f', h('label', 'Визуал'), (typeof Looks !== 'undefined' && Looks.picker(b.look, v => v !== b.look && save({ look: v }, 'визуал'))) || pick(LK, b.look, 'look', 'визуал'), lk && h('p.hint', lk.desc)),
        h('div.bb-f', h('label', 'Длина'), h('div.row', len, h('span.dim.small', b.len ? `≈ ${Math.round(b.len * 2.65)} слов` : '')))),
      typeof Pages.lkOverride === 'function' && Pages.lkOverride(d, key));   // S14: ручки и герои лука только для этого видео
  },

  // ---------------- озвучка ----------------
  voice(d, key) { return Plan.voice(d, key); },

  // ---------------- упаковка: название, описание, обложка ----------------
  pack(d, key) {
    const src = (d.pack || {}).thumb;                    // имя файла в out/ (thumbs_api.use)
    return [
      h('section.card.pk-cover',
        h('div.card-head', h('h3', 'Обложка'), h('span.sp'), h('a.btn', { href: '#/thumbs/' + d.id }, Icon('image', 14), src ? 'Сменить' : 'Сделать в «Обложках»')),
        src ? h('div.row', h('img.pk-thumb', { src: '/api/videos/cover?id=' + d.id + '&v=' + encodeURIComponent(src), alt: '', onclick: e => UI.lightbox(e.target.src) }),
          h('div.dim.small', 'Выбрана на доске «Обложки» («☆ Сделать обложкой»). При экспорте ляжет в out/ рядом с роликом.'))
          : h('p.dim', 'Обложки ещё нет: соберите её на доске «Обложки» — референсы, промпт, Higgsfield или «Claude · кодом» — и нажмите «☆ Сделать обложкой».')),
      Pack.texts(d, key),
    ];
  },
};
addEventListener('keydown', e => {
  if (e.key === 'Escape' && App.route.page === 'v' && Panels.has(App.route.tab) && !document.querySelector('.modal, .mk3menu') && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) go('#/v/' + App.route.id);
});
