import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ScopedLogger } from './logger.ts';
import { HelixError, type HelixClient } from './twitch/helix.ts';
import type { EventSubMessage } from './twitch/eventsub.ts';
import { ObsClient, type ObsMic, type ObsSample, type ObsState, type ObsWsConfig } from './obs-ws.ts';

/**
 * Статистика стрима для док-панели OBS и overlay на экране (1.5.0).
 *
 * Источники:
 *  • OBS WebSocket (мгновенно): время трансляции, битрейт, разрешение, FPS, потерянные кадры, CPU;
 *  • Twitch Helix (опрос раз в 15–120 с): зрители, кто в чате, фолловеры, подписчики и баллы подписок;
 *  • Twitch EventSub (мгновенно): новые фолловеры, подписки, подарки, рейды, начало и конец эфира.
 * 1.6.0: тревога «микрофон выключен», «впервые на канале» / «был N раз» у зрителей чата, награды за баллы в ленте,
 * итоги каждого стрима (сохраняются в базе, история — в панели).
 * Twitch и OBS опрашиваются только пока открыт хотя бы один экран статистики (док, overlay или панель).
 */

export const SCOPE_FOLLOWERS = 'moderator:read:followers';
export const SCOPE_SUBS = 'channel:read:subscriptions';
export const SCOPE_CHATTERS = 'moderator:read:chatters';
/** 1.7.0: метки в записи трансляции. */
export const SCOPE_MARKERS = 'channel:manage:broadcast';
/** 1.7.0: шаутаут рейдеру. */
export const SCOPE_SHOUTOUTS = 'moderator:manage:shoutouts';
/** Права для статистики: запрашиваются при входе, но не обязательны (без них бот работает, а статистика неполная). */
export const STATS_SCOPES = [SCOPE_FOLLOWERS, SCOPE_SUBS, SCOPE_CHATTERS, SCOPE_MARKERS, SCOPE_SHOUTOUTS];

/** Подписки EventSub для статистики (создаются вместе с подпиской на награды, ошибки не мешают наградам). */
export const STATS_EVENTS: Array<{ type: string; version: string; condition: (uid: string) => Record<string, string>; scope?: string }> = [
  { type: 'channel.follow', version: '2', condition: (uid) => ({ broadcaster_user_id: uid, moderator_user_id: uid }), scope: SCOPE_FOLLOWERS },
  { type: 'channel.subscribe', version: '1', condition: (uid) => ({ broadcaster_user_id: uid }), scope: SCOPE_SUBS },
  { type: 'channel.subscription.message', version: '1', condition: (uid) => ({ broadcaster_user_id: uid }), scope: SCOPE_SUBS },
  { type: 'channel.subscription.gift', version: '1', condition: (uid) => ({ broadcaster_user_id: uid }), scope: SCOPE_SUBS },
  { type: 'channel.raid', version: '1', condition: (uid) => ({ to_broadcaster_user_id: uid }) },
  { type: 'stream.online', version: '1', condition: (uid) => ({ broadcaster_user_id: uid }) },
  { type: 'stream.offline', version: '1', condition: (uid) => ({ broadcaster_user_id: uid }) },
];
export const STATS_EVENT_TYPES = new Set(STATS_EVENTS.map((e) => e.type));

/** Чат-боты: не считаются зрителями в чате и не попадают в «пришли». */
export const KNOWN_BOTS = new Set([
  'streamelements', 'nightbot', 'moobot', 'streamlabs', 'fossabot', 'wizebot', 'sery_bot', 'soundalerts', 'kofistreambot',
  'commanderroot', 'streamholics', 'lurxx', 'anotherttvviewer', 'creatisbot', 'pokemoncommunitygame', 'botrixoficial',
  'blerp', 'buttsbot', 'own3d', 'tangiabot', 'restreambot', 'twitchprimereminder', 'drapsnatt', 'frostytoolsdotcom',
]);

export const OVERLAY_FIELDS = ['session', 'viewers', 'chatters', 'followers', 'followersSession', 'subs', 'subPoints', 'bitrate', 'resolution', 'dropped', 'health'] as const;

export type FeedKind = 'follow' | 'sub' | 'resub' | 'gift' | 'raid' | 'join' | 'redeem' | 'marker';
/** Событие ленты. first — зритель впервые на канале; text — название награды. */
export interface FeedItem { kind: FeedKind; name: string; at: number; n?: number; tier?: string; first?: boolean; text?: string; uid?: string; so?: boolean }

/** Итоги одного стрима (сохраняются в базе при окончании эфира). */
export interface StreamSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  title: string;
  game: string;
  peakViewers: number;
  avgViewers: number | null;
  followers: number;
  followerNames: string[];
  subs: number;
  resubs: number;
  subNames: string[];
  gifts: number;
  raids: Array<{ name: string; viewers: number }>;
  /** Сколько разных людей было в чате; null — нет права на список чата. */
  chatters: number | null;
  newChatters: number;
  newChatterNames: string[];
  redemptions: number;
  /** 1.7.0: метки в записи (секунды от начала трансляции). */
  markers?: number[];
  /** 1.7.0: какие награды брали чаще всего и кто больше всех тратил баллы (до 5). */
  topRewards?: Array<[string, number]>;
  topUsers?: Array<[string, number]>;
}

/** Хранилище статистики (база бота). Без него бот не помнит зрителей и итоги стримов. */
export interface StatsStore {
  /** Отметить зрителей чата. sessionId — засчитать им посещение этого стрима; null — только узнать, сколько раз были. */
  chatterVisits(users: Array<{ login: string; name: string }>, sessionId: string | null, now: number): Map<string, number>;
  /** С какого момента бот запоминает зрителей (null — ещё ни разу). */
  trackingSince(): number | null;
  saveSummary(s: StreamSummary): void;
  summaries(limit: number): StreamSummary[];
}

export interface ChatterView { name: string; since: number; visits: number | null; first: boolean }

export type Health = 'good' | 'warn' | 'bad';

export interface StatsView {
  at: number;
  twitch: 'ok' | 'logged_out';
  missingScopes: string[];
  live: boolean | null;
  /** Начало трансляции (мс): по OBS, если OBS транслирует, иначе по Twitch. Клиент сам отсчитывает время. */
  sessionStart: number | null;
  sessionSource: 'obs' | 'twitch' | null;
  title: string;
  game: string;
  viewers: number | null;
  peakViewers: number | null;
  chatters: number | null;
  chattersList: ChatterView[];
  /** С какого момента бот запоминает зрителей («впервые» не показывается до первого полного стрима). */
  chattersTrackedSince: number | null;
  followers: number | null;
  followersSession: number;
  subs: number | null;
  subPoints: number | null;
  subsSession: number;
  feed: FeedItem[];
  /** Последние итоги стримов (новые первыми, до двух — для сравнения). */
  summaries: StreamSummary[];
  obs: {
    enabled: boolean;
    state: ObsState;
    message: string;
    streaming: boolean;
    reconnecting: boolean;
    bitrateKbps: number | null;
    bitrateHistory: number[];
    width: number;
    height: number;
    fps: number;
    activeFps: number;
    droppedFrames: number;
    droppedPct: number | null;
    cpu: number | null;
    health: Health | null;
    healthReason: string;
    mics: ObsMic[];
  };
}

/** Текущий стрим: счётчики «за стрим» и данные для итогов. Хранится в базе (meta stats_session) — переживает перезапуск. */
interface SessionState {
  /** Внутренний номер (пусто — эфира ещё не было). */
  id: string;
  /** Номер трансляции Twitch (пусто — ещё не известен). */
  streamId: string;
  startedAt: number;
  /** Начало посчитано по длительности OBS (уточнится по Twitch). */
  startEstimated: boolean;
  /** 0 — эфир идёт. */
  endedAt: number;
  /** Последний раз, когда эфир точно шёл (для итогов, если бот был закрыт до конца стрима). */
  lastAt: number;
  peakViewers: number;
  viewerSum: number;
  viewerSamples: number;
  followersSession: number;
  subsSession: number;
  resubs: number;
  followerNames: string[];
  subNames: string[];
  gifts: number;
  raids: Array<{ name: string; viewers: number }>;
  chatters: string[];
  newChatters: string[];
  chattersKnown: boolean;
  redemptions: number;
  byReward: Record<string, number>;
  byUser: Record<string, number>;
  markers: number[];
  title: string;
  game: string;
}

function emptySession(): SessionState {
  return {
    id: '', streamId: '', startedAt: 0, startEstimated: false, endedAt: 0, lastAt: 0, peakViewers: 0, viewerSum: 0, viewerSamples: 0,
    followersSession: 0, subsSession: 0, resubs: 0, followerNames: [], subNames: [], gifts: 0, raids: [],
    chatters: [], newChatters: [], chattersKnown: false, redemptions: 0, byReward: {}, byUser: {}, markers: [], title: '', game: '',
  };
}

/** Обрыв короче этого — тот же стрим (переподключение, перезапуск OBS). */
const RESUME_MS = 10 * 60_000;
/** Стримы короче минуты в историю не попадают (проверка, случайный запуск). */
const MIN_SUMMARY_MS = 60_000;
const NAMES_MAX = 200;
/** Открытая запись о стриме без признаков жизни дольше этого — тот стрим давно закончился. */
const STALE_MS = 6 * 3600_000;
const CHATTERS_MAX = 20_000;

export interface StatsOptions {
  log: ScopedLogger;
  helix: () => HelixClient | null;
  user: () => { id: string; login: string } | null;
  hasScope: (s: string) => boolean;
  /** Программа для стрима: к OBS WebSocket подключаемся только для OBS Studio. */
  useObs: () => boolean;
  obsConfig: () => ObsWsConfig;
  loadSession?: () => string | null;
  saveSession?: (json: string) => void;
  store?: StatsStore;
  /** Обрыв короче этого — продолжение того же стрима (тесты ставят 0). */
  resumeMs?: number;
  obsPollMs?: number;
  obsHost?: string;
  /** Интервалы опроса Twitch (тесты). */
  intervals?: Partial<typeof DEFAULT_INTERVALS>;
  /** Сколько ждать после закрытия последнего экрана статистики, прежде чем остановить опрос. */
  idleStopMs?: number;
}

const DEFAULT_INTERVALS = { tick: 5000, stream: 15_000, chatters: 20_000, followers: 60_000, followersNoEvents: 30_000, subs: 120_000 };
const HISTORY = 90; // точек битрейта (3 минуты при опросе раз в 2 с)
const WINDOW = 15;  // точек для «текущих» потерь кадров (~30 с)
const FEED_MAX = 40;

export class StreamStats extends EventEmitter {
  private o: StatsOptions;
  readonly obs: ObsClient;
  private iv: typeof DEFAULT_INTERVALS;
  private clients = 0;
  private active = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private due = { stream: 0, chatters: 0, followers: 0, subs: 0 };
  private busy = false;
  private seenMessages = new Set<string>();

  private live: boolean | null = null;
  private startedAt: number | null = null;
  private title = '';
  private game = '';
  private viewers: number | null = null;
  private followers: number | null = null;
  private subs: number | null = null;
  private subPoints: number | null = null;
  private chatters: Map<string, ChatterView> | null = null;
  private session: SessionState = emptySession();
  private summariesCache: StreamSummary[] | null = null;
  private feed: FeedItem[] = [];
  private noScope = new Set<string>();

  private samples: ObsSample[] = [];
  private bitrate: number[] = [];
  /** Момент начала эфира, если бот застал событие «трансляция началась» от OBS. */
  private obsStartedAt: number | null = null;
  /** Во сколько раз OBS завышает длительность (несколько дорожек видео — «Расширенная трансляция» Twitch). */
  private obsTracks = 1;

  constructor(opts: StatsOptions) {
    super();
    this.o = opts;
    this.iv = { ...DEFAULT_INTERVALS, ...opts.intervals };
    try {
      const saved = opts.loadSession?.();
      if (saved) { const s = JSON.parse(saved) as SessionState; if (typeof s.streamId === 'string') this.session = { ...emptySession(), ...s }; }
    } catch { /* повреждённая запись — начинаем заново */ }
    this.obs = new ObsClient({ log: opts.log, getConfig: opts.obsConfig, pollMs: opts.obsPollMs, host: opts.obsHost });
    this.obs.on('state', () => this.changed());
    this.obs.on('video', () => this.changed());
    this.obs.on('mics', () => this.changed());
    this.obs.on('sample', (s: ObsSample) => this.onSample(s));
    this.obs.on('stream', (on: boolean) => {
      if (on) {
        // Эфир начался в OBS: новый стрим (или продолжение после короткого обрыва); номер трансляции Twitch подхватим позже.
        this.beginSession('', Date.now());
        this.samples = []; this.bitrate = [];
        this.obsStartedAt = Date.now();
        this.obsTracks = 1;
        this.due.stream = Date.now() + 5000;
      } else {
        this.obsStartedAt = null;
        this.endSession(Date.now());
      }
      this.changed();
    });
  }

  /** Сколько экранов статистики открыто (док, overlay, страница панели). */
  setClients(n: number): void {
    this.clients = n;
    if (n > 0) {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (!this.active) this.activate();
    } else if (this.active && !this.idleTimer) {
      this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.clients === 0) this.deactivate(); }, this.o.idleStopMs ?? 60_000);
      this.idleTimer.unref();
    }
  }

  get isActive(): boolean { return this.active; }

  private activate(): void {
    this.active = true;
    this.due = { stream: 0, chatters: 0, followers: 0, subs: 0 };
    this.syncObs();
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), this.iv.tick);
    this.tickTimer.unref();
  }

  private deactivate(): void {
    this.active = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.obs.stop();
    this.samples = []; this.bitrate = [];
  }

  /** Включить или выключить подключение к OBS (сменилась программа для стрима или настройки). */
  syncObs(restart = false): void {
    if (this.active && this.o.useObs()) { this.obs.start(); if (restart) this.obs.restart(); } else this.obs.stop();
    this.changed();
  }

  /** Вход или выход из Twitch: обновить данные сразу. */
  authChanged(): void {
    this.noScope.clear();
    this.due = { stream: 0, chatters: 0, followers: 0, subs: 0 };
    if (!this.o.user()) { this.chatters = null; this.viewers = null; this.followers = null; this.subs = null; this.subPoints = null; this.live = null; }
    if (this.active) void this.tick();
    this.changed();
  }

  stop(): void {
    this.deactivate();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('update'); }, 200);
    this.emitTimer.unref();
  }

  /** OBS подключён и сейчас не транслирует — ему верим больше, чем Twitch (у Twitch задержка до минуты). */
  private obsSaysOffline(): boolean {
    const s = this.samples[this.samples.length - 1];
    return this.obs.state === 'ok' && !!s && !s.streaming;
  }

  private obsStreaming(): boolean {
    const s = this.samples[this.samples.length - 1];
    return this.obs.state === 'ok' && !!s?.streaming;
  }

  private sessionOpen(): boolean { return !!this.session.id && !this.session.endedAt; }

  /** Эфир идёт: продолжить текущий стрим или начать новый. streamId — номер трансляции Twitch, если известен. */
  private beginSession(streamId: string, startedAt: number): void {
    const s = this.session;
    const now = Date.now();
    if (this.sessionOpen()) {
      const otherStream = streamId && s.streamId && s.streamId !== streamId && now - s.lastAt > (this.o.resumeMs ?? RESUME_MS);
      // Без номера Twitch: запись осталась от давнего стрима, конец которого бот не застал.
      const stale = !streamId && s.lastAt && now - s.lastAt > STALE_MS;
      if (otherStream || stale) {
        // Бот не застал конец прошлого стрима — закрываем его по последнему известному моменту.
        this.endSession(s.lastAt || now);
        this.startNew(streamId, startedAt);
      } else if (streamId && s.streamId !== streamId) { s.streamId = streamId; this.saveSession(); }
      return;
    }
    if (s.id && s.endedAt && now - s.endedAt < (this.o.resumeMs ?? RESUME_MS)) {
      s.endedAt = 0; // короткий обрыв — тот же стрим, итоги допишутся
      if (streamId) s.streamId = streamId;
      s.lastAt = now;
      this.saveSession();
      return;
    }
    if (!s.id && streamId && s.streamId === streamId) {
      // Запись старой версии бота (1.5) про этот же стрим — счётчики сохраняем.
      Object.assign(s, { ...emptySession(), ...s, id: newId(), startedAt, lastAt: now });
      this.saveSession();
      return;
    }
    this.startNew(streamId, startedAt);
  }

  private startNew(streamId: string, startedAt: number): void {
    this.session = { ...emptySession(), id: newId(), streamId, startedAt, lastAt: Date.now(), peakViewers: this.viewers ?? 0, title: this.title, game: this.game };
    this.saveSession();
  }

  /** Эфир закончился: сохранить итоги. */
  private endSession(at: number): void {
    const s = this.session;
    if (!this.sessionOpen()) return;
    s.endedAt = Math.max(at, s.startedAt);
    this.saveSession();
    if (s.endedAt - s.startedAt < MIN_SUMMARY_MS || !this.o.store) return;
    try { this.o.store.saveSummary(this.summaryOf(s)); this.summariesCache = null; } catch (e) { this.o.log.warn('Итоги стрима не сохранены', e); }
    this.changed();
  }

  private summaryOf(s: SessionState): StreamSummary {
    return {
      id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, title: s.title, game: s.game,
      peakViewers: s.peakViewers, avgViewers: s.viewerSamples ? Math.round(s.viewerSum / s.viewerSamples) : null,
      followers: s.followersSession, followerNames: s.followerNames.slice(0, NAMES_MAX),
      subs: s.subsSession, resubs: s.resubs, subNames: s.subNames.slice(0, NAMES_MAX), gifts: s.gifts, raids: s.raids.slice(0, 50),
      chatters: s.chattersKnown ? s.chatters.length : null, newChatters: s.newChatters.length, newChatterNames: s.newChatters.slice(0, NAMES_MAX),
      redemptions: s.redemptions,
      markers: s.markers.slice(0, 100),
      topRewards: top(s.byReward, 5),
      topUsers: top(s.byUser, 5),
    };
  }

  private pushName(list: string[], name: string): void {
    if (name && list.length < NAMES_MAX && !list.includes(name)) list.push(name);
  }

  /** Награда за баллы канала (любая, не только бота) — в ленту и в итоги стрима. */
  noteRedemption(userName: string, rewardTitle: string): void {
    this.session.redemptions++;
    bump(this.session.byReward, rewardTitle);
    bump(this.session.byUser, userName);
    this.addFeed({ kind: 'redeem', name: userName, at: Date.now(), text: rewardTitle });
    this.saveSession();
    this.changed();
  }

  /** История стримов изменилась (удалили запись в панели). */
  historyChanged(): void { this.summariesCache = null; this.changed(); }

  /** Шаутаут рейдеру сделан — кнопка в ленте сменится на «✓». */
  markShoutout(uid: string): void {
    for (const f of this.feed) if (f.kind === 'raid' && f.uid === uid) f.so = true;
    this.changed();
  }

  /** Метка в записи поставлена (секунды от начала трансляции). */
  noteMarker(positionSec: number): void {
    if (this.session.markers.length < 100) this.session.markers.push(positionSec);
    this.addFeed({ kind: 'marker', name: '', at: Date.now(), n: positionSec });
    this.saveSession();
    this.changed();
  }

  /** Итоги последних стримов (новые первыми). */
  history(limit = 30): StreamSummary[] {
    try { return this.o.store?.summaries(limit) ?? []; } catch { return []; }
  }

  private saveSession(): void {
    try { this.o.saveSession?.(JSON.stringify(this.session)); } catch { /* не критично */ }
  }

  private missingScopes(): string[] {
    return STATS_SCOPES.filter((s) => !this.o.hasScope(s) || this.noScope.has(s));
  }

  // ---------------- Twitch: опрос ----------------

  private async tick(): Promise<void> {
    if (this.busy || !this.active) return;
    const helix = this.o.helix();
    const user = this.o.user();
    if (!helix || !user?.id) { this.changed(); return; } // экраны получают снимок и без Twitch (OBS, «бот жив»)
    this.busy = true;
    const now = Date.now();
    try {
      if (now >= this.due.stream) { this.due.stream = now + this.iv.stream; await this.pollStream(helix, user.id); }
      if (now >= this.due.followers) {
        // Без права на события фолловеров число обновляется только опросом — чаще.
        this.due.followers = now + (this.o.hasScope(SCOPE_FOLLOWERS) ? this.iv.followers : this.iv.followersNoEvents);
        await this.guard(SCOPE_FOLLOWERS, async () => { this.followers = await helix.getFollowersTotal(user.id); }, false);
      }
      if (now >= this.due.chatters) {
        this.due.chatters = now + this.iv.chatters;
        if (this.o.hasScope(SCOPE_CHATTERS) && !this.noScope.has(SCOPE_CHATTERS)) await this.guard(SCOPE_CHATTERS, () => this.pollChatters(helix, user));
      }
      if (now >= this.due.subs) {
        this.due.subs = now + this.iv.subs;
        if (this.o.hasScope(SCOPE_SUBS) && !this.noScope.has(SCOPE_SUBS)) {
          await this.guard(SCOPE_SUBS, async () => { const s = await helix.getSubscriptionsSummary(user.id); this.subs = s.total; this.subPoints = s.points; });
        }
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /** Ошибки опроса не мешают остальному; 401/403 — права нет (или канал не компаньон) — больше не спрашиваем до нового входа. */
  private async guard(scope: string, fn: () => Promise<void>, markScope = true): Promise<void> {
    try { await fn(); } catch (e) {
      if (markScope && e instanceof HelixError && (e.status === 401 || e.status === 403)) {
        this.noScope.add(scope);
        this.o.log.info(`Статистика: ${scope} недоступно (${e.status})`);
      } else this.o.log.debug(`Статистика: ${(e as Error).message}`);
    }
  }

  private async pollStream(helix: HelixClient, uid: string): Promise<void> {
    try {
      const s = await helix.getStream(uid);
      if (s && s.type === 'live') {
        this.live = true;
        this.viewers = Number(s.viewer_count) || 0;
        this.startedAt = Date.parse(s.started_at) || null;
        this.title = s.title || '';
        this.game = s.game_name || '';
        // Twitch ещё показывает эфир, а OBS уже остановил трансляцию — это задержка Twitch, не новый стрим.
        if (!this.obsSaysOffline() || this.sessionOpen()) this.beginSession(s.id, this.startedAt ?? Date.now());
        const ss = this.session;
        if (this.sessionOpen()) {
          // Время начала по Twitch точнее оценки по OBS; раньше нашего — тоже берём (бот открыли не сразу).
          if (this.startedAt && (ss.startEstimated || (this.startedAt < ss.startedAt && ss.startedAt - this.startedAt < 15 * 60_000))) {
            ss.startedAt = this.startedAt; ss.startEstimated = false;
          }
          ss.viewerSum += this.viewers; ss.viewerSamples++;
          if (this.viewers > ss.peakViewers) ss.peakViewers = this.viewers;
          ss.title = this.title; ss.game = this.game; ss.lastAt = Date.now();
          this.saveSession();
        }
      } else {
        const wasLive = this.live === true;
        this.live = false;
        this.viewers = null;
        this.startedAt = null;
        // Twitch: эфира нет. Если OBS не транслирует (или OBS не подключён) — стрим закончился.
        if (this.sessionOpen() && !this.obsStreaming()) this.endSession(wasLive ? Date.now() : this.session.lastAt || Date.now());
      }
    } catch (e) { this.o.log.debug(`Статистика: ${(e as Error).message}`); }
  }

  private async pollChatters(helix: HelixClient, user: { id: string; login: string }): Promise<void> {
    const r = await helix.getChatters(user.id, user.id);
    const first = this.chatters === null;
    const prev = this.chatters ?? new Map<string, ChatterView>();
    const next = new Map<string, ChatterView>();
    const now = Date.now();
    const users = r.users.filter((u) => { const l = u.login.toLowerCase(); return l !== user.login.toLowerCase() && !KNOWN_BOTS.has(l); });
    // Сколько раз каждый был на стримах (база). «Впервые» — только если бот запоминал зрителей с начала этого стрима.
    const ss = this.session;
    const live = this.sessionOpen();
    let visits = new Map<string, number>();
    let canSayFirst = false;
    if (this.o.store) {
      try {
        const since = this.o.store.trackingSince();
        canSayFirst = live && since !== null && since <= ss.startedAt;
        visits = this.o.store.chatterVisits(users, live ? ss.id : null, now);
      } catch (e) { this.o.log.debug(`Статистика: зрители: ${(e as Error).message}`); }
    }
    if (live) { ss.chattersKnown = true; ss.lastAt = now; }
    const known = live ? new Set(ss.chatters) : null;
    for (const u of users) {
      const login = u.login.toLowerCase();
      const was = prev.get(login);
      const v = visits.get(login) ?? null;
      const isFirst = canSayFirst && v === 1;
      next.set(login, { name: u.name, since: was ? was.since : first ? 0 : now, visits: v, first: isFirst });
      if (!was && !first) this.addFeed({ kind: 'join', name: u.name, at: now, first: isFirst || undefined, n: v ?? undefined });
      if (known && !known.has(login) && ss.chatters.length < CHATTERS_MAX) {
        ss.chatters.push(login);
        known.add(login);
        if (isFirst) this.pushName(ss.newChatters, u.name);
      }
    }
    this.chatters = next;
    if (live) this.saveSession();
  }

  // ---------------- Twitch: события ----------------

  /** Уведомление EventSub (любое): статистика берёт только свои типы. */
  handleNotification(msg: EventSubMessage): void {
    const type = msg.metadata?.subscription_type;
    if (!type || !STATS_EVENT_TYPES.has(type)) return;
    const id = msg.metadata.message_id;
    if (id) {
      if (this.seenMessages.has(id)) return;
      this.seenMessages.add(id);
      if (this.seenMessages.size > 500) this.seenMessages = new Set([...this.seenMessages].slice(-200));
    }
    const ev = (msg.payload.event ?? {}) as Record<string, unknown>;
    const name = String(ev.user_name ?? ev.user_login ?? ev.from_broadcaster_user_name ?? '');
    const now = Date.now();
    switch (type) {
      case 'channel.follow':
        if (this.followers !== null) this.followers++;
        this.session.followersSession++;
        this.pushName(this.session.followerNames, name);
        this.addFeed({ kind: 'follow', name, at: now });
        break;
      case 'channel.subscribe':
        this.session.subsSession++;
        this.due.subs = Math.min(this.due.subs, now + 10_000); // уточнить число и баллы
        if (!ev.is_gift) { this.addFeed({ kind: 'sub', name, at: now, tier: tierName(ev.tier) }); this.pushName(this.session.subNames, name); }
        break;
      case 'channel.subscription.message':
        this.session.resubs++;
        this.pushName(this.session.subNames, name);
        this.addFeed({ kind: 'resub', name, at: now, n: Number(ev.cumulative_months) || undefined, tier: tierName(ev.tier) });
        break;
      case 'channel.subscription.gift':
        this.session.gifts += Number(ev.total) || 1;
        this.addFeed({ kind: 'gift', name: ev.is_anonymous ? '' : name, at: now, n: Number(ev.total) || 1, tier: tierName(ev.tier) });
        break;
      case 'channel.raid': {
        const from = String(ev.from_broadcaster_user_name ?? '');
        if (this.session.raids.length < 50) this.session.raids.push({ name: from, viewers: Number(ev.viewers) || 0 });
        this.addFeed({ kind: 'raid', name: from, at: now, n: Number(ev.viewers) || 0, uid: String(ev.from_broadcaster_user_id ?? '') || undefined });
        break;
      }
      case 'stream.online': {
        this.live = true;
        this.startedAt = Date.parse(String(ev.started_at ?? '')) || now;
        this.beginSession(String(ev.id ?? ''), this.startedAt);
        this.due.stream = now + 5000;
        break;
      }
      case 'stream.offline':
        this.live = false;
        this.viewers = null;
        this.startedAt = null;
        if (!this.obsStreaming()) this.endSession(now);
        break;
    }
    this.saveSession();
    this.changed();
  }

  private addFeed(item: FeedItem): void {
    this.feed.unshift(item);
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }

  // ---------------- OBS ----------------

  private onSample(s: ObsSample): void {
    const prev = this.samples[this.samples.length - 1];
    if (prev && (s.outputBytes < prev.outputBytes || s.streaming !== prev.streaming)) { this.samples = []; this.bitrate = []; }
    const last = this.samples[this.samples.length - 1];
    if (last && s.streaming && s.at > last.at) {
      const kbps = ((s.outputBytes - last.outputBytes) * 8) / (s.at - last.at);
      this.bitrate.push(Math.max(0, Math.round(kbps)));
      if (this.bitrate.length > HISTORY) this.bitrate.shift();
    }
    if (!s.streaming) this.obsStartedAt = null;
    if (s.streaming) {
      // Бот запущен посреди эфира или пропустил событие начала — стрим всё равно учитываем.
      const est = s.at - Math.round(s.durationMs / this.obsTracks);
      if (!this.sessionOpen()) {
        this.beginSession('', this.live && this.startedAt ? this.startedAt : est);
        if (this.sessionOpen() && !(this.live && this.startedAt) && !this.obsStartedAt) this.session.startEstimated = true;
      }
      // Оценка по OBS уточняется, пока не известно число дорожек и время Twitch.
      if (this.session.startEstimated && !this.startedAt) this.session.startedAt = est;
      this.session.lastAt = s.at;
    } else if (prev?.streaming && this.sessionOpen()) this.endSession(s.at);
    this.samples.push(s);
    if (this.samples.length > WINDOW + 1) this.samples.shift();
    this.measureTracks();
    this.changed();
  }

  /**
   * outputDuration у OBS — это «кадры × время одного кадра». При «Расширенной трансляции» Twitch OBS шлёт несколько
   * дорожек видео сразу и складывает их кадры, поэтому длительность выходит в разы больше настоящей (6 ч → 22 ч).
   * Число дорожек оцениваем по скорости роста кадров относительно FPS, с шагом 0,25 (дорожки бывают 60/30/15 FPS).
   */
  private measureTracks(): void {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const fps = this.obs.video?.fps ?? 0;
    if (!first || !last || !last.streaming || fps <= 0 || last.at - first.at < 4000) return;
    const rate = ((last.outputTotalFrames - first.outputTotalFrames) * 1000) / (last.at - first.at);
    const k = Math.round((rate / fps) * 4) / 4;
    this.obsTracks = k >= 1.25 ? k : 1;
  }

  /** Начало эфира: момент события OBS → время Twitch → длительность OBS с поправкой на число дорожек. */
  private sessionStartFrom(s: ObsSample | undefined, obsStreaming: boolean): { start: number | null; source: StatsView['sessionSource'] } {
    if (obsStreaming && this.obsStartedAt) return { start: this.obsStartedAt, source: 'obs' };
    if (this.live && this.startedAt) return { start: this.startedAt, source: 'twitch' };
    if (obsStreaming && s) return { start: s.at - Math.round(s.durationMs / this.obsTracks), source: 'obs' };
    return { start: null, source: null };
  }

  private health(): { health: Health | null; reason: string; droppedPct: number | null } {
    const s = this.samples[this.samples.length - 1];
    if (!s || !s.streaming) return { health: null, reason: '', droppedPct: null };
    const droppedPct = s.outputTotalFrames > 0 ? (s.outputSkippedFrames / s.outputTotalFrames) * 100 : 0;
    const first = this.samples[0];
    const dTotal = s.outputTotalFrames - first.outputTotalFrames;
    const recentDrop = dTotal > 0 ? ((s.outputSkippedFrames - first.outputSkippedFrames) / dTotal) * 100 : 0;
    const dRender = s.renderTotalFrames - first.renderTotalFrames;
    const renderLag = dRender > 0 ? ((s.renderSkippedFrames - first.renderSkippedFrames) / dRender) * 100 : 0;
    const sorted = [...this.bitrate].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const cur = this.currentBitrate();
    if (s.reconnecting) return { health: 'bad', reason: 'reconnecting', droppedPct };
    if (recentDrop >= 5) return { health: 'bad', reason: 'dropped', droppedPct };
    if (this.bitrate.length >= 10 && median > 500 && cur !== null && cur < median * 0.3) return { health: 'bad', reason: 'bitrate_low', droppedPct };
    if (recentDrop >= 0.5) return { health: 'warn', reason: 'dropped', droppedPct };
    if (this.bitrate.length >= 10 && median > 500 && cur !== null && cur < median * 0.6) return { health: 'warn', reason: 'bitrate_low', droppedPct };
    if (renderLag >= 3) return { health: 'warn', reason: 'render', droppedPct };
    if (s.cpu >= 90) return { health: 'warn', reason: 'cpu', droppedPct };
    return { health: 'good', reason: '', droppedPct };
  }

  /** Битрейт как в OBS: среднее за последние ~4 секунды. */
  private currentBitrate(): number | null {
    if (!this.bitrate.length) return null;
    const tail = this.bitrate.slice(-2);
    return Math.round(tail.reduce((a, b) => a + b, 0) / tail.length);
  }

  // ---------------- Снимок для экранов ----------------

  view(): StatsView {
    const s = this.samples[this.samples.length - 1];
    const obsStreaming = !!s?.streaming && this.obs.state === 'ok';
    const h = this.health();
    const v = this.obs.video;
    const now = Date.now();
    const { start: sessionStart, source: sessionSource } = this.sessionStartFrom(s, obsStreaming);
    const list = this.chatters ? [...this.chatters.values()].sort((a, b) => b.since - a.since || a.name.localeCompare(b.name)).slice(0, 300) : [];
    if (!this.summariesCache) this.summariesCache = this.history(2);
    let tracked: number | null = null;
    try { tracked = this.o.store?.trackingSince() ?? null; } catch { /* */ }
    return {
      at: now,
      twitch: this.o.user() ? 'ok' : 'logged_out',
      missingScopes: this.o.user() ? this.missingScopes() : [],
      live: obsStreaming ? true : this.live,
      sessionStart,
      sessionSource,
      title: this.title,
      game: this.game,
      viewers: this.viewers,
      peakViewers: this.live ? Math.max(this.session.peakViewers, this.viewers ?? 0) : (this.session.peakViewers || null),
      chatters: this.chatters ? this.chatters.size : null,
      chattersList: list,
      chattersTrackedSince: tracked,
      followers: this.followers,
      followersSession: this.session.followersSession,
      subs: this.subs,
      subPoints: this.subPoints,
      subsSession: this.session.subsSession,
      feed: this.feed.slice(0, 20),
      summaries: this.summariesCache,
      obs: {
        enabled: this.o.useObs(),
        state: this.obs.state,
        message: this.obs.message,
        streaming: obsStreaming,
        reconnecting: !!s?.reconnecting,
        bitrateKbps: obsStreaming ? this.currentBitrate() : null,
        bitrateHistory: obsStreaming ? this.bitrate.slice() : [],
        width: v?.width ?? 0,
        height: v?.height ?? 0,
        fps: v?.fps ?? 0,
        activeFps: s ? Math.round(s.activeFps * 10) / 10 : 0,
        droppedFrames: obsStreaming ? s.outputSkippedFrames : 0,
        droppedPct: h.droppedPct === null ? null : Math.round(h.droppedPct * 100) / 100,
        cpu: s ? Math.round(s.cpu * 10) / 10 : null,
        health: h.health,
        healthReason: h.reason,
        mics: this.obs.mics,
      },
    };
  }
}

/** Счётчик в словаре (не больше 500 разных ключей — память под контролем). */
function bump(map: Record<string, number>, key: string): void {
  if (!key) return;
  if (map[key] === undefined && Object.keys(map).length >= 500) return;
  map[key] = (map[key] ?? 0) + 1;
}

function top(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function newId(): string { return crypto.randomBytes(8).toString('hex'); }

function tierName(t: unknown): string | undefined {
  return t === '2000' ? '2' : t === '3000' ? '3' : t === '1000' ? '1' : undefined;
}
