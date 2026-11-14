import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { App } from '../app.ts';
import { PUBLIC_DIR, validateSettingsPatch, publicSettings, SUPPORT_LINKS } from '../config.ts';
import { FindError, KLIPY_TYPES, type KlipyType } from '../find.ts';
import { HelixError } from '../twitch/helix.ts';
import { MAX_UPLOAD_BYTES } from '../media.ts';
import { getAutostart, setAutostart } from '../autostart.ts';
import { STREAM_APPS, resolveExe } from '../stream-app.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.wav': 'audio/wav',
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: unknown) => Promise<unknown> | unknown;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; raw?: boolean }

export interface ServerHooks { onShutdown: () => void }

export function createServer(app: App, hooks: ServerHooks): http.Server {
  const routes: Route[] = [];
  const add = (method: string, p: string, handler: Handler, raw = false) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, keys, handler, raw });
  };

  // ---------------- API ----------------
  add('GET', '/api/health', () => {
    const s = app.statusSummary();
    return {
      ok: true, version: s.version, uptimeSec: s.uptimeSec,
      twitch: s.auth.status, eventsub: s.eventsub.state, overlays: s.overlays.length, obsOverlays: s.overlays.filter((o) => o.isObs).length, mode: s.mode,
      streamApp: app.db.getSettings().streamApp, streamlabsOverlays: s.overlays.filter((o) => o.app === 'streamlabs').length,
      viaFileOverlays: s.overlays.filter((o) => o.isObs && o.viaFile).length,
    };
  });

  add('GET', '/api/state', async () => ({
    status: app.statusSummary(),
    settings: publicSettings(app.db.getSettings()),
    find: app.finder.status(),
    update: app.updater.status(),
    links: SUPPORT_LINKS,
    changelog: app.updater.localChangelog(),
    queue: app.queue.snapshot(),
    rewards: app.db.listRewards(),
    media: app.db.listMedia().map((m) => ({ ...m, usedBy: app.db.mediaUsage(m.id).map((r) => r.title) })),
    redemptions: app.db.recentRedemptions(50),
    events: app.db.recentEvents(100),
    autostart: await getAutostart().catch(() => false),
    overlayUrl: `http://127.0.0.1:${app.port}/overlay`,
    overlayLoader: app.loaderPath,
  }));

  add('POST', '/api/auth/login', async () => app.auth.startLogin());
  add('POST', '/api/auth/cancel', () => { app.auth.cancelLogin(); return { ok: true }; });
  add('POST', '/api/auth/logout', async () => { await app.auth.logout(); return { ok: true }; });
  add('POST', '/api/eventsub/reconnect', () => { if (app.auth.state.status !== 'ok') throw new HttpError(400, 'Сначала войдите в Twitch'); app.eventsub.restart(); return { ok: true }; });

  add('GET', '/api/eventsub/subscriptions', async () => {
    if (app.auth.state.status !== 'ok') throw new HttpError(400, 'Сначала войдите в Twitch');
    const subs = await app.helix.getEventSubSubscriptions();
    return {
      currentSession: app.eventsub.status.sessionId,
      subscriptions: subs.map((s) => ({ type: s.type, version: s.version, status: s.status, method: s.transport.method, currentSession: s.transport.session_id === app.eventsub.status.sessionId, created_at: s.created_at })),
    };
  });
  add('POST', '/api/settings', async (_q, _r, _p, body) => {
    const { ok, error } = validateSettingsPatch((body ?? {}) as Record<string, unknown>);
    if (error) throw new HttpError(400, error);
    const before = app.db.getSettings();
    const after = app.db.updateSettings(ok);
    app.hub.pushView();
    let note = '';
    if (ok.clientId !== undefined && ok.clientId !== before.clientId) {
      await app.auth.logout().catch(() => {});
      await app.auth.init();
      note = 'Client ID сохранён. Теперь нажмите «Войти через Twitch».';
    }
    if (ok.allowManageRewards !== undefined && ok.allowManageRewards !== before.allowManageRewards && app.auth.state.status === 'ok') note = 'Права изменены — войдите в Twitch заново, чтобы применить.';
    if (ok.port !== undefined && ok.port !== before.port) note = 'Новый порт начнёт работать после перезапуска бота. Не забудьте изменить адрес в Browser Source (OBS или Streamlabs).';
    if (ok.mode !== undefined) app.journal('info', 'settings', after.mode === 'observe' ? 'Включён режим наблюдения: оповещения не воспроизводятся' : 'Включён активный режим: оповещения воспроизводятся');
    if (ok.klipyApiKey !== undefined || ok.freesoundApiKey !== undefined) {
      app.finder.registerKeys();
      const which = [ok.klipyApiKey !== undefined ? 'Klipy' : '', ok.freesoundApiKey !== undefined ? 'Freesound' : ''].filter(Boolean).join(' и ');
      note = (ok.klipyApiKey || ok.freesoundApiKey) ? `Ключ ${which} сохранён.` : `Ключ ${which} удалён.`;
      app.journal('info', 'settings', note); // сам ключ в журнал не пишется
    }
    app.pushStatus();
    return { settings: publicSettings(after), note, find: app.finder.status() };
  });

  add('POST', '/api/rewards/sync', async () => {
    if (app.auth.state.status !== 'ok') throw new HttpError(400, 'Сначала войдите в Twitch');
    return app.syncRewards();
  });
  add('POST', '/api/rewards/create', async (_q, _r, _p, body) => {
    const b = (body ?? {}) as { confirm?: boolean; title?: string; cost?: number; cooldownSec?: number; prompt?: string; paused?: boolean };
    if (b.confirm !== true) throw new HttpError(400, 'Требуется подтверждение');
    try { return await app.createReward({ title: String(b.title ?? ''), cost: Number(b.cost), cooldownSec: b.cooldownSec, prompt: b.prompt, paused: b.paused }); }
    catch (e) { if (e instanceof HelixError) throw e; throw new HttpError(400, (e as Error).message); }
  });
  add('POST', '/api/rewards/local', (_q, _r, _p, body) => {
    const b = (body ?? {}) as { title?: string };
    const title = String(b.title ?? '').trim().slice(0, 45) || 'Тестовая награда';
    const id = `local-${Date.now().toString(36)}`;
    app.db.insertLocalReward(id, title, 0);
    return { id };
  });
  add('POST', '/api/rewards/:id', (_q, _r, p, body) => {
    const r = app.db.getReward(p.id);
    if (!r) throw new HttpError(404, 'Награда не найдена');
    const b = (body ?? {}) as Record<string, unknown>;
    const cfg: Record<string, number | string | null> = {};
    const int = (k: string, min: number, max: number) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `Неверное значение ${k}: допустимо от ${min} до ${max}`);
      cfg[k] = Math.round(v);
    };
    int('volume', 0, 100); int('duration_ms', 0, 600000); int('delay_ms', 0, 60000); int('cooldown_sec', 0, 86400);
    for (const k of ['bot_enabled', 'show_caption', 'chroma_key']) if (b[k] !== undefined) cfg[k] = b[k] ? 1 : 0;
    if (b.play_mode !== undefined) {
      if (b.play_mode !== 'video' && b.play_mode !== 'audio') throw new HttpError(400, 'Неверный режим воспроизведения');
      cfg.play_mode = b.play_mode;
    }
    for (const k of ['media_id', 'sound_id', 'video_id']) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { cfg[k] = null; continue; }
      const m = app.db.getMedia(String(b[k]));
      if (!m) throw new HttpError(400, 'Выбранный файл не найден');
      if (k === 'sound_id' && m.kind !== 'audio') throw new HttpError(400, 'Дополнительный звук должен быть аудиофайлом');
      if (k === 'video_id' && m.kind === 'audio') throw new HttpError(400, 'В поле «Видео» выберите видео, GIF или картинку');
      cfg[k] = m.id;
    }
    const updated = app.db.updateRewardConfig(p.id, cfg);
    if (cfg.bot_enabled === 1 && !r.bot_enabled && !r.manageable && !r.id.startsWith('local-') && app.db.getSettings().mode === 'active') {
      app.journal('warn', 'migration', `Награда «${r.title}» включена в боте. Если Sound Alerts всё ещё обрабатывает её — оповещение прозвучит дважды. Уберите источник Sound Alerts из OBS (или Streamlabs).`);
    }
    return updated;
  });
  add('POST', '/api/rewards/:id/test', (_q, _r, p) => {
    const r = app.router.test(p.id);
    if (!r.ok) throw new HttpError(400, r.error ?? 'Ошибка теста');
    return r;
  });
  add('POST', '/api/rewards/:id/simulate', (_q, _r, p, body) => {
    const r = app.db.getReward(p.id);
    if (!r) throw new HttpError(404, 'Награда не найдена');
    const user = String((body as { user?: string } | null)?.user ?? 'test_viewer').slice(0, 25);
    const id = `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = app.router.handleNotification({
      metadata: { message_id: id, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.channel_points_custom_reward_redemption.add', subscription_version: '1' },
      payload: { event: { id, broadcaster_user_id: app.auth.user?.id ?? '', user_id: '0', user_login: user, user_name: user, user_input: '', status: 'fulfilled', reward: { id: r.id, title: r.title, cost: r.cost, prompt: r.prompt }, redeemed_at: new Date().toISOString() } },
    });
    return { result };
  });
  add('POST', '/api/rewards/:id/clone', async (_q, _r, p, body) => {
    const b = (body ?? {}) as { confirm?: boolean; title?: string };
    if (b.confirm !== true) throw new HttpError(400, 'Требуется подтверждение');
    return app.cloneReward(p.id, b.title);
  });
  add('GET', '/api/rewards/:id/redemptions', async (req, _r, p) => {
    const user = app.auth.user;
    if (app.auth.state.status !== 'ok' || !user) throw new HttpError(400, 'Сначала войдите в Twitch');
    const status = new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 'UNFULFILLED';
    if (!['UNFULFILLED', 'FULFILLED', 'CANCELED'].includes(status)) throw new HttpError(400, 'Неверный статус');
    const list = await app.helix.getRedemptions(user.id, p.id, status as 'UNFULFILLED', 20);
    return { redemptions: list.map((r) => ({ id: r.id, user: r.user_name, status: r.status, redeemed_at: r.redeemed_at })) };
  });
  add('POST', '/api/rewards/:id/twitch', async (_q, _r, p, body) => {
    await app.updateOwnReward(p.id, (body ?? {}) as Record<string, never>);
    return { ok: true };
  });

  add('PUT', '/api/media', async (req) => {
    const nameHeader = String(req.headers['x-file-name'] ?? '');
    let name = '';
    try { name = decodeURIComponent(nameHeader); } catch { throw new HttpError(400, 'Неверное имя файла'); }
    const data = await readBody(req, MAX_UPLOAD_BYTES);
    try {
      const row = app.media.add(name, data);
      app.journal('info', 'media', `Добавлен файл «${row.name}»${row.status === 'warning' ? ` (предупреждение: ${row.status_msg})` : ''}`);
      return row;
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  }, true);
  add('POST', '/api/media/verify', () => app.media.verifyAll());
  add('POST', '/api/media/:id/delete', (_q, _r, p, body) => {
    const b = (body ?? {}) as { confirm?: boolean; force?: boolean };
    if (b.confirm !== true) throw new HttpError(400, 'Требуется подтверждение удаления');
    const m = app.db.getMedia(p.id);
    const r = app.media.remove(p.id, b.force === true);
    if (!r.ok) throw new HttpError(400, r.error ?? 'Не удалось удалить');
    if (b.force) app.db.raw.prepare('UPDATE rewards SET media_id = NULL WHERE media_id = ?').run(p.id), app.db.raw.prepare('UPDATE rewards SET sound_id = NULL WHERE sound_id = ?').run(p.id), app.db.raw.prepare('UPDATE rewards SET video_id = NULL WHERE video_id = ?').run(p.id);
    app.journal('info', 'media', `Удалён файл «${m?.name}»`);
    return r;
  });
  add('POST', '/api/media/:id/rename', (_q, _r, p, body) => {
    const name = String((body as { name?: string } | null)?.name ?? '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Пустое имя');
    app.db.renameMedia(p.id, name);
    return { ok: true };
  });
  add('POST', '/api/media/:id/test', (_q, _r, p) => {
    const m = app.db.getMedia(p.id);
    if (!m) throw new HttpError(404, 'Файл не найден');
    const r = app.router.testMedia(m);
    if (!r.ok) throw new HttpError(400, r.error ?? 'Ошибка');
    return r;
  });

  // ---------------- Обновления ----------------
  add('GET', '/api/update', () => app.updater.status());
  add('POST', '/api/update/check', () => app.updater.check());
  add('POST', '/api/update/seen', () => { app.updater.markSeen(); return { ok: true }; });
  add('POST', '/api/update/install', (_q, _r, _p, body) => {
    if ((body as { confirm?: boolean } | null)?.confirm !== true) throw new HttpError(400, 'Требуется подтверждение');
    const st = app.updater.status();
    if (!st.canInstall) throw new HttpError(400, st.reason || (st.available ? 'Обновление уже устанавливается' : 'Новой версии нет'));
    // Установка идёт в фоне; ход и ошибки приходят в панель через WebSocket.
    app.updater.install().catch(() => {});
    return { started: true };
  });

  // ---------------- Найти медиа ----------------
  const findErr = (e: unknown): never => {
    if (e instanceof FindError) throw new HttpError(e.status, e.message);
    throw e;
  };
  const klipyType = (v: unknown): KlipyType => {
    const t = String(v ?? 'clips') as KlipyType;
    if (!KLIPY_TYPES.includes(t)) throw new HttpError(400, 'Неизвестный раздел Klipy');
    return t;
  };
  add('GET', '/api/find/klipy', async (req) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    return app.finder.searchKlipy(klipyType(q.get('type')), q.get('q') ?? '', Number(q.get('page') ?? 1)).catch(findErr);
  });
  add('POST', '/api/find/klipy/add', async (_q, _r, _p, body) => {
    const b = (body ?? {}) as { type?: string; slug?: string };
    const row = await app.finder.addKlipy(klipyType(b.type), String(b.slug ?? '')).catch(findErr);
    app.hub.broadcastPanel({ type: 'invalidate', what: 'media' });
    return row;
  });
  add('GET', '/api/find/freesound', async (req) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    return app.finder.searchFreesound(q.get('q') ?? '', Number(q.get('page') ?? 1), q.get('commercial') !== '0').catch(findErr);
  });
  add('POST', '/api/find/freesound/add', async (_q, _r, _p, body) => {
    const row = await app.finder.addFreesound(Number((body as { id?: unknown } | null)?.id)).catch(findErr);
    app.hub.broadcastPanel({ type: 'invalidate', what: 'media' });
    return row;
  });
  add('POST', '/api/find/url', async (_q, _r, _p, body) => {
    const row = await app.finder.importUrl(String((body as { url?: unknown } | null)?.url ?? '')).catch(findErr);
    app.hub.broadcastPanel({ type: 'invalidate', what: 'media' });
    return row;
  });
  /** Предпросмотр онлайн-медиа из медиатеки: свежий адрес файла на сервере Klipy. */
  add('GET', '/api/media/:id/online', async (_q, _r, p) => {
    const m = app.db.getMedia(p.id);
    if (!m || m.source !== 'klipy') throw new HttpError(404, 'Онлайн-медиа не найдено');
    return app.finder.resolveRemote(m.remote_ref, 10_000).catch(findErr);
  });

  add('POST', '/api/test', () => {
    const r = app.router.testBuiltin();
    if (!r.ok) throw new HttpError(400, r.error ?? 'Ошибка теста');
    return r;
  });
  add('POST', '/api/queue/skip', () => ({ skipped: app.queue.skip() }));
  add('POST', '/api/queue/clear', () => ({ cleared: app.queue.clear() }));
  add('POST', '/api/queue/pause', () => { app.queue.setPaused(true); return { ok: true }; });
  add('POST', '/api/queue/resume', () => { app.queue.setPaused(false); return { ok: true }; });
  add('POST', '/api/queue/remove/:id', (_q, _r, p) => ({ removed: app.queue.remove(p.id) }));

  add('POST', '/api/autostart', async (_q, _r, _p, body) => {
    const enabled = Boolean((body as { enabled?: boolean } | null)?.enabled);
    try { await setAutostart(enabled); } catch (e) { throw new HttpError(400, (e as Error).message); }
    return { autostart: await getAutostart() };
  });
  add('POST', '/api/obs/backup', () => {
    try { return { dir: app.backupScenes() }; } catch (e) { throw new HttpError(400, (e as Error).message); }
  });
  add('POST', '/api/obs/launch', () => launchObs(app));
  add('POST', '/api/open-folder', (_q, _r, _p, body) => {
    const which = String((body as { which?: string } | null)?.which ?? '');
    const dirs: Record<string, string> = { logs: app.opts.paths.logDir, media: app.opts.paths.mediaDir, backups: app.opts.paths.backupDir, data: app.opts.paths.dataDir };
    const dir = dirs[which];
    if (!dir) throw new HttpError(400, 'Неизвестная папка');
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  });
  add('GET', '/api/logs', () => {
    const file = path.join(app.opts.paths.logDir, `bot-${new Date().toISOString().slice(0, 10)}.log`);
    if (!fs.existsSync(file)) return { lines: [] };
    const text = fs.readFileSync(file, 'utf8');
    return { lines: text.split('\n').filter(Boolean).slice(-300) };
  });
  add('POST', '/api/shutdown', () => { setTimeout(() => hooks.onShutdown(), 100); return { ok: true }; });

  // ---------------- Сервер ----------------
  const server = http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res, app.port);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!checkHost(req, app.port)) throw new HttpError(403, 'Доступ запрещён: неверный заголовок Host');
      const method = req.method ?? 'GET';

      if (url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') checkCsrf(req, app.port);
        const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
        if (!route) throw new HttpError(404, 'Нет такого метода API');
        const m = url.pathname.match(route.pattern)!;
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        let body: unknown = null;
        if (!route.raw && method !== 'GET') {
          const raw = await readBody(req, 1024 * 1024);
          if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Неверный JSON'); } }
        }
        const result = await route.handler(req, res, params, body);
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
      if (url.pathname === '/' ) { res.writeHead(302, { Location: '/panel/' }); res.end(); return; }
      if (url.pathname === '/overlay' || url.pathname === '/overlay/') return serveStatic(res, path.join(PUBLIC_DIR, 'overlay'), 'index.html', req);
      if (url.pathname.startsWith('/overlay/')) return serveStatic(res, path.join(PUBLIC_DIR, 'overlay'), url.pathname.slice('/overlay/'.length), req);
      if (url.pathname === '/panel') { res.writeHead(302, { Location: '/panel/' }); res.end(); return; }
      if (url.pathname.startsWith('/panel/')) return serveStatic(res, path.join(PUBLIC_DIR, 'panel'), url.pathname.slice('/panel/'.length) || 'index.html', req);
      if (url.pathname.startsWith('/media/')) return serveMedia(app, req, res, url.pathname.slice('/media/'.length));
      if (url.pathname === '/favicon.ico') return serveStatic(res, path.join(PUBLIC_DIR, 'panel'), 'icon.svg', req);
      throw new HttpError(404, 'Страница не найдена');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof HelixError ? 502 : 500;
      const message = (e as Error).message || 'Внутренняя ошибка';
      if (status >= 500) app.log.error(`HTTP ${req.method} ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!checkHost(req, app.port)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    app.hub.handleUpgrade(req, socket, head);
  });
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 10 * 60_000; // загрузка больших файлов
  return server;
}

function checkHost(req: IncomingMessage, port: number): boolean {
  const host = String(req.headers.host ?? '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Защита от CSRF: изменяющие запросы только со своей страницы и со специальным заголовком. */
function checkCsrf(req: IncomingMessage, port: number): void {
  if (req.headers['x-tab-request'] !== '1') throw new HttpError(403, 'Запрос отклонён (защита от подделки запросов)');
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, 'Запрос с чужого сайта отклонён');
}

function setSecurityHeaders(res: ServerResponse, port: number): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob: https://static-cdn.jtvnw.net https://*.klipy.com https://cdn.freesound.org",
    // Онлайн-мемы Klipy по правилам сервиса загружаются напрямую с его серверов; превью звуков — с Freesound.
    "media-src 'self' blob: https://*.klipy.com https://cdn.freesound.org", `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "form-action 'none'",
  ].join('; '));
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) { reject(new HttpError(413, `Слишком большой файл (максимум ${Math.round(limit / 1024 / 1024)} МБ)`)); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Слишком большой файл (максимум ${Math.round(limit / 1024 / 1024)} МБ)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Безопасная выдача статических файлов: только внутри root, без «..», без скрытых файлов. */
export function resolveSafe(root: string, rel: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, decoded);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return full;
}

function serveStatic(res: ServerResponse, root: string, rel: string, req: IncomingMessage): void {
  const full = resolveSafe(root, rel);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Файл не найден');
  const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(full).pipe(res);
}

/** Выдача медиа по ID из базы (имя файла задаёт бот), с поддержкой Range для видео. */
function serveMedia(app: App, req: IncomingMessage, res: ServerResponse, idRaw: string): void {
  const id = decodeURIComponent(idRaw);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Файл не найден');
  const row = app.db.getMedia(id);
  if (!row) throw new HttpError(404, 'Файл не найден');
  const file = app.media.filePath(row);
  if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Файл отсутствует на диске');
  const size = fs.statSync(file).size;
  const headers: Record<string, string | number> = { 'Content-Type': row.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
    if (!m[1] && !m[2]) { start = 0; end = size - 1; }
    if (start < 0 || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/** Запуск выбранной программы для стрима (OBS Studio или Streamlabs Desktop), если она ещё не запущена. */
function launchObs(app: App): Promise<{ ok: boolean; already?: boolean; app: string }> {
  const s = app.db.getSettings();
  const info = STREAM_APPS[s.streamApp];
  return new Promise((resolve, reject) => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${info.processName}`, '/NH'], { windowsHide: true }, (_e, out) => {
      if (String(out).toLowerCase().includes(info.processName.toLowerCase())) return resolve({ ok: true, already: true, app: info.name });
      const exe = resolveExe(s);
      if (!exe) {
        return reject(new HttpError(400, s.streamApp === 'streamlabs'
          ? 'Streamlabs Desktop не найден. Укажите путь к «Streamlabs OBS.exe» в «Настройки → Программа для стрима».'
          : 'OBS не найден по указанному пути. Проверьте путь в «Настройки → Программа для стрима».'));
      }
      try {
        spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
        resolve({ ok: true, app: info.name });
      } catch (e) { reject(new HttpError(500, `Не удалось запустить ${info.name}: ${(e as Error).message}`)); }
    });
  });
}

