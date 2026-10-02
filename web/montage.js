// Claude Studio — этап «🎞 Монтаж» (S6, docs/studio/stage6-montage.md): общий таймлайн ролика и предпросмотр.
// Данные — video.json → montage (units, voice, captions, sfx, music, overlays, len), правки — операцией set ['montage'];
// после правки сервер пересобирает файлы проекта (POST /api/montage/gen), предпросмотр (src/index.html?preview проекта) перезагружается на том же моменте.
// «🔨 Собрать» — задача montagebuild (генератор + build.sh) → «Ревью».
'use strict';

const MT = { info: {}, loading: {}, zoom: 64, sel: null, t: 0, playing: false, drag: null, genTimer: null, key: null, d: null };
const MT_LABEL = 112;                                     // ширина колонки подписей строк, px
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
    const d = MT.d, M = this.M(d), tl = $('.mt-tl'), pr = $('.mt-props'), tb = $('.mt-toolbar');
    if (tl) tl.replaceChildren(this.timeline(d, M));
    if (pr) pr.replaceChildren(this.props(d, M));
    if (tb) tb.replaceWith(this.toolbar(d, MT.key, M));
    if (typeof Workspace !== 'undefined' && App.route.page === 'v') Workspace.onRedraw();   // S12: окно видео — список сцен, свойства
  },

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
      const b = bar('units', u, u.at || 0, u.len || 0, (byAt.indexOf(u) + 1) + '  ' + (sc.name || u.scene), 'unit');
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
        title: (ph.live ? 'Claude собирает: ' + (ph.note || '') + '\n' : '') + (ph.empty ? `Сцены нет: «${ph.title}» — заглушка (текст голоса в кадре)` : '') },
        h('span', ph.live ? '◌ ' + (ph.note || 'Claude собирает…') : ph.title || 'нет сцены')));
    }
    rows.push(['Сцены', sceneRow, 1]);
    // текст и голос (S12): сверху слова — что звучит (из них субтитры и привязка сцен), под ними волна голоса
    if (words.length) {
      const vr = h('div.mt-lane.voice', { class: this.voiceOn(d) ? '' : 'off' });
      for (const w of words) vr.append(h('div.mt-word', { style: { left: X(w.t) + 'px', width: Math.max(4, (w.e - w.t) * Z - 1) + 'px' }, title: `${w.w} · ${w.t.toFixed(2)} с — клик: перейти`, 'data-i': w.i,
        onmousedown: ev => { ev.stopPropagation(); MT.t = +w.t.toFixed(2); MontagePreview.seek(MT.t); this.playhead(); } }, Z >= 40 ? w.w : ''));
      const wave = h('div.mt-wave');
      vr.append(wave);
      this.waves(d, wave, X);
      rows.push(['Текст и голос', vr, 2]);
    }
    // музыка, звуки, надписи — дорожками без наложений
    const laneOf = (items, t0, t1) => { const ends = []; return items.map(it => { const a = t0(it); let k = ends.findIndex(e => e <= a + 1e-3); if (k < 0) { k = ends.length; ends.push(0); } ends[k] = t1(it); return k; }); };
    const group = (list, title, cls, dur, label) => {
      const items = [...(M[list] || [])].sort((a, b) => (a.at || 0) - (b.at || 0)), lanes = laneOf(items, it => it.at || 0, it => (it.at || 0) + dur(it));
      const lane = h('div.mt-lane');
      items.forEach((it, i) => lane.append(bar(list, it, it.at || 0, dur(it), label(it), cls, { lane: lanes[i], edge: list !== 'sfx' })));
      rows.push([title, lane, Math.max(1, ...lanes.map(k => k + 1))]);
    };
    group('music', 'Музыка', 'music', it => it.dur || Math.max(0.5, this.srcDur(d, it.src) - (it.from || 0)), it => it.note || this.srcName(d, it.src));
    group('sfx', 'Звуки', 'sfx', it => Math.min(this.srcDur(d, it.src), 12), it => it.note || this.srcName(d, it.src));
    if ((M.overlays || []).length) group('overlays', 'Надписи', 'ov', it => it.dur || 2, it => it.text || it.kind);
    const body = h('div.mt-rows', { style: { width: width + 'px' } },
      rows.map(([t, lane, n]) => h('div.mt-row', { style: { height: n * 22 + 6 + 'px' } }, h('div.mt-rowlabel', t), lane)),
      h('div.mt-playhead', { style: { left: X(MT.t) + 'px' } }),
      h('div.mt-end', { style: { left: X(M.len || 0) + 'px' }, title: `конец ролика — ${(M.len || 0).toFixed(2)} с` }));
    return h('div.mt-scroll', ruler, body);
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
  scrub(ev) {
    const move = e => { MT.t = +this.xToT(e).toFixed(2); this.playhead(); MontagePreview.seek(MT.t); };
    move(ev);
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
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
  cues(d) {
    const M = Montage.M(d), map = this.map || { srcs: {}, scenes: {}, voice: [] }, out = [];
    const lay = (src, t, gain, extra) => { for (const L of map.srcs[src] || []) out.push(Object.assign({ url: L.url, t: t + (L.at || 0), gain: gain * (L.gain == null ? 1 : L.gain), lib: L.lib, peak: L.peak, off: L.off || 0, dur: L.len || null }, extra)); };
    if ((M.voice || {}).on) for (const v of map.voice || []) out.push({ url: v.url, t: v.at, gain: 1, off: 0, dur: null, voice: true });
    for (const u of M.units || []) {
      const P = Montage.pairs(d, u), a = u.at || 0, b = a + (u.len || 0);
      for (const s of map.scenes[u.scene] || []) { const tv = Montage.s2v(P, s.t); if (tv >= a - 0.05 && tv < b) lay(s.src, tv, s.gain, { align: s.align, sfx: true, cut: b }); }
    }
    for (const x of M.sfx || []) lay(x.src, x.at || 0, x.gain == null ? 1 : x.gain, { align: x.align || '', sfx: true });
    for (const x of M.music || []) lay(x.src, x.at || 0, x.gain == null ? 1 : x.gain, { off: x.from || 0, dur: x.dur || null, fadeIn: x.fadeIn || 0, fadeOut: x.fadeOut || 0, music: true });
    return out;
  },
  warm(d) { this.load(d).then(() => { for (const c of this.cues(d)) this.buf(c.url); }); },
  now() { return this.on ? this.t0 + (this.ctx.currentTime - this.c0) : MT.t; },
  stop() { for (const n of this.nodes) { try { n.stop(); } catch (e) {} } this.nodes = []; this.on = false; },
  async play(d, t) {
    const my = (this.playId = (this.playId || 0) + 1);
    this.stop();
    const ctx = this.ac(); if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    await this.load(d);
    const C = this.cues(d);
    await Promise.all(C.map(c => this.buf(c.url)));      // обычно уже в кэше (warm); первый раз — подождать декод
    if (my !== this.playId || !MT.playing) return;
    t = MT.t != null ? MT.t : t;                          // за время загрузки кадры могли уйти вперёд
    const c0 = ctx.currentTime + 0.04;
    this.t0 = t; this.c0 = c0; this.on = true;
    for (const c of C) {
      const b = await this.bufs[c.url]; if (!b) continue;
      const inf = this.info[c.url] || {};
      let start = c.t;
      if (c.align === 'peak') start -= (c.peak != null && c.off === 0 ? c.peak : inf.peak - c.off) || 0;
      const avail = Math.max(0, b.duration - c.off);
      const len = Math.min(c.dur || avail, avail, c.cut != null ? Math.max(0, c.cut + 0.6 - start) : 1e9);
      const end = start + len;
      if (end <= t || len <= 0.01) continue;
      const skip = Math.max(0, t - start), when = c0 + Math.max(0, start - t);
      const src = ctx.createBufferSource(); src.buffer = b;
      const g = ctx.createGain(), base = c.gain * (c.lib ? inf.norm || 1 : 1);
      const at = s => c0 + (s - t);                        // время ролика -> время звука
      g.gain.setValueAtTime(base, when);
      if (c.fadeIn && skip < c.fadeIn) { g.gain.setValueAtTime(base * (skip / c.fadeIn), when); g.gain.linearRampToValueAtTime(base, at(start + c.fadeIn)); }
      const fo = c.music ? c.fadeOut : c.sfx ? Math.min(1.2, Math.max(0.12, (end - Math.max(start, start + (inf.peak || 0) - c.off)) * 0.5)) : 0;
      if (fo > 0 && end - fo > t) { g.gain.setValueAtTime(base, at(end - fo)); g.gain.linearRampToValueAtTime(0.0001, at(end)); }
      src.connect(g).connect(this.out());
      src.start(when, c.off + skip, Math.max(0.01, len - skip));
      this.nodes.push(src);
    }
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
  close() { if (this.host) this.host.remove(); this.host = this.frame = this.id = this.url = null; },
  post(m) { try { this.frame && this.frame.contentWindow.postMessage(m, '*'); } catch (e) {} },
  seek(t) { if (MT.driven) return Workspace.seek(t); this.post({ seek: t }); if (MT.playing && MT.d) MTA.play(MT.d, t); },
  play(on) {
    if (MT.driven) return on ? Workspace.play() : Workspace.pause();
    this.post({ play: on }); MT.playing = on;
    if (on && MT.d) MTA.play(MT.d, MT.t); else MTA.stop();
  },
  reload(t) { if (this.frame && this.url) { this.frame.src = 'about:blank'; setTimeout(() => { if (this.frame) this.frame.src = this.url + '#t=' + (+t || 0).toFixed(2) + '&r=' + Date.now(); }, 30); } },
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
