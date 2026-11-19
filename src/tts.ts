import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ScopedLogger } from './logger.ts';
import { PROFANITY, BEEP, LINK_WORD, DEFAULT_NAME } from './tts-words.ts';

/**
 * Озвучка текста зрителя (1.7.0): голоса Windows (OneCore — те же, что в «Параметры → Время и язык → Речь»).
 * Синтез — через Windows PowerShell 5.1 и WinRT Windows.Media.SpeechSynthesis, без интернета и сторонних программ.
 * Текст передаётся через stdin (UTF-8), а не в командной строке: никаких подстановок в команду.
 */

export interface TtsVoice { id: string; name: string; lang: string }

export interface TtsTextOptions {
  template: string;
  maxChars: number;
  filter: boolean;
  bannedWords: string;
}

function wordRegex(roots: string[]): RegExp | null {
  if (!roots.length) return null;
  // Слово, в котором встречается корень (буквы, цифры, «*» — частая маскировка).
  return new RegExp(`[\\p{L}\\p{N}*]*(?:${roots.join('|')})[\\p{L}\\p{N}*]*`, 'giu');
}
const PROFANITY_RE = wordRegex(PROFANITY)!;

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Текст для озвучки: подстановка в шаблон, ссылки, мат, повторы, длина. Пустая строка — читать нечего. */
export function ttsText(user: string, input: string, o: TtsTextOptions): string {
  let t = String(input ?? '').normalize('NFC');
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ');
  // Ссылки не читаем: LINK_WORD.
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/giu, ` ${LINK_WORD} `);
  t = t.replace(/\b[\p{L}\p{N}-]+\.(?:ru|com|net|org|tv|gg|io|me|su|рф|xyz|ly|be|co)(?:\/\S*)?/giu, ` ${LINK_WORD} `);
  // Повторы: «аааааа» → «ааа», «!!!!!!» → «!!!».
  t = t.replace(/(.)\1{3,}/gu, '$1$1$1');
  if (o.filter) t = t.replace(PROFANITY_RE, BEEP);
  const banned = o.bannedWords.split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2).map(escapeRe);
  const bannedRe = wordRegex(banned);
  if (bannedRe) t = t.replace(bannedRe, BEEP);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const max = Math.max(20, o.maxChars);
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
  }
  let name = String(user ?? '').replace(/_/g, ' ').trim();
  if (o.filter) name = name.replace(PROFANITY_RE, BEEP);
  const tpl = o.template.includes('{text}') ? o.template : '{user}: {text}';
  return tpl.replaceAll('{user}', name || DEFAULT_NAME).replaceAll('{text}', t).replace(/\s+/g, ' ').trim();
}

// ---------------- Синтез ----------------

/** Скрипт PowerShell (только ASCII: Windows PowerShell 5.1 читает файл без BOM в кодировке ANSI). */
const SCRIPT = String.raw`param([string]$Mode = 'synth', [string]$Out = '', [string]$Voice = '', [double]$Rate = 1.0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
if ($Mode -eq 'list') {
  foreach ($v in $all) { [Console]::Out.WriteLine(($v.Id + "` + '\t' + String.raw`" + $v.DisplayName + "` + '\t' + String.raw`" + $v.Language)) }
  exit 0
}
$ms = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
$text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$pick = $all | Where-Object { $_.Id -eq $Voice } | Select-Object -First 1
if (-not $pick) { $pick = $all | Where-Object { $_.Language -like 'ru*' } | Select-Object -First 1 }
if ($pick) { $synth.Voice = $pick }
try { $synth.Options.SpeakingRate = [Math]::Max(0.5, [Math]::Min(3.0, $Rate)) } catch { }
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$size = [uint32]$stream.Size
$null = Await ($reader.LoadAsync($size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($Out, $bytes)
[Console]::Out.WriteLine('ok')
`;

export type RunFn = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface TtsEngineOptions {
  /** Папка для скрипта и готовых файлов (data\tts). */
  dir: string;
  log: ScopedLogger;
  /** Подмена запуска PowerShell (тесты). */
  run?: RunFn;
}

export class TtsEngine {
  private o: TtsEngineOptions;
  private voicesCache: TtsVoice[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: TtsEngineOptions) { this.o = o; }

  /** Голоса работают только в Windows. */
  get available(): boolean { return process.platform === 'win32' || !!this.o.run; }

  private scriptPath(): string {
    fs.mkdirSync(this.o.dir, { recursive: true });
    const p = path.join(this.o.dir, 'synth.ps1');
    try { if (fs.readFileSync(p, 'utf8') === SCRIPT) return p; } catch { /* нет файла */ }
    fs.writeFileSync(p, SCRIPT, 'ascii');
    return p;
  }

  private run(args: string[], stdin: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.o.run) return this.o.run(args, stdin, timeoutMs);
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve) => {
      const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath(), ...args], { windowsHide: true });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, timeoutMs);
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
      p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
      p.stdin.on('error', () => { /* процесс завершился раньше */ });
      p.stdin.end(Buffer.from(stdin, 'utf8'));
    });
  }

  /** Голоса Windows (кэшируются; refresh — перечитать). */
  async voices(refresh = false): Promise<TtsVoice[]> {
    if (!this.available) return [];
    if (this.voicesCache && !refresh) return this.voicesCache;
    const r = await this.run(['-Mode', 'list'], '', 20_000);
    if (r.code !== 0) { this.o.log.warn(`Голоса Windows не получены: ${r.stderr.trim().slice(0, 300)}`); return this.voicesCache ?? []; }
    this.voicesCache = r.stdout.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 3 && p[0])
      .map(([id, name, lang]) => ({ id: id.trim(), name: name.trim(), lang: lang.trim() }));
    return this.voicesCache;
  }

  /** Озвучить текст в WAV. Возвращает имя файла в папке dir. Запросы идут по одному. */
  synth(text: string, voice: string, ratePct: number): Promise<string> {
    const job = this.chain.then(async () => {
      if (!this.available) throw new Error('Озвучка работает только в Windows');
      const name = crypto.randomBytes(8).toString('hex') + '.wav';
      const out = path.join(this.o.dir, name);
      fs.mkdirSync(this.o.dir, { recursive: true });
      const safeVoice = /^[\w\\\-. {}]{0,200}$/.test(voice) ? voice : '';
      const r = await this.run(['-Mode', 'synth', '-Out', out, '-Voice', safeVoice, '-Rate', String(Math.max(50, Math.min(300, ratePct)) / 100)], text, 30_000);
      if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Не удалось озвучить текст: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0]?.slice(0, 200) || 'код ' + r.code}`);
      return name;
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  /** Удалить старые файлы озвучки. */
  cleanup(maxAgeMs = 3600_000): void {
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(this.o.dir)) {
        if (!/^[a-f0-9]{16}\.wav$/.test(f)) continue;
        const p = path.join(this.o.dir, f);
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
      }
    } catch { /* папки ещё нет */ }
  }
}

/** Длительность WAV по заголовку (байт в секунду из «fmt », размер «data»). 0 — не удалось прочитать. */
export function wavDurationMs(file: string): number {
  try {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let p = 12, byteRate = 0, data = 0;
    while (p + 8 <= b.length) {
      const id = b.toString('ascii', p, p + 4);
      const size = b.readUInt32LE(p + 4);
      if (id === 'fmt ') byteRate = b.readUInt32LE(p + 16);
      if (id === 'data') { data = Math.min(size, b.length - p - 8); break; }
      p += 8 + size + (size % 2);
    }
    return byteRate > 0 ? Math.round((data / byteRate) * 1000) : 0;
  } catch { return 0; }
}
