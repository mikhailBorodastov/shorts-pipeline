// Claude Studio — «Память» (S12.10, вид — по референсу автора).
// Правила трёх уровней: все каналы · канал · одно видео. Claude предлагает новые (вкладка «Предложенные») из правок автора —
// сам по ходу работы и по кнопке «✨ Научиться на моих правках» (задача memlearn); действующие уходят в системный промпт всех ✨ и агента.
'use strict';

const MEM = { data: null, at: 0, edit: null, tab: Local.get('mem-tab') || 'all', scope: 'channel', video: '' };
const MEM_SCOPE = {
  all: { label: 'Все каналы', icon: 'globe', hint: 'для всех каналов студии' },
  channel: { label: 'Канал', icon: 'tv', hint: 'для всех видео этого канала' },
  video: { label: 'Одно видео', icon: 'film', hint: 'только для выбранного видео' },
};

const Memory = {
  async load() {
    try { MEM.data = await api('GET', '/api/memory'); MEM.at = Date.now(); } catch { MEM.data = MEM.data || { channel: [], all: [], new: 0, videos: [] }; }
    App.render();
  },
  newCount() { return (MEM.data || {}).new || 0; },
  async op(body, msg) { try { await api('POST', '/api/memory/op', body); if (msg) UI.toast(msg); await this.load(); } catch (e) { UI.toast(e.message, 'err'); } },
  scopeOf(r) { return r.scope === 'all' ? 'all' : r.scope === 'video' ? 'video' : 'channel'; },

  page() {
    if (!MEM.data || Date.now() - MEM.at > 8000) { if (!MEM.busy) { MEM.busy = true; this.load().finally(() => { MEM.busy = false; }); } }
    const D = MEM.data || { channel: [], all: [], videos: [] };
    const rules = [...D.channel.map(x => ({ ...x, scope: this.scopeOf(x) })), ...D.all.map(x => ({ ...x, scope: 'all' }))]
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    const fresh = rules.filter(x => x.status === 'new'), live = rules.filter(x => x.status !== 'new');
    const tabs = [['all', 'Все', live.length], ['global', 'Все каналы', live.filter(x => x.scope === 'all').length],
      ['channel', 'Канал', live.filter(x => x.scope === 'channel').length], ['video', 'Видео', live.filter(x => x.scope === 'video').length],
      ['new', 'Предложенные', fresh.length]];
    const tab = MEM.tab;
    const shown = tab === 'new' ? fresh : live.filter(x => tab === 'all' || (tab === 'global' ? x.scope === 'all' : x.scope === tab));
    const ckey = D.channelId ? 'channel:' + D.channelId : 'channel:ch';
    return h('div.page.mem-page',
      h('div.mem-head',
        h('div.grow', h('h1', 'Память'),
          h('p.sub', `Правила, которые Claude соблюдает в каждой работе. Он предлагает новые, когда правка выдаёт ваше предпочтение, — что остаётся, решаете вы.`)),
        Claude.btn({ label: 'Научиться на моих правках', action: 'memlearn', key: ckey, scope: 'memlearn', cls: 'mem-learn',
          title: 'Claude перечитает пины и правки кадров, заметки к сценариям и просьбы в чате по видео канала и предложит правила — они появятся в «Предложенных»',
          onResult: () => { MEM.tab = 'new'; Local.set('mem-tab', 'new'); this.load(); } })),
      this.addCard(D),
      h('div.mem-tabs', tabs.map(([k, l, n]) => h('button', { class: (tab === k ? 'on ' : '') + (k === 'new' && n ? 'hot' : ''), onclick: () => { MEM.tab = k; Local.set('mem-tab', k); App.render(); } },
        l, n ? h('span.cnt', String(n)) : null))),
      !MEM.data ? h('div.mem-card.empty', h('p.dim', h('span.spin'), ' загружаю…'))
      : shown.length ? h('div.mem-card', shown.map(r => this.row(r, D)))
        : h('div.mem-card.empty', h('p.dim', tab === 'new' ? 'Предложений нет. Claude предлагает правила сам, когда замечает повторяющуюся правку, — или нажмите «Научиться на моих правках».'
          : 'Пока ни одного правила. Добавьте своё выше или попросите Claude научиться на ваших правках.')));
  },

  addCard(D) {
    const vids = D.videos || [];
    if (MEM.scope === 'video' && !MEM.video && vids.length) MEM.video = vids[0].id;
    const ta = h('textarea.box.mem-new', { key: 'mem|add', rows: 3,
      placeholder: 'Например: камера не за спиной у героя, о котором говорят, — лицо или три четверти.',
      oninput: e => { Drafts['mem|add'] = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } } }, Drafts['mem|add'] || '');
    const add = () => {
      const el = $('.mem-new'), t = ((el && el.value) || Drafts['mem|add'] || '').trim();
      if (!t) return UI.toast('Напишите правило', 'err');
      if (MEM.scope === 'video' && !MEM.video) return UI.toast('Выберите видео', 'err');
      if (el) el.value = ''; delete Drafts['mem|add'];
      this.op({ op: 'add', rule: { text: t, scope: MEM.scope, video: MEM.scope === 'video' ? MEM.video : undefined } }, 'Правило добавлено');
    };
    return h('div.mem-add-card',
      h('label.mem-lbl', 'Новое правило'),
      ta,
      h('div.mem-add-row',
        Object.entries(MEM_SCOPE).map(([k, S]) => h('button.mem-scope', { class: MEM.scope === k ? 'on' : '', title: S.hint, onclick: () => { MEM.scope = k; App.render(); } }, Icon(S.icon, 14), S.label)),
        MEM.scope === 'video' && sel(vids.map(v => ({ value: v.id, label: v.name })), MEM.video, x => { MEM.video = x; App.render(); }, { class: 'mem-vsel' }),
        h('span.sp'),
        h('button.mem-addbtn', { onclick: add, title: 'Ctrl+Enter' }, Icon('plus', 14), 'Добавить правило')));
  },

  scopeLabel(r) { return r.scope === 'video' ? (r.videoName || r.video || 'видео') : MEM_SCOPE[r.scope].label; },

  row(r, D) {
    const fresh = r.status === 'new', ed = MEM.edit === r.id;
    const save = (patch) => {
      const t = $(`[data-key="mem|e|${r.id}"]`), w = $(`[data-key="mem|w|${r.id}"]`);
      MEM.edit = null;
      this.op({ op: 'set', id: r.id, rule: { text: t ? t.value.trim() : r.text, why: w ? w.value.trim() : r.why, ...(patch || {}) } }, fresh && patch ? '✓ Правило принято' : 'Сохранено');
    };
    const meta = h('div.mem-meta',
      h('span.mem-sc', { title: MEM_SCOPE[r.scope].hint }, Icon(MEM_SCOPE[r.scope].icon, 13),
        r.scope === 'video' && r.video ? h('a', { href: '#/v/' + r.video }, this.scopeLabel(r)) : this.scopeLabel(r)),
      h('span', fmtDate(r.created)),
      h('span', r.by === 'claude' ? 'предложил Claude' : 'добавили вы'),
      r.from && r.from.video && r.scope !== 'video' && h('a', { href: '#/v/' + r.from.video }, 'из «' + (r.from.name || r.from.video) + '»'),
      r.from && r.from.kind === 'yt' && h('a', { href: '#/yt', title: 'Урок из статистики канала (S17)' }, '📊 из статистики YouTube'));
    const body = ed
      ? h('div.grow', h('textarea.box.mem-ta', { key: 'mem|e|' + r.id, rows: 2 }, r.text), h('input.box.mem-why', { key: 'mem|w|' + r.id, value: r.why || '', placeholder: 'почему (необязательно)' }),
        h('div.mem-edit-row',
          Object.entries(MEM_SCOPE).map(([k, S]) => h('button.mem-scope.small', { class: r.scope === k ? 'on' : '', title: S.hint,
            onclick: () => { if (k === 'video' && !(r.video || (D.videos[0] || {}).id)) return; this.op({ op: 'set', id: r.id, rule: { scope: k, video: k === 'video' ? (r.video || (D.videos[0] || {}).id) : undefined } }); } }, Icon(S.icon, 13), S.label)),
          r.scope === 'video' && sel((D.videos || []).map(v => ({ value: v.id, label: v.name })), r.video, x => this.op({ op: 'set', id: r.id, rule: { scope: 'video', video: x } }), { class: 'mem-vsel' }),
          h('span.sp'),
          h('button.primary.small', { onclick: () => save(fresh ? { status: 'on' } : null) }, fresh ? '✓ Принять' : 'Сохранить'),
          h('button.small', { onclick: () => { MEM.edit = null; App.render(); } }, 'Отмена')))
      : h('div.grow', h('div.mem-t', { title: 'Клик — поправить', onclick: () => { MEM.edit = r.id; App.render(); } }, r.text),
        r.why && h('div.mem-why', r.why), meta);
    const acts = ed ? null : fresh
      ? h('div.mem-acts',
        h('button.primary.small', { onclick: () => this.op({ op: 'set', id: r.id, rule: { status: 'on' } }, '✓ Правило принято — Claude будет его соблюдать') }, '✓ Принять'),
        h('button.small', { onclick: () => { MEM.edit = r.id; App.render(); } }, 'Поправить'),
        h('button.icon', { title: 'Отклонить', onclick: () => this.op({ op: 'del', id: r.id }, 'Отклонено') }, '✕'))
      : h('div.mem-acts',
        h('button.mem-sw', { class: r.status === 'on' ? 'on' : '', title: r.status === 'on' ? 'Действует — выключить' : 'Выключено — включить',
          onclick: () => this.op({ op: 'set', id: r.id, rule: { status: r.status === 'on' ? 'off' : 'on' } }) }, h('i')),
        h('button.icon.del', { title: 'Удалить', onclick: () => confirm('Удалить правило?') && this.op({ op: 'del', id: r.id }) }, Icon('trash', 16)));
    return h('div.mem-row', { class: r.status + (ed ? ' ed' : '') }, body, acts);
  },
};
setInterval(() => { if (Date.now() - MEM.at > 30000 && !document.hidden) Memory.load(); }, 10000);
