import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_NAME } from './config.ts';

export interface LegacyCandidate { dir: string; clientId: string; rewards: number; media: number; hasTokens: boolean; score: number }

/**
 * Где могли остаться данные прежних версий:
 *  - %LOCALAPPDATA%\TwitchAlertBot — прежнее место хранения;
 *  - %LOCALAPPDATA%\Packages\<приложение>\LocalCache\Local\TwitchAlertBot — копия, которую Windows создаёт,
 *    если бот был запущен из «упакованного» приложения (MSIX, например из Claude): такие процессы пишут
 *    в AppData через виртуализацию, и обычный запуск этих данных не видит.
 */
export function legacyDataDirs(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')): string[] {
  const dirs = [path.join(localAppData, APP_NAME)];
  const pk = path.join(localAppData, 'Packages');
  try {
    for (const d of fs.readdirSync(pk)) dirs.push(path.join(pk, d, 'LocalCache', 'Local', APP_NAME));
  } catch { /* нет папки Packages */ }
  return dirs.filter((d) => fs.existsSync(path.join(d, 'bot.sqlite')));
}

/** Оценка содержимого: читаем копию базы (вместе с WAL), чтобы не трогать оригинал. */
export function inspectDataDir(dir: string): LegacyCandidate | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-inspect-'));
  try {
    for (const f of ['bot.sqlite', 'bot.sqlite-wal', 'bot.sqlite-shm']) {
      const src = path.join(dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    const db = new DatabaseSync(path.join(tmp, 'bot.sqlite'));
    const q = (sql: string): unknown => { try { return db.prepare(sql).get(); } catch { return undefined; } };
    const cid = q(`SELECT value FROM settings WHERE key = 'clientId'`) as { value: string } | undefined;
    const rewards = (q('SELECT COUNT(*) AS n FROM rewards') as { n: number } | undefined)?.n ?? 0;
    const media = (q('SELECT COUNT(*) AS n FROM media') as { n: number } | undefined)?.n ?? 0;
    db.close();
    let clientId = '';
    try { clientId = cid ? String(JSON.parse(cid.value) ?? '') : ''; } catch { /* */ }
    const hasTokens = fs.existsSync(path.join(dir, 'tokens.dpapi'));
    const score = (clientId ? 1000 : 0) + (hasTokens ? 500 : 0) + Number(rewards) * 10 + Number(media);
    return { dir, clientId, rewards: Number(rewards), media: Number(media), hasTokens, score };
  } catch {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function copyDir(src: string, dst: string): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

/**
 * Однократный перенос данных в новую папку. Выполняется, только если в целевой папке ещё нет базы.
 * Из всех найденных копий выбирается самая «полная» (Client ID, вход, награды, медиа). Исходные файлы не удаляются.
 */
export function migrateLegacyData(targetDir: string, candidates = legacyDataDirs()): { from: LegacyCandidate; files: number } | null {
  if (fs.existsSync(path.join(targetDir, 'bot.sqlite'))) return null;
  const inspected = candidates.map(inspectDataDir).filter((c): c is LegacyCandidate => !!c && c.score > 0);
  if (!inspected.length) return null;
  inspected.sort((a, b) => b.score - a.score);
  const best = inspected[0];
  fs.mkdirSync(targetDir, { recursive: true });
  let files = 0;
  for (const f of ['bot.sqlite', 'bot.sqlite-wal', 'bot.sqlite-shm', 'tokens.dpapi']) {
    const src = path.join(best.dir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(targetDir, f)); files++; }
  }
  for (const sub of ['media', 'obs-backups', 'logs']) files += copyDir(path.join(best.dir, sub), path.join(targetDir, sub));
  fs.writeFileSync(path.join(targetDir, 'MIGRATED_FROM.txt'), `Данные перенесены ${new Date().toISOString()} из:\n${best.dir}\n`);
  return { from: best, files };
}
