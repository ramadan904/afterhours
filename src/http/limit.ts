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
