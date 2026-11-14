import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Backoff } from '../backoff.ts';
import type { ScopedLogger } from '../logger.ts';

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

export interface EventSubMetadata {
  message_id: string;
  message_type: 'session_welcome' | 'session_keepalive' | 'session_reconnect' | 'notification' | 'revocation' | string;
  message_timestamp: string;
  subscription_type?: string;
  subscription_version?: string;
}

export interface EventSubMessage {
  metadata: EventSubMetadata;
  payload: {
    session?: { id: string; status: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null; connected_at: string };
    subscription?: { id: string; status: string; type: string; version: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
}

export type EventSubState = 'stopped' | 'connecting' | 'subscribing' | 'connected' | 'reconnecting' | 'error';

export interface EventSubStatus {
  state: EventSubState;
  sessionId: string | null;
  connectedSince: number | null;
  lastMessageAt: number | null;
  reconnects: number;
  lastError: string | null;
  nextRetryAt: number | null;
}

export interface EventSubOptions {
  log: ScopedLogger;
  url?: string;
  keepaliveSeconds?: number;
  /** Создание подписок на новой сессии. Вызывается только для новой сессии (не при штатном session_reconnect). */
  subscribe: (sessionId: string) => Promise<void>;
  backoff?: Backoff;
  /** Дополнительный запас к keepalive-таймауту перед признанием соединения зависшим. */
  keepaliveGraceMs?: number;
  /** Максимум ожидания welcome после открытия сокета. */
  welcomeTimeoutMs?: number;
}

/**
 * Клиент Twitch EventSub WebSocket.
 * События: 'notification' (msg), 'revocation' (msg), 'session' ({ sessionId, gapStartedAt }),
 * 'disconnected' ({ at }), 'status' (EventSubStatus), 'fatal' (Error).
 */
export class EventSubClient extends EventEmitter {
  private opts: EventSubOptions;
  private backoff: Backoff;
  private active: WebSocket | null = null;
  private migrating: WebSocket | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private keepaliveMs = 0;
  private running = false;
  /** Момент последней «живой» активности до разрыва — начало возможного окна потерь. */
  private gapStartedAt: number | null = null;
  private generation = 0;
  private _status: EventSubStatus = { state: 'stopped', sessionId: null, connectedSince: null, lastMessageAt: null, reconnects: 0, lastError: null, nextRetryAt: null };

  constructor(opts: EventSubOptions) {
    super();
    this.opts = opts;
    this.backoff = opts.backoff ?? new Backoff({ baseMs: 1000, maxMs: 60_000 });
  }

  get status(): EventSubStatus { return { ...this._status }; }

  private patch(p: Partial<EventSubStatus>): void {
    this._status = { ...this._status, ...p };
    this.emit('status', this.status);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.patch({ state: 'connecting', lastError: null, nextRetryAt: null });
    this.openSocket(this.baseUrl(), false);
  }

  /** Полный перезапуск (например, после повторного входа в Twitch). */
  restart(): void {
    this.stop();
    this.backoff.reset();
    this.start();
  }

  stop(): Promise<void> {
    this.running = false;
    this.generation++;
    this.clearWatchdog();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const sockets = [this.active, this.migrating].filter(Boolean) as WebSocket[];
    this.active = this.migrating = null;
    this.patch({ state: 'stopped', sessionId: null, connectedSince: null, nextRetryAt: null });
    return Promise.all(sockets.map((s) => closeSocket(s))).then(() => undefined);
  }

  private baseUrl(): string {
    const u = new URL(this.opts.url ?? EVENTSUB_URL);
    u.searchParams.set('keepalive_timeout_seconds', String(this.opts.keepaliveSeconds ?? 30));
    return u.toString();
  }

  private openSocket(url: string, isMigration: boolean): void {
    const gen = this.generation;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    } catch (e) {
      this.opts.log.error('Не удалось открыть соединение EventSub', e);
      if (!isMigration) this.scheduleReconnect(`Ошибка соединения: ${(e as Error).message}`);
      return;
    }
    if (isMigration) this.migrating = ws; else this.active = ws;
    let welcomed = false;
    const welcomeTimer = setTimeout(() => {
      if (!welcomed) { this.opts.log.warn('EventSub: не получено приветствие (session_welcome) вовремя'); ws.terminate(); }
    }, this.opts.welcomeTimeoutMs ?? 15_000);

    ws.on('message', (data) => {
      if (gen !== this.generation) return;
      let msg: EventSubMessage;
      try { msg = JSON.parse(data.toString()) as EventSubMessage; } catch { this.opts.log.warn('EventSub: получено некорректное сообщение'); return; }
      const type = msg.metadata?.message_type;
      if (type === 'session_welcome') {
        welcomed = true; clearTimeout(welcomeTimer);
        this.onWelcome(ws, msg, isMigration);
        return;
      }
      if (ws !== this.active) {
        // Старое соединение во время миграции продолжает доставлять события до welcome на новом.
        if (ws === this.migrating) return; // до welcome новое соединение ничего не шлёт
      }
      this.touch(ws);
      switch (type) {
        case 'session_keepalive': break;
        case 'notification': this.safeEmit('notification', msg); break;
        case 'revocation': this.safeEmit('revocation', msg); break;
        case 'session_reconnect': {
          const reconnectUrl = msg.payload.session?.reconnect_url;
          if (!reconnectUrl) { this.opts.log.warn('session_reconnect без reconnect_url'); break; }
          this.opts.log.info('EventSub: Twitch попросил переподключиться (session_reconnect), переключаюсь без потери подписок');
          if (this.migrating) closeSocket(this.migrating);
          this.openSocket(reconnectUrl, true);
          break;
        }
        default: this.opts.log.debug(`EventSub: неизвестный тип сообщения ${type}`);
      }
    });

    ws.on('error', (e) => {
      if (gen !== this.generation) return;
      this.opts.log.warn(`EventSub: ошибка сокета: ${e.message}`);
      this.patch({ lastError: e.message });
    });

    ws.on('close', (code, reasonBuf) => {
      clearTimeout(welcomeTimer);
      if (gen !== this.generation) return;
      const reason = reasonBuf?.toString() || '';
      if (ws === this.migrating) {
        this.migrating = null;
        this.opts.log.warn(`EventSub: новое соединение после session_reconnect закрыто (${code} ${reason}); старое пока работает`);
        return;
      }
      if (ws !== this.active) return; // старое соединение после успешной миграции
      this.active = null;
      this.clearWatchdog();
      if (this.migrating) {
        // Старое закрылось раньше, чем пришёл welcome на новом — новое становится активным.
        this.active = this.migrating; this.migrating = null;
        return;
      }
      if (!this.running) return;
      if (this.gapStartedAt === null) this.gapStartedAt = this._status.lastMessageAt ?? Date.now();
      this.safeEmit('disconnected', { at: Date.now(), code, reason });
      this.scheduleReconnect(describeClose(code, reason));
    });
  }

  private async onWelcome(ws: WebSocket, msg: EventSubMessage, isMigration: boolean): Promise<void> {
    const session = msg.payload.session!;
    this.keepaliveMs = (session.keepalive_timeout_seconds ?? this.opts.keepaliveSeconds ?? 30) * 1000;
    if (isMigration) {
      const old = this.active;
      this.active = ws; this.migrating = null;
      this.touch(ws);
      this.patch({ state: 'connected', sessionId: session.id });
      this.opts.log.info('EventSub: переключение на новое соединение завершено, подписки сохранены');
      if (old && old !== ws) closeSocket(old);
      return;
    }
    if (ws !== this.active) return;
    this.touch(ws);
    this.patch({ state: 'subscribing', sessionId: session.id });
    const gen = this.generation;
    try {
      await this.opts.subscribe(session.id);
      if (gen !== this.generation || ws !== this.active) return;
      this.backoff.reset();
      this.patch({ state: 'connected', connectedSince: Date.now(), lastError: null, nextRetryAt: null });
      this.opts.log.info(`EventSub: подключено, сессия ${session.id.slice(0, 8)}…`);
      const gap = this.gapStartedAt;
      this.gapStartedAt = null;
      this.safeEmit('session', { sessionId: session.id, gapStartedAt: gap });
    } catch (e) {
      if (gen !== this.generation) return;
      const err = e as Error & { needsLogin?: boolean; status?: number };
      this.opts.log.error('EventSub: не удалось создать подписку', err);
      if (err.needsLogin || err.status === 403 || err.status === 401) {
        // Повторять бессмысленно до повторного входа/исправления прав.
        this.running = false;
        this.patch({ state: 'error', lastError: `Не удалось подписаться на события: ${err.message}` });
        this.safeEmit('fatal', err);
        closeSocket(ws);
        return;
      }
      this.patch({ lastError: err.message });
      ws.terminate();
    }
  }

  private touch(ws: WebSocket): void {
    if (ws !== this.active) return;
    this.patch({ lastMessageAt: Date.now() });
    this.clearWatchdog();
    const grace = this.opts.keepaliveGraceMs ?? 5000;
    this.watchdog = setTimeout(() => {
      this.opts.log.warn(`EventSub: нет сообщений дольше ${this.keepaliveMs / 1000} с — соединение считается зависшим, переподключаюсь`);
      ws.terminate();
    }, this.keepaliveMs + grace);
  }

  private clearWatchdog(): void { if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; } }

  private scheduleReconnect(why: string): void {
    if (!this.running) return;
    const delay = this.backoff.next();
    this.opts.log.warn(`EventSub: соединение потеряно (${why}). Повтор через ${(delay / 1000).toFixed(1)} с`);
    this.patch({ state: 'reconnecting', sessionId: null, connectedSince: null, lastError: why, reconnects: this._status.reconnects + 1, nextRetryAt: Date.now() + delay });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.running) return;
      this.patch({ state: 'connecting', nextRetryAt: null });
      this.openSocket(this.baseUrl(), false);
    }, delay);
  }

  private safeEmit(event: string, arg: unknown): void {
    try { this.emit(event, arg); } catch (e) { this.opts.log.error(`Ошибка в обработчике события ${event}`, e); }
  }
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const t = setTimeout(() => { try { ws.terminate(); } catch { /* */ } resolve(); }, 2000);
    ws.once('close', () => { clearTimeout(t); resolve(); });
    try { if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); else ws.close(1000); } catch { clearTimeout(t); resolve(); }
  });
}

function describeClose(code: number, reason: string): string {
  const map: Record<number, string> = {
    1006: 'обрыв сети',
    4000: 'внутренняя ошибка сервера Twitch',
    4001: 'клиент отправил лишние данные',
    4002: 'не отвечен ping',
    4003: 'не создана подписка вовремя',
    4004: 'истекло время на переподключение',
    4005: 'сетевой таймаут',
    4006: 'сетевая ошибка',
    4007: 'неверный адрес переподключения',
  };
  return `код ${code}${map[code] ? ': ' + map[code] : ''}${reason ? ` (${reason})` : ''}`;
}
