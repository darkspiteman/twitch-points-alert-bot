import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths, validateSettingsPatch } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { tr, localize, effectiveLang } from '../src/i18n.ts';
import { loaderHtml, LOADER_FILE } from '../src/overlay-loader.ts';
import { codecWarnings } from '../src/media-codecs.ts';
import { parseChangelog } from '../src/update.ts';
import { standardTwitch, quietLogger, tmpDir, waitFor, delay } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CYR = /[А-Яа-яЁё]/;
const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(dir = tmpDir()) {
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: twitch.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, port: app.port, dir };
}

const api = (port: number, method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------------------------------------------------------------------------------------------
// Сервер: словарь
// ---------------------------------------------------------------------------------------------

test('перевод сообщений сервера: шаблоны, вложенные части, предложения, неизвестный текст не меняется', () => {
  assert.equal(effectiveLang(''), 'ru');
  assert.equal(effectiveLang('en'), 'en');
  assert.equal(effectiveLang('de'), 'ru');
  // русский — без изменений
  assert.equal(tr('Награда не найдена', 'ru'), 'Награда не найдена');
  assert.equal(tr('Награда не найдена', 'en'), 'Reward not found');
  // подстановки и вложенный перевод
  assert.equal(tr('«Привет» от Вася — награда выключена в боте', 'en'), '“Привет” from Вася — the reward is turned off in the bot', 'название награды и имя зрителя не переводятся');
  assert.equal(tr('Ошибка воспроизведения: файл не начал воспроизводиться за 10 секунд', 'en'), 'Playback error: the file didn’t start playing within 10 seconds');
  assert.equal(tr('Ошибка соединения: код 4002: не отвечен ping', 'en'), 'Connection error: code 4002: ping not answered');
  // несколько предложений, собранных из частей
  assert.equal(tr('Twitch отклонил запрос входа (HTTP 400). Проверьте Client ID. Убедитесь, что тип клиента приложения — «Public» (Общедоступный).', 'en'),
    'Twitch rejected the sign-in request (HTTP 400). Check the Client ID. Make sure the app client type is “Public”.');
  const gap = 'Связь с Twitch EventSub отсутствовала с 12:00:01 по 12:03:15 (194 с). Найдено и обработано пропущенных погашений: 2. Погашения наград других приложений за это время восстановить невозможно (ограничение Twitch): Привет, Звук.';
  const gapEn = tr(gap, 'en');
  assert.match(gapEn, /^There was no connection to Twitch EventSub from 12:00:01 to 12:03:15 \(194 s\)\. Missed redemptions found and processed: 2\. Redemptions of other apps’ rewards/);
  assert.match(gapEn, /Привет, Звук\.$/, 'названия наград остаются как есть');
  // предупреждения о кодеках (собираются из частей) и сообщение «браузер панели тоже не может»
  for (const tracks of [
    [{ type: 'video' as const, id: 'hvc1', name: 'H.265/HEVC', ok: false, note: 'может не воспроизводиться' }],
    [{ type: 'video' as const, id: 'mp4v', name: 'MPEG-4 Part 2', ok: false }, { type: 'audio' as const, id: 'ac-3', name: 'AC-3', ok: false }],
    [{ type: 'audio' as const, id: 'alac', name: 'ALAC', ok: false }],
    [{ type: 'video' as const, id: 'raw ', name: 'несжатое видео', ok: false }, { type: 'video' as const, id: 'avc1', name: 'H.264 High 10 (10 бит)', ok: false, note: 'неизвестный кодек' }],
  ]) {
    const w = codecWarnings(tracks)[0];
    const en = tr(w, 'en');
    assert.doesNotMatch(en, CYR, `${w} → ${en}`);
    assert.match(en, /^This file has /);
    const stripped = w.replace(/ Нажмите «Перекодировать».*$/, '');
    assert.doesNotMatch(tr(`${stripped} Браузер панели тоже не может его прочитать — перекодируйте файл бесплатной программой HandBrake в MP4 (H.264 + AAC) и загрузите заново.`, 'en'), CYR);
  }
  // неизвестный текст (название файла, награды) не трогается
  assert.equal(tr('Мой любимый мем.mp4', 'en'), 'Мой любимый мем.mp4');
});

/** Русские строки сервера, которые не являются сообщением целиком (кусок составного сообщения) или не видны в панели. */
const SERVER_FRAGMENTS = new Set([
  // части составных сообщений — проверяются целиком в тесте выше
  ' (восстановлено после разрыва)', ' Найдено и обработано пропущенных погашений: X1.', ' Погашения наград других приложений за это время восстановить невозможно (ограничение Twitch): X1X1.',
  ' Проверьте Client ID.', ' Убедитесь, что тип клиента приложения — «Public» (Общедоступный).', 'Twitch отклонил запрос входа (HTTP X1).X1',
  ' — лицензия запрещает коммерческое использование', ' Найдите этот мем во вкладке «Klipy» — он будет показываться онлайн.', 'Правила X1 запрещают сохранять их файлы.X1',
  ' Прежняя версия восстановлена.', ' Нажмите «Перекодировать» у файла в разделе «Медиа».', 'Не воспроизводится в программе для стрима: X1.X1',
  ': исходный файл заменёнX1', ', наград переключено: X1', ' — новый файл «X1»', '«X1» перекодирован в WebMX1', ' (предупреждение: X1)', 'Добавлен файл «X1»X1',
  'Добавлен звук Freesound «X1» (X1)X1', '«X1» от X1X1', ' и ', 'не воспроизводится', 'не воспроизводится со звуком', ' в OBS и Streamlabs',
  'В файле X1 — X1. Нажмите «Перекодировать» (раздел «Медиа») или сохраните файл как MP4 (H.264 + AAC).',
  'Основной файл', 'Дополнительный звук', 'X1 удалён(о) из медиатеки', // «Видео удалён(о)…» и т. п. — целиком в словаре
  'Видео', '«X1» не воспроизводится в программе для стрима.X1',
  // describeCodecs — только для отладки и тестов, в панель не уходит
  'видео X1', 'звук X1',
  // не сообщения: проверки текста в базе (startsWith/includes) и заголовок предложения на GitHub
  'Браузер не может', 'Браузер панели тоже', 'Файл', 'Идея: ',
]);
/** Файлы без сообщений для панели: технические, HTML загрузчика, сам словарь. */
const SERVER_SKIP_FILES = new Set(['i18n.ts', 'logger.ts', 'secure-store.ts', 'migrate.ts', 'overlay-loader.ts', 'main.ts']);

test('все русские сообщения сервера есть в английском словаре (кроме технического лога)', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(path.join(ROOT, 'src'));
  const missing: string[] = [];
  for (const file of files) {
    if (SERVER_SKIP_FILES.has(path.basename(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
    const inLogCall = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isCallExpression(p)) {
          const c = p.expression;
          if (ts.isPropertyAccessExpression(c) && ['info', 'warn', 'error', 'debug'].includes(c.name.text) && /log/i.test(c.expression.getText(sf))) return true;
          if (ts.isElementAccessExpression(c) && /log/i.test(c.expression.getText(sf))) return true;
        }
      }
      return false;
    };
    const visit = (n: ts.Node) => {
      let text: string | null = null;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
      else if (ts.isTemplateExpression(n)) text = n.head.text + n.templateSpans.map((s) => 'X1' + s.literal.text).join('');
      if (text !== null && CYR.test(text) && !inLogCall(n) && !text.startsWith('UPDATE ') && !SERVER_FRAGMENTS.has(text)) {
        const en = tr(text, 'en');
        if (CYR.test(en)) missing.push(`${path.relative(ROOT, file)}: ${text} → ${en}`);
      }
      if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
      else n.templateSpans.forEach((s) => visit(s.expression));
    };
    visit(sf);
  }
  assert.deepEqual(missing, [], 'нет перевода:\n' + missing.join('\n'));
});

test('localize: переводятся только поля-сообщения, названия наград и файлов не трогаются; changes_en вместо changes', () => {
  const data = {
    events: [{ id: 1, message: 'Бот запущен (версия 1.4.0)' }],
    media: [{ name: 'Звук.mp3', status_msg: 'Файл отсутствует на диске' }],
    rewards: [{ title: 'Награда не найдена', prompt: 'Тест' }],
    changelog: parseChangelog([{ version: '1.4.0', changes: ['По-русски'], changes_en: ['In English'] }, { version: '1.3.1', changes: ['Только по-русски'] }]),
  };
  const en = localize(data, 'en');
  assert.equal(en.events[0].message, 'Bot started (version 1.4.0)');
  assert.equal(en.media[0].status_msg, 'The file is missing from the disk');
  assert.equal(en.media[0].name, 'Звук.mp3');
  assert.deepEqual(en.rewards[0], { title: 'Награда не найдена', prompt: 'Тест' }, 'название награды совпадает с сообщением, но не переводится');
  assert.deepEqual(en.changelog[0].changes, ['In English']);
  assert.equal('changes_en' in en.changelog[0], false);
  assert.deepEqual(en.changelog[1].changes, ['Только по-русски'], 'старые версии без перевода — по-русски');
  assert.equal(localize(data, 'ru'), data, 'русский — без копирования');
  assert.equal(data.events[0].message, 'Бот запущен (версия 1.4.0)', 'исходные данные не меняются');
});

test('changelog.json: у каждой версии с 1.4.0 есть changes_en того же размера', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf8')) as Array<{ version: string; changes: string[]; changes_en?: string[] }>;
  const first = list[0];
  assert.ok(first.changes_en && first.changes_en.length === first.changes.length, 'у последней версии есть перевод изменений');
  for (const e of first.changes_en!) assert.doesNotMatch(e, CYR);
});

// ---------------------------------------------------------------------------------------------
// Панель: словарь
// ---------------------------------------------------------------------------------------------

function panelDictionary(): Record<string, string> {
  const ctx = vm.createContext({ window: {}, navigator: { language: 'ru-RU' }, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'panel', 'i18n.js'), 'utf8'), ctx);
  return (ctx.window as { I18N: { dictionary: Record<string, string> } }).I18N.dictionary;
}

function unescapeJs(s: string): string {
  return s.replace(/\\(n|'|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

test('панель: у каждой строки T(…) в app.js есть английский перевод с теми же подстановками', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'panel', 'app.js'), 'utf8');
  const dict = panelDictionary();
  const keys = new Set<string>();
  for (const m of app.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)) keys.add(unescapeJs(m[1]));
  // Таблицы, которые переводятся при показе: T(NAV[...]), T(STATUS_RU[...][0]) и т. п.
  for (const name of ['NAV', 'STATUS_RU', 'SOURCE_RU', 'KTYPES']) {
    const decl = new RegExp(`var ${name} = ([\\s\\S]*?);\\r?\\n`).exec(app);
    assert.ok(decl, name);
    for (const m of decl[1].matchAll(/'([^']*[А-Яа-яЁё][^']*)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.size > 450, `найдено строк: ${keys.size}`);
  const missing = [...keys].filter((k) => !(k in dict));
  assert.deepEqual(missing, [], 'нет перевода в public/panel/i18n.js');
  const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');
  for (const [ru, en] of Object.entries(dict)) {
    assert.equal(ph(en), ph(ru), `подстановки не совпадают: ${ru}`);
    assert.doesNotMatch(en, CYR, `в переводе остался русский текст: ${en}`);
  }
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  assert.deepEqual(unused, [], 'лишние строки в словаре');
});

test('панель: русские строки вне T(…) — только сообщения, которые уходят на сервер (проверка файла в браузере)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'panel', 'app.js'), 'utf8');
  const stray: string[] = [];
  app.split('\n').forEach((line, i) => {
    const code = line.replace(/\bT\('(?:[^'\\]|\\.)*'/g, 'T(\'\'').replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (CYR.test(m[1])) stray.push(`${i + 1}: ${m[1]}`);
  });
  const allowed = [/: (Language \/ Язык|Язык \/ Language)$/, /неизвестная длительность/, /превышено время проверки/, /браузер читает из файла только звук/, /^\d+: код $/, /^\d+: ошибка$/,
    /^\d+: (Главная|Награды|Медиа|Найти медиа|Настройки|Журнал|Помощь|❤ Поддержать автора)$/, // NAV
    /^\d+: (получено|в очереди|играет|воспроизведено|ошибка|пропущено|отменено|не настроено|наблюдение|пропущено \(устарело\)|восстановлено|симуляция|тест|🎬 Клипы со звуком|Стикеры)$/];
  const bad = stray.filter((s) => !allowed.some((re) => re.test(s)));
  assert.deepEqual(bad, [], 'строки без перевода в app.js');
});

test('панель: I18N.t подставляет {0}, не трогает {user}; язык браузера', () => {
  const store: Record<string, string> = {};
  const mk = (language: string) => {
    const ctx = vm.createContext({ window: {}, navigator: { languages: [language], language }, localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'panel', 'i18n.js'), 'utf8'), ctx);
    return (ctx.window as { I18N: { t: (k: string, p?: unknown[]) => string; setLang: (l: string) => void; detect: () => string; lang: () => string } }).I18N;
  };
  const I = mk('en-US');
  assert.equal(I.detect(), 'en');
  assert.equal(mk('uk-UA').detect(), 'ru');
  assert.equal(I.lang(), 'ru', 'до выбора — русский');
  assert.equal(I.t('Очередь ({0})', [3]), 'Очередь (3)');
  I.setLang('en');
  assert.equal(I.t('Очередь ({0})', [3]), 'Queue (3)');
  assert.equal(I.t('{user} — зритель, {reward} — награда, {input} — текст зрителя, {cost} — стоимость'), '{user} — viewer, {reward} — reward, {input} — viewer text, {cost} — cost');
  assert.equal(I.t('Нет такой строки'), 'Нет такой строки', 'нет перевода — русский текст');
  assert.equal(mk('ru-RU').lang(), 'en', 'выбор запоминается (тот же адрес — общее хранилище)');
});

// ---------------------------------------------------------------------------------------------
// Настройка языка, HTTP, WebSocket, overlay, загрузчик
// ---------------------------------------------------------------------------------------------

test('настройка language: проверка значения; у прежних установок — русский, у новых — не выбран', () => {
  assert.deepEqual(validateSettingsPatch({ language: 'en' }), { ok: { language: 'en' }, error: null });
  assert.match(validateSettingsPatch({ language: 'de' }).error ?? '', /Неверный язык/);
  const dir = tmpDir();
  const fresh = new Db(path.join(dir, 'new.sqlite'));
  assert.equal(fresh.getSettings().language, '', 'новая установка — язык подскажет панель');
  fresh.close();
  // база версии 1.3.x: настройки есть, языка нет
  const old = new Db(path.join(dir, 'old.sqlite'));
  old.updateSettings({ masterVolume: 70 });
  old.raw.prepare("DELETE FROM settings WHERE key = 'language'").run();
  old.close();
  const reopened = new Db(path.join(dir, 'old.sqlite'));
  assert.equal(reopened.getSettings().language, 'ru', 'кто уже пользовался ботом — остаётся русский');
  reopened.close();
});

test('смена языка без перезапуска: панель (HTTP и WebSocket), ошибки, трей, overlay и файл-загрузчик', async () => {
  const { app, port, dir } = await startApp();
  app.db.updateSettings({ clientId: CLIENT });
  let state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as { settings: { language: string }; events: Array<{ message: string }> };
  assert.equal(state.settings.language, '');
  assert.ok(state.events.some((e) => /^Бот запущен/.test(e.message)));
  assert.match(fs.readFileSync(path.join(dir, LOADER_FILE), 'utf8'), /Ждём запуска/);

  // overlay в программе для стрима и открытая панель
  const overlay = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/127 OBS/31.0.2' } });
  const views: Array<{ lang: string }> = [];
  const plays: Array<{ caption: string; visual?: { url: string } }> = [];
  overlay.on('message', (d) => { const m = JSON.parse(String(d)); if (m.view) views.push(m.view); if (m.type === 'play') plays.push(m.item); });
  await new Promise((r) => overlay.once('open', r));
  overlay.send(JSON.stringify({ type: 'hello', isObs: true, app: 'obs' }));
  const panel = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`);
  const panelMsgs: Array<Record<string, unknown>> = [];
  panel.on('message', (d) => panelMsgs.push(JSON.parse(String(d))));
  await new Promise((r) => panel.once('open', r));
  cleanup.push(() => { overlay.close(); panel.close(); });
  await waitFor(() => views.length > 0);
  assert.equal(views[0].lang, 'ru');

  const r = await api(port, 'POST', '/api/settings', { language: 'en' });
  assert.equal(r.status, 200);
  const body = await r.json() as { note: string; settings: { language: string } };
  assert.equal(body.settings.language, 'en');
  assert.equal(body.note, 'Panel language: English');
  await waitFor(() => panelMsgs.some((m) => m.type === 'invalidate' && m.what === 'language'));
  await waitFor(() => views.some((v) => v.lang === 'en'), 3000);
  assert.match(fs.readFileSync(path.join(dir, LOADER_FILE), 'utf8'), /Waiting for Twitch Alert Bot to start/);
  assert.match(fs.readFileSync(path.join(dir, LOADER_FILE), 'utf8'), /<html lang="en">/);

  // состояние: старые события переводятся, статусы — тоже
  state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as typeof state & { status: { auth: { message: string } } };
  assert.ok(state.events.some((e) => /^Bot started \(version /.test(e.message)), 'событие, записанное по-русски, показывается по-английски');
  assert.ok(state.events.every((e) => !CYR.test(e.message)), JSON.stringify(state.events.map((e) => e.message)));
  // ошибки API
  const err = await (await api(port, 'POST', '/api/rewards/nope/test')).json() as { error: string };
  assert.equal(err.error, 'Reward not found');
  const err2 = await (await api(port, 'POST', '/api/settings', { masterVolume: 500 })).json() as { error: string };
  assert.equal(err2.error, 'Value “masterVolume” must be a number from 0 to 100');
  // трей
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { language: string };
  assert.equal(health.language, 'en');
  // событие в панель через WebSocket — тоже по-английски
  app.journal('info', 'test', 'Встроенный тест оповещения');
  await waitFor(() => panelMsgs.some((m) => m.type === 'event' && (m.event as { message: string }).message === 'Built-in alert test'));
  // встроенный тест: подпись в overlay — на выбранном языке
  assert.equal((await api(port, 'POST', '/api/test')).status, 200);
  await waitFor(() => plays.length > 0);
  assert.equal(plays[0].caption, 'Test: the overlay works!');
  assert.equal(plays[0].visual?.url, '/overlay/test-alert-en.svg', 'картинка встроенного теста — с английской надписью');
  assert.equal(app.db.recentEvents(5)[0].message, 'Встроенный тест оповещения', 'в базе сообщения остаются русскими');

  // обратно на русский
  await api(port, 'POST', '/api/settings', { language: 'ru' });
  const err3 = await (await api(port, 'POST', '/api/rewards/nope/test')).json() as { error: string };
  assert.equal(err3.error, 'Награда не найдена');
  assert.match(fs.readFileSync(path.join(dir, LOADER_FILE), 'utf8'), /Ждём запуска/);
});

test('файл-загрузчик: английский текст и тот же скрипт', () => {
  const ru = loaderHtml(17420, 'ru');
  const en = loaderHtml(17420, 'en');
  assert.match(en, /"Waiting for Twitch Alert Bot to start \(port " \+ PORT/);
  assert.equal(ru.replace(/<html lang="ru">|<title>.*<\/title>|"Ждём[^"]*"/g, ''), en.replace(/<html lang="en">|<title>.*<\/title>|"Waiting[^"]*"/g, ''), 'отличается только текст');
});

test('overlay.js: строка состояния (только в браузере) переключается на язык из view.lang', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'overlay', 'overlay.js'), 'utf8');
  const status = { hidden: true, className: '', textContent: '', appendChild() {} };
  let sock: { onopen: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null } | null = null;
  class FakeWs {
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor() { sock = this; queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() {}
  }
  const ctx = vm.createContext({
    window: {}, navigator: { userAgent: 'Mozilla/5.0 Chrome/127' }, location: { search: '', protocol: 'http:', host: '127.0.0.1:17420' }, URLSearchParams,
    document: { documentElement: { lang: 'ru' }, getElementById: (id: string) => (id === 'status' ? status : { className: '', style: { setProperty() {} }, appendChild() {} }), createElement: () => ({ remove() {}, addEventListener() {} }) },
    WebSocket: FakeWs, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, Date,
  });
  vm.runInContext(src, ctx);
  await delay(0);
  assert.equal(status.textContent, 'Подключено к боту');
  sock!.onmessage!({ data: JSON.stringify({ type: 'hello', view: { position: 'center', lang: 'en' } }) });
  assert.equal(status.textContent, 'Connected to the bot');
});
