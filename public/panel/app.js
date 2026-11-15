// Twitch Alert Bot — панель управления.
// Все пользовательские строки выводятся только через textContent (защита от XSS).
(function () {
  'use strict';

  // Перевод: T(русский текст, [подстановки]) — английский берётся из словаря в i18n.js.
  var T = I18N.t;

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
        if (!r.ok) throw new Error(j.error || (T('Ошибка HTTP {0}', [r.status])));
        return j;
      });
    }, function () { throw new Error(T('Нет связи с ботом. Проверьте, что он запущен.')); });
  }
  function post(path, body) { return api('POST', path, body === undefined ? {} : body); }

  function act(promise, okText) {
    return promise.then(function (r) { if (okText) toast(okText, 'ok'); return r; }, function (e) { toast(e.message, 'bad'); throw e; });
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString(I18N.locale()); }
  function fmtDateTime(ts) { return new Date(ts).toLocaleString(I18N.locale()); }
  function fmtSize(b) { return b > 1048576 ? T('{0} МБ', [(b / 1048576).toFixed(1)]) : T('{0} КБ', [Math.max(1, Math.round(b / 1024))]); }
  function fmtDur(ms) { if (!ms) return '—'; var s = ms / 1000; return s < 60 ? T('{0} с', [s.toFixed(1)]) : T('{0} мин {1} с', [Math.floor(s / 60), Math.round(s % 60)]); }
  function ago(ts) { if (!ts) return T('никогда'); var s = Math.round((Date.now() - ts) / 1000); return s < 60 ? T('{0} с назад', [s]) : T('{0} мин назад', [Math.round(s / 60)]); }

  // ---------------- состояние ----------------
  var S = null; // полный state с сервера
  var page = 'home';
  var ws = null;
  var probed = {};
  var bootVersion = '';

  function load() {
    return api('GET', '/api/state').then(function (s) {
      // Бот обновился — загружаем новую версию панели целиком.
      if (bootVersion && s.status.version !== bootVersion) { location.reload(); return; }
      bootVersion = s.status.version;
      S = s;
      $('conn-banner').hidden = true;
      applyLanguage();
      render();
      renderUpdateUi();
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
      else if (m.type === 'update') { S.update = m.update; renderUpdateUi(); if (page === 'support') renderSupport(); }
    };
    ws.onclose = function () {
      $('conn-banner').hidden = false;
      $('conn-banner').textContent = S && S.update && S.update.step === 'restart' ? T('Бот перезапускается после обновления…') : T('Нет связи с ботом. Переподключение…');
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
      el.addEventListener('loadedmetadata', function () {
        // Видео, у которого браузер читает только звук (видеокодек не поддерживается), — картинки не будет.
        if (m.kind === 'video' && !el.videoWidth) { report(false, 'браузер читает из файла только звук, картинку — нет (видеокодек не поддерживается)'); return; }
        report(isFinite(el.duration) && el.duration > 0, 'неизвестная длительность');
      });
      el.addEventListener('error', function () { report(false, el.error ? 'код ' + el.error.code : 'ошибка'); });
      setTimeout(function () { report(false, 'превышено время проверки'); }, 15000);
      el.src = '/media/' + m.id;
    });
  }

  // ---------------- язык ----------------
  var NAV = { home: 'Главная', rewards: 'Награды', media: 'Медиа', find: 'Найти медиа', stats: 'Статистика', settings: 'Настройки', log: 'Журнал', help: 'Помощь', support: '❤ Поддержать автора' };
  var langAutoSaved = false;

  /** Язык из настроек бота. Не выбран (новая установка) — подбираем по языку браузера и сохраняем выбор. */
  function applyLanguage() {
    var want = S.settings.language;
    if (want !== 'ru' && want !== 'en') {
      want = I18N.detect();
      if (!langAutoSaved) {
        langAutoSaved = true;
        post('/api/settings', { language: want }).then(function (r) { S.settings = r.settings; }, function () { /* повторим при следующей загрузке */ });
      }
    }
    if (want !== I18N.lang()) I18N.setLang(want);
    renderStatic();
  }

  /** Тексты из index.html и переключатель языка в боковой панели. */
  function renderStatic() {
    document.documentElement.lang = I18N.lang();
    document.querySelectorAll('nav a').forEach(function (a) { if (NAV[a.dataset.page]) a.textContent = T(NAV[a.dataset.page]); });
    var box = $('lang-switch');
    if (!box) return;
    clear(box);
    I18N.languages.forEach(function (l) {
      box.appendChild(h('button', { class: 'small' + (I18N.lang() === l.id ? ' active' : ''), text: l.short, title: l.name, 'aria-pressed': I18N.lang() === l.id ? 'true' : 'false',
        onclick: function () { setLanguage(l.id); } }));
    });
  }

  /** Смена языка: сохраняется в боте (сообщения сервера, overlay, трей) и сразу применяется без перезапуска. */
  function setLanguage(l) {
    if (l === I18N.lang() && S && S.settings.language === l) return;
    I18N.setLang(l);
    renderStatic();
    render();
    if (!S) return;
    return act(post('/api/settings', { language: l })).then(function (r) { S.settings = r.settings; load(); }, function () { load(); });
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
    else if (page === 'support') renderSupport();
    else if (page === 'stats') renderStats();
    else if (page === 'settings') renderSettings();
    else if (page === 'log') renderLog();
    else if (page === 'help') renderHelp();
  }

  // ---------------- статусы ----------------
  function twitchView(st) {
    var a = st.auth;
    if (a.status === 'ok') return { cls: 'ok', text: T('Подключён'), detail: a.login };
    if (a.status === 'pending') return { cls: 'warn', text: T('Ожидает подтверждения'), detail: T('Код: {0}', [a.userCode]) };
    if (a.status === 'no_client_id') return { cls: 'bad', text: T('Не настроен'), detail: a.message };
    return { cls: 'bad', text: T('Отключён'), detail: a.message };
  }
  function eventsubView(st) {
    var e = st.eventsub;
    var map = {
      connected: { cls: 'ok', text: T('Активен') },
      subscribing: { cls: 'warn', text: T('Подписка…') },
      connecting: { cls: 'warn', text: T('Подключение…') },
      reconnecting: { cls: 'warn', text: T('Переподключение…') },
      error: { cls: 'bad', text: T('Ошибка') },
      stopped: { cls: '', text: T('Не запущен') },
    };
    var v = map[e.state] || { cls: '', text: e.state };
    v.detail = e.state === 'connected' ? T('Последнее сообщение: {0}', [ago(e.lastMessageAt)])
      : e.state === 'reconnecting' && e.nextRetryAt ? T('Повтор через {0} с{1}', [Math.max(0, Math.round((e.nextRetryAt - Date.now()) / 1000)), (e.lastError ? ' (' + e.lastError + ')' : '')])
      : e.lastError || (st.auth.status !== 'ok' ? T('Требуется вход в Twitch') : '');
    return v;
  }
  // Программа для стрима: OBS Studio или Streamlabs Desktop (у обеих одинаковый Browser Source).
  var APPS = { obs: { name: 'OBS Studio', short: 'OBS' }, streamlabs: { name: 'Streamlabs Desktop', short: 'Streamlabs' } };
  function streamApp() { return S && S.settings.streamApp === 'streamlabs' ? 'streamlabs' : 'obs'; }
  function appName() { return APPS[streamApp()].name; }
  function appShort() { return APPS[streamApp()].short; }
  /** Overlay подключён из Streamlabs, а в настройках выбран OBS — предложить переключить. */
  function streamlabsDetected(st) {
    return streamApp() === 'obs' && st.overlays.some(function (o) { return o.app === 'streamlabs'; });
  }

  function overlayView(st) {
    var n = st.overlays.length;
    var stream = st.overlays.filter(function (o) { return o.isObs; });
    var sl = stream.filter(function (o) { return o.app === 'streamlabs'; }).length;
    var obs = stream.length - sl;
    if (!n) return { cls: 'bad', text: T('Не подключён'), detail: T('Добавьте Browser Source в {0}', [appName()]) };
    var parts = [];
    if (obs) parts.push('OBS: ' + obs);
    if (sl) parts.push('Streamlabs: ' + sl);
    if (n > stream.length) parts.push(T('браузер: {0}', [(n - stream.length)]));
    if (stream.length > 1) return { cls: 'warn', text: T('Подключено: {0}', [n]), detail: T('Внимание: {0} источника ({1}) — звук может дублироваться', [stream.length, parts.join(', ')]) };
    return { cls: stream.length ? 'ok' : 'warn', text: T('Подключён'), detail: stream.length ? parts.join(', ') : T('Только предпросмотр в браузере') };
  }

  /** Поле «только для чтения» с кнопкой «Копировать» (и необязательной второй кнопкой). */
  function copyField(value, done, extra) {
    var inp = h('input', { type: 'text', value: value, readonly: true });
    return h('div', { class: 'copy-field' }, inp, h('button', { text: T('Копировать'), onclick: function () {
      inp.select();
      (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject()).then(function () { toast(done, 'ok'); }, function () { document.execCommand('copy'); toast(done, 'ok'); });
    } }), extra || null);
  }

  /** Источник в программе для стрима открыт по адресу, а не через файл-загрузчик — подсказать переключить. */
  function loaderTipNeeded(st) {
    var stream = st.overlays.filter(function (o) { return o.isObs; });
    return !!S.overlayLoader && stream.length > 0 && !stream.some(function (o) { return o.viaFile; });
  }
  function loaderTipBox() {
    return h('div', { class: 'infobox' },
      h('p', { style: 'margin:0 0 6px' }, h('b', { text: T('Источник в {0} открыт по адресу. ', [appShort()]) }),
        T('Если запустить {0} раньше бота, оповещения не появятся, пока не обновите источник вручную. Переключите источник на файл — тогда порядок запуска неважен:', [appShort()])),
      h('ol', { style: 'margin:0 0 6px; padding-left:20px' },
        h('li', { text: T('В {0} откройте свойства источника бота (например, «Alert Bot»).', [appShort()]) }),
        h('li', { text: T('Поставьте галочку «Локальный файл», нажмите «Обзор» и выберите файл (путь можно вставить в строку «Имя файла»):') }),
        h('li', { text: T('Нажмите «ОК». Остальные настройки источника не меняйте.') })),
      copyField(S.overlayLoader, T('Путь скопирован')));
  }

  function switchToStreamlabsBox() {
    return h('div', { class: 'infobox' },
      h('p', { style: 'margin:0 0 6px' }, h('b', { text: T('Overlay подключён из Streamlabs Desktop. ') }),
        T('Выберите Streamlabs как программу для стрима — тогда кнопка запуска, резервная копия сцен и подсказки будут для Streamlabs.')),
      h('button', { class: 'small primary', text: T('Выбрать Streamlabs Desktop'), onclick: function () {
        saveSetting('streamApp', 'streamlabs').then(function () { render(); });
      } }));
  }

  function renderSide() {
    var el = clear($('side-status'));
    var st = S.status;
    [['Twitch', twitchView(st)], ['EventSub', eventsubView(st)], ['Overlay', overlayView(st)]].forEach(function (x) {
      el.appendChild(h('div', null, h('span', { class: 'dot ' + x[1].cls }), x[0] + ': ' + x[1].text));
    });
    if (st.mode === 'observe') el.appendChild(h('div', null, h('span', { class: 'dot warn' }), T('Режим наблюдения')));
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
      { done: !!S.settings.clientId, text: T('Укажите Client ID приложения Twitch'), go: '#settings' },
      { done: st.auth.status === 'ok', text: T('Войдите через Twitch'), go: '#settings' },
      { done: st.overlays.some(function (o) { return o.isObs; }), text: T('Добавьте Browser Source в {0}', [appName()]), go: '#help' },
      { done: S.rewards.some(function (r) { return r.bot_enabled && (r.media_id || r.sound_id || r.video_id); }), text: T('Назначьте медиафайлы наградам и включите их'), go: '#rewards' },
    ];
    if (steps.some(function (s) { return !s.done; })) {
      root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('Первоначальная настройка') }),
        h('ol', { class: 'steps' }, steps.map(function (s) {
          return h('li', { class: s.done ? 'done' : '' }, h('span', null, s.text, ' ', s.done ? null : h('a', { href: s.go, text: T('Перейти →') })));
        }))));
    }
    if (streamlabsDetected(st)) root.appendChild(switchToStreamlabsBox());
    if (loaderTipNeeded(st)) root.appendChild(loaderTipBox());

    var tw = twitchView(st);
    var twActions = st.auth.status === 'ok' ? [] : [h('button', { class: 'primary small', text: T('Войти'), onclick: function () { location.hash = '#settings'; } })];
    var es = eventsubView(st);
    var esActions = st.auth.status === 'ok' ? [h('button', { class: 'small', text: T('Переподключить'), onclick: function () { act(post('/api/eventsub/reconnect'), T('Переподключение запущено')); } })] : [];
    var modeCard = h('div', { class: 'card stat' },
      h('div', { class: 'label', text: T('Режим') }),
      h('div', { class: 'value' }, h('span', { class: 'dot ' + (st.mode === 'active' ? 'ok' : 'warn') }), st.mode === 'active' ? T('Активный') : T('Наблюдение')),
      h('div', { class: 'detail', text: st.mode === 'active' ? T('Оповещения воспроизводятся') : T('События записываются, но не воспроизводятся') }),
      h('div', { class: 'actions' }, h('button', {
        class: 'small', text: st.mode === 'active' ? T('Включить наблюдение') : T('Включить воспроизведение'),
        onclick: function () { act(post('/api/settings', { mode: st.mode === 'active' ? 'observe' : 'active' })).then(load); },
      })));
    var audioOnly = !!S.settings.audioOnly;
    var videoCard = h('div', { class: 'card stat' },
      h('div', { class: 'label', text: T('Видео') }),
      h('div', { class: 'value' }, h('span', { class: 'dot ' + (audioOnly ? 'warn' : 'ok') }), audioOnly ? T('Только звук') : T('С видео')),
      h('div', { class: 'detail', text: audioOnly ? T('Видео выключено для всех наград') : T('Как настроено у каждой награды') }),
      h('div', { class: 'actions' }, h('button', {
        class: 'small', text: audioOnly ? T('Включить видео') : T('Только звук для всех'),
        onclick: function () { act(post('/api/settings', { audioOnly: !audioOnly }), audioOnly ? T('Видео включено') : T('Теперь все награды — только звук')).then(load); },
      })));
    root.appendChild(h('div', { class: 'grid cols-4' },
      statCard('Twitch', tw, twActions), statCard('EventSub', es, esActions), statCard('Overlay (' + appShort() + ')', overlayView(st)), modeCard, videoCard));

  }

  function renderHome() {
    var root = clear($('page-home'));
    root.appendChild(h('h1', { text: T('Главная') }));
    root.appendChild(h('div', { id: 'home-top' }));
    renderHomeTop();

    var testRow = h('div', { class: 'row' });
    var sel = h('select', { class: 'grow' }, h('option', { value: '', text: T('— выберите награду —') }),
      S.rewards.filter(function (r) { return r.media_id || r.sound_id || r.video_id; }).map(function (r) { return h('option', { value: r.id, text: r.title + ' (' + r.cost + ')' }); }));
    testRow.appendChild(h('button', { class: 'primary', text: T('Тестовое оповещение'), onclick: function () { act(post('/api/test'), T('Тест добавлен в очередь')); } }));
    testRow.appendChild(sel);
    testRow.appendChild(h('button', { text: T('Тест награды'), onclick: function () {
      if (!sel.value) return toast(T('Выберите награду'), 'bad');
      act(post('/api/rewards/' + encodeURIComponent(sel.value) + '/test'), T('Тест добавлен в очередь'));
    } }));
    root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: T('Тестирование') }), h('span', { class: 'muted small', text: T('Баллы канала не списываются') })), testRow));

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
    card.appendChild(h('div', { class: 'card-head' }, h('h2', { text: T('Очередь ({0})', [q.items.length]) }),
      h('div', { class: 'row' },
        h('button', { class: 'small', text: q.paused ? T('Продолжить') : T('Пауза'), onclick: function () { act(post(q.paused ? '/api/queue/resume' : '/api/queue/pause')); } }),
        h('button', { class: 'small', text: T('Пропустить'), disabled: !q.current, onclick: function () { act(post('/api/queue/skip')); } }),
        h('button', { class: 'small danger', text: T('Очистить'), disabled: !q.items.length, onclick: function () {
          if (confirm(T('Удалить из очереди все ожидающие оповещения?'))) act(post('/api/queue/clear'), T('Очередь очищена'));
        } }))));
    if (q.paused) card.appendChild(h('div', { class: 'warnbox', text: T('Очередь на паузе — новые оповещения ждут.') }));
    var list = h('div', { class: 'list' });
    if (q.current) list.appendChild(h('div', { class: 'list-item' }, h('span', { class: 'badge ok', text: T('Играет') }),
      h('span', { class: 'grow', text: q.current.rewardTitle + ' — ' + q.current.userName })));
    q.items.forEach(function (it, i) {
      list.appendChild(h('div', { class: 'list-item' }, h('span', { class: 'badge', text: '#' + (i + 1) }),
        h('span', { class: 'grow', text: it.rewardTitle + ' — ' + it.userName }),
        h('button', { class: 'small', text: '✕', title: T('Убрать'), onclick: function () { act(post('/api/queue/remove/' + encodeURIComponent(it.id))); } })));
    });
    if (!q.current && !q.items.length) list.appendChild(h('div', { class: 'empty', text: T('Очередь пуста') }));
    card.appendChild(list);
  }

  function levelBadge(l) { return h('span', { class: 'badge ' + (l === 'error' ? 'bad' : l === 'warn' ? 'warn' : ''), text: l === 'error' ? T('ошибка') : l === 'warn' ? T('внимание') : T('инфо') }); }

  function renderEventsMini() {
    var card = $('events-card');
    if (!card) return;
    clear(card);
    card.appendChild(h('div', { class: 'card-head' }, h('h2', { text: T('Последние события') }), h('a', { href: '#log', text: T('Весь журнал') })));
    var list = h('div', { class: 'list' });
    S.events.slice(0, 8).forEach(function (e) {
      list.appendChild(h('div', { class: 'list-item' }, levelBadge(e.level), h('span', { class: 'grow', text: e.message, title: e.message }), h('span', { class: 'muted small', text: fmtTime(e.ts) })));
    });
    if (!S.events.length) list.appendChild(h('div', { class: 'empty', text: T('Событий пока нет') }));
    card.appendChild(list);
  }

  var STATUS_RU = {
    received: ['получено', ''], queued: ['в очереди', 'accent'], playing: ['играет', 'ok'], done: ['воспроизведено', 'ok'],
    failed: ['ошибка', 'bad'], skipped: ['пропущено', 'warn'], dropped: ['отменено', 'warn'], ignored: ['не настроено', ''],
    observed: ['наблюдение', ''], missed: ['пропущено (устарело)', 'warn'],
  };
  var SOURCE_RU = { eventsub: 'Twitch', recovery: 'восстановлено', simulate: 'симуляция', test: 'тест' };

  function renderRedemptionsCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: T('Последние активации наград') }));
    if (!S.redemptions.length) { card.appendChild(h('div', { class: 'empty', text: T('Пока не было активаций') })); return card; }
    var tb = h('tbody');
    S.redemptions.slice(0, 25).forEach(function (r) {
      var st = STATUS_RU[r.status] ? [T(STATUS_RU[r.status][0]), STATUS_RU[r.status][1]] : [r.status, ''];
      tb.appendChild(h('tr', null,
        h('td', { class: 'muted', text: fmtTime(r.received_at) }),
        h('td', { text: r.user_name || r.user_login }),
        h('td', null, r.reward_title, r.user_input ? h('div', { class: 'muted small', text: '«' + r.user_input + '»' }) : null),
        h('td', null, h('span', { class: 'badge ' + st[1], text: st[0] }), r.status_msg ? h('div', { class: 'muted small', text: r.status_msg }) : null),
        h('td', { class: 'muted small', text: SOURCE_RU[r.source] ? T(SOURCE_RU[r.source]) : r.source })));
    });
    card.appendChild(h('table', null, h('thead', null, h('tr', null, h('th', { text: T('Время') }), h('th', { text: T('Зритель') }), h('th', { text: T('Награда') }), h('th', { text: T('Статус') }), h('th', { text: T('Источник') }))), tb));
    return card;
  }

  // ---------------- Награды ----------------
  function mediaOptions(selected, filter) {
    var opts = [h('option', { value: '', text: T('— нет —') })];
    S.media.filter(filter || function () { return true; }).forEach(function (m) {
      var kind = m.source === 'klipy' ? '🌐' : ({ audio: '🔊', video: '🎬', image: '🖼' }[m.kind] || '');
      opts.push(h('option', { value: m.id, text: kind + ' ' + m.name + (m.source === 'klipy' ? T(' (онлайн, Klipy)') : '') + (m.status === 'broken' ? T(' (повреждён!)') : ''), selected: m.id === selected }));
    });
    return opts;
  }

  function saveReward(id, patch) {
    return act(post('/api/rewards/' + encodeURIComponent(id), patch), T('Сохранено')).then(function (r) {
      for (var i = 0; i < S.rewards.length; i++) if (S.rewards[i].id === id) S.rewards[i] = r;
    });
  }

  function renderRewards() {
    var root = clear($('page-rewards'));
    root.appendChild(h('div', { class: 'card-head' }, h('h1', { text: T('Награды') }),
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: T('+ Новая награда в Twitch'), onclick: function () {
          var t = prompt(T('Название новой награды (до 45 символов):'), '');
          if (!t) return;
          var c = Number(prompt(T('Стоимость в баллах:'), '1000'));
          if (!c) return;
          var cd = Number(prompt(T('Перезарядка в секундах (0 — без перезарядки):'), '60') || 0);
          if (!confirm(T('Создать в Twitch награду «{0}» за {1} баллов? Она сразу станет видна зрителям.', [t, c]))) return;
          act(post('/api/rewards/create', { confirm: true, title: t, cost: c, cooldownSec: cd }), T('Награда создана — назначьте ей медиафайл и включите')).then(load);
        } }),
        h('button', { text: T('Обновить из Twitch'), onclick: function () { act(post('/api/rewards/sync'), T('Список наград обновлён')).then(load); } }),
        h('button', { text: T('Добавить локальную тестовую'), onclick: function () {
          var t = prompt(T('Название тестовой награды (только для проверки, в Twitch не создаётся):'), T('Тестовая награда'));
          if (t) act(post('/api/rewards/local', { title: t })).then(load);
        } }))));
    root.appendChild(h('div', { class: 'infobox' },
      h('p', null, T('Награды загружаются из Twitch. Новые награды по умолчанию '), h('b', { text: T('выключены') }), T(' в боте — включите и назначьте им звук. Режим «С видео» показывает выбранное видео/GIF, «Только звук» — проигрывает только звук.')),
      h('p', { style: 'margin:0' }, T('Метка «Другое приложение» означает, что награду создал Sound Alerts или другой сервис: бот может на неё реагировать, но изменить её в Twitch не может.'))));

    if (!S.rewards.length) {
      root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: S.status.auth.status === 'ok' ? T('Наград нет. Нажмите «Обновить из Twitch».') : T('Войдите в Twitch, чтобы загрузить награды, или добавьте локальную тестовую награду.') })));
      return;
    }
    S.rewards.forEach(function (r) { root.appendChild(rewardCard(r)); });
  }

  function rewardCard(r) {
    var raw = {}; try { raw = JSON.parse(r.raw || '{}'); } catch (e) { /* */ }
    var isLocal = r.id.indexOf('local-') === 0;
    var card = h('div', { class: 'card reward-card' + (r.bot_enabled ? '' : ' disabled') });
    var badges = [];
    if (isLocal) badges.push(h('span', { class: 'badge', text: T('Локальная (тест)') }));
    else if (r.manageable) badges.push(h('span', { class: 'badge accent', text: T('Создана ботом') }));
    else badges.push(h('span', { class: 'badge', text: T('Другое приложение') }));
    if (!isLocal) badges.push(r.twitch_enabled ? h('span', { class: 'badge ok', text: T('Активна в Twitch') }) : h('span', { class: 'badge warn', text: T('Выключена/на паузе в Twitch') }));
    var enabled = h('input', { type: 'checkbox', checked: !!r.bot_enabled, onchange: function () {
      if (enabled.checked && !r.manageable && !isLocal && S.settings.mode === 'active' &&
        !confirm(T('Включить «{0}» в боте?\n\nЕсли эту награду всё ещё обрабатывает Sound Alerts (его источник есть в {1}), оповещение прозвучит дважды. Сначала уберите или скройте источник Sound Alerts в {2}, либо включите «Режим наблюдения».', [r.title, appShort(), appShort()]))) {
        enabled.checked = false; return;
      }
      saveReward(r.id, { bot_enabled: enabled.checked }).then(function () { card.classList.toggle('disabled', !enabled.checked); });
    } });
    card.appendChild(h('div', { class: 'card-head' },
      h('div', { class: 'reward-title' }, h('span', { class: 'swatch', style: 'background:' + (/^#[0-9a-f]{6}$/i.test(r.background_color) ? r.background_color : '#555') }),
        h('strong', { text: r.title }), h('span', { class: 'muted', text: T('{0} баллов', [r.cost]) }), badges),
      h('label', { class: 'check', style: 'margin:0' }, enabled, T('Включена в боте'))));
    if (r.prompt) card.appendChild(h('div', { class: 'muted small', text: r.prompt }));

    var media = h('select', { onchange: function () { saveReward(r.id, { media_id: media.value || null }); } }, mediaOptions(r.media_id));
    var video = h('select', { onchange: function () { saveReward(r.id, { video_id: video.value || null }).then(function () { renderRewards(); }); } }, mediaOptions(r.video_id, function (m) { return m.kind !== 'audio'; }));
    var hasVisual = !!r.video_id || !!(r.media_id && S.media.some(function (m) { return m.id === r.media_id && m.kind !== 'audio'; }));
    var onlineMedia = [r.video_id, r.media_id].map(function (id) { return id && S.media.find(function (m) { return m.id === id && m.source === 'klipy'; }); }).filter(Boolean)[0];
    var fallbackOk = !!(r.media_id && S.media.some(function (m) { return m.id === r.media_id && m.kind === 'audio' && m.source !== 'klipy'; }));
    var effectiveMode = hasVisual ? r.play_mode : 'audio';
    var chroma = h('input', { type: 'checkbox', checked: !!r.chroma_key, onchange: function () { saveReward(r.id, { chroma_key: chroma.checked }); } });
    var chromaField = h('label', { class: 'check', title: T('Для видео на зелёном фоне (green screen): зелёный станет прозрачным') }, chroma, T('Убрать зелёный фон (хромакей)'));
    var modeBtn = function (mode, text) {
      return h('button', { class: 'small' + (effectiveMode === mode ? ' active' : ''), text: text, disabled: mode === 'video' && !hasVisual,
        title: mode === 'video' && !hasVisual ? T('Сначала выберите видео') : '',
        onclick: function () { saveReward(r.id, { play_mode: mode }).then(function () { renderRewards(); }); } });
    };
    var modeSwitch = h('div', { class: 'field' }, h('label', { text: T('Воспроизведение') }),
      h('div', { class: 'tabs', style: 'margin:0' }, modeBtn('video', T('🎬 С видео')), modeBtn('audio', T('🔊 Только звук'))),
      S.settings.audioOnly ? h('span', { class: 'hint', text: T('Сейчас видео выключено для всех наград (Главная → Видео)') }) : null);
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
      h('div', { class: 'field' }, h('label', { text: T('Звук (основной файл)') }), media),
      h('div', { class: 'field' }, h('label', { text: T('Видео / GIF / картинка') }), video, h('span', { class: 'hint', text: T('В режиме «С видео» у видео играет его собственный звук') })),
      chromaField,
      h('div', { class: 'field' }, h('label', { text: T('Звук к видео/GIF (необязательно)') }), sound),
      h('div', { class: 'field' }, h('label', null, T('Громкость: '), volLabel), vol),
      numField(T('Длительность, с'), 'duration_ms', r.duration_ms, 1000, T('0 — до конца видео/звука')),
      numField(T('Задержка перед показом, с'), 'delay_ms', r.delay_ms, 1000),
      numField(T('Антиспам: повтор от зрителя не чаще, с'), 'cooldown_sec', r.cooldown_sec, 1, T('0 — без ограничения')),
      h('label', { class: 'check' }, caption, T('Показывать подпись'))));

    var actions = h('div', { class: 'reward-actions' },
      h('button', { class: 'primary small', text: T('▶ Тест'), onclick: function () { act(post('/api/rewards/' + encodeURIComponent(r.id) + '/test'), T('Тест добавлен в очередь')); } }),
      h('button', { class: 'small', text: T('Симулировать событие Twitch'), title: T('Проверка всего пути обработки (включено/выключено, режим, очередь) без списания баллов'), onclick: function () {
        act(post('/api/rewards/' + encodeURIComponent(r.id) + '/simulate', { user: 'test_viewer' })).then(function (res) {
          var m = { queued: T('Событие обработано и поставлено в очередь'), ignored: T('Событие получено, но награда выключена или не настроена'), observed: T('Режим наблюдения: событие записано без воспроизведения'), skipped: T('Пропущено (очередь/антиспам)'), failed: T('Ошибка: проверьте медиафайл') };
          toast(m[res.result] || (T('Результат: {0}', [res.result])), res.result === 'queued' ? 'ok' : '');
        });
      } }));
    if (!isLocal && !r.manageable) {
      actions.appendChild(h('button', { class: 'small', text: T('Создать свою копию в Twitch…'), onclick: function () { cloneReward(r); } }));
    }
    if (r.manageable) {
      var paused = raw.is_paused;
      actions.appendChild(h('button', { class: 'small', text: paused ? T('Снять с паузы в Twitch') : T('Поставить на паузу в Twitch'), onclick: function () {
        act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { is_paused: !paused }), T('Изменено в Twitch')).then(load);
      } }));
      actions.appendChild(h('button', { class: 'small', text: T('Переименовать…'), onclick: function () {
        var t = prompt(T('Новое название награды в Twitch (до 45 символов):'), r.title);
        if (t && t !== r.title) act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { title: t }), T('Переименовано')).then(load);
      } }));
      actions.appendChild(h('button', { class: 'small', text: T('Стоимость…'), onclick: function () {
        var c = prompt(T('Новая стоимость в баллах:'), String(r.cost));
        if (c && Number(c) !== r.cost) act(post('/api/rewards/' + encodeURIComponent(r.id) + '/twitch', { cost: Number(c) }), T('Стоимость изменена')).then(load);
      } }));
    }
    card.appendChild(actions);

    [r.media_id, r.video_id, r.sound_id].forEach(function (id) {
      var m = id && S.media.find(function (x) { return x.id === id; });
      if (m && m.status === 'broken') card.appendChild(h('div', { class: 'warnbox', text: T('Медиафайл «{0}» повреждён: {1}', [m.name, m.status_msg]) }));
    });
    if (onlineMedia) card.appendChild(h('div', { class: fallbackOk ? 'infobox' : 'warnbox', style: 'margin-top:10px', text: fallbackOk
      ? T('🌐 «{0}» показывается онлайн с сервера Klipy. Если Klipy недоступен — сыграет «Звук (основной файл)».', [onlineMedia.name])
      : T('🌐 «{0}» показывается онлайн с сервера Klipy. Выберите «Звук (основной файл)» — он сыграет, если Klipy или интернет недоступны; иначе оповещения не будет.', [onlineMedia.name]) }));
    if (r.bot_enabled && !r.media_id && !r.sound_id && !r.video_id) card.appendChild(h('div', { class: 'warnbox', text: T('Награда включена, но медиафайл не выбран — оповещение не покажется.') }));
    return card;
  }

  function cloneReward(r) {
    var msg = T('Создать в вашем канале Twitch НОВУЮ награду — копию «{0}» ({1} баллов)?\n\n• Копия будет создана НА ПАУЗЕ — зрители её не увидят, пока вы не снимете паузу.\n• Twitch требует уникальных названий, поэтому к названию добавится «★». Переименовать можно позже, после удаления старой награды.\n• Старая награда не изменяется.\n\nПродолжить?', [r.title, r.cost]);
    if (!confirm(msg)) return;
    act(post('/api/rewards/' + encodeURIComponent(r.id) + '/clone', { confirm: true }), T('Копия создана (на паузе)')).then(load);
  }

  // ---------------- Медиа ----------------
  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files);
    var next = function () {
      var f = list.shift();
      if (!f) { load(); return; }
      toast(T('Загрузка «{0}»…', [f.name]));
      api('PUT', '/api/media', f, { 'x-file-name': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' })
        .then(function (row) { toast(T('Файл «{0}» добавлен{1}', [row.name, (row.status === 'warning' ? ': ' + row.status_msg : '')]), row.status === 'warning' ? '' : 'ok'); },
          function (e) { toast('«' + f.name + '»: ' + e.message, 'bad'); })
        .then(next);
    };
    next();
  }

  // Перекодирование в браузере панели: файл проигрывается здесь (браузер знает больше кодеков, чем OBS/Streamlabs)
  // и записывается заново в WebM (VP9/VP8 + Opus) — этот формат понимают OBS и Streamlabs. Внешние программы не нужны.
  function recorderType(isVideo) {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var list = isVideo ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['audio/webm;codecs=opus', 'audio/webm'];
    for (var i = 0; i < list.length; i++) if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    return '';
  }

  function transcodeMedia(m) {
    var isVideo = m.kind === 'video';
    var type = recorderType(isVideo);
    if (!type) { toast(T('Этот браузер не умеет записывать WebM. Откройте панель в Chrome или Edge.'), 'bad'); return; }
    var el = h(isVideo ? 'video' : 'audio', { class: 'transcode-preview', preload: 'auto', playsinline: true });
    var bar = h('progress', { class: 'transcode-bar', max: 100, value: 0 });
    var status = h('p', { class: 'small muted', text: T('Нажмите «Начать».') });
    var replace = h('input', { type: 'checkbox', checked: true });
    var running = false, cancelled = false, rec = null, ctx = null, tick = 0, guard = 0;
    var canvas = null, drawTimer = 0, sawPicture = false, samples = 0;
    function noPictureMsg() {
      // Название кодека сервер достаёт из своего (русского) текста — панель от языка сообщения не зависит.
      return T('Браузер читает из этого файла только звук, а картинку — нет{0}.', [(m.videoCodec ? T(' (видео в кодеке {0})', [m.videoCodec]) : '')]) + ' ' + handbrakeTip();
    }
    function handbrakeTip() { return T('Перекодируйте файл бесплатной программой HandBrake в MP4 (H.264 + AAC) и загрузите заново.'); }
    function cleanup() {
      clearInterval(tick); clearTimeout(guard);
      if (drawTimer) clearInterval(drawTimer);
      canvas = null;
      try { el.pause(); } catch (e) { /* */ }
      el.removeAttribute('src'); try { el.load(); } catch (e) { /* */ }
      if (ctx) { ctx.close().catch(function () {}); ctx = null; }
    }
    function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); }
    var startBtn = h('button', { class: 'primary', text: T('Начать'), onclick: start });
    var cancelBtn = h('button', { text: T('Отмена'), onclick: function () { cancelled = true; stopRec(); cleanup(); closeModal(); } });
    modal(T('Перекодировать «{0}»', [m.name]), h('div', null,
      h('p', { class: 'small', text: T('Файл проиграется в этом окне и запишется заново в WebM ({0}) — этот формат понимают OBS и Streamlabs. Это займёт примерно столько же времени, сколько длится файл. Не закрывайте окно и не сворачивайте браузер.', [(isVideo ? 'VP9 + Opus' : 'Opus')]) }),
      isVideo ? h('div', { class: 'transcode-box' }, el) : el, bar, status,
      h('label', { class: 'check' }, replace, m.usedBy.length ? T('Заменить файл у наград ({0}) и удалить исходный', [m.usedBy.join(', ')]) : T('Удалить исходный файл после перекодирования'))),
      [startBtn, cancelBtn]);

    function fail(msg) {
      running = false; cleanup();
      status.textContent = msg; status.className = 'small bad-text';
      startBtn.disabled = true;
    }

    function start() {
      if (running) return;
      running = true; startBtn.disabled = true;
      status.className = 'small muted'; status.textContent = T('Загрузка файла…');
      // AudioContext создаётся сразу по клику — иначе браузер может не разрешить звук.
      var AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC(); } catch (e) { fail(T('Браузер не дал доступ к звуку: {0}', [e.message])); return; }
      var ready = new Promise(function (resolve, reject) {
        el.addEventListener('loadedmetadata', resolve, { once: true });
        el.addEventListener('error', function () {
          reject(new Error(T('Браузер тоже не может прочитать этот файл ({0}). Перекодируйте его бесплатной программой HandBrake в MP4 (H.264 + AAC) и загрузите заново.', [(el.error ? T('код {0}', [el.error.code]) : T('ошибка'))])));
        }, { once: true });
      });
      el.src = '/media/' + m.id;
      ready.then(function () {
        var dur = el.duration;
        if (!isFinite(dur) || dur <= 0) throw new Error(T('Не удалось определить длительность файла.'));
        if (dur > 600) throw new Error(T('Файл длиннее 10 минут — перекодируйте его программой HandBrake в MP4 (H.264 + AAC).'));
        var src = ctx.createMediaElementSource(el);
        var dest = ctx.createMediaStreamDestination();
        src.connect(dest); // в колонки не выводим: запись идёт беззвучно
        var tracks = dest.stream.getAudioTracks();
        if (isVideo) {
          // Видеодорожку браузер не читает (например, MPEG-4/DivX): он играет только звук, картинка была бы чёрной.
          if (!el.videoWidth || !el.videoHeight) throw new Error(noPictureMsg());
          // Кадры рисуются в canvas и записываются оттуда: прямой захват видео (captureStream) на части компьютеров
          // отдаёт чёрные кадры (аппаратное декодирование H.265, HDR). Заодно проверяем, что картинка не пустая.
          var scale = Math.min(1, Math.sqrt(1920 * 1080 / (el.videoWidth * el.videoHeight)));
          canvas = document.createElement('canvas');
          canvas.width = Math.round(el.videoWidth * scale / 2) * 2;
          canvas.height = Math.round(el.videoHeight * scale / 2) * 2;
          var g = canvas.getContext('2d');
          var cs = canvas.captureStream ? canvas.captureStream(0) : null;
          if (!cs || !g) throw new Error(T('Браузер не умеет записывать видео. Откройте панель в Chrome или Edge.'));
          var vtrack = cs.getVideoTracks()[0];
          var probeCanvas = document.createElement('canvas');
          probeCanvas.width = 32; probeCanvas.height = 18;
          var pg = probeCanvas.getContext('2d', { willReadFrequently: true });
          var frames = 0;
          var draw = function () {
            if (!canvas) return;
            g.drawImage(el, 0, 0, canvas.width, canvas.height);
            if (vtrack.requestFrame) vtrack.requestFrame();
            // Яркость кадра (уменьшенная копия): раз в ~15 кадров.
            if (frames++ % 15 === 0) {
              pg.drawImage(canvas, 0, 0, 32, 18);
              var d = pg.getImageData(0, 0, 32, 18).data;
              for (var i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) { sawPicture = true; break; }
              samples++;
            }
          };
          // Ровные 30 кадров/с по таймеру: события отрисовки (requestAnimationFrame) браузер замедляет,
          // если окно частично скрыто, — видео получилось бы рваным.
          drawTimer = setInterval(function () { if (!el.paused && !el.ended) draw(); }, 1000 / 30);
          tracks = [vtrack].concat(tracks);
        }
        var px = isVideo ? canvas.width * canvas.height : 0;
        var opts = { mimeType: type, audioBitsPerSecond: 160000 };
        if (isVideo) opts.videoBitsPerSecond = px >= 1800000 ? 8000000 : px >= 830000 ? 5000000 : 2500000;
        rec = new MediaRecorder(new MediaStream(tracks), opts);
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        var stopped = new Promise(function (resolve) { rec.onstop = resolve; });
        el.addEventListener('ended', stopRec, { once: true });
        el.addEventListener('error', function () { cancelled = 'error'; stopRec(); }, { once: true });
        ctx.resume().catch(function () {});
        rec.start(1000);
        var played = el.play();
        tick = setInterval(function () {
          if (!document.body.contains(bar)) { cancelled = true; stopRec(); return; } // окно закрыли
          bar.value = Math.min(100, el.currentTime / dur * 100);
          status.textContent = T('Запись: {0} из {1} с', [Math.floor(el.currentTime), Math.ceil(dur)]);
        }, 250);
        guard = setTimeout(stopRec, (dur * 2 + 20) * 1000); // воспроизведение зависло
        return Promise.resolve(played).then(function () { return stopped; }).then(function () {
          var reached = el.currentTime;
          cleanup();
          if (cancelled === 'error') throw new Error(T('Воспроизведение прервалось с ошибкой — браузер не смог дочитать файл.'));
          if (cancelled) return null;
          if (reached < dur - 1) throw new Error(T('Запись прервалась на {0} с из {1}. Попробуйте ещё раз и не сворачивайте браузер.', [Math.floor(reached), Math.ceil(dur)]));
          if (isVideo && !samples) throw new Error(T('Браузер не отдал ни одного кадра — окно было свёрнуто или вкладка в фоне. Попробуйте ещё раз, не переключаясь.'));
          if (isVideo && !sawPicture) throw new Error(T('Получилась чёрная картинка: браузер не показывает видео из этого файла. {0}', [handbrakeTip()]));
          var blob = new Blob(chunks, { type: type.split(';')[0] });
          bar.value = 100;
          status.textContent = T('Сохранение ({0})…', [fmtSize(blob.size)]);
          var base = m.name.replace(/\.[a-z0-9]{2,5}$/i, '');
          return api('PUT', '/api/media', blob, { 'x-file-name': encodeURIComponent(base + (replace.checked ? '' : ' (WebM)') + '.webm'), 'Content-Type': 'application/octet-stream' })
            .then(function (row) {
              return post('/api/media/' + row.id + '/transcoded', { from: m.id, durationMs: Math.round(dur * 1000), replace: replace.checked, confirm: replace.checked })
                .then(function (r) { return { row: row, r: r }; });
            });
        });
      }).then(function (res) {
        running = false;
        if (!res) return;
        closeModal();
        toast(T('Готово: «{0}» перекодирован в WebM{1}. Проверьте кнопкой «▶ В {2}».', [m.name, (res.r.rewards ? T(', наград переключено: {0}', [res.r.rewards]) : ''), appShort()]), 'ok');
        probed = {};
        load();
      }, function (e) { fail(e.message || String(e)); });
    }
  }

  function renderMedia() {
    var root = clear($('page-media'));
    var fileInput = h('input', { type: 'file', multiple: true, accept: '.mp3,.wav,.ogg,.m4a,.webm,.mp4,.gif,.png,.jpg,.jpeg,.webp', style: 'display:none', onchange: function () { uploadFiles(fileInput.files); fileInput.value = ''; } });
    root.appendChild(h('div', { class: 'card-head' }, h('h1', { text: T('Медиа') }),
      h('div', { class: 'row' },
        h('button', { text: T('Проверить все файлы'), onclick: function () {
          probed = {};
          act(post('/api/media/verify')).then(function (r) { toast(T('Проверено: {0}, повреждено: {1}{2}', [r.checked, r.broken, (r.warnings ? T(', с предупреждениями: {0}', [r.warnings]) : '')]), r.broken ? 'bad' : r.warnings ? '' : 'ok'); load(); });
        } }),
        h('button', { text: T('Открыть папку'), onclick: function () { act(post('/api/open-folder', { which: 'media' })); } }),
        h('a', { class: 'btn primary', href: '#find', text: T('🔎 Найти медиа') }))));
    var dz = h('div', { class: 'dropzone', onclick: function () { fileInput.click(); } },
      h('div', { text: T('Перетащите файлы сюда или нажмите для выбора') }),
      h('div', { class: 'small', text: T('MP3, WAV, OGG, M4A, WebM, MP4 (H.264; другие кодеки — кнопкой «Перекодировать»), GIF, PNG, JPG, WebP — до 200 МБ') }));
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
    dz.addEventListener('drop', function (e) { e.preventDefault(); dz.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
    root.appendChild(dz);
    root.appendChild(fileInput);

    if (!S.media.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: T('Файлов пока нет') }))); return; }
    var grid = h('div', { class: 'media-grid' });
    S.media.forEach(function (m) {
      var url = '/media/' + m.id;
      var prev;
      if (m.source === 'klipy') {
        prev = h('div', { class: 'online-ph' }, h('div', { text: T('🌐 Онлайн-медиа Klipy') }), h('div', { class: 'small', text: T('файл не хранится на компьютере') }));
        prev.appendChild(h('button', { class: 'small', text: T('Показать'), onclick: function () {
          act(api('GET', '/api/media/' + m.id + '/online')).then(function (r) {
            var box = prev.parentNode; clear(box);
            box.appendChild(r.kind === 'video' ? h('video', { src: r.url, controls: true, autoplay: true }) : h('img', { src: r.url, alt: '' }));
          });
        } }));
      } else {
        prev = m.kind === 'image' ? h('img', { src: url, alt: '' })
          // «#t=0.1» — чтобы на карточке был виден первый кадр (у WebM без этого превью бывает чёрным до запуска).
          : m.kind === 'video' ? h('video', { src: url + '#t=0.1', controls: true, preload: 'metadata' })
          : h('audio', { src: url, controls: true, preload: 'none' });
      }
      var origin = m.source === 'klipy' ? T('Klipy (онлайн)') : m.source === 'freesound' ? 'Freesound' : m.source === 'url' ? T('по ссылке') : '';
      var st = m.status === 'broken' ? h('span', { class: 'badge bad', text: m.fileProblem ? T('повреждён') : T('не воспроизводится') }) : m.status === 'warning' ? h('span', { class: 'badge warn', text: T('внимание') }) : h('span', { class: 'badge ok', text: 'OK' });
      grid.appendChild(h('div', { class: 'media-card' },
        h('div', { class: 'media-preview' }, prev),
        h('div', { class: 'media-info' },
          h('div', { class: 'media-name', text: m.name }),
          h('div', { class: 'row small muted' }, st, { audio: T('звук'), video: T('видео'), image: T('изображение') }[m.kind], '·', m.source === 'klipy' ? T('онлайн') : fmtSize(m.size), '·', fmtDur(m.duration_ms)),
          origin ? h('div', { class: 'small muted' }, T('Источник: '), m.source_url ? h('a', { href: m.source_url, target: '_blank', rel: 'noopener noreferrer', text: origin }) : origin) : null,
          m.attribution && m.source === 'freesound' ? h('div', { class: 'small muted', text: m.attribution }) : null,
          m.status_msg ? h('div', { class: 'small', style: 'color:' + (m.status === 'broken' ? '#ff9a9e' : '#ffd38a'), text: m.status_msg }) : null,
          h('div', { class: 'small muted', text: m.usedBy.length ? T('Используется: {0}', [m.usedBy.join(', ')]) : T('Не используется') }),
          h('div', { class: 'media-actions' },
            h('button', { class: 'small primary', text: T('▶ В {0}', [appShort()]), onclick: function () { act(post('/api/media/' + m.id + '/test'), T('Отправлено в overlay')); } }),
            // Перекодирование: для видео всегда, для звука — если с ним проблема.
            m.source !== 'klipy' && (m.kind === 'video' || (m.kind === 'audio' && m.status !== 'ok')) && !m.panelCantRead
              ? h('button', { class: 'small' + (m.status !== 'ok' ? ' warn-btn' : ''), text: T('Перекодировать'), title: T('Пересохранить в WebM, который понимают OBS и Streamlabs'), onclick: function () { transcodeMedia(m); } })
              : null,
            h('button', { class: 'small', text: T('Переименовать'), onclick: function () {
              var n = prompt(T('Новое имя файла:'), m.name); if (n) act(post('/api/media/' + m.id + '/rename', { name: n })).then(load);
            } }),
            h('button', { class: 'small danger', text: T('Удалить'), onclick: function () {
              if (m.usedBy.length) {
                if (!confirm(T('Файл «{0}» используется наградами: {1}.\nУдалить его и отвязать от наград? Это нельзя отменить.', [m.name, m.usedBy.join(', ')]))) return;
                act(post('/api/media/' + m.id + '/delete', { confirm: true, force: true }), T('Удалено')).then(load);
              } else {
                if (!confirm(T('Удалить файл «{0}»? Это нельзя отменить.', [m.name]))) return;
                act(post('/api/media/' + m.id + '/delete', { confirm: true }), T('Удалено')).then(load);
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
    if (S.status.auth.status !== 'ok') { toast(T('Сначала войдите в Twitch («Настройки» → «Войти через Twitch»)'), 'bad'); return; }
    var t = prompt(T('Название новой награды (до 45 символов):'), (row.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 45));
    if (!t) return;
    var c = Number(prompt(T('Стоимость в баллах:'), '1000'));
    if (!c) return;
    var cd = Number(prompt(T('Перезарядка в секундах (0 — без перезарядки):'), '60') || 0);
    if (!confirm(T('Создать в Twitch награду «{0}» за {1} баллов? Она сразу станет видна зрителям.', [t, c]))) return;
    act(post('/api/rewards/create', { confirm: true, title: t, cost: c, cooldownSec: cd })).then(function (r) {
      var cfg = row.kind === 'audio' ? { media_id: row.id, play_mode: 'audio', bot_enabled: true } : { video_id: row.id, play_mode: 'video', bot_enabled: true };
      return post('/api/rewards/' + encodeURIComponent(r.id), cfg).then(function () {
        toast(T('Награда «{0}» создана и включена{1}', [r.title, (row.source === 'klipy' ? T('. Совет: в «Наградах» выберите ей «Звук (основной файл)» — он сыграет, если Klipy будет недоступен.') : '')]), 'ok');
        load();
      });
    }).catch(function () { /* ошибка уже показана */ });
  }

  function addedActions(row) {
    return h('div', { class: 'row small' }, h('span', { class: 'badge ok', text: T('в медиатеке') }),
      h('button', { class: 'small', text: T('▶ В {0}', [appShort()]), onclick: function () { act(post('/api/media/' + row.id + '/test'), T('Отправлено в overlay')); } }),
      h('button', { class: 'small primary', text: T('＋ Награда'), title: T('Создать награду в Twitch с этим файлом'), onclick: function () { createRewardWith(row); } }));
  }

  function needKey(name, how) {
    return h('div', { class: 'card' }, h('h2', { text: T('Нужен ключ {0}', [name]) }),
      h('p', null, how),
      h('p', null, T('Затем вставьте его в '), h('a', { href: '#settings', text: T('«Настройки» → «Поиск медиа»') }), T('. Ключ бесплатный; бот хранит его только на этом компьютере.')));
  }

  function renderFind() {
    var root = clear($('page-find'));
    root.appendChild(h('h1', { text: T('Найти медиа') }));
    var tab = function (id, text) { return h('button', { class: F.tab === id ? 'active' : '', text: text, onclick: function () { F.tab = id; renderFind(); } }); };
    root.appendChild(h('div', { class: 'tabs' }, tab('klipy', T('Klipy — мемы и клипы')), tab('freesound', T('Freesound — звуки')), tab('url', T('По ссылке'))));
    if (F.tab === 'klipy') renderKlipy(root);
    else if (F.tab === 'freesound') renderFreesound(root);
    else renderUrlImport(root);
  }

  function renderKlipy(root) {
    if (!S.find || !S.find.klipy) {
      root.appendChild(needKey('Klipy', h('span', null, T('Зарегистрируйтесь на '), h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), T(', откройте «API Keys» и создайте ключ.'))));
      return;
    }
    root.appendChild(h('div', { class: 'infobox', style: 'margin-bottom:12px' },
      T('Мемы Klipy не скачиваются на компьютер — так требуют правила Klipy. Они показываются на стриме прямо с сервера Klipy, поэтому нужен интернет. '),
      h('b', { text: T('Если Klipy будет недоступен, сыграет запасной звук награды') }), T(' («Звук (основной файл)» в карточке награды).')));
    var input = h('input', { type: 'search', placeholder: 'Search KLIPY', value: F.kq, oninput: function () { F.kq = input.value; } });
    var search = function (page) {
      F.kloading = true; F.kpage = page; renderFind();
      api('GET', '/api/find/klipy?' + qs({ type: F.ktype, q: F.kq, page: page })).then(function (r) {
        F.kres = page > 1 && F.kres ? F.kres.concat(r.results) : r.results; F.knext = r.hasNext;
      }, function (e) { toast(e.message, 'bad'); }).then(function () { F.kloading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    var types = h('div', { class: 'tabs', style: 'margin:0' }, KTYPES.map(function (t) {
      return h('button', { class: 'small' + (F.ktype === t[0] ? ' active' : ''), text: T(t[1]), onclick: function () { F.ktype = t[0]; F.kres = null; search(1); } });
    }));
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.kloading ? T('Поиск…') : T('Найти'), disabled: F.kloading, onclick: function () { search(1); } })),
      h('div', { style: 'margin-top:10px' }, types),
      h('div', { class: 'small muted', style: 'margin-top:8px', text: T('Пустой запрос — популярное сейчас. Тестовый ключ Klipy: 100 запросов в час (каждый поиск и каждый показ мема на стриме).') })));
    if (F.kres === null) return;
    if (!F.kres.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: T('Ничего не найдено. Попробуйте другое слово (лучше на английском).') }))); return; }
    var grid = h('div', { class: 'find-grid' });
    F.kres.forEach(function (it) {
      var prev = h('div', { class: 'media-preview', title: it.play.kind === 'video' ? T('Нажмите, чтобы посмотреть со звуком') : '' },
        h('img', { src: it.thumb, alt: '', loading: 'lazy' }), it.play.kind === 'video' ? h('span', { class: 'play-hint', text: T('▶ со звуком') }) : null);
      if (it.play.kind === 'video') prev.addEventListener('click', function () {
        if (prev.querySelector('video')) return;
        clear(prev).appendChild(h('video', { src: it.play.url, controls: true, autoplay: true, playsinline: true }));
      });
      var actions = h('div', { class: 'media-actions' });
      var existing = S.media.find(function (m) { return m.source === 'klipy' && m.remote_ref === it.type + '/' + it.slug; });
      if (existing) actions.appendChild(addedActions(existing));
      else actions.appendChild(h('button', { class: 'small primary', text: T('＋ В медиатеку'), onclick: function (ev) {
        var btn = ev.currentTarget; btn.disabled = true;
        act(post('/api/find/klipy/add', { type: it.type, slug: it.slug }), T('Добавлено в медиатеку (онлайн)')).then(function (row) {
          S.media.unshift(Object.assign({ usedBy: [] }, row)); clear(actions).appendChild(addedActions(row));
        }, function () { btn.disabled = false; });
      } }));
      grid.appendChild(h('div', { class: 'media-card' }, prev,
        h('div', { class: 'media-info' }, h('div', { class: 'media-name', text: it.title }),
          h('div', { class: 'small muted' }, it.play.kind === 'video' ? T('видео со звуком') : T('анимация без звука'), it.play.width ? ' · ' + it.play.width + '×' + it.play.height : ''),
          actions)));
    });
    root.appendChild(grid);
    if (F.knext) root.appendChild(h('div', { class: 'row', style: 'margin-top:12px;justify-content:center' }, h('button', { text: F.kloading ? T('Загрузка…') : T('Показать ещё'), disabled: F.kloading, onclick: function () { search(F.kpage + 1); } })));
    root.appendChild(h('div', { class: 'powered', text: 'Powered by KLIPY' }));
  }

  function renderFreesound(root) {
    if (!S.find || !S.find.freesound) {
      root.appendChild(needKey('Freesound', h('span', null, T('Зарегистрируйтесь на '), h('a', { href: 'https://freesound.org', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org' }), T(', затем откройте '), h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), T(' и создайте ключ. Нужна строка «Client secret / Api key».'))));
      return;
    }
    root.appendChild(h('div', { class: 'infobox', style: 'margin-bottom:12px' },
      T('Звуки Freesound скачиваются в медиатеку (MP3) и играют без интернета. Автор и лицензия сохраняются у файла. '),
      T('Лицензия CC BY требует указывать автора — например, в описании канала или панели под стримом.')));
    var input = h('input', { type: 'search', placeholder: T('Например: applause, fail, laugh, bruh'), value: F.fq, oninput: function () { F.fq = input.value; } });
    var search = function (page) {
      if (!F.fq.trim()) { toast(T('Введите, что искать'), 'bad'); return; }
      F.floading = true; F.fpage = page; renderFind();
      api('GET', '/api/find/freesound?' + qs({ q: F.fq, page: page, commercial: F.fcommercial ? 1 : 0 })).then(function (r) {
        F.fres = page > 1 && F.fres ? F.fres.concat(r.results) : r.results; F.fnext = r.hasNext; F.ftotal = r.total;
      }, function (e) { toast(e.message, 'bad'); }).then(function () { F.floading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(1); });
    var commercial = h('input', { type: 'checkbox', checked: F.fcommercial, onchange: function () { F.fcommercial = commercial.checked; } });
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.floading ? T('Поиск…') : T('Найти'), disabled: F.floading, onclick: function () { search(1); } })),
      h('label', { class: 'check', style: 'margin:10px 0 0' }, commercial, T('Только звуки, которые можно использовать на стриме с монетизацией (CC0 и CC BY)')),
      h('div', { class: 'small muted', text: T('Показываются звуки до 60 секунд. Лучше искать на английском.') })));
    if (F.fres === null) return;
    if (!F.fres.length) { root.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty', text: T('Ничего не найдено.') }))); return; }
    var list = h('div', { class: 'list' });
    F.fres.forEach(function (it) {
      var actions = h('div', { class: 'row' });
      var existing = S.media.find(function (m) { return m.source === 'freesound' && m.source_url === it.pageUrl; });
      if (existing) actions.appendChild(addedActions(existing));
      else actions.appendChild(h('button', { class: 'small primary', text: T('＋ В медиатеку'), onclick: function (ev) {
        var btn = ev.currentTarget; btn.disabled = true; btn.textContent = T('Скачивание…');
        act(post('/api/find/freesound/add', { id: it.id }), T('Звук скачан в медиатеку')).then(function (row) {
          S.media.unshift(Object.assign({ usedBy: [] }, row)); clear(actions).appendChild(addedActions(row));
        }, function () { btn.disabled = false; btn.textContent = T('＋ В медиатеку'); });
      } }));
      list.appendChild(h('div', { class: 'sound-row' },
        h('div', null,
          h('div', { class: 'media-name', text: it.name }),
          h('div', { class: 'small muted' }, T('Автор: '), it.username, ' · ', fmtDur(it.durationSec * 1000), ' · ',
            h('a', { href: it.pageUrl, target: '_blank', rel: 'noopener noreferrer', text: T('страница звука') })),
          h('span', { class: 'badge ' + (it.commercialOk ? 'ok' : 'warn'), text: it.licenseLabel })),
        h('audio', { src: it.previewUrl, controls: true, preload: 'none' }),
        actions));
    });
    root.appendChild(h('div', { class: 'card', style: 'margin-top:12px' }, h('div', { class: 'small muted', style: 'margin-bottom:8px', text: T('Найдено: {0}', [F.ftotal]) }), list,
      F.fnext ? h('div', { class: 'row', style: 'margin-top:12px;justify-content:center' }, h('button', { text: F.floading ? T('Загрузка…') : T('Показать ещё'), disabled: F.floading, onclick: function () { search(F.fpage + 1); } })) : null,
      h('div', { class: 'powered', text: T('Звуки: Freesound.org') })));
  }

  function renderUrlImport(root) {
    var input = h('input', { type: 'url', placeholder: 'https://example.com/sound.mp3', value: F.url, oninput: function () { F.url = input.value; } });
    var go = function () {
      if (!F.url.trim()) { toast(T('Вставьте ссылку на файл'), 'bad'); return; }
      F.urlLoading = true; renderFind();
      act(post('/api/find/url', { url: F.url.trim() }), T('Файл скачан в медиатеку')).then(function (row) {
        F.url = ''; F.lastUrlRow = row; S.media.unshift(Object.assign({ usedBy: [] }, row));
      }, function () { /* ошибка уже показана */ }).then(function () { F.urlLoading = false; renderFind(); });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    root.appendChild(h('div', { class: 'card' },
      h('h2', { text: T('Скачать файл по прямой ссылке') }),
      h('div', { class: 'find-bar' }, input, h('button', { class: 'primary', text: F.urlLoading ? T('Скачивание…') : T('Скачать'), disabled: F.urlLoading, onclick: go })),
      h('p', { class: 'small muted' }, T('Нужна прямая ссылка на сам файл: MP3, WAV, OGG, M4A, MP4 (H.264), WebM, GIF, PNG, JPG или WebP, до 200 МБ. '),
        T('Ссылки на страницы YouTube, TikTok и т. п. не подойдут. Используйте только файлы, которые вам разрешено показывать на стриме.')),
      F.lastUrlRow ? h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { text: T('Добавлено: {0}', [F.lastUrlRow.name]) }), addedActions(F.lastUrlRow)) : null));
  }

  // ---------------- Поддержать автора и обновления ----------------
  function extLink(href, text, cls) {
    return h('a', { class: cls || 'btn', href: href, target: '_blank', rel: 'noopener noreferrer', text: text });
  }

  function changesList(entries) {
    return h('div', { class: 'changes' }, entries.map(function (e) {
      return h('div', { class: 'change-ver' },
        h('div', { class: 'change-head' }, h('b', { text: T('Версия {0}', [e.version]) }), e.date ? h('span', { class: 'muted small', text: ' · ' + new Date(e.date).toLocaleDateString(I18N.locale()) }) : null),
        h('ul', null, e.changes.map(function (c) { return h('li', { text: c }); })));
    }));
  }

  // Модальное окно (одно на странице).
  function modal(title, body, buttons) {
    closeModal();
    var box = h('div', { class: 'modal-back', id: 'modal' },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h2', { text: title }), body, h('div', { class: 'row modal-actions' }, buttons)));
    box.addEventListener('click', function (e) { if (e.target === box && !updateBusy()) closeModal(); });
    document.body.appendChild(box);
  }
  function closeModal() { var m = $('modal'); if (m) m.remove(); }
  function updateBusy() { var u = S && S.update; return !!u && ['download', 'unpack', 'copy', 'deps', 'launcher', 'restart'].indexOf(u.step) >= 0; }

  var whatsNewShown = false;
  var updateWanted = false; // пользователь нажал «Обновить» — показываем ход установки
  function dismissedVersion() { try { return localStorage.getItem('tab-update-dismissed') || ''; } catch (e) { return ''; } }
  function dismissVersion(v) { try { localStorage.setItem('tab-update-dismissed', v); } catch (e) { /* */ } }

  /** Окно «Что нового» после обновления и полоса «Доступна новая версия». */
  function renderUpdateUi() {
    var u = S && S.update;
    if (!u) return;
    var bar = $('update-bar');
    if (u.available && !updateBusy()) {
      bar.hidden = false;
      clear(bar).appendChild(h('div', { class: 'row' },
        h('span', { class: 'grow' }, T('🎉 Доступна новая версия бота '), h('b', { text: u.latest }), T(' (у вас {0})', [u.current])),
        h('button', { class: 'small primary', text: T('Что нового и обновить'), onclick: showUpdateModal })));
      if (!$('modal') && !whatsNewShown && dismissedVersion() !== u.latest) { dismissVersion(u.latest); showUpdateModal(); }
    } else bar.hidden = true;

    if (updateWanted || updateBusy()) { showProgressModal(); return; }
    if (u.whatsNew && u.whatsNew.length && !whatsNewShown && !$('modal')) {
      whatsNewShown = true;
      modal(T('Бот обновлён до версии {0}', [u.current]), h('div', null, h('p', { class: 'muted', text: T('Что нового:') }), changesList(u.whatsNew)),
        [h('button', { class: 'primary', text: T('Понятно'), onclick: function () { closeModal(); post('/api/update/seen').then(load, function () {}); } })]);
    }
  }

  function showUpdateModal() {
    var u = S.update;
    var body = h('div', null,
      h('p', null, T('Установлена версия '), h('b', { text: u.current }), T(', доступна '), h('b', { text: u.latest }), '.'),
      changesList(u.notes || []),
      u.canInstall ? h('p', { class: 'small muted', text: T('Бот скачает новую версию с GitHub, установит её и перезапустится (около минуты). Настройки, награды, медиафайлы и вход в Twitch сохранятся. Во время эфира лучше обновлять в перерыве: на время перезапуска оповещения не играют.') })
        : h('div', { class: 'warnbox', text: u.reason || T('Обновление сейчас недоступно.') }));
    var btns = [];
    if (u.canInstall) btns.push(h('button', { class: 'primary', text: T('Обновить сейчас'), onclick: function () {
      updateWanted = true;
      act(post('/api/update/install', { confirm: true })).then(function () { showProgressModal(); }, function () { updateWanted = false; });
    } }));
    btns.push(h('button', { text: T('Позже'), onclick: closeModal }));
    modal(T('Доступно обновление'), body, btns);
  }

  function showProgressModal() {
    var u = S.update;
    if (u.step === 'error') {
      updateWanted = false;
      modal(T('Обновление не установлено'), h('div', null, h('div', { class: 'warnbox', text: u.error || T('Неизвестная ошибка') }),
        h('p', { class: 'small muted', text: T('Бот продолжает работать на прежней версии. Подробности — в «Журнале».') })),
        [h('button', { text: T('Закрыть'), onclick: closeModal })]);
      return;
    }
    var text = u.stepText || T('Подготовка…');
    if (u.step === 'restart') text = T('Обновление установлено. Бот перезапускается — панель обновится сама через несколько секунд…');
    modal(T('Обновление до версии {0}', [(u.latest || '')]), h('div', null, h('div', { class: 'progress-line' }, h('span', { class: 'spinner' }), h('span', { text: text }))), []);
  }

  function renderSupport() {
    var root = clear($('page-support'));
    var L = S.links || {};
    var u = S.update || {};
    root.appendChild(h('h1', { text: T('Поддержать автора') }));
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card support-card' },
        h('h2', { text: T('❤ Поддержать на Boosty') }),
        h('p', { text: T('Бот бесплатный и работает без подписок. Если он вам пригодился — поддержите разработку: это помогает добавлять новые функции и быстрее исправлять ошибки.') }),
        extLink(L.boosty, T('❤ Задонатить на Boosty'), 'btn primary')),
      h('div', { class: 'card' },
        h('h2', { text: T('💡 Новые предложения') }),
        h('p', { text: T('Не хватает какой-то функции или нашли ошибку? Напишите — лучшие идеи попадут в следующие версии.') }),
        h('div', { class: 'row' },
          extLink(L.ideas, T('Предложить на GitHub')),
          extLink(L.boostyProfile, T('Написать на Boosty'))),
        h('p', { class: 'small muted', style: 'margin-top:8px', text: T('GitHub: нужен бесплатный аккаунт, предложение увидят и другие пользователи. Boosty: личное сообщение автору.') }))));

    var status = u.checking ? T('Проверка…')
      : u.available ? T('Доступна версия {0}', [u.latest])
      : u.error ? T('Не удалось проверить: {0}', [u.error])
      : u.lastCheckAt ? T('У вас последняя версия') : T('Ещё не проверялось');
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: T('Обновления') }),
        h('div', { class: 'row' },
          u.available ? h('button', { class: 'primary small', text: T('Обновить до {0}', [u.latest]), onclick: showUpdateModal }) : null,
          h('button', { class: 'small', text: u.checking ? T('Проверка…') : T('Проверить обновления'), disabled: u.checking, onclick: function () {
            act(post('/api/update/check')).then(function (r) { S.update = r; renderSupport(); renderUpdateUi(); toast(r.available ? T('Доступна версия {0}', [r.latest]) : r.error ? r.error : T('У вас последняя версия'), r.error ? 'bad' : 'ok'); });
          } }))),
      h('p', null, T('Установлена версия '), h('b', { text: u.current || S.status.version }), ' · ', h('span', { class: 'muted', text: status + (u.lastCheckAt ? ' (' + fmtTime(u.lastCheckAt) + ')' : '') })),
      settingField(T('Проверять обновления автоматически (раз в 6 часов)'), 'autoUpdateCheck', { type: 'check' }),
      u.reason ? h('p', { class: 'small muted', text: u.reason }) : null,
      h('h3', { text: T('История изменений') }),
      changesList(S.changelog || []),
      h('p', { class: 'small muted' }, T('Исходный код: '), extLink(L.repo, 'GitHub', 'plain'))));
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
      toast(r.note || T('Сохранено'), 'ok');
      renderSide();
    }, function () { load(); });
  }

  function renderAuthBox() {
    var box = $('auth-box');
    if (!box) return;
    clear(box);
    var a = S.status.auth;
    if (a.status === 'ok') {
      box.appendChild(h('p', null, h('span', { class: 'badge ok', text: T('Подключено') }), T(' Аккаунт: '), h('b', { text: a.login })));
      box.appendChild(h('p', { class: 'small muted', text: T('Права: {0}. Токен обновляется автоматически.', [a.scopes.join(', ')]) }));
      box.appendChild(h('div', { class: 'row' },
        h('button', { text: T('Войти заново'), onclick: function () { act(post('/api/auth/login')); } }),
        h('button', { class: 'danger', text: T('Выйти'), onclick: function () { if (confirm(T('Выйти из Twitch? Бот перестанет получать события наград.'))) act(post('/api/auth/logout'), T('Вы вышли из Twitch')); } })));
    } else if (a.status === 'pending') {
      box.appendChild(h('p', { text: T('1. Откройте страницу Twitch (кнопка ниже). 2. Проверьте, что код совпадает. 3. Нажмите «Разрешить».') }));
      box.appendChild(h('div', { class: 'code-box', text: a.userCode }));
      box.appendChild(h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: a.verificationUri, target: '_blank', rel: 'noopener noreferrer', text: T('Открыть twitch.tv/activate') }),
        h('button', { text: T('Отмена'), onclick: function () { act(post('/api/auth/cancel')).then(load); } })));
      box.appendChild(h('p', { class: 'small muted', style: 'margin-top:8px', text: T('Ожидание подтверждения… Код действует до {0}. Пароль Twitch бот не видит и не запрашивает.', [fmtTime(a.expiresAt)]) }));
    } else {
      box.appendChild(h('p', null, h('span', { class: 'badge bad', text: T('Не подключено') }), ' ', a.message));
      box.appendChild(h('button', { class: 'primary', text: T('Войти через Twitch'), disabled: !S.settings.clientId, onclick: function () { act(post('/api/auth/login')).then(load); } }));
    }
  }

  // Client ID скрыт, чтобы случайно не показать его на стриме; «Показать» открывает его на 30 секунд.
  var clientIdShown = false;
  var clientIdTimer = 0;
  function rerenderClientId() {
    var box = $('clientid-box');
    if (box) { clear(box); box.appendChild(clientIdField()); }
  }
  function clientIdField() {
    var id = S.settings.clientId || '';
    var label = h('label', { text: T('Client ID приложения Twitch') });
    var hint = h('span', { class: 'hint', text: T('Создайте приложение на dev.twitch.tv/console (тип клиента — «Общедоступный / Public»). Подробно — в разделе «Помощь».{0}', [(id ? T(' Client ID скрыт, чтобы случайно не показать его на стриме.') : '')]) });
    if (id && !clientIdShown) {
      return h('div', { class: 'field' }, label,
        h('div', { class: 'copy-field' },
          h('input', { type: 'text', value: '•'.repeat(Math.min(id.length, 30)), readonly: true, 'aria-label': T('Client ID скрыт') }),
          h('button', { text: T('Показать'), onclick: function () {
            clientIdShown = true;
            rerenderClientId();
            clearTimeout(clientIdTimer);
            clientIdTimer = setTimeout(function hideLater() {
              var inp = $('clientid-input');
              if (inp && document.activeElement === inp) { clientIdTimer = setTimeout(hideLater, 5000); return; }
              clientIdShown = false;
              rerenderClientId();
            }, 30000);
          } })),
        hint);
    }
    var inp = h('input', { id: 'clientid-input', type: 'text', value: id, autocomplete: 'off', spellcheck: 'false', placeholder: T('вставьте Client ID') });
    inp.addEventListener('change', function () {
      saveSetting('clientId', inp.value.trim()).then(function () {
        clientIdShown = false;
        clearTimeout(clientIdTimer);
        rerenderClientId();
        renderAuthBox();
      });
    });
    return h('div', { class: 'field' }, label,
      h('div', { class: 'copy-field' }, inp, id ? h('button', { text: T('Скрыть'), onclick: function () {
        clientIdShown = false;
        clearTimeout(clientIdTimer);
        rerenderClientId();
      } }) : null),
      hint);
  }

  function renderSettings() {
    var root = clear($('page-settings'));
    clientIdShown = false;
    clearTimeout(clientIdTimer);
    root.appendChild(h('h1', { text: T('Настройки') }));
    var langSel = h('select', { 'aria-label': 'Language / Язык' }, I18N.languages.map(function (l) { return h('option', { value: l.id, text: l.name, selected: I18N.lang() === l.id }); }));
    langSel.addEventListener('change', function () { setLanguage(langSel.value); });
    root.appendChild(h('div', { class: 'card lang-card' },
      h('div', { class: 'field', style: 'margin:0' }, h('label', { text: 'Язык / Language' }), langSel,
        h('span', { class: 'hint', text: T('Язык панели, сообщений бота, служебного текста overlay и меню в трее. Применяется сразу, без перезапуска.') }))));

    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: 'Twitch' }),
        h('div', { id: 'clientid-box' }, clientIdField()),
        settingField(T('Разрешить боту управлять наградами'), 'allowManageRewards', { type: 'check', hint: T('Нужно для создания копий наград и возврата баллов при сбое. Без этого бот только читает события.') }),
        h('div', { id: 'auth-box' })),
      h('div', { class: 'card' }, h('h2', { text: 'Overlay' }),
        S.overlayLoader ? h('div', { class: 'field' }, h('label', { text: T('Файл для источника — рекомендуется') }),
          copyField(S.overlayLoader, T('Путь скопирован'), h('button', { text: T('Папка'), onclick: function () { act(post('/api/open-folder', { which: 'data' })); } })),
          h('div', { class: 'hint', text: T('В свойствах источника «Браузер» поставьте галочку «Локальный файл» и выберите этот файл. Тогда неважно, что запущено раньше — {0} или бот: источник дождётся бота и подключится сам.', [appShort()]) })) : null,
        h('div', { class: 'field' }, h('label', { text: S.overlayLoader ? T('Или адрес (URL) — тогда запускайте бота раньше {0}', [appShort()]) : T('Адрес для Browser Source (OBS Studio или Streamlabs Desktop)') }),
          copyField(S.overlayUrl, T('Адрес скопирован'), h('a', { class: 'btn', href: '/overlay', target: '_blank', text: T('Открыть') }))),
        h('div', { class: 'form-grid' },
          settingField(T('Общая громкость, %'), 'masterVolume', { type: 'number', min: 0, max: 100 }),
          settingField(T('Положение'), 'overlayPosition', { type: 'select', options: [['center', T('По центру')], ['top', T('Сверху')], ['bottom', T('Снизу')], ['left', T('Слева')], ['right', T('Справа')], ['top-left', T('Сверху слева')], ['top-right', T('Сверху справа')], ['bottom-left', T('Снизу слева')], ['bottom-right', T('Снизу справа')]] }),
          settingField(T('Макс. ширина, % экрана'), 'overlayMaxWidthPct', { type: 'number', min: 5, max: 100 }),
          settingField(T('Макс. высота, % экрана'), 'overlayMaxHeightPct', { type: 'number', min: 5, max: 100 })),
        settingField(T('Показывать подпись'), 'showCaption', { type: 'check' }),
        settingField(T('Шаблон подписи'), 'captionTemplate', { hint: T('{user} — зритель, {reward} — награда, {input} — текст зрителя, {cost} — стоимость') }))));

    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: T('Очередь и защита от спама') }),
        h('div', { class: 'form-grid' },
          settingField(T('Задержка перед показом, с'), 'delayBeforeMs', { type: 'number', scale: 1000, min: 0, step: 0.1 }),
          settingField(T('Пауза между оповещениями, с'), 'gapBetweenMs', { type: 'number', scale: 1000, min: 0, step: 0.1 }),
          settingField(T('Максимальная длина очереди'), 'maxQueueLength', { type: 'number', min: 1, max: 500 }),
          settingField(T('Не проигрывать старше, с'), 'maxItemAgeSec', { type: 'number', min: 10, hint: T('Слишком старые оповещения отбрасываются') }),
          settingField(T('Антиспам: один зритель не чаще, с'), 'userCooldownSec', { type: 'number', min: 0, hint: T('0 — без ограничения') }),
          settingField(T('Длительность картинки/GIF, с'), 'defaultImageDurationMs', { type: 'number', scale: 1000, min: 0.5, step: 0.5 }),
          settingField(T('Максимальная длительность, с'), 'maxDurationMs', { type: 'number', scale: 1000, min: 1, max: 3600, hint: T('Видео и звук длиннее обрываются на этом месте (до 3600 с = 1 час)') }))),
      h('div', { class: 'card' }, h('h2', { text: T('Поведение') }),
        settingField(T('Только звук для всех наград (видео выключено)'), 'audioOnly', { type: 'check', hint: T('Быстрый общий выключатель видео, например для игровых сцен. Настройки наград при этом не меняются.') }),
        settingField(T('Режим работы'), 'mode', { type: 'select', options: [['active', T('Активный — воспроизводить оповещения')], ['observe', T('Наблюдение — только записывать (для параллельной работы с Sound Alerts)')]] }),
        settingField(T('Восстанавливать пропущенные события после обрыва связи'), 'recoverMissed', { type: 'check', hint: T('Работает только для наград, созданных этим ботом (ограничение Twitch).') }),
        settingField(T('Отмечать выполненными и возвращать баллы при сбое'), 'manageRedemptionStatus', { type: 'check', hint: T('Только для наград, созданных ботом и не пропускающих очередь запросов.') }),
        settingField(T('Хранить историю, дней'), 'historyRetentionDays', { type: 'number', min: 1 }))));

    var keyField = function (label, key, hint) {
      var inp = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: S.settings[key] ? T('сохранён ({0}) — вставьте новый, чтобы заменить', [S.settings[key]]) : T('вставьте ключ') });
      inp.addEventListener('change', function () { if (inp.value.trim()) saveSetting(key, inp.value.trim()).then(load); });
      return h('div', { class: 'field' }, h('label', { text: label }),
        h('div', { class: 'copy-field' }, inp, S.settings[key] ? h('button', { class: 'danger', text: T('Удалить'), onclick: function () {
          if (confirm(T('Удалить ключ «{0}»? Поиск в этом сервисе перестанет работать.', [label]))) saveSetting(key, '').then(load);
        } }) : null),
        h('span', { class: 'hint' }, hint));
    };
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: T('Поиск медиа') }),
        keyField(T('Ключ Klipy (мемы, клипы, GIF)'), 'klipyApiKey', h('span', null, T('Бесплатно: '), h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), ' → API Keys.')),
        keyField(T('Ключ Freesound (звуки)'), 'freesoundApiKey', h('span', null, T('Бесплатно: '), h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), T(' → строка «Client secret / Api key».'))),
        settingField(T('Фильтр контента Klipy'), 'klipyContentFilter', { type: 'select', options: [['high', T('Строгий')], ['medium', T('Средний (рекомендуется для Twitch)')], ['low', T('Мягкий')], ['off', T('Выключен')]] }),
        h('p', { class: 'small muted', text: T('Ключи хранятся только на этом компьютере, в журнал не записываются и в панели показываются не полностью.') })),
      h('div', { class: 'card' }, h('h2', { text: T('Как это работает') }),
        h('ul', { class: 'small' },
          h('li', { text: T('Klipy: мемы не скачиваются (правила Klipy) — во время стрима OBS или Streamlabs загружает их с сервера Klipy. Назначьте награде запасной звук на случай сбоя.') }),
          h('li', { text: T('Freesound: звуки скачиваются в медиатеку и работают без интернета. Автор и лицензия сохраняются.') }),
          h('li', { text: T('По ссылке: прямой адрес файла скачивается в медиатеку. Ссылки на этот компьютер и локальную сеть запрещены.') })))));

    var autostart = h('input', { type: 'checkbox', checked: !!S.autostart, onchange: function () {
      act(post('/api/autostart', { enabled: autostart.checked }), autostart.checked ? T('Автозапуск включён') : T('Автозапуск выключен')).then(null, function () { autostart.checked = !autostart.checked; });
    } });
    var appSel = h('select', null, ['obs', 'streamlabs'].map(function (k) { return h('option', { value: k, text: APPS[k].name, selected: streamApp() === k }); }));
    appSel.addEventListener('change', function () { saveSetting('streamApp', appSel.value).then(function () { renderSettings(); }); });
    var isSl = streamApp() === 'streamlabs';
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: T('Программа для стрима') }),
        streamlabsDetected(S.status) ? switchToStreamlabsBox() : null,
        h('div', { class: 'field' }, h('label', { text: T('Где идёт стрим') }), appSel,
          h('span', { class: 'hint', text: T('Overlay работает в обеих программах одинаково. Выбор влияет на кнопку запуска, резервную копию сцен и подсказки.') })),
        isSl ? settingField(T('Путь к Streamlabs Desktop («Streamlabs OBS.exe»)'), 'streamlabsExePath', { hint: T('Оставьте пустым — бот сам найдёт программу в Program Files.') })
          : settingField(T('Путь к OBS (obs64.exe)'), 'obsExePath'),
        isSl ? settingField(T('Папка настроек Streamlabs (slobs-client)'), 'streamlabsConfigDir')
          : settingField(T('Папка настроек OBS'), 'obsConfigDir'),
        settingField(T('Запускать {0} при автозапуске бота', [appShort()]), 'launchObsWithBot', { type: 'check' }),
        h('div', { class: 'row' },
          h('button', { text: T('Резервная копия сцен {0}', [appShort()]), onclick: function () { act(post('/api/obs/backup')).then(function (r) { toast(T('Копия сохранена: {0}', [r.dir]), 'ok'); }); } }),
          h('button', { text: T('Запустить {0}', [appShort()]), onclick: function () { act(post('/api/obs/launch')).then(function (r) { toast(r.already ? T('{0} уже запущен', [appName()]) : T('{0} запускается', [appName()]), 'ok'); }); } }),
          h('button', { text: T('Папка копий'), onclick: function () { act(post('/api/open-folder', { which: 'backups' })); } }))),
      h('div', { class: 'card' }, h('h2', { text: T('Система') }),
        h('label', { class: 'check' }, autostart, T('Запускать бота вместе с Windows')),
        settingField(T('Локальный порт'), 'port', { type: 'number', min: 1024, max: 65535, hint: T('Изменение вступит в силу после перезапуска. Сервер доступен только с этого компьютера (127.0.0.1).') }),
        h('div', { class: 'row' },
          h('button', { text: T('Папка логов'), onclick: function () { act(post('/api/open-folder', { which: 'logs' })); } }),
          h('button', { text: T('Папка данных'), onclick: function () { act(post('/api/open-folder', { which: 'data' })); } }),
          h('button', { class: 'danger', text: T('Остановить бота'), onclick: function () { if (confirm(T('Остановить бота? Оповещения перестанут работать до следующего запуска.'))) act(post('/api/shutdown'), T('Бот останавливается')); } })),
        h('p', { class: 'small muted', style: 'margin-top:10px', text: T('Версия {0} · работает {1} мин', [S.status.version, Math.round(S.status.uptimeSec / 60)]) }))));
    renderAuthBox();
  }

  // ---------------- Журнал ----------------
  var logTab = 'events';
  // ---------------- Статистика ----------------
  var ST = null;          // ответ /api/stats
  var statsTimer = 0;
  var OVERLAY_FIELDS = [
    ['session', 'Время эфира'], ['viewers', 'Зрители'], ['chatters', 'В чате'], ['followers', 'Фолловеры'], ['followersSession', 'Новые фолловеры за стрим'],
    ['subs', 'Подписчики'], ['subPoints', 'Баллы подписок'], ['bitrate', 'Битрейт'], ['resolution', 'Разрешение и FPS'], ['dropped', 'Потери кадров'], ['health', 'Состояние трансляции'],
  ];

  function fileUrl(p) { return p ? 'file:///' + encodeURI(p.replace(/\\/g, '/')) : ''; }

  function loadStats() {
    return api('GET', '/api/stats').then(function (r) { ST = r; if (page === 'stats') renderStatsStatus(); }, function () { /* нет связи — баннер покажет */ });
  }

  /** Состояние подключений (обновляется раз в 4 с, пока страница открыта). */
  function obsStateView() {
    var o = ST.stats.obs;
    var su = ST.setup.obs;
    if (ST.setup.streamApp !== 'obs') return { cls: 'warn', text: T('Только OBS Studio'), detail: T('Время, зрители, чат, фолловеры и подписчики работают и со Streamlabs, а битрейт, разрешение и потери кадров бот берёт из OBS Studio.') };
    if (o.state === 'ok') return { cls: 'ok', text: T('Подключено'), detail: o.streaming ? T('Идёт трансляция') : T('OBS подключён, трансляция не идёт') };
    if (o.state === 'off') return { cls: 'warn', text: T('Ждёт'), detail: T('Подключение начнётся, когда открыта док-панель, overlay статистики или эта страница.') };
    if (o.state === 'disabled' || (su.fileFound && su.enabled === false)) return { cls: 'bad', text: T('Сервер WebSocket выключен'), detail: T('Включите его в OBS (шаги ниже).') };
    if (o.state === 'auth_failed') return { cls: 'bad', text: T('Неверный пароль'), detail: T('Скопируйте пароль из OBS и вставьте ниже.') };
    return { cls: 'warn', text: T('Нет связи с OBS'), detail: T('OBS не запущен или сервер WebSocket недоступен (порт {0}).', [su.port]) };
  }

  /** Пароль OBS WebSocket: поле всегда пустое (сохранённый пароль в панель не приходит). */
  function obsPasswordField(su) {
    var inp = h('input', { type: 'password', autocomplete: 'off', placeholder: su.obs.passwordSet ? T('сохранён') : su.obs.fileFound ? T('берётся из настроек OBS') : '' });
    inp.addEventListener('change', function () { if (inp.value) saveSetting('obsWsPassword', inp.value).then(function () { inp.value = ''; loadStats(); }); });
    return h('div', { class: 'field' }, h('label', { text: T('Пароль WebSocket (если бот не нашёл сам)') }), inp,
      su.obs.passwordSet ? h('button', { class: 'small', style: 'margin-top:4px', text: T('Брать пароль из OBS'), onclick: function () { saveSetting('obsWsPassword', '').then(function () { loadStats().then(renderStats); }); } }) : null);
  }

  function renderStatsStatus() {
    var box = $('stats-status');
    if (!box || !ST) return;
    clear(box);
    var a = S.status.auth;
    var miss = ST.stats.missingScopes || [];
    var tw = a.status !== 'ok' ? { cls: 'bad', text: T('Не подключено'), detail: T('Войдите в Twitch в «Настройках».') }
      : miss.length ? { cls: 'warn', text: T('Не все права'), detail: T('Нет прав: {0}. Нажмите «Войти заново» — Twitch спросит разрешение на статистику.', [miss.join(', ')]) }
        : { cls: 'ok', text: T('Подключено'), detail: T('Зрители, чат, фолловеры, подписчики') };
    box.appendChild(h('div', { class: 'grid cols-2' },
      statCard('OBS WebSocket', obsStateView()),
      statCard('Twitch', tw, a.status === 'ok' && miss.length ? [h('button', { class: 'small primary', text: T('Войти заново'), onclick: function () { act(post('/api/auth/login')).then(function () { location.hash = '#settings'; }); } })] : null)));
  }

  // История стримов (итоги каждого эфира, 1.6.0).
  function fmtLen(ms) {
    if (!ms || ms < 0) return '—';
    var m = Math.round(ms / 60000);
    return Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
  }

  function namesRow(label, names, total) {
    if (!names || !names.length) return null;
    return h('div', { class: 'small' }, h('b', { text: label + ': ' }),
      names.join(', ') + (total > names.length ? ' ' + T('и ещё {0}', [total - names.length]) : ''));
  }

  function renderHistory(box) {
    api('GET', '/api/stats/history').then(function (r) {
      clear(box);
      var list = r.summaries || [];
      if (!list.length) { box.appendChild(h('div', { class: 'empty', text: T('Пока пусто: итоги появятся после первого стрима, во время которого был открыт док (или эта страница).') })); return; }
      var tb = h('tbody');
      list.forEach(function (s, i) {
        var prev = list[i + 1] || null;
        function cell(v, pv) {
          var td = h('td', { class: 'num', text: v === null || v === undefined ? '—' : String(v) });
          if (prev && v !== null && pv !== null && pv !== undefined && v !== pv) td.appendChild(h('span', { class: 'delta ' + (v > pv ? 'up' : 'down'), text: (v > pv ? ' ▲' : ' ▼') + Math.abs(v - pv) }));
          return td;
        }
        var details = h('tr', { class: 'hist-details', hidden: true }, h('td', { colspan: '9' },
          s.title ? h('div', { class: 'small muted', text: s.title + (s.game ? ' · ' + s.game : '') }) : null,
          namesRow(T('Новые фолловеры'), s.followerNames, s.followers),
          namesRow(T('Подписки'), s.subNames, s.subNames.length),
          namesRow(T('Впервые в чате'), s.newChatterNames, s.newChatters),
          namesRow(T('Рейды'), s.raids.map(function (x) { return x.name + ' (' + x.viewers + ')'; }), s.raids.length),
          h('button', { class: 'small danger', text: T('Удалить запись'), onclick: function () {
            if (!confirm(T('Удалить итоги стрима от {0}?', [fmtDateTime(s.startedAt)]))) return;
            act(post('/api/stats/history/' + encodeURIComponent(s.id) + '/delete'), T('Удалено')).then(function () { renderHistory(box); });
          } })));
        var row = h('tr', { class: 'hist-row', title: T('Нажмите, чтобы увидеть имена') },
          h('td', { class: 'num', title: fmtDateTime(s.startedAt), text: new Date(s.startedAt).toLocaleDateString(I18N.locale(), { day: '2-digit', month: '2-digit', year: '2-digit' }) }),
          h('td', { class: 'num', text: fmtLen(s.endedAt - s.startedAt) }),
          cell(s.avgViewers, prev && prev.avgViewers),
          cell(s.peakViewers, prev && prev.peakViewers),
          cell(s.followers, prev && prev.followers),
          cell(s.subs + s.resubs, prev && prev.subs + prev.resubs),
          cell(s.chatters, prev && prev.chatters),
          cell(s.newChatters, prev && prev.newChatters),
          cell(s.redemptions, prev && prev.redemptions));
        row.addEventListener('click', function () { details.hidden = !details.hidden; });
        tb.appendChild(row);
        tb.appendChild(details);
      });
      box.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'hist' },
        h('thead', null, h('tr', null,
          h('th', { text: T('Дата') }), h('th', { text: T('Длительность') }), h('th', { text: T('Зрители в среднем') }), h('th', { text: T('Пик') }),
          h('th', { text: T('Фолловеры') }), h('th', { text: T('Подписки') }), h('th', { text: T('В чате') }), h('th', { text: T('Впервые') }),
          h('th', { text: T('Награды') }))),
        tb)));
      box.appendChild(h('p', { class: 'small muted', text: T('▲▼ — по сравнению с предыдущим стримом. Нажмите на строку, чтобы увидеть имена.') }));
    }, function () { /* нет связи */ });
  }

  function renderStats() {
    var root = clear($('page-stats'));
    root.appendChild(h('h1', { text: T('Статистика стрима') }));
    if (!ST) { root.appendChild(h('p', { class: 'muted', text: T('Загрузка…') })); loadStats().then(function () { if (page === 'stats') renderStats(); }); return; }
    var su = ST.setup;
    root.appendChild(h('p', { class: 'muted', text: T('Время эфира, зрители, кто в чате, фолловеры, подписчики, битрейт и потери кадров — в реальном времени: в док-панели OBS и, если хотите, прямо на экране стрима.') }));
    root.appendChild(h('div', { id: 'stats-status' }));

    // Живой предпросмотр док-панели.
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('Предпросмотр док-панели') }),
      h('iframe', { class: 'stats-dock-frame', src: '/stats/dock?embed=1', title: T('Предпросмотр док-панели') })));

    var hist = h('div');
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('История стримов') }),
      h('p', { class: 'small muted', text: T('Итоги каждого эфира: зрители, новые фолловеры и подписки, сколько людей было в чате и сколько из них впервые. Бот считает, пока открыт док или эта страница.') }),
      hist));
    renderHistory(hist);

    // Док в OBS.
    var dockFile = fileUrl(su.dockLoader);
    root.appendChild(h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', { text: T('1. Док-панель в OBS') }),
        h('ol', null,
          h('li', { text: T('В OBS откройте меню «Док-панели» → «Пользовательские док-панели браузера…».') }),
          h('li', { text: T('В пустой строке: имя — «Статистика», адрес — скопируйте сюда:') })),
        dockFile ? copyField(dockFile, T('Адрес скопирован')) : null,
        h('ol', { start: '3' },
          h('li', { text: T('Нажмите «Применить». Появится окно — перетащите его к краю OBS, рядом с «Микшером» или «Сценами».') }),
          h('li', { text: T('Значок ⚙ в доке — какие плитки и разделы показывать и за какими микрофонами следить.') })),
        h('p', { class: 'small' }, h('b', { text: T('Streamlabs Desktop:') + ' ' }),
          T('слева «Editor» → «Layout Editor» → перетащите элемент «Website» в свободное место, вставьте адрес ниже и нажмите «Save Changes». Битрейт и кадры в Streamlabs не показываются.')),
        h('div', { class: 'field' }, h('label', { text: T('Если адрес файла не открывается — используйте этот (тогда запускайте бота раньше OBS):') }),
          copyField(su.dockUrl, T('Адрес скопирован'), h('a', { class: 'btn', href: '/stats/dock', target: '_blank', text: T('Открыть') })))),
      h('div', { class: 'card' }, h('h2', { text: T('2. Подключение к OBS') }),
        h('p', { class: 'small', text: T('Битрейт, разрешение, потери кадров и точное время эфира бот берёт прямо из OBS — через встроенный в OBS сервер WebSocket. Бот только читает данные и ничего в OBS не меняет.') }),
        h('ol', null,
          h('li', { text: T('В OBS: меню «Сервис» → «Настройки сервера WebSocket».') }),
          h('li', { text: T('Поставьте галочку «Включить сервер WebSocket» и нажмите «Применить».') }),
          h('li', { text: su.obs.fileFound ? T('Пароль вводить не нужно — бот прочитает его из настроек OBS сам.') : T('Нажмите «Показать сведения о подключении», скопируйте пароль и вставьте ниже.') })),
        h('div', { class: 'form-grid' },
          obsPasswordField(su),
          settingField(T('Порт (0 — как в OBS)'), 'obsWsPort', { type: 'number', min: 0, max: 65535 })))));

    // Overlay на экране стрима.
    var s = S.settings;
    var chosen = String(s.statsOverlayFields || '').split(',').filter(Boolean);
    var checks = h('div', { class: 'stats-fields' }, OVERLAY_FIELDS.map(function (f) {
      var cb = h('input', { type: 'checkbox', checked: chosen.indexOf(f[0]) >= 0 });
      cb.addEventListener('change', function () {
        var cur = OVERLAY_FIELDS.map(function (x) { return x[0]; }).filter(function (id) {
          return id === f[0] ? cb.checked : chosen.indexOf(id) >= 0;
        });
        chosen = cur;
        saveSetting('statsOverlayFields', cur.join(','));
      });
      return h('label', { class: 'check' }, cb, T(f[1]));
    }));
    var overlayFile = su.overlayLoader;
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('3. На экране стрима (по желанию)') }),
      h('p', { class: 'small muted', text: T('Зрители увидят выбранные показатели поверх стрима. Изменения применяются сразу — источник в OBS трогать не нужно.') }),
      checks,
      h('div', { class: 'form-grid' },
        settingField(T('Расположение'), 'statsOverlayLayout', { type: 'select', options: [['row', T('В строку')], ['column', T('В столбик')]] }),
        settingField(T('Стиль'), 'statsOverlayStyle', { type: 'select', options: [['dark', T('Тёмный')], ['light', T('Светлый')], ['clear', T('Без фона')], ['twitch', T('Фиолетовый')]] }),
        settingField(T('Размер, %'), 'statsOverlayScale', { type: 'number', min: 50, max: 300 })),
      settingField(T('Подписи под числами'), 'statsOverlayLabels', { type: 'check' }),
      h('div', { class: 'stats-overlay-preview' }, h('iframe', { src: '/stats/overlay', title: T('Предпросмотр overlay статистики') })),
      h('ol', null,
        h('li', { text: T('В OBS в нужной сцене: «+» в «Источниках» → «Браузер». Название: «Статистика».') }),
        h('li', { text: T('Поставьте галочку «Локальный файл» и выберите файл (путь можно вставить в строку «Имя файла»):') })),
      overlayFile ? copyField(overlayFile, T('Путь скопирован')) : copyField(su.overlayUrl, T('Адрес скопирован')),
      h('ol', { start: '3' },
        h('li', { text: T('Ширина 1920, высота 300 (для столбика — 400 × 800). Нажмите «ОК» и перетащите источник куда удобно.') })),
      overlayFile ? h('div', { class: 'field' }, h('label', { text: T('Или адрес (URL) — тогда запускайте бота раньше OBS:') }), copyField(su.overlayUrl, T('Адрес скопирован'))) : null));

    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('Откуда берутся цифры') }),
      h('ul', null,
        h('li', { text: T('Время эфира, битрейт, разрешение, потери кадров, CPU — из OBS, обновляются каждые 2 секунды.') }),
        h('li', { text: T('Зрители — счётчик Twitch: сам Twitch обновляет его с задержкой 1–2 минуты, быстрее его не получить никому.') }),
        h('li', { text: T('«В чате» — кто сейчас на стриме и вошёл в Twitch, даже если молчит (без ботов и вас). Это число обычно появляется раньше счётчика зрителей; новые люди подсвечиваются в доке.') }),
        h('li', { text: T('Фолловеры, подписки, подарки и рейды приходят от Twitch мгновенно и сразу видны в ленте событий.') }),
        h('li', { text: T('Микрофон: если во время эфира все микрофоны выключены (или на нуле) либо их не слышно 2 минуты — в доке появится тревога. Лишние микрофоны (например, звук карты захвата) можно убрать значком ⚙.') }),
        h('li', { text: T('«Впервые» и «×N» у зрителей в чате — бот запоминает, кто сколько стримов заходил (хранится только у вас на компьютере).') }))));

    renderStatsStatus();
    clearInterval(statsTimer);
    statsTimer = setInterval(function () { if (page !== 'stats') { clearInterval(statsTimer); return; } loadStats(); }, 4000);
  }

  function renderLog() {
    var root = clear($('page-log'));
    root.appendChild(h('h1', { text: T('Журнал') }));
    var tabs = h('div', { class: 'tabs' },
      h('button', { class: logTab === 'events' ? 'active' : '', text: T('События'), onclick: function () { logTab = 'events'; renderLog(); } }),
      h('button', { class: logTab === 'redemptions' ? 'active' : '', text: T('Активации наград'), onclick: function () { logTab = 'redemptions'; renderLog(); } }),
      h('button', { class: logTab === 'tech' ? 'active' : '', text: T('Технический лог'), onclick: function () { logTab = 'tech'; renderLog(); } }));
    root.appendChild(tabs);
    if (logTab === 'events') {
      var tb = h('tbody');
      S.events.forEach(function (e) { tb.appendChild(h('tr', null, h('td', { class: 'muted small', text: fmtDateTime(e.ts) }), h('td', null, levelBadge(e.level)), h('td', { text: e.message }))); });
      root.appendChild(h('div', { class: 'card' }, S.events.length ? h('table', null, tb) : h('div', { class: 'empty', text: T('Пусто') })));
    } else if (logTab === 'redemptions') {
      root.appendChild(renderRedemptionsCard());
    } else {
      var box = h('div', { class: 'log-lines', text: T('Загрузка…') });
      root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: T('Технический лог (сегодня)') }),
        h('button', { class: 'small', text: T('Открыть папку логов'), onclick: function () { act(post('/api/open-folder', { which: 'logs' })); } })), box));
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
  var helpApp = null; // вкладка инструкции: OBS или Streamlabs (по умолчанию — выбранная программа)
  function renderHelp() {
    var root = clear($('page-help'));
    root.appendChild(h('h1', { text: T('Помощь') }));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('1. Приложение Twitch (один раз)') }),
      h('ol', null,
        h('li', null, T('Откройте '), h('a', { href: 'https://dev.twitch.tv/console/apps/create', target: '_blank', rel: 'noopener noreferrer', text: 'dev.twitch.tv/console/apps/create' }), T(' и войдите своим аккаунтом Twitch.')),
        h('li', { text: T('Название — любое, например «My Alert Bot <ваш ник>».') }),
        h('li', { text: T('OAuth Redirect URL: http://localhost (бот его не использует, но поле обязательное).') }),
        h('li', { text: T('Категория: Broadcaster Suite. Тип клиента: «Общедоступный» (Public).') }),
        h('li', { text: T('Нажмите «Создать», затем «Управление» и скопируйте Client ID (секрет клиента НЕ нужен).') }),
        h('li', { text: T('Вставьте Client ID в «Настройки → Twitch» и нажмите «Войти через Twitch».') }))));
    var ha = helpApp || streamApp();
    var helpTabs = h('div', { class: 'tabs' }, ['obs', 'streamlabs'].map(function (k) {
      return h('button', { class: ha === k ? 'active' : '', text: APPS[k].name, onclick: function () { helpApp = k; renderHelp(); } });
    }));
    // Файл-загрузчик: источник открывается всегда и ждёт бота, поэтому неважно, что запущено раньше.
    var fileStep = function (where) {
      return S.overlayLoader ? h('li', null, T('Поставьте галочку «Локальный файл» (Local file), нажмите «Обзор» (Browse) и выберите файл '), h('code', { text: S.overlayLoader }),
        T(' — путь можно вставить в строку «Имя файла». Так источник сам дождётся бота, даже если {0} запущен раньше. ', [where]),
        h('span', { class: 'muted', text: T('Можно и без файла — указать URL ') }), h('code', { text: S.overlayUrl }),
        h('span', { class: 'muted', text: T(', но тогда запускайте бота раньше {0}, иначе источник придётся обновлять вручную (правой кнопкой → «Обновить»).', [where]) }))
        : h('li', null, 'URL: ', h('code', { text: S.overlayUrl }));
    };
    var sourceSteps = ha === 'streamlabs' ? h('ol', null,
      h('li', { text: T('В Streamlabs Desktop: в блоке «Источники» (Sources) нажмите «+» → «Веб-источник» (Browser Source) → «Добавить источник». Название: «Alert Bot».') }),
      fileStep('Streamlabs'),
      h('li', { text: T('Ширина 1920, высота 1080 (источник растянется на весь экран; при другом разрешении он масштабируется сам).') }),
      h('li', { text: T('Включите «Управление аудио через Streamlabs Desktop» (Control audio via Streamlabs Desktop) — звук оповещений появится в «Микшере» и попадёт в эфир. Выключите «Отключать источник, когда не видим» — иначе оповещения ждут, пока сцена неактивна.') }),
      h('li', { text: T('Чтобы слышать оповещения в наушниках: «Микшер» → шестерёнка → «Дополнительные настройки звука» → у «Alert Bot» в столбце «Мониторинг звука» выберите «Мониторинг и вывод звука».') }),
      h('li', { text: T('Добавьте ОДИН источник. В других сценах: «+» → «Веб-источник» → «Добавить существующий источник» → «Alert Bot» — иначе звук будет двоиться.') }),
      h('li', { text: T('В «Настройки → Программа для стрима» выберите «Streamlabs Desktop» (для кнопки запуска и резервной копии сцен).') }),
      h('li', { text: T('Нажмите «Тестовое оповещение» на главной. Звук играет сам, без кликов — как и в OBS.') }))
      : h('ol', null,
        h('li', { text: T('В OBS: «Источники» → «+» → «Браузер». Название: «Alert Bot».') }),
        fileStep('OBS'),
        h('li', { text: T('Ширина 1920, высота 1080 (источник растянется на весь экран; при другом разрешении он масштабируется сам).') }),
        h('li', { text: T('Включите «Управлять аудио через OBS». Выключите «Отключать источник, когда он не виден» — иначе оповещения ждут, пока сцена неактивна.') }),
        h('li', { text: T('Чтобы слышать оповещения в наушниках: «Расширенные свойства аудио» → «Мониторинг звука» → «Монитор и вывод».') }),
        h('li', { text: T('Добавьте ОДИН источник и используйте его во всех сценах через «Добавить существующий» — иначе звук будет двоиться.') }),
        h('li', { text: T('Нажмите «Тестовое оповещение» на главной.') }));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('2. Источник в программе для стрима') }), helpTabs, sourceSteps,
      S.overlayLoader ? h('p', { class: 'small muted', style: 'margin:0 0 6px', text: T('Источник уже добавлен по адресу? Откройте его свойства, поставьте «Локальный файл», выберите файл выше и нажмите «ОК» — остальное менять не нужно.') }) : null,
      h('p', { class: 'small muted', style: 'margin:0', text: T('Не держите источник одновременно в OBS и в Streamlabs: если обе программы открыты, оповещение прозвучит дважды.') })));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('3. Как добавить новую награду') }),
      h('ol', null,
        h('li', null, h('b', { text: T('Подготовьте файлы. ') }), T('Раздел «Медиа» → перетащите звук (MP3, WAV, OGG, M4A) и, если нужно, видео (MP4 H.264 или WebM), GIF или картинку. Бот проверит каждый файл.')),
        h('li', null, h('b', { text: T('Создайте награду. ') }), T('Раздел «Награды» → «+ Новая награда в Twitch» → название (до 45 символов), стоимость в баллах и перезарядку в секундах → подтвердите. Награда сразу появится у зрителей — если файлы ещё не готовы, нажмите у неё «Поставить на паузу в Twitch».')),
        h('li', null, h('b', { text: T('Назначьте файлы. ') }), T('В карточке награды выберите «Звук (основной файл)» и при желании «Видео / GIF / картинка». Для ролика на зелёном фоне поставьте галочку «Убрать зелёный фон».')),
        h('li', null, h('b', { text: T('Выберите режим. ') }), T('«🎬 С видео» — показывается видео со своим звуком; «🔊 Только звук» — играет только звук. Здесь же громкость, длительность (0 — до конца файла), задержка и антиспам.')),
        h('li', null, h('b', { text: T('Включите. ') }), T('Отметьте «Включена в боте».')),
        h('li', null, h('b', { text: T('Проверьте. ') }), T('Кнопка «▶ Тест» проигрывает оповещение в OBS или Streamlabs без списания баллов. Учтите: во время эфира тест видят и слышат зрители.')),
        h('li', null, h('b', { text: T('Значок (по желанию). ') }), T('Twitch не даёт ботам загружать картинки — значок ставится вручную: '), h('a', { href: 'https://dashboard.twitch.tv', target: '_blank', rel: 'noopener noreferrer', text: T('панель автора Twitch') }), T(' → «Награды для зрителей» → «Баллы канала» → «Управление наградами» → награда → «Изображение награды». Нужен PNG 112×112 с прозрачным фоном, не больше ~25 КБ.'))),
      h('div', { class: 'infobox', style: 'margin-top:8px' },
        h('p', { style: 'margin:0 0 6px' }, h('b', { text: T('Награда создана на сайте Twitch, а не в боте? ') }), T('Нажмите «Обновить из Twitch» — бот увидит её и сможет проигрывать. Но менять её из панели и возвращать зрителям баллы при сбое он не сможет: для этого нажмите у неё «Создать свою копию в Twitch…», удалите оригинал на сайте Twitch, затем у копии — «Переименовать…» и «Снять с паузы в Twitch».')),
        h('p', { style: 'margin:0' }, h('b', { text: T('Временно убрать видео у всех наград ') }), T('(например, на игровой сцене): «Главная» → карточка «Видео» → «Только звук для всех».')))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('4. Мемы и звуки из интернета («Найти медиа»)') }),
      h('ol', null,
        h('li', null, h('b', { text: T('Ключи (один раз). ') }), 'Klipy — ', h('a', { href: 'https://partner.klipy.com', target: '_blank', rel: 'noopener noreferrer', text: 'partner.klipy.com' }), ' → API Keys; Freesound — ',
          h('a', { href: 'https://freesound.org/apiv2/apply', target: '_blank', rel: 'noopener noreferrer', text: 'freesound.org/apiv2/apply' }), T('. Вставьте их в «Настройки» → «Поиск медиа».')),
        h('li', null, h('b', { text: T('Найдите. ') }), T('«Найти медиа» → Klipy (клипы со звуком, GIF, стикеры) или Freesound (звуки). Лучше искать по-английски.')),
        h('li', null, h('b', { text: T('Добавьте. ') }), T('«＋ В медиатеку», затем «▶ В {0}» для проверки или «＋ Награда» — бот создаст награду в Twitch с этим файлом.', [appShort()])),
        h('li', null, h('b', { text: T('Запасной звук. ') }), T('Мемы Klipy не скачиваются (правила Klipy) — они загружаются с сервера Klipy во время показа. Выберите награде «Звук (основной файл)»: он сыграет, если Klipy или интернет недоступны.'))),
      h('p', { class: 'small muted', style: 'margin:0', text: T('Звуки Freesound скачиваются и работают без интернета; автора звуков с лицензией CC BY нужно указывать (например, в описании канала) — он записан у файла в «Медиа».') })));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('5. Переход с Sound Alerts (или другого сервиса)') }),
      h('ol', null,
        h('li', { text: T('Загрузите звуки/видео в раздел «Медиа» и назначьте их наградам.') }),
        h('li', { text: T('Включите «Режим наблюдения» и проверьте во время стрима, что все активации видны в журнале.') }),
        h('li', { text: T('Скройте (значок глаза) источники Sound Alerts во всех сценах {0}, включите нужные награды в боте и «Активный режим».', [appShort()]) }),
        h('li', { text: T('По желанию — создайте собственные копии наград (кнопка у награды). Старые награды Sound Alerts удаляйте только после успешной проверки.') }))));
    root.appendChild(h('div', { class: 'card' }, h('h2', { text: T('6. Переход с TriggerFyre') }),
      h('p', { class: 'muted', style: 'margin-top:0' }, T('Полная инструкция с таблицей настроек: '),
        h('a', { href: 'https://github.com/darkspiteman/twitch-points-alert-bot/blob/main/docs/MIGRATION-TRIGGERFYRE.md', target: '_blank', rel: 'noopener noreferrer', text: T('docs/MIGRATION-TRIGGERFYRE.md на GitHub') }),
        T(' (этот же файл есть в папке программы: docs\\MIGRATION-TRIGGERFYRE.md).')),
      h('ol', null,
        h('li', null, h('b', { text: T('Наблюдение. ') }), T('«Главная» → карточка «Режим» → «Включить наблюдение». Пока TriggerFyre работает, бот только записывает активации и ничего не проигрывает.')),
        h('li', null, h('b', { text: T('Перепишите триггеры. ') }), T('В TriggerFyre для каждого триггера запишите Reward name, файл, громкость, длительность, задержку и кулдаун (удобно сделать скриншоты).')),
        h('li', null, h('b', { text: T('Сохраните файлы. ') }), T('Возьмите исходные картинки, видео и звуки или сохраните их со страницы TriggerFyre (правой кнопкой → «Сохранить как…»).')),
        h('li', null, h('b', { text: T('Загрузите и привяжите. ') }), T('«Медиа» → перетащите файлы. «Награды» → «Обновить из Twitch»: награды TriggerFyre появятся с меткой «Другое приложение» — это нормально. Назначьте файлы, громкость, длительность, задержку, антиспам и отметьте «Включена в боте».')),
        h('li', null, h('b', { text: T('Положение и размер. ') }), T('«Настройки» → «Overlay» — они общие для всех наград.')),
        h('li', null, h('b', { text: T('Проверьте. ') }), T('Вне эфира нажмите «▶ Тест» у каждой награды. Проведите один стрим в режиме наблюдения и убедитесь, что все активации есть в «Последних активациях наград».')),
        h('li', null, h('b', { text: T('Переключитесь. ') }), T('В {0} скройте (значок глаза) источник TriggerFyre во всех сценах, затем в боте — «Включить воспроизведение». Откат: «Включить наблюдение» и снова показать источник TriggerFyre.', [appShort()])),
        h('li', null, h('b', { text: T('Отключите TriggerFyre ') }), T('(после 2–3 удачных стримов): удалите его источник из OBS и отключите доступ в twitch.tv → «Настройки» → «Подключения».'))),
      h('div', { class: 'infobox', style: 'margin-top:8px' },
        h('p', { style: 'margin:0' }, h('b', { text: T('Чего нет в боте: ') }), T('чат-команд, действий в OBS (смена сцены, показ источника, фильтры), случайного выбора файла и «% шанса», лимита срабатываний, своего положения для каждой награды. Бот работает только с наградами за баллы канала.')))));
  }

  // ---------------- старт ----------------
  renderStatic();
  go();
  connectWs();
  setInterval(function () { if (S && page === 'home') renderHomeTop(); }, 5000);
})();
