import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { CachedPrices, SamplePrices } from "../src/market/prices.js";
import { clearDepthCache } from "../src/chain/depth.js";
import { route } from "../src/sim/planner.js";

describe("find_dislocations", () => {
  it("outside market hours, explains that gaps are bets on the open", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const s = await mcp(h, tokens.access_token);
    const step = await s.call("find_dislocations", {});
    expect(step.text).toMatch(/^Using sample data\. The share market is shut, so a token's move now is a bet on the next open/);
    expect(step.structured).toMatchObject({ marketOpen: false, rows: [] });
  });

  it("during market hours, nets each live gap against the cost to trade it", async () => {
    clearDepthCache();
    const monday = Date.parse("2026-10-12T14:30:00Z"); // 10:30 a.m. Eastern
    const now = () => monday;
    const h = harness({ now, prices: new CachedPrices(new SamplePrices(now), 10_000, 120_000, now) });
    const { tokens } = await linkWallet(h.app);
    const s = await mcp(h, tokens.access_token);
    const step = await s.call("find_dislocations", {});
    const rows = (step.structured as { rows: { ticker: string; side: string; netPercent: number; costPercent: number }[] }).rows;
    expect(rows[0]).toMatchObject({ ticker: "COIN", side: "sell" });
    expect(rows.every((r) => r.netPercent > 0 && r.costPercent > 0)).toBe(true);
    expect(rows.find((r) => r.ticker === "AAPL")?.side).toBe("buy"); // Apple's token is cheap
    expect(step.text).toMatch(/^Using sample data\. Against live share prices, at \$1,000: Coinbase, rich by 3\.88 percent against about 0\.\d\d to trade/);
  });

  it.each(["any tokens mispriced right now?", "find me dislocations", "where's the biggest gap against the stock?"])("routes %s", (said) =>
    expect(route(said)).toEqual({ tool: "find_dislocations", args: {} }),
  );
});
