import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { SIGNATURE_FILE, signUpdate, verifyUpdate, UPDATE_PUBLIC_KEYS } from '../src/update-signature.ts';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { compareVersions, parseChangelog, Updater, type UpdateStatus } from '../src/update.ts';
import { readZip, safeEntryName } from '../src/net/zip.ts';
import type { Transport } from '../src/net/safe-download.ts';
import { Db } from '../src/db.ts';
import { App } from '../src/app.ts';
import { makePaths, APP_VERSION } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { MockTwitch, json, tmpDir, quietLogger, standardTwitch } from './helpers.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

/** Простейший ZIP-архив (deflate или без сжатия) — как архивы GitHub. */
function makeZip(files: Record<string, string | Buffer>, opts: { store?: boolean; badCrc?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = opts.store ? data : zlib.deflateRawSync(data);
    const method = opts.store ? 0 : 8;
    const crc = name === opts.badCrc ? 12345 : zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x800, 6); loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, nameBuf, comp);
    cens.push(cen, nameBuf);
    offset += loc.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const changelog = (versions: string[]) => JSON.stringify(versions.map((v) => ({ version: v, date: '2026-11-14', changes: [`Изменения ${v}`] })));
const ZIP_URL = 'https://codeload.github.com/owner/bot/zip/refs/heads/main';
const CL_PATH = '/owner/bot/main/changelog.json';

function zipTransport(zip: Buffer | (() => Buffer)): Transport {
  return async (url) => {
    if (url.href !== ZIP_URL) return { status: 404, headers: {}, body: Readable.from([]) };
    return { status: 200, headers: {}, body: Readable.from([typeof zip === 'function' ? zip() : zip]) };
  };
}

/** Тестовый ключ подписи обновлений (настоящий ключ автора хранится только у автора). */
const TEST_KEY = crypto.generateKeyPairSync('ed25519');
const TEST_KEY_PEM = TEST_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TEST_PUB = TEST_KEY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

type ReleaseOpts = { sign?: 'test' | 'none' | 'other'; tamper?: (files: Record<string, string>) => void; signedVersion?: string };

function releaseFiles(version: string, extra: Record<string, string> = {}, deps: Record<string, string> = { ws: '^8' }): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'twitch-alert-bot', version, dependencies: deps }),
    'changelog.json': changelog([version, '1.1.0']),
    'src/main.ts': `// main ${version}`,
    'src/new-module.ts': 'export const x = 1;',
    'public/panel/app.js': `// panel ${version}`,
    'public/overlay/overlay.js': '// overlay',
    'launcher/TrayLauncher.cs': `// launcher ${version}`,
    'data/evil.txt': 'не должен попасть в данные',
    'node_modules/ws/package.json': '{"name":"evil"}',
    ...extra,
  };
}

/** Архив версии, как его отдаёт GitHub (папка bot-main/), подписанный тестовым ключом. tamper — подмена после подписи. */
function release(version: string, extra: Record<string, string> = {}, deps: Record<string, string> = { ws: '^8' }, o: ReleaseOpts = {}) {
  const files = releaseFiles(version, extra, deps);
  const sign = o.sign ?? 'test';
  if (sign !== 'none') {
    const pem = sign === 'other' ? crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() : TEST_KEY_PEM;
    files[SIGNATURE_FILE] = signUpdate(o.signedVersion ?? version, new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])), pem);
  }
  o.tamper?.(files);
  return makeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => ['bot-main/' + k, v])));
}

/** Установленная программа версии 1.1.0 во временной папке. */
function setupInstall(opts: { git?: boolean; hadData?: boolean } = {}) {
  const root = tmpDir('tab-upd-');
  const w = (rel: string, content: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  w('package.json', JSON.stringify({ name: 'twitch-alert-bot', version: '1.1.0', dependencies: { ws: '^8' } }));
  w('changelog.json', changelog(['1.1.0', '1.0.0']));
  w('src/main.ts', '// main 1.1.0');
  w('public/panel/app.js', '// panel 1.1.0');
  w('public/overlay/overlay.js', '// overlay');
  w('launcher/TrayLauncher.cs', '// launcher 1.1.0');
  w('TwitchAlertBot.exe', 'MZ old launcher');
  w('node_modules/ws/package.json', '{"name":"ws"}');
  w('data/keep.txt', 'данные пользователя');
  if (opts.git) fs.mkdirSync(path.join(root, '.git'));
  const db = new Db(path.join(root, 'data', 'bot.sqlite'));
  if (opts.hadData) db.updateSettings({ masterVolume: 70 });
  cleanup.push(() => db.close());
  return { root, db, read: (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8') };
}

function makeUpdater(ctx: ReturnType<typeof setupInstall>, o: { transport?: Transport; fetch?: MockTwitch; runNpm?: (cwd: string) => Promise<void>; launcherBuilds?: string[] } = {}) {
  const fetchMock = o.fetch ?? new MockTwitch().on('GET', CL_PATH, () => new Response(changelog(['1.2.0', '1.1.0', '1.0.0']), { status: 200 }));
  const journal: string[] = [];
  const statuses: UpdateStatus[] = [];
  const u = new Updater({
    db: ctx.db, log: quietLogger().child('update'), journal: (_l, _t, m) => journal.push(m), appRoot: ctx.root, dataDir: path.join(ctx.root, 'data'),
    currentVersion: '1.1.0', repo: 'owner/bot', fetchFn: fetchMock.fetch as typeof fetch, transport: o.transport,
    runNpm: o.runNpm, buildLauncher: async (r) => { o.launcherBuilds?.push(r); }, onChange: (s) => statuses.push(s),
    publicKeys: [TEST_PUB],
  });
  let restarted = 0;
  u.onRestart = () => { restarted++; };
  return { u, journal, statuses, restarted: () => restarted };
}

// ---------- версии и список изменений ----------
test('сравнение версий и разбор списка изменений', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.2.0', '1.2') === 0);
  assert.ok(compareVersions('1.1.0', '1.1.1') < 0);
  const list = parseChangelog([{ version: '1.0.0', changes: ['a'] }, { version: 'bad', changes: [] }, { version: '1.2.0', changes: ['b', 3] }]);
  assert.deepEqual(list.map((e) => e.version), ['1.2.0', '1.0.0']);
  assert.deepEqual(list[0].changes, ['b', '3']);
  assert.throws(() => parseChangelog({}));
  // Собственный changelog.json проекта корректен, и его последняя версия совпадает с package.json.
  const own = parseChangelog(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'changelog.json'), 'utf8')));
  assert.equal(own[0].version, APP_VERSION, 'changelog.json и package.json должны иметь одну версию');
});

// ---------- ZIP ----------
test('ZIP: чтение deflate и без сжатия; отклонение zip slip и повреждений', () => {
  const files = { 'a/b.txt': 'привет', 'a/c/d.bin': Buffer.alloc(5000, 7) };
  for (const store of [false, true]) {
    const out = readZip(makeZip(files, { store }));
    assert.deepEqual(out.map((e) => e.name), ['a/b.txt', 'a/c/d.bin']);
    assert.equal(out[0].data.toString(), 'привет');
  }
  for (const bad of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', 'a//b']) {
    assert.equal(safeEntryName(bad), null, bad);
    assert.throws(() => readZip(makeZip({ [bad]: 'x' })), /Недопустимый путь/, bad);
  }
  assert.throws(() => readZip(makeZip({ 'a.txt': 'x' }, { badCrc: 'a.txt' })), /контрольная сумма/);
  assert.throws(() => readZip(Buffer.from('это не zip, а просто текст для проверки')), /не найден каталог/);
  assert.throws(() => readZip(makeZip({ 'a.txt': 'x', 'b.txt': 'y' }), { maxEntries: 1 }), /слишком много/);
});

// ---------- проверка обновлений ----------
test('проверка: новая версия найдена, список изменений только по новым версиям; ошибки сети понятны', async () => {
  const ctx = setupInstall();
  const { u } = makeUpdater(ctx);
  const st = await u.check();
  assert.equal(st.latest, '1.2.0');
  assert.equal(st.available, true);
  assert.deepEqual(st.notes.map((n) => n.version), ['1.2.0']);
  assert.equal(st.canInstall, true);

  const same = makeUpdater(ctx, { fetch: new MockTwitch().on('GET', CL_PATH, () => new Response(changelog(['1.1.0']), { status: 200 })) }).u;
  assert.equal((await same.check()).available, false);

  const offline = new MockTwitch().on('GET', CL_PATH, () => { throw new TypeError('fetch failed'); });
  const st2 = await makeUpdater(ctx, { fetch: offline }).u.check();
  assert.match(st2.error, /Нет связи с GitHub/);
  assert.equal(st2.available, false);
  const broken = new MockTwitch().on('GET', CL_PATH, () => new Response('<html>', { status: 200 }));
  assert.match((await makeUpdater(ctx, { fetch: broken }).u.check()).error, /список изменений/);
});

// ---------- установка ----------
test('установка: файлы заменены, данные и зависимости не тронуты, резервная копия, лаунчер, перезапуск', async () => {
  const ctx = setupInstall();
  const builds: string[] = [];
  const { u, journal, statuses, restarted } = makeUpdater(ctx, { transport: zipTransport(release('1.2.0')), launcherBuilds: builds });
  await u.check();
  await u.install();
  assert.equal(ctx.read('src/main.ts'), '// main 1.2.0');
  assert.equal(ctx.read('src/new-module.ts'), 'export const x = 1;');
  assert.equal(ctx.read('public/panel/app.js'), '// panel 1.2.0');
  assert.equal(JSON.parse(ctx.read('package.json')).version, '1.2.0');
  assert.equal(ctx.read('data/keep.txt'), 'данные пользователя');
  assert.equal(fs.existsSync(path.join(ctx.root, 'data', 'evil.txt')), false, 'папка data из архива не копируется');
  assert.equal(ctx.read('node_modules/ws/package.json'), '{"name":"ws"}', 'node_modules не трогаются');
  assert.equal(builds.length, 1, 'лаунчер изменился — пересобран');
  const backups = fs.readdirSync(path.join(ctx.root, 'data', 'updates'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'data', 'updates', backups[0], 'src', 'main.ts'), 'utf8'), '// main 1.1.0');
  assert.ok(journal.some((m) => /Установлена версия 1\.2\.0/.test(m)));
  assert.deepEqual([...new Set(statuses.map((s) => s.step))].filter((s) => s !== 'idle'), ['download', 'unpack', 'copy', 'launcher', 'restart']);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(restarted(), 1);
});

test('установка: неверная версия в архиве, повреждённый архив, сбой зависимостей — откат без изменений', async () => {
  const ctx = setupInstall();
  // Архив другой версии.
  let m = makeUpdater(ctx, { transport: zipTransport(release('1.1.5')) });
  await m.u.check();
  await assert.rejects(m.u.install(), /версия 1\.1\.5, а ожидалась 1\.2\.0/);
  assert.equal(ctx.read('src/main.ts'), '// main 1.1.0');
  assert.equal(m.u.status().step, 'error');

  // Повреждённый архив.
  m = makeUpdater(ctx, { transport: zipTransport(Buffer.from('not a zip at all, some html error page')) });
  await m.u.check();
  await assert.rejects(m.u.install(), /не найден каталог/);

  // Новая зависимость, npm не смог её поставить → файлы возвращены, новые удалены.
  m = makeUpdater(ctx, { transport: zipTransport(release('1.2.0', {}, { ws: '^8', 'new-dep': '^1' })), runNpm: async () => { throw new Error('npm failed'); } });
  await m.u.check();
  await assert.rejects(m.u.install(), /install\.cmd/);
  assert.equal(ctx.read('src/main.ts'), '// main 1.1.0');
  assert.equal(JSON.parse(ctx.read('package.json')).version, '1.1.0');
  assert.equal(fs.existsSync(path.join(ctx.root, 'src', 'new-module.ts')), false);
  assert.ok(m.journal.some((x) => /Прежняя версия восстановлена/.test(x)));
  assert.equal(m.restarted(), 0);
});

test('подпись обновления: без подписи, чужой ключ, подменённый/лишний/недостающий файл, чужая версия — ничего не установлено', async () => {
  const ctx = setupInstall();
  const cases: Array<[string, Buffer, RegExp]> = [
    ['без подписи', release('1.2.0', {}, undefined, { sign: 'none' }), /не подписано автором/],
    ['чужой ключ', release('1.2.0', {}, undefined, { sign: 'other' }), /не прошла проверку/],
    ['подменён файл', release('1.2.0', {}, undefined, { tamper: (f) => { f['src/main.ts'] = 'require("child_process").exec("calc")'; } }), /src\/main\.ts .*не совпадает/],
    ['лишний файл', release('1.2.0', {}, undefined, { tamper: (f) => { f['src/evil.ts'] = 'evil'; } }), /лишний файл src\/evil\.ts/],
    ['нет файла', release('1.2.0', {}, undefined, { tamper: (f) => { delete f['src/new-module.ts']; } }), /не хватает файла src\/new-module\.ts/],
    ['подпись испорчена', release('1.2.0', {}, undefined, { tamper: (f) => { f[SIGNATURE_FILE] = f[SIGNATURE_FILE].replace(/"signature": "./, '"signature": "A'); } }), /не прошла проверку|повреждена/],
    ['подпись другой версии', release('1.2.0', {}, undefined, { signedVersion: '1.1.9' }), /Подпись выдана для версии 1\.1\.9/],
  ];
  for (const [name, zip, re] of cases) {
    const m = makeUpdater(ctx, { transport: zipTransport(zip) });
    await m.u.check();
    await assert.rejects(m.u.install(), re, name);
    assert.equal(ctx.read('src/main.ts'), '// main 1.1.0', name);
    assert.equal(fs.existsSync(path.join(ctx.root, 'src', 'evil.ts')), false, name);
    assert.equal(m.restarted(), 0, name);
  }
  // Ключ бота настоящий: тестовая подпись им не проходит, а формат ключа читается.
  assert.ok(UPDATE_PUBLIC_KEYS.length >= 1 && !UPDATE_PUBLIC_KEYS.includes(TEST_PUB));
  const files = new Map(Object.entries(releaseFiles('1.2.0')).map(([k, v]) => [k, Buffer.from(v)] as [string, Buffer]));
  files.set(SIGNATURE_FILE, Buffer.from(signUpdate('1.2.0', files, TEST_KEY_PEM)));
  assert.throws(() => verifyUpdate(files), /не прошла проверку/);
  assert.equal(verifyUpdate(files, [TEST_PUB]).version, '1.2.0');
});

test('установка запрещена в рабочей папке git (копия разработчика)', async () => {
  const ctx = setupInstall({ git: true });
  const { u } = makeUpdater(ctx, { transport: zipTransport(release('1.2.0')) });
  const st = await u.check();
  assert.equal(st.available, true);
  assert.equal(st.canInstall, false);
  assert.match(st.reason, /git/);
  await assert.rejects(u.install(), /git/);
  assert.equal(ctx.read('src/main.ts'), '// main 1.1.0');
});

// ---------- «Что нового» ----------
test('«Что нового»: новым пользователям не показывается, обновившимся — один раз', () => {
  const fresh = setupInstall();
  assert.equal(makeUpdater(fresh).u.status().whatsNew.length, 0);
  const upgraded = setupInstall({ hadData: true });
  const m = makeUpdater(upgraded);
  assert.deepEqual(m.u.status().whatsNew.map((e) => e.version), ['1.1.0']);
  m.u.markSeen();
  assert.equal(m.u.status().whatsNew.length, 0);
  assert.equal(makeUpdater(upgraded).u.status().whatsNew.length, 0, 'после перезапуска окно не повторяется');
});

// ---------- HTTP ----------
test('HTTP: состояние обновлений и ссылки поддержки в панели; установка требует подтверждения', async () => {
  const dir = tmpDir();
  const app = new App({ paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: standardTwitch().fetch as typeof fetch, eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  const call = (method: string, p: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, any> }));
  const st = await call('GET', '/api/state');
  assert.equal(st.body.links.boosty, 'https://boosty.to/spiteman/donate');
  assert.equal(st.body.links.boostyProfile, 'https://boosty.to/spiteman');
  assert.match(st.body.links.ideas, /^https:\/\/github\.com\/.+\/issues\/new/);
  assert.equal(st.body.update.current, APP_VERSION);
  assert.ok(Array.isArray(st.body.changelog) && st.body.changelog.length > 0);
  assert.equal((await call('POST', '/api/update/install', {})).status, 400);
  assert.equal((await call('POST', '/api/update/install', { confirm: true })).status, 400, 'новой версии нет — установка не начинается');
  assert.equal((await call('POST', '/api/update/seen')).status, 200);
  void json;
});
