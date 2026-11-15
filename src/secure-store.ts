import fs from 'node:fs';
import { spawn } from 'node:child_process';

/** Хранилище секретов. */
export interface SecureStore {
  load(): Promise<string | null>;
  save(plain: string): Promise<void>;
  clear(): Promise<void>;
}

function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`DPAPI: PowerShell завершился с кодом ${code}: ${err.trim().slice(0, 300)}`))));
    ps.stdin.end(stdin);
  });
}

const PROTECT = `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $b = [Convert]::FromBase64String($in);
$e = [System.Security.Cryptography.ProtectedData]::Protect($b, [Text.Encoding]::UTF8.GetBytes('TwitchAlertBot'), 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($e))`;
const UNPROTECT = `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); $b = [Convert]::FromBase64String($in);
$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, [Text.Encoding]::UTF8.GetBytes('TwitchAlertBot'), 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($d))`;

/**
 * Токены шифруются Windows DPAPI (область CurrentUser): расшифровать файл может только
 * этот пользователь Windows на этом компьютере.
 */
export class DpapiStore implements SecureStore {
  private file: string;
  constructor(file: string) { this.file = file; }

  async load(): Promise<string | null> {
    if (!fs.existsSync(this.file)) return null;
    const enc = fs.readFileSync(this.file, 'utf8').trim();
    if (!enc) return null;
    const b64 = await runPowerShell(UNPROTECT, enc);
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  async save(plain: string): Promise<void> {
    const enc = await runPowerShell(PROTECT, Buffer.from(plain, 'utf8').toString('base64'));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, enc, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async clear(): Promise<void> {
    try { fs.unlinkSync(this.file); } catch { /* нет файла */ }
  }
}

/** Шифрование отдельных строк (ключи API в настройках). */
export interface Protector {
  protect(plain: string): Promise<string>;
  unprotect(enc: string): Promise<string>;
}

/** Windows DPAPI (CurrentUser): как и токены Twitch, ключи может расшифровать только этот пользователь Windows. */
export class DpapiProtector implements Protector {
  async protect(plain: string): Promise<string> { return runPowerShell(PROTECT, Buffer.from(plain, 'utf8').toString('base64')); }
  async unprotect(enc: string): Promise<string> { return Buffer.from(await runPowerShell(UNPROTECT, enc), 'base64').toString('utf8'); }
}

/** Для тестов: обратимое преобразование без DPAPI (в базе всё равно не открытый текст). */
export class TestProtector implements Protector {
  async protect(plain: string): Promise<string> { return Buffer.from('test:' + plain, 'utf8').toString('base64'); }
  async unprotect(enc: string): Promise<string> {
    const s = Buffer.from(enc, 'base64').toString('utf8');
    if (!s.startsWith('test:')) throw new Error('не расшифровывается');
    return s.slice(5);
  }
}

/** Хранилище в памяти — только для тестов. */
export class MemoryStore implements SecureStore {
  value: string | null = null;
  saves = 0;
  async load() { return this.value; }
  async save(v: string) { this.value = v; this.saves++; }
  async clear() { this.value = null; }
}
