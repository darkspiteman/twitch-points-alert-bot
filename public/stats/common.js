// Twitch Alert Bot — общее для дока и overlay статистики: подключение к боту, перевод, форматирование, значки.
// Пользовательский текст (ники, название стрима) выводится только через textContent.
(function () {
  'use strict';

  var TEXT = {
    ru: {
      session: 'Сессия', viewers: 'Зрители', chatters: 'В чате', followers: 'Фолловеры', followersSession: 'Новые фолловеры',
      subs: 'Подписчики', subPoints: 'Баллы подписок', bitrate: 'Битрейт', resolution: 'Видео', dropped: 'Потери кадров', health: 'Состояние', cpu: 'CPU',
      peak: 'пик {0}', perStream: '+{0} за стрим', kbps: 'кбит/с', offline: 'Не в эфире', live: 'В ЭФИРЕ',
      good: 'Отлично', warn: 'Есть проблемы', bad: 'Плохо',
      r_reconnecting: 'OBS переподключается к Twitch', r_dropped: 'Теряются кадры — не хватает скорости интернета', r_bitrate_low: 'Битрейт упал', r_render: 'OBS не успевает рисовать кадры (нагрузка на видеокарту)', r_cpu: 'Процессор загружен больше 90 %',
      connecting: 'Подключение к боту…', lost: 'Нет связи с ботом — переподключение…',
      obs_off: 'OBS: подключение выключено', obs_connecting: 'OBS не найден — запустите OBS', obs_disabled: 'В OBS выключен сервер WebSocket: «Сервис» → «Настройки сервера WebSocket» → «Включить сервер WebSocket»',
      obs_auth_failed: 'OBS не принял пароль WebSocket — проверьте его в панели бота («Статистика»)', obs_error: 'Ошибка подключения к OBS', obs_streamlabs: 'Битрейт и кадры доступны только в OBS Studio',
      notLogged: 'Бот не вошёл в Twitch — откройте панель бота', scopes: 'Чтобы видеть {0}, войдите в Twitch заново в панели бота («Настройки» → «Войти заново»)',
      s_followers: 'события фолловеров', s_subs: 'подписчиков', s_chatters: 'кто в чате',
      feed: 'События', chat: 'Кто в чате', noFeed: 'Пока тихо', noChat: 'В чате никого (кроме вас и ботов)', newMark: 'новый',
      f_follow: 'фолловнул(а)', f_sub: 'подписка', f_resub: 'подписка {0} мес.', f_gift: 'подарил(а) {0} подп.', f_giftAnon: 'Аноним подарил {0} подп.', f_raid: 'рейд, {0} зрит.', f_join: 'зашёл(ла) в чат',
      ago_now: 'только что', ago_m: '{0} мин', ago_h: '{0} ч', tiles: 'Плитки', twitchDelay: 'Число зрителей Twitch обновляет с задержкой 1–2 мин; «В чате» — кто реально на стриме (без ботов и вас)',
      mic_muted_live: 'Микрофон «{0}» ВЫКЛЮЧЕН — вас не слышно!', mic_muted: 'Микрофон «{0}» выключен — включите перед эфиром', mic_zero: 'У микрофона «{0}» громкость на нуле',
      mic_silent: 'Микрофона «{0}» не слышно уже {1} мин — проверьте', micWatch: 'Следить за микрофонами', micNone: 'Микрофонов в OBS не найдено',
      sections: 'Разделы', sec_queue: 'Оповещения', sec_feed: 'События', sec_chat: 'Кто в чате', sec_summary: 'Итоги прошлого стрима',
      queue: 'Оповещения', q_skip: 'Пропустить', q_remove: 'Убрать из очереди', q_pause: 'Пауза', q_resume: 'Продолжить', q_paused: 'пауза',
      q_empty: 'Очередь пуста', q_emptyPaused: 'Очередь на паузе', q_more: 'и ещё {0}',
      f_joinFirst: 'впервые на канале!', f_joinN: 'зашёл(ла) в чат · {0}-й стрим', firstMark: 'впервые', visitsTitle: 'Был(а) на {0} стримах',
      trackNote: 'Бот только начал запоминать зрителей: отметка «впервые» появится со следующего стрима.',
      sumTitle: 'Итоги прошлого стрима', sumViewers: 'Зрители в среднем', sumResubs: 'продлений {0}', sumGifts: 'подарено {0}', sumNew: 'впервые {0}',
      sumRaids: 'Рейды', sumRedeems: 'Награды за баллы', sumFollowerNames: 'Новые фолловеры', sumNewChatterNames: 'Впервые в чате', sumSubNames: 'Подписки',
      sumRaidNames: 'Рейды', andMore: 'и ещё {0}', sumHint: 'Все прошлые стримы — в панели бота, раздел «Статистика».',
    },
    en: {
      session: 'Session', viewers: 'Viewers', chatters: 'In chat', followers: 'Followers', followersSession: 'New followers',
      subs: 'Subscribers', subPoints: 'Sub points', bitrate: 'Bitrate', resolution: 'Video', dropped: 'Dropped frames', health: 'Health', cpu: 'CPU',
      peak: 'peak {0}', perStream: '+{0} this stream', kbps: 'kb/s', offline: 'Offline', live: 'LIVE',
      good: 'Excellent', warn: 'Issues', bad: 'Poor',
      r_reconnecting: 'OBS is reconnecting to Twitch', r_dropped: 'Frames are being dropped — internet too slow', r_bitrate_low: 'Bitrate dropped', r_render: 'OBS can’t render frames in time (GPU load)', r_cpu: 'CPU load is above 90%',
      connecting: 'Connecting to the bot…', lost: 'No connection to the bot — reconnecting…',
      obs_off: 'OBS: connection is off', obs_connecting: 'OBS not found — start OBS', obs_disabled: 'The WebSocket server is off in OBS: “Tools” → “WebSocket Server Settings” → “Enable WebSocket server”',
      obs_auth_failed: 'OBS rejected the WebSocket password — check it in the bot panel (“Stats”)', obs_error: 'OBS connection error', obs_streamlabs: 'Bitrate and frames are available only in OBS Studio',
      notLogged: 'The bot isn’t signed in to Twitch — open the bot panel', scopes: 'To see {0}, sign in to Twitch again in the bot panel (“Settings” → “Sign in again”)',
      s_followers: 'follow events', s_subs: 'subscribers', s_chatters: 'who’s in chat',
      feed: 'Events', chat: 'In chat', noFeed: 'Quiet so far', noChat: 'Nobody in chat (except you and bots)', newMark: 'new',
      f_follow: 'followed', f_sub: 'subscribed', f_resub: 'subscribed, {0} mo.', f_gift: 'gifted {0} subs', f_giftAnon: 'Anonymous gifted {0} subs', f_raid: 'raid, {0} viewers', f_join: 'joined the chat',
      ago_now: 'just now', ago_m: '{0} min', ago_h: '{0} h', tiles: 'Tiles', twitchDelay: 'Twitch updates the viewer count with a 1–2 min delay; “In chat” is who is actually here (without bots and you)',
      mic_muted_live: 'Mic “{0}” is MUTED — nobody can hear you!', mic_muted: 'Mic “{0}” is muted — unmute it before going live', mic_zero: 'Mic “{0}” volume is at zero',
      mic_silent: 'No sound from mic “{0}” for {1} min — check it', micWatch: 'Watch microphones', micNone: 'No microphones found in OBS',
      sections: 'Sections', sec_queue: 'Alerts', sec_feed: 'Events', sec_chat: 'In chat', sec_summary: 'Last stream summary',
      queue: 'Alerts', q_skip: 'Skip', q_remove: 'Remove from queue', q_pause: 'Pause', q_resume: 'Resume', q_paused: 'paused',
      q_empty: 'Queue is empty', q_emptyPaused: 'Queue is paused', q_more: 'and {0} more',
      f_joinFirst: 'first time on the channel!', f_joinN: 'joined the chat · stream #{0}', firstMark: 'first time', visitsTitle: 'Was here on {0} streams',
      trackNote: 'The bot has just started remembering viewers: the “first time” mark will appear from the next stream.',
      sumTitle: 'Last stream summary', sumViewers: 'Average viewers', sumResubs: '{0} resubs', sumGifts: '{0} gifted', sumNew: '{0} first-time',
      sumRaids: 'Raids', sumRedeems: 'Channel point rewards', sumFollowerNames: 'New followers', sumNewChatterNames: 'First time in chat', sumSubNames: 'Subs',
      sumRaidNames: 'Raids', andMore: 'and {0} more', sumHint: 'All past streams are in the bot panel, “Stats” section.',
    },
  };

  var lang = 'ru';
  try { if (localStorage.getItem('tab-lang') === 'en') lang = 'en'; } catch (e) { /* нет хранилища */ }

  function t(key, args) {
    var s = (TEXT[lang] && TEXT[lang][key]) || TEXT.ru[key] || key;
    if (args) for (var i = 0; i < args.length; i++) s = s.split('{' + i + '}').join(String(args[i]));
    return s;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function num(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU');
  }

  function duration(ms) {
    if (ms === null || ms === undefined || ms < 0) return '—';
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function resolution(o) {
    if (!o || !o.height) return '—';
    var fps = Math.round(o.fps || 0);
    return o.height + 'p' + (fps ? fps : '');
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return t('ago_now');
    if (s < 3600) return t('ago_m', [Math.round(s / 60)]);
    return t('ago_h', [Math.floor(s / 3600)]);
  }

  // Значки: простые контуры 24×24, рисуются через DOM (CSP запрещает inline-скрипты, а не SVG).
  var ICONS = {
    session: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.4l3.7 2.2-.8 1.3L11 13V7h2z',
    viewers: 'M12 5C7 5 2.7 8.1 1 12.5 2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    chatters: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 1-2zm3 6v2h2V9H7zm4 0v2h2V9h-2zm4 0v2h2V9h-2z',
    followers: 'M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 4.5 6.8 4.5c2.1 0 3.5 1.1 4.2 2.3h2c.7-1.2 2.1-2.3 4.2-2.3 3.8 0 5.9 4 4.4 7.3C19.5 16.4 12 21 12 21z',
    followersSession: 'M12 21s-7.5-4.6-9.6-9.2C.9 8.5 3 4.5 6.8 4.5c2.1 0 3.5 1.1 4.2 2.3h2c.7-1.2 2.1-2.3 4.2-2.3 3.8 0 5.9 4 4.4 7.3C19.5 16.4 12 21 12 21z',
    subs: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7.1L12 17.3 5.8 21l1.6-7.1L2 9.2l7.1-.6L12 2z',
    subPoints: 'M6 3h12l4 6-10 12L2 9l4-6zm1.2 2L5 8.5h3.3L9.4 5H7.2zm4.4 0l-1.1 3.5h3l-1.1-3.5h-.8zm3 0l1.1 3.5H19L16.8 5h-2.2zM5.4 10.5l5.3 6.4-2-6.4H5.4zm5.4 0l1.2 4 1.2-4h-2.4zm4.5 0l-2 6.4 5.3-6.4h-3.3z',
    bitrate: 'M3 20h3v-6H3v6zm5 0h3V10H8v10zm5 0h3V6h-3v14zm5 0h3V2h-3v18z',
    resolution: 'M3 4h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v10h16V6H4z',
    dropped: 'M12 2L1 21h22L12 2zm-1 7h2v6h-2V9zm0 8h2v2h-2v-2z',
    health: 'M3 12h4l2-5 4 10 2-5h6v2h-4.6L13 19 9 9l-.6 1.5L7.4 14H3v-2z',
    cpu: 'M9 2h2v2h2V2h2v2h2a2 2 0 0 1 2 2v2h2v2h-2v2h2v2h-2v2a2 2 0 0 1-2 2h-2v2h-2v-2h-2v2H9v-2H7a2 2 0 0 1-2-2v-2H3v-2h2v-2H3V8h2V6a2 2 0 0 1 2-2h2V2zm-2 4v12h10V6H7zm2 2h6v8H9V8z',
    mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h3v2H8v-2h3v-3.1A7 7 0 0 1 5 11z',
    reward: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 0 1 7 7h-2a5 5 0 0 0-5-5V5zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  };
  var SVG = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ic ' + (cls || ''));
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.health);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  }

  /** Мини-график битрейта (polyline). */
  function sparkline(values, w, h) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    s.setAttribute('preserveAspectRatio', 'none');
    s.setAttribute('class', 'spark');
    if (!values || values.length < 2) return s;
    var max = Math.max.apply(null, values) || 1;
    var pts = [];
    for (var i = 0; i < values.length; i++) {
      var x = (i / (values.length - 1)) * w;
      var y = h - 2 - (values[i] / max) * (h - 4);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var area = document.createElementNS(SVG, 'polygon');
    area.setAttribute('points', '0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h);
    area.setAttribute('class', 'spark-area');
    var line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', 'spark-line');
    s.appendChild(area);
    s.appendChild(line);
    return s;
  }

  /** Подключение к /ws/stats с переподключением. onData(payload), onConn(true/false). */
  function connect(onData, onConn) {
    var ws = null;
    var delay = 1000;
    var lastAt = 0;
    var seenVersion = '';
    function open() {
      try { ws = new WebSocket('ws://' + location.host + '/ws/stats'); } catch (e) { retry(); return; }
      ws.onopen = function () { delay = 1000; lastAt = Date.now(); onConn(true); };
      ws.onmessage = function (ev) {
        lastAt = Date.now();
        var m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.type === 'stats') {
          // Бот обновился — загрузить новую версию страницы (OBS сам её не перезагрузит).
          if (m.version) { if (seenVersion && seenVersion !== m.version) { location.reload(); return; } seenVersion = m.version; }
          if (m.lang === 'en' || m.lang === 'ru') lang = m.lang;
          onData(m);
        }
      };
      ws.onclose = function () { onConn(false); retry(); };
      ws.onerror = function () { /* придёт onclose */ };
    }
    function retry() {
      ws = null;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10000);
    }
    // Бот шлёт данные минимум раз в 5 секунд, пока OBS подключён; долгая тишина — соединение «зависло».
    setInterval(function () { if (ws && ws.readyState === 1 && Date.now() - lastAt > 60000) { try { ws.close(); } catch (e) { /* */ } } }, 10000);
    open();
  }

  /** Сколько длится трансляция сейчас (отсчёт на месте между обновлениями). */
  function sessionMs(st) {
    if (!st || !st.sessionStart) return null;
    return Date.now() - st.sessionStart;
  }

  window.TABStats = {
    t: t, el: el, num: num, duration: duration, resolution: resolution, ago: ago, icon: icon, sparkline: sparkline, connect: connect, sessionMs: sessionMs,
    lang: function () { return lang; },
  };
})();
