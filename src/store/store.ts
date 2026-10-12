import { DynamoStore } from "./dynamo.js";

/**
 * The little state Afterhours keeps: one-time OAuth codes, refresh tokens,
 * alerts, and trade proposals waiting for a signature.
 *
 * In memory by default, which is right for a single long-running process and
 * for tests. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (what
 * Vercel's Redis integration provides) when the server runs as serverless
 * functions, where each instance would otherwise have its own memory, or
 * DYNAMODB_TABLE on AWS.
 */

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Sets only if absent. True when this call set it. */
  setNew(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Reads and deletes in one step, so a one-time value can only be used once. */
  take<T>(key: string): Promise<T | null>;
  /**
   * Adds one to a counter and returns the new count, atomically across every
   * instance of the server (rate limits). The TTL is set when the counter is
   * created. Counters are only ever read through incr.
   */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export class MemoryStore implements Store {
  private readonly map = new Map<string, { value: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires && hit.expires <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit;
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.live(key);
    return hit ? (JSON.parse(hit.value) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.map.set(key, {
      value: JSON.stringify(value),
      expires: ttlSeconds ? this.now() + ttlSeconds * 1000 : 0,
    });
  }

  async setNew(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async take<T>(key: string): Promise<T | null> {
    const value = await this.get<T>(key);
    this.map.delete(key);
    return value;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const hit = this.live(key);
    const n = (hit ? Number(JSON.parse(hit.value)) : 0) + 1;
    this.map.set(key, { value: JSON.stringify(n), expires: hit?.expires || this.now() + ttlSeconds * 1000 });
    return n;
  }
}

/** Upstash Redis over its REST API: no driver, just fetch. */
export class UpstashStore implements Store {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async command<T>(args: (string | number)[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(`Upstash: ${body.error ?? res.status}`);
    return body.result as T;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.command<string | null>(["GET", key]);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const args: (string | number)[] = ["SET", key, JSON.stringify(value)];
    if (ttlSeconds) args.push("EX", ttlSeconds);
    await this.command(args);
  }

  async setNew(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    const args: (string | number)[] = ["SET", key, JSON.stringify(value), "NX"];
    if (ttlSeconds) args.push("EX", ttlSeconds);
    return (await this.command<string | null>(args)) === "OK";
  }

  async del(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  async take<T>(key: string): Promise<T | null> {
    const raw = await this.command<string | null>(["GETDEL", key]);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.command<number>(["INCR", key]);
    // The first increment starts the window; later ones leave it alone.
    if (n === 1) await this.command(["EXPIRE", key, ttlSeconds]);
    return n;
  }
}

/**
 * DynamoDB when `DYNAMODB_TABLE` is set (AWS deployments), Upstash when its
 * REST credentials are (Vercel), memory otherwise.
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  if (env.DYNAMODB_TABLE) return new DynamoStore(env.DYNAMODB_TABLE);
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  return url && token ? new UpstashStore(url, token) : new MemoryStore();
}
