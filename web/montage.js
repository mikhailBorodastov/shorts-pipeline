// Claude Studio — этап «🎞 Монтаж» (S6, docs/studio/stage6-montage.md): общий таймлайн ролика и предпросмотр.
// Данные — video.json → montage (units, voice, captions, sfx, music, overlays, len), правки — операцией set ['montage'];
// после правки сервер пересобирает файлы проекта (POST /api/montage/gen), предпросмотр (src/index.html?preview проекта) перезагружается на том же моменте.
// «🔨 Собрать» — задача montagebuild (генератор + build.sh) → «Ревью».
'use strict';

const MT = { info: {}, loading: {}, zoom: 64, sel: null, t: 0, playing: false, drag: null, genTimer: null, key: null, d: null };
const MT_LABEL = 150;                                     // ширина колонки подписей строк (S23: шапки дорожек — фейдер, M / S), px
const MT_TRANS = ['cut', 'slide', 'push', 'zoom', 'iris'];
const msel = (pairs, v, cb) => sel(pairs.map(([value, label]) => ({ value, label })), v, cb);   // sel() из core.js — с парами [значение, подпись]

const Montage = {
  clone: x => JSON.parse(JSON.stringify(x)),
  load(d, force) {
    if (MT.loading[d.id] || (MT.info[d.id] && !force)) return;
    MT.loading[d.id] = true;
    api('GET', '/api/montage?video=' + encodeURIComponent(d.id))
      .then(r => { MT.info[d.id] = r; })
      .catch(e => { MT.info[d.id] = { error: e.message }; })
      .finally(() => { MT.loading[d.id] = false; App.render(); });
  },
  M(d) { return d.montage || (MT.info[d.id] && MT.info[d.id].montage) || { units: [], voice: {}, captions: {}, sfx: [], music: [], overlays: [], len: 0 }; },
  words(d) { const v = (MT.info[d.id] || {}).voice; return v && v.words && !v.studio ? v.words : []; },
  voiceOn(d) { return !!(this.M(d).voice || {}).on && this.words(d).length > 0; },
  srcDur(d, src) {
    const I = MT.info[d.id] || {}, s = String(src || '');
    const el = (I.sources || []).find(x => x.src === s);
    if (el) return el.dur;
    const m = /^lib:([^|]+)(?:\|([\d.]+)\|([\d.]+))?$/.exec(s);
    if (m) { if (m[3]) return +m[3]; const r = (I.lib || []).find(x => x[0] === m[1]); return r ? r[1] : 1; }
    return 1;
  },
  srcName(d, src) {
    const s = String(src || ''), I = MT.info[d.id] || {};
    const el = (I.sources || []).find(x => x.src === s);
    if (el) return el.name;
    return s.replace(/^lib:/, '').replace(/^file:/, '📄 ');
  },
  // пары карты юнита -> [[t сцены, t ролика абсолютное]]
  pairs(d, u) {
    const W = this.words(d), out = [];
    for (const [ts, tv] of u.map || [[0, 0], [u.len, u.len]]) {
      if (typeof tv === 'string' && tv.startsWith('w:')) { const w = W[+tv.slice(2)]; if (w) out.push([ts, w.t, tv]); }
      else out.push([ts, (u.at || 0) + tv, null]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  },
  s2v(P, ts) {
    if (!P.length) return ts;
    if (ts <= P[0][0]) return P[0][1] + (ts - P[0][0]);
    for (let i = 0; i < P.length - 1; i++) { const [a0, b0] = P[i], [a1, b1] = P[i + 1]; if (ts <= a1) return b0 + (b1 - b0) * (ts - a0) / ((a1 - a0) || 1); }
    const L = P[P.length - 1]; return L[1] + (ts - L[0]);
  },
  autoLen(d, M) {
    const ends = (M.units || []).map(u => (u.at || 0) + (u.len || 0));
    if ((M.voice || {}).on) { const v = (MT.info[d.id] || {}).voice; if (v && v.total && !v.studio) ends.push(v.total); }
    return Math.round(Math.max(1, ...ends) * 100) / 100;
  },

  // ---- правка: локально + операция + пересборка предпросмотра
  save(M, why) {
    const d = MT.d, key = MT.key;
    if (typeof Workspace !== 'undefined' && App.route.page === 'v') Workspace.track(this.clone(this.M(d)));   // S12.4: Ctrl+Z окна видео
    M.len = this.autoLen(d, M);
    Store.set(key, ['montage'], M, false);
    this.redraw();
    if (MT.playing) MTA.play(d, MT.t); else MTA.warm(d);   // звук — сразу по новому монтажу (живое сведение, файл не нужен)
    clearTimeout(MT.genTimer);
    MT.genTimer = setTimeout(() => this.regen(), 700);
  },
  async regen() {
    const d = MT.d, key = MT.key;
    MT.selfGenAt = Date.now();                            // S12.7: своя пересборка — окно не перезагружает превью второй раз
    if (!d || !d.project) return;
    MT.genBusy = true; this.status('обновляю предпросмотр…');
    try {
      await Store.flush(key);
      const r = await api('POST', '/api/montage/gen', { video: d.id });
      const w = (r.report || {}).warn || [];
      this.status(w.length ? '⚠ ' + w.join('; ') : 'предпросмотр обновлён');
      MontagePreview.reload(MT.t);
      const had = Object.keys((MTA.map || {}).srcs || {}).join('|');   // S23: новый звук (из панели, замена) — адреса и волна
      MTA.load(d, true).then(m => { if (Object.keys((m || {}).srcs || {}).join('|') !== had) this.redraw(); });
    } catch (e) { this.status('⚠ ' + e.message); }
    MT.genBusy = false;
  },
  status(s) { MT.statusTxt = s; const e = $('.mt-status'); if (e) e.textContent = s; },

  // ---- S11: ⚡ раскладка по сценарию (без Claude), ✨ монтаж агентом, двойной клик -> сцена, после правки сцены — пересборка сама
  async auto(d) {
    if (d.montage && (d.montage.units || []).length && !confirm('Разложить заново по сценарию? Сцены встанут под свои секции голоса (звуки, музыка и надписи останутся). Отменить — Ctrl+Z на странице / история видео.')) return;
    try {
      this.status('раскладываю по сценарию…');
      const r = await api('POST', '/api/montage/auto', { video: d.id });
      await Store.load('plan:' + d.id, true); this.load(d, true);
      this.status((r.report || []).join(' · '));
      UI.toast('⚡ Разложено: ' + (r.montage.units || []).length + ' сцен' + ((r.report || []).some(x => /нет сцены|⚠|обрезана/.test(x)) ? ' — есть замечания в строке статуса' : ''));
      MontagePreview.reload(0);
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  smart(d) {
    const wish = prompt('✨ Смонтировать: что важно? (можно пусто)\nНапример: «финал подольше, комната короче, ностальгическая музыка», «двойной клик ровно на щелчке мыши»', '');
    if (wish === null) return;
    AgentPanel.toggle(true);
    AgentPanel.say('🎞 Смонтируй ролик из сценария с голосом, сцен препродакшена и звуков (режим монтажа).' + (wish.trim() ? ' Пожелания автора: ' + wish.trim() : ''), { mode: 'montage', model: 'opus' });
  },
  async openAt(d, vt) {
    if (d.locations) { UI.toast('Сцены — плейбек: правку напишите Claude (чат или пин на кадре). Место меняется в препродакшене — «Локации».'); return; }   // S13
    try { const a = await api('GET', `/api/montage/at?video=${encodeURIComponent(d.id)}&t=${vt}`); StageEditor.openScene(d.id, a.el, a.ts); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  async afterEdit(vid, el) {                            // сцена поменялась: длина -> карты юнитов (простое растяжение подстраивается), предпросмотр пересобирается
    const d = Store.get('plan:' + vid); if (!d) return;
    await Store.load('plan:' + vid, true);
    const old = (MT.info[vid] || {}).scenes || [];
    let fresh = null;
    try { fresh = await api('GET', '/api/montage?video=' + encodeURIComponent(vid)); MT.info[vid] = fresh; } catch (e) { return UI.toast(e.message, 'err'); }
    const dd = Store.get('plan:' + vid), M = dd && dd.montage;
    const was = (old.find(s => s.el === el) || {}).len, now = ((fresh.scenes || []).find(s => s.el === el) || {}).len;
    let changed = 0;
    if (M && was && now && Math.abs(was - now) > 1e-3) {
      const N = this.clone(M);
      for (const u of N.units || []) {
        if (u.scene !== el || !Array.isArray(u.map) || u.map.length !== 2) continue;
        const [, b] = u.map;
        if (Math.abs(b[0] - was) < 1e-3 && typeof b[1] === 'number') { b[0] = now; changed++; }   // сцена была растянута на юнит целиком — растягиваем новую длину
      }
      if (changed) { MT.d = dd; MT.key = 'plan:' + vid; Store.set('plan:' + vid, ['montage'], N, true); }
    }
    MT.d = Store.get('plan:' + vid); MT.key = 'plan:' + vid;
    App.render();
    await MTA.load(MT.d, true);                         // звуки сцены могли поменяться
    await this.regen();
    UI.toast('🎞 Сцена обновлена — предпросмотр пересобран' + (changed ? ` (длина ${was} → ${now} с, подогнал под голос)` : '') + '. mp4 — «🔨 Собрать»');
  },

  // ---------------- страница этапа
  redraw() {
    // открыта карточка правки или тянется правка — таймлайн не трогаем (иначе полоса прыгает назад посреди перетаскивания); догонит App.resume()
    if (typeof Workspace !== 'undefined' && Workspace.holding && Workspace.holding()) { this.redrawPending = true; return; }
    this.redrawPending = false;
    const d = MT.d, M = this.M(d), tl = $('.mt-tl'), pr = $('.mt-props'), tb = $('.mt-toolbar');
    if (tl) keepScroll(tl, () => tl.replaceChildren(this.timeline(d, M)));      // прокрутка таймлайна и свойств не прыгает
    if (pr) keepScroll(pr, () => pr.replaceChildren(this.props(d, M)));
    if (tb) tb.replaceWith(this.toolbar(d, MT.key, M));
    if (typeof Workspace !== 'undefined' && App.route.page === 'v') Workspace.onRedraw();   // S12: окно видео — список сцен, свойства
  },

  staleUnit(d, u) { return !!(d.locations && MT.clips && (MT.clips.stale || []).includes(u.id)); },
  timeline(d, M) {
    const Z = MT.zoom, len = Math.max(M.len || 0, this.autoLen(d, M)) + 2, width = MT_LABEL + len * Z;
    const X = t => MT_LABEL + t * Z;
    const rows = [], words = this.words(d), I = MT.info[d.id];
    const bar = (list, it, t0, dur, label, cls, opts = {}) => h('div.mt-bar', {
      class: cls + ((MT.sel && MT.sel.list === list && MT.sel.id === it.id) || (list === 'units' && (MT.multi || []).includes(it.id)) ? ' sel' : ''),
      style: { left: X(t0) + 'px', width: Math.max(6, dur * Z) + 'px', top: (opts.lane || 0) * 22 + 3 + 'px' },
      title: label, onmousedown: ev => this.startDrag(ev, list, it, opts.edge !== false),
      onclick: ev => ev.stopPropagation() }, h('span', label));
    // линейка
    const ruler = h('div.mt-ruler', { style: { width: width + 'px' }, onmousedown: ev => this.scrub(ev) });
    for (let s = 0; s <= len; s += Z < 30 ? 5 : 1) ruler.append(h('div.mt-tick', { style: { left: X(s) + 'px' } }, s % 5 === 0 || Z >= 50 ? String(s) : ''));
    // сцены: полосы юнитов, склейки камеры и маркеры по карте времени
    const sceneRow = h('div.mt-lane');
    const byAt = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const u of M.units || []) {
      const sc = (I.scenes || []).find(s => s.el === u.scene) || {}, P = this.pairs(d, u);
      const b = bar('units', u, u.at || 0, u.len || 0, (byAt.indexOf(u) + 1) + '  ' + (sc.name || u.scene), 'unit' + (this.staleUnit(d, u) ? ' stale' : ''));   // S13.4: клип устарел — штриховка
      b.title = (sc.name || u.scene) + ' — двойной клик: открыть сцену в этом моменте (после правки ролик пересоберётся сам)';
      b.ondblclick = ev => { ev.stopPropagation(); Montage.openAt(d, +this.xToT(ev).toFixed(2)); };
      sceneRow.append(b);
      for (const c of sc.cuts || []) { const tv = this.s2v(P, c); if (tv > (u.at || 0) && tv < (u.at || 0) + u.len) sceneRow.append(h('div.mt-cut', { style: { left: X(tv) + 'px' }, title: 'склейка камеры ' + c + ' с сцены' })); }
      for (const m of sc.markers || []) {
        const tv = this.s2v(P, m.t), pin = P.find(p => Math.abs(p[0] - m.t) < 1e-3);
        if (tv < (u.at || 0) - 0.01 || tv > (u.at || 0) + u.len + 0.01) continue;
        sceneRow.append(h('div.mt-marker', { class: pin && pin[2] ? 'word' : pin ? 'pinned' : '', style: { left: X(tv) + 'px' },
          title: `маркер «${m.name || ''}» (${m.t} с сцены)${pin && pin[2] ? ' — прилип к слову «' + ((words[+pin[2].slice(2)] || {}).w || '?') + '»' : ''}. Тяни на слово голоса.`,
          onmousedown: ev => this.dragMarker(ev, u, m) }, h('span', '⚑ ' + (m.name || ''))));
      }
    }
    for (const ph of this.holes(d, M)) {                 // S12.7: секции голоса без сцены — заглушки; секция, которую Claude собирает сейчас, — бегущая полоса
      sceneRow.append(h('div.mt-ph', { class: (ph.empty ? 'empty' : '') + (ph.live ? ' live' : ''), style: { left: X(ph.a) + 'px', width: Math.max(6, (ph.b - ph.a) * Z) + 'px' },
        title: d.fast ? `Сцена «${ph.title}» (⚡ быстрый ролик: сцена — код проекта, правки — в чате Claude)` : (ph.live ? 'Claude собирает: ' + (ph.note || '') + '\n' : '') + (ph.empty ? `Сцены нет: «${ph.title}» — заглушка (текст голоса в кадре)` : '') },
        h('span', ph.live ? '◌ ' + (ph.note || 'Claude собирает…') : ph.title || 'нет сцены')));
    }
    rows.push(['Сцены', sceneRow, 1]);
    // правки автора (пометки на кадре): отрезок «с … по …» или точка; клик — к кадру и карточка правки
    const NL = this.notesLane(d);
    if (NL) rows.push(['Правки', NL.lane, NL.n]);
    // S21 «Сторож монтажа» (montage guard -> d.guard): красные — застряли / пропали рывком, жёлтые — прыжки и мелочь. Клик — к моменту, двойной — Claude чинит
    const GI = window.AgentPanel ? AgentPanel.openGuard(d) : ((d.guard || {}).issues || []).filter(x => x.status !== 'ok');   // «✓ так задумано» не показываем
    if (GI.length) {
      const gl = h('div.mt-lane.guard'), gend = [];
      GI.forEach(x => {
        const a = x.t0 != null ? x.t0 : x.t, b = x.t1 != null ? x.t1 : a + 0.15;
        let k = gend.findIndex(e => e <= a + 1e-3); if (k < 0) { k = gend.length; gend.push(0); } gend[k] = Math.max(b, a + 60 / Z);
        const what = window.AgentPanel ? AgentPanel.gtext(x) : x.type;
        const where = `${(+a).toFixed(2)} с, сцена ${(x.k || 0) + 1}${x.scene ? ` «${x.scene}»` : ''}`;
        gl.append(h('div.mt-guard', { class: x.type + (window.AgentPanel && AgentPanel.gbad(x) ? ' bad' : ''), style: { left: X(a) + 'px', width: Math.max(10, (b - a) * Z) + 'px', top: 3 + k * 22 + 'px' },
          title: `🛡 ${what}
${where}
клик — к моменту · двойной клик — Claude чинит · все находки — во вкладке «Правки» Claude`,
          onmousedown: ev => { ev.stopPropagation(); MT.t = +(x.tShot != null ? x.tShot : a).toFixed(2); MontagePreview.seek(MT.t); this.playhead(); },
          ondblclick: ev => { ev.stopPropagation(); if (window.AgentPanel) { AgentPanel.toggle(true); AgentPanel.fixNotes(d, [], [], [x]); } } },
          h('span', Z >= 30 ? what : '')));
      });
      rows.push([`Сторож · ${GI.length}`, gl, Math.max(1, gend.length)]);
    }
    // текст и голос (S12): сверху слова — что звучит (из них субтитры и привязка сцен), под ними волна голоса
    if (words.length) {
      const vr = h('div.mt-lane.voice', { class: this.voiceOn(d) ? '' : 'off' });
      for (const w of words) vr.append(h('div.mt-word', { style: { left: X(w.t) + 'px', width: Math.max(4, (w.e - w.t) * Z - 1) + 'px' }, title: `${w.w} · ${w.t.toFixed(2)} с — клик: перейти`, 'data-i': w.i,
        onmousedown: ev => { ev.stopPropagation(); MT.t = +w.t.toFixed(2); MontagePreview.seek(MT.t); this.playhead(); } }, Z >= 40 ? w.w : ''));
      const wave = h('div.mt-wave');
      vr.append(wave);
      this.waves(d, wave, X);
      rows.push([MSnd.head(d, M, MSnd.tracks(M).find(t => t.kind === 'voice'), 'Текст и голос'), vr, 2]);
    }
    // S23: музыка и звуки — дорожки звукового редактора (audio_tl.js); надписи — полосами без наложений
    rows.push(...MSnd.rows(d, M, X));
    const laneOf = (items, t0, t1) => { const ends = []; return items.map(it => { const a = t0(it); let k = ends.findIndex(e => e <= a + 1e-3); if (k < 0) { k = ends.length; ends.push(0); } ends[k] = t1(it); return k; }); };
    const group = (list, title, cls, dur, label) => {
      const items = [...(M[list] || [])].sort((a, b) => (a.at || 0) - (b.at || 0)), lanes = laneOf(items, it => it.at || 0, it => (it.at || 0) + dur(it));
      const lane = h('div.mt-lane');
      items.forEach((it, i) => lane.append(bar(list, it, it.at || 0, dur(it), label(it), cls, { lane: lanes[i], edge: list !== 'sfx' })));
      rows.push([title, lane, Math.max(1, ...lanes.map(k => k + 1))]);
    };
    if ((M.overlays || []).length) group('overlays', 'Надписи', 'ov', it => it.dur || 2, it => it.text || it.kind);
    const body = h('div.mt-rows', { style: { width: width + 'px' } },
      rows.map(([t, lane, n, px]) => h('div.mt-row', { style: { height: (px || n * 22 + 6) + 'px' }, 'data-track': lane.dataset.track || null },
        t instanceof Node ? t : h('div.mt-rowlabel', typeof Icon === 'function' && { 'Сцены': 'clapper', 'Правки': 'pin', 'Текст и голос': 'filetext', 'Музыка': 'music', 'Звуки': 'volume', 'Надписи': 'type', 'Сторож': 'shield' }[t.split(' ·')[0]] ? Icon({ 'Сцены': 'clapper', 'Правки': 'pin', 'Текст и голос': 'filetext', 'Музыка': 'music', 'Звуки': 'volume', 'Надписи': 'type', 'Сторож': 'shield' }[t.split(' ·')[0]], 13) : null, t), lane)),
      h('div.mt-playhead', { style: { left: X(MT.t) + 'px' }, title: 'Тяните — перемотка', onmousedown: ev => this.scrub(ev) }),
      h('div.mt-end', { style: { left: X(M.len || 0) + 'px' }, title: `конец ролика — ${(M.len || 0).toFixed(2)} с` }));
    return h('div.mt-scroll', ruler, body, h('div.mt-selbar', { hidden: !(TLSel.kind && TLSel.ids.size > 1) }, TLSel.kind && TLSel.ids.size > 1 ? TLSel.barText() : ''));
  },
  // дорожка правок отдельно от таймлайна: правка / перетаскивание / удаление пометки перерисовывает только её (не волну голоса и не сцены) — без мигания
  notesLane(d) {
    const notes = typeof Workspace !== 'undefined' && Workspace.notesOpen ? Workspace.notesOpen(d).sort((a, b) => a.t - b.t) : [];
    if (!notes.length) return null;
    const Z = MT.zoom, X = t => MT_LABEL + t * Z, nl = h('div.mt-lane.notes'), ends = [];
    notes.forEach((n, i) => {
      const b = n.t2 != null ? n.t2 : n.t + 0.4;
      let k = ends.findIndex(e => e <= n.t + 1e-3); if (k < 0) { k = ends.length; ends.push(0); } ends[k] = b;
      nl.append(h('div.mt-note', { class: (n.t2 != null ? 'range' : '') + ((n.refs || []).length || (n.assets || []).length ? ' ref' : '') + (TLSel.has('notes', n.id) ? ' sel' : ''), 'data-id': n.id,
        style: { left: X(n.t) + 'px', width: Math.max(14, (b - n.t) * Z) + 'px', top: 3 + k * 22 + 'px' },
        title: `${Workspace.fmt(n.t)}${n.t2 != null ? '–' + Workspace.fmt(n.t2) : ''} · ${n.text}${(n.refs || []).length ? ` · картинок: ${n.refs.length}` : ''}${(n.assets || []).length ? ` · ассетов: ${n.assets.length}` : ''}\nклик — открыть · Ctrl/Shift+клик — выделить несколько · рамка по пустому месту — выделить · за край — растянуть · за середину — сдвинуть (выделенные — вместе) · Delete — удалить · Ctrl+Z — отменить`,
        onmousedown: ev => this.dragNote(ev, d, n) }, h('i.edge.l'), h('span', `${i + 1} ${n.text}`), h('i.edge.r')));
    });
    nl.addEventListener('mousedown', ev => TLSel.marquee(ev, 'notes', nl));
    return { lane: nl, n: Math.max(1, ends.length) };
  },
  refreshNotes() {
    const d = MT.d; if (!d) return;
    const cur = $('.mt-lane.notes'), NL = this.notesLane(d);
    const row = cur && cur.closest('.mt-row');
    if (cur && NL && row && row.style.height === NL.n * 22 + 6 + 'px') { cur.replaceWith(NL.lane); return; }   // та же высота дорожки — подмена на месте
    this.redraw();                                                                                            // появилась / пропала дорожка или стала выше — весь таймлайн
  },
  // правка на таймлайне как клип в Premiere: за край — начало / конец, за середину — сдвиг всего отрезка, клик без движения — открыть правку.
  // Края прилипают к плейхеду (8 px); правка в один кадр, растянутая за правый край, становится отрезком.
  dragNote(ev, d, n) {
    if (ev.button !== 0) return;
    ev.stopPropagation(); ev.preventDefault();
    const el = ev.currentTarget, Z = MT.zoom, x0 = ev.clientX, a0 = n.t, b0 = n.t2 != null ? n.t2 : null;
    const mode = ev.target.classList.contains('l') ? 'l' : ev.target.classList.contains('r') ? 'r' : 'move';
    if (mode === 'move' && !(ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
      if (!TLSel.has('notes', n.id)) TLSel.set('notes', [n.id]);     // взяли невыделенную — выделяется она одна
      if (TLSel.ids.size > 1) return TLSel.drag(ev, d, 'notes', n.id, el);
    }
    const end0 = b0 != null ? b0 : a0 + 0.4, min = 0.1, total = Math.max(Montage.M(d).len || 0, this.autoLen(d, Montage.M(d)));
    const snap = t => Math.abs((t - MT.t) * Z) < 8 ? MT.t : t;
    let a = a0, b = b0, moved = false;
    const tip = h('div.mt-note-tip'); document.body.append(tip);
    const show = e => { tip.textContent = Workspace.fmt(a) + (b != null ? ' – ' + Workspace.fmt(b) + ` · ${(b - a).toFixed(1)} с` : ''); tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px'; };
    const mv = e => {
      const dt = (e.clientX - x0) / Z;
      if (!moved && Math.abs(e.clientX - x0) < 3) return;
      moved = true; document.body.classList.add('mt-dragging');
      if (mode === 'l') { a = Math.max(0, Math.min(snap(a0 + dt), end0 - min)); if (b == null) b = +end0.toFixed(2); }
      else if (mode === 'r') b = Math.min(total, Math.max(snap(end0 + dt), a0 + min));
      else { const w = end0 - a0; a = Math.max(0, Math.min(total - w, a0 + dt)); const sa = snap(a), sb = snap(a + w); a = sa !== a ? sa : sb !== a + w ? sb - w : a; if (b0 != null) b = a + w; }
      el.style.left = (MT_LABEL + a * Z) + 'px';
      el.style.width = Math.max(14, ((b != null ? b : a + 0.4) - a) * Z) + 'px';
      show(e);
    };
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); tip.remove(); document.body.classList.remove('mt-dragging');
      if (!moved) { App.resume(); return TLSel.ADAPT.notes.click(ev, n.id); }
      Workspace.noteEdit('сдвиг правки', key => {
        Store.set(key, ['notes', n.id, 't'], +a.toFixed(2));
        Store.set(key, ['notes', n.id, 't2'], b == null ? null : +b.toFixed(2));
      });
      App.resume();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  // секции голоса (сцены сценария), которые не покрыты юнитами монтажа, и та, которую агент собирает сейчас (video.json → live)
  holes(d, M) {
    const I = MT.info[d.id] || {}, V = I.voice && !I.voice.studio ? I.voice.sections || [] : [];
    const live = d.live && window.AgentPanel && AgentPanel.busy && AgentPanel.vid === d.id ? d.live : null;
    const out = [];
    V.forEach((s, i) => {
      const a = s.start || 0, b = a + (s.dur || 0);
      if (b - a < 0.05) return;
      const cov = (M.units || []).reduce((acc, u) => acc + Math.max(0, Math.min(b, (u.at || 0) + (u.len || 0)) - Math.max(a, u.at || 0)), 0);
      const empty = cov < (b - a) * 0.5, isLive = !!live && +live.sec === i;
      if (empty || isLive) out.push({ i, a, b, title: (s.title || '').replace(/^[\d:.,–—\s-]+—\s*/, ''), empty, live: isLive, note: isLive ? live.note : '' });
    });
    return out;
  },
  // волна голоса под словами: секции голоса (audiomap) -> canvas на каждую, минимум / максимум на пиксель
  waves(d, host, X) {
    const Z = MT.zoom;
    MTA.load(d).then(map => {
      for (const v of (map && map.voice) || []) MTA.buf(v.url).then(b => {
        if (!b || !host.isConnected) return;
        const w = Math.max(1, Math.min(16000, Math.round(b.duration * Z))), H = 22;
        const key = v.url + '|' + w;
        const cv = h('canvas', { width: w, height: H, style: { left: X(v.at) - MT_LABEL + 'px', width: w + 'px' } });
        const c = cv.getContext('2d'), data = b.getChannelData(0), step = data.length / w;
        const P = (MTA.peaks = MTA.peaks || {});
        const peaks = P[key] || (P[key] = Array.from({ length: w }, (_, x) => {
          let mn = 1, mx = -1; const a = Math.floor(x * step), e = Math.min(data.length, Math.floor((x + 1) * step));
          for (let i = a; i < e; i += 8) { const q = data[i]; if (q < mn) mn = q; if (q > mx) mx = q; }
          return [mn, mx];
        }));
        c.fillStyle = '#7d8a9e';
        peaks.forEach(([mn, mx], x) => { const y0 = (1 - Math.min(1, mx * 1.6)) * H / 2, y1 = (1 - Math.max(-1, mn * 1.6)) * H / 2; c.fillRect(x, y0, 1, Math.max(1, y1 - y0)); });
        host.append(cv);
      });
    });
  },
  xToT(ev) {
    const r = $('.mt-rows').getBoundingClientRect();
    return Math.max(0, (ev.clientX - r.left - MT_LABEL) / MT.zoom);
  },
  // перемотка (линейка или сам ползунок): позиция мыши применяется раз в кадр — раньше каждое движение мыши слало видео новую перемотку,
  // они копились, и ползунок «залипал»; на время протаскивания воспроизведение на паузе, таймлайн не перерисовывается (Workspace.holding)
  scrub(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const ws = typeof Workspace !== 'undefined' && App.route.page === 'v';
    if (ws && WS.playing) Workspace.pause();
    let x = ev, raf = 0;
    const apply = () => { raf = 0; MT.t = +this.xToT(x).toFixed(2); this.playhead(); MontagePreview.seek(MT.t); };
    const move = e => { x = e; if (!raf) raf = requestAnimationFrame(apply); };
    document.body.classList.add('mt-scrubbing');
    apply();
    const up = e => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
      x = e; apply();
      document.body.classList.remove('mt-scrubbing');
      App.resume();
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  },
  playhead() {
    const p = $('.mt-playhead'); if (p) p.style.left = MT_LABEL + MT.t * MT.zoom + 'px';
    const e = $('.mt-time'); if (e) e.textContent = typeof Workspace !== 'undefined' && App.route.page === 'v' ? Workspace.fmt(MT.t) : MT.t.toFixed(2) + ' с';
    if (typeof Workspace !== 'undefined' && App.route.page === 'v') Workspace.onTime();
  },
  // сдвиг полосы (at) или край (длина): юнит — len и хвост карты, музыка — dur, надпись — dur
  startDrag(ev, list, it, edgeOk) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const el = ev.currentTarget, r = el.getBoundingClientRect(), edge = edgeOk && ev.clientX > r.right - 7;
    const M = this.clone(this.M(MT.d)), x0 = ev.clientX, item = (M[list] || []).find(x => x.id === it.id);
    if (!item) return;
    const at0 = item.at || 0, len0 = list === 'units' ? item.len : item.dur || Math.max(0.5, this.srcDur(MT.d, item.src) - (item.from || 0));
    let moved = false;
    const move = e => {
      const dt = Math.round(((e.clientX - x0) / MT.zoom) * 20) / 20;
      if (Math.abs(e.clientX - x0) > 2) moved = true;
      if (!moved) return;
      if (edge) {
        const L = Math.max(0.2, len0 + dt);
        el.style.width = L * MT.zoom + 'px';
        if (list === 'units') { item.len = L; const last = item.map.reduce((a, p) => (p[0] > a[0] ? p : a), item.map[0]); if (typeof last[1] === 'number') last[1] = L; } else item.dur = L;
      } else { item.at = Math.max(0, +(at0 + dt).toFixed(2)); el.style.left = MT_LABEL + item.at * MT.zoom + 'px'; }
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (moved) { MT.sel = { list, id: it.id }; MT.multi = list === 'units' ? [it.id] : []; this.save(M); }
      else this.pick(list, it.id, ev);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  },
  // клик по полосе: выбрать; у сцен Ctrl — добавить / убрать, Shift — диапазон (как в Premiere). MT.multi — выбранные сцены (для чата: S12.4)
  pick(list, id, ev = {}) {
    if (list !== 'units') { MT.sel = { list, id }; MT.multi = []; return this.redraw(); }
    const order = [...(this.M(MT.d).units || [])].sort((a, b) => (a.at || 0) - (b.at || 0)).map(u => u.id);
    let cur = (MT.multi || []).filter(x => order.includes(x));
    if (ev.ctrlKey || ev.metaKey) cur = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    else if (ev.shiftKey && MT.sel && MT.sel.list === 'units' && order.includes(MT.sel.id)) {
      const a = order.indexOf(MT.sel.id), b = order.indexOf(id);
      cur = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else cur = [id];
    MT.multi = cur;
    MT.sel = cur.length ? { list, id: cur.includes(id) ? id : cur[cur.length - 1] } : null;
    this.redraw();
  },
  // маркер сцены тянется по ролику; отпустил у слова — пара карты [t маркера, "w:i"], иначе [t маркера, время]
  dragMarker(ev, u, m) {
    ev.preventDefault(); ev.stopPropagation();
    const el = ev.currentTarget, words = this.voiceOn(MT.d) ? this.words(MT.d) : [];
    let tv = null, wi = null;
    const move = e => {
      tv = this.xToT(e); wi = null;
      const near = words.reduce((b, w) => (Math.abs(w.t - tv) < Math.abs((b ? b.t : 1e9) - tv) ? w : b), null);
      if (near && Math.abs(near.t - tv) * MT.zoom < 14) { tv = near.t; wi = near.i; }
      el.style.left = MT_LABEL + tv * MT.zoom + 'px';
      el.classList.toggle('word', wi != null);
      $$('.mt-word.hot').forEach(x => x.classList.remove('hot'));
      if (wi != null) { const w = $(`.mt-word[data-i="${wi}"]`); if (w) w.classList.add('hot'); }
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (tv == null) return;
      const M = this.clone(this.M(MT.d)), U = M.units.find(x => x.id === u.id);
      const map = (U.map || [[0, 0], [U.len, U.len]]).filter(p => Math.abs(p[0] - m.t) > 1e-3);
      map.push([m.t, wi != null ? 'w:' + wi : +(tv - (U.at || 0)).toFixed(3)]);
      map.sort((a, b) => a[0] - b[0]);
      const P = this.pairs(MT.d, { ...U, map });
      if (P.some((p, i) => i && p[1] <= P[i - 1][1])) { UI.toast('Так сцена пошла бы назад: маркер не может обогнать соседние точки карты', 'err'); this.redraw(); return; }
      U.map = map; MT.sel = { list: 'units', id: U.id };
      this.save(M);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  },

  // ---------------- свойства выбранного
  props(d, M) {
    if (TLSel.kind === 'clips') return MSnd.props(d, M);           // S23: выбранные звуки
    const S = MT.sel, list = S && M[S.list], it = list && list.find(x => x.id === S.id);
    if (!it) return h('p.dim.small', 'Клик по полосе — свойства. Тяни полосу — сдвиг, край — длина; линейка — перемотка; маркер сцены ⚑ тяни на слово голоса.');
    const set = (path, v) => { const N = this.clone(M), x = N[S.list].find(y => y.id === it.id); let o = x; for (const p of path.slice(0, -1)) o = o[p] = o[p] || {}; o[path[path.length - 1]] = v; this.save(N); };
    const num = (label, path, step = 0.05, title) => h('label.mt-f', { title }, label, h('input', { type: 'number', step, value: path.reduce((o, p) => (o || {})[p], it) ?? '',
      onchange: ev => set(path, ev.target.value === '' ? null : +ev.target.value) }));
    const del = h('button.danger', { onclick: () => { const N = this.clone(M); N[S.list] = N[S.list].filter(x => x.id !== it.id); MT.sel = null; this.save(N); } }, '🗑 убрать');
    const I = MT.info[d.id];
    if (S.list === 'units') {
      const P = this.pairs(d, it), W = this.words(d);
      return h('div.mt-propbox',
        h('div.row', h('b', '🎬 Сцена'), msel((I.scenes || []).map(s => [s.el, s.name]), it.scene, v => set(['scene'], v)),
          num('с', ['at']), num('длина', ['len']),
          h('label.mt-f', 'переход', msel(MT_TRANS.map(x => [x, x]), (it.trans || {}).type || 'cut', v => set(['trans', 'type'], v))), num('за', ['trans', 'dur'], 0.05), h('span.sp'), del),
        h('div.small.dim', 'Карта времени (сцена → ролик): между точками сцена идёт равномерно — так она растягивается и сжимается под голос.'),
        h('div.mt-map', P.map(p => h('span.mt-pair', `${p[0]} с → ${p[2] ? '«' + ((W[+p[2].slice(2)] || {}).w || '?') + '» ' + p[1].toFixed(2) + ' с' : p[1].toFixed(2) + ' с'}`,
          P.length > 2 && h('button.x', { title: 'убрать точку', onclick: () => { const N = this.clone(M), x = N.units.find(y => y.id === it.id); x.map = x.map.filter(q => Math.abs(q[0] - p[0]) > 1e-3); this.save(N); } }, '×')))));
    }
    const srcSel = () => {
      const opts = (I.sources || []).map(s => [s.src, '🎛 ' + s.name]);
      const cur = String(it.src || '');
      if (cur && !opts.some(o => o[0] === cur)) opts.push([cur, this.srcName(d, cur)]);
      return h('span.row', msel(opts, cur, v => set(['src'], v)),
        h('input.mt-lib', { list: 'mt-libs', placeholder: 'lib:… из библиотеки', title: 'Звук библиотеки пайплайна: lib:<id> (кусок — lib:<id>|смещение|длина)',
          onchange: ev => { const v = ev.target.value.trim(); if (v) set(['src'], v.startsWith('lib:') || v.startsWith('file:') ? v : 'lib:' + v); } }),
        h('datalist#mt-libs', (I.lib || []).map(x => h('option', { value: 'lib:' + x[0] }, `${x[2]} · ${x[1]} с`))));
    };
    if (S.list === 'music') return h('div.mt-propbox', h('div.row', h('b', '🎵 Музыка'), srcSel(), h('span.sp'), del),
      h('div.row', num('с', ['at']), num('громк.', ['gain']), num('с места', ['from'], 0.1, 'откуда в файле брать'), num('длина', ['dur'], 0.1),
        num('вход', ['fadeIn'], 0.1), num('выход', ['fadeOut'], 0.1), h('label.mt-f', 'заметка', h('input', { value: it.note || '', onchange: ev => set(['note'], ev.target.value) }))));
    if (S.list === 'sfx') return h('div.mt-propbox', h('div.row', h('b', '🔊 Звук'), srcSel(), h('span.sp'), del),
      h('div.row', num('с', ['at']), num('громк.', ['gain']),
        h('label.mt-f', 'момент', msel([['', 'начало звука'], ['peak', 'пик звука']], it.align || '', v => set(['align'], v))),
        h('label.mt-f', 'заметка', h('input', { value: it.note || '', onchange: ev => set(['note'], ev.target.value) }))));
    return h('div.mt-propbox', h('div.row', h('b', '🔤 Надпись'), h('label.mt-f', 'вид', msel([['pov', 'POV / титр сверху'], ['title', 'заголовок'], ['note', 'листок']], it.kind || 'pov', v => set(['kind'], v))),
      num('с', ['at']), num('длина', ['dur'], 0.1), num('кегль', ['size'], 2), num('y', ['y'], 10), h('span.sp'), del),
      h('textarea.mt-text', { rows: 2, value: it.text || '', onchange: ev => set(['text'], ev.target.value) }));
  },
};

// предпросмотр — плеер кадров проекта (src/index.html?preview) в своём окне поверх страницы: перерисовка страницы его не перезагружает
// 🔊 живой звук монтажа (S11): страница сама сводит голос, звуки сцен, sfx и музыку (Web Audio) по текущему монтажу — правка слышна сразу.
// Источники и звуки сцен — /api/montage/audiomap; те же правила, что у audio.py: пик к моменту (align peak), библиотека — к пику 0.9, срезы lib:id|с|длина,
// у звуков — затухание после пика, у музыки — from / dur / fadeIn / fadeOut. Готовый mp4 сводит build.sh как раньше.
const MTA = {
  ctx: null, map: null, vid: null, bufs: {}, info: {}, nodes: [], on: false, t0: 0, c0: 0,
  async load(d, force) {
    if (!force && this.vid === d.id && this.map) return this.map;
    this.vid = d.id;
    try { this.map = await api('GET', '/api/montage/audiomap?video=' + encodeURIComponent(d.id)); } catch (e) { this.map = { srcs: {}, scenes: {}, voice: [] }; }
    return this.map;
  },
  ac() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; },
  out() {                                                // общий выход: выключить звук (S12) — громкость 0, сведение не перестраивается
    if (!this.master) { this.master = this.ac().createGain(); this.master.connect(this.ctx.destination); }
    this.master.gain.value = this.muted ? 0 : 1;
    return this.master;
  },
  mute(on) { this.muted = on; if (this.master) this.master.gain.value = on ? 0 : 1; },
  buf(url) {
    if (!this.bufs[url]) this.bufs[url] = fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(a => this.ac().decodeAudioData(a)).then(b => {
      let mx = 0, at = 0;
      for (let c = 0; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let i = 0; i < x.length; i += 4) { const v = Math.abs(x[i]); if (v > mx) { mx = v; at = i; } } }
      this.info[url] = { peak: at / b.sampleRate, norm: mx > 0 ? 0.9 / mx : 1 };
      return b;
    }).catch(() => null);
    return this.bufs[url];
  },
  // S23: сигналы живого звука = те же, что пишет генератор (montage_api.generate): плашки с in / out / dur / loop / фейдами, громкость и mute дорожек,
  // solo (только здесь — в экспорт не идёт), приглушение музыки по словам голоса (MSnd.duckRuns), уровни шин как в audio.py (музыка 0.5, звуки 0.4).
  cues(d) {
    const M = this.override || Montage.M(d), map = this.map || { srcs: {}, scenes: {}, voice: [] }, out = [];
    const T = MSnd.tracks(M), solo = T.some(t => t.solo);
    const tg = t => (!t || t.mute || (solo && !t.solo)) ? 0 : Math.pow(10, (+t.gain || 0) / 20);
    const lay = (src, t, gain, x, kind, tr) => {
      const L = map.srcs[src] || [], c = x ? MSnd.clipOf(x, kind === 'music') : null;
      for (const l of L) {
        const lc = MSnd.layerClip(c, l.at || 0, L.length); if (!lc) continue;
        out.push({ url: l.url, t: t + lc[0], gain: gain * (l.gain == null ? 1 : l.gain), lib: l.lib, peak: l.peak, off: l.off || 0, dur: l.len || null, clip: lc[1],
          align: (x && x.align) || '', kind, sfx: kind === 'sfx', music: kind === 'music', duck: kind === 'music' && !((M.duck || {}).off || []).includes(tr && tr.id) });
      }
    };
    const vt = T.find(t => t.kind === 'voice'), vg = tg(vt);
    if ((M.voice || {}).on && vg) for (const v of map.voice || []) out.push({ url: v.url, t: v.at, gain: vg, off: 0, dur: null, voice: true, kind: 'voice' });
    for (const u of M.units || []) {
      const P = Montage.pairs(d, u), a = u.at || 0, b = a + (u.len || 0);
      for (const s of map.scenes[u.scene] || []) {
        const tv = Montage.s2v(P, s.t); if (tv < a - 0.05 || tv >= b) continue;
        const tr = MSnd.trackOf(T, s.track, 'sfx'), g = tg(tr); if (!g) continue;
        lay(s.src, tv, s.gain * g, s, 'sfx', tr);
      }
    }
    for (const x of M.sfx || []) { const tr = MSnd.trackOf(T, x.track, 'sfx'), g = tg(tr); if (g) lay(x.src, x.at || 0, (x.gain == null ? 1 : x.gain) * g, x, 'sfx', tr); }
    for (const x of M.music || []) { const tr = MSnd.trackOf(T, x.track, 'music'), g = tg(tr); if (g) lay(x.src, x.at || 0, (x.gain == null ? 1 : x.gain) * g, x, 'music', tr); }
    return out;
  },
  warm(d) { this.load(d).then(() => { for (const c of this.cues(d)) this.buf(c.url); }); },
  now() { return this.on ? this.t0 + (this.ctx.currentTime - this.c0) : MT.t; },
  stop() { for (const n of this.nodes) { try { n.stop(); } catch (e) {} } this.nodes = []; this.on = false; clearTimeout(this.pvTimer); },
  bus(level) { const g = this.ac().createGain(); g.gain.value = level; g.connect(this.out()); this.nodes.push({ stop: () => g.disconnect() }); return g; },
  async play(d, t, force) {
    const my = (this.playId = (this.playId || 0) + 1);
    this.stop();
    const ctx = this.ac(); if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    await this.load(d);
    const C = this.cues(d);
    await Promise.all(C.map(c => this.buf(c.url)));      // обычно уже в кэше (warm); первый раз — подождать декод
    if (my !== this.playId || !(MT.playing || force)) return;
    if (!force) t = MT.t != null ? MT.t : t;              // за время загрузки кадры могли уйти вперёд
    const c0 = ctx.currentTime + 0.04;
    this.t0 = t; this.c0 = c0; this.on = true;
    const M = this.override || Montage.M(d), at = s => c0 + (s - t);   // время ролика -> время звука
    // шины как в audio.py: голос × 1, звуки × 0.4, музыка × 0.5 (под ней — приглушение по словам, duck_words)
    const B = { voice: this.bus(1), sfx: this.bus(0.4), music: this.bus(0.5), duck: this.bus(0.5) };
    const D = Object.assign({ on: true, depth: -6, attack: 0.15, release: 0.4 }, M.duck || {});
    if (D.on && (M.voice || {}).on) {
      const low = 0.5 * Math.pow(10, D.depth / 20), g = B.duck.gain;
      const lvl = x => { let k = 0; for (const [a, b] of MSnd.duckRuns(d)) k = Math.max(k, Math.min(Math.max(0, Math.min(1, (x - (a - D.attack)) / D.attack)), Math.max(0, Math.min(1, ((b + D.release) - x) / D.release)))); return 0.5 - (0.5 - low) * k; };
      g.setValueAtTime(lvl(t), c0);
      for (const [a, b] of MSnd.duckRuns(d)) {
        const a0 = a - D.attack, b1 = b + D.release;
        if (b1 <= t) continue;
        if (a0 > t) { g.setValueAtTime(0.5, at(a0)); g.linearRampToValueAtTime(low, at(a)); }
        if (b > t) { g.setValueAtTime(low, at(b)); g.linearRampToValueAtTime(0.5, at(b1)); }
      }
    }
    for (const c of C) {
      const b = await this.bufs[c.url]; if (!b) continue;
      const inf = this.info[c.url] || {}, dest = c.voice ? B.voice : c.music ? (c.duck ? B.duck : B.music) : B.sfx;
      const base = c.gain * (c.sfx ? inf.norm || 1 : 1);   // audio.py нормирует звуки (file: и lib:) к пику 0.9; музыку и голос — нет
      if (c.clip) { this.playClip(ctx, b, inf, c, base, t, at, dest); continue; }
      let start = c.t;
      if (c.align === 'peak') start -= (c.peak != null && c.off === 0 ? c.peak : inf.peak - c.off) || 0;
      const avail = Math.max(0, b.duration - c.off);
      const len = Math.min(c.dur || avail, avail);
      const end = start + len;
      if (end <= t || len <= 0.01) continue;
      const skip = Math.max(0, t - start), when = c0 + Math.max(0, start - t);
      const src = ctx.createBufferSource(); src.buffer = b;
      const g = ctx.createGain();
      g.gain.setValueAtTime(base, when);
      const fo = c.sfx ? Math.min(1.2, Math.max(0.12, (end - Math.max(start, start + (inf.peak || 0) - c.off)) * 0.5)) : 0;
      if (fo > 0 && end - fo > t) { g.gain.setValueAtTime(base, at(end - fo)); g.gain.linearRampToValueAtTime(0.0001, at(end)); }
      src.connect(g).connect(dest);
      src.start(when, c.off + skip, Math.max(0.01, len - skip));
      this.nodes.push(src);
    }
  },
  // S23: плашка — куски файла (MSnd.pieces), швы цикла — равномощный кроссфейд, фейды плашки; fadeOut null у звука — авто-затухание после пика (fade_out в audio.py)
  playClip(ctx, b, inf, c, base, t, at, dest) {
    const off0 = c.off || 0, srcLen = Math.max(0.02, c.dur || (b.duration - off0));   // срез lib:id|с|длина — окно файла
    const cl = c.clip, P = MSnd.pieces(cl, srcLen), total = Math.max(...P.map(p => p[0] + p[2]));
    const pk = (c.lib && c.peak != null && !off0 ? c.peak : (inf.peak || 0) - off0) - (cl.in || 0);
    let start = c.t;
    if (c.align === 'peak' && pk > 0) start -= pk;
    const end = start + total;
    if (end <= t || total <= 0.01) return;
    const fo = cl.fadeOut == null ? (c.sfx ? Math.min(1.2, Math.max(0.12, (total - Math.max(0, pk)) * 0.5)) : 0) : +cl.fadeOut;
    const fi = +cl.fadeIn || 0;
    const env = x => { let k = 1; if (fi > 0 && x < fi) k = Math.min(k, x / fi); if (fo > 0 && x > total - fo) k = Math.min(k, (total - x) / fo); return Math.max(0.0001, k * base); };
    const g = ctx.createGain(); g.connect(dest);
    const s0 = Math.max(t, start);
    g.gain.setValueAtTime(env(s0 - start), at(s0));
    if (fi > 0 && s0 - start < fi) g.gain.linearRampToValueAtTime(env(fi), at(start + fi));
    if (fo > 0) { if (end - fo > s0) g.gain.setValueAtTime(env(total - fo), at(end - fo)); g.gain.linearRampToValueAtTime(0.0001, at(end)); }
    const N = 32, curve = (fn, x0, len) => { const arr = new Float32Array(N); for (let i = 0; i < N; i++) arr[i] = Math.max(0.0001, fn(x0 + (i / (N - 1)) * len)); return arr; };
    for (const [pt, poff, plen, xi, xo] of P) {
      const a = start + pt, e = a + plen;
      if (e <= t) continue;
      const skip = Math.max(0, t - a), when = at(Math.max(a, t));
      const src = ctx.createBufferSource(); src.buffer = b;
      const pg = ctx.createGain();
      if (xi > 0 && skip < xi) pg.gain.setValueCurveAtTime(curve(x => Math.sin(Math.min(1, x / xi) * Math.PI / 2), skip, xi - skip), when, xi - skip);
      else pg.gain.setValueAtTime(1, when);
      if (xo > 0) { const x0 = Math.max(skip, plen - xo, xi); if (plen - x0 > 0.005) pg.gain.setValueCurveAtTime(curve(x => Math.cos(Math.min(1, Math.max(0, (x - (plen - xo)) / xo)) * Math.PI / 2), x0, plen - x0), at(a + x0), plen - x0); }
      src.connect(pg).connect(g);
      src.start(when, off0 + poff + skip, Math.max(0.01, plen - skip));
      this.nodes.push(src);
    }
  },
  // S23: прослушать кусок ролика с другим монтажом (замена звука «на месте»): from — секунда ролика, len — сколько
  async preview(d, M2, from, len) {
    this.override = M2;
    try { await this.play(d, Math.max(0, from), true); } finally { this.override = null; }
    clearTimeout(this.pvTimer); this.pvTimer = setTimeout(() => { if (!MT.playing) this.stop(); }, len * 1000 + 80);
  },
};

// Множественное выделение на таймлайне — общее для дорожек. Дорожка подключается адаптером TLSel.ADAPT[kind]:
//   items(d) -> [{id, a, b|null}] (b = null — «точка»), apply(edits:[{id, a, b}], label) — сохранить сдвиг пачкой (с Ctrl+Z),
//   del(ids, label) — удалить пачкой, sel: CSS-селектор полос дорожки с data-id. Сейчас подключены правки (notes); сцены, звуки, музыка, надписи — следующими.
// Ctrl / Shift + клик — добавить / убрать, рамка по пустому месту дорожки, перетаскивание выделенной полосы — вся группа, Delete — удалить, Esc — снять, Ctrl+A — все.
const TLSel = {
  kind: null, ids: new Set(), ADAPT: {},
  has(kind, id) { return this.kind === kind && this.ids.has(id); },
  set(kind, ids) { this.kind = ids.length ? kind : null; this.ids = new Set(ids); this.mark(); },
  toggle(kind, id) {
    if (this.kind !== kind) this.set(kind, [id]);
    else { this.ids.has(id) ? this.ids.delete(id) : this.ids.add(id); if (!this.ids.size) this.kind = null; this.mark(); }
  },
  clear() { if (this.kind) this.set(null, []); },
  barText() { const A = this.ADAPT[this.kind] || {}; return A.bar ? A.bar(this.ids.size) : `Выделено: ${this.ids.size} · тяните — двигать вместе · Delete — удалить · Esc — снять`; },
  mark() {                                                    // подсветка без перерисовки таймлайна
    for (const [k, A] of Object.entries(this.ADAPT)) $$(A.sel).forEach(el => el.classList.toggle('sel', this.has(k, el.dataset.id)));
    const n = this.kind ? this.ids.size : 0, bar = $('.mt-selbar');
    if (bar) { bar.hidden = n < 2; bar.textContent = n > 1 ? this.barText() : ''; }
    const A = this.kind && this.ADAPT[this.kind]; if (A && A.onSel) A.onSel();
  },
  // перетаскивание группы: grab — полоса, за которую взяли; snap — к ползунку по любому краю любого выделенного
  drag(ev, d, kind, grabId, el0) {
    const A = this.ADAPT[kind], Z = MT.zoom, x0 = ev.clientX, all = A.items(d), group = all.filter(x => this.has(kind, x.id));
    const total = Math.max(Montage.M(d).len || 0, Montage.autoLen(d, Montage.M(d)));
    const lo = Math.min(...group.map(g => g.a)), hi = Math.max(...group.map(g => (g.b != null ? g.b : g.a + 0.4)));
    let dt = 0, moved = false;
    const els = new Map(group.map(g => [g.id, document.querySelector(`${A.sel}[data-id="${CSS.escape(g.id)}"]`)]));
    const tip = h('div.mt-note-tip'); document.body.append(tip);
    const mv = e => {
      if (!moved && Math.abs(e.clientX - x0) < 3) return;
      moved = true; document.body.classList.add('mt-dragging');
      dt = Math.max(-lo, Math.min(total - hi, (e.clientX - x0) / Z));
      let best = null;                                        // прилипание: ближайший край группы к ползунку (8 px)
      for (const g of group) for (const t of [g.a, g.b != null ? g.b : null]) if (t != null) { const k = MT.t - (t + dt); if (Math.abs(k * Z) < 8 && (best == null || Math.abs(k) < Math.abs(best))) best = k; }
      if (best != null) dt += best;
      for (const g of group) { const el = els.get(g.id); if (el) el.style.left = (MT_LABEL + (g.a + dt) * Z) + 'px'; }
      tip.textContent = `${group.length} шт. · ${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)} с`; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px';
    };
    const up = e => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); tip.remove(); document.body.classList.remove('mt-dragging');
      if (!moved) { App.resume(); return A.click && A.click(e, grabId); }
      A.apply(group.map(g => ({ id: g.id, a: +(g.a + dt).toFixed(2), b: g.b != null ? +(g.b + dt).toFixed(2) : null })), `сдвиг ${group.length} правок`);
      App.resume();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  // рамка по пустому месту дорожки: выделить задетые полосы (Ctrl / Shift — добавить к выделенному)
  marquee(ev, kind, lane) {
    if (ev.button !== 0 || ev.target !== lane) return;
    ev.preventDefault(); ev.stopPropagation();
    const A = this.ADAPT[kind], add = ev.ctrlKey || ev.metaKey || ev.shiftKey, base = add && this.kind === kind ? new Set(this.ids) : new Set();
    const R = lane.getBoundingClientRect(), x0 = ev.clientX, y0 = ev.clientY;
    const box = h('div.mt-marquee'); lane.append(box);
    document.body.classList.add('mt-dragging');
    let moved = false;
    const mv = e => {
      const l = Math.min(x0, e.clientX), r = Math.max(x0, e.clientX), t = Math.min(y0, e.clientY), b = Math.max(y0, e.clientY);
      if (!moved && r - l < 4 && b - t < 4) return;
      moved = true;
      Object.assign(box.style, { left: l - R.left + 'px', top: t - R.top + 'px', width: r - l + 'px', height: b - t + 'px' });
      const hit = [...lane.querySelectorAll(A.sel)].filter(el => { const q = el.getBoundingClientRect(); return q.right >= l && q.left <= r && q.bottom >= t && q.top <= b; }).map(el => el.dataset.id);
      this.set(kind, [...new Set([...base, ...hit])]);
    };
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); box.remove(); document.body.classList.remove('mt-dragging');
      if (!moved && !add) this.clear();
      App.resume();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  remove() {
    if (!this.kind || !this.ids.size) return false;
    const A = this.ADAPT[this.kind], ids = [...this.ids];
    A.del(ids, ids.length > 1 ? `удаление ${ids.length} ${A.many || 'правок'}` : 'удаление ' + (A.one || 'правки'));
    this.set(null, []);
    UI.toast(`🗑 Удалено: ${ids.length} · Ctrl+Z — вернуть`);
    return true;
  },
};
// правки (пометки на кадре) — первая дорожка с множественным выделением
TLSel.ADAPT.notes = {
  sel: '.mt-note',
  items(d) { return (typeof Workspace !== 'undefined' ? Workspace.notesOpen(d) : []).map(n => ({ id: n.id, a: n.t, b: n.t2 != null ? n.t2 : null })); },
  apply(edits, label) {
    Workspace.noteEdit(label, key => { for (const x of edits) { Store.set(key, ['notes', x.id, 't'], x.a); Store.set(key, ['notes', x.id, 't2'], x.b); } });
  },
  del(ids, label) { Workspace.noteEdit(label, key => { for (const id of ids) Store.del(key, ['notes'], id, false); }); },
  click(e, id) {                                              // клик без сдвига: Ctrl / Shift — в выделение; иначе — выделить одну и открыть правку
    if (e.ctrlKey || e.metaKey || e.shiftKey) return TLSel.toggle('notes', id);
    TLSel.set('notes', [id]);
    const n = Workspace.notesOpen(MT.d).find(x => x.id === id);
    if (n) Workspace.editPin(n);
  },
};

const MontagePreview = {
  host: null, frame: null, id: null, url: null,
  follow(r) {
    const d = r.page === 'v' && !r.tab ? Store.get('plan:' + r.id) : null;   // окно видео (не панели и не препродакшен)
    const want = d && d.project ? d.id + (r.page === 'v' ? '|v' : '') : null;
    if (want === this.id) return this.place();
    this.close();
    if (!want) return;
    this.id = want;
    const vid = want.split('|')[0], clean = want.endsWith('|v');
    if ((d.locations || d.fast) && clean) return this.openClips(vid);   // S13 / быстрый монтаж: плейбек готового видео      // S13.4: видео на локациях — плейбек готовых клипов сцен
    this.host = h('div.mt-preview', { class: clean ? 'clean' : '' }, h('p.dim.small', h('span.spin'), ' запускаю предпросмотр…'));
    document.body.append(this.host);
    api('POST', '/api/studio/project', { id: vid, page: 'preview' }).then(r => {
      if (this.id !== want) return;
      this.url = r.url + (clean ? '&clean' : '');
      this.frame = h('iframe', { src: r.url + '#t=' + MT.t, title: 'Предпросмотр монтажа' });
      this.host.replaceChildren(this.frame);
    }).catch(e => { if (this.host) this.host.replaceChildren(h('div.badline', '⚠ ' + e.message)); });
    this.place();
  },
  place() {
    if (!this.host) return;
    const slot = $('.mt-prevslot');
    if (!slot) { this.host.style.display = 'none'; return; }
    const r = slot.getBoundingClientRect();
    Object.assign(this.host.style, { display: 'block', left: r.left + 'px', top: Math.max(r.top, 8) + 'px', width: r.width + 'px', height: r.height + 'px' });
  },
  close() { document.querySelectorAll('.pv-card').forEach(p => p.remove()); if (this.host) this.host.remove(); clearInterval(this.cpoll); this.host = this.frame = this.id = this.url = this.video = this.live = null; this.clips = null; },
  post(m) {
    if (this.video && !this.live) return this.videoPost(m);
    try { this.frame && this.frame.contentWindow.postMessage(m, '*'); } catch (e) {}
  },
  // ---- S13.4: плейбек клипов (видео без звука; звук — Web Audio окна, как раньше)
  openClips(vid) {
    this.video = h('video', { muted: true, playsinline: true, preload: 'auto' });
    this.video.muted = true;
    this.badge = h('div.clip-badge', { hidden: true });
    this.empty = h('div.clip-empty', h('span.spin'), ' собираю клипы сцен…');
    this.host = h('div.mt-preview.clean.clips', this.video, this.empty, this.badge);
    document.body.append(this.host);
    this.cvid = vid; this.stamp = null; this.kick = 0;
    const poll = async () => {
      if (document.hidden || !this.video || this.cvid !== vid) return;
      let st; try { st = await api('GET', '/api/clips/state?video=' + vid); } catch { return; }
      this.clips = st; MT.clips = st;
      if (st.fast) { this.video.muted = false; MTA.mute(true); }   // быстрый ролик: звук — из самого видео (голос, звуки, музыка уже сведены)
      if (st.playback && st.stamp !== this.stamp) {               // новая склейка — подменить источник на том же месте
        this.stamp = st.stamp; const t = MT.t, was = !this.video.paused;
        this.video.src = `/api/clips/playback?video=${encodeURIComponent(vid)}&s=${st.stamp}`;
        this.video.addEventListener('loadedmetadata', () => { try { this.video.currentTime = t; if (was) this.video.play().catch(() => {}); } catch {} }, { once: true });
        this.empty.hidden = true;
      }
      const n = (st.stale || []).length;
      this.liveFast(vid, st);
      if (!st.playback) { this.empty.hidden = !!this.live; this.empty.lastChild.textContent = st.fast ? (st.agent ? ' Claude пишет ролик — шаги в панели справа…' : st.job ? ' ' + (st.job.summary || 'собираю ролик…') : ' ролик ещё не собран') : ' собираю клипы сцен…'; }
      this.badge.hidden = !(st.job || n || st.agent || this.live);
      const np = (st.parts || []).length;
      this.badge.textContent = this.live ? `⚡ вживую · написано сцен: ${np}` + (st.agent ? ' · Claude сводит (панель справа)' : st.job ? ' · ' + (st.job.summary || '') : '') : st.fast && st.agent ? '⚡ Claude делает ролик — шаги в панели справа' : st.job ? '⟳ ' + (st.job.summary || 'обновляю') : n ? (st.fast ? '⟳ код новее ролика — пересоберу' : `⟳ ждут обновления: ${n}`) : '';
      if (n && !st.job && !st.agent && (!st.fast || st.playback) && Date.now() - this.kick > 8000) { this.kick = Date.now(); api('POST', '/api/clips/render', { video: vid, auto: true }).catch(() => {}); }   // устарело — в рендер сами (auto: упавшую сборку сервер не повторяет)
      // таймлайн — только если в плейбеке правда что-то поменялось (раньше перерисовывался каждые 3 с: мигал и сбивал перетаскивание правок)
      const sig = JSON.stringify([st.stale, st.job && st.job.id, !!st.agent, !!st.playback, st.stamp, (st.parts || []).length, (st.segments || []).map(x => x.unit + (x.fresh ? '+' : '-'))]);
      if (sig !== this.tlSig) { this.tlSig = sig; if (window.Montage && Montage.redraw) Montage.redraw(); }
    };
    poll(); this.cpoll = setInterval(poll, 3000);
    this.place();
  },
  // ⚡ быстрый монтаж ещё идёт (или ролик не собран), а сцены уже написаны: превью играет код проекта вживую (index.html?preview),
  // недописанные сцены — тёмный кадр «Claude пишет…»; новые файлы сцен -> перезагрузка не чаще раза в 8 с. Ролик собран и задача кончилась — снова видео.
  liveFast(vid, st) {
    const want = !!(st.fast && (st.parts || []).length && (!st.playback || (st.job && st.job.kind === 'fastmontage')));
    if (!want) {
      if (this.live) { this.live.remove(); this.live = this.frame = this.url = null; this.video.hidden = false; }
      return;
    }
    this.video.hidden = true; if (!this.video.paused) this.video.pause();
    if (!this.live) {
      this.live = h('div.clip-live', h('p.dim.small', h('span.spin'), ' запускаю живой предпросмотр сцен…'));
      this.host.insertBefore(this.live, this.badge);
      this.liveStamp = st.partsStamp; this.liveAt = Date.now();
      api('POST', '/api/studio/project', { id: vid, page: 'preview' }).then(r => {
        if (!this.live || this.cvid !== vid) return;
        this.url = r.url + '&clean';
        this.frame = h('iframe', { src: this.url + '#t=' + (+MT.t || 0).toFixed(2), title: 'Живой предпросмотр сцен' });
        this.live.replaceChildren(this.frame);
      }).catch(e => { if (this.live) this.live.replaceChildren(h('div.badline', '⚠ ' + e.message)); });
      return;
    }
    if (this.frame && st.partsStamp !== this.liveStamp && Date.now() - this.liveAt > 8000 && !MT.playing) {   // писатель дописал сцену — показать
      this.liveStamp = st.partsStamp; this.liveAt = Date.now();
      this.frame.src = this.url + '#t=' + (+MT.t || 0).toFixed(2) + '&r=' + Date.now();
    }
  },
  // быстрый ролик (видео со своим звуком) играет: часы окна берут время из самого видео — без рывков от подгоняющих перемоток
  master() {
    const v = this.video;
    return v && !this.live && v.src && this.clips && this.clips.fast && !v.paused && v.readyState >= 2 ? v : null;
  },
  vSeek(t) {
    const v = this.video; if (!v) return;
    if (v.seeking) { this.want = t; return; }
    if (Math.abs(v.currentTime - t) > 0.008) v.currentTime = t;
  },
  videoPost(m) {
    const v = this.video; if (!v || m.seek == null || !v.src) return;
    if (!v.dataset.seekq) { v.dataset.seekq = '1'; v.addEventListener('seeked', () => { if (this.want != null) { const w = this.want; this.want = null; this.vSeek(w); } }); }
    const t = m.seek;
    const W = typeof WS !== 'undefined' ? WS : null;            // WS — const окна видео, на window его нет (было window.WS — звук и скорость не доходили до видео)
    if (this.clips && this.clips.fast) v.muted = !!(W && W.muted);   // быстрый ролик звучит сам — кнопка звука окна глушит его
    try {
      v.playbackRate = (W && W.rate) || 1;
      if (MT.playing) {
        if (v.paused) { this.vSeek(t); v.play().catch(() => {}); }
        else if (!this.master() && Math.abs(v.currentTime - t) > 0.25) this.vSeek(t);   // видео ведёт часы само (master) — не дёргаем его перемотками
      } else { if (!v.paused) v.pause(); this.vSeek(t); }
    } catch (e) {}
  },
  seek(t) { if (MT.driven) return Workspace.seek(t); this.post({ seek: t }); if (MT.playing && MT.d) MTA.play(MT.d, t); },
  play(on) {
    if (MT.driven) return on ? Workspace.play() : Workspace.pause();
    this.post({ play: on }); MT.playing = on;
    if (on && MT.d) MTA.play(MT.d, MT.t); else MTA.stop();
  },
  reload(t) { if (this.video && !this.live) return; if (this.frame && this.url) { this.frame.src = 'about:blank'; setTimeout(() => { if (this.frame) this.frame.src = this.url + '#t=' + (+t || 0).toFixed(2) + '&r=' + Date.now(); }, 30); } },
};
addEventListener('message', ev => {
  const m = ev.data || {};
  if (!MontagePreview.frame || ev.source !== MontagePreview.frame.contentWindow || typeof m.studioT !== 'number') return;
  if (MT.driven) return;                                // S12: в окне видео часы ведёт Studio (скорость, loop, покадрово) — эхо кадров не нужно
  MT.t = +m.studioT.toFixed(2);
  if (MT.playing !== !!m.playing) {                    // ▶ / ❚❚ нажали в самом предпросмотре
    MT.playing = !!m.playing;
    if (MT.playing && MT.d) MTA.play(MT.d, MT.t); else MTA.stop();
  } else if (MT.playing && MTA.on && Math.abs(MTA.now() - MT.t) > 0.3 && MT.d) MTA.play(MT.d, MT.t);   // кадры и звук не разъезжаются
  Montage.playhead();
});
(function follow() {                                    // окно предпросмотра держится над своим местом, даже когда страница сдвигается без перерисовки
  if (MontagePreview.host) {
    const slot = $('.mt-prevslot'), r = slot && slot.getBoundingClientRect(), sig = r ? [r.left, r.top, r.width, r.height].map(Math.round).join() : '-';
    if (sig !== MontagePreview.sig) { MontagePreview.sig = sig; MontagePreview.place(); }
  }
  requestAnimationFrame(follow);
})();

setInterval(() => {                                      // прогресс «🔨 Собрать» (кадры N из M, кодирую mp4…) — в строке статуса этапа
  const j = MT.key && Claude.running(MT.key, 'montage');
  if (j && j.summary) Montage.status('🔨 ' + j.summary);
}, 1000);
setInterval(async () => {                                // новый mp4 (кнопка, агент, «Пересобрать с правками») — сразу на странице, плеер открыт
  if (App.route.page !== 'p' || App.route.tab !== 'montage' || !MT.d || document.hidden) return;
  const vid = MT.d.id;
  try {
    const r = await api('GET', '/api/montage/out?video=' + encodeURIComponent(vid));
    if (!r.mtime) return;
    if (MT.outSeen && MT.outSeen[vid] && r.mtime > MT.outSeen[vid]) {
      if (Claude.running('plan:' + vid, 'montage') || MT.outPending !== r.mtime) { MT.outPending = r.mtime; return; }   // файл ещё пишется — ждём, пока время перестанет меняться
      MT.vidRev = r.mtime; MT.prevMode = 'out'; MontagePreview.play(false);
      const I = MT.info[vid]; if (I) I.out = [r.file];
      UI.toast('🎬 Ролик собран — справа «Готовый ролик»'); App.render();
    }
    (MT.outSeen = MT.outSeen || {})[vid] = r.mtime;
    if (!MT.vidRev) MT.vidRev = r.mtime;
  } catch (e) {}
}, 2000);

window.Montage = Montage;

// ---------------- 👀 Ревью (S8): «✋ поправить кадр» — сцена в моменте паузы, правки -> пометка (fixes[]), «🔨 Пересобрать с правками» — агент
