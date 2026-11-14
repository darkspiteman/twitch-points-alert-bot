import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths, validateSettingsPatch, defaultSettings } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { detectStreamAppFromUA, resolveExe, scenesDir, backupScenes, streamlabsExeCandidates, type StreamAppSettings } from '../src/stream-app.ts';
import { standardTwitch, quietLogger, tmpDir, waitFor, delay } from './helpers.ts';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
/** Реальные User-Agent Browser Source (формат из obs-browser и его форка stream-labs/obs-browser). */
const UA_OBS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.120 Safari/537.36 OBS/31.0.2';
const UA_SLD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.120 Safari/537.36 OBS/30.2.4 SLD';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface Ctx { app: App; server: http.Server; port: number; dir: string }
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(): Promise<Ctx> {
  const dir = tmpDir();
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: twitch.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  app.port = port;
  app.db.updateSettings({ clientId: CLIENT, gapBetweenMs: 0 });
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, server, port, dir };
}

/** Overlay-клиент: User-Agent и hello как у overlay.js в соответствующей программе. */
async function overlay(port: number, ua: string, hello: Record<string, unknown>) {
  const plays: { id: string }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}`, 'User-Agent': ua } });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'play') {
      plays.push(m.item);
      setTimeout(() => ws.send(JSON.stringify({ type: 'ended', id: m.item.id })), 20);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', ...hello }));
  cleanup.push(() => ws.terminate());
  return { ws, plays };
}

const api = (port: number, method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('определение программы по User-Agent: OBS, Streamlabs (метка SLD), обычный браузер', () => {
  assert.equal(detectStreamAppFromUA(UA_OBS), 'obs');
  assert.equal(detectStreamAppFromUA(UA_SLD), 'streamlabs');
  assert.equal(detectStreamAppFromUA('Mozilla/5.0 Streamlabs Desktop'), 'streamlabs');
  assert.equal(detectStreamAppFromUA(UA_CHROME), null);
  assert.equal(detectStreamAppFromUA(''), null);
  assert.equal(detectStreamAppFromUA('Mozilla/5.0 SLDX'), null, 'SLD — отдельное слово');
});

/** Запуск public/overlay/overlay.js в песочнице с заданным User-Agent и window.obsstudio; возвращает его hello. */
function overlayHello(ua: string, obsstudio: boolean): { hello: Record<string, unknown>; statusShown: boolean } {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'overlay.js'), 'utf8');
  const sent: string[] = [];
  const status = { hidden: true, className: '', textContent: '', appendChild() {} };
  class FakeWs {
    readyState = 1;
    onopen: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(s: string) { sent.push(s); }
    close() {}
  }
  const win: Record<string, unknown> = {};
  if (obsstudio) win.obsstudio = { pluginVersion: '2.24.0' };
  const ctx = vm.createContext({
    window: win, navigator: { userAgent: ua }, location: { search: '', protocol: 'http:', host: '127.0.0.1:17420' }, URLSearchParams,
    document: { getElementById: (id: string) => (id === 'status' ? status : { className: '', style: { setProperty() {} }, appendChild() {} }), createElement: () => ({ remove() {}, addEventListener() {} }) },
    WebSocket: FakeWs, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, Date,
  });
  vm.runInContext(src, ctx);
  return { get hello() { return JSON.parse(sent.find((s) => s.includes('"hello"')) ?? '{}'); }, get statusShown() { return !status.hidden; } };
}

test('overlay.js: в Streamlabs и OBS сообщает программу, в обычном браузере — предпросмотр', async () => {
  const sl = overlayHello(UA_SLD, true);
  const obs = overlayHello(UA_OBS, true);
  const oldSl = overlayHello(UA_CHROME, true); // Streamlabs без метки в User-Agent: виден только window.obsstudio
  const browser = overlayHello(UA_CHROME, false);
  await delay(0);
  assert.deepEqual(sl.hello, { type: 'hello', isObs: true, app: 'streamlabs' });
  assert.deepEqual(obs.hello, { type: 'hello', isObs: true, app: 'obs' });
  assert.deepEqual(oldSl.hello, { type: 'hello', isObs: true, app: 'obs' });
  assert.deepEqual(browser.hello, { type: 'hello', isObs: false, app: null });
  assert.equal(sl.statusShown, false, 'в Streamlabs строка состояния не видна зрителям');
  assert.equal(browser.statusShown, true, 'в браузере видна строка состояния с кнопкой «Включить звук»');
});

test('Streamlabs: оповещения идут в Streamlabs, а не во вкладку предпросмотра в браузере', async () => {
  const { app, port } = await startApp();
  const preview = await overlay(port, UA_CHROME, { isObs: false, app: null });
  const sl = await overlay(port, UA_SLD, { isObs: true, app: 'streamlabs' });
  await waitFor(() => app.hub.overlayList().length === 2);

  const list = app.hub.overlayList();
  const slInfo = list.find((o) => o.app === 'streamlabs');
  assert.ok(slInfo, 'overlay Streamlabs определён');
  assert.equal(slInfo.isObs, true, 'Streamlabs — программа для стрима, а не предпросмотр');
  assert.equal(list.filter((o) => o.app === null).length, 1, 'вкладка браузера — предпросмотр');
  assert.deepEqual(app.hub.overlayIds(), [slInfo.id]);

  assert.equal((await api(port, 'POST', '/api/test')).status, 200);
  await waitFor(() => sl.plays.length === 1);
  await delay(150);
  assert.equal(preview.plays.length, 0, 'предпросмотр в браузере ничего не получил');

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Record<string, unknown>;
  assert.equal(health.overlays, 2);
  assert.equal(health.obsOverlays, 1, 'лаунчер в трее считает Streamlabs подключённой программой');
  assert.equal(health.streamlabsOverlays, 1);
  assert.equal(health.streamApp, 'obs');
});

test('Streamlabs без метки SLD в User-Agent распознаётся по hello от overlay (window.obsstudio)', async () => {
  const { app, port } = await startApp();
  await overlay(port, UA_CHROME, { isObs: true, app: 'streamlabs' });
  await waitFor(() => app.hub.overlayList().length === 1 && app.hub.overlayList()[0].app !== null);
  assert.equal(app.hub.overlayList()[0].app, 'streamlabs');
  assert.equal(app.hub.overlayList()[0].isObs, true);
});

test('OBS не сломан: старый overlay (hello без app) — OBS; предпросмотр не получает оповещений', async () => {
  const { app, port } = await startApp();
  const preview = await overlay(port, UA_CHROME, { isObs: false });
  const obs = await overlay(port, UA_OBS, { isObs: true });
  const legacy = await overlay(port, 'Mozilla/5.0', { isObs: true }); // overlay старой версии, открытый в OBS
  await waitFor(() => app.hub.overlayList().filter((o) => o.app === 'obs').length === 2);
  assert.equal((await api(port, 'POST', '/api/test')).status, 200);
  await waitFor(() => obs.plays.length === 1 && legacy.plays.length === 1);
  await delay(150);
  assert.equal(preview.plays.length, 0);
});

test('одновременно OBS и Streamlabs: обе программы получают оповещение (панель предупреждает о двойном звуке)', async () => {
  const { app, port } = await startApp();
  const obs = await overlay(port, UA_OBS, { isObs: true, app: 'obs' });
  const sl = await overlay(port, UA_SLD, { isObs: true, app: 'streamlabs' });
  await waitFor(() => app.hub.overlayList().length === 2);
  assert.deepEqual(app.hub.overlayList().map((o) => o.app).sort(), ['obs', 'streamlabs']);
  assert.equal((await api(port, 'POST', '/api/test')).status, 200);
  await waitFor(() => obs.plays.length === 1 && sl.plays.length === 1);
});

test('настройка «программа для стрима»: проверка значений и сохранение через API', async () => {
  assert.equal(defaultSettings().streamApp, 'obs');
  assert.equal(validateSettingsPatch({ streamApp: 'streamlabs' }).error, null);
  assert.match(validateSettingsPatch({ streamApp: 'xsplit' }).error!, /OBS Studio или Streamlabs Desktop/);
  assert.equal(validateSettingsPatch({ streamlabsExePath: 'D:\\Apps\\Streamlabs OBS.exe', streamlabsConfigDir: 'D:\\slobs-client' }).error, null);

  const { app, port } = await startApp();
  const r = await api(port, 'POST', '/api/settings', { streamApp: 'streamlabs' });
  assert.equal(r.status, 200);
  assert.equal(app.db.getSettings().streamApp, 'streamlabs');
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Record<string, unknown>;
  assert.equal(health.streamApp, 'streamlabs', 'лаунчер показывает «Streamlabs ✓» вместо «OBS ✓»');
  assert.equal((await api(port, 'POST', '/api/settings', { streamApp: 'bad' })).status, 400);
});

function settings(over: Partial<StreamAppSettings>): StreamAppSettings {
  return { streamApp: 'obs', obsExePath: '', obsConfigDir: '', streamlabsExePath: '', streamlabsConfigDir: '', ...over };
}

test('путь к программе: OBS по настройке, Streamlabs — по настройке или поиск в стандартных папках', () => {
  const have = new Set<string>();
  const exists = (p: string) => have.has(p);
  const candidate = streamlabsExeCandidates()[0];
  assert.match(candidate, /Streamlabs OBS\.exe$/);
  assert.equal(resolveExe(settings({ streamApp: 'streamlabs' }), exists), null, 'не установлен');
  have.add(candidate);
  assert.equal(resolveExe(settings({ streamApp: 'streamlabs' }), exists), candidate, 'найден автоматически');
  assert.equal(resolveExe(settings({ streamApp: 'streamlabs', streamlabsExePath: 'D:\\SL\\Streamlabs OBS.exe' }), exists), null, 'указанный путь не существует');
  have.add('D:\\SL\\Streamlabs OBS.exe');
  assert.equal(resolveExe(settings({ streamApp: 'streamlabs', streamlabsExePath: 'D:\\SL\\Streamlabs OBS.exe' }), exists), 'D:\\SL\\Streamlabs OBS.exe');
  have.add('C:\\obs\\obs64.exe');
  assert.equal(resolveExe(settings({ streamApp: 'obs', obsExePath: 'C:\\obs\\obs64.exe' }), exists), 'C:\\obs\\obs64.exe');
  assert.equal(resolveExe(settings({ streamApp: 'obs', obsExePath: '' }), exists), null);
});

test('резервная копия сцен: OBS (basic/scenes) и Streamlabs (SceneCollections, включая .absolute.bak)', () => {
  const root = tmpDir();
  const backups = path.join(root, 'backups');
  // OBS
  const obsDir = path.join(root, 'obs-studio');
  fs.mkdirSync(path.join(obsDir, 'basic', 'scenes'), { recursive: true });
  for (const f of ['Основная.json', 'Основная.json.bak', 'notes.txt']) fs.writeFileSync(path.join(obsDir, 'basic', 'scenes', f), '{}');
  const o = backupScenes(settings({ streamApp: 'obs', obsConfigDir: obsDir }), backups);
  assert.equal(o.count, 2);
  assert.deepEqual(fs.readdirSync(o.dir).sort(), ['Основная.json', 'Основная.json.bak']);
  // Streamlabs
  const slDir = path.join(root, 'slobs-client');
  assert.equal(scenesDir(settings({ streamApp: 'streamlabs', streamlabsConfigDir: slDir })), path.join(slDir, 'SceneCollections'));
  assert.throws(() => backupScenes(settings({ streamApp: 'streamlabs', streamlabsConfigDir: slDir }), backups), /Папка сцен Streamlabs Desktop не найдена/);
  fs.mkdirSync(path.join(slDir, 'SceneCollections'), { recursive: true });
  const files = ['manifest.json', '3f1c.json', '3f1c.json.bak', '3f1c.json.absolute.bak', 'thumb.png'];
  for (const f of files) fs.writeFileSync(path.join(slDir, 'SceneCollections', f), f);
  const s = backupScenes(settings({ streamApp: 'streamlabs', streamlabsConfigDir: slDir }), backups);
  assert.equal(s.count, 4);
  assert.match(path.basename(s.dir), /^streamlabs-/);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ['3f1c.json', '3f1c.json.absolute.bak', '3f1c.json.bak', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(s.dir, '3f1c.json.absolute.bak'), 'utf8'), '3f1c.json.absolute.bak');
});

test('HTTP: резервная копия сцен Streamlabs и понятная ошибка запуска, если программа не найдена', async () => {
  const { app, port, dir } = await startApp();
  const slDir = path.join(dir, 'slobs-client');
  fs.mkdirSync(path.join(slDir, 'SceneCollections'), { recursive: true });
  fs.writeFileSync(path.join(slDir, 'SceneCollections', 'manifest.json'), '{}');
  app.db.updateSettings({ streamApp: 'streamlabs', streamlabsConfigDir: slDir, streamlabsExePath: path.join(dir, 'нет', 'Streamlabs OBS.exe') });

  const b = await api(port, 'POST', '/api/obs/backup');
  assert.equal(b.status, 200);
  const { dir: copy } = await b.json() as { dir: string };
  assert.ok(fs.existsSync(path.join(copy, 'manifest.json')));
  assert.ok(copy.startsWith(app.opts.paths.backupDir));
  assert.ok(app.db.recentEvents(20).some((e) => /Резервная копия сцен Streamlabs Desktop \(1 файлов\)/.test(e.message)));

  const l = await api(port, 'POST', '/api/obs/launch');
  const lj = await l.json() as { error?: string; already?: boolean };
  if (lj.already) return; // Streamlabs запущен на этом компьютере — запуск не нужен
  assert.equal(l.status, 400);
  assert.match(lj.error!, /Streamlabs Desktop не найден/);
});
