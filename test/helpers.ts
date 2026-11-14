import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/logger.ts';

export const quietLogger = () => new Logger({ console: false, minLevel: 'debug' });
export const log = quietLogger().child('test');

export function tmpDir(prefix = 'tab-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = cond(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Мок сервера Twitch EventSub WebSocket. */
export class MockEventSub {
  wss: WebSocketServer;
  port = 0;
  sockets: WebSocket[] = [];
  connections: string[] = []; // url каждого подключения
  sessionIds: string[] = [];
  keepalive = 10;
  autoWelcome = true;

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws, req) => {
      this.sockets.push(ws);
      this.connections.push(req.url ?? '');
      const u = new URL(req.url ?? '/', 'http://x');
      const ka = Number(u.searchParams.get('keepalive_timeout_seconds')) || this.keepalive;
      if (this.autoWelcome) this.welcome(ws, ka);
    });
  }

  static async create(): Promise<MockEventSub> {
    const m = new MockEventSub();
    if (!m.wss.address()) await new Promise((r) => m.wss.once('listening', r));
    m.port = (m.wss.address() as AddressInfo).port;
    return m;
  }

  get url(): string { return `ws://127.0.0.1:${this.port}/ws`; }
  get last(): WebSocket { return this.sockets[this.sockets.length - 1]; }
  open(): WebSocket[] { return this.sockets.filter((s) => s.readyState === WebSocket.OPEN); }

  welcome(ws: WebSocket, keepalive = this.keepalive): string {
    const id = 'sess_' + crypto.randomUUID().slice(0, 8);
    this.sessionIds.push(id);
    this.send(ws, 'session_welcome', { session: { id, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null, connected_at: new Date().toISOString() } });
    return id;
  }

  send(ws: WebSocket, type: string, payload: unknown, extra: Record<string, string> = {}, messageId: string = crypto.randomUUID()): string {
    ws.send(JSON.stringify({ metadata: { message_id: messageId, message_type: type, message_timestamp: new Date().toISOString(), ...extra }, payload }));
    return messageId;
  }

  keepaliveMsg(ws = this.last): void { this.send(ws, 'session_keepalive', {}); }

  notification(event: Record<string, unknown>, ws = this.last, messageId?: string): string {
    return this.send(ws, 'notification', {
      subscription: { id: 'sub1', status: 'enabled', type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: {} },
      event,
    }, { subscription_type: 'channel.channel_points_custom_reward_redemption.add', subscription_version: '1' }, messageId);
  }

  reconnect(ws = this.last): void {
    this.send(ws, 'session_reconnect', { session: { id: 'x', status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: `${this.url}?reconnect=1`, connected_at: '' } });
  }

  revoke(ws = this.last, status = 'authorization_revoked'): void {
    this.send(ws, 'revocation', { subscription: { id: 'sub1', status, type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: {} } });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
}

export function redemptionEvent(over: Partial<{ id: string; rewardId: string; title: string; user: string; redeemed_at: string; status: string }> = {}) {
  const user = over.user ?? 'viewer1';
  return {
    id: over.id ?? crypto.randomUUID(),
    broadcaster_user_id: '1001', broadcaster_user_login: 'streamer', broadcaster_user_name: 'Streamer',
    user_id: '2002', user_login: user, user_name: user, user_input: '',
    status: over.status ?? 'unfulfilled',
    reward: { id: over.rewardId ?? 'reward-1', title: over.title ?? 'Звук', cost: 100, prompt: '' },
    redeemed_at: over.redeemed_at ?? new Date().toISOString(),
  };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Мок fetch для id.twitch.tv и api.twitch.tv. */
export class MockTwitch {
  calls: { method: string; url: string; body?: string }[] = [];
  handlers: { method: string; path: string; fn: Handler }[] = [];

  on(method: string, path: string, fn: Handler): this { this.handlers.unshift({ method, path, fn }); return this; }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push({ method, url: url.toString(), body: init.body ? String(init.body) : undefined });
    const h = this.handlers.find((x) => x.method === method && url.pathname.endsWith(x.path));
    if (!h) return json(404, { message: `no mock for ${method} ${url.pathname}` });
    return h.fn(url, init);
  };

  count(method: string, path: string): number { return this.calls.filter((c) => c.method === method && new URL(c.url).pathname.endsWith(path)).length; }
}

export function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Стандартный набор ответов Twitch для залогиненного пользователя. */
export function standardTwitch(opts: { scopes?: string[] } = {}): MockTwitch {
  const t = new MockTwitch();
  let n = 0;
  t.on('GET', '/oauth2/validate', () => json(200, { client_id: 'abcdefghijklmnopqrstuvwxyz0123', login: 'streamer', user_id: '1001', scopes: opts.scopes ?? ['channel:manage:redemptions'], expires_in: 14000 }));
  t.on('POST', '/oauth2/token', () => { n++; return json(200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 14400, scope: ['channel:manage:redemptions'] }); });
  t.on('POST', '/eventsub/subscriptions', () => json(202, { data: [{ id: crypto.randomUUID(), status: 'enabled', type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: {}, transport: { method: 'websocket' }, created_at: '' }] }));
  t.on('GET', '/eventsub/subscriptions', () => json(200, { data: [], pagination: {} }));
  t.on('GET', '/channel_points/custom_rewards', () => json(200, { data: [] }));
  return t;
}
