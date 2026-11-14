import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue, type OverlayTransport, type PlayItem, type QueueSettings } from '../src/queue.ts';
import { log, waitFor, delay } from './helpers.ts';

class FakeTransport implements OverlayTransport {
  ids = ['ov1'];
  played: { ids: string[]; item: PlayItem; duration: number; at: number }[] = [];
  stopped: string[] = [];
  overlayIds() { return [...this.ids]; }
  play(ids: string[], item: PlayItem, duration: number) { this.played.push({ ids, item, duration, at: Date.now() }); }
  stop(id: string) { this.stopped.push(id); }
}

const settings = (over: Partial<QueueSettings> = {}): QueueSettings => ({
  maxQueueLength: 10, delayBeforeMs: 0, gapBetweenMs: 0, maxItemAgeSec: 300, maxDurationMs: 60000, defaultImageDurationMs: 5000, ...over,
});

let n = 0;
function item(over: Partial<PlayItem> = {}): PlayItem {
  n++;
  return {
    id: `item-${n}`, redemptionId: `red-${n}`, rewardId: 'r', rewardTitle: `Награда ${n}`, userName: 'u', userInput: '',
    visual: null, audio: { id: 'm', url: '/media/m', kind: 'audio', mime: 'audio/mpeg' }, volume: 1, durationMs: 0, delayMs: 0, caption: null,
    source: 'eventsub', createdAt: Date.now(), ...over,
  };
}

function setup(over: Partial<QueueSettings> = {}) {
  const t = new FakeTransport();
  const s = settings(over);
  const q = new PlaybackQueue(t, () => s, log);
  const finished: { item: PlayItem; result: string; message: string }[] = [];
  q.on('finished', (e) => finished.push(e));
  return { t, q, s, finished };
}

test('несколько наград воспроизводятся строго последовательно', async () => {
  const { t, q, finished } = setup();
  const a = item(), b = item(), c = item();
  q.enqueue(a); q.enqueue(b); q.enqueue(c);
  await waitFor(() => t.played.length === 1);
  await delay(50);
  assert.equal(t.played.length, 1, 'второе не начинается, пока первое не закончилось');
  q.report('ov1', a.id, 'ended');
  await waitFor(() => t.played.length === 2);
  assert.equal(t.played[1].item.id, b.id);
  q.report('ov1', b.id, 'ended');
  await waitFor(() => t.played.length === 3);
  q.report('ov1', c.id, 'ended');
  await waitFor(() => finished.length === 3);
  assert.deepEqual(finished.map((f) => f.result), ['done', 'done', 'done']);
});

test('пауза между наградами и задержка перед показом соблюдаются', async () => {
  const { t, q } = setup({ gapBetweenMs: 200, delayBeforeMs: 100 });
  const a = item(), b = item();
  const start = Date.now();
  q.enqueue(a); q.enqueue(b);
  await waitFor(() => t.played.length === 1);
  assert.ok(t.played[0].at - start >= 90, 'задержка перед показом');
  q.report('ov1', a.id, 'ended');
  const endA = Date.now();
  await waitFor(() => t.played.length === 2);
  assert.ok(t.played[1].at - endA >= 280, `пауза + задержка (${t.played[1].at - endA} мс)`);
});

test('максимальная длина очереди', () => {
  const { t, q } = setup({ maxQueueLength: 2 });
  t.ids = []; // overlay не подключён — всё копится
  assert.equal(q.enqueue(item()).ok, true);
  assert.equal(q.enqueue(item()).ok, true);
  const r = q.enqueue(item());
  assert.equal(r.ok, false);
  q.dispose();
});

test('ошибка воспроизведения (повреждённый файл) → следующий элемент всё равно играет', async () => {
  const { t, q, finished } = setup();
  const a = item(), b = item();
  q.enqueue(a); q.enqueue(b);
  await waitFor(() => t.played.length === 1);
  q.report('ov1', a.id, 'error', 'не удалось декодировать файл');
  await waitFor(() => t.played.length === 2);
  assert.equal(finished[0].result, 'failed');
  assert.match(finished[0].message, /декодировать/);
});

test('пропуск текущего и очистка очереди', async () => {
  const { t, q, finished } = setup();
  const a = item(), b = item(), c = item();
  q.enqueue(a); q.enqueue(b); q.enqueue(c);
  await waitFor(() => t.played.length === 1);
  assert.equal(q.clear(), 2);
  assert.equal(q.skip(), true);
  assert.deepEqual(t.stopped, [a.id]);
  await delay(50);
  assert.equal(t.played.length, 1);
  assert.deepEqual(finished.map((f) => f.result).sort(), ['skipped', 'skipped', 'skipped']);
});

test('overlay не сообщил об окончании → переход по таймауту', async () => {
  const { t, q, finished } = setup({ maxDurationMs: 1000 });
  const a = item({ durationMs: 100 }), b = item();
  q.enqueue(a); q.enqueue(b);
  await waitFor(() => t.played.length === 2, 7000); // 100 мс + 5 с запаса
  assert.equal(finished[0].message, 'Завершено по таймауту');
  q.dispose();
});

test('нет подключённого overlay → ждём; после подключения воспроизводится', async () => {
  const { t, q } = setup();
  t.ids = [];
  q.enqueue(item());
  await delay(100);
  assert.equal(t.played.length, 0);
  t.ids = ['ov2'];
  q.overlayConnected();
  await waitFor(() => t.played.length === 1);
  assert.deepEqual(t.played[0].ids, ['ov2']);
  q.dispose();
});

test('устаревшие элементы не воспроизводятся (например, после долгого отсутствия overlay)', async () => {
  const { t, q, finished } = setup({ maxItemAgeSec: 10 });
  t.ids = [];
  q.enqueue(item({ createdAt: Date.now() - 60_000 }));
  q.enqueue(item());
  t.ids = ['ov1'];
  q.overlayConnected();
  await waitFor(() => t.played.length === 1);
  assert.equal(finished[0].result, 'dropped');
  assert.equal(t.played[0].item.id, `item-${n}`);
  q.dispose();
});

test('overlay отключился во время воспроизведения → элемент завершается, очередь идёт дальше', async () => {
  const { t, q, finished } = setup();
  const a = item(), b = item();
  q.enqueue(a); q.enqueue(b);
  await waitFor(() => t.played.length === 1);
  q.overlayDisconnected('ov1');
  await waitFor(() => t.played.length === 2);
  assert.equal(finished[0].result, 'failed');
  q.dispose();
});

test('картинка без звука получает длительность по умолчанию', async () => {
  const { t, q } = setup({ defaultImageDurationMs: 4000 });
  q.enqueue(item({ audio: null, visual: { id: 'i', url: '/media/i', kind: 'image', mime: 'image/png' } }));
  await waitFor(() => t.played.length === 1);
  assert.equal(t.played[0].duration, 4000);
  q.dispose();
});

test('пауза очереди', async () => {
  const { t, q } = setup();
  q.setPaused(true);
  q.enqueue(item());
  await delay(80);
  assert.equal(t.played.length, 0);
  q.setPaused(false);
  await waitFor(() => t.played.length === 1);
  q.dispose();
});
