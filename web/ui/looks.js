// Claude Studio — S14 «Визуалы»: техники → луки (docs/studio/stage14-looks.md §3.2–3.3).
// Данные — channel.json: techniques[], looks[] (server/looks_api.py — схема, переезд, window.LOOK, бриф).
// Живое превью — стенд в iframe ВНЕ разметки страницы (App.render пересобирает DOM, а перенос iframe его перезагружает):
// iframe живёт в body и встаёт поверх слота .lk-live-slot после каждой отрисовки; ручки шлют ему postMessage({look}).
'use strict';

const LKS = { tech: null, look: null, filter: 'all', usage: {}, lib: null, heroMenu: false, heroForm: null, prevT: {}, frame: null, frameSig: '', paused: false };

const Looks = {
  // документ канала (на страницах видео он может быть ещё не загружен — грузим и перерисовываем)
  chan(C) {
    const k = 'channel:' + C.id, d = Store.get(k);
    if (!d && C.id && !LKS['ld' + k]) { LKS['ld' + k] = true; Store.load(k).then(() => App.render()).catch(() => {}); }
    return d;
  },
  // ---------------- данные
  techs(d) { return d.techniques || []; },
  tech(d, key) { return this.techs(d).find(t => t.key === key) || {}; },
  controls(d, lk) {
    const m = new Map();
    for (const c of this.tech(d, lk.tech).controls || []) m.set(c.key, c);
    for (const c of lk.extra || []) m.set(c.key, Object.assign({}, c, { own: true }));
    return [...m.values()];
  },
  values(d, lk, over) {
    const v = {};
    for (const c of this.controls(d, lk)) if (c.default !== undefined) v[c.key] = c.default;
    return Object.assign(v, lk.params || {}, over || {});
  },
  nest(params) {
    const out = {};
    for (const k of Object.keys(params).sort()) {
      const parts = k.split('.'); let cur = out;
      for (const p of parts.slice(0, -1)) { if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[parts.length - 1]] = params[k];
    }
    return out;
  },
  heroImg(C, hr) {
    const m = /^lib:([a-z]+)\/([a-z0-9-]+)@(\d+)$/.exec(hr.ref || '');
    return m ? `/api/lib/file/${C.id}/${m[1]}/${m[2]}/v${m[3]}/preview.png` : (hr.img || '');
  },
  obj(C, d, lk, params) {
    const L = this.nest(params || this.values(d, lk));
    Object.assign(L, { key: lk.key, tech: lk.tech, engine: this.tech(d, lk.tech).engine || lk.engine || '2d', label: lk.label,
      palette: ((lk.palette || {}).colors || []).map(c => c.hex).filter(Boolean),
      heroes: (lk.heroes || []).map(hr => ({ kind: hr.kind, ref: hr.ref, name: hr.name, role: hr.role, img: hr.kind === 'lib' ? this.heroImg(C, hr) : '' })) });
    return L;
  },
  modified(lk) {
    const F = lk.factory; if (!F) return false;
    const a = F.params || {}, b = lk.params || {};
    return (F.desc || '') !== (lk.desc || '') || Object.keys({ ...a, ...b }).some(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  },
  changedKeys(lk) {
    const a = (lk.factory || {}).params; if (!a) return new Set();
    const b = lk.params || {};
    return new Set(Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])));
  },
  file(C, f, ts) { return f ? `/api/channel/file?channel=${C.id}&f=${encodeURIComponent(f)}${ts ? '&v=' + ts : ''}` : ''; },
  sceneUrl(d, lk) {
    const t = this.tech(d, lk.tech), eng = t.engine || lk.engine || '2d';
    const custom = lk.scene || t.scene;
    const scene = custom ? `/chfile/${(App.info.channel || {}).id}/${custom}` : `/render/looks/${t.key === 'diorama' || eng === '3d' ? 'diorama' : 'paper'}.js`;
    return (eng === '3d' ? '/tpl/stand3d.html' : '/render/page.html') + '?scene=' + encodeURIComponent(scene) + '&parts=element';
  },

  // ---------------- живое превью (iframe поверх слота)
  frameFor(C, d, lk) {
    const L = this.obj(C, d, lk);
    const sig = JSON.stringify([lk.id, lk.tech, lk.scene, this.tech(d, lk.tech).scene, L.heroes, L.palette, lk.label, (lk.build || {}).ts]);
    if (!LKS.frame) {
      LKS.frame = h('iframe.lk-frame', { title: 'Превью визуала', loading: 'eager' });
      document.body.append(LKS.frame);
      const re = () => Looks.place();
      window.addEventListener('resize', re); document.addEventListener('scroll', re, true);
      setInterval(re, 400);
    }
    if (LKS.frameSig !== sig) {
      LKS.frameSig = sig; LKS.paused = false;
      LKS.frame.src = this.sceneUrl(d, lk) + '&play=1&lookj=' + encodeURIComponent(JSON.stringify(L));
    }
  },
  place() {
    const f = LKS.frame; if (!f) return;
    const slot = document.querySelector('.lk-live-slot');
    if (!slot || !slot.isConnected) { f.style.display = 'none'; return; }
    const r = slot.getBoundingClientRect(), box = (slot.closest('main') || document.documentElement).getBoundingClientRect();
    const t = Math.max(0, box.top - r.top), b = Math.max(0, r.bottom - box.bottom);   // прокрутка: iframe не вылезает за область страницы
    Object.assign(f.style, { display: t + b >= r.height ? 'none' : 'block', left: r.left + scrollX + 'px', top: r.top + scrollY + 'px', width: r.width + 'px', height: r.height + 'px',
      clipPath: `inset(${t}px 0 ${b}px 0 round 10px)` });
  },
  send(msg) { try { LKS.frame && LKS.frame.contentWindow.postMessage(msg, '*'); } catch (e) {} },
  live(C, d, lk, params) { this.send({ look: this.obj(C, d, lk, params) }); },

  // ---------------- mp4 для плиток: пересъёмка в фоне через ~2.5 с после правок
  schedulePreview(C, lk) {
    clearTimeout(LKS.prevT[lk.id]);
    LKS.prevT[lk.id] = setTimeout(async () => {
      await Store.flushAll();
      try { const r = await api('POST', '/api/looks/preview', { channel: C.id, look: lk.id }); if (r.job) Claude.jobs[r.job.id] = r.job; } catch (e) { /* уже снимается или без изменений */ }
    }, 2500);
  },
  set(C, ckey, lk, path, v, rerender = true) {
    Store.set(ckey, ['looks', lk.id, ...path], v, rerender);
    this.schedulePreview(C, lk);
  },
};

// ---------------- выбор лука плитками по техникам (поп-ап «Новое видео», бриф видео): наведение — превью играет
Looks.picker = function (value, onPick) {
  const C = App.info.channel || {}, d = Looks.chan(C);
  if (!d || !d.techniques) return null;                  // канал не загружен / ещё не переехал на техники — старый выпадающий список
  return h('div.lk-pick', Looks.techs(d).map(t => {
    const L = (d.looks || []).filter(x => x.tech === t.key && !x.draft);
    return L.length > 0 && h('div.lk-pickg', h('div.lk-pickt', (t.icon || '') + ' ' + t.label),
      h('div.lk-pickrow', L.map(lk => {
        // превью не грузятся заранее (поп-ап тормозил): палитра, а картинка и видео — только при наведении
        const P = lk.preview || {}, poster = Looks.file(C, P.poster, P.ts), video = Looks.file(C, P.video, P.ts);
        const pv = h('div.lk-pv', h('div.lk-pal', ((lk.palette || {}).colors || []).slice(0, 5).map(c => h('span', { style: { background: c.hex } }))));
        let vid = null;
        const show = () => {
          if (!pv.dataset.on) {
            pv.dataset.on = '1';
            if (poster) pv.append(h('img', { src: poster, alt: '' }));
            if (video) pv.append(vid = h('video', { src: video, muted: true, loop: true, playsinline: true, preload: 'auto' }));
          }
          if (vid) vid.play().catch(() => {});
        };
        return h('button.lk-pk', { class: lk.key === value ? 'sel' : '', title: lk.desc || '', onclick: e => { e.preventDefault(); onPick(lk.key); },
          onmouseenter: show, onmouseleave: () => { if (vid) { vid.pause(); vid.currentTime = 0; } } },
          pv,
          h('span.lk-pkn', lk.label), (lk.heroes || []).length > 0 && h('span.lk-pkh', '🦸 ' + lk.heroes.map(x => x.name).join(', ')));
      })));
  }));
};

// ---------------- ручки
// put(key, value) — куда писать (лук или перекрытия видео); live(params) — живое превью (или ничего)
Looks.ctl = function (c, vals, changed, put, live) {
  const v = vals[c.key], dis = c.dep && !vals[c.dep];
  const preview = x => live && live(Object.assign({}, vals, { [c.key]: x }));
  let el;
  if (c.type === 'toggle') el = h('button.lk-tg', { class: v ? 'on' : '', role: 'switch', 'aria-checked': v ? 'true' : 'false', title: v ? 'вкл' : 'выкл', onclick: () => { preview(!v); put(c.key, !v); } });
  else if (c.type === 'select') el = msel((c.options || []).map(o => Array.isArray(o) ? o : [o, o]), v ?? '', x => { preview(x); put(c.key, x); });
  else if (c.type === 'color') el = h('input.lk-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(v || '') ? v : '#888888', oninput: e => preview(e.target.value), onchange: e => put(c.key, e.target.value) });
  else {
    const out = h('span.lk-v', fmtV(v, c));
    el = h('span.lk-range', h('input', { type: 'range', min: c.min ?? 0, max: c.max ?? 1, step: c.step ?? 0.01, value: v ?? 0, disabled: dis,
      oninput: e => { out.textContent = fmtV(+e.target.value, c); preview(+e.target.value); }, onchange: e => put(c.key, +e.target.value) }), out);
  }
  return h('div.lk-ctl', { class: dis ? 'dim' : '' },
    h('div.lk-ct', h('b', c.label || c.key, changed.has(c.key) && h('span.lk-dot', { title: 'изменено' }), c.own && h('span.lk-own', { title: 'ручку придумал Claude под этот лук' }, 'своя')),
      c.hint && h('div', c.hint)), el);
};
function fmtV(v, c) { if (v == null || v === '') return '—'; const s = +(c.step || 0.01); return (+v).toFixed(s >= 1 ? 0 : s >= 0.1 ? 1 : s >= 0.01 ? 2 : s >= 0.001 ? 3 : 4); }

Object.assign(Pages, {
  chLooks(C, d, ckey) {
    if (!d.techniques) {
      if (!LKS.migrating) { LKS.migrating = true; api('POST', '/api/looks/migrate', { channel: C.id }).then(() => Store.load(ckey, true)).then(() => App.render()).catch(e => UI.toast(e.message, 'err')).finally(() => { LKS.migrating = false; }); }
      return h('p.dim', h('span.spin'), ' переношу визуалы в техники и луки…');
    }
    const T = Looks.techs(d), all = d.looks || [];
    const show = lk => LKS.filter === 'all' || (LKS.filter === 'builtin' ? lk.builtin : !lk.builtin);
    if (!T.find(t => t.key === LKS.tech)) LKS.tech = (T[0] || {}).key;
    let lks = all.filter(lk => lk.tech === LKS.tech && show(lk));
    const drafts = all.filter(lk => lk.draft);
    let lk = all.find(x => x.id === LKS.look && (x.draft || (x.tech === LKS.tech && show(x)))) || lks[0];
    if (lk) LKS.look = lk.id;
    const t = Looks.tech(d, LKS.tech);
    const newLook = async () => {
      const id = uid('l'); LKS.look = id;                 // до Store.add: он сразу перерисовывает
      Store.add(ckey, ['looks'], { id, key: 'l' + Date.now().toString(36), tech: '', engine: '', label: 'Новый визуал', desc: '', builtin: false, factory: null, draft: true,
        params: {}, extra: [], scene: null, palette: { colors: [] }, heroes: [], refs: [], interview: { qa: [], done: false }, preview: {}, build: {} });
    };
    return [
      h('div.lk-head', h('h2', 'Визуалы'), h('span.sp'),
        h('div.seg', [['all', 'Все'], ['builtin', 'Встроенные'], ['own', 'Свои']].map(([k, l]) => h('button', { class: LKS.filter === k ? 'sel' : '', onclick: () => { LKS.filter = k; App.render(); } }, l))),
        h('button.primary', { onclick: newLook, title: 'Референсы → короткое интервью → ✨ Claude собирает технику или лук с ручками и примером сцены' }, '+ Новый визуал')),
      h('p.dim.lk-sub', 'Как выглядит ролик. Техника — чем рисуется кадр; лук — её настройки, палитра и герои. Ручки лука применяются к ролику при сборке (window.LOOK); в брифе видео их можно подкрутить только для него.'),
      drafts.length > 0 && h('div.lk-drafts', h('span.dim.small', 'Собираются:'), drafts.map(x => h('button', { class: x.id === LKS.look ? 'sel' : '', onclick: () => { LKS.look = x.id; App.render(); } }, '✨ ' + (x.label || 'новый визуал')))),
      h('div.lk-techs', T.map(x => {
        const n = all.filter(l => l.tech === x.key && !l.draft).length;
        return h('div.lk-tech', { class: x.key === LKS.tech && !(lk && lk.draft) ? 'sel' : '', onclick: () => { LKS.tech = x.key; LKS.look = null; App.render(); } },
          h('div.row', h('span.lk-ic', x.icon || '🎨'), h('b', x.label), h('span.sp'), h('span.dim.small', `${n} ${plural(n, 'лук', 'лука', 'луков')}`)),
          h('div.dim.small.lk-tdesc', (x.desc || '').split('. ')[0]),
          h('div.lk-badges', h('span.lk-tag', x.engine === '3d' ? '3D' : '2D'), !x.builtin && h('span.lk-tag.own', 'своя')));
      })),
      lk && lk.draft ? Pages.lkWizard(C, d, ckey, lk) : [
        t.key && h('div.lk-tdesc-full', area(ckey, ['techniques', t.id, 'desc'], { cls: 'box', ph: 'что за техника: движок, где сильна' })),
        h('div.lk-label', 'Луки в технике'),
        h('div.lk-looks',
          h('div.lk-tiles', lks.map(x => Pages.lkTile(C, d, x, x.id === LKS.look)),
            h('button.lk-addlook', { onclick: () => { const id = uid('l'), base = lk || {}; LKS.look = id; Store.add(ckey, ['looks'], { id, key: 'l' + Date.now().toString(36), tech: LKS.tech, engine: t.engine, label: 'Новый лук', desc: base.desc || '', builtin: false, factory: null,
              params: Object.assign({}, base.params || {}), extra: [], scene: null, palette: JSON.parse(JSON.stringify(base.palette || { colors: [] })), heroes: JSON.parse(JSON.stringify(base.heroes || [])), refs: [], interview: { qa: [], done: false }, preview: {}, build: {} }); } }, '+ лук в технике')),
          lk ? Pages.lkPanel(C, d, ckey, lk) : Pages.lkEmpty(C, d, ckey, t)),
      ],
    ];
  },

  // пустая техника: ✨ визуал из интервью канала, «+ Новый визуал» по референсам, или взять готовый лук из каталога
  lkEmpty(C, d, ckey, t) {
    if (!LKS.cat && !LKS.catLoading) { LKS.catLoading = true; api('GET', `/api/looks/catalog?channel=${C.id}`).then(r => { LKS.cat = r.items || []; App.render(); }).catch(() => {}).finally(() => { LKS.catLoading = false; }); }
    const cat = (LKS.cat || []).filter(x => x.tech === t.key);
    const reload = async () => { LKS.cat = null; await Store.load(ckey, true); App.render(); };
    const I = d.interview || {}, hasVis = (I.qa || []).some(q => (q.block || 'visual') === 'visual' && (q.a || '').trim());
    const busy = Object.values(Claude.jobs).some(j => j.key === ckey && j.kind === 'lookbuild' && ['queued', 'running'].includes(j.status));
    return h('div.lk-panel.lk-empty',
      h('h3', 'Своих луков в этой технике нет'),
      h('p.dim', 'Визуал канала собирается из его интервью и референсов — или по новым референсам («+ Новый визуал»). Готовые луки ниже — шаблоны других каналов, бери только если подходят.'),
      h('div.row', busy ? h('span.dim', h('span.spin'), ' Claude собирает визуал канала…')
          : h('button.claude', { disabled: !Claude.on || !hasVis, title: hasVis ? 'Ответы блока «Визуал и герой» и референсы интервью → ✨ сборка лука (Opus)' : 'сначала ответь в интервью на блок «Визуал и герой»',
            onclick: async () => { try { const r = await api('POST', '/api/looks/from-interview', { channel: C.id }); if (r.job) Claude.jobs[r.job.id] = r.job; LKS.look = r.look; await reload(); } catch (e) { UI.toast(e.message, 'err'); } } }, '✨ Собрать визуал из интервью канала'),
        !hasVis && h('a', { href: '#/style/interview' }, 'к интервью')),
      cat.length > 0 && h('div', h('div.lk-label', 'Готовые луки (шаблоны)'),
        h('div.lk-catrow', cat.map(x => h('div.lk-cat', h('b', x.label), h('div.dim.small', x.desc),
          h('button.small', { onclick: async () => { try { const r = await api('POST', '/api/looks/take', { channel: C.id, key: x.key }); LKS.look = r.look; await reload(); } catch (e) { UI.toast(e.message, 'err'); } } }, '+ взять в канал'))))));
  },

  lkTile(C, d, lk, sel) {
    const P = lk.preview || {}, poster = Looks.file(C, P.poster, P.ts), video = Looks.file(C, P.video, P.ts);
    const busy = ['queued', 'running'].includes(P.status) || Object.values(Claude.jobs).some(j => j.scope === 'lookprev:' + lk.id && ['queued', 'running'].includes(j.status));
    const cols = ((lk.palette || {}).colors || []).map(c => c.hex).slice(0, 6);
    const vid = video && h('video', { src: video, muted: true, loop: true, playsinline: true, preload: 'none' });
    const n = (LKS.usage[lk.key] || []).length;
    return h('div.lk-tile', { class: sel ? 'sel' : '', onclick: () => { LKS.look = lk.id; App.render(); },
      onmouseenter: () => { if (vid) { vid.muted = true; vid.play().catch(() => {}); } }, onmouseleave: () => { if (vid) { vid.pause(); vid.currentTime = 0; } } },
      h('div.lk-pv', poster ? h('img', { src: poster, alt: '' }) : h('div.lk-pal', cols.map(c => h('span', { style: { background: c } }))), vid,
        !poster && h('span.lk-pvnote', busy ? 'снимаю превью…' : P.error ? '⚠ превью не снялось' : 'превью появится после первой правки'),
        poster && video && h('span.lk-play', '▶ наведи'), busy && h('span.lk-busy')),
      h('div.lk-nm', h('b', lk.label || 'лук'), lk.builtin && h('span.lk-tag', 'встроенный'), Looks.modified(lk) && h('span.lk-tag.mod', 'изменён')),
      h('div.lk-ds', lk.desc || ''),
      h('div.lk-meta', (lk.heroes || []).length ? '🦸 ' + lk.heroes.map(x => x.name).join(', ') : 'без героя', n ? ` · ${n} ${plural(n, 'видео', 'видео', 'видео')}` : ''));
  },

  lkPanel(C, d, ckey, lk) {
    if (!LKS.usage[lk.key] && !LKS['u' + lk.key]) { LKS['u' + lk.key] = true; api('GET', `/api/looks/usage?channel=${C.id}&look=${encodeURIComponent(lk.key)}`).then(r => { LKS.usage[lk.key] = r.items || []; App.render(); }).catch(() => {}); }
    const used = LKS.usage[lk.key] || [];
    const vals = Looks.values(d, lk), ctls = Looks.controls(d, lk), changed = Looks.changedKeys(lk);
    const groups = [...new Set(ctls.map(c => c.group || 'Настройки'))];
    Looks.frameFor(C, d, lk); requestAnimationFrame(() => Looks.place());
    const reset = async () => { if (!confirm(`Вернуть «${lk.label}» к заводским настройкам?`)) return; try { await Store.flushAll(); await api('POST', '/api/looks/reset', { channel: C.id, look: lk.id }); await Store.load(ckey, true); App.render(); Looks.schedulePreview(C, lk); } catch (e) { UI.toast(e.message, 'err'); } };
    const dup = () => { const id = uid('l'); LKS.look = id; Store.add(ckey, ['looks'], Object.assign(JSON.parse(JSON.stringify(lk)), { id, key: 'l' + Date.now().toString(36), label: lk.label + ' (копия)', builtin: false, factory: null, preview: {} })); };
    const del = () => { if (!confirm(used.length ? `«${lk.label}» стоит в ${used.length} видео — у них визуал пропадёт из брифа. Удалить?` : `Удалить «${lk.label}»?`)) return; LKS.look = null; Store.del(ckey, ['looks'], lk.id); };
    const pal = JSON.parse(JSON.stringify((lk.palette || {}).colors || []));
    const savePal = () => Looks.set(C, ckey, lk, ['palette', 'colors'], pal);
    const job = Object.values(Claude.jobs).find(j => j.scope === 'lookprev:' + lk.id && ['queued', 'running'].includes(j.status));
    return h('div.lk-panel',
      h('div.lk-ph', line(ckey, ['looks', lk.id, 'label'], { cls: 'box lk-title', ph: 'название лука' }),
        lk.builtin && h('span.lk-tag', 'встроенный'), Looks.modified(lk) && h('span.lk-tag.mod', 'изменён'), h('span.sp'),
        h('span.dim.small', { title: used.map(v => v.name).join('\n') }, used.length ? `${used.length} ${plural(used.length, 'видео', 'видео', 'видео')}` : 'не в видео'),
        lk.factory && Looks.modified(lk) && h('button', { onclick: reset, title: 'Ручки, название и описание — как в заводском луке' }, '↺ к заводским'),
        h('button', { onclick: dup }, '⧉ Дублировать'), h('button.icon.del', { title: 'Удалить лук', onclick: del }, Icon('trash', 14))),
      h('div.dim.small', 'Описание — уходит Claude в бриф'),
      area(ckey, ['looks', lk.id, 'desc'], { cls: 'box lk-desc', ph: 'материалы, свет, цвет, камера, чем этот лук отличается от соседних', onInput: () => Looks.schedulePreview(C, lk) }),
      (lk.build || {}).why && h('p.dim.small', '✨ Claude: ' + lk.build.why),
      h('div.lk-live',
        h('div', h('div.lk-live-slot'),
          h('div.lk-bar', h('button.small', { onclick: () => { LKS.paused = !LKS.paused; Looks.send({ pause: LKS.paused }); App.render(); } }, LKS.paused ? '▶' : '⏸'),
            h('span.dim.small', job ? '⏳ снимаю mp4 для плитки…' : 'живое превью · mp4 для плиток снимется сам'))),
        h('div.lk-grid', groups.map(g => [h('div.lk-grp', g), ...ctls.filter(c => (c.group || 'Настройки') === g).map(c => Looks.ctl(c, vals, changed, (k, x) => Looks.set(C, ckey, lk, ['params', k], x), p => Looks.live(C, d, lk, p)))]))),
      Pages.lkHeroes(C, d, ckey, lk),
      h('section.lk-sec', h('div.row', h('h3', 'Палитра лука'), h('span.dim.small', 'цвета демо-сцены и подсказка Claude при рисовании'), h('span.sp'),
          h('button.small', { onclick: () => { pal.push({ name: 'цвет', hex: '#888888', use: '' }); savePal(); } }, '+ цвет')),
        pal.length ? h('div.palette', pal.map((c, i) => h('div.swatch',
          h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#888888', onchange: e => { c.hex = e.target.value; savePal(); } }),
          h('input.box', { value: c.name, oninput: e => { c.name = e.target.value; }, onchange: savePal }),
          h('input.box.small', { value: c.use || '', placeholder: 'где', oninput: e => { c.use = e.target.value; }, onchange: savePal }),
          h('button.icon.del', { onclick: () => { pal.splice(i, 1); savePal(); } }, '×')))) : h('div.empty', 'Палитры нет — демо-сцена берёт цвета по умолчанию.')),
      h('section.lk-sec', h('div.row', h('h3', 'Референсы лука'), h('span.dim.small', 'картинки и видео — уходят Claude в бриф вместе с описанием')),
        Styles.refGrid(C, ckey, ['looks', lk.id, 'refs'], lk.refs || [])));
  },

  // ---------------- 🦸 герои лука
  lkHeroes(C, d, ckey, lk) {
    const H = lk.heroes || [];
    if (LKS.heroMenu && !LKS.lib) { LKS.lib = []; api('GET', `/api/lib?channel=${C.id}&kind=characters`).then(r => { LKS.lib = r.items || []; App.render(); }).catch(() => {}); }
    const add = hr => { Looks.set(C, ckey, lk, ['heroes'], [...H, Object.assign({ id: uid('h'), role: H.length ? '' : 'main' }, hr)]); LKS.heroMenu = false; LKS.heroForm = null; };
    const star = id => Looks.set(C, ckey, lk, ['heroes'], H.map(x => Object.assign({}, x, { role: x.id === id ? 'main' : '' })));
    const rm = id => { const rest = H.filter(x => x.id !== id); if (rest.length && !rest.some(x => x.role === 'main')) rest[0] = Object.assign({}, rest[0], { role: 'main' }); Looks.set(C, ckey, lk, ['heroes'], rest); };
    const make = async hr => { try { await Store.flushAll(); const r = await api('POST', '/api/looks/hero', { channel: C.id, look: lk.id, hero: hr.id }); Claude.jobs[r.job.id] = r.job; UI.toast('Готовлю видео героя…');
      const wait = async () => { const s = await api('GET', '/api/job?id=' + r.job.id).catch(() => null); const j = s && (s.job || s);
        if (j && ['running', 'queued'].includes(j.status)) return setTimeout(wait, 1000);
        if (j && j.status === 'done') { await App.refreshState(); go(`#/v/${j.result.video}/pre`); } else UI.toast((j && j.error) || 'не вышло', 'err'); };
      wait(); } catch (e) { UI.toast(e.message, 'err'); } };
    const F = LKS.heroForm;
    return h('section.lk-sec',
      h('div.row', h('h3', 'Герои'), h('span.dim.small', 'встают в демо-сцену и уходят Claude в бриф; ★ — главный'), h('span.sp'),
        h('div.lk-menuwrap', h('button.small', { onclick: () => { LKS.heroMenu = !LKS.heroMenu; App.render(); } }, '+ из библиотеки'),
          LKS.heroMenu && h('div.lk-menu',
            !(LKS.lib || []).some(it => it.hog) && h('button', { onclick: () => add({ kind: 'hog', name: 'Бумажный ёжик', desc: 'серый, из рваных полосок, тёмная маска, большие глаза (drawHog / hogCard тулкита)' }) }, h('span.lk-av', '🦔'), 'Бумажный ёжик (тулкит)'),
            (LKS.lib || []).map(it => h('button', { onclick: () => add({ kind: it.hog ? 'hog' : 'lib', ref: `lib:${it.id}@${it.latest || 1}`, name: it.name }) },   // hog — рисуется тулкитом (drawHog / hogCard)
              it.preview ? h('img.lk-av', { src: `/api/lib/file/${C.id}/${it.preview}` }) : h('span.lk-av', '🧍'), it.name)),
            LKS.lib && !LKS.lib.length && h('div.dim.small', 'В библиотеке канала нет персонажей.'))),
        h('button.small', { onclick: () => { LKS.heroForm = LKS.heroForm ? null : { name: '', desc: '', character: '' }; App.render(); } }, '+ описать нового')),
      H.length ? h('div.lk-heroes', H.map(hr => h('div.lk-hero',
        hr.ref ? h('img.lk-av', { src: Looks.heroImg(C, hr) }) : h('span.lk-av', hr.kind === 'hog' ? '🦔' : '✏️'),
        h('div', h('b', hr.name || 'герой'), h('div.dim.small', hr.ref ? hr.ref.replace(/^lib:characters\//, '') : hr.kind === 'hog' ? 'тулкит' : (hr.video ? 'описание · есть видео героя' : 'описание'))),
        h('button.icon', { class: hr.role === 'main' ? 'lk-star on' : 'lk-star', title: hr.role === 'main' ? 'главный' : 'сделать главным', onclick: () => star(hr.id) }, '★'),
        hr.kind === 'desc' && h('button.small', { onclick: () => make(hr), title: 'Служебное видео с персонажем по описанию: «🎨 нарисовать» → ✓ → «📚 в библиотеку», потом выбери его здесь из библиотеки' }, '🦸 Сделать'),
        h('button.icon.del', { title: 'Убрать из лука', onclick: () => rm(hr.id) }, '×'))))
        : h('div.empty', 'Без героя: персонажи — по сюжету ролика.'),
      F && h('div.lk-heroform',
        h('input.box', { placeholder: 'Имя', value: F.name, oninput: e => { F.name = e.target.value; } }),
        h('textarea.box', { placeholder: 'Как выглядит (для художника): силуэт, цвета, детали', rows: 2, oninput: e => { F.desc = e.target.value; } }, F.desc),
        h('input.box', { placeholder: 'Характер (коротко)', value: F.character, oninput: e => { F.character = e.target.value; } }),
        h('div.row', h('button.primary', { onclick: () => F.name.trim() ? add({ kind: 'desc', name: F.name.trim(), desc: F.desc.trim(), character: F.character.trim() }) : UI.toast('Нужно имя', 'err') }, 'Добавить'),
          h('button', { onclick: () => { LKS.heroForm = null; App.render(); } }, 'Отмена'))));
  },

  // ---------------- + Новый визуал: референсы → интервью → ✨ собрать (§3.3)
  lkWizard(C, d, ckey, lk) {
    const I = lk.interview || {}, qa = I.qa || [], refs = lk.refs || [];
    const qBusy = Claude.running(ckey, 'lookq:' + lk.id), bBusy = Claude.running(ckey, 'lookbuild:' + lk.id);
    const step = !refs.length ? 1 : (bBusy ? 3 : qa.length ? 2 : 1);
    const job = (path, params = {}) => async () => { try { await Store.flushAll(); const r = await api('POST', path, { channel: C.id, look: lk.id, ...params }); Claude.jobs[r.job.id] = r.job; App.render(); } catch (e) { UI.toast(e.message, 'err'); } };
    const addRef = r => Store.add(ckey, ['looks', lk.id, 'refs'], Object.assign({ id: uid('r'), note: '' }, r), true);
    const search = () => ImgSearch.open('', { multi: true, fetch: async it => (await api('POST', '/api/looks/refurl', { channel: C.id, url: it.full, fallback: it.thumb })).f,
      onPath: f => addRef({ img: f, from: 'search' }) });
    const answered = qa.filter(q => (q.a || '').trim() || (q.refs || []).length || q.skip).length;
    const qRow = q => h('div.lk-qa', { class: (q.a || '').trim() ? 'ok' : '' },
      h('div.row', h('b.grow', q.q), h('button.icon.del', { title: 'Убрать вопрос', onclick: () => Store.del(ckey, ['looks', lk.id, 'interview', 'qa'], q.id) }, '×')),
      q.why && h('div.dim.small', 'зачем: ' + q.why),
      area(ckey, ['looks', lk.id, 'interview', 'qa', q.id, 'a'], { cls: 'box', ph: 'ответ своими словами' }),
      Pages.lkMiniRefs(C, ckey, ['looks', lk.id, 'interview', 'qa', q.id, 'refs'], q.refs || []));
    return h('div.lk-wiz',
      h('div.lk-ph', line(ckey, ['looks', lk.id, 'label'], { cls: 'box lk-title', ph: 'рабочее название (Claude предложит своё)' }), h('span.sp'),
        h('button.icon.del', { title: 'Выбросить черновик', onclick: () => { if (confirm('Выбросить черновик визуала?')) { Store.del(ckey, ['looks'], lk.id); LKS.look = null; } } }, Icon('trash', 14))),
      h('div.lk-steps', ['Референсы', 'Интервью', '✨ Собрать'].map((s, i) => h('span', { class: step === i + 1 ? 'sel' : step > i + 1 ? 'done' : '' }, `${i + 1} · ${s}`))),
      h('section.lk-sec', h('div.row', h('h3', '1 · Референсы'), h('span.dim.small', 'картинки (Ctrl+V, перетащить, файл), видео со ссылкой и куском «с–по», поиск картинок'), h('span.sp'),
          h('button.small', { onclick: search }, '🔎 Найти картинки')),
        Styles.refGrid(C, ckey, ['looks', lk.id, 'refs'], refs, { range: true })),
      h('section.lk-sec', h('div.row', h('h3', '2 · Интервью'), h('span.counter', { class: qa.length && answered === qa.length ? 'ok' : '' }, `отвечено ${answered} из ${qa.length}`), h('span.sp'),
          qBusy ? h('span.dim', h('span.spin'), ' Claude смотрит референсы и придумывает вопросы…')
            : h('button.claude', { disabled: !Claude.on || !refs.length, onclick: job('/api/looks/questions', { n: qa.length ? 4 : 7 }), title: refs.length ? '' : 'сначала референсы' }, qa.length ? '✨ Ещё вопросы' : '✨ Вопросы по референсам')),
        !qa.length && h('div.empty', 'Claude посмотрит полку (кадры видео — только из куска «с–по») и спросит 5–8 вещей про этот вид: контур, свет, материал, 2D или объём, нужен ли герой.'),
        qa.map(qRow),
        addLine('+ свой вопрос — Enter', x => Store.add(ckey, ['looks', lk.id, 'interview', 'qa'], { id: uid('q'), q: x, a: '', why: '', refs: [], by: 'me' }), ckey + '|lkq' + lk.id)),
      h('section.lk-sec', h('div.row', h('h3', '3 · ✨ Собрать визуал'), h('span.sp'),
          bBusy ? h('span.dim', h('span.spin'), ' Claude (Opus) собирает: техника, ручки, пример сцены, кадры — 3–8 минут…')
            : h('button.claude', { disabled: !Claude.on || !refs.length, onclick: job('/api/looks/build') }, '✨ Собрать визуал')),
        h('p.dim.small', 'Claude решит сам: новый лук в одной из техник или новая техника (и объяснит почему); выставит ручки, придумает свои, напишет пример сцены под них, палитру и героев, снимет кадры и проверит. Потом крутишь руками.'),
        (lk.build || {}).error && h('div.badline', '⚠ ' + lk.build.error)));
  },
  // вложения к ответу интервью: картинка (файл / Ctrl+V), ссылка на видео с куском
  lkMiniRefs(C, ckey, path, refs) {
    const pick = () => { const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: async () => {
      for (const f of inp.files) { try { const p = await Styles.upImg(C.id, f); Store.add(ckey, path, { id: uid('r'), img: p, note: '' }, true); } catch (e) { UI.toast(e.message, 'err'); } } } }); inp.click(); };
    const k = ckey + '|' + path.join('.') + '|u';
    return h('div.lk-att', refs.map(r => h('span.lk-chip', r.img ? h('img', { src: Looks.file(C, r.img), onclick: e => UI.lightbox(e.target.src) }) : '🎬 ' + r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 26) + (r.from || r.to ? ` ${r.from || '0:00'}–${r.to || 'конец'}` : ''),
        h('button.icon', { title: 'Убрать', onclick: () => Store.del(ckey, path, r.id) }, '×'))),
      h('button.small', { onclick: pick }, '🖼'),
      h('button.small', { title: 'Найти картинку', onclick: () => ImgSearch.open('', { multi: true, fetch: async it => (await api('POST', '/api/looks/refurl', { channel: C.id, url: it.full, fallback: it.thumb })).f, onPath: f => Store.add(ckey, path, { id: uid('r'), img: f, note: '' }, true) }) }, '🔎'),
      draftInput(k, { class: 'box small', placeholder: 'видео: ссылка [с 1:10 по 1:25] — Enter', onkeydown: e => {
        if (e.key !== 'Enter') return; const v = e.target.value.trim(), m = /^(https?:\/\/\S+)(?:\s+(?:с\s*)?(\d+:\d\d)\s*(?:[-–]|по)\s*(\d+:\d\d))?/i.exec(v);
        if (!m) return UI.toast('нужна ссылка', 'err');
        Store.add(ckey, path, { id: uid('r'), url: m[1], from: m[2] || '', to: m[3] || '', note: '' }, true); e.target.value = ''; delete Drafts[k]; } }));
  },

  // ---------------- бриф видео: ручки и герои лука только для этого видео (brief.lookOver), у вышедших — заморожено (lookSnap)
  lkOverride(d, key) {
    const C = App.info.channel || {}, ch = Looks.chan(C), b = d.brief || {};
    if (!ch || !ch.techniques) return null;
    const lk = (ch.looks || []).find(x => x.key === b.look);
    if (!lk) return null;
    const O = b.lookOver || {}, open = LKS.over === d.id || Object.keys(O.params || {}).length > 0 || O.heroes != null;
    if (d.lookSnap) return h('p.dim.small', '🔒 Видео вышло — настройки лука заморожены (lookSnap): правки лука его не меняют.');
    if (!open) return h('div.row', h('button.small', { onclick: () => { LKS.over = d.id; App.render(); } }, '🎛 Настроить лук для этого видео'),
      h('span.dim.small', `герои: ${(lk.heroes || []).map(x => x.name).join(', ') || 'нет'}`));
    const push = () => { clearTimeout(LKS.overT); LKS.overT = setTimeout(async () => {
      try { await api('POST', '/api/videos/brief', { id: d.id, lookOver: d.brief.lookOver }); await Store.load(key, true); App.render(); } catch (e) { UI.toast(e.message, 'err'); } }, 700); };
    const setO = (k, v) => { d.brief.lookOver = Object.assign({}, d.brief.lookOver || {}, { [k]: v }); push(); };
    const vals = Looks.values(ch, lk, O.params), ctls = Looks.controls(ch, lk), changed = new Set(Object.keys(O.params || {}));
    const row = c => Looks.ctl(c, vals, changed, (k, x) => { O.params = Object.assign({}, O.params || {}, { [k]: x }); setO('params', O.params); App.render(); }, null);
    const H = O.heroes != null ? O.heroes : (lk.heroes || []);
    return h('div.lk-over',
      h('div.row', h('b', '🎛 Лук для этого видео'), h('span.dim.small', `поверх «${lk.label}» — сам лук не меняется`), h('span.sp'),
        h('button.small', { onclick: () => { d.brief.lookOver = {}; LKS.over = null; push(); } }, '↺ как в луке')),
      h('div.lk-grid', ctls.map(row)),
      h('div.row', h('b', 'Герои в этом видео'), h('span.sp'),
        H.map(hr => h('span.lk-chip', (hr.role === 'main' ? '★ ' : '') + (hr.name || 'герой'), h('button.icon', { title: 'Убрать только в этом видео', onclick: () => setO('heroes', H.filter(x => x.id !== hr.id)) }, '×'))),
        !H.length && h('span.dim.small', 'без героя'),
        O.heroes != null && h('button.small', { onclick: () => setO('heroes', null) }, 'герои как в луке')));
  },
});
