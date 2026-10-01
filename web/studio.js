// Claude Studio — этапы видео, которых не было в «Штурме»: Сцены, Сценарий, Голос, Монтаж, Ревью, Упаковка (S2).
// Идея, Вопросы, Название, Препродакшен — в idea.js / plan.js. Сценарий и Ревью открывают страницы проекта ролика (его review_server.py),
// Голос — как сделать озвучку; Монтаж (S6) — web/montage.js.
'use strict';

const HINTS3 = {
  scenes: `<p><b>Сцены</b> — локации ролика, собранные как репетиция: где что стоит, как ходит камера (планы и склейки), как движутся предметы и герои. Это делается в <b>🎬 редакторе сцены</b>; на монтаже (S6) маркеры сцены прилипнут к словам голоса.</p>
<p>Сцена попадает сюда из препродакшена. Старую 3D-сцену (код) переведи в редактор кнопкой «🎬 Перевести в редактор» — Claude разложит её на предметы и данные, картинка не изменится.</p>`,
  script: `<p><b>Сценарий</b> пишется по видео целиком: идея, ответы, название, препродакшен уже лежат в проекте (<code>refs/штурм.md</code>). Раскадровка открывается прямо здесь: правь текст сцен, слушай голос, оставляй заметки Claude (фактчек, переписать, картинка).</p>`,
};

Object.assign(Plan, {
  proj: {},                                           // video id -> {url, err, busy}

  // ---------------- 🎥 Сцены ----------------
  scenes(d, key) {
    const scenes = (d.elements || []).filter(e => e.kind === 'scene' && e.status !== 'drop' && !e.ws);
    return [
      hint('scenes', HINTS3.scenes),
      h('section.card',
        h('div.card-head', h('h3', '🎥 Сцены ролика'), h('span.dim', `${scenes.length}`), h('span.sp'),
          h('a.btn', { href: `#/p/${d.id}/pre` }, '🎬 препродакшен →')),
        scenes.length ? h('div.scenelist', scenes.map(e => Plan.sceneRow(d, key, e)))
          : h('div.empty', 'Сцен пока нет. Их накидывает Claude на этапе «Препродакшен» (или добавь сцену там сам).')),
    ];
  },
  sceneRow(d, key, e) {
    const r = elRender(e), st = e.stage || {}, inEd = !!st.work, df = st.diff || {};
    const cast = sceneCastOf(d, e).map(c => c.x.name);
    return h('div.scenerow',
      r ? h('img', { src: '/' + r.img, alt: '', onclick: () => UI.lightbox('/' + r.img) }) : h('div.noimg', '🎥'),
      h('div.grow',
        h('div.row', h('b', e.name), e.status === 'ok' && h('span.okb', '✓'), inEd ? h('span.stage', '🎬 в редакторе') : r && r.three ? h('span.dim.small', '3D · код (старый формат)') : h('span.dim.small', r ? '2D' : 'без черновика')),
        e.desc && h('p.dim.clamp', e.desc),
        cast.length > 0 && h('p.small', h('span.dim', 'в сцене: '), cast.join(', ')),
        inEd && h('p.small.dim', (df.frames ? (df.ok ? 'перевод: кадры совпадают ✓' : '⚠ перевод: кадры отличаются') : '') + (st.v ? ` · версия редактора v${st.v}` : '') + (st.clip ? ' · есть клип' : ''))),
      h('div.acts',
        inEd && h('button.primary', { onclick: () => go(`#/p/${d.id}/pre/${e.id}/stage`) }, '🎬 Оформить сцену'),
        !inEd && r && r.three && !r.stage && Claude.btn({ label: 'Перевести в редактор', icon: '🎬', action: 'sceneconvert', key, scope: 'sceneconvert:' + e.id, params: { el: e.id, base: r.id },
          confirm: `Claude (Opus) переведёт «${e.name}» v${r.v} в редактор сцены. Картинка не должна измениться — он сам сравнит кадры «было / стало». 5–10 минут.` }),
        h('a.btn', { href: `#/p/${d.id}/pre/${e.id}` }, 'карточка'),
        st.clip && h('a.btn', { href: '/' + st.clip.file.replace(/^render\//, 'rscene/'), target: '_blank', rel: 'noopener' }, '🎞 клип')));
  },

  // ---------------- 📝 Сценарий и 👀 Ревью: страницы проекта ролика ----------------
  projectPage(d, key, page) {
    if (!d.project) return Plan.startProduction(d, key);
    const P = Plan.proj[d.id + page] || (Plan.proj[d.id + page] = { busy: false });
    if (!P.url && !P.busy && !P.err) {
      P.busy = true;
      api('POST', '/api/studio/project', { id: d.id, page }).then(r => { P.url = r.url; P.busy = false; App.render(); })
        .catch(e => { P.err = e.message; P.busy = false; App.render(); });
    }
    return [
      page === 'script' && hint('script', HINTS3.script),
      h('div.row.projbar', h('b', page === 'script' ? '📝 Раскадровка сценария' : '👀 Ревью видео'), h('span.dim.small', `проект «${d.project || d._folder || d.name}»`), h('span.sp'),
        P.url && h('a.btn', { href: P.url, target: '_blank', rel: 'noopener' }, '↗ отдельным окном'),
        h('button', { onclick: () => { Plan.proj[d.id + page] = null; App.render(); }, title: 'Перезапустить страницу проекта' }, '↻')),
      P.err ? h('div.badline', '⚠ ' + P.err) : P.url ? h('iframe.projframe', { src: P.url, title: page === 'script' ? 'Раскадровка сценария' : 'Ревью видео' })
        : h('p.dim', h('span.spin'), ' запускаю локальный скрипт ролика…'),
    ];
  },
  script(d, key) { return Plan.projectPage(d, key, 'script'); },
  review(d, key) { return Plan.projectPage(d, key, 'review'); },

  startProduction(d, key) {
    const running = Claude.running(key, 'produce');
    return [
      hint('script', HINTS3.script),
      h('section.card',
        h('div.card-head', h('h3', '🚀 Начать производство')),
        h('p', 'Studio положит в папку этого видео проект ролика (скрипты сборки, движок, раскадровку) и выгрузит в него всё видео: идею, ответы, название, препродакшен со звуками — ',
          h('code', 'refs/штурм.md'), ', ', h('code', 'refs/препродакшен/'), '.'),
        h('p.dim', 'Потом здесь откроется раскадровка сценария. Сценарий пишет Claude: в чате Claude Code — «сделай сценарий по видео «' + d.name + '»» (в S7 — кнопка ✨ Собрать прямо здесь).'),
        running ? h('p.dim', h('span.spin'), ' кладу шаблон и ставлю зависимости — до минуты…')
          : h('button.primary', { onclick: async () => {
            try { const r = await api('POST', '/api/produce', { id: d.id, name: d.name }); Claude.jobs[r.job.id] = r.job; App.render(); }
            catch (e) { UI.toast(e.message, 'err'); }
          } }, '🚀 Начать производство')),
    ];
  },

  // ---------------- 🎙 Голос и 🎞 Монтаж — S6 ----------------
  voice(d, key) {
    return [h('section.card', h('h3', '🎙 Голос'),
      h('p', 'Голос ролика — дорожка слов на этапе «🎞 Монтаж»: к словам прилипают маркеры сцен, по ним же идут субтитры. Делается так:'),
      h('ul', h('li', 'кнопка «🔊 Переозвучить» в раскадровке (этап «Сценарий»), или ', h('code', 'python tts.py'), ' в папке проекта;'),
        h('li', 'своя озвучка — файлы в ', h('code', 'build/vo/'), ' и ', h('code', 'python align.py'), '.')),
      d.project && h('div.row', h('a.btn', { href: `#/p/${d.id}/script` }, '📝 к раскадровке →'), h('a.btn', { href: `#/p/${d.id}/montage` }, '🎞 к монтажу →')))];
  },


  // ---------------- 📦 Упаковка: обложка (+ названия и описания — S8) ----------------
  pack(d, key, M) {
    return [
      h('section.card', h('div.card-head', h('h3', '📦 Упаковка'), h('span.dim', 'обложка и первый кадр — ниже; названия, описания, хэштеги и «Права» — этап S8')),
        (d.titles || []).filter(t => t.star).length > 0 && h('p', h('span.dim', 'Финалисты названия: '), d.titles.filter(t => t.star).map(t => '«' + t.text + '»').join(' · '))),
      Plan.thumbs(d, key, M),
    ];
  },
});
