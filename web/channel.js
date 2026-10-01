// Claude Studio — новый канал и ⚙ Стиль канала (S9, docs/studio/stage9-channel.md): «+ Канал», интервью по стилю, «✨ Собрать стиль»,
// правка файлов стиля (стайл-гайд, палитра и шрифты, голос и субтитры, правила), история версий, герой канала.
'use strict';

const CH = { files: null, cid: null, voiceUrl: null, saving: false };
const CH_BLOCKS = [['visual', '🎨 Визуал и герой'], ['delivery', '🗣 Подача и голос'], ['montage', '🎞 Монтаж и звук'], ['pack', '📦 Упаковка']];
const CH_TABS = [['interview', '🎤 Интервью'], ['guide', '📝 Стайл-гайд'], ['look', '🎨 Палитра и шрифты'], ['voice', '🎙 Голос и субтитры'], ['rules', '⚙ Правила'], ['hero', '🦸 Герой'], ['history', '🕘 История']];

Object.assign(Pages, {
  newChannel() {
    const f = { name: h('input.box', { placeholder: 'Название канала (так будет называться папка)', key: 'nc|name' }), icon: h('input.box', { placeholder: '🧌', value: '📺', style: { width: '60px' }, key: 'nc|icon' }),
      about: h('input.box', { placeholder: 'О канале одной строкой: про что, кто герой', key: 'nc|about' }) };
    const make = async () => {
      try {
        const r = await api('POST', '/api/channel/new', { name: f.name.value.trim(), icon: f.icon.value.trim(), about: f.about.value.trim() });
        CH.files = null; Pages._style = undefined; LIB.items = null;
        await App.refreshState(); go('#/style/interview'); UI.toast(`Канал создан — начнём с интервью по стилю`);
        void r;
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    return h('div', h('div.phead', h('h1', '📺 Новый канал')),
      h('section.card', h('p', 'Канал — отдельная папка в рабочей папке: свой стиль, своя библиотека (герои, предметы, звуки), свои видео и свой git.'),
        h('div.chanform', h('label.wide', 'Название', f.name), h('label', 'Иконка', f.icon), h('label.wide', 'О канале', f.about)),
        h('div.row', h('button.primary', { onclick: make }, '📺 Создать канал'), h('span.dim.small', 'Дальше — интервью по стилю: Claude спросит про визуал и героя, подачу и голос, монтаж и звук, упаковку.'))));
  },

  style() {
    const C = App.info.channel || {}, ckey = 'channel:' + C.id;
    if (!C.id) return h('div.empty', 'Канал не выбран');
    if (CH.cid !== C.id) { CH.cid = C.id; CH.files = null; }
    if (!CH.files && !CH.loading) { CH.loading = true; api('GET', '/api/channel/style?channel=' + C.id).then(j => { CH.files = j; }).catch(e => { CH.files = { err: e.message }; }).finally(() => { CH.loading = false; App.render(); }); }
    if (!Store.get(ckey) && !CH.docLoading) { CH.docLoading = true; Store.load(ckey).then(() => App.render()).catch(() => {}).finally(() => { CH.docLoading = false; }); }
    const d = Store.get(ckey), F = CH.files;
    const done = d && d.interview && d.interview.done;
    const tab = App.route.id || (done ? 'guide' : 'interview');
    const body = !d || !F ? h('p.dim', h('span.spin'), ' загружаю стиль…') : F.err ? h('div.badline', '⚠ ' + F.err)
      : ({ interview: Pages.chInterview, guide: Pages.chGuide, look: Pages.chLook, voice: Pages.chVoice, rules: Pages.chRules, hero: Pages.chHero, history: Pages.chHistory }[tab] || Pages.chGuide).call(Pages, C, d, ckey, F);
    return h('div',
      h('div.phead', h('h1', `${C.icon || '📺'} ${C.name} — стиль канала`), h('span.sp'), h('a.btn', { href: '#/newchan' }, '+ новый канал')),
      h('div.subtabs', CH_TABS.map(([k, l]) => h('a.btn', { class: k === tab ? 'sel' : '', href: '#/style/' + k }, l))),
      body);
  },

  async chSave(kind, value, quiet) {
    try { await api('POST', '/api/channel/stylefile', { channel: CH.cid, kind, value }); CH.files[kind] = value; if (!quiet) UI.toast('Сохранено (прошлая версия — в 🕘 Истории)'); CH.files.history = null; CH.reload = true; }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  chReload() { CH.files = null; App.render(); },

  // ---------------- 🎤 интервью
  chInterview(C, d, ckey) {
    const qa = (d.interview || {}).qa || [], ans = qa.filter(q => (q.a || '').trim() || q.skip).length;
    const running = Claude.running(ckey, 'chanq'), styling = Claude.running(ckey, 'chanstyle');
    const job = (path, kind, params = {}) => async () => { try { const r = await api('POST', path, { channel: C.id, ...params }); Claude.jobs[r.job.id] = r.job; App.render(); } catch (e) { UI.toast(e.message, 'err'); } };
    const qRow = q => h('div.chq', { class: (q.a || '').trim() ? 'ok' : '' },
      h('div.row', h('b.grow', q.q), h('button.icon.del', { title: 'Убрать вопрос', onclick: () => Store.del(ckey, ['interview', 'qa'], q.id) }, '×')),
      q.why && h('div.dim.small', 'зачем: ' + q.why),
      area(ckey, ['interview', 'qa', q.id, 'a'], { ph: 'ответ своими словами (можно голосом в блокноте и вставить)', cls: 'box' }));
    return [
      h('section.card', h('div.card-head', h('h3', '🎤 Интервью по стилю'), h('span.counter', { class: qa.length && ans === qa.length ? 'ok' : '' }, `отвечено ${ans} из ${qa.length}`), h('span.sp'),
          running ? h('span.dim', h('span.spin'), ' Claude придумывает вопросы…') : h('button.claude', { disabled: !Claude.on, onclick: job('/api/channel/questions', 'chanq', { n: qa.length ? 8 : 20 }) }, qa.length ? '✨ Ещё вопросы' : '✨ Вопросы (≈20)')),
        h('p.dim', 'Отвечай как есть — коротко или подробно. По ответам Claude соберёт стайл-гайд, палитру, шрифты, голос, субтитры, правила и описание героя. Потом всё можно править на соседних вкладках.'),
        !qa.length && h('div.empty', 'Нажми «✨ Вопросы» — Claude спросит про визуал и героя, подачу и голос, монтаж и звук, упаковку.')),
      CH_BLOCKS.map(([b, label]) => {
        const list = qa.filter(q => (q.block || 'visual') === b);
        return list.length > 0 && h('section.card', h('div.card-head', h('h3', label), h('span.dim.small', `${list.filter(q => (q.a || '').trim()).length} из ${list.length}`), h('span.sp'),
          !running && h('button', { onclick: job('/api/channel/questions', 'chanq', { block: b, n: 4 }), title: 'Ещё вопросы по этому блоку' }, '+ ещё')),
          list.map(qRow),
          addLine('+ свой вопрос — Enter', t => Store.add(ckey, ['interview', 'qa'], { id: uid('q'), q: t, a: '', why: '', block: b, round: 1, by: 'me' }), ckey + '|addq' + b));
      }),
      qa.length > 0 && h('section.card', h('div.card-head', h('h3', '✨ Собрать стиль'), h('span.sp'),
          styling ? h('span.dim', h('span.spin'), ' Claude (Opus) собирает стиль — 2–5 минут…')
            : h('button.claude', { disabled: !Claude.on || ans < Math.min(6, qa.length), onclick: async () => { await Store.flushAll(); job('/api/channel/style-build', 'chanstyle')(); },
              title: 'Стайл-гайд, палитра, шрифты, голос, субтитры, правила, стиль 3D, описание героя — по ответам' }, (d.interview || {}).done ? '✨ Пересобрать стиль' : '✨ Собрать стиль')),
        (d.interview || {}).done ? h('p', '✅ Стиль собран ', h('span.dim', new Date(d.interview.styled || 0).toLocaleString().slice(0, 17)), ' — смотри вкладки ', h('a', { href: '#/style/guide' }, 'Стайл-гайд'), ', ', h('a', { href: '#/style/look' }, 'Палитра'), ', ', h('a', { href: '#/style/voice' }, 'Голос'), ', ', h('a', { href: '#/style/hero' }, 'Герой'), '.')
          : h('p.dim', 'Когда ответишь на большую часть вопросов (пропущенные — тоже ок).')),
    ];
  },

  // ---------------- 📝 стайл-гайд
  chGuide(C, d, ckey, F) {
    const ta = h('textarea.box.styleedit', { key: 'styletext:' + C.id, spellcheck: false });
    ta.value = F.style || '';
    const save = () => Pages.chSave('style', ta.value);
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } });
    return [h('section.card', h('div.chanform',
        h('label', 'Название', line(ckey, ['name'], { cls: 'box' })), h('label', 'Иконка', line(ckey, ['icon'], { cls: 'box' })),
        h('label.wide', 'О канале (одной строкой — Claude читает её во всех кнопках ✨)', line(ckey, ['about'], { cls: 'box' })))),
      h('section.card', h('div.card-head', h('h3', '📝 Стайл-гайд'), h('span.dim.small', 'style/style-guide.md · markdown · Ctrl+S'), h('span.sp'), h('button.primary', { onclick: save }, '💾 Сохранить')), ta)];
  },

  // ---------------- 🎨 палитра и шрифты
  chLook(C, d, ckey, F) {
    const P = JSON.parse(JSON.stringify(F.palette || {})); P.colors = P.colors || []; P.fonts = P.fonts || {};
    const save = () => Pages.chSave('palette', P);
    const fontSel = k => h('label', { title: 'заголовки и обложки', body: 'субтитры и текст', hand: 'рукописный' }[k],
      msel([['', '—'], ...F.fonts.map(f => [f, f])], P.fonts[k] || '', v => { P.fonts[k] = v; save(); }),
      h('span.fontprev', { style: { fontFamily: `"${P.fonts[k] || 'Rubik'}"` } }, 'Тролль ушёл в рейд 1234'));
    return [
      h('section.card', h('div.card-head', h('h3', '🎨 Палитра'), h('span.sp'), h('button', { onclick: () => { P.colors.push({ name: 'новый', hex: '#888888', use: '' }); save().then(() => App.render()); } }, '+ цвет')),
        P.colors.length ? h('div.palette', P.colors.map((c, i) => h('div.swatch',
          h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#888888', onchange: ev => { c.hex = ev.target.value; save().then(() => App.render()); } }),
          h('input.box', { value: c.name, oninput: ev => { c.name = ev.target.value; }, onchange: save }),
          h('input.box.small', { value: c.use, placeholder: 'где', oninput: ev => { c.use = ev.target.value; }, onchange: save }),
          h('button.icon.del', { onclick: () => { P.colors.splice(i, 1); save().then(() => App.render()); } }, '×')))) : h('div.empty', 'Палитра появится после «✨ Собрать стиль» — или добавь цвета сам.')),
      h('section.card', h('div.card-head', h('h3', '🔤 Шрифты'), P.fonts.note && h('span.dim.small', P.fonts.note)),
        h('div.fonts', ['title', 'body', 'hand'].map(fontSel)),
        h('p.dim.small', 'Шрифты — из assets/fonts шаблона. Нужен другой — положи .ttf в _studio/template/assets/fonts.')),
    ];
  },

  // ---------------- 🎙 голос и субтитры
  chVoice(C, d, ckey, F) {
    const V = Object.assign({ voice: F.voices[0], rate: '+20%', pitch: '+0Hz' }, F.voice || {}), K = Object.assign({ font: 'Rubik', size: 70, color: '#ffffff', stroke: '#000000', y: 0.765, maxWords: 3, upper: false }, F.captions || {});
    const saveV = () => Pages.chSave('voice', V, true), saveK = () => { Pages.chSave('captions', K, true); drawCap(); };
    const phrase = h('input.box', { value: 'Тролль зашёл в рейд и сразу всё понял.', style: { width: '320px' } });
    const audio = h('audio', { controls: true, src: CH.voiceUrl || '' });
    const test = async () => { try { const r = await api('POST', '/api/channel/voicetest', { voice: V, text: phrase.value }); CH.voiceUrl = '/api/channel/voicefile?f=' + r.f; audio.src = CH.voiceUrl; audio.play().catch(() => {}); } catch (e) { UI.toast(e.message, 'err'); } };
    const cv = h('canvas.capprev', { width: 540, height: 960 });
    const drawCap = () => {
      const g = cv.getContext('2d'); g.fillStyle = '#3a3a44'; g.fillRect(0, 0, 540, 960);
      g.fillStyle = '#55556a'; g.fillRect(0, 960 * 0.18, 540, 960 * 0.55);
      const words = (K.upper ? phrase.value.toUpperCase() : phrase.value).split(/\s+/).slice(0, K.maxWords || 3).join(' ');
      g.font = `800 ${(K.size || 70) / 2}px "${K.font}"`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 8; g.strokeStyle = K.stroke || '#000'; g.strokeText(words, 270, 960 * (K.y || 0.765)); g.fillStyle = K.color || '#fff'; g.fillText(words, 270, 960 * (K.y || 0.765));
    };
    setTimeout(drawCap, 50);
    const num = (obj, k, step, save) => h('input.box', { type: 'number', step, value: obj[k], style: { width: '80px' }, onchange: ev => { obj[k] = +ev.target.value; save(); } });
    const txt = (obj, k, save, w = '110px') => h('input.box', { value: obj[k] || '', style: { width: w }, onchange: ev => { obj[k] = ev.target.value; save(); } });
    return [
      h('section.card', h('div.card-head', h('h3', '🎙 Голос диктора'), V.note && h('span.dim.small', V.note)),
        h('div.row', h('label', 'голос ', msel(F.voices.map(v => [v, v]), V.voice, v => { V.voice = v; saveV(); })), h('label', 'скорость ', txt(V, 'rate', saveV, '70px')), h('label', 'высота ', txt(V, 'pitch', saveV, '70px'))),
        h('div.row', phrase, h('button', { onclick: test }, '▶ послушать'), audio),
        h('p.dim.small', 'Голос — edge-tts, его же возьмёт tts.py в проектах канала (style/voice.json).')),
      h('section.card', h('div.card-head', h('h3', '💬 Субтитры')),
        h('div.capgrid', cv, h('div.capform',
          h('label', 'шрифт ', msel(F.fonts.map(f => [f, f]), K.font, v => { K.font = v; saveK(); })), h('label', 'кегль ', num(K, 'size', 2, saveK)),
          h('label', 'цвет ', h('input', { type: 'color', value: K.color, onchange: ev => { K.color = ev.target.value; saveK(); } })),
          h('label', 'обводка ', h('input', { type: 'color', value: K.stroke || '#000000', onchange: ev => { K.stroke = ev.target.value; saveK(); } })),
          h('label', 'высота (доля кадра) ', num(K, 'y', 0.005, saveK)), h('label', 'слов за раз ', num(K, 'maxWords', 1, saveK)),
          h('label', h('input', { type: 'checkbox', checked: !!K.upper, onchange: ev => { K.upper = ev.target.checked; saveK(); } }), ' ЗАГЛАВНЫМИ')))),
    ];
  },

  // ---------------- ⚙ правила
  chRules(C, d, ckey) {
    const R = d.rules || {}, tk = d.toolkitChoice || {};
    return h('section.card', h('div.card-head', h('h3', '⚙ Правила канала')),
      h('label.row', h('input', { type: 'checkbox', checked: R.paperFacing !== false, onchange: ev => Store.set(ckey, ['rules', 'paperFacing'], ev.target.checked, true) }),
        ' Paper Mario: персонажи-карточки поворачиваются к камере'),
      h('label.row', 'не больше, градусов ', h('input.box', { type: 'number', value: R.facingMaxDeg ?? 35, style: { width: '80px' }, onchange: ev => Store.set(ckey, ['rules', 'facingMaxDeg'], +ev.target.value, true) })),
      h('label.row', 'стиль 3D-предметов ', msel([['paper', 'бумажный макет'], ['toy', 'игрушка / пластилин'], ['flat', 'плоские цветные формы'], ['lowpoly', 'low-poly']], d.style3d || 'paper', v => Store.set(ckey, ['style3d'], v, true))),
      h('label.row', 'тулкит рисования ', msel([['paper', 'бумажный (как у «Доедать будешь»)'], ['new', 'свой (style/toolkit.js)']], tk.kind || 'paper', v => Store.set(ckey, ['toolkitChoice', 'kind'], v, true))),
      tk.note && h('p.dim.small', 'Что поменять в тулките: ' + tk.note));
  },

  // ---------------- 🦸 герой
  chHero(C, d, ckey, F) {
    const H = d.hero || {}, refs = F.heroRefs || [];
    const make = async () => {
      try { await Store.flushAll(); const r = await api('POST', '/api/channel/hero', { channel: C.id }); Claude.jobs[r.job.id] = r.job; UI.toast('Готовлю видео «Герой канала»…');
        const wait = async () => { const s = await api('GET', '/api/job?id=' + r.job.id).catch(() => null); const j = s && (s.job || s);
          if (j && j.status === 'running') return setTimeout(wait, 1000);
          if (j && j.status === 'done') { await App.refreshState(); go(`#/p/${j.result.video}/pre`); } else UI.toast((j && j.error) || 'не вышло', 'err'); };
        wait(); } catch (e) { UI.toast(e.message, 'err'); }
    };
    return [h('section.card', h('div.card-head', h('h3', '🦸 Главный герой канала'), H.video && h('span.dim.small', 'видео героя есть')),
      h('div.chanform', h('label', 'Имя', line(ckey, ['hero', 'name'], { cls: 'box' })), h('label.wide', 'Как выглядит (для художника)', area(ckey, ['hero', 'desc'], { cls: 'box' })),
        h('label.wide', 'Характер', area(ckey, ['hero', 'character'], { cls: 'box' })), h('label.wide', 'Тело (для скелета)', line(ckey, ['hero', 'skeleton'], { cls: 'box' })),
        h('label', 'Как делать', msel([['blender', '3D-модель в Blender со скелетом'], ['parts', 'бумажная карточка из частей'], ['param', 'по параметрам (как ёжик)']], H.make || 'blender', v => Store.set(ckey, ['hero', 'make'], v, true)))),
      refs.length > 0 && h('div', h('label', 'Референсы (style/hero)'), h('div.herorefs', refs.map(f => h('img', { src: `/api/channel/file?channel=${C.id}&f=${encodeURIComponent(f)}`, onclick: ev => UI.lightbox(ev.target.src) })))),
      h('div.row', h('button.primary', { onclick: make, title: 'Служебное видео «Герой канала»: элемент-персонаж с референсами (дальше — «🎨 нарисовать» / «🦴 со скелетом» → 📚 библиотека) и пустая сцена для проверки' }, '🦸 Сделать героя'),
        h('span.dim.small', 'Герой попадёт в библиотеку канала со своим скелетом и встанет в пустую сцену.')))];
  },

  // ---------------- 🕘 история
  chHistory(C, d, ckey, F) {
    const list = F.history || [];
    return h('section.card', h('div.card-head', h('h3', '🕘 История файлов стиля'), h('span.dim.small', 'каждое сохранение кладёт прошлую версию в style/.history')),
      list.length ? h('div', list.map(n => h('div.row', h('span.grow', n.replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)_/, '$3.$2 $4:$5:$6 · ')),
        h('button', { onclick: async () => { if (!confirm('Вернуть эту версию? Текущая уйдёт в историю.')) return; try { await api('POST', '/api/channel/restore', { channel: C.id, name: n }); UI.toast('Вернул'); Pages.chReload(); } catch (e) { UI.toast(e.message, 'err'); } } }, '↺ вернуть'))))
        : h('div.empty', 'Пока пусто'));
  },
});
