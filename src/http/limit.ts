/**
 * Per-client fixed-window rate limits, in memory.
 *
 * The client address is the *last* X-Forwarded-For entry: the one the
 * platform's proxy appended. Earlier entries are whatever the client sent and
 * can't be trusted. Behind no proxy at all, every request counts as one client,
 * which errs on the side of limiting.
 */

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last || request.headers.get("x-real-ip") || "direct";
}

export class RateLimit {
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this request is over the limit. */
  exceeded(request: Request): boolean {
    const key = clientAddress(request);
    const now = this.now();
    const hit = this.hits.get(key);
    if (!hit || hit.reset <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return false;
    }
    hit.n += 1;
    return hit.n > this.max;
  }
}

/**
 * The same limit, counted in the shared store, so it holds across every
 * instance of the server: with in-memory counts, each new App Runner instance
 * would hand a code-guesser another full allowance. If the store can't be
 * reached, the in-memory limit still applies.
 */
export class SharedRateLimit {
  private readonly local: RateLimit;

  constructor(
    private readonly name: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    this.local = new RateLimit(max, windowMs);
  }

  async exceeded(store: { incr(key: string, ttlSeconds: number): Promise<number> }, request: Request, now = Date.now()): Promise<boolean> {
    const window = Math.floor(now / this.windowMs);
    const key = `rl:${this.name}:${clientAddress(request)}:${window}`;
    try {
      return (await store.incr(key, Math.ceil(this.windowMs / 1000) + 5)) > this.max;
    } catch {
      return this.local.exceeded(request);
    }
  }
}
