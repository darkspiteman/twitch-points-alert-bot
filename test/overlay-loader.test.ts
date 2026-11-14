import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import WebSocket from 'ws';
import { App } from '../src/app.ts';
import { makePaths } from '../src/config.ts';
import { MemoryStore } from '../src/secure-store.ts';
import { createServer } from '../src/server/http.ts';
import { loaderHtml, writeLoader, LOADER_FILE } from '../src/overlay-loader.ts';
import { standardTwitch, quietLogger, tmpDir, waitFor, delay } from './helpers.ts';

const CLIENT = 'abcdefghijklmnopqrstuvwxyz0123';
const UA_OBS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.120 Safari/537.36 OBS/31.0.2';
/** Так OBS открывает «Локальный файл»: http://absolute/C:/… — отсюда и Origin у WebSocket. */
const OBS_FILE_ORIGIN = 'http://absolute';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) { try { await cleanup.pop()!(); } catch { /* */ } } });

async function startApp(port = 0, dir = tmpDir()) {
  const twitch = standardTwitch();
  const app = new App({
    paths: makePaths(dir), logger: quietLogger(), store: new MemoryStore(), port, fetchFn: twitch.fetch as typeof fetch,
    idBase: 'https://id.test', helixBase: 'https://api.test/helix', eventsubUrl: 'ws://127.0.0.1:1/ws', noAutoUpdateCheck: true,
  });
  const server: http.Server = createServer(app, { onShutdown: () => {} });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  app.port = (server.address() as AddressInfo).port;
  app.db.updateSettings({ clientId: CLIENT, gapBetweenMs: 0 });
  await app.start();
  cleanup.push(async () => { await app.stop().catch(() => {}); server.closeAllConnections(); await new Promise((r) => server.close(() => r(null))); });
  return { app, port: app.port, dir };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Подключение к /ws/probe; возвращает первое сообщение или код отказа. */
function probe(port: number, origin?: string): Promise<{ msg?: Record<string, unknown>; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/probe`, origin ? { headers: { Origin: origin } } : {});
    ws.on('message', (d) => { resolve({ msg: JSON.parse(d.toString()) }); ws.close(); });
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => {});
  });
}

/**
 * Запускает скрипт загрузчика в песочнице, как в браузере OBS.
 * WebSocket — настоящий клиент ws с Origin «http://absolute» (как у локального файла в OBS) или подделка.
 */
function runLoader(html: string, opts: { obs: boolean; WebSocketImpl: unknown; timers?: 'real' | 'fast' }) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const replaced: string[] = [];
  const status = { textContent: '', style: { display: 'none' } };
  const pending = new Set<NodeJS.Timeout>();
  const st = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { pending.delete(t); fn(); }, opts.timers === 'fast' ? Math.min(ms, 5) : ms);
    pending.add(t);
    return t;
  };
  const ct = (t: NodeJS.Timeout) => { clearTimeout(t); pending.delete(t); };
  const win: Record<string, unknown> = {};
  if (opts.obs) win.obsstudio = { pluginVersion: '2.24.0' };
  const ctx = vm.createContext({
    window: win, navigator: { userAgent: opts.obs ? UA_OBS : 'Mozilla/5.0 Chrome/131.0.0.0' },
    location: { replace: (u: string) => { replaced.push(u); } },
    document: { getElementById: () => status },
    WebSocket: opts.WebSocketImpl, setTimeout: st, clearTimeout: ct, JSON,
  });
  vm.runInContext(script, ctx);
  cleanup.push(() => { for (const t of pending) clearTimeout(t); pending.clear(); });
  return { replaced, status };
}

test('загрузчик: в файле нужный порт и адрес overlay, неверный порт отклоняется', () => {
  const html = loaderHtml(17420);
  assert.match(html, /var PORT = 17420;/);
  assert.match(html, /'\/overlay\?via=file'/);
  assert.match(html, /connect-src ws:\/\/127\.0\.0\.1:17420"/, 'CSP разрешает только WebSocket к боту');
  assert.match(html, /\/\\bOBS\\\/\|\\bSLD\\b\|Streamlabs\/i/, 'регулярное выражение User-Agent записано без потери обратных слэшей');
  assert.throws(() => loaderHtml(0));
  assert.throws(() => loaderHtml(70000));
  assert.throws(() => loaderHtml(1.5));
});

test('загрузчик: файл пишется в папку данных, без лишних перезаписей, и обновляется при смене порта', async () => {
  const dir = tmpDir();
  const file = writeLoader(dir, 17420);
  assert.equal(file, path.join(dir, LOADER_FILE));
  assert.equal(fs.readFileSync(file, 'utf8'), loaderHtml(17420));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  writeLoader(dir, 17420);
  assert.equal(fs.statSync(file).mtimeMs, old.getTime(), 'одинаковое содержимое не перезаписывается');
  writeLoader(dir, 17500);
  assert.match(fs.readFileSync(file, 'utf8'), /var PORT = 17500;/);
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('бот при запуске создаёт загрузчик со своим портом и отдаёт путь панели', async () => {
  const { port, dir } = await startApp();
  const file = path.join(dir, LOADER_FILE);
  assert.equal(fs.readFileSync(file, 'utf8'), loaderHtml(port));
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as Record<string, unknown>;
  assert.equal(state.overlayLoader, file);
  assert.equal(state.overlayUrl, `http://127.0.0.1:${port}/overlay`);
});

test('/ws/probe: отвечает локальному файлу OBS, панели и файлу в браузере; чужим сайтам — отказ', async () => {
  const { port } = await startApp();
  for (const origin of [OBS_FILE_ORIGIN, 'null', 'file://', `http://127.0.0.1:${port}`, undefined]) {
    const r = await probe(port, origin);
    assert.deepEqual(r.msg, { type: 'ready', app: 'twitch-alert-bot' }, String(origin));
  }
  assert.equal((await probe(port, 'https://evil.example')).status, 403);
  // Исключение только для проверки: overlay и панель по-прежнему закрыты для локальных файлов.
  for (const p of ['/ws/overlay', '/ws/panel']) {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers: { Origin: OBS_FILE_ORIGIN } });
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => { resolve(101); ws.close(); });
      ws.on('error', () => {});
    });
    assert.equal(status, 403, p);
  }
});

test('загрузчик в песочнице: повторяет попытки, пока бот не ответит, затем открывает overlay', async () => {
  let attempts = 0;
  class FakeWs {
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      attempts++;
      const n = attempts;
      setTimeout(() => {
        if (n <= 2) { this.onerror?.(); this.onclose?.(); return; } // бот ещё не запущен
        if (n === 3) { this.onmessage?.({ data: '{"type":"hello"}' }); this.onclose?.(); return; } // на порту чужая программа
        this.onmessage?.({ data: JSON.stringify({ type: 'ready', app: 'twitch-alert-bot' }) });
      }, 1);
    }
    close() {}
  }
  const { replaced, status } = runLoader(loaderHtml(17420), { obs: true, WebSocketImpl: FakeWs, timers: 'fast' });
  await waitFor(() => replaced.length > 0);
  assert.equal(attempts, 4);
  assert.deepEqual(replaced, ['http://127.0.0.1:17420/overlay?via=file']);
  assert.equal(status.style.display, 'none', 'в OBS служебный текст не виден зрителям');

  const browser = runLoader(loaderHtml(17420), { obs: false, WebSocketImpl: class { constructor() { throw new Error('нет сети'); } }, timers: 'fast' });
  assert.equal(browser.status.style.display, 'block', 'в обычном браузере видно, что загрузчик ждёт бота');
  assert.match(browser.status.textContent, /Ждём запуска Twitch Alert Bot/);
  await delay(30);
  assert.equal(browser.replaced.length, 0);
});

test('OBS запущен раньше бота: загрузчик дожидается бота и открывает overlay, overlay помечен «через файл»', async () => {
  const port = await freePort();
  const dir = tmpDir();
  const html = fs.readFileSync(writeLoader(dir, port), 'utf8');
  class ObsFileWs extends WebSocket {
    constructor(url: string) { super(url, { headers: { Origin: OBS_FILE_ORIGIN, 'User-Agent': UA_OBS } }); }
  }
  const { replaced } = runLoader(html, { obs: true, WebSocketImpl: ObsFileWs, timers: 'real' });
  await delay(1300); // бот ещё не запущен — первые попытки неудачны
  assert.equal(replaced.length, 0);

  const { app } = await startApp(port, dir);
  await waitFor(() => replaced.length > 0, 5000);
  assert.deepEqual(replaced, [`http://127.0.0.1:${port}/overlay?via=file`]);

  // Overlay, открытый загрузчиком, сообщает via=file — панель не показывает подсказку «переключите на файл».
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/overlay`, { headers: { Origin: `http://127.0.0.1:${port}`, 'User-Agent': UA_OBS } });
  cleanup.push(() => ws.terminate());
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', isObs: true, app: 'obs', via: 'file' }));
  await waitFor(() => app.hub.overlayList().some((o) => o.viaFile));
  assert.deepEqual(app.hub.overlayList().map((o) => [o.app, o.viaFile]), [['obs', true]]);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as Record<string, unknown>;
  assert.equal(health.viaFileOverlays, 1);
});

test('overlay.js: открытый загрузчиком сообщает via=file, открытый по адресу — via=url', async () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'overlay', 'overlay.js'), 'utf8');
  const run = (search: string) => {
    const sent: string[] = [];
    class FakeWs { readyState = 1; onopen: (() => void) | null = null; constructor() { queueMicrotask(() => this.onopen?.()); } send(s: string) { sent.push(s); } close() {} }
    const el = { hidden: true, className: '', textContent: '', style: { setProperty() {} }, appendChild() {} };
    vm.runInContext(src, vm.createContext({
      window: { obsstudio: {} }, navigator: { userAgent: UA_OBS }, location: { search, protocol: 'http:', host: '127.0.0.1:17420' }, URLSearchParams,
      document: { getElementById: () => el, createElement: () => ({ remove() {}, addEventListener() {} }) },
      WebSocket: FakeWs, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, Date,
    }));
    return () => JSON.parse(sent.find((s) => s.includes('"hello"')) ?? '{}');
  };
  const viaFile = run('?via=file');
  const viaUrl = run('');
  await delay(0);
  assert.equal(viaFile().via, 'file');
  assert.equal(viaUrl().via, 'url');
});
