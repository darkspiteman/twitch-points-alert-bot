import type { TwitchAuth, FetchFn } from './auth.ts';
import type { ScopedLogger } from '../logger.ts';

export class HelixError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface HelixReward {
  id: string;
  title: string;
  cost: number;
  prompt: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  background_color: string;
  is_user_input_required: boolean;
  max_per_stream_setting: { is_enabled: boolean; max_per_stream: number };
  max_per_user_per_stream_setting: { is_enabled: boolean; max_per_user_per_stream: number };
  global_cooldown_setting: { is_enabled: boolean; global_cooldown_seconds: number };
  should_redemptions_skip_request_queue: boolean;
  image: { url_1x: string; url_2x: string; url_4x: string } | null;
  default_image: { url_1x: string; url_2x: string; url_4x: string } | null;
}

export interface HelixRedemption {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: 'CANCELED' | 'FULFILLED' | 'UNFULFILLED';
  redeemed_at: string;
  reward: { id: string; title: string; prompt: string; cost: number };
}

export interface EventSubSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: { method: string; session_id?: string };
  created_at: string;
}

export class HelixClient {
  private auth: TwitchAuth;
  private fetchFn: FetchFn;
  private base: string;
  private log: ScopedLogger;

  constructor(auth: TwitchAuth, log: ScopedLogger, opts: { fetchFn?: FetchFn; base?: string } = {}) {
    this.auth = auth;
    this.log = log;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.base = opts.base ?? 'https://api.twitch.tv/helix';
  }

  async request<T>(method: string, path: string, query: Record<string, string | string[] | undefined> = {}, body?: unknown, attempt = 0): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    const token = await this.auth.getAccessToken();
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': this.auth.getClientId(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new HelixError(0, `Нет связи с Twitch API: ${(e as Error).message}`);
    }
    if (res.status === 401 && attempt === 0) {
      this.log.info(`Helix ${method} ${path}: 401, обновляю токен и повторяю`);
      await this.auth.refresh();
      return this.request<T>(method, path, query, body, 1);
    }
    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get('ratelimit-reset')) * 1000;
      const wait = Math.min(10_000, Math.max(500, reset ? reset - Date.now() : 1000));
      this.log.warn(`Helix: превышен лимит запросов, жду ${wait} мс`);
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(method, path, query, body, attempt + 1);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* not json */ }
      throw new HelixError(res.status, `Twitch API ${method} ${path}: HTTP ${res.status} ${msg}`.slice(0, 500));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async getCustomRewards(broadcasterId: string, onlyManageable = false): Promise<HelixReward[]> {
    const r = await this.request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', { broadcaster_id: broadcasterId, only_manageable_rewards: String(onlyManageable) });
    return r.data;
  }

  async createCustomReward(broadcasterId: string, body: Record<string, unknown>): Promise<HelixReward> {
    const r = await this.request<{ data: HelixReward[] }>('POST', '/channel_points/custom_rewards', { broadcaster_id: broadcasterId }, body);
    return r.data[0];
  }

  async updateCustomReward(broadcasterId: string, id: string, body: Record<string, unknown>): Promise<HelixReward> {
    const r = await this.request<{ data: HelixReward[] }>('PATCH', '/channel_points/custom_rewards', { broadcaster_id: broadcasterId, id }, body);
    return r.data[0];
  }

  async getRedemptions(broadcasterId: string, rewardId: string, status: 'UNFULFILLED' | 'FULFILLED' | 'CANCELED', first = 50): Promise<HelixRedemption[]> {
    const r = await this.request<{ data: HelixRedemption[] }>('GET', '/channel_points/custom_rewards/redemptions', {
      broadcaster_id: broadcasterId, reward_id: rewardId, status, sort: 'NEWEST', first: String(first),
    });
    return r.data;
  }

  async createEventSubSubscription(type: string, version: string, condition: Record<string, string>, sessionId: string): Promise<EventSubSubscription> {
    const r = await this.request<{ data: EventSubSubscription[] }>('POST', '/eventsub/subscriptions', {}, {
      type, version, condition, transport: { method: 'websocket', session_id: sessionId },
    });
    return r.data[0];
  }

  async getEventSubSubscriptions(): Promise<EventSubSubscription[]> {
    const out: EventSubSubscription[] = [];
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await this.request<{ data: EventSubSubscription[]; pagination?: { cursor?: string } }>('GET', '/eventsub/subscriptions', { after });
      out.push(...r.data);
      after = r.pagination?.cursor;
      if (!after) break;
    }
    return out;
  }

  async deleteEventSubSubscription(id: string): Promise<void> {
    await this.request<void>('DELETE', '/eventsub/subscriptions', { id });
  }

  // ---------------- Статистика канала ----------------

  /** Текущая трансляция канала; null — канал не в эфире. Право не нужно. */
  async getStream(userId: string): Promise<HelixStream | null> {
    const r = await this.request<{ data: HelixStream[] }>('GET', '/streams', { user_id: userId, first: '1' });
    return r.data[0] ?? null;
  }

  /** Число фолловеров: total отдаётся и без права moderator:read:followers. */
  async getFollowersTotal(broadcasterId: string): Promise<number> {
    const r = await this.request<{ total: number }>('GET', '/channels/followers', { broadcaster_id: broadcasterId, first: '1' });
    return Number(r.total) || 0;
  }

  /** Подписчики и баллы подписок (право channel:read:subscriptions). */
  async getSubscriptionsSummary(broadcasterId: string): Promise<{ total: number; points: number }> {
    const r = await this.request<{ total: number; points: number }>('GET', '/subscriptions', { broadcaster_id: broadcasterId, first: '1' });
    return { total: Number(r.total) || 0, points: Number(r.points) || 0 };
  }

  /** Кто сейчас в чате (право moderator:read:chatters). Не больше maxPages × 1000 имён. */
  async getChatters(broadcasterId: string, moderatorId: string, maxPages = 3): Promise<{ total: number; users: Array<{ login: string; name: string }> }> {
    const users: Array<{ login: string; name: string }> = [];
    let total = 0;
    let after: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.request<{ data: Array<{ user_login: string; user_name: string }>; total: number; pagination?: { cursor?: string } }>(
        'GET', '/chat/chatters', { broadcaster_id: broadcasterId, moderator_id: moderatorId, first: '1000', after });
      total = Number(r.total) || 0;
      for (const u of r.data) users.push({ login: u.user_login, name: u.user_name || u.user_login });
      after = r.pagination?.cursor;
      if (!after) break;
    }
    return { total, users };
  }
}

export interface HelixStream {
  id: string;
  user_id: string;
  type: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
}
