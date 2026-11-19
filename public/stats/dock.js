// Twitch Alert Bot — док-панель статистики для OBS («Док-панели» → «Пользовательские док-панели браузера»)
// и для Streamlabs Desktop (элемент «Website» в Layout Editor).
(function () {
  'use strict';
  var S = window.TABStats;
  var t = S.t, el = S.el;
  var data = null;
  var connected = false;

  var TILE_IDS = ['viewers', 'chatters', 'followers', 'bitrate', 'subs', 'subPoints', 'resolution', 'dropped', 'cpu'];
  var SECTION_IDS = ['queue', 'feed', 'chat', 'summary'];
  /** Микрофон молчит дольше — предупреждение (во время эфира). */
  var MIC_SILENT_MS = 2 * 60000;

  function load(key) { try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* */ } }
  var hidden = load('tab-stats-hidden');
  var micIgnore = load('tab-stats-mic-ignore');
  var embed = new URLSearchParams(location.search).get('embed') === '1';
  if (embed) document.body.classList.add('embed');

  function isLive() { return !!(data && data.stats.live); }

  function tile(id, value, sub, extra, cls) {
    var box = el('div', 'tile' + (cls ? ' ' + cls : ''));
    box.dataset.id = id;
    var head = el('div', 'tile-head');
    head.appendChild(S.icon(id));
    head.appendChild(el('span', 'tile-label', t(id)));
    box.appendChild(head);
    // value — текст или [число, единица] (единица мельче, чтобы число влезало в узкую плитку).
    var v = el('div', 'tile-value', Array.isArray(value) ? value[0] : value);
    if (Array.isArray(value) && value[1]) v.appendChild(el('span', 'unit', value[1]));
    box.appendChild(v);
    if (sub) box.appendChild(el('div', 'tile-sub', sub));
    if (extra) box.appendChild(extra);
    return box;
  }

  function renderTiles() {
    var st = data.stats;
    var o = st.obs;
    var root = document.getElementById('tiles');
    var list = [];
    var viewersTile = tile('viewers', S.num(st.viewers), st.peakViewers ? t('peak', [S.num(st.peakViewers)]) : '');
    viewersTile.title = t('twitchDelay');
    list.push(viewersTile);
    var ch = tile('chatters', S.num(st.chatters), '');
    ch.title = t('twitchDelay');
    list.push(ch);
    list.push(tile('followers', S.num(st.followers), st.followersSession ? t('perStream', [st.followersSession]) : '', null, st.followersSession ? 'plus' : ''));
    var br = o.bitrateKbps === null ? '—' : [S.num(o.bitrateKbps), t('kbps')];
    list.push(tile('bitrate', br, '', S.sparkline(o.bitrateHistory, 120, 28), o.health ? 'h-' + o.health : ''));
    list.push(tile('subs', S.num(st.subs), st.subsSession ? t('perStream', [st.subsSession]) : '', null, st.subsSession ? 'plus' : ''));
    list.push(tile('subPoints', S.num(st.subPoints), ''));
    var resSub = o.width ? o.width + '×' + o.height + (o.activeFps ? ' · ' + o.activeFps + ' FPS' : '') : '';
    list.push(tile('resolution', S.resolution(o), resSub));
    var dropCls = o.droppedPct === null ? '' : o.droppedPct >= 5 ? 'h-bad' : o.droppedPct >= 0.5 ? 'h-warn' : '';
    list.push(tile('dropped', o.droppedPct === null ? '—' : [o.droppedPct.toFixed(1), '%'], o.droppedPct === null ? '' : S.num(o.droppedFrames), null, dropCls));
    list.push(tile('cpu', o.cpu === null ? '—' : [o.cpu.toFixed(0), '%'], '', null, o.cpu >= 90 ? 'h-warn' : ''));
    while (root.firstChild) root.removeChild(root.firstChild);
    for (var i = 0; i < list.length; i++) if (hidden.indexOf(list[i].dataset.id) < 0) root.appendChild(list[i]);
  }

  function renderTop() {
    var st = data.stats;
    var mk = document.getElementById('marker');
    mk.hidden = !st.live;
    mk.textContent = t('marker');
    mk.title = t('markerTitle');
    var live = document.getElementById('live');
    live.className = 'live ' + (st.live ? 'on' : 'off');
    document.getElementById('live-text').textContent = st.live ? t('live') : t('offline');
    var hEl = document.getElementById('health');
    var o = st.obs;
    if (o.health) {
      hEl.hidden = false;
      hEl.className = 'health h-' + o.health;
      hEl.textContent = t(o.health);
      hEl.title = o.healthReason ? t('r_' + o.healthReason) : '';
    } else hEl.hidden = true;
    tickSession();
  }

  function tickSession() {
    if (!data) return;
    document.getElementById('session').textContent = S.duration(S.sessionMs(data.stats));
  }

  // ---------------- Микрофон ----------------

  /**
   * Тревога «вас не слышно»: только если ВСЕ микрофоны в эфире выключены (или на нуле). Часто один микрофон
   * (например, «Mic/Aux» из настроек звука OBS) выключен специально, а говорят через другой источник — это не тревога.
   * Долгая тишина — только в эфире и только если молчат все включённые микрофоны.
   */
  function micAlerts() {
    var mics = (data.stats.obs && data.stats.obs.mics) || [];
    var live = isLive();
    var watched = mics.filter(function (m) { return m.active && micIgnore.indexOf(m.name) < 0; });
    if (!watched.length) return [];
    var on = watched.filter(function (m) { return !m.muted && m.volume > 0; });
    var names = function (list) { return list.map(function (m) { return m.name; }).join('», «'); };
    if (!on.length) {
      var allZero = watched.every(function (m) { return !m.muted; });
      return [{ level: live ? 'bad' : 'warn', text: allZero ? t('mic_zero', [names(watched)]) : t(live ? 'mic_muted_live' : 'mic_muted', [names(watched)]) }];
    }
    if (live && on.every(function (m) { return m.silentMs !== null && m.silentMs >= MIC_SILENT_MS; })) {
      var min = Math.min.apply(null, on.map(function (m) { return m.silentMs; }));
      return [{ level: 'warn', text: t('mic_silent', [names(on), Math.floor(min / 60000)]) }];
    }
    return [];
  }

  function renderMic() {
    var root = document.getElementById('mic');
    while (root.firstChild) root.removeChild(root.firstChild);
    var alerts = micAlerts();
    root.hidden = !alerts.length;
    for (var i = 0; i < alerts.length; i++) {
      var a = el('div', 'mic-alert ' + alerts[i].level);
      a.appendChild(S.icon('mic'));
      a.appendChild(el('span', null, alerts[i].text));
      root.appendChild(a);
    }
  }

  function renderNotes() {
    var st = data.stats;
    var root = document.getElementById('notes');
    while (root.firstChild) root.removeChild(root.firstChild);
    var notes = [];
    if (st.twitch !== 'ok') notes.push(['bad', t('notLogged')]);
    else if (st.missingScopes.length) {
      var names = st.missingScopes.map(function (s) {
        return s.indexOf('followers') >= 0 ? t('s_followers') : s.indexOf('subscriptions') >= 0 ? t('s_subs') : s.indexOf('broadcast') >= 0 ? t('s_markers') : s.indexOf('shoutouts') >= 0 ? t('s_shoutouts') : t('s_chatters');
      });
      notes.push(['warn', t('scopes', [names.join(', ')])]);
    }
    var o = st.obs;
    if (!o.enabled) notes.push(['info', t('obs_streamlabs')]);
    else if (o.state !== 'ok') notes.push([o.state === 'connecting' ? 'info' : 'warn', t('obs_' + o.state)]);
    if (o.health && o.health !== 'good' && o.healthReason) notes.push([o.health === 'bad' ? 'bad' : 'warn', t('r_' + o.healthReason)]);
    for (var i = 0; i < notes.length; i++) root.appendChild(el('div', 'note ' + notes[i][0], notes[i][1]));
  }

  // ---------------- Очередь оповещений ----------------

  function api(path) {
    return fetch(path, { method: 'POST', headers: { 'x-tab-request': '1' } }).catch(function () { /* связь вернётся — данные обновятся */ });
  }

  function iconButton(text, title, onClick, cls) {
    var b = el('button', 'qbtn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  function queueLine(item, current) {
    var li = el('li', current ? 'q-current' : null);
    var txt = el('span', 'f-text');
    txt.appendChild(el('b', null, item.rewardTitle));
    if (item.userName) txt.appendChild(document.createTextNode(' — ' + item.userName));
    li.appendChild(txt);
    if (current) li.appendChild(iconButton('⏭', t('q_skip'), function () { api('/api/queue/skip'); }));
    else li.appendChild(iconButton('✕', t('q_remove'), function () { api('/api/queue/remove/' + encodeURIComponent(item.id)); }, 'small'));
    return li;
  }

  var queueSig = '';
  function renderQueue() {
    var box = document.getElementById('queue');
    box.hidden = hidden.indexOf('queue') >= 0 || !data.queue;
    if (box.hidden) { queueSig = ''; return; }
    var q = data.queue;
    // Перерисовываем только при изменении: иначе кнопка может исчезнуть прямо под курсором (данные приходят каждые 2 с).
    var sig = JSON.stringify([q, S.lang()]);
    if (sig === queueSig) return;
    queueSig = sig;
    var head = document.getElementById('queue-head');
    while (head.firstChild) head.removeChild(head.firstChild);
    var title = el('h2', null, t('queue') + (q.items.length ? ' · ' + q.items.length : ''));
    head.appendChild(title);
    if (q.paused) head.appendChild(el('span', 'q-paused', t('q_paused')));
    var tools = el('span', 'q-tools');
    tools.appendChild(q.paused
      ? iconButton('▶', t('q_resume'), function () { api('/api/queue/resume'); })
      : iconButton('⏸', t('q_pause'), function () { api('/api/queue/pause'); }));
    head.appendChild(tools);
    var ul = document.getElementById('queue-list');
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    if (q.current) ul.appendChild(queueLine(q.current, true));
    var show = q.items.slice(0, 5);
    for (var i = 0; i < show.length; i++) ul.appendChild(queueLine(show[i], false));
    if (q.items.length > show.length) ul.appendChild(el('li', 'empty', t('q_more', [q.items.length - show.length])));
    if (!q.current && !q.items.length) ul.appendChild(el('li', 'empty', q.paused ? t('q_emptyPaused') : t('q_empty')));
  }

  // ---------------- События и чат ----------------

  function feedText(f) {
    switch (f.kind) {
      case 'follow': return t('f_follow');
      case 'sub': return t('f_sub') + (f.tier && f.tier !== '1' ? ' (T' + f.tier + ')' : '');
      case 'resub': return t('f_resub', [f.n || 1]);
      case 'gift': return t('f_gift', [f.n || 1]);
      case 'raid': return t('f_raid', [S.num(f.n || 0)]);
      case 'join': return f.first ? t('f_joinFirst') : f.n > 1 ? t('f_joinN', [f.n]) : t('f_join');
      case 'redeem': return '— ' + (f.text || '');
      case 'marker': return t('f_marker') + ' · ' + S.duration((f.n || 0) * 1000);
    }
    return '';
  }
  var FEED_ICON = { follow: 'followers', sub: 'subs', resub: 'subs', gift: 'subPoints', raid: 'viewers', join: 'chatters', redeem: 'reward', marker: 'session' };

  function shoutoutButton(f) {
    var b = iconButton(t('so'), t('soTitle'), function () {
      b.disabled = true;
      fetch('/api/stats/shoutout', { method: 'POST', headers: { 'x-tab-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ uid: f.uid, name: f.name }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) { toast(res.ok ? t('soDone') : (res.j && res.j.error) || 'Error', res.ok); })
        .catch(function () { toast(t('lost'), false); })
        .then(function () { b.disabled = false; });
    }, 'so-btn');
    return b;
  }

  var listsSig = '';
  function renderLists(force) {
    var st = data.stats;
    // Перерисовка только при изменении (или раз в 30 с для «N мин назад»): иначе кнопка «Шаутаут» пропадала бы под курсором.
    var sig = JSON.stringify([st.feed, st.chattersList, st.chatters, st.live, st.chattersTrackedSince, hidden, S.lang()]);
    if (!force && sig === listsSig) return;
    listsSig = sig;
    var feedBox = document.getElementById('feed-box');
    var chatBox = document.getElementById('chat-box');
    feedBox.hidden = hidden.indexOf('feed') >= 0;
    chatBox.hidden = hidden.indexOf('chat') >= 0;
    document.getElementById('feed-title').textContent = t('feed');
    document.getElementById('chat-title').textContent = t('chat') + (st.chatters !== null ? ' · ' + S.num(st.chatters) : '');
    var feed = document.getElementById('feed');
    while (feed.firstChild) feed.removeChild(feed.firstChild);
    if (!st.feed.length) feed.appendChild(el('li', 'empty', t('noFeed')));
    for (var i = 0; i < st.feed.length; i++) {
      var f = st.feed[i];
      var li = el('li', 'f-' + f.kind + (f.first ? ' f-first' : ''));
      li.appendChild(S.icon(FEED_ICON[f.kind] || 'health'));
      var txt = el('span', 'f-text');
      if (f.kind === 'gift' && !f.name) txt.appendChild(el('span', null, t('f_giftAnon', [f.n || 1])));
      else if (f.kind === 'marker') txt.appendChild(el('span', null, feedText(f)));
      else { txt.appendChild(el('b', null, f.name)); txt.appendChild(document.createTextNode(' ' + feedText(f))); }
      li.appendChild(txt);
      if (f.kind === 'raid' && f.uid) li.appendChild(f.so ? el('span', 'so-done', '✓ ' + t('so').replace(/^\S+ /, '')) : shoutoutButton(f));
      li.appendChild(el('span', 'f-ago', S.ago(f.at)));
      feed.appendChild(li);
    }
    var chat = document.getElementById('chat');
    while (chat.firstChild) chat.removeChild(chat.firstChild);
    if (st.chatters === 0) chat.appendChild(el('li', 'empty', t('noChat')));
    else if (st.chatters === null) chat.appendChild(el('li', 'empty', '—'));
    var now = Date.now();
    for (var j = 0; j < st.chattersList.length; j++) {
      var c = st.chattersList[j];
      var item = el('li', c.first ? 'first' : null);
      item.appendChild(el('span', 'c-name', c.name));
      var marks = el('span', 'mark');
      if (c.first) marks.appendChild(el('span', 'badge-first', t('firstMark')));
      else if (c.visits > 1) { var vb = el('span', 'badge-visits', '×' + c.visits); vb.title = t('visitsTitle', [c.visits]); marks.appendChild(vb); }
      if (c.since && now - c.since < 10 * 60000) { item.classList.add('new'); marks.appendChild(document.createTextNode(' ' + t('newMark') + ' · ' + S.ago(c.since))); }
      item.appendChild(marks);
      chat.appendChild(item);
    }
    // «Впервые» появится, когда бот запомнит зрителей с начала стрима.
    var note = document.getElementById('chat-note');
    var tracked = st.chattersTrackedSince;
    var showNote = st.live && st.chatters !== null && (!tracked || (st.sessionStart && tracked > st.sessionStart + 60000));
    note.hidden = !showNote;
    note.textContent = showNote ? t('trackNote') : '';
  }

  // ---------------- Итоги прошлого стрима ----------------

  function dateText(ts) {
    try { return new Date(ts).toLocaleDateString(S.lang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short' }); } catch (e) { return ''; }
  }

  function delta(cur, prev) {
    if (prev === null || prev === undefined || cur === null || cur === undefined || cur === prev) return null;
    var d = cur - prev;
    return el('span', 'delta ' + (d > 0 ? 'up' : 'down'), (d > 0 ? '▲ ' : '▼ ') + S.num(Math.abs(d)));
  }

  function sumCell(label, value, sub, d) {
    var c = el('div', 'sum-cell');
    c.appendChild(el('div', 'sum-label', label));
    var v = el('div', 'sum-value', value);
    if (d) v.appendChild(d);
    c.appendChild(v);
    if (sub) c.appendChild(el('div', 'sum-sub', sub));
    return c;
  }

  function namesLine(label, names, total) {
    if (!names || !names.length) return null;
    var p = el('div', 'sum-names');
    p.appendChild(el('span', 'sum-label', label + ': '));
    var shown = names.slice(0, 12);
    p.appendChild(document.createTextNode(shown.join(', ') + (total > shown.length ? ' ' + t('andMore', [total - shown.length]) : '')));
    return p;
  }

  function renderSummary() {
    var box = document.getElementById('summary');
    var sums = data.stats.summaries || [];
    var s = sums[0];
    box.hidden = hidden.indexOf('summary') >= 0 || isLive() || !s;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (box.hidden) return;
    var p = sums[1] || null;
    box.appendChild(el('h2', null, t('sumTitle') + ' · ' + dateText(s.startedAt) + ' · ' + S.duration(s.endedAt - s.startedAt)));
    var grid = el('div', 'sum-grid');
    grid.appendChild(sumCell(t('sumViewers'), S.num(s.avgViewers), t('peak', [S.num(s.peakViewers)]), delta(s.avgViewers, p && p.avgViewers)));
    grid.appendChild(sumCell(t('followers'), '+' + S.num(s.followers), '', delta(s.followers, p && p.followers)));
    var subSub = [];
    if (s.resubs) subSub.push(t('sumResubs', [s.resubs]));
    if (s.gifts) subSub.push(t('sumGifts', [s.gifts]));
    grid.appendChild(sumCell(t('subs'), '+' + S.num(s.subs), subSub.join(' · '), delta(s.subs, p && p.subs)));
    grid.appendChild(sumCell(t('chatters'), s.chatters === null ? '—' : S.num(s.chatters), s.newChatters ? t('sumNew', [s.newChatters]) : '', delta(s.chatters, p && p.chatters)));
    grid.appendChild(sumCell(t('sumRaids'), S.num(s.raids.length), s.raids.length ? s.raids.map(function (r) { return r.name; }).slice(0, 2).join(', ') : ''));
    grid.appendChild(sumCell(t('sumRedeems'), S.num(s.redemptions), '', delta(s.redemptions, p && p.redemptions)));
    box.appendChild(grid);
    var lines = [
      namesLine(t('sumFollowerNames'), s.followerNames, s.followers),
      namesLine(t('sumNewChatterNames'), s.newChatterNames, s.newChatters),
      namesLine(t('sumSubNames'), s.subNames, s.subNames.length),
      namesLine(t('sumRaidNames'), s.raids.map(function (r) { return r.name + ' (' + r.viewers + ')'; }), s.raids.length),
      namesLine(t('sumTopRewards'), (s.topRewards || []).map(function (x) { return '«' + x[0] + '» ×' + x[1]; }), (s.topRewards || []).length),
      namesLine(t('sumTopUsers'), (s.topUsers || []).map(function (x) { return x[0] + ' ×' + x[1]; }), (s.topUsers || []).length),
      namesLine(t('sumMarkers'), (s.markers || []).map(function (sec) { return S.duration(sec * 1000); }), (s.markers || []).length),
    ];
    for (var i = 0; i < lines.length; i++) if (lines[i]) box.appendChild(lines[i]);
    box.appendChild(el('div', 'sum-hint', t('sumHint')));
  }

  // ---------------- Меню ⚙ ----------------

  function checkbox(label, checked, onChange) {
    var lab = el('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', function () { onChange(cb.checked); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + label));
    return lab;
  }

  function toggleHidden(id, show) {
    hidden = hidden.filter(function (x) { return x !== id; });
    if (!show) hidden.push(id);
    save('tab-stats-hidden', hidden);
    if (data) render();
  }

  function renderMenu() {
    var m = document.getElementById('tiles-menu');
    while (m.firstChild) m.removeChild(m.firstChild);
    m.appendChild(el('div', 'menu-title', t('tiles')));
    TILE_IDS.forEach(function (id) { m.appendChild(checkbox(t(id), hidden.indexOf(id) < 0, function (on) { toggleHidden(id, on); })); });
    m.appendChild(el('div', 'menu-title', t('sections')));
    SECTION_IDS.forEach(function (id) { m.appendChild(checkbox(t('sec_' + id), hidden.indexOf(id) < 0, function (on) { toggleHidden(id, on); })); });
    var mics = (data && data.stats.obs.mics) || [];
    m.appendChild(el('div', 'menu-title', t('micWatch')));
    if (!mics.length) m.appendChild(el('div', 'menu-empty', t('micNone')));
    mics.forEach(function (mic) {
      m.appendChild(checkbox(mic.name, micIgnore.indexOf(mic.name) < 0, function (on) {
        micIgnore = micIgnore.filter(function (x) { return x !== mic.name; });
        if (!on) micIgnore.push(mic.name);
        save('tab-stats-mic-ignore', micIgnore);
        if (data) renderMic();
      }));
    });
  }

  var toastTimer = 0;
  function toast(text, ok) {
    var el2 = document.getElementById('toast');
    el2.textContent = text;
    el2.className = 'toast ' + (ok ? 'ok' : 'bad');
    el2.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el2.hidden = true; }, 4000);
  }

  document.getElementById('marker').addEventListener('click', function () {
    var b = document.getElementById('marker');
    b.disabled = true;
    fetch('/api/stats/marker', { method: 'POST', headers: { 'x-tab-request': '1' } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) { toast(res.ok ? t('markerOk', [S.duration(res.j.position * 1000)]) : (res.j && res.j.error) || 'Error', res.ok); })
      .catch(function () { toast(t('lost'), false); })
      .then(function () { b.disabled = false; });
  });

  document.getElementById('gear').addEventListener('click', function () {
    var m = document.getElementById('tiles-menu');
    m.hidden = !m.hidden;
    if (!m.hidden) renderMenu();
  });

  function render() {
    if (!data) return;
    document.documentElement.lang = S.lang();
    renderTop();
    renderMic();
    renderNotes();
    renderTiles();
    renderQueue();
    renderLists();
    renderSummary();
  }

  function setConn(ok) {
    connected = ok;
    var c = document.getElementById('conn');
    c.hidden = ok;
    c.textContent = t(data ? 'lost' : 'connecting');
  }

  setConn(false);
  S.connect(function (m) { data = m; render(); }, setConn);
  setInterval(function () { tickSession(); }, 1000);
  // «N мин назад» в списках — раз в 30 с, даже без новых данных.
  setInterval(function () { if (data && connected) renderLists(true); }, 30000);
})();
