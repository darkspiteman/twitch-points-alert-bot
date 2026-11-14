import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Программа для стрима, в которой работает overlay (Browser Source).
 *
 * Streamlabs Desktop использует тот же движок Browser Source, что и OBS Studio (форк obs-browser):
 * в нём тоже есть `window.obsstudio`, звук запускается без клика, а в User-Agent есть «OBS/x.y.z»
 * и дополнительная метка «SLD» (Streamlabs Desktop). По ней программы и различаются.
 */
export type StreamApp = 'obs' | 'streamlabs';

export interface StreamAppInfo {
  /** Полное название для интерфейса. */
  name: string;
  /** Короткое название для кнопок и статусов. */
  short: string;
  /** Имя процесса для проверки «уже запущена». */
  processName: string;
}

export const STREAM_APPS: Record<StreamApp, StreamAppInfo> = {
  obs: { name: 'OBS Studio', short: 'OBS', processName: 'obs64.exe' },
  streamlabs: { name: 'Streamlabs Desktop', short: 'Streamlabs', processName: 'Streamlabs OBS.exe' },
};

export function isStreamApp(v: unknown): v is StreamApp {
  return v === 'obs' || v === 'streamlabs';
}

/** Определение программы по User-Agent Browser Source. null — обычный браузер (предпросмотр). */
export function detectStreamAppFromUA(ua: string): StreamApp | null {
  if (/\bSLD\b|Streamlabs/i.test(ua)) return 'streamlabs';
  if (/\bOBS\//i.test(ua)) return 'obs';
  return null;
}

const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const programFiles = () => [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];

export const DEFAULT_OBS_EXE = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';
export const defaultObsConfigDir = () => path.join(appData(), 'obs-studio');
export const defaultStreamlabsConfigDir = () => path.join(appData(), 'slobs-client');

/** Где обычно установлен Streamlabs Desktop (установщик позволяет выбрать другую папку). */
export function streamlabsExeCandidates(): string[] {
  const out: string[] = [];
  for (const pf of programFiles()) {
    out.push(path.join(pf, 'Streamlabs OBS', 'Streamlabs OBS.exe'));
    out.push(path.join(pf, 'Streamlabs Desktop', 'Streamlabs OBS.exe'));
    out.push(path.join(pf, 'Streamlabs Desktop', 'Streamlabs Desktop.exe'));
  }
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Streamlabs Desktop', 'Streamlabs OBS.exe'));
  return out;
}

export interface StreamAppSettings {
  streamApp: StreamApp;
  obsExePath: string;
  obsConfigDir: string;
  streamlabsExePath: string;
  streamlabsConfigDir: string;
}

/** Путь к exe выбранной программы или null, если файл не найден. Для Streamlabs пустой путь = поиск в стандартных папках. */
export function resolveExe(s: StreamAppSettings, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (s.streamApp === 'streamlabs') {
    if (s.streamlabsExePath) return exists(s.streamlabsExePath) ? s.streamlabsExePath : null;
    return streamlabsExeCandidates().find((p) => exists(p)) ?? null;
  }
  return s.obsExePath && exists(s.obsExePath) ? s.obsExePath : null;
}

/** Папка со сценами выбранной программы. */
export function scenesDir(s: StreamAppSettings): string {
  return s.streamApp === 'streamlabs'
    ? path.join(s.streamlabsConfigDir || defaultStreamlabsConfigDir(), 'SceneCollections')
    : path.join(s.obsConfigDir || defaultObsConfigDir(), 'basic', 'scenes');
}

/** Файлы сцен: OBS — *.json и *.json.bak; Streamlabs — *.json, *.json.bak и *.json.absolute.bak (manifest.json тоже). */
const SCENE_FILE = /\.json(\.bak|\.absolute\.bak)?$/i;

/** Резервная копия сцен выбранной программы. Возвращает папку копии и число файлов. */
export function backupScenes(s: StreamAppSettings, backupRoot: string, now = new Date()): { dir: string; count: number } {
  const info = STREAM_APPS[s.streamApp];
  const src = scenesDir(s);
  if (!fs.existsSync(src)) throw new Error(`Папка сцен ${info.name} не найдена: ${src}. Проверьте «Папку настроек» в разделе «Настройки».`);
  const files = fs.readdirSync(src).filter((f) => SCENE_FILE.test(f) && fs.statSync(path.join(src, f)).isFile());
  if (!files.length) throw new Error(`В папке ${src} нет файлов сцен ${info.name}`);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(backupRoot, s.streamApp === 'obs' ? stamp : `${s.streamApp}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return { dir, count: files.length };
}
