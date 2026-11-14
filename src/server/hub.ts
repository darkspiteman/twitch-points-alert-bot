import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { OverlayTransport, PlayItem } from '../queue.ts';
import type { ScopedLogger } from '../logger.ts';
import { type StreamApp, STREAM_APPS, detectStreamAppFromUA, isStreamApp } from '../stream-app.ts';
import { PROBE_ORIGINS } from '../overlay-loader.ts';

/** app — программа для стрима (OBS Studio / Streamlabs Desktop); null — обычный браузер (предпросмотр). */
interface OverlayClient { id: string; ws: WebSocket; app: StreamApp | null; viaFile: boolean; connectedAt: number; alive: boolean; ua: string }

/**
 * isObs — overlay открыт в программе для стрима (OBS или Streamlabs), а не в браузере. Имя поля сохранено для совместимости.
 * viaFile — источник открыт через файл-загрузчик (overlay.html), а не по адресу: тогда ему не страшен запуск программы раньше бота.
 */
export interface OverlayInfo { id: string; isObs: boolean; app: StreamApp | null; viaFile: boolean; connectedAt: number }

export interface OverlayView {
  position: string;
  maxWidthPct: number;
  maxHeightPct: number;
  masterVolume: number; // 0..100
  maxDurationMs: number;
}

/**
 * WebSocket-хаб: /ws/overlay (Browser Source в OBS Studio или Streamlabs Desktop) и /ws/panel (панель управления).
 * Реализует OverlayTransport для очереди.
 */
export class Hub implements OverlayTransport {
  private overlayWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private probeWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private panelWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private overlays = new Map<string, OverlayClient>();
  private panels = new Set<WebSocket>();
  private heartbeat: NodeJS.Timeout;
  private log: ScopedLogger;
  private getView: () => OverlayView;
  private allowedOrigins: () => string[];

  onOverlayResult: (overlayId: string, itemId: string, result: 'ended' | 'error', message?: string) => void = () => {};
  onOverlayConnected: (info: OverlayInfo) => void = () => {};
  onOverlayDisconnected: (id: string) => void = () => {};
  onMediaProbe: (mediaId: string, ok: boolean, durationMs: number, message: string) => void = () => {};
  /** Overlay не смог загрузить онлайн-медиа и сыграл запасной звук. */
  onOverlayFallback: (itemId: string, message: string) => void = () => {};

  constructor(log: ScopedLogger, getView: () => OverlayView, allowedOrigins: () => string[]) {
    this.log = log;
    this.getView = getView;
    this.allowedOrigins = allowedOrigins;
    this.overlayWss.on('connection', (ws, req) => this.onOverlay(ws, req));
    this.panelWss.on('connection', (ws) => this.onPanel(ws));
    // Проверка «бот запущен?» для файла-загрузчика: ответ и сразу закрытие, никаких данных бота.
    this.probeWss.on('connection', (ws) => { ws.on('error', () => {}); ws.send(JSON.stringify({ type: 'ready', app: 'twitch-alert-bot' }), () => ws.close(1000)); });
    this.heartbeat = setInterval(() => this.beat(), 15_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    // Загрузчик открыт как локальный файл (в OBS — http://absolute/…), поэтому для /ws/probe разрешены и эти источники.
    const allowed = url.pathname === '/ws/probe' ? [...this.allowedOrigins(), ...PROBE_ORIGINS] : this.allowedOrigins();
    if (origin && !allowed.includes(origin)) {
      this.log.warn(`Отклонено WebSocket-подключение с чужого источника: ${origin.slice(0, 100)}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    if (url.pathname === '/ws/overlay') this.overlayWss.handleUpgrade(req, socket, head, (ws) => this.overlayWss.emit('connection', ws, req));
    else if (url.pathname === '/ws/probe') this.probeWss.handleUpgrade(req, socket, head, (ws) => this.probeWss.emit('connection', ws, req));
    else if (url.pathname === '/ws/panel') this.panelWss.handleUpgrade(req, socket, head, (ws) => this.panelWss.emit('connection', ws, req));
    else { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
  }

  private onOverlay(ws: WebSocket, req: IncomingMessage): void {
    const id = crypto.randomUUID().slice(0, 8);
    const ua = String(req.headers['user-agent'] ?? '');
    const client: OverlayClient = { id, ws, app: detectStreamAppFromUA(ua), viaFile: false, connectedAt: Date.now(), alive: true, ua };
    this.overlays.set(id, client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => {
      let m: { type?: string; id?: string; message?: string; isObs?: boolean; app?: unknown; via?: unknown; mediaId?: string; ok?: boolean; durationMs?: number };
      try { m = JSON.parse(data.toString()); } catch { return; }
      client.alive = true;
      try {
        switch (m.type) {
          case 'hello':
            // Overlay сам видит window.obsstudio (есть и в OBS, и в Streamlabs) — доверяем ему, если User-Agent не подсказал.
            if (isStreamApp(m.app) && (client.app === null || m.app === 'streamlabs')) client.app = m.app;
            else if (m.isObs && client.app === null) client.app = 'obs';
            client.viaFile = m.via === 'file';
            this.log.info(`Overlay подключён (${client.app ? STREAM_APPS[client.app].name : 'браузер'}${client.viaFile ? ', через файл' : ''}), id ${id}`);
            this.onOverlayConnected(this.info(client));
            break;
          case 'ended': if (m.id) this.onOverlayResult(id, String(m.id), 'ended'); break;
          case 'error': if (m.id) this.onOverlayResult(id, String(m.id), 'error', String(m.message ?? '').slice(0, 300)); break;
          case 'fallback': if (m.id) this.onOverlayFallback(String(m.id), String(m.message ?? '').slice(0, 300)); break;
          case 'pong': break;
        }
      } catch (e) { this.log.error('Ошибка обработки сообщения overlay', e); }
    });
    ws.on('close', () => {
      this.overlays.delete(id);
      this.log.info(`Overlay отключён, id ${id}`);
      try { this.onOverlayDisconnected(id); } catch (e) { this.log.error('Ошибка при отключении overlay', e); }
    });
    ws.on('error', () => {});
    this.send(ws, { type: 'hello', overlayId: id, view: this.getView() });
  }

  private onPanel(ws: WebSocket): void {
    this.panels.add(ws);
    ws.on('message', (data) => {
      let m: { type?: string; mediaId?: string; ok?: boolean; durationMs?: number; message?: string };
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'probe' && m.mediaId) {
        try { this.onMediaProbe(String(m.mediaId), Boolean(m.ok), Number(m.durationMs) || 0, String(m.message ?? '').slice(0, 300)); } catch (e) { this.log.error('probe', e); }
      }
    });
    ws.on('close', () => this.panels.delete(ws));
    ws.on('error', () => {});
    this.send(ws, { type: 'hello' });
  }

  private beat(): void {
    for (const c of this.overlays.values()) {
      if (!c.alive) { this.log.warn(`Overlay ${c.id} не отвечает — соединение закрыто`); c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* */ }
      this.send(c.ws, { type: 'ping' });
    }
    for (const p of this.panels) { try { p.ping(); } catch { /* */ } }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* */ } }
  }

  private info(c: OverlayClient): OverlayInfo {
    return { id: c.id, isObs: c.app !== null, app: c.app, viaFile: c.viaFile, connectedAt: c.connectedAt };
  }

  overlayList(): OverlayInfo[] {
    return [...this.overlays.values()].map((c) => this.info(c));
  }

  /** Получатели: overlay в программе для стрима (OBS или Streamlabs), если есть; иначе — все (например, предпросмотр в браузере). */
  overlayIds(): string[] {
    const all = [...this.overlays.values()];
    const streaming = all.filter((c) => c.app !== null);
    return (streaming.length ? streaming : all).map((c) => c.id);
  }

  play(ids: string[], item: PlayItem, effectiveDurationMs: number): void {
    const view = this.getView();
    const msg = {
      type: 'play',
      item: {
        id: item.id, visual: item.visual, audio: item.audio, fallbackAudio: item.fallbackAudio ?? null, caption: item.caption, chromaKey: !!item.chromaKey,
        volume: Math.max(0, Math.min(1, item.volume * (view.masterVolume / 100))),
        durationMs: effectiveDurationMs, maxDurationMs: view.maxDurationMs,
      },
    };
    for (const id of ids) { const c = this.overlays.get(id); if (c) this.send(c.ws, msg); }
  }

  stop(itemId: string): void {
    for (const c of this.overlays.values()) this.send(c.ws, { type: 'stop', id: itemId });
  }

  pushView(): void {
    const view = this.getView();
    for (const c of this.overlays.values()) this.send(c.ws, { type: 'view', view });
  }

  /** Сообщение всем открытым панелям. */
  broadcastPanel(msg: unknown): void {
    for (const p of this.panels) this.send(p, msg);
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const c of this.overlays.values()) { try { c.ws.close(1001, 'shutdown'); } catch { /* */ } }
    for (const p of this.panels) { try { p.close(1001, 'shutdown'); } catch { /* */ } }
    await Promise.all([this.overlayWss, this.panelWss, this.probeWss].map((w) => new Promise((r) => w.close(() => r(null)))));
  }
}
