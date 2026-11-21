import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths, validateSettingsPatch } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { standardTwitch, quietLogger, tmpDir } from './helpers.ts';

// 2.0.0: новая панель — палитра (панель и док OBS), метки «на связи» у источников на странице «OBS / Streamlabs».

const ROOT = path.join(import.meta.dirname, '..');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp() {
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(tmpDir()), logger: quietLogger(), store: new MemoryStore(), port: 0, fetchFn: twitch.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, port: app.port };
}

const api = (port: number, method: string, p: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-tab-request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

function openStats(port: number, query: string, ua: string): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/stats${query}`, { headers: { 'User-Agent': ua, Origin: `http://127.0.0.1:${port}` } });
    ws.once('message', (d) => resolve({ ws, first: JSON.parse(String(d)) as Record<string, unknown> }));
    ws.once('error', reject);
    cleanup.push(() => ws.close());
  });
}

test('палитра панели: проверка значения, по умолчанию «Аметист», уходит в док вместе со статистикой', async () => {
  assert.deepEqual(validateSettingsPatch({ panelTheme: 'graphite' }), { ok: { panelTheme: 'graphite' }, error: null });
  assert.match(validateSettingsPatch({ panelTheme: 'neon' }).error ?? '', /Неверная палитра панели/);
  const { port } = await startApp();
  const st = await (await api(port, 'GET', '/api/state')).json() as { settings: { panelTheme: string } };
  assert.equal(st.settings.panelTheme, 'amethyst');
  const dock = await openStats(port, '?kind=dock', 'Mozilla/5.0 Chrome/130');
  assert.equal(dock.first.theme, 'amethyst');
  const next = new Promise<Record<string, unknown>>((r) => dock.ws.on('message', (d) => { const m = JSON.parse(String(d)) as Record<string, unknown>; if (m.theme === 'midnight') r(m); }));
  assert.equal((await api(port, 'POST', '/api/settings', { panelTheme: 'midnight' })).status, 200);
  assert.equal((await next).theme, 'midnight', 'док получает новую палитру сразу');
});

test('метки источников: док, overlay и счётчики считаются по виду страницы, предпросмотры панели — нет', async () => {
  const { port } = await startApp();
  const sources = async () => ((await (await api(port, 'GET', '/api/stats')).json()) as { setup: { sources: Record<string, { count: number; app: string | null }> } }).setup.sources;
  assert.deepEqual(await sources(), { dock: { count: 0, app: null }, overlay: { count: 0, app: null }, counter: { count: 0, app: null } });
  const dock = await openStats(port, '?kind=dock', 'Mozilla/5.0 (Windows NT 10.0) OBS/31.0.0 Chrome/116');
  await openStats(port, '?kind=overlay&preview=1', 'Mozilla/5.0 Chrome/130');
  await openStats(port, '?kind=counter', 'Mozilla/5.0 Chrome/130');
  await openStats(port, '?kind=bogus', 'Mozilla/5.0 Chrome/130');
  await openStats(port, '', 'Mozilla/5.0 Chrome/130');
  const s = await sources();
  assert.deepEqual(s.dock, { count: 1, app: 'obs' });
  assert.deepEqual(s.overlay, { count: 0, app: null }, 'предпросмотр в панели не считается');
  assert.deepEqual(s.counter, { count: 1, app: null }, 'обычный браузер — без программы');
  dock.ws.close();
  for (let i = 0; i < 100 && (await sources()).dock.count !== 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await sources()).dock.count, 0, 'закрытый док больше не считается');
});

test('страницы статистики передают вид страницы, панель — предпросмотр', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(read('public/stats/dock.js'), /setConn, 'dock'\)/);
  assert.match(read('public/stats/overlay.js'), /\}, 'overlay'\);/);
  assert.match(read('public/stats/counter.js'), /\}, 'counter'\);/);
  const app = read('public/panel/app.js');
  assert.match(app, /\/stats\/overlay\?preview=1/);
  assert.match(app, /\/stats\/counter\?preview=1/);
  assert.match(app, /\/stats\/dock\?embed=1/);
  // Шрифты лежат в папке панели (без интернета), лицензия рядом.
  for (const f of ['inter-latin.woff2', 'inter-cyrillic.woff2', 'unbounded-latin.woff2', 'unbounded-cyrillic.woff2', 'jetbrainsmono-latin.woff2', 'jetbrainsmono-cyrillic.woff2', 'OFL.txt']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'panel', 'fonts', f)), f);
  }
});
