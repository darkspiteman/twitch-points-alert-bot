import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { PiperInstaller, patchVoiceConfig, PIPER_VOICES, _hash, type PiperVoiceDef } from '../src/piper.ts';
import { TtsEngine, chooseVoice, type RunFn } from '../src/tts.ts';
import type { Transport } from '../src/net/safe-download.ts';
import { log, tmpDir, waitFor } from './helpers.ts';

// 1.8.0: голоса Piper — загрузка с проверкой хешей, распаковка, исправление настроек голоса, озвучка.

/** ZIP без сжатия. */
function makeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = []; const cens: Buffer[] = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, nameBuf, data); cens.push(cen, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(cens); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const VOICE_JSON = JSON.stringify({ espeak: { voice: 'ru' }, phoneme_id_map: { a: [1], 'aɪ': [161], 'eɪ': [164], b: [2] } });

function fixture(opts: { badOnnx?: boolean; evil?: boolean } = {}) {
  const zip = makeZip({ 'piper/piper.exe': Buffer.from('MZ fake'), 'piper/espeak-ng-data/ru_dict': Buffer.from('dict'), ...(opts.evil ? { '../evil.txt': Buffer.from('x') } : {}) });
  const onnx = Buffer.from('fake onnx model');
  const json = Buffer.from(VOICE_JSON);
  const voice: PiperVoiceDef = { key: 'ru_RU-dmitri-medium', name: 'Дмитрий', onnx: { sha256: _hash.sha256(onnx), size: onnx.length }, json: { gitSha1: _hash.gitSha1(json), size: json.length } };
  const files: Record<string, Buffer> = {
    'https://github.com/test/piper.zip': zip,
    'https://huggingface.co/v/dmitri/medium/ru_RU-dmitri-medium.onnx': opts.badOnnx ? Buffer.from('tampered model!') : onnx,
    'https://huggingface.co/v/dmitri/medium/ru_RU-dmitri-medium.onnx.json': json,
  };
  const asked: string[] = [];
  const transport: Transport = async (url) => {
    asked.push(url.href);
    const body = files[url.href];
    return body ? { status: 200, headers: {}, body: Readable.from([body]) } : { status: 404, headers: {}, body: Readable.from([]) };
  };
  return {
    asked, voice,
    opts: { transport, zip: { url: 'https://github.com/test/piper.zip', sha256: _hash.sha256(zip), size: zip.length }, voices: [voice], base: 'https://huggingface.co/v' },
  };
}

test('настройки голоса: английские дифтонги из двух символов убираются, остальное не меняется', () => {
  const out = JSON.parse(patchVoiceConfig(VOICE_JSON));
  assert.deepEqual(out.phoneme_id_map, { a: [1], b: [2] });
  assert.equal(out.espeak.voice, 'ru');
  assert.deepEqual(PIPER_VOICES.map((v) => v.key), ['ru_RU-dmitri-medium', 'ru_RU-denis-medium'], 'только голоса с лицензией CC0');
});

test('установка Piper: хеши сходятся — программа и голос на месте, настройки голоса исправлены', async () => {
  const dir = tmpDir();
  const f = fixture();
  const p = new PiperInstaller({ dir, log, ...f.opts });
  assert.equal(p.status().installed, false);
  p.install();
  await waitFor(() => !p.status().busy, 5000);
  assert.equal(p.status().error, '');
  assert.equal(p.status().installed, true);
  assert.deepEqual(p.status().voices, ['Дмитрий']);
  assert.ok(fs.existsSync(path.join(dir, 'piper', 'piper.exe')));
  assert.ok(fs.existsSync(path.join(dir, 'piper', 'espeak-ng-data', 'ru_dict')));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p.model('ru_RU-dmitri-medium') + '.json', 'utf8')).phoneme_id_map), ['a', 'b']);
  // Повторная установка ничего не скачивает.
  const before = f.asked.length;
  p.install(); await waitFor(() => !p.status().busy, 5000);
  assert.equal(f.asked.length, before);
  p.remove();
  assert.equal(p.status().installed, false);
});

test('установка Piper: архив с путём «../» — отказ, ничего не распаковано', async () => {
  const dir = tmpDir();
  const p = new PiperInstaller({ dir, log, ...fixture({ evil: true }).opts });
  p.install();
  await waitFor(() => !p.status().busy, 5000);
  assert.match(p.status().error, /Недопустимый путь/);
  assert.ok(!fs.existsSync(path.join(dir, 'piper', 'piper.exe')) && !fs.existsSync(path.join(path.dirname(dir), 'evil.txt')));
});

test('установка Piper: подменённый файл голоса — установка отменена, голос не появляется', async () => {
  const dir = tmpDir();
  const f = fixture({ badOnnx: true });
  const p = new PiperInstaller({ dir, log, ...f.opts });
  p.install();
  await waitFor(() => !p.status().busy, 5000);
  assert.match(p.status().error, /не совпадает с ожидаемым/);
  assert.equal(p.status().installed, false);
  assert.ok(!fs.existsSync(p.model('ru_RU-dmitri-medium')));
});

test('озвучка голосом Piper: голос в списке, [Дмитрий] выбирает его, скорость → length_scale, текст через stdin', async () => {
  const dir = tmpDir();
  const f = fixture();
  const p = new PiperInstaller({ dir: path.join(dir, 'piper'), log, ...f.opts });
  p.install(); await waitFor(() => !p.status().busy, 5000);
  const calls: Array<{ args: string[]; stdin: string }> = [];
  const runPiper: RunFn = async (args, stdin) => { calls.push({ args, stdin }); fs.writeFileSync(args[args.indexOf('-f') + 1], Buffer.from('RIFF')); return { code: 0, stdout: '', stderr: '' }; };
  const runWin: RunFn = async (args) => (args.includes('list') ? { code: 0, stdout: 'IR\tMicrosoft Irina\tru-RU\r\n', stderr: '' } : { code: 1, stdout: '', stderr: 'не должно вызываться' });
  const e = new TtsEngine({ dir: path.join(dir, 'tts'), log, run: runWin, piper: p, runPiper });
  const voices = await e.voices();
  assert.deepEqual(voices.map((v) => v.id), ['piper:ru_RU-dmitri-medium', 'IR']);
  assert.equal(voices[0].name, 'Дмитрий (Piper)');
  const id = chooseVoice(voices, { lang: 'ru', alias: 'дмитрий' }, { ttsVoice: 'IR', ttsVoiceEn: '' });
  assert.equal(id, 'piper:ru_RU-dmitri-medium');
  const name = await e.synth('Привет, стрим!', id, 125);
  assert.match(name, /^[a-f0-9]{16}\.wav$/);
  assert.equal(calls[0].stdin, 'Привет, стрим!');
  assert.equal(calls[0].args[calls[0].args.indexOf('-m') + 1], p.model('ru_RU-dmitri-medium'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--length_scale') + 1], '0.8', 'скорость 125 % → length_scale 0.8');
  // Голос удалили — читает голос Windows, а не падает.
  p.remove();
  await assert.rejects(e.synth('ещё', id, 100), /не должно вызываться/);
});

test('установка Piper: основной сайт голосов недоступен — берёт с зеркала; файлы, положенные вручную, проверяются и не скачиваются', async () => {
  // Зеркало: основной адрес «не отвечает», зеркало отдаёт те же файлы.
  const dir = tmpDir();
  const f = fixture();
  const inner = f.opts.transport;
  const transport: Transport = async (url, signal) => {
    if (url.host === 'huggingface.co') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    if (url.host === 'hf-mirror.com') return inner(new URL(url.href.replace('https://hf-mirror.com/', 'https://huggingface.co/')), signal);
    return inner(url, signal);
  };
  const p = new PiperInstaller({ dir, log, ...f.opts, transport, mirrors: ['https://hf-mirror.com/v'] });
  p.install(); await waitFor(() => !p.status().busy, 5000);
  assert.equal(p.status().error, '');
  assert.equal(p.status().installed, true);

  // Всё недоступно — понятный совет (VPN или вручную) и ссылки для ручной загрузки.
  const dir2 = tmpDir();
  const down: Transport = async (url, signal) => (url.host === 'github.com' ? inner(url, signal) : Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  const p2 = new PiperInstaller({ dir: dir2, log, ...f.opts, transport: down, mirrors: ['https://hf-mirror.com/v'] });
  p2.install(); await waitFor(() => !p2.status().busy, 5000);
  assert.match(p2.status().error, /VPN/);
  assert.deepEqual(p2.status().links.map((l) => l.name), ['ru_RU-dmitri-medium.onnx', 'ru_RU-dmitri-medium.onnx.json']);
  assert.equal(p2.status().folder, path.join(dir2, 'voices'));

  // Пользователь положил оригинальные файлы сам — бот сверяет хеши, исправляет настройки и ничего не качает.
  fs.writeFileSync(path.join(dir2, 'voices', 'ru_RU-dmitri-medium.onnx'), Buffer.from('fake onnx model'));
  fs.writeFileSync(path.join(dir2, 'voices', 'ru_RU-dmitri-medium.onnx.json'), VOICE_JSON);
  const asked: string[] = [];
  const p3 = new PiperInstaller({ dir: dir2, log, ...f.opts, transport: async (u, s) => { asked.push(u.host); return down(u, s); }, mirrors: [] });
  p3.install(); await waitFor(() => !p3.status().busy, 5000);
  assert.equal(p3.status().error, '');
  assert.equal(p3.status().installed, true);
  assert.ok(!asked.some((h) => h.includes('huggingface')), 'голоса не скачивались');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p3.model('ru_RU-dmitri-medium') + '.json', 'utf8')).phoneme_id_map), ['a', 'b']);

  // Подменённый вручную файл голоса удаляется, а не используется.
  fs.writeFileSync(p3.model('ru_RU-dmitri-medium'), Buffer.from('bad'));
  p3.install(); await waitFor(() => !p3.status().busy, 5000);
  assert.ok(!fs.existsSync(p3.model('ru_RU-dmitri-medium')), 'чужой файл удалён');
  assert.equal(p3.status().installed, false);
});
