import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'TwitchAlertBot';

/** Корень проекта (папка, где лежат src/ и public/). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Версия берётся из package.json — единственный источник номера версии. */
export const APP_VERSION: string = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
})();

/** Публичный репозиторий, откуда приходят обновления. */
export const UPDATE_REPO = 'darkspiteman/twitch-points-alert-bot';
export const SUPPORT_LINKS = {
  /** Сразу открывает окно доната. */
  boosty: 'https://boosty.to/spiteman/donate',
  /** Страница автора (личные сообщения). */
  boostyProfile: 'https://boosty.to/spiteman',
  ideas: `https://github.com/${UPDATE_REPO}/issues/new?labels=enhancement&title=${encodeURIComponent('Идея: ')}`,
  repo: `https://github.com/${UPDATE_REPO}`,
};
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');

export function resolveDataDir(): string {
  const override = process.env.TAB_DATA_DIR;
  if (override) return path.resolve(override);
  // Данные хранятся в папке программы, а не в AppData: так их одинаково видят все способы запуска
  // (ярлык, автозапуск, запуск из «упакованных» приложений Windows, где AppData виртуализируется).
  return path.join(APP_ROOT, 'data');
}

export interface Paths {
  dataDir: string;
  dbFile: string;
  tokenFile: string;
  mediaDir: string;
  logDir: string;
  lockFile: string;
  runtimeFile: string;
  backupDir: string;
}

export function makePaths(dataDir = resolveDataDir()): Paths {
  const p: Paths = {
    dataDir,
    dbFile: path.join(dataDir, 'bot.sqlite'),
    tokenFile: path.join(dataDir, 'tokens.dpapi'),
    mediaDir: path.join(dataDir, 'media'),
    logDir: path.join(dataDir, 'logs'),
    lockFile: path.join(dataDir, 'bot.lock'),
    runtimeFile: path.join(dataDir, 'runtime.json'),
    backupDir: path.join(dataDir, 'obs-backups'),
  };
  for (const d of [p.dataDir, p.mediaDir, p.logDir, p.backupDir]) fs.mkdirSync(d, { recursive: true });
  return p;
}

/** Порт по умолчанию. Можно переопределить переменной TAB_PORT или в настройках. */
export const DEFAULT_PORT = 17420;

export interface Settings {
  clientId: string;
  port: number;
  /** 'active' — воспроизводить; 'observe' — только записывать события (для параллельной работы с Sound Alerts). */
  mode: 'active' | 'observe';
  allowManageRewards: boolean;
  masterVolume: number; // 0..100
  delayBeforeMs: number;
  gapBetweenMs: number;
  maxQueueLength: number;
  maxItemAgeSec: number;
  userCooldownSec: number;
  defaultImageDurationMs: number;
  maxDurationMs: number;
  showCaption: boolean;
  captionTemplate: string;
  overlayPosition: 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  overlayMaxWidthPct: number;
  overlayMaxHeightPct: number;
  obsExePath: string;
  obsConfigDir: string;
  launchObsWithBot: boolean;
  historyRetentionDays: number;
  recoverMissed: boolean;
  /** Для наград, созданных ботом: отмечать погашение выполненным, а при сбое — возвращать баллы. */
  manageRedemptionStatus: boolean;
  /** Общий выключатель видео: true — все награды только со звуком. */
  audioOnly: boolean;
  /** Ключ API Klipy (поиск мемов). Никогда не отдаётся в панель целиком и не пишется в логи. */
  klipyApiKey: string;
  /** Ключ API Freesound (поиск звуков). */
  freesoundApiKey: string;
  /** Фильтр «взрослого» контента Klipy. */
  klipyContentFilter: 'off' | 'low' | 'medium' | 'high';
  /** Проверять наличие новой версии бота на GitHub. */
  autoUpdateCheck: boolean;
}

export const SECRET_SETTINGS = ['klipyApiKey', 'freesoundApiKey'] as const;

/** Маска ключа для панели: «••••abcd» или пустая строка. */
export function maskSecret(v: string): string {
  return v ? `••••${v.slice(-4)}` : '';
}

/** Настройки для отправки в панель: ключи API заменены маской. */
export function publicSettings(s: Settings): Settings {
  const out = { ...s };
  for (const k of SECRET_SETTINGS) out[k] = maskSecret(s[k]);
  return out;
}

export function defaultSettings(): Settings {
  return {
    clientId: '',
    port: DEFAULT_PORT,
    mode: 'active',
    allowManageRewards: true,
    masterVolume: 80,
    delayBeforeMs: 0,
    gapBetweenMs: 700,
    maxQueueLength: 30,
    maxItemAgeSec: 300,
    userCooldownSec: 0,
    defaultImageDurationMs: 5000,
    maxDurationMs: 60000,
    showCaption: true,
    captionTemplate: '{user}: {reward}',
    overlayPosition: 'center',
    overlayMaxWidthPct: 60,
    overlayMaxHeightPct: 60,
    obsExePath: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    obsConfigDir: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio'),
    launchObsWithBot: false,
    historyRetentionDays: 30,
    recoverMissed: true,
    manageRedemptionStatus: true,
    audioOnly: false,
    klipyApiKey: '',
    freesoundApiKey: '',
    klipyContentFilter: 'medium',
    autoUpdateCheck: true,
  };
}

/** Проверка и нормализация значений настроек, пришедших из панели. Возвращает текст ошибки или null. */
export function validateSettingsPatch(patch: Record<string, unknown>): { ok: Partial<Settings>; error: string | null } {
  const def = defaultSettings();
  const out: Record<string, unknown> = {};
  const num = (k: string, min: number, max: number) => {
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Значение «${k}» должно быть числом от ${min} до ${max}`);
    out[k] = Math.round(v);
  };
  try {
    for (const k of Object.keys(patch)) {
      if (!(k in def)) throw new Error(`Неизвестная настройка: ${k}`);
      switch (k) {
        case 'port': num(k, 1024, 65535); break;
        case 'masterVolume': num(k, 0, 100); break;
        case 'delayBeforeMs': num(k, 0, 60000); break;
        case 'gapBetweenMs': num(k, 0, 60000); break;
        case 'maxQueueLength': num(k, 1, 500); break;
        case 'maxItemAgeSec': num(k, 10, 86400); break;
        case 'userCooldownSec': num(k, 0, 3600); break;
        case 'defaultImageDurationMs': num(k, 500, 600000); break;
        case 'maxDurationMs': num(k, 1000, 600000); break;
        case 'overlayMaxWidthPct': num(k, 5, 100); break;
        case 'overlayMaxHeightPct': num(k, 5, 100); break;
        case 'historyRetentionDays': num(k, 1, 3650); break;
        case 'mode':
          if (patch[k] !== 'active' && patch[k] !== 'observe') throw new Error('Неверный режим работы');
          out[k] = patch[k]; break;
        case 'overlayPosition': {
          const allowed = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
          if (!allowed.includes(String(patch[k]))) throw new Error('Неверное положение overlay');
          out[k] = patch[k]; break;
        }
        case 'allowManageRewards': case 'showCaption': case 'launchObsWithBot': case 'recoverMissed': case 'manageRedemptionStatus': case 'audioOnly': case 'autoUpdateCheck':
          out[k] = Boolean(patch[k]); break;
        case 'clientId': {
          const v = String(patch[k] ?? '').trim();
          if (v && !/^[a-z0-9]{20,40}$/i.test(v)) throw new Error('Client ID выглядит неверно: ожидается 30 латинских букв и цифр из dev.twitch.tv/console');
          out[k] = v; break;
        }
        case 'klipyApiKey': case 'freesoundApiKey': {
          const v = String(patch[k] ?? '').trim();
          if (v && !/^[A-Za-z0-9_-]{8,128}$/.test(v)) throw new Error('Ключ API выглядит неверно: ожидаются латинские буквы и цифры без пробелов. Скопируйте его ещё раз.');
          out[k] = v; break;
        }
        case 'klipyContentFilter':
          if (!['off', 'low', 'medium', 'high'].includes(String(patch[k]))) throw new Error('Неверный уровень фильтра контента');
          out[k] = patch[k]; break;
        case 'captionTemplate': {
          const v = String(patch[k] ?? '');
          if (v.length > 200) throw new Error('Шаблон подписи слишком длинный');
          out[k] = v; break;
        }
        case 'obsExePath': case 'obsConfigDir': {
          const v = String(patch[k] ?? '').trim();
          if (v.length > 500) throw new Error('Слишком длинный путь');
          out[k] = v; break;
        }
        default: throw new Error(`Неизвестная настройка: ${k}`);
      }
    }
  } catch (e) {
    return { ok: {}, error: (e as Error).message };
  }
  return { ok: out as Partial<Settings>, error: null };
}
