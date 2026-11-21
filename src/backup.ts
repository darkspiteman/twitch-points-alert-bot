import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Резервная копия бота (1.9.0): база (настройки, награды, медиатека, история, статистика, счётчики) и медиафайлы —
 * в один ZIP. Вход в Twitch (tokens.dpapi), голоса Piper, озвучка, логи и копии сцен в архив не входят.
 *
 * Восстановление в два шага: архив проверяется и распаковывается в data\restore-pending, бот перезапускается,
 * и уже при запуске, до открытия базы, файлы меняются местами (прежние — в data\restore-previous).
 */

export const BACKUP_DIR = 'backups';
const PENDING_DIR = 'restore-pending';
const PREVIOUS_DIR = 'restore-previous';
const DONE_FILE = 'restore-done.json';
const MANIFEST = 'backup.json';
const DB_ENTRY = 'bot.sqlite';
const APP_MARK = 'twitch-alert-bot';
/** Имена файлов медиатеки — их задаёт сам бот (uuid.расширение). */
const MEDIA_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
export const BACKUP_NAME = /^TwitchAlertBot-(backup|before-restore)-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;
/** ZIP без расширения Zip64: не больше 4 ГБ. */
const MAX_ZIP = 3.9 * 1024 ** 3;
const CHUNK = 1024 * 1024;

export class BackupError extends Error {}

export interface BackupInfo { name: string; size: number; createdAt: number; kind: 'backup' | 'before-restore' }

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupDir(dataDir: string): string { return path.join(dataDir, BACKUP_DIR); }

/** Создать резервную копию в data\backups. Старые копии этого вида удаляются (остаются последние). */
export function createBackup(o: { db: DatabaseSync; dataDir: string; mediaDir: string; version: string }, kind: BackupInfo['kind'] = 'backup'): BackupInfo & { files: number } {
  const dir = backupDir(o.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  let name = `TwitchAlertBot-${kind}-${stamp()}.zip`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `TwitchAlertBot-${kind}-${stamp(new Date(Date.now() + i * 1000))}.zip`;
  const tmpDb = path.join(dir, `tmp-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  const out = path.join(dir, name);
  try {
    // Целостная копия базы без остановки бота.
    o.db.exec(`VACUUM INTO '${tmpDb.replaceAll("'", "''")}'`);
    const media = fs.existsSync(o.mediaDir)
      ? fs.readdirSync(o.mediaDir, { withFileTypes: true }).filter((f) => f.isFile() && MEDIA_NAME.test(f.name)).map((f) => f.name)
      : [];
    const entries: ZipSource[] = [
      { name: MANIFEST, data: Buffer.from(JSON.stringify({ app: APP_MARK, version: o.version, createdAt: Date.now(), mediaFiles: media.length }, null, 2)) },
      { name: DB_ENTRY, file: tmpDb },
      ...media.map((f) => ({ name: `media/${f}`, file: path.join(o.mediaDir, f) })),
    ];
    let total = 0;
    for (const e of entries) total += e.data ? e.data.length : fs.statSync(e.file!).size;
    if (total > MAX_ZIP) throw new BackupError('Медиафайлов слишком много для одной копии (больше 3,9 ГБ). Удалите ненужные файлы в разделе «Медиатека».');
    writeZip(out + '.part', entries);
    fs.renameSync(out + '.part', out);
    prune(dir, kind, kind === 'backup' ? 5 : 3);
    return { name, size: fs.statSync(out).size, createdAt: Date.now(), kind, files: media.length };
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(out + '.part', { force: true });
  }
}

export function listBackups(dataDir: string): BackupInfo[] {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, size: st.size, createdAt: st.mtimeMs, kind: (n.includes('before-restore') ? 'before-restore' : 'backup') as BackupInfo['kind'] };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

function prune(dir: string, kind: BackupInfo['kind'], keep: number): void {
  const list = fs.readdirSync(dir).filter((n) => BACKUP_NAME.test(n) && n.startsWith(`TwitchAlertBot-${kind}-`)).sort().reverse();
  for (const n of list.slice(keep)) fs.rmSync(path.join(dir, n), { force: true });
}

// ---------------- ZIP: запись (без сжатия: медиа уже сжаты) ----------------

interface ZipSource { name: string; data?: Buffer; file?: string }

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fileCrc(file: string): { crc: number; size: number } {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(CHUNK);
  let crc = 0, size = 0, n = 0;
  try {
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) { crc = zlib.crc32(buf.subarray(0, n), crc); size += n; }
  } finally { fs.closeSync(fd); }
  return { crc, size };
}

export function writeZip(target: string, entries: ZipSource[]): void {
  if (entries.length > 65000) throw new BackupError('Слишком много файлов для одной копии');
  const fd = fs.openSync(target, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) => { fs.writeSync(fd, b); offset += b.length; };
  const { time, date } = dosTime(new Date());
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const { crc, size } = e.data ? { crc: zlib.crc32(e.data), size: e.data.length } : fileCrc(e.file!);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name);
      if (e.data) write(e.data);
      else {
        const src = fs.openSync(e.file!, 'r');
        const buf = Buffer.alloc(CHUNK);
        let n = 0, copied = 0;
        try { while (copied < size && (n = fs.readSync(src, buf, 0, Math.min(CHUNK, size - copied), null)) > 0) { write(buf.subarray(0, n)); copied += n; } } finally { fs.closeSync(src); }
        if (copied !== size) throw new BackupError(`Файл изменился во время копирования: ${e.name}`);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const cdStart = offset;
    for (const b of central) write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally { fs.closeSync(fd); }
}

// ---------------- ZIP: чтение с диска (архив может быть больше памяти) ----------------

interface ZipIndexEntry { name: string; method: number; flags: number; crc: number; csize: number; usize: number; loc: number }

function readIndex(fd: number): ZipIndexEntry[] {
  const size = fs.fstatSync(fd).size;
  if (size < 22) throw new BackupError('Файл повреждён или это не ZIP-архив');
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new BackupError('Файл повреждён или это не ZIP-архив');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) throw new BackupError('Файл повреждён или это не ZIP-архив');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const out: ZipIndexEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new BackupError('Файл повреждён или это не ZIP-архив');
    const nlen = cd.readUInt16LE(p + 28);
    out.push({
      flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24),
      loc: cd.readUInt32LE(p + 42), name: cd.subarray(p + 46, p + 46 + nlen).toString('utf8'),
    });
    p += 46 + nlen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  return out;
}

function extract(fd: number, e: ZipIndexEntry, dest: string): void {
  if (e.flags & 1) throw new BackupError('Зашифрованные архивы не поддерживаются');
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, e.loc);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new BackupError(`Архив повреждён: ${e.name}`);
  const start = e.loc + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  let crc = 0;
  if (e.method === 0) {
    if (e.csize !== e.usize) throw new BackupError(`Архив повреждён: ${e.name}`);
    const out = fs.openSync(dest, 'w');
    const buf = Buffer.alloc(CHUNK);
    let done = 0;
    try {
      while (done < e.csize) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, e.csize - done), start + done);
        if (n <= 0) throw new BackupError(`Архив обрезан: ${e.name}`);
        crc = zlib.crc32(buf.subarray(0, n), crc);
        fs.writeSync(out, buf, 0, n);
        done += n;
      }
    } finally { fs.closeSync(out); }
  } else if (e.method === 8) {
    // Архив, пересобранный другой программой (со сжатием).
    if (e.csize > 512 * 1024 * 1024 || e.usize > 1024 ** 3) throw new BackupError(`Слишком большой сжатый файл в архиве: ${e.name}`);
    const comp = Buffer.alloc(e.csize);
    fs.readSync(fd, comp, 0, e.csize, start);
    let data: Buffer;
    try { data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(e.usize, 1) }); } catch { throw new BackupError(`Архив повреждён: ${e.name}`); }
    if (data.length !== e.usize) throw new BackupError(`Архив повреждён: ${e.name}`);
    crc = zlib.crc32(data);
    fs.writeFileSync(dest, data);
  } else throw new BackupError(`Неподдерживаемое сжатие в архиве: ${e.name}`);
  if ((crc >>> 0) !== (e.crc >>> 0)) throw new BackupError(`Архив повреждён (контрольная сумма): ${e.name}`);
}

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number(x) || 0), pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export interface RestoreInfo { version: string; createdAt: number; mediaFiles: number }

/** Проверить архив и подготовить восстановление (применится при следующем запуске бота). */
export function prepareRestore(zipFile: string, dataDir: string, currentVersion: string): RestoreInfo {
  const pending = path.join(dataDir, PENDING_DIR);
  fs.rmSync(pending, { recursive: true, force: true });
  const fd = fs.openSync(zipFile, 'r');
  try {
    const index = readIndex(fd);
    const man = index.find((e) => e.name === MANIFEST);
    const dbe = index.find((e) => e.name === DB_ENTRY);
    if (!man || !dbe || man.usize > 64 * 1024) throw new BackupError('Это не резервная копия Twitch Alert Bot');
    fs.mkdirSync(path.join(pending, 'media'), { recursive: true });
    extract(fd, man, path.join(pending, MANIFEST));
    let info: { app?: string; version?: string; createdAt?: number };
    try { info = JSON.parse(fs.readFileSync(path.join(pending, MANIFEST), 'utf8')); } catch { throw new BackupError('Это не резервная копия Twitch Alert Bot'); }
    if (info.app !== APP_MARK) throw new BackupError('Это не резервная копия Twitch Alert Bot');
    const version = String(info.version ?? '0.0.0');
    if (newer(version, currentVersion)) throw new BackupError(`Копия сделана более новой версией бота (${version}) — сначала обновите бота`);
    extract(fd, dbe, path.join(pending, DB_ENTRY));
    let mediaFiles = 0;
    for (const e of index) {
      if (!e.name.startsWith('media/')) continue;
      const f = e.name.slice('media/'.length);
      if (!MEDIA_NAME.test(f)) continue; // посторонние файлы не распаковываются
      extract(fd, e, path.join(pending, 'media', f));
      mediaFiles++;
    }
    checkDb(path.join(pending, DB_ENTRY));
    const ready: RestoreInfo = { version, createdAt: Number(info.createdAt) || 0, mediaFiles };
    fs.writeFileSync(path.join(pending, 'ready.json'), JSON.stringify(ready));
    return ready;
  } catch (e) {
    fs.rmSync(pending, { recursive: true, force: true });
    throw e;
  } finally { fs.closeSync(fd); }
}

function checkDb(file: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'rewards', 'media')`).get() as { n: number };
    if (Number(r.n) !== 3) throw new Error('no tables');
    const ok = db.prepare('PRAGMA quick_check').get() as Record<string, string>;
    if (Object.values(ok)[0] !== 'ok') throw new Error('corrupt');
  } catch {
    throw new BackupError('База данных в копии повреждена');
  } finally { try { db?.close(); } catch { /* */ } }
}

export function cancelPendingRestore(dataDir: string): void {
  fs.rmSync(path.join(dataDir, PENDING_DIR), { recursive: true, force: true });
}

/**
 * При запуске бота, до открытия базы: заменить базу и медиа подготовленными из копии.
 * Прежние файлы переносятся в data\restore-previous (одна, последняя, замена).
 */
export function applyPendingRestore(dataDir: string, dbFile: string, mediaDir: string): RestoreInfo | null {
  const pending = path.join(dataDir, PENDING_DIR);
  const readyFile = path.join(pending, 'ready.json');
  if (!fs.existsSync(readyFile)) return null;
  const info = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as RestoreInfo;
  const prev = path.join(dataDir, PREVIOUS_DIR);
  fs.rmSync(prev, { recursive: true, force: true });
  fs.mkdirSync(prev, { recursive: true });
  const moved: Array<[string, string]> = [];
  const move = (from: string, to: string) => { if (fs.existsSync(from)) { fs.renameSync(from, to); moved.push([from, to]); } };
  try {
    for (const suf of ['', '-wal', '-shm']) move(dbFile + suf, path.join(prev, path.basename(dbFile) + suf));
    move(mediaDir, path.join(prev, 'media'));
    fs.renameSync(path.join(pending, DB_ENTRY), dbFile);
    fs.renameSync(path.join(pending, 'media'), mediaDir);
  } catch (e) {
    // Вернуть как было: бот запустится с прежними данными.
    try { fs.rmSync(dbFile, { force: true }); } catch { /* */ }
    for (const [from, to] of moved.reverse()) { try { if (fs.existsSync(from)) fs.rmSync(from, { recursive: true, force: true }); fs.renameSync(to, from); } catch { /* */ } }
    fs.rmSync(pending, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(pending, { recursive: true, force: true });
  fs.writeFileSync(path.join(dataDir, DONE_FILE), JSON.stringify(info));
  return info;
}

/** Восстановление выполнено при запуске — сведения для журнала (один раз). */
export function takeRestoreDone(dataDir: string): RestoreInfo | null {
  const f = path.join(dataDir, DONE_FILE);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as RestoreInfo; } catch { return null; } finally { fs.rmSync(f, { force: true }); }
}
