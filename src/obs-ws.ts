import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { ScopedLogger } from './logger.ts';

/**
 * Клиент OBS WebSocket 5 (встроен в OBS Studio с версии 28: «Сервис» → «Настройки сервера WebSocket»).
 * Только чтение: состояние трансляции, байты вывода (→ битрейт), кадры, CPU, разрешение.
 * Никаких команд, меняющих сцены или настройки OBS, бот не отправляет.
 */

export type ObsState = 'off' | 'connecting' | 'ok' | 'disabled' | 'auth_failed' | 'error';

export interface ObsWsConfig { port: number; password: string; enabled: boolean | null; fromFile: boolean }

/** Настройки сервера из конфигурации OBS (plugin_config/obs-websocket/config.json). null — файла нет. */
export function readObsWsConfig(obsConfigDir: string): { port: number; password: string; enabled: boolean; authRequired: boolean } | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(obsConfigDir, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')) as Record<string, unknown>;
    const port = Number(j.server_port);
    return {
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4455,
      password: typeof j.server_password === 'string' ? j.server_password : '',
      enabled: j.server_enabled === true,
      authRequired: j.auth_required !== false,
    };
  } catch { return null; }
}

/** Ответ на запрос пароля OBS WebSocket 5: base64(sha256(base64(sha256(пароль + salt)) + challenge)). */
export function obsAuthString(password: string, salt: string, challenge: string): string {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

export interface ObsSample {
  at: number;
  streaming: boolean;
  reconnecting: boolean;
  /** Длительность трансляции, мс. */
  durationMs: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
  congestion: number;
  cpu: number;
  memoryMb: number;
  activeFps: number;
  renderSkippedFrames: number;
  renderTotalFrames: number;
}

export interface ObsVideo { width: number; height: number; baseWidth: number; baseHeight: number; fps: number }

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;
/** Подписка только на события выходов (StreamStateChanged). */
const EVENTS_OUTPUTS = 1 << 6;

export interface ObsClientOptions {
  log: ScopedLogger;
  /** Куда подключаться (вызывается перед каждой попыткой: настройки могли измениться). */
  getConfig: () => ObsWsConfig;
  pollMs?: number;
  host?: string;
}

/**
 * Подключение к OBS с переподключением. События: 'state' (ObsState, message), 'sample' (ObsSample), 'video' (ObsVideo),
 * 'stream' (boolean — трансляция началась/закончилась).
 */
export class ObsClient extends EventEmitter {
  private opts: ObsClientOptions;
  private ws: WebSocket | null = null;
  private running = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private polls = 0;
  private _state: ObsState = 'off';
  private _message = '';
  video: ObsVideo | null = null;
  version = '';

  constructor(opts: ObsClientOptions) {
    super();
    this.opts = opts;
  }

  get state(): ObsState { return this._state; }
  get message(): string { return this._message; }

  private setState(s: ObsState, message = ''): void {
    if (s === this._state && message === this._message) return;
    this._state = s;
    this._message = message;
    this.emit('state', s, message);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.cleanup();
    this.setState('off');
  }

  /** Переподключиться сразу (например, после смены пароля). */
  restart(): void {
    if (!this.running) return;
    this.cleanup();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  private cleanup(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); try { ws.terminate(); } catch { /* */ } }
  }

  private retry(ms: number): void {
    this.cleanup();
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, ms);
    this.retryTimer.unref();
  }

  private connect(): void {
    if (!this.running) return;
    const cfg = this.opts.getConfig();
    if (cfg.enabled === false) {
      // Сервер выключен в настройках OBS — проверяем файл реже (пользователь включит галочку).
      this.setState('disabled', 'В OBS выключен сервер WebSocket');
      this.retry(5000);
      return;
    }
    if (this._state !== 'ok') this.setState(this._state === 'auth_failed' ? 'auth_failed' : 'connecting', this._state === 'auth_failed' ? this._message : '');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.opts.host ?? '127.0.0.1'}:${cfg.port}`, { handshakeTimeout: 4000, maxPayload: 4 * 1024 * 1024 });
    } catch (e) {
      this.setState('error', (e as Error).message);
      this.retry(5000);
      return;
    }
    this.ws = ws;
    let identified = false;
    ws.on('message', (data) => {
      let m: { op?: number; d?: Record<string, unknown> };
      try { m = JSON.parse(data.toString()); } catch { return; }
      const d = m.d ?? {};
      if (m.op === OP.Hello) {
        this.version = String(d.obsWebSocketVersion ?? '');
        const auth = d.authentication as { challenge?: string; salt?: string } | undefined;
        const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: EVENTS_OUTPUTS };
        if (auth?.challenge && auth.salt) {
          if (!cfg.password) { this.setState('auth_failed', 'OBS требует пароль WebSocket, а он не найден'); this.retry(10_000); return; }
          identify.authentication = obsAuthString(cfg.password, auth.salt, auth.challenge);
        }
        ws.send(JSON.stringify({ op: OP.Identify, d: identify }));
      } else if (m.op === OP.Identified) {
        identified = true;
        this.opts.log.info(`Подключено к OBS WebSocket ${this.version}`);
        this.setState('ok');
        this.polls = 0;
        void this.poll();
        this.pollTimer = setInterval(() => void this.poll(), this.opts.pollMs ?? 2000);
        this.pollTimer.unref();
      } else if (m.op === OP.RequestResponse) {
        const id = String(d.requestId ?? '');
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const st = d.requestStatus as { result?: boolean; comment?: string; code?: number } | undefined;
        if (st?.result) p.resolve((d.responseData ?? {}) as Record<string, unknown>);
        else p.reject(new Error(st?.comment || `код ${st?.code ?? '?'}`));
      } else if (m.op === OP.Event) {
        if (d.eventType === 'StreamStateChanged') {
          const ed = (d.eventData ?? {}) as { outputActive?: boolean; outputState?: string };
          if (ed.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' || ed.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
            this.emit('stream', Boolean(ed.outputActive));
            void this.poll();
          }
        }
      }
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      if (code === 4009) {
        this.opts.log.warn('OBS WebSocket: неверный пароль');
        this.setState('auth_failed', 'OBS не принял пароль WebSocket');
        this.retry(15_000);
        return;
      }
      if (identified) this.opts.log.info(`Соединение с OBS WebSocket закрыто (код ${code})`);
      this.setState('connecting', identified ? 'Связь с OBS потеряна' : 'OBS не запущен или сервер WebSocket недоступен');
      this.retry(identified ? 2000 : 5000);
    });
    ws.on('error', () => { /* после ошибки придёт close */ });
  }

  request(requestType: string, requestData?: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Нет связи с OBS'));
    const requestId = `tab-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('OBS не ответил')); }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } })); } catch (e) {
        clearTimeout(timer); this.pending.delete(requestId); reject(e as Error);
      }
    });
  }

  private async poll(): Promise<void> {
    if (this._state !== 'ok') return;
    try {
      // Разрешение и FPS меняются редко — раз в ~30 секунд.
      if (this.polls++ % 15 === 0 || !this.video) {
        const v = await this.request('GetVideoSettings');
        const num = Number(v.fpsNumerator) || 0, den = Number(v.fpsDenominator) || 1;
        this.video = {
          width: Number(v.outputWidth) || 0, height: Number(v.outputHeight) || 0,
          baseWidth: Number(v.baseWidth) || 0, baseHeight: Number(v.baseHeight) || 0, fps: Math.round((num / den) * 100) / 100,
        };
        this.emit('video', this.video);
      }
      const [st, stats] = await Promise.all([this.request('GetStreamStatus'), this.request('GetStats')]);
      const sample: ObsSample = {
        at: Date.now(),
        streaming: Boolean(st.outputActive),
        reconnecting: Boolean(st.outputReconnecting),
        durationMs: Number(st.outputDuration) || 0,
        outputBytes: Number(st.outputBytes) || 0,
        outputSkippedFrames: Number(st.outputSkippedFrames) || 0,
        outputTotalFrames: Number(st.outputTotalFrames) || 0,
        congestion: Number(st.outputCongestion) || 0,
        cpu: Number(stats.cpuUsage) || 0,
        memoryMb: Number(stats.memoryUsage) || 0,
        activeFps: Number(stats.activeFps) || 0,
        renderSkippedFrames: Number(stats.renderSkippedFrames) || 0,
        renderTotalFrames: Number(stats.renderTotalFrames) || 0,
      };
      this.emit('sample', sample);
    } catch (e) {
      if (this._state === 'ok') this.opts.log.debug(`OBS: запрос статистики не удался: ${(e as Error).message}`);
    }
  }
}
