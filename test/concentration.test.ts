import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";

// The sample portfolio: about $2,671 Nvidia, $2,145 Apple, $1,575 Tesla, $1,385 S&P (≈ $7,777).
async function session() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return mcp(h, tokens.access_token);
}

describe("concentration check", () => {
  it("says when a buy would make one name a big share of the portfolio", async () => {
    process.env.MAX_TRADE_USD = "10000";
    const s = await session();
    const big = await s.call("propose_trade", { stock: "Nvidia", side: "buy", amount_usd: 3000 });
    expect(big.text).toContain("After this, Nvidia would be 53 percent of your tokenized stocks.");
    delete process.env.MAX_TRADE_USD;
  });
  it("stays quiet for modest buys and for broad index funds", async () => {
    process.env.MAX_TRADE_USD = "10000";
    const s = await session();
    expect((await s.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 50 })).text).not.toContain("After this");
    expect((await s.call("propose_trade", { stock: "SPY", side: "buy", amount_usd: 9000 })).text).not.toContain("After this");
    delete process.env.MAX_TRADE_USD;
  });
});
