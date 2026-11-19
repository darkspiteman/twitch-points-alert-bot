import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Db } from './db.ts';
import { Logger, type ScopedLogger } from './logger.ts';
import { type Paths, APP_VERSION, APP_ROOT, UPDATE_REPO, SECRET_SETTINGS, ENC_PREFIX } from './config.ts';
import { type SecureStore, type Protector, TestProtector } from './secure-store.ts';
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
import { isCodecMessage } from './media.ts';
import { Updater } from './update.ts';
import { writeLoader } from './overlay-loader.ts';
import type { Transport } from './net/safe-download.ts';
import { type Lang, effectiveLang, localize, tr } from './i18n.ts';
import { StreamStats, STATS_SCOPES, STATS_EVENTS, STATS_EVENT_TYPES, SCOPE_MARKERS, SCOPE_SHOUTOUTS, type StreamSummary } from './stats.ts';
import { TtsEngine, wavDurationMs, ttsPrepare, chooseVoice, type RunFn } from './tts.ts';
import { PiperInstaller } from './piper.ts';
import type { PlayItem } from './queue.ts';
import { readObsWsConfig, type ObsWsConfig } from './obs-ws.ts';
import { writeStatsLoaders, type StatsLoaders } from './overlay-loader.ts';

export interface AppOptions {
  paths: Paths;
  logger: Logger;
  store: SecureStore;
  /** Шифрование ключей API в настройках (в main.ts — DPAPI; в тестах по умолчанию — тестовое). */
  protector?: Protector;
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
  /** Адрес OBS WebSocket (тесты: мок-сервер). */
  obsHost?: string;
  obsPollMs?: number;
  /** Интервалы опроса статистики Twitch (тесты). */
  statsIntervals?: ConstructorParameters<typeof StreamStats>[0]['intervals'];
  /** Обрыв эфира короче этого — тот же стрим (тесты ставят 0). */
  statsResumeMs?: number;
  /** Задержка автоматического шаутаута после рейда (тесты). */
  shoutoutDelayMs?: number;
  /** Подмена запуска PowerShell для озвучки (тесты). */
  ttsRun?: RunFn;
  /** Голоса Piper: подмена загрузки и запуска piper.exe (тесты). */
  piperTransport?: Transport;
  piperRun?: RunFn;
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
  readonly tts: TtsEngine;
  readonly piper: PiperInstaller;
  readonly updater: Updater;
  readonly stats: StreamStats;
  /** Файлы-загрузчики дока и overlay статистики (пусто, если записать не удалось). */
  statsLoaders: StatsLoaders = { dock: '', overlay: '' };
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
      optionalScopes: () => STATS_SCOPES,
    });
    this.helix = new HelixClient(this.auth, opts.logger.child('helix'), { fetchFn: opts.fetchFn, base: opts.helixBase });
    this.media = new MediaLibrary(this.db, opts.paths.mediaDir);

    this.hub = new Hub(opts.logger.child('hub'), () => {
      const s = this.db.getSettings();
      return { position: s.overlayPosition, maxWidthPct: s.overlayMaxWidthPct, maxHeightPct: s.overlayMaxHeightPct, masterVolume: s.masterVolume, maxDurationMs: s.maxDurationMs, ttsVolume: s.ttsVolume, lang: effectiveLang(s.language) };
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
    this.piper = new PiperInstaller({ dir: path.join(opts.paths.dataDir, 'piper'), log: opts.logger.child('piper'), transport: opts.piperTransport });
    this.piper.on('status', (st: { busy: boolean; error: string; installed: boolean }) => {
      if (!st.busy && st.error) this.journal('error', 'tts', `Голоса Piper не установлены: ${st.error}`);
      else if (!st.busy && st.installed) this.journal('info', 'tts', 'Голоса Piper установлены: выберите голос Piper в «Настройках» → «Озвучка текста зрителя»');
      this.hub?.broadcastPanel({ type: 'invalidate', what: 'tts' });
    });
    this.tts = new TtsEngine({ dir: path.join(opts.paths.dataDir, 'tts'), log: opts.logger.child('tts'), run: opts.ttsRun, piper: this.piper, runPiper: opts.piperRun });
    this.queue = new PlaybackQueue(this.hub, () => this.db.getSettings(), opts.logger.child('queue'), (item) => this.prepareItem(item));
    this.router = new RedemptionRouter({
      db: this.db, media: this.media, queue: this.queue, log: opts.logger.child('router'),
      helix: () => (this.auth.state.status === 'ok' ? this.helix : null),
      broadcasterId: () => this.auth.user?.id || null,
      journal: (l, t, m) => this.journal(l, t, m),
    });

    this.stats = new StreamStats({
      log: opts.logger.child('stats'),
      helix: () => (this.auth.state.status === 'ok' ? this.helix : null),
      user: () => (this.auth.state.status === 'ok' && this.auth.user?.id ? this.auth.user : null),
      hasScope: (s) => this.auth.hasScope(s),
      useObs: () => this.db.getSettings().streamApp === 'obs',
      obsConfig: () => this.obsWsConfig(),
      loadSession: () => this.db.getMeta('stats_session'),
      saveSession: (json) => this.db.setMeta('stats_session', json),
      store: {
        chatterVisits: (users, sessionId, now) => this.db.chatterVisits(users, sessionId, now),
        trackingSince: () => this.db.chattersTrackingSince(),
        saveSummary: (sum) => this.db.saveStreamSummary(sum),
        summaries: (limit) => this.db.streamSummaries<StreamSummary>(limit),
      },
      resumeMs: opts.statsResumeMs,
      obsHost: opts.obsHost, obsPollMs: opts.obsPollMs, intervals: opts.statsIntervals,
    });

    this.eventsub = new EventSubClient({
      log: opts.logger.child('eventsub'), url: opts.eventsubUrl, keepaliveSeconds: opts.eventsubKeepaliveSec ?? 30, backoff: opts.eventsubBackoff,
      subscribe: (sessionId) => this.subscribe(sessionId),
    });

    this.wire();
  }

  /** Файл-загрузчик overlay: пишется при запуске и при смене языка (служебный текст на языке панели). */
  refreshLoader(): void {
    try { this.loaderPath = writeLoader(this.opts.paths.dataDir, this.port, this.lang); } catch (e) { this.log.warn('Не удалось записать файл-загрузчик overlay', e); }
    try { this.statsLoaders = writeStatsLoaders(this.opts.paths.dataDir, this.port, this.lang); } catch (e) { this.log.warn('Не удалось записать файлы-загрузчики статистики', e); }
  }

  /** Куда подключаться к OBS WebSocket: настройки бота, а пустые поля — из настроек самого OBS. */
  obsWsConfig(): ObsWsConfig & { fileFound: boolean } {
    const s = this.db.getSettings();
    const file = readObsWsConfig(s.obsConfigDir);
    return {
      port: s.obsWsPort || file?.port || 4455,
      password: s.obsWsPassword || (file?.authRequired === false ? '' : file?.password ?? ''),
      // Выключен ли сервер, знаем только из файла OBS; если порт задан вручную — просто пробуем.
      enabled: s.obsWsPort ? null : file ? file.enabled : null,
      fromFile: !s.obsWsPassword && !!file,
      fileFound: !!file,
    };
  }

  /** Перед показом: адреса онлайн-медиа и озвучка текста зрителя. */
  private async prepareItem(item: PlayItem): Promise<PlayItem> {
    const it = await this.finder.prepare(item);
    if (!it.ttsText || it.tts) return it;
    const s = this.db.getSettings();
    try {
      const voices = await this.tts.voices().catch(() => []);
      const voice = chooseVoice(voices, { lang: it.ttsLang ?? 'ru', alias: it.ttsAlias ?? null }, s);
      const name = await this.tts.synth(it.ttsText, voice, s.ttsRate);
      return { ...it, tts: { url: `/tts/${name}`, ms: wavDurationMs(path.join(this.opts.paths.dataDir, 'tts', name)) } };
    } catch (e) {
      // Без озвучки: если есть звук или видео — играем их, иначе оповещение не состоится.
      this.journal('warn', 'tts', `«${it.rewardTitle}»: ${(e as Error).message}`);
      if (!it.visual && !it.audio) throw e;
      return it;
    }
  }

  // ---------------- Награды только в эфире (1.7.0) ----------------
  private liveChain: Promise<void> = Promise.resolve();

  /** Поставить в очередь: эфир начался (true), закончился (false) или узнать у Twitch (null). */
  queueRewardsLive(live: boolean | null): Promise<void> {
    this.liveChain = this.liveChain.then(() => this.applyRewardsLive(live)).catch((e) => this.log.warn('Награды только в эфире: ошибка', e));
    return this.liveChain;
  }

  /**
   * Вне эфира — награды бота на паузе в Twitch, в эфире — доступны. Бот снимает с паузы только те награды,
   * которые сам поставил на паузу (список — meta rewards_paused_offline): ручную паузу стримера не трогает.
   */
  private async applyRewardsLive(live: boolean | null): Promise<void> {
    const user = this.auth.user;
    if (!user?.id || this.auth.state.status !== 'ok' || !this.auth.hasScope(SCOPE_MANAGE)) return;
    const s = this.db.getSettings();
    let mine: string[] = [];
    try { mine = JSON.parse(this.db.getMeta('rewards_paused_offline') ?? '[]') as string[]; } catch { mine = []; }
    if (!s.rewardsOnlyLive && !mine.length) return;
    if (live === null) {
      const st = await this.helix.getStream(user.id);
      live = !!st && st.type === 'live';
    }
    if (s.rewardsOnlyLive && !live) {
      let n = 0;
      for (const r of this.db.listRewards().filter((x) => x.manageable)) {
        let raw: { is_paused?: boolean } = {};
        try { raw = JSON.parse(r.raw || '{}'); } catch { /* */ }
        if (raw.is_paused || mine.includes(r.id)) continue;
        try { await this.updateOwnReward(r.id, { is_paused: true }); mine.push(r.id); n++; } catch (e) { this.log.warn(`Пауза награды «${r.title}» не удалась`, e); }
      }
      if (n) this.journal('info', 'reward', `Эфира нет — награды бота на паузе в Twitch (${n})`);
    } else if (mine.length) {
      let n = 0;
      for (const id of mine) {
        if (!this.db.getReward(id)?.manageable) continue;
        try { await this.updateOwnReward(id, { is_paused: false }); n++; } catch (e) { this.log.warn(`Снятие паузы с награды ${id} не удалось`, e); }
      }
      mine = [];
      if (n) this.journal('info', 'reward', live ? `Эфир начался — награды бота снова доступны (${n})` : `Награды бота сняты с паузы (${n})`);
    }
    this.db.setMeta('rewards_paused_offline', JSON.stringify(mine));
  }

  /** Шаутаут каналу (после рейда): карточка канала в чате стримера (1.7.0). */
  async shoutout(uid: string, name: string): Promise<void> {
    const user = this.auth.user;
    if (!user?.id || this.auth.state.status !== 'ok') throw new Error('Бот не вошёл в Twitch');
    if (!/^\d{1,20}$/.test(uid)) throw new Error('Неизвестный канал');
    if (!this.auth.hasScope(SCOPE_SHOUTOUTS)) throw new Error('Нет разрешения на шаутаут: «Настройки» → «Войти заново»');
    try {
      await this.helix.sendShoutout(user.id, uid);
    } catch (e) {
      if (e instanceof HelixError && e.status === 429) throw new Error('Twitch разрешает шаутаут не чаще раза в 2 минуты и одному каналу — раз в час. Попробуйте позже.');
      if (e instanceof HelixError && e.status === 400) throw new Error('Шаутаут работает только во время эфира');
      if (e instanceof HelixError && (e.status === 401 || e.status === 403)) throw new Error('Нет разрешения на шаутаут: «Настройки» → «Войти заново»');
      throw e;
    }
    this.stats.markShoutout(uid);
    this.journal('info', 'shoutout', `Шаутаут: ${name || uid}`);
  }

  /** Метка в записи трансляции из дока (1.7.0). */
  async createMarker(): Promise<{ position: number }> {
    const user = this.auth.user;
    if (!user?.id || this.auth.state.status !== 'ok') throw new Error('Бот не вошёл в Twitch');
    if (!this.auth.hasScope(SCOPE_MARKERS)) throw new Error('Нет разрешения ставить метки: «Настройки» → «Войти заново»');
    try {
      const m = await this.helix.createStreamMarker(user.id, 'Twitch Alert Bot');
      this.stats.noteMarker(Number(m?.position_seconds) || 0);
      return { position: Number(m?.position_seconds) || 0 };
    } catch (e) {
      if (e instanceof HelixError && (e.status === 404 || e.status === 400)) throw new Error('Метку можно поставить только во время эфира (и если на Twitch включено сохранение трансляций)');
      if (e instanceof HelixError && (e.status === 401 || e.status === 403)) throw new Error('Нет разрешения ставить метки: «Настройки» → «Войти заново»');
      throw e;
    }
  }

  /** Награда для озвучки (1.8.0): в Twitch — с вводом текста, в боте — включена, с озвучкой. */
  async createTtsReward(cost: number): Promise<{ id: string; title: string }> {
    const r = await this.createReward({
      title: tr('🗣 Скажи голосом', this.lang), cost, inputRequired: true, cooldownSec: 30,
      prompt: tr('Напишите текст — бот прочитает его вслух. Голос можно выбрать: [Павел] или [Ирина] в начале. Без мата, ссылок и оскорблений.', this.lang),
    });
    this.db.updateRewardConfig(r.id, { tts: 1, bot_enabled: 1 });
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
    return r;
  }

  /** Проверка голоса из панели: только озвучка, без награды. */
  testTts(text: string): { ok: true } | { ok: false; error: string } {
    const s = this.db.getSettings();
    const prep = ttsPrepare(tr('Тест', this.lang), text, { template: s.ttsTemplate, templateEn: s.ttsTemplateEn, viewerVoice: s.ttsViewerVoice, maxChars: s.ttsMaxChars, filter: s.ttsFilter, bannedWords: s.ttsBannedWords });
    if (!prep) return { ok: false, error: 'Нечего озвучивать' };
    const r = this.queue.enqueue({
      id: `test-${crypto.randomUUID()}`, redemptionId: null, rewardId: '', rewardTitle: tr('Проверка озвучки', this.lang), userName: tr('Тест', this.lang), userInput: text,
      visual: null, audio: null, volume: 1, durationMs: 0, delayMs: 0, caption: null, ttsText: prep.text, ttsLang: prep.lang, ttsAlias: prep.alias, source: 'test', createdAt: Date.now(),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.reason };
  }

  /** Снимок статистики для дока и overlay (с оформлением overlay и языком). */
  statsPayload(): Record<string, unknown> {
    const s = this.db.getSettings();
    const v = this.stats.view();
    return {
      type: 'stats',
      lang: this.lang,
      // Док и overlay перезагружаются, если бот обновился (иначе в OBS осталась бы старая версия страницы).
      version: APP_VERSION,
      stats: { ...v, obs: { ...v.obs, message: v.obs.message ? tr(v.obs.message, this.lang) : '' } },
      // Очередь оповещений — для дока (что играет, кто ждёт, «Пропустить» / «Пауза»).
      queue: this.queue.snapshot(),
      tts: { enabled: s.ttsEnabled },
      overlay: {
        fields: s.statsOverlayFields.split(',').filter(Boolean), layout: s.statsOverlayLayout, style: s.statsOverlayStyle,
        labels: s.statsOverlayLabels, scale: s.statsOverlayScale,
      },
    };
  }

  /** Язык панели и служебных сообщений (из настроек; не выбран — русский). */
  get lang(): Lang { return effectiveLang(this.db.getSettings().language); }

  private wire(): void {
    this.hub.panelTransform = (msg) => localize(msg, this.lang);
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
      // Предпросмотр в браузере панели снимает только свою же ошибку: ошибку из OBS/Streamlabs (другой движок, меньше кодеков) он не отменяет.
      const ownError = m.status === 'broken' && (m.status_msg.startsWith('Браузер не может') || m.status_msg.includes('Браузер панели тоже'));
      if (ok) this.db.updateMediaStatus(mediaId, ownError ? 'ok' : m.status, ownError ? '' : m.status_msg, durationMs);
      else if (m.status === 'warning' && isCodecMessage(m.status_msg)) {
        // Кодек уже назван при загрузке — сохраняем причину, но перекодировать в панели не выйдет.
        const reason = m.status_msg.replace(/ Нажмите «Перекодировать».*$/, '');
        this.db.updateMediaStatus(mediaId, 'broken', `${reason} Браузер панели тоже не может его прочитать — перекодируйте файл бесплатной программой HandBrake в MP4 (H.264 + AAC) и загрузите заново.`);
      } else this.db.updateMediaStatus(mediaId, 'broken', `Браузер не может воспроизвести файл: ${message}`);
      this.hub.broadcastPanel({ type: 'invalidate', what: 'media' });
    };

    this.hub.getStatsPayload = () => this.statsPayload();
    this.hub.onStatsClients = (n) => this.stats.setClients(n);
    this.stats.on('update', () => this.hub.broadcastStats(this.statsPayload()));
    this.stats.obs.on('state', (st: string, msg: string) => {
      if (st === 'auth_failed') this.journal('warn', 'obs', `${msg}. Проверьте пароль в «Статистика» → «Подключение к OBS».`);
    });

    this.queue.on('change', (snap) => {
      this.hub.broadcastPanel({ type: 'queue', queue: snap });
      if (this.hub.statsClientCount > 0) this.hub.broadcastStats(this.statsPayload());
    });
    this.router.on('redemption', () => this.hub.broadcastPanel({ type: 'invalidate', what: 'redemptions' }));

    this.auth.on('state', () => { this.pushStatus(); this.stats.authChanged(); });
    this.auth.on('logged_in', () => {
      this.syncRewards().then(() => this.queueRewardsLive(null)).catch((e) => this.log.warn('Синхронизация наград не удалась', e));
      this.eventsub.restart();
    });
    this.auth.on('logged_out', (reason: 'expired' | 'manual') => {
      void this.eventsub.stop();
      if (reason === 'expired') this.journal('error', 'auth', 'Требуется повторный вход в Twitch: события наград не принимаются');
      else this.journal('info', 'auth', 'Выполнен выход из Twitch');
    });

    this.eventsub.on('status', () => this.pushStatus());
    this.eventsub.on('notification', (msg) => {
      const st = msg.metadata?.subscription_type;
      if (st === 'stream.online' || st === 'stream.offline') this.queueRewardsLive(st === 'stream.online');
      if (st === 'channel.raid' && this.db.getSettings().autoShoutout) {
        const ev = (msg.payload.event ?? {}) as { from_broadcaster_user_id?: string; from_broadcaster_user_name?: string };
        // Через несколько секунд: рейдеры успевают зайти и увидеть карточку.
        if (ev.from_broadcaster_user_id) setTimeout(() => {
          this.shoutout(String(ev.from_broadcaster_user_id), String(ev.from_broadcaster_user_name ?? ''))
            .catch((e) => this.journal('warn', 'shoutout', `Шаутаут ${ev.from_broadcaster_user_name ?? ''}: ${(e as Error).message}`));
        }, this.opts.shoutoutDelayMs ?? 5000).unref();
      }
      if (STATS_EVENT_TYPES.has(st)) { this.stats.handleNotification(msg); return; }
      if (msg.metadata?.subscription_type === 'channel.channel_points_custom_reward_redemption.add') {
        const ev = (msg.payload.event ?? {}) as { id?: string; user_name?: string; user_login?: string; reward?: { title?: string } };
        // Повторная доставка того же погашения в ленту не попадает.
        if (ev.id && !this.db.hasRedemption(ev.id)) this.stats.noteRedemption(String(ev.user_name || ev.user_login || ''), String(ev.reward?.title ?? ''));
      }
      this.router.handleNotification(msg);
    });
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
    // Подписки статистики — без ожидания и без влияния на награды: нет права — просто пропускаем.
    void this.subscribeStats(sessionId, user.id);
    // Чистим «мёртвые» websocket-подписки прошлых сессий (best effort, не блокирует).
    this.cleanupSubscriptions(sessionId).catch(() => {});
  }

  private async subscribeStats(sessionId: string, uid: string): Promise<void> {
    for (const e of STATS_EVENTS) {
      if (e.scope && !this.auth.hasScope(e.scope)) continue;
      try { await this.helix.createEventSubSubscription(e.type, e.version, e.condition(uid), sessionId); } catch (err) {
        if (!(err instanceof HelixError && err.status === 409)) this.log.info(`Статистика: подписка ${e.type} не создана: ${(err as Error).message}`);
      }
    }
  }

  private async cleanupSubscriptions(currentSession: string): Promise<void> {
    const subs = await this.helix.getEventSubSubscriptions();
    for (const s of subs) {
      if (s.transport.method === 'websocket' && (s.type === REDEMPTION_TYPE || STATS_EVENT_TYPES.has(s.type)) && s.transport.session_id !== currentSession && s.status !== 'enabled') {
        await this.helix.deleteEventSubSubscription(s.id).catch(() => {});
      }
    }
  }

  /**
   * Ключи Klipy и Freesound: в базе — зашифрованы, в памяти — открыты. При запуске расшифровываем,
   * а ключи, сохранённые открытым текстом версиями до 1.4.1, шифруем.
   */
  async loadSecrets(): Promise<void> {
    const prot = this.opts.protector ?? new TestProtector();
    for (const k of SECRET_SETTINGS) {
      const raw = this.db.rawSetting(k);
      if (typeof raw !== 'string' || !raw) continue;
      if (raw.startsWith(ENC_PREFIX)) {
        try { this.db.setSecretPlain(k, await prot.unprotect(raw.slice(ENC_PREFIX.length))); } catch (e) {
          this.log.warn(`Ключ ${k} не расшифровывается`, e);
          if (k === 'obsWsPassword') this.journal('warn', 'settings', 'Не удалось расшифровать пароль OBS WebSocket (например, база перенесена с другого компьютера) — введите его заново в «Статистика» → «Подключение к OBS».');
          else this.journal('warn', 'settings', `Не удалось расшифровать ключ ${k === 'klipyApiKey' ? 'Klipy' : 'Freesound'} (например, база перенесена с другого компьютера) — вставьте его заново в «Настройки» → «Поиск медиа».`);
        }
      } else {
        try { await this.saveSecret(k, raw); } catch (e) { this.log.warn(`Ключ ${k} не удалось зашифровать — остаётся как был`, e); }
      }
    }
    this.finder.registerKeys();
  }

  /** Сохранение ключа API: в базу — зашифрованным. Пустая строка — удалить ключ. */
  async saveSecret(key: (typeof SECRET_SETTINGS)[number], plain: string): Promise<void> {
    if (!plain) { this.db.updateSettings({ [key]: '' }); this.db.setSecretPlain(key, ''); return; }
    const enc = await (this.opts.protector ?? new TestProtector()).protect(plain);
    this.db.setSecretPlain(key, plain);
    this.db.updateSettings({ [key]: ENC_PREFIX + enc });
  }

  async start(): Promise<void> {
    await this.loadSecrets();
    this.refreshLoader();
    await this.auth.init();
    if (this.auth.state.status === 'ok') {
      this.initialSync = this.syncRewards().catch((e) => this.log.warn('Синхронизация наград при старте не удалась', e));
      this.eventsub.start();
    }
    try {
      // Разбор кодеков у старых файлов — один раз после обновления (до 1.3.0 кодеки не проверялись).
      const deep = this.db.getMeta('codec_scan') !== '1';
      const r = this.media.verifyAll(deep);
      if (deep) { this.db.setMeta('codec_scan', '1'); if (r.warnings) this.log.info(`Проверка кодеков: предупреждений — ${r.warnings}`); }
    } catch (e) { this.log.warn('Проверка медиафайлов не удалась', e); }
    const s = this.db.getSettings();
    this.db.cleanup(s.historyRetentionDays);
    this.tts.cleanup();
    this.cleanupTimer = setInterval(() => { try { this.db.cleanup(this.db.getSettings().historyRetentionDays); } catch { /* */ } this.tts.cleanup(); }, 6 * 3600_000);
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
      bot_enabled: 1, media_id: src.media_id, sound_id: src.sound_id, video_id: src.video_id, play_mode: src.play_mode, chroma_key: src.chroma_key, tts: src.tts, volume: src.volume, duration_ms: src.duration_ms, delay_ms: src.delay_ms,
      cooldown_sec: src.cooldown_sec, show_caption: src.show_caption, created_by_bot: 1,
    });
    this.journal('info', 'migration', `Создана копия награды «${src.title}» → «${created.title}» (на паузе)`);
    this.hub.broadcastPanel({ type: 'invalidate', what: 'rewards' });
    return { id: created.id, title: created.title };
  }

  /** Создание новой награды бота в Twitch. */
  async createReward(opts: { title: string; cost: number; cooldownSec?: number; prompt?: string; paused?: boolean; inputRequired?: boolean }): Promise<{ id: string; title: string }> {
    const user = this.auth.user;
    if (!user?.id) throw new Error('Не выполнен вход в Twitch');
    if (!this.auth.hasScope(SCOPE_MANAGE)) throw new Error('Нет права управлять наградами. Включите его в настройках и войдите в Twitch заново.');
    const title = String(opts.title ?? '').trim();
    if (!title || title.length > 45) throw new Error('Название награды: от 1 до 45 символов');
    const cost = Number(opts.cost);
    if (!Number.isInteger(cost) || cost < 1) throw new Error('Стоимость должна быть целым числом от 1');
    const body: Record<string, unknown> = { title, cost, prompt: opts.prompt ?? '', is_enabled: true, background_color: '#7838F8' };
    if (opts.inputRequired) body.is_user_input_required = true;
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
  async updateOwnReward(rewardId: string, patch: { title?: string; cost?: number; is_paused?: boolean; is_enabled?: boolean; is_user_input_required?: boolean }): Promise<void> {
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
    if (patch.is_user_input_required !== undefined) body.is_user_input_required = Boolean(patch.is_user_input_required);
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
    this.stats.stop();
    this.auth.dispose();
    await this.eventsub.stop();
    const left = this.queue.dispose();
    for (const item of left) if (item.redemptionId) this.db.setRedemptionStatus(item.redemptionId, 'dropped', 'Отменено: бот остановлен');
    await this.hub.close();
    this.db.close();
  }
}
