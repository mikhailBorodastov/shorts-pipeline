// Claude Studio — состояние сценария проекта (для пайплайна окна видео), панель «Озвучка и тайминги» (запись диктора, черновой голос) и звериная речь.
'use strict';

Object.assign(Plan, {
  // ✨ сценарий агентом (режим «📝 сценарий», server/agent.py): написать заново по видео / ответить на правки раскадровки
  scriptState(d) {                                          // состояние сценария проекта (правки раскадровки, заглушка ли script.md) — раз в 8 с
    const S = Plan.scriptSt[d.id];
    if (!S || Date.now() - S.at > 8000) {
      Plan.scriptSt[d.id] = Object.assign(S || {}, { at: Date.now() });
      api('GET', '/api/script/state?video=' + d.id).then(r => { const old = JSON.stringify((Plan.scriptSt[d.id] || {}).r); Plan.scriptSt[d.id].r = r; if (old !== JSON.stringify(r)) App.render(); }).catch(() => {});
    }
    return (S && S.r) || {};
  },
  scriptSt: {},

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
    if (!d.project) return [h('section.card', h('h3', '🎙 Голос'), h('p', 'Голос появится, когда будет сценарий: шаг «Сценарий» в пайплайне слева.'),
      h('button', { onclick: () => ScriptWin.open(d) }, '→ к сценарию')), Plan.talkBox(d)];
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
      Plan.talkBox(d),
    ];
  },

  // 🐾 звериная речь (Animalese, server/talk_api.py): голоса канала, ползунки, послушать — сразу; фраза -> звук препродакшена (в сцены и монтаж как el:)
  talkSt: {},
  talkBox(d) {
    const T = Plan.talkSt[d.id] || (Plan.talkSt[d.id] = { text: Local.get('talk:' + d.id) || 'Будь другом, сбегай наверх! Кажется, там кто-то есть?' });
    if (!T.r && !T.busy) {
      T.busy = true;
      api('GET', '/api/talk/voices?video=' + d.id).then(r => { T.r = r; T.name = Object.keys(r.voices)[0]; T.p = JSON.parse(JSON.stringify(r.voices[T.name])); T.busy = false; App.render(); })
        .catch(e => { T.r = { error: e.message }; T.busy = false; App.render(); });
    }
    const head = h('div.card-head', h('h3', '🐾 Звериная речь'), h('span.dim.small', 'лепет как в Animal Crossing — для реплик героев без диктора; тот же движок, что у сборки ролика'));
    if (!T.r) return h('section.card', head, h('p.dim', h('span.spin'), ' гружу голоса…'));
    if (T.r.error) return h('section.card', head, h('div.badline', '⚠ ' + T.r.error));
    const V = T.r.voices, p = T.p || {};
    const play = async () => {
      const ta = document.getElementById('talktext'); if (ta) T.text = ta.value;
      Local.set('talk:' + d.id, T.text);
      try {
        T.playing = true; const r = await api('POST', '/api/talk/say', { video: d.id, text: T.text, p: T.p });
        if (T.audio) T.audio.pause();
        T.audio = new Audio(r.url); T.audio.play().catch(() => {});
      } catch (e) { UI.toast(e.message, 'err'); }
      T.playing = false;
    };
    const again = () => { clearTimeout(T.tm); T.tm = setTimeout(play, 350); };   // ползунок отпустил — сразу слышно
    const pick = n => { T.name = n; T.p = JSON.parse(JSON.stringify(V[n])); App.render(); play(); };
    return h('section.card.talk',
      head,
      h('div.row.wrap', Object.keys(V).map(n => h('button.chip', { class: T.name === n ? 'sel' : '', onclick: () => pick(n) }, n)),
        h('span.sp'),
        h('button', { title: 'Сохранить текущие ползунки голосом канала (им же озвучит Claude в роликах этого канала)', onclick: async () => {
          const n = prompt('Имя голоса (например «ёжик», «мама», «кот-сыщик»):', T.name || ''); if (!n) return;
          try { T.r.voices = (await api('POST', '/api/talk/voices', { video: d.id, name: n, p: T.p })).voices; T.name = n; UI.toast('💾 Голос «' + n + '» сохранён в канале'); App.render(); } catch (e) { UI.toast(e.message, 'err'); }
        } }, '💾 Сохранить голос'),
        Object.keys(V).length > 1 && h('button.icon', { title: 'Убрать этот голос из канала', onclick: async () => {
          if (!confirm(`Убрать голос «${T.name}»?`)) return;
          try { T.r.voices = (await api('POST', '/api/talk/voices', { video: d.id, name: T.name, p: null })).voices; pick(Object.keys(T.r.voices)[0]); } catch (e) { UI.toast(e.message, 'err'); }
        } }, '🗑')),
      h('textarea.box#talktext', { rows: 2, value: T.text, placeholder: 'Фраза героя', oninput: e => { T.text = e.target.value; } }),
      h('div.row', h('button.primary', { onclick: play, title: 'Озвучить и послушать (секунда)' }, '▶ Послушать'),
        h('select', { onchange: e => { T.p.voice = e.target.value; again(); } }, T.r.engines.map(([v, l]) => h('option', { value: v, selected: p.voice === v }, 'основа: ' + l))),
        h('span.sp'),
        h('button', { title: 'Фраза станет звуком препродакшена «🐾 …»: его можно поставить в сцену редактора или на монтаж', onclick: async () => {
          const ta = document.getElementById('talktext'); if (ta) T.text = ta.value;
          try { const r = await api('POST', '/api/talk/keep', { video: d.id, text: T.text, p: T.p, name: T.name }); await Store.load('plan:' + d.id, true); UI.toast(`➕ Звук в препродакшене (${r.dur} с) — ставь его в сцену или на монтаж`); }
          catch (e) { UI.toast(e.message, 'err'); }
        } }, '➕ В препродакшен звуком')),
      h('div.talk-grid', T.r.params.map(([k, label, lo, hi, step, hint]) => h('label.talk-sl', { title: hint || '' },
        h('span', label), h('input', { type: 'range', min: lo, max: hi, step, value: p[k] != null ? p[k] : T.r.defaults[k],
          oninput: e => { T.p[k] = +e.target.value; e.target.nextSibling.textContent = (+e.target.value).toString(); }, onchange: again }),
        h('span.dim', String(p[k] != null ? p[k] : T.r.defaults[k]))))),
      h('p.dim.small', 'Подвинул ползунок — фраза сама переозвучивается. Голоса хранятся в канале (style/animalese.json). В сцене / на монтаже реплика — звук «🐾 …» из препродакшена.'));
  },
});
