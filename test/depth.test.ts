import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { clearDepthCache } from "../src/chain/depth.js";

function liveHarness() {
  const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
  const upstream = fakeUpstreams(state);
  vi.stubGlobal("fetch", upstream);
  const h = harness({
    sample: false,
    prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => SUNDAY),
    holdings: new RpcHoldings("http://rpc.test", upstream),
    swap: new JupiterSwap("http://jup.test", upstream),
    rpcUrl: "http://rpc.test",
  });
  return { h, state };
}
beforeEach(() => clearDepthCache());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MAX_TRADE_USD;
});

describe("market_depth", () => {
  it("prices three sizes from real Jupiter quotes, in parallel, and caches them", async () => {
    const { h, state } = liveHarness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("market_depth", { stock: "Tesla" });
    expect(step.text).toBe(
      "Buying Tesla's token right now costs about 0.31 percent for $100, about 0.35 percent for $1,000 and about 0.81 percent for $10,000 over its price of $370.56. It's deep enough for everyday sizes.",
    );
    expect(step.structured).toMatchObject({ dataSource: "jupiter", side: "buy", under1PercentUsd: 10_000 });
    const quotes = () => state.calls.filter((c) => c === "/swap/v1/quote").length;
    expect(quotes()).toBe(3);
    await session.call("market_depth", { stock: "TSLA" });
    expect(quotes()).toBe(3);
  });

  it("says when size gets expensive on a thin name (sample model)", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("market_depth", { stock: "Palantir", side: "sell" });
    expect(step.text).toMatch(/^Using sample data\. Selling Palantir's token right now costs about 0\.12 percent for \$100, about 0\.48 percent for \$1,000 and about 4\.1 percent for \$10,000 over its price of \$[\d.]+\. Up to about \$1,000 costs under 1 percent; beyond that, splitting the trade or waiting for the open would likely fill better\.$/);
  });
});

describe("big proposals on thin markets", () => {
  it("warns before a large trade fills far from the price", async () => {
    process.env.MAX_TRADE_USD = "50000";
    const { h } = liveHarness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const big = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 20_000 });
    expect(big.text).toContain("At this size you'd pay about 1.3 percent over the token's price, because the market is thin right now. A smaller trade would fill closer.");
    const small = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 300 });
    expect(small.text).not.toContain("At this size");
  });
});
