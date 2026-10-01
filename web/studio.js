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

  // ✨ сценарий агентом (режим «📝 сценарий», server/agent.py): написать заново по видео / ответить на правки раскадровки
  scriptState(d) {                                          // состояние сценария проекта (правки раскадровки, заглушка ли script.md) — раз в 8 с
    const S = Plan.scriptSt[d.id];
    if (!S || Date.now() - S.at > 8000) {
      Plan.scriptSt[d.id] = Object.assign(S || {}, { at: Date.now() });
      api('GET', '/api/script/state?video=' + d.id).then(r => { const old = JSON.stringify((Plan.scriptSt[d.id] || {}).r); Plan.scriptSt[d.id].r = r; if (old !== JSON.stringify(r)) App.render(); }).catch(() => {});
    }
    return (S && S.r) || {};
  },
  scriptBtns(d) {
    const r = Plan.scriptState(d), n = r.open || 0;
    const run = (text, title) => { AgentPanel.toggle(true); AgentPanel.say(text, { mode: 'script', model: 'opus' }); UI.toast(title); };
    return [
      h('button' + (r.template ? '.primary' : ''), { title: 'Claude (Opus) напишет сценарий заново по видео: идея, твои ответы, название, препродакшен, сцены редактора; проверит по гайду и озвучит. 5–15 минут.',
        onclick: () => { if (!r.template && !confirm('Написать сценарий заново? Текущий script.md будет заменён (старый — в истории git проекта / можно попросить вернуть).')) return;
          run('📝 Напиши сценарий заново по этому видео' + (n ? ' и учти открытые правки раскадровки (ответь на каждую)' : '') + '. Потом montage check и montage tts.', '📝 Claude пишет сценарий — шаги в панели справа'); } },
        r.template ? '✨ Написать сценарий' : '✨ Написать заново'),
      n > 0 && h('button.primary', { title: 'Claude ответит на каждую правку раскадровки: фактчек — таблицей, переписать — заменой (применишь кнопкой), «весь сценарий» и картинку — поправит сам; потом проверка и голос.',
        onclick: () => run(`✍️ Отработай правки раскадровки (${n}): script notes, ответь на каждую (script reply), правь script.md. Потом montage check и montage tts.`, '✍️ Claude разбирает правки — шаги в панели справа') },
        `✍️ Исправить по правкам (${n})`),
    ];
  },
  scriptSt: {},

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
        page === 'script' && Plan.scriptBtns(d),
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
  // 🎙 Голос (S11): запись диктора целиком -> нарезка по сценам (server/voice_api.py) или черновой голос нейросетью
  voiceSt: {},
  voiceLoad(d, force) {
    const V = Plan.voiceSt[d.id] || (Plan.voiceSt[d.id] = {});
    if ((!V.r && !V.busy) || force) {
      V.busy = true;
      api('GET', '/api/voice/state?video=' + d.id).then(r => { V.r = r; V.busy = false; App.render(); }).catch(e => { V.r = { error: e.message }; V.busy = false; App.render(); });
    }
    return V.r;
  },
  voiceJob(d, url, body, toast) {
    api('POST', url, body).then(r => {
      Claude.jobs[r.job.id] = r.job;
      Claude.cbs[r.job.id] = () => { Plan.voiceLoad(d, true); if (window.MT && MT.info) delete MT.info[d.id]; };
      UI.toast(toast); App.render();
    }).catch(e => UI.toast(e.message, 'err'));
  },
  async voiceUpload(d, f) {
    if (!f) return;
    try {
      UI.toast('⬆ загружаю запись…');
      const r = await api('POST', `/api/voice/upload?video=${encodeURIComponent(d.id)}&name=${encodeURIComponent(f.name)}`, undefined, f);
      Plan.voiceJob(d, '/api/voice/split', { video: d.id, file: r.file }, '✂ Режу запись по сценам и сверяю слова — минута-две');
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  voice(d, key) {
    if (!d.project) return [h('section.card', h('h3', '🎙 Голос'), h('p', 'Голос появится, когда будет сценарий: этап «📝 Сценарий» → «🚀 Начать производство» → «✨ Написать сценарий».'),
      h('a.btn', { href: `#/p/${d.id}/script` }, '→ к сценарию'))];
    const r = Plan.voiceLoad(d), job = Claude.running('plan:' + d.id, 'voice');
    if (!r) return h('p.dim', h('span.spin'), ' читаю голос…');
    if (r.error) return h('div.badline', '⚠ ' + r.error);
    const src = r.source || {}, secs = r.sections || [], voiced = secs.filter(x => !x.silent);
    const au = (q, ttl) => h('audio', { controls: true, preload: 'none', src: `/api/voice/audio?video=${encodeURIComponent(d.id)}&${q}`, title: ttl || '' });
    const pick = () => { const i = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac,.opus,.webm', onchange: () => Plan.voiceUpload(d, i.files[0]) }); i.click(); };
    const drop = h('div.vo-drop', { tabindex: 0, onclick: pick,
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('drop'); }, ondragleave: e => e.currentTarget.classList.remove('drop'),
      ondrop: e => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const f = [...(e.dataTransfer.files || [])][0]; if (f) Plan.voiceUpload(d, f); } },
      h('b', '⬆ Запись диктора'), h('span', 'перетащи файл сюда или нажми — весь сценарий одним дублем (wav, mp3, m4a…)'),
      h('span.dim.small', 'Claude распознает речь, разрежет по сценам в паузах и сверит слова со сценарием. Черновой голос уйдёт в сторону (его можно вернуть).'));
    return [
      h('section.card',
        h('div.card-head', h('h3', '🎙 Голос'),
          h('span.dim', src.kind === 'rec' ? `🎤 запись диктора «${src.file}»` : voiced.some(x => x.file) ? `🤖 черновой голос нейросетью (${r.voice || ''} ${r.rate || ''})` : voiced.length ? 'голоса ещё нет' : 'в сценарии нет текста для голоса — ролик без диктора'),
          r.total && h('span.dim', ` · ролик ${(+r.total).toFixed(1)} с`), h('span.sp'),
          !voiced.length && secs.length > 0 && h('button', { disabled: !!job, title: 'Ролик без диктора: разметить длины тихих сцен по таймкодам сценария — по ним «⚡ Разложить по сценарию» на монтаже', onclick: () => Plan.voiceJob(d, '/api/voice/tts', { video: d.id }, '⏱ Размечаю тайминги сцен…') }, '⏱ разметить тайминги'),
          voiced.length > 0 && h('button', { disabled: !!job, title: 'Озвучить сценарий нейросетью (tts.py) — для таймингов, пока нет записи. Запись диктора уйдёт в сторону (build/vo_rec)', onclick: () => {
            if (src.kind === 'rec' && !confirm('Сейчас голос — запись диктора. Заменить её черновым голосом нейросети? (запись останется в «Записи» — нарежешь снова)')) return;
            Plan.voiceJob(d, '/api/voice/tts', { video: d.id }, '🔊 Озвучиваю сценарий нейросетью…');
          } }, src.kind === 'rec' ? '🤖 вернуть черновой голос' : voiced.some(x => x.file) ? '🔊 переозвучить черновой' : '🔊 черновой голос'),
          h('button', { onclick: () => Plan.voiceLoad(d, true), title: 'Обновить' }, '↻')),
        job ? h('p.dim', h('span.spin'), ' ', job.summary || 'работаю…') : voiced.length ? drop : null,
        (r.recordings || []).length > 0 && h('details.vo-recs', h('summary.dim.small', `Записи (${r.recordings.length})`),
          r.recordings.map(f => h('div.row.small', h('span', f), au('rec=' + encodeURIComponent(f)), h('span.sp'),
            h('button', { disabled: !!job, onclick: () => Plan.voiceJob(d, '/api/voice/split', { video: d.id, file: f }, '✂ Режу запись по сценам…') }, '✂ нарезать по сценам'))))),
      (src.diff || []).length > 0 && h('section.card.vo-diff',
        h('div.card-head', h('h3', `Расхождения записи со сценарием (${src.diff.length})`), h('span.dim.small', 'субтитры должны совпадать с голосом'), h('span.sp'),
          h('button.claude', { title: 'Агент поправит строки VO в сценарии под сказанное (имена, латиницу и цифры — как в сценарии) и пересчитает тайминги', onclick: () => {
            AgentPanel.toggle(true);
            AgentPanel.say('🎙 Голос — запись диктора. Поправь строки VO в script.md под то, что он реально сказал (имена, латиницу и цифры оставляй как в сценарии; если диктор оговорился — не правь, скажи мне). Расхождения (voice show): '
              + src.diff.map(x => `[${x.title}] в сценарии «${x.script}» → сказал «${x.said}»`).join('; ') + '. Потом voice align и montage check.', { mode: 'script', model: 'opus' });
          } }, '✨ Поправить сценарий под запись')),
        h('div.vo-difflist', src.diff.map(x => h('div.small', h('b', x.title.replace(/^[\d:.–\s—-]+/, '') + ': '), h('s', x.script || '—'), ' → ', h('span', x.said || '(не сказано)'))))),
      h('section.card', h('div.card-head', h('h3', 'По сценам'), h('span.dim.small', 'длина сцены в ролике = длина её голоса (тихие биты — по таймкоду)')),
        secs.length ? h('div.vo-secs', secs.map(x => h('div.vo-sec', { class: x.silent ? 'silent' : '' },
          h('div.row', h('b', x.title), h('span.sp'), h('span.dim.small', x.dur ? (+x.dur).toFixed(2) + ' с' : '')),
          x.silent ? h('div.dim.small', 'тихий бит — без голоса') : h('div.small', x.text),
          !x.silent && (x.file ? au('i=' + x.i) : h('span.dim.small', 'нет файла'))))) : h('p.dim', 'В сценарии нет сцен.')),
      h('p', h('a.btn', { href: `#/p/${d.id}/montage` }, 'Дальше → 🎞 Монтаж'), h('span.dim', ' — Claude соберёт ролик: сцены препродакшена под этот голос, звуки, музыка')),
    ];
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
