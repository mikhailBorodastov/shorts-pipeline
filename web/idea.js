// «Штурм идей» — the «есть идея» path (flow idea): Идея и референсы → Вопросы и биты → Препродакшен
// (сцены, персонажи, пропсы, звуки: черновик нашим движком с правками по пинам, звуки — подбор Claude, поиск и ссылка).
// Смыслы и название, обложка, «В работу» и «Итоги» — общие с брейншторм-путём, в plan.js.
'use strict';

const HINTS2 = {
  idea: `<p>Запиши идею так, как рассказал бы другу: о чём ролик и где крючок. В <b>контекст</b> — всё, что уже знаешь: откуда идея, тон, что точно должно быть, финал, факты, ссылки.</p>
<p><b>Референсы</b> — чужие ролики, по которым хочешь снять: вставь ссылку или путь к файлу, и скрипт нарежет кадры и расшифрует речь, чтобы Claude их «посмотрел». Напиши у референса, <b>что из него берём</b>: подачу, темп, структуру, шутки, визуал. Картинки — Ctrl+V.</p>`,
  qa: `<p>Claude читает идею, контекст и референсы и задаёт <b>15–20 вопросов</b> — всё, что ему непонятно для сценария и анимации: сюжет, герои, мир и детали, тон, упаковка, неудобные вопросы. Отвечай коротко; «не знаю, предложи» — тоже ответ. Неважное — «–».</p>
<p>Ответил — жми <b>✨ Ещё вопросы</b> (уточняющий раунд) или иди к названию: твои ответы — решения, дальше на них строится всё.</p>`,
  pre: `<p><b>Препродакшен</b> — всё, из чего соберём ролик: <b>персонажи</b>, <b>пропсы и реквизит</b> (предметы, надписи, мебель, свет, текстуры), <b>сцены</b> (локации) и <b>звуки</b>. Claude накидает список по идее и твоим ответам; чего не хватает — впиши в поле «чего не хватает?» и жми ✨, или добавь сам.</p>
<p><b>Порядок:</b> сначала персонажи и пропсы, потом сцены. У сцены есть «Что в сцене» — её персонажи и пропсы: утверждённые черновики Claude ставит прямо в неё. 3D-сцену можно смотреть живьём и крутить камерой — кнопка 🧊.</p>
<p>Открой элемент: накидай референсы (Ctrl+V), и Claude нарисует <b>черновик нашим движком</b> — поправишь пинами, как в ревью. Для звука Claude сам найдёт и скачает кандидатов, или найди сам поиском либо ссылкой (YouTube тоже); несколько звуков можно свести в один — со сдвигом, громкостью и пояснением, что куда. Утверди ✓ всё, что годится.</p>
<p><b>Черновик — не финал:</b> это согласованный образ и стартовый код. Что хочешь видеть в готовом ролике, пиши в <b>🎬 Для финала</b> (у утверждённого — ещё и пином на картинке): это ТЗ для сборки. <b>@</b> в любом поле — ссылка на другой элемент («поставь сюда @[Табличка трассы]»).</p>`,
};
const KIND = k => REF.kinds.find(x => x.key === k) || REF.kinds[2];
// 2D / 3D у персонажа и пропса (S3): нет поля dim — 2D, если черновики уже есть, иначе по умолчанию канала (как ideas_claude.dim_of)
const dimOf = e => e.dim || ((e.renders || []).length ? '2d' : (((App.info.channel || {}).defaults || {}).dim || '2d'));
const isProp3 = e => e.kind === 'prop' && dimOf(e) === '3d';
// черновики того вида, который сейчас выбран: у пропса 2D и 3D-версии живут рядом, переключатель показывает свои
// персонаж: «лист» (2D-рисунок) или «со скелетом» (S4, rigchar) — form: '' | 'rig'
const isRigChar = e => e.kind === 'char' && e.form === 'rig';
const elRenders = e => { const rs = e.renders || [];
  if (e.kind === 'char') { const rg = isRigChar(e); return rs.filter(r => !!r.rigchar === rg); }
  if (e.kind !== 'prop') return rs; const d3 = dimOf(e) === '3d'; return rs.filter(r => !!r.three3 === d3); };
const elRender = e => { const rs = elRenders(e); return rs.find(r => r.id === e.render) || rs[rs.length - 1]; };
// layers of a sound element (e.mix; old plans — the single chosen e.sound): [{id, sid, at, gain, note, s: candidate}]
const elMix = e => {
  const ss = e.sounds || [], mix = e.mix != null ? e.mix : e.sound ? [{ id: 'l1', sid: e.sound, at: 0, gain: 1, note: '' }] : [];
  return mix.map(m => ({ ...m, at: +m.at || 0, gain: m.gain === '' || m.gain == null ? 1 : +m.gain, s: ss.find(s => s.id === m.sid) })).filter(m => m.s);
};
const elSound = e => { const m = elMix(e); return m.length ? m[0].s : null; };
// every text of an element (where @-links can be) — mirrors preprod.el_texts
const elTexts = e => { const fx = (e.fx || {}).main || {}; return [e.desc, e.why, fx.text, e.ask, e.mixNote, ...(fx.pins || []).map(p => p.text), ...(e.final || []).map(f => f.text), ...(e.mix || []).map(m => m.note), ...(e.assets || []).map(a => a.why), e.aask].filter(Boolean); };
const elMentions = (d, e) => { const out = []; for (const t of elTexts(e)) for (const x of mentionsIn(t, d)) if (x !== e && !out.includes(x)) out.push(x); return out; };
// who and what stands in a scene: «Что в сцене» + characters and props @-mentioned in its texts — mirrors preprod.cast_of
const isModel = a => a.kind === '3d' && ['glb', 'gltf'].includes((a.fmt || '').toLowerCase());
// ⬆ своя 3D-модель в ассеты элемента (glb / gltf / fbx / obj / stl / usdz / blend / zip) — Blender перегонит в glb и найдёт скелет и анимации
function uploadModel(key, el) {
  const i = h('input', { type: 'file', accept: '.glb,.gltf,.fbx,.obj,.stl,.usdz,.usd,.blend,.zip', onchange: async () => {
    const f = i.files[0]; if (!f) return;
    if (f.size > 150 * 2 ** 20) return UI.toast('Файл больше 150 МБ', 'err');
    const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    const lic = prompt('Лицензия модели (для «Прав»): своя, CC0, CC-BY автор…', 'своя') || 'своя / указать';
    try { const r = await api('POST', '/api/assets/upload', { key, el, name: f.name, data, license: lic }); Claude.jobs[r.job.id] = r.job; UI.toast('Загружаю «' + f.name + '» — Blender проверит скелет и анимации'); App.render(); }
    catch (e) { UI.toast(e.message, 'err'); } } });
  i.click();
}
// 🦴 герой из 3D-модели: ассет | Meshy | Tripo — локальная задача charmodel (готовый скелет подстроит, нет — поставит авто-скелет)
async function charModel(key, el, source, asset, extra = {}) {
  const msg = source === 'asset' ? 'Делаю героя из модели…' : source === 'trellis'
    ? ({ draft: 'TRELLIS лепит черновик на твоей видеокарте — 1–3 минуты', final: 'TRELLIS доводит до чистовика 1536³ — 3–8 минут', retex: 'TRELLIS перекрашивает ту же форму — 2–5 минут', fix: 'TRELLIS перелепливает по правкам' }[extra.mode || 'draft'])
    : `${source === 'meshy' ? 'Meshy' : 'Tripo'} лепит модель по картинке — 3–10 минут`;
  try { const r = await api('POST', '/api/char/model', Object.assign({ key, el, source, asset }, extra)); Claude.jobs[r.job.id] = r.job; App.render(); UI.toast(msg); }
  catch (e) { UI.toast(e.message, 'err'); }
}
// 🖥 TRELLIS локально: выбор картинки (или ракурсов) перед первым черновиком; перетекстурить — по какой картинке красить
function trellisDlg(key, e, cur, mode = 'draft') {
  const prop = e.kind === 'prop', who = prop ? 'предмет' : 'герой';
  // картинки: референсы автора + 2D-черновики элемента (утверждённый 2D-пропс или лист персонажа сразу превращается в 3D)
  const drafts = (e.renders || []).filter(r => r.img && !r.three3 && !r.rigchar && !r.model3d).slice(-3).reverse().map(r => ({ img: r.img, note: `2D-черновик v${r.v}` }));
  const refs = (e.refs || []).filter(r => r.img).concat(drafts);
  if (!refs.length) return UI.toast(prop ? 'Добавь картинку-референс слева или нарисуй 2D-черновик' : 'Добавь картинку-референс героя слева', 'err');
  const st = { ref: (cur && cur.meta && (mode === 'retex' ? '' : cur.meta.ref)) || refs[0].img, engine: (cur && cur.meta && cur.meta.engine) || 'pixal3d', views: {}, texref: '',
    h: (cur && cur.meta && cur.meta.h) || e.h || 0.6, crops: Object.assign({}, (cur && cur.meta && cur.meta.crops) || {}), focus: null };
  const SL = [['front', 'спереди'], ['left', 'слева'], ['back', 'сзади'], ['right', 'справа']];
  const body = h('div.trellis');
  const draw = () => {
    body.replaceChildren(...[
      mode === 'draft' && h('div.seg', [['pixal3d', 'Pixal3D — точно по картинке'], ['trellis', 'TRELLIS.2 — свободнее достроит'], ['multiview', 'по ракурсам (2–4 картинки)']]
        .map(([k, l]) => h('button', { class: st.engine === k ? 'sel' : '', onclick: () => { st.engine = k; draw(); } }, l))),
      h('p.dim.small', mode === 'retex' ? 'Форма останется та же. Выбери картинку, по которой красить (можно перекрашенный тот же референс), или «новый сид» — та же картинка, другая раскраска.'
        : st.engine === 'multiview' ? 'Кликай по картинкам по порядку: спереди → слева → сзади → справа (повторный клик снимает). Герой целиком, на простом фоне, одного размера и в одной позе на всех видах.'
        : `Какая картинка — ${who} целиком, лучше спереди или ¾, на простом фоне.`),
      prop && mode === 'draft' && h('label.small', 'высота предмета ', h('input.box', { type: 'number', step: '0.05', min: '0.02', max: '20', value: st.h, style: { width: '80px' },
        oninput: ev => { st.h = +ev.target.value || st.h; } }), ' м — по ней предмет встанет в сцене в правильном размере'),
      h('div.refpick', refs.map(r => {
        const slot = Object.keys(st.views).find(k => st.views[k] === r.img);
        const sel = st.engine === 'multiview' ? !!slot : (mode === 'retex' ? st.texref === r.img : st.ref === r.img);
        return h('button.refbtn', { class: sel ? 'sel' : '', title: r.note || '', 'data-note': r.note || '', onclick: () => {
          if (st.engine === 'multiview' && mode === 'draft') { const free = SL.find(([k]) => !st.views[k]); if (slot) delete st.views[slot]; else if (free) st.views[free[0]] = r.img; }
          else if (mode === 'retex') st.texref = st.texref === r.img ? '' : r.img; else st.ref = r.img;
          st.focus = r.img; draw(); } }, h('img', { src: '/' + r.img, alt: '' }), slot && h('span.slot', SL.find(([k]) => k === slot)[1]), st.crops[r.img] && h('span.cropmark', '✂'));
      })),
      cropBox(),
      st.engine === 'multiview' && mode === 'draft' && h('p.small', SL.map(([k, l]) => h('span.tag', { class: st.views[k] ? 'on' : '' }, l + (st.views[k] ? ' ✓' : '')))),
      h('div.row', h('span.sp'), h('button.primary', { onclick: () => {
        if (st.engine === 'multiview' && mode === 'draft' && Object.keys(st.views).length < 2) return UI.toast('Нужно хотя бы 2 ракурса', 'err');
        close();
        const used = new Set([st.ref, st.texref, ...Object.values(st.views)].filter(Boolean));
        const crops = Object.fromEntries(Object.entries(st.crops).filter(([k]) => used.has(k)));
        const x = { mode, base: mode === 'draft' ? undefined : cur && cur.id, ...(Object.keys(crops).length ? { crops } : {}) };
        if (mode === 'draft') Object.assign(x, st.engine === 'multiview' ? { engine: 'multiview', views: st.views } : { engine: st.engine, ref: st.ref }, prop ? { h: st.h } : {});
        if (mode === 'retex') Object.assign(x, st.texref ? { texref: st.texref } : {});
        charModel(key, e.id, 'trellis', undefined, x);
      } }, mode === 'retex' ? (st.texref ? '🎨 Перекрасить по картинке' : '🎲 Новая раскраска') : '🖥 Лепить черновик'))].filter(Boolean));
  };
  // рамка: если на картинке лист (несколько видов, подписи, другие герои) — обведи нужный предмет мышью; без рамки берётся вся картинка
  function cropBox() {
    const img = st.focus || (mode === 'retex' ? st.texref : st.engine === 'multiview' ? Object.values(st.views).slice(-1)[0] : st.ref);
    if (!img) return null;
    const c = st.crops[img];
    const frame = h('div.cropframe'), rect = h('div.croprect'), pic = h('img', { src: '/' + img, alt: '', draggable: false });
    const put = b => { if (!b) { rect.hidden = true; return; } rect.hidden = false; Object.assign(rect.style, { left: b[0] * 100 + '%', top: b[1] * 100 + '%', width: (b[2] - b[0]) * 100 + '%', height: (b[3] - b[1]) * 100 + '%' }); };
    put(c);
    frame.onpointerdown = ev => {
      const R = pic.getBoundingClientRect(), at = e2 => [Math.min(1, Math.max(0, (e2.clientX - R.left) / R.width)), Math.min(1, Math.max(0, (e2.clientY - R.top) / R.height))];
      const a = at(ev); let b = null;
      frame.setPointerCapture(ev.pointerId);
      frame.onpointermove = e2 => { const q = at(e2); b = [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[0], q[0]), Math.max(a[1], q[1])].map(v => +v.toFixed(4)); put(b); };
      frame.onpointerup = () => { frame.onpointermove = frame.onpointerup = null; if (b && b[2] - b[0] > 0.02 && b[3] - b[1] > 0.02) st.crops[img] = b; draw(); };
    };
    frame.append(pic, rect);
    return h('div.cropwrap', h('div.small', c ? '✂ взят кусок в рамке — ' : 'Если на картинке лист с несколькими видами или подписями — обведи мышью нужный ' + who + ' (нарисованные тени и подписи нейросеть тоже вылепит — оставь их за рамкой, если можно). ',
      c && h('button.small', { onclick: () => { delete st.crops[img]; draw(); } }, 'вся картинка')), frame);
  }
  draw();
  const close = UI.modal(mode === 'retex' ? `🎨 Перетекстурить «${e.name}» v${cur.v}` : `🖥 TRELLIS локально · ${prop ? '3D-пропс' : 'герой'} «${e.name}»`, body);
}
// 📚 из библиотеки в препродакшен (studio_api.import_to_video): выбрать предмет, версию и написать, что это в ролике и где — Claude это прочтёт
async function libImport(d, key, K) {
  const kind = K.key === 'char' ? 'characters' : 'props';
  let items = [];
  try { items = (await api('GET', '/api/lib?kind=' + kind)).items; } catch (e) { return UI.toast(e.message, 'err'); }
  if (!items.length) return UI.toast(`В библиотеке канала пока нет: ${K.label.toLowerCase()}`, 'err');
  const chan = (App.info.channel || {}).id, st = { id: '', why: '' };
  const body = h('div.libimp');
  const draw = () => {
    const q = (st.q || '').toLowerCase();
    body.replaceChildren(...[
      h('input.box', { placeholder: '🔎 найти', value: st.q || '', key: 'limq', oninput: e => { st.q = e.target.value; draw(); } }),
      h('div.libgrid.compact', items.filter(it => !q || (it.name + ' ' + (it.desc || '')).toLowerCase().includes(q)).map(it => h('div.libcard', { class: st.id === it.id ? 'sel' : '', onclick: () => { st.id = it.id; draw(); } },
        it.preview ? h('img', { src: `/api/lib/file/${chan}/${it.preview}`, alt: '' }) : h('div.noimg', '📦'),
        h('b', it.name, it.d3 ? ' 🧊' : ''), h('span.dim.small', `v${it.latest}`)))),
      st.id && h('label', 'Что это в ролике и где использовать', h('textarea.box', { rows: 3, key: 'limwhy', placeholder: '«стоит на столе слева от монитора в сцене «Комната»; на него падает свет лампы»', oninput: e => { st.why = e.target.value; } })),
      h('div.row', h('span.sp'), h('button.primary', { disabled: !st.id, onclick: async () => {
        try { const r = await api('POST', '/api/lib/import', { key, id: st.id, why: st.why }); close(); await Store.load(key, true); App.render(); UI.toast(`📚 «${r.name}» в видео (${r.ref})`); }
        catch (e) { UI.toast(e.message, 'err'); }
      } }, '📚 Взять в видео'))].filter(Boolean));
    const t = body.querySelector('textarea'); if (t) t.value = st.why;
  };
  draw();
  const close = UI.modal(`📚 ${K.label} из библиотеки`, body, { wide: true });
}
const ASSET_KIND = { '3d': '3D', '2d': '2D', tex: 'текстура' };
const ASSET_SRC = { polypizza: 'Poly Pizza', polyhaven: 'Poly Haven', sketchfab: 'Sketchfab', oga: 'OpenGameArt', openverse: 'Openverse', commons: 'Commons', ambientcg: 'ambientCG',
  quaternius: 'Quaternius', kenney: 'Kenney', smithsonian: 'Smithsonian', objaverse: 'Objaverse', upload: 'своя', meshy: 'Meshy', tripo: 'Tripo' };
const ASSET_WHERE = { '3d': 'Poly Pizza · Quaternius (персонажи со скелетом) · Kenney · Poly Haven · Sketchfab (скачать — токен в ⚙ Настройках) · Objaverse (Sketchfab без токена) · Smithsonian (сканы) · OpenGameArt',
  '2d': 'Openverse (фото и рисунки под CC) · Wikimedia Commons · OpenGameArt', tex: 'ambientCG (CC0) · Poly Haven (CC0)' };
const sceneCastOf = (d, e) => {
  const els = d.elements || [], out = [];
  for (const id of e.uses || []) { const x = els.find(y => y.id === id); if (x && x.status !== 'drop' && !out.some(o => o.x === x)) out.push({ x, via: 'uses' }); }
  for (const x of elMentions(d, e)) if ((x.kind === 'char' || x.kind === 'prop') && x.status !== 'drop' && !out.some(o => o.x === x)) out.push({ x, via: '@' });
  return out;
};
const elPic = x => { const r = elRender(x); return r ? r.img : ((x.refs || []).find(f => f.img) || {}).img; };
const sndSrc = u => ((u || '').startsWith('lib:') ? '/sfxlib/' + u.slice(4) + '.wav' : u);
const isUrl = s => /^https?:\/\//i.test(s || '');

Object.assign(Plan, {
  pinMode: {},                                        // element id -> what a click on its draft places: 'fix' | 'final'
  mixPlay: null,                                      // ▶ the mix that is playing: {el, ctx}
  sres: {},                                           // sound search results per element (page memory only): {q, list, errs, busy}

  // ---------------- 💡 Идея ----------------
  idea(d, key) {
    const refs = d.refs || [], qa = d.qa || [];
    return [
      hint('idea', HINTS2.idea),
      h('section.card',
        h('div.card-head', h('h3', '💡 Идея'), h('span.dim', 'одна-две фразы: о чём ролик и где крючок')),
        area(key, ['idea'], { cls: 'big', ph: 'Например: детская поликлиника — советские Backrooms. Мама послала ёжика за забытой сумкой, а он нажал в лифте кнопку без цифры…' }),
        h('div.card-head', { style: { marginTop: '12px' } }, h('h3', 'Контекст'), h('span.dim', 'всё, что уже знаешь: откуда идея, тон, что точно должно быть, финал, факты, ссылки')),
        area(key, ['topic'], { cls: 'big', ph: 'Хочу в 3D, как Paper Mario. Тон — жутко, но смешно. Точно нужны гудящие лампы, бахилы, регистратура…' })),
      h('section.card',
        h('div.card-head', h('h3', '📼 Референсы'), h('span.dim', 'Claude посмотрит их, когда будет спрашивать и собирать биты')),
        Plan.refAdd(d, key),
        refs.filter(r => r.kind !== 'image').map(r => Plan.refRow(d, key, r)),
        h('h4.sub', '🖼 Картинки'), Plan.refImages(d, key)),
      h('section.card.next', h('div.row', h('b', 'Дальше:'),
        qa.length ? [h('span', `вопросов уже ${qa.length}`), h('a', { href: `#/p/${d.id}/qa` }, '→ ❓ Вопросы')]
          : [h('span.dim', 'Claude прочитает идею и референсы и задаст 15–20 вопросов.'), h('span.sp'),
            Claude.btn({ label: '15–20 вопросов по идее', action: 'questions', key, params: { n: 18 } })])),
    ];
  },

  refAdd(d, key) {
    const inp = h('input.box.grow', { key: key + '|refadd', placeholder: 'ссылка на ролик (YouTube, TikTok, VK…) или путь к видео / папке на диске',
      value: Local.get('refadd:' + d.id) || '', oninput: e => Local.set('refadd:' + d.id, e.target.value) });
    const add = kind => {
      const v = inp.value.trim().replace(/^"|"$/g, '');
      if (!v) return UI.toast('Вставь ссылку или путь', 'err');
      const id = uid('r'), url = isUrl(v);
      Store.add(key, ['refs'], { id, kind, url: url ? v : '', path: url ? '' : v, title: '', note: '', parse: {} });
      inp.value = ''; Local.set('refadd:' + d.id, '');
      if (kind === 'video') Plan.parseRef(key, id);
    };
    return h('div.row.refadd', inp,
      h('button.primary', { onclick: () => add('video'), title: 'Скрипт скачает ролик (если это ссылка), нарежет кадры и расшифрует речь' }, '📼 Добавить видео'),
      h('button', { onclick: () => add('link'), title: 'Статья или страница: Claude прочитает её, если включён 🌐' }, '🔗 Ссылка'));
  },

  parseRef(key, id) { Claude.run({ action: 'refparse', key, scope: 'refparse:' + id, params: { key, ref: id } }); },

  refRow(d, key, r) {
    const ps = r.parse || {}, P = ['refs', r.id], src = r.url || r.path || '';
    const running = !!Claude.running(key, 'refparse:' + r.id) || ps.status === 'running';
    return h('div.ref',
      h('div.row',
        h('span', r.kind === 'video' ? '📼' : '🔗'),
        line(key, [...P, 'title'], { ph: ps.title || 'название', cls: 'grow reftitle' }),
        isUrl(src) ? h('a.small', { href: src, target: '_blank', rel: 'noopener', title: src }, '🔗 открыть')
          : h('span.dim.small', { title: src }, src.length > 50 ? '…' + src.slice(-48) : src),
        r.kind === 'video' && (running ? h('span.dim.small', h('span.spin'), ' разбираю…')
          : h('button.small', { onclick: () => Plan.parseRef(key, r.id), title: 'Скачать (если ссылка), нарезать кадры и расшифровать речь' }, ps.status === 'done' ? '🔄 Заново' : '📼 Разобрать')),
        h('button.icon.del', { title: 'Убрать референс', onclick: () => Store.del(key, ['refs'], r.id) }, '×')),
      area(key, [...P, 'note'], { ph: 'что берём из референса: подачу, темп, структуру, шутки, визуал, звук…', cls: 'box' }),
      ps.status === 'error' && h('div.badline', '⚠ ' + (ps.err || 'не получилось')),
      ps.status === 'done' && h('div.refparse',
        h('div.sheets', (ps.sheets || []).map(s => h('img', { src: '/' + s, alt: '', title: 'Открыть крупно', onclick: () => UI.lightbox('/' + s) }))),
        h('div.grow', h('div.dim.small', `${Math.round(ps.dur || 0)} с · кадры каждые ${ps.step} с`),
          h('details', h('summary', '📄 Расшифровка речи'), h('pre.transcript', ps.text || '(речи нет)')))));
  },

  refImages(d, key) {
    const imgs = (d.refs || []).filter(r => r.kind === 'image');
    return h('div.refimgs',
      imgs.map(r => h('div.refimg',
        imgSlot({ key, path: ['refs', r.id, 'img'], planId: d.id, aspect: '4/3', onSet: p => (p ? Store.set(key, ['refs', r.id, 'img'], p, true) : Store.del(key, ['refs'], r.id)) }),
        line(key, ['refs', r.id, 'note'], { ph: 'что здесь важно', cls: 'box' }))),
      h('div.refimg', imgSlot({ key, path: null, planId: d.id, aspect: '4/3', label: '+ картинка',
        onSet: p => p && Store.add(key, ['refs'], { id: uid('r'), kind: 'image', img: p, note: '' }) })));
  },

  // ---------------- ❓ Вопросы и биты ----------------
  qa(d, key, M) {
    const qa = d.qa || [], answered = qa.filter(q => (q.a || '').trim() || q.skip).length;
    const f = Local.get('qaf:' + d.id) || 'all';
    const focus = h('input.box', { key: key + '|qfocus', placeholder: 'о чём ещё спросить (можно пусто)', style: { width: '240px' },
      value: Local.get('qfocus:' + d.id) || '', oninput: e => Local.set('qfocus:' + d.id, e.target.value) });
    const rounds = [...new Set(qa.map(q => q.round || 1))].sort((a, b) => a - b);
    const shown = q => f === 'all' || !((q.a || '').trim() || q.skip);
    const beats = d.beats || [], kept = beats.filter(b => b.keep !== false).length, ch = d.challenge;
    return [
      hint('qa', HINTS2.qa),
      ideaBanner(d),
      h('section.card',
        h('div.card-head', h('h3', '❓ Вопросы Claude'),
          h('span.counter', { class: qa.length && answered === qa.length ? 'ok' : '' }, `отвечено ${answered} из ${qa.length}`),
          qa.length > 0 && h('div.seg', [['all', 'Все'], ['open', 'Без ответа']].map(([k, l]) =>
            h('button', { class: f === k ? 'sel' : '', onclick: () => { Local.set('qaf:' + d.id, k); App.render(); } }, l))),
          h('span.sp'), focus,
          Claude.btn({ label: qa.length ? 'Ещё вопросы' : '15–20 вопросов', action: 'questions', key, params: () => ({ n: qa.length ? 10 : 18, focus: focus.value }),
            title: qa.length ? 'Уточняющий раунд: Claude учтёт твои ответы и копнёт глубже' : 'Claude прочитает идею, контекст и референсы и спросит всё, что ему непонятно' })),
        qa.length ? rounds.map(rn => {
          const list = qa.filter(q => (q.round || 1) === rn && shown(q));
          return list.length > 0 && h('div.qround',
            rounds.length > 1 && h('div.sec', `Раунд ${rn}` + (list.some(q => q.from === 'challenge') ? ' · после челленджа' : '')),
            list.map(q => Plan.qRow(d, key, q, qa.indexOf(q) + 1)));
        }) : h('div.empty', 'Пока пусто. Нажми ✨ — Claude задаст 15–20 вопросов по идее. Или добавь свой вопрос ниже.'),
        addLine('+ свой вопрос — Enter', q => Store.add(key, ['qa'], { id: uid('q'), q, a: '', why: '', group: '', round: Math.max(1, ...qa.map(x => x.round || 1)), by: 'me' }), key + '|addq')),
      d.flow !== 'idea' && h('section.card',
        h('div.card-head', h('h3', '🧱 Биты'),
          h('span.counter', { class: kept >= M.keep[0] && kept <= M.keep[1] ? 'ok' : kept > M.keep[1] ? 'warn' : '' }, `оставлено ${kept} из ${beats.length} · цель ${M.keep[0]}–${M.keep[1]}`),
          h('span.sp'),
          Claude.btn({ label: beats.length ? 'Ещё биты' : 'Биты из ответов', action: 'beats', key, title: 'Claude разобьёт ролик на биты по идее и твоим ответам' }),
          Claude.btn({ label: 'Челлендж', action: 'challenge', key, title: 'Claude-редактор ищет слабые места битов и задаёт новые вопросы, чтобы их закрыть' })),
        ch && (ch.points || []).length > 0 && h('div.critique',
          h('div.row', h('span.v', { class: { strong: 'good', ok: 'fix', weak: 'bad' }[ch.verdict] || '' }, { strong: '✅ держит', ok: '🔧 есть что усилить', weak: '⛔ пока не держит' }[ch.verdict] || 'челлендж'),
            h('span.dim', ` · ${fmtDate(ch.at)}${ch.round ? ` · новые вопросы — в раунде ${ch.round}` : ''}`), h('span.sp'),
            h('button.icon', { title: 'Скрыть разбор', onclick: () => Store.set(key, ['challenge'], null, true) }, '×')),
          h('ul', ch.points.map(p => h('li', p)))),
        h('div.beats-head', h('span'), h('span', '#'), h('span', '«Вопрос» — сетап'), h('span'), h('span', '«Ответ» — панчлайн'), h('span', 'Источник'), h('span', '✓'), h('span')),
        beats.length ? h('div.beats', beats.map((b, i) => Plan.beatRow(d, key, b, i))) : h('div.empty', 'Битов пока нет. Ответь на вопросы и нажми ✨ Биты из ответов.'),
        addLine('+ бит: вопрос | ответ — Enter', t => { const [q, ...a] = t.split('|'); Store.add(key, ['beats'], { id: uid('b'), q: q.trim(), a: a.join('|').trim(), src: '', keep: true, by: 'me' }); }, key + '|addbeat')),
      h('p', h('a', { href: `#/p/${d.id}/title` }, 'Дальше → 🎯 Название'), h('span.dim', ' · потом 🎬 препродакшен')),
    ];
  },

  qRow(d, key, q, n) {
    const G = REF.qgroups[q.group], done = !!((q.a || '').trim() || q.skip);
    return h('div.qrow', { class: (done ? 'done ' : '') + (q.skip ? 'skip' : '') },
      h('span.no', n),
      h('div.grow',
        h('div.qq', G && h('span.qg', { style: { borderColor: G.color, color: G.color } }, G.label), area(key, ['qa', q.id, 'q'], { cls: 'qtext' }), q.by === 'claude' && h('span.by', '🤖')),
        q.why && h('div.qwhy', q.why),
        !q.skip && area(key, ['qa', q.id, 'a'], { ph: 'твой ответ — можно коротко, можно «не знаю, предложи»', cls: 'ans',
          onInput: (v, el) => el.closest('.qrow').classList.toggle('done', !!v.trim()) })),
      h('button.tgl', { class: q.skip ? 'on skipb' : '', title: q.skip ? 'Вернуть вопрос' : 'Не важно — пропустить', onclick: () => Store.set(key, ['qa', q.id, 'skip'], !q.skip, true) }, '–'),
      h('button.icon.del', { title: 'Удалить вопрос', onclick: () => Store.del(key, ['qa'], q.id) }, '×'));
  },

  // ---------------- 🎬 Препродакшен ----------------
  pre(d, key, M, sub) {
    const els = d.elements || [];
    if (sub) { const e = els.find(x => x.id === sub); if (e) return Plan.element(d, key, M, e); }
    const focus = h('input.box', { key: key + '|pfocus', placeholder: 'чего не хватает? Claude учтёт', style: { width: '260px' },
      value: Local.get('pfocus:' + d.id) || '', oninput: e => Local.set('pfocus:' + d.id, e.target.value) });
    const live = els.filter(e => e.status !== 'drop'), ready = live.filter(e => e.status === 'ok').length;
    return [
      hint('pre', HINTS2.pre),
      ideaBanner(d),
      h('section.card',
        h('div.card-head', h('h3', '🎬 Препродакшен'),
          h('span.counter', { class: live.length && ready === live.length ? 'ok' : '' }, `утверждено ${ready} из ${live.length}`),
          h('span.row', { title: 'Как Claude рисует черновики сцен: бумажный коллаж или картонная 3D-диорама (stage3d)' }, 'сцены:',
            h('div.seg', [['2d', '2D-аппликация'], ['3d', '3D-диорама']].map(([k, l]) =>
              h('button', { class: (d.engine || '2d') === k ? 'sel' : '', onclick: () => Store.set(key, ['engine'], k, true) }, l)))),
          h('span.sp'), focus,
          Claude.btn({ label: live.length ? 'Накидать ещё' : 'Накидать элементы', action: 'elements', key, params: () => ({ focus: focus.value }),
            title: 'Claude соберёт персонажей, пропсы, сцены (с их составом) и звуки по идее и твоим ответам' })),
        !els.length && h('p.dim', 'Пусто. Нажми ✨ — Claude составит список по идее и твоим ответам. Или добавляй сам в разделах ниже.')),
      REF.kinds.map(K => Plan.kindBox(d, key, K, focus)),
      h('p', h('a', { href: `#/p/${d.id}/scenes` }, 'Дальше → 🎥 Сцены'), h('span.dim', ' — оформить сцены в редакторе: расстановка, камера, движение')),
    ];
  },

  kindBox(d, key, K, focus) {
    const all = (d.elements || []).filter(e => e.kind === K.key);
    const list = [...all.filter(e => e.status !== 'drop'), ...all.filter(e => e.status === 'drop')];
    const live = all.filter(e => e.status !== 'drop').length, ok = all.filter(e => e.status === 'ok').length;
    const cast = (d.elements || []).filter(e => (e.kind === 'char' || e.kind === 'prop') && e.status !== 'drop');
    const castOk = cast.filter(e => e.status === 'ok').length;
    return h('section.card',
      h('div.card-head', h('h3', K.icon + ' ' + K.label), h('span.counter', { class: live && ok === live ? 'ok' : '' }, `${ok}/${live}`), h('span.dim', K.hint), h('span.sp'),
        (K.key === 'char' || K.key === 'prop') && h('button.mini', { onclick: () => libImport(d, key, K), title: `Взять готов${K.key === 'char' ? 'ого персонажа' : 'ый пропс'} из библиотеки канала: копия версии станет утверждённым элементом этого видео` }, '📚 Из библиотеки'),
        Claude.btn({ label: 'Ещё', action: 'elements', key, scope: 'elements:' + K.key, params: () => ({ kind: K.key, focus: focus.value }), cls: 'mini',
          title: `Claude предложит ещё: ${K.label.toLowerCase()} (учтёт поле «чего не хватает?»)` })),
      K.key === 'scene' && cast.length > 0 && castOk < cast.length && h('p.warnline', `Персонажи и пропсы утверждены: ${castOk} из ${cast.length}. `,
        'Сцены лучше рисовать после них — утверждённые черновики Claude ставит прямо в сцену.'),
      list.length ? h('div.elgrid', { class: K.key === 'sound' ? 'snd' : '' }, list.map(e => Plan.elCard(d, key, e))) : h('p.dim', 'Пока пусто.'),
      addLine(`+ ${K.one}: название | как выглядит${K.key === 'sound' ? ' / звучит' : ''} — Enter`, t => {
        const [n, ...rest] = t.split('|');
        Store.add(key, ['elements'], { id: uid('e'), kind: K.key, name: n.trim(), desc: rest.join('|').trim(), why: '', q: '', status: '', refs: [], by: 'me' });
      }, key + '|adde' + K.key));
  },

  elCard(d, key, e) {
    const r = elRender(e), s = elSound(e), K = KIND(e.kind), nfx = fxCount((e.fx || {}).main), nmix = elMix(e).length, nfin = (e.final || []).filter(f => (f.text || '').trim()).length;
    const busy = Claude.running(key, 'element:' + e.id) || Claude.running(key, 'sound:' + e.id);
    const pic = r ? r.img : ((e.refs || []).find(x => x.img) || {}).img;
    const open = () => go(`#/p/${d.id}/pre/${e.id}`);
    return h('div.elcard', { class: e.status || 'new', title: 'Открыть', tabindex: 0, role: 'link', 'aria-label': `${K.one}: ${e.name || 'без названия'}, ${{ ok: 'утверждён', drop: 'не нужен' }[e.status] || 'предложен'}`,
      onclick: ev => { if (!ev.target.closest('audio,button,a')) open(); },
      onkeydown: ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); open(); } } },
      e.kind !== 'sound'
        ? h('div.elpic', { class: pic ? '' : 'noimg' }, pic ? h('img', { src: '/' + pic, alt: '' }) : h('span.elph', K.icon),
          busy && h('span.elbusy', h('span.spin'), ' рисую…'), !r && pic && h('span.eltag', 'референс'))
        : h('div.elsnd', s ? h('audio', { controls: true, preload: 'none', src: '/' + s.file })
          : h('span.dim.small', busy ? '⏳ ищу звук…' : (e.sounds || []).length ? `кандидатов: ${e.sounds.length}, не выбран` : 'звук не выбран')),
      h('div.elbody', h('b', e.name || '(без названия)'), e.desc && h('div.eldesc', e.desc),
        h('div.elmeta', h('span.st', { class: e.status || 'new' }, { ok: '✓ утверждён', drop: '✗ не нужен' }[e.status] || '💡 предложен'),
          (e.refs || []).length > 0 && h('span', { title: 'референсов' }, `📎${e.refs.length}`), r && h('span', { title: 'версия черновика' }, `🎨 v${r.v}`),
          nfx > 0 && h('span', { title: 'неотправленных правок' }, `✏️${nfx}`), r && (r.three || r.three3) && h('span', { title: r.three3 ? '3D-пропс — можно покрутить' : '3D-сцена — можно смотреть живьём' }, '🧊'),
          nmix > 1 && h('span', { title: 'звук сведён из нескольких слоёв' }, `🎚${nmix}`), nfin > 0 && h('span', { title: 'пунктов «для финала»' }, `🎬${nfin}`),
          e.by === 'claude' && h('span', { title: 'предложил Claude' }, '🤖')),
        e.kind === 'scene' && sceneCastOf(d, e).length > 0 && Plan.castRow(d, e, true)));
  },

  // characters and props that stand in a scene: little cut-outs (their draft or first reference)
  castRow(d, e, small) {
    return h('div.castrow', { class: small ? 'small' : '' }, sceneCastOf(d, e).map(({ x }) => {
      const r = elRender(x), pic = elPic(x);
      return h('span.castav', { title: x.name + (x.status === 'ok' ? ' · утверждён' : r ? ' · черновик не утверждён' : ' · черновика нет'), class: x.status === 'ok' ? 'ok' : r ? '' : 'none' },
        pic ? h('img', { src: '/' + pic, alt: '' }) : KIND(x.kind).icon, !small && h('span', x.name));
    }));
  },

  // «Что в сцене»: link characters and props to a scene — Claude puts their drafts into it
  sceneCast(d, key, e) {
    const P = ['elements', e.id, 'uses'], uses = e.uses || [];
    const pool = (d.elements || []).filter(x => (x.kind === 'char' || x.kind === 'prop') && x.status !== 'drop');
    const cast = sceneCastOf(d, e), free = pool.filter(x => !cast.some(c => c.x === x));
    return [
      h('label', 'Что в сцене', h('span.dim', ' — персонажи и пропсы: их черновики Claude поставит в сцену; @ в текстах сцены тоже добавляет')),
      cast.length ? h('div.castlist', cast.map(({ x, via }) => {
        const r = elRender(x), pic = elPic(x);
        return h('div.castitem', { class: x.status === 'ok' ? 'ok' : '' },
          h('a', { href: `#/p/${d.id}/pre/${x.id}`, title: 'Открыть элемент' }, pic ? h('img', { src: '/' + pic, alt: '' }) : h('span.elph', KIND(x.kind).icon)),
          h('div.grow', h('b', x.name), h('div.dim.small', (x.status === 'ok' ? '✓ утверждён' : r ? `черновик v${r.v}, не утверждён` : 'черновика нет — Claude нарисует по описанию')
            + (via === '@' ? ' · отмечен через @ в тексте' : ''))),
          via === 'uses' ? h('button.icon.del', { title: 'Убрать из сцены', onclick: () => Store.set(key, P, uses.filter(i => i !== x.id), true) }, '×')
            : h('span.dim.small', { title: 'Чтобы убрать — удали @-ссылку из текста сцены' }, '@'));
      })) : h('p.dim.small', pool.length ? 'Пока никого — добавь из списка или отметь через @ в описании.' : 'Сначала заведи персонажей и пропсы в препродакшене.'),
      free.length > 0 && sel([{ value: '', label: '+ персонаж или пропс в сцену…' },
        ...['char', 'prop'].map(k => ({ label: KIND(k).label, group: free.filter(x => x.kind === k).map(x => ({ value: x.id, label: x.name + (x.status === 'ok' ? ' ✓' : '') })) })).filter(g => g.group.length)],
        '', v => v && Store.set(key, P, [...uses, v], true), { class: 'box' }),
    ];
  },

  element(d, key, M, e) {
    const K = KIND(e.kind), P = ['elements', e.id];
    const same = (d.elements || []).filter(x => x.kind === e.kind), i = same.indexOf(e);
    const nav = (x, label) => (x ? h('a.btn', { href: `#/p/${d.id}/pre/${x.id}`, title: x.name }, label) : null);
    return [
      h('div.row.elnav', h('a.btn', { href: `#/p/${d.id}/pre` }, '← Все элементы'), h('span.dim', `${K.icon} ${K.label} · ${i + 1} из ${same.length}`), h('span.sp'),
        nav(same[i - 1], '← ' + (same[i - 1] || {}).name), nav(same[i + 1], (same[i + 1] || {}).name + ' →')),
      h('div.eldetail', h('div.elleft',
        h('section.card.elinfo',
          h('div.row', sel(REF.kinds.map(k => ({ value: k.key, label: k.icon + ' ' + k.one })), e.kind, v => Store.set(key, [...P, 'kind'], v, true), { class: 'box' }),
            Plan.nameInput(key, e)),
          h('div.seg.stseg', [['', '💡 предложен'], ['ok', '✓ утверждён'], ['drop', '✗ не нужен']].map(([k, l]) =>
            h('button', { class: (e.status || '') === k ? 'sel' : '', onclick: () => Store.set(key, [...P, 'status'], k, true) }, l))),
          h('label', e.kind === 'sound' ? 'Как звучит' : 'Как выглядит'),
          area(key, [...P, 'desc'], { cls: 'box', ph: e.kind === 'sound' ? 'гулкий металлический лязг, эхо в шахте…' : 'материал, цвет, эпоха, состояние, размер…' }),
          h('label', 'Где в ролике'), area(key, [...P, 'why'], { cls: 'box', ph: 'в каком бите или сцене' }),
          e.kind === 'scene' && Plan.sceneCast(d, key, e),
          h('label', 'Референсы', h('span.dim', ' — Ctrl+V, перетащи или 📎; Claude смотрит их, когда рисует')),
          Plan.elRefs(d, key, e),
          Plan.linksBar(d, e),
          h('div.row', { style: { marginTop: '10px' } }, e.by === 'claude' && h('span.dim.small', '🤖 предложил Claude'), h('span.sp'),
            h('button.icon.del', { title: 'Удалить элемент', onclick: () => { if (confirm(`Удалить «${e.name}»?`)) { Store.del(key, ['elements'], e.id, false); go(`#/p/${d.id}/pre`); } } }, '🗑 удалить'))),
          e.kind !== 'sound' && Plan.assetBox(d, key, e)),
        h('div.elright', h('section.card.elwork', e.kind === 'sound' ? Plan.elSound(d, key, e) : Plan.elDraw(d, key, e)), Plan.finalBox(d, key, e))),
    ];
  },

  // the name field: renaming an element rewrites every @[old name] in the plan, so links do not break
  nameInput(key, e) {
    const inp = line(key, ['elements', e.id, 'name'], { cls: 'elname grow', ph: 'название' });
    inp.addEventListener('focus', () => (inp.dataset.old = inp.value));
    inp.addEventListener('change', () => { Plan.renameMentions(key, inp.dataset.old, inp.value); inp.dataset.old = inp.value; });
    return inp;
  },
  renameMentions(key, from, to) {
    if (!(from || '').trim() || !(to || '').trim() || normName(from) === normName(to)) return;
    const n = normName(from);
    let k = 0;
    const walk = (o, path) => {
      if (typeof o === 'string') {
        if (!o.includes('@[')) return;
        const v = o.replace(MENTION_RE, (m, name) => (normName(name) === n ? '@[' + to.trim() + ']' : m));
        if (v !== o) { Store.set(key, path, v); k++; }
      } else if (Array.isArray(o)) { for (const it of o) if (it && typeof it === 'object' && it.id) walk(it, [...path, it.id]); }
      else if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) if (kk !== 'id' && kk !== 'rev') walk(v, [...path, kk]);
    };
    walk(Store.get(key), []);
    if (k) { App.render(); UI.toast(`@-ссылки переименованы: ${k}`); }
  },

  // 🔗 what this element points to with @ and where it is pointed at from
  chips(d, list) {
    return h('div.chips.mchips', list.map(x => h('a.mchip', { href: `#/p/${d.id}/pre/${x.id}`, title: KIND(x.kind).one + (x.status === 'ok' ? ' · утверждён' : '') },
      elPic(x) ? h('img', { src: '/' + elPic(x), alt: '' }) : h('span', KIND(x.kind).icon), x.name)));
  },
  linksBar(d, e) {
    const out = elMentions(d, e), back = (d.elements || []).filter(x => x !== e && x.status !== 'drop' && elMentions(d, x).includes(e));
    if (!out.length && !back.length) return h('p.dim.small', { style: { marginTop: '8px' } }, '@ в любом поле — ссылка на другой элемент: Claude и реализатор получат его черновик и код.');
    return [out.length > 0 && [h('label', '🔗 Отмечено через @'), Plan.chips(d, out)], back.length > 0 && [h('label', '↩ Упоминается в'), Plan.chips(d, back)]];
  },

  // 🎬 «Для финала»: what the author wants from the asset in the finished video — the brief for the production (preprod.export -> README)
  finalBox(d, key, e) {
    const F = ['elements', e.id, 'final'], fin = e.final || [];
    return h('section.card.finalcard', { class: e.status === 'ok' ? 'ok' : '' },
      h('div.card-head', h('h3', '🎬 Для финала'), h('span.dim.small', 'черновик — не финал: что должно быть в готовом ассете. Это ТЗ для сборки ролика; @ — сослаться на другой элемент')),
      fin.length ? h('div.finlist', fin.map((f, i) => h('div.finrow',
        h('span.fnum', { class: f.x != null ? 'pinned' : '', title: f.x != null ? 'Пин на картинке черновика' : '' }, i + 1),
        area(key, [...F, f.id, 'text'], { cls: 'box', ph: e.kind === 'sound' ? '«в финале — эхо шахты, хвост 2 с»' : '«снег падает хлопьями и налипает на @[Табличка трассы]»' }),
        f.x != null && h('button.icon', { title: 'Убрать пин с картинки (текст останется)', onclick: () => { Store.set(key, [...F, f.id, 'x'], null); Store.set(key, [...F, f.id, 'y'], null, true); } }, '📍×'),
        h('button.icon.del', { title: 'Удалить пункт', onclick: () => Store.del(key, F, f.id) }, '×'))))
        : h('p.dim.small', e.kind === 'sound' ? 'Пока пусто.' : e.status === 'ok' ? 'Пока пусто. Кликни по черновику — поставишь пин «для финала», или напиши ниже.' : 'Пока пусто. Когда утвердишь черновик, клик по нему будет ставить пины «для финала».'),
      addLine('+ для финала: что должно быть в готовом ассете — Enter (можно @элемент)', t => Store.add(key, F, { id: uid('f'), text: t }), key + '|addfin|' + e.id));
  },

  elRefs(d, key, e) {
    const P = ['elements', e.id, 'refs'];
    return h('div.refimgs.small',
      (e.refs || []).map(r => h('div.refimg',
        imgSlot({ key, path: [...P, r.id, 'img'], planId: d.id, aspect: '4/3', onSet: p => (p ? Store.set(key, [...P, r.id, 'img'], p, true) : Store.del(key, P, r.id)) }),
        line(key, [...P, r.id, 'note'], { ph: 'что взять', cls: 'box' }))),
      h('div.refimg', imgSlot({ key, path: null, planId: d.id, aspect: '4/3', label: '+ референс', onSet: p => p && Store.add(key, P, { id: uid('f'), img: p, note: '' }) })));
  },

  // 🎨 draft by our engine (ideas_claude.element_spec) + edits by pins, like the video review
  elDraw(d, key, e) {
    const rs = elRenders(e), cur = elRender(e), scope = 'element:' + e.id, running = Claude.running(key, scope);
    const FX = ['elements', e.id, 'fx', 'main'], fx = (e.fx || {}).main || {}, pins = fx.pins || [], n = fxCount(fx);
    const three = e.kind === 'scene' && d.engine === '3d', prop3 = isProp3(e), p3 = cur && cur.three3, pins3 = fx.pins3d || [];
    const has2d = prop3 && (e.renders || []).some(r => !r.three3);
    const rig = isRigChar(e), rc = cur && cur.rigchar, trl = cur && cur.source === 'trellis' && cur.meta, act = trl ? 'trellisfix' : rig ? 'charparts' : 'element';
    // a click on the picture: a pin for the next draft (red) or, once the element is approved, a wish «для финала» (green)
    const mode = Plan.pinMode[e.id] || (e.status === 'ok' ? 'final' : 'fix'), FIN = ['elements', e.id, 'final'];
    const img = cur && rc ? h('img', { src: '/' + cur.img, alt: '', title: 'Проверочные позы с костями — клик: крупно', onclick: () => UI.lightbox('/' + cur.img) })
      : cur && p3 ? h('img', { src: '/' + cur.img, alt: '', title: 'Клик — покрутить модель и поставить пины', onclick: () => Plan.viewProp(d, e, cur) })
      : cur && h('img', { src: '/' + cur.img, alt: '', title: mode === 'final' ? 'Клик — пин «для финала»' : 'Клик — пин с правкой черновика', onclick: ev => {
      const b = ev.currentTarget.getBoundingClientRect(), id = uid(mode === 'final' ? 'f' : 'p');
      const x = Math.round((ev.clientX - b.left) / b.width * 1000) / 1000, y = Math.round((ev.clientY - b.top) / b.height * 1000) / 1000;
      if (mode === 'final') { App.focusKey = key + '|' + [...FIN, id, 'text'].join('.'); Store.add(key, FIN, { id, text: '', x, y }); return; }
      App.focusKey = key + '|' + [...FX, 'pins', id, 'text'].join('.');
      Store.add(key, [...FX, 'pins'], { id, x, y, text: '' });
    } });
    const finMarks = (e.final || []).map((f, i) => f.x != null && h('span.pin.fin', { style: { left: f.x * 100 + '%', top: f.y * 100 + '%' }, title: f.text || '' }, i + 1));
    // a scene is drawn from its characters and props: ask before drawing it without their drafts
    const bare = e.kind === 'scene' ? sceneCastOf(d, e).map(c => c.x).filter(x => !elRender(x)).map(x => x.name) : [];
    const ask = bare.length ? `У ${bare.length === 1 ? 'элемента' : 'элементов'} сцены ещё нет черновика: ${bare.join(', ')}. Claude нарисует ${bare.length === 1 ? 'его' : 'их'} прямо в сцене по описанию. Рисовать сцену сейчас?` : null;
    return [
      h('div.card-head', h('h3', '🎨 Черновик' + (three || (cur && cur.three) || prop3 ? ' · 3D' : '')),
        e.kind === 'char' && h('div.seg.small', { title: 'Лист — рисунок персонажа; со скелетом — части на костях: позы, эмоции, костюмы, анимации (S4–S5)' },
          [['', '🖼 лист'], ['rig', '🦴 со скелетом']].map(([k, l]) => h('button', { class: (e.form || '') === k ? 'sel' : '', disabled: running, onclick: () => Store.set(key, ['elements', e.id, 'form'], k, true) }, l))),
        e.kind === 'prop' && h('div.seg.small', { title: '2D — рисунок-карточка; 3D — объёмный пропс' },
          ['2d', '3d'].map(k => h('button', { class: dimOf(e) === k ? 'sel' : '', disabled: running || (e.kind === 'char' && k === '3d'),
            title: e.kind === 'char' && k === '3d' ? 'Персонажи в 3D — этап S4 (скелеты)' : '',
            onclick: () => { Store.set(key, ['elements', e.id, 'dim'], k, true); } }, k.toUpperCase()))),
        prop3 && h('select.small', { title: 'Как Claude делает 3D-пропс', disabled: running, onchange: ev => Store.set(key, ['elements', e.id, 'how'], ev.target.value, true) },
          [['auto', 'способ: сам выберет'], ['shapes', 'фигурами кодом'], ['model', 'из модели 📦'], ...(App.info.blender ? [['blender', 'через Blender']] : [])]
            .map(([v, l]) => h('option', { value: v, selected: (e.how || 'auto') === v }, l))),
        rs.length > 1 && h('span.row', rs.map(r => h('button.small', { class: r === cur ? 'sel' : '', title: r.feedback ? 'правка: ' + r.feedback : 'первая версия',
          onclick: () => Store.set(key, ['elements', e.id, 'render'], r.id, true) }, 'v' + r.v))),
        h('span.sp'),
        e.kind === 'scene' && e.stage && e.stage.work && h('button.primary', { onclick: () => go(`#/p/${d.id}/pre/${e.id}/stage`), title: 'Редактор сцены: расстановка, камера и планы, ключи движения, звуки, маркеры, отмена, версии, клип, просьбы Claude' }, '🎬 Оформить сцену'),
        e.kind === 'scene' && !(e.stage && e.stage.work) && cur && cur.three && !cur.stage && Claude.btn({ label: 'Перевести в редактор', icon: '🎬', action: 'sceneconvert', key, scope: 'sceneconvert:' + e.id,
          params: { el: e.id, base: cur.id }, confirm: `Claude (Opus) переведёт «${e.name}» v${cur.v} в редактор сцены: код предметов отдельно, расстановка и движение — данными. Картинка не должна измениться — он сам сравнит кадры «было / стало». 5–10 минут.`,
          title: 'Перевести сцену в формат редактора (🎬 Оформить сцену)' }),
        cur && cur.three && !(e.stage && e.stage.work) && h('button', { onclick: () => Plan.view3d(d, e, cur, true), title: 'Переставить объекты сцены: мышью или с клавиатуры — сдвиг, поворот, размер. Сохраняется новой версией без Claude.' }, '✋ Расставить'),
        cur && cur.three && !cur.stage && h('button' + (e.stage && e.stage.work ? '' : '.primary'), { onclick: () => Plan.view3d(d, e, cur), title: 'Сцена играет живьём, камеру можно крутить мышью' }, '🧊 Смотреть в 3D'),
        (p3 || (rc && cur.model3d)) && h('button.primary', { onclick: () => Plan.viewProp(d, e, cur), title: 'Покрутить мышью; клик по модели ставит пин с правкой' }, '🧊 Покрутить · 📍 пины'),
        trl && cur.meta.stage === 'draft' && h('button.primary', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => charModel(key, e.id, 'trellis', undefined, { mode: 'final', base: cur.id }),
          title: 'Та же фигура (те же сиды), но 1536³, текстура 2048 и полная сетка — 3–8 минут' }, '⬆ Довести'),
        trl && h('button', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => trellisDlg(key, e, cur, 'retex'), title: 'Форма та же — новая раскраска: по другой картинке или новым сидом' }, '🎨 Перекрасить'),
        rc && cur.fn !== 'hog' && !cur.model3d && h('button.primary', { onclick: () => Plan.viewSkel(d, e, cur), title: 'Двигать суставы мышью, проверять позами; сохраняется новой версией без Claude' }, '🦴 Редактор скелета'),
        ((rig && e.kind === 'char') || e.kind === 'prop') && h('span.row.mk3d', { title: e.kind === 'prop' ? '3D-пропс из модели по картинке: локально или сервисом' : 'Как сделать 3D-героя со скелетом' },
          e.kind === 'char' && Claude.btn({ label: 'Blender', icon: '🧊', action: 'charparts', key, scope, params: { el: e.id, make: 'blender' }, title: 'Claude (Opus) соберёт детальную модель в Blender кодом по референсам и поставит скелет — 15–40 минут' }),
          h('button', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => trellisDlg(key, e, null), title: 'TRELLIS.2 / Pixal3D на твоей видеокарте, бесплатно: черновик за 1–3 минуты, потом «довести», «перекрасить», пины. Ставится в ⚙ Настройках' }, '🖥 TRELLIS'),
          h('button', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => charModel(key, e.id, 'meshy'), title: 'Meshy: модель с текстурой прямо по первому референсу + их авто-скелет (ключ — в ⚙ Настройках)' }, '✨ Meshy'),
          h('button', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => charModel(key, e.id, 'tripo'), title: 'Tripo: модель с текстурой по первому референсу + их авто-скелет (ключ — в ⚙ Настройках)' }, '✨ Tripo'),
          Claude.running(key, 'charmodel:' + e.id) && h('span.dim.small', h('span.spin'), ' ', (Object.values(Claude.jobs).find(j => j.scope === 'charmodel:' + e.id && j.status === 'running') || {}).summary || 'делаю…')),
        !cur && rig && e.make !== 'blender' && Claude.btn({ label: '🦴 Собрать персонажа', icon: '', action: 'charparts', key, scope, params: { el: e.id },
          title: e.make === 'blender' ? 'Claude (Opus) соберёт 3D-модель в Blender со скелетом-арматурой, снимет поворотный стол и позы — 15–40 минут' : 'Claude (Opus) нарисует персонажа частями, предложит скелет, пять проверочных поз и лица — 10–20 минут' }),
        !cur && !rig && Claude.btn({ label: prop3 ? (has2d ? 'Сделать в 3D' : 'Сделать 3D-пропс') : 'Нарисовать черновик', action: 'element', key, scope, params: { el: e.id }, confirm: ask,
          title: prop3 ? 'Claude (Opus) соберёт объёмный пропс (фигурами, из модели или в Blender), снимет четыре ракурса, сам посмотрит и поправит. 5–15 минут.'
            : 'Claude нарисует элемент нашим тулкитом по описанию и референсам, сам посмотрит и поправит. 3–10 минут.' })),
      running && rig && h('p.dim', 'Claude собирает персонажа: рисует части, ставит кости, проверяет пятью позами и лицами — обычно 10–20 минут.'),
      running && !rig && h('p.dim', prop3 ? 'Claude собирает 3D-пропс: пишет код (или модель в Blender), снимает четыре ракурса, смотрит и правит — обычно 5–15 минут.'
        : 'Claude рисует: пишет код, рендерит, смотрит на картинку и правит — обычно 3–10 минут. Можно заниматься другими элементами.'),
      Claude.running(key, 'sceneconvert:' + e.id) && h('p.dim', h('span.spin'), ' 🎬 Claude переводит сцену в редактор и сравнивает кадры «было / стало» — 5–10 минут…'),
      e.stage && e.stage.work && Plan.stageInfo(d, e),
      Claude.running(key, 'layout3d:' + e.id) && h('p.dim', h('span.spin'), ' ✋ снимаю новую расстановку — полминуты…'),
      !cur && !running && rig && h('p.dim', (e.renders || []).some(r => !r.rigchar)
          ? 'Со скелетом персонажа ещё нет. Claude возьмёт твой утверждённый лист за образец, разрежет его на части и предложит скелет (кот — хвост, уши, лапы); потом ты подвинешь суставы в редакторе скелета.'
          : 'Claude нарисует персонажа частями и предложит скелет; суставы потом подвинешь в редакторе скелета, поправить можно и словами — «в целом».'),
      !cur && !running && !rig && h('p.dim', prop3 ? (has2d ? '3D-версии ещё нет. Claude сделает её по 2D-черновику: та же форма, цвета и детали, но объёмно — его можно будет крутить и ставить в сцены.'
          : 'Пропс будет объёмным: Claude соберёт его фигурами, из модели 📦 или в Blender. Его можно будет покрутить и поставить пины прямо на модель.')
        : three ? 'Сцена будет 3D-диорамой (stage3d, как в «Не жми эту кнопку»). Переключатель 2D / 3D — на странице препродакшена.'
        : 'Добавь референсы слева (необязательно) и нажми ✨ — получишь черновик, который правится пинами, как в ревью.'),
      cur && !p3 && !rc && h('div.seg.pinmode', { title: 'Что ставит клик по картинке' },
        [['fix', '✏️ правка черновика'], ['final', '🎬 для финала']].map(([k, l]) => h('button', { class: mode === k ? 'sel' : '', onclick: () => { Plan.pinMode[e.id] = k; App.render(); } }, l))),
      cur && h('div.elshot', h('div.pinwrap.big', img, pinMarks(fx), finMarks),
        (cur.extra || []).length > 0 && h('div.extra', cur.extra.map(x => h('img', { src: '/' + x, alt: '', title: 'другой момент времени — открыть крупно', onclick: () => UI.lightbox('/' + x) })))),
      (p3 || (rc && cur.model3d)) && (pins3.length ? h('ol.pinlist', pins3.map((p, i) => h('li', h('span.pnum', i + 1),
        line(key, [...FX, 'pins3d', p.id, 'text'], { ph: 'что здесь не так / как надо', cls: 'box' }),
        h('button.icon.del', { title: 'Убрать пин', onclick: () => Store.del(key, [...FX, 'pins3d'], p.id) }, '×'))))
        : h('p.dim', 'Нажми «🧊 Покрутить · 📍 пины» (или на картинку): крути модель мышью и кликай по ней — каждый клик ставит пин с номером, текст правки пишешь рядом.')),
      cur && rc && h('p.dim.small', 'Правки скелета словами — «в целом» ниже («добавь хвост из 3 костей», «уши гнутся»), суставы — в редакторе скелета.'),
      cur && !p3 && !rc && (pins.length ? h('ol.pinlist', pins.map((p, i) => h('li', h('span.pnum', i + 1),
        line(key, [...FX, 'pins', p.id, 'text'], { ph: 'что здесь не так / как надо', cls: 'box' }),
        h('button.icon.del', { title: 'Убрать пин', onclick: () => Store.del(key, [...FX, 'pins'], p.id) }, '×'))))
        : h('p.dim', mode === 'final' ? 'Клик по картинке ставит зелёный пин «для финала» — пункт появится в блоке ниже. Правки к следующему черновику — режим «✏️ правка черновика».'
          : 'Кликни по картинке — поставишь пин с номером и напишешь, что поправить в следующем черновике.')),
      cur && [h('label', 'В целом', h('span.dim', ' — к следующему черновику; каждая правка отдельным пунктом')),
        noteList(key, FX, '+ «краска зеленее, как в советских коридорах», «ёжик меньше», «кнопки круглые»…')],
      cur && h('div.row',
        n ? Claude.btn({ label: `Поправить (${n})`, action: act, key, scope, params: { el: e.id, base: cur.id }, title: trl ? 'Claude прочтёт пины, посмотрит модель и подберёт, что перелепить (силуэт, детали, раскраску, картинку, ракурсы); лепит TRELLIS' : 'Новая версия с учётом правок; прошлые остаются',
            onResult: trl ? r => { if (!r || !r.reseed) return; UI.toast(r.reply || 'перелепливаю', 'ok');
              charModel(key, e.id, 'trellis', undefined, Object.assign({ mode: 'fix', base: cur.id, why: r.reply, feedback: r.feedback },
                ...['reseed', 'engine', 'stage', 'ref', 'texref', 'views', 'pad', 'bg', 'faces', 'tex'].filter(k => r[k] != null && r[k] !== '' && !(typeof r[k] === 'object' && !Array.isArray(r[k]) && !Object.keys(r[k]).length)).map(k => ({ [k]: r[k] })))); } : undefined })
          : h('span.dim.small', 'правок нет'),
        h('span.sp'),
        e.status !== 'ok' && h('button.primary', { onclick: () => Store.set(key, ['elements', e.id, 'status'], 'ok', true) }, '✓ Утвердить'),
        Claude.btn({ label: '', icon: '🔄', action: act, key, scope, params: { el: e.id }, cls: 'mini', confirm: ask, title: 'Нарисовать с нуля ещё вариант' })),
      cur && cur.feedback && h('p.dim.clamp', cur.by === 'layout' || cur.by === 'skeleton' ? `v${cur.v} — ${cur.feedback}` : `✏️ v${cur.v} — правка: ${cur.feedback}`),
      cur && cur.summary && h('p.dim.clamp', { title: 'Клик — целиком', onclick: ev => ev.currentTarget.classList.toggle('open') }, cur.summary),
      cur && cur.note && h('p.clamp.elnote', '💬 ' + cur.note),
      cur && h('div.code.dim.small', 'код: ', h('code', `render/${cur.dir}/${p3 ? 'prefab.js' : rc ? 'prefab.js + rig.json' : 'element.js'}`), cur.fn && [' · функция ', h('code', cur.fn)],
        p3 && cur.how && [' · способ: ', { shapes: 'фигуры кодом', model: 'модель 📦', blender: 'Blender' }[cur.how] || cur.how]),
    ];
  },

  // a scene in the editor: how the conversion went (frames «было / стало»), the last clip
  stageInfo(d, e) {
    const st = e.stage, df = st.diff || {};
    const bad = df.frames && !df.ok;
    return h('div.stageinfo', { class: bad ? 'warn' : '' },
      h('span', '🎬 в редакторе'), st.fromV && h('span.dim.small', ` · из v${st.fromV}`),
      df.frames && h('span.small', { title: (df.frames || []).map(f => `t=${f.t}: средняя ${f.mean}, 95% ${f.p95}`).join('\n') }, bad ? ' · ⚠ кадры отличаются' : ' · кадры «было / стало» совпадают ✓'),
      st.compare && h('button.small', { onclick: () => UI.lightbox('/' + st.compare) }, 'было / стало'),
      st.clip && h('a.btn.small', { href: '/' + st.clip.file.replace(/^render\//, 'rscene/'), target: '_blank', rel: 'noopener' }, '🎞 клип'));
  },

  // 🧊 a 3D draft live: the stand in view mode (web/render/stand3d.html?view=1) — plays the scene, the camera orbits with the mouse.
  // &edit=1 adds «✋ Двигать»: the author moves named objects (stage3d items), «💾 Сохранить» -> POST /api/layout3d -> a new version with WORLD.layout
  view3d(d, e, r, move) {
    const key = 'plan:' + d.id;
    const src = `/tpl/stand3d.html?scene=/rscene/${r.dir}/element.js&parts=element&view=1&edit=1&key=${encodeURIComponent(key)}&el=${e.id}&base=${r.id}` + (move ? '&move=1' : '');
    const onMsg = ev => {
      if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'stand3d-layout') return;
      if (ev.data.job) Claude.jobs[ev.data.job.id] = ev.data.job;
      close(); App.render();
      UI.toast('✋ Расстановка сохраняется — новая версия черновика появится через полминуты');
    };
    addEventListener('message', onMsg);
    const close = UI.modal(`🧊 ${e.name} · v${r.v}`, h('div.view3d',
      h('iframe', { src, title: '3D-сцена', allow: 'fullscreen' }),
      h('div.row', h('span.dim.small', '«✋ Двигать» (M) — переставить объекты: тяни мышью или стрелками, Q / E — поворот, + / − — размер. «💾 Сохранить» делает новую версию черновика без Claude. Пробел — пауза.'), h('span.sp'),
        h('a.btn', { href: src, target: '_blank', rel: 'noopener' }, '↗ Во весь экран'))), { wide: true, onClose: () => removeEventListener('message', onMsg) });
  },
  // 🧊 3D-пропс: поворотный стол (stand3d.html?prop=…&view=1&pin=1) — крутить мышью, клик по модели ставит пин (fx.main.pins3d) с текстом справа
  viewProp(d, e, r) {
    const key = 'plan:' + d.id, PP = ['elements', e.id, 'fx', 'main', 'pins3d'];
    const src = `/tpl/stand3d.html?prop=${encodeURIComponent('/rscene/' + r.dir + '/prefab.js')}&view=1&pin=1`;
    const frame = h('iframe', { src, title: '3D-пропс' }), list = h('div.p3list');
    const cur = () => { const el = ((Store.get(key) || {}).elements || []).find(x => x.id === e.id); return (((el || {}).fx || {}).main || {}).pins3d || []; };
    const send = () => { try { frame.contentWindow.postMessage({ type: 'prop-pins', pins: cur().map((p, i) => ({ n: i + 1, p: p.p })) }, location.origin); } catch (err) {} };
    const draw = focus => {
      const ps = cur();
      list.replaceChildren(h('h4', '📍 Пины на модели'),
        ps.length ? h('ol.pinlist', ps.map((p, i) => h('li', h('span.pnum', i + 1),
          line(key, [...PP, p.id, 'text'], { ph: 'что здесь не так / как надо', cls: 'box' }),
          h('button.icon.del', { title: 'Убрать пин', onclick: () => { Store.del(key, PP, p.id, false); draw(); send(); App.render(); } }, '×'))))
          : h('p.dim.small', 'Кликни по модели — появится пин с номером. Крутить — тяни мышью, колесо — ближе, пробел — вращение стола.'),
        h('p.dim.small', 'Правки уходят в следующую версию кнопкой «Поправить» в карточке. Там же — «в целом».'));
      if (focus) { const inp = list.querySelectorAll('input'); const last = inp[inp.length - 1]; if (last) last.focus(); }
    };
    const onMsg = ev => {
      if (ev.origin !== location.origin || !ev.data || ev.source !== frame.contentWindow) return;
      if (ev.data.type === 'prop-ready') send();
      if (ev.data.type === 'prop-pin') { Store.add(key, PP, { id: uid('p'), p: ev.data.p, n: ev.data.n, text: '' }, false); draw(true); send(); App.render(); }
    };
    addEventListener('message', onMsg);
    draw();
    UI.modal(`🧊 ${e.name} · v${r.v}`, h('div.view3d.prop3', h('div.p3main', frame, list),
      h('div.row', h('span.dim.small', 'Лист из четырёх ракурсов — в карточке; клик по картинке открывает этот просмотр.'), h('span.sp'),
        h('a.btn', { href: src.replace('&pin=1', ''), target: '_blank', rel: 'noopener' }, '↗ Во весь экран'))), { wide: true, onClose: () => removeEventListener('message', onMsg) });
  },
  // 🦴 редактор скелета (stands/skel.html): суставы мышью, позы, «💾 Сохранить» -> POST /api/char/rig -> новая версия (задача charrig)
  viewSkel(d, e, r) {
    const key = 'plan:' + d.id;
    const src = `/render/skel.html?char=${encodeURIComponent('/rscene/' + r.dir + '/prefab.js')}&key=${encodeURIComponent(key)}&el=${e.id}&base=${r.id}`;
    const onMsg = ev => {
      if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'skel-saved') return;
      if (ev.data.job) Claude.jobs[ev.data.job.id] = ev.data.job;
      close(); App.render(); UI.toast('🦴 Скелет сохраняется — новая версия появится через полминуты');
    };
    addEventListener('message', onMsg);
    const close = UI.modal(`🦴 ${e.name} · v${r.v}`, h('div.view3d', h('iframe', { src, title: 'Редактор скелета' })), { wide: true, onClose: () => removeEventListener('message', onMsg) });
  },
  viewModel(title, url) {
    const src = `/tpl/stand3d.html?model=${encodeURIComponent(url)}&view=1`;
    UI.modal('🧊 ' + title, h('div.view3d', h('iframe', { src, title: '3D-модель' }),
      h('p.dim.small', 'Модель на полу со светом, камера облетает её сама; тяни мышью — крутить, колесо — ближе.')), { wide: true });
  },

  // 📦 free assets for an element: search (assets.py via /api/assets/search) -> «📌 в реф.» (the preview into refs) or
  // «⬇ в работу» (the asset itself into e.assets: glTF for w.model, a picture, texture maps — Claude and the implementer use them)
  ares: {},
  assetBox(d, key, e) {
    const S = Plan.ares[e.id] || {}, list = e.assets || [], P = ['elements', e.id, 'assets'];
    const kind = S.kind || (d.engine === '3d' ? '3d' : '2d'), three = d.engine === '3d' && e.kind === 'scene';
    const q = draftInput(key + '|aq|' + e.id, { class: 'box grow', value: S.q ?? '', placeholder: 'по-английски: elevator, office chair, brick wall…',
      'aria-label': 'Поиск бесплатных ассетов', onkeydown: ev => { if (ev.key === 'Enter' && !ev.isComposing) search(); } });
    const search = async (k = kind) => {
      const v = q.value.trim();
      if (!v) { Plan.ares[e.id] = { ...S, kind: k }; App.render(); return; }
      Plan.ares[e.id] = { q: v, kind: k, busy: true, list: S.kind === k ? S.list : [] }; App.render();
      try { const r = await api('GET', `/api/assets/search?q=${encodeURIComponent(v)}&kind=${k}&n=12`); Plan.ares[e.id] = { q: v, kind: k, list: r.results || [], errs: r.errors || [], hint: r.hint }; }
      catch (err) { Plan.ares[e.id] = { q: v, kind: k, list: [], errs: [err.message] }; }
      App.render();
    };
    const sc = (r, as) => `assetfetch:${e.id}:${as}:${r.src}:${r.id}`;
    const take = (r, as) => Claude.run({ action: 'assetfetch', key, scope: sc(r, as), params: { key, el: e.id, as, row: r } });
    const busy = (r, as) => Claude.running(key, sc(r, as));
    const inRefs = r => (e.refs || []).some(x => x.asset === `${r.src}:${r.id}`), inWork = r => list.some(a => a.src === r.src && a.sid === String(r.id));
    const picks = e.picks || [], PK = ['elements', e.id, 'picks'];
    const card = (r, pick) => h('div.acard', { class: pick ? 'pick' : '' },
      h('div.athumb', r.thumb && h('img', { src: r.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', title: 'Крупно', onclick: () => UI.lightbox(r.thumb) }),
        h('span.srcb', { class: r.src }, ASSET_SRC[r.src] || r.src),
        pick && h('button.icon.del.adrop', { title: 'Убрать предложение', onclick: () => Store.del(key, PK, pick.pid) }, '×')),
      h('b.clamp1', { title: r.title }, r.title),
      h('div.dim.small.clamp1', { title: [r.license, r.author].filter(Boolean).join(' · ') }, [r.license || 'лицензия на странице', r.author].filter(Boolean).join(' · ')),
      pick && pick.why && h('div.awhy', { title: pick.why }, (pick.use === 'work' ? '⬇ ' : '📌 ') + pick.why),
      r.attr && h('div.awarn', 'нужна подпись автора'),
      !pick && r.note && h('div.dim.small.clamp2', { title: r.note }, r.note),
      h('div.row.abtns',
        inRefs(r) ? h('span.ok-t.small', '📌 в реф.') : h('button.small', { disabled: !!busy(r, 'ref') || !r.thumb, onclick: () => take(r, 'ref'),
          title: 'Картинку-превью — в референсы элемента: Claude посмотрит её, когда будет рисовать' }, busy(r, 'ref') ? '⏳' : '📌 В реф.'),
        inWork(r) ? h('span.ok-t.small', '✓ в работе') : h('button.small.primary', { disabled: !!busy(r, 'work') || !r.dl, onclick: () => take(r, 'work'),
          title: r.dl ? 'Скачать сам ассет (модель, картинку, текстуру): Claude поставит его в черновик, реализатор — в ролик' : r.note || 'скачать нельзя' }, busy(r, 'work') ? '⏳' : '⬇ В работу'),
        ['polypizza', 'quaternius', 'kenney'].includes(r.src) && h('button.small', { title: 'Покрутить модель в 3D', onclick: () => Plan.viewModel(r.title, r.thumb.replace(/\.[a-z]+$/i, '.glb')) }, '🧊'),
        r.page && h('a.btn.small', { href: r.page, target: '_blank', rel: 'noopener', title: 'Страница ассета: лицензия, автор' }, '↗')));
    const fetching = Object.values(Claude.jobs).filter(j => j.status === 'running' && j.key === key && (j.scope || '').startsWith(`assetfetch:${e.id}:work:`)).length;
    return h('section.card.assetcard',
      h('div.card-head', h('h3', '📦 Бесплатные ассеты'), h('span.sp'),
        h('button', { onclick: () => uploadModel(key, e.id), title: 'Своя 3D-модель (нашёл где-то): glb, gltf, fbx, obj, stl, usdz, blend или zip — Blender перегонит в glb и найдёт скелет и анимации' }, '⬆ своя модель'),
        Claude.btn({ label: picks.length ? 'Подобрать ещё' : 'Подобрать', action: 'assets', key, scope: 'assets:' + e.id, params: { el: e.id },
          title: 'Claude поищет по бесплатным каталогам (Poly Pizza, Poly Haven, Sketchfab, Openverse, Commons, ambientCG…) и предложит 3–6 ассетов с объяснением. 1–3 минуты.' })),
      h('label', 'Что нужно', h('span.dim', ' — Claude учтёт, когда будет подбирать')),
      area(key, ['elements', e.id, 'aask'], { cls: 'box', ph: '«советский лифт с раздвижными дверями», «только текстура кафеля», «low-poly, без фотореализма»…' }),
      Claude.running(key, 'assets:' + e.id) && h('p.dim.small', 'Claude ищет по каталогам и выбирает — обычно 1–3 минуты.'),
      picks.length > 0 && [h('h4.sub', '✨ Claude предлагает', h('span.dim.small', ' — ⬇ можно брать в ролик, 📌 только как образец')),
        h('div.agrid', picks.map(p => card(p, p)))],
      list.length > 0 && [h('h4.sub', '⬇ В работе', h('span.dim.small', three ? ' — Claude поставит их в сцену' : ' — Claude возьмёт их, когда будет рисовать')),
        h('div.alist', list.map(a => h('div.arow',
          a.preview ? h('img', { src: '/' + a.preview, alt: '', title: 'Крупно', onclick: () => UI.lightbox('/' + a.preview) }) : h('span.aph', a.kind === '3d' ? '🧊' : '🖼'),
          h('div.grow',
            h('div.row', h('b.clamp1', { title: a.title }, a.title || '(без названия)'), h('span.sp'),
              isModel(a) && h('button.icon', { title: 'Посмотреть модель в 3D', onclick: () => Plan.viewModel(a.title, '/' + a.main) }, '🧊'),
              h('button.icon.del', { title: 'Убрать из работы (файлы останутся в _ideas)', onclick: () => Store.del(key, P, a.id) }, '×')),
            h('div.dim.small', [ASSET_KIND[a.kind], (a.fmt || '').toUpperCase(), ASSET_SRC[a.src] || a.src, a.license, a.author].filter(Boolean).join(' · '),
              a.page && [' · ', h('a', { href: a.page, target: '_blank', rel: 'noopener' }, 'страница')]),
            a.kind === '3d' && (a.rigged || (a.anims || []).length) && h('div.small.ok-t', (a.rigged ? `🦴 скелет (${a.bones || '?'} костей)` : '') + ((a.anims || []).length ? ` · 🎬 анимации: ${a.anims.slice(0, 6).join(', ')}` : '')),
            e.kind === 'char' && a.kind === '3d' && h('button.small.primary', { disabled: !!Claude.running(key, 'charmodel:' + e.id), onclick: () => charModel(key, e.id, 'asset', a.id),
              title: 'Сделать из этой модели героя: готовый скелет подстроится под позы студии, нет скелета — встанет авто-скелет; клипы модели станут клипами' }, '🦴 Сделать героем'),
            a.attr && h('div.awarn', 'лицензия просит подписать автора — реализатор внесёт в «Права»'),
            a.note && h('div.awarn', '⚠ ' + a.note),
            line(key, [...P, a.id, 'why'], { cls: 'box', ph: 'что взять: «только форму», «как есть, но серым»… можно @' })))))],
      fetching > 0 && h('p.dim.small', h('span.spin'), ` качаю: ${fetching}…`),
      h('h4.sub', '🔎 Найти самому'),
      h('div.row', q, h('button', { onclick: () => search(), disabled: !!S.busy }, S.busy ? '⏳ ищу…' : '🔎 Искать')),
      h('div.row', h('div.seg.aseg', { role: 'group', 'aria-label': 'Что искать' }, [['3d', '🧊 3D'], ['2d', '🖼 2D'], ['tex', '🧱 Текстуры']].map(([k, l]) =>
        h('button', { class: kind === k ? 'sel' : '', 'aria-pressed': kind === k ? 'true' : 'false', onclick: () => search(k) }, l)))),
      h('p.dim.small', ASSET_WHERE[kind]),
      S.hint && h('p.warnline', '💡 ' + S.hint),
      (S.errs || []).length > 0 && h('p.dim.small', '⚠ ' + S.errs.join('; ')),
      S.list && !S.busy && !S.list.length && h('p.dim.small', 'Ничего не нашлось — попробуй другие слова по-английски.'),
      (S.list || []).length > 0 && [h('h4.sub', '🔎 Найдено'), h('div.agrid', S.list.map(r => card(r)))],
      !S.list && !list.length && !picks.length && h('p.dim.small', three ? 'Найди мебель, технику, машины — модель встанет в диораму как есть, в матовом бумажном виде. Или возьми превью как референс.'
        : 'Найди фото или рисунок — в референсы (Claude перерисует в нашем стиле) или в работу (вклеится вырезкой).'));
  },

  // 🔊 sound: Claude picks and downloads candidates; or search yourself (library, Freesound, Commons); or any link (YouTube via yt-dlp)
  elSound(d, key, e) {
    const ss = e.sounds || [], S = Plan.sres[e.id] || {};
    if (e.mix == null && e.sound) Store.set(key, ['elements', e.id, 'mix'], [{ id: uid('l'), sid: e.sound, at: 0, gain: 1, note: '' }]);   // old plans: one chosen sound -> one layer
    const q = draftInput(key + '|sq|' + e.id, { class: 'box grow', value: S.q ?? e.q ?? '', placeholder: 'по-английски: elevator door, fluorescent hum…',
      'aria-label': 'Поиск звука', onkeydown: ev => { if (ev.key === 'Enter' && !ev.isComposing) search(); } });
    const search = async () => {
      const v = q.value.trim();
      if (!v) return;
      Plan.sres[e.id] = { q: v, busy: true, list: S.list || [] }; App.render();
      try { const r = await api('GET', '/api/sound/search?q=' + encodeURIComponent(v) + '&n=8'); Plan.sres[e.id] = { q: v, list: r.results || [], errs: r.errors || [] }; }
      catch (err) { Plan.sres[e.id] = { q: v, list: [], errs: [err.message] }; }
      App.render();
    };
    const take = (url, start, end) => Claude.run({ action: 'sndfetch', key, scope: `sndfetch:${e.id}:${url}`, params: { key, el: e.id, url, start, end } });
    const u = draftInput(key + '|su|' + e.id, { class: 'box grow', placeholder: 'ссылка: YouTube, Freesound, прямой .mp3 / .wav, любая страница со звуком', 'aria-label': 'Ссылка на звук' });
    const st = draftInput(key + '|ss|' + e.id, { class: 'box', placeholder: 'с, сек', 'aria-label': 'С какой секунды', style: { width: '74px' } });
    const en = draftInput(key + '|se|' + e.id, { class: 'box', placeholder: 'по, сек', 'aria-label': 'По какую секунду', style: { width: '74px' } });
    const fetching = Object.values(Claude.jobs).filter(j => j.status === 'running' && j.key === key && (j.scope || '').startsWith(`sndfetch:${e.id}:`)).length;
    return [
      h('div.card-head', h('h3', '🔊 Звук'), h('span.sp'),
        Claude.btn({ label: ss.length ? 'Подобрать ещё' : 'Подобрать звук', action: 'sound', key, scope: 'sound:' + e.id, params: { el: e.id },
          title: 'Claude поищет в библиотеке, на Freesound, Commons и в интернете и скачает 3–5 кандидатов (1–3 минуты)' })),
      Plan.mixBox(d, key, e),
      h('label', 'Какой нужен / что не так', h('span.dim', ' — Claude учтёт в следующем подборе')),
      area(key, ['elements', e.id, 'ask'], { cls: 'box', ph: '«глуше и дальше», «без писка», «не хватает лязга решётки поверх @[Гул лифта]»…' }),
      h('h4.sub', '🎧 Кандидаты', h('span.dim.small', ' — ✓ кладёт звук в ролик; несколько ✓ — микс из слоёв')),
      ss.length ? h('div.sndlist', ss.map(s => Plan.sndRow(d, key, e, s))) : h('p.dim', 'Кандидатов пока нет: ✨ Подобрать, поиск или ссылка ниже.'),
      fetching > 0 && h('p.dim.small', h('span.spin'), ` качаю: ${fetching}…`),
      h('h4.sub', '🔎 Найти самому'),
      h('div.row', q, h('button', { onclick: search, disabled: !!S.busy }, S.busy ? '⏳ ищу…' : '🔎 Искать'), h('span.dim.small', 'библиотека пайплайна · Freesound · Commons')),
      (S.errs || []).length > 0 && h('p.dim.small', '⚠ ' + S.errs.join('; ')),
      S.list && !S.busy && !S.list.length && h('p.dim.small', 'Ничего не нашлось — попробуй другие слова по-английски.'),
      (S.list || []).length > 0 && h('div.sres', S.list.map(r => {
        const got = ss.some(s => s.url === r.url), busy = Claude.running(key, `sndfetch:${e.id}:${r.url}`);
        return h('div.sresrow',
          h('span.srcb', { class: r.src }, { lib: 'библиотека', freesound: 'Freesound', commons: 'Commons' }[r.src] || r.src),
          h('div.grow', h('b', r.title),
            h('div.dim.small', [r.dur ? (+r.dur).toFixed(1) + ' с' : '', r.license, r.author].filter(Boolean).join(' · '),
              r.page && [' · ', h('a', { href: r.page, target: '_blank', rel: 'noopener' }, 'страница')]),
            r.tags && h('div.dim.small.clamp1', r.tags)),
          h('audio', { controls: true, preload: 'none', src: sndSrc(r.url) }),
          got ? h('span.ok-t.small', '✓ взят') : h('button', { disabled: !!busy, onclick: () => take(r.url) }, busy ? '⏳' : '⬇ Взять'));
      })),
      h('h4.sub', '⬇ По ссылке'),
      h('div.row', u, st, en, h('button.primary', { onclick: () => {
        const v = u.value.trim();
        if (!v) return UI.toast('Вставь ссылку', 'err');
        take(v, st.value.trim() || null, en.value.trim() || null); u.value = ''; delete Drafts[key + '|su|' + e.id];
      } }, '⬇ Скачать')),
      h('p.dim.small', 'YouTube и другие видеосайты качаются через yt-dlp; «с / по» — вырезать кусок в секундах. Всё сохраняется в wav; выбранный звук при создании проекта ляжет в assets/sfx/.'),
    ];
  },

  // the mix is e.mix (layers); e.sound mirrors its first layer for old readers
  setMix(key, e, list) {
    Store.set(key, ['elements', e.id, 'mix'], list.map(({ s, ...m }) => m));
    Store.set(key, ['elements', e.id, 'sound'], list.length ? list[0].sid : '', true);
  },
  mixBox(d, key, e) {
    const mix = elMix(e), P = ['elements', e.id, 'mix'], playing = Plan.mixPlay && Plan.mixPlay.el === e.id;
    if (!mix.length) return h('p.warnline', 'В ролике пока нет звука: отметь ✓ у кандидата ниже (можно несколько — получится микс).');
    return h('div.mixbox',
      h('div.row', h('b', mix.length > 1 ? `🎚 В ролике — микс из ${mix.length} слоёв` : '🎚 В ролике'), h('span.sp'),
        mix.length > 1 && h('button', { class: playing ? 'sel' : '', onclick: () => Plan.playMix(e) }, playing ? '⏹ Стоп' : '▶ Слушать вместе')),
      mix.map((m, i) => h('div.mixrow',
        h('span.fnum', i + 1),
        h('div.grow', h('div.clamp1', h('b', m.s.title || '(без названия)'), h('span.dim.small', ` · ${m.s.dur} с`)),
          line(key, [...P, m.id, 'note'], { cls: 'box', ph: mix.length > 1 ? 'что это и куда: «лязг на открытии дверей», «фон под всей сценой»… можно @' : 'что это и куда (необязательно), можно @' })),
        h('label.mixnum', { title: 'Сдвиг от начала звука, секунды' }, 'с', h('input.box', { type: 'number', step: '0.1', min: '0', key: key + '|mixat|' + m.id, value: m.at,
          oninput: ev => Store.set(key, [...P, m.id, 'at'], +ev.target.value || 0) }), 'сек'),
        h('label.mixnum', { title: 'Громкость слоя' }, h('input.box', { type: 'number', step: '10', min: '0', max: '200', key: key + '|mixg|' + m.id, value: Math.round(m.gain * 100),
          oninput: ev => Store.set(key, [...P, m.id, 'gain'], Math.max(0, +ev.target.value || 0) / 100) }), '%'),
        h('button.icon', { title: 'Выше', disabled: i === 0, onclick: () => { const l = mix.slice(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; Plan.setMix(key, e, l); } }, '↑'),
        h('button.icon.del', { title: 'Убрать из ролика (кандидат останется)', onclick: () => Plan.setMix(key, e, mix.filter(x => x !== m)) }, '×'))),
      mix.length > 1 && [h('label', 'Как свести', h('span.dim', ' — порядок, что громче, где тишина; реализатор прочитает это вместе со слоями')),
        area(key, ['elements', e.id, 'mixNote'], { cls: 'box', ph: '«сначала лязг, через полсекунды гул; гул тише и тянется под всей сценой @[Лифт]»' })]);
  },
  // ▶ the layers together, the way audio.py mixes file: sounds (each peak-normalised × its volume, at its offset)
  async playMix(e) {
    const P = Plan.mixPlay;
    if (P) { Plan.mixPlay = null; try { P.ctx.close(); } catch {} App.render(); if (P.el === e.id) return; }
    const ctx = new AudioContext(), comp = ctx.createDynamicsCompressor(), mix = elMix(e);
    comp.connect(ctx.destination);
    Plan.mixPlay = { el: e.id, ctx }; App.render();
    try {
      const bufs = await Promise.all(mix.map(m => fetch('/' + m.s.file).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))));
      let end = 0;
      bufs.forEach((b, i) => {
        let peak = 1e-6;
        for (let c = 0; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let k = 0; k < x.length; k += 7) peak = Math.max(peak, Math.abs(x[k])); }
        const g = ctx.createGain(), src = ctx.createBufferSource();
        g.gain.value = 0.9 / peak * mix[i].gain * 0.7;
        src.buffer = b; src.connect(g).connect(comp); src.start(ctx.currentTime + 0.05 + mix[i].at);
        end = Math.max(end, mix[i].at + b.duration);
      });
      setTimeout(() => { if (Plan.mixPlay && Plan.mixPlay.ctx === ctx) { Plan.mixPlay = null; ctx.close(); App.render(); } }, (end + 0.4) * 1000);
    } catch (err) { UI.toast('Не проигралось: ' + err.message, 'err'); Plan.mixPlay = null; ctx.close(); App.render(); }
  },

  sndRow(d, key, e, s) {
    const mix = elMix(e), n = mix.findIndex(m => m.sid === s.id), on = n >= 0;
    return h('div.sndrow', { class: on ? 'on' : '' },
      h('button.tgl.pick', { class: on ? 'on' : '', title: on ? `В ролике (слой ${n + 1}) — клик, чтобы убрать` : 'Взять в ролик (ещё один слой, если уже что-то выбрано)',
        onclick: () => Plan.setMix(key, e, on ? mix.filter(m => m.sid !== s.id) : [...mix, { id: uid('l'), sid: s.id, at: 0, gain: 1, note: '', s }]) }, on && mix.length > 1 ? n + 1 : '✓'),
      h('div.grow', h('b', s.title || '(без названия)'), s.by === 'claude' && h('span.by', ' 🤖'),
        h('div.dim.small', [s.dur != null ? s.dur + ' с' : '', s.peak_t != null ? 'пик ' + s.peak_t + ' с' : '', s.src, s.license, s.author].filter(Boolean).join(' · '),
          (s.start != null || s.end != null) && ` · кусок ${s.start ?? 0}–${s.end ?? '…'} с`,
          s.page && [' · ', h('a', { href: s.page, target: '_blank', rel: 'noopener' }, 'источник')]),
        s.why && h('div.dim.small', '💬 ' + s.why)),
      h('audio', { controls: true, preload: 'metadata', src: '/' + s.file }),
      h('button.icon.del', { title: 'Убрать кандидата', onclick: () => {
        if (on) Plan.setMix(key, e, mix.filter(m => m.sid !== s.id));
        Store.del(key, ['elements', e.id, 'sounds'], s.id);
      } }, '×'));
  },
});
