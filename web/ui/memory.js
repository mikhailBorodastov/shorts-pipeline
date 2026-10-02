// Claude Studio — S12.10: «Память» (docs/studio/stage12-redesign.md §10.3).
// Правила из правок автора: Claude предлагает (new) — автор принимает ✓, правит ✎, отклоняет ✗; действующие уходят в системный промпт всех ✨ и агента.
'use strict';

const MEM = { data: null, at: 0, edit: null };

const Memory = {
  async load() {
    try { MEM.data = await api('GET', '/api/memory'); MEM.at = Date.now(); } catch { MEM.data = MEM.data || { channel: [], all: [], new: 0 }; }
    App.render();
  },
  newCount() { return (MEM.data || {}).new || 0; },
  async op(body, msg) { try { await api('POST', '/api/memory/op', body); if (msg) UI.toast(msg); await this.load(); } catch (e) { UI.toast(e.message, 'err'); } },

  page() {
    if (!MEM.data || Date.now() - MEM.at > 8000) { if (!MEM.busy) { MEM.busy = true; this.load().finally(() => { MEM.busy = false; }); } }
    const D = MEM.data || { channel: [], all: [] };
    const all = [...D.channel.map(x => ({ ...x, scope: 'channel' })), ...D.all.map(x => ({ ...x, scope: 'all' }))];
    const fresh = all.filter(x => x.status === 'new'), on = all.filter(x => x.status === 'on'), off = all.filter(x => x.status === 'off');
    const inp = draftInput('mem|add', { class: 'box grow', placeholder: 'Своё правило: «звуки на переходах — тише», «в конце без морали»… Enter — добавить',
      onkeydown: e => { if (e.key === 'Enter' && e.target.value.trim()) { const t = e.target.value.trim(); e.target.value = ''; delete Drafts['mem|add']; this.op({ op: 'add', rule: { text: t, scope: 'channel' } }, 'Правило добавлено'); } } });
    return h('div.page.mem-page',
      h('div.page-head', h('div.grow', h('h1', 'Память'),
        h('p.sub', `Правила, которые Claude выносит из ваших правок. Принятые он соблюдает во всех видео канала «${D.channelName || ''}» (или во всех каналах).`))),
      h('div.row.mem-add', inp),
      fresh.length > 0 && [h('div.ws-sec', 'Предложил Claude', h('span.cnt', String(fresh.length))), h('div.mem-list', fresh.map(r => this.row(r, true)))],
      h('div.ws-sec', 'Действуют', h('span.cnt', String(on.length))),
      on.length ? h('div.mem-list', on.map(r => this.row(r))) : h('p.dim.small.mem-empty', 'Пока ни одного. Когда Claude заметит в ваших правках общее правило, он предложит его здесь — или добавьте своё строкой выше.'),
      off.length > 0 && [h('div.ws-sec', 'Выключены', h('span.cnt', String(off.length))), h('div.mem-list', off.map(r => this.row(r)))]);
  },
  row(r, fresh) {
    const ed = MEM.edit === r.id;
    const text = ed ? h('textarea.box.mem-ta', { key: 'mem|e|' + r.id, rows: 2 }, r.text) : h('div.mem-t', r.text);
    const why = ed ? h('input.box', { key: 'mem|w|' + r.id, value: r.why || '', placeholder: 'почему' }) : r.why && h('div.dim.small', 'почему: ' + r.why);
    const save = () => {
      const t = $(`[data-key="mem|e|${r.id}"]`), w = $(`[data-key="mem|w|${r.id}"]`);
      MEM.edit = null; this.op({ op: 'set', id: r.id, rule: { text: t ? t.value.trim() : r.text, why: w ? w.value.trim() : r.why, status: fresh ? 'on' : r.status } }, fresh ? '✓ Правило принято' : 'Сохранено');
    };
    return h('div.mem-row', { class: r.status },
      h('div.grow', text, why,
        h('div.mem-meta', h('span.pill', { class: r.scope === 'all' ? 'info' : '' }, r.scope === 'all' ? 'для всех каналов' : 'канал'),
          r.by === 'claude' ? h('span.dim.small', '🤖 предложил Claude') : h('span.dim.small', 'добавили вы'),
          r.from && r.from.video && h('a.small', { href: '#/v/' + r.from.video }, 'из «' + (r.from.name || r.from.video) + '»'),
          h('span.dim.small', fmtDate(r.created)))),
      h('div.mem-acts',
        ed ? [h('button.primary.small', { onclick: save }, fresh ? '✓ Принять' : 'Сохранить'), h('button.small', { onclick: () => { MEM.edit = null; App.render(); } }, 'Отмена')]
          : fresh ? [h('button.primary.small', { onclick: () => this.op({ op: 'set', id: r.id, rule: { status: 'on' } }, '✓ Правило принято — Claude будет его соблюдать') }, '✓ Принять'),
            h('button.small', { onclick: () => { MEM.edit = r.id; App.render(); } }, '✎ Поправить'),
            h('button.small', { onclick: () => this.op({ op: 'del', id: r.id }, 'Отклонено') }, '✗')]
            : [h('button.small', { title: r.status === 'on' ? 'Выключить (не удаляя)' : 'Включить', onclick: () => this.op({ op: 'set', id: r.id, rule: { status: r.status === 'on' ? 'off' : 'on' } }) }, r.status === 'on' ? 'Выключить' : 'Включить'),
              h('button.icon', { title: r.scope === 'all' ? 'Только этот канал' : 'Для всех каналов', onclick: () => this.op({ op: 'set', id: r.id, rule: { scope: r.scope === 'all' ? 'channel' : 'all' } }) }, Icon('tv', 15)),
              h('button.icon', { title: 'Поправить', onclick: () => { MEM.edit = r.id; App.render(); } }, '✎'),
              h('button.icon.del', { title: 'Удалить', onclick: () => confirm('Удалить правило?') && this.op({ op: 'del', id: r.id }) }, Icon('trash', 15))]));
  },
};
setInterval(() => { if (Date.now() - MEM.at > 30000 && !document.hidden) Memory.load(); }, 10000);
