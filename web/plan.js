// Claude Studio — общие помощники карточек препродакшена: правки «в целом» списком, пины на картинке.
// Вкладки «Штурма» (идеи, биты, название, образы, структура, итоги) убраны в S12.11 — данные в video.json остались; экраны видео — ui/workspace.js и его панели (ui/panels.js).
'use strict';

const fxCount = e => (e && e.pins ? e.pins.length : 0) + (e && e.pins3d ? e.pins3d.length : 0) + (e && (e.text || '').trim() ? 1 : 0) + ((e && e.notes) || []).filter(n => (n.text || '').trim()).length;

// «В целом» as a stack of separate edits (fx.<part>.notes[]): Enter in an item adds the next one, Backspace in an empty one removes it.
// redraw — for a modal that App.render does not repaint (the cover edits); the page re-renders itself otherwise.

function noteList(key, P, ph, redraw) {
  const part = getPath(Store.get(key), P) || {}, notes = part.notes || [];
  const kOf = id => key + '|' + [...P, 'notes', id, 'text'].join('.'), addKey = key + '|addnote|' + P.join('.');
  const focusKey = k => { const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`); if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); } };   // the DOM is already repainted
  const repaint = () => (redraw ? redraw() : App.render());
  const add = (at, text = '', focus = true) => {
    const id = uid('n');
    Store.op(key, { op: 'add', path: [...P, 'notes'], item: { id, text }, at }, false);
    repaint(); focusKey(focus ? kOf(id) : addKey);
  };
  return h('div.notelist',
    (part.text || '').trim() && h('div.noterow', h('span.nnum', '•'), area(key, [...P, 'text'], { cls: 'box' })),   // the old single field, kept while it has text
    notes.map((n, i) => {
      const inp = line(key, [...P, 'notes', n.id, 'text'], { cls: 'box', ph: 'правка — Enter: следующая' });
      inp.setAttribute('aria-label', `Правка в целом ${i + 1}`);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); add(i + 1); }
        else if (ev.key === 'Backspace' && !inp.value) {
          ev.preventDefault();
          Store.del(key, [...P, 'notes'], n.id, false); repaint();
          focusKey(i > 0 ? kOf(notes[i - 1].id) : addKey);
        }
      });
      return h('div.noterow', h('span.nnum', i + 1), inp,
        h('button.icon.del', { title: 'Убрать правку', onclick: () => { Store.del(key, [...P, 'notes'], n.id, false); repaint(); } }, '×'));
    }),
    addLine(ph + ' — Enter (каждая правка — отдельным пунктом, можно @)', t => add(notes.length, t, false), addKey));
}

const pinMarks = e => ((e && e.pins) || []).map((p, i) => h('span.pin', { style: { left: p.x * 100 + '%', top: p.y * 100 + '%' }, title: p.text || '' }, i + 1));

const Plan = {};                                      // методы карточек — idea.js (препродакшен), studio.js (голос), ui/preprod.js, ui/panels.js
