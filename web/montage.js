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
    M.len = this.autoLen(d, M);
    Store.set(key, ['montage'], M, false);
    this.redraw();
    clearTimeout(MT.genTimer);
    MT.genTimer = setTimeout(() => this.regen(), 700);
  },
  async regen() {
    const d = MT.d, key = MT.key;
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
  status(s) { const e = $('.mt-status'); if (e) e.textContent = s; },

  // ---------------- страница этапа
  view(d, key) {
    MT.d = d; MT.key = key;
    if (!d.project) return [
      h('section.card', h('div.card-head', h('h3', '🎞 Монтаж')),
        h('p', 'Монтаж собирает ролик из сцен редактора, голоса, звуков, музыки и надписей. Для него нужен проект ролика в папке видео — сценарий не обязателен (ролик без голоса тоже можно).')),
      Plan.startProduction(d, key)];
    this.load(d);
    const I = MT.info[d.id];
    if (!I) return h('p.dim', h('span.spin'), ' читаю монтаж…');
    if (I.error) return h('div.badline', '⚠ ' + I.error);
    if (!I.generated && !(MT.autogen || (MT.autogen = {}))[d.id]) { MT.autogen[d.id] = true; I.generated = true; setTimeout(() => this.regen(), 0); }   // проект ещё не видел монтажа: сгенерировать файлы для предпросмотра
    const M = this.M(d), out = (I.out || [])[0];
    return [
      h('section.card.mt-top',
        h('div.card-head', h('h3', '🎞 Монтаж'),
          h('span.dim', `${(M.len || 0).toFixed(1)} с · ${(M.units || []).length} ${plural((M.units || []).length, 'сцена', 'сцены', 'сцен')} · голос ${this.voiceOn(d) ? 'вкл' : this.words(d).length ? 'выкл' : 'нет'}`),
          h('span.sp'),
          h('span.mt-status.dim.small', d.montage ? '' : 'монтаж по умолчанию — первая правка сохранит его'),
          h('button', { onclick: () => this.regen(), title: 'Пересобрать файлы проекта и перезагрузить предпросмотр' }, '↻ предпросмотр'),
          Claude.btn({ label: 'Собрать', icon: '🔨', action: 'montagebuild', key, scope: 'montage', params: { video: d.id }, noClaude: true,
            title: 'Кадры, звук и mp4 (build.sh) — 1–3 минуты', onResult: () => { this.load(d, true); UI.toast('Ролик собран — смотри «Ревью»'); } }),
          h('button.claude', { onclick: () => AgentPanel.build(), title: 'Агент (Opus) сам напишет сценарий, озвучит, смонтирует и соберёт — шаги видны в панели справа' }, '✨ Собрать агентом'),
          out && h('a.btn', { href: `#/p/${d.id}/review`, title: out }, '👀 Ревью →'))),
      h('div.mt-layout',
        h('div.mt-left', this.toolbar(d, key, M), h('div.mt-tl', this.timeline(d, M)), h('div.mt-props', this.props(d, M))),
        h('div.mt-prevslot', h('span.dim.small', 'предпросмотр'))),
    ];
  },
  redraw() {
    const d = MT.d, M = this.M(d), tl = $('.mt-tl'), pr = $('.mt-props'), tb = $('.mt-toolbar');
    if (tl) tl.replaceChildren(this.timeline(d, M));
    if (pr) pr.replaceChildren(this.props(d, M));
    if (tb) tb.replaceWith(this.toolbar(d, MT.key, M));
  },

  toolbar(d, key, M) {
    const add = (list, item) => { const N = this.clone(M); (N[list] = N[list] || []).push(item); MT.sel = { list, id: item.id }; this.save(N); };
    const I = MT.info[d.id], at = +MT.t.toFixed(2);
    const firstSrc = (I.sources || [])[0];
    return h('div.row.mt-toolbar',
      h('button', { onclick: () => MontagePreview.play(!MT.playing), title: 'Играть / пауза (предпросмотр, без звука)' }, MT.playing ? '❚❚' : '▶'),
      h('span.mt-time', MT.t.toFixed(2) + ' с'),
      h('span.sp'),
      h('button', { onclick: () => { const sc = (I.scenes || [])[0]; if (!sc) return UI.toast('Нет сцен в редакторе — оформи сцену на этапе «Сцены»', 'err');
        const end = Math.max(0, ...(M.units || []).map(u => (u.at || 0) + (u.len || 0)));
        add('units', { id: uid('u'), scene: sc.el, at: end, len: sc.len, map: [[0, 0], [sc.len, sc.len]], trans: { type: 'cut', dur: 0 } }); } }, '+ сцена'),
      h('button', { onclick: () => add('music', { id: uid('mu'), at, src: firstSrc ? firstSrc.src : '', gain: 0.6, from: 0, dur: 6, fadeIn: 0.5, fadeOut: 1 }) }, '+ музыка'),
      h('button', { onclick: () => add('sfx', { id: uid('x'), at, src: firstSrc ? firstSrc.src : 'lib:other/pop', gain: 0.8, align: '' }) }, '+ звук'),
      h('button', { onclick: () => add('overlays', { id: uid('ov'), at, dur: 3, kind: 'pov', text: 'POV: …' }) }, '+ надпись'),
      h('span.sep'),
      h('label.small', h('input', { type: 'checkbox', checked: !!(M.voice || {}).on, disabled: !this.words(d).length,
        onchange: ev => { const N = this.clone(M); N.voice = { on: ev.target.checked }; this.save(N); } }), ' голос'),
      h('label.small', h('input', { type: 'checkbox', checked: !!(M.captions || {}).on, disabled: !this.words(d).length,
        onchange: ev => { const N = this.clone(M); N.captions = { on: ev.target.checked }; this.save(N); } }), ' субтитры'),
      h('span.sep'),
      h('button', { onclick: () => { MT.zoom = Math.max(16, MT.zoom / 1.4); this.redraw(); }, title: 'Мельче' }, '−'),
      h('button', { onclick: () => { MT.zoom = Math.min(400, MT.zoom * 1.4); this.redraw(); }, title: 'Крупнее' }, '+'));
  },

  // ---------------- таймлайн
  timeline(d, M) {
    const Z = MT.zoom, len = Math.max(M.len || 0, this.autoLen(d, M)) + 2, width = MT_LABEL + len * Z;
    const X = t => MT_LABEL + t * Z;
    const rows = [], words = this.words(d), I = MT.info[d.id];
    const bar = (list, it, t0, dur, label, cls, opts = {}) => h('div.mt-bar', {
      class: cls + (MT.sel && MT.sel.list === list && MT.sel.id === it.id ? ' sel' : ''),
      style: { left: X(t0) + 'px', width: Math.max(6, dur * Z) + 'px', top: (opts.lane || 0) * 22 + 3 + 'px' },
      title: label, onmousedown: ev => this.startDrag(ev, list, it, opts.edge !== false),
      onclick: ev => { ev.stopPropagation(); MT.sel = { list, id: it.id }; this.redraw(); } }, h('span', label));
    // линейка
    const ruler = h('div.mt-ruler', { style: { width: width + 'px' }, onmousedown: ev => this.scrub(ev) });
    for (let s = 0; s <= len; s += Z < 30 ? 5 : 1) ruler.append(h('div.mt-tick', { style: { left: X(s) + 'px' } }, s % 5 === 0 || Z >= 50 ? String(s) : ''));
    // сцены: полосы юнитов, склейки камеры и маркеры по карте времени
    const sceneRow = h('div.mt-lane');
    for (const u of M.units || []) {
      const sc = (I.scenes || []).find(s => s.el === u.scene) || {}, P = this.pairs(d, u);
      const b = bar('units', u, u.at || 0, u.len || 0, sc.name || u.scene, 'unit');
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
    rows.push(['🎬 Сцены', sceneRow, 1]);
    // голос: слова
    if (words.length) {
      const vr = h('div.mt-lane.voice', { class: this.voiceOn(d) ? '' : 'off' });
      for (const w of words) vr.append(h('div.mt-word', { style: { left: X(w.t) + 'px', width: Math.max(4, (w.e - w.t) * Z - 1) + 'px' }, title: `${w.w} · ${w.t.toFixed(2)} с`, 'data-i': w.i }, Z >= 40 ? w.w : ''));
      rows.push(['🎙 Голос', vr, 1]);
    }
    // музыка, звуки, надписи — дорожками без наложений
    const laneOf = (items, t0, t1) => { const ends = []; return items.map(it => { const a = t0(it); let k = ends.findIndex(e => e <= a + 1e-3); if (k < 0) { k = ends.length; ends.push(0); } ends[k] = t1(it); return k; }); };
    const group = (list, title, cls, dur, label) => {
      const items = [...(M[list] || [])].sort((a, b) => (a.at || 0) - (b.at || 0)), lanes = laneOf(items, it => it.at || 0, it => (it.at || 0) + dur(it));
      const lane = h('div.mt-lane');
      items.forEach((it, i) => lane.append(bar(list, it, it.at || 0, dur(it), label(it), cls, { lane: lanes[i], edge: list !== 'sfx' })));
      rows.push([title, lane, Math.max(1, ...lanes.map(k => k + 1))]);
    };
    group('music', '🎵 Музыка', 'music', it => it.dur || Math.max(0.5, this.srcDur(d, it.src) - (it.from || 0)), it => it.note || this.srcName(d, it.src));
    group('sfx', '🔊 Звуки', 'sfx', it => Math.min(this.srcDur(d, it.src), 12), it => it.note || this.srcName(d, it.src));
    group('overlays', '🔤 Надписи', 'ov', it => it.dur || 2, it => it.text || it.kind);
    const body = h('div.mt-rows', { style: { width: width + 'px' } },
      rows.map(([t, lane, n]) => h('div.mt-row', { style: { height: n * 22 + 6 + 'px' } }, h('div.mt-rowlabel', t), lane)),
      h('div.mt-playhead', { style: { left: X(MT.t) + 'px' } }),
      h('div.mt-end', { style: { left: X(M.len || 0) + 'px' }, title: `конец ролика — ${(M.len || 0).toFixed(2)} с` }));
    return h('div.mt-scroll', ruler, body);
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
    const e = $('.mt-time'); if (e) e.textContent = MT.t.toFixed(2) + ' с';
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
      MT.sel = { list, id: it.id };
      if (moved) this.save(M); else this.redraw();
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
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
const MontagePreview = {
  host: null, frame: null, id: null, url: null,
  follow(r) {
    const d = r.page === 'p' && r.tab === 'montage' ? Store.get('plan:' + r.id) : null;
    const want = d && d.project ? d.id : null;
    if (want === this.id) return this.place();
    this.close();
    if (!want) return;
    this.id = want;
    this.host = h('div.mt-preview', h('p.dim.small', h('span.spin'), ' запускаю предпросмотр…'));
    document.body.append(this.host);
    api('POST', '/api/studio/project', { id: want, page: 'preview' }).then(r => {
      if (this.id !== want) return;
      this.url = r.url;
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
  seek(t) { this.post({ seek: t }); },
  play(on) { this.post({ play: on }); MT.playing = on; const tb = $('.mt-toolbar'); if (tb && MT.d) tb.replaceWith(Montage.toolbar(MT.d, MT.key, Montage.M(MT.d))); },
  reload(t) { if (this.frame && this.url) { this.frame.src = 'about:blank'; setTimeout(() => { if (this.frame) this.frame.src = this.url + '#t=' + (+t || 0).toFixed(2) + '&r=' + Date.now(); }, 30); } },
};
addEventListener('message', ev => {
  const m = ev.data || {};
  if (!MontagePreview.frame || ev.source !== MontagePreview.frame.contentWindow || typeof m.studioT !== 'number') return;
  MT.t = +m.studioT.toFixed(2);
  if (MT.playing !== !!m.playing) { MT.playing = !!m.playing; const tb = $('.mt-toolbar'); if (tb && MT.d) tb.replaceWith(Montage.toolbar(MT.d, MT.key, Montage.M(MT.d))); }
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

Object.assign(Plan, { montage(d, key) { return Montage.view(d, key); } });
