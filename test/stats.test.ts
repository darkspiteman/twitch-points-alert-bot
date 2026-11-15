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
import { StreamStats, STATS_SCOPES } from '../src/stats.ts';
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
    obsConfig: () => ({ port: obs.port, password: 'secret-pass', enabled: true, fromFile: true }), obsPollMs: 100, idleStopMs: 50,
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
