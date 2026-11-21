import fs from 'node:fs';
import path from 'node:path';
import { makePaths, DEFAULT_PORT, APP_VERSION, APP_ROOT } from './config.ts';
import { Logger } from './logger.ts';
import { DpapiStore, DpapiProtector } from './secure-store.ts';
import { App } from './app.ts';
import { createServer } from './server/http.ts';
import { Db } from './db.ts';
import { migrateLegacyData } from './migrate.ts';
import { applyPendingRestore } from './backup.ts';

const paths = makePaths();
const logger = new Logger({ logDir: paths.logDir, minLevel: process.env.TAB_DEBUG ? 'debug' : 'info' });
const log = logger.child('main');

// Однократный перенос данных из прежнего места хранения (AppData и его виртуализированных копий).
if (!process.env.TAB_DATA_DIR) {
  try {
    const r = migrateLegacyData(paths.dataDir);
    if (r) log.info(`Данные перенесены в ${paths.dataDir} из ${r.from.dir} (файлов: ${r.files}, наград: ${r.from.rewards}, медиа: ${r.from.media}, Client ID: ${r.from.clientId ? 'есть' : 'нет'}, вход: ${r.from.hasTokens ? 'есть' : 'нет'})`);
  } catch (e) { log.error('Не удалось перенести данные из прежней папки', e); }
}

// Восстановление из резервной копии (подготовлено в панели): до открытия базы.
try {
  const r = applyPendingRestore(paths.dataDir, paths.dbFile, paths.mediaDir);
  if (r) log.info(`Данные восстановлены из резервной копии (версия ${r.version}, медиафайлов: ${r.mediaFiles}); прежние — в restore-previous`);
} catch (e) { log.error('Не удалось восстановить данные из резервной копии — бот запускается с прежними данными', e); }

/** Проверка, жив ли процесс с указанным PID. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Только один экземпляр: lock-файл с PID + проверка порта. */
async function acquireLock(port: number): Promise<boolean> {
  try {
    const fd = fs.openSync(paths.lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    let pid = 0;
    try { pid = Number(fs.readFileSync(paths.lockFile, 'utf8').trim()); } catch { /* */ }
    if (pid && pid !== process.pid && pidAlive(pid) && (await healthy(port))) return false;
    // Устаревший lock (процесс завершился аварийно) — перехватываем.
    fs.writeFileSync(paths.lockFile, String(process.pid));
    return true;
  }
}

function releaseLock(): void {
  try { if (fs.readFileSync(paths.lockFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.lockFile); } catch { /* */ }
  try { fs.unlinkSync(paths.runtimeFile); } catch { /* */ }
}

async function main(): Promise<void> {
  // Порт берём из настроек (до создания App).
  let port = Number(process.env.TAB_PORT) || DEFAULT_PORT;
  try { const db = new Db(paths.dbFile); port = Number(process.env.TAB_PORT) || db.getSettings().port || DEFAULT_PORT; db.close(); } catch { /* */ }

  if (!(await acquireLock(port))) {
    log.warn(`Бот уже запущен (http://127.0.0.1:${port}/panel/). Второй экземпляр не запускается.`);
    await logger.close();
    process.exit(3);
  }

  log.info(`Запуск Twitch Alert Bot ${APP_VERSION}, данные: ${paths.dataDir}`);
  const app = new App({ paths, logger, store: new DpapiStore(paths.tokenFile), protector: new DpapiProtector(), port });
  const server = createServer(app, { onShutdown: () => void shutdown('panel'), onRestart: () => void shutdown('restore', 4) });
  // После установки обновления — выход с кодом 4: лаунчер сразу запускает новую версию.
  app.updater.onRestart = () => void shutdown('update', 4);
  try { fs.rmSync(path.join(APP_ROOT, 'TwitchAlertBot.exe.old'), { force: true }); } catch { /* старый лаунчер ещё работает */ }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`Порт ${port} занят другой программой. Измените порт в настройках (или переменной TAB_PORT).`));
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // language — для меню лаунчера в трее до первого ответа /api/health.
  fs.writeFileSync(paths.runtimeFile, JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), language: app.lang }));
  log.info(`Панель управления: http://127.0.0.1:${port}/panel/  |  overlay (OBS/Streamlabs): http://127.0.0.1:${port}/overlay`);

  await app.start();

  if (app.db.getSettings().launchObsWithBot && process.argv.includes('--autostart')) {
    fetch(`http://127.0.0.1:${port}/api/obs/launch`, { method: 'POST', headers: { 'x-tab-request': '1' } }).catch(() => {});
  }

  let stopping = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info(`Завершение работы (${reason})…`);
    const force = setTimeout(() => { log.error('Корректное завершение заняло слишком долго — принудительный выход'); releaseLock(); process.exit(1); }, 8000);
    try {
      await app.stop(); // закрывает EventSub, WebSocket overlay/панели и базу данных
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    } catch (e) { log.error('Ошибка при завершении', e); }
    clearTimeout(force);
    log.info('Работа завершена корректно');
    releaseLock();
    await logger.close();
    process.exit(exitCode);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
}

// Ошибка одного обработчика не должна ронять всё приложение.
process.on('uncaughtException', (e) => { log.error('Непредвиденная ошибка (приложение продолжает работу)', e); log.error(String(e.stack ?? '')); });
process.on('unhandledRejection', (e) => { log.error('Необработанная ошибка в асинхронном коде', e instanceof Error ? e : new Error(String(e))); });

main().catch(async (e) => {
  log.error(`Не удалось запустить бота: ${(e as Error).message}`);
  releaseLock();
  await logger.close();
  process.exit(1);
});
