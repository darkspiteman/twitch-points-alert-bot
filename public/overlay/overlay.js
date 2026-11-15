// Twitch Alert Bot — overlay для Browser Source в OBS Studio или Streamlabs Desktop.
// Подключается к боту по WebSocket и автоматически переподключается (в том числе после перезапуска программы или бота).
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  // Streamlabs Desktop работает на том же движке Browser Source, что и OBS: в обоих есть window.obsstudio,
  // а Streamlabs дополнительно пишет «SLD» в User-Agent.
  var ua = navigator.userAgent || '';
  var app = /\bSLD\b|Streamlabs/i.test(ua) ? 'streamlabs' : (typeof window.obsstudio !== 'undefined' || /\bOBS\//i.test(ua)) ? 'obs' : null;
  var isObs = app !== null; // открыт в программе для стрима, а не в обычном браузере
  // via=file — страницу открыл файл-загрузчик overlay.html («Локальный файл» в источнике), а не адрес.
  var via = params.get('via') === 'file' ? 'file' : 'url';
  var showStatus = params.get('debug') === '1' || !isObs;
  var stage = document.getElementById('stage');
  var statusEl = document.getElementById('status');

  var ws = null;
  var retryDelay = 1000;
  var lastMessageAt = 0;
  var current = null; // { id, root, media: [], timers: [], done }
  var audioUnlocked = isObs;

  // Служебный текст (виден только в обычном браузере, не в OBS/Streamlabs) — на языке панели.
  // Язык приходит от бота в view.lang; до подключения — тот, что запомнила панель (тот же адрес — общее хранилище).
  // Сообщения об ошибках воспроизведения уходят боту по-русски: он хранит их и сам переводит для панели.
  var TEXT = {
    ru: { connecting: 'Подключение к боту…', connected: 'Подключено к боту', lost: 'Нет связи с ботом — переподключение…', unmute: 'Включить звук' },
    en: { connecting: 'Connecting to the bot…', connected: 'Connected to the bot', lost: 'No connection to the bot — reconnecting…', unmute: 'Enable sound' },
  };
  var lang = 'ru';
  try { if (localStorage.getItem('tab-lang') === 'en') lang = 'en'; } catch (e) { /* нет доступа к хранилищу */ }
  var lastStatus = null;

  function setStatus(key, cls) {
    lastStatus = { key: key, cls: cls };
    if (!showStatus) return;
    statusEl.hidden = false;
    statusEl.className = cls || '';
    statusEl.textContent = TEXT[lang][key];
    if (!audioUnlocked) {
      var b = document.createElement('button');
      b.textContent = TEXT[lang].unmute;
      b.addEventListener('click', function () { audioUnlocked = true; b.remove(); });
      statusEl.appendChild(b);
    }
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) { /* соединение закрывается */ }
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      ws = new WebSocket(proto + location.host + '/ws/overlay');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    setStatus('connecting');
    ws.onopen = function () {
      retryDelay = 1000;
      lastMessageAt = Date.now();
      send({ type: 'hello', isObs: isObs, app: app, via: via });
      setStatus('connected', 'ok');
    };
    ws.onmessage = function (ev) {
      lastMessageAt = Date.now();
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function () {
      setStatus('lost', 'bad');
      ws = null;
      // Текущее оповещение прерываем: бот сам решит, что делать дальше.
      if (current) finish(current, null, true);
      scheduleReconnect();
    };
    ws.onerror = function () { /* onclose вызовется следом */ };
  }

  function scheduleReconnect() {
    var delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, 5000);
    setTimeout(connect, delay);
  }

  // Сторож: если бот молчит дольше 40 с (он шлёт ping каждые 15 с) — переподключаемся.
  setInterval(function () {
    if (ws && ws.readyState === 1 && Date.now() - lastMessageAt > 40000) {
      try { ws.close(); } catch (e) { /* */ }
    }
  }, 5000);

  function applyView(view) {
    if (!view) return;
    if ((view.lang === 'en' || view.lang === 'ru') && view.lang !== lang) {
      lang = view.lang;
      document.documentElement.lang = lang;
      if (lastStatus) setStatus(lastStatus.key, lastStatus.cls);
    }
    stage.className = 'pos-' + (view.position || 'center');
    stage.style.setProperty('--max-w', (view.maxWidthPct || 60) + 'vw');
    stage.style.setProperty('--max-h', (view.maxHeightPct || 60) + 'vh');
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello': applyView(msg.view); break;
      case 'view': applyView(msg.view); break;
      case 'ping': send({ type: 'pong' }); break;
      case 'play': play(msg.item); break;
      case 'stop': if (current && current.id === msg.id) finish(current, null, true); break;
    }
  }

  function mediaErrorText(el) {
    var e = el.error;
    if (!e) return 'неизвестная ошибка воспроизведения';
    var codes = { 1: 'воспроизведение прервано', 2: 'ошибка сети при загрузке файла', 3: 'не удалось декодировать файл (повреждён или неподдерживаемый кодек)', 4: 'кодек или формат файла не поддерживается программой для стрима (MEDIA_ERR_SRC_NOT_SUPPORTED)' };
    return codes[e.code] || ('код ошибки ' + e.code);
  }

  // Хромакей: видео рисуется в canvas через WebGL, зелёный фон становится прозрачным.
  var VS = 'attribute vec2 p; varying vec2 uv; void main(){ uv = vec2((p.x+1.0)/2.0, (1.0-p.y)/2.0); gl_Position = vec4(p,0.0,1.0); }';
  var FS = 'precision mediump float; varying vec2 uv; uniform sampler2D t;' +
    'void main(){ vec4 c = texture2D(t, uv); float m = max(c.r, c.b); float g = c.g - m;' +
    ' float a = 1.0 - smoothstep(0.06, 0.22, g);' +              // насколько пиксель «зелёный»
    ' vec3 col = c.rgb; if (c.g > m) col.g = mix(c.g, m, 0.85);' + // подавление зелёных отсветов по краям
    ' gl_FragColor = vec4(col * a, a); }';
  function chromaKeyCanvas(video, state) {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    if (!gl) return null;
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    function frame() {
      if (state.done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
        gl.viewport(0, 0, canvas.width, canvas.height);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) { /* кадр ещё не готов */ }
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return canvas;
  }

  function play(item) {
    if (current) finish(current, null, true);
    var state = { id: item.id, root: null, media: [], timers: [], done: false, waiting: 0 };
    current = state;

    var root = document.createElement('div');
    root.className = 'alert';
    state.root = root;

    var fail = function (text) {
      // Онлайн-медиа (Klipy) не загрузилось — играем запасной звук награды под тем же id.
      if (item.fallbackAudio && !state.done && (item.visual && item.visual.remote || item.audio && item.audio.remote)) {
        var fb = item.fallbackAudio;
        send({ type: 'fallback', id: item.id, message: text || '' });
        finish(state, null, true);
        play({ id: item.id, visual: null, audio: fb, fallbackAudio: null, caption: item.caption, volume: item.volume, durationMs: 0, maxDurationMs: item.maxDurationMs });
        return;
      }
      finish(state, text || 'ошибка воспроизведения', false);
    };
    var oneEnded = function () {
      state.waiting--;
      if (state.waiting <= 0 && !(item.durationMs > 0)) finish(state, null, false);
    };

    if (item.visual) {
      if (item.visual.kind === 'video') {
        var v = document.createElement('video');
        v.src = item.visual.url;
        v.playsInline = true;
        v.preload = 'auto';
        v.volume = item.volume;
        v.muted = !audioUnlocked; // в обычном браузере без клика звук запрещён
        v.addEventListener('ended', oneEnded);
        v.addEventListener('error', function () { fail(mediaErrorText(v)); });
        state.media.push(v);
        state.waiting++;
        var keyed = item.chromaKey ? chromaKeyCanvas(v, state) : null;
        if (keyed) {
          v.className = 'hidden-source'; // видео играет, но на экране — обработанный canvas
          root.appendChild(v);
          root.appendChild(keyed);
        } else {
          root.appendChild(v);
        }
      } else {
        var img = document.createElement('img');
        img.alt = '';
        img.addEventListener('error', function () { fail('не удалось загрузить изображение (файл повреждён?)'); });
        img.src = item.visual.url;
        root.appendChild(img);
      }
    }
    if (item.audio) {
      var a = new Audio();
      a.preload = 'auto';
      a.src = item.audio.url;
      a.volume = item.volume;
      a.muted = !audioUnlocked;
      a.addEventListener('ended', oneEnded);
      a.addEventListener('error', function () { fail(mediaErrorText(a)); });
      state.media.push(a);
      state.waiting++;
    }
    if (item.caption) {
      var cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = item.caption; // только textContent — защита от XSS
      root.appendChild(cap);
    }

    stage.appendChild(root);
    // Анимация появления.
    void root.offsetWidth; // принудительный reflow, чтобы сработал CSS-переход
    setTimeout(function () { root.classList.add('show'); }, 20);

    var started = false;
    state.media.forEach(function (m) {
      m.addEventListener('playing', function () { started = true; });
      var p = m.play();
      if (p && p.catch) p.catch(function (err) {
        if (state.done) return;
        if (err && err.name === 'NotAllowedError') fail('браузер запретил автозапуск звука (в OBS и Streamlabs этого не происходит)');
        else if (err && err.name !== 'AbortError') fail('не удалось начать воспроизведение: ' + (err.message || err.name));
      });
    });

    // Фиксированная длительность (для картинок/GIF или если задана в настройках награды).
    if (item.durationMs > 0) state.timers.push(setTimeout(function () { finish(state, null, false); }, item.durationMs));
    else if (state.media.length === 0) state.timers.push(setTimeout(function () { finish(state, null, false); }, 5000));
    // Жёсткий предел длительности.
    state.timers.push(setTimeout(function () { finish(state, null, false); }, item.maxDurationMs || 300000));
    // Если медиа не начало играть за 10 с — считаем ошибкой (повреждённый/зависший файл).
    if (state.media.length) state.timers.push(setTimeout(function () { if (!started && !state.done) fail('файл не начал воспроизводиться за 10 секунд'); }, 10000));
  }

  function finish(state, errorText, silent) {
    if (state.done) return;
    state.done = true;
    state.timers.forEach(clearTimeout);
    if (current === state) current = null;
    var root = state.root;
    var cleanup = function () {
      state.media.forEach(function (m) {
        try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) { /* */ }
      });
      if (root && root.parentNode) root.parentNode.removeChild(root);
    };
    // Плавное исчезновение, затем полная очистка (видео не «застревает» на экране).
    state.media.forEach(function (m) { if (m.tagName === 'AUDIO') { try { m.pause(); } catch (e) { /* */ } } });
    if (root) { root.classList.remove('show'); root.classList.add('hide'); }
    setTimeout(function () {
      cleanup();
      if (!silent) send(errorText ? { type: 'error', id: state.id, message: errorText } : { type: 'ended', id: state.id });
    }, root ? 420 : 0);
  }

  connect();
})();
