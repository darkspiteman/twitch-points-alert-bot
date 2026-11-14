/** Экспоненциальная задержка с «полным джиттером»: случайное значение в [base*2^n / 2, base*2^n], не больше max. */
export class Backoff {
  private attempt = 0;
  private baseMs: number;
  private maxMs: number;
  private random: () => number;
  constructor(opts: { baseMs?: number; maxMs?: number; random?: () => number } = {}) {
    this.baseMs = opts.baseMs ?? 1000;
    this.maxMs = opts.maxMs ?? 60_000;
    this.random = opts.random ?? Math.random;
  }
  next(): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.round(exp / 2 + this.random() * (exp / 2));
  }
  get attempts(): number { return this.attempt; }
  reset(): void { this.attempt = 0; }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
