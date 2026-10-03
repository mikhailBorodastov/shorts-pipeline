// Claude Studio — S12.6: препродакшен внутри окна видео #/v/<id>/pre[/<el>] (docs/studio/stage12-redesign.md §7).
// Вкладки видов «Все · Персонажи · Пропсы · Сцены · Звуки · Эффекты · B-roll»; карточки и карточка элемента — прежние (idea.js: kindBox, element),
// новое — B-roll (кусок видео: файл, ссылка, YouTube по таймкоду) и эффекты (vfx — рисуются как пропсы, анимированы по T).
'use strict';

const PRE = { tab: Local.get('pretab') || 'all' };

Object.assign(Plan, {
  // ✨ Сделать всё (S12.13): черновики всех элементов без черновика — в очередь Claude. Порядок: персонажи, пропсы, эффекты, звуки, сцены
  // (сервер запускает по «Claude одновременно» из ⚙ Настроек, сцена ждёт черновики своего состава). B-roll — нет: ему нужен источник.
  doAllTodo(d, key, live) {
    const order = { char: 0, prop: 1, vfx: 2, sound: 3, scene: 4 };
    return live.filter(e => e.kind in order && !(e.from && e.from.scene))
      .filter(e => e.kind === 'sound' ? !(e.sounds || []).length : !elRender(e))
      .filter(e => !Claude.running(key, e.kind === 'sound' ? 'sound:' + e.id : 'element:' + e.id))
      .sort((a, b) => order[a.kind] - order[b.kind]);
  },
  // одна кнопка на всё видео (шапка) или на одну группу (kind — в шапке группы: «все персонажи» и т.п.)
  doAllBtn(d, key, live, kind) {
    const todo = this.doAllTodo(d, key, live).filter(e => !kind || e.kind === kind), q = Claude.queued();
    if (!todo.length) return !kind && q ? h('span.dim.small', Icon('hourglass', 13), ` в очереди: ${q}`) : null;
    return h('button.claude' + (kind ? '.mini' : ''), { title: (kind ? 'Черновики всех элементов этой группы, у которых их ещё нет' : 'Черновики всех элементов, у которых их ещё нет')
        + ', — в очередь Claude' + (kind ? '' : ': сначала персонажи, пропсы, эффекты и звуки, сцены — после своего состава') + '. Сколько сразу — ⚙ Настройки → «Claude одновременно»',
      onclick: () => this.doAllRun(key, todo) }, Icon('sparkles', 14), kind ? `Сделать все (${todo.length})` : `Сделать всё (${todo.length})`);
  },
  async doAllRun(key, todo) {
    const by = {}; for (const e of todo) by[e.kind] = (by[e.kind] || 0) + 1;
    const names = { char: 'персонажей', prop: 'пропсов', vfx: 'эффектов', sound: 'звуков', scene: 'сцен' };
    if (!confirm(`Поставить в очередь Claude ${todo.length}: ${Object.entries(by).map(([k, n]) => `${names[k]} ${n}`).join(', ')}?
Работают по несколько сразу (⚙ Настройки), остальные ждут. Каждый черновик тратит лимит подписки Claude.`)) return;
    for (const e of todo) {
      const mk3 = isRigChar(e) || isProp3(e);
      if (e.kind === 'sound') await Claude.run({ action: 'sound', key, scope: 'sound:' + e.id, params: { el: e.id } });
      else await Claude.run({ action: mk3 ? 'make3d' : 'element', key, scope: 'element:' + e.id, params: { el: e.id } });
    }
    UI.toast(`В очереди Claude: ${todo.length}`);
  },

  // 🎞 B-roll: источник (ссылка / YouTube / файл), «с … по …», чьи кадры → «⬇ Взять кусок» (задача brollfetch) → плеер
  elBroll(d, key, e) {
    const B = e.broll || {}, scope = 'broll:' + e.id, run = Claude.running(key, scope);
    const k = 'broll|' + e.id + '|';
    const val = n => Drafts[k + n] ?? (n === 'src' ? (B.src && /^https?:/.test(B.src) ? B.src : '') : B[n] || '');
    const inp = (n, ph, cls) => draftInput(k + n, { class: 'box ' + (cls || ''), placeholder: ph, value: val(n) });
    const file = h('input', { type: 'file', accept: 'video/*', hidden: true, onchange: async ev => {
      const f = ev.target.files[0]; if (!f) return;
      UI.toast('⬆ загружаю ' + f.name + '…');
      try { const r = await api('POST', `/api/videos/brollup?id=${d.id}&el=${e.id}&name=${encodeURIComponent(f.name)}`, undefined, f); Drafts[k + 'src'] = r.src; Drafts[k + 'srcName'] = r.name; App.render(); }
      catch (er) { UI.toast(er.message, 'err'); }
    } });
    const fetchIt = () => {
      const src = (Drafts[k + 'src'] ?? val('src')).trim();
      if (!src) return UI.toast('Нужна ссылка или файл', 'err');
      Claude.run({ action: 'brollfetch', key, scope, params: { key, el: e.id, src, from: (Drafts[k + 'from'] ?? val('from')).trim(), to: (Drafts[k + 'to'] ?? val('to')).trim(), owner: (Drafts[k + 'owner'] ?? val('owner')).trim() } });
    };
    return [
      h('div.card-head', h('h3', '🎞 Кадры'), h('span.dim.small', 'кусок реального видео — монтаж вставит его в ролик; чужие кадры попадут в «Права» упаковки')),
      B.file ? h('div.broll-play', h('video', { controls: true, preload: 'metadata', src: '/' + B.file + '?v=' + (B.at || 0), poster: B.thumb ? '/' + B.thumb : null }),
        h('div.dim.small', [B.title, B.dur ? `${B.dur.toFixed(1)} с` : '', B.w ? `${B.w}×${B.h}` : '', B.from || B.to ? `кусок ${B.from || '0'}–${B.to || 'конец'}` : '', B.owner ? 'кадры: ' + B.owner : ''].filter(Boolean).join(' · ')))
        : h('div.broll-empty', Icon('film', 26), h('span.dim', 'Кадров пока нет — укажите источник ниже.')),
      h('label', 'Источник', h('span.dim', ' — ссылка (YouTube и всё, что умеет yt-dlp) или файл с компьютера')),
      h('div.row', inp('src', 'https://youtu.be/…', 'grow'), file, h('button', { onclick: () => file.click(), title: 'Файл с компьютера' }, Icon('folder', 14), 'Файл…')),
      Drafts[k + 'srcName'] && h('div.dim.small', '📄 ' + Drafts[k + 'srcName']),
      h('div.row', h('label.inl', 'с', inp('from', '1:23.5', 'ts')), h('label.inl', 'по', inp('to', '1:31', 'ts'))),
      h('label', 'Чьи кадры', h('span.dim', ' — для «Прав» в упаковке')), inp('owner', 'Capcom / Nintendo / автор ролика', 'wide'),
      h('div.row', h('span.dim.small', 'Кусок — с/по в минутах:секундах; пусто — целиком. Для ссылки скачивается только кусок (до 1080p).'), h('span.sp'),
        run ? h('button.claude.run', { title: 'Отменить', onclick: () => api('POST', '/api/job/cancel?id=' + run.id).catch(() => {}) }, h('span.spin'), ' ', run.summary || 'качаю…', ' ✕')
          : h('button.primary', { onclick: fetchIt }, Icon('download', 14), B.file ? 'Взять заново' : 'Взять кусок')),
    ];
  },

  // препродакшен окна видео: шапка, вкладки видов, разделы (или карточка элемента)
  preWs(d, key, sub) {
    const els = (d.elements || []).filter(e => !e.ws);
    if (sub) {
      const e = els.find(x => x.id === sub);
      if (e) return h('div.ws-pre', h('div.ws-pre-in', Plan.element(d, key, Montage.M(d), e)));
    }
    const live = els.filter(e => e.status !== 'drop'), ready = live.filter(e => e.status === 'ok').length;
    const SS = Plan.scriptState ? Plan.scriptState(d) : {}, hasScript = SS.project && !SS.template;
    const focus = h('input.box', { key: key + '|pfocus', placeholder: 'чего не хватает? Claude учтёт', style: { width: '240px' },
      value: Local.get('pfocus:' + d.id) || '', oninput: e => Local.set('pfocus:' + d.id, e.target.value) });
    const cnt = k => { const a = live.filter(e => e.kind === k); return [a.filter(e => e.status === 'ok').length, a.length]; };
    const tabs = [['all', 'Все', [ready, live.length]], ...REF.kinds.map(K => [K.key, K.label, cnt(K.key)])];
    const shown = PRE.tab === 'all' ? REF.kinds : REF.kinds.filter(K => K.key === PRE.tab);
    return h('div.ws-pre', h('div.ws-pre-in',
      h('div.ws-pre-head',
        h('h2', 'Препродакшен'), h('span.counter', { class: live.length && ready === live.length ? 'ok' : '' }, `утверждено ${ready} из ${live.length}`),
        h('span.sp'),
        h('span.row.small', { title: 'Как Claude рисует черновики сцен: бумажный коллаж или картонная 3D-диорама' }, 'сцены:',
          h('div.seg', [['2d', '2D'], ['3d', '3D']].map(([k, l]) => h('button', { class: (d.engine || '2d') === k ? 'sel' : '', onclick: () => Store.set(key, ['engine'], k, true) }, l)))),
        focus,
        Claude.btn({ label: hasScript ? (live.some(e => e.kind === 'scene') ? 'Накидать ещё' : 'Накидать по сценарию') : live.length ? 'Накидать ещё' : 'Накидать элементы', action: 'elements', key,
          params: () => ({ focus: focus.value, kind: PRE.tab !== 'all' ? PRE.tab : undefined }),
          title: hasScript ? 'Claude разложит сценарий: каждой сцене сценария — сцена препродакшена, персонажи, пропсы, звуки, эффекты и B-roll — из «Картинки» и текста' : 'Claude соберёт элементы по идее и твоим ответам' }),
        Plan.doAllBtn(d, key, live)),
      !hasScript && h('div.ws-pre-note', '📝 Сначала сценарий — сцены препродакшена строятся по нему (каждой сцене сценария — своя). Можно и без него: тогда Claude накидает по идее и ответам.'),
      h('div.seg.ws-pre-tabs', tabs.map(([k, l, [ok, n]]) => h('button', { class: PRE.tab === k ? 'sel' : '', onclick: () => { PRE.tab = k; Local.set('pretab', k); App.render(); } },
        l, n ? h('span.c', { class: ok === n ? 'ok' : '' }, `${ok}/${n}`) : null))),
      shown.map(K => Plan.kindBox(d, key, K, focus)),
      h('div.ws-pre-foot', h('span.dim.small', 'Всё утверждено и «Для финала» написано — дальше синхронизация и монтаж.'), h('span.sp'),
        h('button.primary', { onclick: () => go(`#/v/${d.id}`), title: 'Назад к превью и таймлайну' }, '▶ К монтажу'))));
  },
});
