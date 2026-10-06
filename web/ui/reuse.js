// Claude Studio — S15 «Уже было» (docs/studio/stage15-reuse.md): после «✨ Накидать» сервер ищет новых персонажей, пропсы и звуки
// в библиотеке канала и прошлых видео (reuse_api.py) -> e.libMatch. Здесь — поп-ап «Нашлось в библиотеке» и значки на карточках.
// Решение: Как есть (копия, ✓, без черновика) / За основу (копия + правка Claude под ролик) / Новый (рисовать с нуля) -> POST /api/lib/reuse.
'use strict';

const Reuse = {
  shown: new Set(),                                   // какие наборы находок уже всплывали в этой вкладке (элемент + время поиска)
  undecided: d => (d.elements || []).filter(e => e.libMatch && e.libMatch.state === 'found' && !e.libMatch.pick && e.status !== 'drop'),
  waiting: d => (d.elements || []).filter(e => e.libMatch && e.libMatch.state === 'wait' && !e.libMatch.pick),
  holds: e => !!(e.libMatch && ['wait', 'found'].includes(e.libMatch.state) && !e.libMatch.pick),
  job: key => Object.values(Claude.jobs).find(j => j.kind === 'reuse' && j.key === key && (j.status === 'running' || j.status === 'queued')),
  HOW: { 'as-is': 'Как есть', base: 'За основу', new: 'Новый' },

  // всплыть само: есть нерешённые находки, которых в этой вкладке ещё не показывали
  auto(d, key) {
    const list = this.undecided(d).filter(e => !this.shown.has(e.id + '@' + e.libMatch.at));
    if (!list.length || document.querySelector('.modal')) return;
    setTimeout(() => { if (!document.querySelector('.modal')) this.open(d, key); }, 50);
  },

  // кнопки шапки препродакшена: «📚 Находки (N)», «🔎 Проверить библиотеку» / «ищу в библиотеке…»
  head(d, key) {
    const n = this.undecided(d).length, j = this.job(key);
    return [
      n > 0 && h('button.primary', { title: 'Это уже делали в прошлых видео — решить: взять как есть, за основу или рисовать новое', onclick: () => this.open(d, key) }, `📚 Находки (${n})`),
      j ? h('button.claude.run', { title: (j.summary || 'Claude сверяет новые элементы с библиотекой и прошлыми видео') + ' — снять', onclick: () => api('POST', '/api/job/cancel?id=' + j.id).catch(() => {}) },
        h('span.spin'), ' ', j.status === 'queued' ? 'поиск в библиотеке ждёт…' : 'ищу в библиотеке…', ' ✕')
        : h('button.ghost', { title: 'Поискать в библиотеке канала и прошлых видео персонажей, пропсы и звуки этого видео, у которых ещё нет черновика', onclick: () => this.check(key) }, '🔎 Проверить библиотеку'),
    ];
  },
  async check(key, els) {
    try {
      const r = await api('POST', '/api/lib/reuse/check', { key, els });
      if (!r.job) return UI.toast('Проверять нечего: у всех элементов уже есть черновик или решение, или в библиотеке нет ничего того же вида');
      Claude.jobs[r.job.id] = r.job; App.render(); UI.toast('🔎 Ищу в библиотеке и прошлых видео…');
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  // значок на карточке элемента
  tag(d, key, e) {
    const m = e.libMatch;
    if (!m) return null;
    if (m.pick) {
      const p = m.pick;
      return p.how === 'new' ? null : h('span.reuse-tag.done', { title: `${this.HOW[p.how]}: ${p.ref}` }, p.how === 'base' ? '📚 за основу' : '📚 из библиотеки');
    }
    if (m.state === 'wait') return h('span.reuse-tag.wait', { title: 'Claude ищет это в библиотеке и прошлых видео — черновик подождёт' }, '🔎 ищу в библиотеке');
    if (m.state === 'found') return h('button.reuse-tag.found', { title: 'Нашлось уже сделанное — решить', onclick: ev => { ev.stopPropagation(); this.open(d, key, e.id); } },
      `📚 ждёт решения · ${m.found.length}`);
    return null;
  },

  // блок на странице элемента: что нашлось / что выбрано (+ отменить)
  panel(d, key, e) {
    const m = e.libMatch;
    if (!m || (m.state !== 'found' && !m.pick)) return null;
    if (m.pick) {
      const f = (m.found || []).find(x => x.ref === (m.pick.from || m.pick.ref));
      return h('div.reuse-panel.done', h('span', m.pick.how === 'new' ? '📚 Нашлось в библиотеке — решили рисовать новый' : `📚 ${this.HOW[m.pick.how]}: ${m.pick.ref}` + (f && f.videoName ? ` (из «${f.videoName}»)` : '')),
        h('span.sp'), e.status !== 'ok' && h('button.ghost', { title: 'Вернуть элемент к выбору: скопированное из библиотеки уйдёт из него', onclick: () => this.undo(key, e) }, '↺ Передумать'),
        m.found && m.found.length > 0 && h('button.ghost', { onclick: () => this.open(d, key, e.id) }, 'Находки'));
    }
    return h('div.reuse-panel', h('span', `📚 Это, похоже, уже делали: находок ${m.found.length}. Пока не решишь, черновик не рисуется.`), h('span.sp'),
      h('button.primary', { onclick: () => this.open(d, key, e.id) }, 'Посмотреть и решить'));
  },
  async undo(key, e) {
    if (!confirm(`Передумать по «${e.name}»? Скопированное из библиотеки уйдёт из элемента, он снова будет ждать решения.`)) return;
    try { await api('POST', '/api/lib/reuse', { key, el: e.id, how: 'undo' }); await Store.load(key, true); App.render(); }
    catch (er) { UI.toast(er.message, 'err'); }
  },

  // поп-ап: по элементу — найденные карточки (выбор одной) + Как есть / За основу / Новый
  open(d, key, only) {
    const list = this.undecided(d).filter(e => !only || e.id === only);
    const all = this.undecided(d).length;
    list.forEach(e => this.shown.add(e.id + '@' + e.libMatch.at));
    if (!list.length) return UI.toast('Нерешённых находок нет');
    const baseOnly = e => e.kind === 'scene' || e.kind === 'vfx';   // S15 ч.2: место и эффект — только за основу (код подгоняется под ролик)
    const sel = {};
    for (const e of list) { const f = e.libMatch.found[0]; sel[e.id] = { ref: f.ref, how: baseOnly(e) ? 'base' : f.suggest || 'base' }; }
    const K = { char: 'персонаж', prop: 'пропс', sound: 'звук', scene: d.locations ? 'локация' : 'сцена', vfx: 'эффект' };
    const body = h('div.reuse');
    const card = (e, f) => {
      const s = sel[e.id], on = s.how !== 'new' && s.ref === f.ref;
      return h('div.reuse-hit', { class: on ? 'sel' : '', onclick: ev => { if (ev.target.closest('audio')) return; s.ref = f.ref; if (s.how === 'new') s.how = f.suggest || 'base'; draw(); } },
        f.img ? h('img', { src: f.img, alt: '', title: 'Открыть крупно', onclick: ev => { ev.stopPropagation(); UI.lightbox(f.img); } }) : h('div.noimg', e.kind === 'sound' ? '🔊' : '📦'),
        h('div.reuse-txt',
          h('b', f.name || f.ref),
          h('div.dim.small', [f.src === 'lib' ? '📚 библиотека' : '🎞 прошлое видео', f.ref.startsWith('lib:') ? 'v' + f.ref.split('@')[1] : '', f.dim === '3d' ? '3D' : '', f.own ? `📎 свой ассет · ${f.own} сост.` : '',
            f.videoName ? `из «${f.videoName}»` : '', `похоже на ${Math.round(f.score * 100)}%`].filter(Boolean).join(' · ')),
          f.why && h('div.small', f.why),
          f.diff && h('div.small.reuse-diff', '✏️ отличие: ' + f.diff),
          f.audio && h('audio', { controls: true, preload: 'none', src: f.audio })));

    };
    const row = e => {
      const s = sel[e.id], found = e.libMatch.found;
      return h('div.reuse-row',
        h('div.reuse-need', h('span.dim.small', K[e.kind] || e.kind), h('b', e.name || '(без названия)'), e.desc && h('div.dim.small', e.desc)),
        h('div.reuse-hits', found.map(f => card(e, f))),
        h('div.reuse-how',
          h('div.seg', (baseOnly(e) ? ['base', 'new'] : ['as-is', 'base', 'new']).map(k => h('button', { class: s.how === k ? 'sel' : '', onclick: () => { s.how = k; draw(); },
            title: { 'as-is': 'Взять готовое без правок: элемент сразу ✓, черновик не рисуется',
              base: 'Взять готовое и доработать под этот ролик: Claude поправит копию по «отличию»',
              new: 'Не брать: Claude нарисует новый с нуля' }[k] }, this.HOW[k]))),
          s.how === 'base' && h('span.dim.small', (found.find(f => f.ref === s.ref) || {}).diff ? 'правка — «отличие» под картинкой' : 'отличий нет — копия встанет черновиком, поправишь сам'),
          s.how !== 'new' && (() => { const f = found.find(x => x.ref === s.ref) || {};
            return f.src === 'video' && h('span.dim.small', baseOnly(e) ? 'черновик скопируется, Claude подгонит его под ролик (в редактор — как новая)'
              : f.own ? 'свой ассет — картинки состояний скопируются в это видео' : 'из прошлого видео — заодно попадёт в 📚 библиотеку'); })()));
    };
    const draw = () => keepScroll(body, () => body.replaceChildren(
      h('p.dim.small.reuse-lead', 'Claude сверил новые элементы с библиотекой канала и утверждёнными ассетами прошлых видео. Реши, что брать готовым — эти элементы не придётся рисовать заново.'),
      ...list.map(row),
      h('div.row.reuse-foot', h('span.dim.small', only && all > 1 ? `ещё нерешённых: ${all - 1}` : ''), h('span.sp'),
        h('button', { title: 'Закрыть: на карточках останется «📚 ждёт решения», черновики этих элементов подождут', onclick: () => close() }, 'Позже'),
        h('button.primary', { onclick: () => this.apply(key, list, sel, close) }, `Применить (${list.length})`))));
    draw();
    const close = UI.modal(only ? `📚 Нашлось в библиотеке: ${list[0].name}` : `📚 Нашлось в библиотеке · ${list.length}`, body, { wide: true });
    body.closest('.modal').classList.add('reuse-modal');   // над панелью Claude (#agentpanel, z 960): окно решения не должно прятаться под ней
  },

  async apply(key, list, sel, close) {
    const n = { 'as-is': 0, base: 0, new: 0 }, errs = [];
    close();
    UI.toast('📚 Применяю…');
    for (const e of list) {
      const s = sel[e.id];
      try {
        const r = await api('POST', '/api/lib/reuse', { key, el: e.id, how: s.how, ref: s.how === 'new' ? '' : s.ref });
        n[s.how]++;
        if (r.job) Claude.jobs[r.job.id] = r.job;
        if (r.note) UI.toast(`«${e.name}»: ${r.note}`);
      } catch (er) { errs.push(`«${e.name}»: ${er.message}`); }
    }
    await Store.load(key, true); App.render();
    if (errs.length) UI.toast(errs.join('; '), 'err');
    else UI.toast(`📚 Как есть: ${n['as-is']} · за основу: ${n.base} (правки — в очереди Claude) · новые: ${n.new}`);
  },
};
