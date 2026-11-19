import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Lang, LANGUAGES } from './i18n.ts';
import { OVERLAY_FIELDS } from './stats.ts';
import { type StreamApp, isStreamApp, DEFAULT_OBS_EXE, defaultObsConfigDir, defaultStreamlabsConfigDir } from './stream-app.ts';

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
  /** Программа для стрима: OBS Studio или Streamlabs Desktop (кнопка запуска, резервная копия сцен, подсказки). */
  streamApp: StreamApp;
  obsExePath: string;
  obsConfigDir: string;
  /** Путь к Streamlabs Desktop; пустая строка — искать в стандартных папках. */
  streamlabsExePath: string;
  streamlabsConfigDir: string;
  /** Запускать выбранную программу для стрима при автозапуске бота (имя сохранено ради совместимости). */
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
  /** Язык панели и сообщений: '' — ещё не выбран (панель подскажет по языку браузера и сохранит выбор). */
  language: '' | Lang;
  /** Порт OBS WebSocket; 0 — взять из настроек OBS (plugin_config/obs-websocket/config.json). */
  obsWsPort: number;
  /** Пароль OBS WebSocket; пустая строка — взять из настроек OBS. В базе — зашифрован. */
  obsWsPassword: string;
  /** Overlay статистики: какие показатели, через запятую (см. OVERLAY_FIELDS в stats.ts). */
  statsOverlayFields: string;
  statsOverlayLayout: 'row' | 'column';
  statsOverlayStyle: 'dark' | 'light' | 'clear' | 'twitch';
  statsOverlayLabels: boolean;
  /** Масштаб overlay статистики, %. */
  statsOverlayScale: number;
  /** 1.7.0: озвучка текста зрителя — голос Windows (id; пусто — первый русский), скорость %, громкость %. */
  ttsVoice: string;
  ttsRate: number;
  ttsVolume: number;
  /** Что читать: {user} — ник, {text} — текст зрителя. */
  ttsTemplate: string;
  ttsMaxChars: number;
  /** Заменять мат на «пи-ип». */
  ttsFilter: boolean;
  /** Свои запрещённые слова через запятую. */
  ttsBannedWords: string;
  /** 1.7.0: награды бота доступны только во время эфира (вне эфира — на паузе в Twitch). */
  rewardsOnlyLive: boolean;
  /** 1.7.0: шаутаут рейдеру автоматически. */
  autoShoutout: boolean;
}

export const SECRET_SETTINGS = ['klipyApiKey', 'freesoundApiKey', 'obsWsPassword'] as const;
/** Признак зашифрованного ключа в базе: «enc:<DPAPI в base64>». */
export const ENC_PREFIX = 'enc:';

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
    maxDurationMs: 300000,
    showCaption: true,
    captionTemplate: '{user}: {reward}',
    overlayPosition: 'center',
    overlayMaxWidthPct: 60,
    overlayMaxHeightPct: 60,
    streamApp: 'obs',
    obsExePath: DEFAULT_OBS_EXE,
    obsConfigDir: defaultObsConfigDir(),
    streamlabsExePath: '',
    streamlabsConfigDir: defaultStreamlabsConfigDir(),
    launchObsWithBot: false,
    historyRetentionDays: 30,
    recoverMissed: true,
    manageRedemptionStatus: true,
    audioOnly: false,
    klipyApiKey: '',
    freesoundApiKey: '',
    klipyContentFilter: 'medium',
    autoUpdateCheck: true,
    language: '',
    obsWsPort: 0,
    obsWsPassword: '',
    statsOverlayFields: 'session,viewers,chatters,followers,bitrate',
    statsOverlayLayout: 'row',
    statsOverlayStyle: 'dark',
    statsOverlayLabels: true,
    statsOverlayScale: 100,
    ttsVoice: '',
    ttsRate: 100,
    ttsVolume: 100,
    ttsTemplate: '{user} пишет: {text}',
    ttsMaxChars: 200,
    ttsFilter: true,
    ttsBannedWords: '',
    rewardsOnlyLive: false,
    autoShoutout: false,
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
        case 'maxDurationMs': num(k, 1000, 3600000); break;
        case 'overlayMaxWidthPct': num(k, 5, 100); break;
        case 'overlayMaxHeightPct': num(k, 5, 100); break;
        case 'historyRetentionDays': num(k, 1, 3650); break;
        case 'obsWsPort': if (Number(patch[k]) !== 0) num(k, 1024, 65535); else out[k] = 0; break;
        case 'statsOverlayScale': num(k, 50, 300); break;
        case 'ttsRate': num(k, 50, 300); break;
        case 'ttsVolume': num(k, 0, 100); break;
        case 'ttsMaxChars': num(k, 20, 500); break;
        case 'ttsVoice': {
          const v = String(patch[k] ?? '');
          if (v.length > 200 || !/^[\w\\\-. {}]*$/.test(v)) throw new Error('Неверный голос озвучки');
          out[k] = v; break;
        }
        case 'ttsTemplate': {
          const v = String(patch[k] ?? '').trim();
          if (v.length > 100) throw new Error('Шаблон озвучки слишком длинный');
          if (!v.includes('{text}')) throw new Error('В шаблоне озвучки должно быть {text} — текст зрителя');
          out[k] = v; break;
        }
        case 'ttsBannedWords': {
          const v = String(patch[k] ?? '');
          if (v.length > 2000) throw new Error('Список запрещённых слов слишком длинный');
          out[k] = v; break;
        }
        case 'obsWsPassword': {
          const v = String(patch[k] ?? '');
          if (v.length > 200 || /[\r\n]/.test(v)) throw new Error('Пароль OBS WebSocket выглядит неверно');
          out[k] = v; break;
        }
        case 'statsOverlayFields': {
          const list = String(patch[k] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
          if (list.some((f) => !(OVERLAY_FIELDS as readonly string[]).includes(f))) throw new Error('Неизвестный показатель overlay статистики');
          out[k] = [...new Set(list)].join(','); break;
        }
        case 'statsOverlayLayout':
          if (patch[k] !== 'row' && patch[k] !== 'column') throw new Error('Неверное расположение overlay статистики');
          out[k] = patch[k]; break;
        case 'statsOverlayStyle':
          if (!['dark', 'light', 'clear', 'twitch'].includes(String(patch[k]))) throw new Error('Неверный стиль overlay статистики');
          out[k] = patch[k]; break;
        case 'mode':
          if (patch[k] !== 'active' && patch[k] !== 'observe') throw new Error('Неверный режим работы');
          out[k] = patch[k]; break;
        case 'overlayPosition': {
          const allowed = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
          if (!allowed.includes(String(patch[k]))) throw new Error('Неверное положение overlay');
          out[k] = patch[k]; break;
        }
        case 'allowManageRewards': case 'showCaption': case 'launchObsWithBot': case 'recoverMissed': case 'manageRedemptionStatus': case 'audioOnly': case 'autoUpdateCheck': case 'statsOverlayLabels': case 'ttsFilter': case 'rewardsOnlyLive': case 'autoShoutout':
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
        case 'language':
          if (!(LANGUAGES as readonly unknown[]).includes(patch[k])) throw new Error('Неверный язык: выберите русский или английский');
          out[k] = patch[k]; break;
        case 'streamApp':
          if (!isStreamApp(patch[k])) throw new Error('Неверная программа для стрима: выберите OBS Studio или Streamlabs Desktop');
          out[k] = patch[k]; break;
        case 'obsExePath': case 'obsConfigDir': case 'streamlabsExePath': case 'streamlabsConfigDir': {
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
