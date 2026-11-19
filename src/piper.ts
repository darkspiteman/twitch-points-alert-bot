import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { safeDownload, DownloadError, type Transport } from './net/safe-download.ts';
import { readZip } from './net/zip.ts';
import type { ScopedLogger } from './logger.ts';

/**
 * Голоса Piper (1.8.0): нейросетевая озвучка без интернета. Скачиваются по кнопке в панели с фиксированных адресов
 * и проверяются по SHA-256 / git-хешу — подменённый файл не установится.
 *
 * Только голоса, которые можно использовать на стриме: Дмитрий и Денис — CC0 (общественное достояние,
 * github.com/OHF-Voice/voice-datasets). Ирина (лицензия не указана) и Руслан (CC BY-NC-SA — только некоммерческое) — нет.
 *
 * Программа — rhasspy/piper 2023.11.14-2 (MIT, последняя готовая сборка для Windows). Эти голоса обучены для Piper 1.5:
 * в их настройках есть английские дифтонги из двух символов («aɪ», «eɪ»…), которых старая программа не понимает.
 * Русская речь их не использует (в обучении — 0–1 раз), поэтому при установке они убираются из настроек голоса.
 */

const REV = '42301ec547bc2939386cf0ae9f9050ca05b1d3af';
const HF = `https://huggingface.co/rhasspy/piper-voices/resolve/${REV}/ru/ru_RU`;
/** Зеркало Hugging Face: если основной сайт недоступен (бывает, что его блокирует провайдер). Файлы всё равно сверяются по хешам. */
const HF_MIRROR = `https://hf-mirror.com/rhasspy/piper-voices/resolve/${REV}/ru/ru_RU`;

export const PIPER_ZIP = {
  url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea', size: 22477236,
};

export interface PiperVoiceDef { key: string; name: string; onnx: { sha256: string; size: number }; json: { gitSha1: string; size: number } }

export const PIPER_VOICES: PiperVoiceDef[] = [
  { key: 'ru_RU-dmitri-medium', name: 'Дмитрий', onnx: { sha256: '9ed9941bac7373f2ec1be36627e0e71a349a59ca5522d4363fd50701db05193a', size: 63221984 }, json: { gitSha1: 'df277a2725f068d0c4fceb79c32b8d682defc891', size: 6197 } },
  { key: 'ru_RU-denis-medium', name: 'Денис', onnx: { sha256: '879bc365cb14d1380e3f5ed6044162ccf54c99f6161871569b7f830aec3ce841', size: 63221984 }, json: { gitSha1: '59da8d82e1416c9b53095278419c410ad2ed324b', size: 6196 } },
];

/** Примерный размер загрузки, МБ (для подсказки в панели). */
export const PIPER_DOWNLOAD_MB = Math.round((PIPER_ZIP.size + PIPER_VOICES.reduce((a, v) => a + v.onnx.size, 0)) / 1024 / 1024);

const ALLOW = (h: string) => h === 'github.com' || h.endsWith('.githubusercontent.com') || h === 'huggingface.co' || h.endsWith('.huggingface.co') || h.endsWith('.hf.co') || h === 'hf-mirror.com' || h.endsWith('.hf-mirror.com');

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Хеш git (blob) — им Hugging Face помечает небольшие файлы. */
const gitSha1 = (b: Buffer) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');

/** Убрать из настроек голоса фонемы из нескольких символов (их не понимает Piper для Windows 2023 года). */
export function patchVoiceConfig(json: string): string {
  const j = JSON.parse(json) as { phoneme_id_map?: Record<string, number[]> };
  for (const k of Object.keys(j.phoneme_id_map ?? {})) if ([...k].length > 1) delete j.phoneme_id_map![k];
  return JSON.stringify(j);
}

export interface PiperStatus {
  installed: boolean; busy: boolean; step: string; error: string; voices: string[]; sizeMb: number;
  /** Для ручной установки: куда положить файлы и откуда их скачать. */
  folder: string; links: Array<{ name: string; url: string }>;
}

export interface PiperOptions {
  dir: string; log: ScopedLogger; transport?: Transport;
  /** Подмена набора файлов (тесты). */
  zip?: typeof PIPER_ZIP; voices?: PiperVoiceDef[]; base?: string; mirrors?: string[];
}

export class PiperInstaller extends EventEmitter {
  private o: PiperOptions;
  private busy = false;
  private step = '';
  private error = '';

  constructor(o: PiperOptions) { super(); this.o = o; }

  get exe(): string { return path.join(this.o.dir, 'piper', 'piper.exe'); }
  model(key: string): string { return path.join(this.o.dir, 'voices', `${key}.onnx`); }

  /** Установленные голоса (есть и модель, и её настройки). */
  installedVoices(): PiperVoiceDef[] {
    if (!fs.existsSync(this.exe)) return [];
    return (this.o.voices ?? PIPER_VOICES).filter((v) => fs.existsSync(this.model(v.key)) && fs.existsSync(this.model(v.key) + '.json'));
  }

  status(): PiperStatus {
    const voices = this.installedVoices();
    const base = this.bases()[0];
    const links = (this.o.voices ?? PIPER_VOICES).flatMap((v) => [
      { name: `${v.key}.onnx`, url: `${base}/${v.key.split('-')[1]}/medium/${v.key}.onnx?download=true` },
      { name: `${v.key}.onnx.json`, url: `${base}/${v.key.split('-')[1]}/medium/${v.key}.onnx.json?download=true` },
    ]);
    return { installed: voices.length > 0, busy: this.busy, step: this.step, error: this.error, voices: voices.map((v) => v.name), sizeMb: PIPER_DOWNLOAD_MB, folder: path.join(this.o.dir, 'voices'), links };
  }

  /** Дождаться конца установки (тесты). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
  }

  private set(step: string): void { this.step = step; this.emit('status', this.status()); }

  /** Скачать программу и голоса (в фоне; ход — событие 'status'). */
  install(): void {
    if (this.busy) return;
    if (process.platform !== 'win32' && !this.o.transport) { this.error = 'Голоса Piper работают только в Windows'; this.emit('status', this.status()); return; }
    this.busy = true; this.error = '';
    this.run().catch((e) => {
      this.error = (e as Error).message;
      this.o.log.warn('Piper: установка не удалась', e);
    }).finally(() => { this.busy = false; this.set(''); });
  }

  private bases(): string[] { return this.o.base ? [this.o.base, ...(this.o.mirrors ?? [])] : [HF, HF_MIRROR]; }

  /** Файл голоса: основной сайт, при сбое связи — зеркало. */
  private async getVoiceFile(rel: string, size: number): Promise<Buffer> {
    let last: unknown = null;
    for (const b of this.bases()) {
      try { return await this.get(`${b}/${rel}`, size); } catch (e) {
        last = e;
        this.o.log.warn(`Piper: ${new URL(b).host} недоступен: ${(e as Error).message} ${(e as DownloadError).detail ?? ''}`);
        if (!(e instanceof DownloadError) || !['network', 'timeout', 'http'].includes(e.code)) throw e;
      }
    }
    if (last instanceof DownloadError && (last.code === 'network' || last.code === 'timeout')) {
      throw new Error('Сайт с голосами (Hugging Face) недоступен — возможно, его блокирует провайдер. Включите VPN и нажмите «Скачать» ещё раз или скачайте файлы вручную (ссылки ниже).');
    }
    throw last as Error;
  }

  private async get(url: string, size: number): Promise<Buffer> {
    const r = await safeDownload(url, { maxBytes: size + 1024, timeoutMs: 600_000, transport: this.o.transport, allowHost: ALLOW });
    return r.data;
  }

  private async run(): Promise<void> {
    fs.mkdirSync(path.join(this.o.dir, 'voices'), { recursive: true });
    const zipDef = this.o.zip ?? PIPER_ZIP;
    if (!fs.existsSync(this.exe)) {
      this.set('Скачиваю программу Piper…');
      const zip = await this.get(zipDef.url, zipDef.size);
      if (sha256(zip) !== zipDef.sha256) throw new Error('Файл Piper не совпадает с ожидаемым — установка отменена');
      this.set('Распаковываю Piper…');
      const tmp = path.join(this.o.dir, 'piper.tmp');
      fs.rmSync(tmp, { recursive: true, force: true });
      for (const e of readZip(zip, { maxEntries: 2000, maxTotalBytes: 200 * 1024 * 1024 })) {
        // Внутри архива всё лежит в папке piper/; readZip уже отбрасывает «../» и абсолютные пути.
        if (!e.name.startsWith('piper/') || e.name.endsWith('/')) continue;
        const out = path.join(tmp, e.name);
        if (!out.startsWith(tmp + path.sep)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.data);
      }
      if (!fs.existsSync(path.join(tmp, 'piper', 'piper.exe'))) throw new Error('В архиве Piper нет piper.exe');
      fs.rmSync(path.join(this.o.dir, 'piper'), { recursive: true, force: true });
      fs.renameSync(path.join(tmp, 'piper'), path.join(this.o.dir, 'piper'));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    for (const v of this.o.voices ?? PIPER_VOICES) {
      const onnxPath = this.model(v.key), jsonPath = onnxPath + '.json';
      const rel = `${v.key.split('-')[1]}/medium/${v.key}`;
      // Файлы, положенные вручную (или от прошлой установки), проверяются так же строго, как скачанные.
      let json: Buffer | null = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath) : null;
      if (json && gitSha1(json) !== v.json.gitSha1 && !isPatchedOf(json)) { fs.rmSync(jsonPath, { force: true }); json = null; }
      let onnxOk = fs.existsSync(onnxPath) && fs.statSync(onnxPath).size === v.onnx.size && sha256(fs.readFileSync(onnxPath)) === v.onnx.sha256;
      if (!onnxOk && fs.existsSync(onnxPath)) { fs.rmSync(onnxPath, { force: true }); this.o.log.warn(`Piper: файл голоса «${v.name}» не совпал с ожидаемым — скачаю заново`); }
      if (json && onnxOk) { if (!isPatchedOf(json)) fs.writeFileSync(jsonPath, patchVoiceConfig(json.toString('utf8'))); continue; }
      this.set(`Скачиваю голос «${v.name}»…`);
      if (!json) {
        json = await this.getVoiceFile(`${rel}.onnx.json`, v.json.size);
        if (gitSha1(json) !== v.json.gitSha1) throw new Error(`Настройки голоса «${v.name}» не совпадают с ожидаемыми — установка отменена`);
      }
      if (!onnxOk) {
        const onnx = await this.getVoiceFile(`${rel}.onnx`, v.onnx.size);
        if (sha256(onnx) !== v.onnx.sha256) throw new Error(`Файл голоса «${v.name}» не совпадает с ожидаемым — установка отменена`);
        fs.writeFileSync(onnxPath + '.tmp', onnx);
        fs.renameSync(onnxPath + '.tmp', onnxPath);
        onnxOk = true;
      }
      fs.writeFileSync(jsonPath, isPatchedOf(json) ? json : patchVoiceConfig(json.toString('utf8')));
    }
    this.o.log.info('Piper: голоса установлены');
  }

  /** Удалить Piper и голоса (освободить место). */
  remove(): void {
    if (this.busy) throw new Error('Идёт установка — подождите');
    fs.rmSync(path.join(this.o.dir, 'piper'), { recursive: true, force: true });
    fs.rmSync(path.join(this.o.dir, 'voices'), { recursive: true, force: true });
    this.emit('status', this.status());
  }
}

/** Настройки голоса уже исправлены ботом (нет фонем из нескольких символов). */
function isPatchedOf(json: Buffer): boolean {
  try {
    const j = JSON.parse(json.toString('utf8')) as { phoneme_id_map?: Record<string, number[]> };
    return !!j.phoneme_id_map && Object.keys(j.phoneme_id_map).every((k) => [...k].length === 1);
  } catch { return false; }
}

export const _hash = { sha256, gitSha1 };
