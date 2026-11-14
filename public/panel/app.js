// Twitch Alert Bot — панель управления.
// Все пользовательские строки выводятся только через textContent (защита от XSS).
(function () {
  'use strict';

  // ---------------- утилиты ----------------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'style') el.style.cssText = v; // CSSOM разрешён CSP, атрибут style — нет
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(id) { return document.getElementById(id); }

  function toast(text, kind) {
    var t = h('div', { class: 'toast ' + (kind || '') , text: text });
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 3500);
  }

  function api(method, path, body, extraHeaders) {
    var headers = { 'x-tab-request': '1' };
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) headers['Content-Type'] = 'application/json';
    if (extraHeaders) for (var k in extraHeaders) headers[k] = extraHeaders[k];
    return fetch(path, {
      method: method, headers: headers,
      body: body === undefined ? undefined : (body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body)),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Ошибка HTTP ' + r.status));
        return j;
      });
    }, function () { throw new Error('Нет связи с ботом. Проверьте, что он запущен.'); });
  }
  function post(path, body) { return api('POST', path, body === undefined ? {} : body); }

  function act(promise, okText) {
    return promise.then(function (r) { if (okText) toast(okText, 'ok'); return r; }, function (e) { toast(e.message, 'bad'); throw e; });
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU'); }
  function fmtDateTime(ts) { return new Date(ts).toLocaleString('ru-RU'); }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ'; }
  function fmtDur(ms) { if (!ms) return '—'; var s = ms / 1000; return s < 60 ? s.toFixed(1) + ' с' : Math.floor(s / 60) + ' мин ' + Math.round(s % 60) + ' с'; }
  function ago(ts) { if (!ts) return 'никогда'; var s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + ' с назад' : Math.round(s / 60) + ' мин назад'; }

  // ---------------- состояние ----------------
  var S = null; // полный state с сервера
  var page = 'home';
  var ws = null;
  var probed = {};

  function load() {
    return api('GET', '/api/state').then(function (s) {
      S = s;
      $('conn-banner').hidden = true;
      render();
      probeMedia();
    }, function (e) {
      $('conn-banner').hidden = false;
      $('conn-banner').textContent = e.message;
    });
  }

  var reloadTimer = null;
  function reloadSoon() { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 250); }

  function connectWs() {
    ws = new WebSocket('ws://' + location.host + '/ws/panel');
    ws.onopen = function () { $('conn-banner').hidden = true; load(); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!S) return;
      if (m.type === 'status') { S.status = m.status; renderSide(); if (page === 'home') renderHomeTop(); if (page === 'settings') renderAuthBox(); }
      else if (m.type === 'queue') { S.queue = m.queue; if (page === 'home') renderQueue(); }
      else if (m.type === 'event') { S.events.unshift(m.event); S.events = S.events.slice(0, 200); if (page === 'home') renderEventsMini(); if (page === 'log') renderLog(); }
      else if (m.type === 'invalidate') reloadSoon();
    };
    ws.onclose = function () {
      $('conn-banner').hidden = false;
      $('conn-banner').textContent = 'Нет связи с ботом. Переподключение…';
      setTimeout(connectWs, 2000);
    };
  }

  // Проверка медиафайлов в браузере: длительность и возможность воспроизведения.
  function probeMedia() {
    if (!S || !ws || ws.readyState !== 1) return;
    S.media.forEach(function (m) {
      if (probed[m.id] || m.kind === 'image' || m.source === 'klipy' || (m.duration_ms > 0 && m.status !== 'broken')) return;
      probed[m.id] = true;
      var el = document.createElement(m.kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      var done = false;
      var report = function (ok, msg) {
        if (done) return; done = true;
        ws.send(JSON.stringify({ type: 'probe', mediaId: m.id, ok: ok, durationMs: ok ? Math.round(el.duration * 1000) : 0, message: msg || '' }));
        el.removeAttribute('src'); el.load();
      };
      el.addEventListener('loadedmetadata', function () { report(isFinite(el.duration) && el.duration > 0, 'неизвестная длительность'); });
      el.addEventListener('error', function () { report(false, el.error ? 'код ' + el.error.code : 'ошибка'); });
      setTimeout(function () { report(false, 'превышено время проверки'); }, 15000);
      el.src = '/media/' + m.id;
    });
  }

  // ---------------- навигация ----------------
  function go() {
    page = (location.hash || '#home').slice(1);
    if (!$('page-' + page)) page = 'home';
    document.querySelectorAll('nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.page === page); });
    document.querySelectorAll('.page').forEach(function (p) { p.hidden = p.id !== 'page-' + page; });
    render();
  }
  window.addEventListener('hashchange', go);

  function render() {
    if (!S) return;
    renderSide();
    if (page === 'home') renderHome();
    else if (page === 'rewards') renderRewards();
    else if (page === 'media') renderMedia();
    else if (page === 'find') renderFind();
    else if (page === 'settings') renderSettings();
    else if (page === 'log') renderLog();
    else if (page === 'help') renderHelp();
  }

  // ---------------- статусы ----------------
  function twitchView(st) {
    var a = st.auth;
    if (a.status === 'ok') return { cls: 'ok', text: 'Подключён', detail: a.login };
    if (a.status === 'pending') return { cls: 'warn', text: 'Ожидает подтверждения', detail: 'Код: ' + a.userCode };
    if (a.status === 'no_client_id') return { cls: 'bad', text: 'Не настроен', detail: a.message };
    return { cls: 'bad', text: 'Отключён', detail: a.message };
  }
  function eventsubView(st) {
    var e = st.eventsub;
    var map = {
      connected: { cls: 'ok', text: 'Активен' },
      subscribing: { cls: 'warn', text: 'Подписка…' },
      connecting: { cls: 'warn', text: 'Подключение…' },
      reconnecting: { cls: 'warn', text: 'Переподключение…' },
      error: { cls: 'bad', text: 'Ошибка' },
      stopped: { cls: '', text: 'Не запущен' },
    };
    var v = map[e.state] || { cls: '', text: e.state };
    v.detail = e.state === 'connected' ? 'Последнее сообщение: ' + ago(e.lastMessageAt)
      : e.state === 'reconnecting' && e.nextRetryAt ? 'Повтор через ' + Math.max(0, Math.round((e.nextRetryAt - Date.now()) / 1000)) + ' с' + (e.lastError ? ' (' + e.lastError + ')' : '')
      : e.lastError || (st.auth.status !== 'ok' ? 'Требуется вход в Twitch' : '');
    return v;
  }
  function overlayView(st) {
    var n = st.overlays.length, obs = st.overlays.filter(function (o) { return o.isObs; }).length;
    if (!n) return { cls: 'bad', text: 'Не подключён', detail: 'Добавьте Browser Source в OBS' };
    var detail = obs ? 'OBS: ' + obs + (n > obs ? ', браузер: ' + (n - obs) : '') : 'Только предпросмотр в браузере';
    if (obs > 1) return { cls: 'warn', text: 'Подключено: ' + n, detail: 'Внимание: ' + obs + ' источника OBS — звук может дублироваться' };
    return { cls: obs ? 'ok' : 'warn', text: 'Подключён', detail: detail };
  }

  function renderSide() {
    var el = clear($('side-status'));
    var st = S.status;
    [['Twitch', twitchView(st)], ['EventSub', eventsubView(st)], ['Overlay', overlayView(st)]].forEach(function (x) {
      el.appendChild(h('div', null, h('span', { class: 'dot ' + x[1].cls }), x[0] + ': ' + x[1].text));
    });
    if (st.mode === 'observe') el.appendChild(h('div', null, h('span', { class: 'dot warn' }), 'Режим наблюдения'));
  }

  // ---------------- Главная ----------------
  function statCard(label, v, actions) {
    return h('div', { class: 'card stat' },
      h('div', { class: 'label', text: label }),
      h('div', { class: 'value' }, h('span', { class: 'dot ' + v.cls }), v.text),
      h('div', { class: 'detail', text: v.detail || '' }),
      actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
  }

  function renderHomeTop() {
    var root = $('home-top');
    if (!root) return;
    clear(root);
    var st = S.status;

    // Мастер первоначальной настройки
    var steps = [
      { done: !!S.settings.clientId, text: 'Укажите Client ID приложения Twitch', go: '#settings' },
      { done: st.auth.status === 'ok', text: 'Войдите через Twitch', go: '#settings' },
      { done: st.overlays.some(function (o) { return o.isObs; }), text: 'Добавьте Browser Source в OBS', go: '#help' },
      { done: S.rewards.some(function (r) { return r.bot_enabled && (r.media_id || r.sound_id || r.video_id); }), text: 'Назначьте медиафайлы наградам и включите их', go: '#rewards' },
    ];
    if (steps.some(function (s) { return !s.done; })) {
      root.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Первоначальная настройка' }),
        h('ol', { class: 'steps' }, steps.map(function (s) {
          return h('li', { class: s.done ? 'done' : '' }, h('span', null, s.text, ' ', s.done ? null : h('a', { href: s.go, text: 'Перейти →' })));
        }))));
    }

    var tw = twitchView(st);
    var twActions = st.auth.status === 'ok' ? [] : [h('button', { class: 'primary small', text: 'Войти', onclick: function () { location.hash = '#settings'; } })];
    var es = eventsubView(st);
    var esActions = st.auth.status === 'ok' ? [h('button', { class: 'small', text: 'Переподключить', onclick: function () { act(post('/api/eventsub/reconnect'), 'Переподключение запущено'); } })] : [];
    var modeCard = h('div', { class: 'card stat' },
      h('div', { class: 'label', text: 'Режим' }),
      h('div', { class: 'value' }, h('span', { class: 'dot ' + (st.mode === 'active' ? 'ok' : 'warn') }), st.mode === 'active' ? 'Активный' : 'Наблюдение'),
      h('div', { class: 'detail', text: st.mode === 'active' ? 'Оповещения воспроизводятся' : 'События записываются, но не воспроизводятся' }),
      h('div', { class: 'actions' }, h('button', {
        class: 'small', text: st.mode === 'active' ? 'Включить наблюдение' : 'Включить воспроизведение',
        onclick: function () { act(post('/api/settings', { mode: st.mode === 'active' ? 'observe' : 'active' })).then(load); },
      })));
    var audioOnly = !!S.settings.audioOnly;
    var videoCard = h('div', { class: 'card stat' },
      h('div', { class: 'label', text: 'Видео' }),
      h('div', { class: 'value' }, h('span', { class: 'dot ' + (audioOnly ? 'warn' : 'ok') }), audioOnly ? 'Только звук' : 'С видео'),
      h('div', { class: 'detail', text: audioOnly ? 'Видео выключено для всех наград' : 'Как настроено у каждой награды' }),
      h('div', { class: 'actions' }, h('button', {
        class: 'small', text: audioOnly ? 'Включить видео' : 'Только звук для всех',
        onclick: function () { act(post('/api/settings', { audioOnly: !audioOnly }), audioOnly ? 'Видео включено' : 'Теперь все награды — только звук').then(load); },
      })));
    root.appendChild(h('div', { class: 'grid cols-4' },
      statCard('Twitch', tw, twActions), statCard('EventSub', es, esActions), statCard('OBS overlay', overlayView(st)), modeCard, videoCard));

  }

  function renderHome() {
    var root = clear($('page-home'));
    root.appendChild(h('h1', { text: 'Главная' }));
    root.appendChild(h('div', { id: 'home-top' }));
    renderHomeTop();

    var testRow = h('div', { class: 'row' });
    var sel = h('select', { class: 'grow' }, h('option', { value: '', text: '— выберите награду —' }),
      S.rewards.filter(function (r) { return r.media_id || r.sound_id || r.video_id; }).map(function (r) { return h('option', { value: r.id, text: r.title + ' (' + r.cost + ')' }); }));
    testRow.appendChild(h('button', { class: 'primary', text: 'Тестовое оповещение', onclick: function () { act(post('/api/test'), 'Тест добавлен в очередь'); } }));
    testRow.appendChild(sel);
    testRow.appendChild(h('button', { text: 'Тест награды', onclick: function () {
      if (!sel.value) return toast('Выберите награду', 'bad');
      act(post('/api/rewards/' + encodeURIComponent(sel.value) + '/test'), 'Тест добавлен в очередь');
    } }));
    root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Тестирование' }), h('span', { class: 'muted small', text: 'Баллы канала не списываются' })), testRow));

    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card', id: 'queue-card' }), h('div', { class: 'card', id: 'events-card' })));
    renderQueue();
    renderEventsMini();

    root.appendChild(renderRedemptionsCard());
  }

  function renderQueue() {
    var card = $('queue-card');
    if (!card) return;
    clear(card);
    var q = S.queue;
    card.appendChild(h('div', { class: 'card-head' }, h('h2', { text: 'Очередь (' + q.items.length + ')' }),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: q.paused ? 'Продолжить' : 'Пауза', onclick: function () { act(post(q.paused ? '/api/queue/resume' : '/api/queue/pause')); } }),
        h('button', { class: 'small', text: 'Пропустить', disabled: !q.current, onclick: function () { act(post('/api/queue/skip')); } }),
        h('button', { class: 'small danger', text: 'Очистить', disabled: !q.items.length, onclick: function () {
          if (confirm('Удалить из очереди все ожидающие оповещения?')) act(post('/api/queue/clear'), 'Очередь очищена');
        } }))));
    if (q.paused) card.appendChild(h('div', { class: 'warnbox', text: 'Очередь на паузе — новые оповещения ждут.' }));
    var list = h('div', { class: 'list' });
    if (q.current) list.appendChild(h('div', { class: 'list-item' }, h('span', { class: 'badge ok', text: 'Играет' }),
      h('span', { class: 'grow', text: q.current.rewardTitle + ' — ' + q.current.userName })));
    q.items.forEach(function (it, i) {
      list.appendChild(h('div', { class: 'list-item' }, h('span', { class: 'badge', text: '#' + (i + 1) }),
        h('span', { class: 'grow', text: it.rewardTitle + ' — ' + it.userName }),
        h('button', { class: 'small', text: '✕', title: 'Убрать', onclick: function () { act(post('/api/queue/remove/' + encodeURIComponent(it.id))); } })));
    });
    if (!q.current && !q.items.length) list.appendChild(h('div', { class: 'empty', text: 'Очередь пуста' }));
    card.appendChild(list);
  }

  function levelBadge(l) { return h('span', { class: 'badge ' + (l === 'error' ? 'bad' : l === 'warn' ? 'warn' : ''), text: l === 'error' ? 'ошибка' : l === 'warn' ? 'внимание' : 'инфо' }); }

  function renderEventsMini() {
    var card = $('events-card');
    if (!card) return;
    clear(card);
    card.appendChild(h('div', { class: 'card-head' }, h('h2', { text: 'Последние события' }), h('a', { href: '#log', text: 'Весь журнал' })));
    var list = h('div', { class: 'list' });
    S.events.slice(0, 8).forEach(function (e) {
      list.appendChild(h('div', { class: 'list-item' }, levelBadge(e.level), h('span', { class: 'grow', text: e.message, title: e.message }), h('span', { class: 'muted small', text: fmtTime(e.ts) })));
    });
    if (!S.events.length) list.appendChild(h('div', { class: 'empty', text: 'Событий пока нет' }));
    card.appendChild(list);
  }

  var STATUS_RU = {
    received: ['получено', ''], queued: ['в очереди', 'accent'], playing: ['играет', 'ok'], done: ['воспроизведено', 'ok'],
    failed: ['ошибка', 'bad'], skipped: ['пропущено', 'warn'], dropped: ['отменено', 'warn'], ignored: ['не настроено', ''],
    observed: ['наблюдение', ''], missed: ['пропущено (устарело)', 'warn'],
  };
  var SOURCE_RU = { eventsub: 'Twitch', recovery: 'восстановлено', simulate: 'симуляция', test: 'тест' };

  function renderRedemptionsCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Последние активации наград' }));
    if (!S.redemptions.length) { card.appendChild(h('div', { class: 'empty', text: 'Пока не было активаций' })); return card; }
    var tb = h('tbody');
    S.redemptions.slice(0, 25).forEach(function (r) {
      var st = STATUS_RU[r.status] || [r.status, ''];
      tb.appendChild(h('tr', null,
        h('td', { class: 'muted', text: fmtTime(r.received_at) }),
        h('td', { text: r.user_name || r.user_login }),
        h('td', null, r.reward_title, r.user_input ? h('div', { class: 'muted small', text: '«' + r.user_input + '»' }) : null),
        h('td', null, h('span', { class: 'badge ' + st[1], text: st[0] }), r.status_msg ? h('div', { class: 'muted small', text: r.status_msg }) : null),
        h('td', { class: 'muted small', text: SOURCE_RU[r.source] || r.source })));
    });
    card.appendChild(h('table', null, h('thead', null, h('tr', null, h('th', { text: 'Время' }), h('th', { text: 'Зритель' }), h('th', { text: 'Награда' }), h('th', { text: 'Статус' }), h('th', { text: 'Источник' }))), tb));
    return card;
  }

  // ---------------- Награды ----------------
  function mediaOptions(selected, filter) {
    var opts = [h('option', { value: '', text: '— нет —' })];
    S.media.filter(filter || function () { return true; }).forEach(function (m) {
      var kind = m.source === 'klipy' ? '🌐' : ({ audio: '🔊', video: '🎬', image: '🖼' }[m.kind] || '');
      opts.push(h('option', { value: m.id, text: kind + ' ' + m.name + (m.source === 'klipy' ? ' (онлайн, Klipy)' : '') + (m.status === 'broken' ? ' (повреждён!)' : ''), selected: m.id === selected }));
    });
    return opts;
  }

  function saveReward(id, patch) {
    return act(post('/api/rewards/' + encodeURIComponent(id), patch), 'Сохранено').then(function (r) {
      for (var i = 0; i < S.rewards.length; i++) if (S.rewards[i].id === id) S.rewards[i] = r;
    });
  }

  function renderRewards() {
    var root = clear($('page-rewards'));
    root.appendChild(h('div', { class: 'card-head' }, h('h1', { text: 'Награды' }),
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: '+ Новая награда в Twitch', onclick: function () {
          var t = prompt('Название новой награды (до 45 символов):', '');
          if (!t) return;
          var c = Number(prompt('Стоимость в баллах:', '1000'));
          if (!c) return;
          var cd = Number(prompt('Перезарядка в секундах (0 — без перезарядки):', '60') || 0);
          if (!confirm('Создать в Twitch награду «' + t + '» за ' + c + ' баллов? Она сразу станет видна зрителям.')) return;
          act(post('/api/rewards/create', { confirm: true, title: t, cost: c, cooldownSec: cd }), 'Награда создана — назначьте ей медиафайл и включите').then(load);
        } }),
        h('button', { text: 'Обновить из Twitch', onclick: function () { act(post('/api/rewards/sync'), 'Список наград обновлён').then(load); } }),
        h('button', { text: 'Добавить локальную тестовую', onclick: function () {
          var t = prompt('Название тестовой награды (только для проверки, в Twitch не создаётся):', 'Тестовая награда');
          if (t) act(post('/api/rewards/local', { title: t })).then(load);
        } }))));
    root.appendChild(h('div', { class: 'infobox' },
      h('p', null, 'Награды загружаются из Twitch. Новые награды по умолчанию ', h('b', { text: 'выключены' }), ' в боте — включите и назначьте им звук. Режим «С видео» показывает выбранное видео/GIF, «Только звук» — проигрывает только звук.'),
      h('p', { style: 'margin:0' }, 'Метка «Другое приложение» означает, что награду создал Sound Alerts или другой сервис: бот может на неё реагировать, но изменить её в Twitch не может.')));

    if (!S.rewards.length) {
      root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: S.status.auth.status === 'ok' ? 'Наград нет. Нажмите «Обновить из Twitch».' : 'Войдите в Twitch, чтобы загрузить награды, или добавьте локальную тестовую награду.' })));
      return;
    }
    S.rewards.forEach(function (r) { root.appendChild(rewardCard(r)); });
  }

  function rewardCard(r) {
    var raw = {}; try { raw = JSON.parse(r.raw || '{}'); } catch (e) { /* */ }
    var isLocal = r.id.indexOf('local-') === 0;
    var card = h('div', { class: 'card reward-card' + (r.bot_enabled ? '' : ' disabled') });
    var badges = [];
    if (isLocal) badges.push(h('span', { class: 'badge', text: 'Локальная (тест)' }));
    else if (r.manageable) badges.push(h('span', { class: 'badge accent', text: 'Создана ботом' }));
    else badges.push(h('span', { class: 'badge', text: 'Другое приложение' }));
    if (!isLocal) badges.push(r.twitch_enabled ? h('span', { class: 'badge ok', text: 'Активна в Twitch' }) : h('span', { class: 'badge warn', text: 'Выключена/на паузе в Twitch' }));
    var enabled = h('input', { type: 'checkbox', checked: !!r.bot_enabled, onchange: function () {
      if (enabled.checked && !r.manageable && !isLocal && S.settings.mode === 'active' &&
        !confirm('Включить «' + r.title + '» в боте?\n\nЕсли эту награду всё ещё обрабатывает Sound Alerts (его источник есть в OBS), оповещение прозвучит дважды. Сначала уберите или скройте источник Sound Alerts в OBS, либо включите «Режим наблюдения».')) {
        enabled.checked = false; return;
      }
      saveReward(r.id, { bot_enabled: enabled.checked }).then(function () { card.classList.toggle('disabled', !enabled.checked); });
    } });
    card.appendChild(h('div', { class: 'card-head' },
      h('div', { class: 'reward-title' }, h('span', { class: 'swatch', style: 'background:' + (/^#[0-9a-f]{6}$/i.test(r.background_color) ? r.background_color : '#555') }),
        h('strong', { text: r.title }), h('span', { class: 'muted', text: r.cost + ' баллов' }), badges),
      h('label', { class: 'check', style: 'margin:0' }, enabled, 'Включена в боте')));
    if (r.prompt) card.appendChild(h('div', { class: 'muted small', text: r.prompt }));

    var media = h('select', { onchange: function () { saveReward(r.id, { media_id: media.value || null }); } }, mediaOptions(r.media_id));
    var video = h('select', { onchange: function () { saveReward(r.id, { video_id: video.value || null }).then(function () { renderRewards(); }); } }, mediaOptions(r.video_id, function (m) { return m.kind !== 'audio'; }));
    var hasVisual = !!r.video_id || !!(r.media_id && S.media.some(function (m) { return m.id === r.media_id && m.kind !== 'audio'; }));
    var onlineMedia = [r.video_id, r.media_id].map(function (id) { return id && S.media.find(function (m) { return m.id === id && m.source === 'klipy'; }); }).filter(Boolean)[0];
    var fallbackOk = !!(r.media_id && S.media.some(function (m) { return m.id === r.media_id && m.kind === 'audio' && m.source !== 'klipy'; }));
    var effectiveMode = hasVisual ? r.play_mode : 'audio';
    var chroma = h('input', { type: 'checkbox', checked: !!r.chroma_key, onchange: function () { saveReward(r.id, { chroma_key: chroma.checked }); } });
    var chromaField = h('label', { class: 'check', title: 'Для видео на зелёном фоне (green screen): зелёный станет прозрачным' }, chroma, 'Убрать зелёный фон (хромакей)');
    var modeBtn = function (mode, text) {
      return h('button', { class: 'small' + (effectiveMode === mode ? ' active' : ''), text: text, disabled: mode === 'video' && !hasVisual,
        title: mode === 'video' && !hasVisual ? 'Сначала выберите видео' : '',
        onclick: function () { saveReward(r.id, { play_mode: mode }).then(function () { renderRewards(); }); } });
    };
    var modeSwitch = h('div', { class: 'field' }, h('label', { text: 'Воспроизведение' }),
      h('div', { class: 'tabs', style: 'margin:0' }, modeBtn('video', '🎬 С видео'), modeBtn('audio', '🔊 Только звук')),
      S.settings.audioOnly ? h('span', { class: 'hint', text: 'Сейчас видео выключено для всех наград (Главная → Видео)' }) : null);
    var sound = h('select', { onchange: function () { saveReward(r.id, { sound_id: sound.value || null }); } }, mediaOptions(r.sound_id, function (m) { return m.kind === 'audio'; }));
    var volLabel = h('span', { text: r.volume + '%' });
    var vol = h('input', { type: 'range', min: 0, max: 100, value: r.volume, oninput: function () { volLabel.textContent = vol.value + '%'; }, onchange: function () { saveReward(r.id, { volume: Number(vol.value) }); } });
    var numField = function (label, key, value, scale, hint) {
      var inp = h('input', { type: 'number', min: 0, step: scale === 1000 ? 0.5 : 1, value: scale === 1000 ? value / 1000 : value, onchange: function () {
        var p = {}; p[key] = Math.round(Number(inp.value) * scale); saveReward(r.id, p);
      } });
      return h('div', { class: 'field' }, h('label', { text: label }), inp, hint ? h('span', { class: 'hint', text: hint }) : null);
    };
    var caption = h('input', { type: 'checkbox', checked: !!r.show_caption, onchange: function () { saveReward(r.id, { show_caption: caption.checked }); } });
    card.appendChild(h('div', { class: 'reward-body' },
      modeSwitch,
      h('div', { class: 'field' }, h('label', { text: 'Звук (основной файл)' }), media),
      h('div', { class: 'field' }, h('label', { text: 'Видео / GIF / картинка' }), video, h('span', { class: 'hint', text: 'В режиме «С видео» у видео играет его собственный звук' })),
      chromaField,
      h('div', { class: 'field' }, h('label', { text: 'Звук к видео/GIF (необязательно)' }), sound),
      h('div', { class: 'field' }, h('label', null, 'Громкость: ', volLabel), vol),
      numField('Длительность, с', 'duration_ms', r.duration_ms, 1000, '0 — до конца видео/звука'),
      numField('Задержка перед показом, с', 'delay_ms', r.delay_ms, 1000),
      numField('Антиспам: повтор от зрителя не чаще, с', 'cooldown_sec', r.cooldown_sec, 1, '0 — без ограничения'),
      h('label', { class: 'check' }, caption, 'Показывать подпись')));

    var actions = h('div', { class: 'reward-actions' },
      h('button', { class: 'primary small', text: '▶ Тест', onclick: function () { act(post('/api/rewards/' + encodeURIComponent(r.id) + '/test'), 'Тест добавлен в очередь'); } }),
      h('button', { class: 'small', text: 'Симулировать событие Twitch', title: 'Проверка всего пути обработки (включено/выключено, режим, очередь) без списания баллов', onclick: function () {
        act(post('/api/rewards/' + encodeURIComponent(r.id) + '/simulate', { user: 'test_viewer' })).then(function (res) {
          var m = { queued: 'Событие обработано и поставлено в очередь', ignored: 'Событие получено, но награда выключена или не настроена', observed: 'Режим наблюдения: событие записано без воспроизведения', skipped: 'Пропущено (очередь/антиспам)', failed: 'Ошибка: проверьте медиафайл' };
          toast(m[res.result] || ('Результат: ' + res.result), res.result === 'queued' ? 'ok' : '');
        });
      } }));
    if (!isLocal && !r.manageable) {
      actions.appendChild(h('button', { class: 'small', text: 'Создать свою копию в Twitch…', onclick: function () { cloneReward(r); } }));
    }
    if (r.manageable) {
      var paused = raw.is_paused;
      actions.appendChild(h('button', { class: 'small', text: paused ? 'Снять с паузы в Twitch' : 'Поставить на паузу в Twitch', onclick: function () {
        act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { is_paused: !paused }), 'Изменено в Twitch').then(load);
      } }));
      actions.appendChild(h('button', { class: 'small', text: 'Переименовать…', onclick: function () {
        var t = prompt('Новое название награды в Twitch (до 45 символов):', r.title);
        if (t && t !== r.title) act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { title: t }), 'Переименовано').then(load);
      } }));
      actions.appendChild(h('button', { class: 'small', text: 'Стоимость…', onclick: function () {
        var c = prompt('Новая стоимость в баллах:', String(r.cost));
        if (c && Number(c) !== r.cost) act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { cost: Number(c) }), 'Стоимость изменена').then(load);
      } }));
    }
    card.appendChild(actions);

    [r.media_id, r.video_id, r.sound_id].forEach(function (id) {
      var m = id && S.media.find(function (x) { return x.id === id; });
      if (m && m.status === 'broken') card.appendChild(h('div', { class: 'warnbox', text: 'Медиафайл «' + m.name + '» повреждён: ' + m.status_msg }));
    });
    if (onlineMedia) card.appendChild(h('div', { class: fallbackOk ? 'infobox' : 'warnbox', style: 'margin-top:10px', text: fallbackOk
      ? '🌐 «' + onlineMedia.name + '» показывается онлайн с сервера Klipy. Если Klipy недоступен — сыграет «Звук (основной файл)».'
      : '🌐 «' + onlineMedia.name + '» показывается онлайн с сервера Klipy. Выберите «Звук (основной файл)» — он сыграет, если Klipy или интернет недоступны; иначе оповещения не будет.' }));
    if (r.bot_enabled && !r.media_id && !r.sound_id && !r.video_id) card.appendChild(h('div', { class: 'warnbox', text: 'Награда включена, но медиафайл не выбран — оповещение не покажется.' }));
    return card;
  }

  function cloneReward(r) {
    var msg = 'Создать в вашем канале Twitch НОВУЮ награду — копию «' + r.title + '» (' + r.cost + ' баллов)?\n\n' +
      '• Копия будет создана НА ПАУЗЕ — зрители её не увидят, пока вы не снимете паузу.\n' +
      '• Twitch требует уникальных названий, поэтому к названию добавится «★». Переименовать можно позже, после удаления старой награды.\n' +
      '• Старая награда не изменяется.\n\nПродолжить?';
    if (!confirm(msg)) return;
    act(post('/api/rewards/' + encodeURIComponent(r.id) + '/clone', { confirm: true }), 'Копия создана (на паузе)').then(load);
  }

  // ---------------- Медиа ----------------
  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files);
    var next = function () {
      var f = list.shift();
      if (!f) { load(); return; }
      toast('Загрузка «' + f.name + '»…');
      api('PUT', '/api/media', f, { 'x-file-name': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' })
        .then(function (row) { toast('Файл «' + row.name + '» добавлен' + (row.status === 'warning' ? ': ' + row.status_msg : ''), row.status === 'warning' ? '' : 'ok'); },
          function (e) { toast('«' + f.name + '»: ' + e.message, 'bad'); })
        .then(next);
    };
    next();
  }

  function renderMedia() {
    var root = clear($('page-media'));
    var fileInput = h('input', { type: 'file', multiple: true, accept: '.mp3,.wav,.ogg,.m4a,.webm,.mp4,.gif,.png,.jpg,.jpeg,.webp', style: 'display:none', onchange: function () { uploadFiles(fileInput.files); fileInput.value = ''; } });
    root.appendChild(h('div', { class: 'card-head' }, h('h1', { text: 'Медиа' }),
      h('div', { class: 'row' },
        h('button', { text: 'Проверить все файлы', onclick: function () {
          probed = {};
          act(post('/api/media/verify')).then(function (r) { toast('Проверено: ' + r.checked + ', повреждено: ' + r.broken, r.broken ? 'bad' : 'ok'); load(); });
        } }),
        h('button', { text: 'Открыть папку', onclick: function () { act(post('/api/open-folder', { which: 'media' })); } }),
        h('a', { class: 'btn primary', href: '#find', text: '🔎 Найти медиа' }))));
    var dz = h('div', { class: 'dropzone', onclick: function () { fileInput.click(); } },
      h('div', { text: 'Перетащите файлы сюда или нажмите для выбора' }),
      h('div', { class: 'small', text: 'MP3, WAV, OGG, M4A, WebM, MP4 (H.264), GIF, PNG, JPG, WebP — до 200 МБ' }));
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
    dz.addEventListener('drop', function (e) { e.preventDefault(); dz.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
    root.appendChild(dz);
    root.appendChild(fileInput);

    if (!S.media.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Файлов пока нет' }))); return; }
    var grid = h('div', { class: 'media-grid' });
    S.media.forEach(function (m) {
      var url = '/media/' + m.id;
      var prev;
      if (m.source === 'klipy') {
        prev = h('div', { class: 'online-ph' }, h('div', { text: '🌐 Онлайн-медиа Klipy' }), h('div', { class: 'small', text: 'файл не хранится на компьютере' }));
        prev.appendChild(h('button', { class: 'small', text: 'Показать', onclick: function () {
          act(api('GET', '/api/media/' + m.id + '/online')).then(function (r) {
            var box = prev.parentNode; clear(box);
            box.appendChild(r.kind === 'video' ? h('video', { src: r.url, controls: true, autoplay: true }) : h('img', { src: r.url, alt: '' }));
          });
        } }));
      } else {
        prev = m.kind === 'image' ? h('img', { src: url, alt: '' })
          : m.kind === 'video' ? h('video', { src: url, controls: true, preload: 'metadata' })
          : h('audio', { src: url, controls: true, preload: 'none' });
      }
      var origin = m.source === 'klipy' ? 'Klipy (онлайн)' : m.source === 'freesound' ? 'Freesound' : m.source === 'url' ? 'по ссылке' : '';
      var st = m.status === 'broken' ? h('span', { class: 'badge bad', text: 'повреждён' }) : m.status === 'warning' ? h('span', { class: 'badge warn', text: 'внимание' }) : h('span', { class: 'badge ok', text: 'OK' });
      grid.appendChild(h('div', { class: 'media-card' },
        h('div', { class: 'media-preview' }, prev),
        h('div', { class: 'media-info' },
          h('div', { class: 'media-name', text: m.name }),
          h('div', { class: 'row small muted' }, st, { audio: 'звук', video: 'видео', image: 'изображение' }[m.kind], '·', m.source === 'klipy' ? 'онлайн' : fmtSize(m.size), '·', fmtDur(m.duration_ms)),
          origin ? h('div', { class: 'small muted' }, 'Источник: ', m.source_url ? h('a', { href: m.source_url, target: '_blank', rel: 'noopener noreferrer', text: origin }) : origin) : null,
          m.attribution && m.source === 'freesound' ? h('div', { class: 'small muted', text: m.attribution }) : null,
          m.status_msg ? h('div', { class: 'small', style: 'color:' + (m.status === 'broken' ? '#ff9a9e' : '#ffd38a'), text: m.status_msg }) : null,
          h('div', { class: 'small muted', text: m.usedBy.length ? 'Используется: ' + m.usedBy.join(', ') : 'Не используется' }),
          h('div', { class: 'media-actions' },
            h('button', { class: 'small primary', text: '▶ В OBS', onclick: function () { act(post('/api/media/' + m.id + '/test'), 'Отправлено в overlay'); } }),
            h('button', { class: 'small', text: 'Переименовать', onclick: function () {
              var n = prompt('Новое имя файла:', m.name); if (n) act(post('/api/media/' + m.id + '/rename', { name: n })).then(load);
            } }),
            h('button', { class: 'small danger', text: 'Удалить', onclick: function () {
              if (m.usedBy.length) {
                if (!confirm('Файл «' + m.name + '» используется наградами: ' + m.usedBy.join(', ') + '.\nУдалить его и отвязать от наград? Это нельзя отменить.')) return;
                act(post('/api/media/' + m.id + '/delete', { confirm: true, force: true }), 'Удалено').then(load);
              } else {
                if (!confirm('Удалить файл «' + m.name + '»? Это нельзя отменить.')) return;
                act(post('/api/media/' + m.id + '/delete', { confirm: true }), 'Удалено').then(load);
              }
            } })))));
    });
    root.appendChild(grid);
  }

  // ---------------- Найти медиа ----------------
  // Состояние поиска хранится отдельно, чтобы результаты не пропадали при обновлении данных панели.
  var F = {
    tab: 'klipy', ktype: 'clips', kq: '', kres: null, kpage: 1, knext: false, kloading: false,
    fq: '', fres: null, fpage: 1, fnext: false, ftotal: 0, fcommercial: true, floading: false, url: '', urlLoading: false, lastUrlRow: null,
  };
  var KTYPES = [['clips', '🎬 Клипы со звуком'], ['gifs', 'GIF'], ['stickers', 'Стикеры']];

  function qs(o) {
    return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }

  /** Создание награды в Twitch с этим файлом (с подтверждением) и включение её в боте. */
  function createRewardWith(row) {
    if (S.status.auth.status !== 'ok') { toast('Сначала войдите в Twitch («Настройки» → «Войти через Twitch»)', 'bad'); return; }
    var t = prompt('Название новой награды (до 45 символов):', (row.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 45));
    if (!t) return;
    var c = Number(prompt('Стоимость в баллах:', '1000'));
    if (!c) return;
    var cd = Number(prompt('Перезарядка в секундах (0 — без перезарядки):', '60') || 0);
    if (!confirm('Создать в Twitch награду «' + t + '» за ' + c + ' баллов? Она сразу станет видна зрителям.')) return;
    act(post('/api/rewards/create', { confirm: true, title: t, cost: c, cooldownSec: cd })).then(function (r) {
      var cfg = row.kind === 'audio' ? { media_id: row.id, play_mode: 'audio', bot_enabled: true } : { video_id: row.id, play_mode: 'video', bot_enabled: true };
      return post('/api/rewards/' + encodeURIComponent(r.id), cfg).then(function () {
        toast('Награда «' + r.title + '» создана и включена' + (row.source === 'klipy' ? '. Совет: в «Наградах» выберите ей «Звук (основной файл)» — он сыграет, если Klipy будет недоступен.' : ''), 'ok');
        load();
      });
    }).catch(function () { /* ошибка уже показана */ });
  }

  function addedActions(row) {
    return h('div', { class: 'row small' }, h('span', { class: 'badge ok', text: 'в медиатеке' }),
      h('button', { class: 'small', text: '▶ В OBS', onclick: function () { act(post('/api/media/' + row.id + '/test'), 'Отправлено в overlay'); } }),
      h('button', { class: 'small primary', text: '＋ Награда', title: 'Создать награду в Twitch с этим файлом', onclick: function () { createRewardWith(row); } }));
  }

  function needKey(name, how) {
    return h('div', { class: 'card' }, h('h2', { text: 'Нужен ключ ' + name }),
      h('p', null, how),
      h('p', null, 'Затем вставьте его в ', h('a', { href: '#settings', text: '«Настройки» → «Поиск медиа»' }), '. Ключ бесплатный; бот хранит его только на этом компьютере.'));
  }

  function renderFind() {
    var root = clear($('page-find'));
    root.appendChild(h('h1', { text: 'Найти медиа' }));
    var tab = function (id, text) { return h('button', { class: F.tab === id ? 'active' : '', text: text, onclick: function () { F.tab = id; renderFind(); } }); };
    root.appendChild(h('div', { class: 'tabs' }, tab('klipy', 'Klipy — мемы и клипы'), tab('freesound', 'Freesound — звуки'), tab('url', 'По ссылке')));
    if (F.tab === 'klipy') renderKlipy(root);
    else if (F.tab === 'freesound') renderFreesound(root);
    else renderUrlImport(root);
  }

  function renderKlipy(root) {
    if (!S.find || !S.find.klipy) {
      root.appendChild(needKey('Klipy', h('span', null, 'Зарегистрируйтесь на ', h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), ', откройте «API Keys» и создайте ключ.')));
      return;
    }
    root.appendChild(h('div', { class: 'infobox', style: 'margin-bottom:12px' },
      'Мемы Klipy не скачиваются на компьютер — так требуют правила Klipy. Они показываются на стриме прямо с сервера Klipy, поэтому нужен интернет. ',
      h('b', { text: 'Если Klipy будет недоступен, сыграет запасной звук награды' }), ' («Звук (основной файл)» в карточке награды).'));
    var input = h('input', { type: 'search', placeholder: 'Search KLIPY', value: F.kq, oninput: function () { F.kq = input.value; } });
    var search = function (page) {
      F.kloading = true; F.kpage = page; renderFind();
      api('GET', '/api/find/klipy?' + qs({ type: F.ktype, q: F.kq, page: page })).then(function (r) {
        F.kres = page > 1 && F.kres ? F.kres.concat(r.results) : r.results; F.knext = r.hasNext;
      }, function (e) { toast(e.message, 'bad'); }).then(function () { F.kloading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    var types = h('div', { class: 'tabs', style: 'margin:0' }, KTYPES.map(function (t) {
      return h('button', { class: 'small' + (F.ktype === t[0] ? ' active' : ''), text: t[1], onclick: function () { F.ktype = t[0]; F.kres = null; search(1); } });
    }));
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.kloading ? 'Поиск…' : 'Найти', disabled: F.kloading, onclick: function () { search(1); } })),
      h('div', { style: 'margin-top:10px' }, types),
      h('div', { class: 'small muted', style: 'margin-top:8px', text: 'Пустой запрос — популярное сейчас. Тестовый ключ Klipy: 100 запросов в час (каждый поиск и каждый показ мема на стриме).' })));
    if (F.kres === null) return;
    if (!F.kres.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Ничего не найдено. Попробуйте другое слово (лучше на английском).' }))); return; }
    var grid = h('div', { class: 'find-grid' });
    F.kres.forEach(function (it) {
      var prev = h('div', { class: 'media-preview', title: it.play.kind === 'video' ? 'Нажмите, чтобы посмотреть со звуком' : '' },
        h('img', { src: it.thumb, alt: '', loading: 'lazy' }), it.play.kind === 'video' ? h('span', { class: 'play-hint', text: '▶ со звуком' }) : null);
      if (it.play.kind === 'video') prev.addEventListener('click', function () {
        if (prev.querySelector('video')) return;
        clear(prev).appendChild(h('video', { src: it.play.url, controls: true, autoplay: true, playsinline: true }));
      });
      var actions = h('div', { class: 'media-actions' });
      var existing = S.media.find(function (m) { return m.source === 'klipy' && m.remote_ref === it.type + '/' + it.slug; });
      if (existing) actions.appendChild(addedActions(existing));
      else actions.appendChild(h('button', { class: 'small primary', text: '＋ В медиатеку', onclick: function (ev) {
        var btn = ev.currentTarget; btn.disabled = true;
        act(post('/api/find/klipy/add', { type: it.type, slug: it.slug }), 'Добавлено в медиатеку (онлайн)').then(function (row) {
          S.media.unshift(Object.assign({ usedBy: [] }, row)); clear(actions).appendChild(addedActions(row));
        }, function () { btn.disabled = false; });
      } }));
      grid.appendChild(h('div', { class: 'media-card' }, prev,
        h('div', { class: 'media-info' }, h('div', { class: 'media-name', text: it.title }),
          h('div', { class: 'small muted' }, it.play.kind === 'video' ? 'видео со звуком' : 'анимация без звука', it.play.width ? ' · ' + it.play.width + '×' + it.play.height : ''),
          actions)));
    });
    root.appendChild(grid);
    if (F.knext) root.appendChild(h('div', { class: 'row', style: 'margin-top:12px;justify-content:center' }, h('button', { text: F.kloading ? 'Загрузка…' : 'Показать ещё', disabled: F.kloading, onclick: function () { search(F.kpage + 1); } })));
    root.appendChild(h('div', { class: 'powered', text: 'Powered by KLIPY' }));
  }

  function renderFreesound(root) {
    if (!S.find || !S.find.freesound) {
      root.appendChild(needKey('Freesound', h('span', null, 'Зарегистрируйтесь на ', h('a', { href: 'https://freesound.org', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org' }), ', затем откройте ', h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), ' и создайте ключ. Нужна строка «Client secret / Api key».')));
      return;
    }
    root.appendChild(h('div', { class: 'infobox', style: 'margin-bottom:12px' },
      'Звуки Freesound скачиваются в медиатеку (MP3) и играют без интернета. Автор и лицензия сохраняются у файла. ',
      'Лицензия CC BY требует указывать автора — например, в описании канала или панели под стримом.'));
    var input = h('input', { type: 'search', placeholder: 'Например: applause, fail, laugh, bruh', value: F.fq, oninput: function () { F.fq = input.value; } });
    var search = function (page) {
      if (!F.fq.trim()) { toast('Введите, что искать', 'bad'); return; }
      F.floading = true; F.fpage = page; renderFind();
      api('GET', '/api/find/freesound?' + qs({ q: F.fq, page: page, commercial: F.fcommercial ? 1 : 0 })).then(function (r) {
        F.fres = page > 1 && F.fres ? F.fres.concat(r.results) : r.results; F.fnext = r.hasNext; F.ftotal = r.total;
      }, function (e) { toast(e.message, 'bad'); }).then(function () { F.floading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    var commercial = h('input', { type: 'checkbox', checked: F.fcommercial, onchange: function () { F.fcommercial = commercial.checked; } });
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.floading ? 'Поиск…' : 'Найти', disabled: F.floading, onclick: function () { search(1); } })),
      h('label', { class: 'check', style: 'margin:10px 0 0' }, commercial, 'Только звуки, которые можно использовать на стриме с монетизацией (CC0 и CC BY)'),
      h('div', { class: 'small muted', text: 'Показываются звуки до 60 секунд. Лучше искать на английском.' })));
    if (F.fres === null) return;
    if (!F.fres.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: 'Ничего не найдено.' }))); return; }
    var list = h('div', { class: 'list' });
    F.fres.forEach(function (it) {
      var actions = h('div', { class: 'row' });
      var existing = S.media.find(function (m) { return m.source === 'freesound' && m.source_url === it.pageUrl; });
      if (existing) actions.appendChild(addedActions(existing));
      else actions.appendChild(h('button', { class: 'small primary', text: '＋ В медиатеку', onclick: function (ev) {
        var btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Скачивание…';
        act(post('/api/find/freesound/add', { id: it.id }), 'Звук скачан в медиатеку').then(function (row) {
          S.media.unshift(Object.assign({ usedBy: [] }, row)); clear(actions).appendChild(addedActions(row));
        }, function () { btn.disabled = false; btn.textContent = '＋ В медиатеку'; });
      } }));
      list.appendChild(h('div', { class: 'sound-row' },
        h('div', null,
          h('div', { class: 'media-name', text: it.name }),
          h('div', { class: 'small muted' }, 'Автор: ', it.username, ' · ', fmtDur(it.durationSec * 1000), ' · ',
            h('a', { href: it.pageUrl, target: '_blank', rel: 'noopener noreferrer', text: 'страница звука' })),
          h('span', { class: 'badge ' + (it.commercialOk ? 'ok' : 'warn'), text: it.licenseLabel })),
        h('audio', { src: it.previewUrl, controls: true, preload: 'none' }),
        actions));
    });
    root.appendChild(h('div', { class: 'card', style: 'margin-top:12px' }, h('div', { class: 'small muted', style: 'margin-bottom:8px', text: 'Найдено: ' + F.ftotal }), list,
      F.fnext ? h('div', { class: 'row', style: 'margin-top:12px;justify-content:center' }, h('button', { text: F.floading ? 'Загрузка…' : 'Показать ещё', disabled: F.floading, onclick: function () { search(F.fpage + 1); } })) : null,
      h('div', { class: 'powered', text: 'Звуки: Freesound.org' })));
  }

  function renderUrlImport(root) {
    var input = h('input', { type: 'url', placeholder: 'https://example.com/sound.mp3', value: F.url, oninput: function () { F.url = input.value; } });
    var go = function () {
      if (!F.url.trim()) { toast('Вставьте ссылку на файл', 'bad'); return; }
      F.urlLoading = true; renderFind();
      act(post('/api/find/url', { url: F.url.trim() }), 'Файл скачан в медиатеку').then(function (row) {
        F.url = ''; F.lastUrlRow = row; S.media.unshift(Object.assign({ usedBy: [] }, row));
      }, function () { /* ошибка уже показана */ }).then(function () { F.urlLoading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    root.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Скачать файл по прямой ссылке' }),
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.urlLoading ? 'Скачивание…' : 'Скачать', disabled: F.urlLoading, onclick: go })),
      h('p', { class: 'small muted' }, 'Нужна прямая ссылка на сам файл: MP3, WAV, OGG, M4A, MP4 (H.264), WebM, GIF, PNG, JPG или WebP, до 200 МБ. ',
        'Ссылки на страницы YouTube, TikTok и т. п. не подойдут. Используйте только файлы, которые вам разрешено показывать на стриме.'),
      F.lastUrlRow ? h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { text: 'Добавлено: ' + F.lastUrlRow.name }), addedActions(F.lastUrlRow)) : null));
  }

  // ---------------- Настройки ----------------
  function settingField(label, key, opts) {
    opts = opts || {};
    var s = S.settings;
    var inp;
    if (opts.type === 'select') {
      inp = h('select', null, opts.options.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(s[key]) === String(o[0]) }); }));
    } else if (opts.type === 'check') {
      inp = h('input', { type: 'checkbox', checked: !!s[key] });
      var lab = h('label', { class: 'check' }, inp, label);
      inp.addEventListener('change', function () { saveSetting(key, inp.checked); });
      return h('div', null, lab, opts.hint ? h('div', { class: 'hint small muted', style: 'margin:-6px 0 10px 24px', text: opts.hint }) : null);
    } else {
      var val = opts.scale ? s[key] / opts.scale : s[key];
      inp = h('input', { type: opts.type || 'text', value: val, min: opts.min, max: opts.max, step: opts.step });
    }
    inp.addEventListener('change', function () {
      var v = inp.value;
      if (opts.type === 'number') v = Number(v) * (opts.scale || 1);
      saveSetting(key, v);
    });
    return h('div', { class: 'field' }, h('label', { text: label }), inp, opts.hint ? h('span', { class: 'hint', text: opts.hint }) : null);
  }

  function saveSetting(key, value) {
    var p = {}; p[key] = value;
    return act(post('/api/settings', p)).then(function (r) {
      S.settings = r.settings;
      if (r.find) S.find = r.find;
      toast(r.note || 'Сохранено', 'ok');
      renderSide();
    }, function () { load(); });
  }

  function renderAuthBox() {
    var box = $('auth-box');
    if (!box) return;
    clear(box);
    var a = S.status.auth;
    if (a.status === 'ok') {
      box.appendChild(h('p', null, h('span', { class: 'badge ok', text: 'Подключено' }), ' Аккаунт: ', h('b', { text: a.login })));
      box.appendChild(h('p', { class: 'small muted', text: 'Права: ' + a.scopes.join(', ') + '. Токен обновляется автоматически.' }));
      box.appendChild(h('div', { class: 'row' },
        h('button', { text: 'Войти заново', onclick: function () { act(post('/api/auth/login')); } }),
        h('button', { class: 'danger', text: 'Выйти', onclick: function () { if (confirm('Выйти из Twitch? Бот перестанет получать события наград.')) act(post('/api/auth/logout'), 'Вы вышли из Twitch'); } })));
    } else if (a.status === 'pending') {
      box.appendChild(h('p', { text: '1. Откройте страницу Twitch (кнопка ниже). 2. Проверьте, что код совпадает. 3. Нажмите «Разрешить».' }));
      box.appendChild(h('div', { class: 'code-box', text: a.userCode }));
      box.appendChild(h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: a.verificationUri, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть twitch.tv/activate' }),
        h('button', { text: 'Отмена', onclick: function () { act(post('/api/auth/cancel')).then(load); } })));
      box.appendChild(h('p', { class: 'small muted', style: 'margin-top:8px', text: 'Ожидание подтверждения… Код действует до ' + fmtTime(a.expiresAt) + '. Пароль Twitch бот не видит и не запрашивает.' }));
    } else {
      box.appendChild(h('p', null, h('span', { class: 'badge bad', text: 'Не подключено' }), ' ', a.message));
      box.appendChild(h('button', { class: 'primary', text: 'Войти через Twitch', disabled: !S.settings.clientId, onclick: function () { act(post('/api/auth/login')).then(load); } }));
    }
  }

  function renderSettings() {
    var root = clear($('page-settings'));
    root.appendChild(h('h1', { text: 'Настройки' }));

    var copyInput = h('input', { type: 'text', value: S.overlayUrl, readonly: true });
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: 'Twitch' }),
        settingField('Client ID приложения Twitch', 'clientId', { hint: 'Создайте приложение на dev.twitch.tv/console (тип клиента — «Общедоступный / Public»). Подробно — в разделе «Помощь».' }),
        settingField('Разрешить боту управлять наградами', 'allowManageRewards', { type: 'check', hint: 'Нужно для создания копий наград и возврата баллов при сбое. Без этого бот только читает события.' }),
        h('div', { id: 'auth-box' })),
      h('div', { class: 'card' }, h('h2', { text: 'OBS overlay' }),
        h('div', { class: 'field' }, h('label', { text: 'Адрес для Browser Source в OBS' }),
          h('div', { class: 'copy-field' }, copyInput, h('button', { text: 'Копировать', onclick: function () {
            copyInput.select();
            (navigator.clipboard ? navigator.clipboard.writeText(S.overlayUrl) : Promise.reject()).then(function () { toast('Адрес скопирован', 'ok'); }, function () { document.execCommand('copy'); toast('Адрес скопирован', 'ok'); });
          } }), h('a', { class: 'btn', href: '/overlay', target: '_blank', text: 'Открыть' }))),
        h('div', { class: 'form-grid' },
          settingField('Общая громкость, %', 'masterVolume', { type: 'number', min: 0, max: 100 }),
          settingField('Положение', 'overlayPosition', { type: 'select', options: [['center', 'По центру'], ['top', 'Сверху'], ['bottom', 'Снизу'], ['left', 'Слева'], ['right', 'Справа'], ['top-left', 'Сверху слева'], ['top-right', 'Сверху справа'], ['bottom-left', 'Снизу слева'], ['bottom-right', 'Снизу справа']] }),
          settingField('Макс. ширина, % экрана', 'overlayMaxWidthPct', { type: 'number', min: 5, max: 100 }),
          settingField('Макс. высота, % экрана', 'overlayMaxHeightPct', { type: 'number', min: 5, max: 100 })),
        settingField('Показывать подпись', 'showCaption', { type: 'check' }),
        settingField('Шаблон подписи', 'captionTemplate', { hint: '{user} — зритель, {reward} — награда, {input} — текст зрителя, {cost} — стоимость' }))));

    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: 'Очередь и защита от спама' }),
        h('div', { class: 'form-grid' },
          settingField('Задержка перед показом, с', 'delayBeforeMs', { type: 'number', scale: 1000, min: 0, step: 0.1 }),
          settingField('Пауза между оповещениями, с', 'gapBetweenMs', { type: 'number', scale: 1000, min: 0, step: 0.1 }),
          settingField('Максимальная длина очереди', 'maxQueueLength', { type: 'number', min: 1, max: 500 }),
          settingField('Не проигрывать старше, с', 'maxItemAgeSec', { type: 'number', min: 10, hint: 'Слишком старые оповещения отбрасываются' }),
          settingField('Антиспам: один зритель не чаще, с', 'userCooldownSec', { type: 'number', min: 0, hint: '0 — без ограничения' }),
          settingField('Длительность картинки/GIF, с', 'defaultImageDurationMs', { type: 'number', scale: 1000, min: 0.5, step: 0.5 }),
          settingField('Максимальная длительность, с', 'maxDurationMs', { type: 'number', scale: 1000, min: 1 }))),
      h('div', { class: 'card' }, h('h2', { text: 'Поведение' }),
        settingField('Только звук для всех наград (видео выключено)', 'audioOnly', { type: 'check', hint: 'Быстрый общий выключатель видео, например для игровых сцен. Настройки наград при этом не меняются.' }),
        settingField('Режим работы', 'mode', { type: 'select', options: [['active', 'Активный — воспроизводить оповещения'], ['observe', 'Наблюдение — только записывать (для параллельной работы с Sound Alerts)']] }),
        settingField('Восстанавливать пропущенные события после обрыва связи', 'recoverMissed', { type: 'check', hint: 'Работает только для наград, созданных этим ботом (ограничение Twitch).' }),
        settingField('Отмечать выполненными и возвращать баллы при сбое', 'manageRedemptionStatus', { type: 'check', hint: 'Только для наград, созданных ботом и не пропускающих очередь запросов.' }),
        settingField('Хранить историю, дней', 'historyRetentionDays', { type: 'number', min: 1 }))));

    var keyField = function (label, key, hint) {
      var inp = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: S.settings[key] ? 'сохранён (' + S.settings[key] + ') — вставьте новый, чтобы заменить' : 'вставьте ключ' });
      inp.addEventListener('change', function () { if (inp.value.trim()) saveSetting(key, inp.value.trim()).then(load); });
      return h('div', { class: 'field' }, h('label', { text: label }),
        h('div', { class: 'copy-field' }, inp, S.settings[key] ? h('button', { class: 'danger', text: 'Удалить', onclick: function () {
          if (confirm('Удалить ключ «' + label + '»? Поиск в этом сервисе перестанет работать.')) saveSetting(key, '').then(load);
        } }) : null),
        h('span', { class: 'hint' }, hint));
    };
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: 'Поиск медиа' }),
        keyField('Ключ Klipy (мемы, клипы, GIF)', 'klipyApiKey', h('span', null, 'Бесплатно: ', h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), ' → API Keys.')),
        keyField('Ключ Freesound (звуки)', 'freesoundApiKey', h('span', null, 'Бесплатно: ', h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), ' → строка «Client secret / Api key».')),
        settingField('Фильтр контента Klipy', 'klipyContentFilter', { type: 'select', options: [['high', 'Строгий'], ['medium', 'Средний (рекомендуется для Twitch)'], ['low', 'Мягкий'], ['off', 'Выключен']] }),
        h('p', { class: 'small muted', text: 'Ключи хранятся только на этом компьютере, в журнал не записываются и в панели показываются не полностью.' })),
      h('div', { class: 'card' }, h('h2', { text: 'Как это работает' }),
        h('ul', { class: 'small' },
          h('li', { text: 'Klipy: мемы не скачиваются (правила Klipy) — во время стрима OBS загружает их с сервера Klipy. Назначьте награде запасной звук на случай сбоя.' }),
          h('li', { text: 'Freesound: звуки скачиваются в медиатеку и работают без интернета. Автор и лицензия сохраняются.' }),
          h('li', { text: 'По ссылке: прямой адрес файла скачивается в медиатеку. Ссылки на этот компьютер и локальную сеть запрещены.' })))));

    var autostart = h('input', { type: 'checkbox', checked: !!S.autostart, onchange: function () {
      act(post('/api/autostart', { enabled: autostart.checked }), autostart.checked ? 'Автозапуск включён' : 'Автозапуск выключен').then(null, function () { autostart.checked = !autostart.checked; });
    } });
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: 'OBS Studio' }),
        settingField('Путь к OBS (obs64.exe)', 'obsExePath'),
        settingField('Папка настроек OBS', 'obsConfigDir'),
        settingField('Запускать OBS при автозапуске бота', 'launchObsWithBot', { type: 'check' }),
        h('div', { class: 'row' },
          h('button', { text: 'Резервная копия сцен OBS', onclick: function () { act(post('/api/obs/backup')).then(function (r) { toast('Копия сохранена: ' + r.dir, 'ok'); }); } }),
          h('button', { text: 'Запустить OBS', onclick: function () { act(post('/api/obs/launch')).then(function (r) { toast(r.already ? 'OBS уже запущен' : 'OBS запускается', 'ok'); }); } }),
          h('button', { text: 'Папка копий', onclick: function () { act(post('/api/open-folder', { which: 'backups' })); } }))),
      h('div', { class: 'card' }, h('h2', { text: 'Система' }),
        h('label', { class: 'check' }, autostart, 'Запускать бота вместе с Windows'),
        settingField('Локальный порт', 'port', { type: 'number', min: 1024, max: 65535, hint: 'Изменение вступит в силу после перезапуска. Сервер доступен только с этого компьютера (127.0.0.1).' }),
        h('div', { class: 'row' },
          h('button', { text: 'Папка логов', onclick: function () { act(post('/api/open-folder', { which: 'logs' })); } }),
          h('button', { text: 'Папка данных', onclick: function () { act(post('/api/open-folder', { which: 'data' })); } }),
          h('button', { class: 'danger', text: 'Остановить бота', onclick: function () { if (confirm('Остановить бота? Оповещения перестанут работать до следующего запуска.')) act(post('/api/shutdown'), 'Бот останавливается'); } })),
        h('p', { class: 'small muted', style: 'margin-top:10px', text: 'Версия ' + S.status.version + ' · работает ' + Math.round(S.status.uptimeSec / 60) + ' мин' }))));
    renderAuthBox();
  }

  // ---------------- Журнал ----------------
  var logTab = 'events';
  function renderLog() {
    var root = clear($('page-log'));
    root.appendChild(h('h1', { text: 'Журнал' }));
    var tabs = h('div', { class: 'tabs' },
      h('button', { class: logTab === 'events' ? 'active' : '', text: 'События', onclick: function () { logTab = 'events'; renderLog(); } }),
      h('button', { class: logTab === 'redemptions' ? 'active' : '', text: 'Активации наград', onclick: function () { logTab = 'redemptions'; renderLog(); } }),
      h('button', { class: logTab === 'tech' ? 'active' : '', text: 'Технический лог', onclick: function () { logTab = 'tech'; renderLog(); } }));
    root.appendChild(tabs);
    if (logTab === 'events') {
      var tb = h('tbody');
      S.events.forEach(function (e) { tb.appendChild(h('tr', null, h('td', { class: 'muted small', text: fmtDateTime(e.ts) }), h('td', null, levelBadge(e.level)), h('td', { text: e.message }))); });
      root.appendChild(h('div', { class: 'card' }, S.events.length ? h('table', null, tb) : h('div', { class: 'empty', text: 'Пусто' })));
    } else if (logTab === 'redemptions') {
      root.appendChild(renderRedemptionsCard());
    } else {
      var box = h('div', { class: 'log-lines', text: 'Загрузка…' });
      root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Технический лог (сегодня)' }),
        h('button', { class: 'small', text: 'Открыть папку логов', onclick: function () { act(post('/api/open-folder', { which: 'logs' })); } })), box));
      api('GET', '/api/logs').then(function (r) {
        clear(box);
        r.lines.forEach(function (l) {
          box.appendChild(h('div', { class: /\[ERROR\]/.test(l) ? 'lvl-error' : /\[WARN\]/.test(l) ? 'lvl-warn' : '', text: l }));
        });
        box.scrollTop = box.scrollHeight;
      });
    }
  }

  // ---------------- Помощь ----------------
  function renderHelp() {
    var root = clear($('page-help'));
    root.appendChild(h('h1', { text: 'Помощь' }));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '1. Приложение Twitch (один раз)' }),
      h('ol', null,
        h('li', null, 'Откройте ', h('a', { href: 'https://dev.twitch.tv/console/apps/create', target: '_blank', rel: 'noopener noreferrer', text: 'dev.twitch.tv/console/apps/create' }), ' и войдите своим аккаунтом Twitch.'),
        h('li', { text: 'Название — любое, например «My Alert Bot <ваш ник>».' }),
        h('li', { text: 'OAuth Redirect URL: http://localhost (бот его не использует, но поле обязательное).' }),
        h('li', { text: 'Категория: Broadcaster Suite. Тип клиента: «Общедоступный» (Public).' }),
        h('li', { text: 'Нажмите «Создать», затем «Управление» и скопируйте Client ID (секрет клиента НЕ нужен).' }),
        h('li', { text: 'Вставьте Client ID в «Настройки → Twitch» и нажмите «Войти через Twitch».' }))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '2. Источник в OBS' }),
      h('ol', null,
        h('li', { text: 'В OBS: «Источники» → «+» → «Браузер». Название: «Alert Bot».' }),
        h('li', null, 'URL: ', h('code', { text: S.overlayUrl })),
        h('li', { text: 'Ширина 1920, высота 1080 (источник растянется на весь экран; при другом разрешении он масштабируется сам).' }),
        h('li', { text: 'Включите «Управлять аудио через OBS». Выключите «Отключать источник, когда он не виден» — иначе оповещения ждут, пока сцена неактивна.' }),
        h('li', { text: 'Чтобы слышать оповещения в наушниках: «Расширенные свойства аудио» → «Мониторинг звука» → «Монитор и вывод».' }),
        h('li', { text: 'Добавьте ОДИН источник и используйте его во всех сценах через «Добавить существующий» — иначе звук будет двоиться.' }),
        h('li', { text: 'Нажмите «Тестовое оповещение» на главной.' }))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '3. Как добавить новую награду' }),
      h('ol', null,
        h('li', null, h('b', { text: 'Подготовьте файлы. ' }), 'Раздел «Медиа» → перетащите звук (MP3, WAV, OGG, M4A) и, если нужно, видео (MP4 H.264 или WebM), GIF или картинку. Бот проверит каждый файл.'),
        h('li', null, h('b', { text: 'Создайте награду. ' }), 'Раздел «Награды» → «+ Новая награда в Twitch» → название (до 45 символов), стоимость в баллах и перезарядку в секундах → подтвердите. Награда сразу появится у зрителей — если файлы ещё не готовы, нажмите у неё «Поставить на паузу в Twitch».'),
        h('li', null, h('b', { text: 'Назначьте файлы. ' }), 'В карточке награды выберите «Звук (основной файл)» и при желании «Видео / GIF / картинка». Для ролика на зелёном фоне поставьте галочку «Убрать зелёный фон».'),
        h('li', null, h('b', { text: 'Выберите режим. ' }), '«🎬 С видео» — показывается видео со своим звуком; «🔊 Только звук» — играет только звук. Здесь же громкость, длительность (0 — до конца файла), задержка и антиспам.'),
        h('li', null, h('b', { text: 'Включите. ' }), 'Отметьте «Включена в боте».'),
        h('li', null, h('b', { text: 'Проверьте. ' }), 'Кнопка «▶ Тест» проигрывает оповещение в OBS без списания баллов. Учтите: во время эфира тест видят и слышат зрители.'),
        h('li', null, h('b', { text: 'Значок (по желанию). ' }), 'Twitch не даёт ботам загружать картинки — значок ставится вручную: ', h('a', { href: 'https://dashboard.twitch.tv', target: '_blank', rel: 'noopener noreferrer', text: 'панель автора Twitch' }), ' → «Награды для зрителей» → «Баллы канала» → «Управление наградами» → награда → «Изображение награды». Нужен PNG 112×112 с прозрачным фоном, не больше ~25 КБ.')),
      h('div', { class: 'infobox', style: 'margin-top:8px' },
        h('p', { style: 'margin:0 0 6px' }, h('b', { text: 'Награда создана на сайте Twitch, а не в боте? ' }), 'Нажмите «Обновить из Twitch» — бот увидит её и сможет проигрывать. Но менять её из панели и возвращать зрителям баллы при сбое он не сможет: для этого нажмите у неё «Создать свою копию в Twitch…», удалите оригинал на сайте Twitch, затем у копии — «Переименовать…» и «Снять с паузы в Twitch».'),
        h('p', { style: 'margin:0' }, h('b', { text: 'Временно убрать видео у всех наград ' }), '(например, на игровой сцене): «Главная» → карточка «Видео» → «Только звук для всех».'))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '4. Мемы и звуки из интернета («Найти медиа»)' }),
      h('ol', null,
        h('li', null, h('b', { text: 'Ключи (один раз). ' }), 'Klipy — ', h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), ' → API Keys; Freesound — ',
          h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), '. Вставьте их в «Настройки» → «Поиск медиа».'),
        h('li', null, h('b', { text: 'Найдите. ' }), '«Найти медиа» → Klipy (клипы со звуком, GIF, стикеры) или Freesound (звуки). Лучше искать по-английски.'),
        h('li', null, h('b', { text: 'Добавьте. ' }), '«＋ В медиатеку», затем «▶ В OBS» для проверки или «＋ Награда» — бот создаст награду в Twitch с этим файлом.'),
        h('li', null, h('b', { text: 'Запасной звук. ' }), 'Мемы Klipy не скачиваются (правила Klipy) — они загружаются с сервера Klipy во время показа. Выберите награде «Звук (основной файл)»: он сыграет, если Klipy или интернет недоступны.')),
      h('p', { class: 'small muted', style: 'margin:0', text: 'Звуки Freesound скачиваются и работают без интернета; автора звуков с лицензией CC BY нужно указывать (например, в описании канала) — он записан у файла в «Медиа».' })));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '5. Переход с Sound Alerts (или другого сервиса)' }),
      h('ol', null,
        h('li', { text: 'Загрузите звуки/видео в раздел «Медиа» и назначьте их наградам.' }),
        h('li', { text: 'Включите «Режим наблюдения» и проверьте во время стрима, что все активации видны в журнале.' }),
        h('li', { text: 'Скройте (значок глаза) источники Sound Alerts во всех сценах OBS, включите нужные награды в боте и «Активный режим».' }),
        h('li', { text: 'По желанию — создайте собственные копии наград (кнопка у награды). Старые награды Sound Alerts удаляйте только после успешной проверки.' }))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: '6. Переход с TriggerFyre' }),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Полная инструкция с таблицей настроек: ',
        h('a', { href: 'https://github.com/darkspiteman/twitch-points-alert-bot/blob/main/docs/MIGRATION-TRIGGERFYRE.md', target: '_blank', rel: 'noopener noreferrer', text: 'docs/MIGRATION-TRIGGERFYRE.md на GitHub' }),
        ' (этот же файл есть в папке программы: docs\\MIGRATION-TRIGGERFYRE.md).'),
      h('ol', null,
        h('li', null, h('b', { text: 'Наблюдение. ' }), '«Главная» → карточка «Режим» → «Включить наблюдение». Пока TriggerFyre работает, бот только записывает активации и ничего не проигрывает.'),
        h('li', null, h('b', { text: 'Перепишите триггеры. ' }), 'В TriggerFyre для каждого триггера запишите Reward name, файл, громкость, длительность, задержку и кулдаун (удобно сделать скриншоты).'),
        h('li', null, h('b', { text: 'Сохраните файлы. ' }), 'Возьмите исходные картинки, видео и звуки или сохраните их со страницы TriggerFyre (правой кнопкой → «Сохранить как…»).'),
        h('li', null, h('b', { text: 'Загрузите и привяжите. ' }), '«Медиа» → перетащите файлы. «Награды» → «Обновить из Twitch»: награды TriggerFyre появятся с меткой «Другое приложение» — это нормально. Назначьте файлы, громкость, длительность, задержку, антиспам и отметьте «Включена в боте».'),
        h('li', null, h('b', { text: 'Положение и размер. ' }), '«Настройки» → «OBS overlay» — они общие для всех наград.'),
        h('li', null, h('b', { text: 'Проверьте. ' }), 'Вне эфира нажмите «▶ Тест» у каждой награды. Проведите один стрим в режиме наблюдения и убедитесь, что все активации есть в «Последних активациях наград».'),
        h('li', null, h('b', { text: 'Переключитесь. ' }), 'В OBS скройте (значок глаза) источник TriggerFyre во всех сценах, затем в боте — «Включить воспроизведение». Откат: «Включить наблюдение» и снова показать источник TriggerFyre.'),
        h('li', null, h('b', { text: 'Отключите TriggerFyre ' }), '(после 2–3 удачных стримов): удалите его источник из OBS и отключите доступ в twitch.tv → «Настройки» → «Подключения».')),
      h('div', { class: 'infobox', style: 'margin-top:8px' },
        h('p', { style: 'margin:0' }, h('b', { text: 'Чего нет в боте: ' }), 'чат-команд, действий в OBS (смена сцены, показ источника, фильтры), случайного выбора файла и «% шанса», лимита срабатываний, своего положения для каждой награды. Бот работает только с наградами за баллы канала.'))));
  }

  // ---------------- старт ----------------
  go();
  connectWs();
  setInterval(function () { if (S && page === 'home') renderHomeTop(); }, 5000);
})();
