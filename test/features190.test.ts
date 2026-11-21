import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths, publicSettings } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { Backoff } from '../src/backoff.ts';
import { Counters, MAX_COUNTERS } from '../src/counters.ts';
import { summaryText, Telegram } from '../src/telegram.ts';
import { createBackup, prepareRestore, applyPendingRestore, takeRestoreDone, writeZip } from '../src/backup.ts';
import type { StreamSummary } from '../src/stats.ts';
import type { RunFn } from '../src/tts.ts';
import { MockEventSub, standardTwitch, quietLogger, tmpDir, waitFor, redemptionEvent, json, type MockTwitch } from './helpers.ts';

// 1.9.0: проверка текста перед озвучкой, счётчики, итоги стрима в Telegram, резервная копия.

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const TOKEN = '123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake12345';
const wav = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'test-chime.wav'));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

const fakeTts: RunFn = async (args) => {
  if (args.includes('list')) return { code: 0, stdout: 'VOICE_RU\tMicrosoft Pavel\tru-RU\r\n', stderr: '' };
  fs.writeFileSync(args[args.indexOf('-Out') + 1], wav);
  return { code: 0, stdout: 'ok', stderr: '' };
};

interface Ctx { app: App; server: http.Server; port: number; restarts: number[]; dir: string }
async function startApp(opts: { twitch?: MockTwitch; es?: MockEventSub; dir?: string } = {}): Promise<Ctx> {
  const dir = opts.dir ?? tmpDir();
  const twitch = opts.twitch ?? standardTwitch();
  const store = new MemoryStore();
  store.value = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scopes: ['channel:manage:redemptions'], userId: '1001', login: 'streamer', clientId: CLIENT });
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store, port: 0, fetchFn: twitch.fetch as typeof fetch, idBase: 'https://id.test', helixBase: 'https://api.test/helix',
    eventsubUrl: opts.es?.url ?? 'ws://127.0.0.1:1/ws', eventsubBackoff: new Backoff({ baseMs: 50, maxMs: 200 }), ttsRun: fakeTts, telegramBase: 'https://tg.test',
  });
  const restarts: number[] = [];
  const server = createServer(app, { onShutdown: () => {}, onRestart: () => restarts.push(Date.now()) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  app.db.updateSettings({ clientId: CLIENT, gapBetweenMs: 0 });
  await app.start();
  await app.initialSync;
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, server, port, restarts, dir };
}

async function overlay(port: number) {
  const plays: Array<{ id: string; audio: unknown; tts: unknown }> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}`, 'User-Agent': 'Mozilla/5.0 OBS/33.0.1' } });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'play') { plays.push(m.item); setTimeout(() => ws.send(JSON.stringify({ type: 'ended', id: m.item.id })), 20); }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', isObs: true }));
  cleanup.push(() => ws.terminate());
  return plays;
}

const api = (port: number, method: string, p: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, {
  method, headers: { 'x-tab-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const statusOf = (app: App, id: string) => app.db.recentRedemptions(100).find((r) => r.id === id)?.status;

// ---------------------------------------------------------------------------------------------
// Проверка текста перед озвучкой
// ---------------------------------------------------------------------------------------------

test('проверка текста: «всегда» — текст ждёт решения, «Озвучить» / «Без озвучки» / «Отклонить» (баллы возвращаются)', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const twitch = standardTwitch();
  const refunds: string[] = [];
  twitch.on('PATCH', '/channel_points/custom_rewards/redemptions', (url, init) => { refunds.push(`${url.searchParams.get('id')}:${JSON.parse(String(init.body)).status}`); return json(200, { data: [{}] }); });
  const { app, port } = await startApp({ es, twitch });
  app.db.upsertTwitchReward({ id: 'reward-1', title: 'Скажи', cost: 100, prompt: '', manageable: true, is_enabled: true, background_color: '', raw: {} });
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig('reward-1', { media_id: m.id, bot_enabled: 1, tts: 1 });
  app.db.updateSettings({ ttsReview: 'all' });
  const plays = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');

  const ev = (id: string, user: string, text: string) => ({ ...redemptionEvent({ id, user, title: 'Скажи' }), user_input: text });
  es.notification(ev('r-voice', 'viewer_a', 'привет всем'));
  await waitFor(() => app.queue.snapshot().held.length === 1);
  assert.equal(statusOf(app, 'r-voice'), 'held');
  const held = app.queue.snapshot().held[0];
  assert.match(held.text, /viewer a пишет: привет всем/);
  assert.equal(held.hasMedia, true);
  assert.equal(plays.length, 0, 'пока стример не решил — ничего не играет');
  // Док видит список в данных статистики.
  assert.equal((app.statsPayload().queue as { held: unknown[] }).held.length, 1);

  let r = await api(port, 'POST', '/api/queue/held/r-voice/voice');
  assert.equal(r.status, 200);
  await waitFor(() => plays.length === 1);
  assert.ok(plays[0].tts, 'одобренный текст озвучен');
  await waitFor(() => statusOf(app, 'r-voice') === 'done');

  es.notification(ev('r-mute', 'viewer_b', 'текст'));
  await waitFor(() => app.queue.snapshot().held.length === 1);
  await api(port, 'POST', '/api/queue/held/r-mute/mute');
  await waitFor(() => plays.length === 2);
  assert.equal(plays[1].tts, null, 'без озвучки — только звук награды');
  assert.ok(plays[1].audio);

  es.notification(ev('r-reject', 'viewer_c', 'плохой текст'));
  await waitFor(() => app.queue.snapshot().held.length === 1);
  r = await api(port, 'POST', '/api/queue/held/r-reject/reject');
  assert.equal(r.status, 200);
  await waitFor(() => statusOf(app, 'r-reject') === 'skipped');
  await waitFor(() => refunds.includes('r-reject:CANCELED'));
  assert.equal(plays.length, 2, 'отклонённое не играет');
  r = await api(port, 'POST', '/api/queue/held/r-reject/voice');
  assert.equal(r.status, 400, 'решение по тексту принимается один раз');
  r = await api(port, 'POST', '/api/queue/held/x/hack');
  assert.equal(r.status, 400);
});

test('проверка текста: «только новые» — зритель, чей текст уже озвучивали, не ждёт; без медиа «Без озвучки» = отклонить', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const { app, port } = await startApp({ es });
  app.db.upsertTwitchReward({ id: 'reward-1', title: 'Скажи', cost: 100, prompt: '', manageable: false, is_enabled: true, background_color: '', raw: {} });
  app.db.updateRewardConfig('reward-1', { bot_enabled: 1, tts: 1 });
  app.db.updateSettings({ ttsReview: 'new' });
  const plays = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  const ev = (id: string, user: string) => ({ ...redemptionEvent({ id, user, title: 'Скажи' }), user_input: 'привет' });

  es.notification(ev('n1', 'newbie'));
  await waitFor(() => app.queue.snapshot().held.length === 1);
  app.decideHeld('n1', 'voice');
  await waitFor(() => statusOf(app, 'n1') === 'done');
  es.notification(ev('n2', 'newbie'));
  await waitFor(() => statusOf(app, 'n2') === 'done');
  assert.equal(plays.length, 2, 'второй раз — без проверки');

  es.notification(ev('n3', 'other'));
  await waitFor(() => app.queue.snapshot().held.length === 1);
  assert.equal(app.queue.snapshot().held[0].hasMedia, false);
  app.decideHeld('n3', 'mute');
  await waitFor(() => statusOf(app, 'n3') === 'skipped');
  assert.equal(app.queue.snapshot().held.length, 0);

  // Выключенная проверка — как раньше.
  app.db.updateSettings({ ttsReview: 'off' });
  es.notification(ev('n4', 'third'));
  await waitFor(() => statusOf(app, 'n4') === 'done');
  // Тест награды из панели проверку не проходит.
  app.db.updateSettings({ ttsReview: 'all' });
  assert.equal(app.router.test('reward-1').ok, true);
  assert.equal(app.queue.snapshot().held.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Счётчики
// ---------------------------------------------------------------------------------------------

test('счётчики: добавить, +1/−1, значение, «на экране», удалить; хранятся в базе; ограничения', () => {
  let saved: string | null = null;
  const store = { load: () => saved, save: (j: string) => { saved = j; } };
  const c = new Counters(store);
  const a = c.add('  Смерти\n ');
  assert.equal(a.name, 'Смерти');
  c.update(a.id, { delta: 1 }); c.update(a.id, { delta: 1 }); c.update(a.id, { delta: -1 });
  assert.equal(c.all()[0].value, 1);
  c.update(a.id, { value: 42, show: false, name: 'Победы' });
  assert.deepEqual(new Counters(store).all(), [{ id: a.id, name: 'Победы', value: 42, show: false }], 'читается из базы заново');
  assert.throws(() => c.add('   '), /название/);
  assert.throws(() => c.update('нет', { delta: 1 }), /не найден/);
  assert.throws(() => c.update(a.id, { value: 'abc' }), /числом/);
  c.update(a.id, { value: 1e15 });
  assert.equal(c.all()[0].value, 1_000_000_000, 'огромные числа ограничены');
  for (let i = 1; i < MAX_COUNTERS; i++) c.add(`c${i}`);
  assert.throws(() => c.add('лишний'), /не больше/);
  assert.equal(c.remove(a.id), true);
  assert.equal(c.remove(a.id), false);
  assert.equal(new Counters({ load: () => '{битый json', save: () => {} }).all().length, 0);
});

test('счётчики через API: док и экран получают изменения, страница и файл для OBS', async () => {
  const { app, port, dir } = await startApp();
  const statsMsgs: Array<{ counters: Array<{ name: string; value: number }> }> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stats`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'stats') statsMsgs.push(m); });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  cleanup.push(() => ws.terminate());

  let r = await api(port, 'POST', '/api/counters', { name: 'Смерти' });
  assert.equal(r.status, 200);
  const c = await r.json() as { id: string };
  r = await api(port, 'POST', `/api/counters/${c.id}`, { delta: 1 });
  assert.equal((await r.json() as { value: number }).value, 1);
  await waitFor(() => statsMsgs.some((m) => m.counters?.[0]?.value === 1));
  r = await api(port, 'POST', '/api/counters', { name: '' });
  assert.equal(r.status, 400);
  assert.deepEqual((await (await api(port, 'GET', '/api/counters')).json() as { counters: unknown[] }).counters.length, 1);
  assert.equal(app.statsPayload().counterOverlay && (app.statsPayload().counterOverlay as { style: string }).style, 'dark');

  r = await fetch(`http://127.0.0.1:${port}/stats/counter`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /counter\.js/);
  const loader = fs.readFileSync(path.join(dir, 'counter-overlay.html'), 'utf8');
  assert.match(loader, /\/stats\/counter\?via=file/);
  const st = await (await api(port, 'GET', '/api/stats')).json() as { setup: { counterLoader: string; counterUrl: string } };
  assert.ok(st.setup.counterLoader.endsWith('counter-overlay.html'));
  assert.match(st.setup.counterUrl, /\/stats\/counter$/);

  r = await api(port, 'POST', `/api/counters/${c.id}/delete`);
  assert.equal((await r.json() as { removed: boolean }).removed, true);
});

// ---------------------------------------------------------------------------------------------
// Итоги в Telegram
// ---------------------------------------------------------------------------------------------

const SUMMARY: StreamSummary = {
  id: 's1', startedAt: Date.parse('2026-11-20T18:00:00'), endedAt: Date.parse('2026-11-20T21:12:05'), title: 'Стрим', game: 'Игра',
  peakViewers: 40, avgViewers: 25, followers: 2, followerNames: ['fan1', 'fan2'], subs: 1, resubs: 1, subNames: ['sub1'], gifts: 3,
  raids: [{ name: 'Raider', viewers: 12 }], chatters: 30, newChatters: 1, newChatterNames: ['new1'], redemptions: 7,
  markers: [65], topRewards: [['Звук', 4]], topUsers: [['fan1', 3]],
};

test('итоги для Telegram: понятный текст на русском и английском, ники как есть', () => {
  const ru = summaryText(SUMMARY, 'ru');
  assert.match(ru, /^📺 Итоги стрима · 20 ноября · 3:12:05\nСтрим — Игра\n/);
  assert.match(ru, /👁 Зрители: в среднем 25, пик 40/);
  assert.match(ru, /❤ Новые фолловеры: \+2\n {3}fan1, fan2/);
  assert.match(ru, /⭐ Подписки: \+1, продлений 1, подарено 3/);
  assert.match(ru, /💬 В чате было: 30, впервые: 1/);
  assert.match(ru, /🚀 Рейды: Raider \(12\)/);
  assert.match(ru, /Чаще всего: «Звук» ×4/);
  assert.match(ru, /📍 Метки в записи: 0:01:05/);
  const en = summaryText({ ...SUMMARY, avgViewers: null, chatters: null }, 'en');
  assert.match(en, /^📺 Stream summary · November 20 · 3:12:05/);
  assert.match(en, /👁 Viewers: peak 40/);
  assert.match(en, /⭐ Subs: \+1, 1 resubs, 3 gifted/);
  assert.doesNotMatch(en, /In chat/, 'нет права на чат — строки нет');
  assert.doesNotMatch(en.replace(/Стрим — Игра|Звук/g, ''), /[А-Яа-яЁё]/);
});

function telegramMock() {
  const t = standardTwitch();
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextId = 100;
  const rec = (method: string) => (_u: URL, init: RequestInit) => { sent.push({ method, body: JSON.parse(String(init.body)) }); return json(200, { ok: true, result: { message_id: nextId++ } }); };
  t.on('POST', '/sendMessage', rec('send'));
  t.on('POST', '/editMessageText', rec('edit'));
  t.on('POST', '/getUpdates', () => json(200, { ok: true, result: [
    { update_id: 1, message: { chat: { id: 555, type: 'private', first_name: 'Стример' } } },
    { update_id: 2, channel_post: { chat: { id: -1001, type: 'channel', title: 'Мой канал' } } },
    { update_id: 3, message: { chat: { id: 555, type: 'private', first_name: 'Стример' } } },
  ] }));
  return { t, sent };
}

test('Telegram: токен зашифрован, «Найти чат», проверка, итоги после стрима и правка после короткого обрыва', async () => {
  const { t, sent } = telegramMock();
  const { app, port } = await startApp({ twitch: t });
  let r = await api(port, 'POST', '/api/settings', { telegramToken: 'плохой' });
  assert.equal(r.status, 400);
  r = await api(port, 'POST', '/api/settings', { telegramToken: TOKEN });
  assert.equal(r.status, 200);
  assert.ok(String(app.db.rawSetting('telegramToken')).startsWith('enc:'), 'в базе — зашифрован');
  assert.equal(publicSettings(app.db.getSettings()).telegramToken, '••••2345');
  assert.ok(!app.db.recentEvents(20).some((e) => e.message.includes(TOKEN)), 'токен не попадает в журнал');

  r = await api(port, 'POST', '/api/telegram/test');
  assert.equal(r.status, 400, 'чат не выбран');
  r = await api(port, 'POST', '/api/telegram/chats');
  const chats = (await r.json() as { chats: Array<{ id: string; title: string }> }).chats;
  assert.deepEqual(chats.map((c) => c.id), ['555', '-1001']);
  assert.equal(chats[1].title, 'Мой канал');
  r = await api(port, 'POST', '/api/settings', { telegramChatId: '555' });
  assert.equal(r.status, 200);
  assert.equal((await api(port, 'POST', '/api/settings', { telegramChatId: 'abc' })).status, 400);

  r = await api(port, 'POST', '/api/telegram/test');
  assert.equal(r.status, 200);
  assert.equal(sent.at(-1)!.body.chat_id, '555');
  assert.match(String(sent.at(-1)!.body.text), /Twitch Alert Bot подключён/);

  // Выключено — после стрима ничего не отправляется.
  const before = sent.length;
  await app.sendSummaryToTelegram(SUMMARY, false);
  assert.equal(sent.length, before);
  app.db.updateSettings({ telegramEnabled: true });
  await app.sendSummaryToTelegram(SUMMARY, false);
  assert.equal(sent.at(-1)!.method, 'send');
  assert.match(String(sent.at(-1)!.body.text), /Итоги стрима/);
  // Тот же стрим продолжился и закончился снова — сообщение правится, а не дублируется.
  await app.sendSummaryToTelegram({ ...SUMMARY, followers: 5 }, false);
  assert.equal(sent.at(-1)!.method, 'edit');
  assert.equal(sent.at(-1)!.body.message_id, 101);
  assert.match(String(sent.at(-1)!.body.text), /\+5/);
  assert.ok(app.db.recentEvents(20).some((e) => e.message === 'Итоги стрима отправлены в Telegram'));
});

test('Telegram: понятные ошибки (неверный токен, бот не может писать, нет связи), адрес с токеном не в журнале', async () => {
  const resp = (code: number, desc: string) => (async () => json(code, { ok: false, error_code: code, description: desc })) as unknown as typeof fetch;
  await assert.rejects(new Telegram({ fetchFn: resp(401, 'Unauthorized') }).send(TOKEN, '1', 'x'), /не принял токен/);
  await assert.rejects(new Telegram({ fetchFn: resp(403, 'Forbidden: bot was blocked by the user') }).send(TOKEN, '1', 'x'), /Запустить/);
  await assert.rejects(new Telegram({ fetchFn: resp(400, 'Bad Request: chat not found') }).send(TOKEN, '1', 'x'), /Найти чат/);
  await assert.rejects(new Telegram({ fetchFn: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }).send(TOKEN, '1', 'x'), /VPN/);
  await new Telegram({ fetchFn: resp(400, 'Bad Request: message is not modified') }).edit(TOKEN, '1', 5, 'x'); // не ошибка

  const t = standardTwitch();
  t.on('POST', '/sendMessage', () => json(403, { ok: false, error_code: 403, description: 'Forbidden' }));
  const { app } = await startApp({ twitch: t });
  await app.saveSecret('telegramToken', TOKEN);
  app.db.updateSettings({ telegramEnabled: true, telegramChatId: '555' });
  await assert.rejects(app.sendSummaryToTelegram(SUMMARY, false));
  const ev = app.db.recentEvents(10).find((e) => e.type === 'telegram')!;
  assert.match(ev.message, /^Итоги стрима не отправлены в Telegram: Бот не может писать/);
  assert.ok(!ev.message.includes(TOKEN));
});

// ---------------------------------------------------------------------------------------------
// Резервная копия
// ---------------------------------------------------------------------------------------------

test('резервная копия: скачать из панели, восстановить на «другом компьютере» — награды, медиа, счётчики на месте', async () => {
  const { app, port, dir } = await startApp();
  app.db.upsertTwitchReward({ id: 'reward-1', title: 'Звук', cost: 100, prompt: '', manageable: false, is_enabled: true, background_color: '', raw: {} });
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig('reward-1', { media_id: m.id, bot_enabled: 1, volume: 55 });
  app.counters.add('Смерти');
  app.db.updateSettings({ masterVolume: 33 });
  fs.writeFileSync(path.join(app.opts.paths.mediaDir, 'посторонний.txt'), 'x');

  let r = await api(port, 'POST', '/api/backup/create');
  assert.equal(r.status, 200);
  const made = await r.json() as { name: string; size: number; files: number };
  assert.match(made.name, /^TwitchAlertBot-backup-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);
  assert.equal(made.files, 1, 'только файлы медиатеки');
  r = await api(port, 'GET', `/api/backup/download/${made.name}`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('content-disposition')), /attachment/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.length, made.size);
  assert.equal((await api(port, 'GET', '/api/backup/download/..%2Fbot.sqlite')).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/backup/download/${made.name}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'чужой сайт не скачает копию');
  const list = await (await api(port, 'GET', '/api/backup/list')).json() as { backups: Array<{ name: string }> };
  assert.deepEqual(list.backups.map((b) => b.name), [made.name]);
  assert.ok(fs.existsSync(path.join(dir, 'backups', made.name)));

  // «Другой компьютер»: чистая папка данных, архив загружается через панель.
  const other = await startApp();
  other.app.db.updateSettings({ masterVolume: 90 });
  r = await fetch(`http://127.0.0.1:${other.port}/api/backup/restore`, { method: 'PUT', headers: { 'x-tab-request': '1', 'content-type': 'application/zip' }, body: zip });
  assert.equal(r.status, 200, await r.clone().text());
  const res = await r.json() as { restarting: boolean; mediaFiles: number; version: string };
  assert.equal(res.restarting, true);
  assert.equal(res.mediaFiles, 1);
  await waitFor(() => other.restarts.length === 1);
  const before = fs.readdirSync(path.join(other.dir, 'backups')).filter((n) => n.startsWith('TwitchAlertBot-before-restore-'));
  assert.equal(before.length, 1, 'текущие данные сохранены перед восстановлением');
  assert.ok(!fs.readdirSync(path.join(other.dir, 'backups')).some((n) => n.startsWith('upload-')), 'загруженный файл удалён');

  // Перезапуск: бот останавливается, при запуске файлы меняются местами.
  await other.app.stop();
  const paths = makePaths(other.dir);
  const info = applyPendingRestore(paths.dataDir, paths.dbFile, paths.mediaDir);
  assert.equal(info?.mediaFiles, 1);
  const db = new Db(paths.dbFile);
  try {
    assert.equal(db.getReward('reward-1')?.volume, 55);
    assert.equal(db.getSettings().masterVolume, 33);
    assert.match(db.getMeta('counters') ?? '', /Смерти/);
    assert.ok(fs.existsSync(path.join(paths.mediaDir, path.basename(app.media.filePath(m)!))));
  } finally { db.close(); }
  assert.ok(fs.existsSync(path.join(other.dir, 'restore-previous', 'bot.sqlite')), 'прежняя база сохранена');
  assert.equal(takeRestoreDone(other.dir)?.mediaFiles, 1);
  assert.equal(takeRestoreDone(other.dir), null, 'запись в журнал — один раз');
  assert.equal(applyPendingRestore(paths.dataDir, paths.dbFile, paths.mediaDir), null, 'повторно не применяется');
});

test('восстановление: чужой архив, копия новой версии, испорченный архив и пути «../» — отказ, данные не трогаются', () => {
  const dir = tmpDir();
  const paths = makePaths(dir);
  const db = new DatabaseSync(path.join(dir, 'src.sqlite'));
  db.exec(`CREATE TABLE settings (k); CREATE TABLE rewards (k); CREATE TABLE media (k);`);
  db.close();
  const zip = (name: string, entries: Array<{ name: string; data?: Buffer; file?: string }>) => { const f = path.join(dir, name); writeZip(f, entries); return f; };
  const man = (o: Record<string, unknown>) => ({ name: 'backup.json', data: Buffer.from(JSON.stringify(o)) });
  const dbEntry = { name: 'bot.sqlite', file: path.join(dir, 'src.sqlite') };

  assert.throws(() => prepareRestore(zip('a.zip', [{ name: 'readme.txt', data: Buffer.from('x') }]), dir, '1.9.0'), /не резервная копия/);
  assert.throws(() => prepareRestore(zip('b.zip', [man({ app: 'other' }), dbEntry]), dir, '1.9.0'), /не резервная копия/);
  assert.throws(() => prepareRestore(zip('c.zip', [man({ app: 'twitch-alert-bot', version: '2.0.0' }), dbEntry]), dir, '1.9.0'), /более новой версией/);
  assert.throws(() => prepareRestore(zip('d.zip', [man({ app: 'twitch-alert-bot', version: '1.8.0' }), { name: 'bot.sqlite', data: Buffer.from('не база') }]), dir, '1.9.0'), /повреждена/);
  const bad = path.join(dir, 'e.zip');
  fs.writeFileSync(bad, Buffer.from('это не zip'));
  assert.throws(() => prepareRestore(bad, dir, '1.9.0'), /не ZIP/);
  // Порченый байт данных — контрольная сумма.
  const okZip = zip('f.zip', [man({ app: 'twitch-alert-bot', version: '1.8.0', createdAt: 1 }), dbEntry, { name: 'media/11111111-2222-3333-4444-555555555555.wav', data: wav }]);
  const broken = Buffer.from(fs.readFileSync(okZip));
  broken[broken.indexOf(Buffer.from('RIFF')) + 20] ^= 0xff;
  fs.writeFileSync(path.join(dir, 'g.zip'), broken);
  assert.throws(() => prepareRestore(path.join(dir, 'g.zip'), dir, '1.9.0'), /контрольная сумма/);
  assert.ok(!fs.existsSync(path.join(dir, 'restore-pending')), 'после ошибки ничего не остаётся');

  // Лишние и опасные пути не распаковываются; нормальная копия готовится.
  const evil = zip('h.zip', [man({ app: 'twitch-alert-bot', version: '1.8.0', createdAt: 1 }), dbEntry,
    { name: '../evil.txt', data: Buffer.from('x') }, { name: 'media/../../evil2.txt', data: Buffer.from('x') }, { name: 'tokens.dpapi', data: Buffer.from('x') },
    { name: 'media/11111111-2222-3333-4444-555555555555.wav', data: wav }]);
  const info = prepareRestore(evil, dir, '1.9.0');
  assert.equal(info.mediaFiles, 1);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil2.txt')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'restore-pending')).sort(), ['backup.json', 'bot.sqlite', 'media', 'ready.json']);
  assert.ok(fs.existsSync(paths.mediaDir));
});

test('резервная копия большой медиатеки пишется потоком и читается без загрузки в память; старые копии удаляются', () => {
  const dir = tmpDir();
  const paths = makePaths(dir);
  const big = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
  fs.writeFileSync(path.join(paths.mediaDir, 'aaaaaaaa-2222-3333-4444-555555555555.mp4'), big);
  const db = new Db(paths.dbFile);
  try {
    const first = createBackup({ db: db.raw, dataDir: dir, mediaDir: paths.mediaDir, version: '1.9.0' });
    for (let i = 0; i < 6; i++) {
      const name = `TwitchAlertBot-backup-2020-01-0${i + 1}-000000.zip`;
      fs.copyFileSync(path.join(dir, 'backups', first.name), path.join(dir, 'backups', name));
    }
    createBackup({ db: db.raw, dataDir: dir, mediaDir: paths.mediaDir, version: '1.9.0' });
    const left = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('TwitchAlertBot-backup-'));
    assert.equal(left.length, 5, 'хранятся последние 5 копий');
    const info = prepareRestore(path.join(dir, 'backups', first.name), dir, '1.9.0');
    assert.equal(info.mediaFiles, 1);
    assert.ok(fs.readFileSync(path.join(dir, 'restore-pending', 'media', 'aaaaaaaa-2222-3333-4444-555555555555.mp4')).equals(big));
  } finally { db.close(); }
});
