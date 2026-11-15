import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Db } from './db.ts';
import type { ScopedLogger } from './logger.ts';
import type { FetchFn } from './twitch/auth.ts';
import { safeDownload, DownloadError, type Transport } from './net/safe-download.ts';
import { verifyUpdate, UPDATE_PUBLIC_KEYS } from './update-signature.ts';
import { readZip, ZipError, type ZipEntry } from './net/zip.ts';

/**
 * Обновления бота с GitHub.
 * - Проверка: changelog.json из публичного репозитория (raw.githubusercontent.com).
 * - Установка по кнопке: ZIP ветки main (codeload.github.com) → проверка версии и состава →
 *   резервная копия заменяемых файлов → копирование поверх программы (data, runtime, node_modules не трогаются) →
 *   при необходимости зависимости и лаунчер → перезапуск (код выхода 4, лаунчер запускает бота снова).
 *   При ошибке файлы восстанавливаются из резервной копии.
 * - После обновления панель показывает «Что нового».
 */

/** changes_en — те же изменения по-английски (с 1.4.0; в панели на английском показываются вместо changes). */
export interface ChangelogEntry { version: string; date: string; changes: string[]; changes_en?: string[] }

export type UpdateStep = 'idle' | 'download' | 'unpack' | 'copy' | 'deps' | 'launcher' | 'restart' | 'error';

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  checking: boolean;
  lastCheckAt: number;
  error: string;
  canInstall: boolean;
  reason: string;
  step: UpdateStep;
  stepText: string;
  /** Изменения в версиях новее текущей (для окна «Доступно обновление»). */
  notes: ChangelogEntry[];
  /** Изменения, которые пользователь ещё не видел после обновления (окно «Что нового»). */
  whatsNew: ChangelogEntry[];
}

export interface UpdaterDeps {
  db: Db;
  log: ScopedLogger;
  journal: (level: 'info' | 'warn' | 'error', type: string, message: string) => void;
  appRoot: string;
  dataDir: string;
  currentVersion: string;
  repo: string;
  fetchFn?: FetchFn;
  transport?: Transport;
  /** Установка npm-зависимостей (если в новой версии появились новые). */
  runNpm?: (cwd: string) => Promise<void>;
  /** Пересборка лаунчера TwitchAlertBot.exe (если изменился его исходный код). */
  buildLauncher?: (root: string) => Promise<void>;
  onChange?: (s: UpdateStatus) => void;
  /** Открытые ключи для проверки подписи обновления (тесты подставляют свой). */
  publicKeys?: readonly string[];
}

/** Сравнение версий вида 1.2.3: >0 — a новее. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function parseChangelog(raw: unknown): ChangelogEntry[] {
  if (!Array.isArray(raw)) throw new Error('неверный формат списка изменений');
  const out: ChangelogEntry[] = [];
  for (const e of raw.slice(0, 200)) {
    const r = e as Record<string, unknown>;
    const version = String(r?.version ?? '');
    if (!VERSION_RE.test(version)) continue;
    const list = (v: unknown) => (Array.isArray(v) ? v.map((c) => String(c).slice(0, 500)).slice(0, 50) : []);
    const changes = list(r.changes);
    const changesEn = list(r.changes_en);
    out.push({ version, date: String(r.date ?? '').slice(0, 20), changes, ...(changesEn.length ? { changes_en: changesEn } : {}) });
  }
  return out.sort((x, y) => compareVersions(y.version, x.version));
}

/** Не копируются при обновлении: данные пользователя, собственная копия Node.js, зависимости, git, собранный лаунчер. */
const KEEP_TOP = new Set(['data', 'runtime', 'node_modules', 'backup', '.git', 'TwitchAlertBot.exe', 'TwitchAlertBot.exe.old']);
const KEEP_PATHS = new Set(['launcher/app.ico']);
const isKept = (rel: string) => KEEP_TOP.has(rel.split('/')[0]) || KEEP_PATHS.has(rel) || rel.startsWith('launcher/bin/');

const STEP_TEXT: Record<UpdateStep, string> = {
  idle: '', download: 'Скачивание новой версии…', unpack: 'Проверка архива…', copy: 'Установка файлов…',
  deps: 'Установка зависимостей…', launcher: 'Обновление лаунчера…', restart: 'Перезапуск бота…', error: '',
};

export class Updater {
  private d: UpdaterDeps;
  private fetchFn: FetchFn;
  private latest: string | null = null;
  private remote: ChangelogEntry[] = [];
  private checking = false;
  private lastCheckAt = 0;
  private error = '';
  private step: UpdateStep = 'idle';
  private timer: NodeJS.Timeout | null = null;
  /** Перезапуск после установки (задаётся в main.ts). */
  onRestart: () => void = () => {};

  constructor(deps: UpdaterDeps) {
    this.d = deps;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.initSeen();
  }

  private get changelogUrl(): string { return `https://raw.githubusercontent.com/${this.d.repo}/main/changelog.json`; }
  private get zipUrl(): string { return `https://codeload.github.com/${this.d.repo}/zip/refs/heads/main`; }

  /** Локальный список изменений (из папки программы). */
  localChangelog(): ChangelogEntry[] {
    try { return parseChangelog(JSON.parse(fs.readFileSync(path.join(this.d.appRoot, 'changelog.json'), 'utf8'))); } catch { return []; }
  }

  /** Первый запуск этой версии: новым пользователям «Что нового» не показываем, обновившимся — показываем. */
  private initSeen(): void {
    if (this.d.db.getMeta('seen_version')) return;
    const hadData = (this.d.db.raw.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n > 0
      || (this.d.db.raw.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n > 0;
    this.d.db.setMeta('seen_version', hadData ? '1.0.0' : this.d.currentVersion);
  }

  markSeen(): void { this.d.db.setMeta('seen_version', this.d.currentVersion); this.emit(); }

  installBlocker(): string {
    if (fs.existsSync(path.join(this.d.appRoot, '.git'))) return 'Эта копия бота — рабочая папка разработчика (git). Обновляйте её через git, автоматическая установка отключена.';
    if (process.platform !== 'win32' && !process.env.TAB_UPDATE_ANY_OS) return 'Автоматическое обновление работает только в Windows.';
    return '';
  }

  status(): UpdateStatus {
    const cur = this.d.currentVersion;
    const seen = this.d.db.getMeta('seen_version') ?? cur;
    const available = !!this.latest && compareVersions(this.latest, cur) > 0;
    const blocker = this.installBlocker();
    return {
      current: cur, latest: this.latest, available, checking: this.checking, lastCheckAt: this.lastCheckAt, error: this.error,
      canInstall: available && !blocker && (this.step === 'idle' || this.step === 'error'), reason: blocker,
      step: this.step, stepText: STEP_TEXT[this.step],
      notes: this.remote.filter((e) => compareVersions(e.version, cur) > 0),
      whatsNew: this.localChangelog().filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, cur) <= 0),
    };
  }

  private emit(): void { try { this.d.onChange?.(this.status()); } catch { /* */ } }

  /** Периодическая проверка (при старте через 20 с, затем каждые 6 часов). */
  startAuto(enabled: () => boolean, firstDelayMs = 20_000, everyMs = 6 * 3600_000): void {
    const run = () => { if (enabled()) this.check().catch(() => {}); };
    const t = setTimeout(run, firstDelayMs); t.unref?.();
    this.timer = setInterval(run, everyMs); this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  async check(): Promise<UpdateStatus> {
    if (this.checking) return this.status();
    this.checking = true; this.emit();
    try {
      let res: Response;
      try {
        res = await this.fetchFn(this.changelogUrl, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      } catch { throw new Error('Нет связи с GitHub — проверьте интернет'); }
      if (!res.ok) throw new Error(`GitHub ответил ошибкой ${res.status}`);
      let list: ChangelogEntry[];
      try { list = parseChangelog(await res.json()); } catch { throw new Error('Не удалось прочитать список изменений'); }
      if (!list.length) throw new Error('Список изменений пуст');
      this.remote = list;
      this.latest = list[0].version;
      this.error = '';
      if (compareVersions(this.latest, this.d.currentVersion) > 0) this.d.log.info(`Доступна новая версия ${this.latest} (сейчас ${this.d.currentVersion})`);
    } catch (e) {
      this.error = (e as Error).message;
      this.d.log.warn(`Проверка обновлений не удалась: ${this.error}`);
    } finally {
      this.checking = false;
      this.lastCheckAt = Date.now();
      this.emit();
    }
    return this.status();
  }

  private setStep(s: UpdateStep): void { this.step = s; this.emit(); }

  /** Установка новой версии. Бросает Error с понятным текстом; при ошибке файлы восстанавливаются. */
  async install(): Promise<void> {
    const blocker = this.installBlocker();
    if (blocker) throw new Error(blocker);
    if (this.step !== 'idle' && this.step !== 'error') throw new Error('Обновление уже устанавливается');
    if (!this.latest || compareVersions(this.latest, this.d.currentVersion) <= 0) throw new Error('Новой версии нет — установлена последняя');
    const target = this.latest;
    const from = this.d.currentVersion;
    const root = this.d.appRoot;
    const backupDir = path.join(this.d.dataDir, 'updates', `backup-${from}-${Date.now()}`);
    const written: string[] = [];
    const backedUp = new Set<string>();
    try {
      // 1. Скачивание
      this.setStep('download');
      let zipBuf: Buffer;
      try {
        zipBuf = (await safeDownload(this.zipUrl, { maxBytes: 60 * 1024 * 1024, timeoutMs: 180_000, transport: this.d.transport, allowHost: (h) => h === 'codeload.github.com' || h === 'github.com' })).data;
      } catch (e) {
        throw new Error(e instanceof DownloadError ? `Не удалось скачать обновление: ${e.message}` : 'Не удалось скачать обновление');
      }

      // 2. Проверка архива
      this.setStep('unpack');
      let entries: ZipEntry[];
      try { entries = readZip(zipBuf); } catch (e) { throw new Error(e instanceof ZipError ? e.message : 'Архив обновления повреждён'); }
      const prefix = commonPrefix(entries);
      // Подпись автора: ни один файл не установится, если архив подменён (даже при взломе репозитория на GitHub).
      const signed = verifyUpdate(new Map(entries.map((e) => [e.name.slice(prefix.length), e.data] as [string, Buffer]).filter(([rel]) => rel)), this.d.publicKeys ?? UPDATE_PUBLIC_KEYS);
      const files = entries.map((e) => ({ rel: e.name.slice(prefix.length), data: e.data })).filter((f) => f.rel && !isKept(f.rel));
      const byRel = new Map(files.map((f) => [f.rel, f.data]));
      const pkgBuf = byRel.get('package.json');
      let pkg: { name?: string; version?: string; dependencies?: Record<string, string> };
      try { pkg = JSON.parse(String(pkgBuf ?? '')); } catch { throw new Error('В архиве обновления нет корректного package.json'); }
      if (pkg.name !== readJson(path.join(root, 'package.json'))?.name) throw new Error('Архив обновления не похож на Twitch Alert Bot');
      if (pkg.version !== target) throw new Error(`В архиве версия ${pkg.version}, а ожидалась ${target}. Попробуйте позже.`);
      if (signed.version !== pkg.version) throw new Error(`Подпись выдана для версии ${signed.version}, а в архиве ${pkg.version} — установка отменена.`);
      for (const must of ['src/main.ts', 'public/panel/app.js', 'public/overlay/overlay.js', 'changelog.json']) {
        if (!byRel.has(must)) throw new Error(`В архиве обновления нет файла ${must}`);
      }

      // 3. Резервная копия и копирование
      this.setStep('copy');
      const oldLauncher = readText(path.join(root, 'launcher', 'TrayLauncher.cs'));
      for (const f of files) {
        const dest = path.join(root, ...f.rel.split('/'));
        if (!dest.startsWith(path.resolve(root) + path.sep)) throw new Error('Недопустимый путь в архиве');
        if (fs.existsSync(dest)) {
          const bak = path.join(backupDir, ...f.rel.split('/'));
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(dest, bak);
          backedUp.add(f.rel);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.data);
        written.push(f.rel);
      }

      // 4. Зависимости
      const missing = Object.keys(pkg.dependencies ?? {}).filter((dep) => !fs.existsSync(path.join(root, 'node_modules', dep, 'package.json')));
      if (missing.length) {
        this.setStep('deps');
        try { await (this.d.runNpm ?? runNpmInstall)(root); } catch { throw new Error(`Не удалось установить зависимости (${missing.join(', ')}). Запустите install.cmd вручную.`); }
        const still = missing.filter((dep) => !fs.existsSync(path.join(root, 'node_modules', dep, 'package.json')));
        if (still.length) throw new Error(`Не установлены зависимости: ${still.join(', ')}. Запустите install.cmd вручную.`);
      }

      // 5. Лаунчер (не критично: при ошибке бот продолжит работать со старым лаунчером)
      const newLauncher = readText(path.join(root, 'launcher', 'TrayLauncher.cs'));
      if (newLauncher && newLauncher !== oldLauncher && fs.existsSync(path.join(root, 'TwitchAlertBot.exe'))) {
        this.setStep('launcher');
        try { await (this.d.buildLauncher ?? rebuildLauncher)(root); }
        catch (e) { this.d.journal('warn', 'update', `Лаунчер не обновлён (${(e as Error).message}). Он продолжит работать; при желании запустите install.cmd.`); }
      }
    } catch (e) {
      // Откат: возвращаем заменённые файлы, удаляем добавленные.
      for (const rel of written) {
        const dest = path.join(root, ...rel.split('/'));
        try {
          if (backedUp.has(rel)) fs.copyFileSync(path.join(backupDir, ...rel.split('/')), dest);
          else fs.rmSync(dest, { force: true });
        } catch { /* best effort */ }
      }
      this.error = (e as Error).message;
      this.setStep('error');
      this.d.journal('error', 'update', `Обновление до ${target} не установлено: ${this.error}${written.length ? ' Прежняя версия восстановлена.' : ''}`);
      throw e;
    }
    this.d.journal('info', 'update', `Установлена версия ${target} (была ${from}). Резервная копия прежних файлов: ${backupDir}`);
    this.setStep('restart');
    setTimeout(() => this.onRestart(), 800).unref?.();
  }
}

function commonPrefix(entries: ZipEntry[]): string {
  // Архив GitHub: всё лежит в папке «<repo>-main/».
  const first = entries[0]?.name.split('/')[0];
  if (first && entries.every((e) => e.name.startsWith(first + '/'))) return first + '/';
  return '';
}

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readText(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** npm из системного Node.js (он нужен для установки бота). Скрипты пакетов не запускаются: зависимостям бота они не нужны. */
function runNpmInstall(root: string): Promise<void> {
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd install --omit=dev --no-audit --no-fund --ignore-scripts'], root, 300_000);
}

/** Работающий .exe нельзя перезаписать, но можно переименовать: старый лаунчер остаётся в памяти, новый — для следующего запуска. */
async function rebuildLauncher(root: string): Promise<void> {
  const exe = path.join(root, 'TwitchAlertBot.exe');
  const old = exe + '.old';
  try { fs.rmSync(old, { force: true }); } catch { /* занят — оставим */ }
  fs.renameSync(exe, old);
  try {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'launcher', 'build-launcher.ps1')], root, 180_000);
    if (!fs.existsSync(exe)) throw new Error('файл не создан');
  } catch (e) {
    try { fs.rmSync(exe, { force: true }); fs.renameSync(old, exe); } catch { /* */ }
    throw e;
  }
}
