import { describe, expect, it } from "vitest";
import { route } from "../src/sim/planner.js";
import { simulatorPage } from "../src/http/simulator.js";

describe("every simulator suggestion routes to the tool it shows off", () => {
  const expected: Record<string, string> = {
    "What happened overnight?": "overnight_brief",
    "How's Tesla doing?": "check_stock",
    "How deep is the Tesla market?": "market_depth",
    "How's my portfolio?": "my_portfolio",
    "How much have I made on Nvidia?": "my_returns",
    "Tell me if Coinbase moves more than 3 percent": "set_alert",
    "Buy 25 dollars of Apple": "propose_trade",
    "Buy 25 dollars of the S&P every Monday": "recurring_buy",
    "Don't let me spend more than 200 dollars a day": "set_spending_limit",
    "Don't let me trade at night": "set_sleep_mode",
    "Keep me 60 percent S&P and 40 percent Nasdaq": "set_target_allocation",
    "How far am I from my target?": "rebalance",
    "Add Netflix to my watchlist": "edit_watchlist",
    "Brief me every weekday at 7": "schedule_briefing",
    "What can you do?": "explain",
  };
  it("lists exactly these chips", async () => {
    const html = await simulatorPage({ baseUrl: "http://x", sample: true } as never).text();
    const chips = JSON.parse(/const CHIPS=(\[.*?\]);/.exec(html)![1]) as string[];
    expect(chips).toEqual(Object.keys(expected));
  });
  it.each(Object.entries(expected))("%s → %s", (said, tool) => expect(route(said)?.tool).toBe(tool));
  it("reads the stock out of depth and returns questions", () => {
    expect(route("How deep is the Tesla market?")?.args).toEqual({ stock: "tesla" });
    expect(route("How much have I made on Nvidia?")?.args).toEqual({ stock: "nvidia" });
    expect(route("am I up overall?")?.args).toEqual({});
  });
});
