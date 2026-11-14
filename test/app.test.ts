import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { Backoff } from '../src/backoff.ts';
import { MockEventSub, standardTwitch, quietLogger, tmpDir, waitFor, delay, redemptionEvent, json, type MockTwitch } from './helpers.ts';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const wav = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'test-chime.wav'));

interface Ctx { app: App; server: http.Server; port: number; dir: string; store: MemoryStore }
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(opts: { dir?: string; twitch?: MockTwitch; es?: MockEventSub; loggedIn?: boolean } = {}): Promise<Ctx> {
  const dir = opts.dir ?? tmpDir();
  const twitch = opts.twitch ?? standardTwitch();
  const store = new MemoryStore();
  if (opts.loggedIn !== false) store.value = JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, scopes: ['channel:manage:redemptions'], userId: '1001', login: 'streamer', clientId: CLIENT });
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store, port: 0, fetchFn: twitch.fetch as typeof fetch, idBase: 'https://id.test', helixBase: 'https://api.test/helix',
    eventsubUrl: opts.es?.url ?? 'ws://127.0.0.1:1/ws', eventsubBackoff: new Backoff({ baseMs: 50, maxMs: 200 }),
  });
  const server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  app.db.updateSettings({ clientId: CLIENT, gapBetweenMs: 0 });
  await app.start();
  await app.initialSync;
  const ctx = { app, server, port, dir, store };
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return ctx;
}

/** Настроенная награда с медиафайлом. */
function addReward(app: App, id = 'reward-1', over: { manageable?: boolean; enabled?: boolean } = {}) {
  app.db.upsertTwitchReward({ id, title: `Награда ${id}`, cost: 100, prompt: '', manageable: over.manageable ?? false, is_enabled: true, background_color: '', raw: {} });
  const m = app.media.add('звук.wav', wav);
  app.db.updateRewardConfig(id, { media_id: m.id, bot_enabled: over.enabled === false ? 0 : 1 });
  return m;
}

/** Overlay-клиент, имитирующий OBS Browser Source. */
async function overlay(port: number, opts: { autoEndMs?: number; error?: string } = {}) {
  const plays: { id: string; volume: number; audio: unknown }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}`, 'User-Agent': 'Mozilla/5.0 OBS/33.0.1' } });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'play') {
      plays.push(m.item);
      setTimeout(() => ws.send(JSON.stringify(opts.error ? { type: 'error', id: m.item.id, message: opts.error } : { type: 'ended', id: m.item.id })), opts.autoEndMs ?? 20);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', isObs: true }));
  cleanup.push(() => ws.terminate());
  return { ws, plays };
}

function statusOf(app: App, id: string) { return app.db.recentRedemptions(100).find((r) => r.id === id)?.status; }

test('полный путь: EventSub notification → очередь → overlay → «воспроизведено»', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const twitch = standardTwitch();
  const { app, port } = await startApp({ es, twitch });
  addReward(app);
  const ov = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  assert.equal(twitch.count('POST', '/eventsub/subscriptions'), 1);
  const sub = JSON.parse(twitch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/eventsub/subscriptions'))!.body!);
  assert.equal(sub.type, 'channel.channel_points_custom_reward_redemption.add');
  assert.equal(sub.version, '1');
  assert.deepEqual(sub.condition, { broadcaster_user_id: '1001' });
  assert.equal(sub.transport.session_id, es.sessionIds[0]);

  const ev = redemptionEvent({ id: 'red-1' });
  es.notification(ev);
  await waitFor(() => statusOf(app, 'red-1') === 'done');
  assert.equal(ov.plays.length, 1);
  assert.equal(ov.plays[0].volume, 0.8, 'громкость награды 100% × общая 80%');
});

test('дедупликация: повтор message_id и повтор redemption id не воспроизводятся дважды', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const { app, port } = await startApp({ es });
  addReward(app);
  const ov = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  const ev = redemptionEvent({ id: 'red-dup' });
  es.notification(ev, es.last, 'msg-1');
  es.notification(ev, es.last, 'msg-1'); // та же доставка повторно
  es.notification(ev, es.last, 'msg-2'); // новое сообщение, но то же погашение
  await waitFor(() => statusOf(app, 'red-dup') === 'done');
  await delay(200);
  assert.equal(ov.plays.length, 1);
});

test('выключенная награда и режим наблюдения не воспроизводят', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const { app, port } = await startApp({ es });
  addReward(app, 'off', { enabled: false });
  addReward(app, 'on');
  const ov = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  es.notification(redemptionEvent({ id: 'x1', rewardId: 'off' }));
  await waitFor(() => statusOf(app, 'x1') === 'ignored');
  app.db.updateSettings({ mode: 'observe' });
  es.notification(redemptionEvent({ id: 'x2', rewardId: 'on' }));
  await waitFor(() => statusOf(app, 'x2') === 'observed');
  // неизвестная награда добавляется в список выключенной
  es.notification(redemptionEvent({ id: 'x3', rewardId: 'brand-new', title: 'Новая' }));
  await waitFor(() => statusOf(app, 'x3') === 'ignored');
  assert.equal(app.db.getReward('brand-new')?.bot_enabled, 0);
  await delay(100);
  assert.equal(ov.plays.length, 0);
});

test('защита от спама: кулдаун на зрителя', async () => {
  const { app, port } = await startApp({ loggedIn: false });
  addReward(app);
  app.db.updateSettings({ userCooldownSec: 60 });
  await overlay(port);
  const r1 = app.router.handleRedemption(redemptionEvent({ id: 's1', user: 'spammer' }), 'eventsub');
  const r2 = app.router.handleRedemption(redemptionEvent({ id: 's2', user: 'spammer' }), 'eventsub');
  const r3 = app.router.handleRedemption(redemptionEvent({ id: 's3', user: 'other' }), 'eventsub');
  assert.deepEqual([r1, r2, r3], ['queued', 'skipped', 'queued']);
});

test('повреждённый медиафайл: ошибка в журнале, файл помечен, следующая награда играет', async () => {
  const { app, port } = await startApp({ loggedIn: false });
  addReward(app, 'good');
  const bad = addReward(app, 'bad');
  const ov = await overlay(port);
  // Overlay сообщит ошибку только для «плохого» файла
  ov.ws.removeAllListeners('message');
  ov.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'play') return;
    ov.plays.push(m.item);
    const isBad = m.item.audio.id === bad.id;
    ov.ws.send(JSON.stringify(isBad ? { type: 'error', id: m.item.id, message: 'не удалось декодировать файл (повреждён)' } : { type: 'ended', id: m.item.id }));
  });
  app.router.handleRedemption(redemptionEvent({ id: 'b1', rewardId: 'bad' }), 'eventsub');
  app.router.handleRedemption(redemptionEvent({ id: 'g1', rewardId: 'good' }), 'eventsub');
  await waitFor(() => statusOf(app, 'g1') === 'done');
  assert.equal(statusOf(app, 'b1'), 'failed');
  assert.equal(app.db.getMedia(bad.id)?.status, 'broken');
  assert.ok(app.db.recentEvents().some((e) => e.level === 'error' && /декодировать/.test(e.message)));
  // файл удалён с диска → понятная ошибка, без падения
  fs.unlinkSync(app.media.filePath(app.db.getMedia(app.db.getReward('good')!.media_id!)!)!);
  assert.equal(app.router.handleRedemption(redemptionEvent({ id: 'g2', rewardId: 'good' }), 'eventsub'), 'failed');
});

test('полный разрыв EventSub → новая сессия, подписка создаётся заново, пропуски для своих наград восстанавливаются', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const twitch = standardTwitch();
  const { app, port } = await startApp({ es, twitch });
  addReward(app, 'own', { manageable: true });
  addReward(app, 'sa', { manageable: false });
  const ov = await overlay(port);
  await waitFor(() => app.eventsub.status.state === 'connected');
  const missedAt = () => new Date(Date.now() - 100).toISOString();
  twitch.on('GET', '/channel_points/custom_rewards/redemptions', (u) => {
    if (u.searchParams.get('reward_id') !== 'own' || u.searchParams.get('status') !== 'UNFULFILLED') return json(200, { data: [] });
    return json(200, { data: [{ id: 'missed-1', user_id: '5', user_login: 'late', user_name: 'Late', user_input: '', status: 'UNFULFILLED', redeemed_at: missedAt(), reward: { id: 'own', title: 'Своя', prompt: '', cost: 10 } }] });
  });
  es.last.terminate(); // обрыв
  await waitFor(() => twitch.count('POST', '/eventsub/subscriptions') === 2 && app.eventsub.status.state === 'connected');
  await waitFor(() => statusOf(app, "missed-1") === "done");
  assert.equal(ov.plays.length, 1);
  const gap = app.db.recentEvents().find((e) => e.type === 'gap');
  assert.ok(gap, 'в журнале есть запись об окне разрыва');
  assert.match(gap!.message, /восстановить невозможно/);
  // Для награды бота статус погашения отмечен выполненным
  await waitFor(() => twitch.count('PATCH', '/channel_points/custom_rewards/redemptions') === 1);
});

test('revocation authorization_revoked → проверка токена и сообщение в журнале', async () => {
  const es = await MockEventSub.create(); cleanup.push(() => es.close());
  const twitch = standardTwitch();
  const { app } = await startApp({ es, twitch });
  await waitFor(() => app.eventsub.status.state === 'connected');
  const before = twitch.count('GET', '/oauth2/validate');
  es.revoke(es.last, 'authorization_revoked');
  await waitFor(() => twitch.count('GET', '/oauth2/validate') === before + 1);
  assert.ok(app.db.recentEvents().some((e) => /отменил подписку/.test(e.message)));
});

test('перезапуск приложения: старые награды не проигрываются, настройки сохраняются', async () => {
  const dir = tmpDir();
  const a = await startApp({ dir, loggedIn: false });
  addReward(a.app);
  a.app.db.updateSettings({ masterVolume: 33, maxQueueLength: 7 });
  // overlay не подключён → погашения остаются в очереди
  a.app.router.handleRedemption(redemptionEvent({ id: 'old-1' }), 'eventsub');
  a.app.router.handleRedemption(redemptionEvent({ id: 'old-2' }), 'eventsub');
  assert.equal(statusOf(a.app, 'old-1'), 'queued');
  await cleanup.pop()!(); // остановка первого экземпляра

  const b = await startApp({ dir, loggedIn: false });
  const ov = await overlay(b.port);
  await delay(300);
  assert.equal(ov.plays.length, 0, 'после перезапуска старые оповещения не воспроизводятся');
  assert.equal(statusOf(b.app, 'old-1'), 'dropped');
  const s = b.app.db.getSettings();
  assert.equal(s.masterVolume, 33);
  assert.equal(s.maxQueueLength, 7);
  assert.equal(b.app.db.getReward('reward-1')?.bot_enabled, 1);
  // повторная доставка того же погашения после перезапуска не проигрывается
  assert.equal(b.app.router.handleRedemption(redemptionEvent({ id: 'old-1' }), 'eventsub'), 'duplicate');
});

test('слишком старое погашение не воспроизводится', async () => {
  const { app, port } = await startApp({ loggedIn: false });
  addReward(app);
  const ov = await overlay(port);
  const r = app.router.handleRedemption(redemptionEvent({ id: 'ancient', redeemed_at: new Date(Date.now() - 3600_000).toISOString() }), 'eventsub');
  assert.equal(r, 'missed');
  await delay(100);
  assert.equal(ov.plays.length, 0);
});

test('HTTP: Host, CSRF, Origin для WebSocket, traversal, медиа по ID с Range', async () => {
  const { app, port } = await startApp({ loggedIn: false });
  const m = addReward(app);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/test`, { method: 'POST' })).status, 403, 'без заголовка x-tab-request');
  assert.equal((await fetch(`${base}/api/test`, { method: 'POST', headers: { 'x-tab-request': '1', Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/test`, { method: 'POST', headers: { 'x-tab-request': '1', Origin: base } })).status, 200);
  const http = await import('node:http');
  const badHost = await new Promise<number>((r) => http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: 'attacker.example' } }, (res) => { res.resume(); r(res.statusCode!); }));
  assert.equal(badHost, 403, 'защита от DNS rebinding');
  const trav = await new Promise<number>((r) => http.get({ host: '127.0.0.1', port, path: '/panel/../../package.json' }, (res) => { res.resume(); r(res.statusCode!); }));
  assert.equal(trav, 404);
  assert.equal((await fetch(`${base}/media/..%2f..%2fbot.sqlite`)).status, 404);
  const ranged = await fetch(`${base}/media/${m.id}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  const csp = (await fetch(`${base}/panel/`)).headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self'/);
  const evil = new WebSocket(`ws://127.0.0.1:${port}/ws/panel`, { headers: { Origin: 'https://evil.example' } });
  const evilResult = await new Promise((r) => { evil.on('open', () => r('open')); evil.on('error', () => r('rejected')); });
  assert.equal(evilResult, 'rejected');
  // загрузка: повреждённый файл отклоняется с понятным сообщением
  const up = await fetch(`${base}/api/media`, { method: 'PUT', headers: { 'x-tab-request': '1', 'x-file-name': encodeURIComponent('bad.mp3') }, body: Buffer.from('not a media file at all...') });
  assert.equal(up.status, 400);
  assert.match(((await up.json()) as { error: string }).error, /повреждён/);
});

test('сервер слушает только 127.0.0.1', async () => {
  const { server } = await startApp({ loggedIn: false });
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
});

test('режимы «С видео» / «Только звук», общий выключатель видео и откат на звук при повреждённом видео', async () => {
  const { app, port } = await startApp({ loggedIn: false });
  const sound = addReward(app, 'vid');
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm....V_VP9....A_OPUS'), Buffer.alloc(64)]);
  const video = app.media.add('ролик.webm', webm);
  app.db.updateRewardConfig('vid', { video_id: video.id, play_mode: 'video' });
  const ov = await overlay(port);
  const play = async (id: string) => {
    const before = ov.plays.length;
    app.router.handleRedemption(redemptionEvent({ id, rewardId: 'vid', user: id }), 'eventsub');
    await waitFor(() => ov.plays.length === before + 1);
    return ov.plays[ov.plays.length - 1] as unknown as { visual: { id: string; kind: string } | null; audio: { id: string; kind: string } | null };
  };
  // С видео: картинка — видео, звук — собственная дорожка ролика (отдельный звук не накладывается)
  let p = await play('m1');
  assert.equal(p.visual?.id, video.id);
  assert.equal(p.audio, null);
  // Только звук: проигрывается основной звук, без картинки
  app.db.updateRewardConfig('vid', { play_mode: 'audio' });
  p = await play('m2');
  assert.equal(p.visual, null);
  assert.equal(p.audio?.id, sound.id);
  // Общий выключатель видео перекрывает настройку награды
  app.db.updateRewardConfig('vid', { play_mode: 'video' });
  app.db.updateSettings({ audioOnly: true });
  p = await play('m3');
  assert.equal(p.visual, null);
  assert.equal(p.audio?.id, sound.id);
  app.db.updateSettings({ audioOnly: false });
  // Видео повреждено → награда всё равно звучит (только звук) и пишет предупреждение
  app.db.updateMediaStatus(video.id, 'broken', 'повреждён');
  p = await play('m4');
  assert.equal(p.visual, null);
  assert.equal(p.audio?.id, sound.id);
  assert.ok(app.db.recentEvents().some((e) => e.level === 'warn' && /только звук/.test(e.message)));
  // Только видео без отдельного звука, режим «Только звук» → играет звуковая дорожка видео
  app.db.updateMediaStatus(video.id, 'ok', '');
  app.db.updateRewardConfig('vid', { media_id: null, play_mode: 'audio' });
  p = await play('m5');
  assert.equal(p.visual, null);
  assert.equal(p.audio?.id, video.id);
  assert.equal(p.audio?.kind, 'audio');
});

test('миграция схемы: старая база без video_id/play_mode обновляется без потери данных', async () => {
  const dir = tmpDir();
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'bot.sqlite'));
  old.exec(`CREATE TABLE rewards (id TEXT PRIMARY KEY, title TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL DEFAULT '',
    manageable INTEGER NOT NULL DEFAULT 0, twitch_enabled INTEGER NOT NULL DEFAULT 1, background_color TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0,
    bot_enabled INTEGER NOT NULL DEFAULT 0, media_id TEXT, sound_id TEXT, volume INTEGER NOT NULL DEFAULT 100, duration_ms INTEGER NOT NULL DEFAULT 0,
    delay_ms INTEGER NOT NULL DEFAULT 0, cooldown_sec INTEGER NOT NULL DEFAULT 0, show_caption INTEGER NOT NULL DEFAULT 1, raw TEXT NOT NULL DEFAULT '{}',
    created_by_bot INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
  old.exec(`INSERT INTO rewards(id, title, bot_enabled, media_id) VALUES ('r-old', 'Старая', 1, 'm-1')`);
  old.close();
  const { app } = await startApp({ dir, loggedIn: false });
  const r = app.db.getReward('r-old')!;
  assert.equal(r.title, 'Старая');
  assert.equal(r.media_id, 'm-1');
  assert.equal(r.play_mode, 'video');
  assert.equal(r.video_id, null);
});
