import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { isPrivateAddress, checkUrl, guardedLookup, safeDownload, DownloadError, type Transport } from '../src/net/safe-download.ts';
import { MediaFinder, freesoundLicense } from '../src/find.ts';
import { App } from '../src/app.ts';
import { makePaths, publicSettings, validateSettingsPatch, defaultSettings } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { Logger, type LogEntry } from '../src/logger.ts';
import { Db } from '../src/db.ts';
import { MediaLibrary } from '../src/media.ts';
import { MockTwitch, json, tmpDir, waitFor, standardTwitch } from './helpers.ts';
import type { PlayItem } from '../src/queue.ts';

const KLIPY_KEY = 'klipyTESTkey1234567890abcdef';
const FS_KEY = 'freesoundTESTkey0987654321zz';
const wav = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'test-chime.wav'));
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 1)]);

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

// ---------- помощники ----------
interface Served { status?: number; headers?: Record<string, string>; body?: Buffer | Buffer[] }
function mockTransport(routes: Record<string, Served | (() => Served)>, seen: string[] = []): Transport {
  return async (url) => {
    seen.push(url.href);
    const r0 = routes[url.href];
    if (!r0) return { status: 404, headers: {}, body: Readable.from([]) };
    const r = typeof r0 === 'function' ? r0() : r0;
    const chunks = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: Readable.from(chunks) };
  };
}

function clip(slug: string, mp4 = `https://static.klipy.com/ii/x/${slug}.mp4`) {
  return { url: `https://klipy.com/clips/${slug}`, title: `Clip ${slug}`, slug, file: { mp4, gif: `https://static.klipy.com/ii/x/${slug}.gif`, webp: `https://static.klipy.com/ii/x/${slug}.webp` }, file_meta: { mp4: { width: 640, height: 360 } }, type: 'clip' };
}
function gif(slug: string) {
  const f = (n: string, ext: string) => ({ url: `https://static.klipy.com/ii/y/${slug}-${n}.${ext}`, width: 200, height: 200, size: 1000 });
  return { id: 1, slug, title: `Gif ${slug}`, file: { md: { webp: f('md', 'webp'), gif: f('md', 'gif') }, sm: { webp: f('sm', 'webp') } }, type: 'gif' };
}

function klipyMock(t: MockTwitch, opts: { searchStatus?: number; itemsFail?: boolean } = {}): MockTwitch {
  t.on('GET', '/clips/search', () => opts.searchStatus ? json(opts.searchStatus, { result: false }) : json(200, { result: true, data: { data: [clip('a'), { type: 'ad', slug: '' }, clip('b')], has_next: false } }));
  t.on('GET', '/clips/trending', () => json(200, { result: true, data: { data: [clip('t')] } }));
  t.on('GET', '/gifs/search', () => json(200, { result: true, data: { data: [gif('g1')] } }));
  t.on('GET', '/clips/items', (url) => {
    if (opts.itemsFail) throw new TypeError('fetch failed');
    const slug = (url.searchParams.get('slugs') ?? '').split('--')[0]; // как настоящий Klipy: без суффикса из выдачи
    return json(200, { result: true, data: { data: [clip(slug, `https://static.klipy.com/ii/fresh/${slug}.mp4`)] } });
  });
  return t;
}

function freesoundMock(t: MockTwitch): MockTwitch {
  const sound = (id: number, license: string) => ({ id, name: `Laugh ${id}.wav`, username: 'author1', license, duration: 2.5, url: `https://freesound.org/people/author1/sounds/${id}/`, previews: { 'preview-hq-mp3': `https://cdn.freesound.org/previews/0/${id}-hq.mp3` } });
  t.on('GET', '/apiv2/search/', () => json(200, { count: 2, next: null, results: [sound(11, 'http://creativecommons.org/publicdomain/zero/1.0/'), sound(12, 'https://creativecommons.org/licenses/by-nc/4.0/')] }));
  t.on('GET', '/sounds/11/', () => json(200, sound(11, 'http://creativecommons.org/licenses/by/4.0/')));
  t.on('GET', '/sounds/13/', () => json(200, sound(13, 'http://creativecommons.org/licenses/by/4.0/')));
  return t;
}

function makeFinder(opts: { fetch: MockTwitch; transport?: Transport; keys?: boolean; entries?: LogEntry[] }) {
  const dir = tmpDir();
  const db = new Db(path.join(dir, 'db.sqlite'));
  fs.mkdirSync(path.join(dir, 'media'));
  const media = new MediaLibrary(db, path.join(dir, 'media'));
  if (opts.keys !== false) db.updateSettings({ klipyApiKey: KLIPY_KEY, freesoundApiKey: FS_KEY });
  const logger = new Logger({ console: false, minLevel: 'debug' });
  if (opts.entries) logger.onEntry((e) => opts.entries!.push(e));
  const journal: string[] = [];
  const finder = new MediaFinder({
    db, media, log: logger.child('find'), journal: (_l, _t, m) => { journal.push(m); logger.child('journal').info(m); },
    fetchFn: opts.fetch.fetch as typeof fetch, transport: opts.transport, klipyBase: 'https://klipy.test', freesoundBase: 'https://fs.test/apiv2',
  });
  cleanup.push(() => db.close());
  return { finder, db, media, dir, journal, logger };
}

// ---------- SSRF ----------
test('SSRF: внутренние адреса распознаются', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '64:ff9b::a00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('SSRF: проверка ссылок', () => {
  const bad = ['http://example.com/a.mp3', 'ftp://example.com/a', 'https://localhost/a.mp3', 'https://127.0.0.1/a.mp3', 'https://[::1]/a', 'https://192.168.0.10/a.mp3',
    'https://user:pass@example.com/a.mp3', 'https://example.com:8080/a.mp3', 'https://router.local/x', 'https://intranet/x', 'https://2130706433/a', 'https://0x7f.0.0.1/a', 'not a url', 'file:///C:/Windows/win.ini'];
  for (const u of bad) assert.throws(() => checkUrl(u), DownloadError, u);
  assert.equal(checkUrl('https://example.com/a.mp3').hostname, 'example.com');
  assert.equal(checkUrl('https://example.com:443/a.mp3').hostname, 'example.com');
  assert.throws(() => checkUrl('https://evil.com/a.mp3', (h) => h.endsWith('freesound.org')), /не разрешено/);
});

test('SSRF: DNS-имя, указывающее на внутренний адрес, отклоняется при соединении', async () => {
  const resolver = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])) as never;
  const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup('rebind.example', {}, (e) => r(e), resolver));
  assert.equal(err?.code, 'EBLOCKED');
  const ok = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '93.184.216.34', family: 4 }])) as never;
  const res = await new Promise<string>((r) => guardedLookup('ok.example', {}, (_e, a) => r(String(a)), ok));
  assert.equal(res, '93.184.216.34');
});

test('скачивание: перенаправление на внутренний адрес и чужой сайт запрещено, лимит размера соблюдается', async () => {
  const seen: string[] = [];
  const t = mockTransport({
    'https://files.example/redir-local': { status: 302, headers: { location: 'https://127.0.0.1/secret' } },
    'https://files.example/redir-meta': { status: 301, headers: { location: 'https://169.254.169.254/latest/meta-data' } },
    'https://cdn.freesound.org/redir-away': { status: 302, headers: { location: 'https://evil.example/x.mp3' } },
    'https://files.example/big-declared': { headers: { 'content-length': String(50 * 1024 * 1024) }, body: Buffer.alloc(10) },
    'https://files.example/big-stream': { body: [Buffer.alloc(600 * 1024), Buffer.alloc(600 * 1024)] },
    'https://files.example/ok': { headers: { 'content-disposition': 'attachment; filename="Смешной звук.mp3"' }, body: mp3 },
    'https://files.example/redir-ok': { status: 302, headers: { location: '/ok' } },
  }, seen);
  await assert.rejects(safeDownload('https://files.example/redir-local', { maxBytes: 1e6, transport: t }), (e: DownloadError) => e.code === 'blocked');
  await assert.rejects(safeDownload('https://files.example/redir-meta', { maxBytes: 1e6, transport: t }), (e: DownloadError) => e.code === 'blocked');
  await assert.rejects(safeDownload('https://cdn.freesound.org/redir-away', { maxBytes: 1e6, transport: t, allowHost: (h) => h.endsWith('freesound.org') }), (e: DownloadError) => e.code === 'blocked');
  assert.ok(!seen.some((u) => u.includes('127.0.0.1') || u.includes('169.254') || u.includes('evil.example')), 'запрос к запрещённому адресу не отправлялся');
  await assert.rejects(safeDownload('https://files.example/big-declared', { maxBytes: 1024 * 1024, transport: t }), (e: DownloadError) => e.code === 'too_big');
  await assert.rejects(safeDownload('https://files.example/big-stream', { maxBytes: 1024 * 1024, transport: t }), (e: DownloadError) => e.code === 'too_big');
  await assert.rejects(safeDownload('https://files.example/missing', { maxBytes: 1e6, transport: t }), /404/);
  const ok = await safeDownload('https://files.example/redir-ok', { maxBytes: 1e6, transport: t });
  assert.equal(ok.fileName, 'Смешной звук.mp3');
  assert.equal(ok.data.length, mp3.length);
});

// ---------- Klipy ----------
test('Klipy: поиск без ключа — понятная ошибка; с ключом — выдача в исходном порядке без рекламы', async () => {
  const t = klipyMock(new MockTwitch());
  const noKey = makeFinder({ fetch: t, keys: false });
  await assert.rejects(noKey.finder.searchKlipy('clips', 'cat'), /ключ Klipy/);
  const { finder } = makeFinder({ fetch: t });
  const r = await finder.searchKlipy('clips', 'cat');
  assert.deepEqual(r.results.map((x) => x.slug), ['a', 'b']);
  assert.equal(r.results[0].play.kind, 'video');
  assert.equal(r.results[0].play.url, 'https://static.klipy.com/ii/x/a.mp4');
  const call = new URL(t.calls.find((c) => c.url.includes('/clips/search'))!.url);
  assert.equal(call.searchParams.get('q'), 'cat');
  assert.equal(call.searchParams.get('content_filter'), 'medium');
  assert.ok(call.searchParams.get('customer_id'));
  const g = await finder.searchKlipy('gifs', 'dog');
  assert.equal(g.results[0].play.kind, 'image');
  assert.equal(g.results[0].play.mime, 'image/webp');
  const trending = await finder.searchKlipy('clips', '');
  assert.equal(trending.results[0].slug, 't');
});

test('Klipy: лимит, неверный ключ, нет сети — сообщения на русском', async () => {
  for (const [status, re] of [[429, /лимит/], [401, /не принял ключ/], [500, /временно недоступен/]] as const) {
    const { finder } = makeFinder({ fetch: klipyMock(new MockTwitch(), { searchStatus: status }) });
    await assert.rejects(finder.searchKlipy('clips', 'x'), re);
  }
  // Так отвечает настоящий Klipy на неверный ключ (проверено 14.11.2026).
  const invalid = new MockTwitch();
  invalid.on('GET', '/clips/search', () => json(404, { result: false, errors: { message: ['The provided API key is invalid.'] } }));
  await assert.rejects(makeFinder({ fetch: invalid }).finder.searchKlipy('clips', 'x'), /не принял ключ/);
  const off = new MockTwitch();
  off.on('GET', '/clips/search', () => { throw new TypeError('fetch failed'); });
  await assert.rejects(makeFinder({ fetch: off }).finder.searchKlipy('clips', 'x'), /Нет связи с Klipy/);
});

test('Klipy: добавление — только ссылка в базе, файл не скачивается; адрес берётся свежим перед показом', async () => {
  const t = klipyMock(new MockTwitch());
  const { finder, db, dir } = makeFinder({ fetch: t });
  const row = await finder.addKlipy('clips', 'a');
  assert.equal(row.source, 'klipy');
  assert.equal(row.remote_ref, 'clips/a');
  assert.equal(row.kind, 'video');
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 0, 'файлы Klipy не сохраняются на диск');
  assert.equal((await finder.addKlipy('clips', 'a')).id, row.id, 'повторное добавление не создаёт дубликат');
  assert.equal(db.listMedia().length, 1);
  await assert.rejects(finder.addKlipy('clips', '../../etc'), /Неверный идентификатор/);
  // Настоящая выдача Klipy: slug с суффиксом («bruh--xY12abCd3»), Items API отвечает основным slug («bruh»).
  const suffixed = await finder.addKlipy('clips', 'bruh--xY12abCd3');
  assert.equal(suffixed.remote_ref, 'clips/bruh--xY12abCd3', 'идентификатор из выдачи хранится без изменений');
  assert.equal((await finder.resolveRemote(suffixed.remote_ref)).url, 'https://static.klipy.com/ii/fresh/bruh.mp4');

  const item = { id: 'x', visual: { id: row.id, url: '', kind: 'video', mime: 'video/mp4', remote: 'clips/a' }, audio: null, fallbackAudio: null, rewardTitle: 'R' } as unknown as PlayItem;
  const ready = await finder.prepare(item);
  assert.equal(ready.visual?.url, 'https://static.klipy.com/ii/fresh/a.mp4');
});

test('Klipy недоступен: играет запасной звук, без него — понятная ошибка', async () => {
  const { finder, journal } = makeFinder({ fetch: klipyMock(new MockTwitch(), { itemsFail: true }) });
  const fb = { id: 'm1', url: '/media/m1', kind: 'audio' as const, mime: 'audio/wav' };
  const base = { id: 'x', rewardTitle: 'Мем', visual: { id: 'r', url: '', kind: 'video', mime: 'video/mp4', remote: 'clips/a' }, audio: null, durationMs: 0 } as unknown as PlayItem;
  const res = await finder.prepare({ ...base, fallbackAudio: fb });
  assert.equal(res.visual, null);
  assert.deepEqual(res.audio, fb);
  assert.ok(journal.some((m) => /запасной звук/.test(m)));
  await assert.rejects(finder.prepare({ ...base, fallbackAudio: null }), /Звук \(основной файл\)/);
});

// ---------- Freesound ----------
test('Freesound: поиск (ключ в заголовке, не в адресе), лицензии, скачивание превью с автором', async () => {
  const t = freesoundMock(new MockTwitch());
  const seen: string[] = [];
  const transport = mockTransport({ 'https://cdn.freesound.org/previews/0/11-hq.mp3': { body: mp3 }, 'https://cdn.freesound.org/previews/0/13-hq.mp3': { body: Buffer.from('<html>not audio at all, just a page</html>') } }, seen);
  const { finder, dir } = makeFinder({ fetch: t, transport });
  const r = await finder.searchFreesound('laugh');
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].commercialOk, true);
  assert.equal(r.results[1].commercialOk, false);
  const call = t.calls.find((c) => c.url.includes('/search/'))!;
  assert.ok(!call.url.includes(FS_KEY), 'ключ не передаётся в адресе');
  assert.match(new URL(call.url).searchParams.get('filter') ?? '', /Creative Commons 0/);
  await finder.searchFreesound('laugh', 1, false);
  assert.doesNotMatch(new URL(t.calls.filter((c) => c.url.includes('/search/')).pop()!.url).searchParams.get('filter') ?? '', /license/);
  await assert.rejects(finder.searchFreesound('  '), /Введите/);

  const row = await finder.addFreesound(11);
  assert.equal(row.source, 'freesound');
  assert.equal(row.kind, 'audio');
  assert.equal(row.name, 'Laugh 11 (author1).mp3', 'без двойного расширения');
  assert.match(row.attribution, /author1/);
  assert.match(row.attribution, /CC BY/);
  assert.ok(fs.existsSync(path.join(dir, 'media', row.file_name)));
  // Повреждённое превью отклоняется, в медиатеку не попадает.
  await assert.rejects(finder.addFreesound(13), /не распознано/);
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 1);
  assert.equal(freesoundLicense('Attribution NonCommercial').commercialOk, false);
});

// ---------- По ссылке ----------
test('импорт по ссылке: корректный файл, повреждённый, слишком большой, локальная сеть, Klipy/GIPHY', async () => {
  const transport = mockTransport({
    'https://files.example/sound': { body: wav },
    'https://files.example/broken.mp3': { body: Buffer.from('MZ\x90\x00 definitely an executable, not media') },
    'https://files.example/huge.mp4': { headers: { 'content-length': String(500 * 1024 * 1024) }, body: Buffer.alloc(1) },
  });
  const { finder, dir } = makeFinder({ fetch: new MockTwitch(), transport });
  const row = await finder.importUrl('https://files.example/sound');
  assert.equal(row.name, 'sound.wav');
  assert.equal(row.source, 'url');
  assert.equal(row.source_url, 'https://files.example/sound');
  await assert.rejects(finder.importUrl('https://files.example/broken.mp3'), /не распознано/);
  await assert.rejects(finder.importUrl('https://files.example/huge.mp4'), /слишком большой/);
  await assert.rejects(finder.importUrl('https://192.168.1.1/a.mp3'), /локальной сети/);
  await assert.rejects(finder.importUrl('http://example.com/a.mp3'), /https/);
  await assert.rejects(finder.importUrl('https://static.klipy.com/ii/x/a.mp4'), /Klipy/);
  await assert.rejects(finder.importUrl('https://media.giphy.com/media/x/giphy.gif'), /GIPHY/);
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, 1);
});

// ---------- Ключи ----------
test('ключи API: проверка формата, маска для панели, отсутствие в логах', async () => {
  assert.ok(validateSettingsPatch({ klipyApiKey: 'bad key with spaces' }).error);
  assert.ok(validateSettingsPatch({ freesoundApiKey: '••••abcd' }).error);
  assert.equal(validateSettingsPatch({ klipyApiKey: '' }).error, null);
  const pub = publicSettings({ ...defaultSettings(), klipyApiKey: KLIPY_KEY, freesoundApiKey: '' });
  assert.equal(pub.klipyApiKey, '••••' + KLIPY_KEY.slice(-4));
  assert.equal(pub.freesoundApiKey, '');

  const entries: LogEntry[] = [];
  const t = klipyMock(freesoundMock(new MockTwitch()), { searchStatus: 429 });
  const { finder, logger } = makeFinder({ fetch: t, entries, transport: mockTransport({}) });
  await finder.searchKlipy('clips', 'x').catch(() => {});
  await finder.searchFreesound('x').catch(() => {});
  await finder.addFreesound(11).catch(() => {});
  logger.child('test').error(`Ошибка запроса https://api.klipy.com/api/v1/${KLIPY_KEY}/clips/search, токен ${FS_KEY}`);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(!e.msg.includes(KLIPY_KEY) && !e.msg.includes(FS_KEY), `ключ попал в лог: ${e.msg}`);
  }
});

// ---------- Целиком через HTTP и overlay ----------
interface Ctx { app: App; server: http.Server; port: number }
async function startApp(fetchMock: MockTwitch, transport?: Transport): Promise<Ctx> {
  const dir = tmpDir();
  const app = new App({
    paths: makePaths(dir), logger: new Logger({ console: false }), store: new MemoryStore(), port: 0, fetchFn: fetchMock.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', downloadTransport: transport,
    klipyBase: 'https://klipy.test', freesoundBase: 'https://fs.test/apiv2',
  });
  const server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  app.db.updateSettings({ gapBetweenMs: 0 });
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, server, port };
}

function call(port: number, method: string, p: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
}

async function overlay(port: number) {
  const plays: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}`, 'User-Agent': 'Mozilla/5.0 OBS/33.0.1' } });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'play') { plays.push(m.item); setTimeout(() => ws.send(JSON.stringify({ type: 'ended', id: m.item.id })), 10); }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', isObs: true }));
  cleanup.push(() => ws.terminate());
  return plays;
}

test('HTTP: ключи не отдаются в панель; найденный мем Klipy играет в overlay по «▶ Тест», при сбое — запасной звук', async () => {
  let klipyDown = false;
  const t = klipyMock(standardTwitch());
  t.on('GET', '/clips/items', (url) => {
    if (klipyDown) return json(503, {});
    const slug = url.searchParams.get('slugs') ?? '';
    return json(200, { result: true, data: { data: [clip(slug, `https://static.klipy.com/ii/fresh/${slug}.mp4`)] } });
  });
  const { app, port } = await startApp(t);

  const saved = await call(port, 'POST', '/api/settings', { klipyApiKey: KLIPY_KEY });
  assert.equal(saved.status, 200);
  assert.equal((saved.body.settings as Record<string, string>).klipyApiKey, '••••' + KLIPY_KEY.slice(-4));
  const state = await call(port, 'GET', '/api/state');
  assert.ok(!JSON.stringify(state.body).includes(KLIPY_KEY), 'ключ не уходит в панель');
  assert.deepEqual(state.body.find, { klipy: true, freesound: false });

  const search = await call(port, 'GET', '/api/find/klipy?type=clips&q=cat');
  assert.equal(search.status, 200);
  assert.equal((search.body.results as unknown[]).length, 2);
  assert.equal((await call(port, 'GET', '/api/find/klipy?type=evil&q=cat')).status, 400);
  assert.equal((await call(port, 'GET', '/api/find/freesound?q=x')).status, 400);

  const added = await call(port, 'POST', '/api/find/klipy/add', { type: 'clips', slug: 'a' });
  assert.equal(added.status, 200);
  const mediaId = added.body.id as string;
  const fallback = app.media.add('запасной.wav', wav);
  app.db.insertLocalReward('local-meme', 'Мем', 0);
  app.db.updateRewardConfig('local-meme', { video_id: mediaId, media_id: fallback.id, bot_enabled: 1, play_mode: 'video' });

  const plays = await overlay(port);
  assert.equal((await call(port, 'POST', '/api/rewards/local-meme/test')).status, 200);
  await waitFor(() => plays.length === 1);
  const first = plays[0] as { visual: { url: string; kind: string }; fallbackAudio: { url: string } };
  assert.equal(first.visual.url, 'https://static.klipy.com/ii/fresh/a.mp4');
  assert.equal(first.visual.kind, 'video');
  assert.equal(first.fallbackAudio.url, `/media/${fallback.id}`, 'overlay получает запасной звук на случай сбоя загрузки');

  klipyDown = true;
  await call(port, 'POST', '/api/rewards/local-meme/test');
  await waitFor(() => plays.length === 2);
  const second = plays[1] as { visual: unknown; audio: { url: string } };
  assert.equal(second.visual, null);
  assert.equal(second.audio.url, `/media/${fallback.id}`);

  // Без запасного звука — ошибка в журнале, очередь продолжает работу.
  app.db.updateRewardConfig('local-meme', { media_id: null });
  await call(port, 'POST', '/api/rewards/local-meme/test');
  await waitFor(() => app.db.recentEvents(20).some((e) => /онлайн-медиа недоступно/.test(e.message)));
  assert.equal(app.queue.snapshot().current, null);

  // Предпросмотр онлайн-медиа в медиатеке и удаление.
  klipyDown = false;
  const online = await call(port, 'GET', `/api/media/${mediaId}/online`);
  assert.equal(online.body.url, 'https://static.klipy.com/ii/fresh/a.mp4');
  assert.equal((await call(port, 'POST', `/api/media/${mediaId}/delete`, { confirm: true, force: true })).status, 200);
});

test('overlay сообщает о запасном звуке — запись в журнале', async () => {
  const { app, port } = await startApp(standardTwitch());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  cleanup.push(() => ws.terminate());
  ws.send(JSON.stringify({ type: 'hello', isObs: true }));
  ws.send(JSON.stringify({ type: 'fallback', id: 'item-1', message: 'ошибка сети при загрузке файла' }));
  await waitFor(() => app.db.recentEvents(10).some((e) => /не загрузилось в OBS.*запасной звук/.test(e.message)));
});

test('HTTP: импорт по ссылке и CSP разрешает только нужные внешние домены', async () => {
  const transport = mockTransport({ 'https://files.example/a.mp3': { body: mp3 } });
  const { port } = await startApp(standardTwitch(), transport);
  const ok = await call(port, 'POST', '/api/find/url', { url: 'https://files.example/a.mp3' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.kind, 'audio');
  const bad = await call(port, 'POST', '/api/find/url', { url: 'https://127.0.0.1:' + port + '/api/state' });
  assert.equal(bad.status, 400);
  const res = await fetch(`http://127.0.0.1:${port}/panel/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /media-src 'self' blob: https:\/\/\*\.klipy\.com https:\/\/cdn\.freesound\.org/);
  assert.match(csp, /connect-src 'self' ws:/);
  assert.doesNotMatch(csp, /connect-src[^;]*https:/, 'панель не обращается к внешним API напрямую');
});
