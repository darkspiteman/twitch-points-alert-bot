import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

/**
 * Безопасное скачивание файлов из интернета (защита от SSRF):
 * только https, только порт 443, без логина/пароля в ссылке,
 * запрет адресов этого компьютера и локальной сети (проверяется и для IP в ссылке,
 * и для каждого адреса, в который разрешается имя — в момент соединения, что исключает DNS rebinding),
 * повторная проверка при каждом перенаправлении, ограничение размера и времени.
 */

export class DownloadError extends Error {
  readonly code: 'bad_url' | 'blocked' | 'http' | 'too_big' | 'timeout' | 'network' | 'redirects';
  readonly status?: number;
  constructor(code: DownloadError['code'], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(a, p, 'ipv6');

/** true — адрес принадлежит этому компьютеру, локальной сети или служебным диапазонам. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // не IP — на всякий случай считаем запрещённым
  const lower = ip.toLowerCase();
  // IPv4, упакованный в IPv6 (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::7f00:1).
  const mapped = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(ip, 'ipv6');
}

/** Проверка ссылки до соединения. Бросает DownloadError с понятным текстом. */
export function checkUrl(raw: string, allowHost?: (host: string) => boolean): URL {
  if (raw.length > 2048) throw new DownloadError('bad_url', 'Ссылка слишком длинная');
  let u: URL;
  try { u = new URL(raw); } catch { throw new DownloadError('bad_url', 'Это не похоже на ссылку. Скопируйте адрес целиком, начиная с https://'); }
  if (u.protocol !== 'https:') throw new DownloadError('bad_url', 'Поддерживаются только ссылки https://');
  if (u.username || u.password) throw new DownloadError('bad_url', 'Ссылки с логином и паролем не поддерживаются');
  if (u.port && u.port !== '443') throw new DownloadError('blocked', 'Ссылки с нестандартным портом не поддерживаются');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    throw new DownloadError('blocked', 'Скачивание с этого компьютера и из локальной сети запрещено');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new DownloadError('blocked', 'Скачивание с этого компьютера и из локальной сети запрещено');
  } else if (!host.includes('.')) {
    throw new DownloadError('blocked', 'Адрес сайта указан неверно');
  }
  if (allowHost && !allowHost(host)) throw new DownloadError('blocked', `Скачивание с сайта ${host} здесь не разрешено`);
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS-поиск, отклоняющий внутренние адреса. Вызывается сокетом при соединении. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb, resolver: typeof dns.lookup = dns.lookup): void {
  resolver(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length) return cb(Object.assign(new Error('Адрес не найден'), { code: 'ENOTFOUND' }), '', 0);
    if (list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error('blocked-private-address'), { code: 'EBLOCKED' }), '', 0);
    }
    if (options.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

export interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Readable }
/** Транспорт одного запроса (без перенаправлений). Подменяется в тестах. */
export type Transport = (url: URL, signal: AbortSignal) => Promise<RawResponse>;

export const httpsTransport: Transport = (url, signal) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    method: 'GET', signal, lookup: guardedLookup as unknown as typeof dns.lookup,
    headers: { 'User-Agent': 'TwitchAlertBot/1.0 (local media importer)', Accept: '*/*' },
  }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
  req.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EBLOCKED' || /blocked-private-address/.test(e.message)) reject(new DownloadError('blocked', 'Ссылка ведёт на этот компьютер или в локальную сеть — скачивание запрещено'));
    else reject(e);
  });
  req.end();
});

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Разрешённые сайты (для источников с известным CDN). */
  allowHost?: (host: string) => boolean;
  transport?: Transport;
}

export interface Downloaded { data: Buffer; finalUrl: URL; contentType: string; fileName: string }

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;

export async function safeDownload(rawUrl: string, opts: DownloadOptions): Promise<Downloaded> {
  const transport = opts.transport ?? httpsTransport;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60_000);
  try {
    let url = checkUrl(rawUrl, opts.allowHost);
    for (let hop = 0; ; hop++) {
      let res: RawResponse;
      try {
        res = await transport(url, ac.signal);
      } catch (e) {
        if (e instanceof DownloadError) throw e;
        if (ac.signal.aborted) throw new DownloadError('timeout', 'Сайт отвечает слишком долго — попробуйте позже');
        throw new DownloadError('network', 'Не удалось подключиться к сайту. Проверьте интернет и ссылку.');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.body.resume();
        const loc = res.headers.location;
        if (!loc) throw new DownloadError('http', 'Сайт вернул перенаправление без адреса');
        if (hop >= (opts.maxRedirects ?? 5)) throw new DownloadError('redirects', 'Слишком много перенаправлений');
        url = checkUrl(new URL(loc, url).href, opts.allowHost);
        continue;
      }
      if (res.status !== 200) {
        res.body.resume();
        const text = res.status === 404 ? 'файл не найден (404)' : res.status === 403 || res.status === 401 ? 'доступ к файлу закрыт' : `ошибка ${res.status}`;
        throw new DownloadError('http', `Сайт не отдал файл: ${text}`, res.status);
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > opts.maxBytes) { res.body.destroy(); throw new DownloadError('too_big', `Файл слишком большой (${mb(declared)}, максимум ${mb(opts.maxBytes)})`); }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += b.length;
          if (size > opts.maxBytes) { res.body.destroy(); throw new DownloadError('too_big', `Файл слишком большой (максимум ${mb(opts.maxBytes)})`); }
          chunks.push(b);
        }
      } catch (e) {
        if (e instanceof DownloadError) throw e;
        if (ac.signal.aborted) throw new DownloadError('timeout', 'Скачивание заняло слишком много времени');
        throw new DownloadError('network', 'Связь оборвалась во время скачивания');
      }
      return { data: Buffer.concat(chunks), finalUrl: url, contentType: String(res.headers['content-type'] ?? ''), fileName: fileNameFrom(url, res.headers) };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Имя файла из Content-Disposition или из последней части адреса. */
export function fileNameFrom(url: URL, headers: IncomingHttpHeaders): string {
  const cd = String(headers['content-disposition'] ?? '');
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain) return plain[1].trim();
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try { return decodeURIComponent(last) || url.hostname; } catch { return last || url.hostname; }
}
