// Claude Studio — S12.10: вкладки стиля канала «Обзор», «Подачи», «Визуалы» (docs/studio/stage12-redesign.md §10.2).
// Данные — channel.json: refs[] {id, img|url, note}, deliveries[] {id, key, label, desc}, looks[] {id, key, label, desc, engine, refs[]};
// пусто — берутся стартовые из ref.json. Поп-ап «Новое видео» и бриф (videos_api.brief_text) берут списки канала.
'use strict';

const Styles = {
  deliveries(cid) { const d = Store.get('channel:' + (cid || (App.info.channel || {}).id)); return (d && (d.deliveries || []).length ? d.deliveries : REF.deliveries) || []; },
  looks(cid) { const d = Store.get('channel:' + (cid || (App.info.channel || {}).id)); return ((d && (d.techniques || (d.looks || []).length) ? d.looks || [] : REF.looks) || []).filter(x => !x.draft); },   // S14: у канала с техниками — только его луки (без шаблонов); черновики — не в выбор
  // первый раз — стартовые из ref.json становятся списком канала (дальше их правят тут)
  seed(ckey, d, field) {
    if ((d[field] || []).length) return;
    Store.set(ckey, [field], (REF[field] || []).map(x => ({ id: uid(field[0]), ...x, refs: x.refs || [] })), true);
  },
  async upImg(cid, file) {
    const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); });
    return (await api('POST', '/api/channel/upload', { channel: cid, kind: 'ref', name: file.name, data })).f;
  },
  refGrid(C, ckey, path, refs, o = {}) {   // o.range — у видео поля «с» и «по» (S14: кусок референса для визуала)
    const pick = () => { const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: async () => {
      for (const f of inp.files) { try { const p = await this.upImg(C.id, f); Store.add(ckey, path, { id: uid('r'), img: p, note: '' }, true); } catch (e) { UI.toast(e.message, 'err'); } }
    } }); inp.click(); };
    const take = async files => { for (const f of files) { try { const p = await this.upImg(C.id, f); Store.add(ckey, path, { id: uid('r'), img: p, note: '' }, true); } catch (e) { UI.toast(e.message, 'err'); } } };
    return h('div.st-refs', { tabindex: 0, title: 'Ctrl+V — вставить картинку, можно перетащить файлы',   // S14: вставка и перетаскивание картинок на полку
        onpaste: e => { const fs = [...(e.clipboardData || {}).files || []].filter(f => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); take(fs); } },
        ondragover: e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
        ondragleave: e => e.currentTarget.classList.remove('over'),
        ondrop: e => { const fs = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')); e.currentTarget.classList.remove('over'); if (fs.length) { e.preventDefault(); e.stopPropagation(); take(fs); } } },
      refs.map(r => h('div.st-ref',
        r.img ? h('img', { src: `/api/channel/file?channel=${C.id}&f=${encodeURIComponent(r.img)}`, onclick: e => UI.lightbox(e.target.src) })
          : h('a.st-link', { href: r.url, target: '_blank', rel: 'noopener' }, Icon('film', 18), h('span', r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))),
        line(ckey, [...path, r.id, 'note'], { cls: 'box', ph: 'что взять' }),
        o.range && r.url && h('div.st-range', line(ckey, [...path, r.id, 'from'], { cls: 'box', ph: 'с 0:00' }), line(ckey, [...path, r.id, 'to'], { cls: 'box', ph: 'по конец' })),
        h('button.icon.del', { title: 'Убрать', onclick: () => Store.del(ckey, path, r.id) }, Icon('x', 13)))),
      h('div.st-ref.add', h('button', { onclick: pick }, Icon('image', 15), 'Картинки'),
        draftInput(ckey + '|' + path.join('.') + '|url', { class: 'box', placeholder: 'ссылка на видео / страницу — Enter',
          onkeydown: e => { if (e.key === 'Enter' && /^https?:\/\//.test(e.target.value.trim())) { Store.add(ckey, path, { id: uid('r'), url: e.target.value.trim(), note: '' }, true); e.target.value = ''; delete Drafts[ckey + '|' + path.join('.') + '|url']; } } })));
  },
};

Object.assign(Pages, {
  // 🧭 Обзор: о канале, референсы (фото, видео), стайл-гайд — ссылкой
  chOverview(C, d, ckey) {
    const setTop = (k, v) => { Store.set(ckey, [k], v, true); setTimeout(() => App.refreshState(), 700); };   // иконка и язык видны в шапке и списке каналов
    return [
      h('section.card.ch-basics',
        h('div.nv-field.nc-icon', h('label', 'Иконка'), iconPicker('ov', d.icon || '', v => setTop('icon', v))),
        h('div.nv-field.nc-lang', h('label', 'Язык роликов'),
          sel(CH_LANGS.map(([value, label]) => ({ value, label })), d.lang || 'ru', v => setTop('lang', v), { class: 'box' })),
        h('p.hint', 'На языке роликов Claude пишет названия, сценарий, озвучку, субтитры и обложки. С тобой он говорит по-русски. Голос диктора — во вкладке «Голос и субтитры».')),
      h('section.card', h('div.card-head', h('h3', 'О канале'), h('span.dim.small', 'одной-двумя фразами — Claude читает это во всех кнопках ✨ и в агенте')),
        area(ckey, ['about'], { cls: 'box', ph: 'Бумажная аппликация: наш серый ёжик из рваных полосок, техно-новости и истории…' })),
      h('section.card', h('div.card-head', h('h3', 'Референсы канала'), h('span.dim.small', 'картинки и ссылки на видео — как должно выглядеть и звучать; «что взять» — коротко')),
        Styles.refGrid(C, ckey, ['refs'], d.refs || [])),
      h('section.card.row', h('span', 'Подробный стайл-гайд, палитра, голос, герой, правила — на соседних вкладках. Как пишутся сценарии — «Подачи», как выглядят ролики — «Визуалы».'))];
  },
  // ✍️ Подачи — как пишется сценарий (инфоповод, история, сюжет…)
  chDeliveries(C, d, ckey) {
    Styles.seed(ckey, d, 'deliveries');
    const L = d.deliveries || [];
    return [h('section.card', h('div.card-head', h('h3', 'Подачи'), h('span.dim.small', 'как пишется сценарий — выбирается в поп-апе «Новое видео»; описание уходит Claude в бриф')),
      h('div.st-list', L.map(x => h('div.st-item',
        h('div.row', line(ckey, ['deliveries', x.id, 'label'], { cls: 'box st-name', ph: 'название' }), h('span.dim.small', x.key === 'auto' ? 'Claude выберет сам' : ''), h('span.sp'),
          x.key !== 'auto' && h('button.icon.del', { title: 'Удалить подачу', onclick: () => confirm(`Удалить «${x.label}»?`) && Store.del(ckey, ['deliveries'], x.id) }, Icon('trash', 14))),
        area(ckey, ['deliveries', x.id, 'desc'], { cls: 'box', ph: 'схема: хук → … → кода; темп, интонация, что обязательно' })))),
      addLine('+ подача: название — Enter', t => Store.add(ckey, ['deliveries'], { id: uid('d'), key: 'd' + Date.now().toString(36), label: t, desc: '' }), ckey + '|adddl'))];
  },
  // 🎨 Визуалы — ui/looks.js (S14: техники → луки)
});
