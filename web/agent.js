// Claude Studio — панель агента (S7, docs/studio/stage7-agent.md): справа, на всех этапах видео и поверх редактора сцены.
// Живой лог шагов (GET /api/agent?video=&since=), сообщение посреди работы (уходит в ту же сессию), «■ стоп», «↺ отменить» весь запуск,
// контекст просьбы (этап, открытая сцена, момент, выбранное — из редактора window.agentCtx()), пометки сцены, «✨ Собрать».
'use strict';

const AgentPanel = {
  open: false, vid: null, since: 0, entries: [], busy: false, model: null, timer: null, el: null, expanded: new Set(),
  init() {
    try { this.open = Local.get('agent.open') === '1'; this.model = Local.get('agent.model') || 'sonnet'; } catch { this.model = 'sonnet'; }
    this.el = h('aside#agentpanel', { hidden: true });
    document.body.append(this.el);
    addEventListener('keydown', e => {
      const a = document.activeElement, typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.altKey && this.vid) { e.preventDefault(); this.toggle(true); }
      if (e.key === 'Escape' && this.open && a && a.closest && a.closest('#agentpanel')) { this.toggle(false); }
    });
    setInterval(() => this.poll(), 1000);
  },
  // видео, на котором сейчас автор (панель только на страницах видео)
  follow(r) {
    const vid = r.page === 'p' ? r.id : null;
    if (vid !== this.vid) { this.vid = vid; this.since = 0; this.entries = []; this.busy = false; this.expanded.clear(); if (vid) this.poll(true); }
    document.body.classList.toggle('agent-open', !!(this.open && this.vid));
    this.el.hidden = !(this.open && this.vid);
    if (!this.vid) return;
    if (!this.btn) { this.btn = h('button#agentfab', { title: 'Claude-агент (/)', onclick: () => this.toggle() }, '💬'); document.body.append(this.btn); }
    this.btn.hidden = !!this.open;
    this.btn.classList.toggle('busy', this.busy);
    if (this.open) this.draw();
  },
  toggle(on) {
    this.open = on == null ? !this.open : on;
    try { Local.set('agent.open', this.open ? '1' : '0'); } catch {}
    this.follow(App.route);
    if (this.open) setTimeout(() => { const t = this.el.querySelector('textarea'); if (t) t.focus(); }, 0);
    setTimeout(() => window.MontagePreview && MontagePreview.place(), 0);
  },
  ctx() {
    const r = App.route, c = { stage: (Plan.stageLabel && Plan.stageLabel(r.tab)) || r.tab || '' };
    const f = document.querySelector('.stage-editor iframe');
    try { if (f && f.contentWindow.agentCtx) Object.assign(c, f.contentWindow.agentCtx(), { stage: 'редактор сцены' }); } catch {}
    if (r.tab === 'montage' && window.MT) c.t = MT.t;
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
      if (this.entries.length > 400) this.entries = this.entries.slice(-400);
      if (was && !this.busy) {                                  // запуск кончился: страница видео подтягивает правки
        Store.load('plan:' + vid, true).then(() => App.render()).catch(() => {});
        if (window.MT && MT.info) { delete MT.info[vid]; }
      }
      if (changed) { if (this.btn) this.btn.classList.toggle('busy', this.busy); if (this.open) this.draw(); }
    } catch {}
  },
  async say(text, extra = {}) {
    if (!this.vid) return;
    await Store.flushAll();
    try {
      await api('POST', '/api/agent/say', { video: this.vid, text, ctx: Object.assign(this.ctx(), extra.ctx || {}), model: extra.model || this.model, mode: extra.mode || 'chat' });
      this.busy = true; this.poll(true);
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
  async undo(run, btn) {
    if (!confirm('Отменить всё, что агент сделал в этом запуске?')) return;
    btn.disabled = true;
    try { const r = await api('POST', '/api/agent/undo', { video: this.vid, run }); UI.toast(`↺ отменено: ${(r.done || []).length}`); Store.load('plan:' + this.vid, true).then(() => App.render()); }
    catch (e) { UI.toast(e.message, 'err'); btn.disabled = false; }
  },
  async reset() {
    try { await api('POST', '/api/agent/reset', { video: this.vid }); UI.toast('Новый разговор: агент забыл прошлое (лог остался)'); } catch (e) { UI.toast(e.message, 'err'); }
  },

  // ---------------- отрисовка
  draw() {
    const feed0 = this.el.querySelector('.ag-feed'), atBottom = !feed0 || feed0.scrollHeight - feed0.scrollTop - feed0.clientHeight < 40, top = feed0 ? feed0.scrollTop : 0;
    const draft = this.el.querySelector('textarea');
    const keep = draft ? [draft.value, document.activeElement === draft, draft.selectionStart] : ['', false, 0];
    const undone = new Set(this.entries.filter(e => e.undone).map(e => e.undone));
    const items = [];
    for (const e of this.entries) {
      if (e.kind === 'you') items.push(h('div.ag-you', e.ctx && h('div.ag-ctx', e.ctx.replace(/^\[контекст: |\]$/g, '')), e.text));
      else if (e.kind === 'claude') items.push(h('div.ag-cl', { html: md(e.text) }));
      else if (e.kind === 'step') {
        const open = this.expanded.has(e.i);
        items.push(h('div.ag-step', { class: (e.res == null ? 'run' : e.err ? 'bad' : 'ok') + (open ? ' open' : ''), onclick: () => { open ? this.expanded.delete(e.i) : this.expanded.add(e.i); this.draw(); } },
          h('span.ag-ic', e.res == null ? '…' : e.err ? '⚠' : '✓'), ' ', e.text,
          open && h('pre.ag-cmd', (e.cmd || '') + (e.res != null ? '\n→ ' + e.res : ''))));
      } else if (e.kind === 'done') {
        const n = e.undo ? Object.values(e.undo.scenes || {}).reduce((a, b) => a + b, 0) + (e.undo.plan || 0) : 0;
        items.push(h('div.ag-done', { class: e.ok ? '' : 'bad' }, e.ok ? '✓ готово' : '■ ' + (e.text || 'не закончил'),
          e.sec ? ` · ${fmtSec(e.sec)}` : '', e.cost ? ` · $${(+e.cost).toFixed(2)}` : '',
          n > 0 && (undone.has(e.run) ? h('span.dim', ' · отменено') : h('button.ag-undo', { onclick: ev => this.undo(e.run, ev.target), title: 'Отменить все правки этого запуска (сцены и видео)' }, `↺ отменить (${n})`))));
      } else if (e.kind === 'note') items.push(h('div.ag-note', e.text));
      else if (e.kind === 'err') items.push(h('div.ag-note.bad', '⚠ ' + e.text));
    }
    const d = this.vid && Store.get('plan:' + this.vid);
    const notes = this.sceneNotes();
    this.el.replaceChildren(
      h('div.ag-head', h('b', '💬 Claude'), d && h('span.dim.small', d.name),
        h('span.sp'),
        sel([{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }], this.model, v => { this.model = v; try { Local.set('agent.model', v); } catch {} }, { title: 'Модель: Sonnet — расстановка, ключи, мелкие правки; Opus — сборка, сложное' }),
        h('button', { onclick: () => this.reset(), title: 'Новый разговор (агент забудет прошлое)' }, '⟲'),
        h('button', { onclick: () => this.toggle(false), title: 'Скрыть (/)' }, '✕')),
      h('div.ag-feed', items.length ? items : h('div.ag-empty',
        h('p', 'Попроси что-нибудь словами — агент сделает это командами студии, а ты увидишь каждый шаг.'),
        h('p.dim.small', 'Например: «поставь вокруг стола три стула и сделай наезд на ёжика за 2 секунды». Посреди работы можно дописать или остановить, всё сделанное — отменить.'),
        d && h('button.claude', { onclick: () => this.build(), title: 'Агент проходит путь до mp4: сценарий → голос → монтаж → сборка → проверка кадров' }, '✨ Собрать ролик'))),
      notes.length ? h('div.ag-notes', h('div.row', h('span.dim.small', `📌 пометки сцены (${notes.length})`), h('span.sp'),
          !this.busy && h('button.claude', { title: 'Отдать агенту все открытые пометки одной просьбой — он исправит и закроет каждую', onclick: () => this.fixAll(notes) }, `✨ Исправить все (${notes.length})`)),
        h('div.ag-pins', notes.map(n => h('div.ag-pin', h('span.grow', `${n.who ? n.who + ' · ' : ''}${n.t != null ? n.t + ' с · ' : ''}${n.text}`),
          h('button', { title: 'Отдать агенту только эту', disabled: this.busy, onclick: () => this.fixAll([n]) }, '✨'),
          h('button', { title: 'Отметить исправленной вручную', onclick: () => this.noteDone(n) }, '✓'))))) : '',
      h('form.ag-form', { onsubmit: ev => { ev.preventDefault(); const t = ev.target.querySelector('textarea'); const v = t.value.trim(); if (!v) return; t.value = ''; this.say(v); } },
        h('textarea', { rows: 3, placeholder: this.busy ? 'Дописать агенту посреди работы…' : 'Просьба Claude (Enter — отправить, Shift+Enter — строка)',
          onkeydown: ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ev.target.form.requestSubmit(); } } }),
        h('div.row', h('span.dim.small.ag-ctxline', this.ctxLine()), h('span.sp'),
          this.busy && h('button.danger', { type: 'button', onclick: () => this.stop(), title: 'Остановить агента (сделанное останется — его можно отменить)' }, '■ стоп'),
          h('button.primary', { type: 'submit' }, this.busy ? 'Дописать ↵' : 'Отправить ↵'))));
    const feed = this.el.querySelector('.ag-feed');
    feed.scrollTop = atBottom ? feed.scrollHeight : top;
    const t = this.el.querySelector('textarea');
    t.value = keep[0];
    if (keep[1]) { t.focus(); try { t.setSelectionRange(keep[2], keep[2]); } catch {} }
  },
  ctxLine() {
    const c = this.ctx(), b = [];
    if (c.el) b.push('🎬 сцена'); else if (c.stage) b.push(c.stage);
    if (c.t != null) b.push(`⏱ ${(+c.t).toFixed(2)} с`);
    if (c.sel && c.sel.length) b.push('выбрано: ' + c.sel.slice(0, 2).map(s => s.replace(/^\S+ /, '')).join(', '));
    return b.join(' · ');
  },
  // ✨ по пометкам: одна просьба со всеми — агент правит, проверяет кадром и закрывает каждую (scene done)
  fixAll(notes) {
    const c = this.ctx(), el = c.el || 'EL';
    const list = notes.map((n, i) => `${i + 1}. [${n.id}] ${n.who ? n.who + ', ' : ''}${n.t != null ? n.t + ' с: ' : ''}${n.text}`).join('\n');
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

// мини-markdown для ответов агента: **жирный**, `код`, строки
function md(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}
window.AgentPanel = AgentPanel;
