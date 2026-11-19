import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { Backoff } from '../src/backoff.ts';
import { StreamStats } from '../src/stats.ts';
import { TtsEngine, ttsText, ttsPrepare, chooseVoice, detectLang, wavDurationMs, type RunFn } from '../src/tts.ts';
import type { EventSubMessage } from '../src/twitch/eventsub.ts';
import { MockEventSub, standardTwitch, quietLogger, log, tmpDir, waitFor, redemptionEvent, json, type MockTwitch } from './helpers.ts';

// 1.7.0: озвучка текста зрителя, награды только в эфире, метки в записи, топ наград и зрителей.

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const wav = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'test-chime.wav'));
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

const TXT = { template: '{user} пишет: {text}', maxChars: 200, filter: true, bannedWords: '' };

/** Подмена PowerShell: список голосов и «синтез» (копия тестового WAV). Запоминает прочитанные тексты. */
function fakeRun(spoken: string[], opts: { fail?: boolean } = {}): RunFn {
  return async (args, stdin) => {
    if (args.includes('list')) return { code: 0, stdout: 'VOICE_RU\tMicrosoft Pavel\tru-RU\r\nVOICE_EN\tMicrosoft Zira\ten-US\r\n', stderr: '' };
    if (opts.fail) return { code: 1, stdout: '', stderr: 'synth failed' };
    spoken.push(stdin);
    fs.writeFileSync(args[args.indexOf('-Out') + 1], wav);
    return { code: 0, stdout: 'ok', stderr: '' };
  };
}

test('текст озвучки: ссылки, мат, повторы, длина, шаблон, свои запрещённые слова', () => {
  assert.equal(ttsText('cool_viewer', 'Привет https://example.com/x и www.site.ru!', TXT), 'cool viewer пишет: Привет ссылка и ссылка');
  assert.equal(ttsText('a', 'зайди на twitch.tv/someone', TXT), 'a пишет: зайди на ссылка');
  assert.equal(ttsText('a', 'ты сука и бля*ть, а ещё хуево', TXT), 'a пишет: ты пи-ип и пи-ип, а ещё пи-ип');
  assert.equal(ttsText('a', 'ты сука', { ...TXT, filter: false }), 'a пишет: ты сука');
  assert.equal(ttsText('a', 'аааааааа!!!!!!!!', TXT), 'a пишет: ааа!!!');
  assert.equal(ttsText('a', 'скажи Огурец и огурцы', { ...TXT, bannedWords: 'огурец, банан' }), 'a пишет: скажи пи-ип и огурцы');
  const long = ttsText('a', 'слово '.repeat(100), { ...TXT, maxChars: 40, template: '{text}' });
  assert.ok(long.length <= 41 && long.endsWith('…'), long);
  assert.equal(ttsText('a', '   ', TXT), '', 'пустой текст — читать нечего');
  assert.equal(ttsText('a', 'hi', { ...TXT, template: 'без текста' }), 'a: hi', 'шаблон без {text} — по умолчанию');
});

test('движок озвучки: голоса, синтез по одному, длительность WAV, очистка старых файлов', async () => {
  const dir = tmpDir();
  const spoken: string[] = [];
  const e = new TtsEngine({ dir, log, run: fakeRun(spoken) });
  assert.deepEqual(await e.voices(), [{ id: 'VOICE_RU', name: 'Microsoft Pavel', lang: 'ru-RU' }, { id: 'VOICE_EN', name: 'Microsoft Zira', lang: 'en-US' }]);
  const [a, b] = await Promise.all([e.synth('раз', 'VOICE_RU', 100), e.synth('два', 'VOICE_RU', 100)]);
  assert.match(a, /^[a-f0-9]{16}\.wav$/);
  assert.notEqual(a, b);
  assert.deepEqual(spoken, ['раз', 'два'], 'текст передаётся через stdin, по порядку');
  assert.ok(wavDurationMs(path.join(dir, a)) > 100, 'длительность по заголовку WAV');
  assert.equal(wavDurationMs(path.join(dir, 'нет.wav')), 0);
  const old = path.join(dir, b);
  fs.utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  e.cleanup(3600_000);
  assert.ok(!fs.existsSync(old) && fs.existsSync(path.join(dir, a)));
  // Голос с подозрительными символами не уходит в команду.
  const args: string[][] = [];
  const e2 = new TtsEngine({ dir, log, run: async (ar, _s) => { args.push(ar); fs.writeFileSync(ar[ar.indexOf('-Out') + 1], wav); return { code: 0, stdout: '', stderr: '' }; } });
  await e2.synth('x', 'evil"; Remove-Item C:\\', 100);
  assert.equal(args[0][args[0].indexOf('-Voice') + 1], '');
});

test('настоящий голос Windows озвучивает русский текст', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpDir();
  const e = new TtsEngine({ dir, log });
  const voices = await e.voices();
  if (!voices.length) return; // в системе нет голосов OneCore
  const name = await e.synth('Проверка голоса', '', 100);
  const file = path.join(dir, name);
  assert.equal(fs.readFileSync(file).toString('ascii', 0, 4), 'RIFF');
  assert.ok(wavDurationMs(file) > 300, `длительность ${wavDurationMs(file)}`);
});

// ---------------------------------------------------------------------------------------------
// Бот целиком
// ---------------------------------------------------------------------------------------------

interface Ctx { app: App; server: http.Server; port: number }

async function startApp(opts: { twitch?: MockTwitch; es?: MockEventSub; ttsRun?: RunFn; scopes?: string[] } = {}): Promise<Ctx> {
  const dir = tmpDir();
  const twitch = opts.twitch ?? standardTwitch();
  const store = new MemoryStore();
  store.value = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scopes: opts.scopes ?? ['channel:manage:redemptions'], userId: '1001', login: 'streamer', clientId: CLIENT });
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store, port: 0, fetchFn: twitch.fetch as typeof fetch, idBase: 'https://id.test', helixBase: 'https://api.test/helix',
    eventsubUrl: opts.es?.url ?? 'ws://127.0.0.1:1/ws', eventsubBackoff: new Backoff({ baseMs: 50, maxMs: 200 }), ttsRun: opts.ttsRun, shoutoutDelayMs: 10,
  });
  const server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  app.db.updateSettings({ clientId: CLIENT, gapBetweenMs: 0 });
  await app.start();
  await app.initialSync;
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, server, port };
}

async function overlay(port: number) {
  const plays: Array<{ id: string; audio: unknown; tts: { url: string; ms: number; volume: number } | null }> = [];
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

function statusOf(app: App, id: string) { return app.db.recentRedemptions(100).find((r) => r.id === id)?.status; }

test('бот: награда с озвучкой — текст зрителя очищается, озвучка уходит в overlay вместе со звуком; только озвучка; нет текста', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const spoken: string[] = [];
  const { app, port } = await startApp({ es, ttsRun: fakeRun(spoken) });
  app.db.upsertTwitchReward({ id: 'reward-1', title: 'Скажи', cost: 100, prompt: '', manageable: false, is_enabled: true, background_color: '', raw: {} });
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig('reward-1', { media_id: m.id, bot_enabled: 1, tts: 1 });
  app.db.updateSettings({ ttsVolume: 50 });
  const plays = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');

  es.notification({ ...redemptionEvent({ id: 'red-1', user: 'cool_viewer' }), user_input: 'Привет https://evil.example/x' });
  await waitFor(() => statusOf(app, 'red-1') === 'done');
  assert.deepEqual(spoken, ['cool viewer пишет: Привет ссылка']);
  assert.ok(plays[0].audio, 'звук награды тоже играет');
  assert.match(plays[0].tts!.url, /^\/tts\/[a-f0-9]{16}\.wav$/);
  assert.ok(plays[0].tts!.ms > 0);
  assert.equal(plays[0].tts!.volume, 0.4, 'громкость озвучки 50 % × общая 80 %');
  const f = await fetch(`http://127.0.0.1:${port}${plays[0].tts!.url}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(`http://127.0.0.1:${port}/tts/..%2Fbot.sqlite`)).status, 404);

  // Только озвучка (без медиафайла).
  app.db.updateRewardConfig('reward-1', { media_id: null });
  es.notification({ ...redemptionEvent({ id: 'red-2' }), user_input: 'второй' });
  await waitFor(() => statusOf(app, 'red-2') === 'done');
  assert.equal(plays[1].audio, null);
  assert.ok(plays[1].tts);

  // Нет ни текста, ни файла — ошибка в журнале, баллы не пропадают зря.
  es.notification({ ...redemptionEvent({ id: 'red-3' }), user_input: '' });
  await waitFor(() => statusOf(app, 'red-3') === 'failed');

  // Проверка голоса из панели.
  const r = await api(port, 'POST', '/api/tts/test', { text: 'проверка' });
  assert.equal(r.status, 200);
  await waitFor(() => plays.length === 3);
  assert.equal(spoken.at(-1), 'Тест пишет: проверка');
  const voices = await (await api(port, 'GET', '/api/tts/voices')).json() as { voices: Array<{ name: string }> };
  assert.deepEqual(voices.voices.map((v) => v.name), ['Microsoft Pavel', 'Microsoft Zira']);
  // Настройки озвучки проверяются.
  assert.equal((await api(port, 'POST', '/api/settings', { ttsTemplate: 'без текста' })).status, 400);
  assert.equal((await api(port, 'POST', '/api/settings', { ttsVoice: 'a"; rm' })).status, 400);
});

test('бот: озвучка не удалась — звук награды всё равно играет, в журнале предупреждение', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const { app, port } = await startApp({ es, ttsRun: fakeRun([], { fail: true }) });
  app.db.upsertTwitchReward({ id: 'reward-1', title: 'Скажи', cost: 100, prompt: '', manageable: false, is_enabled: true, background_color: '', raw: {} });
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig('reward-1', { media_id: m.id, bot_enabled: 1, tts: 1 });
  const plays = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  es.notification({ ...redemptionEvent({ id: 'red-1' }), user_input: 'текст' });
  await waitFor(() => statusOf(app, 'red-1') === 'done');
  assert.equal(plays[0].tts, null);
  assert.ok(app.db.recentEvents(20).some((e) => e.type === 'tts' && /Не удалось озвучить/.test(e.message)));
});

test('бот: включить озвучку у награды бота — в Twitch включается «Требовать ввод текста»', async () => {
  const twitch = standardTwitch();
  const patches: Array<Record<string, unknown>> = [];
  twitch.on('PATCH', '/channel_points/custom_rewards', (_u, init) => {
    const body = JSON.parse(String(init.body)); patches.push(body);
    return json(200, { data: [{ id: 'own', title: 'Скажи', cost: 100, prompt: '', is_enabled: true, is_paused: false, background_color: '', is_user_input_required: !!body.is_user_input_required }] });
  });
  const { app, port } = await startApp({ twitch });
  app.db.upsertTwitchReward({ id: 'own', title: 'Скажи', cost: 100, prompt: '', manageable: true, is_enabled: true, background_color: '', raw: { is_user_input_required: false } });
  assert.equal((await api(port, 'POST', '/api/rewards/own', { tts: true })).status, 200);
  assert.deepEqual(patches, [{ is_user_input_required: true }]);
  assert.equal(app.db.getReward('own')!.tts, 1);
});

function streamNotif(type: 'stream.online' | 'stream.offline'): EventSubMessage {
  return {
    metadata: { message_id: String(Math.random()), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type, subscription_version: '1' },
    payload: { event: { id: 'stream-1', broadcaster_user_id: '1001', type: 'live', started_at: new Date(Date.now() - 300_000).toISOString() } },
  } as EventSubMessage;
}

test('бот: награды только в эфире — вне эфира на паузе, в эфире снова доступны; ручную паузу и чужие награды не трогает', async () => {
  const twitch = standardTwitch();
  const patches: Array<[string, Record<string, unknown>]> = [];
  twitch.on('GET', '/streams', () => json(200, { data: [] }));
  twitch.on('PATCH', '/channel_points/custom_rewards', (u, init) => {
    const id = u.searchParams.get('id')!;
    const body = JSON.parse(String(init.body)); patches.push([id, body]);
    return json(200, { data: [{ id, title: id, cost: 100, prompt: '', is_enabled: true, is_paused: !!body.is_paused, background_color: '' }] });
  });
  const { app, port } = await startApp({ twitch });
  app.db.upsertTwitchReward({ id: 'own', title: 'own', cost: 100, prompt: '', manageable: true, is_enabled: true, background_color: '', raw: { is_paused: false } });
  app.db.upsertTwitchReward({ id: 'manual', title: 'manual', cost: 100, prompt: '', manageable: true, is_enabled: false, background_color: '', raw: { is_paused: true } });
  app.db.upsertTwitchReward({ id: 'other', title: 'other', cost: 100, prompt: '', manageable: false, is_enabled: true, background_color: '', raw: { is_paused: false } });

  await api(port, 'POST', '/api/settings', { rewardsOnlyLive: true });
  await waitFor(() => patches.length === 1);
  assert.deepEqual(patches[0], ['own', { is_paused: true }], 'эфира нет — пауза только у своей активной награды');
  assert.ok(app.db.recentEvents(20).some((e) => /награды бота на паузе/.test(e.message)));

  app.eventsub.emit('notification', streamNotif('stream.online'));
  await waitFor(() => patches.length === 2);
  assert.deepEqual(patches[1], ['own', { is_paused: false }], 'эфир начался — снимаем только свою паузу');

  app.eventsub.emit('notification', streamNotif('stream.offline'));
  await waitFor(() => patches.length === 3);
  assert.deepEqual(patches[2], ['own', { is_paused: true }]);

  // Выключили настройку — награды, поставленные ботом на паузу, возвращаются.
  await api(port, 'POST', '/api/settings', { rewardsOnlyLive: false });
  await waitFor(() => patches.length === 4);
  assert.deepEqual(patches[3], ['own', { is_paused: false }]);
  await app.queueRewardsLive(false);
  assert.equal(patches.length, 4, 'настройка выключена — больше ничего не трогаем');
});

test('бот: метка в записи — без разрешения понятная ошибка; в эфире ставится и попадает в ленту дока', async () => {
  let r = await startApp();
  let res = await api(r.port, 'POST', '/api/stats/marker');
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /Войти заново/);

  const twitch = standardTwitch({ scopes: ['channel:manage:redemptions', 'channel:manage:broadcast'] });
  let live = false;
  twitch.on('POST', '/streams/markers', (_u, init) => {
    assert.equal(JSON.parse(String(init.body)).user_id, '1001');
    return live ? json(200, { data: [{ id: 'm1', created_at: '', description: '', position_seconds: 125 }] }) : json(404, { error: 'Not Found', status: 404, message: 'user not live' });
  });
  r = await startApp({ twitch, scopes: ['channel:manage:redemptions', 'channel:manage:broadcast'] });
  res = await api(r.port, 'POST', '/api/stats/marker');
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /только во время эфира/);
  live = true;
  res = await api(r.port, 'POST', '/api/stats/marker');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { position: 125 });
  const f = r.app.stats.view().feed[0];
  assert.deepEqual([f.kind, f.n], ['marker', 125]);
});

test('топ наград и зрителей: в итогах стрима и по всей истории погашений', () => {
  const db = new Db(path.join(tmpDir(), 'bot.sqlite'));
  cleanup.push(() => db.close());
  const saved: Array<{ topRewards?: Array<[string, number]>; topUsers?: Array<[string, number]>; markers?: number[] }> = [];
  const stats = new StreamStats({
    log, helix: () => null, user: () => null, hasScope: () => false, useObs: () => false, obsConfig: () => ({ port: 1, password: '', enabled: null, fromFile: false }),
    store: { chatterVisits: () => new Map(), trackingSince: () => null, saveSummary: (s) => { saved.push(s); }, summaries: () => [] },
  });
  cleanup.push(() => stats.stop());
  stats.handleNotification(streamNotif('stream.online'));
  for (const [u, r] of [['Аня', 'Сюрприз'], ['Боря', 'Сюрприз'], ['Аня', 'Мем'], ['Аня', 'Сюрприз']]) stats.noteRedemption(u, r);
  stats.noteMarker(61);
  stats.handleNotification(streamNotif('stream.offline'));
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].topRewards, [['Сюрприз', 3], ['Мем', 1]]);
  assert.deepEqual(saved[0].topUsers, [['Аня', 3], ['Боря', 1]]);
  assert.deepEqual(saved[0].markers, [61]);

  let i = 0;
  const add = (user: string, title: string, source = 'eventsub') => db.insertRedemption({ id: `r${++i}`, reward_id: 'x', reward_title: title, user_login: user.toLowerCase(), user_name: user, user_input: '', redeemed_at: '', received_at: Date.now() - i * 1000, source, status: 'done' });
  add('Аня', 'Сюрприз'); add('Аня', 'Сюрприз'); add('Боря', 'Мем'); add('test_viewer', 'Мем', 'simulate');
  const top = db.redemptionTop(5);
  assert.equal(top.total, 4);
  assert.deepEqual(top.rewards, [['Мем', 2], ['Сюрприз', 2]]);
  assert.deepEqual(top.users, [['Аня', 2], ['Боря', 1]], 'проверочные события (симуляция) не считаются');
  assert.ok(top.since! <= Date.now());
});

test('бот: шаутаут рейдеру — автоматически после рейда и кнопкой из дока; лимит Twitch — понятное сообщение', async () => {
  const scopes = ['channel:manage:redemptions', 'moderator:manage:shoutouts'];
  const twitch = standardTwitch({ scopes });
  const calls: string[] = [];
  let limited = false;
  twitch.on('POST', '/chat/shoutouts', (u) => {
    calls.push(`${u.searchParams.get('from_broadcaster_id')}>${u.searchParams.get('to_broadcaster_id')}/${u.searchParams.get('moderator_id')}`);
    return limited ? json(429, { error: 'Too Many Requests', status: 429, message: 'cooldown' }) : new Response(null, { status: 204 });
  });
  const { app, port } = await startApp({ twitch, scopes });
  const raid = (id: string, name: string): EventSubMessage => ({
    metadata: { message_id: String(Math.random()), message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.raid', subscription_version: '1' },
    payload: { event: { from_broadcaster_user_id: id, from_broadcaster_user_name: name, to_broadcaster_user_id: '1001', viewers: 23 } },
  } as EventSubMessage);
  // Галочка выключена — рейд только в ленте, с данными для кнопки.
  app.eventsub.emit('notification', raid('3003', 'Raider'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 0);
  const f = app.stats.view().feed[0];
  assert.deepEqual([f.kind, f.uid, f.so], ['raid', '3003', undefined]);
  // Кнопка в доке.
  let res = await api(port, 'POST', '/api/stats/shoutout', { uid: '3003', name: 'Raider' });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['1001>3003/1001']);
  assert.equal(app.stats.view().feed[0].so, true, 'в ленте — отметка «сделано»');
  // Лимит Twitch: без повторов, понятное сообщение.
  limited = true;
  res = await api(port, 'POST', '/api/stats/shoutout', { uid: '3003', name: 'Raider' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /раза в 2 минуты/);
  assert.equal(calls.length, 2, 'при 429 запрос не повторяется');
  assert.equal((await api(port, 'POST', '/api/stats/shoutout', { uid: 'abc' })).status, 400);
  // Галочка включена — шаутаут сам.
  limited = false;
  await api(port, 'POST', '/api/settings', { autoShoutout: true });
  app.eventsub.emit('notification', raid('4004', 'Second'));
  await waitFor(() => calls.length === 3);
  assert.equal(calls[2], '1001>4004/1001');
  assert.ok(app.db.recentEvents(20).some((e) => e.type === 'shoutout' && /Second/.test(e.message)));
});

test('1.8.0: язык текста, голос на выбор зрителя [Павел], выбор голоса', () => {
  const o = { ...TXT, templateEn: '{user} says: {text}', viewerVoice: true };
  assert.equal(detectLang('Привет всем'), 'ru');
  assert.equal(detectLang('hello everyone'), 'en');
  assert.equal(detectLang('ok'), 'ru', 'пара латинских букв — ещё не английский');
  assert.deepEqual(ttsPrepare('Bob', 'Hello there https://x.com', o), { text: 'Bob says: Hello there ссылка', lang: 'en', alias: null });
  assert.deepEqual(ttsPrepare('Bob', 'Привет, зайди на https://example.com/very/long/path', o)!.lang, 'ru', 'латиница в ссылке не делает текст английским');
  assert.deepEqual(ttsPrepare('Bob', '[Павел] привет', o), { text: 'Bob пишет: привет', lang: 'ru', alias: 'павел' });
  assert.deepEqual(ttsPrepare('Bob', '[Павел] привет', { ...o, viewerVoice: false }), { text: 'Bob пишет: привет', lang: 'ru', alias: null }, 'выбор выключен — скобки не читаются');
  assert.equal(ttsPrepare('Bob', '[Павел]', o), null, 'только скобки — читать нечего');
  const voices = [{ id: 'IR', name: 'Microsoft Irina', lang: 'ru-RU' }, { id: 'PV', name: 'Microsoft Pavel', lang: 'ru-RU' }, { id: 'ZR', name: 'Microsoft Zira', lang: 'en-US' }];
  const s = { ttsVoice: 'IR', ttsVoiceEn: '' };
  assert.equal(chooseVoice(voices, { lang: 'ru', alias: 'павел' }, s), 'PV');
  assert.equal(chooseVoice(voices, { lang: 'ru', alias: 'pavel' }, s), 'PV');
  assert.equal(chooseVoice(voices, { lang: 'ru', alias: 'неизвестный' }, s), 'IR');
  assert.equal(chooseVoice(voices, { lang: 'en', alias: null }, s), 'ZR');
  assert.equal(chooseVoice(voices.slice(0, 2), { lang: 'en', alias: null }, s), 'IR', 'нет английского — основной');
  assert.equal(ttsText('a', 'ты чурка', TXT), 'a пишет: ты пи-ип', 'оскорбления по национальности — тоже «пи-ип»');
});

test('1.8.0: озвучку можно выключить (только медиа); кнопка «Создать награду для озвучки»', async () => {
  const twitch = standardTwitch();
  const created: Array<Record<string, unknown>> = [];
  twitch.on('POST', '/channel_points/custom_rewards', (_u, init) => {
    const b = JSON.parse(String(init.body)); created.push(b);
    return json(200, { data: [{ id: 'tts-reward', title: b.title, cost: b.cost, prompt: b.prompt, is_enabled: true, is_paused: false, background_color: '', is_user_input_required: true }] });
  });
  const spoken: string[] = [];
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const { app, port } = await startApp({ twitch, es, ttsRun: fakeRun(spoken) });
  const res = await api(port, 'POST', '/api/tts/reward', { cost: 500 });
  assert.equal(res.status, 200);
  assert.equal(created[0].cost, 500);
  assert.equal(created[0].is_user_input_required, true);
  assert.match(String(created[0].prompt), /\[Павел\]/);
  const r = app.db.getReward('tts-reward')!;
  assert.equal(r.tts, 1);
  assert.equal(r.bot_enabled, 1);
  assert.equal((await api(port, 'POST', '/api/tts/reward', { cost: 0 })).status, 400);

  // Выключили озвучку: награда только с озвучкой не играет (ошибка), с медиа — играет без озвучки.
  const plays = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  await api(port, 'POST', '/api/settings', { ttsEnabled: false });
  es.notification({ ...redemptionEvent({ id: 'red-1', rewardId: 'tts-reward' }), user_input: 'привет' });
  await waitFor(() => statusOf(app, 'red-1') === 'failed');
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig('tts-reward', { media_id: m.id });
  es.notification({ ...redemptionEvent({ id: 'red-2', rewardId: 'tts-reward' }), user_input: 'привет' });
  await waitFor(() => statusOf(app, 'red-2') === 'done');
  assert.equal(plays[0].tts, null);
  assert.deepEqual(spoken, []);
  assert.equal((app.statsPayload() as { tts: { enabled: boolean } }).tts.enabled, false, 'док видит выключатель');
});
