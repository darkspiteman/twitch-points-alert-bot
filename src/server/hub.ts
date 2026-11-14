import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { OverlayTransport, PlayItem } from '../queue.ts';
import type { ScopedLogger } from '../logger.ts';

interface OverlayClient { id: string; ws: WebSocket; isObs: boolean; connectedAt: number; alive: boolean; ua: string }

export interface OverlayInfo { id: string; isObs: boolean; connectedAt: number }

export interface OverlayView {
  position: string;
  maxWidthPct: number;
  maxHeightPct: number;
  masterVolume: number; // 0..100
  maxDurationMs: number;
}

/**
 * WebSocket-хаб: /ws/overlay (OBS Browser Source) и /ws/panel (панель управления).
 * Реализует OverlayTransport для очереди.
 */
export class Hub implements OverlayTransport {
  private overlayWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
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
    this.heartbeat = setInterval(() => this.beat(), 15_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins().includes(origin)) {
      this.log.warn(`Отклонено WebSocket-подключение с чужого источника: ${origin.slice(0, 100)}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    if (url.pathname === '/ws/overlay') this.overlayWss.handleUpgrade(req, socket, head, (ws) => this.overlayWss.emit('connection', ws, req));
    else if (url.pathname === '/ws/panel') this.panelWss.handleUpgrade(req, socket, head, (ws) => this.panelWss.emit('connection', ws, req));
    else { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
  }

  private onOverlay(ws: WebSocket, req: IncomingMessage): void {
    const id = crypto.randomUUID().slice(0, 8);
    const ua = String(req.headers['user-agent'] ?? '');
    const client: OverlayClient = { id, ws, isObs: /\bOBS\//i.test(ua), connectedAt: Date.now(), alive: true, ua };
    this.overlays.set(id, client);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => {
      let m: { type?: string; id?: string; message?: string; isObs?: boolean; mediaId?: string; ok?: boolean; durationMs?: number };
      try { m = JSON.parse(data.toString()); } catch { return; }
      client.alive = true;
      try {
        switch (m.type) {
          case 'hello':
            if (m.isObs) client.isObs = true;
            this.log.info(`Overlay подключён (${client.isObs ? 'OBS' : 'браузер'}), id ${id}`);
            this.onOverlayConnected({ id, isObs: client.isObs, connectedAt: client.connectedAt });
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

  overlayList(): OverlayInfo[] {
    return [...this.overlays.values()].map((c) => ({ id: c.id, isObs: c.isObs, connectedAt: c.connectedAt }));
  }

  /** Получатели: OBS-overlay, если есть; иначе — все (например, предпросмотр в браузере). */
  overlayIds(): string[] {
    const all = [...this.overlays.values()];
    const obs = all.filter((c) => c.isObs);
    return (obs.length ? obs : all).map((c) => c.id);
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
    await Promise.all([new Promise((r) => this.overlayWss.close(() => r(null))), new Promise((r) => this.panelWss.close(() => r(null)))]);
  }
}
