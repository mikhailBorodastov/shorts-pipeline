// Простой агент (S1): одна просьба -> задача sceneagent (claude -p, Sonnet; переключатель Opus) -> одна пачка операций, её можно отменить.
// Пока задача идёт, сцена только для просмотра (плашка «Claude работает… ✕»). S7: в приложении просьбы уходят в общую панель агента (web/agent.js), здесь — меню «💬 Claude» по предмету.
export function initAgent(ED) {
  const $ = id => document.getElementById(id);
  const box = $('agent'), feed = $('agentFeed'), form = $('agentForm'), ask = $('agentAsk'), model = $('agentModel');
  let jobId = null;
  try { model.value = localStorage.getItem('editor.agentModel') || 'sonnet'; } catch {}
  model.onchange = () => { try { localStorage.setItem('editor.agentModel', model.value); } catch {} };

  function msg(kind, text, meta) {
    const d = document.createElement('div'); d.className = 'msg ' + kind; d.textContent = text;
    if (meta) { const m = document.createElement('div'); m.className = 'meta'; meta(m); d.append(m); }
    feed.append(d); feed.scrollTop = feed.scrollHeight;
    return d;
  }
  // earlier talk about this scene (element.stage.chat)
  for (const c of ((ED.info.element || {}).stage || {}).chat || []) {
    msg('me', c.ask);
    msg('cl', (c.reply || '') + (c.desc ? `\n→ ${c.desc}` : ''), m => { m.textContent = `${new Date(c.ts).toLocaleString().slice(0, 17)} · ${c.model || ''} · правок: ${c.n || 0}`; });
  }
  const ctx = () => {
    const sel = [...ED.sel].map(id => id === 'camera' ? 'камера' : ((ED.doc.objects || []).concat(ED.doc.lights || []).find(o => o.id === id) || {}).name).filter(Boolean);
    $('agentCtx').textContent = `⏱ ${ED.t.toFixed(2)} с` + (sel.length ? ` · выбрано: ${sel.slice(0, 3).join(', ')}${sel.length > 3 ? '…' : ''}` : '');
  };
  const open = (text) => { box.hidden = false; ctx(); if (text != null) ask.value = text + ask.value; ask.focus(); ask.setSelectionRange(ask.value.length, ask.value.length); };
  const close = () => { box.hidden = true; $('vp').querySelector('canvas').focus(); };
  $('agentClose').onclick = close;
  ask.addEventListener('focus', ctx);
  ask.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  });

  function setLock(jid) {
    ED.locked = jid || null;
    document.getElementById('app').classList.toggle('locked', !!jid);
    $('lockbar').hidden = !jid;
    $('agentSend').disabled = !!jid;
  }
  $('lockCancel').onclick = async () => { if (ED.locked) await fetch('/api/job/cancel?id=' + ED.locked, { method: 'POST', headers: { 'X-Ideas': '1' } }); };

  form.onsubmit = async e => {
    e.preventDefault();
    const text = ask.value.trim();
    if (!text || ED.locked) return;
    if (ED.pending) { ED.msg('Секунду — сохраняю правки'); return; }
    msg('me', text);
    ask.value = '';
    const wait = msg('cl', '… Claude смотрит сцену');
    try {
      const { job } = await ED.api('/api/scene/agent', { key: ED.key, el: ED.el, ask: text, t: ED.t, sel: [...ED.sel], model: model.value });
      jobId = job.id; setLock(job.id);
      let s;
      for (;;) {
        await new Promise(r => setTimeout(r, 1200));
        s = await fetch('/api/job?id=' + job.id).then(r => r.json());
        wait.textContent = '… ' + (s.summary || 'Claude работает');
        if (s.status !== 'running') break;
      }
      setLock(null);
      if (s.status !== 'done') { wait.className = 'msg err'; wait.textContent = s.status === 'cancelled' ? 'Отменено' : '⚠ ' + (s.error || s.status); return; }
      const r = s.result || {};
      if (r.prefabs) {                                            // Claude drew things anew: the page must load the new prefabs.js
        const entry = { batch: r.batch, desc: '💬 ' + (r.desc || text), ops: r.ops, undo: r.undo, at: Date.now(), agent: true };
        ED.undo.push(entry); ED.redo = [];
        ED.reloadPage('Claude поменял вид предметов: ' + (r.desc || text) + ' — Ctrl+Z вернёт как было');
        return;
      }
      await ED.reload('агент');
      wait.textContent = (r.reply || '') + (r.desc ? `\n→ ${r.desc}` : '') + (r.warn && r.warn.length ? `\n⚠ ${r.warn.join('; ')}` : '');
      const m = document.createElement('div'); m.className = 'meta';
      if (r.applied) {
        const entry = { batch: r.batch, desc: '💬 ' + (r.desc || text), ops: r.ops, undo: r.undo, at: Date.now(), agent: true };
        ED.undo.push(entry); ED.redo = [];
        m.textContent = `правок: ${(r.ops || []).length} · Ctrl+Z отменит `;
        const u = document.createElement('button'); u.textContent = '↺ отменить'; u.onclick = () => {
          const i = ED.undo.indexOf(entry);
          if (i < 0) { ED.msg('Эта правка уже отменена'); return; }
          if (i !== ED.undo.length - 1) { ED.msg('После неё были другие правки — отменяю её отдельно'); }
          ED.undo.splice(i, 1);
          ED.commit(entry.undo, '↺ отмена: ' + entry.desc, { kind: 'undo', undoes: entry.batch });
          u.disabled = true;
        };
        m.append(u);
      } else m.textContent = 'без правок';
      wait.append(m);
    } catch (err) { setLock(null); wait.className = 'msg err'; wait.textContent = '⚠ ' + err.message; }
  };

  // S7: панель агента живёт в окне приложения (справа, на всех этапах) — редактор отдаёт ей просьбы и контекст; без приложения — старая панель S1
  const host = () => { try { return window.parent !== window && window.parent.AgentPanel ? window.parent.AgentPanel : null; } catch { return null; } };
  const name = id => id === 'camera' ? 'камера' : ((ED.doc.objects || []).concat(ED.doc.lights || []).find(o => o.id === id) || {}).name || id;

  // правый щелчок по предмету (или Ctrl+/): «💬 Claude, сделай…» / «📌 пометка на потом» — комментарий на объекте в моменте курсора
  function commentBox(x, y, target) {
    document.querySelectorAll('.cmtbox').forEach(b => b.remove());
    const b = document.createElement('div'); b.className = 'cmtbox';
    b.style.left = Math.min(x, innerWidth - 330) + 'px'; b.style.top = Math.min(y, innerHeight - 170) + 'px';
    b.innerHTML = `<div class="dim">💬 ${target ? '«' + name(target) + '»' : 'сцена'} · ${ED.t.toFixed(2)} с</div><textarea rows="3" placeholder="Например: пусть тут испуганно отпрыгнет"></textarea>
      <div class="row"><button class="do" title="Enter">✨ Сделать сейчас</button><button class="note" title="Ctrl+Enter — пометка для сборки, агент прочитает её потом">📌 Пометка</button><span class="grow"></span><button class="x">✕</button></div>`;
    document.body.append(b);
    const ta = b.querySelector('textarea'); ta.focus();
    const done = () => b.remove();
    const send = mode => {
      const text = ta.value.trim(); if (!text) return done();
      if (mode === 'note') {
        ED.commit([{ op: 'add', path: ['comments'], item: { id: 'n' + Math.random().toString(36).slice(2, 8), target: target || null, t: +ED.t.toFixed(2), text, by: 'author', status: 'open', mode: 'note', ts: Date.now() } }],
          `📌 пометка: ${text.slice(0, 60)}`);
        ED.msg('📌 Пометка сохранена — агент увидит её при сборке и в «scene brief»');
      } else {
        const H = host();
        if (H) H.ask(text, { target: target ? `${target} «${name(target)}»` : null });
        else { open((target ? `«${name(target)}»: ` : '') + text); }
      }
      done();
    };
    b.querySelector('.do').onclick = () => send('do');
    b.querySelector('.note').onclick = () => send('note');
    b.querySelector('.x').onclick = done;
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') done(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.ctrlKey ? 'note' : 'do'); } });
  }
  ED.objMenu = (e, id) => { if (ED.readonly) return; if (id) ED.select([id]); commentBox(e.clientX, e.clientY, id); };
  // контекст для панели приложения: что открыто, где курсор, что выбрано
  window.agentCtx = () => ({ el: ED.el, t: +ED.t.toFixed(2), sel: [...ED.sel].map(id => `${id} «${name(id)}»`) });

  return {
    open, close, setLock,
    toggle() { const H = host(); if (H) { H.toggle(); return; } if (box.hidden) open(); else close(); },
    comment() { const r = document.getElementById('vp').getBoundingClientRect(); commentBox(r.left + r.width / 2 - 150, r.top + 60, ED.active && ED.active !== 'camera' ? ED.active : null); },
  };
}
