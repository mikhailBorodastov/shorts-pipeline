// Claude Studio — панель агента (S7, docs/studio/stage7-agent.md; S12.4 — новый вид, docs/studio/stage12-redesign.md §5.7): справа, на всех страницах видео и поверх редактора сцены.
// Живой лог шагов (GET /api/agent?video=&since=), сообщение посреди работы (уходит в ту же сессию), «■ стоп», «Откатить» весь запуск (и Ctrl+Z в окне видео).
// Вкладки: Чат · История (запуски: изменения, откат) · Правки (пометки на кадрах ролика notes[], правки ревью fixes[], пометки открытой сцены).
// Область правки (окно видео): Выделение (выбранные сцены) · Сцена (под курсором) · Всё видео; карточка «Применено» — кадр сцены до / после (S12.4, agent.py _shot).
'use strict';

const AG_TIPS = {
  empty: ['Собери видео: сценарий → голос → монтаж → mp4'],
  video: ['Проверь всё видео и поправь, что выглядит не так', 'Сделай надписи читаемыми на телефоне', 'Проверь, что каждая картинка попадает в своё слово'],
  scene: ['Сделай эту сцену живее: камера и движение', 'Добавь звук к главному действию сцены'],
};

const AgentPanel = {
  open: false, vid: null, since: 0, entries: [], busy: false, model: null, timer: null, el: null, expanded: new Set(), tab: 'chat', scope: null,
  init() {
    try { this.open = Local.get('agent.open') === '1'; this.model = Local.get('agent.model') || 'sonnet'; } catch { this.model = 'sonnet'; }
    this.el = h('aside#agentpanel', { hidden: true });
    document.body.append(this.el);
    addEventListener('keydown', e => {
      const a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.altKey && this.vid) { e.preventDefault(); this.toggle(true); }
      if (e.key === 'Escape' && this.open && a && a.closest && a.closest('#agentpanel') && !document.querySelector('.mention')) { this.toggle(false); }
    });
    setInterval(() => this.poll(), 1000);
    setInterval(() => { const w = this.el.querySelector('.ag-working .elapsed2'); if (w) w.textContent = fmtSec((Date.now() - +w.dataset.start) / 1000); }, 1000);
  },
  inWs() { return App.route.page === 'v' && this.vid === App.route.id; },
  // видео, на котором сейчас автор (панель только на страницах видео)
  follow(r) {
    const vid = r.page === 'p' || r.page === 'v' ? r.id : null;   // S12: и окно видео #/v/<id>
    if (vid !== this.vid) { this.vid = vid; this.since = 0; this.entries = []; this.busy = false; this.expanded.clear(); if (vid) this.poll(true); }
    document.body.classList.toggle('agent-open', !!(this.open && this.vid));
    this.el.hidden = !(this.open && this.vid);
    if (!this.vid) return;
    if (!this.btn) { this.btn = h('button#agentfab', { title: 'Claude-агент (/)', onclick: () => this.toggle() }, Icon('spark', 20)); document.body.append(this.btn); }
    this.btn.hidden = !!this.open;
    this.btn.classList.toggle('busy', this.busy);
    if (this.open) this.draw();
  },
  toggle(on) {
    this.open = on == null ? !this.open : on;
    try { Local.set('agent.open', this.open ? '1' : '0'); } catch {}
    this.follow(App.route);
    if (this.open) setTimeout(() => { const t = this.el.querySelector('textarea'); if (t) t.focus(); }, 0);
    setTimeout(() => { window.MontagePreview && MontagePreview.place(); App.route.page === 'v' && Workspace.fit(); }, 0);
  },

  // ---------------- контекст просьбы ----------------
  scopeOf() {
    if (!this.inWs()) return null;
    if (this.scope) return this.scope;
    return (MT.multi || []).length ? 'selection' : 'all';
  },
  units() {                                                 // выбранные сцены монтажа (окно видео)
    const d = MT.d; if (!d) return [];
    const M = Montage.M(d), I = MT.info[d.id] || {}, order = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    return order.filter(u => (MT.multi || []).includes(u.id)).map(u => ({ n: order.indexOf(u) + 1, el: u.scene, name: ((I.scenes || []).find(s => s.el === u.scene) || {}).name || u.scene, at: u.at || 0, len: u.len || 0 }));
  },
  ctx() {
    const r = App.route, c = { stage: (Plan.stageLabel && Plan.stageLabel(r.tab)) || r.tab || '' };
    const f = document.querySelector('.stage-editor iframe');
    try { if (f && f.contentWindow.agentCtx) { Object.assign(c, f.contentWindow.agentCtx(), { stage: 'редактор сцены' }); return c; } } catch {}
    if (r.tab === 'montage' && window.MT) c.t = MT.t;
    if (this.inWs()) {
      c.stage = 'окно видео'; c.t = MT.t; c.scope = this.scopeOf();
      if (c.scope === 'selection') c.units = this.units();
    }
    return c;
  },
  async fullCtx(extra = {}) {                               // + сцена под курсором (кадр «до / после», область «Сцена»)
    const c = Object.assign(this.ctx(), extra);
    const d = this.vid && Store.get('plan:' + this.vid);
    if (this.inWs() && d && d.project && !c.el && (Montage.M(d).units || []).length) {
      try {
        const a = await api('GET', `/api/montage/at?video=${encodeURIComponent(d.id)}&t=${MT.t}`);
        if (a && a.el) { c.ab = { el: a.el, ts: a.ts }; if (c.scope === 'scene') c.el = a.el; }
      } catch {}
    }
    return c;
  },

  async poll(force) {
    if (!this.vid || (!force && !this.open && !this.busy)) return;
    const vid = this.vid;
    try {
      const r = await api('GET', `/api/agent?video=${encodeURIComponent(vid)}&since=${this.since}`);
      if (vid !== this.vid) return;
      const was = this.busy;
      this.busy = !!r.busy;
      let changed = was !== this.busy;
      for (const e of r.entries || []) {
        if (e.i <= this.since) continue;                       // два опроса разом — не задваивать
        this.since = e.i;
        if (e.kind === 'res') { const s = this.entries.find(x => x.i === e.of); if (s) { s.res = e.text; s.err = e.err; } }
        else this.entries.push(e);
        changed = true;
      }
      if (this.entries.length > 600) this.entries = this.entries.slice(-600);
      if (was && !this.busy) {                                  // запуск кончился: страница видео подтягивает правки
        Store.load('plan:' + vid, true).then(() => App.render()).catch(() => {});
        if (window.MT && MT.info) { delete MT.info[vid]; }
        if (App.route.page === 'v') setTimeout(() => window.Montage && MT.d && Montage.regen(), 300);   // превью — по новым сценам
        if (typeof Memory !== 'undefined') setTimeout(() => Memory.load(), 500);   // S12.10: Claude мог предложить правило
      }
      if (changed) { if (this.btn) this.btn.classList.toggle('busy', this.busy); if (this.open) this.draw(); }
      if (was !== this.busy && App.route.page === 'v') App.render();   // точка «Claude работает» у «Редактора», пайплайн
    } catch {}
  },
  async say(text, extra = {}) {
    if (!this.vid) return;
    await Store.flushAll();
    try {
      const ctx = await this.fullCtx(extra.ctx || {});
      await api('POST', '/api/agent/say', { video: this.vid, text, ctx, model: extra.model || this.model, mode: extra.mode || 'chat' });
      this.busy = true; this.tab = 'chat'; this.poll(true);
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  ask(text, ctx) { this.toggle(true); this.say(text, { ctx }); },          // из редактора: «💬 Claude, сделай…» на объекте
  build() {
    const d = Store.get('plan:' + this.vid);
    if (!confirm(`✨ Собрать «${d ? d.name : this.vid}»: Claude (Opus) напишет сценарий, озвучит, смонтирует сцены редактора и соберёт mp4. Ты видишь каждый шаг и можешь вмешаться. 10–30 минут.`)) return;
    this.toggle(true);
    this.say('✨ Собери ролик: сценарий, голос, монтаж, сборка — по видео и его сценам. Пометки автора в сценах — учти.', { mode: 'build', model: 'opus' });
  },
  stop() { api('POST', '/api/agent/stop', { video: this.vid }).catch(e => UI.toast(e.message, 'err')); },
  async undo(run, btn, ask = true) {
    if (ask && !confirm('Откатить всё, что Claude сделал в этом запуске?')) return false;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/agent/undo', { video: this.vid, run });
      UI.toast(`↺ откатил: ${(r.done || []).length}`);
      await Store.load('plan:' + this.vid, true); App.render();
      if (App.route.page === 'v' && MT.d) { delete MT.info[this.vid]; Montage.regen(); }
      return true;
    } catch (e) { UI.toast(e.message, 'err'); if (btn) btn.disabled = false; return false; }
  },
  async reset() {
    try { await api('POST', '/api/agent/reset', { video: this.vid }); UI.toast('Новый разговор: Claude забыл прошлое (лог остался)'); } catch (e) { UI.toast(e.message, 'err'); }
  },
  // последний запуск с правками, который ещё не откатили (Ctrl+Z в окне видео)
  lastRun() {
    const undone = new Set(this.entries.filter(e => e.undone).map(e => e.undone));
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind !== 'done' || !e.run || undone.has(e.run)) continue;
      const n = this.changes(e);
      if (n > 0) return { run: e.run, ts: e.ts, n };
    }
    return null;
  },
  changes(e) { return e.undo ? Object.values(e.undo.scenes || {}).reduce((a, b) => a + b, 0) + (e.undo.plan || 0) : 0; },
  async detail(run) {
    let r;
    try { r = await api('GET', `/api/agent/run?video=${encodeURIComponent(this.vid)}&run=${run}`); } catch (e) { return UI.toast(e.message, 'err'); }
    const shot = this.entries.find(e => e.kind === 'shot' && e.run === run);
    UI.modal('Изменения запуска', h('div.ag-detail',
      shot && this.ab(shot),
      r.scenes.map(s => h('div.ag-dsec', h('b', '🎬 ' + (s.name || s.el)), h('ul', s.batches.map(b => h('li', { class: b.undone ? 'undone' : '' }, b.desc || 'правка сцены', h('span.dim', ` · ${b.n} оп.`), b.undone ? h('span.dim', ' · откачено') : null))))),
      r.plan.length ? h('div.ag-dsec', h('b', '🎞 Видео и монтаж'), h('ul', r.plan.map(p => h('li', p.desc)))) : null,
      !r.scenes.length && !r.plan.length ? h('p.dim', 'Запуск ничего не менял в сценах и видео (только смотрел или отвечал).') : null,
      r.undone ? h('p.dim', '↺ Этот запуск откачен.') : null), { wide: true });
  },
  ab(s) {                                                    // кадр сцены до / после: ползунок
    if (!s.before && !s.after) return null;
    const src = p => `/api/agent/file?video=${encodeURIComponent(this.vid)}&path=${encodeURIComponent(p)}&v=${s.i}`;
    if (!s.before || !s.after) return h('div.ag-ab', h('img', { src: src(s.after || s.before), alt: '' }), h('span.ag-abl', s.after ? 'После' : 'До'));
    const box = h('div.ag-ab.cmp', { title: 'Тяни — сравнить до и после' },
      h('img.after', { src: src(s.after), alt: 'после' }), h('div.before', h('img', { src: src(s.before), alt: 'до' })), h('i.bar'),
      h('span.ag-abl.l', 'До'), h('span.ag-abl.r', 'После'));
    const set = x => { const r = box.getBoundingClientRect(), k = Math.max(0, Math.min(1, (x - r.left) / r.width)); box.style.setProperty('--k', k * 100 + '%'); };
    box.addEventListener('pointerdown', e => { set(e.clientX); const mv = ev => set(ev.clientX), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); });
    return box;
  },

  // ---------------- отрисовка ----------------
  draw() {
    const feed0 = this.el.querySelector('.ag-feed'), atBottom = !feed0 || feed0.scrollHeight - feed0.scrollTop - feed0.clientHeight < 40, top = feed0 ? feed0.scrollTop : 0;
    const draft = this.el.querySelector('textarea');
    const keep = draft ? [draft.value, document.activeElement === draft, draft.selectionStart] : [Drafts['agent|' + this.vid] || '', false, 0];
    const d = this.vid && Store.get('plan:' + this.vid);
    const notesN = this.openNotes(d).length;
    const ws = this.inWs();
    const tabs = h('div.seg.ag-tabs', [['chat', 'Чат'], ['history', 'История'], ['notes', notesN ? `Правки ${notesN}` : 'Правки']].map(([k, l]) =>
      h('button', { class: this.tab === k ? 'sel' : '', onclick: () => { this.tab = k; this.draw(); } }, l)));
    const body = this.tab === 'history' ? this.history() : this.tab === 'notes' ? this.notesView(d) : this.feed(d);
    this.el.replaceChildren(...[
      h('div.ag-head', h('span.ag-title', Icon('spark', 16), 'Claude'), tabs, h('span.sp'),
        !ws && sel([{ value: 'sonnet', label: 'Sonnet 5.5' }, { value: 'opus', label: 'Opus 5.5' }], this.model, v => { this.model = v; try { Local.set('agent.model', v); } catch {} }, { title: 'Модель: Sonnet — расстановка, ключи, мелкие правки; Opus — сборка, сложное' }),
        h('button.icon', { onclick: () => this.reset(), title: 'Новый разговор (Claude забудет прошлое, лог останется)' }, Icon('plus', 16)),
        h('button.icon', { onclick: () => this.toggle(false), title: 'Скрыть (/ — открыть)' }, Icon('x', 16))),
      body,
      this.tab === 'chat' && this.form(d, keep)].filter(x => x instanceof Node));
    const feed = this.el.querySelector('.ag-feed');
    if (feed) feed.scrollTop = atBottom ? feed.scrollHeight : top;
    const t = this.el.querySelector('textarea');
    if (t) { t.value = keep[0]; if (keep[1]) { t.focus(); try { t.setSelectionRange(keep[2], keep[2]); } catch {} } }
  },

  feed(d) {
    const items = [], E = this.entries, undone = new Set(E.filter(e => e.undone).map(e => e.undone));
    const shots = Object.fromEntries(E.filter(e => e.kind === 'shot').map(e => [e.run, e]));
    let steps = [];
    const flush = () => {
      if (!steps.length) return;
      const key = 'g' + steps[0].i, open = this.expanded.has(key), hidden = open ? 0 : Math.max(0, steps.length - 4);
      const pics = [];
      for (const s of steps) for (const m of String(s.res || '').matchAll(/([A-Za-z]:[\\/][^\s"'<>|]+?\.png)/g)) pics.push(m[1]);
      items.push(h('div.ag-steps',
        hidden > 0 && h('button.ag-more', { onclick: () => { this.expanded.add(key); this.draw(); } }, `+${hidden} ${plural(hidden, 'шаг', 'шага', 'шагов')} раньше`),
        steps.slice(hidden).map(e => this.step(e)),
        pics.length > 0 && h('div.ag-thumbs', [...new Set(pics)].slice(-6).map(p => h('img', { src: `/api/agent/file?video=${encodeURIComponent(this.vid)}&path=${encodeURIComponent(p)}&v=${steps[steps.length - 1].i}`, alt: '', loading: 'lazy',
          onerror: e => e.target.remove(), onclick: e => UI.lightbox(e.target.src) })))));
      steps = [];
    };
    for (const e of E) {
      if (e.kind === 'step') { steps.push(e); continue; }
      flush();
      if (e.kind === 'you') items.push(h('div.ag-you', e.ctx && h('div.ag-ctx', e.ctx.replace(/^\[контекст: |\]$/g, '')), e.text));
      else if (e.kind === 'claude') items.push(h('div.ag-cl', { html: md(e.text) }));
      else if (e.kind === 'done') items.push(this.card(e, shots[e.run], undone.has(e.run)));
      else if (e.kind === 'note') items.push(h('div.ag-note', e.text));
      else if (e.kind === 'err') items.push(h('div.ag-note.bad', '⚠ ' + e.text));
    }
    flush();
    if (this.busy) {
      const start = [...E].reverse().find(e => e.kind === 'you');
      items.push(h('div.ag-working', h('span.spin'), ' Claude работает · ', this.model === 'opus' ? 'opus-5.5' : 'sonnet-5.5', ' · ',
        h('span.elapsed2', { 'data-start': start ? start.ts : Date.now() }, fmtSec((Date.now() - (start ? start.ts : Date.now())) / 1000)), h('span.sp'),
        h('button.small', { onclick: () => this.stop(), title: 'Остановить (сделанное останется — его можно откатить)' }, Icon('x', 12), 'Стоп')));
    }
    return h('div.ag-feed', items.length ? items : h('div.ag-empty',
      h('div.es-ico', Icon('spark', 22)),
      h('p', 'Опишите правку словами — Claude сделает её командами студии, а вы увидите каждый шаг.'),
      h('p.dim.small', 'Например: «сделай наезд на ёжика за 2 секунды», «между 3 и 4 сценой — плавный переход». @ — сослаться на персонажа, пропс или сцену.'),
      d && h('button.claude', { onclick: () => this.build(), title: 'Агент проходит путь до mp4: сценарий → голос → монтаж → сборка → проверка кадров' }, '✨ Собрать ролик')));
  },
  step(e) {
    const open = this.expanded.has(e.i);
    return h('div.ag-step', { class: (e.res == null ? 'run' : e.err ? 'bad' : 'ok') + (open ? ' open' : ''), onclick: () => { open ? this.expanded.delete(e.i) : this.expanded.add(e.i); this.draw(); } },
      h('span.ag-ic', e.res == null ? h('span.spin') : e.err ? '⚠' : Icon('check', 12)), h('span.ag-st', e.text),
      open && h('pre.ag-cmd', (e.cmd || '') + (e.res != null ? '\n→ ' + e.res : '')));
  },
  card(e, shot, undone) {
    const n = this.changes(e), u = e.undo || {}, sc = Object.keys(u.scenes || {}).length;
    return h('div.ag-card', { class: e.ok ? '' : 'bad' },
      h('div.ag-card-h', h('span.pill', { class: e.ok ? 'ok' : '' }, h('i'), e.ok ? (n ? 'Применено' : 'Готово') : 'Остановлено'),
        h('span.dim.small', [e.sec ? fmtSec(e.sec) : '', n ? `${n} ${plural(n, 'правка', 'правки', 'правок')}` : ''].filter(Boolean).join(' · '))),
      !e.ok && e.text && h('div.dim.small', e.text),
      shot && !undone && this.ab(shot),
      n > 0 && h('div.ag-card-ch.dim.small', [sc ? `сцены: ${sc}` : '', u.plan ? `видео: ${u.plan}` : ''].filter(Boolean).join(' · ')),
      n > 0 && h('div.ag-card-b',
        h('button.small', { onclick: () => this.detail(e.run) }, Icon('book', 13), 'Изменения'),
        undone ? h('span.dim.small', '↺ откачено') : h('button.small', { onclick: ev => this.undo(e.run, ev.currentTarget), title: 'Откатить весь запуск (Ctrl+Z в окне видео)' }, '↺ Откатить')));
  },

  form(d, keep) {
    const ws = this.inWs(), scope = this.scopeOf(), units = ws ? this.units() : [];
    const tips = !this.busy && d && (ws ? ((Montage.M(d).units || []).length ? (scope === 'scene' ? AG_TIPS.scene : AG_TIPS.video) : AG_TIPS.empty) : []);
    const chip = ws && (scope === 'selection' && units.length ? h('span.ag-chip', 'Сцены: ' + units.map(u => u.n).join(', '), h('button.x', { title: 'Снять выбор', onclick: () => { MT.multi = []; MT.sel = null; Montage.redraw(); this.draw(); } }, '×'))
      : scope === 'scene' ? h('span.ag-chip', 'Сцена под курсором · ' + Workspace.fmt(MT.t)) : scope === 'all' ? h('span.ag-chip.dim', 'Всё видео') : null);
    const send = () => { const t = this.el.querySelector('textarea'), v = t.value.trim(); if (!v) return; t.value = ''; delete Drafts['agent|' + this.vid]; this.say(v); };
    return h('form.ag-form', { onsubmit: ev => { ev.preventDefault(); send(); } },
      tips && tips.length > 0 && h('div.ag-tips', tips.map(t => h('button.ag-tip', { type: 'button', onclick: () => this.say(t) }, t))),
      chip && h('div.ag-chiprow', chip),
      h('textarea', { rows: 3, key: d ? `plan:${d.id}|agentchat` : 'agentchat',
        placeholder: this.busy ? 'Поставить следующую правку в очередь — Claude подхватит её между шагами…' : ws ? 'Опишите правку или кликните кадр в превью (пометка)… @ — элемент' : 'Просьба Claude (Enter — отправить, Shift+Enter — строка)',
        oninput: e => { Drafts['agent|' + this.vid] = e.target.value; },
        onkeydown: ev => { if (ev.key === 'Enter' && !ev.shiftKey && !document.querySelector('.mention')) { ev.preventDefault(); send(); } } }),
      h('div.ag-bar',
        ws ? h('div.seg.ag-scope', [['selection', 'Выделение'], ['scene', 'Сцена'], ['all', 'Всё видео']].map(([k, l]) =>
          h('button', { type: 'button', class: scope === k ? 'sel' : '', disabled: k === 'selection' && !units.length,
            title: { selection: 'Только выбранные сцены (Ctrl / Shift на таймлайне)', scene: 'Сцена под курсором', all: 'Правка по всему видео' }[k],
            onclick: () => { this.scope = k === 'all' && !units.length ? null : k; this.draw(); } }, l))) : h('span.dim.small.ag-ctxline', this.ctxLine()),
        h('span.sp'),
        h('button.icon', { type: 'button', title: 'Enter — отправить · Shift+Enter — строка · @ — элемент · / — открыть панель · Ctrl+Z в окне видео — откатить последний запуск' }, '?'),
        this.busy && h('button.small', { type: 'button', onclick: () => this.stop(), title: 'Остановить' }, Icon('x', 12), 'Стоп'),
        h('button.primary', { type: 'submit' }, this.busy ? 'В очередь' : 'Применить', Icon('enter', 14))));
  },
  ctxLine() {
    const c = this.ctx(), b = [];
    if (c.el) b.push('🎬 сцена'); else if (c.stage) b.push(c.stage);
    if (c.t != null) b.push(`⏱ ${(+c.t).toFixed(2)} с`);
    if (c.sel && c.sel.length) b.push('выбрано: ' + c.sel.slice(0, 2).map(s => s.replace(/^\S+ /, '')).join(', '));
    return b.join(' · ');
  },

  // ---------------- История: запуски ----------------
  history() {
    const E = this.entries, undone = new Set(E.filter(e => e.undone).map(e => e.undone));
    const runs = E.filter(e => e.kind === 'done' && e.run).reverse().map(e => {
      const ask = E.find(x => x.kind === 'you' && x.run === e.run);
      return { e, ask, n: this.changes(e), undone: undone.has(e.run), shot: E.find(x => x.kind === 'shot' && x.run === e.run) };
    });
    return h('div.ag-feed.ag-hist', runs.length ? runs.map(r => h('div.ag-run', { class: r.undone ? 'undone' : '' },
      h('div.row', h('span.pill', { class: r.e.ok ? 'ok' : '' }, h('i'), r.e.ok ? 'готово' : 'стоп'), h('span.dim.small', new Date(r.e.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })),
        h('span.sp'), r.n ? h('span.dim.small', `${r.n} ${plural(r.n, 'правка', 'правки', 'правок')}`) : null),
      h('div.ag-run-t', r.ask ? r.ask.text.slice(0, 220) : '—'),
      r.shot && !r.undone && this.ab(r.shot),
      r.n > 0 && h('div.ag-card-b', h('button.small', { onclick: () => this.detail(r.e.run) }, 'Изменения'),
        r.undone ? h('span.dim.small', '↺ откачено') : h('button.small', { onclick: ev => this.undo(r.e.run, ev.currentTarget) }, '↺ Откатить'))))
      : h('div.ag-empty', h('p.dim', 'Запусков пока нет. Каждая просьба Claude — запуск: здесь будет что он сделал, и его можно откатить.')));
  },

  // ---------------- Правки: пометки на кадрах, ревью, сцена ----------------
  openNotes(d) { return ((d && d.notes) || []).filter(n => (n.status || 'open') === 'open'); },
  notesView(d) {
    const key = d && 'plan:' + d.id, notes = this.openNotes(d), done = ((d && d.notes) || []).filter(n => n.status === 'done');
    const fixes = ((d && d.fixes) || []).filter(x => x.status === 'open'), scene = this.sceneNotes();
    const total = notes.length + fixes.length;
    return h('div.ag-feed.ag-notesview',
      h('p.dim.small', this.inWs() ? 'Кликните по кадру в превью — пометка встанет в этот момент. Соберите несколько и отдайте Claude одной кнопкой.' : 'Пометки на кадрах ставятся в окне видео.'),
      total > 0 && h('div.row', h('b', `Открытых: ${total}`), h('span.sp'),
        !this.busy && h('button.claude', { onclick: () => this.fixNotes(d, notes, fixes) }, `✨ Исправить все (${total})`)),
      notes.map(n => h('div.ag-pin', h('button.link', { title: 'Перейти к кадру', onclick: () => { if (App.route.page === 'v') Workspace.seek(n.t); } }, Workspace.fmt(n.t)),
        h('span.grow', n.text), h('button.icon', { title: 'Отдать Claude только эту', disabled: this.busy, onclick: () => this.fixNotes(d, [n], []) }, '✨'),
        h('button.icon', { title: 'Готово (сделал сам)', onclick: () => Store.set(key, ['notes', n.id, 'status'], 'done', true) }, Icon('check', 14)),
        h('button.icon.del', { title: 'Удалить', onclick: () => Store.del(key, ['notes'], n.id) }, Icon('x', 14)))),
      fixes.map(x => h('div.ag-pin', h('span.dim.small', '✋ ' + (x.vt || 0).toFixed(1) + ' с'), h('span.grow', x.why || x.desc || 'правка в сцене'))),
      fixes.length > 0 && h('p.dim.small', '✋ — правки, сделанные в редакторе сцены (уходят «Исправить все» вместе с пометками).'),
      scene.length > 0 && [h('div.ws-sec', '📌 Пометки открытой сцены'), scene.map(n => h('div.ag-pin', h('span.grow', `${n.who ? n.who + ' · ' : ''}${n.t != null ? n.t + ' с · ' : ''}${n.text}`),
        h('button.icon', { title: 'Отдать агенту только эту', disabled: this.busy, onclick: () => this.fixAll([n]) }, '✨'),
        h('button.icon', { title: 'Отметить исправленной вручную', onclick: () => this.noteDone(n) }, Icon('check', 14)))),
        h('button.claude', { disabled: this.busy, onclick: () => this.fixAll(scene) }, `✨ Исправить пометки сцены (${scene.length})`)],
      done.length > 0 && h('details.ag-done-notes', h('summary.dim.small', `Сделанные (${done.length})`), done.slice(-20).reverse().map(n => h('div.ag-pin.done', h('span.dim.small', Workspace.fmt(n.t)), h('span.grow', n.text, n.reply ? h('span.dim', ' → ' + n.reply) : null)))),
      !total && !scene.length && !done.length && h('div.ag-empty', h('p.dim', 'Пометок нет.')));
  },
  fixNotes(d, notes, fixes) {
    const M = Montage.M(d), I = MT.info[d.id] || {}, order = [...(M.units || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    const list = notes.map(n => {
      const u = Workspace.unitAt(M, n.t), sc = u && (I.scenes || []).find(s => s.el === u.scene);
      return { id: n.id, t: +n.t.toFixed(2), x: +(n.x || 0).toFixed(2), y: +(n.y || 0).toFixed(2), text: n.text, scene: u ? { n: order.indexOf(u) + 1, el: u.scene, name: (sc && sc.name) || u.scene, ts: +Workspace.v2s(d, u, n.t).toFixed(2) } : null };
    });
    let msg = `✋ Пометки автора на кадрах ролика (video.json → notes; x, y — доли кадра от левого верхнего угла, t — время ролика, scene.ts — время сцены): ${JSON.stringify(list)}
Для каждой: найди, что не так в кадре (scene frame сцены в ts — посмотри), поправь сцену (scene ops) или монтаж, проверь кадром и закрой: set plan:${d.id} notes.<id>.status '"done"' и notes.<id>.reply '"что сделал"'. Что не вышло — не закрывай и скажи почему.`;
    if (fixes.length) msg += `\n\nЕщё правки из ревью (video.json → fixes, сделаны в редакторе): ${JSON.stringify(fixes.map(x => ({ id: x.id, el: x.el, ts: x.ts, vt: x.vt, why: x.why, ops: x.ops })))} — примени их ops как правку автора (scene ops … --by author), проверь кадром и закрой: set plan:${d.id} fixes.<id>.status '"done"'.`;
    msg += '\nВ конце — montage gen и коротко по каждой.';
    this.tab = 'chat';
    this.say(msg, { model: 'opus' });
  },
  // ✨ по пометкам: одна просьба со всеми — агент правит, проверяет кадром и закрывает каждую (scene done)
  fixAll(notes) {
    const c = this.ctx(), el = c.el || 'EL';
    const list = notes.map((n, i) => `${i + 1}. [${n.id}] ${n.who ? n.who + ', ' : ''}${n.t != null ? n.t + ' с: ' : ''}${n.text}`).join('\n');
    this.tab = 'chat';
    this.say(`Исправь по пометкам автора в этой сцене (${notes.length}):\n${list}\n\nСделай все, проверь кадрами на их моментах, потом закрой исправленные: scene done ${'PLAN'} ${el} ${notes.map(n => n.id).join(',')} "что сделано". Что не получилось — не закрывай и скажи.`);
  },
  noteDone(n) {                                               // ✓ вручную — из редактора (операция сцены, отменяется Ctrl+Z)
    const f = document.querySelector('.stage-editor iframe');
    try { f.contentWindow.ED.commit([{ op: 'set', path: ['comments', n.id, 'status'], value: 'done' }], `📌 ✓ ${n.text.slice(0, 40)}`); setTimeout(() => this.draw(), 300); }
    catch (e) { UI.toast('Открой сцену в редакторе', 'err'); }
  },
  sceneNotes() {                                              // пометки (📌 note) открытой сцены — из редактора
    const f = document.querySelector('.stage-editor iframe');
    try {
      const ED = f && f.contentWindow.ED;
      if (!ED || !ED.doc) return [];
      const nm = id => ((ED.doc.objects || []).find(o => o.id === id) || {}).name;
      return (ED.doc.comments || []).filter(c => (c.status || 'open') === 'open').map(c => ({ id: c.id, text: c.text, t: c.t, who: c.target ? nm(c.target) || c.target : '' }));
    } catch { return []; }
  },
};

// мини-markdown для ответов агента: **жирный**, `код`, строки, списки «- »
function md(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^- /gm, '• ').replace(/\n/g, '<br>');
}
window.AgentPanel = AgentPanel;
