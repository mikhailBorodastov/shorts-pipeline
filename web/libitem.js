// Предмет библиотеки канала: #/lib/item/<kind>/<slug> — покрутить 3D, версии (основная = её берут новые сцены), имя и описание,
// где используется, ✏️ правка пинами и словами (Claude делает НОВУЮ версию — старые держат сцены, studio_api.fork + ideas_claude.libfix_spec),
// 🗑 в архив (версия или целиком; если стоит в сценах — сначала список). Сервер — studio_api.py (/api/lib/item|usage|meta|archive|fix).
'use strict';
const LI = { id: '', card: null, usage: null, v: 0, pins3d: [], notes: [], busy: false, err: '' };

const LibItem = {
  async load(id, force) {
    if (LI.id === id && LI.card && !force) return;
    if (LI.id !== id) Object.assign(LI, { pins3d: [], notes: [], v: 0 });
    LI.id = id; LI.busy = true; LI.err = '';
    try {
      LI.card = await api('GET', '/api/lib/item?id=' + encodeURIComponent(id));
      LI.usage = (await api('GET', '/api/lib/usage?id=' + encodeURIComponent(id))).items;
      if (!LI.v || !LI.card.versions.some(x => x.v === LI.v)) LI.v = LI.card.latest;
    } catch (e) { LI.err = e.message; LI.card = null; }
    LI.busy = false; App.render();
  },
  chan() { return LIB.channel || (App.info.channel || {}).id; },
  file(v, f) { return `/api/lib/file/${LibItem.chan()}/${LI.id}/v${v}/${f}`; },
  view(kind, slug) {
    const id = kind + '/' + slug;
    if (LI.id !== id || (!LI.card && !LI.busy && !LI.err)) LibItem.load(id);
    const back = h('p', h('a', { href: '#/lib' }, '← библиотека'));
    if (LI.err) return h('div', back, h('p.warn', LI.err));
    const C = LI.card;
    if (!C || LI.id !== id) return h('div', back, h('p.dim', h('span.spin'), ' загружаю…'));
    const ver = C.versions.find(x => x.v === LI.v) || C.versions[C.versions.length - 1];
    const has = f => (ver.files || []).includes(f) || (f === 'prefab.js' && ver.dim === '3d');
    const is3d = has('prefab.js') && kind !== 'sounds';
    const running = Object.values(Claude.jobs).find(j => j.scope === 'libfix:' + id && j.status === 'running');
    return h('div.libitem',
      back,
      h('div.phead', h('h1', (KIND_ICON[{ characters: 'char', props: 'prop', sounds: 'sound' }[kind]] || '📦') + ' ' + C.name), h('span.dim', `lib:${id}@${C.latest} — основная`),
        h('span.sp'), (kind === 'characters' || is3d) && h('button.primary', { onclick: () => wsOpen({ src: `lib:${id}@${LI.v}` }), title: 'Мастерская: скелет, позы, анимации (клипы), предметы в руках — в служебной сцене редактора' }, '🛠 Мастерская'),
        kind === 'characters' && h('a.btn', { href: '#/lib/char/' + slug }, '🦴 Лист персонажа')),
      h('div.li-main',
        h('div.li-view', LibItem.viewer(kind, ver, is3d)),
        h('div.li-side',
          LibItem.versions(C),
          LibItem.meta(C),
          is3d ? LibItem.fixBox(C, ver, running) : h('p.dim.small', kind === 'sounds' ? 'Звук правится в препродакшене видео (слои, кусок) и публикуется новой версией.'
            : 'Это 2D-предмет (рисунок кодом): правки — в препродакшене видео, оттуда «⬆ новая версия». Сделать его объёмным — «🖥 TRELLIS» у пропса в препродакшене.'),
          LibItem.dupBox(C, ver, is3d),
          LibItem.usageBox(C),
          LibItem.archiveBox(C, ver))));
  },

  // покрутить: 3D — стенд с пинами (клик по модели), 2D — превью, звук — плеер
  viewer(kind, ver, is3d) {
    if (kind === 'sounds') return h('div.li-sounds', (ver.files || []).filter(f => /\.(wav|mp3|ogg)$/i.test(f)).map(f => h('div', h('span.small', f), h('audio', { controls: true, src: LibItem.file(ver.v, f) }))));
    if (!is3d) return ver.preview ? h('img.li-img', { src: `/api/lib/file/${LibItem.chan()}/${LI.id}/${ver.preview}`, alt: '' }) : h('p.dim', 'нет превью');
    const src = `/tpl/stand3d.html?prop=${encodeURIComponent(LibItem.file(ver.v, 'prefab.js'))}&view=1&pin=1`;
    const frame = h('iframe.li-frame', { src, title: '3D', key: 'li3d|' + src });
    const send = () => { try { frame.contentWindow.postMessage({ type: 'prop-pins', pins: LI.pins3d.map((p, i) => ({ n: i + 1, p: p.p })) }, location.origin); } catch (e) {} };
    if (LibItem._msg) removeEventListener('message', LibItem._msg);
    LibItem._msg = ev => {
      if (ev.origin !== location.origin || !ev.data || ev.source !== frame.contentWindow) return;
      if (ev.data.type === 'prop-ready') send();
      if (ev.data.type === 'prop-pin') { LI.pins3d.push({ id: uid('p'), p: ev.data.p, n: ev.data.n, text: '' }); App.focusKey = 'lipin|' + (LI.pins3d.length - 1); App.render(); setTimeout(send, 50); }
    };
    addEventListener('message', LibItem._msg);
    return [frame, h('div.row.small', h('span.dim', 'Крутить — мышью, колесо — ближе. Клик по модели — 📍 пин с правкой.'), h('span.sp'),
      h('a', { href: src.replace('&pin=1', ''), target: '_blank', rel: 'noopener' }, '↗ во весь экран'))];
  },

  versions(C) {
    return h('section.card', h('div.card-head', h('h3', 'Версии'), h('span.dim.small', 'сцены держат свою @N; основная — для новых')),
      h('div.li-vers', C.versions.slice().reverse().map(x => h('div.li-ver', { class: (x.v === LI.v ? 'sel ' : '') + (x.v === C.latest ? 'main' : ''), onclick: () => { LI.v = x.v; LI.pins3d = []; App.render(); } },
        x.preview ? h('img', { src: `/api/lib/file/${LibItem.chan()}/${LI.id}/${x.preview}`, alt: '' }) : h('div.noimg', '📦'),
        h('div', h('b', 'v' + x.v), x.v === C.latest && h('span.small', ' ★ основная'), x.dim === '3d' && h('span.small', ' 🧊'),
          h('div.dim.small', x.forkOf ? `копия ${x.forkOf}` : x.from && x.from.videoName ? `из «${x.from.videoName}»` : ''),
          (x.summary || x.feedback) && h('div.small', x.summary || ('правка: ' + x.feedback)))))),
      LI.v !== C.latest && h('button', { onclick: () => LibItem.setMeta({ latest: LI.v }, `v${LI.v} — основная`) }, `★ Сделать v${LI.v} основной`));
  },

  meta(C) {
    const name = h('input.box', { value: C.name, key: 'liname|' + LI.id }), desc = h('textarea.box', { rows: 3, key: 'lidesc|' + LI.id });
    desc.value = C.desc || '';
    return h('section.card', h('div.card-head', h('h3', 'Имя и описание'), h('span.dim.small', 'по описанию его находят поиск и Claude')),
      name, desc, h('div.row', h('span.sp'), h('button', { onclick: () => LibItem.setMeta({ name: name.value, desc: desc.value }, 'сохранено') }, '💾 Сохранить')));
  },
  async setMeta(body, msg) {
    try { LI.card = await api('POST', '/api/lib/meta', Object.assign({ id: LI.id }, body)); LIB.items = null; UI.toast(msg); App.render(); } catch (e) { UI.toast(e.message, 'err'); }
  },

  // ✏️ правка: пины на модели + «в целом» -> Claude (Opus) делает новую версию, превью, она становится основной
  fixBox(C, ver, running) {
    const notesTa = h('textarea.box', { rows: 3, key: 'linotes|' + LI.id, placeholder: '«абажур зелёный», «ножка короче», «убери принтер — оставь только блок»…', oninput: e => { LI.note = e.target.value; const b = document.getElementById('lifix'); if (b) { const k = LI.pins3d.length + (LI.note.trim() ? 1 : 0); b.disabled = !k; b.textContent = `Поправить (${k})`; } } });
    notesTa.value = LI.note || '';
    const n = LI.pins3d.length + ((LI.note || '').trim() ? 1 : 0);
    return h('section.card', h('div.card-head', h('h3', '✏️ Правки'), h('span.dim.small', `от v${ver.v} → новая версия`)),
      LI.pins3d.length ? h('ol.pinlist', LI.pins3d.map((p, i) => h('li', h('span.pnum', i + 1),
        h('input.box', { value: p.text, placeholder: 'что здесь не так / как надо', key: 'lipin|' + i, oninput: e => { p.text = e.target.value; } }),
        h('button.icon.del', { title: 'Убрать пин', onclick: () => { LI.pins3d.splice(i, 1); App.render(); } }, '×'))))
        : h('p.dim.small', 'Кликни по модели слева — пин с номером; или просто напиши, что поменять.'),
      notesTa,
      running ? h('p.dim', h('span.spin'), ' ', running.summary || 'Claude правит…')
        : h('div.row', h('span.sp'), h('button.primary#lifix', { disabled: !n, onclick: () => LibItem.fix(ver), title: 'Claude (Opus) сделает новую версию: правит prefab.js / model.py / модель, снимает кадры. Старые версии остаются. 5–20 минут.' }, `Поправить (${n})`)));
  },
  async fix(ver) {
    try {
      const r = await api('POST', '/api/lib/fix', { id: LI.id, v: ver.v, notes: (LI.note || '').split('\n').filter(s => s.trim()), pins3d: LI.pins3d.map(p => ({ p: p.p, n: p.n, text: p.text })) });
      Claude.jobs[r.job.id] = r.job;
      Claude.cbs[r.job.id] = () => { LI.pins3d = []; LI.note = ''; LI.v = 0; LibItem.load(LI.id, true); LIB.items = null; };
      UI.toast('Claude правит — новая версия появится здесь, старые останутся');
      App.render();
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  // 🧬 копия: новый предмет из этой версии (целый системный блок -> «разбитый системный блок») и сразу просьба Claude, что в нём поменять
  dupBox(C, ver, is3d) {
    const nm = h('input.box', { placeholder: `${C.name} — разбитый`, key: 'lidup|' + LI.id });
    const ask = h('textarea.box', { rows: 2, key: 'lidupask|' + LI.id, placeholder: is3d ? 'что сделать с копией (необязательно): «разбей — трещины, вмятина, осколки»' : 'описание копии' });
    return h('section.card', h('div.card-head', h('h3', '🧬 Дублировать'), h('span.dim.small', `новый предмет из v${ver.v} — этот не меняется`)),
      nm, ask, h('div.row', h('span.sp'), h('button', { onclick: async () => {
        const name = nm.value.trim();
        if (!name) return UI.toast('Назови копию', 'err');
        try {
          const r = await api('POST', '/api/lib/fork', { id: LI.id, v: ver.v, as: name, note: ask.value.trim() || 'копия ' + C.name });
          const nid = r.ref.slice(4).split('@')[0];
          LIB.items = null; UI.toast('🧬 ' + name + ' — ' + r.ref);
          if (ask.value.trim() && is3d) {
            LI.id = ''; LI.card = null; await LibItem.load(nid);
            LI.note = ask.value.trim();
            await LibItem.fix(LI.card.versions.find(x => x.v === LI.card.latest));
          }
          go('#/lib/item/' + nid);
        } catch (e) { UI.toast(e.message, 'err'); }
      } }, ask.value ? '🧬 Дублировать и поправить' : '🧬 Дублировать')));
  },

  usageBox(C) {
    const U = LI.usage || [];
    return h('section.card', h('div.card-head', h('h3', 'Где стоит'), h('span.dim.small', U.length ? `сцен: ${U.length}` : 'пока нигде')),
      U.length ? h('ul.li-usage', U.map(u => h('li', h('a', { href: `#/p/${u.video}/pre/${u.el}/stage` }, `«${u.videoName}» → ${u.scene}`), ` · v${u.v}`, h('span.dim.small', ' · ' + u.objects.slice(0, 4).join(', ')))))
        : h('p.dim.small', 'В сцены его ставят «＋ добавить» в редакторе или агент.'));
  },

  archiveBox(C, ver) {
    const go_ = async (v, force) => {
      try {
        const r = await api('POST', '/api/lib/archive', { id: LI.id, v, force });
        if (r.used) {
          const list = r.used.map(u => `«${u.videoName}» → ${u.scene} (v${u.v})`).join('\n');
          if (confirm(`Стоит в сценах:\n${list}\n\nЕсли убрать — там он пропадёт (сцены останутся, предмет — нет). Всё равно убрать в архив?`)) return go_(v, true);
          return;
        }
        UI.toast('🗄 В архиве: ' + (r.archived || ''));
        LIB.items = null;
        if (v == null || C.versions.length <= 1) { LI.card = null; LI.id = ''; go('#/lib'); } else { LI.v = 0; LibItem.load(LI.id, true); }
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    return h('section.card.li-danger', h('div.card-head', h('h3', '🗑 Убрать'), h('span.dim.small', 'ничего не удаляется — уезжает в _archive/library')),
      h('div.row', C.versions.length > 1 && h('button', { onclick: () => confirm(`Убрать в архив версию v${ver.v}?`) && go_(ver.v, false) }, `версию v${ver.v}`),
        h('button.danger', { onclick: () => confirm(`Убрать «${C.name}» из библиотеки целиком (все версии)?`) && go_(null, false) }, 'весь предмет')));
  },
};
window.LibItem = LibItem;
