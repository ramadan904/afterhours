import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, FRIDAY_CLOSE, exchange, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { cleanReason, isLateNight, mirror, type JournalEntry } from "../src/account/journal.js";
import { route } from "../src/sim/planner.js";

afterEach(() => vi.unstubAllGlobals());

describe("journal pieces", () => {
  it("cleans spoken reasons and knows what late night is", () => {
    expect(cleanReason("because AI earnings are next week.")).toBe("AI earnings are next week");
    expect(cleanReason("  ")).toBeNull();
    expect(cleanReason(undefined)).toBeNull();
    expect([22, 23, 0, 4, 5, 12].map(isLateNight)).toEqual([false, true, true, true, false, false]);
  });

  it("compares late-night buys with daytime ones, leaving sales out", () => {
    const e = (ticker: string, hour: number, price: number, side: "buy" | "sell" = "buy"): JournalEntry => ({ id: ticker + hour, ticker, side, usd: 25, price, askedAt: 0, hour, why: null, confirmedAt: 1 });
    const m = mirror([e("NVDA", 1, 100), e("TSLA", 2, 100), e("AAPL", 14, 100), e("COIN", 3, 100, "sell")], new Map([["NVDA", 96], ["TSLA", 98], ["AAPL", 103], ["COIN", 50]]));
    expect(m.lateNight.trades).toBe(2);
    expect(m.lateNight.avgChangePercent).toBeCloseTo(-3, 6);
    expect(m.daytime).toEqual({ trades: 1, avgChangePercent: expect.closeTo(3, 6) });
  });

  it("hears the reason in a trade, and the questions about it", () => {
    expect(route("Buy 25 dollars of Nvidia because AI earnings are next week")).toEqual({ tool: "propose_trade", args: { stock: "nvidia", side: "buy", amount_usd: 25, why: "AI earnings are next week" } });
    expect(route("Why did I buy Nvidia?")).toEqual({ tool: "trade_journal", args: { stock: "nvidia" } });
    expect(route("How are my late night trades doing?")).toEqual({ tool: "trade_journal", args: {} });
  });
});

describe("the trading journal, end to end", () => {
  it("keeps the reason and the hour, counts only confirmed trades, and holds up the mirror", async () => {
    let now = Date.parse("2026-10-10T05:12:00Z"); // Saturday 1:12 a.m. Eastern
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const h = harness({
      sample: false,
      now: () => now,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 0, 0, () => now),
      holdings: new RpcHoldings("http://rpc.test", upstream, 0),
      swap: new JupiterSwap("http://jup.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const { tokens, wallet } = await linkWallet(h.app);
    let session = await mcp(h, tokens.access_token);
    let refreshToken = tokens.refresh_token;
    let accessToken = tokens.access_token;
    // Access tokens last an hour; after a jump in the clock, refresh like Alexa would.
    const later = async (at: number) => {
      now = at;
      const t = await (await exchange(h.app, { grant_type: "refresh_token", refresh_token: refreshToken })).json();
      refreshToken = t.refresh_token;
      accessToken = t.access_token;
      session = await mcp(h, accessToken);
    };
    const post = (path: string, body: unknown) => h.app(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    let n = 0;
    const tradeAndConfirm = async (args: Record<string, unknown>) => {
      const r = await session.call("propose_trade", args);
      const { code } = r.structured as { code: string };
      await post("/api/trade/build", { code });
      const sig = String(++n).repeat(88);
      await post("/api/trade/submitted", { code, signature: sig });
      state.transactions[sig] = { payer: wallet.address, blockhash: state.built!.at(-1) };
      await h.app(new Request(`${BASE}/api/trade?code=${code}`));
      return r;
    };

    expect((await session.call("trade_journal", {})).text).toBe(
      "Your journal is empty: no trades through Afterhours have confirmed yet. When you trade, tell me why, and I'll keep it with the trade.",
    );

    const late = await tradeAndConfirm({ stock: "Nvidia", side: "buy", amount_usd: 25, why: "because AI earnings are next week." });
    expect(late.text).toMatch(/I've kept your reason in your journal\.$/);

    await later(Date.parse("2026-10-11T15:00:00Z")); // Sunday 11 a.m.
    await tradeAndConfirm({ stock: "Tesla", side: "buy", amount_usd: 40 });
    // A proposal nobody signs isn't a decision.
    await session.call("propose_trade", { stock: "Apple", side: "buy", amount_usd: 10, why: "felt lucky" });

    // Since then: Nvidia's token down 3 percent, Tesla's up 2.
    state.tokenFactor = { NVDA: 0.97, TSLA: 1.02 };
    await later(Date.parse("2026-10-11T16:00:00Z"));

    const why = await session.call("trade_journal", { stock: "Nvidia" });
    expect(why.text).toMatch(/^On Saturday, October 10 at 1:12 a\.m\., you bought \$25 of Nvidia at \$[\d.]+ and said: "AI earnings are next week\." It's down 3\.0 percent since\. You asked for that one late at night\.$/);

    const all = await session.call("trade_journal", {});
    expect(all.text).toBe(
      'You\'ve made 2 trades through Afterhours. Your 1 buy asked for late at night is down 3.0 percent on average since; your 1 daytime buy is up 2.0 percent. So far, the late-night ones are doing worse. Your latest note, on Nvidia: "AI earnings are next week."',
    );
    expect(all.structured).toMatchObject({ lateNight: { trades: 1, avgChangePercent: -3 }, daytime: { trades: 1, avgChangePercent: 2 } });
    expect((all.structured as { entries: { ticker: string }[] }).entries.map((e) => e.ticker)).toEqual(["TSLA", "NVDA"]);

    expect((await session.call("trade_journal", { stock: "Apple" })).text).toMatch(/^I don't have a confirmed Apple trade of yours on record yet\./);

    // It's personal data: exported with the rest, and gone with the rest.
    const exported = await (await h.app(new Request(`${BASE}/api/export/data.json`, { headers: { authorization: `Bearer ${accessToken}` } }))).json();
    expect(exported.journal).toHaveLength(3);
  });
});
