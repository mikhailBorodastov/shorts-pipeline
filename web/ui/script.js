// Claude Studio — S12.5: окно «Сценарий» (docs/studio/stage12-redesign.md §6).
// Раскадровка — страница проекта src/script.html?embed (сцены, правки 🔎 ✍️ 🎨 💬, замены, голос по сценам; логика — script_api.py проекта),
// вокруг — рамка Studio: вкладки «Раскадровка · Ресерч и источники · Версии», итоги, «Открыть файл · Скопировать для TTS · Применить правки · Сохранить».
'use strict';

const SW = { el: null, vid: null, tab: 'board', st: {}, url: null, frame: null, research: null, vers: null, ver: null, err: '' };

// markdown ресерча: заголовки, списки, ссылки, **жирный**, `код`, таблицы
function mdDoc(src) {
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(«])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)»]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const L = String(src || '').split('\n'), out = [];
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    let m;
    if (/^\s*```/.test(l)) {                            // блок кода — как есть
      const code = []; i++;
      while (i < L.length && !/^\s*```/.test(L[i])) code.push(L[i++]);
      out.push(`<pre class="mdcode">${esc(code.join('\n'))}</pre>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) out.push('<hr>');
    else if ((m = /^(#{1,4})\s+(.+)$/.exec(l))) out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    else if (/^\s*\|/.test(l)) {
      const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++]); i--;
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      out.push('<table>' + rows.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r, k) => '<tr>' + cells(r).map(c => k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join('') + '</tr>').join('') + '</table>');
    } else if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
      const ol = /^\s*\d/.test(l), items = [];
      while (i < L.length && /^\s*([-*]|\d+[.)])\s+/.test(L[i])) items.push(L[i++].replace(/^\s*([-*]|\d+[.)])\s+/, '')); i--;
      out.push(`<${ol ? 'ol' : 'ul'}>` + items.map(x => `<li>${inline(x)}</li>`).join('') + `</${ol ? 'ol' : 'ul'}>`);
    } else if (/^\s*>/.test(l)) out.push(`<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}

const ScriptWin = {
  open(d, tab) {
    if (SW.el) this.close(true);
    const bm = typeof BeatMap !== 'undefined' && BeatMap.base(d) && (d.beatmap || {}).status !== 'ok';   // S16: референс подачи, карта не утверждена — начинаем с неё
    Object.assign(SW, { vid: d.id, tab: tab || (bm ? 'beatmap' : 'board'), st: {}, url: null, frame: null, research: null, vers: null, ver: null, err: '' });
    SW.el = h('div.sw');
    document.body.append(SW.el);
    this.draw();
    api('POST', '/api/videos/scriptsnap', { id: d.id, why: 'открыт в студии' }).catch(() => {});
    api('POST', '/api/studio/project', { id: d.id, page: 'script' }).then(r => {
      SW.url = r.url + (r.url.includes('?') ? '&' : '?') + 'embed';
      SW.frame = h('iframe.sw-frame', { src: SW.url, title: 'Раскадровка сценария' });
      const slot = SW.el && SW.el.querySelector('.sw-board'); if (slot) slot.replaceChildren(SW.frame);   // один раз — дальше iframe не трогаем
    }).catch(e => { SW.err = e.message; this.draw(); });
    this.esc = e => { if (e.key === 'Escape' && SW.el && !document.querySelector('.modal')) this.close(); };
    document.addEventListener('keydown', this.esc);
  },
  close(quiet) {
    if (!SW.el) return;
    this.cmd('flush');
    const vid = SW.vid;
    setTimeout(() => api('POST', '/api/videos/scriptsnap', { id: vid, why: 'правки автора' }).catch(() => {}), 1500);
    SW.el.remove(); SW.el = null; SW.frame = null;
    document.removeEventListener('keydown', this.esc);
    if (!quiet) { Plan.scriptSt[vid] = null; App.render(); }
  },
  cmd(c, extra = {}) { try { SW.frame && SW.frame.contentWindow.postMessage(Object.assign({ scriptCmd: c }, extra), '*'); } catch {} },

  // каркас строится один раз (iframe раскадровки нельзя переносить — перезагрузится); дальше меняются шапка и панели
  draw() {
    if (!SW.el) return;
    const d = Store.get('plan:' + SW.vid) || {};
    if (!SW.el.firstChild) {
      SW.el.append(
        h('div.sw-head'),
        h('div.sw-body', h('div.sw-board', SW.err ? h('div.badline', '⚠ ' + SW.err) : h('p.dim.sw-wait', h('span.spin'), ' запускаю раскадровку проекта…')), h('div.sw-side')),
        h('div.sw-foot',
          h('button', { onclick: () => api('POST', '/api/videos/open', { id: SW.vid, file: 'script.md' }).catch(e => UI.toast(e.message, 'err')), title: 'script.md в проводнике' }, Icon('folder', 15), 'Открыть файл'),
          h('button', { onclick: () => this.copyTts(), title: 'Только текст голоса, сцена за сценой — для внешней озвучки' }, Icon('book', 15), 'Скопировать для TTS'),
          h('span.sp'),
          h('button.claude.sw-apply', { onclick: () => this.applyNotes(), title: 'Claude ответит на каждую правку раскадровки: фактчек — таблицей, переписать — заменой (применишь кнопкой), остальное поправит сам; потом проверка и голос' }, '✨ Применить правки'),
          h('button.primary.sw-save', { disabled: true, onclick: () => { this.cmd('flush'); UI.toast('Сохранено в script.md'); }, title: 'Правки в карточках сохраняются сами через секунду; кнопка — сохранить сейчас' }, 'Сохранить')));
    }
    const tabs = [...(typeof BeatMap !== 'undefined' && BeatMap.base(d) ? [['beatmap', '📐 Карта подачи']] : []), ['board', 'Раскадровка'], ['research', 'Ресерч и источники'], ['versions', 'Версии']];
    SW.el.querySelector('.sw-head').replaceChildren(
      h('b.sw-title', 'Сценарий'), h('span.dim.sw-name', d.name || ''),
      h('div.seg', tabs.map(([k, l]) => h('button', { class: SW.tab === k ? 'sel' : '', onclick: () => this.go(k) }, l))),
      h('span.sp'), h('span.sw-stats'),
      (() => { const key = 'plan:' + d.id, ok = (Store.get(key) || {}).scriptOk;   // S12.13: сценарий утверждает автор — дальше препродакшен
        return ok ? h('button.sw-ok.on', { title: 'Сценарий утверждён ' + fmtDate(ok) + '. Клик — снять утверждение', onclick: () => { Store.set(key, ['scriptOk'], null, true); this.draw(); } }, Icon('check', 14), 'Утверждён')
          : h('button.primary.sw-ok', { title: 'Сценарий готов — утвердить: дальше озвучка и препродакшен', onclick: () => { Store.set(key, ['scriptOk'], Date.now(), true); UI.toast('✓ Сценарий утверждён'); this.draw(); } }, Icon('check', 14), 'Утвердить сценарий'); })(),
      h('button.icon', { title: 'Закрыть (Esc)', onclick: () => this.close() }, Icon('x', 18)));
    const board = SW.el.querySelector('.sw-board'), side = SW.el.querySelector('.sw-side');
    board.hidden = SW.tab !== 'board';
    if (SW.err) board.replaceChildren(h('div.badline', '⚠ ' + SW.err));
    side.hidden = SW.tab === 'board';
    keepScroll(side, () => side.replaceChildren(...[SW.tab === 'research' ? this.research() : SW.tab === 'versions' ? this.versions() : SW.tab === 'beatmap' ? BeatMap.pane(d) : null].filter(Boolean)));
    SW.bmSig = SW.tab === 'beatmap' ? BeatMap.sig(d) : null;
    this.bar();
  },
  // App.render -> только вкладка «📐 Карта подачи» и только если видимое поменялось (задача Claude, разбор, новая версия карты)
  refresh() {
    if (!SW.el || SW.tab !== 'beatmap' || typeof BeatMap === 'undefined') return;
    const d = Store.get('plan:' + SW.vid);
    if (d && BeatMap.sig(d) !== SW.bmSig) this.draw();
  },
  go(tab) {
    SW.tab = tab;
    if (tab === 'research') SW.research = null;
    if (tab === 'versions') { SW.vers = null; SW.ver = null; }
    this.draw();
  },
  bar() {                                                   // итоги и кнопки — по состоянию раскадровки (без перерисовки iframe)
    if (!SW.el) return;
    const s = SW.st, f = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    const st = SW.el.querySelector('.sw-stats');
    if (st) st.textContent = s.scenes != null ? `${s.scenes} ${plural(s.scenes, 'сцена', 'сцены', 'сцен')} · ${s.words} слов · ≈ ${f(s.words / 2.65)} при 2,65 сл/с` + (s.real ? ` · голос ${f(s.real)}` : '') : '';
    const ap = SW.el.querySelector('.sw-apply'); if (ap) { ap.textContent = s.open ? `✨ Применить правки (${s.open})` : '✨ Применить правки'; ap.disabled = !s.open || (window.AgentPanel && AgentPanel.busy); }
    const sv = SW.el.querySelector('.sw-save'); if (sv) sv.disabled = !s.dirty;
  },

  research() {
    if (!SW.research) { SW.research = { busy: true }; api('GET', `/api/videos/text?id=${SW.vid}&f=research.md`).then(r => { SW.research = r; this.draw(); }).catch(e => { SW.research = { err: e.message }; this.draw(); }); }
    const r = SW.research;
    if (r.busy) return h('div.sw-pane', h('p.dim', h('span.spin'), ' читаю research.md…'));
    if (r.err) return h('div.sw-pane', h('div.badline', '⚠ ' + r.err));
    if (!r.exists || !r.text.trim()) return h('div.sw-pane', h('div.empty-state', h('div.es-ico', Icon('search', 24)), h('b', 'Ресерча пока нет'),
      h('p', 'Когда Claude пишет сценарий по теме, он ищет источники в интернете и записывает research.md: источники с номерами и факты. Номера стоят в поле «Источники» у сцен.')));
    return h('div.sw-pane.sw-md', { html: mdDoc(r.text) });
  },

  versions() {
    if (!SW.vers) { SW.vers = { busy: true }; api('GET', `/api/videos/scriptver?id=${SW.vid}`).then(r => { SW.vers = r; this.draw(); }).catch(e => { SW.vers = { err: e.message }; this.draw(); }); }
    const V = SW.vers;
    if (V.busy) return h('div.sw-pane', h('p.dim', h('span.spin'), ' читаю версии…'));
    if (V.err) return h('div.sw-pane', h('div.badline', '⚠ ' + V.err));
    const list = V.versions || [];
    if (!list.length) return h('div.sw-pane', h('div.empty-state', h('div.es-ico', Icon('clock', 24)), h('b', 'Версий пока нет'), h('p', 'Версия сохраняется сама: до и после каждого запуска Claude, при открытии и закрытии этого окна, перед возвратом старой версии.')));
    const cur = SW.ver;
    return h('div.sw-vers',
      h('div.sw-vlist', list.map((v, i) => h('button.sw-v', { class: cur && cur.name === v.file ? 'on' : '', onclick: () => api('GET', `/api/videos/scriptver?id=${SW.vid}&v=${v.file}`).then(r => { SW.ver = r; this.draw(); }) },
        h('b', new Date(v.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + (i === 0 ? ' · последняя' : '')),
        h('small', (v.why || '') + (v.words ? ` · ${v.words} слов голоса` : ''))))),
      h('div.sw-vview', cur ? [h('div.row', h('b', 'Версия ' + cur.name.replace('.md', '')), h('span.sp'),
        h('button.primary', { onclick: () => this.restore(cur.name) }, '↺ Вернуть эту версию')), h('pre.sw-pre', cur.text)]
        : h('p.dim', 'Выберите версию слева — увидите её текст и сможете вернуть.')));
  },
  async restore(name) {
    if (!confirm('Вернуть эту версию сценария? Текущая сохранится версией — её тоже можно будет вернуть.')) return;
    try {
      await api('POST', '/api/videos/scriptrestore', { id: SW.vid, v: name });
      UI.toast('↺ Версия возвращена — не забудьте переозвучить');
      this.cmd('reload'); SW.tab = 'board'; SW.vers = null; this.draw();
    } catch (e) { UI.toast(e.message, 'err'); }
  },
  copyTts() {
    const id = uid('t');
    const on = ev => { if (ev.data && ev.data.id === id && typeof ev.data.scriptTtsText === 'string') { removeEventListener('message', on); UI.copy(ev.data.scriptTtsText); } };
    addEventListener('message', on);
    this.cmd('ttsText', { id });
    setTimeout(() => removeEventListener('message', on), 4000);
  },
  applyNotes() {
    const n = SW.st.open || 0;
    if (!n) return;
    this.cmd('flush');
    AgentPanel.toggle(true);
    AgentPanel.say(`✍️ Отработай правки раскадровки (${n}): script notes, ответь на каждую (script reply), правь script.md. Потом montage check и montage tts.`, { mode: 'script', model: 'opus' });
    UI.toast('✍️ Claude разбирает правки — шаги в панели справа');
  },
};
addEventListener('message', ev => {
  if (!SW.frame || ev.source !== SW.frame.contentWindow || !ev.data || !ev.data.scriptState) return;
  SW.st = ev.data.scriptState; ScriptWin.bar();
});
