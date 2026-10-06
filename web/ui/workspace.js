// Claude Studio — S12.3: рабочее окно видео #/v/<id> (docs/studio/stage12-redesign.md §5).
// Шапка · слева сцены и пайплайн · в центре превью по формату, транспорт и таймлайн · справа Claude (панель агента).
// Превью, звук и таймлайн — механика монтажа (montage.js: MT, MTA, MontagePreview, Montage.timeline); часы воспроизведения ведёт окно (скорость, loop, покадрово).
'use strict';

const WS = { rate: 1, loop: false, playing: false, raf: 0, t0: 0, p0: 0, muted: Local.get('ws-muted') === '1', opened: {}, snapBusy: false };
const FPS = 30;

const Workspace = {
  fmt(t) { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`; },

  // ---------------- страница ----------------
  page(d) {
    const key = 'plan:' + d.id;
    MT.d = d; MT.key = key; MT.driven = true;
    if (!WS.opened[d.id] && window.AgentPanel && !AgentPanel.open) { WS.opened[d.id] = true; setTimeout(() => AgentPanel.toggle(true), 0); }   // справа — Claude
    WS.opened[d.id] = true;
    if (d.project) { Montage.load(d); MTA.mute(WS.muted); MTA.warm(d); }
    const I = MT.info[d.id] || {}, M = Montage.M(d);
    // ролик Studio: при первом открытии окна — пересобрать файлы проекта (свежий движок и превью без своей полосы управления — &clean)
    // пустой монтаж не собираем — превью без сцен падает
    if (d.project && I.owned && (M.units || []).length && !(MT.autogen || (MT.autogen = {}))[d.id]) { MT.autogen[d.id] = true; I.generated = true; setTimeout(() => Montage.regen(), 0); }
    requestAnimationFrame(() => { this.fit(); this.pins(); this.liveOverlay(); });
    return h('div.ws', { class: d.mode === 'long' ? 'long' : 'short' },
      this.head(d, key),
      h('div.ws-main', { style: WSize.leftStyle() },
        h('aside.ws-left', this.left(d, M, I)),
        h('div.ws-split.left', { title: 'Тяните — шире / уже (двойной клик — как было)', onmousedown: ev => WSize.dragLeft(ev), ondblclick: () => WSize.reset('left') }),
        App.route.tab === 'pre' ? h('section.ws-center', Plan.preWs(d, key, App.route.sub)) : Panels.has(App.route.tab) ? h('section.ws-center', Panels.view(d, key, App.route.tab)) : h('section.ws-center',
          h('div.ws-stage', h('div.mt-prevslot.ws-slot'), this.overlay(d, M, I)),
          this.transport(d, M),
          h('div.ws-tl', { style: WSize.tlStyle() },
            h('div.ws-split.tl', { title: 'Тяните — таймлайн выше / ниже (двойной клик — как было)', onmousedown: ev => WSize.dragTl(ev), ondblclick: () => WSize.reset('tl') }),
            this.tlHead(d, M, I),
            d.project && MT.info[d.id] && !I.error ? h('div.mt-tl', Montage.timeline(d, M)) : h('div.ws-tl-empty', I.error ? '⚠ ' + I.error : d.project ? 'читаю монтаж…' : ''),
            h('div.mt-props', this.props(d, M))))));
  },

  head(d, key) {
    const model = window.AgentPanel ? AgentPanel.model : 'sonnet', I = MT.info[d.id] || {};
    return h('header.ws-head',
      line(key, ['name'], { cls: 'ws-name', title: 'Название видео' }),
      h('span.ws-saved', Icon('check', 13), h('span#ws-saved-t', 'сохранено локально')),
      h('span.sp'),
      (() => { const b = d.brief || {}, L = (typeof Styles !== 'undefined' ? Styles.looks() : REF.looks || []).find(x => x.key === b.look);   // S12.13: визуал ролика, как «Pixel art · Crisp 640» в референсе
        return L ? h('button.ws-look', { title: 'Визуал ролика (бриф): ' + (L.desc || ''), onclick: () => go(`#/v/${d.id}/brief`) }, Icon('palette', 14), L.label + (d.mode === 'long' ? ' · 16:9' : ' · 9:16')) : null; })(),
      h('label.ws-model', { title: 'Модель Claude для этого окна: Opus 5.5 — сборка и сложное, Sonnet 5.5 — быстрые правки' }, Icon('spark', 14),
        sel([{ value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5.5' }], model, v => { AgentPanel.model = v; Local.set('agent.model', v); App.render(); })),
      h('button.icon', { title: 'История: запуски Claude (что сделал, откатить), Ctrl+Z — откатить последнее', onclick: () => { AgentPanel.tab = 'history'; AgentPanel.toggle(true); } }, Icon('clock', 17)),
      h('button.icon', { disabled: !d.project, title: d.project ? 'Текст озвучки — скопировать диктору (с подсказками, как читать и записать)' : 'Текст озвучки появится, когда будет сценарий', onclick: () => Plan.actorText(d) }, Icon('mic', 17)),
      h('button.icon', { class: App.route.tab === 'brief' ? 'on' : '', title: 'Бриф: идея, контекст, референсы, ответы на вопросы', onclick: () => go(`#/v/${d.id}/brief`) }, Icon('book', 17)),
      h('button.icon', { title: 'Открыть папку видео', onclick: () => api('POST', '/api/videos/open', { id: d.id }).catch(e => UI.toast(e.message, 'err')) }, Icon('folder', 17)),
      h('button.primary.ws-export', { disabled: !d.project, title: d.project ? 'Экспорт: имя, .srt, главы — в out/ всё для YouTube' : 'Сначала проект ролика', onclick: () => ExportDlg.open(d) },
        Renders.of(d.id) ? h('span.spin') : Icon('download', 15), Renders.of(d.id) ? 'Рендер…' : 'Экспорт'));
  },

  // ---------------- слева: сцены + пайплайн ----------------
  left(d, M, I) {
    if (MSnd.panel && d.project) return [MSnd.panelEl(d)];        // S23: панель «🔊 Звуки» вместо сцен
    const units = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0)), cur = this.unitAt(M, MT.t);
    const open = Local.get('ws-scenes-open') === '1';               // список сцен — аккордеоном, по умолчанию свёрнут
    return [
      h('div.ws-sec.ws-acc', { title: open ? 'Свернуть список сцен' : 'Показать список сцен', onclick: () => { Local.set('ws-scenes-open', open ? '0' : '1'); this.onRedraw(); } },
        h('span.ws-acc-ar', open ? '▾' : '▸'), 'Сцены', units.length ? h('span.cnt', String(units.length)) : null),
      !open ? null : units.length ? h('div.ws-scenes', units.map((u, i) => {
        const sc = (I.scenes || []).find(s => s.el === u.scene) || {};
        return h('button.ws-scene', { class: (cur && cur.id === u.id ? 'on ' : '') + ((MT.multi || []).includes(u.id) ? 'sel' : ''), 'data-u': u.id,
          title: 'Клик — перейти, Ctrl / Shift — выбрать несколько, двойной клик — открыть сцену в редакторе',
          onclick: ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return Montage.pick('units', u.id, ev); this.seek(u.at || 0); },
          ondblclick: () => Montage.openAt(d, +((u.at || 0) + 0.05).toFixed(2)) },
          h('span.n', String(i + 1)), h('span.t', h('b', sc.name || u.scene), h('small', `${this.fmt(u.at || 0)} · ${(u.len || 0).toFixed(1)} с`)));
      })) : h('p.ws-hint', d.project ? 'Сцен пока нет — соберите видео с Claude: «Сделать» в пайплайне.' : 'Проект ролика ещё не создан.'),
      h('div.ws-sec', 'Пайплайн'),
      h('div.ws-pipe', this.steps(d, M, I).map(s => h('div.ws-step', { class: s.st, title: s.title || '' },
        h('span.ws-ico', { title: s.st === 'done' ? 'готово' : s.st === 'part' ? 'частично' : '' }, Icon(s.icon || 'hash', 15), s.st === 'done' && h('i.ok', Icon('check', 9))),
        h('span.lbl', s.label, s.sub ? h('small', s.sub) : null),
        s.btn && h('button.small', { class: s.primary ? 'primary' : '', disabled: !!s.off, onclick: s.btn }, s.act)))),
    ];
  },

  steps(d, M, I) {
    const id = d.id, has = !!d.project, scr = has ? Plan.scriptState(d) : {}, words = has ? Montage.words(d) : [];
    const vo = has ? (MT.info[d.id] || {}).voice : null, mute = !!(vo && (vo.sections || []).length && !words.length && vo.sections.every(s => s.silent));   // ролик без диктора: тайминги по таймкодам сцен
    const els = (d.elements || []).filter(e => e.status !== 'drop'), ok = els.filter(e => e.status === 'ok').length;
    const agent = (text, mode = 'chat', model = 'opus') => { AgentPanel.toggle(true); AgentPanel.say(text, { mode, model }); };
    const nav = tab => () => go(`#/v/${id}/${tab}`);
    const scriptWritten = has && scr.template === false;
    const bmWait = !!(typeof BeatMap !== 'undefined' && BeatMap.base(d)) && (d.beatmap || {}).status !== 'ok' && !scriptWritten;   // S16: сначала карта подачи по референсу
    const scriptDone = scriptWritten && !!(d.scriptOk || (d.montage && (d.montage.units || []).length) || (d.elements || []).some(e => e.status === 'ok'));   // S12.13: готов — когда автор утвердил (или уже ушёл дальше)
    // монтаж сделан по-настоящему: сохранён (не «по умолчанию» — локации подряд) и с юнитами; быстрый ролик — его код собран
    const made = !!(d.montage && ((d.montage.units || []).length || d.fast) && (!d.locations || (d.mscenes || []).length || (d.montage.units || []).some(u => String(u.scene || '').startsWith('ms'))));
    const steps = [
      { icon: 'pencil', label: 'Сценарий', sub: scriptWritten && !scriptDone ? 'написан — проверьте и утвердите' : bmWait ? (Claude.running('plan:' + id, 'beatmap') ? '📐 Claude раскладывает референс…' : (d.beatmap || {}).beats ? '📐 карта подачи — проверьте и утвердите' : '📐 по референсу: сначала карта подачи') : '',
        st: scriptDone ? 'done' : scriptWritten || (bmWait && (d.beatmap || {}).beats) ? 'part' : '',
        act: scriptWritten ? 'Открыть' : bmWait ? 'Карта подачи' : 'Написать', primary: !scriptDone,
        btn: scriptWritten ? () => ScriptWin.open(d) : () => this.writeScript(d),
        title: scriptDone ? 'Раскадровка: текст сцен, правки, фактчек' : d.brief ? 'Claude: ресерч и сценарий по брифу (проект ролика создастся сам)' : 'Сначала бриф и вопросы Claude — потом сценарий' },
      { icon: 'mic', label: 'Озвучка', sub: mute ? 'без диктора — по сценарию' : words.length ? '' : 'черновой голос или своя запись', st: words.length || mute ? 'done' : '', act: mute ? 'Открыть' : words.length ? 'Заменить' : 'Добавить', btn: nav('voice'), off: !scriptDone,
        title: mute ? 'В сценарии нет закадрового текста — голос не нужен. Реплики героев — звериная речь в панели «Озвучка»' : '' },
      { icon: 'clock', label: 'Тайминги', sub: words.length ? `${words.length} слов` : mute ? `по таймкодам · ${vo.sections.length} сцен` : '', st: words.length || mute ? 'done' : '', act: words.length || mute ? 'Повторить' : 'Запустить', btn: nav('voice'), off: !scriptDone,
        title: 'Слова голоса по времени: из них субтитры и привязка сцен к словам' },
      { icon: 'users', label: 'Препродакшен', sub: els.length ? `${ok} из ${els.length} утверждено` : '', st: els.length && ok === els.length ? 'done' : els.length ? 'part' : '', act: App.route.tab === 'pre' ? 'Открыт' : 'Открыть',
        btn: () => go(`#/v/${id}/pre`), off: App.route.tab === 'pre' && !App.route.sub },
      { icon: 'clapper', label: 'Монтаж', sub: d.fast && MT.clips && MT.clips.fast && MT.clips.agent ? '⚡ Claude делает ролик…' : d.fast && MT.clips && MT.clips.fast && MT.clips.job ? (MT.clips.job.summary || 'собираю ролик…') : Claude.running('plan:' + id, 'automontage') ? (Claude.running('plan:' + id, 'automontage').summary || 'идёт…') : (M.units || []).length || (d.fast && M.len) ? `${(M.len || 0).toFixed(1)} с` : '', st: d.montage && ((M.units || []).length || d.fast) ? 'done' : '', act: d.montage ? 'Пересобрать' : 'Сделать', primary: !d.montage && has, off: !has || I.owned === false,
        btn: () => this.make(d), title: 'Монтаж в прямом эфире: сцены сразу встают по сценарию, Claude доводит их по одной — смотрите и пишите правки по ходу',
        ...this.makeRunning(d) },
      { icon: 'link', label: 'Синхронизация', sub: (d.sync || {}).at ? 'шаги, звуки, анимации' : '', st: (d.sync || {}).at ? 'done' : '', act: (d.sync || {}).at ? 'Повторить' : 'Запустить', off: !has || !made,
        btn: () => agent(`🔊 Шаг «Синхронизация»: соедини ассеты препродакшена со сценами и голосом — шаги персонажей к касаниям ног, звуки к действиям и маркерам сцен, анимации, которые персонажи умеют, там, где их требует сценарий или «Для финала», музыку под смысловые блоки (montage: music, приглушить под голос). Потом montage gen и проверь кадрами (montage snap). В конце — список «сцена · момент · что привязал». ВАЖНО: если монтажа ещё нет (montage brief пишет «монтаж по умолчанию» или в сценах нет действия — одни локации подряд), НИЧЕГО не сохраняй (set montage / sync не трогай) и ответь, что сначала нужен шаг «Монтаж». Когда закончишь: set plan:${id} sync '{"at": ${Date.now()}}'`, 'montage'),
        title: made ? 'Claude привязывает звуки и анимации к действиям в сценах' : 'Сначала «Монтаж»: синхронизация привязывает звуки и анимации к готовым сценам монтажа' },
      (() => {                                                // S21 🛡 сторож: проверить ролик (застревания, рывки, мерцание; 3D + готовый mp4) — без Claude
        const g = d.guard, open = window.AgentPanel ? AgentPanel.openGuard(d).length : (g || {}).n || 0, busy = this.guardBusy === id;
        const when = g && g.at ? new Date(g.at * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return { icon: 'shield', label: 'Сторож', sub: busy ? 'проверяю… (20–60 с)' : g ? (open ? `замечаний ${open} · ${when}` : `чисто · ${when}`) : '',
          st: g && !open ? 'done' : g ? 'part' : '', act: busy ? 'Проверяю…' : g ? 'Проверить снова' : 'Проверить', off: !has || busy,
          btn: () => this.guardRun(d),
          title: 'Сторож ролика: персонажи и предметы не входят друг в друга, не пропадают рывком, ничего не мерцает (3D — по сценам, мерцание — по собранному mp4). Без Claude; находки — строкой «Сторож» на таймлайне и во вкладке «Правки»' };
      })(),
      { icon: 'package', label: 'Упаковка', sub: (d.pack || {}).titles ? 'название и описание' : '', st: (d.pack || {}).titles ? 'done' : '', act: 'Открыть', btn: nav('pack') },
    ];
    return steps;
  },

  // 🛡 сторож — одна проверка на видео за раз (пайплайн и кнопка на таймлайне)
  async guardRun(d) {
    if (this.guardBusy) return;
    this.guardBusy = d.id; App.render(); Montage.status('🛡 сторож проверяет ролик…');
    try {
      const r = await api('POST', '/api/montage/guard', { video: d.id });
      UI.toast(r.n ? `🛡 Сторож: замечаний ${r.n}${r.bad ? `, серьёзных ${r.bad}` : ''} — во вкладке «Правки» и строкой «Сторож» на таймлайне` : '🛡 Сторож: чисто');
    } catch (e) { UI.toast(e.message, 'err'); }
    finally { this.guardBusy = null; Montage.status(''); App.render(); }
  },

  // монтаж уже идёт (⚡ быстрый: задача или сводка Claude; автомонтаж): вместо «Сделать» — «Идёт» с остановкой, а не второй запуск
  makeRunning(d) {
    const key = 'plan:' + d.id, c = MT.clips && MT.clips.fast ? MT.clips : null;
    const job = Claude.running(key, 'fastmontage') || Claude.running(key, 'automontage') || (c && c.job && c.job.kind === 'fastmontage' ? c.job : null);
    const agent = !job && c && c.agent;
    if (!job && !agent) return {};
    return { act: 'Стоп', primary: false, off: false, st: 'part', title: 'Монтаж идёт — шаги в панели Claude справа. «Стоп» — остановить (написанные сцены останутся)',
      btn: async () => {
        if (!confirm('Остановить монтаж? Написанные сцены останутся в проекте.')) return;
        try { if (job) await api('POST', '/api/job/cancel?id=' + job.id); else await api('POST', '/api/agent/stop', { video: d.id }); UI.toast('Останавливаю…'); } catch (e) { UI.toast(e.message, 'err'); }
      } };
  },

  // «Написать сценарий»: нет брифа (видео заведено до поп-апа) — поп-ап «Бриф → вопросы»; нет проекта — проект, потом сразу Claude (S12.13)
  writeScript(d) {
    if (d.stage === 'brief') return NewVideo.resume(d);                  // бриф не закончен — вопросы Claude
    if (!d.brief) return NewVideo.openFor(d);
    if (typeof BeatMap !== 'undefined' && BeatMap.base(d) && (d.beatmap || {}).status !== 'ok') return this.beatmap(d);   // S16: по референсу — сначала карта подачи
    const say = () => { AgentPanel.toggle(true); AgentPanel.say('📝 Напиши сценарий по этому видео: сначала мои референсы (ref list → неразобранные разобрать → прочитать расшифровки целиком), потом ресерч темы (источники → research.md), потом сценарий по брифу, ответам на вопросы и препродакшену. Потом montage check и montage tts.', { mode: 'script', model: 'opus' }); };
    if (d.project) return say();
    UI.toast('Кладу проект ролика в папку видео — потом Claude начнёт сценарий');
    Claude.run({ action: 'produce', key: 'plan:' + d.id, params: { id: d.id, name: d.name }, onResult: () => Store.load('plan:' + d.id, true).then(say) });
  },

  // S16: проект ролика (если нет) -> окно «Сценарий» на вкладке «📐 Карта подачи»; карты нет — Claude раскладывает референс
  beatmap(d) {
    const key = 'plan:' + d.id;
    const open = () => {
      const dd = Store.get(key) || d;
      if (!((dd.beatmap || {}).beats || []).length && !Claude.running(key, 'beatmap')) Claude.run({ action: 'beatmap', key });
      ScriptWin.open(dd, 'beatmap');
    };
    if (d.project) return open();
    UI.toast('Кладу проект ролика в папку видео — потом Claude разложит референс подачи');
    Claude.run({ action: 'produce', key, params: { id: d.id, name: d.name }, onResult: () => Store.load(key, true).then(open) });
  },

  // ---------------- 🎞 монтаж в прямом эфире (S12.7) ----------------
  async make(d) {
    const M = Montage.M(d);
    const ready = (d.elements || []).some(e => e.kind === 'scene' && e.status !== 'drop' && (e.stage || {}).work);   // сцены / локации редактора уже нарисованы
    if (d.fast && d.montage) {                                // быстрый ролик уже есть: заново с нуля (старый код — в архив) или только пересобрать текущий код
      const redo = confirm('Сделать монтаж ЗАНОВО — по сценарию и текущему препродакшену?\nСтарый ролик и его код уйдут в архив (_archive/fast).\n\nОК — сделать заново · Отмена — только пересобрать текущий ролик');
      if (redo) {
        const wish = prompt('Пожелания к новому монтажу (можно пусто):', '');
        if (wish === null) return;
        try { await api('POST', '/api/montage/redo', { video: d.id, wish }); AgentPanel.toggle(true); UI.toast('⚡ Монтаж заново: план → сцены параллельно → сводка'); } catch (e) { UI.toast(e.message, 'err'); }
        return;
      }
      try { await api('POST', '/api/clips/render', { video: d.id }); UI.toast('Пересобираю ролик…'); } catch (e) { UI.toast(e.message, 'err'); }
      return;
    }
    if (!d.fast && !ready && !(M.units || []).length) {     // S22: по умолчанию — препродакшен, потом монтаж на согласованных локациях (быстрый монтаж автору не нравится)
      if (confirm('Локации ещё не нарисованы — монтаж собирается из согласованного препродакшена.\nОткрыть препродакшен?')) location.hash = `#/v/${d.id}/pre`;
      return;
    }
    if (d.fast) {                                             // ⚡ быстрый монтаж (только у видео, которые уже сделаны так): ролик кодом по сценарию
      const wish = prompt('⚡ Быстрый монтаж: Claude сделает ролик сразу по сценарию — кодом, сцены параллельно (обычно 10–20 мин).\nЧто есть в препродакшене — возьмёт, остальное нарисует сам и потом занесёт в препродакшен.\nПравки — в чате и пинами по ходу.\n\nПожелания (можно пусто):', '');
      if (wish === null) return;
      try { await api('POST', '/api/montage/fast', { video: d.id, wish }); AgentPanel.toggle(true); AgentPanel.tab = 'chat'; UI.toast('⚡ Пошло: план и общий код → сцены пишутся параллельно → Claude сводит в панели справа'); }
      catch (e) { UI.toast(e.message, 'err'); }
      return;
    }
    if (!(d.montage && (M.units || []).length)) {         // каркас за секунды — все сцены на своих местах, Claude доводит дальше
      try {
        UI.toast('⚡ Раскладываю сцены по сценарию…');
        await api('POST', '/api/montage/auto', { video: d.id });
        await Store.load('plan:' + d.id, true); delete MT.info[d.id]; Montage.load(d, true);
        await Montage.regen();
      } catch (e) { UI.toast('Каркас не собрался: ' + e.message + ' — Claude начнёт с нуля', 'err'); }
    }
    AgentPanel.toggle(true); AgentPanel.tab = 'chat';
    AgentPanel.say('🎞 Смонтируй ролик в прямом эфире: каркас уже стоит, иди по секциям голоса по порядку, перед каждой — live, после — montage gen (я смотрю превью). Пожелания и правки напишу по ходу.', { mode: 'montage', model: 'opus' });
  },
  // заглушка в кадре: секция без сцены (название + текст голоса) и плашка «Claude собирает…»
  liveOverlay() {
    const d = MT.d, st = $('.ws-stage');
    if (!d || !st) return;
    if (d.fast) { const o = st.querySelector('.ws-live'); if (o) o.remove(); return; }   // ⚡ быстрый ролик: сцены — код проекта, «дыр» монтажа у него нет (превью само показывает недописанные)
    const M = Montage.M(d), I = MT.info[d.id] || {}, holes = Montage.holes(d, M);
    const hole = holes.find(x => x.empty && MT.t >= x.a - 1e-3 && MT.t < x.b), live = holes.find(x => x.live);
    const sig = (hole ? hole.i : '-') + '|' + (live ? live.i + live.note : '-');
    let ov = st.querySelector('.ws-live');
    if (ov && ov.dataset.sig === sig) return;
    if (ov) ov.remove();
    if (!hole && !live) return;
    const words = hole ? Montage.words(d).filter(w => w.t >= hole.a - 0.01 && w.t < hole.b).map(w => w.w).join(' ') : '';
    ov = h('div.ws-live', { 'data-sig': sig },
      live && h('div.ws-livebadge', h('span.spin'), ` Claude собирает · сцена ${live.i + 1}` + (live.note ? ' · ' + live.note : '')),
      hole && h('div.ws-hole', h('small', `Сцена ${hole.i + 1} · сцены ещё нет`), h('b', hole.title || 'без названия'), words && h('p', '«' + words + '»')));
    st.append(ov);
  },
  // ---------------- центр: превью ----------------
  overlay(d, M, I) {
    if (!d.project) return h('div.ws-over', h('div.es-ico', Icon('clapper', 24)), h('b', 'Проекта ролика ещё нет'),
      Claude.running('plan:' + d.id, 'produce') ? h('p', h('span.spin'), ' кладу шаблон и ставлю зависимости…')
        : h('button.primary', { onclick: () => Claude.run({ action: 'produce', key: 'plan:' + d.id, params: { id: d.id, name: d.name } }) }, 'Создать проект'));
    if (I.owned === false) return h('div.ws-badge', 'Рукописный ролик: монтаж Studio его не меняет');
    if (MT.info[d.id] && !(M.units || []).length && !d.fast) return h('div.ws-over.soft', h('b', 'Сцен пока нет'), h('p', 'Соберите видео с Claude — «Сделать» в пайплайне слева.'));
    return null;
  },
  fit() {                                                 // превью вписывается в центр по формату: 9:16 или 16:9
    const st = $('.ws-stage'), slot = $('.ws-slot');
    if (!st || !slot) return;
    const r = st.getBoundingClientRect(), long = !!$('.ws.long'), A = long ? 16 / 9 : 9 / 16, pad = 12;
    let H = r.height - pad * 2, W = H * A;
    if (W > r.width - pad * 2) { W = r.width - pad * 2; H = W / A; }
    Object.assign(slot.style, { width: Math.max(10, W) + 'px', height: Math.max(10, H) + 'px' });
  },

  // ---------------- транспорт ----------------
  transport(d, M) {
    const u = this.unitAt(M, MT.t), I = MT.info[d.id] || {}, sc = u && (I.scenes || []).find(s => s.el === u.scene);
    const units = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    const jump = dir => { const t = MT.t, list = units.map(x => x.at || 0); const n = dir < 0 ? list.filter(a => a < t - 0.05).pop() : list.find(a => a > t + 0.05); this.seek(n != null ? n : dir < 0 ? 0 : M.len || 0); };
    return h('div.ws-transport',
      h('button.icon', { title: 'К началу сцены (Home — к началу ролика)', onclick: () => jump(-1) }, Icon('skipback', 17)),
      h('button.icon.ws-play', { title: 'Играть / пауза (пробел)', onclick: () => (WS.playing ? this.pause() : this.play()) }, Icon(WS.playing ? 'pause' : 'play', 19)),
      h('button.icon', { title: 'К следующей сцене', onclick: () => jump(1) }, Icon('skipfwd', 17)),
      h('span.ws-time', h('b.mt-time', this.fmt(MT.t)), h('span.dim', ' / ' + this.fmt(M.len || 0))),
      h('span.ws-scname', u ? `Сцена ${units.indexOf(u) + 1} · ${(sc && sc.name) || u.scene}` : ''),
      h('span.sp'),
      h('button.icon.ws-fstep', { title: 'Кадр назад (←), Shift — на секунду', onclick: () => this.seek(MT.t - 1 / FPS) }, Icon('chevl', 16)),
      h('button.icon.ws-fstep', { title: 'Кадр вперёд (→), Shift — на секунду', onclick: () => this.seek(MT.t + 1 / FPS) }, Icon('chevr', 16)),
      h('button.icon', { title: 'Снимок кадра → out/shots/', disabled: WS.snapBusy || !d.project, onclick: () => this.snap(d) }, WS.snapBusy ? h('span.spin') : '📷'),
      h('button.icon', { class: WS.muted ? 'on' : '', title: WS.muted ? 'Включить звук' : 'Выключить звук', onclick: () => { WS.muted = !WS.muted; Local.set('ws-muted', WS.muted ? '1' : '0'); MTA.mute(WS.muted); this.redrawTransport(); } }, WS.muted ? '🔇' : '🔊'),
      h('button.icon', { class: WS.loop ? 'on' : '', title: 'Повтор: выбранные сцены или весь ролик', onclick: () => { WS.loop = !WS.loop; this.redrawTransport(); } }, '🔁'),
      h('div.seg.ws-rate', [0.5, 1, 1.5, 2].map(r => h('button', { class: WS.rate === r ? 'sel' : '', title: r === 1 ? 'Обычная скорость' : 'Скорость ' + r + '× (звук — только на 1×)',
        onclick: () => { WS.rate = r; if (WS.playing) this.play(); this.redrawTransport(); } }, r + '×'))));
  },
  redrawTransport() { const t = $('.ws-transport'); if (t && MT.d) t.replaceWith(this.transport(MT.d, Montage.M(MT.d))); },

  // ---------------- таймлайн: шапка и свойства ----------------
  tlHead(d, M, I) {
    const add = (list, item) => { const N = Montage.clone(M); (N[list] = N[list] || []).push(item); MT.sel = { list, id: item.id }; Montage.save(N); };
    const at = +MT.t.toFixed(2), src0 = (I.sources || [])[0];
    const can = d.project && I.owned !== false && MT.info[d.id];
    return h('div.ws-tlhead',
      h('b', 'Таймлайн'), h('span.ws-hint', 'Клик — выбрать · Ctrl / Shift — несколько сцен · тянуть линейку — перемотка · двойной клик по сцене — редактор'),
      h('span.sp'),
      can && [
        h('button.small', { class: MSnd.panel ? 'on' : '', title: 'Звуки: библиотека, канал, видео, интернет — перетаскивайте на дорожки (S23)', onclick: () => MSnd.toggle() }, '🔊 Звуки'),
        h('button.small', { onclick: () => add('overlays', { id: uid('ov'), at, dur: 3, kind: 'pov', text: 'POV: …' }) }, '+ надпись'),
        h('label.ws-chk', h('input', { type: 'checkbox', checked: !!(M.voice || {}).on, disabled: !Montage.words(d).length, onchange: ev => { const N = Montage.clone(M); N.voice = { on: ev.target.checked }; Montage.save(N); } }), 'голос'),
        h('label.ws-chk', h('input', { type: 'checkbox', checked: !!(M.captions || {}).on, disabled: !Montage.words(d).length, onchange: ev => { const N = Montage.clone(M); N.captions = { on: ev.target.checked }; Montage.save(N); } }), 'субтитры')],
      h('span.mt-status.dim.small', MT.statusTxt || ''),
      d.project && h('button.small', { title: 'Сторож (S21): застревания, рывки, мерцание — 3D по сценам и собранный mp4. Без Claude, 20–60 с; находки — строкой «Сторож» и во вкладке «Правки»',
        disabled: this.guardBusy === d.id, onclick: () => this.guardRun(d) }, this.guardBusy === d.id ? '🛡 Проверяю…' : '🛡 Сторож'),
      h('button.icon', { title: 'Мельче (клавиша −; Ctrl / Alt + колесо — вокруг курсора)', onclick: () => TLZoom.at(1 / 1.4, null) }, '−'),
      h('button.icon', { title: 'Крупнее (клавиша =; Ctrl / Alt + колесо — вокруг курсора)', onclick: () => TLZoom.at(1.4, null) }, '+'),
      h('button.icon', { title: 'Таймлайн выше / ниже (или тяните его верхний край)', onclick: () => { WSize.reset('tl'); document.body.classList.toggle('ws-tl-big'); requestAnimationFrame(() => this.fit()); } }, '⤢'));
  },
  props(d, M) {
    if (TLSel.kind === 'clips') return MSnd.props(d, M);           // S23: выбранные звуки
    const n = (MT.multi || []).length;
    if (n > 1) return h('div.ws-multi', h('b', `Выбрано сцен: ${n}`), h('span.dim', ' — опишите правку для них в чате Claude справа (переход между ними, общий ассет…); Esc — снять выбор.'));
    if (!MT.sel) return null;
    return Montage.props(d, M);
  },

  // ---------------- хуки montage.js ----------------
  onRedraw() {
    const d = MT.d; if (!d) return;
    const M = Montage.M(d), I = MT.info[d.id] || {};
    const L = $('.ws-left'); if (L) keepScroll(L, () => L.replaceChildren(...[this.left(d, M, I)].flat(Infinity).filter(x => x instanceof Node)));
    const P = $('.ws-tl .mt-props'); if (P) keepScroll(P, () => P.replaceChildren(...[this.props(d, M)].flat().filter(x => x instanceof Node)));
  },
  onTime() {
    const d = MT.d; if (!d) return;
    const M = Montage.M(d), u = this.unitAt(M, MT.t);
    this.pins();
    this.liveOverlay();
    if ((u && u.id) !== this.curU) {
      this.curU = u && u.id;
      $$('.ws-scene').forEach(b => b.classList.toggle('on', b.dataset.u === this.curU));
      const n = $('.ws-scname'), I = MT.info[d.id] || {}, units = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
      if (n) n.textContent = u ? `Сцена ${units.indexOf(u) + 1} · ${((I.scenes || []).find(s => s.el === u.scene) || {}).name || u.scene}` : '';
    }
  },
  // время ролика -> время сцены (обратная карта юнита)
  v2s(d, u, tv) {
    const P = Montage.pairs(d, u);
    if (!P.length) return tv - (u.at || 0);
    if (tv <= P[0][1]) return P[0][0] + (tv - P[0][1]);
    for (let i = 0; i < P.length - 1; i++) { const [a0, b0] = P[i], [a1, b1] = P[i + 1]; if (tv <= b1) return a0 + (a1 - a0) * (tv - b0) / ((b1 - b0) || 1); }
    const L = P[P.length - 1]; return L[0] + (tv - L[1]);
  },

  // ---------------- Ctrl+Z: ручные правки монтажа и запуски Claude ----------------
  track(prev) { (WS.undo = WS.undo || []).push({ M: prev, ts: Date.now() }); if (WS.undo.length > 60) WS.undo.shift(); WS.redo = []; },
  // правки (пометки на кадре): действие = снимок notes до него в общий стек Ctrl+Z; обновляются только дорожка правок, точки на кадре и вкладка «Правки»
  notesNow() { return JSON.parse(JSON.stringify((Store.get(MT.key) || {}).notes || [])); },
  noteEdit(label, fn) {
    if (!MT.d) return;
    const prev = this.notesNow();
    fn(MT.key);
    (WS.undo = WS.undo || []).push({ N: prev, label, ts: Date.now() }); if (WS.undo.length > 60) WS.undo.shift(); WS.redo = [];
    this.notesRefresh();
  },
  notesRestore(N) { Store.set(MT.key, ['notes'], N); this.notesRefresh(); },
  notesRefresh() {
    const ov = MontagePreview.host && MontagePreview.host.querySelector('.pv-pins');
    if (ov) ov.dataset.sig = '';
    this.pins();
    Montage.refreshNotes();
    if (typeof AgentPanel !== 'undefined' && AgentPanel.open && AgentPanel.tab === 'notes') AgentPanel.draw();
    else if (typeof AgentPanel !== 'undefined' && AgentPanel.el) { const t = AgentPanel.el.querySelector('.ag-tabs'); if (t) AgentPanel.draw(); }   // счётчик «Правки N» во вкладках
  },
  async undoLast() {
    const local = (WS.undo || [])[WS.undo ? WS.undo.length - 1 : -1], run = AgentPanel.lastRun();
    if (local && (!run || local.ts > run.ts)) {
      WS.undo.pop();
      if (local.N) {
        (WS.redo = WS.redo || []).push({ N: this.notesNow(), label: local.label, ts: Date.now() });
        this.notesRestore(local.N); UI.toast('↶ отменил: ' + (local.label || 'правка пометки'));
        return;
      }
      if (local.SC) { (WS.redo = WS.redo || []).push(await MSnd.sceneUndo(local)); UI.toast('↶ отменил: ' + (local.label || 'звук сцены')); return; }   // S23: звуки сцен
      (WS.redo = WS.redo || []).push({ M: Montage.clone(Montage.M(MT.d)), ts: Date.now() });
      this.restore(local.M); UI.toast('↶ отменил правку монтажа');
      return;
    }
    if (run) { if (await AgentPanel.undo(run.run, null, true)) UI.toast('↶ откатил запуск Claude'); return; }
    UI.toast('Нечего отменять');
  },
  redoLast() {
    const r = (WS.redo || []).pop();
    if (!r) return UI.toast('Нечего вернуть');
    if (r.N) {
      (WS.undo = WS.undo || []).push({ N: this.notesNow(), label: r.label, ts: Date.now() });
      this.notesRestore(r.N); UI.toast('↷ вернул: ' + (r.label || 'правка пометки'));
      return;
    }
    if (r.SC) { MSnd.sceneUndo(r).then(x => { (WS.undo = WS.undo || []).push(x); UI.toast('↷ вернул: ' + (r.label || 'звук сцены')); }); return; }
    (WS.undo = WS.undo || []).push({ M: Montage.clone(Montage.M(MT.d)), ts: Date.now() });
    this.restore(r.M); UI.toast('↷ вернул правку монтажа');
  },
  restore(M) {
    const d = MT.d, key = MT.key;
    Store.set(key, ['montage'], M, false);
    Montage.redraw();
    clearTimeout(MT.genTimer); MT.genTimer = setTimeout(() => Montage.regen(), 500);
  },

  // ---------------- пометки (правки) на кадре: курсор-крестик над превью, карточка правки ----------------
  // пометка: { id, t, t2?, x, y, text, refs?: ['files/<видео>/N.png'], status: open|done } — t2: конец отрезка «с … по …» (нет — один кадр)
  holding() { return !!document.querySelector('.pv-card') || document.body.classList.contains('mt-dragging') || document.body.classList.contains('mt-scrubbing'); },
  notesOpen(d) { return ((Store.get('plan:' + d.id) || {}).notes || []).filter(n => (n.status || 'open') === 'open'); },
  pins() {
    const host = MontagePreview.host, d = MT.d;
    if (!host || !d || App.route.page !== 'v' || !host.classList.contains('clean')) return;
    let ov = host.querySelector('.pv-pins');
    if (!ov) {
      ov = h('div.pv-pins', { title: 'Клик — правка на этом кадре (что поправить)', onmousedown: ev => { if (ev.target === ov) this.newPin(ev); } });
      host.append(ov);
    }
    // точка на кадре — ровно пока плейхед на полосе правки (то же правило, что у таймлайна: отрезок t–t2, правка в кадр — 0,4 с), номер — как на таймлайне
    const all = this.notesOpen(d).sort((a, b) => a.t - b.t), num = new Map(all.map((n, i) => [n.id, i + 1]));
    const near = all.filter(n => MT.t >= n.t - 0.02 && MT.t <= (n.t2 != null ? n.t2 : n.t + 0.4) + 0.02);
    const sig = near.map(n => n.id + ':' + (n.text || '').length + ':' + (n.refs || []).length).join(',');
    if (ov.dataset.sig === sig) return;
    ov.dataset.sig = sig;
    ov.querySelectorAll('.pv-dot:not(.new)').forEach(x => x.remove());
    near.forEach((n, i) => ov.append(h('div.pv-dot', { class: [(n.refs || []).length ? 'has-ref' : '', n.global ? 'glob' : ''].join(' ').trim(), style: { left: n.x * 100 + '%', top: n.y * 100 + '%' },
      title: n.text + ((n.refs || []).length ? ` · картинок: ${n.refs.length}` : '') + ' — клик: открыть',
      onmousedown: ev => { ev.stopPropagation(); this.pinCard(n); } }, String(num.get(n.id)))));
  },
  newPin(ev) {
    if (WS.playing) this.pause();
    const r = ev.currentTarget.getBoundingClientRect();
    this.pinCard(null, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  },
  // открыть пометку из списка / таймлайна: перейти к её кадру и показать карточку
  editPin(n) { this.seek(n.t); setTimeout(() => { this.pins(); this.pinCard(n); }, 120); },
  parseT(s) {
    s = String(s || '').trim().replace(',', '.');
    if (!s) return null;
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s);
    return m ? (+(m[1] || 0)) * 60 + +m[2] : NaN;
  },
  // карточка правки — новая (n = null, x/y — точка клика) или существующая: текст (несколько строк), отрезок «с … по …», картинки-референсы
  pinCard(n, x, y) {
    const host = MontagePreview.host, d = MT.d;
    if (!host || !d) return;
    if (!host.querySelector('.pv-pins')) this.pins();
    const ov = host.querySelector('.pv-pins');
    if (!ov) return;
    ov.querySelectorAll('.pv-pop, .pv-dot.new').forEach(p => p.remove());
    document.querySelectorAll('.pv-card').forEach(p => p.remove());
    if (WS.playing) this.pause();
    const key = 'plan:' + d.id, vid = d.id, edit = !!n;
    if (edit) { x = n.x; y = n.y; }
    const refs = [...((n && n.refs) || [])], assets = [...((n && n.assets) || [])];
    const chips = h('div.pv-assets');
    const redrawA = () => chips.replaceChildren(...assets.map(a => AssetPick.chip(a, () => { assets.splice(assets.indexOf(a), 1); redrawA(); })));
    let paste = null, card = null, dot = null;
    const close = () => { card.remove(); dot.remove(); if (Paste.target === paste) Paste.target = null; ov.dataset.sig = ''; this.pins(); setTimeout(() => App.resume(), 0); };
    const thumbs = h('div.pv-refs');
    const redraw = () => thumbs.replaceChildren(...refs.map(p => h('span.ag-img', h('img', { src: '/' + p, alt: '', onclick: () => UI.lightbox('/' + p) }),
      h('button.x', { type: 'button', title: 'Убрать', onclick: () => { refs.splice(refs.indexOf(p), 1); redraw(); } }, '×'))));
    paste = async f => {
      try { refs.push(typeof f === 'string' && !f.startsWith('data:') ? await uploadImageUrl(vid, f) : await uploadImage(vid, f)); redraw(); }
      catch (e) { UI.toast(e.message, 'err'); }
    };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.4) + 'px'; };
    const ta = h('textarea.box', { rows: 4, placeholder: 'Что поправить? Можно подробно, в несколько строк.\nEnter — сохранить · Shift+Enter — новая строка · Ctrl+V — картинка · Esc — закрыть',
      onfocus: () => (Paste.target = paste), oninput: grow,
      onkeydown: e => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } } });
    ta.value = (n && n.text) || '';
    const len = h('small.dim');
    // S22: «на весь ролик» — правка становится правилом ролика: Claude применяет её ко ВСЕМ сценам и держит в каждой следующей правке (автор: «Гейб выше» писал 4 раза)
    let glob = !!(n && n.global);
    const globBtn = h('button.small.pv-glob', { type: 'button', title: 'Правка на весь ролик: Claude применит её ко всем сценам и будет соблюдать дальше (как правило ролика)',
      onclick: () => { glob = !glob; globBtn.classList.toggle('on', glob); } }, '🌐 На весь ролик');
    globBtn.classList.toggle('on', glob);
    const GLOBAL_WORDS = /по\s+всему\s+(видео|ролику)|глобальн|во\s+всех\s+сценах|везде\s+в\s+ролике|по\s+всему\s+ролик/i;
    const span = () => { const a = this.parseT(tIn.value), b = this.parseT(t2In.value); len.textContent = a != null && b != null && b > a ? `${(b - a).toFixed(1)} с` : ''; };
    const tIn = h('input.box.pv-t', { value: this.fmt(n ? n.t : MT.t), title: 'Начало: 0:12.40 или 12.4', onkeydown: e => e.stopPropagation(), oninput: () => span() });
    const t2In = h('input.box.pv-t', { value: n && n.t2 != null ? this.fmt(n.t2) : '', placeholder: 'один кадр', title: 'Конец отрезка (пусто — один кадр)', onkeydown: e => e.stopPropagation(), oninput: () => span() });
    span();
    const save = () => {
      const text = ta.value.trim() || (assets.length ? 'вставь этот ассет сюда' : refs.length ? 'сделай как на картинке' : '');
      if (!text) { ta.focus(); return; }
      const a = this.parseT(tIn.value), b = this.parseT(t2In.value);
      if (a == null || isNaN(a)) { UI.toast('Начало — время вида 0:12.40 или 12.4', 'err'); tIn.focus(); return; }
      if (Number.isNaN(b) || (b != null && b <= a)) { UI.toast('Конец должен быть позже начала (или пусто — один кадр)', 'err'); t2In.focus(); return; }
      if (!glob && GLOBAL_WORDS.test(text)) { glob = true; UI.toast('🌐 Отметил как правку на весь ролик — по словам в тексте'); }
      const f = { t: +a.toFixed(2), t2: b == null ? null : +b.toFixed(2), text, refs: [...refs], assets: [...assets], global: glob };
      close();
      if (edit) { this.noteEdit('правка пометки', k => { for (const [kk, v] of Object.entries(f)) Store.set(k, ['notes', n.id, kk], v); }); UI.toast('✓ Правка обновлена · Ctrl+Z — отменить'); }
      else { this.noteEdit('новая пометка', k => Store.add(k, ['notes'], { id: uid('n'), ...f, x: +x.toFixed(3), y: +y.toFixed(3), status: 'open', created: Date.now() }, false)); UI.toast('✛ Правка сохранена · Ctrl+Z — отменить'); }
    };
    const btn = (label, title, on, cls = '') => h('button.small' + cls, { type: 'button', title, onclick: on }, label);
    card = h('div.pv-pop.pv-card', { onmousedown: e => e.stopPropagation(),
        ondragover: e => { if (hasFiles(e) || hasImgUrl(e)) e.preventDefault(); },
        ondrop: e => { const fs = imageFiles(e.dataTransfer), u = !fs.length && dropImageUrl(e.dataTransfer); if (fs.length || u) { e.preventDefault(); e.stopPropagation(); fs.length ? fs.forEach(paste) : paste(u); } } },
      h('div.pv-head', h('b', edit ? 'Правка' : 'Новая правка'), h('span.sp'), h('button.icon', { type: 'button', title: 'Закрыть (Esc)', onclick: close }, '×')),
      ta,
      h('div.pv-time', h('span.dim', 'с'), tIn, btn('⇤ сейчас', 'Начало = кадр под курсором', () => { tIn.value = this.fmt(MT.t); span(); }),
        h('span.dim', 'по'), t2In, btn('сейчас ⇥', 'Конец = кадр под курсором: промотайте таймлайн до конца проблемы и нажмите', () => { t2In.value = this.fmt(MT.t); span(); }), len),
      h('div.pv-refrow', thumbs, btn('📎 файл', 'Приложить картинку с диска (или Ctrl+V в поле, или перетащить сюда)', () => pickFiles(fs => fs.forEach(paste))),
        btn('🔎 найти', 'Найти картинку в Яндекс Картинках (Google — в окне): клик по картинке — она добавится к правке, можно несколько',
          () => ImgSearch.open(ta.value.trim().split(/\r?\n/)[0].slice(0, 60), { planId: vid, multi: true, onPath: p => { refs.push(p); redraw(); } })),
        btn('📦 ассет', 'Взять готовый ассет из препродакшена видео или библиотеки канала — Claude вставит в кадр именно его',
          () => AssetPick.open({ d, picked: assets, onPick: a => { assets.push(a); redrawA(); } }))),
      chips,
      h('div.pv-globrow', globBtn),
      h('div.pv-foot',
        edit && btn('Удалить', 'Удалить правку (Ctrl+Z — вернуть)', () => { close(); this.noteEdit('удаление пометки', k => Store.del(k, ['notes'], n.id, false)); UI.toast('🗑 Правка удалена · Ctrl+Z — вернуть'); }, '.danger'),
        edit && btn('✓ Сделано', 'Сделал сам — убрать из открытых (Ctrl+Z — вернуть)', () => { close(); this.noteEdit('«сделано»', k => Store.set(k, ['notes', n.id, 'status'], 'done')); }),
        h('span.sp'), btn('Отмена', 'Esc', close), btn(edit ? 'Сохранить' : 'Добавить', 'Enter', save, '.primary')));
    dot = h('div.pv-dot.new.mark', { style: { left: x * 100 + '%', top: y * 100 + '%' } });
    // карточка — рядом с кадром (справа, нет места — слева), чтобы не закрывать сам кадр; точка правки — на кадре
    // поле — центральная область окна видео (между левой колонкой и панелью Claude), не всё окно
    const R = ov.getBoundingClientRect(), S = ($('.ws-stage') || ov).getBoundingClientRect(), gap = 14;
    const room = Math.max(S.right - R.right, R.left - S.left) - gap - 8, side = room >= 240;
    const cw = side ? Math.min(380, room) : Math.min(380, S.width - 16);
    const right = side && S.right - R.right - gap - 8 >= cw;
    card.style.width = cw + 'px';                         // места сбоку нет — у правого края области, частично на кадре (точка правки остаётся видна слева)
    card.style.left = (right ? R.right + gap : side ? R.left - gap - cw : S.right - cw - 8) + 'px';
    card.style.top = Math.max(S.top + 8, Math.min(R.top + y * R.height - 40, S.bottom - 380)) + 'px';
    ov.append(dot);
    document.body.append(card);
    redraw(); redrawA();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); grow(); }, 0);
  },
  unitAt(M, t) { return (M.units || []).find(u => t >= (u.at || 0) - 1e-3 && t < (u.at || 0) + (u.len || 0)) || null; },

  // ---------------- часы воспроизведения ----------------
  range() {
    const M = Montage.M(MT.d), sel = (M.units || []).filter(u => (MT.multi || []).includes(u.id));
    if (WS.loop && sel.length) return [Math.min(...sel.map(u => u.at || 0)), Math.max(...sel.map(u => (u.at || 0) + (u.len || 0)))];
    return [0, M.len || Montage.autoLen(MT.d, M)];
  },
  play() {
    if (!MT.d) return;
    const [a, b] = this.range();
    if (MT.t >= b - 0.04 || (WS.loop && MT.t < a)) MT.t = a;
    WS.playing = MT.playing = true; WS.t0 = MT.t; WS.p0 = performance.now();
    if (WS.rate === 1) MTA.play(MT.d, MT.t); else MTA.stop();
    cancelAnimationFrame(WS.raf);
    const tick = () => {
      if (!WS.playing) return;
      let t = WS.t0 + (performance.now() - WS.p0) / 1000 * WS.rate;
      const mv = MontagePreview.master && MontagePreview.master();
      if (mv) { t = mv.currentTime; WS.t0 = t; WS.p0 = performance.now(); }      // видео ведёт часы: плейхед идёт за кадром, а не наоборот
      const [a2, b2] = this.range();
      if (t >= b2) {
        if (WS.loop) { t = a2; WS.t0 = a2; WS.p0 = performance.now(); if (WS.rate === 1) MTA.play(MT.d, a2); }
        else { MT.t = b2; MontagePreview.post({ seek: b2 }); Montage.playhead(); return this.pause(); }
      }
      MT.t = +t.toFixed(3);
      MontagePreview.post({ seek: MT.t });
      Montage.playhead();
      WS.raf = requestAnimationFrame(tick);
    };
    WS.raf = requestAnimationFrame(tick);
    this.redrawTransport();
  },
  pause() { WS.playing = MT.playing = false; cancelAnimationFrame(WS.raf); MTA.stop(); MontagePreview.post({ seek: MT.t }); this.redrawTransport(); },
  seek(t) {
    const len = Montage.M(MT.d || {}).len || 0;
    MT.t = +Math.max(0, Math.min(len || 1e9, t)).toFixed(3);
    MontagePreview.post({ seek: MT.t });
    Montage.playhead();
    if (WS.playing) { WS.t0 = MT.t; WS.p0 = performance.now(); if (WS.rate === 1) MTA.play(MT.d, MT.t); }
  },
  async snap(d) {
    WS.snapBusy = true; this.redrawTransport();
    try { const r = await api('POST', '/api/videos/snap', { id: d.id, t: MT.t }); UI.toast('📷 ' + r.file); }
    catch (e) { UI.toast(e.message, 'err'); }
    WS.snapBusy = false; this.redrawTransport();
  },
  leave() { if (WS.playing) this.pause(); MT.driven = false; },
};

// клавиши окна видео: пробел, ←/→ (кадр, Shift — секунда), Home/End, Esc — снять выбор
addEventListener('keydown', e => {
  if (App.route.page === 'v' && MT.d && (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    const a = document.activeElement, typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    if (typing || document.querySelector('.modal, .nv, .pal, .stage-editor')) return;
    e.preventDefault();
    return e.code === 'KeyY' || e.shiftKey ? Workspace.redoLast() : Workspace.undoLast();
  }
  if (App.route.page !== 'v' || !MT.d || e.ctrlKey || e.altKey || e.metaKey) return;
  const a = document.activeElement, typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
  if (typing || document.querySelector('.modal, .nv, .pal, .stage-editor')) return;
  const M = Montage.M(MT.d);
  if (e.code === 'Space') { e.preventDefault(); WS.playing ? Workspace.pause() : Workspace.play(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); Workspace.seek(MT.t - (e.shiftKey ? 1 : 1 / FPS)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); Workspace.seek(MT.t + (e.shiftKey ? 1 : 1 / FPS)); }
  else if (e.key === 'Home') { e.preventDefault(); Workspace.seek(0); }
  else if (e.key === 'End') { e.preventDefault(); Workspace.seek(M.len || 0); }
  else if (e.key === 'Escape' && ((MT.multi || []).length || MT.sel)) { MT.multi = []; MT.sel = null; Montage.redraw(); }
});
addEventListener('resize', () => { if (App.route.page !== 'v') return; document.body.classList.toggle('side-mini', Shell.mini || innerWidth < 1440); Workspace.fit(); });
// S12.7: пока Claude монтирует — каждая его пересборка (montage gen) сразу в превью
setInterval(async () => {
  const d = MT.d;
  if (App.route.page !== 'v' || App.route.tab || !d || !window.AgentPanel || !AgentPanel.busy || AgentPanel.vid !== d.id || document.hidden || WS.genBusy) return;
  WS.genBusy = true;
  try {
    const r = await api('GET', '/api/videos/genat?id=' + d.id);
    if (WS.genSeen == null || WS.genVid !== d.id) { WS.genSeen = r.t; WS.genVid = d.id; }
    else if (r.t > WS.genSeen) {
      WS.genSeen = r.t;
      if (Date.now() - (MT.selfGenAt || 0) > 2500) {
        delete MT.info[d.id]; Montage.load(d, true); MTA.load(d, true); MontagePreview.reload(MT.t);
        Montage.status('Claude пересобрал — превью обновлено');
      }
    }
  } catch {}
  WS.genBusy = false;
}, 1500);
// Ctrl + колесо над таймлайном — масштаб
// зум таймлайна как в Premiere: Ctrl / Alt + колесо — вокруг времени под курсором (точка под мышью остаётся на месте),
// кнопки + / − и клавиши = / − — вокруг ползунка (если он виден, иначе — вокруг середины); щелчки колеса за один кадр склеиваются
const TLZoom = {
  f: 1, x: null, raf: 0,
  at(factor, clientX) {
    this.f *= factor; this.x = clientX;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.apply());
  },
  apply() {
    const f = this.f, cx = this.x; this.f = 1; this.x = null; this.raf = 0;
    const tl = $('.ws-tl .mt-tl'); if (!tl) return;
    const z0 = MT.zoom, z1 = Math.max(4, Math.min(400, z0 * f));
    if (Math.abs(z1 - z0) < 1e-6) return;
    const R = tl.getBoundingClientRect(), vis = tl.clientWidth;
    let ax;                                                           // точка привязки — в пикселях от левого края видимой области
    if (cx != null) ax = Math.max(MT_LABEL, Math.min(vis, cx - R.left));
    else { const ph = MT_LABEL + MT.t * z0 - tl.scrollLeft; ax = ph >= MT_LABEL && ph <= vis ? ph : MT_LABEL + (vis - MT_LABEL) / 2; }
    const t = Math.max(0, (tl.scrollLeft + ax - MT_LABEL) / z0);     // время под точкой привязки
    MT.zoom = z1;
    Montage.redraw();
    const t2 = $('.ws-tl .mt-tl'); if (t2) t2.scrollLeft = Math.max(0, MT_LABEL + t * z1 - ax);
  },
};
addEventListener('wheel', e => {
  if (App.route.page !== 'v' || !(e.ctrlKey || e.altKey) || !e.target.closest || !e.target.closest('.ws-tl')) return;
  e.preventDefault();
  const k = Math.pow(1.0018, -(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY));   // тачпад — плавно, колесо — шагом ~×1.2
  TLZoom.at(Math.max(0.5, Math.min(2, k)), e.clientX);
}, { passive: false });
// множественное выделение на таймлайне (TLSel, montage.js): Delete / Backspace — удалить выделенное, Esc — снять, Ctrl+A — все правки
addEventListener('keydown', e => {
  if (App.route.page !== 'v' || !MT.d) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) || document.querySelector('.modal, .nv, .pal, .stage-editor, .pv-card')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && TLSel.kind) { e.preventDefault(); e.stopImmediatePropagation(); TLSel.remove(); }
  else if (e.key === 'Escape' && TLSel.kind) { TLSel.clear(); }
  else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && (TLSel.kind === 'notes' || (a && a.closest && a.closest('.ws-tl')) || document.querySelector('.ws-tl:hover'))) {
    const ids = TLSel.ADAPT.notes.items(MT.d).map(x => x.id);
    if (ids.length) { e.preventDefault(); TLSel.set('notes', ids); }
  }
}, true);
addEventListener('keydown', e => {
  if (App.route.page !== 'v' || !MT.d || e.ctrlKey || e.altKey || e.metaKey) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) || document.querySelector('.modal, .nv, .pal, .stage-editor, .pv-card')) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); TLZoom.at(1.4, null); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); TLZoom.at(1 / 1.4, null); }
});

// 📦 ассет в правку / чат: элемент препродакшена этого видео или предмет библиотеки канала. В правку уходит ссылка (el:<id> / lib:<вид>/<slug>@N),
// а не картинка: Claude вставляет в кадр сам ассет (быстрый ролик — ppAdd / PP2D / PROP, сцена редактора — src.prefab).
// Окно: выбор нескольких (клик — выбрать / снять, «Добавить (N)»), превью — маленькие JPEG (/api/thumb), сетка порциями по 48 с догрузкой при прокрутке.
const AssetPick = {
  KIND: { char: 'персонаж', prop: 'пропс', scene: 'место', sound: 'звук', vfx: 'эффект', broll: 'B-roll', characters: 'персонаж', props: 'пропс', models: '3D-модель', sounds: 'звук', media: 'видео' },
  PAGE: 48,
  thumb(src) { return src ? '/api/thumb?w=240&src=' + encodeURIComponent(src) : ''; },
  async open({ d, onPick, picked = [] }) {
    const chan = (App.info.channel || {}).id, had = new Set(picked.map(a => a.ref));
    const st = { tab: 'pp', q: '', lib: null, n: this.PAGE, sel: new Map() };
    const els = (d.elements || []).filter(e => e.status !== 'drop').map(e => {
      let img = (typeof elPic === 'function' && elPic(e)) || '';
      if (img && !/^(\/|https?:)/.test(img)) img = '/' + img;
      return { ref: 'el:' + e.id, type: 'el', id: e.id, name: e.name || e.id, kind: e.kind, img, ok: e.status === 'ok', d3: e.dim === '3d' };
    });
    const grid = h('div.libgrid.compact.asp-grid'), more = h('div.asp-more'), count = h('span.dim');
    const addBtn = h('button.primary', { disabled: true, onclick: () => { for (const a of st.sel.values()) onPick(a); close(); UI.toast(`📦 В правку: ${st.sel.size}`); } }, 'Добавить');
    const foot = () => { count.textContent = st.sel.size ? `Выбрано: ${st.sel.size}` : 'Клик — выбрать (можно несколько), ещё клик — снять'; addBtn.disabled = !st.sel.size; addBtn.textContent = st.sel.size ? `Добавить (${st.sel.size})` : 'Добавить'; };
    const card = a => {
      const on = st.sel.has(a.ref), was = had.has(a.ref);
      const el = h('div.libcard.asp-card', { class: (on ? 'sel ' : '') + (was ? 'had' : ''), title: was ? 'Уже в правке' : a.ref,
        onclick: () => {
          if (was) return;
          if (st.sel.has(a.ref)) st.sel.delete(a.ref); else st.sel.set(a.ref, { type: a.type, ref: a.ref, id: a.id, name: a.name, kind: a.kind, img: a.img || '' });
          el.classList.toggle('sel', st.sel.has(a.ref)); foot();
        } },
        h('i.asp-mark', was ? '✓' : ''),
        a.img ? h('img', { src: this.thumb(a.img), alt: '', loading: 'lazy', decoding: 'async' }) : h('div.noimg', a.kind === 'sound' || a.kind === 'sounds' ? '🔊' : '📦'),
        h('b', a.name, a.d3 ? ' 🧊' : ''), h('span.dim.small', (this.KIND[a.kind] || a.kind || '') + (a.ok ? ' · ✓' : '') + (a.v ? ` · v${a.v}` : '') + (was ? ' · уже в правке' : '')));
      return el;
    };
    const filtered = () => {
      const q = st.q.toLowerCase();
      return (st.tab === 'pp' ? els : (st.lib || [])).filter(a => !q || (a.name + ' ' + (this.KIND[a.kind] || '')).toLowerCase().includes(q));
    };
    const fill = (reset = true) => {                               // сетка порциями: первые PAGE, дальше — при прокрутке к низу
      if (st.tab === 'lib' && !st.lib) { grid.replaceChildren(h('p.dim', h('span.spin'), ' загружаю библиотеку…')); more.replaceChildren(); return; }
      const list = filtered();
      if (reset) { st.n = this.PAGE; grid.replaceChildren(); grid.scrollTop = 0; }
      const have = grid.querySelectorAll('.asp-card').length;
      grid.append(...list.slice(have, st.n).map(card));
      if (!list.length) grid.replaceChildren(h('p.dim', st.tab === 'pp' ? 'В препродакшене видео ничего не нашлось.' : 'В библиотеке канала ничего не нашлось.'));
      more.replaceChildren(...(list.length > st.n ? [h('button.small', { onclick: () => { st.n += this.PAGE; fill(false); } }, `Показать ещё (${list.length - st.n})`)] : []));
    };
    grid.addEventListener('scroll', () => { if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 300 && filtered().length > st.n) { st.n += this.PAGE; fill(false); } });
    const tabs = h('div.seg', [['pp', `Препродакшен видео (${els.length})`], ['lib', 'Библиотека канала']].map(([k, l]) =>
      h('button', { class: st.tab === k ? 'sel' : '', 'data-k': k, onclick: () => {
        st.tab = k; tabs.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.k === k));
        fill(); if (k === 'lib' && !st.lib) load();
      } }, l)));
    let qt = 0;
    const qIn = h('input.box', { placeholder: '🔎 найти по названию', oninput: e => { st.q = e.target.value; clearTimeout(qt); qt = setTimeout(() => fill(), 150); } });
    const load = async () => {
      try {
        const r = await api('GET', `/api/lib?channel=${chan || ''}`);
        st.lib = (r.items || []).map(it => ({ ref: `lib:${it.id}@${it.latest}`, type: 'lib', id: it.id, name: it.name, kind: it.kind || String(it.id).split('/')[0], v: it.latest, d3: it.d3,
          img: it.preview ? `/api/lib/file/${chan}/${it.preview}` : '' }));
      } catch (e) { st.lib = []; UI.toast(e.message, 'err'); }
      if (st.tab === 'lib') fill();
    };
    const body = h('div.asp', h('div.row.asp-top', tabs, qIn), grid, more,
      h('div.row.asp-foot', count, h('span.sp'), h('button', { onclick: () => close() }, 'Отмена'), addBtn));
    fill(); foot();
    const close = UI.modal('📦 Ассеты в правку', body, { wide: true });
    const mod = body.closest('.modal'); if (mod) mod.classList.add('asp-modal');   // поверх панели Claude (она на слое 960), как окно «Нашлось в библиотеке»
    setTimeout(() => qIn.focus(), 0);
  },
  // строка для Claude: что вставить и откуда
  text(assets) {
    return (assets || []).map(a => `«${a.name}» — ${a.type === 'lib' ? 'библиотека канала' : 'препродакшен видео'}, ${this.KIND[a.kind] || a.kind || ''}, ${a.ref}`).join('; ');
  },
  chip(a, onDel) {
    return h('span.asp-chip', { title: a.ref }, a.img ? h('img', { src: this.thumb(a.img), alt: '' }) : '📦', h('span', a.name), onDel && h('button.x', { type: 'button', title: 'Убрать', onclick: onDel }, '×'));
  },
};

// Размеры окна видео, которые автор тянет мышью (S23): ширина левой панели (сцены / «🔊 Звуки» — отдельно), высота таймлайна, ширина чата Claude.
// Хранятся в localStorage; двойной клик по ручке — как было.
const WSize = {
  get(k) { const v = +Local.get('wsize-' + k); return v > 0 ? v : null; },
  set(k, v) { Local.set('wsize-' + k, v == null ? '' : String(Math.round(v))); },
  leftKey() { return typeof MSnd !== 'undefined' && MSnd.panel ? 'left-snd' : 'left'; },
  leftW() { return this.get(this.leftKey()) || (this.leftKey() === 'left-snd' ? 330 : null); },
  leftStyle() { const w = this.leftW(); return w ? { gridTemplateColumns: `${w}px minmax(0, 1fr)` } : null; },
  tlStyle() { const v = this.get('tl'); return v ? { height: v + 'px' } : null; },
  reset(k) {
    if (k === 'left') { this.set(this.leftKey(), null); const m = $('.ws-main'); if (m) m.style.gridTemplateColumns = (this.leftStyle() || {}).gridTemplateColumns || ''; }
    if (k === 'tl') { this.set('tl', null); const t = $('.ws-tl'); if (t) t.style.height = ''; }
    if (k === 'agent') { this.set('agent', null); document.documentElement.style.removeProperty('--agent-w'); }
    requestAnimationFrame(() => Workspace.fit());
  },
  drag(ev, fn, cursor) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    document.body.classList.add('ws-resizing'); document.body.style.cursor = cursor;
    let raf = 0, last = ev;
    const mv = e => { last = e; if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(last); Workspace.fit(); }); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.classList.remove('ws-resizing'); document.body.style.cursor = ''; fn(last, true); Workspace.fit(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  dragLeft(ev) {
    const m = $('.ws-main'), x0 = m.getBoundingClientRect().left;
    this.drag(ev, (e, done) => {
      const w = Math.max(170, Math.min(innerWidth * 0.5, e.clientX - x0));
      m.style.gridTemplateColumns = `${w}px minmax(0, 1fr)`;
      if (done) this.set(this.leftKey(), w);
    }, 'col-resize');
  },
  dragTl(ev) {
    const t = $('.ws-tl'), bottom = t.getBoundingClientRect().bottom;
    this.drag(ev, (e, done) => {
      const hgt = Math.max(120, Math.min(innerHeight - 160, bottom - e.clientY));
      t.style.height = hgt + 'px'; document.body.classList.remove('ws-tl-big');
      if (done) this.set('tl', hgt);
    }, 'row-resize');
  },
  dragAgent(ev) {
    this.drag(ev, (e, done) => {
      const w = Math.max(280, Math.min(innerWidth * 0.6, innerWidth - e.clientX));
      document.documentElement.style.setProperty('--agent-w', w + 'px');
      if (done) this.set('agent', w);
    }, 'col-resize');
  },
  init() {
    const w = this.get('agent'); if (w) document.documentElement.style.setProperty('--agent-w', w + 'px');
    const s = h('div.ag-split', { title: 'Тяните — чат шире / уже (двойной клик — как было)', onmousedown: ev => this.dragAgent(ev), ondblclick: () => this.reset('agent') });
    document.body.append(s);
  },
};
WSize.init();
