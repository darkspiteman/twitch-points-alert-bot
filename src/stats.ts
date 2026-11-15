import { EventEmitter } from 'node:events';
import type { ScopedLogger } from './logger.ts';
import { HelixError, type HelixClient } from './twitch/helix.ts';
import type { EventSubMessage } from './twitch/eventsub.ts';
import { ObsClient, type ObsSample, type ObsState, type ObsWsConfig } from './obs-ws.ts';

/**
 * Статистика стрима для док-панели OBS и overlay на экране (1.5.0).
 *
 * Источники:
 *  • OBS WebSocket (мгновенно): время трансляции, битрейт, разрешение, FPS, потерянные кадры, CPU;
 *  • Twitch Helix (опрос раз в 15–120 с): зрители, кто в чате, фолловеры, подписчики и баллы подписок;
 *  • Twitch EventSub (мгновенно): новые фолловеры, подписки, подарки, рейды, начало и конец эфира.
 * Twitch и OBS опрашиваются только пока открыт хотя бы один экран статистики (док, overlay или панель).
 */

export const SCOPE_FOLLOWERS = 'moderator:read:followers';
export const SCOPE_SUBS = 'channel:read:subscriptions';
export const SCOPE_CHATTERS = 'moderator:read:chatters';
/** Права для статистики: запрашиваются при входе, но не обязательны (без них бот работает, а статистика неполная). */
export const STATS_SCOPES = [SCOPE_FOLLOWERS, SCOPE_SUBS, SCOPE_CHATTERS];

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

export type FeedKind = 'follow' | 'sub' | 'resub' | 'gift' | 'raid' | 'join';
export interface FeedItem { kind: FeedKind; name: string; at: number; n?: number; tier?: string }

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
  chattersList: Array<{ name: string; since: number }>;
  followers: number | null;
  followersSession: number;
  subs: number | null;
  subPoints: number | null;
  subsSession: number;
  feed: FeedItem[];
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
  };
}

interface SessionState { streamId: string; peakViewers: number; followersSession: number; subsSession: number }

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
  private chatters: Map<string, { name: string; since: number }> | null = null;
  private session: SessionState = { streamId: '', peakViewers: 0, followersSession: 0, subsSession: 0 };
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
      if (saved) { const s = JSON.parse(saved) as SessionState; if (typeof s.streamId === 'string') this.session = { ...this.session, ...s }; }
    } catch { /* повреждённая запись — начинаем заново */ }
    this.obs = new ObsClient({ log: opts.log, getConfig: opts.obsConfig, pollMs: opts.obsPollMs, host: opts.obsHost });
    this.obs.on('state', () => this.changed());
    this.obs.on('video', () => this.changed());
    this.obs.on('sample', (s: ObsSample) => this.onSample(s));
    this.obs.on('stream', (on: boolean) => {
      if (on) {
        // Эфир начался в OBS: счётчики сессии — с нуля; номер трансляции Twitch подхватим, когда он появится.
        this.resetSession('');
        this.samples = []; this.bitrate = [];
        this.obsStartedAt = Date.now();
        this.obsTracks = 1;
        this.due.stream = Date.now() + 5000;
      } else {
        this.obsStartedAt = null;
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

  private resetSession(streamId: string): void {
    this.session = { streamId, peakViewers: this.viewers ?? 0, followersSession: 0, subsSession: 0 };
    this.saveSession();
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
        if (this.session.streamId === '') { this.session.streamId = s.id; this.saveSession(); }
        else if (this.session.streamId !== s.id) this.resetSession(s.id);
        if (this.viewers > this.session.peakViewers) { this.session.peakViewers = this.viewers; this.saveSession(); }
      } else {
        this.live = false;
        this.viewers = null;
        this.startedAt = null;
      }
    } catch (e) { this.o.log.debug(`Статистика: ${(e as Error).message}`); }
  }

  private async pollChatters(helix: HelixClient, user: { id: string; login: string }): Promise<void> {
    const r = await helix.getChatters(user.id, user.id);
    const first = this.chatters === null;
    const prev = this.chatters ?? new Map();
    const next = new Map<string, { name: string; since: number }>();
    const now = Date.now();
    for (const u of r.users) {
      const login = u.login.toLowerCase();
      if (login === user.login.toLowerCase() || KNOWN_BOTS.has(login)) continue;
      const was = prev.get(login);
      next.set(login, { name: u.name, since: was ? was.since : first ? 0 : now });
      if (!was && !first) this.addFeed({ kind: 'join', name: u.name, at: now });
    }
    this.chatters = next;
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
        this.addFeed({ kind: 'follow', name, at: now });
        break;
      case 'channel.subscribe':
        this.session.subsSession++;
        this.due.subs = Math.min(this.due.subs, now + 10_000); // уточнить число и баллы
        if (!ev.is_gift) this.addFeed({ kind: 'sub', name, at: now, tier: tierName(ev.tier) });
        break;
      case 'channel.subscription.message':
        this.addFeed({ kind: 'resub', name, at: now, n: Number(ev.cumulative_months) || undefined, tier: tierName(ev.tier) });
        break;
      case 'channel.subscription.gift':
        this.addFeed({ kind: 'gift', name: ev.is_anonymous ? '' : name, at: now, n: Number(ev.total) || 1, tier: tierName(ev.tier) });
        break;
      case 'channel.raid':
        this.addFeed({ kind: 'raid', name: String(ev.from_broadcaster_user_name ?? ''), at: now, n: Number(ev.viewers) || 0 });
        break;
      case 'stream.online': {
        this.live = true;
        this.startedAt = Date.parse(String(ev.started_at ?? '')) || now;
        const sid = String(ev.id ?? '');
        if (sid && this.session.streamId !== sid && this.session.streamId !== '') this.resetSession(sid);
        else if (sid) { this.session.streamId = sid; }
        this.due.stream = now + 5000;
        break;
      }
      case 'stream.offline':
        this.live = false;
        this.viewers = null;
        this.startedAt = null;
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
      followers: this.followers,
      followersSession: this.session.followersSession,
      subs: this.subs,
      subPoints: this.subPoints,
      subsSession: this.session.subsSession,
      feed: this.feed.slice(0, 20),
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
      },
    };
  }
}

function tierName(t: unknown): string | undefined {
  return t === '2000' ? '2' : t === '3000' ? '3' : t === '1000' ? '1' : undefined;
}
