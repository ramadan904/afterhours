import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { normalisePin } from "../src/auth/pin.js";
import { route, routeInContext } from "../src/sim/planner.js";

async function setup() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return { h, session: await mcp(h, tokens.access_token) };
}
const buy = { stock: "Tesla", side: "buy", amount_usd: 25 };

describe("spoken trade PIN", () => {
  it("hears PINs however they're said", () => {
    expect(["4 7 1 9", "4-7-1-9", "four seven one nine", "four, seven, one, nine", "4719"].map(normalisePin)).toEqual(Array(5).fill("4719"));
    expect(normalisePin("oh four oh two")).toBe("0402");
  });

  it("asks for the PIN before preparing a trade, and never says it back", async () => {
    const { session } = await setup();
    const set = await session.call("set_trade_pin", { new_pin: "four seven one nine" });
    expect(set.text).toBe("Done. From now on I'll ask for your PIN before preparing a trade. I won't say it back.");
    expect(set.text).not.toMatch(/4\s*7\s*1\s*9|four seven/);
    const ask = await session.call("propose_trade", buy);
    expect(ask).toMatchObject({ isError: true, text: "You've set a trade PIN. What is it?" });
    expect((await session.call("propose_trade", { ...buy, pin: "4 7 1 9" })).structured).toMatchObject({ status: "awaiting_signature" });
    expect((await session.call("recurring_buy", { stock: "SPY", amount_usd: 10, cadence: "weekly" })).text).toBe("You've set a trade PIN. What is it?");
  });

  it("locks voice trading for an hour after five wrong tries, even for the right PIN", async () => {
    const { session } = await setup();
    await session.call("set_trade_pin", { new_pin: "4719" });
    expect((await session.call("propose_trade", { ...buy, pin: "1111" })).text).toBe("That PIN isn't right. 4 more wrong tries and trading by voice locks for an hour.");
    for (let i = 0; i < 3; i += 1) await session.call("propose_trade", { ...buy, pin: "1111" });
    const locked = await session.call("propose_trade", { ...buy, pin: "1111" });
    expect(locked.text).toBe("Trading by voice is locked until 12:00 p.m. after too many wrong PINs. Nothing was prepared.");
    expect((await session.call("propose_trade", { ...buy, pin: "4719" })).text).toContain("locked until");
  });

  it("needs the current PIN to change or remove it, and refuses easy ones", async () => {
    const { session } = await setup();
    expect((await session.call("set_trade_pin", { new_pin: "1234" })).text).toBe("That PIN is too easy to guess. Pick digits that aren't all the same or in a row.");
    expect((await session.call("set_trade_pin", { new_pin: "7777" })).isError).toBe(true);
    await session.call("set_trade_pin", { new_pin: "4719" });
    expect((await session.call("set_trade_pin", { remove: true })).text).toBe("To change or remove your PIN, I need your current one first.");
    expect((await session.call("set_trade_pin", { remove: true, current_pin: "4719" })).text).toBe("Your trade PIN is removed.");
    expect((await session.call("propose_trade", buy)).structured).toMatchObject({ status: "awaiting_signature" });
  });
});

describe("the scripted planner and PINs", () => {
  it("routes PIN requests, and carries a spoken PIN into the trade that asked for it", () => {
    expect(route("set a trade pin 4 7 1 9")).toEqual({ tool: "set_trade_pin", args: { new_pin: "4 7 1 9" } });
    expect(route("remove my trade pin")).toEqual({ tool: "set_trade_pin", args: { remove: true } });
    const previous = { tool: "propose_trade", args: { stock: "tesla", side: "buy", amount_usd: 25 } };
    expect(routeInContext("four seven one nine", previous)).toEqual({ tool: "propose_trade", args: { ...previous.args, pin: "four seven one nine" } });
    expect(routeInContext("my pin is 4719", previous)).toEqual({ tool: "propose_trade", args: { ...previous.args, pin: "4719" } });
    expect(routeInContext("4719", { tool: "set_trade_pin", args: { remove: true } })).toEqual({ tool: "set_trade_pin", args: { remove: true, current_pin: "4719" } });
  });
});
