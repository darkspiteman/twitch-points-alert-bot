import crypto from 'node:crypto';
import type { Db, MediaRow } from './db.ts';
import type { MediaLibrary } from './media.ts';
import { MAX_UPLOAD_BYTES } from './media.ts';
import type { ScopedLogger } from './logger.ts';
import { registerSecret } from './logger.ts';
import type { FetchFn } from './twitch/auth.ts';
import type { MediaRef, PlayItem } from './queue.ts';
import { safeDownload, DownloadError, type Transport } from './net/safe-download.ts';

/**
 * «Найти медиа»: поиск в Klipy (мемы, клипы, GIF, стикеры) и Freesound (звуки), импорт по ссылке.
 *
 * Правила сервисов (проверено 14.11.2026):
 * - Klipy запрещает хранить копии своих файлов и раздавать их через свой сервер, поэтому медиа Klipy
 *   НЕ скачиваются: в базе хранится только «тип/slug», а адрес файла запрашивается у Klipy в момент показа,
 *   и OBS загружает файл напрямую с серверов Klipy. Порядок выдачи не меняется, поле поиска — «Search KLIPY».
 * - Freesound разрешает скачивать MP3-превью (без OAuth); у каждого звука сохраняется автор и лицензия.
 */

export type KlipyType = 'clips' | 'gifs' | 'stickers';
export const KLIPY_TYPES: KlipyType[] = ['clips', 'gifs', 'stickers'];

export class FindError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface KlipyResult {
  slug: string;
  title: string;
  type: KlipyType;
  /** Картинка-превью для сетки (загружается панелью напрямую с CDN Klipy). */
  thumb: string;
  /** Что будет показано на стриме. */
  play: { url: string; kind: 'video' | 'image'; mime: string; width: number; height: number };
  pageUrl: string;
}

export interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  license: string;
  licenseLabel: string;
  commercialOk: boolean;
  durationSec: number;
  previewUrl: string;
  pageUrl: string;
}

export interface FinderDeps {
  db: Db;
  media: MediaLibrary;
  log: ScopedLogger;
  journal: (level: 'info' | 'warn' | 'error', type: string, message: string) => void;
  fetchFn?: FetchFn;
  transport?: Transport;
  klipyBase?: string;
  freesoundBase?: string;
}

const isKlipyHost = (h: string) => h === 'klipy.com' || h.endsWith('.klipy.com');
const isFreesoundHost = (h: string) => h === 'freesound.org' || h.endsWith('.freesound.org');
/** Сервисы, чьи правила запрещают сохранять файлы. */
const NO_COPY_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)klipy\.com$/, 'Klipy'], [/(^|\.)giphy\.com$/, 'GIPHY'], [/(^|\.)tenor\.com$/, 'Tenor'], [/(^|\.)memealerts\.com$/, 'MemeAlerts'],
];

function httpsUrl(v: unknown, hostOk: (h: string) => boolean): string {
  if (typeof v !== 'string') return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && hostOk(u.hostname.toLowerCase()) ? u.href : '';
  } catch { return ''; }
}

const mimeOf = (url: string): string => {
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
  return ({ mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' } as Record<string, string>)[ext] ?? 'application/octet-stream';
};

export function freesoundLicense(raw: string): { label: string; commercialOk: boolean } {
  const s = (raw || '').toLowerCase();
  if (s.includes('publicdomain/zero') || s.includes('creative commons 0') || s === 'cc0') return { label: 'CC0 (без ограничений)', commercialOk: true };
  if (s.includes('by-nc') || s.includes('noncommercial') || s.includes('sampling+')) return { label: 'CC BY-NC (только некоммерческое, указать автора)', commercialOk: false };
  if (s.includes('/by/') || s === 'attribution') return { label: 'CC BY (указать автора)', commercialOk: true };
  return { label: raw || 'лицензия не указана', commercialOk: false };
}

export class MediaFinder {
  private d: FinderDeps;
  private fetchFn: FetchFn;
  private klipyBase: string;
  private freesoundBase: string;

  constructor(deps: FinderDeps) {
    this.d = deps;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.klipyBase = deps.klipyBase ?? 'https://api.klipy.com';
    this.freesoundBase = deps.freesoundBase ?? 'https://freesound.org/apiv2';
    this.registerKeys();
  }

  /** Ключи — секреты: логгер заменяет их на *** где бы они ни встретились. */
  registerKeys(): void {
    const s = this.d.db.getSettings();
    registerSecret(s.klipyApiKey);
    registerSecret(s.freesoundApiKey);
  }

  status(): { klipy: boolean; freesound: boolean } {
    const s = this.d.db.getSettings();
    return { klipy: !!s.klipyApiKey, freesound: !!s.freesoundApiKey };
  }

  // ---------------- Klipy ----------------
  private customerId(): string {
    let id = this.d.db.getMeta('klipy_customer_id');
    if (!id) { id = crypto.randomUUID(); this.d.db.setMeta('klipy_customer_id', id); }
    return id;
  }

  private async klipyGet(path: string, params: Record<string, string>, timeoutMs = 10_000): Promise<Record<string, unknown>[]> {
    const key = this.d.db.getSettings().klipyApiKey;
    if (!key) throw new FindError('Сначала вставьте ключ Klipy: «Настройки» → «Ключи сервисов».');
    const url = new URL(`${this.klipyBase}/api/v1/${encodeURIComponent(key)}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    } catch {
      throw new FindError('Нет связи с Klipy. Проверьте интернет и попробуйте ещё раз.', 502);
    }
    let errText = '';
    if (!res.ok) { try { errText = JSON.stringify(await res.json()); } catch { /* не JSON */ } }
    // Неверный ключ Klipy возвращает 404 с текстом «The provided API key is invalid».
    if (res.status === 401 || res.status === 403 || /api key/i.test(errText)) throw new FindError('Klipy не принял ключ. Проверьте ключ в «Настройки» → «Ключи сервисов».', 400);
    if (res.status === 429) throw new FindError('Превышен лимит запросов Klipy (тестовый ключ — 100 в час). Подождите немного или запросите production-доступ в Partner Panel Klipy.', 429);
    if (!res.ok) throw new FindError(`Сервис Klipy временно недоступен (ошибка ${res.status}). Попробуйте позже.`, 502);
    let body: { result?: boolean; data?: { data?: unknown[] } | unknown[] };
    try { body = await res.json() as typeof body; } catch { throw new FindError('Klipy вернул непонятный ответ', 502); }
    const list = Array.isArray(body.data) ? body.data : body.data?.data;
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  }

  /** Нормализация элемента выдачи Klipy. Возвращает null для рекламы и элементов без файлов. */
  static normalizeKlipy(type: KlipyType, it: Record<string, unknown>): KlipyResult | null {
    const slug = typeof it.slug === 'string' ? it.slug : '';
    if (!slug || !/^[a-z0-9][a-z0-9_-]{0,200}$/i.test(slug)) return null;
    const title = (typeof it.title === 'string' && it.title.trim()) || slug;
    const file = (it.file ?? {}) as Record<string, unknown>;
    const pageUrl = httpsUrl(it.url, isKlipyHost) || `https://klipy.com/${type}/${slug}`;
    if (type === 'clips') {
      const mp4 = httpsUrl(file.mp4, isKlipyHost);
      const thumb = httpsUrl(file.webp, isKlipyHost) || httpsUrl(file.gif, isKlipyHost);
      if (!mp4) return null;
      const meta = ((it.file_meta ?? {}) as Record<string, { width?: number; height?: number }>).mp4 ?? {};
      return { slug, title, type, thumb: thumb || mp4, pageUrl, play: { url: mp4, kind: 'video', mime: 'video/mp4', width: Number(meta.width) || 0, height: Number(meta.height) || 0 } };
    }
    const size = (k: string) => (file[k] ?? {}) as Record<string, { url?: string; width?: number; height?: number }>;
    const pick = (k: string, fmts: string[]) => {
      for (const f of fmts) { const u = httpsUrl(size(k)[f]?.url, isKlipyHost); if (u) return { url: u, w: Number(size(k)[f]?.width) || 0, h: Number(size(k)[f]?.height) || 0 }; }
      return null;
    };
    const play = pick('md', ['webp', 'gif']) ?? pick('hd', ['webp', 'gif']) ?? pick('sm', ['webp', 'gif']);
    const thumb = pick('sm', ['webp', 'gif', 'jpg']) ?? play;
    if (!play || !thumb) return null;
    return { slug, title, type, thumb: thumb.url, pageUrl, play: { url: play.url, kind: 'image', mime: mimeOf(play.url), width: play.w, height: play.h } };
  }

  async searchKlipy(type: KlipyType, q: string, page = 1): Promise<{ results: KlipyResult[]; hasNext: boolean }> {
    if (!KLIPY_TYPES.includes(type)) throw new FindError('Неизвестный раздел Klipy');
    const query = q.trim().slice(0, 100);
    const s = this.d.db.getSettings();
    const params = { page: String(Math.max(1, Math.min(100, Math.floor(page) || 1))), per_page: '24', customer_id: this.customerId(), locale: 'ru', content_filter: s.klipyContentFilter };
    const list = query
      ? await this.klipyGet(`${type}/search`, { ...params, q: query })
      : await this.klipyGet(`${type}/trending`, params);
    // Порядок выдачи сохраняется (требование Klipy); пропускаются только элементы без файлов (например, реклама).
    const results = list.map((it) => MediaFinder.normalizeKlipy(type, it)).filter((x): x is KlipyResult => !!x);
    return { results, hasNext: list.length >= 24 };
  }

  /** Актуальная информация об элементе Klipy по slug. */
  async klipyItem(type: KlipyType, slug: string, timeoutMs = 10_000): Promise<KlipyResult> {
    const list = await this.klipyGet(`${type}/items`, { slugs: slug }, timeoutMs);
    const items = list.map((it) => MediaFinder.normalizeKlipy(type, it)).filter((r): r is KlipyResult => !!r);
    // Поиск выдаёт slug с суффиксом («bruh--xY12abCd3»), а Items API возвращает основной slug («bruh»).
    // Сохраняем slug из выдачи как есть (Klipy просит не менять идентификаторы), а ответ сопоставляем по основе.
    const base = slug.split('--')[0];
    const found = items.find((r) => r.slug === slug) ?? items.find((r) => r.slug === base) ?? (items.length === 1 ? items[0] : undefined);
    if (!found) throw new FindError('Этот мем больше недоступен в Klipy (удалён или скрыт)', 404);
    return found;
  }

  /** Добавление мема Klipy в медиатеку как онлайн-медиа (без копии на диске). */
  async addKlipy(type: KlipyType, slug: string): Promise<MediaRow> {
    if (!KLIPY_TYPES.includes(type)) throw new FindError('Неизвестный раздел Klipy');
    if (!/^[a-z0-9][a-z0-9_-]{0,200}$/i.test(slug)) throw new FindError('Неверный идентификатор мема');
    const item = await this.klipyItem(type, slug);
    const existing = this.d.db.listMedia().find((m) => m.source === 'klipy' && m.remote_ref === `${type}/${slug}`);
    if (existing) return existing;
    const row = this.d.media.addRemote({
      name: item.title, kind: item.play.kind, mime: item.play.mime, remoteRef: `${type}/${slug}`,
      attribution: 'KLIPY', sourceUrl: item.pageUrl, source: 'klipy',
    });
    this.d.journal('info', 'media', `Добавлен онлайн-мем Klipy «${row.name}» (файл не скачивается, показывается с сервера Klipy)`);
    return row;
  }

  /** Адрес файла для показа прямо сейчас. */
  async resolveRemote(ref: string, timeoutMs = 5000): Promise<{ url: string; kind: 'video' | 'image'; mime: string }> {
    const [type, slug] = ref.split('/') as [KlipyType, string];
    if (!KLIPY_TYPES.includes(type) || !slug) throw new FindError('Неверная ссылка на онлайн-медиа');
    const item = await this.klipyItem(type, slug, timeoutMs);
    return { url: item.play.url, kind: item.play.kind, mime: item.play.mime };
  }

  /**
   * Подготовка элемента очереди перед показом: подставляет свежие адреса онлайн-медиа.
   * Если Klipy недоступен — играет запасной звук награды; без запасного звука — ошибка.
   */
  async prepare(item: PlayItem): Promise<PlayItem> {
    const remote = (r: MediaRef | null) => !!r?.remote;
    if (!remote(item.visual) && !remote(item.audio)) return item;
    const out: PlayItem = { ...item };
    try {
      for (const key of ['visual', 'audio'] as const) {
        const ref = out[key];
        if (!ref?.remote) continue;
        const r = await this.resolveRemote(ref.remote);
        out[key] = { ...ref, url: r.url, mime: r.mime };
      }
      return out;
    } catch (e) {
      const why = (e as Error).message;
      const fb = item.fallbackAudio;
      if (fb && !fb.remote) {
        this.d.journal('warn', 'online', `«${item.rewardTitle}»: Klipy недоступен (${why}) — сыграл запасной звук`);
        return { ...item, visual: null, audio: fb, fallbackAudio: null, durationMs: 0, chromaKey: false };
      }
      throw new Error(`онлайн-медиа недоступно: ${why}. Назначьте награде «Звук (основной файл)» — он сыграет при сбое Klipy.`);
    }
  }

  // ---------------- Freesound ----------------
  private async freesoundGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const key = this.d.db.getSettings().freesoundApiKey;
    if (!key) throw new FindError('Сначала вставьте ключ Freesound: «Настройки» → «Ключи сервисов».');
    const url = new URL(`${this.freesoundBase}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    let res: Response;
    try {
      // Ключ передаётся заголовком, а не в адресе — так он не попадает в адресные логи.
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', Authorization: `Token ${key}` } });
    } catch {
      throw new FindError('Нет связи с Freesound. Проверьте интернет и попробуйте ещё раз.', 502);
    }
    if (res.status === 401 || res.status === 403) throw new FindError('Freesound не принял ключ. Проверьте ключ в «Настройки» → «Ключи сервисов».', 400);
    if (res.status === 404) throw new FindError('Звук не найден на Freesound', 404);
    if (res.status === 429) throw new FindError('Превышен лимит запросов Freesound (60 в минуту, 2000 в день). Подождите немного.', 429);
    if (!res.ok) throw new FindError(`Сервис Freesound временно недоступен (ошибка ${res.status}). Попробуйте позже.`, 502);
    try { return await res.json() as Record<string, unknown>; } catch { throw new FindError('Freesound вернул непонятный ответ', 502); }
  }

  static normalizeFreesound(it: Record<string, unknown>): FreesoundResult | null {
    const id = Number(it.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const previews = (it.previews ?? {}) as Record<string, unknown>;
    const previewUrl = httpsUrl(previews['preview-hq-mp3'], isFreesoundHost) || httpsUrl(previews['preview-lq-mp3'], isFreesoundHost);
    if (!previewUrl) return null;
    const lic = freesoundLicense(String(it.license ?? ''));
    return {
      id, name: String(it.name ?? `sound ${id}`).slice(0, 200), username: String(it.username ?? '').slice(0, 100),
      license: String(it.license ?? ''), licenseLabel: lic.label, commercialOk: lic.commercialOk,
      durationSec: Number(it.duration) || 0, previewUrl, pageUrl: httpsUrl(it.url, isFreesoundHost) || `https://freesound.org/s/${id}/`,
    };
  }

  async searchFreesound(q: string, page = 1, commercialOnly = true): Promise<{ results: FreesoundResult[]; hasNext: boolean; total: number }> {
    const query = q.trim().slice(0, 100);
    if (!query) throw new FindError('Введите, что искать (например: «applause», «fail», «laugh»)');
    const filters = ['duration:[0 TO 60]'];
    if (commercialOnly) filters.push('license:("Attribution" OR "Creative Commons 0")');
    const params = {
      query, page: String(Math.max(1, Math.min(100, Math.floor(page) || 1))), page_size: '20',
      fields: 'id,name,username,license,duration,previews,url', filter: filters.join(' '),
    };
    let body: Record<string, unknown>;
    try {
      body = await this.freesoundGet('search/', params);
    } catch (e) {
      // Старые версии API: /search/text/.
      if (!(e instanceof FindError) || e.status !== 404) throw e;
      body = await this.freesoundGet('search/text/', params);
    }
    const list = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
    return { results: list.map(MediaFinder.normalizeFreesound).filter((x): x is FreesoundResult => !!x), hasNext: !!body.next, total: Number(body.count) || 0 };
  }

  async addFreesound(id: number): Promise<MediaRow> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new FindError('Неверный идентификатор звука');
    const info = MediaFinder.normalizeFreesound(await this.freesoundGet(`sounds/${id}/`, { fields: 'id,name,username,license,duration,previews,url' }));
    if (!info) throw new FindError('У этого звука нет файла для скачивания');
    const dl = await this.download(info.previewUrl, { maxBytes: 30 * 1024 * 1024, allowHost: isFreesoundHost });
    const attribution = `«${info.name}» — ${info.username || 'автор неизвестен'}, Freesound, ${info.licenseLabel}`;
    const title = info.name.replace(/\.(wav|mp3|ogg|flac|aiff?|m4a|opus|wma)$/i, '').trim() || `sound ${info.id}`;
    const row = this.addFile(() => this.d.media.addDownloaded(`${title} (${info.username})`, dl, { source: 'freesound', attribution, source_url: info.pageUrl }));
    this.d.journal(info.commercialOk ? 'info' : 'warn', 'media', `Добавлен звук Freesound «${row.name}» (${info.licenseLabel})${info.commercialOk ? '' : ' — лицензия запрещает коммерческое использование'}`);
    return row;
  }

  // ---------------- По ссылке ----------------
  async importUrl(raw: string): Promise<MediaRow> {
    const url = String(raw ?? '').trim();
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* проверит safeDownload */ }
    for (const [re, name] of NO_COPY_HOSTS) {
      if (re.test(host)) throw new FindError(`Правила ${name} запрещают сохранять их файлы.${name === 'Klipy' ? ' Найдите этот мем во вкладке «Klipy» — он будет показываться онлайн.' : ''}`);
    }
    const res = await this.downloadFull(url, { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: 180_000 });
    const clean = `${res.finalUrl.origin}${res.finalUrl.pathname}`;
    const row = this.addFile(() => this.d.media.addDownloaded(res.fileName, res.data, { source: 'url', attribution: res.finalUrl.hostname, source_url: clean }));
    this.d.journal('info', 'media', `Добавлен файл по ссылке «${row.name}» (${res.finalUrl.hostname})`);
    return row;
  }

  private async downloadFull(url: string, opts: { maxBytes: number; allowHost?: (h: string) => boolean; timeoutMs?: number }) {
    try {
      return await safeDownload(url, { ...opts, transport: this.d.transport });
    } catch (e) {
      if (e instanceof DownloadError) throw new FindError(e.message, e.code === 'too_big' ? 413 : 400);
      throw e;
    }
  }

  private async download(url: string, opts: { maxBytes: number; allowHost?: (h: string) => boolean }): Promise<Buffer> {
    return (await this.downloadFull(url, opts)).data;
  }

  private addFile(fn: () => MediaRow): MediaRow {
    try { return fn(); } catch (e) { throw new FindError((e as Error).message); }
  }
}
