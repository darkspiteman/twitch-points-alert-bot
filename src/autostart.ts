import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { APP_ROOT, APP_NAME } from './config.ts';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function reg(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout) }));
  });
}

export function launcherPath(): string {
  return path.join(APP_ROOT, `${APP_NAME}.exe`);
}

export async function getAutostart(): Promise<boolean> {
  const r = await reg(['query', RUN_KEY, '/v', APP_NAME]);
  return r.code === 0 && r.out.includes(APP_NAME);
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (enabled) {
    const exe = launcherPath();
    if (!fs.existsSync(exe)) throw new Error('Лаунчер TwitchAlertBot.exe не найден. Запустите установку (install.cmd).');
    const r = await reg(['add', RUN_KEY, '/v', APP_NAME, '/t', 'REG_SZ', '/d', `"${exe}" --autostart`, '/f']);
    if (r.code !== 0) throw new Error('Не удалось включить автозапуск');
  } else {
    await reg(['delete', RUN_KEY, '/v', APP_NAME, '/f']);
  }
}
