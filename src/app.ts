import { EventEmitter } from 'node:events';
import { Db } from './db.ts';
import { Logger, type ScopedLogger } from './logger.ts';
import { type Paths, APP_VERSION, APP_ROOT, UPDATE_REPO } from './config.ts';
import type { SecureStore } from './secure-store.ts';
import { TwitchAuth, type FetchFn, SCOPE_MANAGE } from './twitch/auth.ts';
import { HelixClient, HelixError, type HelixReward } from './twitch/helix.ts';
import { EventSubClient } from './twitch/eventsub.ts';
import { PlaybackQueue } from './queue.ts';
import { MediaLibrary } from './media.ts';
import { RedemptionRouter, REDEMPTION_TYPE, REDEMPTION_VERSION } from './router.ts';
import { Hub } from './server/hub.ts';
import { Backoff } from './backoff.ts';
import { MediaFinder } from './find.ts';
import { STREAM_APPS, backupScenes as copySceneFiles } from './stream-app.ts';
import { Updater } from './update.ts';
import { writeLoader } from './overlay-loader.ts';
import type { Transport } from './net/safe-download.ts';

export interface AppOptions {
  paths: Paths;
  logger: Logger;
  store: SecureStore;
  port: number;
  fetchFn?: FetchFn;
  idBase?: string;
  helixBase?: string;
  eventsubUrl?: string;
  eventsubKeepaliveSec?: number;
  eventsubBackoff?: Backoff;
  /** Подмена транспорта скачивания (тесты). */
  downloadTransport?: Transport;
  klipyBase?: string;
  freesoundBase?: string;
  /** Папка программы (для обновлений; в тестах — временная). */
  appRoot?: string;
  /** Не проверять обновления автоматически (тесты). */
  noAutoUpdateCheck?: boolean;
}

/**
 * Контейнер приложения: связывает БД, авторизацию, EventSub, очередь, overlay и панель.
 * Используется и в main.ts, и в интеграционных тестах.
 */
export class App extends EventEmitter {
  readonly opts: AppOptions;
  readonly db: Db;
  readonly log: ScopedLogger;
  readonly auth: TwitchAuth;
  readonly helix: HelixClient;
  readonly eventsub: EventSubClient;
  readonly queue: PlaybackQueue;
  readonly media: MediaLibrary;
  readonly router: RedemptionRouter;
  readonly hub: Hub;
  readonly finder: MediaFinder;
  readonly updater: Updater;
  readonly startedAt = Date.now();
  port: number;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private subscribedSessions = new Set<string>();
  /** Файл-загрузчик overlay для «Локального файла» в OBS/Streamlabs (пусто, если записать не удалось). */
  loaderPath = '';
  /** Первичная синхронизация наград (для тестов и диагностики). */
  initialSync: Promise<unknown> = Promise.resolve();

  constructor(opts: AppOptions) {
    super();
    this.opts = opts;
    this.port = opts.port;
    this.log = opts.logger.child('app');
    this.db = new Db(opts.paths.dbFile);
    const dropped = this.db.dropStaleQueue();
    if (dropped) this.journal('warn', 'startup', `После перезапуска отменено незавершённых оповещений: ${dropped} (старые награды не воспроизводятся)`);

    this.auth = new TwitchAuth({
      store: opts.store, log: opts.logger.child('auth'), fetchFn: opts.fetchFn, idBase: opts.idBase,
      getClientId: () => this.db.getSettings().clientId,
      wantManage: () => this.db.getSettings().allowManageRewards,
    });
    this.helix = new HelixClient(this.auth, opts.logger.child('helix'), { fetchFn: opts.fetchFn, base: opts.helixBase });
    this.media = new MediaLibrary(this.db, opts.paths.mediaDir);

    this.hub = new Hub(opts.logger.child('hub'), () => {
      const s = this.db.getSettings();
      return { position: s.overlayPosition, maxWidthPct: s.overlayMaxWidthPct, maxHeightPct: s.overlayMaxHeightPct, masterVolume: s.masterVolume, maxDurationMs: s.maxDurationMs };
    }, () => [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);

    this.finder = new MediaFinder({
      db: this.db, media: this.media, log: opts.logger.child('find'), journal: (l, t, m) => this.journal(l, t, m),
      fetchFn: opts.fetchFn, transport: opts.downloadTransport, klipyBase: opts.klipyBase, freesoundBase: opts.freesoundBase,
    });
    this.updater = new Updater({
      db: this.db, log: opts.logger.child('update'), journal: (l, t, m) => this.journal(l, t, m),
      appRoot: opts.appRoot ?? APP_ROOT, dataDir: opts.paths.dataDir, currentVersion: APP_VERSION, repo: UPDATE_REPO,
      fetchFn: opts.fetchFn, transport: opts.downloadTransport,
      onChange: (s) => this.hub.broadcastPanel({ type: 'update', update: s }),
    });
    this.queue = new PlaybackQueue(this.hub, () => this.db.getSettings(), opts.logger.child('queue'), (item) => this.finder.prepare(item));
    this.router = new RedemptionRouter({
      db: this.db, media: this.media, queue: this.queue, log: opts.logger.child('router'),
      helix: () => (this.auth.state.status === 'ok' ? this.helix : null),
      broadcasterId: () => this.auth.user?.id || null,
      journal: (l, t, m) => this.journal(l, t, m),
    });

    this.eventsub = new EventSubClient({
      log: opts.logger.child('eventsub'), url: opts.eventsubUrl, keepaliveSeconds: opts.eventsubKeepaliveSec ?? 30, backoff: opts.eventsubBackoff,
      subscribe: (sessionId) => this.subscribe(sessionId),
    });

    this.wire();
  }

  private wire(): void {
    this.hub.onOverlayResult = (oid, itemId, result, msg) => this.queue.report(oid, itemId, result, msg);
    this.hub.onOverlayConnected = () => { this.queue.overlayConnected(); this.pushStatus(); };
    this.hub.onOverlayDisconnected = (id) => { this.queue.overlayDisconnected(id); this.pushStatus(); };
    this.hub.onOverlayFallback = (itemId, message) => {
      const cur = this.queue.snapshot().current;
      const title = cur && cur.id === itemId ? cur.rewardTitle : 'оповещение';
      this.journal('warn', 'online', `«${title}»: онлайн-медиа не загрузилось в ${STREAM_APPS[this.db.getSettings().streamApp].short} (${message || 'ошибка'}) — сыграл запасной звук`);
    };
    this.hub.onMediaProbe = (mediaId, ok, durationMs, message) => {
      const m = this.db.getMedia(mediaId);
      if (!m) return;
      if (ok) this.db.updateMediaStatus(mediaId, m.status === 'broken' ? 'ok' : m.status, m.status === 'broken' ? '' : m.status_msg, durationMs);
      else this.db.updateMediaStatus(mediaId, 'broken', `Браузер не может воспроизвести файл: ${message}`);
      this.hub.broadcastPanel({ type: 'invalidate', what: 'media' });
    };

    this.queue.on('change', (snap) => this.hub.broadcastPanel({ type: 'queue', queue: snap }));
    this.router.on('redemption', () => this.hub.broadcastPanel({ type: 'invalidate', what: 'redemptions' }));

    this.auth.on('state', () => this.pushStatus());
    this.auth.on('logged_in', () => {
      this.syncRewards().catch((e) => this.log.warn('Синхронизация наград не удалась', e));
      this.eventsub.restart();
    });
    this.auth.on('logged_out', (reason: 'expired' | 'manual') => {
      void this.eventsub.stop();
      if (reason === 'expired') this.journal('error', 'auth', 'Требуется повторный вход в Twitch: события наград не принимаются');
      else this.journal('info', 'auth', 'Выполнен выход из Twitch');
    });

    this.eventsub.on('status', () => this.pushStatus());
    this.eventsub.on('notification', (msg) => { this.router.handleNotification(msg); });
    this.eventsub.on('revocation', (msg) => {
      const sub = msg.payload.subscription;
      const reasons: Record<string, string> = {
        authorization_revoked: 'доступ приложения отозван в настройках Twitch',
        user_removed: 'пользователь удалён или заблокирован',
        version_removed: 'версия подписки больше не поддерживается Twitch',
      };
      this.journal('error', 'eventsub', `Twitch отменил подписку на награды: ${reasons[sub?.status] ?? sub?.status}. Переподключаюсь.`);
      if (sub?.status === 'authorization_revoked') { this.auth.validate().catch(() => {}); return; }
      // Пробуем создать подписку заново на новой сессии.
      setTimeout(() => this.eventsub.restart(), 5000).unref();
    });
    this.eventsub.on('disconnected', () => this.journal('warn', 'eventsub', 'Соединение с Twitch EventSub потеряно, переподключаюсь…'));
    this.eventsub.on('session', ({ gapStartedAt }: { gapStartedAt: number | null }) => {
      this.journal('info', 'eventsub', gapStartedAt ? 'Соединение с Twitch EventSub восстановлено' : 'Подключено к Twitch EventSub');
      if (gapStartedAt) this.router.recoverGap(gapStartedAt, Date.now()).catch((e) => this.log.warn('Восстановление пропущенных событий не удалось', e));
    });
    this.eventsub.on('fatal', (e: Error) => this.journal('error', 'eventsub', `Подписка на события невозможна: ${e.message}`));
  }

  /** Создание подписки на погашения на новой сессии EventSub (без дубликатов). */
  private async subscribe(sessionId: string): Promise<void> {
    if (this.subscribedSessions.has(sessionId)) return;
    const user = this.auth.user;
    if (!user?.id) throw Object.assign(new Error('Не выполнен вход в Twitch'), { needsLogin: true });
    try {
      await this.helix.createEventSubSubscription(REDEMPTION_TYPE, REDEMPTION_VERSION, { broadcaster_user_id: user.id }, sessionId);
    } catch (e) {
      if (e instanceof HelixError && e.status === 409) { this.subscribedSessions.add(sessionId); return; } // уже существует
      throw e;
    }
    this.subscribedSessions.add(sessionId);
    if (this.subscribedSessions.size > 20) this.subscribedSessions = new Set([sessionId]);
    // Чистим «мёртвые» websocket-подписки прошлых сессий (best effort, не блокирует).
    this.cleanupSubscriptions(sessionId).catch(() => {});
  }

  private async cleanupSubscriptions(currentSession: string): Promise<void> {
    const subs = await this.helix.getEventSubSubscriptions();
    for (const s of subs) {
      if (s.transport.method === 'websocket' && s.type === REDEMPTION_TYPE && s.transport.session_id !== currentSession && s.status !== 'enabled') {
        await this.helix.deleteEventSubSubscription(s.id).catch(() => {});
      }
    }
  }

  async start(): Promise<void> {
    try { this.loaderPath = writeLoader(this.opts.paths.dataDir, this.port); } catch (e) { this.log.warn('Не удалось записать файл-загрузчик overlay', e); }
    await this.auth.init();
    if (this.auth.state.status === 'ok') {
      this.initialSync = this.syncRewards().catch((e) => this.log.warn('Синхронизация наград при старте не удалась', e));
      this.eventsub.start();
    }
    try { this.media.verifyAll(); } catch (e) { this.log.warn('Проверка медиафайлов не удалась', e); }
    const s = this.db.getSettings();
    this.db.cleanup(s.historyRetentionDays);
    this.cleanupTimer = setInterval(() => { try { this.db.cleanup(this.db.getSettings().historyRetentionDays); } catch { /* */ } }, 6 * 3600_000);
    this.cleanupTimer.unref();
    this.journal('info', 'startup', `Бот запущен (версия ${APP_VERSION})`);
    if (!this.opts.noAutoUpdateCheck) this.updater.startAuto(() => this.db.getSettings().autoUpdateCheck);
  }

  /** Загрузка списка наград из Twitch. Награды других приложений помечаются как «не управляемые». */
  async syncRewards(): Promise<{ total: number; manageable: number }> {
    const user = this.auth.user;
    if (!user?.id) throw new Error('Не выполнен вход в Twitch');
    let all: HelixReward[];
    try {
      all = await this.helix.getCustomRewards(user.id, false);
    } catch (e) {
      if (e instanceof HelixError && e.status === 403) throw new Error('Twitch: баллы канала доступны только компаньонам и партнёрам');
      throw e;
    }
    const own = new Set((await this.helix.getCustomRewards(user.id, true).catch(() => [] as HelixReward[])).map((r) => r.id));
    for (const r of all) {
      this.db.upsertTwitchReward({ id: r.id, title: r.title, cost: r.cost, prompt: r.prompt, manageable: own.has(r.id), is_enabled: r.is_enabled && !r.is_paused, background_color: r.background_color, raw: r });
    }
    this.db.markRewardsDeletedExcept(all.map((r) => r.id).concat(this.db.listRewards().filter((r) => r.id.startsWith('local-')).map((r) => r.id)));
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
    this.log.info(`Награды синхронизированы: всего ${all.length}, созданных ботом ${own.size}`);
    return { total: all.length, manageable: own.size };
  }

  /**
   * Создание копии награды (например, от Sound Alerts) как собственной награды бота.
   * Копия создаётся НА ПАУЗЕ и с изменённым названием (Twitch требует уникальности), чтобы не мешать действующей.
   */
  async cloneReward(rewardId: string, title?: string): Promise<{ id: string; title: string }> {
    const user = this.auth.user;
    if (!user?.id) throw new Error('Не выполнен вход в Twitch');
    if (!this.auth.hasScope(SCOPE_MANAGE)) throw new Error('Нет права управлять наградами. Включите его в настройках и войдите в Twitch заново.');
    const src = this.db.getReward(rewardId);
    if (!src) throw new Error('Награда не найдена');
    const raw = JSON.parse(src.raw || '{}') as Partial<HelixReward>;
    const newTitle = (title?.trim() || `${src.title} ★`).slice(0, 45);
    const body: Record<string, unknown> = {
      title: newTitle, cost: src.cost, prompt: raw.prompt ?? src.prompt, is_enabled: true,
      is_user_input_required: raw.is_user_input_required ?? false,
      should_redemptions_skip_request_queue: raw.should_redemptions_skip_request_queue ?? false,
    };
    if (raw.background_color) body.background_color = raw.background_color;
    if (raw.max_per_stream_setting?.is_enabled) { body.is_max_per_stream_enabled = true; body.max_per_stream = raw.max_per_stream_setting.max_per_stream; }
    if (raw.max_per_user_per_stream_setting?.is_enabled) { body.is_max_per_user_per_stream_enabled = true; body.max_per_user_per_stream = raw.max_per_user_per_stream_setting.max_per_user_per_stream; }
    if (raw.global_cooldown_setting?.is_enabled) { body.is_global_cooldown_enabled = true; body.global_cooldown_seconds = raw.global_cooldown_setting.global_cooldown_seconds; }
    const created = await this.helix.createCustomReward(user.id, body);
    // Ставим на паузу сразу после создания: зрители не смогут её активировать до переключения.
    const paused = await this.helix.updateCustomReward(user.id, created.id, { is_paused: true }).catch(() => created);
    this.db.upsertTwitchReward({ id: created.id, title: created.title, cost: created.cost, prompt: created.prompt, manageable: true, is_enabled: paused.is_enabled && !paused.is_paused, background_color: created.background_color, raw: paused });
    // Переносим настройки медиа из исходной награды; включена в боте (на Twitch она на паузе).
    this.db.updateRewardConfig(created.id, {
      bot_enabled: 1, media_id: src.media_id, sound_id: src.sound_id, video_id: src.video_id, play_mode: src.play_mode, chroma_key: src.chroma_key, volume: src.volume, duration_ms: src.duration_ms, delay_ms: src.delay_ms,
      cooldown_sec: src.cooldown_sec, show_caption: src.show_caption, created_by_bot: 1,
    });
    this.journal('info', 'migration', `Создана копия награды «${src.title}» → «${created.title}» (на паузе)`);
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
    return { id: created.id, title: created.title };
  }

  /** Создание новой награды бота в Twitch. */
  async createReward(opts: { title: string; cost: number; cooldownSec?: number; prompt?: string; paused?: boolean }): Promise<{ id: string; title: string }> {
    const user = this.auth.user;
    if (!user?.id) throw new Error('Не выполнен вход в Twitch');
    if (!this.auth.hasScope(SCOPE_MANAGE)) throw new Error('Нет права управлять наградами. Включите его в настройках и войдите в Twitch заново.');
    const title = String(opts.title ?? '').trim();
    if (!title || title.length > 45) throw new Error('Название награды: от 1 до 45 символов');
    const cost = Number(opts.cost);
    if (!Number.isInteger(cost) || cost < 1) throw new Error('Стоимость должна быть целым числом от 1');
    const body: Record<string, unknown> = { title, cost, prompt: opts.prompt ?? '', is_enabled: true, background_color: '#7838F8' };
    const cd = Number(opts.cooldownSec ?? 0);
    if (cd > 0) { body.is_global_cooldown_enabled = true; body.global_cooldown_seconds = Math.round(cd); }
    const created = await this.helix.createCustomReward(user.id, body);
    const final = opts.paused ? await this.helix.updateCustomReward(user.id, created.id, { is_paused: true }).catch(() => created) : created;
    this.db.upsertTwitchReward({ id: final.id, title: final.title, cost: final.cost, prompt: final.prompt, manageable: true, is_enabled: final.is_enabled && !final.is_paused, background_color: final.background_color, raw: final });
    this.db.updateRewardConfig(final.id, { created_by_bot: 1 });
    this.journal('info', 'reward', `Создана награда «${final.title}» (${final.cost} баллов)`);
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
    return { id: final.id, title: final.title };
  }

  /** Изменение собственной награды бота в Twitch (название, стоимость, пауза, вкл/выкл). */
  async updateOwnReward(rewardId: string, patch: { title?: string; cost?: number; is_paused?: boolean; is_enabled?: boolean }): Promise<void> {
    const user = this.auth.user;
    if (!user?.id) throw new Error('Не выполнен вход в Twitch');
    const r = this.db.getReward(rewardId);
    if (!r) throw new Error('Награда не найдена');
    if (!r.manageable) throw new Error('Эту награду создало другое приложение (например, Sound Alerts) — Twitch запрещает её изменять. Измените её на сайте Twitch или в Sound Alerts.');
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) { const t = String(patch.title).trim(); if (!t || t.length > 45) throw new Error('Название: от 1 до 45 символов'); body.title = t; }
    if (patch.cost !== undefined) { const c = Number(patch.cost); if (!Number.isInteger(c) || c < 1) throw new Error('Стоимость должна быть целым числом от 1'); body.cost = c; }
    if (patch.is_paused !== undefined) body.is_paused = Boolean(patch.is_paused);
    if (patch.is_enabled !== undefined) body.is_enabled = Boolean(patch.is_enabled);
    const upd = await this.helix.updateCustomReward(user.id, rewardId, body);
    this.db.upsertTwitchReward({ id: upd.id, title: upd.title, cost: upd.cost, prompt: upd.prompt, manageable: true, is_enabled: upd.is_enabled && !upd.is_paused, background_color: upd.background_color, raw: upd });
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
  }

  journal(level: 'info' | 'warn' | 'error', type: string, message: string): void {
    const ev = this.db.addEvent(level, type, message);
    this.log[level](`[${type}] ${message}`);
    this.hub?.broadcastPanel({ type: 'event', event: ev });
  }

  statusSummary() {
    const es = this.eventsub.status;
    const overlays = this.hub.overlayList();
    return {
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      port: this.port,
      auth: this.auth.state,
      eventsub: es,
      overlays,
      mode: this.db.getSettings().mode,
      queueLength: this.queue.length,
    };
  }

  pushStatus(): void {
    this.hub.broadcastPanel({ type: 'status', status: this.statusSummary() });
  }

  /** Резервная копия сцен выбранной программы для стрима (OBS Studio или Streamlabs Desktop). */
  backupScenes(): string {
    const s = this.db.getSettings();
    const { dir, count } = copySceneFiles(s, this.opts.paths.backupDir);
    this.journal('info', 'obs', `Резервная копия сцен ${STREAM_APPS[s.streamApp].name} (${count} файлов): ${dir}`);
    return dir;
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.updater.stop();
    this.auth.dispose();
    await this.eventsub.stop();
    const left = this.queue.dispose();
    for (const item of left) if (item.redemptionId) this.db.setRedemptionStatus(item.redemptionId, 'dropped', 'Отменено: бот остановлен');
    await this.hub.close();
    this.db.close();
  }
}
