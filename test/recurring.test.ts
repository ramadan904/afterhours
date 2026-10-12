import { describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { recordTape } from "../src/market/tape.js";
import { listPlans, parseWeekday, runDuePlans, runsOn, type RecurringPlan } from "../src/chain/recurring.js";
import { getIntent, saveIntent } from "../src/chain/trade.js";
import { route } from "../src/sim/planner.js";
import type { PushSender } from "../src/notify/push.js";

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

async function setup() {
  let now = SUNDAY;
  const sent: { title: string; body: string; url: string }[] = [];
  const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
  const h = harness({ push, now: () => now });
  const { tokens } = await linkWallet(h.app);
  const session = await mcp(h, tokens.access_token);
  await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));
  const sub = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).sub as string;
  return { h, session, sent, sub, at: (iso: string) => (now = Date.parse(iso)) };
}

describe("recurring buys", () => {
  it("sets up a plan by voice and reads it back", async () => {
    const { session } = await setup();
    const set = await session.call("recurring_buy", { stock: "the S&P 500", amount_usd: 25, cadence: "weekly", day: "Mondays", time: "9:30 am" });
    expect(set.text).toBe(
      "Done. Every Monday at 9:30 a.m. Eastern, I'll prepare a $25 buy of the S&P 500 fund and send it to your phone to sign. Nothing is bought unless you sign it.",
    );
    await session.call("recurring_buy", { stock: "Nvidia", amount_usd: 100, cadence: "monthly", day: "the 31st" });
    const list = await session.call("my_recurring_buys", {});
    expect(list.text).toBe(
      "You have 2 recurring buys, times in Eastern. $25 of the S&P 500 fund every Monday at 9:30 a.m.: it hasn't run yet. $100 of Nvidia on the 31st of each month at 9 a.m.: it hasn't run yet.",
    );
    expect((await session.call("stop_recurring_buy", { stock: "Nvidia" })).text).toBe(
      "Stopped your recurring Nvidia buy. Anything already sent to your phone can still be signed until it expires.",
    );
    expect((await session.call("recurring_buy", { stock: "Tesla", amount_usd: 9000, cadence: "daily" })).isError).toBe(true);
  });

  it("prepares a proposal at each run, pushes it, and counts what was signed", async () => {
    const { h, session, sent, sub, at } = await setup();
    await session.call("recurring_buy", { stock: "SPY", amount_usd: 25, cadence: "weekly", day: "monday", time: "9" });

    at("2026-10-12T12:55:00Z"); // Monday 8:55 a.m. Eastern: not yet
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);

    at("2026-10-12T13:02:00Z"); // 9:02
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Your weekly $25 S&P 500 fund buy is ready");
    expect(sent[0].url).toMatch(new RegExp(`^${BASE}/go/\\d{6}$`));
    const [plan] = await listPlans(h.svc, sub);
    const intent = (await getIntent(h.svc.store, plan.runs[0].intentId!, Date.parse("2026-10-12T13:02:00Z")))!;
    expect(intent).toMatchObject({ side: "buy", usd: 25, ticker: "SPY", status: "awaiting_signature", planId: plan.id });
    expect(intent.expiresAt - intent.createdAt).toBe(3600_000);

    at("2026-10-12T13:08:00Z"); // the next sample doesn't run it again
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);

    // The person signs it; next week's run happens too.
    intent.status = "confirmed";
    await saveIntent(h.svc.store, intent, Date.parse("2026-10-12T13:08:00Z"));
    at("2026-10-19T13:01:00Z");
    await recordTape(h.svc);
    expect(sent).toHaveLength(2);
    const after = (await listPlans(h.svc, sub))[0];
    expect(after.runs).toHaveLength(2);
  });

  it("runs once even when two samplers reach the plan at the same moment", async () => {
    const { h, session, sent, at } = await setup();
    await session.call("recurring_buy", { stock: "SPY", amount_usd: 25, cadence: "daily", time: "9" });
    at("2026-10-12T13:02:00Z");
    const prices = new Map([["SPY", 600]]);
    const [a, b] = await Promise.all([runDuePlans(h.svc, prices), runDuePlans(h.svc, prices)]);
    expect(a.length + b.length).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("skips a run that would break the daily limit, and says so", async () => {
    const { h, session, sent, sub, at } = await setup();
    await session.call("set_spending_limit", { daily_usd: 20 });
    await session.call("recurring_buy", { stock: "Tesla", amount_usd: 25, cadence: "daily", time: "8" });
    at("2026-10-12T12:03:00Z");
    await recordTape(h.svc);
    expect(sent.map((n) => n.title)).toEqual(["Skipped today's Tesla buy"]);
    expect((await listPlans(h.svc, sub))[0].runs).toEqual([{ date: "2026-10-12", skipped: "limit" }]);
  });
});

describe("schedules", () => {
  const plan = (p: Partial<RecurringPlan>): RecurringPlan => ({ id: "x", ticker: "SPY", usd: 1, cadence: "monthly", minutes: 0, wallet: "w", createdAt: 0, runs: [], ...p });
  it("runs a monthly plan on the last day of short months", () => {
    expect(runsOn(plan({ dayOfMonth: 31 }), { date: "2026-02-28", weekday: 6 })).toBe(true);
    expect(runsOn(plan({ dayOfMonth: 31 }), { date: "2026-03-30", weekday: 1 })).toBe(false);
    expect(runsOn(plan({ dayOfMonth: 31 }), { date: "2026-03-31", weekday: 2 })).toBe(true);
    expect(runsOn(plan({ cadence: "weekly", weekday: 1 }), { date: "2026-10-12", weekday: 1 })).toBe(true);
  });
  it("hears weekdays", () => {
    expect(["Monday", "mondays", "Tue", "friday"].map(parseWeekday)).toEqual([1, 1, 2, 5]);
    expect(parseWeekday("someday")).toBeNull();
  });
});

describe("the scripted planner routes recurring buys", () => {
  it.each([
    ["buy 25 dollars of the S&P every Monday", { tool: "recurring_buy", args: { stock: "s&p", amount_usd: 25, cadence: "weekly", day: "monday" } }],
    ["buy 10 dollars of Nvidia every day at 9", { tool: "recurring_buy", args: { stock: "nvidia", amount_usd: 10, cadence: "daily", time: "9" } }],
    ["invest 100 dollars in Apple on the 1st of every month", { tool: "recurring_buy", args: { stock: "apple", amount_usd: 100, cadence: "monthly", day: "1" } }],
    ["what recurring buys do I have", { tool: "my_recurring_buys", args: {} }],
    ["stop my weekly S&P buy", { tool: "stop_recurring_buy", args: { stock: "SPY" } }],
    ["buy 25 dollars of Apple", { tool: "propose_trade", args: { stock: "apple", side: "buy", amount_usd: 25 } }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
