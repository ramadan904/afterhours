import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { dayStatus, resolveDay, upcoming } from "../src/market/calendar-talk.js";
import { route } from "../src/sim/planner.js";

async function session() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return mcp(h, tokens.access_token);
}

describe("market calendar", () => {
  const today = "2026-10-11"; // a Sunday
  it("resolves days as said to their next occurrence", () => {
    expect(resolveDay("Thanksgiving", today)).toBe("2026-11-26");
    expect(resolveDay("black friday", today)).toBe("2026-11-27");
    expect(resolveDay("Christmas Eve", today)).toBe("2026-12-24");
    expect(resolveDay("December 25", today)).toBe("2026-12-25");
    expect(resolveDay("July 4th", today)).toBe("2027-07-05");
    expect(resolveDay("friday", today)).toBe("2026-10-16");
    expect(resolveDay("tomorrow", today)).toBe("2026-10-12");
    expect(resolveDay("whenever", today)).toBeNull();
  });
  it("knows closures, half days and weekends", () => {
    expect(dayStatus("2026-11-26")).toEqual({ date: "2026-11-26", status: "closed", label: "Thanksgiving Day" });
    expect(dayStatus("2026-11-27").status).toBe("half_day");
    expect(dayStatus("2026-10-17").status).toBe("weekend");
    expect(dayStatus("2026-10-13").status).toBe("open");
    expect(dayStatus("2030-01-02").status).toBe("unknown");
    expect(upcoming(today, 2).map((d) => d.date)).toEqual(["2026-11-26", "2026-11-27"]);
  });
  it("answers out loud", async () => {
    const s = await session();
    expect((await s.call("market_calendar", { day: "Thanksgiving" })).text).toBe("No. The market is closed on Thursday, November 26 for Thanksgiving Day. Tokenized stocks still trade around the clock.");
    expect((await s.call("market_calendar", { day: "the day after thanksgiving" })).text).toBe("It's open on Friday, November 27, but closes early, at 1 p.m. Eastern, for Day after Thanksgiving.");
    expect((await s.call("market_calendar", { day: "tomorrow" })).text).toBe("Yes, the market is open on Monday, October 12, 9:30 a.m. to 4 p.m. Eastern.");
    expect((await s.call("market_calendar", {})).text).toBe(
      "The next market closures: Thanksgiving Day on Thursday, November 26, an early close at 1 p.m. on Friday, November 27 (Day after Thanksgiving) and an early close at 1 p.m. on Thursday, December 24 (Christmas Eve). Tokenized stocks still trade around the clock.",
    );
  });
});

describe("compare_stocks", () => {
  it("puts names side by side", async () => {
    const s = await session();
    const step = await s.call("compare_stocks", { stocks: ["Tesla", "NVDA"] });
    expect(step.text).toBe(
      "Using sample data. Since Friday's close, Tesla's token is up 2.1 percent, at $370.56 and Nvidia's token is up 1.0 percent, at $222.62. Tesla is ahead. Usually, Tesla moves about 2.0 times the market and Nvidia moves about 1.8 times the market.",
    );
    expect((await s.call("compare_stocks", { stocks: ["Tesla", "blorp"] })).isError).toBe(true);
  });
});

describe("routing", () => {
  it.each([
    ["is the market open on Thanksgiving?", { tool: "market_calendar", args: { day: "thanksgiving" } }],
    ["is the stock market open friday", { tool: "market_calendar", args: { day: "friday" } }],
    ["is christmas eve a half day?", { tool: "market_calendar", args: { day: "christmas eve" } }],
    ["when's the next market holiday?", { tool: "market_calendar", args: {} }],
    ["is the market open?", { tool: "market_status", args: {} }],
    ["compare Tesla and Nvidia", { tool: "compare_stocks", args: { stocks: ["TSLA", "NVDA"] } }],
    ["Apple versus Microsoft", { tool: "compare_stocks", args: { stocks: ["AAPL", "MSFT"] } }],
    ["which is doing better, Coinbase or Strategy?", { tool: "compare_stocks", args: { stocks: ["COIN", "MSTR"] } }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
