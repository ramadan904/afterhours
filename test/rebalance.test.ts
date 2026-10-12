import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { planRebalance } from "../src/market/rebalance.js";
import { route } from "../src/sim/planner.js";

describe("planning a rebalance", () => {
  it("sells what's over, buys what's under, and never spends more than the sales raise", () => {
    const plan = planRebalance({ SPY: 0.6, QQQ: 0.4 }, { SPY: 500, QQQ: 500, TSLA: 9999 });
    expect(plan.baseUsd).toBe(1000); // TSLA is outside the plan
    expect(plan.legs).toEqual([
      { ticker: "QQQ", side: "sell", usd: 100 },
      { ticker: "SPY", side: "buy", usd: 100 },
    ]);
  });

  it("buys a target that isn't held yet, funded by the others", () => {
    const plan = planRebalance({ SPY: 0.5, QQQ: 0.25, GLD: 0.25 }, { SPY: 600, QQQ: 400 });
    expect(plan.legs).toEqual([
      { ticker: "QQQ", side: "sell", usd: 150 },
      { ticker: "SPY", side: "sell", usd: 100 },
      { ticker: "GLD", side: "buy", usd: 250 },
    ]);
  });

  it("leaves small drifts alone", () => {
    expect(planRebalance({ SPY: 0.5, QQQ: 0.5 }, { SPY: 505, QQQ: 495 }).legs).toEqual([]);
  });
});

describe("set_target_allocation and rebalance", () => {
  async function session() {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    return mcp(h, tokens.access_token);
  }

  it("checks the mix adds up, and reads it back", async () => {
    const s = await session();
    expect((await s.call("set_target_allocation", { targets: [{ stock: "SPY", percent: 60 }, { stock: "Nasdaq", percent: 30 }] })).text).toBe(
      "Those add up to 90 percent. A target mix needs to add up to 100.",
    );
    expect((await s.call("set_target_allocation", { targets: [{ stock: "Nvidia", percent: 60 }, { stock: "the S&P", percent: 40 }] })).text).toBe(
      "Done. Your target mix is 60 percent Nvidia and 40 percent the S&P 500 fund. Ask me to check my balance against it any time.",
    );
    expect((await s.call("set_target_allocation", {})).text).toBe("Your target mix is 60 percent Nvidia and 40 percent the S&P 500 fund.");
  });

  it("explains the drift first, and prepares the trades only when confirmed, sale first", async () => {
    const s = await session();
    await s.call("set_target_allocation", { targets: [{ stock: "Nvidia", percent: 60 }, { stock: "SPY", percent: 40 }] });
    const dry = await s.call("rebalance", {});
    expect(dry.text).toMatch(
      /^Using sample data\. Nvidia is 66 percent against a 60 percent target and the S&P 500 fund is 34 percent against a 40 percent target\. To get back, I'd sell \$2\d\d of Nvidia and buy \$2\d\d of the S&P 500 fund, paid for by the sale\. Say rebalance now and I'll prepare them for you to sign\.$/,
    );
    expect((dry.structured as { prepared: boolean }).prepared).toBe(false);
    const go = await s.call("rebalance", { confirm: true });
    expect(go.text).toMatch(/^Using sample data\. 2 trades are ready to sign for the next 30 minutes, sales first so they pay for the buys\. Sell \$\d+ of Nvidia, code \d \d \d \d \d \d\. Then buy \$\d+ of the S&P 500 fund, code \d \d \d \d \d \d\. They're also in the Afterhours app\.$/);
    const legs = (go.structured as { legs: { side: string; code: string | null }[] }).legs;
    expect(legs.map((l) => l.side)).toEqual(["sell", "buy"]);
    expect(legs.every((l) => /^\d{6}$/.test(l.code ?? ""))).toBe(true);
  });

  it("respects the PIN and the daily limit", async () => {
    const s = await session();
    await s.call("set_target_allocation", { targets: [{ stock: "Nvidia", percent: 60 }, { stock: "SPY", percent: 40 }] });
    await s.call("set_spending_limit", { daily_usd: 100 });
    expect((await s.call("rebalance", { confirm: true })).text).toMatch(/^The buys add up to \$2\d\d, which is over your \$100 daily limit\. Nothing was prepared\.$/);
    await s.call("set_trade_pin", { new_pin: "4719" });
    expect((await s.call("rebalance", { confirm: true })).text).toBe("You've set a trade PIN. What is it?");
  });
});

describe("the scripted planner routes rebalancing", () => {
  it.each([
    ["keep me 60 percent S&P and 40 percent Nasdaq", { tool: "set_target_allocation", args: { targets: [{ stock: "s&p", percent: 60 }, { stock: "nasdaq", percent: 40 }] } }],
    ["my target mix is 50% nvidia, 25% apple and 25% gold", { tool: "set_target_allocation", args: { targets: [{ stock: "nvidia", percent: 50 }, { stock: "apple", percent: 25 }, { stock: "the gold fund", percent: 25 }] } }],
    ["what's my target mix", { tool: "set_target_allocation", args: {} }],
    ["how far am I from my target?", { tool: "rebalance", args: {} }],
    ["rebalance my portfolio", { tool: "rebalance", args: {} }],
    ["yes, rebalance now", { tool: "rebalance", args: { confirm: true } }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
