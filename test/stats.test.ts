import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { App } from '../src/app.ts';
import { makePaths, validateSettingsPatch } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { obsAuthString, readObsWsConfig, ObsClient } from '../src/obs-ws.ts';
import { StreamStats, STATS_SCOPES, type StreamSummary } from '../src/stats.ts';
import { Db } from '../src/db.ts';
import { HelixClient } from '../src/twitch/helix.ts';
import { loaderHtml, STATS_DOCK_FILE, STATS_OVERLAY_FILE } from '../src/overlay-loader.ts';
import type { EventSubMessage } from '../src/twitch/eventsub.ts';
import { standardTwitch, json, quietLogger, log, tmpDir, waitFor, type MockTwitch } from './helpers.ts';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

// ---------------------------------------------------------------------------------------------
// Мок OBS WebSocket 5
// ---------------------------------------------------------------------------------------------

class MockObs {
  wss: WebSocketServer;
  port = 0;
  password: string | null;
  bytes = 0;
  skipped = 0;
  total = 0;
  streaming = true;
  /** Кадров в секунду на всех дорожках вместе (0 — по 12 кадров за опрос). */
  framesPerSec = 0;
  t0 = Date.now();
  durationMs = 65_000;
  identified = 0;
  inputs: Array<{ name: string; kind: string; muted: boolean; volume: number; active: boolean }> = [];
  requests: string[] = [];
  sockets: WebSocket[] = [];
  constructor(password: string | null) {
    this.password = password;
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const salt = 'c2FsdA==', challenge = 'Y2hhbGxlbmdl';
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, ...(this.password !== null ? { authentication: { salt, challenge } } : {}) } }));
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as { op: number; d: Record<string, unknown> };
        if (m.op === 1) {
          if (this.password !== null && m.d.authentication !== obsAuthString(this.password, salt, challenge)) { ws.close(4009, 'auth'); return; }
          this.identified++;
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        } else if (m.op === 6) {
          const type = String(m.d.requestType);
          this.requests.push(type);
          let data: Record<string, unknown> = {};
          if (type === 'GetVideoSettings') data = { fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 };
          if (type === 'GetStreamStatus') {
            if (this.streaming) { this.bytes += 750_000; this.total = this.framesPerSec ? Math.round(((Date.now() - this.t0) * this.framesPerSec) / 1000) : this.total + 12; } // ≈ 6000 кбит/с при опросе раз в секунду
            data = { outputActive: this.streaming, outputReconnecting: false, outputDuration: this.durationMs, outputBytes: this.bytes, outputSkippedFrames: this.skipped, outputTotalFrames: this.total, outputCongestion: 0 };
          }
          const inp = this.inputs.find((i) => i.name === (m.d.requestData as { inputName?: string; sourceName?: string } | undefined)?.inputName
            || i.name === (m.d.requestData as { sourceName?: string } | undefined)?.sourceName);
          if (type === 'GetInputList') data = { inputs: this.inputs.map((i) => ({ inputName: i.name, inputKind: i.kind, unversionedInputKind: i.kind })) };
          if (type === 'GetInputMute' && inp) data = { inputMuted: inp.muted };
          if (type === 'GetInputVolume' && inp) data = { inputVolumeMul: inp.volume, inputVolumeDb: 0 };
          if (type === 'GetSourceActive' && inp) data = { videoActive: inp.active, videoShowing: inp.active };
          if (type === 'GetStats') data = { cpuUsage: 12.5, memoryUsage: 300, activeFps: 60, renderSkippedFrames: 0, renderTotalFrames: this.total };
          ws.send(JSON.stringify({ op: 7, d: { requestType: type, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData: data } }));
        }
      });
    });
  }
  static async start(password: string | null): Promise<MockObs> {
    const m = new MockObs(password);
    await new Promise<void>((r) => m.wss.once('listening', () => r()));
    m.port = (m.wss.address() as AddressInfo).port;
    return m;
  }
  event(eventType: string, eventData: Record<string, unknown>): void {
    for (const s of this.sockets) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 64, eventData } }));
  }
  close(): Promise<void> { for (const s of this.sockets) s.terminate(); return new Promise((r) => this.wss.close(() => r())); }
}

test('пароль OBS WebSocket: пример из документации obs-websocket', () => {
  assert.equal(obsAuthString('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='), '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
});

test('настройки сервера WebSocket читаются из папки OBS; нет файла — null', () => {
  const dir = tmpDir();
  assert.equal(readObsWsConfig(dir), null);
  fs.mkdirSync(path.join(dir, 'plugin_config', 'obs-websocket'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify({ server_enabled: false, server_port: 4466, server_password: 'pw123', auth_required: true }));
  assert.deepEqual(readObsWsConfig(dir), { port: 4466, password: 'pw123', enabled: false, authRequired: true });
});

test('OBS: вход по паролю, битрейт, разрешение, потери кадров; начало эфира в OBS обнуляет счётчики сессии', async () => {
  const obs = await MockObs.start('secret-pass');
  cleanup.push(() => obs.close());
  const stats = new StreamStats({
    log, helix: () => null, user: () => null, hasScope: () => false, useObs: () => true,
    obsConfig: () => ({ port: obs.port, password: 'secret-pass', enabled: true, fromFile: true }), obsPollMs: 100, idleStopMs: 50, resumeMs: 0,
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => stats.view().obs.bitrateHistory.length >= 3, 5000);
  const v = stats.view();
  assert.equal(v.obs.state, 'ok');
  assert.equal(v.obs.streaming, true);
  assert.equal(v.live, true, 'OBS транслирует — значит, в эфире');
  assert.equal(v.sessionSource, 'obs');
  assert.ok(Math.abs(Date.now() - 65_000 - v.sessionStart!) < 2000, 'начало эфира = сейчас − длительность из OBS');
  assert.equal(v.obs.height, 1080);
  assert.equal(v.obs.fps, 60);
  assert.ok(v.obs.bitrateKbps! > 1000, `битрейт ${v.obs.bitrateKbps}`);
  assert.equal(v.obs.health, 'good');
  // Потери кадров → предупреждение.
  obs.skipped = obs.total; // 100 % потерь в окне
  await waitFor(() => stats.view().obs.health === 'bad', 5000);
  assert.equal(stats.view().obs.healthReason, 'dropped');
  // Конец эфира.
  obs.streaming = false;
  await waitFor(() => stats.view().obs.streaming === false, 5000);
  assert.equal(stats.view().obs.bitrateKbps, null);
  assert.equal(stats.view().obs.health, null);
  // Новый эфир в OBS: счётчики сессии с нуля.
  stats.handleNotification(notif('channel.follow', { user_name: 'A' }));
  assert.equal(stats.view().followersSession, 1);
  obs.event('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  await waitFor(() => stats.view().followersSession === 0, 3000);
  // Никто не смотрит — отключаемся.
  stats.setClients(0);
  await waitFor(() => !stats.isActive && stats.obs.state === 'off', 3000);
});

test('OBS: «Расширенная трансляция» (несколько дорожек) не завышает время эфира; начало эфира — по событию OBS', async () => {
  const obs = await MockObs.start(null);
  cleanup.push(() => obs.close());
  // 60 + 60 + 60 + 30 FPS = 210 кадров/с при FPS сцены 60 → OBS считает длительность в 3,5 раза больше.
  obs.framesPerSec = 210;
  const real = 6 * 3600_000 + 16 * 60_000;
  obs.durationMs = Math.round(real * 3.5);
  const stats = new StreamStats({
    log, helix: () => null, user: () => null, hasScope: () => false, useObs: () => true,
    obsConfig: () => ({ port: obs.port, password: '', enabled: true, fromFile: true }), obsPollMs: 300, idleStopMs: 50,
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => { const v = stats.view(); return v.sessionStart !== null && Math.abs(Date.now() - real - v.sessionStart) < 60_000; }, 10_000);
  assert.equal(stats.view().sessionSource, 'obs');
  // Эфир начался при открытом доке — время считается от этого момента.
  obs.event('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  await waitFor(() => Math.abs(Date.now() - stats.view().sessionStart!) < 3000, 3000);
});

test('OBS: микрофон выключен / громкость / не в эфире / тишина — по данным OBS; системный звук не считается микрофоном', async () => {
  const obs = await MockObs.start(null);
  cleanup.push(() => obs.close());
  obs.inputs = [
    { name: 'Mic/Aux', kind: 'wasapi_input_capture', muted: true, volume: 1, active: true },
    { name: 'Desktop Audio', kind: 'wasapi_output_capture', muted: true, volume: 1, active: true },
    { name: 'Old mic', kind: 'wasapi_input_capture', muted: false, volume: 0, active: false },
  ];
  const stats = new StreamStats({
    log, helix: () => null, user: () => null, hasScope: () => false, useObs: () => true,
    obsConfig: () => ({ port: obs.port, password: '', enabled: true, fromFile: true }), obsPollMs: 100, idleStopMs: 50,
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => stats.view().obs.mics.length === 2, 5000);
  const mics = () => Object.fromEntries(stats.view().obs.mics.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(mics()).sort(), ['Mic/Aux', 'Old mic'], 'системный звук — не микрофон');
  assert.equal(mics()['Mic/Aux'].muted, true);
  assert.equal(mics()['Mic/Aux'].active, true);
  assert.equal(mics()['Old mic'].active, false, 'источник не в текущей сцене');
  assert.equal(mics()['Old mic'].volume, 0);
  assert.equal(mics()['Mic/Aux'].silentMs, null, 'индикатор громкости ещё не приходил');
  // Включили микрофон кнопкой в OBS — событие приходит сразу.
  obs.inputs[0].muted = false;
  obs.event('InputMuteStateChanged', { inputName: 'Mic/Aux', inputMuted: false });
  await waitFor(() => mics()['Mic/Aux'].muted === false, 2000);
  // Индикатор громкости: тишина копится, звук сбрасывает.
  const meters = (level: number) => obs.event('InputVolumeMeters', { inputs: [{ inputName: 'Mic/Aux', inputLevelsMul: [[level, level, level], [level, level, level]] }] });
  meters(0);
  await new Promise((r) => setTimeout(r, 350));
  meters(0.0001); // −80 дБ — всё ещё тишина
  assert.ok((mics()['Mic/Aux'].silentMs ?? 0) >= 300, `тишина ${mics()['Mic/Aux'].silentMs}`);
  meters(0.2);
  await waitFor(() => (mics()['Mic/Aux'].silentMs ?? 999) < 100, 2000); // голос — тишина сброшена
});

test('зрители «впервые» / «×N» и итоги стрима: сохраняются в базе, второй стрим сравнивается с первым', async () => {
  const t = standardTwitch();
  let phase: 'live1' | 'off' | 'live2' = 'live1';
  let live2Start = 0;
  t.on('GET', '/streams', () => {
    if (phase === 'off') return json(200, { data: [] });
    const id = phase === 'live1' ? 'stream-1' : 'stream-2';
    const started = phase === 'live1' ? Date.now() - 600_000 : live2Start;
    return json(200, { data: [{ id, user_id: '1001', type: 'live', title: 'Тест', game_name: 'Just Chatting', viewer_count: phase === 'live1' ? 7 : 9, started_at: new Date(started).toISOString() }] });
  });
  t.on('GET', '/channels/followers', () => json(200, { total: 32, data: [] }));
  t.on('GET', '/subscriptions', () => json(200, { total: 3, points: 4, data: [] }));
  let chat = ['streamer', 'alice'];
  t.on('GET', '/chat/chatters', () => json(200, { data: chat.map((l) => ({ user_id: l, user_login: l, user_name: l.toUpperCase() })), total: chat.length, pagination: {} }));
  const auth = { getAccessToken: async () => 'tok', getClientId: () => CLIENT, refresh: async () => ({}) } as unknown as ConstructorParameters<typeof HelixClient>[0];
  const helix = new HelixClient(auth, log, { fetchFn: t.fetch as typeof fetch, base: 'https://api.test/helix' });
  const db = new Db(path.join(tmpDir(), 'bot.sqlite'));
  cleanup.push(() => db.close());
  const stats = new StreamStats({
    log, helix: () => helix, user: () => ({ id: '1001', login: 'streamer' }), hasScope: () => true, useObs: () => false,
    obsConfig: () => ({ port: 1, password: '', enabled: null, fromFile: false }), resumeMs: 0,
    loadSession: () => db.getMeta('stats_session'), saveSession: (j) => db.setMeta('stats_session', j),
    store: {
      chatterVisits: (u, sid, now) => db.chatterVisits(u, sid, now), trackingSince: () => db.chattersTrackingSince(),
      saveSummary: (s) => db.saveStreamSummary(s), summaries: (n) => db.streamSummaries(n),
    },
    intervals: { tick: 30, stream: 60, chatters: 60, followers: 10_000, subs: 10_000 },
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  // Стрим 1: бот только начал запоминать зрителей — «впервые» не показываем (вдруг alice смотрит давно).
  await waitFor(() => stats.view().chatters === 1, 5000);
  chat = ['streamer', 'alice', 'bob'];
  await waitFor(() => stats.view().chatters === 2, 5000);
  const v1 = stats.view();
  assert.ok(v1.chattersList.every((c) => !c.first), 'в первом стриме «впервые» нет');
  assert.equal(v1.chattersList.find((c) => c.name === 'ALICE')!.visits, 1);
  assert.notEqual(v1.chattersTrackedSince, null);
  stats.handleNotification(notif('channel.follow', { user_name: 'Carol' }));
  stats.handleNotification(notif('channel.raid', { from_broadcaster_user_name: 'Raider', viewers: 40 }));
  stats.noteRedemption('BOB', 'Сюрприз');
  assert.deepEqual([stats.view().feed[0].kind, stats.view().feed[0].name, stats.view().feed[0].text], ['redeem', 'BOB', 'Сюрприз']);

  // Конец стрима 1 → итоги в базе.
  phase = 'off';
  await waitFor(() => stats.view().summaries.length === 1, 5000);
  const s1 = stats.view().summaries[0];
  assert.equal(s1.peakViewers, 7);
  assert.equal(s1.avgViewers, 7);
  assert.equal(s1.followers, 1);
  assert.deepEqual(s1.followerNames, ['Carol']);
  assert.deepEqual(s1.raids, [{ name: 'Raider', viewers: 40 }]);
  assert.equal(s1.chatters, 2);
  assert.equal(s1.newChatters, 0);
  assert.equal(s1.redemptions, 1);
  assert.ok(s1.endedAt - s1.startedAt >= 590_000, 'начало стрима — по Twitch');

  // Стрим 2: alice — второй раз, carol — впервые.
  live2Start = Date.now();
  chat = ['streamer', 'alice', 'carol'];
  phase = 'live2';
  await waitFor(() => stats.view().chattersList.some((c) => c.name === 'CAROL' && c.first), 5000);
  const v2 = stats.view();
  assert.equal(v2.chattersList.find((c) => c.name === 'ALICE')!.visits, 2);
  assert.equal(v2.chattersList.find((c) => c.name === 'ALICE')!.first, false);
  assert.ok(v2.feed.some((f) => f.kind === 'join' && f.name === 'CAROL' && f.first), 'в ленте: впервые на канале');
  assert.equal(v2.followersSession, 0, 'новый стрим — счётчики с нуля');
  assert.equal(v2.summaries.length, 1, 'итоги — только у закончившихся стримов');
  // Повторный опрос того же стрима не увеличивает число посещений.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stats.view().chattersList.find((c) => c.name === 'ALICE')!.visits, 2);
  // Стрим 2 закончился через 1 мин 5 с (по часам Twitch) — в истории два стрима, новый первым.
  live2Start = Date.now() - 65_000;
  await new Promise((r) => setTimeout(r, 150));
  phase = 'off';
  await waitFor(() => stats.view().summaries.length === 2, 5000);
  const [last, prev] = stats.view().summaries;
  assert.equal(prev.id, s1.id);
  assert.equal(last.newChatters, 1);
  assert.deepEqual(last.newChatterNames, ['CAROL']);
  assert.equal(stats.history(10).length, 2);
});

test('OBS: перерыв в эфире короче 10 минут — тот же стрим (итоги не делятся)', async () => {
  const obs = await MockObs.start(null);
  cleanup.push(() => obs.close());
  const saved: StreamSummary[] = [];
  const stats = new StreamStats({
    log, helix: () => null, user: () => null, hasScope: () => false, useObs: () => true,
    obsConfig: () => ({ port: obs.port, password: '', enabled: true, fromFile: true }), obsPollMs: 100, idleStopMs: 50,
    store: { chatterVisits: () => new Map(), trackingSince: () => null, saveSummary: (s) => { const i = saved.findIndex((x) => x.id === s.id); if (i >= 0) saved[i] = s; else saved.push(s); }, summaries: () => saved.slice().reverse() },
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => stats.view().obs.streaming, 5000);
  stats.handleNotification(notif('channel.follow', { user_name: 'A' }));
  obs.streaming = false;
  await waitFor(() => saved.length === 1, 5000);
  assert.equal(saved[0].followers, 1);
  obs.streaming = true;
  obs.event('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  await waitFor(() => stats.view().obs.streaming, 5000);
  stats.handleNotification(notif('channel.follow', { user_name: 'B' }));
  assert.equal(stats.view().followersSession, 2, 'перезапуск трансляции — тот же стрим');
  obs.streaming = false;
  await waitFor(() => saved.length === 1 && saved[0].followers === 2, 5000);
  assert.deepEqual(saved[0].followerNames, ['A', 'B']);
});

test('OBS: неверный пароль → auth_failed, без пароля в Hello — подключение без него', async () => {
  const obs = await MockObs.start('right');
  cleanup.push(() => obs.close());
  const c = new ObsClient({ log, getConfig: () => ({ port: obs.port, password: 'wrong', enabled: true, fromFile: false }), pollMs: 100 });
  cleanup.push(() => c.stop());
  c.start();
  await waitFor(() => c.state === 'auth_failed', 5000);
  assert.equal(obs.identified, 0);

  const open = await MockObs.start(null);
  cleanup.push(() => open.close());
  const c2 = new ObsClient({ log, getConfig: () => ({ port: open.port, password: '', enabled: true, fromFile: false }), pollMs: 100 });
  cleanup.push(() => c2.stop());
  c2.start();
  await waitFor(() => c2.state === 'ok', 5000);

  const off = new ObsClient({ log, getConfig: () => ({ port: open.port, password: '', enabled: false, fromFile: true }), pollMs: 100 });
  cleanup.push(() => off.stop());
  off.start();
  assert.equal(off.state, 'disabled', 'сервер выключен в настройках OBS — не подключаемся');
});

// ---------------------------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------------------------

function twitchStats(t: MockTwitch, chatters: string[][]) {
  let call = 0;
  t.on('GET', '/streams', () => json(200, { data: [{ id: 'stream-1', user_id: '1001', type: 'live', title: 'Тест', game_name: 'Just Chatting', viewer_count: 7, started_at: new Date(Date.now() - 600_000).toISOString() }] }));
  t.on('GET', '/channels/followers', () => json(200, { total: 32, data: [] }));
  t.on('GET', '/subscriptions', () => json(200, { total: 3, points: 4, data: [] }));
  t.on('GET', '/chat/chatters', () => {
    const list = chatters[Math.min(call++, chatters.length - 1)];
    return json(200, { data: list.map((l) => ({ user_id: l, user_login: l, user_name: l.toUpperCase() })), total: list.length, pagination: {} });
  });
}

function notif(type: string, event: Record<string, unknown>, id = String(Math.random())): EventSubMessage {
  return { metadata: { message_id: id, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: type, subscription_version: '1' }, payload: { event } } as EventSubMessage;
}

test('Twitch: зрители, пик, фолловеры, подписчики, кто в чате (без ботов и стримера), новые в чате и события', async () => {
  const t = standardTwitch();
  twitchStats(t, [['streamer', 'nightbot', 'alice'], ['streamer', 'nightbot', 'alice', 'bob']]);
  const auth = { getAccessToken: async () => 'tok', getClientId: () => CLIENT, refresh: async () => ({}) } as unknown as ConstructorParameters<typeof HelixClient>[0];
  const helix = new HelixClient(auth, log, { fetchFn: t.fetch as typeof fetch, base: 'https://api.test/helix' });
  let saved = '';
  const stats = new StreamStats({
    log, helix: () => helix, user: () => ({ id: '1001', login: 'streamer' }), hasScope: () => true, useObs: () => false,
    obsConfig: () => ({ port: 1, password: '', enabled: null, fromFile: false }), saveSession: (j) => { saved = j; },
    intervals: { tick: 30, stream: 10_000, chatters: 60, followers: 10_000, subs: 10_000 },
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => stats.view().chatters === 2, 5000);
  const v = stats.view();
  assert.equal(v.live, true);
  assert.equal(v.viewers, 7);
  assert.equal(v.peakViewers, 7);
  assert.equal(v.followers, 32);
  assert.equal(v.subs, 3);
  assert.equal(v.subPoints, 4);
  assert.equal(v.sessionSource, 'twitch');
  assert.equal(v.obs.enabled, false);
  assert.deepEqual(v.missingScopes, []);
  assert.equal(v.chattersList.find((c) => c.name === 'ALICE')!.since, 0, 'были в чате при первом опросе — не «новые»');
  assert.ok(v.chattersList.find((c) => c.name === 'BOB')!.since > 0, 'bob пришёл позже');
  assert.ok(!v.chattersList.some((c) => c.name === 'NIGHTBOT' || c.name === 'STREAMER'), 'боты и сам стример не считаются');
  assert.deepEqual(v.feed.map((f) => [f.kind, f.name]), [['join', 'BOB']]);
  assert.equal(JSON.parse(saved).streamId, 'stream-1');

  stats.handleNotification(notif('channel.follow', { user_name: 'Carol' }, 'm1'));
  stats.handleNotification(notif('channel.follow', { user_name: 'Carol' }, 'm1')); // повтор доставки
  stats.handleNotification(notif('channel.subscribe', { user_name: 'Dave', tier: '1000', is_gift: false }));
  stats.handleNotification(notif('channel.subscription.gift', { user_name: 'X', is_anonymous: true, total: 5, tier: '1000' }));
  stats.handleNotification(notif('channel.raid', { from_broadcaster_user_name: 'Raider', viewers: 40 }));
  const v2 = stats.view();
  assert.equal(v2.followers, 33);
  assert.equal(v2.followersSession, 1);
  assert.equal(v2.subsSession, 1);
  assert.deepEqual(v2.feed.slice(0, 4).map((f) => [f.kind, f.name, f.n ?? null]), [['raid', 'Raider', 40], ['gift', '', 5], ['sub', 'Dave', null], ['follow', 'Carol', null]]);
  stats.handleNotification(notif('stream.offline', {}));
  assert.equal(stats.view().live, false);
  assert.equal(stats.view().viewers, null);
});

test('Twitch: нет прав на статистику — помечаются, чат и подписчики не запрашиваются; 403 тоже помечает', async () => {
  const t = standardTwitch();
  twitchStats(t, [['alice']]);
  t.on('GET', '/subscriptions', () => json(403, { message: 'not affiliate' }));
  const auth = { getAccessToken: async () => 'tok', getClientId: () => CLIENT, refresh: async () => ({}) } as unknown as ConstructorParameters<typeof HelixClient>[0];
  const helix = new HelixClient(auth, log, { fetchFn: t.fetch as typeof fetch, base: 'https://api.test/helix' });
  const scopes = new Set(['channel:read:subscriptions']);
  const stats = new StreamStats({
    log, helix: () => helix, user: () => ({ id: '1001', login: 'streamer' }), hasScope: (s) => scopes.has(s), useObs: () => false,
    obsConfig: () => ({ port: 1, password: '', enabled: null, fromFile: false }), intervals: { tick: 30 },
  });
  cleanup.push(() => stats.stop());
  stats.setClients(1);
  await waitFor(() => stats.view().followers === 32 && t.count('GET', '/subscriptions') > 0, 5000);
  await waitFor(() => stats.view().missingScopes.includes('channel:read:subscriptions'), 3000);
  assert.deepEqual(stats.view().missingScopes.sort(), [...STATS_SCOPES].sort());
  assert.equal(t.count('GET', '/chat/chatters'), 0);
  assert.equal(stats.view().chatters, null);
});

// ---------------------------------------------------------------------------------------------
// Бот целиком
// ---------------------------------------------------------------------------------------------

async function startApp(opts: { obsPort?: number; scopes?: string[] } = {}) {
  const dir = tmpDir();
  const twitch = standardTwitch({ scopes: opts.scopes });
  twitchStats(twitch, [['alice', 'bob']]);
  const store = new MemoryStore();
  store.value = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scopes: opts.scopes ?? ['channel:manage:redemptions'], userId: '1001', login: 'streamer', clientId: CLIENT });
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store, port: 0, fetchFn: twitch.fetch as typeof fetch, idBase: 'https://id.test', helixBase: 'https://api.test/helix',
    eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true, obsPollMs: 100, statsIntervals: { tick: 50 },
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  app.db.updateSettings({ clientId: CLIENT, obsWsPort: opts.obsPort ?? 0, obsConfigDir: dir });
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, port: app.port, dir, twitch };
}

const api = (port: number, method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('бот: док получает статистику по /ws/stats, overlay меняется из настроек сразу, пароль OBS не уходит в панель', async () => {
  const obs = await MockObs.start('from-panel');
  cleanup.push(() => obs.close());
  const { app, port, dir } = await startApp({ obsPort: obs.port, scopes: ['channel:manage:redemptions', ...STATS_SCOPES] });
  // Загрузчики дока и overlay статистики.
  assert.ok(fs.existsSync(path.join(dir, STATS_DOCK_FILE)) && fs.existsSync(path.join(dir, STATS_OVERLAY_FILE)));
  assert.match(fs.readFileSync(path.join(dir, STATS_DOCK_FILE), 'utf8'), /\/stats\/dock\?via=file/);

  // Страницы отдаются.
  for (const p of ['/stats/dock', '/stats/overlay', '/stats/common.js', '/stats/dock.js', '/stats/overlay.js', '/stats/dock.css', '/stats/overlay.css']) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal(r.status, 200, p);
  }

  const msgs: Array<{ type: string; stats: { chatters: number | null; obs: { state: string; bitrateKbps: number | null } }; overlay: { fields: string[]; style: string } }> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stats`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  cleanup.push(() => ws.terminate());
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await waitFor(() => msgs.length > 0, 3000);
  assert.equal(msgs[0].type, 'stats');
  await waitFor(() => msgs.some((m) => m.stats.chatters === 2), 5000);
  // Пароль неверный (в OBS другой) → сохраняем правильный из панели.
  await waitFor(() => app.stats.obs.state === 'auth_failed', 5000);
  const saved = await (await api(port, 'POST', '/api/settings', { obsWsPassword: 'from-panel' })).json() as { settings: { obsWsPassword: string }; note: string };
  assert.equal(saved.settings.obsWsPassword, '••••anel');
  assert.match(saved.note, /Пароль OBS WebSocket сохранён/);
  assert.ok(app.db.rawSetting('obsWsPassword')?.toString().startsWith('enc:'), 'в базе — зашифрован');
  await waitFor(() => msgs.some((m) => m.stats.obs.state === 'ok' && (m.stats.obs.bitrateKbps ?? 0) > 0), 5000);

  // Overlay: настройки сразу уходят на экраны.
  const r = await api(port, 'POST', '/api/settings', { statsOverlayFields: 'bitrate,viewers', statsOverlayStyle: 'twitch' });
  assert.equal(r.status, 200);
  await waitFor(() => msgs.some((m) => m.overlay.style === 'twitch' && m.overlay.fields.join() === 'bitrate,viewers'), 3000);

  const st = await (await api(port, 'GET', '/api/stats')).json() as { setup: { obs: { port: number; passwordSet: boolean }; dockUrl: string; clients: number } };
  assert.equal(st.setup.obs.port, obs.port);
  assert.equal(st.setup.obs.passwordSet, true);
  assert.equal(st.setup.clients, 1);
  assert.match(st.setup.dockUrl, /\/stats\/dock$/);
  const state = await (await api(port, 'GET', '/api/state')).json() as { settings: { obsWsPassword: string } };
  assert.equal(state.settings.obsWsPassword, '••••anel');

  // Очередь оповещений приходит в док; кнопки дока работают (запрос со страницы бота).
  app.queue.setPaused(true);
  await waitFor(() => msgs.some((m) => (m as unknown as { queue?: { paused: boolean } }).queue?.paused === true), 3000);
  const resume = await fetch(`http://127.0.0.1:${port}/api/queue/resume`, { method: 'POST', headers: { 'x-tab-request': '1', Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(resume.status, 200);
  await waitFor(() => (msgs[msgs.length - 1] as unknown as { queue: { paused: boolean } }).queue.paused === false, 3000);
  const hist = await (await api(port, 'GET', '/api/stats/history')).json() as { summaries: unknown[] };
  assert.deepEqual(hist.summaries, []);

  // Чужой сайт не подключится к /ws/stats.
  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws/stats`, { headers: { Origin: 'https://evil.example' } });
  const code = await new Promise<string>((res) => { evil.on('unexpected-response', (_q, resp) => res(String(resp.statusCode))); evil.on('open', () => res('open')); evil.on('error', () => res('error')); });
  assert.equal(code, '403');
});

test('бот: при входе Twitch просит и права статистики; без них вход не ломается', async () => {
  const { app, twitch } = await startApp();
  assert.equal(app.auth.state.status, 'ok', 'старый токен без прав статистики — бот работает');
  twitch.on('POST', '/oauth2/device', () => json(200, { device_code: 'd', user_code: 'U', verification_uri: 'https://www.twitch.tv/activate', expires_in: 1800, interval: 5 }));
  await app.auth.startLogin();
  app.auth.cancelLogin();
  const scopes = new URLSearchParams(twitch.calls.find((c) => c.url.endsWith('/oauth2/device'))!.body).get('scopes')!.split(' ');
  assert.deepEqual(scopes.sort(), ['channel:manage:redemptions', ...STATS_SCOPES].sort());
});

test('настройки overlay статистики проверяются', () => {
  assert.equal(validateSettingsPatch({ statsOverlayFields: 'viewers, bitrate,viewers' }).ok.statsOverlayFields, 'viewers,bitrate');
  assert.match(validateSettingsPatch({ statsOverlayFields: 'viewers,hack' }).error!, /Неизвестный показатель/);
  assert.match(validateSettingsPatch({ statsOverlayStyle: 'neon' }).error!, /стиль/);
  assert.equal(validateSettingsPatch({ obsWsPort: 0 }).ok.obsWsPort, 0);
  assert.match(validateSettingsPatch({ obsWsPort: 80 }).error!, /obsWsPort/);
  assert.match(validateSettingsPatch({ obsWsPassword: 'a\nb' }).error!, /Пароль OBS/);
});

test('загрузчик дока показывает текст ожидания и в OBS, загрузчик overlay — нет', () => {
  const dock = loaderHtml(17420, 'ru', 'stats-dock');
  const ov = loaderHtml(17420, 'ru', 'stats-overlay');
  assert.match(dock, /\/stats\/dock\?via=file/);
  assert.match(dock, /s\.style\.display = 'block'; \/\/ док/);
  assert.match(ov, /\/stats\/overlay\?via=file/);
  assert.match(ov, /if \(!inStreamApp\) s\.style\.display/);
  assert.match(loaderHtml(17420, 'en'), /\/overlay\?via=file/, 'обычный загрузчик не изменился');
});
