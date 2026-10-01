// Claude Studio — этап «📦 Упаковка» (S8, docs/studio/stage8-review-pack.md): обложки (концепты и «🎨 Отрисовать» — plan.js) + выгрузка в проект,
// тексты (✨ packtext: 5 названий по углам атаки, 3 описания, закреп, хэштеги, «Права» из лицензий) -> video.json → pack и out/packaging.md проекта.
'use strict';

const Pack = {
  async md(d, quiet) {
    try { const r = await api('POST', '/api/pack/md', { video: d.id }); if (!quiet) UI.toast(r.md ? '📄 out/packaging.md обновлён' : 'Нет проекта ролика — сначала «🚀 Начать производство»'); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  async covers(d) {
    try { const r = await api('POST', '/api/pack/covers', { video: d.id }); UI.toast('📤 В проект: ' + r.covers.join(', ')); Store.load('plan:' + d.id, true).then(() => App.render()); }
    catch (e) { UI.toast(e.message, 'err'); }
  },
  texts(d, key) {
    const p = d.pack || {}, has = (p.titles || []).length > 0;
    const field = (label, k, rows = 3) => h('div.pk-field', h('label', label), area(key, ['pack', k], { cls: 'box' }));
    return h('section.card.pk',
      h('div.card-head', h('h3', '📝 Тексты'), p.at && h('span.dim.small', 'обновлены ' + new Date(p.at).toLocaleString().slice(0, 17)), h('span.sp'),
        Claude.btn({ label: has ? 'Переписать' : 'Написать', action: 'packtext', key, scope: 'packtext', title: 'Claude: 5 названий по углам атаки, 3 описания, закреп, хэштеги, «Права» — по сценарию и тому, что вошло в ролик',
          onResult: () => this.md(d, true) }),
        d.project && h('button', { onclick: () => this.md(d), title: 'Записать тексты и права в out/packaging.md проекта' }, '📄 packaging.md')),
      !has ? h('div.empty', 'Нажми «✨ Написать» — Claude соберёт названия, описания, закреп, хэштеги и «Права» (их источники — лицензии звуков, библиотеки и ассетов, которые вошли в ролик).')
        : [
          h('div.pk-titles', h('label', 'Названия (★ — лучшее, клик — сделать лучшим)'),
            p.titles.map((t, i) => h('div.row.pk-t',
              h('button.icon', { class: t.best ? 'sel' : '', title: 'Лучшее', onclick: () => Store.set(key, ['pack', 'titles'], p.titles.map((x, j) => ({ ...x, best: j === i })), true) }, t.best ? '★' : '☆'),
              h('input.box.grow', { value: t.text, oninput: ev => { const T = p.titles.map(x => ({ ...x })); T[i].text = ev.target.value; Store.set(key, ['pack', 'titles'], T); } }),
              h('span.dim.small', `${(t.text || '').length} зн.`), t.angle && h('span.dim.small', '· ' + t.angle)))),
          field('Короткое описание (Shorts / Reels)', 'short', 2), field('С источниками', 'sources', 4), field('Провокация для комментариев', 'provoke', 2),
          field('Закреп в комментариях', 'pin', 2),
          h('div.pk-field', h('label', 'Хэштеги'), h('input.box', { value: (p.tags || []).join(' '), oninput: ev => Store.set(key, ['pack', 'tags'], ev.target.value.split(/\s+/).filter(Boolean)) })),
          field('Права', 'rights_md', 6),
        ]);
  },
  coversCard(d, key) {
    const n = (d.thumbs || []).filter(c => (c.renders || []).length).length, out = (d.pack || {}).covers || [];
    return h('section.card', h('div.card-head', h('h3', '🖼 Обложки'), h('span.dim.small', n ? `отрисовано концептов: ${n}` : 'концепты и «🎨 Отрисовать» — ниже'), h('span.sp'),
      d.project && h('button', { disabled: !n, onclick: () => this.covers(d), title: 'Текущая версия каждой отрисованной обложки (выбранная связка — первой) -> out/thumbnail_N.png и .jpg проекта' }, '📤 Обложки в проект')),
      out.length > 0 && h('p.dim.small', 'В проекте: ' + out.map(x => 'out/' + x).join(', ')));
  },
};

Object.assign(Plan, {
  pack(d, key, M) {
    return [
      Pack.texts(d, key),
      Pack.coversCard(d, key),
      Plan.thumbs(d, key, M),
    ];
  },
});
