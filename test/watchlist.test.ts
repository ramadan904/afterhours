import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { route } from "../src/sim/planner.js";

async function session() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return mcp(h, tokens.access_token);
}

describe("watchlist", () => {
  it("adds names however they're said, and says what it couldn't find", async () => {
    const s = await session();
    const step = await s.call("edit_watchlist", { add: ["Netflix", "PLTR", "coke", "blorp"] });
    expect(step.text).toBe('Added Netflix, Palantir and Coca-Cola. I don\'t have a tokenized stock for "blorp". You\'re watching 3 names.');
    expect(step.structured).toMatchObject({ added: ["NFLX", "PLTR", "KO"], unknown: ["blorp"], watching: ["NFLX", "PLTR", "KO"] });
    expect((await s.call("edit_watchlist", { add: ["netflix"] })).text).toBe("Your watchlist already looks like that. You're watching 3 names.");
    expect((await s.call("edit_watchlist", { remove: ["Coca-Cola"] })).text).toBe("Stopped watching Coca-Cola. You're watching 2 names.");
  });

  it("reads the watchlist back, biggest move first", async () => {
    const s = await session();
    expect((await s.call("my_watchlist", {})).text).toBe("You're not watching anything yet. You can say, add Netflix to my watchlist.");
    await s.call("edit_watchlist", { add: ["Netflix", "Palantir", "Coca-Cola", "Linde"] });
    const step = await s.call("my_watchlist", {});
    expect(step.text).toBe(
      "Using sample data. You're watching 4 names. Since Friday's close: Palantir up 0.8 percent, Netflix up 0.5 percent, Coca-Cola flat and Linde flat.",
    );
  });

  it("leads the briefing with watched names that moved, then the rest of the market without repeats", async () => {
    const s = await session();
    await s.call("edit_watchlist", { add: ["Netflix", "Palantir", "Coca-Cola", "Coinbase"] });
    const brief = await s.call("overnight_brief", {});
    expect(brief.text).toContain("On your watchlist: Coinbase up 3.9 percent, Palantir up 0.8 percent and Netflix up 0.5 percent.");
    expect(brief.text).toContain("Across the market, biggest moves since Friday's close: Strategy up 3.0 percent and Tesla up 2.1 percent.");
    expect(brief.text.indexOf("On your watchlist")).toBeLessThan(brief.text.indexOf("Across the market"));
    expect((brief.structured as { watchlist: { ticker: string }[] }).watchlist.map((r) => r.ticker)).toEqual(["COIN", "PLTR", "NFLX"]);
  });

  it("says so when nothing watched has moved", async () => {
    const s = await session();
    await s.call("edit_watchlist", { add: ["Linde", "Honeywell"] });
    expect((await s.call("overnight_brief", {})).text).toContain("Your watchlist is quiet. Across the market, biggest moves");
  });
});

describe("the scripted planner routes watchlist requests", () => {
  it.each([
    ["Add Netflix to my watchlist", { tool: "edit_watchlist", args: { add: ["NFLX"] } }],
    ["watch Palantir, AMD and Intel", { tool: "edit_watchlist", args: { add: ["PLTR", "AMD", "INTC"] } }],
    ["put coke on my watch list", { tool: "edit_watchlist", args: { add: ["KO"] } }],
    ["stop watching Intel", { tool: "edit_watchlist", args: { remove: ["INTC"] } }],
    ["remove Netflix from my watchlist", { tool: "edit_watchlist", args: { remove: ["NFLX"] } }],
    ["how's my watchlist doing?", { tool: "my_watchlist", args: {} }],
    ["what am I watching", { tool: "my_watchlist", args: {} }],
  ])("%s", (said, expected) => {
    expect(route(said)).toEqual(expected);
  });
});
