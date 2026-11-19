/**
 * Client-side token bucket for a tokens-per-minute budget. We estimate a
 * request's cost before sending (prompt chars / 4 + max output) and wait
 * until the bucket can afford it, so we slow down *before* the provider has
 * to tell us to. Provider headers, when present, correct our estimate.
 */
export class TokenBucket {
  private tokens: number;
  private updated: number;

  constructor(
    private perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.updated = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.updated) / 60_000) * this.perMinute);
    this.updated = t;
  }

  /** ms to wait before `cost` tokens are available (0 = now). Reserves them. */
  reserve(cost: number): number {
    this.refill();
    const c = Math.min(cost, this.perMinute);
    this.tokens -= c;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.perMinute) * 60_000);
  }

  /** Provider says what the real per-minute limit is (it differs per model). */
  setLimit(perMinute: number) {
    if (perMinute > 0 && perMinute !== this.perMinute) {
      this.refill();
      this.tokens = Math.min(this.tokens, perMinute);
      this.perMinute = perMinute;
    }
  }

  /** Provider says how many tokens remain: never believe we have more. */
  observeRemaining(remaining: number) {
    this.refill();
    if (Number.isFinite(remaining)) this.tokens = Math.min(this.tokens, remaining);
  }

  /** Refund the difference when the actual usage was lower than estimated. */
  refund(tokens: number) {
    if (tokens > 0) this.tokens = Math.min(this.perMinute, this.tokens + tokens);
  }
}

/** Parse Groq/OpenAI-style durations: "7.66s", "1m2.5s", "350ms", "2". */
export function parseDurationMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s) * 1000);
  let ms = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  return matched ? Math.ceil(ms) : undefined;
}
