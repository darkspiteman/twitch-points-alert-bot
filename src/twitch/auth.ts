import { EventEmitter } from 'node:events';
import type { SecureStore } from '../secure-store.ts';
import { registerSecret, type ScopedLogger } from '../logger.ts';

export type FetchFn = typeof fetch;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scopes: string[];
  userId: string;
  login: string;
  clientId: string;
}

export type AuthState =
  | { status: 'no_client_id'; message: string }
  | { status: 'logged_out'; message: string }
  | { status: 'pending'; message: string; userCode: string; verificationUri: string; expiresAt: number }
  | { status: 'ok'; message: string; login: string; userId: string; scopes: string[]; expiresAt: number }
  | { status: 'error'; message: string };

export class AuthError extends Error {
  readonly needsLogin: boolean;
  constructor(message: string, needsLogin: boolean) { super(message); this.needsLogin = needsLogin; }
}

export const SCOPE_READ = 'channel:read:redemptions';
export const SCOPE_MANAGE = 'channel:manage:redemptions';

export interface AuthOptions {
  store: SecureStore;
  log: ScopedLogger;
  getClientId: () => string;
  /** Нужно ли право управлять наградами (создание копий, статусы). */
  wantManage: () => boolean;
  /** Необязательные права (статистика): запрашиваются при входе, но без них вход не считается ошибкой. */
  optionalScopes?: () => string[];
  fetchFn?: FetchFn;
  idBase?: string;
  now?: () => number;
}

/**
 * Авторизация Twitch: Device Code Grant Flow для public-клиента (без client secret),
 * автоматическое обновление токена, ежечасная валидация.
 */
export class TwitchAuth extends EventEmitter {
  private opts: AuthOptions;
  private fetchFn: FetchFn;
  private idBase: string;
  private now: () => number;
  private tokens: TokenSet | null = null;
  private refreshing: Promise<TokenSet> | null = null;
  private validateTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pollAbort: AbortController | null = null;
  private _state: AuthState = { status: 'logged_out', message: 'Не выполнен вход в Twitch' };

  constructor(opts: AuthOptions) {
    super();
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.idBase = opts.idBase ?? 'https://id.twitch.tv';
    this.now = opts.now ?? Date.now;
  }

  get state(): AuthState { return this._state; }
  get user(): { id: string; login: string } | null { return this.tokens ? { id: this.tokens.userId, login: this.tokens.login } : null; }
  get scopes(): string[] { return this.tokens?.scopes ?? []; }
  hasScope(s: string): boolean { return this.scopes.includes(s) || (s === SCOPE_READ && this.scopes.includes(SCOPE_MANAGE)); }

  requiredScopes(): string[] { return this.opts.wantManage() ? [SCOPE_MANAGE] : [SCOPE_READ]; }
  /** Что просить при входе: обязательные права и необязательные (статистика). */
  requestedScopes(): string[] { return [...new Set([...this.requiredScopes(), ...(this.opts.optionalScopes?.() ?? [])])]; }

  private setState(s: AuthState): void {
    this._state = s;
    this.emit('state', s);
  }

  private setOk(): void {
    const t = this.tokens!;
    this.setState({ status: 'ok', message: `Подключено как ${t.login}`, login: t.login, userId: t.userId, scopes: t.scopes, expiresAt: t.expiresAt });
  }

  /** Загрузка сохранённых токенов при старте. */
  async init(): Promise<void> {
    const clientId = this.opts.getClientId();
    if (!clientId) { this.setState({ status: 'no_client_id', message: 'Укажите Client ID приложения Twitch в настройках' }); return; }
    let raw: string | null = null;
    try { raw = await this.opts.store.load(); } catch (e) {
      this.opts.log.error('Не удалось расшифровать сохранённые токены', e);
      this.setState({ status: 'logged_out', message: 'Сохранённый вход повреждён — войдите в Twitch снова' });
      return;
    }
    if (!raw) { this.setState({ status: 'logged_out', message: 'Не выполнен вход в Twitch' }); return; }
    try {
      const t = JSON.parse(raw) as TokenSet;
      if (t.clientId !== clientId) {
        this.setState({ status: 'logged_out', message: 'Client ID изменён — войдите в Twitch снова' });
        return;
      }
      this.tokens = t;
      registerSecret(t.accessToken); registerSecret(t.refreshToken);
      await this.validate();
      this.startTimers();
    } catch (e) {
      if (e instanceof AuthError) { if (!e.needsLogin) this.startTimers(); return; } // состояние уже выставлено
      this.opts.log.warn('Проверка токена при старте не удалась (возможно, нет сети), повторю позже', e);
      if (this.tokens) this.setOk();
      this.startTimers();
    }
  }

  private startTimers(): void {
    this.stopTimers();
    // Twitch требует валидировать токен при старте и далее раз в час.
    this.validateTimer = setInterval(() => { this.validate().catch((e) => this.opts.log.warn('Ежечасная проверка токена не удалась', e)); }, 60 * 60_000);
    this.validateTimer.unref();
    // Проверка срока действия каждую минуту — обновляем заранее.
    this.refreshTimer = setInterval(() => {
      if (this.tokens && this.tokens.expiresAt - this.now() < 10 * 60_000) {
        this.refresh().catch((e) => this.opts.log.warn('Плановое обновление токена не удалось', e));
      }
    }, 60_000);
    this.refreshTimer.unref();
  }

  private stopTimers(): void {
    if (this.validateTimer) clearInterval(this.validateTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.validateTimer = this.refreshTimer = null;
  }

  /** Действующий access token (с автообновлением). */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new AuthError('Не выполнен вход в Twitch', true);
    if (this.tokens.expiresAt - this.now() < 5 * 60_000) await this.refresh();
    return this.tokens!.accessToken;
  }

  getClientId(): string { return this.opts.getClientId(); }

  /** GET /oauth2/validate: проверка токена, получение user id и scopes. */
  async validate(): Promise<void> {
    if (!this.tokens) return;
    const res = await this.fetchFn(`${this.idBase}/oauth2/validate`, { headers: { Authorization: `OAuth ${this.tokens.accessToken}` } });
    if (res.status === 401) {
      this.opts.log.info('Токен недействителен, обновляю');
      await this.refresh();
      return this.validate();
    }
    if (!res.ok) throw new Error(`validate: HTTP ${res.status}`);
    const body = (await res.json()) as { client_id: string; login: string; user_id: string; scopes: string[] | null; expires_in: number };
    this.tokens.userId = body.user_id;
    this.tokens.login = body.login;
    this.tokens.scopes = body.scopes ?? [];
    this.tokens.expiresAt = this.now() + body.expires_in * 1000;
    const missing = this.requiredScopes().filter((s) => !this.hasScope(s));
    if (missing.length) {
      this.setState({ status: 'error', message: `Недостаточно прав (${missing.join(', ')}). Нажмите «Войти через Twitch» ещё раз.` });
      throw new AuthError('missing scopes', false);
    }
    await this.persist();
    this.setOk();
  }

  /** Обновление токена. Refresh token одноразовый — новый сохраняется сразу. */
  refresh(): Promise<TokenSet> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<TokenSet> {
    if (!this.tokens) throw new AuthError('Не выполнен вход в Twitch', true);
    const body = new URLSearchParams({ client_id: this.opts.getClientId(), grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken });
    let res: Response;
    try {
      res = await this.fetchFn(`${this.idBase}/oauth2/token`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (e) {
      throw new Error(`Нет связи с Twitch при обновлении токена: ${(e as Error).message}`);
    }
    if (res.status === 400 || res.status === 401) {
      const text = await res.text().catch(() => '');
      this.opts.log.warn(`Refresh token отклонён Twitch (HTTP ${res.status}): ${text.slice(0, 200)}`);
      this.tokens = null;
      await this.opts.store.clear().catch(() => {});
      this.stopTimers();
      this.setState({ status: 'logged_out', message: 'Срок входа истёк или доступ отозван — войдите в Twitch снова' });
      this.emit('logged_out', 'expired');
      throw new AuthError('refresh rejected', true);
    }
    if (!res.ok) throw new Error(`Twitch вернул ошибку при обновлении токена: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string[] };
    registerSecret(j.access_token); registerSecret(j.refresh_token);
    this.tokens = { ...this.tokens, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: this.now() + j.expires_in * 1000, scopes: j.scope ?? this.tokens.scopes };
    await this.persist();
    this.opts.log.info('Токен Twitch обновлён');
    this.setOk();
    this.emit('refreshed');
    return this.tokens;
  }

  private async persist(): Promise<void> {
    if (this.tokens) await this.opts.store.save(JSON.stringify(this.tokens));
  }

  /** Запуск входа через Device Code Flow. Возвращает код, который пользователь подтверждает на twitch.tv. */
  async startLogin(): Promise<AuthState> {
    const clientId = this.opts.getClientId();
    if (!clientId) { this.setState({ status: 'no_client_id', message: 'Сначала укажите Client ID в настройках' }); return this._state; }
    this.cancelLogin();
    const scopes = this.requestedScopes().join(' ');
    const res = await this.fetchFn(`${this.idBase}/oauth2/device`, {
      method: 'POST', body: new URLSearchParams({ client_id: clientId, scopes }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let hint = '';
      if (/invalid client/i.test(text)) hint = ' Проверьте Client ID.';
      if (res.status === 400 && /public/i.test(text) === false && /client/i.test(text)) hint += ' Убедитесь, что тип клиента приложения — «Public» (Общедоступный).';
      this.setState({ status: 'error', message: `Twitch отклонил запрос входа (HTTP ${res.status}).${hint}` });
      this.opts.log.error(`device flow: HTTP ${res.status} ${text.slice(0, 200)}`);
      return this._state;
    }
    const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
    registerSecret(d.device_code);
    const expiresAt = this.now() + d.expires_in * 1000;
    this.setState({ status: 'pending', message: 'Подтвердите вход на сайте Twitch', userCode: d.user_code, verificationUri: d.verification_uri, expiresAt });
    this.pollAbort = new AbortController();
    void this.pollDevice(clientId, scopes, d.device_code, Math.max(1, d.interval || 5), expiresAt, this.pollAbort.signal);
    return this._state;
  }

  cancelLogin(): void {
    if (this.pollAbort) { this.pollAbort.abort(); this.pollAbort = null; }
  }

  private async pollDevice(clientId: string, scopes: string, deviceCode: string, intervalSec: number, expiresAt: number, signal: AbortSignal): Promise<void> {
    let interval = intervalSec;
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      if (signal.aborted) return;
      if (this.now() > expiresAt) {
        this.setState({ status: 'logged_out', message: 'Время на подтверждение входа истекло. Нажмите «Войти через Twitch» ещё раз.' });
        return;
      }
      try {
        const res = await this.fetchFn(`${this.idBase}/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, scopes, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        });
        if (res.ok) {
          const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string[] };
          registerSecret(j.access_token); registerSecret(j.refresh_token);
          this.tokens = { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: this.now() + j.expires_in * 1000, scopes: j.scope ?? [], userId: '', login: '', clientId };
          await this.validate();
          this.startTimers();
          this.opts.log.info(`Вход в Twitch выполнен: ${this.tokens.login}`);
          this.emit('logged_in');
          return;
        }
        const text = await res.text().catch(() => '');
        if (/authorization_pending/i.test(text)) continue;
        if (/slow_down/i.test(text)) { interval += 5; continue; }
        this.setState({ status: 'logged_out', message: /denied/i.test(text) ? 'Вход отклонён на сайте Twitch' : 'Код входа недействителен или истёк. Попробуйте ещё раз.' });
        return;
      } catch (e) {
        if (e instanceof AuthError) return;
        this.opts.log.warn('Ошибка при ожидании подтверждения входа, повторяю', e);
      }
    }
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    this.stopTimers();
    const t = this.tokens;
    this.tokens = null;
    await this.opts.store.clear();
    if (t) {
      // Отзываем токен на стороне Twitch (best effort).
      await this.fetchFn(`${this.idBase}/oauth2/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: t.clientId, token: t.accessToken }),
      }).catch(() => {});
    }
    this.setState({ status: 'logged_out', message: 'Вы вышли из Twitch' });
    if (t) this.emit('logged_out', 'manual');
  }

  /** Для тестов. */
  setTokensForTest(t: TokenSet): void { this.tokens = t; this.setOk(); }

  dispose(): void { this.cancelLogin(); this.stopTimers(); }
}
