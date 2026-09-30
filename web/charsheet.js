// Лист персонажа со скелетом (S4 Claude Studio, docs/studio/stage4-characters.md §4): #/lib/char/<slug>
// Превью — стенд /render/char.html (поза, костюмы, эмоция, скелет поверх), вкладки Костюмы / Эмоции / Анимации (S5) / Версии.
const CS = { slug: '', info: null, busy: false, tab: 'costumes', wear: {}, pose: '', emotion: '', skel: true, err: '', want: '' };

const CharSheet = {
  async load(slug, force) {
    if (CS.slug === slug && CS.info && !force) return;
    CS.slug = slug; CS.busy = true; CS.err = '';
    try { CS.info = await api('GET', '/api/char?slug=' + encodeURIComponent(slug)); if (!force) { CS.wear = {}; CS.pose = ''; CS.emotion = ''; } }
    catch (e) { CS.err = e.message; CS.info = null; }
    CS.busy = false; App.render();
  },
  src(extra = '', o = {}) {
    const I = CS.info, P = (I.skel && I.skel.poses) || {};
    return `/render/char.html?char=${encodeURIComponent(I.url)}&size=${o.size || '900x1000'}&bg=%23ece6da` + (CS.skel && !o.noSkel ? '&skel=1' : '')
      + (Object.keys(CS.wear).length ? '&wear=' + encodeURIComponent(JSON.stringify(CS.wear)) : '')
      + (CS.pose && P[CS.pose] ? '&pose=' + encodeURIComponent(JSON.stringify(P[CS.pose])) : '')
      + (CS.emotion ? '&emotion=' + encodeURIComponent(CS.emotion) : '') + extra;
  },
  view(slug) {
    if (CS.slug !== slug || (!CS.info && !CS.busy && !CS.err)) CharSheet.load(slug);
    const I = CS.info;
    if (CS.err) return h('div', h('p', h('a', { href: '#/lib' }, '← библиотека')), h('p.warn', CS.err));
    if (!I) return h('p.dim', 'Загружаю персонажа…');
    const card = I.card, r = I.rigged;
    if (!r) return h('div', h('p', h('a', { href: '#/lib' }, '← библиотека')), h('h1', card.name),
      h('p.dim', 'У этого персонажа пока только 2D-лист (v' + card.latest + '), скелета нет. Персонажа со скелетом собирает «🦴 Собрать персонажа» в карточке препродакшена.'));
    const P = Object.keys((I.skel && I.skel.poses) || {});
    const tabs = [['costumes', `👕 Костюмы · ${I.costumes.length}`], ['emotions', `🙂 Эмоции · ${Object.keys(I.emotions).length}`], ['anims', '🎞 Анимации'], ['versions', `🕘 Версии · ${card.versions.length}`]];
    return h('div.charsheet',
      h('p', h('a', { href: '#/lib' }, '← библиотека')),
      h('div.phead', h('h1', '🦴 ' + card.name), h('span.dim', `скелет ${I.skeleton} · риг ${r.rig === 'param' ? 'по параметрам (drawHog)' : 'частями'} · v${r.v} · lib:characters/${I.slug}@${r.v}`)),
      card.desc && h('p.dim', card.desc),
      h('div.cs-main',
        h('div.cs-prev',
          h('iframe', { src: CharSheet.src(), title: 'Персонаж', key: 'csprev|' + CharSheet.src() }),
          h('div.row.wrap',
            h('label.small', h('input', { type: 'checkbox', checked: CS.skel, onchange: e => { CS.skel = e.target.checked; App.render(); } }), ' кости'),
            h('select.small', { onchange: e => { CS.pose = e.target.value; App.render(); } }, h('option', { value: '' }, 'поза: база'), P.map(p => h('option', { value: p, selected: CS.pose === p }, p))),
            h('select.small', { onchange: e => { CS.emotion = e.target.value; App.render(); } }, h('option', { value: '' }, 'эмоция: база'),
              Object.keys(I.emotions).map(k => h('option', { value: k, selected: CS.emotion === k }, k + (I.emotions[k].ok ? ' ✓' : ' ?'))))),
          h('p.dim.small', I.same.length ? 'На этом скелете ещё: ' + I.same.map(x => x.name).join(', ') + ' — анимации типа (S5) общие.' : `Скелет «${I.skeleton}» пока только у этого персонажа; анимации (S5) будут общими для всех на нём.`)),
        h('div.cs-tabs',
          h('div.tabs', tabs.map(([k, l]) => h('a', { class: CS.tab === k ? 'on' : '', href: 'javascript:void 0', onclick: () => { CS.tab = k; App.render(); } }, l))),
          CS.tab === 'costumes' ? CharSheet.costumes(I) : CS.tab === 'emotions' ? CharSheet.emotions(I) : CS.tab === 'versions' ? CharSheet.versions(I)
            : CharSheet.anims(I))));
  },
  costumes(I) {
    const base = {};
    return h('div',
      h('p.dim.small', 'Надень и сними на превью. В сцене — галочки в свойствах персонажа (ключ на текущем моменте).'),
      I.costumes.length ? h('div.cs-list', I.costumes.map(c => {
        const on = CS.wear[c.id] != null ? CS.wear[c.id] : null;
        return h('div.row', h('b', c.name), h('span.dim.small', `слот ${c.slot || '—'} · ${c.id}`), h('span.sp'),
          h('div.seg', [[null, 'как у персонажа'], [true, 'надеть'], [false, 'снять']].map(([v, l]) => h('button.small', { class: on === v ? 'sel' : '', onclick: () => { if (v === null) delete CS.wear[c.id]; else CS.wear[c.id] = v; App.render(); } }, l))));
      })) : h('p.dim', 'Костюмов пока нет.'), void base);
  },
  emotions(I) {
    const running = Object.values(Claude.jobs).find(j => j.status === 'running' && j.key === 'char:' + I.slug && j.scope === 'emotions');
    const act = async (name, a) => { try { await api('POST', '/api/char/emotion', { slug: I.slug, name, act: a }); await CharSheet.load(I.slug, true); } catch (e) { UI.toast(e.message, 'err'); } };
    const ask = async () => {
      try {
        const r = await api('POST', '/api/char/emotions', { slug: I.slug, want: CS.want });
        Claude.jobs[r.job.id] = r.job; UI.toast('Claude придумывает эмоции — полминуты…'); App.render();
        const poll = async () => { const j = await api('GET', '/api/job?id=' + r.job.id); Claude.jobs[j.id] = j;
          if (j.status === 'running') return setTimeout(poll, 1500);
          UI.toast(j.status === 'done' ? j.summary : (j.error || j.status), j.status === 'done' ? 'ok' : 'err'); CharSheet.load(I.slug, true); };
        poll();
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    const E = Object.entries(I.emotions);
    return h('div',
      E.length ? h('iframe.cs-grid', { src: CharSheet.src('&emotions=1', { noSkel: true, size: '1400x' + Math.ceil(E.length / 4) * 440 }), title: 'Эмоции', key: 'csem|' + E.map(([k, v]) => k + v.ok).join(),
        style: { aspectRatio: `1400 / ${Math.ceil(E.length / 4) * 440}` } }) : null,
      h('div.cs-list', E.map(([k, v]) => h('div.row', h('b', (v.ok ? '✓ ' : '? ') + k), v.note && h('span.dim.small', v.note), h('span.sp'),
        v.src === 'prefab' ? h('span.dim.small', 'из версии') : [
          !v.ok && h('button.small.primary', { onclick: () => act(k, 'ok') }, '✓ утвердить'),
          v.ok && h('button.small', { onclick: () => act(k, 'no') }, 'снять ✓'),
          h('button.small', { title: 'Убрать эмоцию', onclick: () => act(k, 'drop') }, '✗')],
        h('button.small', { title: 'Показать на превью', onclick: () => { CS.emotion = k; App.render(); } }, '👁')))),
      h('div.row', draftInput('cswant|' + I.slug, { class: 'box grow', placeholder: 'какие ещё? «хитрый, растерянный» — или пусто: недостающие базовые', oninput: e => { CS.want = e.target.value; } }),
        h('button.primary', { disabled: !!running, onclick: ask }, running ? '…Claude думает' : '✨ Предложить эмоции')),
      h('p.dim.small', 'Claude (Sonnet) подбирает параметры лица (брови, рот, веко, взгляд); ты утверждаешь ✓ по одной. Утверждённые видны в редакторе сцены в списке эмоций.'));
  },
  // 🎞 движения типа скелета (S5): общие для всех персонажей на нём; ▶ — на этом персонаже, «+ научить» — Claude (Opus)
  anims(I) {
    if (!CS.anims || CS.animsFor !== I.skeleton) {
      CS.animsFor = I.skeleton; CS.anims = null;
      api('GET', `/api/anims?type=${encodeURIComponent(I.skeleton)}`).then(j => { CS.anims = j.items; App.render(); }).catch(() => { CS.anims = []; App.render(); });
      return h('p.dim', 'Загружаю движения…');
    }
    const running = Object.values(Claude.jobs).find(j => j.status === 'running' && j.scope === 'teach:' + I.skeleton);
    const play = a => UI.modal(`🎞 ${a.name} · ${I.card.name}`, h('div.view3d', h('iframe', { src: `/render/char.html?char=${encodeURIComponent(I.url)}&anim=${encodeURIComponent(`/api/lib/file/${I.channel}/anims/${a.id}.json`)}&size=900x1000`, title: a.name, style: { height: '70vh' } })), { wide: true });
    const teach = async () => {
      const ask = (CS.teach || '').trim(); if (!ask) { UI.toast('Опиши движение словами', 'err'); return; }
      try {
        const r = await api('POST', '/api/char/teach', { type: I.skeleton, ask, char: I.url });
        Claude.jobs[r.job.id] = r.job; CS.teach = ''; App.render(); UI.toast('✨ Claude учит движение — 1–10 минут');
        const poll = async () => { const j = await api('GET', '/api/job?id=' + r.job.id); Claude.jobs[j.id] = j;
          if (j.status === 'running') return setTimeout(poll, 2000);
          UI.toast(j.status === 'done' ? j.summary : (j.error || j.status), j.status === 'done' ? 'ok' : 'err'); CS.anims = null; App.render(); };
        poll();
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    return h('div',
      h('p.dim.small', `Движения скелета «${I.skeleton}» — общие для всех персонажей на нём${I.same.length ? ' (' + I.same.map(x => x.name).join(', ') + ')' : ''}. В сцене — Tab на персонаже.`),
      h('div.cs-list', (CS.anims || []).map(a => h('div.row',
        a.preview ? h('img.cs-strip', { src: a.preview, alt: '', onclick: () => play(a), title: 'Лента кадров — клик: посмотреть на этом персонаже' }) : h('button.small', { onclick: () => play(a) }, '▶'),
        h('div', h('b', a.name + (a.by === 'claude' ? ' ✨' : '')), h('div.dim.small', `${a.id} · ${a.dur} с${a.loop ? ' · петля' : ''}${a.proc ? ' · от пройденного пути' : ''}`), a.prompt && h('div.dim.small', a.prompt)),
        h('span.sp'), h('button.small', { onclick: () => play(a), title: 'Посмотреть на этом персонаже' }, '▶')))),
      h('div.row', draftInput('csteach|' + I.slug, { class: 'box grow', placeholder: '«чешет затылок левой лапой», «топает от злости», «кланяется»', oninput: e => { CS.teach = e.target.value; },
        onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) teach(); } }),
        h('button.primary', { disabled: !!running, onclick: teach }, running ? '…Claude учит' : '+ научить')),
      h('p.dim.small', 'Claude (Opus) пишет движение данными (кости, лицо, IK), снимает ленту кадров на персонаже, проверяет и кладёт в библиотеку типа скелета.'));
  },
  versions(I) {
    return h('div.cs-list', I.card.versions.slice().reverse().map(v => h('div.row',
      v.preview && h('img.cs-thumb', { src: `/api/lib/file/${I.channel}/characters/${I.slug}/${v.preview}`, alt: '', onclick: () => UI.lightbox(`/api/lib/file/${I.channel}/characters/${I.slug}/${v.preview}`) }),
      h('div', h('b', 'v' + v.v + (v.rig ? ` · 🦴 ${v.skeleton} (${v.rig})` : ' · 2D-лист')), h('div.dim.small', (v.from && v.from.videoName ? 'из «' + v.from.videoName + '» · ' : '') + new Date(v.ts).toLocaleString('ru')),
        v.note && h('div.dim.small', v.note)))));
  },
};
