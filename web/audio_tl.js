// Claude Studio — S23 «Звуковой редактор монтажа» (docs/studio/stage23-audio.md).
// Дорожки (montage.tracks: голос, музыка, звуки 1…N — громкость, M / S), плашки звука с волной: сдвиг (и на другую дорожку), края — обрезка,
// дальше конца файла — цикл, Ctrl + тянуть внутри — сдвиг звука в плашке, линия уровня, фейды; мультивыделение (TLSel 'clips'), рамка через дорожки,
// прилипание (слова, склейки, плейхед, соседи; Ctrl — пик, Shift — без), S / C — разрезать, Ctrl C / V / D, Alt + тянуть — копия.
// Звуки сцен (scene.json → sounds) — на тех же дорожках, правка уходит в сцену (/api/scene/op). Панель «🔊 Звуки» слева: библиотека, канал, видео, интернет;
// перетаскивание на дорожки, свои файлы из проводника. Двойной клик — редактор звука (срез, цикл, шов). «Заменить похожим…».
// Расчёт плашки (pieces) — тот же, что clip_pieces / render_clip в template/audio.py: превью и сборка звучат одинаково.
'use strict';

const MSND_H = 46;                                           // высота плашки, px
const MSND_DB = [-30, 10];                                   // шкала линии уровня

const MSnd = {
  known: {}, durOf: {}, pending: [], clipboard: null,
  panel: Local.get('snd-panel') === '1', tab: Local.get('snd-tab') || 'lib', q: '', cat: '', list: {}, netQ: '',

  // ---------------- модель ----------------
  tracks(M) {
    const T = (M.tracks || []).filter(t => t && t.id).map(t => Object.assign({}, t));
    for (const [kind, id, name] of [['voice', 'voice', 'Голос'], ['music', 'm1', 'Музыка'], ['sfx', 's1', 'Звуки']])
      if (!T.some(t => t.kind === kind)) T.push({ id, kind, name });
    const order = { voice: 0, music: 1, sfx: 2 };
    return M.tracks ? T : T.sort((a, b) => order[a.kind] - order[b.kind]);
  },
  trackOf(T, id, kind) { return T.find(t => t.id === id && t.kind === kind) || T.find(t => t.kind === kind); },
  db: g => g > 0 ? 20 * Math.log10(g) : -60,
  gain: db => Math.pow(10, db / 20),
  KEYS: ['in', 'out', 'dur', 'loop', 'fadeIn', 'fadeOut'],
  clipOf(x, music) {                                         // = montage_api.clip_of
    if (!music && !this.KEYS.some(k => k in x)) return null;
    const c = { in: +(x.in != null ? x.in : x.from || 0), out: x.out != null ? +x.out : null, dur: x.dur != null ? +x.dur : null, loop: x.loop || null, fadeIn: +x.fadeIn || 0, fadeOut: x.fadeOut != null ? +x.fadeOut : null };
    if (music) { c.fadeOut = +c.fadeOut || 0; c.music = true; }
    return c;
  },
  layerClip(c, dt, n) {                                      // = montage_api.layer_clip
    if (!c || (dt === 0 && n === 1)) return [dt, c];
    c = Object.assign({}, c);
    const lin = Math.max(0, c.in - dt), shift = Math.max(0, dt - c.in);
    if (c.dur != null) { c.dur -= shift; if (c.dur <= 0.01) return null; }
    if (c.out != null) { c.out -= dt; if (c.out <= lin) return null; }
    c.in = lin;
    if (n > 1) c.loop = null;
    return [shift, c];
  },
  // = audio.clip_pieces: [[t на плашке, секунда файла, длина, xf входа, xf выхода]]
  pieces(c, L) {
    const inn = Math.max(0, +c.in || 0);
    let out = c.out != null && c.out !== '' ? Math.min(L, +c.out) : L;
    out = Math.max(out, inn + 0.02);
    const seg = out - inn, dur = c.dur != null && c.dur !== '' ? +c.dur : seg, lp = c.loop;
    if (!lp || dur <= seg + 1e-3) return [[0, inn, Math.min(dur, seg), 0, 0]];
    const a = Math.min(Math.max(lp.a != null ? +lp.a : inn, 0), out - 0.05), body = out - a;
    const xf = Math.min(Math.max(+lp.xf || 0, 0), body * 0.45, seg * 0.45);
    const P = [[0, inn, seg, 0, xf]];
    let t = seg - xf;
    while (t < dur - 1e-3 && P.length < 2000) { const ln = Math.min(body, dur - t); P.push([t, a, ln, xf, t + ln < dur - 1e-3 ? xf : 0]); t += body - xf; }
    return P;
  },
  // слова голоса -> фразы для приглушения музыки (= audio.duck_words: паузы короче 0,35 с не отпускают)
  duckRuns(d) {
    if (this._dr && this._dr.d === d.id && this._dr.n === Montage.words(d).length) return this._dr.runs;
    const runs = [];
    for (const w of [...Montage.words(d)].sort((a, b) => a.t - b.t)) { const L = runs[runs.length - 1]; if (L && w.t - L[1] < 0.35) L[1] = Math.max(L[1], w.e); else runs.push([w.t, w.e]); }
    this._dr = { d: d.id, n: Montage.words(d).length, runs };
    return runs;
  },
  layers(src) { return ((MTA.map || {}).srcs || {})[src] || []; },
  // длина источника, с: препродакшен и библиотека — из сводки; файлы — по декодированному звуку (пока нет — что знала панель)
  srcLen(d, src) {
    const I = MT.info[d.id] || {}, s = String(src || '');
    const el = (I.sources || []).find(x => x.src === s); if (el) return el.dur || 1;
    const m = /^lib:([^|]+)(?:\|([\d.]+)\|([\d.]+))?$/.exec(s);
    if (m && !/^sounds\//.test(m[1])) { if (m[3]) return +m[3]; const r = (I.lib || []).find(x => x[0] === m[1]); if (r) return r[1] || 1; }
    const L = this.layers(s);
    let best = 0, miss = false;
    for (const l of L) { const du = this.durOf[l.url]; if (du) best = Math.max(best, (l.at || 0) + (l.len || du - (l.off || 0))); else { miss = true; this.learn(l.url); } }
    return best || this.known[s] || (miss ? 2 : 1);
  },
  learn(url) {
    if (this.durOf[url] !== undefined) return;
    this.durOf[url] = 0;
    MTA.buf(url).then(b => { if (b) { this.durOf[url] = b.duration; clearTimeout(this.lt); this.lt = setTimeout(() => Montage.redraw(), 120); } });
  },
  // пик звука от начала плашки (для «момент: пик») или null
  peakOff(d, x, c) {
    const L = this.layers(x.src || x.raw || '')[0]; if (!L) return null;
    const inf = MTA.info[L.url] || {}, off = L.off || 0;
    const pk = L.lib && L.peak != null && !off ? L.peak : inf.peak != null ? inf.peak - off : null;
    if (pk == null) { this.learn(L.url); return null; }
    return Math.max(0, pk - ((c && c.in) || 0) + (L.at || 0));
  },
  // все плашки: [{key, kind, list, scene, it, track, at, t0, dur, len, pk, clip, label, by}]
  items(d, M) {
    const T = this.tracks(M), out = [], I = MT.info[d.id] || {};
    const mk = (it, kind, list, at, scene) => {
      const src = scene ? it.src : it.src, len = this.srcLen(d, src);
      const c = this.clipOf(it, kind === 'music') || { in: 0, out: null, dur: null, loop: null, fadeIn: 0, fadeOut: null };
      const P = this.pieces(c, len), dur = Math.max(0.05, Math.max(...P.map(p => p[0] + p[2])));
      const pk = it.align === 'peak' ? this.peakOff(d, it, c) : null;
      const tr = this.trackOf(T, it.track, kind);
      const name = it.note || (scene ? '' : '') || Montage.srcName(d, scene ? it.raw || it.src : it.src);
      out.push({ key: scene ? `sc~${scene.u}~${it.id}` : `${list}~${it.id}`, kind, list, scene, it, track: tr.id, at, t0: at - (pk || 0), dur, len, pk, clip: c,
        label: (scene ? '🎬 ' : '') + String(name || '').replace(/^el:/, ''), by: it.by, layers: this.layers(it.src).length });
    };
    for (const x of M.music || []) mk(x, 'music', 'music', +x.at || 0);
    for (const x of M.sfx || []) mk(x, 'sfx', 'sfx', +x.at || 0);
    const map = MTA.map || { scenes: {} };
    const byAt = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const u of M.units || []) {
      const P = Montage.pairs(d, u), a = u.at || 0, b = a + (u.len || 0), sc = (I.scenes || []).find(s => s.el === u.scene) || {};
      for (const s of (map.scenes || {})[u.scene] || []) {
        const tv = Montage.s2v(P, s.t); if (tv < a - 0.05 || tv >= b) continue;
        mk(s, 'sfx', null, tv, { u: u.id, el: u.scene, sid: s.id, n: byAt.indexOf(u) + 1, name: sc.name || u.scene, loc: !!s.loc });
      }
    }
    return out;
  },
  byKey(d, key) { return this.items(d, Montage.M(d)).find(c => c.key === key); },

  // ---------------- дорожки на таймлайне ----------------
  rows(d, M, X) {
    const T = this.tracks(M), all = this.items(d, M), Z = MT.zoom, rows = [];
    for (const tr of T.filter(t => t.kind !== 'voice')) {
      const lane = h('div.mt-lane.snd', { 'data-track': tr.id, class: tr.kind });
      const mine = all.filter(c => c.track === tr.id).sort((a, b) => a.t0 - b.t0), ends = [];
      for (const c of mine) {
        let k = ends.findIndex(e => e <= c.t0 + 1e-3); if (k < 0) { k = ends.length; ends.push(0); } ends[k] = c.t0 + c.dur;
        lane.append(this.clipEl(d, c, X, k));
      }
      for (const p of this.pending.filter(p => p.track === tr.id && p.vid === d.id))
        lane.append(h('div.mt-ghost', { style: { left: X(p.t) + 'px', width: Math.max(40, (p.dur || 2) * Z) + 'px', top: '3px' } }, h('span.spin'), ' ⬇ ' + (p.name || 'качаю…')));
      lane.addEventListener('mousedown', ev => this.marquee(ev, lane));
      this.dropZone(lane, d, () => tr.id);
      rows.push([this.head(d, M, tr), lane, Math.max(1, ends.length), Math.max(1, ends.length) * (MSND_H + 2) + 6]);
    }
    const add = h('div.mt-lane.snd-add', h('span', 'перетащите звук сюда — новая дорожка'));
    this.dropZone(add, d, item => this.newTrack(d, item));
    rows.push([h('div.mt-rowlabel.mt-trk.add', '＋ дорожка'), add, 1, 30]);
    return rows;
  },
  gy(db) { const [lo, hi] = MSND_DB, H = MSND_H - 2; return 4 + (1 - (Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * (H - 10); },
  clipEl(d, c, X, k) {
    const Z = MT.zoom, w = Math.max(6, c.dur * Z), it = c.it, db = this.db(it.gain == null ? 1 : +it.gain);
    const el = h('div.mt-clip', { class: c.kind + (c.scene ? ' scene' : '') + (c.scene && c.scene.loc ? ' loc' : '') + (TLSel.has('clips', c.key) ? ' sel' : ''), 'data-id': c.key,
      style: { left: X(c.t0) + 'px', width: w + 'px', top: 3 + k * (MSND_H + 2) + 'px', height: MSND_H + 'px' },
      title: `${c.label}${c.scene ? ` — звук сцены ${c.scene.n} «${c.scene.name}»${c.scene.loc ? ' (звук локации — правится в локации)' : ''}` : ''}\n${c.t0.toFixed(2)}–${(c.t0 + c.dur).toFixed(2)} с · ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB${c.by === 'author' ? ' · 🔒 поставили вы' : ''}\n` +
        'тянуть — сдвиг (и на другую дорожку) · края — обрезать / растянуть (дальше конца — цикл) · Ctrl+тянуть — звук внутри · Alt+тянуть — копия\nбелая линия — громкость · уголки — фейды · двойной клик — редактор звука · правый клик — меню',
      onmousedown: ev => this.down(ev, d, c.key), ondblclick: ev => { ev.stopPropagation(); this.editor(d, c.key); },
      oncontextmenu: ev => { ev.preventDefault(); ev.stopPropagation(); if (!TLSel.has('clips', c.key)) TLSel.set('clips', [c.key]); this.menu(ev, d, c.key); } });
    const cv = h('canvas.mt-cw', { width: Math.min(4000, Math.ceil(w)), height: MSND_H - 2 });
    el.append(cv);
    this.wave(d, c, cv);
    for (const p of this.pieces(c.clip, c.len).slice(1)) el.append(h('i.mt-seam', { style: { left: p[0] * Z + 'px' } }));
    const fi = +c.clip.fadeIn || 0, fo = c.clip.fadeOut == null ? 0 : +c.clip.fadeOut;
    if (fi > 0) el.append(h('i.mt-fade.l', { style: { width: fi * Z + 'px' } }));
    if (fo > 0) el.append(h('i.mt-fade.r', { style: { width: fo * Z + 'px' } }));
    el.append(h('i.mt-gl', { style: { top: this.gy(db) - 3 + 'px' } }),
      h('i.mt-fh.fi', { style: { left: Math.min(w - 8, fi * Z) + 'px' }, title: 'фейд входа' }), h('i.mt-fh.fo', { style: { right: Math.min(w - 8, fo * Z) + 'px' }, title: c.clip.fadeOut == null && c.kind === 'sfx' ? 'фейд выхода (сейчас — авто)' : 'фейд выхода' }),
      c.pk != null && it.align === 'peak' ? h('i.mt-pk', { style: { left: c.pk * Z + 'px' } }) : null,
      h('span.mt-cl', (c.by === 'author' ? '🔒 ' : '') + c.label + (c.clip.loop && c.dur > (c.clip.out != null ? c.clip.out : c.len) - c.clip.in + 0.01 ? ' ↻' : '')),
      h('i.edge.l'), h('i.edge.r'));
    return el;
  },
  // волна плашки: куски файла по порядку (цикл — повторы), высота — по громкости плашки
  wave(d, c, cv) {
    const L = this.layers(c.it.src)[0]; if (!L) return;
    MTA.buf(L.url).then(b => {
      if (!b || !cv.isConnected) return;
      this.durOf[L.url] = b.duration;
      const g = cv.getContext('2d'), W = cv.width, H = cv.height, Z = MT.zoom, data = b.getChannelData(0), sr = b.sampleRate, off = L.off || 0;
      const P = this.pieces(c.clip, c.len), inf = MTA.info[L.url] || {}, k = Math.min(1.6, (c.it.gain == null ? 1 : +c.it.gain) * (c.kind === 'sfx' ? inf.norm || 1 : 1.2));
      g.fillStyle = 'rgba(255,255,255,.55)';
      const sh = (L.at || 0) - (c.clip.in > 0 ? 0 : 0);
      for (let x = 0; x < W; x++) {
        const tl = x / Z - sh; let mn = 0, mx = 0;
        const p = P.find(q => tl >= q[0] && tl < q[0] + q[2]); if (!p) continue;
        const s0 = Math.floor((off + p[1] + (tl - p[0])) * sr), s1 = Math.min(data.length, s0 + Math.max(1, Math.floor(sr / Z)));
        for (let i = Math.max(0, s0); i < s1; i += 16) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const y0 = H / 2 - Math.min(1, mx * k) * H / 2, y1 = H / 2 - Math.max(-1, mn * k) * H / 2;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    });
  },
  head(d, M, tr, title) {
    if (!tr) return title;
    const set = (patch, why) => { const N = Montage.clone(M); N.tracks = this.tracks(M).map(t => t.id === tr.id ? Object.assign(t, patch) : t); Montage.save(N, why); };
    const db = +tr.gain || 0, lbl = h('span.mt-dbv', (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
    const ic = { voice: '🎙', music: '🎵', sfx: '🔊' }[tr.kind];
    const D = Object.assign({ on: true }, M.duck || {});
    return h('div.mt-rowlabel.mt-trk', { class: (tr.mute ? 'muted ' : '') + (tr.solo ? 'solo' : '') },
      h('div.mt-trk-n',
        h('b', { title: 'двойной клик — переименовать', ondblclick: () => { const v = prompt('Имя дорожки', tr.name || ''); if (v && v.trim()) set({ name: v.trim() }); } }, ic + ' ' + (title || tr.name || '')),
        h('button.mt-ms.m', { class: tr.mute ? 'on' : '', title: 'Заглушить дорожку (и в экспорте)', onclick: () => set({ mute: !tr.mute }) }, 'M'),
        h('button.mt-ms.s', { class: tr.solo ? 'on' : '', title: 'Слушать только её (только в окне — в экспорт не идёт)', onclick: () => set({ solo: !tr.solo }) }, 'S'),
        tr.kind !== 'voice' && h('button.mt-ms', { title: 'Ещё', onclick: ev => this.trackMenu(ev, d, M, tr) }, '⋯')),
      h('div.mt-trk-f',
        h('input', { type: 'range', min: -30, max: 10, step: 0.5, value: db, title: 'громкость дорожки (двойной клик — 0 dB)',
          oninput: ev => { lbl.textContent = (+ev.target.value > 0 ? '+' : '') + (+ev.target.value).toFixed(1) + ' dB'; },
          onchange: ev => set({ gain: +ev.target.value }), ondblclick: () => set({ gain: 0 }) }), lbl,
        tr.kind === 'music' && h('button.mt-ms.duck', { class: D.on && !(D.off || []).includes(tr.id) ? 'on' : '', title: `Приглушать под голос (${D.depth != null ? D.depth : -6} dB) — клик: вкл / выкл для этой дорожки, правый клик — глубина`,
          onclick: () => { const N = Montage.clone(M), Dn = Object.assign({ on: true, depth: -6, attack: 0.15, release: 0.4 }, N.duck || {}); const off = new Set(Dn.off || []); off.has(tr.id) ? off.delete(tr.id) : off.add(tr.id); Dn.off = [...off]; Dn.on = true; N.duck = Dn; Montage.save(N); },
          oncontextmenu: ev => { ev.preventDefault(); const v = prompt('Насколько приглушать музыку под голос, dB (например −6, −10; 0 — выключить)', String(D.depth != null ? D.depth : -6)); if (v == null) return; const n = parseFloat(v.replace('−', '-')); if (isNaN(n)) return; const N = Montage.clone(M); N.duck = Object.assign({ attack: 0.15, release: 0.4 }, N.duck || {}, { on: n !== 0, depth: n > 0 ? -n : n }); Montage.save(N); } }, '⇩')));
  },
  trackMenu(ev, d, M, tr) {
    const T = this.tracks(M), i = T.indexOf(T.find(t => t.id === tr.id)), used = this.items(d, M).some(c => c.track === tr.id);
    const save = T2 => { const N = Montage.clone(M); N.tracks = T2; Montage.save(N); };
    const mv = k => { const T2 = T.slice(), j = i + k; if (j < 0 || j >= T2.length || T2[j].kind === 'voice') return; [T2[i], T2[j]] = [T2[j], T2[i]]; save(T2); };
    this.popup(ev, [
      ['Переименовать…', () => { const v = prompt('Имя дорожки', tr.name || ''); if (v && v.trim()) save(T.map(t => t.id === tr.id ? Object.assign(t, { name: v.trim() }) : t)); }],
      ['↑ Выше', () => mv(-1)], ['↓ Ниже', () => mv(1)],
      [used ? 'Удалить (на ней есть звуки)' : '🗑 Удалить дорожку', () => { if (used || T.filter(t => t.kind === tr.kind).length < 2) return UI.toast(used ? 'Сначала уберите или перенесите звуки с дорожки' : 'Последнюю дорожку этого вида не удалить', 'err'); save(T.filter(t => t.id !== tr.id)); }, used],
    ]);
  },
  newTrack(d, item, kind) {
    const M = Montage.M(d), T = this.tracks(M);
    kind = kind || (item && item.dur > 25 ? 'music' : 'sfx');
    const n = T.filter(t => t.kind === kind).length + 1, id = uid(kind === 'music' ? 'm' : 's');
    const tr = { id, kind, name: kind === 'music' ? `Музыка ${n}` : `Звуки ${n}` };
    this._newTracks = (this._newTracks || []).concat([tr]);
    return id;
  },

  // ---------------- мышь ----------------
  tip(e, text) { let t = $('.mt-note-tip.snd'); if (!t) { t = h('div.mt-note-tip.snd'); document.body.append(t); } t.textContent = text; t.style.left = e.clientX + 12 + 'px'; t.style.top = e.clientY - 30 + 'px'; },
  untip() { $$('.mt-note-tip.snd, .mt-snapline').forEach(x => x.remove()); },
  snapPts(d, M, skip) {
    const P = [{ t: MT.t, l: 'плейхед' }];
    if ((M.voice || {}).on) for (const w of Montage.words(d)) P.push({ t: w.t, l: `слово «${w.w}»` });
    const I = MT.info[d.id] || {};
    for (const u of M.units || []) {
      P.push({ t: u.at || 0, l: 'начало сцены' }, { t: (u.at || 0) + (u.len || 0), l: 'конец сцены' });
      const sc = (I.scenes || []).find(s => s.el === u.scene) || {}, PP = Montage.pairs(d, u);
      for (const c of sc.cuts || []) P.push({ t: Montage.s2v(PP, c), l: 'склейка камеры' });
    }
    for (const c of this.items(d, M)) if (!skip.has(c.key)) P.push({ t: c.t0, l: 'начало ' + c.label }, { t: c.t0 + c.dur, l: 'конец ' + c.label });
    return P;
  },
  snapLine(t, label) {
    let ln = $('.mt-snapline'); const rows = $('.mt-rows'); if (!rows) return;
    if (t == null) { if (ln) ln.remove(); return; }
    if (!ln) { ln = h('div.mt-snapline', h('span')); rows.append(ln); }
    ln.style.left = MT_LABEL + t * MT.zoom + 'px'; ln.firstChild.textContent = '🧲 ' + label;
  },
  // ближайшая точка прилипания к любому из ts (8 px) -> {dt, l} | null
  snap(P, ts) {
    let best = null;
    for (const t of ts) for (const p of P) { const k = p.t - t; if (Math.abs(k * MT.zoom) < 8 && (!best || Math.abs(k) < Math.abs(best.dt))) best = { dt: k, l: p.l, t: p.t }; }
    return best;
  },
  rowAt(e) { const el = document.elementFromPoint(e.clientX, e.clientY); const r = el && el.closest && el.closest('.mt-row[data-track]'); return r && r.dataset.track; },
  down(ev, d, key) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const M = Montage.M(d), all = this.items(d, M), c = all.find(x => x.key === key); if (!c) return;
    const el = ev.currentTarget, R = el.getBoundingClientRect(), x0 = ev.clientX, y0 = ev.clientY, Z = MT.zoom, t = ev.target.classList;
    const mod = ev.ctrlKey || ev.metaKey;
    let mode = t.contains('mt-fh') ? (t.contains('fi') ? 'fi' : 'fo') : t.contains('mt-gl') ? 'gain' : ev.clientX - R.left < 7 ? 'l' : R.right - ev.clientX < 7 ? 'r' : mod ? 'slip' : 'move';
    if (ev.shiftKey && mode === 'move') mode = 'pick';
    if (mode === 'move' && !TLSel.has('clips', key)) TLSel.set('clips', [key]);
    if (mode === 'gain' && !TLSel.has('clips', key)) TLSel.set('clips', [key]);
    const group = mode === 'move' || mode === 'gain' ? all.filter(x => TLSel.has('clips', x.key)) : [c];
    const T = this.tracks(M).filter(t => t.kind !== 'voice'), skip = new Set(group.map(g => g.key)), P = this.snapPts(d, M, skip);
    const els = new Map(group.map(g => [g.key, document.querySelector(`.mt-clip[data-id="${CSS.escape(g.key)}"]`)]));
    const row0 = this.rowAt(ev), copy = ev.altKey && mode === 'move';
    let moved = false, res = null;
    document.body.classList.add('mt-dragging');
    const mv = e => {
      if (!moved && Math.abs(e.clientX - x0) < 3 && Math.abs(e.clientY - y0) < 3) return;
      moved = true;
      let dt = (e.clientX - x0) / Z;
      const sn = (ts, lim) => { if (e.shiftKey) { this.snapLine(null); return 0; } const s = this.snap(P, ts.map(x => x + dt)); this.snapLine(s && s.t, s && s.l); return s ? s.dt : 0; };
      if (mode === 'move') {
        const lo = Math.min(...group.map(g => g.t0)); dt = Math.max(-lo, dt);
        dt += sn(group.map(g => (e.ctrlKey || e.metaKey) && g.pk != null ? g.t0 + g.pk : g.t0).concat(e.ctrlKey ? [] : group.map(g => g.t0 + g.dur)));
        const r1 = this.rowAt(e), i0 = T.findIndex(x => x.id === row0), i1 = T.findIndex(x => x.id === r1), dk = i0 >= 0 && i1 >= 0 ? i1 - i0 : 0;
        const rows = new Map($$('.mt-row[data-track]').map(r => [r.dataset.track, r]));
        for (const g of group) {
          const e2 = els.get(g.key); if (!e2) continue;
          e2.style.left = MT_LABEL + (g.t0 + dt) * Z + 'px';
          const gi = T.findIndex(x => x.id === g.track), to = T[Math.max(0, Math.min(T.length - 1, gi + dk))];
          const okT = to && !(g.scene && to.kind !== 'sfx') ? to : T[gi];
          const ra = rows.get(g.track), rb = rows.get(okT.id);
          e2.style.transform = ra && rb ? `translateY(${rb.offsetTop - ra.offsetTop}px)` : '';
          e2.classList.toggle('copy', copy);
          g._to = okT.id;
        }
        res = { dt };
        this.tip(e, `${group.length > 1 ? group.length + ' шт. · ' : ''}${dt >= 0 ? '+' : '−'}${Math.abs(dt).toFixed(2)} с${copy ? ' · копия' : ''}`);
      } else if (mode === 'r') {
        const seg = (c.clip.out != null ? Math.min(c.len, c.clip.out) : c.len) - c.clip.in;
        let dur = Math.max(0.05, c.dur + dt); dur += sn([c.t0 + dur]) ; dur = Math.max(0.05, dur);
        if (c.layers > 1 && dur > seg) dur = seg;
        el.style.width = dur * Z + 'px'; res = { dur };
        this.tip(e, `${dur.toFixed(2)} с${dur > seg + 0.01 ? ' · ↻ цикл' : ''}`);
      } else if (mode === 'l') {
        dt += sn([c.t0 + dt]);
        dt = Math.max(-c.clip.in, Math.min(c.dur - 0.05, dt));
        if (c.t0 + dt < 0) dt = -c.t0;
        el.style.left = MT_LABEL + (c.t0 + dt) * Z + 'px'; el.style.width = (c.dur - dt) * Z + 'px'; res = { dt };
        this.tip(e, `начало файла ${(c.clip.in + dt).toFixed(2)} с · ${(c.dur - dt).toFixed(2)} с`);
      } else if (mode === 'slip') {
        const inn = Math.max(0, Math.min(c.len - 0.05, c.clip.in - dt)); res = { in: inn };
        this.tip(e, `звук внутри: с ${inn.toFixed(2)} с файла`);
      } else if (mode === 'gain') {
        const dd = -(e.clientY - y0) * (e.shiftKey ? 0.05 : 0.25); res = { dd };
        for (const g of group) { const e2 = els.get(g.key), gl = e2 && e2.querySelector('.mt-gl'); if (gl) gl.style.top = this.gy(this.db(g.it.gain == null ? 1 : +g.it.gain) + dd) - 3 + 'px'; }
        this.tip(e, `${dd >= 0 ? '+' : '−'}${Math.abs(dd).toFixed(1)} dB${group.length > 1 ? ' · ' + group.length + ' шт.' : ` → ${(this.db(c.it.gain == null ? 1 : +c.it.gain) + dd).toFixed(1)} dB`}`);
      } else if (mode === 'fi' || mode === 'fo') {
        const x = mode === 'fi' ? e.clientX - R.left : R.right - e.clientX, v = Math.max(0, Math.min(c.dur * 0.9, x / Z)); res = { v };
        const f = el.querySelector('.mt-fade.' + (mode === 'fi' ? 'l' : 'r')) || el.appendChild(h('i.mt-fade.' + (mode === 'fi' ? 'l' : 'r')));
        f.style.width = v * Z + 'px';
        this.tip(e, `${mode === 'fi' ? 'вход' : 'выход'} ${v.toFixed(2)} с`);
      }
    };
    const up = e => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up);
      document.body.classList.remove('mt-dragging'); this.untip();
      if (!moved || !res) {
        if (mode === 'pick' || ((ev.ctrlKey || ev.metaKey) && !moved)) TLSel.toggle('clips', key);
        else if (!moved) { TLSel.set('clips', [key]); MT.sel = null; }
        App.resume(); Montage.redraw();
        return;
      }
      const ch = [];
      if (mode === 'move') {
        for (const g of group) {
          const tr = this.tracks(M).find(t => t.id === g._to);
          const kind = g.scene ? 'sfx' : tr.kind;
          ch.push({ c: g, copy, set: { at: +(g.at + res.dt).toFixed(3), track: g._to }, kind });
        }
      } else if (mode === 'r') {
        const seg = (c.clip.out != null ? Math.min(c.len, c.clip.out) : c.len) - c.clip.in, set = { dur: +res.dur.toFixed(3) };
        if (res.dur > seg + 0.01 && !c.clip.loop) set.loop = { a: c.clip.in, xf: +Math.min(0.15, seg * 0.2).toFixed(3) };
        ch.push({ c, set: Object.assign(this.unpeak(c), set) });
      } else if (mode === 'l') {
        const set = Object.assign(this.unpeak(c), { at: +(c.t0 + res.dt).toFixed(3), in: +(c.clip.in + res.dt).toFixed(3), dur: +(c.dur - res.dt).toFixed(3) });
        if (c.clip.loop && c.clip.loop.a < set.in) set.loop = Object.assign({}, c.clip.loop, { a: set.in });
        ch.push({ c, set });
      } else if (mode === 'slip') {
        const set = Object.assign(this.unpeak(c), { in: +res.in.toFixed(3), dur: +c.dur.toFixed(3) });
        if (c.clip.out != null && c.clip.out <= set.in + 0.05) set.out = null;
        if (c.clip.loop && c.clip.loop.a < set.in) set.loop = Object.assign({}, c.clip.loop, { a: set.in });
        ch.push({ c, set });
      } else if (mode === 'gain') {
        for (const g of group) ch.push({ c: g, set: { gain: +this.gain(Math.max(-60, Math.min(12, this.db(g.it.gain == null ? 1 : +g.it.gain) + res.dd))).toFixed(4) } });
      } else if (mode === 'fi' || mode === 'fo') ch.push({ c, set: { [mode === 'fi' ? 'fadeIn' : 'fadeOut']: +res.v.toFixed(2) } });
      this.commit(d, ch, { move: 'сдвиг звуков', r: 'длина звука', l: 'обрезка начала', slip: 'звук внутри плашки', gain: 'громкость', fi: 'фейд', fo: 'фейд' }[mode]);
      App.resume();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },
  // «момент: пик» мешает обрезке — плашка встаёт по своему началу (звучит так же)
  unpeak(c) { return c.it.align === 'peak' ? { align: '', at: +c.t0.toFixed(3) } : {}; },
  // рамка по пустому месту дорожек — через все дорожки звука
  marquee(ev, lane) {
    if (ev.button !== 0 || ev.target !== lane) return;
    ev.preventDefault(); ev.stopPropagation();
    const add = ev.ctrlKey || ev.metaKey || ev.shiftKey, base = add && TLSel.kind === 'clips' ? new Set(TLSel.ids) : new Set();
    const x0 = ev.clientX, y0 = ev.clientY, box = h('div.mt-marquee.fixed'); document.body.append(box);
    document.body.classList.add('mt-dragging');
    let moved = false;
    const mv = e => {
      const l = Math.min(x0, e.clientX), r = Math.max(x0, e.clientX), t = Math.min(y0, e.clientY), b = Math.max(y0, e.clientY);
      if (!moved && r - l < 4 && b - t < 4) return;
      moved = true;
      Object.assign(box.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
      const hit = $$('.mt-clip').filter(el => { const q = el.getBoundingClientRect(); return q.right >= l && q.left <= r && q.bottom >= t && q.top <= b; }).map(el => el.dataset.id);
      TLSel.set('clips', [...new Set([...base, ...hit])]);
    };
    const up = e => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); box.remove(); document.body.classList.remove('mt-dragging');
      if (!moved) { if (!add) TLSel.clear(); MT.t = +Montage.xToT(e).toFixed(2); MontagePreview.seek(MT.t); Montage.playhead(); }
      App.resume(); Montage.redraw();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  },

  // ---------------- запись правок ----------------
  // ch: [{c (плашка), set: {поле: значение | null — убрать}, copy?, kind?}] | [{add: {kind, track, at, src, …}}] | [{del: c}]
  async commit(d, ch, label) {
    const M = Montage.M(d), N = Montage.clone(M), T = this.tracks(M), scOps = {}, newSel = [];
    let touchedM = false;
    if (this._newTracks && this._newTracks.length) { N.tracks = T.concat(this._newTracks); this._newTracks = []; touchedM = true; }
    const ensureT = () => { if (!N.tracks) N.tracks = T; };
    const pushSc = (el, op) => (scOps[el] = scOps[el] || []).push(op);
    for (const x of ch) {
      if (x.add) {
        const a = Object.assign({ id: uid(x.add.kind === 'music' ? 'mu' : 'x'), by: 'author' }, x.add); const kind = a.kind; delete a.kind;
        (N[kind === 'music' ? 'music' : 'sfx'] = N[kind === 'music' ? 'music' : 'sfx'] || []).push(a); touchedM = true; ensureT(); newSel.push((kind === 'music' ? 'music' : 'sfx') + '~' + a.id);
        continue;
      }
      const c = x.c || x.del;
      if (x.del) {
        if (c.scene) { if (c.scene.loc) { UI.toast('Звук локации — правится в локации (препродакшен)', 'err'); continue; } pushSc(c.scene.el, { op: 'del', path: ['sounds'], id: c.scene.sid }); }
        else { N[c.list] = (N[c.list] || []).filter(y => y.id !== c.it.id); touchedM = true; }
        continue;
      }
      const set = Object.assign({}, x.set);
      if (c.scene && !x.copy) {
        if (c.scene.loc) { UI.toast('Звук локации — правится в локации (препродакшен)', 'err'); continue; }
        const u = (M.units || []).find(y => y.id === c.scene.u);
        if ('at' in set) { set.t = +Math.max(0, Workspace.v2s(d, u, set.at)).toFixed(3); delete set.at; }
        if (set.track && !T.find(t => t.id === set.track && t.kind === 'sfx')) delete set.track;
        if (set.track) ensureT(), touchedM = touchedM || !M.tracks;
        for (const [k, v] of Object.entries(set)) pushSc(c.scene.el, { op: 'set', path: ['sounds', c.scene.sid, k], value: v == null ? (k === 'in' || k === 'fadeIn' ? 0 : null) : v });
        continue;
      }
      // плашка монтажа (или копия — в т. ч. копия звука сцены становится звуком монтажа)
      const kind = x.kind || c.kind, list = kind === 'music' ? 'music' : 'sfx';
      let it;
      if (x.copy || c.scene) {
        it = Object.assign({}, c.it); delete it.t; delete it.raw; delete it.loc;
        if (c.scene) it.src = c.it.raw || c.it.src;
        it.id = uid(list === 'music' ? 'mu' : 'x'); it.at = c.at;
        (N[list] = N[list] || []).push(it);
      } else {
        it = (N[c.list] || []).find(y => y.id === c.it.id); if (!it) continue;
        if (list !== c.list) { N[c.list] = N[c.list].filter(y => y !== it); (N[list] = N[list] || []).push(it); if (list === 'music') { it.fadeOut = it.fadeOut || 0; } }
      }
      if (it.from != null && it.in == null) { it.in = it.from; } delete it.from;
      for (const [k, v] of Object.entries(set)) { if (v == null) delete it[k]; else it[k] = v; }
      it.by = 'author'; touchedM = true; ensureT();
      newSel.push(list + '~' + it.id);
    }
    if (Object.keys(scOps).length) {
      const done = [];
      for (const [el, ops] of Object.entries(scOps)) {
        try { const r = await api('POST', '/api/scene/op', { key: MT.key, el, ops, desc: '🔊 ' + (label || 'звук') + ' (монтаж)' }); if (r && r.batch && (r.undo || []).length) done.push({ el, undo: r.undo, batch: r.batch }); }
        catch (e) { UI.toast('Звук сцены: ' + e.message, 'err'); }
      }
      if (done.length) { (WS.undo = WS.undo || []).push({ SC: done, label, ts: Date.now() }); WS.redo = []; }
    }
    if (touchedM) Montage.save(N, label);
    if (Object.keys(scOps).length) { await MTA.load(d, true); Montage.redraw(); if (!touchedM) { clearTimeout(MT.genTimer); MT.genTimer = setTimeout(() => Montage.regen(), 300); } if (MT.playing) MTA.play(d, MT.t); }
    if (newSel.length && ch.some(x => x.add || x.copy)) TLSel.set('clips', newSel);
  },
  // отмена / возврат правки звуков сцен (WS.undo: {SC: [{el, undo, batch}]}) -> запись для обратного шага
  async sceneUndo(e) {
    const back = [];
    for (const x of e.SC) {
      try { const r = await api('POST', '/api/scene/op', { key: MT.key, el: x.el, ops: x.undo, kind: 'undo', undoes: x.batch, desc: '↶ звук сцены (монтаж)' }); if (r && (r.undo || []).length) back.push({ el: x.el, undo: r.undo, batch: r.batch }); }
      catch (err) { UI.toast(err.message, 'err'); }
    }
    await MTA.load(MT.d, true); Montage.redraw(); clearTimeout(MT.genTimer); MT.genTimer = setTimeout(() => Montage.regen(), 300);
    return { SC: back, label: e.label, ts: Date.now() };
  },

  // ---------------- правки клавишами и меню ----------------
  sel(d) { return this.items(d, Montage.M(d)).filter(c => TLSel.has('clips', c.key)); },
  split(d) {
    let S = this.sel(d).filter(c => c.t0 < MT.t - 0.02 && c.t0 + c.dur > MT.t + 0.02);
    if (!S.length) { const tr = (document.querySelector('.mt-row[data-track]:hover') || {}).dataset; S = this.items(d, Montage.M(d)).filter(c => (!tr || c.track === tr.track) && c.t0 < MT.t - 0.02 && c.t0 + c.dur > MT.t + 0.02); }
    if (!S.length) return UI.toast('Под плейхедом нет звука — поставьте плейхед на плашку');
    const ch = [];
    for (const c of S) {
      const tp = MT.t - c.t0, P = this.pieces(c.clip, c.len), p = P.find(q => tp >= q[0] && tp < q[0] + q[2]) || P[0];
      const srcPos = p[1] + (tp - p[0]);
      ch.push({ c, set: Object.assign(this.unpeak(c), { dur: +tp.toFixed(3), fadeOut: 0.02 }) });
      const it = Object.assign({}, c.it, { at: +MT.t.toFixed(3), in: +srcPos.toFixed(3), dur: +(c.dur - tp).toFixed(3), fadeIn: 0.02, align: '' });
      if (it.loop && it.loop.a > srcPos) it.loop = Object.assign({}, it.loop, { a: it.in });
      if (c.it.fadeOut != null) it.fadeOut = c.it.fadeOut;
      if (c.scene) {
        const u = (Montage.M(d).units || []).find(y => y.id === c.scene.u), sid = uid('s');
        delete it.at; delete it.raw; delete it.loc; it.id = sid; it.src = c.it.raw || c.it.src; it.t = +Math.max(0, Workspace.v2s(d, u, MT.t)).toFixed(3);
        ch.push({ scAdd: { el: c.scene.el, item: it } });
      } else { delete it.id; ch.push({ add: Object.assign(it, { kind: c.kind }) }); }
    }
    this.commitSplit(d, ch);
  },
  async commitSplit(d, ch) {
    const sc = ch.filter(x => x.scAdd);
    await this.commit(d, ch.filter(x => !x.scAdd), 'разрезать');
    for (const x of sc) {
      try { const r = await api('POST', '/api/scene/op', { key: MT.key, el: x.scAdd.el, ops: [{ op: 'add', path: ['sounds'], item: x.scAdd.item }], desc: '✂ разрезать звук (монтаж)' }); if (r && r.batch) { (WS.undo = WS.undo || []).push({ SC: [{ el: x.scAdd.el, undo: r.undo, batch: r.batch }], label: 'разрезать', ts: Date.now() }); } }
      catch (e) { UI.toast(e.message, 'err'); }
    }
    if (sc.length) { await MTA.load(d, true); Montage.redraw(); Montage.regen(); }
    UI.toast('✂ Разрезано по плейхеду · Ctrl+Z — отменить');
  },
  copy(d) {
    const S = this.sel(d); if (!S.length) return;
    const lo = Math.min(...S.map(c => c.t0));
    this.clipboard = S.map(c => ({ kind: c.kind, track: c.track, dt: c.at - lo, it: Object.assign({}, c.it, c.scene ? { src: c.it.raw || c.it.src } : {}) }));
    UI.toast(`📋 Скопировано: ${S.length} · Ctrl+V — вставить по плейхеду`);
  },
  paste(d, at) {
    if (!this.clipboard) return UI.toast('Буфер пуст — Ctrl+C на выделенных звуках');
    this.commit(d, this.clipboard.map(x => {
      const it = Object.assign({}, x.it); delete it.id; delete it.t; delete it.raw; delete it.loc;
      return { add: Object.assign(it, { kind: x.kind, track: x.track, at: +((at != null ? at : MT.t) + x.dt).toFixed(3) }) };
    }), 'вставка звуков');
  },
  dup(d) {
    const S = this.sel(d); if (!S.length) return;
    const hi = Math.max(...S.map(c => c.t0 + c.dur)), lo = Math.min(...S.map(c => c.t0));
    this.commit(d, S.map(c => ({ c, copy: true, set: { at: +(c.at + (hi - lo)).toFixed(3), track: c.track } })), 'дубль звуков');
  },
  nudge(d, ch) { const S = this.sel(d); if (S.length) this.commit(d, S.map(c => ({ c, set: ch(c) })), 'правка звуков'); },
  remove(d, keys) { const all = this.items(d, Montage.M(d)); this.commit(d, keys.map(k => all.find(c => c.key === k)).filter(Boolean).map(c => ({ del: c })), keys.length > 1 ? `удаление ${keys.length} звуков` : 'удаление звука'); },
  popup(ev, items) {
    $$('.mt-menu').forEach(x => x.remove());
    const m = h('div.mt-menu', { style: { left: Math.min(innerWidth - 240, ev.clientX) + 'px', top: Math.min(innerHeight - 30 * items.length - 20, ev.clientY) + 'px' } },
      items.map(it => it === '-' ? h('hr') : h('div', { class: it[2] ? 'off' : '', onclick: () => { m.remove(); it[1](); } }, it[0], it[3] ? h('kbd', it[3]) : null)));
    document.body.append(m);
    setTimeout(() => addEventListener('mousedown', function f(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('mousedown', f, true); } }, true), 0);
  },
  menu(ev, d, key) {
    const T = this.tracks(Montage.M(d)).filter(t => t.kind !== 'voice'), c = this.byKey(d, key);
    this.popup(ev, [
      ['✂ Разрезать по плейхеду', () => this.split(d), false, 'S'],
      ['⧉ Дублировать', () => this.dup(d), false, 'Ctrl D'],
      ['📋 Копировать', () => this.copy(d), false, 'Ctrl C'],
      ['📥 Вставить по плейхеду', () => this.paste(d), !this.clipboard, 'Ctrl V'],
      '-',
      ['🎛 Редактор звука…', () => this.editor(d, key), false, '2× клик'],
      ['🔁 Заменить похожим…', () => this.replace(d, key)],
      ...T.filter(t => c && t.id !== c.track && !(c.scene && t.kind !== 'sfx')).map(t => ['➜ На дорожку «' + (t.name || t.id) + '»', () => this.commit(d, this.sel(d).map(x => ({ c: x, set: { track: t.id }, kind: x.scene ? 'sfx' : t.kind })), 'на дорожку')]),
      '-',
      ['🗑 Удалить', () => this.remove(d, [...TLSel.ids]), false, 'Del'],
    ]);
  },

  // ---------------- свойства выбранного ----------------
  props(d, M) {
    const S = this.sel(d);
    if (!S.length) return null;
    const one = S.length === 1 ? S[0] : null;
    const set = (patch, why) => this.commit(d, S.map(c => ({ c, set: typeof patch === 'function' ? patch(c) : patch })), why || 'правка звука');
    const num = (label, v, fn, step = 0.05, title) => h('label.mt-f', { title }, label, h('input', { type: 'number', step, value: v == null ? '' : +(+v).toFixed(3), onchange: ev => fn(ev.target.value === '' ? null : +ev.target.value) }));
    const T = this.tracks(M).filter(t => t.kind !== 'voice');
    const trackSel = msel(T.filter(t => !S.some(c => c.scene) || t.kind === 'sfx').map(t => [t.id, (t.kind === 'music' ? '🎵 ' : '🔊 ') + (t.name || t.id)]), one ? one.track : '',
      v => this.commit(d, S.map(c => ({ c, set: { track: v }, kind: c.scene ? 'sfx' : (T.find(t => t.id === v) || {}).kind })), 'на дорожку'));
    const btns = h('span.row',
      h('button.small', { title: 'Тише на 1 dB (Alt+↓)', onclick: () => set(c => ({ gain: +this.gain(this.db(c.it.gain == null ? 1 : +c.it.gain) - 1).toFixed(4) })) }, '−1 dB'),
      h('button.small', { title: 'Громче на 1 dB (Alt+↑)', onclick: () => set(c => ({ gain: +this.gain(this.db(c.it.gain == null ? 1 : +c.it.gain) + 1).toFixed(4) })) }, '+1 dB'),
      one && h('button.small', { onclick: () => this.editor(d, one.key) }, '🎛 Редактор'),
      one && h('button.small', { onclick: () => this.replace(d, one.key) }, '🔁 Заменить похожим'),
      h('button.danger.small', { onclick: () => this.remove(d, S.map(c => c.key)) }, '🗑'));
    if (!one) return h('div.mt-propbox', h('div.row', h('b', `🔊 Звуков: ${S.length}`), h('span.dim.small', S.some(c => c.scene) ? ' · есть звуки сцен — их правка уйдёт в сцены' : ''), h('span.sp'), h('label.mt-f', 'дорожка', trackSel), btns));
    const c = one, it = c.it, cl = c.clip, db = this.db(it.gain == null ? 1 : +it.gain);
    const I = MT.info[d.id] || {};
    const srcIn = h('input.mt-lib', { list: 'mt-libs', value: c.scene ? (it.raw || it.src) : it.src || '', title: 'Источник: lib:<id>, lib:sounds/<slug>@N, el:<id>, file:<путь> — проще перетащить из панели «🔊 Звуки»',
      onchange: ev => { const v = ev.target.value.trim(); if (v) set({ src: v }); } });
    return h('div.mt-propbox',
      h('div.row', h('b', (c.kind === 'music' ? '🎵 ' : '🔊 ') + c.label), c.scene ? h('span.dim.small', ` звук сцены ${c.scene.n} «${c.scene.name}»${c.scene.loc ? ' — звук локации, правится в локации' : ' — правка уйдёт в сцену'}`) : null,
        c.by === 'author' ? h('span.dim.small', { title: 'Claude не меняет его без вашего «да»' }, ' · 🔒 ваш') : null, h('span.sp'), srcIn,
        h('datalist#mt-libs', (I.lib || []).slice(0, 400).map(x => h('option', { value: 'lib:' + x[0] }, `${x[2]} · ${x[1]} с`))), btns),
      h('div.row',
        num('с', c.at, v => set({ at: v || 0 }), 0.05, it.align === 'peak' ? 'момент пика звука' : 'начало звука'),
        h('label.mt-f', 'момент', msel([['', 'начало'], ['peak', 'пик']], it.align || '', v => set({ align: v }))),
        num('dB', +db.toFixed(1), v => set({ gain: +this.gain(v || 0).toFixed(4) }), 0.5),
        num('с места', cl.in, v => set({ in: Math.max(0, v || 0) }), 0.05, 'с какой секунды файла играть'),
        num('до', cl.out, v => set({ out: v }), 0.05, 'до какой секунды файла (пусто — до конца)'),
        num('длина', +c.dur.toFixed(3), v => set({ dur: v }), 0.05, 'длина плашки; больше куска файла — цикл'),
        h('label.mt-f', { title: 'дальше конца — повторять кусок (шов — в редакторе звука)' }, h('input', { type: 'checkbox', checked: !!cl.loop, onchange: ev => set({ loop: ev.target.checked ? { a: cl.in, xf: 0.15 } : null }) }), 'цикл'),
        num('вход', cl.fadeIn, v => set({ fadeIn: v || 0 }), 0.05),
        num('выход', cl.fadeOut, v => set({ fadeOut: v }), 0.05, c.kind === 'sfx' ? 'пусто — авто-затухание после пика' : ''),
        h('label.mt-f', 'дорожка', trackSel),
        h('label.mt-f', 'заметка', h('input', { value: it.note || '', onchange: ev => set({ note: ev.target.value }) }))));
  },

  // ---------------- панель «🔊 Звуки» (слева в окне видео) ----------------
  toggle(on) { this.panel = on == null ? !this.panel : on; Local.set('snd-panel', this.panel ? '1' : '0'); App.render(); },
  async load(d, force) {
    const k = this.tab + '|' + this.q + '|' + this.cat + '|' + (this.pack || '');
    if (this.tab === 'net') return;
    if (!force && this.list.k === k && this.list.vid === d.id) return;
    this.list = { k, vid: d.id, busy: true, items: (this.list.vid === d.id && this.list.tab === this.tab && this.list.items) || [], tab: this.tab, cats: this.list.cats };
    try { const r = await api('GET', `/api/audio/list?video=${encodeURIComponent(d.id)}&tab=${this.tab}&q=${encodeURIComponent(this.q)}&cat=${encodeURIComponent(this.cat)}&pack=${encodeURIComponent(this.pack || '')}`); if (this.list.k !== k) return; Object.assign(this.list, { items: r.items, cats: r.cats && r.cats.length ? r.cats : this.list.cats, packs: r.packs || this.list.packs, n: r.n, busy: false }); if (r.import && r.import.status === 'run' && !this.impT) { this.imp = r.import; this.pollImport(d); } }
    catch (e) { this.list.busy = false; this.list.err = e.message; }
    this.drawPanel(d);
  },
  // «＋ Пак»: папка или .zip -> общая библиотека звуков (sfx_library.py import на сервере), прогресс — строкой в панели
  async addPack(d) {
    const path = prompt('Путь к паку звуков — папка или .zip (например D:\\Загрузки\\Sonniss GDC 2026).\nКатегории (whoosh, impact, ui, ambience…) разложатся сами по именам файлов; повторный запуск продолжит с места.');
    if (!path || !path.trim()) return;
    const license = prompt('Лицензия пака (для «Прав» в упаковке; можно пусто)', /sonniss|gdc/i.test(path) ? 'Sonniss GDC: royalty-free, без атрибуции, не для обучения ИИ' : '') || '';
    try { this.imp = await api('POST', '/api/audio/import', { path: path.trim(), license }); this.drawPanel(d); this.pollImport(d); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  pollImport(d) {
    clearTimeout(this.impT);
    this.impT = setTimeout(async () => {
      this.impT = null;
      try { this.imp = await api('GET', '/api/audio/importstate'); } catch (e) { return; }
      if (this.imp.status === 'run') { this.drawPanel(d); this.pollImport(d); }
      else { this.load(d, true); if (this.imp.status === 'done') UI.toast(`🔊 Пак «${this.imp.pack}»: добавлено звуков ${this.imp.added}`); }
    }, 2000);
  },
  async netSearch(d) {
    if (!this.netQ.trim()) return;
    this.net = { busy: true, items: [] }; this.drawPanel(d);
    try { const r = await api('GET', '/api/audio/search?q=' + encodeURIComponent(this.netQ.trim())); this.net = { items: r.results || [], errs: r.errors || [] }; }
    catch (e) { this.net = { items: [], errs: [e.message] }; }
    this.drawPanel(d);
  },
  panelEl(d) {
    if (this.tab !== 'net') this.load(d);
    return h('div.snd-panel', this.panelBody(d));
  },
  drawPanel(d) { const p = $('.snd-panel'); if (p) keepScroll(p, () => p.replaceChildren(...this.panelBody(d).flat(Infinity).filter(x => x instanceof Node))); },
  panelBody(d) {
    const tabs = [['lib', 'Общие', 'Общая библиотека звуков Studio (паки)'], ['channel', 'Канал', 'Звуки библиотеки канала'], ['video', 'Видео', 'Препродакшен этого видео и ваши файлы'], ['net', 'Сеть', 'Поиск в интернете: YouTube, Freesound, Commons']];
    const L = this.list.tab === this.tab ? this.list : { items: [] };
    let qt = 0;
    const head = [
      h('div.ws-sec', '🔊 Звуки', h('span.sp'), h('button.icon', { title: 'Закрыть панель — назад к сценам', onclick: () => this.toggle(false) }, '✕')),
      h('div.snd-tabs', tabs.map(([k, l, tt]) => h('button', { class: this.tab === k ? 'on' : '', title: tt, onclick: () => { this.tab = k; Local.set('snd-tab', k); this.cat = ''; this.drawPanel(d); if (k !== 'net') this.load(d, true); } }, l))),
      this.tab === 'net'
        ? h('form.snd-q', { onsubmit: ev => { ev.preventDefault(); this.netSearch(d); } }, h('input.box', { placeholder: 'YouTube, Freesound, Commons…', value: this.netQ, oninput: ev => { this.netQ = ev.target.value; } }), h('button.small', 'Найти'))
        : h('div.snd-q', h('input.box', { placeholder: 'дождь, удар, вжух…', value: this.q, key: 'sndq', oninput: ev => { this.q = ev.target.value; clearTimeout(qt); qt = setTimeout(() => this.load(d), 220); } })),
      this.tab === 'lib' ? h('div.snd-packs',
        msel([['', 'все паки'], ...(this.list.packs || []).map(p => [p, p])], this.pack || '', v => { this.pack = v; this.load(d, true); }),
        h('button.small', { title: 'Добавить пак звуков: папка или .zip (Sonniss, свой сборник…) — категории разложатся сами', onclick: () => this.addPack(d) }, '＋ Пак')) : null,
      this.tab === 'lib' && this.imp && this.imp.status ? h('div.snd-imp', { class: this.imp.status },
        this.imp.status === 'run' ? [h('span.spin'), ` импорт «${this.imp.pack}»: ${this.imp.i || 0} из ${this.imp.n || '…'} · добавлено ${this.imp.added || 0}`]
          : this.imp.status === 'done' ? `✓ «${this.imp.pack}»: добавлено ${this.imp.added}` : '⚠ ' + (this.imp.error || 'импорт не удался')) : null,
      this.tab === 'lib' && (L.cats || this.list.cats || []).length ? h('div.snd-cats', ['', ...(this.list.cats || [])].map(c => h('span', { class: this.cat === c ? 'on' : '', onclick: () => { this.cat = c; this.load(d, true); } }, c || 'все'))) : null,
    ];
    const rows = this.tab === 'net' ? ((this.net || {}).items || []) : L.items || [];
    const body = this.tab === 'net' && (this.net || {}).busy ? [h('p.dim.small', h('span.spin'), ' ищу…')]
      : rows.length ? rows.map(x => this.tab === 'net' ? this.netRow(d, x) : this.row(d, x))
      : [h('p.dim.small', L.busy ? 'загружаю…' : this.tab === 'net' ? 'Найдите звук — его можно прослушать по ссылке и перетащить на дорожку: скачается сам.' : this.tab === 'video' ? 'Пока пусто: звуки препродакшена и ваши файлы (бросьте их сюда или на дорожку).' : 'Ничего не нашлось.')];
    const drop = h('div.snd-drop', '⬇ Бросьте сюда свои файлы (.wav .mp3 .ogg, видео — возьмётся звук) — или прямо на дорожку');
    this.fileDrop(drop, d, null);
    return [...head, h('div.snd-list', body, this.tab === 'net' && ((this.net || {}).errs || []).length ? h('p.dim.small', '⚠ ' + this.net.errs.join('; ')) : null), drop];
  },
  row(d, x) {
    return h('div.snd-it', { title: `${x.name}\n${x.src}${x.desc ? '\n' + x.desc : ''}\nперетащите на дорожку · двойной клик — поставить в плейхед`,
      onmousedown: ev => this.grab(ev, d, x),
      ondblclick: () => this.place(d, x, null, MT.t) },
      h('button.snd-pl', { title: 'Прослушать', onclick: ev => { ev.stopPropagation(); this.audition(x.url, ev.currentTarget); } }, '▶'),
      h('span.snd-n', h('b', x.name), h('small', [x.cat, x.layers > 1 ? `${x.layers} слоя` : '', x.license].filter(Boolean).join(' · '))),
      h('span.snd-d', x.dur ? (+x.dur).toFixed(1) + ' с' : ''));
  },
  netRow(d, x) {
    const item = { fetch: true, url: x.url, name: x.title, dur: x.dur && x.dur < 600 ? x.dur : 4, src: '' };
    return h('div.snd-it', { title: `${x.title}\n${x.author || ''} · ${x.license || ''}\nперетащите на дорожку — скачается сам (длинное видео — укажите «с / по»)`,
      onmousedown: ev => this.grab(ev, d, Object.assign(item, { start: x._s, end: x._e })) },
      x.src === 'youtube' || !/\.(wav|mp3|ogg|flac|m4a)(\?|$)/i.test(x.url) ? h('a.snd-pl', { href: x.page || x.url, target: '_blank', title: 'Открыть источник' }, '↗') : h('button.snd-pl', { onclick: ev => this.audition(x.url, ev.currentTarget) }, '▶'),
      h('span.snd-n', h('b', x.title), h('small', [x.src, x.author, x.tags].filter(Boolean).join(' · ')),
        x.dur > 30 ? h('span.snd-cut', 'с', h('input', { placeholder: '0', size: 3, onchange: ev => { x._s = ev.target.value; } }), 'по', h('input', { placeholder: '10', size: 3, onchange: ev => { x._e = ev.target.value; } })) : null),
      h('span.snd-d', x.dur ? Math.round(x.dur) + ' с' : ''));
  },
  audition(url, btn) {
    if (this.au) { this.au.pause(); const was = this.au.src; this.au = null; $$('.snd-pl.on').forEach(b => { b.classList.remove('on'); b.textContent = '▶'; }); if (was && was.endsWith(url)) return; }
    if (!url) return;
    this.au = new Audio(url); this.au.play().catch(() => {});
    if (btn) { btn.classList.add('on'); btn.textContent = '❚❚'; }
    this.au.onended = () => { if (btn) { btn.classList.remove('on'); btn.textContent = '▶'; } this.au = null; };
  },
  // цель перетаскивания — дорожка (или «＋ новая дорожка»): призрак плашки с прилипанием, бросок — звук встаёт там
  // призрак плашки над дорожкой (перетаскивание из панели и файлов): прилипание, Shift — без
  hover(lane, ev, d, item) {
    let t = Montage.xToT(ev);
    const s = ev.shiftKey ? null : this.snap(this._pts || (this._pts = this.snapPts(d, Montage.M(d), new Set())), [t]);
    if (s) t += s.dt;
    this.snapLine(s && s.t, s && s.l);
    $$('.mt-dropghost').forEach(g => { if (g.parentNode !== lane) g.remove(); });
    let g = lane.querySelector('.mt-dropghost');
    if (!g) { g = h('div.mt-dropghost'); lane.append(g); }
    g.style.left = MT_LABEL + t * MT.zoom + 'px'; g.style.width = Math.max(30, ((item && item.dur) || 2) * MT.zoom) + 'px';
    g.textContent = '+ ' + (item ? item.name : 'файлы');
    lane._t = t;
    return t;
  },
  unhover() { $$('.mt-dropghost').forEach(g => g.remove()); this.snapLine(null); this._pts = null; },
  // перетаскивание звука из панели — мышью, не HTML5: окно Studio (WebView2 в Tauri) на Windows перехватывает HTML5-перетаскивание
  grab(ev, d, item) {
    if (ev.button !== 0 || ev.target.closest('.snd-pl, input, a, button')) return;
    ev.preventDefault();
    const x0 = ev.clientX, y0 = ev.clientY;
    let fly = null, lane = null;
    const mv = e => {
      if (!fly && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 5) return;
      if (!fly) { fly = h('div.snd-fly', item.name); document.body.append(fly); document.body.classList.add('mt-dragging', 'snd-grabbing'); }
      fly.style.left = e.clientX + 14 + 'px'; fly.style.top = e.clientY + 10 + 'px';
      const el = document.elementFromPoint(e.clientX, e.clientY), L = el && el.closest && el.closest('.mt-lane.snd, .mt-lane.snd-add');
      if (L) { lane = L; this.hover(L, e, d, item); fly.classList.add('ok'); } else { lane = null; this.unhover(); fly.classList.remove('ok'); }
    };
    const end = drop => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); removeEventListener('keydown', esc, true);
      document.body.classList.remove('mt-dragging', 'snd-grabbing');
      if (fly) fly.remove();
      const t = lane && lane._t;
      this.unhover();
      if (drop && lane && t != null) this.place(d, item, lane.classList.contains('snd-add') ? this.newTrack(d, item) : lane.dataset.track, t);
      App.resume();
    };
    const up = () => end(true);
    const esc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
    addEventListener('mousemove', mv); addEventListener('mouseup', up); addEventListener('keydown', esc, true);
  },
  dropZone(lane, d, trackFor) {
    lane.addEventListener('dragover', ev => {
      const files = ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
      if (!files) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy';
      this.hover(lane, ev, d, null);
    });
    lane.addEventListener('dragleave', ev => { if (!lane.contains(ev.relatedTarget)) this.unhover(); });
    lane.addEventListener('drop', ev => {
      ev.preventDefault();
      const t0 = lane._t; this.unhover(); lane._t = t0;
      const t = lane._t != null ? lane._t : Montage.xToT(ev), files = [...((ev.dataTransfer || {}).files || [])];
      if (files.length) return this.upload(d, files, item => trackFor(item), t);
      if (this.drag) { const it = this.drag; this.drag = null; this.place(d, it, trackFor(it), t); }
    });
  },
  fileDrop(el, d, trackFor) {
    el.addEventListener('dragover', ev => { if ([...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); el.classList.add('hot'); } });
    el.addEventListener('dragleave', () => el.classList.remove('hot'));
    el.addEventListener('drop', ev => { ev.preventDefault(); el.classList.remove('hot'); const f = [...ev.dataTransfer.files]; if (f.length) this.upload(d, f, trackFor, null); });
  },
  async upload(d, files, trackFor, t) {
    let at = t;
    for (const f of files) {
      if (!/^(audio|video)\//.test(f.type) && !/\.(wav|mp3|ogg|flac|m4a|aac|opus|mp4|mov|webm|mkv)$/i.test(f.name)) { UI.toast('Не звук: ' + f.name, 'err'); continue; }
      UI.toast('⬆ ' + f.name + '…');
      try {
        const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
        const it = await api('POST', '/api/audio/upload', { video: d.id, name: f.name, data });
        this.known[it.src] = it.dur;
        if (at != null && trackFor) { await this.place(d, it, trackFor(it), at); at += it.dur || 1; }
      } catch (e) { UI.toast(f.name + ': ' + e.message, 'err'); }
    }
    if (this.tab === 'video') this.load(d, true);
    if (at == null) { this.tab = 'video'; Local.set('snd-tab', 'video'); this.load(d, true); UI.toast('Файлы — во вкладке «Видео»: перетащите на дорожку'); }
  },
  // поставить звук панели на дорожку (track null — первая дорожка подходящего вида); из интернета — сначала скачать (призрак «⬇ качаю…»)
  async place(d, item, track, at) {
    const M = Montage.M(d), T = this.tracks(M).concat(this._newTracks || []);
    let tr = T.find(t => t.id === track);
    if (!tr) { const kind = item.dur > 25 ? 'music' : 'sfx'; tr = T.find(t => t.kind === kind); }
    at = Math.max(0, +(+at || 0).toFixed(3));
    if (item.fetch) {
      const p = { vid: d.id, track: tr.id, t: at, dur: item.dur, name: item.name };
      this.pending.push(p); Montage.redraw();
      try {
        const { id } = await api('POST', '/api/audio/fetch', { video: d.id, url: item.url, start: item.start, end: item.end, title: item.name });
        let st;
        for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 1500)); st = await api('GET', '/api/audio/fetchstate?id=' + id); if (st.status !== 'run') break; }
        if (!st || st.status !== 'done') throw new Error((st && st.error) || 'не скачалось');
        item = st.item; this.known[item.src] = item.dur;
      } catch (e) { UI.toast('⬇ ' + e.message, 'err'); return; }
      finally { this.pending = this.pending.filter(x => x !== p); Montage.redraw(); }
    }
    if (item.dur) this.known[item.src] = item.dur;
    const music = tr.kind === 'music';
    await this.commit(d, [{ add: Object.assign({ kind: tr.kind, track: tr.id, at, src: item.src, gain: music ? 0.6 : 0.8, note: item.name || '' }, music ? { fadeIn: 0.5, fadeOut: 1 } : {}) }], 'звук на дорожку');
    await Store.flush(MT.key).catch(() => {});
    await MTA.load(d, true); Montage.redraw();
  },

  // ---------------- редактор звука (двойной клик по плашке) ----------------
  async editor(d, key) {
    const c = this.byKey(d, key); if (!c) return;
    if (c.scene && c.scene.loc) return UI.toast('Звук локации — правится в локации (препродакшен)', 'err');
    const L = this.layers(c.it.src)[0]; if (!L) return UI.toast('Звук ещё не загрузился — попробуйте через секунду', 'err');
    const b = await MTA.buf(L.url); if (!b) return UI.toast('Не получилось прочитать звук', 'err');
    const off = L.off || 0, len = c.layers > 1 ? c.len : Math.min(b.duration - off, c.len || 1e9) || b.duration;
    const st = { in: c.clip.in || 0, out: c.clip.out != null ? Math.min(len, c.clip.out) : len, loop: !!c.clip.loop, a: c.clip.loop && c.clip.loop.a != null ? c.clip.loop.a : c.clip.in || 0, xf: c.clip.loop ? (c.clip.loop.xf != null ? +c.clip.loop.xf : 0.15) : 0.15 };
    const data = b.getChannelData(0), sr = b.sampleRate;
    let pkAll = 1e-4; for (let i = Math.floor(off * sr), e = Math.min(data.length, Math.floor((off + len) * sr)); i < e; i += 16) pkAll = Math.max(pkAll, Math.abs(data[i]));
    const kv = 0.95 / pkAll;                                         // тихий звук — волна во всю высоту (как в любом редакторе)
    const cv = h('canvas.se-cv', { width: 1600, height: 220 }), over = h('div.se-over');
    const wrap = h('div.se-wave', cv, over);
    const info = h('span.dim.small');
    const X = s => (s / len * 100) + '%';
    const draw = () => {
      const g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
      for (let x = 0; x < W; x++) {
        const s0 = Math.floor((off + x / W * len) * sr), s1 = Math.floor((off + (x + 1) / W * len) * sr); let mn = 0, mx = 0;
        for (let i = s0; i < s1; i += 8) { const v = data[i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
        const t = x / W * len, inside = t >= st.in && t <= st.out, lp = st.loop && t >= st.a && t <= st.out;
        g.fillStyle = !inside ? '#555a' : lp ? '#5fd0b4' : '#9fb4d8';
        g.fillRect(x, H / 2 - mx * kv * H / 2, 1, Math.max(1, (mx - mn) * kv * H / 2));
      }
    };
    const handles = () => {
      over.replaceChildren(
        h('div.se-cut', { style: { left: 0, width: X(st.in) } }), h('div.se-cut', { style: { left: X(st.out), right: 0 } }),
        st.loop ? h('div.se-loop', { style: { left: X(st.a), width: `calc(${X(st.out)} - ${X(st.a)})` } }, h('span', `цикл ${st.a.toFixed(2)}–${st.out.toFixed(2)} с`)) : null,
        st.loop && st.xf > 0 ? h('div.se-xf', { style: { left: X(Math.max(st.a, st.out - st.xf)), width: `calc(${X(st.out)} - ${X(Math.max(st.a, st.out - st.xf))})` } }) : null,
        hd('in', 'начало ' + st.in.toFixed(2)), hd('out', 'конец ' + st.out.toFixed(2)), st.loop ? hd('a', 'цикл с ' + st.a.toFixed(2)) : null);
      info.textContent = `кусок ${(st.out - st.in).toFixed(2)} с из ${len.toFixed(2)} с` + (st.loop ? ` · повторяется ${(st.out - st.a).toFixed(2)} с, шов ${st.xf.toFixed(2)} с` : '');
      draw();
    };
    const hd = (k, label) => h('div.se-h', { class: k, style: { left: X(st[k]) }, title: 'тяните',
      onmousedown: ev => {
        ev.preventDefault(); const R = wrap.getBoundingClientRect();
        const mv = e => {
          let v = Math.max(0, Math.min(len, (e.clientX - R.left) / R.width * len));
          if (k === 'in') v = Math.min(v, st.out - 0.05); if (k === 'out') v = Math.max(v, Math.max(st.in, st.loop ? st.a : 0) + 0.05); if (k === 'a') v = Math.max(st.in, Math.min(v, st.out - 0.1));
          st[k] = +v.toFixed(3); if (k === 'in' && st.a < st.in) st.a = st.in; handles();
        };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      } }, h('i', label));
    // прослушивание прямо из буфера: весь кусок или шов по кругу
    let nodes = [];
    const stop = () => { nodes.forEach(n => { try { n.stop(); } catch (e) {} }); nodes = []; };
    const ctx = MTA.ac();
    const playSeg = (from, to, when, fadeIn, fadeOut) => {
      const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain(); s.connect(g).connect(MTA.out());
      const ln = to - from; g.gain.setValueAtTime(fadeIn ? 0 : 1, when);
      if (fadeIn) g.gain.linearRampToValueAtTime(1, when + fadeIn);
      if (fadeOut) { g.gain.setValueAtTime(1, when + ln - fadeOut); g.gain.linearRampToValueAtTime(0, when + ln); }
      s.start(when, off + from, ln); nodes.push(s);
    };
    const listen = () => { stop(); const t0 = ctx.currentTime + 0.05; playSeg(st.in, Math.min(st.out, st.in + 12), t0, 0, 0.05); };
    const seam = () => {
      stop(); const t0 = ctx.currentTime + 0.05, pre = Math.min(2, st.out - st.a), post = Math.min(2, st.out - st.a), xf = Math.min(st.xf, pre * 0.45);
      for (let r = 0; r < 4; r++) { const w = t0 + r * (pre + post); playSeg(st.out - pre, st.out, w, 0, xf); playSeg(st.a, st.a + post, w + pre - xf, xf, 0); }
    };
    // тихие края: порог −45 dB от пика
    const trim = () => {
      let pk = 0; const a = Math.floor(off * sr), e = Math.floor((off + len) * sr);
      for (let i = a; i < e; i += 4) pk = Math.max(pk, Math.abs(data[i] || 0));
      const th = pk * Math.pow(10, -45 / 20); let i0 = a, i1 = e - 1;
      while (i0 < e && Math.abs(data[i0] || 0) < th) i0++;
      while (i1 > i0 && Math.abs(data[i1] || 0) < th) i1--;
      st.in = +Math.max(0, (i0 - a) / sr - 0.01).toFixed(3); st.out = +Math.min(len, (i1 - a) / sr + 0.05).toFixed(3); if (st.a < st.in) st.a = st.in; handles();
    };
    // шов цикла: ищем a (в начале куска) и конец (в хвосте), где громкость и «окраска» (частота переходов через ноль) похожи — шов попадёт между похожими местами
    const findSeam = () => {
      const fr = 0.02, n = Math.floor(fr * sr), F = Math.floor(len / fr), E = new Float32Array(F), Zc = new Float32Array(F);
      for (let f = 0; f < F; f++) { let s = 0, z = 0, p = 0; const a = Math.floor(off * sr) + f * n; for (let i = 0; i < n; i += 2) { const v = data[a + i] || 0; s += v * v; if ((v >= 0) !== (p >= 0)) z++; p = v; } E[f] = Math.sqrt(s / (n / 2)); Zc[f] = z / (n / 2); }
      const em = Math.max(1e-6, ...E), W = 15, fi = Math.floor(st.in / fr), fo = Math.floor(st.out / fr), span = fo - fi;
      if (span < 3 * W) return UI.toast('Кусок слишком короткий, чтобы искать шов', 'err');
      let best = null;
      for (let A = fi + W; A < fi + span * 0.4; A++) for (let B = Math.floor(fi + span * 0.6); B < fo - 1; B++) {
        let cost = 0; for (let k = -W; k < W; k++) { const x = A + k, y = B + k; if (x < 0 || y >= F) continue; cost += Math.abs(E[x] - E[y]) / em + 0.5 * Math.abs(Zc[x] - Zc[y]); }
        cost -= 0.004 * (B - A);
        if (!best || cost < best.c) best = { c: cost, A, B };
      }
      if (!best) return;
      st.loop = true; st.a = +(best.A * fr).toFixed(3); st.out = +(best.B * fr).toFixed(3); st.xf = Math.min(0.3, Math.max(0.08, st.xf)); handles(); seam();
    };
    const xfIn = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: st.xf, oninput: ev => { st.xf = +ev.target.value; xfv.textContent = st.xf.toFixed(2) + ' с'; handles(); } }), xfv = h('b', st.xf.toFixed(2) + ' с');
    const loopCb = h('input', { type: 'checkbox', checked: st.loop, onchange: ev => { st.loop = ev.target.checked; handles(); } });
    const save = async () => {                                       // кусок (с фейдами плашки, без цикла) -> новый звук видео
      const ln = Math.min(60, st.out - st.in), oc = new OfflineAudioContext(b.numberOfChannels, Math.ceil(ln * b.sampleRate), b.sampleRate);
      const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start(0, off + st.in, ln);
      const out = await oc.startRendering(), wav = this.wavB64(out);
      try { const it = await api('POST', '/api/audio/upload', { video: d.id, name: (c.label || 'звук').replace(/^[^\wа-яё]+/i, '') + ' (обработан).wav', data: wav, edit: true }); this.known[it.src] = it.dur; UI.toast('💾 Сохранено — во вкладке «Видео» панели «🔊 Звуки»'); if (this.tab === 'video') this.load(d, true); }
      catch (e) { UI.toast(e.message, 'err'); }
    };
    const apply = () => {
      stop(); close();
      const set = Object.assign(this.unpeak(c), { in: st.in, out: st.out >= len - 0.01 ? null : st.out, loop: st.loop ? { a: st.a, xf: st.xf } : null });
      if (c.it.dur == null) set.dur = +Math.min(c.dur, st.out - st.in).toFixed(3);
      this.commit(d, [{ c, set }], 'редактор звука');
    };
    const body = h('div.se',
      h('p.dim.small', 'Тяните ручки: «начало» и «конец» — какой кусок играет; зелёное — кусок, который повторяется, если плашку растянуть дальше конца. «Найти шов» сам подберёт ровное место; «Слушать шов» играет стык по кругу. Файл не меняется.'),
      wrap, h('div.row', info),
      h('div.row.se-btns',
        h('button', { onclick: listen }, '▶ Слушать'), h('button', { onclick: seam }, '🔁 Слушать шов'), h('button', { onclick: stop }, '⏹'),
        h('span.sep'), h('button', { onclick: trim, title: 'Убрать тихие края (−45 dB): обрыв с тишиной в конце пропадёт' }, '✂ Срезать тишину'),
        h('button', { onclick: findSeam, title: 'Подобрать начало и конец цикла, где звук похож — шов не слышно' }, '🔁 Найти шов'),
        h('label.mt-f', loopCb, 'цикл'), h('label.mt-f', 'шов', xfIn, xfv),
        h('button', { onclick: () => { Object.assign(st, { in: 0, out: len, loop: false, a: 0, xf: 0.15 }); loopCb.checked = false; handles(); } }, '↺ Сбросить'),
        h('span.sp'), h('button', { onclick: save, title: 'Записать кусок отдельным звуком видео' }, '💾 Как новый звук'), h('button.primary', { onclick: apply }, '✓ Готово')));
    const close = UI.modal('🎛 Редактор звука — ' + c.label, body, { wide: true, onClose: stop });
    const mod = body.closest('.modal'); if (mod) mod.classList.add('snd-modal');   // поверх панели Claude
    requestAnimationFrame(handles);
  },
  wavB64(buf) {
    const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const C = [...Array(ch)].map((_, i) => buf.getChannelData(i));
    for (let i = 0, o = 44; i < n; i++) for (let k = 0; k < ch; k++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, C[k][i])) * 32767, true);
    let s = ''; const u = new Uint8Array(out.buffer); for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return 'data:audio/wav;base64,' + btoa(s);
  },

  // ---------------- «Заменить похожим…» ----------------
  async replace(d, key) {
    const c = this.byKey(d, key); if (!c) return;
    const list = h('div.snd-alts', h('p.dim.small', h('span.spin'), ' ищу похожие…'));
    const tryIt = async x => {                                       // прослушать на месте: секунда до и после, с этим звуком вместо нынешнего
      if (x.fetch) return UI.toast('Сначала «Взять» — звук из интернета скачается');
      const M2 = Montage.clone(Montage.M(d));
      if (c.scene) { (M2.sfx = M2.sfx || []).push({ id: 'pv', at: c.at, src: x.src, gain: c.it.gain, align: c.it.align, track: c.track }); MTA.map.scenes[c.scene.el] = (MTA.map.scenes[c.scene.el] || []).filter(s => s.id !== c.scene.sid); }
      else { const it = (M2[c.list] || []).find(y => y.id === c.it.id); if (it) it.src = x.src; }
      this.known[x.src] = x.dur;
      if (!MTA.map.srcs[x.src]) MTA.map.srcs[x.src] = [{ url: x.url, at: 0, gain: 1, lib: /^lib:[^s]/.test(x.src), peak: x.peak }];
      await MTA.preview(d, M2, c.t0 - 1, Math.min(6, c.dur + 2));
      if (c.scene) MTA.load(d, true);
    };
    const take = async x => {
      close();
      if (x.fetch) { const it = await this.fetchNow(d, x); if (!it) return; x = it; }
      this.known[x.src] = x.dur;
      await this.commit(d, [{ c, set: { src: x.src, note: x.name } }], 'замена звука');
      await Store.flush(MT.key).catch(() => {}); await MTA.load(d, true); Montage.redraw();
    };
    const draw = (rows, more) => list.replaceChildren(...(rows.length ? rows.map(x => h('div.snd-it',
      h('button.snd-pl', { title: 'Прослушать на месте в ролике', onclick: () => tryIt(x) }, '▶'),
      h('span.snd-n', h('b', x.name), h('small', [x.cat, x.dur ? (+x.dur).toFixed(1) + ' с' : ''].filter(Boolean).join(' · '))),
      h('button.small', { onclick: () => take(x) }, 'Взять'))) : [h('p.dim.small', 'В библиотеке похожих не нашлось — поищите в интернете или спросите Claude.')]), more || '');
    const q = h('input', { value: String(c.it.note || c.label).replace(/^[^\wа-яё]+/i, ''), placeholder: 'что за звук' });
    const net = async () => {
      list.replaceChildren(h('p.dim.small', h('span.spin'), ' ищу в интернете…'));
      try { const r = await api('GET', '/api/audio/search?q=' + encodeURIComponent(q.value)); draw((r.results || []).filter(x => /\.(wav|mp3|ogg|flac)/i.test(x.url) || x.src !== 'youtube' || (x.dur && x.dur < 120)).slice(0, 8).map(x => ({ fetch: true, url: x.url, name: x.title, dur: x.dur, cat: x.src }))); }
      catch (e) { list.replaceChildren(h('p.dim.small', '⚠ ' + e.message)); }
    };
    const body = h('div.se',
      h('div.row', q, h('button.small', { onclick: async () => { const r = await api('GET', `/api/audio/similar?video=${encodeURIComponent(d.id)}&src=${encodeURIComponent(c.it.raw || c.it.src)}&q=${encodeURIComponent(q.value)}`); draw(r.items); } }, '🔎 в библиотеке'),
        h('button.small', { onclick: net }, '🌐 в интернете'),
        h('button.small', { title: 'Claude подберёт и поставит сам (чат справа)', onclick: () => { close(); AgentPanel.toggle(true); AgentPanel.say(`🔁 Замени звук «${c.label.replace(/^🎬 /, '')}» на ${c.t0.toFixed(2)} с (${c.scene ? 'звук сцены ' + c.scene.n : 'дорожка «' + ((this.tracks(Montage.M(d)).find(t => t.id === c.track) || {}).name || c.track) + '»'}, id ${c.it.id}) на более подходящий: ${q.value}. Предложи 3 варианта из библиотеки или YouTube, поставь лучший, остальные назови.`, { mode: 'montage', model: 'sonnet' }); } }, '✨ Спросить Claude')),
      list);
    const close = UI.modal('🔁 Заменить похожим — ' + c.label, body, { wide: false, onClose: () => MTA.stop() });
    const mod = body.closest('.modal'); if (mod) mod.classList.add('snd-modal');
    try { const r = await api('GET', `/api/audio/similar?video=${encodeURIComponent(d.id)}&src=${encodeURIComponent(c.it.raw || c.it.src)}&q=${encodeURIComponent(q.value)}`); draw(r.items); } catch (e) { draw([]); }
  },
  async fetchNow(d, x) {
    UI.toast('⬇ качаю ' + x.name + '…');
    try {
      const { id } = await api('POST', '/api/audio/fetch', { video: d.id, url: x.url, title: x.name });
      for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 1500)); const st = await api('GET', '/api/audio/fetchstate?id=' + id); if (st.status === 'done') return st.item; if (st.status === 'error') throw new Error(st.error); }
    } catch (e) { UI.toast('⬇ ' + e.message, 'err'); }
    return null;
  },
};

// мультивыделение звуков (TLSel, montage.js): Delete — удалить, групповой сдвиг и громкость — MSnd.down, рамка — MSnd.marquee
TLSel.ADAPT.clips = {
  sel: '.mt-clip', many: 'звуков', one: 'звука',
  bar: n => `Выделено звуков: ${n} · тяните — вместе (и на другую дорожку) · линия уровня — громкость всем · S — разрезать · Ctrl C / V / D · Delete · Esc`,
  items(d) { return MSnd.items(d, Montage.M(d)).map(c => ({ id: c.key, a: c.t0, b: c.t0 + c.dur })); },
  apply() {},
  del(ids) { MSnd.remove(MT.d, ids); },
  onSel() { if (typeof Workspace !== 'undefined' && App.route.page === 'v') { const P = $('.ws-tl .mt-props'); if (P && MT.d) keepScroll(P, () => P.replaceChildren(...[Workspace.props(MT.d, Montage.M(MT.d))].flat().filter(x => x instanceof Node))); } },
};

// клавиши звуков (окно видео, выделены звуки): S / C — разрезать, Ctrl C / V / D, Alt + ← → — сдвиг на кадр (Shift — 0,5 с), Alt + ↑ ↓ — ±1 dB, [ ] — фейды ±0,1 с
addEventListener('keydown', e => {
  if (typeof App === 'undefined' || App.route.page !== 'v' || !MT.d) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) || document.querySelector('.modal, .nv, .pal, .stage-editor, .pv-card')) return;
  const d = MT.d, on = TLSel.kind === 'clips', ctrl = e.ctrlKey || e.metaKey, overSnd = !!document.querySelector('.mt-lane.snd:hover, .mt-row[data-track]:hover');
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (!ctrl && !e.altKey && (e.code === 'KeyS' || e.code === 'KeyC') && (on || overSnd)) { stop(); return MSnd.split(d); }
  if (ctrl && !e.altKey && e.code === 'KeyC' && on) { stop(); return MSnd.copy(d); }
  if (ctrl && !e.altKey && e.code === 'KeyV' && MSnd.clipboard && (on || overSnd)) { stop(); return MSnd.paste(d); }
  if (ctrl && !e.altKey && e.code === 'KeyD' && on) { stop(); return MSnd.dup(d); }
  if (ctrl && e.code === 'KeyA' && overSnd) { stop(); return TLSel.set('clips', MSnd.items(d, Montage.M(d)).map(c => c.key)); }
  if (!on) return;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { stop(); const k = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.5 : 1 / 30); return MSnd.nudge(d, c => ({ at: +Math.max(0, c.at + k).toFixed(3) })); }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { stop(); const k = e.key === 'ArrowUp' ? 1 : -1; return MSnd.nudge(d, c => ({ gain: +MSnd.gain(MSnd.db(c.it.gain == null ? 1 : +c.it.gain) + k).toFixed(4) })); }
  if (!ctrl && !e.altKey && (e.key === '[' || e.key === ']' || e.key === 'х' || e.key === 'ъ')) {
    stop(); const k = e.shiftKey ? -0.1 : 0.1, f = e.key === '[' || e.key === 'х' ? 'fadeIn' : 'fadeOut';
    return MSnd.nudge(d, c => ({ [f]: +Math.max(0, (+c.clip[f] || 0) + k).toFixed(2) }));
  }
}, true);
window.MSnd = MSnd;
