// S16. «📐 Карта подачи» — вкладка окна «Сценарий»: референс подачи разложен на биты, автор правит «наш бит», утверждает — по карте пишется сценарий.
// Данные — video.json → beatmap (server/refbase_api.py), задача beatmap (Opus). ТЗ — docs/studio/stage16-refbase.md
const BeatMap = {
  vids: {},
  MODES: [['', 'Авто'], ['same', 'Один в один'], ['compress', 'Длинное → шортс'], ['expand', 'Шортс → длинное']],
  // как сервер (refbase_api.mode_of): выбрал автор — его режим, иначе по длинам референса и брифа (длинное — больше 3 мин)
  autoMode(d) {
    const b = this.base(d) || {}, dur = +((b.parse || {}).dur || b.dur || 0), blen = +((d.brief || {}).len || 0) || dur;
    return dur > 180 && blen <= 180 ? 'compress' : dur <= 180 && blen > 180 ? 'expand' : 'same';
  },                                            // <video> референса живёт между перерисовками — не сбрасывает воспроизведение

  base(d) { return (d.refs || []).find(r => r.role === 'base'); },
  mm(t) { t = +t || 0; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; },
  wc(s) { return (s || '').split(/\s+/).filter(w => /[\p{L}\d]/u.test(w)).length; },

  // подпись перерисовки: окно «Сценарий» не перерисовывается с App.render — только когда меняется то, что видно здесь
  sig(d) {
    const key = 'plan:' + d.id, b = this.base(d) || {}, ps = b.parse || {}, bm = d.beatmap || {};
    return [b.id, d.beatmapMode, ps.status, ps.msg, (ps.base || {}).status, bm.v, bm.status, bm.at, (bm.beats || []).length,
      (bm.beats || []).map(x => ((x.fx || {}).notes || []).length).join('.'), ((bm.fx || {}).notes || []).length,
      !!Claude.running(key, 'beatmap'), b.id && !!Claude.running(key, 'refparse:' + b.id), b.id && !!Claude.running(key, 'refbase:' + b.id)].join('|');
  },

  pane(d) {
    const key = 'plan:' + d.id, b = this.base(d), bm = d.beatmap || {};
    if (!b) return h('div.sw-pane', h('div.empty-state', h('div.es-ico', '📐'), h('b', 'Референса подачи нет'),
      h('p', 'Отметь «📐 За основу» у видео-референса в брифе — Claude разложит его на биты, а ты решишь, чем заменить каждый. Сценарий напишется по этой карте.'),
      (d.refs || []).filter(r => r.kind === 'video').map(r => h('div.row.bm-pickref', h('span', '📼 ' + (r.title || r.url || r.path)),
        h('button.small', { onclick: () => this.setBase(d, r.id, true) }, '📐 За основу')))));
    const ps = b.parse || {}, bs = ps.base || {}, R = bm.rhythm || bs.rhythm || {};
    const job = Claude.running(key, 'beatmap'), parsing = Claude.running(key, 'refparse:' + b.id) || Claude.running(key, 'refbase:' + b.id) || ps.status === 'running' || bs.status === 'running';
    let vid = null;
    if (bs.video) { vid = this.vids[bs.video] || (this.vids[bs.video] = h('video.bm-video', { src: '/' + bs.video, controls: true, playsinline: true, preload: 'metadata' })); }
    const top = h('div.bm-top',
      vid || h('div.bm-novid.dim', parsing ? [h('span.spin'), ' ', ps.msg || 'разбираю…'] : 'видео появится после разбора'),
      h('div.bm-info',
        h('div.row', h('b', '📐 ' + (b.title || ps.title || 'Референс подачи')), b.url && h('a.small', { href: b.url, target: '_blank', rel: 'noopener' }, 'открыть'), h('span.sp'),
          h('button.small.ghost', { title: 'Снять «основу подачи» — сценарий будет писаться как обычно', onclick: () => confirm('Снять референс подачи? Карта останется, но сценарий будет писаться как обычно.') && this.setBase(d, b.id, false) }, 'снять')),
        bm.summary ? h('p.bm-sum', h('b', 'Фишка подачи: '), bm.summary) : h('p.dim', 'Claude разложит ролик на биты: функция, приём, как сказано, текст на экране — и предложит наш бит на каждое место.'),
        h('div.bm-chips',
          R.wps != null && h('span.bm-chip', h('i', 'темп '), `${R.wps} сл/с`),
          R.phrase != null && h('span.bm-chip', h('i', 'фраза '), `~${R.phrase} сл.`),
          R.pauses != null && h('span.bm-chip', h('i', 'пауз '), R.pauses),
          bs.cuts != null && h('span.bm-chip', h('i', 'склеек '), bs.cuts),
          bm.lenRef && h('span.bm-chip', h('i', 'длина '), `${this.mm(bm.lenRef)} → наша ${this.mm(bm.lenOur)}`),
          bs.lang && bs.lang !== 'ru' && h('span.bm-chip', h('i', 'язык '), bs.lang + ' → переведено'),
          bm.v && h('span.bm-chip', h('i', 'версия '), bm.v)),
        this.modeRow(d, key)));
    const beats = bm.beats || [];
    const ok = bm.status === 'ok';
    if (!beats.length) return h('div.sw-pane.bm', top, h('div.bm-empty',
      job ? h('p', h('span.spin'), ' ', job.summary || 'Claude смотрит кадры и раскладывает референс на биты… обычно 3–8 минут')
        : [h('p.dim', parsing ? 'Референс ещё разбирается (слова, кадры с таймкодом) — разложить можно уже сейчас: задача дождётся разбора.' : 'Карты ещё нет.'),
          Claude.btn({ label: 'Разложить референс', action: 'beatmap', key, title: 'Claude (Opus) смотрит кадры, читает фразы, режет на биты и пишет наш бит на каждое место. Факты для нашей темы ищет в интернете' })]));
    const nNotes = beats.reduce((n, x) => n + ((x.fx || {}).notes || []).length, 0) + ((bm.fx || {}).notes || []).length;
    return h('div.sw-pane.bm', top,
      ok && h('div.bm-ok', Icon('check', 14), ` Карта утверждена ${bm.okAt ? fmtDate(bm.okAt) : ''} — сценарий пишется по ней. Правишь карту — утверди снова и перепиши сценарий.`),
      h('table.bm-table', h('thead', h('tr', h('th', 'время'), h('th', 'их бит'), h('th'), h('th', 'наш бит'), h('th'))),
        h('tbody', beats.flatMap((x, i) => {
          const ch = x.chapter || '', prev = i ? beats[i - 1].chapter || '' : null;
          const head = ch !== prev && (ch || i) ? h('tr.bm-ch', h('td', { colspan: 5 }, ch ? '📖 Глава: ' + ch : 'Без главы')) : null;
          return [head, this.row(d, key, x, i)].filter(Boolean);
        }))),
      h('div.bm-foot',
        h('div.bm-gen', ((bm.fx || {}).notes || []).map(n => h('span.bm-note', '📌 ' + n.text, h('button.icon', { title: 'Убрать', onclick: () => { Store.del(key, ['beatmap', 'fx', 'notes'], n.id, false); this.redraw(); } }, '×'))),
          this.noteInput(key, ['beatmap', 'fx', 'notes'], 'Правка в целом — Enter: тон, порядок, что выкинуть…')),
        h('div.row',
          job ? Claude.btn({ label: 'Переразложить', action: 'beatmap', key })
            : Claude.btn({ label: nNotes ? `Переразложить (${nNotes} ${plural(nNotes, 'правка', 'правки', 'правок')})` : 'Переразложить', action: 'beatmap', key,
              title: 'Новая версия карты: правки 📌 и «в целом» учтутся, биты с 🔒 (ты правил руками) останутся как есть',
              confirm: nNotes ? null : 'Правок нет — Claude разложит заново с нуля (биты с 🔒 останутся). Продолжить?' }),
          h('span.sp'),
          ok ? h('button', { onclick: () => this.write(d) }, '✍️ Переписать сценарий по карте')
            : h('button.primary', { disabled: !!job, onclick: () => this.approve(d) }, Icon('check', 14), 'Утвердить карту и написать сценарий'))));
  },

  modeRow(d, key) {
    const want = d.beatmapMode || '', auto = this.autoMode(d), bm = d.beatmap || {}, M = Object.fromEntries(this.MODES);
    const stale = (bm.beats || []).length && (bm.mode || 'same') !== (want || auto);
    return h('div.bm-mode',
      h('span.dim.small', 'Режим:'),
      h('div.seg', this.MODES.map(([k, l]) => h('button', { class: want === k ? 'sel' : '', title: k ? '' : `Сейчас: ${M[auto]} — по длине референса и брифа`,
        onclick: () => { Store.set(key, ['beatmapMode'], k || null); this.redraw(); } }, k ? l : `Авто: ${M[auto].toLowerCase()}`))),
      stale && h('span.bm-stale', '⚠ карта сделана в режиме «' + M[bm.mode || 'same'] + '» — «Переразложить» разложит заново'));
  },

  row(d, key, x, i) {
    const o = x.our || {}, P = ['beatmap', 'beats', x.id];
    const tg = x.target || x.words || 0, n = this.wc(o.vo), bad = tg && n && Math.abs(n - tg) > Math.max(1, tg * 0.2);   // бюджет слов: их слова × (наша длина / их длина)
    const edit = (f, v) => { Store.set(key, [...P, 'our', f], v); if (!x.lock) { x.lock = true; Store.set(key, [...P, 'lock'], true); const l = document.querySelector(`[data-bmlock="${x.id}"]`); if (l) l.hidden = false; } };
    const vo = h('textarea.box.auto', { key: `bm|${d.id}|${x.id}|vo`, rows: 2, placeholder: '— нет пары —', oninput: e => { edit('vo', e.target.value); autosize(e.target);
      const w = e.target.closest('td').querySelector('.bm-wc'); if (w) { const k = this.wc(e.target.value); w.textContent = `${k} из ${tg} сл.`; w.classList.toggle('bad', !!(tg && k && Math.abs(k - tg) > Math.max(1, tg * 0.2))); } } });
    vo.value = o.vo || '';
    const notes = (x.fx || {}).notes || [];
    return h('tr', { class: x.lock ? 'locked' : '' },
      h('td.bm-tc', h('a', { href: '#', title: 'Проиграть этот бит референса', onclick: e => { e.preventDefault(); this.seek(d, x.t0); } }, `${this.mm(x.t0)}–${this.mm(x.t1)}`),
        h('span.bm-our', `наш ${this.mm(x.ot0)}–${this.mm(x.ot1)}`), h('span.bm-n', '#' + (i + 1))),
      h('td.bm-their', h('div.bm-fn', x.fn), h('div.bm-dev', x.device),
        (x.voRu || x.vo) && h('div.bm-q', '«' + (x.voRu || x.vo) + '»', x.voRu && x.vo && h('span.bm-orig', x.vo)),
        x.screen && h('span.bm-scr', x.screen)),
      h('td.bm-arrow', '→'),
      h('td.bm-ours',
        h('div.bm-lbl', h('span.bm-lock', { 'data-bmlock': x.id, hidden: !x.lock, title: 'Ты правил этот бит — «Переразложить» его не тронет' }, '🔒'), 'голос',
          h('span.bm-wc', { class: bad ? 'bad' : '', title: `Бюджет: у них ${x.words || 0} сл. × длина нашего / их ролика` }, `${n} из ${tg} сл.`)),
        vo,
        h('div.bm-lbl', 'текст на экране'),
        h('input.box.bm-scrin', { key: `bm|${d.id}|${x.id}|scr`, value: o.screen || '', placeholder: x.screen ? 'у них был — нужен аналог' : '— у них не было —', oninput: e => edit('screen', e.target.value) }),
        o.note && h('div.bm-src', { class: /^нет пары/i.test(o.note) ? 'warn' : '' }, (/^нет пары/i.test(o.note) ? '⚠ ' : '') + o.note),
        notes.map(nn => h('div.bm-pinnote', '📌 ' + nn.text, h('button.icon', { title: 'Убрать', onclick: () => { Store.del(key, [...P, 'fx', 'notes'], nn.id, false); this.redraw(); } }, '×'))),
        this.noteInput(key, [...P, 'fx', 'notes'], '📌 правка к биту для Claude — Enter', true)),
      h('td.bm-pin'));
  },

  noteInput(key, path, ph, small) {
    return h('input.box.bm-noteinp', { class: small ? 'small' : '', key: key + '|' + path.join('.') + '|new', placeholder: ph,
      onkeydown: e => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        e.preventDefault();
        Store.add(key, path, { id: uid('n'), text: e.target.value.trim() }, false);
        e.target.value = '';
        this.redraw();
      } });
  },

  seek(d, t) {
    const b = this.base(d), v = b && this.vids[((b.parse || {}).base || {}).video];
    if (!v) return UI.toast('Видео референса ещё не готово');
    v.currentTime = Math.max(0, (+t || 0) - 0.1); v.play().catch(() => {});
  },

  async setBase(d, rid, on) {
    try { await api('POST', '/api/refs/base', { key: 'plan:' + d.id, ref: rid, on }); await Store.load('plan:' + d.id, true); this.redraw(); App.render(); }
    catch (e) { UI.toast(e.message, 'err'); }
  },

  async approve(d) {
    const key = 'plan:' + d.id, bm = (Store.get(key) || {}).beatmap || {};
    const empty = (bm.beats || []).filter(x => !((x.our || {}).vo || '').trim() && !((x.our || {}).screen || '').trim()).length;
    if (empty && !confirm(`${empty} ${plural(empty, 'бит', 'бита', 'битов')} без пары — Claude решит по заметке (вариант или убрать). Утвердить?`)) return;
    try {
      await Store.flushAll();
      await api('POST', '/api/beatmap/ok', { key, on: true });
      await Store.load(key, true);
      UI.toast('✓ Карта утверждена — Claude пишет сценарий по ней');
      this.write(Store.get(key));
    } catch (e) { UI.toast(e.message, 'err'); }
  },

  write(d) {
    if (!window.AgentPanel) return;
    AgentPanel.toggle(true);
    AgentPanel.say('📐 Напиши сценарий ПО КАРТЕ ПОДАЧИ (beatmap show — я её утвердил): одна сцена на бит, голос и текст на экране — из «наш бит», картинку придумай сам. ' +
      'Шапка: «по референсу: <ссылка>», rate под темп референса. Ресерч (research.md) — для фактов, если его ещё нет. Потом montage check (сверка с картой) и montage tts.', { mode: 'script', model: 'opus' });
    if (typeof ScriptWin !== 'undefined' && SW.el) ScriptWin.go('board');
  },

  redraw() { if (typeof ScriptWin !== 'undefined' && SW.el && SW.tab === 'beatmap') { this.last = null; ScriptWin.draw(); } },
};
