import { EventEmitter } from 'node:events';
import type { ScopedLogger } from './logger.ts';

export interface MediaRef {
  id: string; url: string; kind: 'audio' | 'video' | 'image'; mime: string;
  /** Онлайн-медиа (Klipy): «тип/slug»; адрес подставляется перед показом. */
  remote?: string;
}

export interface PlayItem {
  id: string;
  redemptionId: string | null;
  rewardId: string;
  rewardTitle: string;
  userName: string;
  userInput: string;
  visual: MediaRef | null;
  audio: MediaRef | null;
  /** Громкость награды 0..1 (общая громкость применяется при отправке). */
  volume: number;
  /** 0 — автоматически (до конца видео/звука; для картинок — длительность по умолчанию). */
  durationMs: number;
  delayMs: number;
  caption: string | null;
  /** Убрать зелёный фон у видео. */
  chromaKey?: boolean;
  /** Запасной звук, если онлайн-медиа не загрузилось. */
  fallbackAudio?: MediaRef | null;
  /** 1.7.0: что озвучить голосом Windows (уже очищено фильтрами); файл создаётся перед показом. */
  ttsText?: string | null;
  /** Готовая озвучка: файл и его длительность. Играет после звука/видео награды (с картинкой — сразу). */
  tts?: { url: string; ms: number } | null;
  source: 'eventsub' | 'recovery' | 'test' | 'simulate';
  createdAt: number;
}

export type ItemResult = 'done' | 'failed' | 'skipped' | 'dropped';

export interface QueueSettings {
  maxQueueLength: number;
  delayBeforeMs: number;
  gapBetweenMs: number;
  maxItemAgeSec: number;
  maxDurationMs: number;
  defaultImageDurationMs: number;
}

/** Канал доставки к overlay (реализуется WebSocket-хабом). */
export interface OverlayTransport {
  overlayIds(): string[];
  play(overlayIds: string[], item: PlayItem, effectiveDurationMs: number): void;
  stop(itemId: string): void;
}

interface Current { item: PlayItem; pending: Set<string>; errors: string[]; timer: NodeJS.Timeout; startedAt: number }

/**
 * Очередь воспроизведения. Элементы проигрываются строго по одному.
 * События: 'change' (snapshot), 'started' (item), 'finished' ({ item, result, message }).
 */
export class PlaybackQueue extends EventEmitter {
  private items: PlayItem[] = [];
  private current: Current | null = null;
  private busy = false; // ожидание задержки/паузы между элементами
  private paused = false;
  private transport: OverlayTransport;
  private getSettings: () => QueueSettings;
  private log: ScopedLogger;
  private wakeTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  /** Подготовка элемента перед показом (адреса онлайн-медиа). Ошибка — элемент завершается с 'failed'. */
  private prepare: ((item: PlayItem) => Promise<PlayItem>) | null;
  private preparing: PlayItem | null = null;

  constructor(transport: OverlayTransport, getSettings: () => QueueSettings, log: ScopedLogger, prepare?: (item: PlayItem) => Promise<PlayItem>) {
    super();
    this.transport = transport;
    this.getSettings = getSettings;
    this.log = log;
    this.prepare = prepare ?? null;
  }

  snapshot() {
    return {
      paused: this.paused,
      current: this.current ? { ...summary(this.current.item), startedAt: this.current.startedAt } : this.preparing ? { ...summary(this.preparing), startedAt: Date.now() } : null,
      items: this.items.map(summary),
    };
  }

  get length(): number { return this.items.length; }

  enqueue(item: PlayItem): { ok: true } | { ok: false; reason: string } {
    const s = this.getSettings();
    if (this.items.length >= s.maxQueueLength) return { ok: false, reason: `Очередь переполнена (максимум ${s.maxQueueLength})` };
    this.items.push(item);
    this.changed();
    this.pump();
    return { ok: true };
  }

  skip(): boolean {
    if (!this.current) return false;
    this.transport.stop(this.current.item.id);
    this.finish('skipped', 'Пропущено вручную');
    return true;
  }

  clear(): number {
    const removed = this.items.splice(0);
    for (const item of removed) this.emit('finished', { item, result: 'skipped', message: 'Очередь очищена' });
    this.changed();
    return removed.length;
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [item] = this.items.splice(i, 1);
    this.emit('finished', { item, result: 'skipped', message: 'Удалено из очереди' });
    this.changed();
    return true;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.changed();
    if (!p) this.pump();
  }

  /** Overlay сообщил результат воспроизведения. */
  report(overlayId: string, itemId: string, result: 'ended' | 'error', message?: string): void {
    const c = this.current;
    if (!c || c.item.id !== itemId) return;
    if (!c.pending.has(overlayId)) return;
    c.pending.delete(overlayId);
    if (result === 'error') c.errors.push(message || 'ошибка воспроизведения');
    if (c.pending.size === 0) {
      if (c.errors.length) this.finish('failed', `Ошибка воспроизведения: ${c.errors[0]}`);
      else this.finish('done', '');
    }
  }

  overlayConnected(): void { this.pump(); }

  overlayDisconnected(overlayId: string): void {
    const c = this.current;
    if (!c || !c.pending.has(overlayId)) return;
    c.pending.delete(overlayId);
    if (c.pending.size === 0) this.finish('failed', 'Overlay отключился во время воспроизведения');
  }

  private effectiveDuration(item: PlayItem, s: QueueSettings): number {
    if (item.durationMs > 0) return Math.min(item.durationMs, s.maxDurationMs);
    if (!item.audio && item.visual?.kind === 'image') return Math.min(s.defaultImageDurationMs, s.maxDurationMs);
    return 0; // до конца медиа, но не дольше maxDurationMs (контролирует overlay и таймаут)
  }

  private pump(): void {
    if (this.disposed || this.current || this.busy || this.paused || this.items.length === 0) return;
    const s = this.getSettings();
    // Удаляем устаревшие элементы, чтобы после долгого простоя не проигрывать старые награды.
    while (this.items.length && Date.now() - this.items[0].createdAt > s.maxItemAgeSec * 1000) {
      const old = this.items.shift()!;
      this.emit('finished', { item: old, result: 'dropped', message: `Устарело: ждало дольше ${s.maxItemAgeSec} с` });
      this.changed();
    }
    if (!this.items.length) return;
    const overlays = this.transport.overlayIds();
    if (overlays.length === 0) {
      this.scheduleWake(2000); // ждём подключения overlay (и периодически чистим устаревшие)
      return;
    }
    const item = this.items[0];
    const delay = s.delayBeforeMs + item.delayMs;
    this.busy = true;
    this.after(delay, () => {
      this.busy = false;
      if (this.disposed || this.paused || this.current) return this.pump();
      if (this.items[0] !== item) return this.pump(); // очередь изменилась во время задержки
      const ids = this.transport.overlayIds();
      if (ids.length === 0) return this.pump();
      this.items.shift();
      if (this.prepare && (item.visual?.remote || item.audio?.remote || (item.ttsText && !item.tts))) {
        this.busy = true;
        this.preparing = item;
        this.prepare(item).then(
          (ready) => { this.busy = false; this.preparing = null; if (!this.disposed) this.start(ready); },
          (e: Error) => {
            this.busy = false; this.preparing = null;
            if (this.disposed) return;
            this.emit('finished', { item, result: 'failed', message: `Ошибка воспроизведения: ${e.message}` });
            this.changed();
            this.pump();
          });
        return;
      }
      this.start(item);
    });
  }

  private start(item: PlayItem): void {
    const s = this.getSettings();
    const ids = this.transport.overlayIds();
    if (ids.length === 0) { this.items.unshift(item); this.changed(); return this.pump(); }
    const duration = this.effectiveDuration(item, s);
    const hardLimit = (duration > 0 ? duration : s.maxDurationMs) + (item.tts ? item.tts.ms : 0) + 5000;
    const timer = setTimeout(() => {
      this.log.warn(`Overlay не сообщил об окончании «${item.rewardTitle}» за ${hardLimit} мс — переходим к следующему`);
      this.transport.stop(item.id);
      this.finish('done', 'Завершено по таймауту');
    }, hardLimit);
    timer.unref?.();
    this.current = { item, pending: new Set(ids), errors: [], timer, startedAt: Date.now() };
    this.changed();
    this.emit('started', item);
    try {
      this.transport.play(ids, item, duration);
    } catch (e) {
      this.log.error('Не удалось отправить элемент в overlay', e);
      this.finish('failed', 'Не удалось отправить в overlay');
    }
  }

  private finish(result: ItemResult, message: string): void {
    const c = this.current;
    if (!c) return;
    clearTimeout(c.timer);
    this.current = null;
    this.emit('finished', { item: c.item, result, message });
    this.changed();
    const gap = this.getSettings().gapBetweenMs;
    this.busy = true;
    this.after(gap, () => { this.busy = false; this.pump(); });
  }

  private after(ms: number, fn: () => void): void {
    if (ms <= 0) { queueMicrotask(fn); return; }
    setTimeout(fn, ms);
  }

  private scheduleWake(ms: number): void {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.pump(); }, ms);
    this.wakeTimer.unref?.();
  }

  private changed(): void { this.emit('change', this.snapshot()); }

  /** Остановка без проигрывания оставшегося. Возвращает незавершённые элементы. */
  dispose(): PlayItem[] {
    this.disposed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const left = [...this.items];
    if (this.preparing) { left.unshift(this.preparing); this.preparing = null; }
    if (this.current) { clearTimeout(this.current.timer); left.unshift(this.current.item); this.current = null; }
    this.items = [];
    return left;
  }
}

function summary(i: PlayItem) {
  return { id: i.id, rewardTitle: i.rewardTitle, userName: i.userName, source: i.source, createdAt: i.createdAt };
}
