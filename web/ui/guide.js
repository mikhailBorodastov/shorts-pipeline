// Claude Studio — редактор стайл-гайда канала по разделам (⚙ Стиль → 📝 Стайл-гайд).
// style/style-guide.md режется на разделы по «## » (вне блоков кода): слева оглавление с поиском, справа — один раздел для чтения;
// «✏️ Править» — поле только этого раздела, «✨ С Claude» — просьба словами -> вариант раздела (задача changuide), «Принять» / «Отклонить»;
// разделы двигаются, добавляются, удаляются; «Весь текст» — старое поле целиком. Сохранение — тот же /api/channel/stylefile (прошлая версия — в 🕘 Истории).
'use strict';

const GD = { cid: null, sel: 0, edit: null, draft: '', q: '', raw: false, ask: {}, prop: {}, open: {} };

const Guide = {
  // markdown -> [{title, level, body}] — body с заголовком первой строкой; заголовки внутри ``` не считаются
  split(src) {
    const L = String(src || '').replace(/\r\n/g, '\n').split('\n'), out = [];
    let cur = { title: 'Вступление', level: 1, lines: [] }, fence = false;
    for (const l of L) {
      if (/^\s*```/.test(l)) fence = !fence;
      if (!fence && /^##\s+/.test(l)) {
        if (cur.lines.some(x => x.trim()) || out.length) out.push(cur);
        cur = { title: l.replace(/^##\s+/, '').trim(), level: 2, lines: [l] };
      } else cur.lines.push(l);
    }
    out.push(cur);
    return out.map(s => ({ title: s.level === 1 ? ((s.lines.find(x => /^#\s+/.test(x)) || '').replace(/^#\s+/, '').trim() || 'Вступление') : s.title,
      level: s.level, body: s.lines.join('\n').replace(/\n+$/, '') }));
  },
  join(secs) { return secs.map(s => s.body.replace(/\n+$/, '')).join('\n\n') + '\n'; },
  subs(body) {                                         // ### подразделы — в оглавление
    let fence = false;
    return body.split('\n').filter(l => { if (/^\s*```/.test(l)) fence = !fence; return !fence && /^###\s+/.test(l); }).map(l => l.replace(/^###\s+/, '').trim());
  },
  words: s => (s.match(/[\p{L}\d]+/gu) || []).length,

  async save(secs, msg) {
    const text = this.join(secs);
    await Pages.chSave('style', text, true);
    if (CH.files) CH.files.style = text;
    UI.toast(msg || 'Гайд сохранён (прошлая версия — в 🕘 Истории)');
    App.render();
  },

  view(C, F) {
    if (GD.cid !== C.id) Object.assign(GD, { cid: C.id, sel: 0, edit: null, raw: false, ask: {}, prop: {}, q: '' });
    const secs = this.split(F.style || '');
    if (GD.raw) return this.rawView(F);
    GD.sel = Math.min(GD.sel, secs.length - 1);
    const q = GD.q.trim().toLowerCase();
    const hits = secs.map(s => !q || s.body.toLowerCase().includes(q));
    const total = this.words(F.style || '');
    const toc = h('div.gd-toc',
      h('input.box', { key: 'gd|q', placeholder: '🔎 найти в гайде', value: GD.q, oninput: e => { GD.q = e.target.value; clearTimeout(GD.t); GD.t = setTimeout(() => App.render(), 150); } }),
      h('div.gd-list', secs.map((s, i) => !hits[i] ? null : h('div.gd-item', { class: (i === GD.sel ? 'sel ' : '') + (GD.prop[i] ? 'prop' : ''), onclick: () => { GD.sel = i; if (GD.edit !== i) GD.edit = null; App.render(); } },
        h('div.gd-t', s.title, GD.prop[i] && h('span.gd-dot', { title: 'Вариант Claude ждёт решения' }, '●')),
        h('div.gd-meta.dim.small', `${this.words(s.body)} сл.` + (this.subs(s.body).length ? ' · ' + this.subs(s.body).length + ' подразд.' : ''))))),
      h('div.gd-tocfoot',
        h('button.small', { onclick: () => { const t = prompt('Название нового раздела'); if (!t) return; secs.push({ title: t, level: 2, body: `## ${t}\n\n` }); GD.sel = secs.length - 1; GD.edit = GD.sel; GD.draft = `## ${t}\n\n`; this.save(secs, '+ раздел'); } }, '＋ Раздел'),
        h('span.sp'), h('span.dim.small', `${secs.length} разд. · ${total} слов`)));
    return [h('section.card.gd',
      h('div.card-head', h('h3', '📝 Стайл-гайд'), h('span.dim.small', 'style/style-guide.md — его читают все сценарии и кнопки ✨ канала'), h('span.sp'),
        h('button.small', { onclick: () => { GD.raw = true; App.render(); }, title: 'Править markdown целиком одним полем' }, 'Весь текст')),
      h('div.gd-wrap', toc, this.section(secs, GD.sel, q)))];
  },

  section(secs, i, q) {
    const s = secs[i]; if (!s) return h('div.gd-main', h('p.dim', 'Гайд пуст — «＋ Раздел» или «Весь текст».'));
    const editing = GD.edit === i, prop = GD.prop[i], ckey = 'channel:' + GD.cid, job = Claude.running(ckey, 'changuide:' + i);
    const move = d => { const j = i + d; if (j < 0 || j >= secs.length || (secs[j].level === 1) || s.level === 1) return; [secs[i], secs[j]] = [secs[j], secs[i]]; GD.sel = j; GD.prop = {}; this.save(secs, 'Раздел перемещён'); };
    const head = h('div.gd-head',
      h('h2.gd-title', s.title),
      h('span.sp'),
      s.level === 2 && !editing && h('button.icon', { title: 'Выше', onclick: () => move(-1) }, '↑'),
      s.level === 2 && !editing && h('button.icon', { title: 'Ниже', onclick: () => move(1) }, '↓'),
      !editing && h('button', { onclick: () => { GD.edit = i; GD.draft = s.body; App.render(); } }, '✏️ Править'),
      !editing && s.level === 2 && h('button.icon.del', { title: 'Удалить раздел', onclick: () => { if (!confirm(`Удалить раздел «${s.title}»?\n\nПрошлая версия гайда останется в 🕘 Истории.`)) return; secs.splice(i, 1); GD.sel = Math.max(0, i - 1); GD.prop = {}; this.save(secs, 'Раздел удалён'); } }, '×'));
    const nav = h('div.gd-nav',
      i > 0 && h('button.small', { onclick: () => { GD.sel = i - 1; GD.edit = null; App.render(); } }, '← ' + secs[i - 1].title),
      h('span.sp'),
      i < secs.length - 1 && h('button.small', { onclick: () => { GD.sel = i + 1; GD.edit = null; App.render(); } }, secs[i + 1].title + ' →'));
    // ✨ просьба к Claude
    const askBox = h('textarea.box.auto', { key: 'gd|ask|' + GD.cid + '|' + i, rows: 1, placeholder: 'Что поменять в разделе — словами: «сократи вдвое», «добавь пример хука про игры», «темп 2,4 слова/с вместо 2,65»…',
      oninput: e => { GD.ask[i] = e.target.value; autosize(e.target); } });
    askBox.value = GD.ask[i] || '';
    const run = async () => {
      const ask = (GD.ask[i] || '').trim();
      try {
        const r = await api('POST', '/api/channel/guide-fix', { channel: GD.cid, sec: i, text: editing ? GD.draft : s.body, ask });
        Claude.jobs[r.job.id] = r.job;
        Claude.cbs[r.job.id] = res => { if (res && res.text) { GD.prop[i] = { text: res.text, note: res.note, base: s.body }; GD.sel = i; App.render(); } };
        App.render();
      } catch (e) { UI.toast(e.message, 'err'); }
    };
    const claude = h('div.gd-ask', askBox,
      job ? h('button.claude.run', { title: 'Отменить', onclick: () => api('POST', '/api/job/cancel?id=' + job.id).catch(() => {}) }, h('span.spin'), ' Claude правит… ✕')
        : h('button.claude', { disabled: !Claude.on, onclick: run, title: 'Claude перепишет только этот раздел по просьбе; сохранится, когда нажмёшь «Принять»' }, '✨ С Claude'));
    const proposal = prop && h('div.gd-prop',
      h('div.gd-prop-head', h('b', '✨ Вариант Claude'), prop.note && h('span.dim.small', ' — ' + prop.note), h('span.sp'),
        h('button.primary.small', { onclick: () => { const cur = secs[i]; if (cur.body !== prop.base && !confirm('Раздел поменялся, пока Claude думал. Всё равно заменить?')) return;
          secs[i] = { ...cur, body: prop.text }; delete GD.prop[i]; GD.edit = null; GD.ask[i] = ''; this.save(secs, '✓ Раздел заменён вариантом Claude'); } }, '✓ Принять'),
        h('button.small', { onclick: () => { GD.edit = i; GD.draft = prop.text; delete GD.prop[i]; App.render(); }, title: 'Взять вариант и доправить руками' }, '✏️ Доправить'),
        h('button.small', { onclick: () => { delete GD.prop[i]; App.render(); } }, 'Отклонить')),
      h('div.gd-cmp',
        h('div', h('div.dim.small', 'Было'), h('div.gd-md.old', { html: mdDoc(prop.base.replace(/^##\s+.*\n?/, '')) })),
        h('div', h('div.dim.small', 'Станет'), h('div.gd-md', { html: mdDoc(prop.text.replace(/^##\s+.*\n?/, '')) }))));
    let body;
    if (editing) {
      const ta = h('textarea.box.gd-edit.auto', { key: 'gd|ed|' + GD.cid + '|' + i, spellcheck: false, oninput: e => { GD.draft = e.target.value; autosize(e.target); } });
      ta.value = GD.draft;
      const done = () => { secs[i] = { ...s, body: GD.draft.replace(/\n+$/, '') }; GD.edit = null; this.save(secs, 'Раздел сохранён'); };
      ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); done(); }
        if (e.key === 'Escape') { e.preventDefault(); GD.edit = null; App.render(); }
      });
      body = h('div.gd-editwrap', ta,
        h('div.row', h('span.dim.small', 'markdown · Ctrl+S — сохранить · Esc — отмена'), h('span.sp'),
          h('button', { onclick: () => { GD.edit = null; App.render(); } }, 'Отмена'), h('button.primary', { onclick: done }, '💾 Сохранить раздел')));
      requestAnimationFrame(() => { const t = document.querySelector('.gd-edit'); if (t) autosize(t); });
    } else {
      let html = mdDoc(s.level === 2 ? s.body.replace(/^##\s+.*\n?/, '') : s.body.replace(/^\s*#\s+.*\n?/, ''));   // заголовок уже над разделом
      if (q) html = html.replace(/>([^<]+)</g, (m, t) => '>' + t.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), x => `<mark>${x}</mark>`) + '<');
      body = h('div.gd-md', { html, ondblclick: () => { GD.edit = i; GD.draft = s.body; App.render(); }, title: 'Двойной клик — править' });
    }
    return h('div.gd-main', head, proposal, claude, body, nav);
  },

  rawView(F) {
    const ta = h('textarea.box.styleedit', { key: 'styletext:' + GD.cid, spellcheck: false });
    ta.value = F.style || '';
    const save = async () => { await Pages.chSave('style', ta.value); if (CH.files) CH.files.style = ta.value; };
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } });
    return [h('section.card', h('div.card-head', h('h3', '📝 Стайл-гайд — весь текст'), h('span.dim.small', 'style/style-guide.md · markdown · Ctrl+S'), h('span.sp'),
      h('button', { onclick: async () => { await save(); GD.raw = false; App.render(); } }, '← По разделам'), h('button.primary', { onclick: save }, '💾 Сохранить')), ta)];
  },
};
window.Guide = Guide;
