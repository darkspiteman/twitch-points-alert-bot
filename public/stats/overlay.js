// Twitch Alert Bot — статистика на экране стрима (Browser Source). Что показывать — выбирается в панели бота
// («OBS / Streamlabs» → «Статистика на экране») и меняется сразу, без правки источника в OBS.
(function () {
  'use strict';
  var S = window.TABStats;
  var t = S.t, el = S.el;
  var bar = document.getElementById('bar');
  var data = null;
  var cells = {}; // id → { value, sub }

  function value(id, st) {
    var o = st.obs;
    switch (id) {
      case 'session': return S.duration(S.sessionMs(st));
      case 'viewers': return S.num(st.viewers);
      case 'chatters': return S.num(st.chatters);
      case 'followers': return S.num(st.followers);
      case 'followersSession': return '+' + S.num(st.followersSession);
      case 'subs': return S.num(st.subs);
      case 'subPoints': return S.num(st.subPoints);
      case 'bitrate': return o.bitrateKbps === null ? '—' : S.num(o.bitrateKbps) + ' ' + t('kbps');
      case 'resolution': return S.resolution(o);
      case 'dropped': return o.droppedPct === null ? '—' : o.droppedPct.toFixed(1) + ' %';
      case 'health': return o.health ? t(o.health) : '—';
    }
    return '—';
  }

  var layoutKey = '';
  function build() {
    var ov = data.overlay;
    var key = [ov.fields.join(','), ov.layout, ov.style, ov.labels, S.lang()].join('|');
    bar.className = 'bar ' + (ov.layout === 'column' ? 'column' : 'row') + ' ' + ov.style + (ov.labels ? '' : ' nolabels');
    document.documentElement.style.setProperty('--scale', String((ov.scale || 100) / 100));
    if (key === layoutKey) return;
    layoutKey = key;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    cells = {};
    ov.fields.forEach(function (id) {
      var cell = el('div', 'cell');
      cell.dataset.id = id;
      cell.appendChild(S.icon(id === 'followersSession' ? 'followers' : id));
      var txt = el('div', 'txt');
      var v = el('div', 'val');
      txt.appendChild(v);
      if (ov.labels) txt.appendChild(el('div', 'lab', t(id)));
      cell.appendChild(txt);
      bar.appendChild(cell);
      cells[id] = { cell: cell, value: v };
    });
  }

  function update() {
    if (!data) return;
    build();
    var st = data.stats;
    for (var id in cells) {
      cells[id].value.textContent = value(id, st);
      var cls = 'cell';
      if (id === 'health' && st.obs.health) cls += ' h-' + st.obs.health;
      if (id === 'bitrate' && st.obs.health && st.obs.health !== 'good' && st.obs.healthReason === 'bitrate_low') cls += ' h-' + st.obs.health;
      if (id === 'dropped' && st.obs.droppedPct !== null) cls += st.obs.droppedPct >= 5 ? ' h-bad' : st.obs.droppedPct >= 0.5 ? ' h-warn' : '';
      cells[id].cell.className = cls;
    }
  }

  S.connect(function (m) { data = m; update(); }, function (ok) {
    // Нет связи — на экране стрима ничего не показываем (зрители не должны видеть служебные сообщения).
    bar.hidden = !ok;
  }, 'overlay');
  setInterval(function () { if (data && cells.session) cells.session.value.textContent = value('session', data.stats); }, 1000);
})();
