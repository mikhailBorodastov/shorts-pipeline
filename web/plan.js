// «Штурм идей» — the planner of one video. Brainstorm (flow storm): Идеи → Биты → Название → Образы → Превью → Структура → В работу → Итоги.
// Видео Claude Studio (flow idea): Идея → Вопросы → Название → Препродакшен → Сцены → Сценарий → Голос → Монтаж → Ревью → Упаковка (idea.js, studio.js).
'use strict';

const HINTS = {
  ideas: `<p><b>Шаг 1.</b> Накидай минимум 10 идей: чем больше кандидатов, тем сильнее победитель. Откуда брать: из головы («всегда хотелось рассказать о…», «а прикольно было бы сделать…»), из чужих выстреливших роликов («а как бы это сделал я?»), из свежих новостей — включи 🌐, и Claude поищет их сам.</p>
<p><b>Шаг 2.</b> Отметь ★ три лучшие. Правило трёх: один вариант — не выбор, а ловушка; два — дилемма, которая легко оказывается ложной; настоящий выбор начинается с трёх.</p>
<p><b>Шаг 3.</b> Выбери ● одну — её и развиваем. Остальные не выкидывай: «📤 Остальные — в банк». Названия пока не придумывай: сначала пойми, что будет в ролике (вкладка «Биты»).</p>`,
  beats: M => `<p><b>Бит</b> — единица смысла ролика, пара из двух половин. <b>Вопрос / сетап</b> вызывает ожидание: «что будет, если надеть на кота камеру?». <b>Ответ / панчлайн</b> даёт реакцию: «коты нашли 407 потерявшихся котов».</p>
<p>Выпиши всё, что хочешь сказать, показать или проверить. Можно пока только половину — вторую допишешь перед сценарием. Не уверен, вопрос это или ответ, — пиши в любую колонку и потом ⇄ поменяй. Бывает, что ответ сильнее работает как сетап: попробуй поменять половины местами.</p>
<p><b>Сколько:</b> ${M === REF.modes.long ? 'для видео на 8–15 минут собери 30–40, оставь 20–30: на бит выйдет 20–40 секунд' : 'для шортса собери 15–25, оставь 6–10: на бит выйдет 5–10 секунд'}. Чем больше отсеешь (✓ снять), тем плотнее ролик. Но режь бит целиком: вопрос без ответа зритель запомнит как «непонятно».</p>`,
  beatsStory: `<p><b>🎭 Сюжет:</b> биты — это сцены и детали. Сетап — ситуация или действие ёжика, от которого ждёшь «что сейчас будет?» («он нажимает кнопку без цифры»), панчлайн — что происходит на самом деле («двери открываются в тот же коридор, но без людей»). Узнаваемые детали мира тоже биты: «что гудит в потолке?» → «лампа дневного света». Факты и цифры не нужны. Накидай 2–3 разных финала, выберешь на «Структуре».</p>`,
  title: `<p><b>Шаг 1.</b> Ответь на 7 вопросов коротко, но по сути — это топливо для названия.</p>
<p><b>Шаг 2.</b> Выпиши смыслы — единицы, которые раскрывают суть ролика. Принцип пещерного человека: самые простые слова, понятные первокласснику. Не «энергопотребление вычислительных центров», а «ИИ, СВЕТ, СЧЁТ». Клик по смыслу: <b>●</b> «без этого вообще никак» → <b>✕</b> вычеркнуть (не про суть или создаёт ложное впечатление) → обычный.</p>
<p><b>Шаг 3.</b> В центре круга — то, что хочешь сказать роликом. Сформулируй название через каждый из четырёх углов, минимум по 3 на угол, из смыслов «без этого никак». Усиливай сильными словами: 💪 у названия или группы над кругом.</p>
<p><b>Шаг 4.</b> Отметь ★ три самых сильных названия, желательно совсем разных. Их проверим превью.</p>`,
  images: `<p>Превью должно объяснять ролик без слов, а для этого нужны образы. <b>Образ</b> — картинка, которая передаёт смысл мгновенно: слышишь «ёжик в тумане» — и уже видишь его. Это предмет, человек, символ или сцена.</p>
<p>По три <b>разных</b> образа на смысл, а не три фотки одного и того же. Ищи узнаваемое: логотипы, кадры, игровые спрайты, вещи эпохи, мемы — у нас они станут бумажными вырезками. Картинку можно вставить прямо в ячейку (Ctrl+V).</p>`,
  thumbs: `<p>На каждое название-финалист — один концепт превью (переключатель сверху). Нарисуй схематично ✏️ или вставь референс. Не зашёл — доводи правками или попроси «ещё вариант».</p>
<p><b>Задачи превью:</b> привлечь внимание, заинтересовать, показать, что зритель получит, и что это наш ролик. <b>1 образ — победа, 3 — хорошо, больше 7</b> — что-то пошло не так ещё на прошлых шагах.</p>
<p>Текста — минимум, и он <b>не повторяет название</b>: текст читают сознательно и медленно, картинку считывают сразу. Числа, суммы и «СТОП!» — уже образы. <b>Не делай ребус</b>: если смысл надо собирать из отдельных картинок, это провал.</p>
<p>Выбери 🏆 связку с самым сильным превью — под это название и пишем сценарий. Потом загляни в «Биты»: новые мысли, пришедшие с превью, добавь туда.</p>`,
  thumbsS: `<p>У шортса два «превью», и задачи у них разные. <b>🖼 Обложка 9:16</b> — полка шортсов, рекомендации, страница канала и поиск: статичная картинка, которую считывают в маленьком размере. <b>🎬 Первый кадр + хук</b> — лента: зритель уже смотрит ролик и за секунду решает, остаться или пролистнуть.</p>
<p>На каждое название-финалист придумай одну связку (не зашла — доводи правками или попроси «ещё вариант»): обложка, первый кадр и хук (первая фраза на 10–15 слов). Правила для обеих картинок: 1–3 образа, без ребуса; текст на обложке — 2–4 слова или число и не повторяет название. Лучше всего работают типы из «золотого грааля». Для нашего ёжика это «предмет и реакция»: ёжик реагирует на саму вещь из истории.</p>
<p>Выбери 🏆 связку с самыми сильными обложкой и первым кадром. Новые мысли, которые пришли по ходу, добавь в «Биты».</p>`,
  structS: `<p>Разложи оставленные биты по схеме: перетащи бит в блок или выбери его в списке. Начни с хука и сразу подбери ему пару в коде: они должны перекликаться словом или цифрой. Потом поставь главный поворот. Смена мысли — каждые 5–10 секунд. Схемы — из нашего стайл-гайда.</p>`,
  structL: `<p>Три акта нужны не всегда: видео до 20 минут можно строить как <b>инструкцию</b> — биты шаг за шагом от названия к выводу. Но открывающий образ нужен всегда: он удерживает зрителя. А кульминация и завершающий образ заставляют захотеть следующее видео.</p>
<p>Порядок работы: открывающий образ → сразу парный ему завершающий → кульминация → остальное. У слота отметь, что в нём: сетап (вопрос) или панчлайн (ответ).</p>`,
  titleIdea: `<p><b>Название</b> — через четыре угла атаки (число или сумма, сильный образ или эмоция, время или срочность, отрицание или противоречие), по 3 на угол; Claude берёт их из идеи, контекста и твоих ответов. Усиливай сильными словами (💪).</p>
<p>Отметь ★ одного–трёх <b>финалистов</b>: под них — препродакшен, а в конце упаковка (обложка, описания).</p>`,
  prod: `<p>Перед запуском проверь: биты развёрнуты в пары «вопрос → ответ», новые идеи с превью добавлены в биты, выбрана связка «название + превью», есть открывающий и завершающий образ.</p>
<p><b>🚀 Создать проект</b> заведёт папку проекта (как new.bat) и положит в неё весь штурм — <code>refs/штурм.md</code> и эскизы. Потом напиши Claude фразу из зелёной плашки: сценарий будет строиться по этому штурму.</p>`,
  results: `<p><b>Работу над ошибками</b> делай до публикации или сразу после, пока цифр ещё нет: без неё легко застрять и повторять одни и те же промахи. На вопрос «офигенно получилось?» ответь до цифр — потом сравним с реальностью.</p>
<p><b>Реакцию аудитории</b> — после выхода. Кто-то всегда будет недоволен, и чаще всего дело не в ролике. <b>Просмотры</b> заполняй по мере прихода данных: час, сутки, 7, 14 и 28 дней.</p>`,
};

const Drag = { beat: null, from: null };
const BAD_NAME = /[\\/:*?"<>|]/g;
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const beatLabel = b => { const t = (b.q || '') + (b.a ? ' → ' + b.a : ''); return t.length > 72 ? t.slice(0, 70) + '…' : t || '(пустой бит)'; };
const zoneOf = t => REF.thumbZones.find(z => z.types.includes(t));
const isIdea = d => d.flow === 'idea';
const tabsOf = d => REF.flows[isIdea(d) ? 'idea' : 'storm'];
const chosenOf = d => (isIdea(d) ? ((d.idea || '').trim() ? { id: '', text: d.idea.trim() } : null) : (d.ideas || []).find(i => i.id === d.chosen));
const wordsOf = s => (s || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{3,}/g) || [];
function dupTitle(text, title) {                      // cover text repeats the title (rough stem match)
  const a = wordsOf(text);
  if (a.length < 2) return false;
  const b = new Set(wordsOf(title).map(w => w.slice(0, 5)));
  return a.filter(w => b.has(w.slice(0, 5))).length / a.length >= 0.6;
}

function progress(d) {
  const M = REF.modes[d.mode] || REF.modes.short;
  const ideas = d.ideas || [], beats = d.beats || [], titles = d.titles || [];
  const kept = beats.filter(b => b.keep !== false).length;
  const need = (d.meanings || []).filter(m => m.mark !== 'cut').length * 3;
  const filled = (d.images || []).filter(g => g.text || g.img).length;
  const slots = Object.values((d.structure || {}).slots || {}).filter(v => v && v.length).length;
  const qa = d.qa || [], answered = qa.filter(q => (q.a || '').trim() || q.skip).length;
  const els = (d.elements || []).filter(e => e.status !== 'drop'), ready = els.filter(e => e.status === 'ok').length;
  return {
    idea: { t: (d.refs || []).length ? `реф. ${(d.refs || []).length}` : '', ok: !!(d.idea || '').trim() },
    qa: isIdea(d) ? { t: qa.length ? `${answered}/${qa.length}` : '', ok: qa.length > 0 && answered === qa.length } : { t: qa.length ? `${answered}/${qa.length} · биты ${kept}` : '', ok: answered >= Math.min(10, qa.length || 10) && kept >= M.keep[0] },
    pre: { t: els.length ? `${ready}/${els.length}` : '', ok: els.length > 0 && ready === els.length },
    ideas: { t: `${ideas.length} · ★${ideas.filter(i => i.star).length}`, ok: !!d.chosen },
    beats: { t: `${kept}/${beats.length}`, ok: kept >= M.keep[0] },
    title: { t: `${titles.length} · ★${titles.filter(t => t.star).length}`, ok: titles.filter(t => t.star).length >= (isIdea(d) ? 1 : 3) },
    images: { t: need ? `${Math.min(filled, need)}/${need}` : '', ok: need > 0 && filled >= need },
    thumbs: { t: `${(d.thumbs || []).length}${d.final && d.final.thumb ? ' · 🏆' : ''}`, ok: !!(d.final && d.final.thumb) },
    structure: { t: slots ? String(slots) : '', ok: slots >= 3 },
    prod: { t: d.project ? '✓' : '', ok: !!d.project },
    results: { t: d.status === 'out' ? '✓' : '', ok: d.status === 'out' },
  };
}

function ideaBanner(d) {
  const c = chosenOf(d), t = isIdea(d) ? 'idea' : 'ideas';
  if (isIdea(d)) return c ? h('div.banner', h('b', '💡 Идея:'), h('span.grow', c.text), h('a', { href: `#/p/${d.id}/idea` }, 'править'))
    : h('div.banner', h('span.counter.warn', '💡 Идея ещё не записана.'), h('a', { href: `#/p/${d.id}/idea` }, 'Запиши её на вкладке «Идея»'));
  return c ? h('div.banner', h('b', '● Развиваем:'), h('span.grow', c.text), h('a', { href: `#/p/${d.id}/${t}` }, 'сменить'))
    : h('div.banner', h('span.counter.warn', '● Идея ещё не выбрана.'), h('a', { href: `#/p/${d.id}/${t}` }, 'Выбери её на вкладке «Идеи»'), h('span.dim', '— Claude будет опираться на вводные.'));
}

// edits on a drawn picture: {text, pins: [{id, x, y, text}]}, x/y — share of width/height
const fxCount = e => (e && e.pins ? e.pins.length : 0) + (e && e.pins3d ? e.pins3d.length : 0) + (e && (e.text || '').trim() ? 1 : 0) + ((e && e.notes) || []).filter(n => (n.text || '').trim()).length;

// «В целом» as a stack of separate edits (fx.<part>.notes[]): Enter in an item adds the next one, Backspace in an empty one removes it.
// redraw — for a modal that App.render does not repaint (the cover edits); the page re-renders itself otherwise.
function noteList(key, P, ph, redraw) {
  const part = getPath(Store.get(key), P) || {}, notes = part.notes || [];
  const kOf = id => key + '|' + [...P, 'notes', id, 'text'].join('.'), addKey = key + '|addnote|' + P.join('.');
  const focusKey = k => { const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`); if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); } };   // the DOM is already repainted
  const repaint = () => (redraw ? redraw() : App.render());
  const add = (at, text = '', focus = true) => {
    const id = uid('n');
    Store.op(key, { op: 'add', path: [...P, 'notes'], item: { id, text }, at }, false);
    repaint(); focusKey(focus ? kOf(id) : addKey);
  };
  return h('div.notelist',
    (part.text || '').trim() && h('div.noterow', h('span.nnum', '•'), area(key, [...P, 'text'], { cls: 'box' })),   // the old single field, kept while it has text
    notes.map((n, i) => {
      const inp = line(key, [...P, 'notes', n.id, 'text'], { cls: 'box', ph: 'правка — Enter: следующая' });
      inp.setAttribute('aria-label', `Правка в целом ${i + 1}`);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); add(i + 1); }
        else if (ev.key === 'Backspace' && !inp.value) {
          ev.preventDefault();
          Store.del(key, [...P, 'notes'], n.id, false); repaint();
          focusKey(i > 0 ? kOf(notes[i - 1].id) : addKey);
        }
      });
      return h('div.noterow', h('span.nnum', i + 1), inp,
        h('button.icon.del', { title: 'Убрать правку', onclick: () => { Store.del(key, [...P, 'notes'], n.id, false); repaint(); } }, '×'));
    }),
    addLine(ph + ' — Enter (каждая правка — отдельным пунктом, можно @)', t => add(notes.length, t, false), addKey));
}
const pinMarks = e => ((e && e.pins) || []).map((p, i) => h('span.pin', { style: { left: p.x * 100 + '%', top: p.y * 100 + '%' }, title: p.text || '' }, i + 1));

const Plan = {
  extra: {},                                          // meaning id -> number of image cells the user opened with «+ образ»
  view(d, tab, sub) {
    const key = 'plan:' + d.id, M = REF.modes[d.mode] || REF.modes.short, tabs = tabsOf(d);
    if (!tabs.some(t => t.key === tab)) tab = tabs.some(t => t.key === d.stage) ? d.stage : tabs[0].key;
    if (isIdea(d) && d.stage !== tab) setTimeout(() => Store.set(key, ['stage'], tab), 0);     // the last opened stage (the project screen shows it)
    return h('div.plan', this.head(d, key, M), this.tabbar(d, tab, M), h('div.tabbody', this[tab](d, key, M, sub)));
  },

  head(d, key, M) {
    const to = d.mode === 'short' ? 'long' : 'short';
    return h('div.phead',
      h('span.mode', { class: d.mode }, M.icon + ' ' + M.label),
      h('input.name', { key: key + '|name', value: d.name, placeholder: 'Рабочее название', oninput: e => Store.set(key, ['name'], e.target.value) }),
      !isIdea(d) && sel(REF.genres.map(g => ({ value: g.key, label: g.label })), d.genre || 'news', v => {
        Store.set(key, ['genre'], v);
        if (d.mode !== 'long') Store.set(key, ['structure', 'scheme'], v === 'story' ? 'S' : v === 'history' ? 'A' : 'V');
        App.render();
      }, { class: 'box', title: 'Жанр: от него зависят биты, хук, структура и все кнопки ✨' }),
      sel([{ value: 'draft', label: '💡 черновик' }, { value: 'prod', label: '🛠 в работе' }, { value: 'out', label: '✅ вышло' }, { value: 'archived', label: '📦 архив' }],
        d.status, v => Store.set(key, ['status'], v, true), { class: 'box', title: 'Статус видео' }),
      h('label.row', { title: 'Claude ищет свежие новости и проверяет факты в интернете (дольше: 1–3 минуты)' },
        h('input', { type: 'checkbox', checked: !!d.web, onchange: e => Store.set(key, ['web'], e.target.checked, true) }), '🌐 Claude ищет в интернете'),
      h('button.icon', { title: `Сделать ${to === 'long' ? 'длинным видео' : 'шортсом'}`, onclick: () => {
        if (!confirm(`Сделать этот штурм ${to === 'long' ? 'длинным видео' : 'шортсом'}? Всё заполненное останется.`)) return;
        Store.set(key, ['mode'], to); Store.set(key, ['structure', 'scheme'], to === 'long' ? 'acts' : 'V', true);
      } }, '⇄'),
      false && h('button', { title: 'Перевести на путь «Есть идея»: выбранная идея станет идеей, появятся вопросы Claude и препродакшен (сцены, персонажи, пропсы, звуки). Образы и структура останутся в файле штурма.',
        onclick: () => {
          if (!confirm('Перевести штурм на путь «Есть идея»? Выбранная идея станет идеей ролика, биты, название и обложки останутся. Вкладки «Идеи», «Образы» и «Структура» скроются (данные сохранятся).')) return;
          const c = (d.ideas || []).find(i => i.id === d.chosen);
          if (!(d.idea || '').trim() && c) Store.set(key, ['idea'], c.text);
          for (const [k, v] of [['refs', []], ['qa', []], ['elements', []], ['engine', '2d']]) if (d[k] == null) Store.set(key, [k], v);
          Store.set(key, ['flow'], 'idea', true);
          go(`#/p/${d.id}/pre`);
        } }, '🎬 → препродакшен'),
      h('button', { title: 'Очистить видео и начать заново — тот же ролик, новый концепт', onclick: () => Plan.restart(d) }, '🧹 Начать заново'),
      (d.backups || []).length > 0 && h('button', { title: 'Вернуть штурм, каким он был до очистки', onclick: () => Plan.versions(d) }, '↶ Прошлые версии'),
      h('button.icon.del', { title: 'Убрать видео в архив (папка уйдёт в _archive/videos, ничего не удаляется)', onclick: () => Plan.remove(d) }, '🗑'));
  },

  tabbar(d, tab, M) {
    const P = progress(d);
    return h('div.tabs', tabsOf(d).map(t => h('a', { class: t.key === tab ? 'on' : '', href: `#/p/${d.id}/${t.key}` },
      t.icon, ' ', t.key === 'thumbs' ? M.thumbTab : t.label, P[t.key] && P[t.key].t && h('span.tb', { class: P[t.key].ok ? 'ok' : '' }, P[t.key].t),
      dot(t.key !== tab && Unread.has(d.id, t.key)))));
  },

  // «Начать заново»: pick what to clear, see exactly what goes, backup first, then clear
  restart(d) {
    const key = 'plan:' + d.id;
    const idea = isIdea(d);
    const parts = [
      idea && { k: 'qa', label: 'Вопросы и ответы, челлендж', n: (d.qa || []).length, word: ['вопрос', 'вопроса', 'вопросов'], clear: [['qa', []], ['challenge', null]] },
      !idea && { k: 'ideas', label: 'Идеи и выбранная идея', n: (d.ideas || []).length, word: ['идея', 'идеи', 'идей'], clear: [['ideas', []], ['chosen', '']] },
      { k: 'beats', label: 'Биты', n: (d.beats || []).length, word: ['бит', 'бита', 'битов'], clear: [['beats', []]] },
      { k: 'title', label: idea ? 'Название: смыслы, названия' : 'Название: 7 ответов, смыслы, названия', n: (d.titles || []).length + (d.meanings || []).length, word: ['пункт', 'пункта', 'пунктов'],
        clear: [['q7', {}], ['meanings', []], ['titles', []]] },
      idea && { k: 'pre', label: 'Препродакшен: сцены, персонажи, пропсы, звуки', n: (d.elements || []).length, word: ['элемент', 'элемента', 'элементов'], clear: [['elements', []]] },
      !idea && { k: 'images', label: 'Образы', n: (d.images || []).filter(g => g.text || g.img).length, word: ['образ', 'образа', 'образов'], clear: [['images', []]] },
      { k: 'thumbs', label: 'Превью / хук и обложка и выбранная связка', n: (d.thumbs || []).length, word: ['концепт', 'концепта', 'концептов'],
        clear: [['thumbs', []], ['final', { title: '', thumb: '' }]] },
      !idea && { k: 'structure', label: 'Структура', n: Object.values((d.structure || {}).slots || {}).filter(v => v && v.length).length, word: ['слот', 'слота', 'слотов'],
        clear: [['structure', { scheme: (d.structure || {}).scheme || (d.mode === 'long' ? 'acts' : 'V'), minutes: (d.structure || {}).minutes || 12, slots: {}, notes: {}, marks: {}, steps: [] }]] },
      idea ? { k: 'topic', label: 'Идея, контекст и референсы', n: ((d.idea || '').trim() ? 1 : 0) + ((d.topic || '').trim() ? 1 : 0) + (d.refs || []).length,
        word: ['поле', 'поля', 'полей'], clear: [['idea', ''], ['topic', ''], ['refs', []]], off: true }
        : { k: 'topic', label: 'Вводные', n: (d.topic || '').trim() ? 1 : 0, word: ['поле', 'поля', 'полей'], clear: [['topic', '']], off: true },
    ].filter(Boolean);
    const on = Object.fromEntries(parts.map(p => [p.k, !p.off && p.n > 0]));
    const sum = h('p');
    const go_ = h('button.primary', { onclick: async () => {
      const chosen = parts.filter(p => on[p.k]);
      if (!chosen.length) return;
      if (!confirm(`Точно очистить: ${chosen.map(p => p.label.toLowerCase()).join('; ')}?\nПеред этим сохраню копию — её можно вернуть кнопкой «↶ Прошлые версии».`)) return;
      try {
        await Store.flushAll();
        const r = await api('POST', '/api/backup', { key });
        Store.add(key, ['backups'], { id: uid('v'), file: r.file, ts: Date.now(), note: 'до «Начать заново»: ' + chosen.map(p => p.label.split(':')[0].toLowerCase()).join(', ') }, false);
        for (const p of chosen) for (const [path, val] of p.clear) Store.set(key, [path], clone(val));
        close(); go(`#/p/${d.id}/${idea ? (on.topic ? 'idea' : 'qa') : on.ideas ? 'ideas' : 'beats'}`); App.render();
        UI.toast('Штурм очищен, копия сохранена');
      } catch (e) { UI.toast(e.message, 'err'); }
    } }, '🧹 Очистить');
    const paint = () => {
      const chosen = parts.filter(p => on[p.k] && p.n);
      sum.replaceChildren(chosen.length ? 'Будет удалено: ' + chosen.map(p => `${p.n} ${plural(p.n, ...p.word)} (${p.label.split(':')[0].toLowerCase()})`).join(', ') + '.' : 'Ничего не выбрано.');
      go_.disabled = !parts.some(p => on[p.k]);
    };
    const close = UI.modal('🧹 Начать заново — тот же ролик', h('div',
      h('p.dim', 'Название штурма, формат, статус, проект и итоги останутся. Выбери, что стереть:'),
      h('div.pick', parts.map(p => h('label', h('input', { type: 'checkbox', checked: on[p.k], onchange: e => { on[p.k] = e.target.checked; paint(); } }),
        h('span.grow', p.label), h('span.dim', p.n ? `${p.n} ${plural(p.n, ...p.word)}` : 'пусто')))),
      sum,
      h('p.dim', 'Перед очисткой весь штурм сохранится в копию (_ideas/trash), вернуть — «↶ Прошлые версии».'),
      h('div.row', h('span.sp'), h('button', { onclick: () => close() }, 'Отмена'), go_)));
    paint();
  },

  versions(d) {
    const key = 'plan:' + d.id;
    const list = (d.backups || []).slice().reverse();
    const close = UI.modal('↶ Прошлые версии штурма', h('div',
      h('p.dim', 'Вернуть версию: текущее состояние тоже сохранится копией, так что можно передумать.'),
      h('div.pick', list.map(b => h('label', h('span.grow', h('b', new Date(b.ts).toLocaleString('ru-RU')), h('div.dim', b.note || '')),
        h('button', { onclick: async () => {
          if (!confirm('Вернуть штурм к этой версии? Всё, что сейчас в штурме, уйдёт в копию.')) return;
          try { await Store.flushAll(); await api('POST', '/api/restore', { key, file: b.file }); await Store.load(key, true); close(); App.render(); UI.toast('Версия возвращена'); }
          catch (e) { UI.toast(e.message, 'err'); }
        } }, 'Вернуть'))))));
  },

  async remove(d) {
    if (!confirm(`Убрать видео «${d.name}» в архив? Папка целиком уйдёт в _archive/videos — оттуда её можно вернуть вручную.`)) return;
    await Store.flushAll();
    try {
      await api('POST', '/api/delete', { key: 'plan:' + d.id }); delete Store.docs['plan:' + d.id]; await App.refreshState();
      if (App.route.page === 'home') App.render(); else go('#/');
    }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- 1. Идеи ----------------
  ideas(d, key) {
    const ideas = d.ideas || [], stars = ideas.filter(i => i.star).length;
    return [
      hint('ideas', HINTS.ideas),
      h('section.card', h('div.card-head', h('h3', 'Вводные'), h('span.dim', 'тема, новость, ссылки, мысли — Claude читает это поле')),
        area(key, ['topic'], { cls: 'big', ph: 'Например: Microsoft подала заявку на патент — игры за просмотр рекламы. Ссылка… Хочу показать обычный день геймера в 2030-м.' })),
      h('section.card',
        h('div.card-head', h('h3', 'Идеи'),
          h('span.counter', { class: ideas.length >= 10 ? 'ok' : '' }, `${ideas.length} из 10`),
          h('span.counter', { class: stars === 3 ? 'ok' : stars > 3 ? 'warn' : '' }, `★ ${stars} из 3`),
          h('span.counter', { class: d.chosen ? 'ok' : '' }, d.chosen ? '● выбрана' : '● не выбрана'),
          h('span.sp'),
          Claude.btn({ label: '10 идей', action: 'ideas', key, params: { n: 10 } }),
          h('button', { onclick: () => Plan.fromBank(d) }, '📥 Из банка'),
          h('button', { title: 'Все идеи, кроме выбранной, — в банк идей', onclick: () => Plan.toBank(d) }, '📤 Остальные — в банк')),
        ideas.length ? h('div.ideas', ideas.map((it, n) => Plan.ideaRow(d, key, it, n))) : h('div.empty', 'Пока пусто. Напиши свои идеи ниже или нажми ✨ 10 идей.'),
        addLine('+ идея — Enter', text => Store.add(key, ['ideas'], { id: uid('i'), text, why: '', star: false, by: 'me' }), key + '|addidea'),
        stars > 3 && h('p.counter.warn', 'Финалистов больше трёх — оставь сильнейшие.')),
    ];
  },

  ideaRow(d, key, it, n) {
    const chosen = d.chosen === it.id;
    return h('div.idea', { class: (chosen ? 'chosen ' : '') + (it.banked ? 'banked' : '') },
      h('span.no', n + 1),
      h('button.tgl.star', { class: it.star ? 'on' : '', title: 'Финалист: ★ три лучшие', onclick: () => Store.set(key, ['ideas', it.id, 'star'], !it.star, true) }, '★'),
      h('button.tgl.pick', { class: chosen ? 'on' : '', title: 'Развиваем эту идею', onclick: () => {
        Store.set(key, ['chosen'], chosen ? '' : it.id);
        if (!chosen && !it.star) Store.set(key, ['ideas', it.id, 'star'], true);
        App.render();
      } }, '●'),
      h('div.grow', area(key, ['ideas', it.id, 'text'], { ph: 'идея…' }),
        (it.why || it.src || it.date) && h('div.meta', it.why && h('span', it.why), it.src && /^https?:/.test(it.src) && h('a', { href: it.src, target: '_blank', rel: 'noopener' }, '🔗 источник'), it.date && h('span', it.date))),
      it.by === 'claude' && h('span.by', { title: 'Придумал Claude' }, '🤖'),
      h('button.icon', { title: it.banked ? 'Уже в банке идей' : 'Отправить в банк идей', disabled: !!it.banked, onclick: () => Plan.toBank(d, [it]) }, '📤'),
      h('button.icon.del', { title: 'Удалить', onclick: () => Store.del(key, ['ideas'], it.id) }, '×'));
  },

  toBank(d, list) {
    const key = 'plan:' + d.id;
    list = list || (d.ideas || []).filter(i => !i.banked && i.id !== d.chosen);
    if (!list.length) return UI.toast('Нечего отправлять — всё уже в банке');
    for (const i of list) {
      const bid = uid('k');
      Store.add('bank', ['items'], { id: bid, title: (i.text || '').slice(0, 200), desc: i.why || '', mode: d.mode, cool: i.star ? 2 : 1, speed: 2,
        fresh: i.date || '', src: i.src || '', status: 'new', by: i.by || 'me', created: Date.now(), from: d.id }, false);
      Store.set(key, ['ideas', i.id, 'banked'], bid);
    }
    App.render();
    UI.toast(`В банк идей: ${list.length}`);
  },

  fromBank(d) {
    const key = 'plan:' + d.id, bank = Store.get('bank');
    const items = (bank ? bank.items : []).filter(i => ['new', 'later', ''].includes(i.status || ''));
    if (!items.length) return UI.toast('В банке пока нет свободных идей');
    const picked = new Set();
    const close = UI.modal('Идеи из банка', h('div',
      h('div.pick', items.map(i => h('label', h('input', { type: 'checkbox', onchange: e => (e.target.checked ? picked.add(i.id) : picked.delete(i.id)) }),
        h('div', h('b', i.title), i.desc && h('div.dim', i.desc), h('small.dim', '★'.repeat(i.cool || 1) + ' · ' + (REF.modes[i.mode] ? REF.modes[i.mode].icon : 'любой формат')))))),
      h('div.row', { style: { marginTop: '10px' } }, h('span.sp'), h('button.primary', { onclick: () => {
        for (const i of items.filter(x => picked.has(x.id))) {
          Store.add(key, ['ideas'], { id: uid('i'), text: i.title + (i.desc ? ' — ' + i.desc : ''), why: '', src: i.src || '', star: false, by: i.by || 'me', bank: i.id }, false);
          Store.set('bank', ['items', i.id, 'status'], 'plan'); Store.set('bank', ['items', i.id, 'plan'], d.id);
        }
        close(); App.render();
      } }, 'Добавить в штурм'))));
  },

  // ---------------- 2. Биты ----------------
  beats(d, key, M) {
    const beats = d.beats || [], kept = beats.filter(b => b.keep !== false).length;
    const f = Local.get('beats:' + d.id) || 'all';
    const shown = beats.filter(b => f === 'all' || (f === 'keep' ? b.keep !== false : b.keep === false));
    return [
      hint('beats', HINTS.beats(M) + (d.genre === 'story' ? HINTS.beatsStory : '')),
      ideaBanner(d),
      h('section.card',
        h('div.card-head', h('h3', 'Биты'),
          h('span.counter', { class: beats.length >= M.beats[0] ? 'ok' : '' }, `собрано ${beats.length} · цель ${M.beats[0]}–${M.beats[1]}`),
          h('span.counter', { class: kept >= M.keep[0] && kept <= M.keep[1] ? 'ok' : kept > M.keep[1] ? 'warn' : '' }, `оставлено ${kept} · цель ${M.keep[0]}–${M.keep[1]}`),
          h('span.sp'),
          h('div.seg', [['all', 'Все'], ['keep', 'Оставленные'], ['cut', 'Снятые']].map(([k, l]) =>
            h('button', { class: f === k ? 'sel' : '', onclick: () => { Local.set('beats:' + d.id, k); App.render(); } }, l))),
          Claude.btn({ label: 'Накидать биты', action: 'beats', key })),
        h('div.beats-head', h('span'), h('span', '#'), h('span', '«Вопрос» — сетап'), h('span'), h('span', '«Ответ» — панчлайн'), h('span', 'Источник'), h('span', '✓'), h('span')),
        shown.length ? h('div.beats', shown.map(b => Plan.beatRow(d, key, b, beats.indexOf(b)))) : h('div.empty', 'Пока пусто. Пиши биты ниже или нажми ✨ Накидать биты.'),
        addLine('+ бит: вопрос | ответ — Enter', t => { const [q, ...a] = t.split('|'); Store.add(key, ['beats'], { id: uid('b'), q: q.trim(), a: a.join('|').trim(), src: '', keep: true, by: 'me' }); }, key + '|addbeat')),
    ];
  },

  beatRow(d, key, b, idx) {
    const url = /^https?:\/\//.test(b.src || '');
    const row = h('div.beat', { class: b.keep === false ? 'cut' : '' },
      h('span.handle', { title: 'Потяни, чтобы поменять порядок', onmousedown: () => (row.draggable = true) }, '⋮⋮'),
      h('span.no', idx + 1),
      area(key, ['beats', b.id, 'q'], { ph: 'вопрос / сетап…' }),
      h('button.icon.swap', { title: 'Поменять половины местами', onclick: () => { const q = b.q || '', a = b.a || ''; Store.set(key, ['beats', b.id, 'q'], a); Store.set(key, ['beats', b.id, 'a'], q, true); } }, '⇄'),
      area(key, ['beats', b.id, 'a'], { ph: 'ответ / панчлайн…' }),
      h('div.src', line(key, ['beats', b.id, 'src'], { ph: 'источник' }), url && h('a', { href: b.src, target: '_blank', rel: 'noopener', title: b.src }, '🔗 открыть'), b.by === 'claude' && h('span.by', ' 🤖')),
      h('button.tgl.keep', { class: b.keep !== false ? 'on' : '', title: b.keep !== false ? 'Оставлен — клик, чтобы снять' : 'Снят — клик, чтобы вернуть',
        onclick: () => Store.set(key, ['beats', b.id, 'keep'], b.keep === false, true) }, '✓'),
      h('button.icon.del', { title: 'Удалить', onclick: () => Store.del(key, ['beats'], b.id) }, '×'));
    row.addEventListener('dragstart', e => { Drag.beat = b.id; Drag.from = 'list'; e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { row.draggable = false; Drag.beat = Drag.from = null; $$('.beat.dragover').forEach(x => x.classList.remove('dragover')); });
    row.addEventListener('dragover', e => { if (Drag.from === 'list' && Drag.beat && Drag.beat !== b.id) { e.preventDefault(); row.classList.add('dragover'); } });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', e => {
      if (Drag.from !== 'list' || !Drag.beat) return;
      e.preventDefault();
      const list = d.beats || [], from = list.findIndex(x => x.id === Drag.beat), t = list.findIndex(x => x.id === b.id);
      Store.op(key, { op: 'move', path: ['beats'], id: Drag.beat, to: from < t ? t - 1 : t });
      Drag.beat = null;
    });
    return row;
  },

  // ---------------- 3. Название ----------------
  title(d, key, M) {
    const ch = chosenOf(d), idea = isIdea(d), n0 = idea ? 0 : 1;   // the new path has no «7 questions»: Claude's questions replaced them
    return [
      idea ? hint('titleIdea', HINTS.titleIdea) : hint('title', HINTS.title),
      ideaBanner(d),
      !idea && h('section.card', h('div.card-head', h('h3', 'Шаг 1 · Описываем идею'), h('span.sp'), Claude.btn({ label: 'Черновик ответов', action: 'q7', key, title: 'Claude заполнит только пустые ответы' })),
        h('div.q7', REF.q7.map(q => h('div.q', { class: q.wide ? 'wide' : '' }, h('label', q.label), h('small.dim', q.hint), area(key, ['q7', q.key], { ph: '…' }))))),
      !idea && h('section.card', h('div.card-head', h('h3', `Шаг ${n0 + 1} · Выделяем смыслы`), h('span.dim', 'клик: ● без этого никак → ✕ вычеркнуть → обычный'), h('span.sp'),
          Claude.btn({ label: 'Выделить смыслы', action: 'meanings', key })),
        (d.meanings || []).length ? h('div.chips', d.meanings.map(m => Plan.chip(key, m))) : h('p.dim', 'Пока пусто: пиши самыми простыми словами, через запятую.'),
        addLine('+ смыслы через запятую — Enter', t => { t.split(',').map(s => s.trim()).filter(Boolean).forEach(s => Store.add(key, ['meanings'], { id: uid('m'), text: s, mark: '', by: 'me' }, false)); App.render(); }, key + '|addm')),
      h('section.card', h('div.card-head', h('h3', idea ? 'Шаг 1 · Названия по углам атаки' : `Шаг ${n0 + 2} · Выбираем «угол атаки»`), h('span.dim', `название до ${M.titleMax} знаков`), h('span.sp'),
          Claude.btn({ label: 'По 3 на каждый угол', action: 'titles', key, params: { k: 3 } })),
        Plan.wordsBar(),
        h('div.circle', REF.angles.map(a => Plan.sector(d, key, M, a)),
          h('div.center', h('b', 'ИДЕЯ'), h('span', ch ? ch.text : idea ? 'запиши идею на вкладке «Идея»' : 'выбери идею на вкладке «Идеи»')))),
      h('section.card', h('h3', idea ? 'Шаг 2 · Финалисты (1–3)' : `Шаг ${n0 + 3} · Три финалиста`), Plan.finalists(d)),
    ];
  },

  chip(key, m) {
    const next = { '': 'must', must: 'cut', cut: '' };
    return h('span.chip', { class: m.mark || '', title: 'Клик: ● без этого никак → ✕ вычеркнуть → обычный', onclick: () => Store.set(key, ['meanings', m.id, 'mark'], next[m.mark || ''], true) },
      m.mark === 'must' ? '●' : m.mark === 'cut' ? '✕' : '', m.text, m.by === 'claude' && h('span.by', '🤖'),
      h('span.x', { title: 'Удалить', onclick: e => { e.stopPropagation(); Store.del(key, ['meanings'], m.id); } }, '×'));
  },

  wordsBar() {
    return h('div.words', h('span.dim', 'Сильные слова:'),
      REF.words.map(w => h('button.word', { style: { borderColor: w.color }, title: w.hint, onclick: () => Plan.wordInfo(w) }, w.label)),
      App.info.pdf && h('a', { href: '/planner.pdf#page=200', target: '_blank' }, '📖 словарь из тетради'));
  },

  wordInfo(w) {
    UI.modal(w.label, h('div', h('p', w.hint), h('p.dim', 'Например: ' + w.ex.join(', ') + '.'),
      App.info.pdf ? h('p', h('a', { href: '/planner.pdf#page=200', target: '_blank' }, '📖 Полный словарь сильных слов — в тетради, стр. 200–201')) : h('p.dim', 'Положи PDF тетради в _ideas/master-planer.pdf — тогда здесь появится ссылка на словарь.'),
      h('p.dim', 'Кнопка 💪 у названия попросит Claude усилить его словами из разных групп.')));
  },

  sector(d, key, M, a) {
    const ts = (d.titles || []).filter(t => t.angle === a.key);
    return h('div.sector', { style: { borderColor: a.color } },
      h('div.card-head', h('h4', { style: { color: a.color } }, a.label), h('span.counter', { class: ts.length >= 3 ? 'ok' : '' }, ts.length + '/3'), h('span.sp'),
        Claude.btn({ label: '3', action: 'titles', key, scope: 'titles:' + a.key, params: { angle: a.key, k: 3 }, cls: 'mini', title: 'Claude: 3 названия через этот угол' })),
      h('div.shint', a.hint),
      ts.map(t => Plan.titleLine(d, key, M, t)),
      addLine('+ название — Enter', text => Store.add(key, ['titles'], { id: uid('t'), angle: a.key, text, words: [], star: false, by: 'me' }), key + '|addt' + a.key));
  },

  titleLine(d, key, M, t) {
    const cls = n => (n > 100 ? 'bad' : n > M.titleMax ? 'warn' : '');
    const len = h('span.len', { class: cls((t.text || '').length), title: `знаков (до ${M.titleMax})` }, (t.text || '').length);
    return h('div.tline',
      h('button.tgl.star', { class: t.star ? 'on' : '', title: 'Финалист: ★ до трёх самых сильных', onclick: () => Store.set(key, ['titles', t.id, 'star'], !t.star, true) }, '★'),
      area(key, ['titles', t.id, 'text'], { onInput: v => { len.textContent = v.length; len.className = 'len ' + cls(v.length); } }),
      len,
      (t.words || []).length > 0 && h('span.wtags', t.words.map(w => { const W = REF.words.find(x => x.key === w); return W && h('i', { style: { background: W.color }, title: W.label }); })),
      t.by === 'claude' && h('span.by', '🤖'),
      Claude.btn({ label: '', icon: '💪', action: 'strengthen', key, scope: 'strengthen:' + t.id, params: { title: t.id }, cls: 'mini', title: 'Claude: усилить сильными словами',
        onResult: r => Plan.variants(d, key, t, r.variants || []) }),
      h('button.icon.del', { title: 'Удалить', onclick: () => Store.del(key, ['titles'], t.id) }, '×'));
  },

  variants(d, key, t, list) {
    if (!list.length) return UI.toast('Claude не предложил вариантов', 'err');
    const close = UI.modal('💪 Усиленные варианты', h('div.pick', list.map(v => h('label', h('div.grow', h('b', v.text),
      h('div.dim', (v.words || []).map(w => (REF.words.find(x => x.key === w) || {}).label).filter(Boolean).join(', '))),
      h('button', { onclick: () => { Store.set(key, ['titles', t.id, 'text'], v.text); Store.set(key, ['titles', t.id, 'words'], v.words || [], true); close(); } }, 'Заменить'),
      h('button', { onclick: () => { Store.add(key, ['titles'], { id: uid('t'), angle: t.angle, text: v.text, words: v.words || [], star: false, by: 'claude' }); close(); } }, 'Добавить рядом')))));
  },

  finalists(d) {
    const fin = (d.titles || []).filter(t => t.star);
    if (!fin.length) return h('p.dim', 'Отметь ★ до трёх названий в круге выше.');
    return [
      h('div.finalists', fin.map((t, i) => { const A = REF.angles.find(a => a.key === t.angle) || {}; return h('div.fin', { style: { borderLeftColor: A.color } }, h('span.badge', i + 1), h('b.grow', t.text), h('span.dim', A.short)); })),
      fin.length > 3 && h('p.counter.warn', 'Больше трёх — оставь сильнейшие.'),
      fin.length >= 2 && new Set(fin.map(t => t.angle)).size === 1 && h('p.counter.warn', 'Все финалисты с одного угла — лучше совсем разные.'),
      isIdea(d) ? h('p', h('a', { href: `#/p/${d.id}/pre` }, 'Дальше → 🎬 Препродакшен: сцены, персонажи, пропсы и звуки'), ' · потом ', h('a', { href: `#/p/${d.id}/thumbs` }, 'обложка и первый кадр'))
        : h('p', h('a', { href: `#/p/${d.id}/images` }, 'Дальше → образы для смыслов'), ' · ', h('a', { href: `#/p/${d.id}/thumbs` }, 'проверим финалистов превью')),
    ];
  },

  // ---------------- 4. Образы ----------------
  images(d, key) {
    const ms = (d.meanings || []).filter(m => m.mark !== 'cut').sort((a, b) => (b.mark === 'must') - (a.mark === 'must'));
    return [
      hint('images', HINTS.images),
      h('section.card', h('div.card-head', h('h3', 'Смыслы в образы'), h('span.dim', 'минимум 3 разных образа на смысл, больше — можно'), h('span.sp'), Claude.btn({ label: 'Подобрать образы', action: 'images', key })),
        ms.length ? h('div.imgrows', ms.map(m => {
          // at least 3 cells (the method's minimum), more on «+ образ»; extra empty slots are remembered per page view
          const used = (d.images || []).filter(g => g.meaning === m.id).map(g => g.slot);
          const n = Math.max(3, used.length ? Math.max(...used) + 1 : 0, Plan.extra[m.id] || 0);
          return h('div.imgrow', h('div.it-m', { class: m.mark === 'must' ? 'must' : '' }, (m.mark === 'must' ? '● ' : '') + m.text),
            h('div.icells', [...Array(n).keys()].map(s => Plan.imageCell(d, key, m, s)),
              h('button.icell.addimg', { title: 'Ещё один образ для этого смысла', onclick: () => { Plan.extra[m.id] = n + 1; App.render(); } }, '+ образ')));
        }))
          : h('div.empty', 'Сначала выпиши смыслы на вкладке «Название» (шаг 2).', h('br'), h('a', { href: `#/p/${d.id}/title` }, '→ Название'))),
    ];
  },

  imageCell(d, key, m, slot) {
    const g = (d.images || []).find(x => x.meaning === m.id && x.slot === slot);
    let gid = g && g.id;
    const ensure = () => { if (!gid) { gid = uid('g'); Store.add(key, ['images'], { id: gid, meaning: m.id, slot, text: '', img: '', by: 'me' }, false); } return gid; };
    const ta = h('textarea.auto', { key: `${key}|img|${m.id}|${slot}`, rows: 1, placeholder: `образ ${slot + 1}…`,
      oninput: e => { Store.set(key, ['images', ensure(), 'text'], e.target.value); autosize(e.target); } });
    ta.value = g ? g.text || '' : '';
    return h('div.icell', ta, imgSlot({ key, path: g ? ['images', g.id, 'img'] : null, planId: d.id, aspect: '4/3', small: true, compact: true,
      onSet: p => Store.set(key, ['images', ensure(), 'img'], p, true) }), g && g.by === 'claude' && h('small.dim', '🤖 Claude'));
  },

  // ---------------- 5. Превью / Хук и обложка ----------------
  thumbs(d, key, M) {
    const short = d.mode !== 'long', fin = (d.titles || []).filter(t => t.star);
    const hk = short ? 'thumbsS' : 'thumbs';
    if (!fin.length) return [hint(hk, HINTS[hk]), h('div.card.empty', 'Сначала отметь ★ до трёх названий-финалистов на вкладке «Название».', h('br'), h('a', { href: `#/p/${d.id}/title` }, '→ Название'))];
    const cur = Local.get('tt:' + d.id), t = fin.find(x => x.id === cur) || fin[0];
    const cs = (d.thumbs || []).filter(c => c.title === t.id);
    return [
      hint(hk, HINTS[hk]),
      h('div.subtabs', fin.map((x, i) => h('button', { class: x === t ? 'sel' : '', onclick: () => { Local.set('tt:' + d.id, x.id); App.render(); } },
        `${i + 1}. ${x.text} `, h('span.badge', (d.thumbs || []).filter(c => c.title === x.id).length)))),
      h('section.card',
        h('div.card-head', h('h3', `Гипотеза названия: «${t.text}»`), h('span.sp'),
          Claude.btn({ label: cs.length ? 'Ещё вариант' : (short ? 'Связка' : 'Концепт'), action: 'thumbs', key, scope: 'thumbs:' + t.id, params: { title: t.id, k: 1 },
            title: cs.length ? 'Claude придумает ещё один, непохожий на уже имеющиеся' : 'Claude придумает концепт по смыслам и образам' }),
          h('button', { onclick: () => Store.add(key, ['thumbs'], { id: uid('c'), title: t.id, desc: '', type: '', n: null, text: '', hook: '', frame: '', img: '', by: 'me' }) }, '+ концепт')),
        cs.length ? h('div.concepts', { class: short ? 'short' : '' }, cs.map(c => Plan.concept(d, key, t, c)))
          : h('div.empty', short ? 'Придумай связку «хук + первый кадр + обложка» — или попроси Claude.' : 'Нарисуй или опиши концепт превью — или попроси Claude.')),
      Plan.winBox(d),
    ];
  },

  concept(d, key, t, c) {
    const short = d.mode !== 'long', win = !!(d.final && d.final.thumb === c.id), P = ['thumbs', c.id];
    const zone = zoneOf(c.type), n = Number(c.n) || 0;
    const nNote = !n ? '' : n === 1 ? '🏆 один образ — победа' : n <= 3 ? '👍 хорошо' : n <= 7 ? '⚠ многовато' : '⛔ больше 7 — провал';
    const hookWords = (c.hook || '').split(/\s+/).filter(Boolean).length;
    const typeOpts = [{ value: '', label: 'тип по карте превью…' }, ...REF.thumbZones.map(z => ({ label: `${z.icon} ${z.label} — ${z.sub}`, group: z.types.map(k => ({ value: k, label: REF.thumbTypes[k].label })) }))];
    const cr = c.critique;
    const col = (...kids) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } }, ...kids);
    // shorts: the cover (shelf, recommendations, channel page, search) and the first frame (feed) are separate jobs
    const cover = h('div.cbody',
      imgSlot({ key, path: [...P, 'img'], planId: d.id, aspect: short ? '9/16' : '16/9', label: short ? 'обложка 9:16' : 'эскиз 16:9' }),
      col(h('label', short ? '🖼 Обложка — полка шортсов, рекомендации, канал' : 'Что в кадре'), area(key, [...P, 'desc'], { ph: 'один образ, крупно…' })));
    const frame = short && h('div.cbody',
      imgSlot({ key, path: [...P, 'frameImg'], planId: d.id, aspect: '9/16', label: 'первый кадр 9:16' }),
      col(h('label', '🎬 Первый кадр — лента: остаться или пролистнуть'), area(key, [...P, 'frame'], { ph: 'что зритель видит в первую секунду, в движении' }),
        h('label', 'Хук — первая фраза'), area(key, [...P, 'hook'], { ph: d.genre === 'story' ? '10–15 слов: ёжик уже в странной ситуации или обещание беды' : '10–15 слов с именем, годом или цифрой' }),
        c.hook && (hookWords < 9 || hookWords > 16) && h('div.warnline', `⚠ ${hookWords} ${plural(hookWords, 'слово', 'слова', 'слов')}, лучше 10–15`),
        /\?\s*$/.test(c.hook || '') && h('div.warnline', '⚠ Хук лучше без вопроса: вопрос зритель задаст себе сам')));
    return h('div.concept', { class: win ? 'win' : '' },
      cover, frame,
      h('div.row', sel(typeOpts, c.type || '', v => Store.set(key, [...P, 'type'], v, true), { class: 'box', title: 'Тип по карте превью (подробно — в Справочнике)' }),
        zone && h('span.zone', zone.icon + ' ' + zone.label)),
      h('div.row.nimg', 'Образов в кадре:',
        h('button.icon', { onclick: () => Store.set(key, [...P, 'n'], Math.max(1, n - 1), true) }, '−'), h('b', n || '?'),
        h('button.icon', { onclick: () => Store.set(key, [...P, 'n'], n + 1, true) }, '+'), h('span.dim', nNote)),
      h('label', short ? 'Текст на обложке' : 'Текст на превью'), line(key, [...P, 'text'], { ph: short ? '2–4 слова или число' : 'минимум слов или пусто', cls: 'box' }),
      dupTitle(c.text, t.text) && h('div.warnline', '⚠ Текст повторяет название — пусть лучше дополняет его'),
      wordsOf(c.text).length > (short ? 4 : 5) && h('div.warnline', '⚠ Много слов: превью читают за секунду'),
      zone && zone.key === 'no' && h('div.badline', '⛔ Этот тип из зоны «не делаем»'),
      (() => { const ms = mentionsIn([c.desc, c.frame, c.hook, c.text].join(' '), d); return ms.length > 0 && typeof Plan.chips === 'function' && [h('label', '🔗 Отмечено через @ — будет в отрисовке'), Plan.chips(d, ms)]; })(),
      cr && cr.points && h('div.critique', h('span.v', { class: cr.verdict }, { good: '✅ можно брать', fix: '🔧 доработать', bad: '⛔ не работает' }[cr.verdict] || cr.verdict),
        cr.type && REF.thumbTypes[cr.type] && h('span.dim', ' · по карте: ' + REF.thumbTypes[cr.type].label), h('ul', cr.points.map(p => h('li', p)))),
      Plan.renderBox(d, key, c),
      h('div.row',
        h('button', { class: win ? 'primary' : '', onclick: () => Store.set(key, ['final'], win ? { title: '', thumb: '' } : { title: t.id, thumb: c.id }, true) }, win ? '🏆 Выбрано' : '🏆 Выбрать связку'),
        Claude.btn({ label: 'Разбор', action: 'critique', key, scope: 'critique:' + c.id, params: { thumb: c.id }, title: 'Claude разберёт концепт (и эскиз, если он есть)' }),
        c.by === 'claude' && h('span.by', '🤖'), h('span.sp'),
        h('button.icon.del', { title: 'Удалить концепт', onclick: () => Store.del(key, ['thumbs'], c.id) }, '×')));
  },

  // 🎨 cover + first frame drawn by our engine (ideas_claude.render_spec): versions, pick, pins + notes per picture -> next version
  renderBox(d, key, c) {
    const rs = c.renders || [], cur = rs.find(r => r.id === c.render) || rs[rs.length - 1];
    const short = d.mode !== 'long', scope = 'render:' + c.id;
    const running = Claude.running(key, scope);
    const fx = c.fx || {}, nC = fxCount(fx.cover), nF = fxCount(fx.frame);
    const pic = (src, cap, part) => src && h('figure.rpic',
      h('div.pinwrap', { title: 'Клик — отметить правки на картинке' }, h('img', { src: '/' + src, alt: cap, onclick: () => Plan.fixes(key, c.id, part) }), pinMarks(fx[part])),
      h('figcaption', cap, fxCount(fx[part]) ? h('b', ` · правок: ${fxCount(fx[part])}`) : '', ' ',
        h('a', { href: '#', title: 'Открыть крупно', onclick: e => { e.preventDefault(); UI.lightbox('/' + src); } }, '🔍')));
    const fixLabel = nC && nF ? 'Поправить обложку и кадр' : nC ? (short ? 'Поправить обложку' : 'Поправить превью') : 'Поправить первый кадр';
    const clamp = text => h('p.dim.clamp', { title: 'Клик — показать целиком', onclick: e => e.currentTarget.classList.toggle('open') }, text);
    return h('div.renderbox',
      h('div.row', h('b', '🎨 Отрисовка нашим движком'),
        rs.length > 1 && h('span.row', rs.map(r => h('button.small', { class: r === cur ? 'sel' : '', title: r.feedback ? 'правка: ' + r.feedback : 'первая версия',
          onclick: () => Store.set(key, ['thumbs', c.id, 'render'], r.id, true) }, 'v' + r.v))),
        h('span.sp'),
        !cur && Claude.btn({ label: short ? 'Отрисовать обложку и первый кадр' : 'Отрисовать превью и первый кадр', action: 'render', key, scope, params: { thumb: c.id },
          title: 'Claude нарисует по эскизу и описанию бумажным тулкитом и ёжиком, сам посмотрит результат и поправит. 3–10 минут.' })),
      running && h('p.dim', 'Claude рисует: пишет сцену, рендерит, смотрит на картинку и правит — обычно 3–10 минут. Можно заниматься другими вкладками.'),
      cur && h('div.rpair', pic(cur.cover, short ? 'обложка' : 'превью', 'cover'), pic(cur.frame, 'первый кадр', 'frame')),
      cur && cur.feedback && clamp(`✏️ v${cur.v} — правка: ${cur.feedback}`),
      cur && cur.summary && clamp(cur.summary),
      cur && h('div.row',
        h('button', { onclick: () => Plan.fixes(key, c.id, 'cover'), title: 'Пины прямо на картинках и общие заметки — отдельно к обложке и к первому кадру' },
          '✏️ Правки', (nC || nF) ? ` (${nC + nF})` : ''),
        (nC || nF) ? Claude.btn({ label: fixLabel, action: 'render', key, scope, params: { thumb: c.id, base: cur.id }, title: 'Новая версия с учётом правок; прошлые версии остаются' })
          : h('span.dim', 'кликни по картинке, чтобы отметить, что поправить'),
        h('span.sp'),
        Claude.btn({ label: '', icon: '🔄', action: 'render', key, scope, params: { thumb: c.id }, cls: 'mini', title: 'Нарисовать с нуля ещё один вариант' })));
  },

  // ✏️ edits of a drawn version, like the video review: click the picture to drop a numbered pin, write what to change;
  // plus a note «в целом». Cover and first frame are separate: Claude touches only the parts that have edits.
  fixes(key, cid, focus) {
    const body = h('div.fixes'), P = part => ['thumbs', cid, 'fx', part];
    let close = null, want = null;
    const draw = () => {
      const d = Store.get(key), c = (d.thumbs || []).find(x => x.id === cid);
      const rs = (c && c.renders) || [], cur = c && (rs.find(r => r.id === c.render) || rs[rs.length - 1]);
      if (!cur) { if (close) close(); return; }
      const short = d.mode !== 'long', fx = c.fx || {};
      const col = part => {
        const e = fx[part] || {}, pins = e.pins || [];
        const img = h('img', { src: '/' + cur[part], alt: '', onclick: ev => {
          const r = ev.currentTarget.getBoundingClientRect(), id = uid('p');
          const x = Math.round((ev.clientX - r.left) / r.width * 1000) / 1000, y = Math.round((ev.clientY - r.top) / r.height * 1000) / 1000;
          want = [...P(part), 'pins', id, 'text'];
          Store.add(key, [...P(part), 'pins'], { id, x, y, text: '' }); draw();
        } });
        return h('div.fxcol', { class: part === focus ? 'focus' : '' },
          h('h4', part === 'cover' ? (short ? '🖼 Обложка' : '🖼 Превью') : '🎬 Первый кадр', h('span.dim', ` · v${cur.v}`)),
          h('div.pinwrap.big', img, pinMarks(e)),
          pins.length ? h('ol.pinlist', pins.map((p, i) => h('li', h('span.pnum', i + 1),
            line(key, [...P(part), 'pins', p.id, 'text'], { ph: 'что здесь не так / как надо', cls: 'box' }),
            h('button.icon.del', { title: 'Убрать пин', onclick: () => { Store.del(key, [...P(part), 'pins'], p.id); draw(); } }, '×'))))
            : h('p.dim', 'Кликни по картинке — поставишь пин с номером и напишешь, что там поправить.'),
          h('label', 'В целом'),
          noteList(key, P(part), part === 'cover' ? '+ «фон ярче», «ёжика крупнее», «текст короче»…' : '+ «больше движения», «ёжик испуганнее», «дверь как на эскизе»…', draw));
      };
      const send = () => {
        const f = ((Store.get(key).thumbs || []).find(x => x.id === cid) || {}).fx || {};
        if (!fxCount(f.cover) && !fxCount(f.frame)) return UI.toast('Сначала отметь, что поправить', 'err');
        if (Claude.running(key, 'render:' + cid)) return UI.toast('Claude уже рисует этот концепт — дождись версии', 'err');
        Claude.run({ action: 'render', key, scope: 'render:' + cid, params: { thumb: cid, base: cur.id } });
        close();
      };
      body.replaceChildren(
        h('div.fxcols', col('cover'), col('frame')),
        h('div.row', h('span.dim', 'Правки сохраняются сами. Картинку без правок Claude не трогает.'), h('span.sp'),
          h('button', { onclick: () => close() }, 'Готово'),
          h('button.claude', { disabled: !Claude.on, onclick: send }, '✨ Отправить Claude')));
      requestAnimationFrame(() => {
        $$('textarea.auto', body).forEach(autosize);
        if (want) { const i = body.querySelector(`[data-key="${CSS.escape(key + '|' + want.join('.'))}"]`); want = null; if (i) i.focus(); }
      });
    };
    close = UI.modal('✏️ Правки отрисовки', body, { wide: true, onClose: () => App.render() });
    draw();
  },

  winBox(d) {
    const ft = (d.titles || []).find(t => t.id === (d.final || {}).title), fc = (d.thumbs || []).find(c => c.id === (d.final || {}).thumb);
    if (!ft || !fc) return null;
    return h('div.finalbox', h('b', '🏆 Связка выбрана: '), `«${ft.text}»`, fc.desc && h('span.dim', ' — ' + fc.desc),
      isIdea(d) ? h('p', 'Новые мысли, которые пришли с обложкой, добавь в ', h('a', { href: `#/p/${d.id}/qa` }, 'биты'), ' или ', h('a', { href: `#/p/${d.id}/pre` }, 'препродакшен'),
        '. Дальше — ', h('a', { href: `#/p/${d.id}/prod` }, '🚀 В работу'), '.')
        : h('p', 'Теперь загляни в ', h('a', { href: `#/p/${d.id}/beats` }, 'Биты'), ': новые мысли, которые пришли с превью, добавь туда. Потом — ', h('a', { href: `#/p/${d.id}/structure` }, 'Структура'), '.'));
  },

  // ---------------- 6. Структура ----------------
  structure(d, key) {
    const short = d.mode !== 'long', st = d.structure || {};
    const scheme = short ? (REF.schemes[st.scheme] ? st.scheme : 'V') : (st.scheme === 'steps' ? 'steps' : 'acts');
    const rows = Plan.rows(d, scheme);
    const kept = (d.beats || []).filter(b => b.keep !== false);
    const slots = st.slots || {};
    const used = new Set(Object.values(slots).flat());
    const free = kept.filter(b => !used.has(b.id));
    const switcher = short
      ? h('div.seg', Object.entries(REF.schemes).map(([k, s]) => h('button', { class: scheme === k ? 'sel' : '', title: `${s.label} — ${s.for}`, onclick: () => Store.set(key, ['structure', 'scheme'], k, true) }, s.label.split(' → ')[0])))
      : h('div.seg', [['acts', 'Три акта (15 точек)'], ['steps', 'Инструкция по шагам']].map(([k, l]) => h('button', { class: scheme === k ? 'sel' : '', onclick: () => Store.set(key, ['structure', 'scheme'], k, true) }, l)));
    const freeBox = h('div.free', h('b', `Не разложены (${free.length}):`), free.map(b => Plan.chipBeat(key, b, null, slots)),
      !kept.length && h('span.dim', 'оставленных битов нет — добавь их на вкладке «Биты»'));
    Plan.drop(freeBox, id => { const next = {}; for (const [k, v] of Object.entries(slots)) next[k] = (v || []).filter(x => x !== id); Store.set(key, ['structure', 'slots'], next, true); });
    return [
      hint(short ? 'structS' : 'structL', short ? HINTS.structS : HINTS.structL),
      h('section.card',
        h('div.card-head', h('h3', 'Структура'), switcher,
          !short && h('span.row', 'длина', line(key, ['structure', 'minutes'], { type: 'number', num: true, cls: 'box', onInput: () => App.render() }), 'мин'),
          h('span.sp'),
          Claude.btn({ label: 'Разложить биты', action: 'structure', key, confirm: used.size ? 'Claude разложит биты заново — текущая раскладка заменится. Продолжить?' : null })),
        short && h('p.dim', `${REF.schemes[scheme].label} — для: ${REF.schemes[scheme].for}.`),
        !short && scheme === 'acts' && Plan.curve(rows, slots),
        freeBox,
        h('div.slots', rows.map(r => Plan.slot(d, key, r, kept, slots, st, short))),
        !short && scheme === 'steps' && addLine('+ шаг — Enter', text => Store.add(key, ['structure', 'steps'], { id: uid('s'), text }), key + '|addstep')),
    ];
  },

  rows(d, scheme) {
    if (REF.schemes[scheme]) return REF.schemes[scheme].blocks;
    if (scheme === 'steps') {
      const F = REF.steps, steps = (d.structure || {}).steps || [];
      return [...F.filter(s => !s.end), ...steps.map((s, i) => ({ key: s.id, label: `Шаг ${i + 1}`, step: s, hint: '' })), ...F.filter(s => s.end)];
    }
    return REF.acts;
  },

  slot(d, key, r, kept, slots, st, short) {
    const ids = slots[r.key] || [];
    const beats = ids.map(id => (d.beats || []).find(b => b.id === id)).filter(Boolean);
    const tm = r.t || (r.pct != null ? '~' + mmss(r.pct / 100 * (Number(st.minutes) || 12) * 60) : '');
    const assign = id => {
      const next = {};
      for (const [k, v] of Object.entries(slots)) next[k] = (v || []).filter(x => x !== id);
      next[r.key] = [...(next[r.key] || []), id];
      Store.set(key, ['structure', 'slots'], next, true);
    };
    const usedAll = new Set(Object.values(slots).flat());
    const freeBeats = kept.filter(b => !usedAll.has(b.id));
    const mark = (st.marks || {})[r.key];
    const row = h('div.slotrow', { class: r.act ? 'act' + r.act : '' },
      h('div.sl', h('b', r.label), tm && h('span.tm', tm), r.hint && h('small', r.hint),
        r.step && h('div.row', line(key, ['structure', 'steps', r.step.id, 'text'], { ph: 'о чём шаг', cls: 'box' }),
          h('button.icon.del', { title: 'Удалить шаг', onclick: () => Store.del(key, ['structure', 'steps'], r.step.id) }, '×')),
        !short && h('div.qa', { title: 'Что в этом слоте: сетап (вопрос) или панчлайн (ответ)?' },
          [['q', 'сетап'], ['a', 'панчлайн']].map(([k, l]) => h('button', { class: mark === k ? 'sel' : '', onclick: () => Store.set(key, ['structure', 'marks', r.key], mark === k ? '' : k, true) }, l)))),
      h('div.sb',
        h('div.chips', beats.map(b => Plan.chipBeat(key, b, r.key, slots)), !beats.length && h('span.dim', 'пусто — перетащи бит сюда')),
        freeBeats.length > 0 && h('div.row', sel([{ value: '', label: '+ бит в этот слот…' }, ...freeBeats.map(b => ({ value: b.id, label: beatLabel(b) }))], '', v => v && assign(v), { class: 'box' })),
        area(key, ['structure', 'notes', r.key], { ph: 'заметка: что здесь должно быть…' })));
    Plan.drop(row, assign);
    return row;
  },

  chipBeat(key, b, slotKey, slots) {
    const c = h('span.bchip', { draggable: 'true', title: (b.q || '') + (b.a ? ' → ' + b.a : '') }, h('span', beatLabel(b)),
      slotKey && h('span.x', { title: 'Убрать из слота', onclick: () => Store.set(key, ['structure', 'slots'], { ...slots, [slotKey]: (slots[slotKey] || []).filter(x => x !== b.id) }, true) }, '×'));
    c.addEventListener('dragstart', e => { Drag.beat = b.id; Drag.from = 'chip'; e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move'; });
    c.addEventListener('dragend', () => { Drag.beat = Drag.from = null; });
    return c;
  },

  drop(el, onDrop) {
    el.addEventListener('dragover', e => { if (Drag.from === 'chip' && Drag.beat) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', e => { el.classList.remove('drop'); if (Drag.from !== 'chip' || !Drag.beat) return; e.preventDefault(); e.stopPropagation(); const id = Drag.beat; Drag.beat = null; onDrop(id); });
  },

  curve(rows, slots) {                                // schematic emotion curve of the three acts, filled dots = slot has beats
    const LEVEL = { open: .16, theme: .32, setup: .42, catalyst: .64, debate: .36, act2: .28, bstory: .36, fun: .56, mid: .8, bad: .5, lost: .2, dark: .3, act3: .66, climax: .96, final: .56 };
    const pts0 = rows.filter(r => LEVEL[r.key] != null), W = 1000, H = 230, px = 70, py = 34;
    const pts = pts0.map((r, i) => ({ r, x: px + i * (W - 2 * px) / (pts0.length - 1), y: H - py - LEVEL[r.key] * (H - 2 * py) }));
    let path = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      path += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6}, ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6}, ${p2.x} ${p2.y}`;
    }
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.classList.add('curve');
    const add = (tag, a, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
    add('line', { x1: px, y1: H - py + 14, x2: W - px, y2: H - py + 14, stroke: '#3a3a3e' });
    add('text', { x: W / 2, y: H - 4, 'text-anchor': 'middle', fill: '#9a9aa2', 'font-size': 12 }, 'время →');
    add('path', { d: path, fill: 'none', stroke: '#ff5470', 'stroke-width': 4, 'stroke-linecap': 'round' });
    pts.forEach((p, i) => {
      const on = (slots[p.r.key] || []).length > 0;
      add('circle', { cx: p.x, cy: p.y, r: 7, fill: on ? '#ff5470' : '#1d1d1f', stroke: '#ff5470', 'stroke-width': 3 });
      const edge = i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
      add('text', { x: p.x + (edge === 'start' ? -12 : edge === 'end' ? 12 : 0), y: i % 2 ? p.y + 24 : p.y - 14, 'text-anchor': edge,
        fill: on ? '#e6e6e6' : '#9a9aa2', 'font-size': 12 }, p.r.label.replace(/ \(.*\)$/, ''));
    });
    return svg;
  },

  // ---------------- 7. В работу ----------------
  prod(d, key, M) {
    const short = d.mode !== 'long';
    const kept = (d.beats || []).filter(b => b.keep !== false);
    const full = kept.length > 0 && kept.every(b => (b.q || '').trim() && (b.a || '').trim());
    const fin = d.final || {}, ft = (d.titles || []).find(t => t.id === fin.title), fc = (d.thumbs || []).find(c => c.id === fin.thumb);
    const st = d.structure || {}, slots = st.slots || {};
    const blocks = short ? (REF.schemes[st.scheme] || REF.schemes.V).blocks : null;
    const first = short ? blocks[0].key : 'open', last = short ? blocks[blocks.length - 1].key : 'final';
    const idea = isIdea(d), qa = d.qa || [], answered = qa.filter(q => (q.a || '').trim()).length;
    const els = (d.elements || []).filter(e => e.status !== 'drop'), ready = els.filter(e => e.status === 'ok').length;
    const snd = els.filter(e => e.kind === 'sound'), sndOk = snd.filter(e => e.sound).length;
    const checks = idea ? [
      [!!chosenOf(d), 'Идея записана'],
      [answered >= Math.min(10, qa.length || 10), `Ответы на вопросы Claude: ${answered} из ${qa.length}`],
      [kept.length >= M.keep[0], `Оставлено битов: ${kept.length} (нужно от ${M.keep[0]})`],
      [full, 'Биты развёрнуты в пары «вопрос → ответ»'],
      [els.length > 0 && ready === els.length, `Препродакшен утверждён: ${ready} из ${els.length}`],
      [!snd.length || sndOk === snd.length, `Звуки выбраны: ${sndOk} из ${snd.length}`],
      [!!(ft && fc), `Выбрана связка «название + ${short ? 'обложка' : 'превью'}»`],
    ] : [
      [!!d.chosen, 'Выбрана идея'],
      [kept.length >= M.keep[0], `Оставлено битов: ${kept.length} (нужно от ${M.keep[0]})`],
      [full, 'Биты развёрнуты в пары «вопрос → ответ»'],
      [!!(ft && fc), 'Выбрана связка «название + превью»'],
      [(slots[first] || []).length > 0 && (slots[last] || []).length > 0, short ? 'В структуре есть хук и кода' : 'Есть открывающий и завершающий образ'],
    ];
    const preLine = REF.kinds.map(k => { const xs = els.filter(e => e.kind === k.key); return xs.length ? `${k.icon} ${xs.length}` : ''; }).filter(Boolean).join(' · ');
    const must = (d.meanings || []).filter(m => m.mark === 'must').map(m => m.text).join(', ');
    const others = (d.titles || []).filter(t => t.star && t !== ft).map(t => '«' + t.text + '»').join(', ');
    const label = short ? (REF.schemes[st.scheme] || REF.schemes.V).label : st.scheme === 'steps' ? 'Инструкция по шагам' : 'Три акта';
    return [
      hint('prod', HINTS.prod),
      h('section.card', h('h3', 'Проверка перед запуском'), h('div.checks', checks.map(([ok, t]) => h('div.check', { class: ok ? 'ok' : 'no' }, h('span.m', ok ? '✓' : '✗'), t)))),
      h('section.card', h('h3', 'Что уйдёт в производство'),
        h('div.sumgrid',
          h('b', 'Формат'), h('span', `${M.icon} ${M.label} (${M.len})`),
          h('b', 'Идея'), h('span', chosenOf(d) ? chosenOf(d).text : '—'),
          h('b', 'Название'), h('span', ft ? h('b', ft.text) : '—', others && h('span.dim', ' · запасные: ' + others)),
          h('b', short ? 'Обложка' : 'Превью'), h('span', fc ? [fc.desc, fc.type && REF.thumbTypes[fc.type] && h('span.dim', ' · ' + REF.thumbTypes[fc.type].label), fc.text && h('span.dim', ` · текст «${fc.text}»`)] : '—'),
          short && [h('b', 'Хук'), h('span', (fc && fc.hook) || '—'), h('b', 'Первый кадр'), h('span', (fc && fc.frame) || '—')],
          h('b', 'Смыслы'), h('span', must || '—'),
          h('b', 'Биты'), h('span', `${kept.length} оставлено из ${(d.beats || []).length}`),
          idea ? [h('b', 'Вопросы'), h('span', `отвечено ${answered} из ${qa.length}`),
            h('b', 'Препродакшен'), h('span', preLine ? [preLine, h('span.dim', ` · утверждено ${ready} из ${els.length}`)] : '—')]
            : [h('b', 'Структура'), h('span', `${label} · заполнено слотов: ${Object.values(slots).filter(v => v && v.length).length}`)])),
      h('section.card', h('h3', '🚀 Проект'), d.project ? Plan.projectDone(d) : Plan.projectForm(d, ft)),
    ];
  },

  projectForm(d, ft) {
    const def = ((ft && ft.text) || d.name || 'Новый ролик').replace(BAD_NAME, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const inp = h('input.box', { key: 'pname|' + d.id, value: Local.get('pname:' + d.id) ?? def, style: { width: '420px' }, oninput: e => Local.set('pname:' + d.id, e.target.value) });
    return [
      h('p.dim', 'Папка появится рядом с другими проектами. Внутри — шаблон ролика и refs/штурм.md со всем штурмом и эскизами',
        isIdea(d) ? '; препродакшен — в refs/препродакшен (референсы, черновики, код element.js), выбранные звуки — в assets/sfx.' : '.'),
      h('div.row', 'Папка:', inp,
        Claude.btn({ label: 'Создать проект', icon: '🚀', action: 'produce', key: 'plan:' + d.id, scope: 'produce', noClaude: true,
          params: () => ({ id: d.id, name: inp.value.trim() }), title: 'new_project.py + штурм в refs/', onResult: r => UI.toast(`Проект «${r.project}» готов`) }),
        h('button', { onclick: () => Plan.attach(d) }, '📎 Привязать к существующему')),
      d.mode === 'long' && h('p.counter.warn', 'Сборка длинных роликов (16:9) в шаблоне пока не настроена: сценарий и раскадровка уже работают, рендер доделаем, когда дойдём до первого длинного.'),
    ];
  },

  projectDone(d) {
    const phrase = `Сценарий по штурму в папке «${d.project}»`;
    return [
      h('p', 'Проект: ', h('b', d.project), ' — штурм лежит в ', h('code', 'refs/штурм.md'), '.'),
      h('div.say', '💬 Напиши мне:', h('code', phrase), h('button', { onclick: () => UI.copy(phrase) }, 'Скопировать')),
      h('div.row', { style: { marginTop: '8px' } },
        Claude.btn({ label: 'Обновить refs/штурм.md', icon: '🔄', action: 'produce', key: 'plan:' + d.id, scope: 'produce', noClaude: true,
          params: { id: d.id, name: d.project, attach: true }, title: 'Переписать штурм в папке проекта по текущему состоянию' })),
    ];
  },

  async attach(d) {
    let list = [];
    try { list = await api('GET', '/api/projects'); } catch (e) { return UI.toast(e.message, 'err'); }
    const close = UI.modal('Привязать штурм к проекту', h('div.pick', list.map(p => h('label', { onclick: () => {
      close(); Claude.run({ action: 'produce', key: 'plan:' + d.id, scope: 'produce', params: { id: d.id, name: p.name, attach: true } });
    } }, h('b.grow', p.name), p.brainstorm && h('span.dim', 'уже есть refs/штурм.md'), p.video && h('span.dim', '🎬 собран')))));
  },

  // ---------------- 8. Итоги ----------------
  results(d, key, M) {
    const stats = Store.get('stats'), row = d.stats && stats && stats.items.find(r => r.id === d.stats);
    const re = d.retro || {}, brand = Store.get('brand') || {};
    let sumPlan = 0, sumFact = 0;
    const hours = REF.stages.map(s => {
      const r = (re.hours || {})[s.key] || {};
      const def = ((brand.hours || {})[s.key] || {})[d.mode] ?? s[d.mode];
      const plan = r.plan === '' || r.plan == null ? def : Number(r.plan), fact = r.fact === '' || r.fact == null ? null : Number(r.fact);
      sumPlan += plan || 0; sumFact += fact || 0;
      const v = fact == null ? '' : fact <= plan * 1.1 ? 'да' : fact <= plan * 1.5 ? 'средне' : 'нет';
      return h('tr', h('td', s.label), h('td.num', line(key, ['retro', 'hours', s.key, 'plan'], { type: 'number', num: true, ph: String(def), cls: 'box' })),
        h('td.num', line(key, ['retro', 'hours', s.key, 'fact'], { type: 'number', num: true, cls: 'box', onInput: () => App.render() })),
        h('td', h('span', { class: v === 'да' ? 'ok-t' : v === 'нет' ? 'bad-t' : 'dim' }, v)));
    });
    return [
      hint('results', HINTS.results),
      h('section.card', h('div.card-head', h('h3', 'Работа над ошибками'), h('span.dim', 'до публикации или сразу после, пока цифр нет')),
        h('div.row', { style: { marginBottom: '10px' } }, h('b', 'Видео получилось офигенным?'),
          h('div.seg', ['Да', 'Средне', 'Нет'].map(v => h('button', { class: re.awesome === v ? 'sel' : '', onclick: () => {
            Store.set(key, ['retro', 'awesome'], re.awesome === v ? '' : v);
            if (row) Store.set('stats', ['items', row.id, 'awesome'], re.awesome === v ? '' : v);
            App.render();
          } }, v)))),
        h('table.grid', h('tr', h('th', 'Этап'), h('th', 'План, ч'), h('th', 'Заняло, ч'), h('th', 'Уложились?')), hours,
          h('tr', h('td', h('b', 'Итого')), h('td', h('b', Math.round(sumPlan * 10) / 10)), h('td', h('b', sumFact ? Math.round(sumFact * 10) / 10 : '')), h('td'))),
        h('div.row', { style: { margin: '10px 0' } }, 'Выход запланирован:', line(key, ['retro', 'planned'], { type: 'date', cls: 'box' }), 'Вышло:', line(key, ['retro', 'out'], { type: 'date', cls: 'box' }),
          d.project && h('button', { onclick: () => Plan.projStats(d) }, '📊 Цифры из проекта')),
        h('div.q2', REF.retroQ.map(q => h('div', h('label', q.label), area(key, ['retro', q.key], { ph: '…' }))))),
      h('section.card', h('div.card-head', h('h3', 'Реакция аудитории'), h('span.dim', 'после публикации')),
        h('div.q2', REF.reaction.map(q => h('div', h('label', q.icon + ' ' + q.label), area(key, ['reaction', q.key], { ph: 'вставь комментарий…' }))))),
      h('section.card', h('div.card-head', h('h3', 'Просмотры'), h('span.sp'), h('a', { href: '#/stats' }, 'весь трекер →')),
        row ? Plan.viewsRow(row, d.mode)
          : h('div.row', h('button.primary', { onclick: () => Plan.markOut(d) }, '✅ Ролик вышел — завести строку в трекере'), h('span.dim', 'статус станет «вышло», цифры заполнишь по мере прихода'))),
    ];
  },

  viewsRow(row, mode) {
    const cols = [...REF.views, ...REF.viewsExtra[mode]];
    return [
      h('div.row', 'Ссылка:', line('stats', ['items', row.id, 'url'], { ph: 'https://youtube.com/shorts/…', cls: 'box' }), 'Дата выхода:', line('stats', ['items', row.id, 'date'], { type: 'date', cls: 'box' })),
      h('table.grid', { style: { marginTop: '8px' } }, h('tr', cols.map(c => h('th', c.label))), h('tr', cols.map(c => h('td.num', line('stats', ['items', row.id, c.key], { cls: 'box' }))))),
    ];
  },

  markOut(d) {
    const key = 'plan:' + d.id, ft = (d.titles || []).find(t => t.id === (d.final || {}).title), id = uid('r');
    Store.add('stats', ['items'], { id, plan: d.id, name: ft ? ft.text : d.name, mode: d.mode, date: new Date().toISOString().slice(0, 10),
      awesome: (d.retro || {}).awesome || '', project: d.project || '' }, false);
    Store.set(key, ['stats'], id); Store.set(key, ['status'], 'out');
    if (!(d.retro || {}).out) Store.set(key, ['retro', 'out'], new Date().toISOString().slice(0, 10));
    App.render();
  },

  async projStats(d) {
    try {
      const s = await api('GET', '/api/projstats?name=' + encodeURIComponent(d.project));
      UI.modal('📊 Цифры из проекта «' + d.project + '»', h('div.sumgrid',
        h('b', 'Правки сценария'), h('span', `${s.script.all} (открыто ${s.script.open})`),
        h('b', 'Правки ролика'), h('span', `${s.review.all} (открыто ${s.review.open})`),
        h('b', 'Папка создана'), h('span', new Date(s.created).toLocaleString('ru-RU')),
        h('b', 'Последняя сборка'), h('span', s.built ? new Date(s.built).toLocaleString('ru-RU') : 'ещё не собран'),
        h('b', 'От папки до сборки'), h('span', s.days != null ? `${s.days} дн.` : '—')));
    } catch (e) { UI.toast(e.message, 'err'); }
  },
};
