// Twitch Alert Bot — счётчики на экране стрима (Browser Source). Значения меняются кнопками +1 / −1 в доке OBS,
// названия и вид — в панели бота («Стрим» → «Счётчики»). Названия выводятся только через textContent.
(function () {
  'use strict';
  var S = window.TABStats;
  var el = S.el;
  var root = document.getElementById('list');
  var rows = {}; // id → { row, value, last }
  var layoutKey = '';

  function update(m) {
    var list = (m.counters || []).filter(function (c) { return c.show; });
    var look = m.counterOverlay || { style: 'dark', scale: 100 };
    root.className = 'list ' + look.style;
    document.documentElement.style.setProperty('--scale', String((look.scale || 100) / 100));
    var key = list.map(function (c) { return c.id + ':' + c.name; }).join('|');
    if (key !== layoutKey) {
      layoutKey = key;
      while (root.firstChild) root.removeChild(root.firstChild);
      rows = {};
      list.forEach(function (c) {
        var row = el('div', 'row');
        row.appendChild(el('span', 'name', c.name));
        var v = el('span', 'value', S.num(c.value));
        row.appendChild(v);
        root.appendChild(row);
        rows[c.id] = { row: row, value: v, last: c.value };
      });
      return;
    }
    list.forEach(function (c) {
      var r = rows[c.id];
      if (!r || r.last === c.value) return;
      var up = c.value > r.last;
      r.last = c.value;
      r.value.textContent = S.num(c.value);
      // Короткая вспышка при изменении — зрители замечают +1.
      r.row.classList.remove('bump-up', 'bump-down');
      void r.row.offsetWidth;
      r.row.classList.add(up ? 'bump-up' : 'bump-down');
    });
  }

  S.connect(update, function (ok) {
    // Нет связи — ничего не показываем (зрители не должны видеть служебные сообщения).
    root.hidden = !ok;
  }, 'counter');
})();
