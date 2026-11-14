import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db, MediaRow } from './db.ts';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

interface FormatInfo { ext: string; mime: string; kind: MediaRow['kind'] }

const FORMATS: Record<string, FormatInfo> = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', kind: 'audio' },
  wav: { ext: 'wav', mime: 'audio/wav', kind: 'audio' },
  ogg: { ext: 'ogg', mime: 'audio/ogg', kind: 'audio' },
  webm: { ext: 'webm', mime: 'video/webm', kind: 'video' },
  mp4: { ext: 'mp4', mime: 'video/mp4', kind: 'video' },
  gif: { ext: 'gif', mime: 'image/gif', kind: 'image' },
  png: { ext: 'png', mime: 'image/png', kind: 'image' },
  jpg: { ext: 'jpg', mime: 'image/jpeg', kind: 'image' },
  webp: { ext: 'webp', mime: 'image/webp', kind: 'image' },
};

export const ALLOWED_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'webm', 'mp4', 'm4v', 'gif', 'png', 'jpg', 'jpeg', 'webp'];

/** Определение формата по сигнатуре (магическим байтам), а не по расширению. */
export function sniffFormat(buf: Buffer): FormatInfo | null {
  if (buf.length < 12) return null;
  const ascii = (s: number, e: number) => buf.subarray(s, e).toString('latin1');
  if (ascii(0, 3) === 'ID3') return FORMATS.mp3;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return FORMATS.mp3; // MPEG frame sync
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return FORMATS.wav;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return FORMATS.webp;
  if (ascii(0, 4) === 'OggS') {
    // Ogg может содержать видео (Theora) — считаем аудио, если есть Vorbis/Opus.
    const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1');
    if (head.includes('theora')) return { ext: 'ogg', mime: 'video/ogg', kind: 'video' };
    return FORMATS.ogg;
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    // EBML (WebM/Matroska). Если нет видеодорожки — это аудио WebM.
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    if (!head.includes('webm')) return null; // Matroska (.mkv) браузером не гарантируется
    const hasVideo = head.includes('V_VP8') || head.includes('V_VP9') || head.includes('V_AV1');
    return hasVideo || !head.includes('A_') ? FORMATS.webm : { ext: 'webm', mime: 'audio/webm', kind: 'audio' };
  }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('M4A')) return { ext: 'mp4', mime: 'audio/mp4', kind: 'audio' };
    return FORMATS.mp4;
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return FORMATS.gif;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return FORMATS.png;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return FORMATS.jpg;
  return null;
}

/** Дополнительные проверки совместимости с браузерным движком OBS (Chromium/CEF). */
export function compatibilityWarnings(buf: Buffer, fmt: FormatInfo): string[] {
  const warn: string[] = [];
  if (fmt.ext === 'mp4' || fmt.ext === 'm4a') {
    const s = buf.toString('latin1');
    if (s.includes('hvc1') || s.includes('hev1')) warn.push('Видео в кодеке H.265/HEVC может не воспроизводиться в OBS. Рекомендуется H.264 (MP4) или VP9 (WebM).');
    if (!s.includes('moov')) warn.push('Не найден индекс MP4 (moov) — файл может быть повреждён или не дозаписан.');
  }
  if (fmt.ext === 'webm' && fmt.kind === 'video') {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    if (!head.includes('V_VP8') && !head.includes('V_VP9') && !head.includes('V_AV1')) warn.push('Не удалось определить видеокодек WebM.');
  }
  return warn;
}

export function sanitizeDisplayName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

/** Дополнительные сведения о происхождении файла. */
export interface MediaOrigin { source?: MediaRow['source']; attribution?: string; source_url?: string }

export function isRemote(row: Pick<MediaRow, 'source'>): boolean { return row.source === 'klipy'; }

export class MediaLibrary {
  private db: Db;
  private dir: string;
  constructor(db: Db, dir: string) { this.db = db; this.dir = path.resolve(dir); }

  /** Сохранение загруженного файла с проверкой формата. Бросает Error с понятным сообщением. */
  add(originalName: string, data: Buffer, origin: MediaOrigin = {}): MediaRow {
    if (data.length === 0) throw new Error('Файл пустой');
    if (data.length > MAX_UPLOAD_BYTES) throw new Error(`Файл больше ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ`);
    const display = sanitizeDisplayName(originalName);
    const ext = path.extname(display).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) throw new Error(`Формат .${ext || '?'} не поддерживается. Допустимы: MP3, WAV, OGG, M4A, WebM, MP4, GIF, PNG, JPG, WebP`);
    let fmt = sniffFormat(data);
    // .m4a — контейнер MP4 только со звуком (AAC): воспроизводим как аудио, даже если бренд ftyp «isom».
    if (fmt && ext === 'm4a' && fmt.ext === 'mp4') fmt = { ext: 'm4a', mime: 'audio/mp4', kind: 'audio' };
    if (!fmt) throw new Error('Содержимое файла не распознано: файл повреждён или это не медиафайл');
    const warnings = compatibilityWarnings(data, fmt);
    const id = crypto.randomUUID();
    const fileName = `${id}.${fmt.ext}`;
    fs.writeFileSync(path.join(this.dir, fileName), data);
    const row: MediaRow = {
      id, name: display, file_name: fileName, kind: fmt.kind, mime: fmt.mime, size: data.length, duration_ms: 0,
      status: warnings.length ? 'warning' : 'ok', status_msg: warnings.join(' '), created_at: Date.now(),
      source: origin.source ?? 'upload', remote_ref: '', attribution: (origin.attribution ?? '').slice(0, 300), source_url: (origin.source_url ?? '').slice(0, 500),
    };
    this.db.insertMedia(row);
    return row;
  }

  /**
   * Сохранение скачанного файла, у которого может не быть расширения в имени (ссылка, Freesound):
   * расширение определяется по содержимому.
   */
  addDownloaded(baseName: string, data: Buffer, origin: MediaOrigin): MediaRow {
    if (data.length === 0) throw new Error('Файл пустой');
    const fmt = sniffFormat(data);
    if (!fmt) throw new Error('Содержимое файла не распознано: это не аудио, видео или картинка поддерживаемого формата');
    let base = sanitizeDisplayName(baseName).replace(/\.(mp3|wav|ogg|oga|m4a|webm|mp4|m4v|gif|png|jpe?g|webp)$/i, '');
    base = base.slice(0, 110) || 'file';
    return this.add(`${base}.${fmt.ext}`, data, origin);
  }

  /**
   * Онлайн-медиа (Klipy): файл не копируется на диск — по правилам сервиса он загружается
   * с его сервера в момент показа. В базе хранится только идентификатор.
   */
  addRemote(opts: { name: string; kind: MediaRow['kind']; mime: string; remoteRef: string; attribution: string; sourceUrl: string; source: 'klipy' }): MediaRow {
    const id = crypto.randomUUID();
    const row: MediaRow = {
      id, name: sanitizeDisplayName(opts.name).slice(0, 120), file_name: `remote:${id}`, kind: opts.kind, mime: opts.mime, size: 0, duration_ms: 0,
      status: 'ok', status_msg: '', created_at: Date.now(), source: opts.source, remote_ref: opts.remoteRef,
      attribution: opts.attribution.slice(0, 300), source_url: opts.sourceUrl.slice(0, 500),
    };
    this.db.insertMedia(row);
    return row;
  }

  /** Абсолютный путь файла медиа по ID. Путь строится только из имени, сгенерированного ботом. */
  filePath(row: MediaRow): string | null {
    if (isRemote(row)) return null;
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(row.file_name)) return null;
    const full = path.resolve(this.dir, row.file_name);
    if (path.dirname(full) !== this.dir) return null;
    return full;
  }

  exists(row: MediaRow): boolean {
    if (isRemote(row)) return !!row.remote_ref;
    const p = this.filePath(row);
    return !!p && fs.existsSync(p);
  }

  remove(id: string, force = false): { ok: boolean; error?: string } {
    const row = this.db.getMedia(id);
    if (!row) return { ok: false, error: 'Файл не найден' };
    const used = this.db.mediaUsage(id);
    if (used.length && !force) return { ok: false, error: `Файл используется наградами: ${used.map((r) => r.title).join(', ')}` };
    const p = this.filePath(row);
    if (p) { try { fs.unlinkSync(p); } catch { /* уже нет */ } }
    this.db.deleteMedia(id);
    return { ok: true };
  }

  /** Проверка всех файлов: существуют ли и распознаются ли. */
  verifyAll(): { checked: number; broken: number } {
    let broken = 0;
    const rows = this.db.listMedia();
    for (const r of rows) {
      if (isRemote(r)) continue;
      const p = this.filePath(r);
      if (!p || !fs.existsSync(p)) { this.db.updateMediaStatus(r.id, 'broken', 'Файл отсутствует на диске'); broken++; continue; }
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      const fmt = sniffFormat(head);
      if (!fmt) { this.db.updateMediaStatus(r.id, 'broken', 'Файл повреждён: формат не распознан'); broken++; }
      else if (r.status === 'broken' && r.status_msg.startsWith('Файл')) this.db.updateMediaStatus(r.id, 'ok', '');
    }
    return { checked: rows.filter((r) => !isRemote(r)).length, broken };
  }
}
