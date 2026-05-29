/* Recall — spaced-repetition study calendar.
 * Plain-script app (no build step). State persists in localStorage.
 * Depends on ICS (ics.js) for Google Calendar export + Blackbaud feed parsing.
 */
(function () {
  'use strict';

  // ----------------------------------------------------------------- storage
  const KEY = 'recall.v1';
  const DEFAULTS = {
    classes: [],            // { id, name, color }
    topics: [],             // { id, title, notes, classId, learnedDate, reviews:[{n,offset,date,done,doneAt}], createdAt }
    assignments: [],        // { id, title, date, time, source:'blackbaud' }
    settings: {
      intervals: [1, 3, 7, 14, 30],
      reminderTime: '18:00',
      bbUrl: '',
      bbProxy: 'https://api.allorigins.win/raw?url=',
      bbLastSync: '',
      bbAutoSync: false,
      lastNotified: '',
      gClientId: '',
      gCalendarId: '',
      gConnected: false,
    },
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      // shallow-merge settings so new defaults appear after upgrades
      parsed.settings = Object.assign(structuredClone(DEFAULTS.settings), parsed.settings || {});
      parsed.classes = parsed.classes || [];
      parsed.topics = parsed.topics || [];
      parsed.assignments = parsed.assignments || [];
      return parsed;
    } catch (e) {
      console.error('load failed', e);
      return structuredClone(DEFAULTS);
    }
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // -------------------------------------------------------------- date utils
  function todayStr() { return ymd(new Date()); }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); }
  function daysFromToday(s) {
    const a = parseYMD(todayStr()), b = parseYMD(s);
    return Math.round((b - a) / 86400000);
  }
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtNice(s) { const d = parseYMD(s); return WD[d.getDay()] + ', ' + MO[d.getMonth()] + ' ' + d.getDate(); }
  function relLabel(s) {
    const n = daysFromToday(s);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n < 0) return `${-n} days ago`;
    if (n < 7) return `In ${n} days`;
    return fmtNice(s);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ----------------------------------------------------- spaced repetition
  function genReviews(learnedDate, intervals, prev) {
    return intervals.map((off, i) => {
      const existing = prev && prev[i];
      return {
        n: i + 1,
        offset: off,
        date: addDays(learnedDate, off),
        done: existing ? !!existing.done : false,
        doneAt: existing ? existing.doneAt || null : null,
      };
    });
  }

  // --------------------------------------------------------------- entities
  function getClass(id) { return state.classes.find((c) => c.id === id) || null; }
  function classColor(id) { const c = getClass(id); return c ? c.color : '#64748b'; }
  function classNameOf(id) { const c = getClass(id); return c ? c.name : 'Unassigned'; }

  function addTopic({ title, notes, classId, learnedDate }) {
    const t = {
      id: uid(), title: title.trim(), notes: (notes || '').trim(),
      classId: classId || null, learnedDate,
      reviews: genReviews(learnedDate, state.settings.intervals.slice()),
      createdAt: new Date().toISOString(),
    };
    state.topics.push(t);
    save();
    gcalSyncTopic(t).catch(() => {});
    return t;
  }
  function updateTopic(id, patch) {
    const t = state.topics.find((x) => x.id === id);
    if (!t) return;
    const dateChanged = patch.learnedDate && patch.learnedDate !== t.learnedDate;
    Object.assign(t, patch);
    if (dateChanged) t.reviews = genReviews(t.learnedDate, t.reviews.map((r) => r.offset), t.reviews);
    save();
    gcalSyncTopic(t).catch(() => {});
  }
  function deleteTopic(id) {
    const t = state.topics.find((x) => x.id === id);
    if (t) gcalDeleteTopic(t).catch(() => {});
    state.topics = state.topics.filter((x) => x.id !== id); save();
  }

  // -------------------------------------------------------- event gathering
  function reviewEvents() {
    const out = [];
    for (const t of state.topics) {
      for (const r of t.reviews) {
        out.push({
          kind: 'review', topicId: t.id, n: r.n, total: t.reviews.length,
          title: t.title, notes: t.notes, classId: t.classId, color: classColor(t.classId),
          date: r.date, done: r.done,
        });
      }
    }
    return out;
  }
  function assignmentEvents() {
    return state.assignments.map((a) => ({ kind: 'assignment', ...a }));
  }
  function eventsByDate() {
    const map = {};
    const push = (e) => { (map[e.date] = map[e.date] || []).push(e); };
    reviewEvents().forEach(push);
    assignmentEvents().forEach(push);
    return map;
  }

  // ------------------------------------------------------------------- UI $
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  let calCursor = new Date(); calCursor.setDate(1);
  let activeView = 'calendar';

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function switchView(v) {
    activeView = v;
    $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
    $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    render();
  }

  function render() {
    if (activeView === 'calendar') renderCalendar();
    else if (activeView === 'agenda') renderAgenda();
    else if (activeView === 'topics') renderTopics();
    else if (activeView === 'classes') renderClasses();
    else if (activeView === 'settings') renderSettings();
  }

  // ------------------------------------------------------------- calendar
  function renderCalendar() {
    const grid = $('#calGrid');
    const year = calCursor.getFullYear(), month = calCursor.getMonth();
    $('#calTitle').textContent = calCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const first = new Date(year, month, 1);
    const start = new Date(first); start.setDate(1 - first.getDay()); // back to Sunday
    const byDate = eventsByDate();
    const today = todayStr();
    let html = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = ymd(d);
      const out = d.getMonth() !== month;
      const items = (byDate[ds] || []).slice().sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'assignment' ? 1 : -1));
      let chips = '';
      const shown = items.slice(0, 3);
      for (const it of shown) {
        if (it.kind === 'review') {
          chips += `<span class="chip${it.done ? ' done' : ''}" style="background:${it.color}">R${it.n} ${esc(it.title)}</span>`;
        } else {
          chips += `<span class="chip assignment">${esc(it.title)}</span>`;
        }
      }
      if (items.length > 3) chips += `<span class="more">+${items.length - 3} more</span>`;
      html += `<button class="cell${out ? ' out' : ''}${ds === today ? ' today' : ''}" data-date="${ds}">
        <span class="dnum">${d.getDate()}</span>${chips}</button>`;
    }
    grid.innerHTML = html;
    $$('.cell', grid).forEach((c) => c.onclick = () => openDay(c.dataset.date));
    $('#calLegend').innerHTML = 'Colored chips = reviews (by class) · ' +
      '<span style="border-left:3px solid #f59e0b;padding-left:5px">amber</span> = Blackbaud assignment. Tap a day for details.';
  }

  // --------------------------------------------------------------- agenda
  function renderAgenda() {
    const body = $('#agendaBody');
    const revs = reviewEvents();
    const today = todayStr();
    const overdue = revs.filter((r) => !r.done && r.date < today).sort(byDate);
    const todays = revs.filter((r) => !r.done && r.date === today).sort(byDate);
    const soon = revs.filter((r) => !r.done && r.date > today && daysFromToday(r.date) <= 14).sort(byDate);
    const upAssign = assignmentEvents().filter((a) => a.date >= today && daysFromToday(a.date) <= 21)
      .sort(byDate);

    let html = '';
    if (!revs.length) {
      html = emptyState('🧠', 'Nothing to review yet', 'Tap the + button to log what you learned today. Reviews get scheduled automatically.');
    } else {
      html += section('Overdue', overdue, 'overdue');
      html += section('Today', todays, 'today');
      html += section('Next 14 days', soon, '');
      if (!overdue.length && !todays.length && !soon.length) {
        html += `<div class="card"><div class="muted">🎉 All caught up — no reviews due in the next two weeks.</div></div>`;
      }
    }
    if (upAssign.length) {
      html += `<div class="section-title">Upcoming assignments (Blackbaud)</div>`;
      for (const a of upAssign) {
        html += `<div class="row"><span class="dot" style="background:#f59e0b"></span>
          <div class="body"><div class="ttl">${esc(a.title)}</div>
          <div class="sub">${esc(relLabel(a.date))}${a.time ? ' · ' + esc(a.time) : ''}</div></div></div>`;
      }
    }
    body.innerHTML = html;
    wireReviewRows(body);

    function section(label, list, badgeClass) {
      if (!list.length) return '';
      let s = `<div class="section-title">${label} · ${list.length}</div>`;
      for (const r of list) {
        const badge = badgeClass ? `<span class="badge ${badgeClass}">${label}</span>` : `<span class="badge">${esc(relLabel(r.date))}</span>`;
        s += `<div class="row" data-topic="${r.topicId}" data-n="${r.n}">
          <span class="dot" style="background:${r.color}"></span>
          <div class="body">
            <div class="ttl">${esc(r.title)}</div>
            <div class="sub"><span class="pill" style="background:${r.color}">${esc(classNameOf(r.classId))}</span>
              <span class="review-n">Review ${r.n}/${r.total}</span> · ${badge}
              <a href="${ICS.gcalLink(gcalEvent(r))}" target="_blank" rel="noopener" class="review-n" style="margin-left:4px">＋Google Cal</a>
            </div>
          </div>
          <button class="check" title="Mark reviewed">✓</button>
        </div>`;
      }
      return s;
    }
  }
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  function wireReviewRows(root) {
    $$('.row[data-topic]', root).forEach((row) => {
      const btn = $('.check', row);
      if (btn) btn.onclick = () => { toggleReview(row.dataset.topic, +row.dataset.n); };
    });
  }
  function toggleReview(topicId, n) {
    const t = state.topics.find((x) => x.id === topicId);
    if (!t) return;
    const r = t.reviews.find((x) => x.n === n);
    if (!r) return;
    r.done = !r.done; r.doneAt = r.done ? new Date().toISOString() : null;
    save();
    gcalUpsertReview(t, r).catch(() => {});
    toast(r.done ? `Review ${n} done ✓` : `Review ${n} reopened`);
    render();
  }

  // --------------------------------------------------------------- topics
  function renderTopics() {
    const body = $('#topicsBody');
    if (!state.topics.length) {
      body.innerHTML = emptyState('📚', 'No topics logged', 'Log something you learned and Recall schedules all five reviews for you.');
      return;
    }
    const sorted = state.topics.slice().sort((a, b) => (a.learnedDate < b.learnedDate ? 1 : -1));
    let html = '';
    for (const t of sorted) {
      const done = t.reviews.filter((r) => r.done).length;
      const pct = Math.round((done / t.reviews.length) * 100);
      const next = t.reviews.find((r) => !r.done);
      html += `<div class="card">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <span class="dot" style="width:12px;height:12px;border-radius:50%;background:${classColor(t.classId)};margin-top:6px;flex:0 0 auto"></span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${esc(t.title)}</div>
            <div class="faint"><span class="pill" style="background:${classColor(t.classId)}">${esc(classNameOf(t.classId))}</span>
              · learned ${esc(fmtNice(t.learnedDate))}</div>
            ${t.notes ? `<div class="faint" style="margin-top:4px">${esc(t.notes)}</div>` : ''}
            <div class="faint" style="margin-top:6px">${done}/${t.reviews.length} reviews done${next ? ' · next ' + esc(relLabel(next.date)) : ' · ✅ complete'}</div>
            <div class="progress"><i style="width:${pct}%"></i></div>
          </div>
        </div>
        <div class="btn-row" style="margin-top:11px">
          <button class="btn secondary sm" data-act="ics" data-id="${t.id}">📅 To Google Calendar</button>
          <button class="btn ghost sm" data-act="edit" data-id="${t.id}">Edit</button>
          <button class="btn ghost sm" data-act="del" data-id="${t.id}">Delete</button>
        </div>
      </div>`;
    }
    body.innerHTML = html;
    $$('[data-act]', body).forEach((b) => b.onclick = () => {
      const id = b.dataset.id;
      if (b.dataset.act === 'ics') downloadTopicIcs(id);
      else if (b.dataset.act === 'edit') openTopicModal(id);
      else if (b.dataset.act === 'del') confirmDeleteTopic(id);
    });
  }

  // -------------------------------------------------------------- classes
  function renderClasses() {
    const body = $('#classesBody');
    if (!state.classes.length) {
      body.innerHTML = emptyState('🎓', 'No classes yet', 'Add your classes so you can color-code and filter your reviews.');
      return;
    }
    let html = '';
    for (const c of state.classes) {
      const count = state.topics.filter((t) => t.classId === c.id).length;
      html += `<div class="row">
        <span class="dot" style="background:${c.color}"></span>
        <div class="body"><div class="ttl">${esc(c.name)}</div>
          <div class="sub">${count} topic${count === 1 ? '' : 's'}</div></div>
        <button class="btn ghost sm" data-edit="${c.id}">Edit</button>
        <button class="btn ghost sm" data-del="${c.id}">Delete</button>
      </div>`;
    }
    body.innerHTML = html;
    $$('[data-edit]', body).forEach((b) => b.onclick = () => openClassModal(b.dataset.edit));
    $$('[data-del]', body).forEach((b) => b.onclick = () => {
      const c = getClass(b.dataset.del);
      if (!confirm(`Delete class "${c.name}"? Its topics become Unassigned.`)) return;
      state.topics.forEach((t) => { if (t.classId === c.id) t.classId = null; });
      state.classes = state.classes.filter((x) => x.id !== c.id);
      save(); render(); toast('Class deleted');
    });
  }

  // -------------------------------------------------------------- settings
  function renderSettings() {
    $('#intervalsInput').value = state.settings.intervals.join(', ');
    $('#reminderTime').value = state.settings.reminderTime;
    $('#bbUrl').value = state.settings.bbUrl;
    $('#bbProxy').value = state.settings.bbProxy;
    $('#bbAutoSync').checked = !!state.settings.bbAutoSync;
    const n = state.assignments.length;
    $('#bbStatus').textContent = n
      ? `${n} assignment${n === 1 ? '' : 's'} loaded${state.settings.bbLastSync ? ' · last sync ' + new Date(state.settings.bbLastSync).toLocaleString() : ''}.`
      : 'No assignments loaded yet.';

    // Google Calendar section
    $('#gClientId').value = state.settings.gClientId || '';
    const connected = !!state.settings.gConnected;
    $('#gConnect').textContent = connected ? '🔗 Reconnect' : '🔗 Connect Google Calendar';
    $('#gResync').style.display = connected ? '' : 'none';
    $('#gDisconnect').style.display = connected ? '' : 'none';
    $('#gStatus').innerHTML = connected
      ? `<span class="gpill">✓ Connected</span> Syncing to your “Recall Reviews” calendar.`
      : 'Not connected — log a topic to schedule reviews; export .ics for now.';
  }

  function emptyState(big, title, sub) {
    return `<div class="empty"><div class="big">${big}</div><div style="font-weight:700;color:var(--txt-dim)">${title}</div>
      <div style="margin-top:4px">${sub}</div></div>`;
  }

  // ------------------------------------------------------------- modals
  const overlay = $('#overlay'), sheet = $('#sheet');
  function openSheet(html) { sheet.innerHTML = html; overlay.classList.add('open'); }
  function closeSheet() { overlay.classList.remove('open'); sheet.innerHTML = ''; }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

  function classOptions(selected) {
    let o = `<option value="">Unassigned</option>`;
    for (const c of state.classes) o += `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`;
    o += `<option value="__new">＋ New class…</option>`;
    return o;
  }

  function openTopicModal(id) {
    const t = id ? state.topics.find((x) => x.id === id) : null;
    openSheet(`
      <div class="sheet-head"><h3>${t ? 'Edit topic' : 'Log what you learned'}</h3>
        <span class="spacer"></span><button class="btn ghost sm" id="mClose">Close</button></div>
      <label class="fld">What did you learn?</label>
      <input id="mTitle" placeholder="e.g. Photosynthesis light reactions" value="${t ? esc(t.title) : ''}">
      <label class="fld">Class</label>
      <select id="mClass">${classOptions(t ? t.classId : '')}</select>
      <label class="fld">Notes (optional)</label>
      <textarea id="mNotes" placeholder="Key points, page numbers, links…">${t ? esc(t.notes) : ''}</textarea>
      <label class="fld">Date learned</label>
      <input id="mDate" type="date" value="${t ? t.learnedDate : todayStr()}">
      <div class="hint">Reviews will be scheduled on:</div>
      <div class="preview-dates" id="mPreview"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" id="mSave">${t ? 'Save changes' : 'Schedule reviews'}</button>
        ${t ? '' : '<button class="btn secondary" id="mCancel">Cancel</button>'}
      </div>
    `);
    $('#mClose').onclick = closeSheet;
    if ($('#mCancel')) $('#mCancel').onclick = closeSheet;
    const dateEl = $('#mDate');
    const refreshPreview = () => {
      const offs = t ? t.reviews.map((r) => r.offset) : state.settings.intervals;
      const base = dateEl.value || todayStr();
      $('#mPreview').innerHTML = offs.map((o, i) =>
        `<span>R${i + 1}: <b>${esc(fmtNice(addDays(base, o)))}</b></span>`).join('');
    };
    dateEl.oninput = refreshPreview; refreshPreview();
    $('#mClass').onchange = (e) => {
      if (e.target.value === '__new') {
        const name = prompt('New class name:');
        if (name && name.trim()) {
          const c = { id: uid(), name: name.trim(), color: pickColor() };
          state.classes.push(c); save();
          $('#mClass').innerHTML = classOptions(c.id);
        } else { e.target.value = t ? (t.classId || '') : ''; }
      }
    };
    $('#mSave').onclick = () => {
      const title = $('#mTitle').value.trim();
      if (!title) { toast('Add a title first'); $('#mTitle').focus(); return; }
      const data = {
        title, notes: $('#mNotes').value,
        classId: $('#mClass').value && $('#mClass').value !== '__new' ? $('#mClass').value : null,
        learnedDate: dateEl.value || todayStr(),
      };
      if (t) { updateTopic(t.id, data); toast('Topic updated'); }
      else { addTopic(data); toast('Scheduled 5 reviews ✓'); }
      closeSheet(); render(); maybeNotifySoon();
    };
    setTimeout(() => $('#mTitle').focus(), 50);
  }

  function confirmDeleteTopic(id) {
    const t = state.topics.find((x) => x.id === id);
    if (!t) return;
    if (confirm(`Delete "${t.title}" and its reviews?`)) { deleteTopic(id); render(); toast('Topic deleted'); }
  }

  function openClassModal(id) {
    const c = id ? getClass(id) : null;
    openSheet(`
      <div class="sheet-head"><h3>${c ? 'Edit class' : 'Add class'}</h3>
        <span class="spacer"></span><button class="btn ghost sm" id="mClose">Close</button></div>
      <label class="fld">Class name</label>
      <input id="cName" placeholder="e.g. AP Biology" value="${c ? esc(c.name) : ''}">
      <label class="fld">Color</label>
      <input id="cColor" type="color" value="${c ? c.color : pickColor()}">
      <div class="btn-row" style="margin-top:16px">
        <button class="btn" id="cSave">${c ? 'Save' : 'Add class'}</button>
      </div>
    `);
    $('#mClose').onclick = closeSheet;
    $('#cSave').onclick = () => {
      const name = $('#cName').value.trim();
      if (!name) { toast('Name required'); return; }
      if (c) { c.name = name; c.color = $('#cColor').value; }
      else state.classes.push({ id: uid(), name, color: $('#cColor').value });
      save(); closeSheet(); render(); toast('Saved');
    };
  }

  function openDay(ds) {
    const items = (eventsByDate()[ds] || []);
    let html = `<div class="sheet-head"><h3>${esc(fmtNice(ds))}</h3>
      <span class="spacer"></span><button class="btn ghost sm" id="mClose">Close</button></div>`;
    if (!items.length) {
      html += `<p class="muted">Nothing scheduled.</p>`;
    } else {
      for (const it of items) {
        if (it.kind === 'review') {
          html += `<div class="row" data-topic="${it.topicId}" data-n="${it.n}">
            <span class="dot" style="background:${it.color}"></span>
            <div class="body"><div class="ttl${it.done ? '' : ''}">${esc(it.title)}</div>
              <div class="sub"><span class="pill" style="background:${it.color}">${esc(classNameOf(it.classId))}</span>
                <span class="review-n">Review ${it.n}/${it.total}</span>
                <a href="${ICS.gcalLink(gcalEvent(it))}" target="_blank" rel="noopener" class="review-n" style="margin-left:4px">＋Google Cal</a>
              </div></div>
            <button class="check" title="Toggle reviewed">${it.done ? '↺' : '✓'}</button></div>`;
        } else {
          html += `<div class="row"><span class="dot" style="background:#f59e0b"></span>
            <div class="body"><div class="ttl">${esc(it.title)}</div>
              <div class="sub">Blackbaud assignment${it.time ? ' · ' + esc(it.time) : ''}</div></div></div>`;
        }
      }
    }
    html += `<div class="btn-row" style="margin-top:14px"><button class="btn sm" id="dayAdd">+ Log learning on this day</button></div>`;
    openSheet(html);
    $('#mClose').onclick = closeSheet;
    wireReviewRows(sheet);
    $('#dayAdd').onclick = () => { closeSheet(); openTopicModal(); setTimeout(() => { $('#mDate').value = ds; $('#mDate').dispatchEvent(new Event('input')); }, 60); };
  }

  // ------------------------------------------------------- Google Calendar
  function gcalEvent(r) {
    const t = state.topics.find((x) => x.id === r.topicId);
    return {
      title: `Review: ${r.title}`,
      description: `Spaced-repetition review ${r.n} of ${r.total} · ${classNameOf(r.classId)}` +
        (t && t.notes ? `\n\n${t.notes}` : '') + `\n\n— Recall`,
      date: r.date, time: state.settings.reminderTime, durationMin: 30,
    };
  }
  function topicIcsEvents(t) {
    return t.reviews.map((r) => ({
      uid: `${t.id}-r${r.n}@recall`,
      title: `Review: ${t.title}`,
      description: `Spaced-repetition review ${r.n} of ${t.reviews.length} · ${classNameOf(t.classId)}` +
        (t.notes ? `\n\n${t.notes}` : '') + `\n\n— Recall`,
      date: r.date, time: state.settings.reminderTime, durationMin: 30, alarmMin: 0,
    }));
  }
  function downloadIcs(filename, events) {
    if (!events.length) { toast('Nothing to export'); return; }
    const blob = new Blob([ICS.generate(events, { calName: 'Recall Reviews' })], { type: 'text/calendar' });
    triggerDownload(blob, filename);
    toast('Downloaded — import it into Google Calendar');
  }
  function downloadTopicIcs(id) {
    const t = state.topics.find((x) => x.id === id);
    if (t) downloadIcs(`recall-${slug(t.title)}.ics`, topicIcsEvents(t));
  }
  function exportAllIcs() {
    const events = [];
    for (const t of state.topics) events.push(...topicIcsEvents(t));
    downloadIcs('recall-all-reviews.ics', events);
  }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic'; }
  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --------------------------------------------------------- Blackbaud sync
  async function syncBlackbaud(opts) {
    opts = opts || {};
    const url = (state.settings.bbUrl || '').trim();
    if (!url) {
      if (opts.silent) return;
      toast('Add your feed URL in Settings'); switchView('settings'); return;
    }
    const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
    const proxy = state.settings.bbProxy;
    const fetchUrl = proxy ? proxy + encodeURIComponent(httpUrl) : httpUrl;
    if (!opts.silent) toast('Syncing assignments…');
    try {
      const res = await fetch(fetchUrl, { headers: { 'Accept': 'text/calendar, text/plain, */*' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      ingestIcsText(text, opts);
    } catch (e) {
      console.error(e);
      if (!opts.silent) toast('Sync failed — try a different proxy or import the .ics file');
    }
  }
  function ingestIcsText(text, opts) {
    opts = opts || {};
    const parsed = ICS.parse(text);
    if (!parsed.length) {
      if (!opts.silent) toast('No events found in that calendar');
      return;
    }
    state.assignments = parsed.map((e) => ({
      id: e.uid || uid(), title: e.title, date: e.date, time: e.time || null, source: 'blackbaud',
    }));
    state.settings.bbLastSync = new Date().toISOString();
    save();
    if (!opts.silent) toast(`Loaded ${state.assignments.length} assignments`);
    render();
  }
  // Live auto-sync: on app open, on tab visible, every 30 min, throttled to 15 min.
  function startAutoSync() {
    if (startAutoSync._timer) { clearInterval(startAutoSync._timer); startAutoSync._timer = null; }
    if (!state.settings.bbAutoSync || !state.settings.bbUrl) return;
    maybeBbSync();
    startAutoSync._timer = setInterval(maybeBbSync, 30 * 60 * 1000);
  }
  function maybeBbSync() {
    if (!state.settings.bbAutoSync || !state.settings.bbUrl) return;
    const last = state.settings.bbLastSync ? new Date(state.settings.bbLastSync).getTime() : 0;
    if (Date.now() - last > 15 * 60 * 1000) syncBlackbaud({ silent: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) maybeBbSync();
  });

  // -------------------------------------------------------- Google Calendar
  // Uses Google Identity Services for OAuth (loaded from gsi/client in index.html)
  // and the Calendar v3 REST API. Scope 'calendar.app.created' lets us create
  // and manage a dedicated 'Recall Reviews' calendar without touching anything
  // else in the user's Google account.
  const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
  let tokenClient = null;
  let gToken = null;
  let gTokenExpires = 0;

  function gisReady() {
    return typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
  }
  function waitForGIS(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (gisReady()) return resolve();
        if (Date.now() > deadline) return reject(new Error('Google sign-in script did not load'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  function initTokenClient() {
    const id = (state.settings.gClientId || '').trim();
    if (!id) throw new Error('Missing Google Client ID');
    if (tokenClient && tokenClient._cid === id) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id, scope: GCAL_SCOPE, callback: () => {},
    });
    tokenClient._cid = id;
    return tokenClient;
  }
  async function getToken(opts) {
    opts = opts || {};
    if (gToken && Date.now() < gTokenExpires - 60_000) return gToken;
    await waitForGIS();
    const client = initTokenClient();
    return new Promise((resolve, reject) => {
      client.callback = (resp) => {
        if (resp.error || !resp.access_token) return reject(new Error(resp.error || 'No token'));
        gToken = resp.access_token;
        gTokenExpires = Date.now() + (resp.expires_in || 3600) * 1000;
        resolve(gToken);
      };
      try { client.requestAccessToken({ prompt: opts.interactive ? 'consent' : '' }); }
      catch (e) { reject(e); }
    });
  }
  async function gFetch(url, init) {
    init = init || {};
    const token = await getToken();
    const headers = Object.assign({
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    }, init.headers || {});
    let res = await fetch(url, Object.assign({}, init, { headers }));
    if (res.status === 401) {
      gToken = null;
      const t2 = await getToken({ interactive: true });
      headers.Authorization = 'Bearer ' + t2;
      res = await fetch(url, Object.assign({}, init, { headers }));
    }
    return res;
  }
  async function ensureRecallCalendar() {
    if (state.settings.gCalendarId) return state.settings.gCalendarId;
    const res = await gFetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST',
      body: JSON.stringify({
        summary: 'Recall Reviews',
        description: 'Spaced-repetition reviews managed by Recall.',
        timeZone: ICS.TZ,
      }),
    });
    if (!res.ok) throw new Error('Calendar create failed: ' + res.status);
    const data = await res.json();
    state.settings.gCalendarId = data.id; save();
    return data.id;
  }
  // Google event ID rules: 5-1024 chars, lowercase [a-v0-9]. Encode each source
  // character as two lowercase hex digits — always within a-p, always valid.
  function gcalEventId(topicId, n) {
    const src = `r${topicId}r${n}`;
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      out += (c & 0xf).toString(16) + ((c >> 4) & 0xf).toString(16);
    }
    return out;
  }
  function gcalEventBody(t, r) {
    const [hh, mm] = (state.settings.reminderTime || '18:00').split(':').map(Number);
    const [y, m, d] = r.date.split('-').map(Number);
    const startDt = new Date(y, m - 1, d, hh, mm, 0);
    const endDt = new Date(startDt.getTime() + 30 * 60_000);
    const summary = (r.done ? '✓ ' : '') + `Review ${r.n}/${t.reviews.length}: ${t.title}`;
    const desc = `Spaced-repetition review · ${classNameOf(t.classId)}` +
      (t.notes ? `\n\n${t.notes}` : '') + `\n\n— Recall`;
    return {
      id: gcalEventId(t.id, r.n),
      summary, description: desc,
      start: { dateTime: startDt.toISOString(), timeZone: ICS.TZ },
      end: { dateTime: endDt.toISOString(), timeZone: ICS.TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    };
  }
  async function gcalUpsertReview(t, r) {
    if (!state.settings.gConnected) return;
    try {
      const calId = await ensureRecallCalendar();
      const body = gcalEventBody(t, r);
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
      let res = await gFetch(base, { method: 'POST', body: JSON.stringify(body) });
      if (res.status === 409) {
        // Already exists — update in place.
        res = await gFetch(`${base}/${body.id}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      if (!res.ok && res.status !== 410) {
        const txt = await res.text();
        console.warn('gcal upsert', res.status, txt);
      }
    } catch (e) { console.warn('gcal upsert err', e); }
  }
  async function gcalDeleteReview(topicId, n) {
    if (!state.settings.gConnected || !state.settings.gCalendarId) return;
    try {
      const id = gcalEventId(topicId, n);
      await gFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(state.settings.gCalendarId)}/events/${id}`, { method: 'DELETE' });
    } catch (e) { console.warn('gcal delete err', e); }
  }
  async function gcalSyncTopic(t) {
    if (!state.settings.gConnected) return;
    for (const r of t.reviews) await gcalUpsertReview(t, r);
  }
  async function gcalDeleteTopic(t) {
    if (!state.settings.gConnected) return;
    for (const r of t.reviews) await gcalDeleteReview(t.id, r.n);
  }
  async function connectGoogleCalendar() {
    const id = ($('#gClientId') && $('#gClientId').value || state.settings.gClientId || '').trim();
    if (!id) { toast('Paste your Google Client ID first'); return; }
    state.settings.gClientId = id; save();
    try {
      await getToken({ interactive: true });
      await ensureRecallCalendar();
      state.settings.gConnected = true; save();
      renderSettings();
      toast('Connected ✓ syncing your topics…');
      let n = 0;
      for (const t of state.topics) { await gcalSyncTopic(t); n++; }
      toast(`Pushed ${n} topic${n === 1 ? '' : 's'} to Google Calendar ✓`);
    } catch (e) {
      console.error(e);
      toast('Connect failed — check the Client ID and authorized origin');
    }
  }
  async function resyncAllToGoogle() {
    if (!state.settings.gConnected) return;
    toast('Resyncing…');
    for (const t of state.topics) await gcalSyncTopic(t);
    toast('Resync done ✓');
  }
  function disconnectGoogle() {
    gToken = null; gTokenExpires = 0;
    state.settings.gConnected = false; save();
    renderSettings();
    toast('Disconnected (Google Calendar events kept)');
  }

  // --------------------------------------------------------- notifications
  let swReg = null;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  }
  async function enableNotifications() {
    if (!('Notification' in window)) { toast('Notifications not supported here'); return; }
    const perm = await Notification.requestPermission();
    toast(perm === 'granted' ? 'Notifications on ✓' : 'Notifications blocked');
    if (perm === 'granted') scheduleTodayReminder();
  }
  function showNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (swReg && swReg.active) swReg.active.postMessage({ type: 'notify', title, body });
    else try { new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch (e) {}
  }
  function dueCountToday() {
    const today = todayStr();
    return reviewEvents().filter((r) => !r.done && r.date <= today).length;
  }
  // One summary notification per day at the reminder time (best-effort while open).
  function scheduleTodayReminder() {
    clearTimeout(scheduleTodayReminder._t);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const [hh, mm] = state.settings.reminderTime.split(':').map(Number);
    const now = new Date();
    const at = new Date(); at.setHours(hh, mm, 0, 0);
    if (at > now) {
      scheduleTodayReminder._t = setTimeout(fireDaily, at - now);
    } else {
      maybeNotifySoon(); // already past reminder time today
    }
  }
  function fireDaily() {
    const c = dueCountToday();
    if (c > 0 && state.settings.lastNotified !== todayStr()) {
      showNotification('Time to review 🧠', `${c} topic${c === 1 ? '' : 's'} due today in Recall.`);
      state.settings.lastNotified = todayStr(); save();
    }
  }
  function maybeNotifySoon() {
    const [hh, mm] = state.settings.reminderTime.split(':').map(Number);
    const at = new Date(); at.setHours(hh, mm, 0, 0);
    if (new Date() >= at) fireDaily();
  }

  // --------------------------------------------------------- install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e; $('#installBtn').style.display = 'inline-flex';
  });
  $('#installBtn').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null;
    $('#installBtn').style.display = 'none';
  };

  // ------------------------------------------------------------ data backup
  function exportBackup() {
    triggerDownload(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
      'recall-backup-' + todayStr() + '.json');
    toast('Backup downloaded');
  }
  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.topics || !data.settings) throw new Error('bad file');
        state = Object.assign(structuredClone(DEFAULTS), data);
        state.settings = Object.assign(structuredClone(DEFAULTS.settings), data.settings);
        save(); render(); toast('Backup restored');
      } catch (e) { toast('Not a valid Recall backup'); }
    };
    reader.readAsText(file);
  }

  function pickColor() {
    const palette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16', '#f97316', '#14b8a6'];
    return palette[state.classes.length % palette.length];
  }

  // ----------------------------------------------------------------- wiring
  function wire() {
    $$('nav.tabs button').forEach((b) => b.onclick = () => switchView(b.dataset.view));
    $('#fab').onclick = () => openTopicModal();
    $('#addTopicBtn2').onclick = () => openTopicModal();
    $('#addClassBtn').onclick = () => openClassModal();
    $('#prevMonth').onclick = () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); };
    $('#nextMonth').onclick = () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); };
    $('#todayBtn').onclick = () => { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); };
    $('#exportAllIcs').onclick = exportAllIcs;
    $('#syncBtn').onclick = syncBlackbaud;

    // settings
    $('#saveSchedule').onclick = () => {
      const ints = $('#intervalsInput').value.split(',').map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (!ints.length) { toast('Enter at least one interval'); return; }
      state.settings.intervals = ints;
      state.settings.reminderTime = $('#reminderTime').value || '18:00';
      save(); scheduleTodayReminder(); toast('Schedule saved');
    };
    $('#enableNotif').onclick = enableNotifications;
    $('#testNotif').onclick = () => {
      if (Notification && Notification.permission === 'granted') showNotification('Recall test 🔔', 'Notifications are working.');
      else enableNotifications();
    };
    $('#bbSync').onclick = () => {
      state.settings.bbUrl = $('#bbUrl').value.trim();
      state.settings.bbProxy = $('#bbProxy').value;
      save(); syncBlackbaud();
    };
    $('#bbAutoSync').onchange = (e) => {
      state.settings.bbUrl = $('#bbUrl').value.trim();
      state.settings.bbProxy = $('#bbProxy').value;
      state.settings.bbAutoSync = e.target.checked;
      save(); startAutoSync();
      toast(e.target.checked ? 'Auto-sync on ✓' : 'Auto-sync off');
    };

    // Google Calendar direct sync
    $('#gConnect').onclick = connectGoogleCalendar;
    $('#gResync').onclick = resyncAllToGoogle;
    $('#gDisconnect').onclick = disconnectGoogle;
    $('#bbImportBtn').onclick = () => $('#bbFile').click();
    $('#bbFile').onchange = (e) => { const f = e.target.files[0]; if (f) f.text().then(ingestIcsText); };
    $('#bbClear').onclick = () => { state.assignments = []; save(); render(); toast('Assignments cleared'); };
    const drop = $('#bbDrop');
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) f.text().then(ingestIcsText); });
    drop.addEventListener('click', () => $('#bbFile').click());

    $('#backupBtn').onclick = exportBackup;
    $('#restoreBtn').onclick = () => $('#restoreFile').click();
    $('#restoreFile').onchange = (e) => { const f = e.target.files[0]; if (f) importBackup(f); };
    $('#wipeBtn').onclick = () => {
      if (confirm('Erase ALL topics, classes and settings on this device? This cannot be undone.')) {
        state = structuredClone(DEFAULTS); save(); render(); toast('Everything erased');
      }
    };

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  }

  // ------------------------------------------------------------------- init
  registerSW();
  wire();
  switchView('calendar');
  if (Notification && Notification.permission === 'granted') scheduleTodayReminder();
  startAutoSync();
})();
