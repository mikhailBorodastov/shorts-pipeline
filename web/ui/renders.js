// Claude Studio — S12.8: окно «Экспорт» и раздел «Рендеры» (docs/studio/stage12-redesign.md §9).
// Очередь рендеров — на сервере (render_api.py), по одному; окно можно свернуть — рендер идёт дальше, в конце уведомление Windows.
'use strict';

const RND = { data: null, busy: false, at: 0, seenDone: new Set(), first: true };
const fmtT = s => (s == null ? '' : s < 60 ? Math.round(s) + ' с' : `${Math.floor(s / 60)} мин ${String(Math.round(s % 60)).padStart(2, '0')} с`);
const fmtMB = b => (b > 1e9 ? (b / 1e9).toFixed(2) + ' ГБ' : (b / 1e6).toFixed(1) + ' МБ');

const Renders = {
  async load() {
    if (RND.busy) return; RND.busy = true;
    try {
      const r = await api('GET', '/api/renders');
      for (const x of r.recent || []) {                     // только что закончился — тост в приложении
        if (!RND.first && !RND.seenDone.has(x.rid) && x.finished && Date.now() - x.finished < 15000)
          UI.toast(x.status === 'done' ? `🎬 Рендер готов: out/${x.name}.mp4` : x.status === 'error' ? 'Рендер не получился: ' + (x.error || '').slice(-120) : 'Рендер отменён', x.status === 'error' ? 'err' : 'ok');
        RND.seenDone.add(x.rid);
      }
      RND.first = false;
      const was = JSON.stringify((RND.data || {}).queue), now = JSON.stringify(r.queue);
      RND.data = r; RND.at = Date.now();
      if (was !== now || App.route.page === 'renders') { App.render(); ExportDlg.draw(); }
    } catch {}
    RND.busy = false;
  },
  active() { return ((RND.data || {}).queue || []); },
  of(vid) { return this.active().find(x => x.vid === vid); },

  // ---------------- раздел «Рендеры» ----------------
  page() {
    if (!RND.data || Date.now() - RND.at > 5000) this.load();
    const D = RND.data || { queue: [], recent: [], done: [] };
    const fails = (D.recent || []).filter(x => x.status === 'error').slice(-3).reverse();
    return h('div.page.renders-page',
      h('div.page-head', h('div.grow', h('h1', 'Рендеры'), h('p.sub', 'Очередь экспорта и готовые ролики канала. Рендер идёт по одному — видеокарта одна.'))),
      D.queue.length > 0 && h('section.rq', h('div.ws-sec', 'Очередь'), D.queue.map(x => this.qRow(x))),
      fails.length > 0 && h('section.rq', h('div.ws-sec', 'Не получилось'), fails.map(x => h('div.rq-row.err', h('b', x.video), h('span.dim.small', (x.error || '').slice(-200))))),
      h('div.ws-sec', 'Готовые', h('span.cnt', String(D.done.length))),
      D.done.length ? h('div.rgrid', D.done.map(x => this.card(x)))
        : h('div.empty-state', h('div.es-ico', Icon('film', 24)), h('b', RND.data ? 'Готовых роликов пока нет' : 'Загружаю…'), h('p', 'Экспорт — белая кнопка в шапке окна видео.')));
  },
  qRow(x) {
    const pct = x.total ? Math.round(x.done / x.total * 100) : 0;
    return h('div.rq-row',
      h('div.grow', h('div.row', h('b', x.video), h('span.dim.small', `→ out/${x.name}.mp4 · ${x.fps} fps`), h('span.sp'), h('span.small', x.status === 'queued' ? 'в очереди' : x.phase)),
        h('div.pbar', h('i', { style: { width: (x.status === 'queued' ? 0 : x.phase === 'кадры' || x.phase === 'склейка' || x.phase === 'файлы для YouTube' ? pct : 3) + '%' } })),
        h('div.dim.small', x.total ? `${x.done} / ${x.total} кадров · ${x.fpsr || 0} fps · ≈ ${fmtT(x.eta)} осталось` : x.status === 'queued' ? 'ждёт своей очереди' : x.phase + '…')),
      h('button.small', { onclick: () => this.cancel(x) }, 'Отменить'));
  },
  card(x) {
    const q = `vid=${x.vid}&file=${encodeURIComponent(x.file)}`;
    return h('div.rcard',
      h('div.rc-pic', { class: x.mode, onclick: () => this.play(x) }, h('img', { src: `/api/renders/thumb?${q}&m=${x.mtime}`, alt: '', loading: 'lazy' }), h('span.rc-play', '▶'),
        h('span.vc-len', `${Math.floor(x.dur / 60)}:${String(Math.round(x.dur % 60)).padStart(2, '0')}`)),
      h('div.rc-body', h('b', x.file.replace(/\.mp4$/, '')), h('div.dim.small', x.video),
        h('div.dim.small', [new Date(x.mtime).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), x.w ? `${x.w}×${x.h}` : '', fmtMB(x.size)].filter(Boolean).join(' · ')),
        h('div.rc-foot', x.srt && h('span.pill', '.srt'), x.txt && h('span.pill', '.txt'), h('span.sp'),
          h('button.icon', { title: 'Показать в проводнике', onclick: () => api('POST', '/api/renders/open', { vid: x.vid, file: x.file }).catch(e => UI.toast(e.message, 'err')) }, Icon('folder', 15)),
          h('button.icon', { title: 'Открыть видео', onclick: () => go('#/v/' + x.vid) }, Icon('clapper', 15)),
          h('button.icon.del', { title: 'Удалить ролик (в _archive)', onclick: () => this.del(x) }, Icon('trash', 15)))));
  },
  play(x) { UI.modal(x.file, h('video.rc-video', { controls: true, autoplay: true, src: `/api/renders/file?vid=${x.vid}&file=${encodeURIComponent(x.file)}` }), { wide: x.mode === 'long' }); },
  async del(x) {
    if (!confirm(`Удалить «${x.file}»? Ролик и его .srt / .txt / обложка уйдут в _archive/renders.`)) return;
    try { await api('POST', '/api/renders/delete', { vid: x.vid, file: x.file }); RND.data = null; this.load(); } catch (e) { UI.toast(e.message, 'err'); }
  },
  async cancel(x) { try { await api('POST', '/api/renders/cancel', { rid: x.rid }); this.load(); } catch (e) { UI.toast(e.message, 'err'); } },
};

// ---------------- окно «Экспорт» ----------------
const ExportDlg = {
  el: null, d: null, f: null, ch: null,
  open(d) {
    this.d = d;
    const own = Renders.of(d.id);
    this.f = { name: (own && own.name) || (d.name || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '_'), srt: true, fps: d.mode === 'long' ? 30 : 60 };   // длинное — 30 fps: 10–20 минут рендерятся вдвое быстрее
    this.ch = null;
    this.el = h('div.nv', { onmousedown: e => { if (e.target === this.el) this.close(); } });
    document.body.append(this.el);
    this.esc = e => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this.esc);
    this.draw();
    api('GET', '/api/renders/chapters?id=' + d.id).then(r => { this.ch = r; this.draw(); }).catch(() => {});
  },
  close() { if (!this.el) return; this.el.remove(); this.el = null; document.removeEventListener('keydown', this.esc); },
  draw() {
    if (!this.el) return;
    const d = this.d, f = this.f, run = Renders.of(d.id), long = d.mode === 'long', size = long ? '1920×1080' : '1080×1920';
    const nameInp = h('input.box', { value: f.name, disabled: !!run, oninput: e => { f.name = e.target.value; } });
    const body = [
      h('div.nv-field', h('label', 'Имя файла'), nameInp,
        h('p.hint', `${size} · ${f.fps} fps · H.264 на видеокарте · голос, звуки и музыка. Сохраняется в out/ папки видео вместе с обложкой и текстом для YouTube.`)),
      h('div.nv-row',
        h('div.nv-field', h('label', 'Кадров в секунду'), h('div.seg', [[60, '60 — плавнее'], [30, '30 — вдвое быстрее']].map(([v, l]) => h('button', { class: f.fps === v ? 'sel' : '', disabled: !!run, onclick: () => { f.fps = v; this.draw(); } }, l)))),
        h('div.nv-field', h('label', 'Субтитры'), h('label.ws-chk', h('input', { type: 'checkbox', checked: f.srt, disabled: !!run, onchange: e => { f.srt = e.target.checked; } }), 'сохранить .srt рядом с видео (YouTube их любит)'))),
      h('details.ex-ch', { open: long },
        h('summary', 'Главы YouTube', h('span.dim', long ? '' : ' — для длинных видео')),
        this.ch ? [h('pre.ex-pre', this.ch.text || '(сцен ещё нет)'), h('p.hint', this.ch.from === 'script' ? 'Из сценария: заголовки «## Глава …». Сохранятся в out/ (_chapters.txt и в описании).' : 'По сценам монтажа. Свои главы — заголовки «## Глава 1. Название» в сценарии перед сценами.'),
          !this.ch.ok && h('p.hint', 'YouTube покажет главы, если их хотя бы 3 и каждая не короче 10 с.'),
          h('button.small', { onclick: () => UI.copy(this.ch.text) }, Icon('book', 13), 'Скопировать')] : h('p.dim.small', 'считаю…')),
    ];
    if (run) {
      const pct = run.total ? Math.round(run.done / run.total * 100) : 0;
      body.push(h('div.ex-prog', h('div.pbar', h('i', { style: { width: (run.status === 'queued' ? 0 : pct || 3) + '%' } })),
        h('div.dim.small', run.status === 'queued' ? 'в очереди — дождётся другого рендера' : run.total ? `${run.done} / ${run.total} кадров · ${run.fpsr || 0} fps · ≈ ${fmtT(run.eta)} осталось · ${run.phase}` : run.phase + '…')));
    }
    const el = this.el, saved = ScrollKeep.save(el);
    el.replaceChildren(h('div.nv-box',
      h('div.nv-head', h('h3', 'Экспорт видео'), h('span.dim.small', d.name), h('span.sp'), h('button.icon', { onclick: () => this.close(), title: 'Закрыть (Esc)' }, Icon('x', 16))),
      h('div.nv-body', body),
      h('div.nv-foot',
        run ? [h('button', { onclick: () => Renders.cancel(run) }, 'Отменить экспорт'), h('span.sp'),
          h('button', { onclick: () => { this.close(); UI.toast('Рендер идёт — следите в «Рендерах», придёт уведомление'); }, title: 'Окно закроется, рендер продолжится' }, 'Свернуть'),
          h('button.primary', { disabled: true }, h('span.spin'), ' Экспорт')]
          : [h('span.sp'), h('button', { onclick: () => this.close() }, 'Закрыть'),
            h('button.primary', { onclick: () => this.go() }, Icon('download', 15), 'Экспорт')])));
    ScrollKeep.restore(el, saved);
  },
  async go() {
    try {
      await Store.flushAll();
      await api('POST', '/api/renders/start', { id: this.d.id, name: this.f.name, srt: this.f.srt, fps: this.f.fps });
      await Renders.load(); this.draw();
    } catch (e) { UI.toast(e.message, 'err'); }
  },
};

// опрос очереди: часто, пока что-то рендерится; редко — иначе
setInterval(() => { if (Renders.active().length || App.route.page === 'renders' || ExportDlg.el || Date.now() - RND.at > 20000) Renders.load(); }, 1500);
