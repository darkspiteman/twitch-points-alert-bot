import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sniffFormat, MediaLibrary, sanitizeDisplayName } from '../src/media.ts';
import { resolveSafe } from '../src/server/http.ts';
import { Db } from '../src/db.ts';
import { tmpDir } from './helpers.ts';

const wav = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'test-chime.wav'));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16), Buffer.from('vorbis'), Buffer.alloc(32)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8), Buffer.from('moov avc1'), Buffer.alloc(16)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm....V_VP9....A_OPUS'), Buffer.alloc(16)]);

test('определение форматов по сигнатуре', () => {
  assert.equal(sniffFormat(wav)?.ext, 'wav');
  assert.equal(sniffFormat(png)?.ext, 'png');
  assert.equal(sniffFormat(gif)?.ext, 'gif');
  assert.equal(sniffFormat(mp3)?.ext, 'mp3');
  assert.equal(sniffFormat(ogg)?.kind, 'audio');
  assert.equal(sniffFormat(mp4)?.ext, 'mp4');
  assert.equal(sniffFormat(webm)?.kind, 'video');
  assert.equal(sniffFormat(Buffer.from('MZ\x90\x00 this is an exe file....')), null);
  assert.equal(sniffFormat(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

test('медиатека: принимает корректные файлы, отклоняет повреждённые и подменённые', () => {
  const dir = tmpDir();
  const db = new Db(path.join(dir, 'db.sqlite'));
  fs.mkdirSync(path.join(dir, 'media'));
  const lib = new MediaLibrary(db, path.join(dir, 'media'));
  const row = lib.add('звук.wav', wav);
  assert.equal(row.kind, 'audio');
  assert.ok(fs.existsSync(path.join(dir, 'media', row.file_name)));
  assert.throws(() => lib.add('virus.png', Buffer.from('MZ\x90\x00 fake executable content here')), /не распознано/);
  assert.throws(() => lib.add('script.html', png), /не поддерживается/);
  assert.throws(() => lib.add('empty.mp3', Buffer.alloc(0)), /пустой/);
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8), Buffer.from('moov mp4a'), Buffer.alloc(16)]);
  const m4aRow = lib.add('звук.m4a', m4a);
  assert.equal(m4aRow.kind, 'audio');
  assert.equal(m4aRow.mime, 'audio/mp4');
  const hevc = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8), Buffer.from('moov hvc1'), Buffer.alloc(16)]);
  assert.equal(lib.add('hevc.mp4', hevc).status, 'warning');
  db.close();
});

test('медиатека: удаление используемого файла требует подтверждения; повреждённый файл на диске обнаруживается', () => {
  const dir = tmpDir();
  const db = new Db(path.join(dir, 'db.sqlite'));
  fs.mkdirSync(path.join(dir, 'media'));
  const lib = new MediaLibrary(db, path.join(dir, 'media'));
  const row = lib.add('a.wav', wav);
  db.insertLocalReward('local-1', 'Тест', 0);
  db.updateRewardConfig('local-1', { media_id: row.id });
  assert.equal(lib.remove(row.id).ok, false);
  // портим файл на диске
  fs.writeFileSync(path.join(dir, 'media', row.file_name), Buffer.from('garbage garbage garbage'));
  const v = lib.verifyAll();
  assert.equal(v.broken, 1);
  assert.equal(db.getMedia(row.id)?.status, 'broken');
  assert.equal(lib.remove(row.id, true).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'media', row.file_name)), false);
  db.close();
});

test('имя файла очищается от путей и спецсимволов', () => {
  assert.equal(sanitizeDisplayName('..\\..\\Windows\\evil<>.mp3'), 'evil__.mp3');
  assert.equal(sanitizeDisplayName('../../etc/passwd'), 'passwd');
});

test('защита от directory traversal при выдаче файлов', () => {
  const root = tmpDir();
  assert.ok(resolveSafe(root, 'index.html'));
  assert.ok(resolveSafe(root, 'sub/app.js'));
  assert.equal(resolveSafe(root, '../secret.txt'), null);
  assert.equal(resolveSafe(root, '..%2fsecret.txt'), null);
  assert.equal(resolveSafe(root, '%2e%2e/secret.txt'), null);
  assert.equal(resolveSafe(root, '..\\secret.txt'), null);
  assert.equal(resolveSafe(root, '.env'), null);
  assert.equal(resolveSafe(root, 'a/%00/b'), null);
  assert.equal(resolveSafe(root, 'C:/Windows/win.ini'), null);
});
