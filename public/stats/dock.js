// Twitch Alert Bot — док-панель статистики для OBS («Док-панели» → «Пользовательские док-панели браузера»).
(function () {
  'use strict';
  var S = window.TABStats;
  var t = S.t, el = S.el;
  var data = null;
  var connected = false;

  var TILE_IDS = ['viewers', 'chatters', 'followers', 'bitrate', 'subs', 'subPoints', 'resolution', 'dropped', 'cpu'];
  var hidden = [];
  try { hidden = JSON.parse(localStorage.getItem('tab-stats-hidden') || '[]') || []; } catch (e) { hidden = []; }
  var embed = new URLSearchParams(location.search).get('embed') === '1';
  if (embed) document.body.classList.add('embed');

  function saveHidden() { try { localStorage.setItem('tab-stats-hidden', JSON.stringify(hidden)); } catch (e) { /* */ } }

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

  function renderNotes() {
    var st = data.stats;
    var root = document.getElementById('notes');
    while (root.firstChild) root.removeChild(root.firstChild);
    var notes = [];
    if (st.twitch !== 'ok') notes.push(['bad', t('notLogged')]);
    else if (st.missingScopes.length) {
      var names = st.missingScopes.map(function (s) {
        return s.indexOf('followers') >= 0 ? t('s_followers') : s.indexOf('subscriptions') >= 0 ? t('s_subs') : t('s_chatters');
      });
      notes.push(['warn', t('scopes', [names.join(', ')])]);
    }
    var o = st.obs;
    if (!o.enabled) notes.push(['info', t('obs_streamlabs')]);
    else if (o.state !== 'ok') notes.push([o.state === 'connecting' ? 'info' : 'warn', t('obs_' + o.state)]);
    if (o.health && o.health !== 'good' && o.healthReason) notes.push([o.health === 'bad' ? 'bad' : 'warn', t('r_' + o.healthReason)]);
    for (var i = 0; i < notes.length; i++) root.appendChild(el('div', 'note ' + notes[i][0], notes[i][1]));
  }

  function feedText(f) {
    switch (f.kind) {
      case 'follow': return t('f_follow');
      case 'sub': return t('f_sub') + (f.tier && f.tier !== '1' ? ' (T' + f.tier + ')' : '');
      case 'resub': return t('f_resub', [f.n || 1]);
      case 'gift': return t('f_gift', [f.n || 1]);
      case 'raid': return t('f_raid', [S.num(f.n || 0)]);
      case 'join': return t('f_join');
    }
    return '';
  }
  var FEED_ICON = { follow: 'followers', sub: 'subs', resub: 'subs', gift: 'subPoints', raid: 'viewers', join: 'chatters' };

  function renderLists() {
    var st = data.stats;
    document.getElementById('feed-title').textContent = t('feed');
    document.getElementById('chat-title').textContent = t('chat') + (st.chatters !== null ? ' · ' + S.num(st.chatters) : '');
    var feed = document.getElementById('feed');
    while (feed.firstChild) feed.removeChild(feed.firstChild);
    if (!st.feed.length) feed.appendChild(el('li', 'empty', t('noFeed')));
    for (var i = 0; i < st.feed.length; i++) {
      var f = st.feed[i];
      var li = el('li', 'f-' + f.kind);
      li.appendChild(S.icon(FEED_ICON[f.kind] || 'health'));
      var txt = el('span', 'f-text');
      if (f.kind === 'gift' && !f.name) txt.appendChild(el('span', null, t('f_giftAnon', [f.n || 1])));
      else { txt.appendChild(el('b', null, f.name)); txt.appendChild(document.createTextNode(' ' + feedText(f))); }
      li.appendChild(txt);
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
      var item = el('li', null, c.name);
      if (c.since && now - c.since < 10 * 60000) { item.className = 'new'; item.appendChild(el('span', 'mark', t('newMark') + ' · ' + S.ago(c.since))); }
      chat.appendChild(item);
    }
  }

  function renderMenu() {
    var m = document.getElementById('tiles-menu');
    while (m.firstChild) m.removeChild(m.firstChild);
    m.appendChild(el('div', 'menu-title', t('tiles')));
    TILE_IDS.forEach(function (id) {
      var lab = el('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = hidden.indexOf(id) < 0;
      cb.addEventListener('change', function () {
        hidden = hidden.filter(function (x) { return x !== id; });
        if (!cb.checked) hidden.push(id);
        saveHidden();
        if (data) renderTiles();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + t(id)));
      m.appendChild(lab);
    });
  }

  document.getElementById('gear').addEventListener('click', function () {
    var m = document.getElementById('tiles-menu');
    m.hidden = !m.hidden;
    if (!m.hidden) renderMenu();
  });

  function render() {
    if (!data) return;
    document.documentElement.lang = S.lang();
    renderTop();
    renderNotes();
    renderTiles();
    renderLists();
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
  setInterval(function () { if (data && connected) renderLists(); }, 30000);
})();
