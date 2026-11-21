import crypto from 'node:crypto';

/**
 * Счётчики стримера (1.9.0): «Смерти», «Победы» и т. п. Кнопки +1 / −1 — в доке OBS,
 * число — на экране стрима (источник «Браузер» с data\counter-overlay.html). Хранятся в meta 'counters'.
 */

export interface Counter { id: string; name: string; value: number; show: boolean }

export const MAX_COUNTERS = 10;
const LIMIT = 1_000_000_000;

export interface CounterStore { load(): string | null; save(json: string): void }

export class Counters {
  private list: Counter[];
  private store: CounterStore;

  constructor(store: CounterStore) {
    this.store = store;
    this.list = parse(store.load());
  }

  all(): Counter[] { return this.list.map((c) => ({ ...c })); }

  add(name: string): Counter {
    if (this.list.length >= MAX_COUNTERS) throw new Error(`Счётчиков не больше ${MAX_COUNTERS}`);
    const c: Counter = { id: crypto.randomUUID().slice(0, 8), name: cleanName(name), value: 0, show: true };
    this.list.push(c);
    this.persist();
    return { ...c };
  }

  update(id: string, patch: { name?: unknown; value?: unknown; delta?: unknown; show?: unknown }): Counter {
    const c = this.list.find((x) => x.id === id);
    if (!c) throw new Error('Счётчик не найден');
    if (patch.name !== undefined) c.name = cleanName(String(patch.name));
    if (patch.value !== undefined) c.value = clampInt(patch.value);
    if (patch.delta !== undefined) c.value = clampInt(c.value + clampInt(patch.delta));
    if (patch.show !== undefined) c.show = Boolean(patch.show);
    this.persist();
    return { ...c };
  }

  remove(id: string): boolean {
    const n = this.list.length;
    this.list = this.list.filter((x) => x.id !== id);
    if (this.list.length === n) return false;
    this.persist();
    return true;
  }

  private persist(): void { this.store.save(JSON.stringify(this.list)); }
}

function cleanName(v: string): string {
  // Только печатные символы: имя видят зрители.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!s) throw new Error('Введите название счётчика');
  return s;
}

function clampInt(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Значение счётчика должно быть числом');
  return Math.max(-LIMIT, Math.min(LIMIT, Math.round(n)));
}

function parse(json: string | null): Counter[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is Counter => !!x && typeof x.id === 'string' && typeof x.name === 'string' && Number.isFinite(x.value))
      .slice(0, MAX_COUNTERS)
      .map((x) => ({ id: x.id, name: x.name, value: x.value, show: x.show !== false }));
  } catch { return []; }
}
