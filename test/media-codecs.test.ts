import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { App } from '../src/app.ts';
import { makePaths } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { MediaLibrary } from '../src/media.ts';
import { detectCodecs, describeCodecs, codecWarnings } from '../src/media-codecs.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { standardTwitch, quietLogger, tmpDir, waitFor } from './helpers.ts';

// ---------- Построение настоящей структуры MP4 (box) ----------
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}
function hdlr(handler: string) { return box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from([0])); }
function trak(handler: string, entry: Buffer) {
  const stsd = box('stsd', Buffer.alloc(4), u32(1), entry);
  return box('trak', box('mdia', hdlr(handler), box('minf', box('stbl', stsd))));
}
function videoEntry(fourcc: string, avcProfile?: number) {
  return box(fourcc, Buffer.alloc(70), ...(avcProfile !== undefined ? [box('avcC', Buffer.from([1, avcProfile, 0, 31, 0xff]))] : []));
}
function aacEntry(oti: number) {
  // ES_Descriptor (0x03) → DecoderConfigDescriptor (0x04) с objectTypeIndication.
  const dcd = Buffer.from([0x04, 13, oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const es = Buffer.concat([Buffer.from([0x03, 3 + dcd.length, 0, 1, 0]), dcd]);
  return box('mp4a', Buffer.alloc(28), box('esds', Buffer.alloc(4), es));
}
function mp4(...traks: Buffer[]) {
  return Buffer.concat([box('ftyp', Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isomavc1')), box('moov', ...traks), box('mdat', Buffer.alloc(64))]);
}
const H264_AAC = mp4(trak('vide', videoEntry('avc1', 100)), trak('soun', aacEntry(0x40)));
const MPEG4_AC3 = mp4(trak('vide', videoEntry('mp4v')), trak('soun', box('ac-3', Buffer.alloc(28))));
const HEVC_AAC = mp4(trak('vide', videoEntry('hvc1')), trak('soun', aacEntry(0x40)));

// WebM: элементы CodecID (0x86) в заголовке дорожек.
function webm(...codecIds: string[]) {
  const ids = codecIds.map((id) => Buffer.concat([Buffer.from([0x86, 0x80 | id.length]), Buffer.from(id, 'latin1')]));
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm....'), ...ids, Buffer.alloc(32)]);
}

test('кодеки MP4: H.264 + AAC поддерживаются, предупреждений нет', () => {
  const t = detectCodecs(H264_AAC, 'mp4');
  assert.deepEqual(t.map((x) => [x.type, x.name, x.ok]), [['video', 'H.264', true], ['audio', 'AAC', true]]);
  assert.equal(describeCodecs(t), 'видео H.264, звук AAC');
  assert.deepEqual(codecWarnings(t), []);
});

test('кодеки MP4: MPEG-4 Part 2 + AC-3, H.265, H.264 10 бит, AC-3 и MP3 внутри mp4a, ALAC', () => {
  const bad = detectCodecs(MPEG4_AC3, 'mp4');
  assert.deepEqual(bad.map((x) => [x.name, x.ok]), [['MPEG-4 Part 2 (DivX/Xvid)', false], ['AC-3 (Dolby Digital)', false]]);
  const w = codecWarnings(bad).join(' ');
  assert.match(w, /MPEG-4 Part 2/);
  assert.match(w, /AC-3/);
  assert.match(w, /не воспроизводится в OBS и Streamlabs/);
  assert.match(w, /Перекодировать/);

  assert.match(codecWarnings(detectCodecs(HEVC_AAC, 'mp4')).join(' '), /H\.265\/HEVC — может не воспроизводиться/);
  assert.deepEqual(detectCodecs(mp4(trak('vide', videoEntry('avc1', 110))), 'mp4').map((x) => [x.name, x.ok]), [['H.264 High 10 (10 бит)', false]]);
  assert.deepEqual(detectCodecs(mp4(trak('soun', aacEntry(0xa5))), 'mp4').map((x) => [x.name, x.ok]), [['AC-3 (Dolby Digital)', false]]);
  assert.deepEqual(detectCodecs(mp4(trak('soun', aacEntry(0x6b))), 'mp4').map((x) => [x.name, x.ok]), [['MP3', true]]);
  assert.deepEqual(detectCodecs(mp4(trak('soun', box('alac', Buffer.alloc(28)))), 'mp4').map((x) => [x.name, x.ok]), [['Apple Lossless (ALAC)', false]]);
  // Только звук не поддерживается → «не воспроизводится со звуком»
  assert.match(codecWarnings(detectCodecs(mp4(trak('vide', videoEntry('avc1', 100)), trak('soun', box('ac-3', Buffer.alloc(28)))), 'mp4')).join(' '), /не воспроизводится со звуком/);
  // Неизвестный кодек видео
  assert.deepEqual(detectCodecs(mp4(trak('vide', videoEntry('xyz1'))), 'mp4').map((x) => [x.name, x.ok]), [['«xyz1»', false]]);
});

test('кодеки MP4: индекс moov в конце файла, 64-битный размер box, мусор и обрезанный файл — без падений', () => {
  const moovLast = Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', Buffer.alloc(1000)), box('moov', trak('vide', videoEntry('mp4v')))]);
  assert.deepEqual(detectCodecs(moovLast, 'mp4').map((x) => x.id), ['mp4v']);
  const big = Buffer.concat([u32(1), Buffer.from('mdat'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 24]), Buffer.alloc(8)]);
  assert.deepEqual(detectCodecs(Buffer.concat([box('ftyp', Buffer.from('isom')), big, box('moov', trak('vide', videoEntry('avc1', 66)))]), 'mp4').map((x) => x.name), ['H.264']);
  assert.deepEqual(detectCodecs(Buffer.from('случайные байты, а не mp4 ...........'), 'mp4'), []);
  assert.deepEqual(detectCodecs(H264_AAC.subarray(0, 60), 'mp4'), []);
  const lying = Buffer.concat([u32(0xffffff00), Buffer.from('moov'), Buffer.alloc(16)]);
  assert.deepEqual(detectCodecs(lying, 'mp4'), []);
});

test('кодеки WebM: VP9 + Opus — ок; H.264 и AAC внутри WebM — предупреждение', () => {
  assert.deepEqual(detectCodecs(webm('V_VP9', 'A_OPUS'), 'webm').map((x) => [x.name, x.ok]), [['VP9', true], ['Opus', true]]);
  assert.deepEqual(codecWarnings(detectCodecs(webm('V_VP8', 'A_VORBIS'), 'webm')), []);
  const w = codecWarnings(detectCodecs(webm('V_MPEG4/ISO/AVC', 'A_AAC'), 'webm')).join(' ');
  assert.match(w, /H\.264/);
  assert.match(w, /AAC/);
});

test('медиатека: при загрузке несовместимый кодек — «внимание» с подсказкой, H.264 + AAC — OK', () => {
  const dir = tmpDir();
  const db = new Db(`${dir}/db.sqlite`);
  fs.mkdirSync(`${dir}/media`);
  const lib = new MediaLibrary(db, `${dir}/media`);
  const good = lib.add('good.mp4', H264_AAC);
  assert.equal(good.status, 'ok');
  const bad = lib.add('CamonBaby.mp4', MPEG4_AC3);
  assert.equal(bad.status, 'warning');
  assert.match(bad.status_msg, /MPEG-4 Part 2.*AC-3.*Перекодировать/);
  assert.equal(lib.add('clip.webm', webm('V_VP9', 'A_OPUS')).status, 'ok');
  db.close();
});

test('проверка файлов: старые файлы получают предупреждение о кодеке; «Проверить все» снимает ошибку воспроизведения', () => {
  const dir = tmpDir();
  const db = new Db(`${dir}/db.sqlite`);
  fs.mkdirSync(`${dir}/media`);
  const lib = new MediaLibrary(db, `${dir}/media`);
  const old = lib.add('old.mp4', MPEG4_AC3);
  const good = lib.add('good.mp4', H264_AAC);
  db.updateMediaStatus(old.id, 'ok', ''); // как если бы файл загрузили до версии с проверкой кодеков
  db.updateMediaStatus(good.id, 'broken', 'Не воспроизводится в программе для стрима: сбой'); // разовый сбой воспроизведения

  // Обычная проверка при запуске кодеки не читает и ошибку воспроизведения не трогает.
  let r = lib.verifyAll();
  assert.equal(db.getMedia(old.id)?.status, 'ok');
  assert.equal(db.getMedia(good.id)?.status, 'broken');

  r = lib.verifyAll(true);
  assert.equal(r.warnings, 1);
  assert.equal(db.getMedia(old.id)?.status, 'warning');
  assert.match(db.getMedia(old.id)!.status_msg, /MPEG-4 Part 2/);
  assert.equal(db.getMedia(good.id)?.status, 'ok', 'полная проверка снимает отметку о сбое: файл целый и кодеки поддерживаются');
  db.close();
});

// ---------- Через приложение и HTTP ----------
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(dir = tmpDir()) {
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: twitch.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  app.db.updateSettings({ clientId: 'abcdefghijklmnopqrstuvwxyz0123', gapBetweenMs: 0 });
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, port: app.port, dir };
}
const api = (port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'x-tab-request': '1', ...(Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  });

test('при первом запуске новой версии бот один раз проверяет кодеки у ранее загруженных файлов', async () => {
  const dir = tmpDir();
  {
    const paths = makePaths(dir);
    const db = new Db(paths.dbFile);
    const lib = new MediaLibrary(db, paths.mediaDir);
    const m = lib.add('old.mp4', MPEG4_AC3);
    db.updateMediaStatus(m.id, 'ok', '');
    db.close();
  }
  const { app } = await startApp(dir);
  const row = app.db.listMedia()[0];
  assert.equal(row.status, 'warning');
  assert.equal(app.db.getMeta('codec_scan'), '1', 'повторно при следующих запусках не читает файлы');
});

test('ошибка воспроизведения в OBS: понятный текст, предпросмотр в панели её не снимает, тест сообщает причину', async () => {
  const { app, port } = await startApp();
  const up = await api(port, 'PUT', '/api/media', H264_AAC, { 'x-file-name': encodeURIComponent('clip.mp4') });
  const m = await up.json() as { id: string };
  // Overlay (OBS/Streamlabs) не смог воспроизвести файл
  const ws = new (await import('ws')).default(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  cleanup.push(() => ws.terminate());
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === 'play') ws.send(JSON.stringify({ type: 'error', id: msg.item.id, message: 'кодек или формат файла не поддерживается программой для стрима (MEDIA_ERR_SRC_NOT_SUPPORTED)' }));
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', isObs: true, app: 'streamlabs' }));
  await waitFor(() => app.hub.overlayList().length === 1);
  assert.equal((await api(port, 'POST', `/api/media/${m.id}/test`)).status, 200);
  await waitFor(() => app.db.getMedia(m.id)?.status === 'broken');
  assert.match(app.db.getMedia(m.id)!.status_msg, /^Не воспроизводится в программе для стрима: кодек или формат.*Перекодировать/);
  assert.ok(app.db.recentEvents().some((e) => e.level === 'warn' && /Перекодировать/.test(e.message)));

  // Предпросмотр в браузере панели воспроизвёл файл — это не отменяет ошибку OBS/Streamlabs.
  app.hub.onMediaProbe(m.id, true, 9900, '');
  assert.equal(app.db.getMedia(m.id)?.status, 'broken');
  // А свою ошибку предпросмотр снимает.
  app.db.updateMediaStatus(m.id, 'broken', 'Браузер не может воспроизвести файл: код 4');
  app.hub.onMediaProbe(m.id, true, 9900, '');
  assert.equal(app.db.getMedia(m.id)?.status, 'ok');

  // Кодек назван при загрузке, а браузер панели тоже не читает файл — причина и совет (HandBrake) сохраняются.
  app.db.updateMediaStatus(m.id, 'warning', 'В файле видео в кодеке MPEG-4 Part 2 (DivX/Xvid) — не воспроизводится в OBS и Streamlabs. Нажмите «Перекодировать» (раздел «Медиа») или сохраните файл как MP4 (H.264 + AAC).');
  app.hub.onMediaProbe(m.id, false, 0, 'код 4');
  assert.equal(app.db.getMedia(m.id)?.status, 'broken');
  assert.match(app.db.getMedia(m.id)!.status_msg, /^В файле видео в кодеке MPEG-4 Part 2.*Браузер панели тоже не может его прочитать.*HandBrake/);
  assert.doesNotMatch(app.db.getMedia(m.id)!.status_msg, /Нажмите «Перекодировать»/);

  app.db.updateMediaStatus(m.id, 'broken', 'Не воспроизводится в программе для стрима: кодек не поддерживается.');
  const t = await api(port, 'POST', `/api/media/${m.id}/test`);
  assert.equal(t.status, 400);
  assert.match(((await t.json()) as { error: string }).error, /не воспроизводится: Не воспроизводится в программе для стрима/);
  // Файл удалён с диска → «отсутствует на диске», а не «повреждён»
  fs.unlinkSync(app.media.filePath(app.db.getMedia(m.id)!)!);
  app.db.updateMediaStatus(m.id, 'ok', '');
  assert.match(((await (await api(port, 'POST', `/api/media/${m.id}/test`)).json()) as { error: string }).error, /отсутствует на диске/);
});

test('перекодированный файл: длительность, замена у наград, удаление исходного; без подтверждения — отказ', async () => {
  const { app, port } = await startApp();
  const orig = await (await api(port, 'PUT', '/api/media', MPEG4_AC3, { 'x-file-name': encodeURIComponent('CamonBaby.mp4') })).json() as { id: string; status: string };
  assert.equal(orig.status, 'warning');
  app.db.upsertTwitchReward({ id: 'r1', title: 'CamonBaby ★', cost: 100, prompt: '', manageable: true, is_enabled: true, background_color: '', raw: {} });
  app.db.updateRewardConfig('r1', { video_id: orig.id, play_mode: 'video', bot_enabled: 1 });

  const upload = async (name: string) => (await (await api(port, 'PUT', '/api/media', webm('V_VP9', 'A_OPUS'), { 'x-file-name': encodeURIComponent(name) })).json()) as { id: string; status: string };
  // Без замены: новый файл рядом, исходный остаётся, длительность записана.
  const copy = await upload('CamonBaby (WebM).webm');
  assert.equal(copy.status, 'ok');
  let r = await api(port, 'POST', `/api/media/${copy.id}/transcoded`, { from: orig.id, durationMs: 9900, replace: false });
  assert.equal(r.status, 200);
  assert.equal(app.db.getMedia(copy.id)?.duration_ms, 9900);
  assert.ok(app.db.getMedia(orig.id));

  // Замена без подтверждения — отказ.
  const next = await upload('CamonBaby.webm');
  r = await api(port, 'POST', `/api/media/${next.id}/transcoded`, { from: orig.id, durationMs: 9900, replace: true });
  assert.equal(r.status, 400);
  // С подтверждением: награда переключена, исходный удалён (и с диска), имя — как у исходного, но .webm.
  const origPath = app.media.filePath(app.db.getMedia(orig.id)!)!;
  r = await api(port, 'POST', `/api/media/${next.id}/transcoded`, { from: orig.id, durationMs: 9900, replace: true, confirm: true });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { rewards: number }).rewards, 1);
  assert.equal(app.db.getReward('r1')?.video_id, next.id);
  assert.equal(app.db.getMedia(orig.id), undefined);
  assert.equal(fs.existsSync(origPath), false);
  assert.equal(app.db.getMedia(next.id)?.name, 'CamonBaby.webm');
  assert.ok(app.db.recentEvents().some((e) => /перекодирован в WebM: исходный файл заменён, наград переключено: 1/.test(e.message)));
  // Неверные запросы
  assert.equal((await api(port, 'POST', `/api/media/${next.id}/transcoded`, { from: next.id })).status, 400);
  assert.equal((await api(port, 'POST', `/api/media/${next.id}/transcoded`, { from: 'нет-такого' })).status, 404);
});
