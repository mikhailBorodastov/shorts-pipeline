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
    const busy = !!(Claude.running(ckey, 'chanstyle') || Claude.running(ckey, 'chancaps'));
    if (CH.wasBusy && !busy) { CH.files = null; Store.load(ckey, true).then(() => App.render()).catch(() => {}); }
    CH.wasBusy = busy;
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
    try { await api('POST', '/api/channel/stylefile', { channel: CH.cid, kind, value }); if (CH.files) CH.files[kind] = value; if (!quiet) UI.toast('Сохранено (прошлая версия — в 🕘 Истории)'); }
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
    const V = Object.assign({ voice: F.voices[0], rate: '+20%', pitch: '+0Hz' }, F.voice || {});
    const K = Object.assign({ font: 'Rubik', weight: 800, size: 70, color: '#ffffff', highlight: '#ffd84a', stroke: '#0c0828', strokeWidth: 16, shadow: false, box: '', boxAlpha: 0.75, y: 0.765, maxWords: 3, upper: false, anim: 'pop' }, F.captions || {});
    const saveV = () => Pages.chSave('voice', V, true), saveK = () => { Pages.chSave('captions', K, true); drawCap(); };
    const phrase = h('input.box', { value: 'Ульджан зашёл в рейд и сразу всё понял, мон.', style: { width: '320px' }, oninput: () => drawCap() });
    const audio = h('audio', { controls: true, src: CH.voiceUrl || '' });
    const test = async () => { try { const r = await api('POST', '/api/channel/voicetest', { voice: V, text: phrase.value }); CH.voiceUrl = '/api/channel/voicefile?f=' + r.f; audio.src = CH.voiceUrl; audio.play().catch(() => {}); } catch (e) { UI.toast(e.message, 'err'); } };
    Pages.chFonts(C, F);
    const cv = h('canvas.capprev', { width: 540, height: 960 });
    let said = 1;
    const drawCap = () => {                                   // как в ролике (template main.js drawCaptions), половинный размер
      const g = cv.getContext('2d'); g.clearRect(0, 0, 540, 960);
      g.fillStyle = '#2d3140'; g.fillRect(0, 0, 540, 960); g.fillStyle = '#4a5068'; g.fillRect(0, 960 * 0.15, 540, 960 * 0.55);
      const size = (K.size || 70) / 2, y = 960 * (K.y || 0.765);
      const ws = phrase.value.split(/\s+/).filter(Boolean).slice(0, Math.max(1, K.maxWords || 3)).map(w => K.upper ? w.toUpperCase() : w);
      g.font = `${K.weight || 800} ${size}px "${K.font}", Rubik`; g.textBaseline = 'middle'; g.textAlign = 'center'; g.lineJoin = 'round';
      const wd = ws.map(w => g.measureText(w).width), gap = size * 0.38, total = wd.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
      let x = 270 - total / 2;
      if (K.box) { g.save(); g.globalAlpha = K.boxAlpha == null ? 0.75 : K.boxAlpha; g.fillStyle = K.box; g.beginPath(); g.roundRect(x - size * 0.4, y - size * 0.72, total + size * 0.8, size * 1.44, size * 0.28); g.fill(); g.restore(); }
      ws.forEach((w, i) => {
        const on = i < said;
        g.save(); g.translate(x + wd[i] / 2, y);
        if (K.shadow) { g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = size * 0.18; g.shadowOffsetY = size * 0.06; }
        if ((K.strokeWidth ?? 16) > 0) { g.lineWidth = (K.strokeWidth ?? 16) / 2; g.strokeStyle = K.stroke || '#000'; g.strokeText(w, 0, 0); }
        g.shadowColor = 'transparent'; g.fillStyle = on ? (K.highlight || '#ffd84a') : (K.color || '#fff'); g.fillText(w, 0, 0); g.restore();
        x += wd[i] + gap;
      });
    };
    cv.onclick = () => { said = said % Math.max(1, K.maxWords || 3) + 1; drawCap(); };
    document.fonts.ready.then(drawCap); setTimeout(drawCap, 60);
    const num = (obj, k, step, save, w = '80px') => h('input.box', { type: 'number', step, value: obj[k] ?? '', style: { width: w }, onchange: ev => { obj[k] = +ev.target.value; save(); } });
    const txt = (obj, k, save, w = '110px') => h('input.box', { value: obj[k] || '', style: { width: w }, onchange: ev => { obj[k] = ev.target.value; save(); } });
    const color = (k, label) => h('label', label, ' ', h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(K[k] || '') ? K[k] : '#000000', onchange: ev => { K[k] = ev.target.value; saveK(); } }));
    const upload = (accept, kind, done) => () => { const i = h('input', { type: 'file', accept, onchange: async () => {
      const f = i.files[0]; if (!f) return; const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
      try { const r = await api('POST', '/api/channel/upload', { channel: C.id, kind, name: f.name, data }); done(r); } catch (e) { UI.toast(e.message, 'err'); } } }); i.click(); };
    const capsBusy = Claude.running('channel:' + C.id, 'chancaps');
    return [
      h('section.card', h('div.card-head', h('h3', '🎙 Голос диктора')),
        V.note && h('p.dim.small', V.note),
        h('div.row', h('label', 'голос ', msel(F.voices.map(v => [v, v]), V.voice, v => { V.voice = v; saveV(); })), h('label', 'скорость ', txt(V, 'rate', saveV, '70px')), h('label', 'высота ', txt(V, 'pitch', saveV, '70px'))),
        h('div.row', phrase, h('button', { onclick: test }, '▶ послушать'), audio),
        h('p.dim.small', 'Голос — edge-tts; его возьмёт tts.py в проектах канала (style/voice.json). Свой голос — запись и align.py, как раньше.')),
      h('section.card', h('div.card-head', h('h3', '💬 Субтитры'), h('span.sp'),
          h('button', { onclick: upload('.ttf,.otf,.woff,.woff2', 'font', r => { K.font = r.font; saveK(); CH.files = null; UI.toast('Шрифт «' + r.font + '» загружен'); }), title: 'Свой шрифт (.ttf / .otf / .woff2) — ляжет в style/fonts канала и поедет в ролики' }, '⬆ свой шрифт'),
          h('button', { onclick: upload('image/*', 'capref', () => { CH.files = null; UI.toast('Картинка загружена — жми «✨ как на картинке»'); }), title: 'Скрин субтитров, которые нравятся (из любого ролика)' }, '⬆ пример субтитров'),
          F.capRef && (capsBusy ? h('span.dim', h('span.spin'), ' Claude смотрит картинку…')
            : h('button.claude', { onclick: async () => { try { const r = await api('POST', '/api/channel/captions-from-ref', { channel: C.id }); Claude.jobs[r.job.id] = r.job; App.render(); } catch (e) { UI.toast(e.message, 'err'); } } }, '✨ как на картинке'))),
        K.note && h('p.dim.small', K.note),
        h('div.capgrid', h('div', cv, h('div.dim.small', 'клик — следующее слово «сказано»')),
          F.capRef && h('img.capref', { src: `/api/channel/file?channel=${C.id}&f=${encodeURIComponent(F.capRef)}&v=${Date.now() % 100000}`, title: 'пример автора' }),
          h('div.capform',
            h('label', 'шрифт ', msel(F.fonts.map(f => [f, f + ((F.chanFonts || []).includes(f) ? ' (свой)' : '')]), K.font, v => { K.font = v; saveK(); }), ' жирность ', num(K, 'weight', 100, saveK, '70px')),
            h('label', 'кегль ', num(K, 'size', 2, saveK), ' слов за раз ', num(K, 'maxWords', 1, saveK, '60px')),
            h('div.row', color('color', 'текст'), color('highlight', 'сказанное слово')),
            h('div.row', color('stroke', 'обводка'), h('label', 'толщина ', num(K, 'strokeWidth', 1, saveK, '60px'))),
            h('div.row', h('label', h('input', { type: 'checkbox', checked: !!K.box, onchange: ev => { K.box = ev.target.checked ? (K.box || '#000000') : ''; saveK(); App.render(); } }), ' подложка'),
              K.box && color('box', 'цвет'), K.box && h('label', 'прозрачность ', num(K, 'boxAlpha', 0.05, saveK, '60px'))),
            h('label', h('input', { type: 'checkbox', checked: !!K.shadow, onchange: ev => { K.shadow = ev.target.checked; saveK(); } }), ' тень'),
            h('label', h('input', { type: 'checkbox', checked: !!K.upper, onchange: ev => { K.upper = ev.target.checked; saveK(); } }), ' ЗАГЛАВНЫМИ'),
            h('label', 'появление слова ', msel([['pop', 'подпрыгивает'], ['rise', 'всплывает'], ['none', 'без анимации']], K.anim || 'pop', v => { K.anim = v; saveK(); })),
            h('label', 'высота (доля кадра) ', num(K, 'y', 0.005, saveK))))),
    ];
  },
  chFonts(C, F) {                                             // свои шрифты канала — в страницу, чтобы превью их показывало
    for (const [fam, rel] of F.chanFontFiles || []) {
      if ((CH.loadedFonts = CH.loadedFonts || new Set()).has(rel)) continue;
      CH.loadedFonts.add(rel);
      try { new FontFace(fam, `url(/api/channel/file?channel=${C.id}&f=${encodeURIComponent(rel)})`).load().then(x => { document.fonts.add(x); App.render(); }).catch(() => {}); } catch (e) {}
    }
  },

  // ---------------- ⚙ правила (их выбирает «✨ Собрать стиль» — только нужные этому каналу)
  chRules(C, d, ckey) {
    const R = d.rules || {}, tk = d.toolkitChoice || {};
    const known = { paperFacing: { label: 'Paper Mario: персонажи-карточки поворачиваются к камере', type: 'bool' }, facingMaxDeg: { label: 'Поворот карточек к камере — не больше, градусов', type: 'number' },
      style3d: { label: 'Стиль 3D-предметов', type: 'choice', options: ['paper', 'toy', 'flat', 'lowpoly', 'game'] }, toolkit: { label: '2D-тулкит рисования', type: 'choice', options: ['paper', 'new', 'none'] } };
    const defs = (d.ruleDefs && d.ruleDefs.length) ? d.ruleDefs : Object.keys(R).filter(k => known[k]).map(k => ({ key: k, ...known[k] }));
    const setRule = (k, v) => { Store.set(ckey, ['rules', k], v, true); if (k === 'style3d') Store.set(ckey, ['style3d'], v); if (k === 'toolkit') Store.set(ckey, ['toolkitChoice', 'kind'], v); };
    const ctl = r => {
      const v = R[r.key];
      if (r.type === 'bool') return h('input', { type: 'checkbox', checked: v === true || v === 'true', onchange: ev => setRule(r.key, ev.target.checked) });
      if (r.type === 'number') return h('input.box', { type: 'number', value: v ?? '', style: { width: '90px' }, onchange: ev => setRule(r.key, +ev.target.value) });
      if (r.type === 'choice') return msel((r.options || []).map(o => [o, o]), v ?? '', x => setRule(r.key, x));
      return h('input.box.grow', { value: v ?? '', onchange: ev => setRule(r.key, ev.target.value) });
    };
    return h('section.card', h('div.card-head', h('h3', '⚙ Правила канала'), h('span.dim.small', 'их выбирает «✨ Собрать стиль» — только те, что нужны этому каналу')),
      defs.length ? h('div.rules-list', defs.map(r => h('div.rule', h('div.row', h('b.grow', r.label || r.key), ctl(r)), r.why && h('div.dim.small', r.why))))
        : h('div.empty', 'Правил пока нет — их соберёт «✨ Собрать стиль» по интервью.'),
      tk.note && h('p.dim.small', '2D-тулкит: ' + tk.note));
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
