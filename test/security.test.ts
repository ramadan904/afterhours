import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, authorizeUrl, exchange, harness, mcp, pkce, wallet, FRIDAY_CLOSE, SUNDAY } from "./helpers.js";
import { clientAddress, RateLimit } from "../src/http/limit.js";
import { servicesFromEnv } from "../src/services.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";

async function linkWatch(app: (r: Request) => Promise<Response>, address: string) {
  const { verifier, challenge } = pkce();
  const page = await (await app(new Request(authorizeUrl(challenge)))).text();
  const request = /name="request" value="([^"]+)"/.exec(page)![1];
  const post = await app(
    new Request(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, mode: "watch", address }) }),
  );
  const code = new URL(post.headers.get("location")!).searchParams.get("code")!;
  const res = await exchange(app, { grant_type: "authorization_code", code, redirect_uri: `${BASE}/sim/`, code_verifier: verifier });
  return (await res.json()).access_token as string;
}

afterEach(() => vi.unstubAllGlobals());

describe("account isolation", () => {
  it("gives two people watching the same address separate alerts and proposals", async () => {
    const h = harness();
    const shared = wallet().address;
    const alice = await mcp(h, await linkWatch(h.app, shared));
    const bob = await mcp(h, await linkWatch(h.app, shared));
    await alice.call("set_alert", { stock: "Tesla", percent: 2 });
    expect((await bob.call("list_alerts", {})).text).toMatch(/^You don't have any alerts/);
    await alice.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10 });
    expect((await bob.call("trade_status", {})).text).toBe("I don't see a recent trade for you.");
  });
});

describe("rate limits trust only the proxy's address", () => {
  it("uses the last X-Forwarded-For entry, which the platform proxy appends", () => {
    const req = new Request(BASE, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    expect(clientAddress(req)).toBe("203.0.113.9");
  });

  it("can't be dodged by rotating a spoofed first entry", () => {
    const limit = new RateLimit(3, 60_000);
    const from = (spoof: string) => new Request(BASE, { headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` } });
    expect([1, 2, 3, 4].map((i) => limit.exceeded(from(`10.0.0.${i}`)))).toEqual([false, false, false, true]);
  });
});

describe("a bogus signature can't freeze a trade", () => {
  it("returns the trade to its owner when the reported signature never lands", async () => {
    let now = SUNDAY;
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const h = harness({
      sample: false,
      now: () => now,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => now),
      holdings: new RpcHoldings("http://rpc.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const session = await mcp(h, await linkWatch(h.app, wallet().address));
    const { code } = (await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10 })).structured as { code: string };
    await h.app(new Request(`${BASE}/api/trade/submitted`, { method: "POST", body: JSON.stringify({ code, signature: "5".repeat(88) }) }));
    const view = async () => (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect((await view()).status).toBe("submitted");
    now += 3 * 60_000;
    const after = await view();
    expect(after.status).toBe("awaiting_signature");
    expect(after.error).toContain("never landed");
  });

  it("lets a trade submitted at the last minute expire, rather than stay 'sent' forever", async () => {
    let now = SUNDAY;
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const h = harness({
      sample: false,
      now: () => now,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => now),
      holdings: new RpcHoldings("http://rpc.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const session = await mcp(h, await linkWatch(h.app, wallet().address));
    const { code } = (await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10 })).structured as { code: string };
    now += 14 * 60_000;
    await h.app(new Request(`${BASE}/api/trade/submitted`, { method: "POST", body: JSON.stringify({ code, signature: "5".repeat(88) }) }));
    now += 3 * 60_000;
    const view = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(view.status).toBe("expired");
  });
});

describe("deployment guards", () => {
  it("refuses to run over HTTPS without a real signing key, or with auth off", () => {
    expect(() => servicesFromEnv({ PUBLIC_URL: "https://afterhours.example" })).toThrow(/AUTH_SECRET/);
    expect(() => servicesFromEnv({ NODE_ENV: "production", AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
    expect(() => servicesFromEnv({ PUBLIC_URL: "https://a.example", AUTH_SECRET: "x".repeat(40), AUTH: "off" })).toThrow(/local development/);
    expect(servicesFromEnv({ PUBLIC_URL: "https://a.example", AUTH_SECRET: "x".repeat(40) }).authRequired).toBe(true);
  });
});

describe("public URL", () => {
  it("comes from PUBLIC_URL, else the platform, else localhost", () => {
    const secret = { AUTH_SECRET: "x".repeat(40) };
    expect(servicesFromEnv({ ...secret, PUBLIC_URL: "https://mine.example/" }).baseUrl).toBe("https://mine.example");
    expect(servicesFromEnv({ ...secret, RENDER_EXTERNAL_URL: "https://afterhours.onrender.com" }).baseUrl).toBe("https://afterhours.onrender.com");
    expect(servicesFromEnv({ ...secret, VERCEL_PROJECT_PRODUCTION_URL: "afterhours.vercel.app" }).baseUrl).toBe("https://afterhours.vercel.app");
    expect(servicesFromEnv({}).baseUrl).toBe("http://localhost:8787");
    // A platform URL is HTTPS, so the deployment guard applies to it too.
    expect(() => servicesFromEnv({ RENDER_EXTERNAL_URL: "https://afterhours.onrender.com" })).toThrow(/AUTH_SECRET/);
  });
});
