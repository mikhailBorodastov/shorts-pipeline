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
      h('div.ws-main',
        h('aside.ws-left', this.left(d, M, I)),
        App.route.tab === 'pre' ? h('section.ws-center', Plan.preWs(d, key, App.route.sub)) : Panels.has(App.route.tab) ? h('section.ws-center', Panels.view(d, key, App.route.tab)) : h('section.ws-center',
          h('div.ws-stage', h('div.mt-prevslot.ws-slot'), this.overlay(d, M, I)),
          this.transport(d, M),
          h('div.ws-tl',
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
      h('label.ws-model', { title: 'Модель Claude для этого окна: Opus 5.5 — сборка и сложное, Sonnet 5.5 — быстрые правки' }, Icon('spark', 14),
        sel([{ value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5.5' }], model, v => { AgentPanel.model = v; Local.set('agent.model', v); App.render(); })),
      h('button.icon', { title: 'История: запуски Claude (что сделал, откатить), Ctrl+Z — откатить последнее', onclick: () => { AgentPanel.tab = 'history'; AgentPanel.toggle(true); } }, Icon('clock', 17)),
      h('button.icon', { class: App.route.tab === 'brief' ? 'on' : '', title: 'Бриф: идея, контекст, референсы, ответы на вопросы', onclick: () => go(`#/v/${d.id}/brief`) }, Icon('book', 17)),
      h('button.icon', { title: 'Открыть папку видео', onclick: () => api('POST', '/api/videos/open', { id: d.id }).catch(e => UI.toast(e.message, 'err')) }, Icon('folder', 17)),
      h('button.primary.ws-export', { disabled: !d.project, title: d.project ? 'Экспорт: имя, .srt, главы — в out/ всё для YouTube' : 'Сначала проект ролика', onclick: () => ExportDlg.open(d) },
        Renders.of(d.id) ? h('span.spin') : Icon('download', 15), Renders.of(d.id) ? 'Рендер…' : 'Экспорт'));
  },

  // ---------------- слева: сцены + пайплайн ----------------
  left(d, M, I) {
    const units = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0)), cur = this.unitAt(M, MT.t);
    return [
      h('div.ws-sec', 'Сцены', units.length ? h('span.cnt', String(units.length)) : null),
      units.length ? h('div.ws-scenes', units.map((u, i) => {
        const sc = (I.scenes || []).find(s => s.el === u.scene) || {};
        return h('button.ws-scene', { class: (cur && cur.id === u.id ? 'on ' : '') + ((MT.multi || []).includes(u.id) ? 'sel' : ''), 'data-u': u.id,
          title: 'Клик — перейти, Ctrl / Shift — выбрать несколько, двойной клик — открыть сцену в редакторе',
          onclick: ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return Montage.pick('units', u.id, ev); this.seek(u.at || 0); },
          ondblclick: () => Montage.openAt(d, +((u.at || 0) + 0.05).toFixed(2)) },
          h('span.n', String(i + 1)), h('span.t', h('b', sc.name || u.scene), h('small', `${this.fmt(u.at || 0)} · ${(u.len || 0).toFixed(1)} с`)));
      })) : h('p.ws-hint', d.project ? 'Сцен пока нет — соберите видео с Claude: «Сделать» в пайплайне.' : 'Проект ролика ещё не создан.'),
      h('div.ws-sec', 'Пайплайн'),
      h('div.ws-pipe', this.steps(d, M, I).map(s => h('div.ws-step', { class: s.st, title: s.title || '' },
        h('span.ws-dot', s.st === 'done' ? Icon('check', 12) : s.st === 'part' ? h('i') : null),
        h('span.lbl', s.label, s.sub ? h('small', s.sub) : null),
        s.btn && h('button.small', { class: s.primary ? 'primary' : '', disabled: !!s.off, onclick: s.btn }, s.act)))),
    ];
  },

  steps(d, M, I) {
    const id = d.id, has = !!d.project, scr = has ? Plan.scriptState(d) : {}, words = has ? Montage.words(d) : [];
    const els = (d.elements || []).filter(e => e.status !== 'drop'), ok = els.filter(e => e.status === 'ok').length;
    const agent = (text, mode = 'chat', model = 'opus') => { AgentPanel.toggle(true); AgentPanel.say(text, { mode, model }); };
    const nav = tab => () => go(`#/v/${id}/${tab}`);
    const scriptDone = has && scr.template === false;
    const steps = [
      { label: 'Сценарий', st: scriptDone ? 'done' : '', act: scriptDone ? 'Открыть' : has ? 'Написать' : 'Начать', primary: !scriptDone,
        btn: scriptDone ? () => ScriptWin.open(d) : has ? () => agent('📝 Напиши сценарий по этому видео: сначала ресерч темы (источники → research.md), потом сценарий по брифу, ответам на вопросы и препродакшену. Потом montage check и montage tts.', 'script')
          : () => Claude.run({ action: 'produce', key: 'plan:' + id, params: { id, name: d.name } }),
        title: has ? 'Раскадровка: текст сцен, правки, фактчек' : 'Положить проект ролика в папку видео' },
      { label: 'Озвучка', sub: words.length ? '' : 'черновой голос или своя запись', st: words.length ? 'done' : '', act: words.length ? 'Заменить' : 'Добавить', btn: nav('voice'), off: !scriptDone },
      { label: 'Тайминги', sub: words.length ? `${words.length} слов` : '', st: words.length ? 'done' : '', act: words.length ? 'Повторить' : 'Запустить', btn: nav('voice'), off: !scriptDone,
        title: 'Слова голоса по времени: из них субтитры и привязка сцен к словам' },
      { label: 'Препродакшен', sub: els.length ? `${ok} из ${els.length} утверждено` : '', st: els.length && ok === els.length ? 'done' : els.length ? 'part' : '', act: App.route.tab === 'pre' ? 'Открыт' : 'Открыть',
        btn: () => go(`#/v/${id}/pre`), off: App.route.tab === 'pre' && !App.route.sub },
      { label: 'Синхронизация', sub: (d.sync || {}).at ? 'шаги, звуки, анимации' : '', st: (d.sync || {}).at ? 'done' : '', act: (d.sync || {}).at ? 'Повторить' : 'Запустить', off: !has || !(M.units || []).length,
        btn: () => agent(`🔊 Шаг «Синхронизация»: соедини ассеты препродакшена со сценами и голосом — шаги персонажей к касаниям ног, звуки к действиям и маркерам сцен, анимации, которые персонажи умеют, там, где их требует сценарий или «Для финала», музыку под смысловые блоки (montage: music, приглушить под голос). Потом montage gen и проверь кадрами (montage snap). В конце — список «сцена · момент · что привязал». Когда закончишь: set plan:${id} sync '{"at": ${Date.now()}}'`, 'montage'),
        title: 'Claude привязывает звуки и анимации к действиям в сценах' },
      { label: 'Монтаж', sub: (M.units || []).length ? `${(M.len || 0).toFixed(1)} с` : '', st: d.montage && (M.units || []).length ? 'done' : '', act: d.montage ? 'Пересобрать' : 'Сделать', primary: !d.montage && has, off: !has || I.owned === false,
        btn: () => this.make(d), title: 'Монтаж в прямом эфире: сцены сразу встают по сценарию, Claude доводит их по одной — смотрите и пишите правки по ходу' },
      { label: 'Упаковка', sub: (d.pack || {}).titles ? 'название и описание' : '', st: (d.pack || {}).titles ? 'done' : '', act: 'Открыть', btn: nav('pack') },
    ];
    return steps;
  },

  // ---------------- 🎞 монтаж в прямом эфире (S12.7) ----------------
  async make(d) {
    const M = Montage.M(d);
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
    if (MT.info[d.id] && !(M.units || []).length) return h('div.ws-over.soft', h('b', 'Сцен пока нет'), h('p', 'Соберите видео с Claude — «Сделать» в пайплайне слева.'));
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
      h('button.icon', { title: 'К началу сцены (Home — к началу ролика)', onclick: () => jump(-1) }, '⏮'),
      h('button.icon.ws-play', { title: 'Играть / пауза (пробел)', onclick: () => (WS.playing ? this.pause() : this.play()) }, WS.playing ? '❚❚' : '▶'),
      h('button.icon', { title: 'К следующей сцене', onclick: () => jump(1) }, '⏭'),
      h('span.ws-time', h('b.mt-time', this.fmt(MT.t)), h('span.dim', ' / ' + this.fmt(M.len || 0))),
      h('span.ws-scname', u ? `Сцена ${units.indexOf(u) + 1} · ${(sc && sc.name) || u.scene}` : ''),
      h('span.sp'),
      h('button.icon', { title: 'Кадр назад (←), Shift — на секунду', onclick: () => this.seek(MT.t - 1 / FPS) }, '‹'),
      h('button.icon', { title: 'Кадр вперёд (→), Shift — на секунду', onclick: () => this.seek(MT.t + 1 / FPS) }, '›'),
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
        h('button.small', { onclick: () => add('sfx', { id: uid('x'), at, src: src0 ? src0.src : 'lib:other/pop', gain: 0.8, align: '' }), title: 'Звук в момент курсора' }, '+ звук'),
        h('button.small', { onclick: () => add('music', { id: uid('mu'), at, src: src0 ? src0.src : '', gain: 0.6, from: 0, dur: 6, fadeIn: 0.5, fadeOut: 1 }) }, '+ музыка'),
        h('button.small', { onclick: () => add('overlays', { id: uid('ov'), at, dur: 3, kind: 'pov', text: 'POV: …' }) }, '+ надпись'),
        h('label.ws-chk', h('input', { type: 'checkbox', checked: !!(M.voice || {}).on, disabled: !Montage.words(d).length, onchange: ev => { const N = Montage.clone(M); N.voice = { on: ev.target.checked }; Montage.save(N); } }), 'голос'),
        h('label.ws-chk', h('input', { type: 'checkbox', checked: !!(M.captions || {}).on, disabled: !Montage.words(d).length, onchange: ev => { const N = Montage.clone(M); N.captions = { on: ev.target.checked }; Montage.save(N); } }), 'субтитры')],
      h('span.mt-status.dim.small', MT.statusTxt || ''),
      h('button.icon', { title: 'Мельче (Ctrl + колесо)', onclick: () => { MT.zoom = Math.max(4, MT.zoom / 1.4); Montage.redraw(); } }, '−'),
      h('button.icon', { title: 'Крупнее (Ctrl + колесо)', onclick: () => { MT.zoom = Math.min(400, MT.zoom * 1.4); Montage.redraw(); } }, '+'),
      h('button.icon', { title: 'Таймлайн выше / ниже', onclick: () => { document.body.classList.toggle('ws-tl-big'); requestAnimationFrame(() => this.fit()); } }, '⤢'));
  },
  props(d, M) {
    const n = (MT.multi || []).length;
    if (n > 1) return h('div.ws-multi', h('b', `Выбрано сцен: ${n}`), h('span.dim', ' — опишите правку для них в чате Claude справа (переход между ними, общий ассет…); Esc — снять выбор.'));
    if (!MT.sel) return null;
    return Montage.props(d, M);
  },

  // ---------------- хуки montage.js ----------------
  onRedraw() {
    const d = MT.d; if (!d) return;
    const M = Montage.M(d), I = MT.info[d.id] || {};
    const L = $('.ws-left'); if (L) L.replaceChildren(...[this.left(d, M, I)].flat(Infinity).filter(x => x instanceof Node));
    const P = $('.ws-tl .mt-props'); if (P) P.replaceChildren(...[this.props(d, M)].flat().filter(x => x instanceof Node));
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
  async undoLast() {
    const local = (WS.undo || [])[WS.undo ? WS.undo.length - 1 : -1], run = AgentPanel.lastRun();
    if (local && (!run || local.ts > run.ts)) {
      WS.undo.pop();
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
    (WS.undo = WS.undo || []).push({ M: Montage.clone(Montage.M(MT.d)), ts: Date.now() });
    this.restore(r.M); UI.toast('↷ вернул правку монтажа');
  },
  restore(M) {
    const d = MT.d, key = MT.key;
    Store.set(key, ['montage'], M, false);
    Montage.redraw();
    clearTimeout(MT.genTimer); MT.genTimer = setTimeout(() => Montage.regen(), 500);
  },

  // ---------------- пометки на кадре: курсор-крестик над превью ----------------
  pins() {
    const host = MontagePreview.host, d = MT.d;
    if (!host || !d || App.route.page !== 'v' || !host.classList.contains('clean')) return;
    let ov = host.querySelector('.pv-pins');
    if (!ov) {
      ov = h('div.pv-pins', { title: 'Клик — пометка на этом кадре (что поправить)', onmousedown: ev => { if (ev.target === ov) this.newPin(ev); } });
      host.append(ov);
    }
    const near = ((Store.get('plan:' + d.id) || {}).notes || []).filter(n => (n.status || 'open') === 'open' && Math.abs(n.t - MT.t) < 0.35);
    const sig = near.map(n => n.id).join(',');
    if (ov.dataset.sig === sig && !ov.querySelector('.pv-pop')) return;
    ov.dataset.sig = sig;
    ov.querySelectorAll('.pv-dot').forEach(x => x.remove());
    near.forEach((n, i) => ov.append(h('div.pv-dot', { style: { left: n.x * 100 + '%', top: n.y * 100 + '%' }, title: n.text }, String(i + 1))));
  },
  newPin(ev) {
    if (WS.playing) this.pause();
    const ov = ev.currentTarget, r = ov.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
    ov.querySelectorAll('.pv-pop').forEach(p => p.remove());
    const t = MT.t, key = 'plan:' + MT.d.id;
    const inp = h('input.box', { placeholder: 'Что поправить в этом кадре? Enter — сохранить, Esc — отмена',
      onkeydown: e => {
        e.stopPropagation();
        if (e.key === 'Escape') pop.remove();
        if (e.key === 'Enter' && inp.value.trim()) {
          Store.add(key, ['notes'], { id: uid('n'), t: +t.toFixed(2), x: +x.toFixed(3), y: +y.toFixed(3), text: inp.value.trim(), status: 'open', created: Date.now() }, true);
          pop.remove(); UI.toast('✛ Пометка сохранена — вкладка «Правки» у Claude');
          setTimeout(() => this.pins(), 50);
        }
      } });
    const pop = h('div.pv-pop', { style: { left: Math.min(x, 0.55) * 100 + '%', top: Math.min(y, 0.85) * 100 + '%' } }, h('div.pv-dot.new'), inp);
    ov.append(pop);
    setTimeout(() => inp.focus(), 0);
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
  pause() { WS.playing = MT.playing = false; cancelAnimationFrame(WS.raf); MTA.stop(); this.redrawTransport(); },
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
addEventListener('resize', () => App.route.page === 'v' && Workspace.fit());
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
addEventListener('wheel', e => {
  if (App.route.page !== 'v' || !e.ctrlKey || !e.target.closest || !e.target.closest('.ws-tl')) return;
  e.preventDefault();
  MT.zoom = Math.max(4, Math.min(400, MT.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  Montage.redraw();
}, { passive: false });
