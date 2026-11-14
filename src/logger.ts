import fs from 'node:fs';
import path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Значения, которые никогда не должны попасть в лог (токены). Пополняется модулем авторизации. */
const secrets = new Set<string>();
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

const PATTERNS: RegExp[] = [
  /("?(?:access_token|refresh_token|device_code|client_secret|code)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
  /(Authorization:\s*(?:Bearer|OAuth)\s+)\S+/gi,
  /(oauth:)[a-z0-9]+/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('***');
  for (const re of PATTERNS) out = out.replace(re, '$1***');
  return out;
}

export interface LogEntry { ts: number; level: Level; scope: string; msg: string }
type Listener = (e: LogEntry) => void;

export class Logger {
  private stream: fs.WriteStream | null = null;
  private currentDay = '';
  private listeners = new Set<Listener>();
  private logDir: string | null;
  private minLevel: Level;
  private keepDays: number;
  private console: boolean;

  constructor(opts: { logDir?: string | null; minLevel?: Level; keepDays?: number; console?: boolean } = {}) {
    this.logDir = opts.logDir ?? null;
    this.minLevel = opts.minLevel ?? 'info';
    this.keepDays = opts.keepDays ?? 14;
    this.console = opts.console ?? true;
  }

  onEntry(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  child(scope: string): ScopedLogger { return new ScopedLogger(this, scope); }

  write(level: Level, scope: string, msg: string, extra?: unknown): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    let text = msg;
    if (extra !== undefined) {
      if (extra instanceof Error) text += ` | ${extra.message}`;
      else { try { text += ` | ${JSON.stringify(extra)}`; } catch { text += ' | [unserializable]'; } }
    }
    text = redact(text);
    const entry: LogEntry = { ts: Date.now(), level, scope, msg: text };
    const line = `${new Date(entry.ts).toISOString()} [${level.toUpperCase()}] ${scope}: ${text}`;
    if (this.console) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    this.toFile(line);
    for (const l of this.listeners) { try { l(entry); } catch { /* слушатель не должен ломать логгер */ } }
  }

  private toFile(line: string): void {
    if (!this.logDir) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (day !== this.currentDay || !this.stream) {
        this.stream?.end();
        this.currentDay = day;
        this.stream = fs.createWriteStream(path.join(this.logDir, `bot-${day}.log`), { flags: 'a' });
        this.stream.on('error', () => { this.stream = null; });
        this.cleanup();
      }
      this.stream.write(line + '\n');
    } catch { /* запись лога не должна ронять приложение */ }
  }

  private cleanup(): void {
    if (!this.logDir) return;
    try {
      const cutoff = Date.now() - this.keepDays * 86400_000;
      for (const f of fs.readdirSync(this.logDir)) {
        if (!/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const full = path.join(this.logDir, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch { /* ignore */ }
  }

  close(): Promise<void> {
    return new Promise((resolve) => { if (!this.stream) return resolve(); this.stream.end(() => resolve()); this.stream = null; });
  }
}

export class ScopedLogger {
  private root: Logger;
  private scope: string;
  constructor(root: Logger, scope: string) { this.root = root; this.scope = scope; }
  debug(msg: string, extra?: unknown) { this.root.write('debug', this.scope, msg, extra); }
  info(msg: string, extra?: unknown) { this.root.write('info', this.scope, msg, extra); }
  warn(msg: string, extra?: unknown) { this.root.write('warn', this.scope, msg, extra); }
  error(msg: string, extra?: unknown) { this.root.write('error', this.scope, msg, extra); }
}
