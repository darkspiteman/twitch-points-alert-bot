import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { App } from '../src/app.ts';
import { makePaths } from '../src/config.ts';
import { MemoryStore, DpapiProtector, TestProtector } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { launchDenied } from '../src/stream-app.ts';
import { standardTwitch, quietLogger, tmpDir } from './helpers.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(dir = tmpDir(), before?: (app: App) => void) {
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: twitch.fetch as typeof fetch, protector: new TestProtector(),
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  before?.(app);
  await app.start();
  const stop = async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); };
  cleanup.push(stop);
  return { app, port: app.port, dir, stop };
}
const api = (port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test('запросы к /api по команде чужого сайта отклоняются (даже GET), своя панель и трей — работают', async () => {
  const { port } = await startApp();
  for (const site of ['cross-site', 'same-site']) {
    for (const p of ['/api/state', '/api/find/klipy?q=x', '/api/logs']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' } });
      assert.equal(r.status, 403, `${site} ${p}`);
    }
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200, 'панель');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'трей (без заголовков браузера)');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'sec-fetch-site': 'none' } })).status, 200, 'адрес, введённый вручную');
  // Overlay из «Локального файла» открывается переходом с другого «сайта» — это не /api, он не блокируется.
  assert.equal((await fetch(`http://127.0.0.1:${port}/overlay?via=file`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
});

test('запуск программы для стрима: только obs64.exe / Streamlabs OBS.exe из Program Files или папки пользователя', async () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', USERPROFILE: 'C:\\Users\\Streamer', SystemDrive: 'C:' } as NodeJS.ProcessEnv;
  assert.equal(launchDenied('C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', 'obs', env), '');
  assert.equal(launchDenied('c:\\program files\\OBS-Studio\\bin\\64bit\\OBS64.EXE', 'obs', env), '', 'регистр не важен');
  assert.equal(launchDenied('C:\\Users\\Streamer\\Portable\\obs64.exe', 'obs', env), '', 'своя папка пользователя');
  assert.equal(launchDenied('C:\\Program Files\\Streamlabs OBS\\Streamlabs OBS.exe', 'streamlabs', env), '');
  assert.match(launchDenied('C:\\Program Files\\obs-studio\\bin\\64bit\\cmd.exe', 'obs', env), /только «obs64\.exe»/);
  assert.match(launchDenied('C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', 'streamlabs', env), /Streamlabs OBS\.exe/);
  assert.match(launchDenied('C:\\Users\\Public\\obs64.exe', 'obs', env), /Program Files/, 'общая папка — туда пишут все пользователи');
  assert.match(launchDenied('D:\\Games\\obs64.exe', 'obs', env), /Program Files/);
  assert.match(launchDenied('C:\\Users\\Other\\obs64.exe', 'obs', env), /Program Files/, 'папка другого пользователя');
  assert.match(launchDenied('C:\\Program Files\\..\\Users\\Public\\obs64.exe', 'obs', env), /Program Files/, '«..» в пути');
  assert.match(launchDenied('C:\\Program Files Evil\\obs64.exe', 'obs', env), /Program Files/, 'похожее имя папки');

  // Через API: путь к чужой программе сохранить можно, но запустить её бот откажется (и ничего не запустит).
  const { port } = await startApp();
  assert.equal((await api(port, 'POST', '/api/settings', { obsExePath: process.execPath })).status, 200);
  const r = await api(port, 'POST', '/api/obs/launch');
  assert.equal(r.status, 400);
  assert.match((await r.json() as { error: string }).error, /только «obs64\.exe»/);
});

test('ключи Klipy и Freesound хранятся в базе зашифрованными; старые открытые ключи шифруются при запуске', async () => {
  const dir = tmpDir();
  const KEY = 'klipyKey_1234567890abcdef';
  // База версии 1.4.0: ключ Freesound лежит открытым текстом.
  let s = await startApp(dir, (app) => app.db.updateSettings({ freesoundApiKey: 'freesoundOld_123456' }));
  assert.ok(String(s.app.db.rawSetting('freesoundApiKey')).startsWith('enc:'), 'старый ключ зашифрован при запуске');
  assert.equal(s.app.db.getSettings().freesoundApiKey, 'freesoundOld_123456');
  // Новый ключ через панель
  assert.equal((await api(s.port, 'POST', '/api/settings', { klipyApiKey: KEY })).status, 200);
  const raw = String(s.app.db.rawSetting('klipyApiKey'));
  assert.ok(raw.startsWith('enc:') && !raw.includes(KEY), 'в базе не открытый текст');
  assert.equal(s.app.db.getSettings().klipyApiKey, KEY, 'бот пользуется ключом');
  const state = await (await fetch(`http://127.0.0.1:${s.port}/api/state`)).json() as { settings: { klipyApiKey: string }; find: { klipy: boolean } };
  assert.equal(state.settings.klipyApiKey, '••••cdef', 'в панель — только маска');
  assert.equal(state.find.klipy, true);
  await s.stop();
  // После перезапуска ключ расшифрован
  s = await startApp(dir);
  assert.equal(s.app.db.getSettings().klipyApiKey, KEY);
  // Удаление ключа
  await api(s.port, 'POST', '/api/settings', { klipyApiKey: '' });
  assert.equal(s.app.db.getSettings().klipyApiKey, '');
  assert.equal(s.app.db.rawSetting('klipyApiKey'), '');
  await s.stop();
  // Ключ, который не расшифровывается (база с другого компьютера), — пусто и подсказка в журнале
  s = await startApp(dir, (app) => app.db.updateSettings({ freesoundApiKey: 'enc:bm90LXZhbGlk' }));
  assert.equal(s.app.db.getSettings().freesoundApiKey, '');
  assert.ok(s.app.db.recentEvents(10).some((e) => /Не удалось расшифровать ключ Freesound/.test(e.message)));
});

test('DPAPI шифрует и расшифровывает ключ (настоящий Windows)', { skip: process.platform !== 'win32' }, async () => {
  const p = new DpapiProtector();
  const enc = await p.protect('secret-key-ключ');
  assert.ok(!Buffer.from(enc, 'base64').toString('latin1').includes('secret-key'));
  assert.equal(await p.unprotect(enc), 'secret-key-ключ');
  void path;
});
