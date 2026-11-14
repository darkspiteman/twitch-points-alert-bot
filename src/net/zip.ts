import zlib from 'node:zlib';

/**
 * Минимальное безопасное чтение ZIP-архива (для обновлений с GitHub).
 * Поддерживаются методы «без сжатия» и deflate. Отклоняются: шифрование, пути с «..», абсолютные пути,
 * обратные слэши и буквы дисков (защита от zip slip), несовпадение размера или CRC32, слишком большие архивы.
 */

export interface ZipEntry { name: string; data: Buffer }

export class ZipError extends Error {}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export function safeEntryName(raw: string): string | null {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.split('/').filter((p, i, a) => !(p === '' && i === a.length - 1));
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.join('/');
}

export function readZip(buf: Buffer, limits: { maxEntries?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxTotal = limits.maxTotalBytes ?? 200 * 1024 * 1024;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Архив повреждён: не найден каталог ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new ZipError('В архиве слишком много файлов');
  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError('Архив повреждён: неверный каталог');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (flags & 1) throw new ZipError('Зашифрованные архивы не поддерживаются');
    if (rawName.endsWith('/')) continue; // папка
    const name = safeEntryName(rawName);
    if (!name) throw new ZipError(`Недопустимый путь в архиве: ${rawName.slice(0, 100)}`);
    total += usize;
    if (total > maxTotal) throw new ZipError('Архив слишком большой после распаковки');
    if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== SIG_LOC) throw new ZipError('Архив повреждён: неверный заголовок файла');
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const comp = buf.subarray(start, start + csize);
    if (comp.length !== csize) throw new ZipError('Архив повреждён: файл обрезан');
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(usize, 1) }); } catch { throw new ZipError(`Архив повреждён: не удалось распаковать ${name}`); }
    } else throw new ZipError(`Неподдерживаемый метод сжатия в архиве (${method})`);
    if (data.length !== usize || zlib.crc32(data) !== crc) throw new ZipError(`Архив повреждён: контрольная сумма не совпала (${name})`);
    out.push({ name, data });
  }
  return out;
}
