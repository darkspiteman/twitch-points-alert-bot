import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventSubClient } from '../src/twitch/eventsub.ts';
import { Backoff } from '../src/backoff.ts';
import { MockEventSub, log, waitFor, delay, redemptionEvent } from './helpers.ts';

let server: MockEventSub | null = null;
let client: EventSubClient | null = null;
afterEach(async () => {
  await client?.stop();
  await server?.close();
  client = null; server = null;
});

async function makeClient(subscribe: (id: string) => Promise<void>, opts: { keepaliveSeconds?: number; graceMs?: number } = {}) {
  server ??= await MockEventSub.create();
  client = new EventSubClient({
    log, url: server.url, keepaliveSeconds: opts.keepaliveSeconds ?? 10, subscribe,
    backoff: new Backoff({ baseMs: 50, maxMs: 200 }), keepaliveGraceMs: opts.graceMs ?? 100, welcomeTimeoutMs: 2000,
  });
  return client;
}

test('session_welcome → создаётся подписка, статус «connected»', async () => {
  const subs: string[] = [];
  const c = await makeClient(async (id) => { subs.push(id); });
  c.start();
  await waitFor(() => c.status.state === 'connected');
  assert.equal(subs.length, 1);
  assert.equal(subs[0], server!.sessionIds[0]);
  assert.match(server!.connections[0], /keepalive_timeout_seconds=10/);
});

test('notification доставляется обработчику', async () => {
  const c = await makeClient(async () => {});
  const got: unknown[] = [];
  c.on('notification', (m) => got.push(m));
  c.start();
  await waitFor(() => c.status.state === 'connected');
  server!.notification(redemptionEvent({ id: 'r-1' }));
  await waitFor(() => got.length === 1);
  assert.equal((got[0] as { payload: { event: { id: string } } }).payload.event.id, 'r-1');
});

test('session_keepalive продлевает жизнь соединения', async () => {
  const c = await makeClient(async () => {}, { keepaliveSeconds: 1, graceMs: 100 });
  c.start();
  await waitFor(() => c.status.state === 'connected');
  for (let i = 0; i < 4; i++) { await delay(500); server!.keepaliveMsg(); }
  assert.equal(server!.sockets.length, 1, 'не должно быть переподключений при регулярном keepalive');
  assert.equal(c.status.state, 'connected');
});

test('зависшее соединение (нет keepalive) → переподключение и повторная подписка', async () => {
  const subs: string[] = [];
  const c = await makeClient(async (id) => { subs.push(id); }, { keepaliveSeconds: 1, graceMs: 100 });
  const sessions: Array<{ gapStartedAt: number | null }> = [];
  c.on('session', (s) => sessions.push(s));
  c.start();
  await waitFor(() => c.status.state === 'connected');
  // сервер молчит → через ~1.1 с клиент рвёт соединение и подключается заново
  await waitFor(() => subs.length === 2, 5000);
  assert.equal(server!.sockets.length, 2);
  assert.notEqual(subs[0], subs[1]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].gapStartedAt, null);
  assert.ok(sessions[1].gapStartedAt, 'вторая сессия сообщает начало окна возможной потери событий');
});

test('обрыв TCP/WebSocket → reconnect с backoff и пересоздание подписки', async () => {
  const subs: string[] = [];
  const c = await makeClient(async (id) => { subs.push(id); });
  c.start();
  await waitFor(() => c.status.state === 'connected');
  server!.last.terminate();
  await waitFor(() => c.status.state === 'reconnecting' || subs.length === 2);
  await waitFor(() => subs.length === 2 && c.status.state === 'connected');
  assert.equal(c.status.reconnects, 1);
});

test('несколько обрывов подряд → задержки растут (exponential backoff), затем успешное подключение', async () => {
  server = await MockEventSub.create();
  server.autoWelcome = false;
  let accepted = 0;
  server.wss.on('connection', (ws) => {
    accepted++;
    if (accepted <= 3) ws.terminate(); else server!.welcome(ws);
  });
  const subs: string[] = [];
  const c = await makeClient(async (id) => { subs.push(id); });
  c.start();
  await waitFor(() => c.status.state === 'connected', 5000);
  assert.equal(accepted, 4);
  assert.equal(subs.length, 1);
  assert.equal(c.status.reconnects, 3);
});

test('session_reconnect → переход на reconnect_url без повторной подписки, старое соединение закрыто', async () => {
  const subs: string[] = [];
  const c = await makeClient(async (id) => { subs.push(id); });
  const got: string[] = [];
  c.on('notification', (m) => got.push(m.payload.event.id));
  c.start();
  await waitFor(() => c.status.state === 'connected');
  const old = server!.last;
  server!.reconnect(old);
  await waitFor(() => server!.sockets.length === 2);
  assert.match(server!.connections[1], /reconnect=1/);
  await waitFor(() => old.readyState === old.CLOSED);
  assert.equal(subs.length, 1, 'при штатном reconnect подписки переносятся Twitch, повторно не создаются');
  assert.equal(c.status.state, 'connected');
  server!.notification(redemptionEvent({ id: 'after-reconnect' }), server!.sockets[1]);
  await waitFor(() => got.includes('after-reconnect'));
});

test('во время session_reconnect события со старого соединения доставляются до welcome на новом', async () => {
  server = await MockEventSub.create();
  const c = await makeClient(async () => {});
  const got: string[] = [];
  c.on('notification', (m) => got.push(m.payload.event.id));
  c.start();
  await waitFor(() => c.status.state === 'connected');
  server.autoWelcome = false; // новое соединение не получит welcome сразу
  const old = server.last;
  server.reconnect(old);
  await waitFor(() => server!.sockets.length === 2);
  server.notification(redemptionEvent({ id: 'old-conn-event' }), old);
  await waitFor(() => got.includes('old-conn-event'));
  server.welcome(server.sockets[1]);
  await waitFor(() => old.readyState === old.CLOSED);
});

test('revocation передаётся приложению', async () => {
  const c = await makeClient(async () => {});
  const rev: string[] = [];
  c.on('revocation', (m) => rev.push(m.payload.subscription.status));
  c.start();
  await waitFor(() => c.status.state === 'connected');
  server!.revoke(server!.last, 'authorization_revoked');
  await waitFor(() => rev.length === 1);
  assert.equal(rev[0], 'authorization_revoked');
});

test('ошибка авторизации при подписке → состояние error без бесконечных переподключений', async () => {
  const c = await makeClient(async () => { throw Object.assign(new Error('401 Unauthorized'), { status: 401 }); });
  let fatal = 0;
  c.on('fatal', () => fatal++);
  c.start();
  await waitFor(() => c.status.state === 'error');
  await delay(400);
  assert.equal(fatal, 1);
  assert.equal(server!.sockets.length, 1, 'не должно быть повторных подключений');
});

test('временная ошибка подписки (500) → повтор на новой сессии', async () => {
  let n = 0;
  const c = await makeClient(async () => { n++; if (n === 1) throw Object.assign(new Error('500'), { status: 500 }); });
  c.start();
  await waitFor(() => c.status.state === 'connected', 5000);
  assert.equal(n, 2);
  assert.equal(server!.sockets.length, 2);
});

test('stop() закрывает соединение и не переподключается', async () => {
  const c = await makeClient(async () => {});
  c.start();
  await waitFor(() => c.status.state === 'connected');
  await c.stop();
  await delay(300);
  assert.equal(server!.open().length, 0);
  assert.equal(server!.sockets.length, 1);
  assert.equal(c.status.state, 'stopped');
});
