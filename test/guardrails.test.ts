import { describe, expect, it } from "vitest";
import { SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { recordTape } from "../src/market/tape.js";
import type { PushSender } from "../src/notify/push.js";
import { getGuardrails } from "../src/chain/guardrails.js";
import { getIntent } from "../src/chain/trade.js";
import { route } from "../src/sim/planner.js";

async function setup(start = SUNDAY) {
  let now = start;
  const sent: { title: string; body: string; url: string }[] = [];
  const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
  const h = harness({ push, now: () => now });
  const { tokens } = await linkWallet(h.app);
  const session = await mcp(h, tokens.access_token);
  // Access tokens last an hour; past that, read state as the server holds it.
  const sub = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).sub as string;
  const latest = async () => getIntent(h.svc.store, (await h.svc.store.get<string>(`latest-intent:${sub}`))!, now);
  return { h, session, sent, sub, latest, at: (iso: string) => (now = Date.parse(iso)), advance: (ms: number) => (now += ms), now: () => now };
}

const buy = (stock: string, amount: number) => ({ stock, side: "buy", amount_usd: amount });

describe("daily spending limit", () => {
  it("applies a new or lower limit at once, and counts live and confirmed buys", async () => {
    const { session } = await setup();
    expect((await session.call("set_spending_limit", {})).text).toBe("You don't have a daily spending limit. You can say, don't let me spend more than 200 dollars a day.");
    expect((await session.call("set_spending_limit", { daily_usd: 100 })).text).toBe(
      "Done. From now on I'll only prepare up to $100 of buys a day. Lowering it again works right away; raising it takes a day.",
    );
    expect((await session.call("propose_trade", buy("Tesla", 60))).isError).toBeFalsy();
    const over = await session.call("propose_trade", buy("Apple", 50));
    expect(over.isError).toBe(true);
    expect(over.text).toBe("That's over the daily limit you set: $100 of buys a day, and $60 is already spoken for today. You can still buy up to $40 today.");
    expect((await session.call("propose_trade", buy("Apple", 40))).isError).toBeFalsy();
    // Sells aren't spending.
    expect((await session.call("propose_trade", { stock: "Tesla", side: "sell", amount_usd: 50 })).isError).toBeFalsy();
  });

  it("gives back a cancelled buy's room", async () => {
    const { session } = await setup();
    await session.call("set_spending_limit", { daily_usd: 100 });
    await session.call("propose_trade", buy("Tesla", 80));
    await session.call("cancel_trade", {});
    expect((await session.call("propose_trade", buy("Apple", 90))).isError).toBeFalsy();
  });

  it("makes raising or removing a limit wait 24 hours", async () => {
    const { h, session, advance, sub, now } = await setup();
    await session.call("set_spending_limit", { daily_usd: 100 });
    const raise = await session.call("set_spending_limit", { daily_usd: 500 });
    expect(raise.text).toMatch(/^OK\. I'll raise your limit to \$500 tomorrow at 11:00 a\.m\. Eastern, 24 hours from now\. Until then it stays \$100\. The wait is on purpose\.$/);
    expect(raise.structured).toMatchObject({ dailyLimitUsd: 100, pendingLimitUsd: 500 });
    expect((await session.call("propose_trade", buy("Tesla", 200))).isError).toBe(true);
    // Lowering in the meantime is instant and cancels the pending raise.
    expect((await session.call("set_spending_limit", { daily_usd: 50 })).structured).toMatchObject({ dailyLimitUsd: 50, pendingLimitUsd: null });
    await session.call("set_spending_limit", { remove: true });
    expect((await session.call("set_spending_limit", {})).text).toMatch(/It changes to no limit tomorrow at/);
    advance(24 * 3600_000 + 60_000);
    expect(await getGuardrails(h.svc.store, sub, now())).toEqual({ dailyLimitUsd: null, sleep: null });
  });
});

describe("sleep mode", () => {
  it("sets a late-night trade aside, then makes it signable in the morning and pushes it", async () => {
    // 2:14 a.m. in Lagos is 1:14 UTC.
    const { h, session, sent, at, latest } = await setup(Date.parse("2026-10-13T01:14:00Z"));
    await session.call("set_timezone", { place: "Lagos" });
    expect((await session.call("set_sleep_mode", { on: true })).text).toBe(
      "Sleep mode is on. Between 11 p.m. and 7 a.m. Lagos time, I'll set trades aside until morning instead of preparing them, and send them to your phone when you're up.",
    );
    const asked = await session.call("propose_trade", buy("Tesla", 50));
    expect(asked.text).toBe(
      "Using sample data. It's 2:14 a.m. Lagos time and sleep mode is on, so I've set this $50 buy of Tesla aside instead of preparing it now. It'll be ready to sign at 7:00 a.m., if you still want it. To drop it, say cancel my order.",
    );
    expect(asked.structured).toMatchObject({ status: "armed", code: "" });
    expect((await session.call("trade_status", {})).text).toBe("Your $50 buy of Tesla is set aside until 7:00 a.m. Lagos time, so you can sleep on it.");

    at("2026-10-13T05:30:00Z"); // 6:30 a.m. Lagos: still asleep
    await recordTape(h.svc);
    expect((await latest())?.status).toBe("armed");

    at("2026-10-13T06:02:00Z"); // 7:02 a.m. Lagos
    await recordTape(h.svc);
    const ready = (await latest())!;
    expect(ready.status).toBe("awaiting_signature");
    expect(ready.code).toMatch(/^\d{6}$/);
    const { triggeredTradeNotice } = await import("../src/notify/notices.js");
    const notice = triggeredTradeNotice(ready, "https://x", { tz: "Africa/Lagos", label: "Lagos" });
    expect(notice.title).toBe("Slept on it? Your Tesla buy is ready");
    expect(notice.body).toMatch(/^You asked for \$50 at 2:14 a\.m\. Lagos time\. It's \$[\d.]+ now\. Sign with code \d{6} until 8:02 a\.m\., or let it lapse\.$/);
    expect(sent).toHaveLength(0); // no device subscribed
  });

  it("doesn't hold daytime trades, and reads back custom hours", async () => {
    const { session } = await setup(); // 11 a.m. Eastern
    await session.call("set_sleep_mode", { on: true, from: "midnight", until: "6:30 am" });
    expect((await session.call("set_sleep_mode", {})).text).toBe("Sleep mode is on, from midnight to 6:30 a.m. Eastern.");
    expect((await session.call("propose_trade", buy("Tesla", 50))).structured).toMatchObject({ status: "awaiting_signature" });
    expect((await session.call("set_sleep_mode", { on: true, from: "11" })).structured).toMatchObject({ from: "23:00", until: "06:30" });
    expect((await session.call("set_sleep_mode", { on: false })).structured).toMatchObject({ on: false });
  });
});

describe("the scripted planner routes guardrails", () => {
  it.each([
    ["don't let me spend more than 200 dollars a day", { tool: "set_spending_limit", args: { daily_usd: 200 } }],
    ["what's my spending limit", { tool: "set_spending_limit", args: {} }],
    ["remove my spending limit", { tool: "set_spending_limit", args: { remove: true } }],
    ["don't let me trade at night", { tool: "set_sleep_mode", args: { on: true } }],
    ["turn on sleep mode from midnight to 6 am", { tool: "set_sleep_mode", args: { on: true, from: "midnight", until: "6 am" } }],
    ["turn off sleep mode", { tool: "set_sleep_mode", args: { on: false } }],
    ["is sleep mode on?", { tool: "set_sleep_mode", args: {} }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
