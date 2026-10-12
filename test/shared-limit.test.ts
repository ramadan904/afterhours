import { describe, expect, it } from "vitest";
import { SharedRateLimit } from "../src/http/limit.js";
import { MemoryStore } from "../src/store/store.js";
import { BASE, harness } from "./helpers.js";

const req = (ip: string) => new Request(`${BASE}/x`, { headers: { "x-forwarded-for": ip } });

describe("rate limits shared across instances", () => {
  it("counts one client across two server instances that share a store", async () => {
    const store = new MemoryStore(() => 0);
    const instanceA = new SharedRateLimit("t", 3, 60_000);
    const instanceB = new SharedRateLimit("t", 3, 60_000);
    expect(await instanceA.exceeded(store, req("1.1.1.1"), 0)).toBe(false);
    expect(await instanceB.exceeded(store, req("1.1.1.1"), 0)).toBe(false);
    expect(await instanceA.exceeded(store, req("1.1.1.1"), 0)).toBe(false);
    expect(await instanceB.exceeded(store, req("1.1.1.1"), 0)).toBe(true);
    expect(await instanceB.exceeded(store, req("2.2.2.2"), 0)).toBe(false);
    expect(await instanceA.exceeded(store, req("1.1.1.1"), 60_000)).toBe(false); // next window
  });

  it("falls back to an in-memory limit when the store is down", async () => {
    const broken = { incr: async () => { throw new Error("store down"); } };
    const limit = new SharedRateLimit("t", 2, 60_000);
    expect(await limit.exceeded(broken, req("1.1.1.1"))).toBe(false);
    expect(await limit.exceeded(broken, req("1.1.1.1"))).toBe(false);
    expect(await limit.exceeded(broken, req("1.1.1.1"))).toBe(true);
  });

  it("guards trade-code lookups through the store", async () => {
    const h = harness();
    let last = 200;
    for (let i = 0; i < 61; i += 1) {
      last = (await h.app(new Request(`${BASE}/api/trade?code=000000`, { headers: { "x-forwarded-for": "9.9.9.9" } }))).status;
    }
    expect(last).toBe(429);
    const counters = await h.svc.store.incr(`rl:trade:9.9.9.9:${Math.floor(Date.now() / 600_000)}`, 600);
    expect(counters).toBeGreaterThan(61);
  });
});
