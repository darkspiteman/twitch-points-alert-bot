import fs from 'node:fs';
import path from 'node:path';

/**
 * Файл-загрузчик overlay для OBS Studio и Streamlabs Desktop.
 *
 * Проблема: Browser Source загружает страницу один раз при запуске программы. Если бот в этот момент
 * ещё не запущен, браузер внутри OBS показывает страницу ошибки и сам её больше не перезагружает —
 * а переподключение в overlay.js не работает, потому что overlay так и не загрузился.
 *
 * Решение: в источнике выбирается «Локальный файл» — этот загрузчик. Он открывается всегда (файл на диске),
 * ждёт бота через WebSocket /ws/probe и, когда бот ответил, сам переходит на http://127.0.0.1:<порт>/overlay.
 * Дальше переподключения обеспечивает overlay.js.
 */

export const LOADER_FILE = 'overlay.html';

/** Источники WebSocket /ws/probe, кроме самой панели: локальный файл в OBS/Streamlabs (http://absolute/…) и файл в браузере. */
export const PROBE_ORIGINS = ['http://absolute', 'null', 'file://'];

export function loaderHtml(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Неверный порт: ${port}`);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://127.0.0.1:${port}">
<title>Twitch Alert Bot — загрузчик overlay</title>
<!--
  Этот файл создаёт Twitch Alert Bot (заново при каждом запуске, правки не сохранятся).
  В OBS / Streamlabs: свойства источника «Браузер» → галочка «Локальный файл» → выберите этот файл.
  Файл ждёт запуска бота и сам открывает overlay — неважно, что запущено раньше: программа или бот.
-->
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  #s { display: none; margin: 16px; padding: 10px 14px; border-radius: 8px; background: rgba(20,20,30,.85); color: #fff; font: 16px/1.4 "Segoe UI", sans-serif; width: max-content; }
</style>
</head>
<body>
<div id="s"></div>
<script>
(function () {
  'use strict';
  var PORT = ${port};
  var TARGET = 'http://127.0.0.1:' + PORT + '/overlay?via=file';
  var ua = navigator.userAgent || '';
  var inStreamApp = typeof window.obsstudio !== 'undefined' || /\\bOBS\\/|\\bSLD\\b|Streamlabs/i.test(ua);
  var s = document.getElementById('s');
  // В OBS/Streamlabs ничего не показываем (зрители не должны видеть служебный текст).
  if (!inStreamApp) s.style.display = 'block';
  s.textContent = 'Ждём запуска Twitch Alert Bot (порт ' + PORT + ')…';
  var attempt = 0;
  var done = false;

  function go() {
    if (done) return;
    done = true;
    location.replace(TARGET);
  }

  function probe() {
    if (done) return;
    attempt++;
    var ws = null;
    var settled = false;
    var timer = 0;
    function retry() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch (e) { /* уже закрыт */ }
      setTimeout(probe, attempt < 60 ? 1000 : 3000);
    }
    try {
      ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws/probe');
    } catch (e) {
      retry();
      return;
    }
    timer = setTimeout(retry, 4000); // бот завис или порт занят чужой программой
    ws.onmessage = function (ev) {
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { /* не наш ответ */ }
      if (m && m.type === 'ready' && m.app === 'twitch-alert-bot') {
        settled = true;
        clearTimeout(timer);
        go();
      }
    };
    ws.onclose = retry;
    ws.onerror = function () { /* onclose вызовется следом */ };
  }

  probe();
})();
</script>
</body>
</html>
`;
}

/** Записывает загрузчик в папку данных (только если содержимое изменилось). Возвращает полный путь к файлу. */
export function writeLoader(dir: string, port: number): string {
  const file = path.join(dir, LOADER_FILE);
  const html = loaderHtml(port);
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* файла ещё нет */ }
  if (current !== html) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, html, 'utf8');
    fs.renameSync(tmp, file);
  }
  return file;
}
