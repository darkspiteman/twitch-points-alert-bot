import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DpapiStore } from '../src/secure-store.ts';
import { tmpDir, waitFor } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('DPAPI: токены шифруются и расшифровываются, в файле нет открытого текста', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpDir();
  const store = new DpapiStore(path.join(dir, 'tokens.dpapi'));
  const secret = JSON.stringify({ accessToken: 'very-secret-access-token-123', refreshToken: 'very-secret-refresh-456' });
  await store.save(secret);
  const raw = fs.readFileSync(path.join(dir, 'tokens.dpapi'), 'utf8');
  assert.ok(!raw.includes('very-secret'), 'в файле не должно быть токена в открытом виде');
  assert.equal(await store.load(), secret);
  await store.clear();
  assert.equal(await store.load(), null);
});

function startBot(dataDir: string, port: number) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'main.ts')], {
    env: { ...process.env, TAB_DATA_DIR: dataDir, TAB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on('exit', (c) => r(c)));
  return { p, exited, output: () => out };
}

test('запускается только один экземпляр; корректное завершение через API; повторный запуск работает', async () => {
  const dir = tmpDir();
  const port = 17600 + Math.floor(Math.random() * 300);
  const a = startBot(dir, port);
  try {
    await waitFor(() => a.output().includes('Бот запущен'), 15000, 100);
    const b = startBot(dir, port);
    const code = await b.exited;
    assert.equal(code, 3, 'второй экземпляр должен завершиться с кодом 3');
    assert.match(b.output(), /уже запущен/);

    const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'x-tab-request': '1' } });
    assert.equal(r.status, 200);
    assert.equal(await a.exited, 0);
    assert.match(a.output(), /Работа завершена корректно/);
    assert.equal(fs.existsSync(path.join(dir, 'bot.lock')), false, 'lock-файл удалён');

    // Повторный запуск после остановки
    const c = startBot(dir, port);
    await waitFor(() => c.output().includes('Бот запущен'), 15000, 100);
    const h = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean };
    assert.equal(h.ok, true);
    c.p.kill();
    await c.exited;
  } finally {
    a.p.kill();
  }
});

test('после аварийного завершения (устаревший lock-файл) бот запускается', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bot.lock'), '999999'); // PID несуществующего процесса
  const port = 17900 + Math.floor(Math.random() * 90);
  const a = startBot(dir, port);
  try {
    await waitFor(() => a.output().includes('Бот запущен'), 15000, 100);
  } finally {
    a.p.kill();
    await a.exited;
  }
});
