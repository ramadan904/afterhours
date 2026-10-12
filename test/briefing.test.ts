import { describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { parseTime, spokenTime } from "../src/notify/briefing.js";
import { recordTape } from "../src/market/tape.js";
import type { PushSender } from "../src/notify/push.js";
import { route } from "../src/sim/planner.js";

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
  const subscribe = () =>
    h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));
  return { h, session, sent, subscribe, at: (iso: string) => (now = Date.parse(iso)) };
}

describe("times as said", () => {
  it.each([
    ["7", 420], ["7am", 420], ["7 a.m.", 420], ["7:30 am", 450], ["6:45", 405], ["19:00", 1140], ["7 pm", 1140],
    ["noon", 720], ["12 am", 0], ["6 in the morning", 360], ["8 in the evening", 1200], ["at 9", 540],
  ])("%s → %i", (said, minutes) => expect(parseTime(said)).toBe(minutes));

  it.each(["25:00", "13 pm", "seven", "", "7:75"])("rejects %s", (said) => expect(parseTime(said)).toBeNull());

  it("says times back the way people say them", () => {
    expect([420, 450, 720, 1140, 0].map(spokenTime)).toEqual(["7 a.m.", "7:30 a.m.", "noon", "7 p.m.", "12 a.m."]);
  });
});

describe("schedule_briefing", () => {
  it("sets, reads back and stops a briefing, in the account's own time zone", async () => {
    const { session, subscribe } = await setup();
    expect((await session.call("schedule_briefing", {})).text).toBe("You don't have a scheduled briefing. You can say, brief me every weekday at 7.");
    const set = await session.call("schedule_briefing", { time: "7" });
    expect(set.text).toBe(
      "Done. I'll send your briefing every weekday at 7 a.m. Eastern. It comes as a notification, so turn notifications on in the Afterhours app on your phone.",
    );
    expect(set.structured).toMatchObject({ scheduled: true, time: "07:00", days: "weekdays", timeZone: "America/New_York", devices: 0 });
    await subscribe();
    await session.call("set_timezone", { place: "Lagos" });
    expect((await session.call("schedule_briefing", { time: "6:30 am", days: "daily" })).text).toBe("Done. I'll send your briefing every day at 6:30 a.m. Lagos time.");
    expect((await session.call("schedule_briefing", {})).text).toBe("Your briefing comes every day at 6:30 a.m. Lagos time.");
    expect((await session.call("schedule_briefing", { time: "whenever" })).isError).toBe(true);
    expect((await session.call("schedule_briefing", { off: true })).text).toBe("Done. I've stopped your scheduled briefing.");
    expect((await session.call("schedule_briefing", {})).structured).toMatchObject({ scheduled: false });
  });
});

describe("sending scheduled briefings", () => {
  it("pushes once when the time comes, on the days asked for", async () => {
    const { h, session, sent, subscribe, at } = await setup();
    await subscribe();
    await session.call("edit_watchlist", { add: ["Palantir", "Netflix"] });
    await session.call("schedule_briefing", { time: "7am", days: "weekdays" });

    at("2026-10-11T11:03:00Z"); // Sunday 7:03 a.m. Eastern: not a weekday
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);

    at("2026-10-12T10:58:00Z"); // Monday 6:58: not yet
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);

    at("2026-10-12T11:03:00Z"); // Monday 7:03
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("[Sample] Your Monday morning briefing");
    expect(sent[0].body).toMatch(/^Your \$[\d,]+(\.\d\d)? portfolio is (up|down) \$[\d,.]+ since the close\. Watchlist: Palantir \+0\.8%, Netflix \+0\.5%\. Biggest: Coinbase \+3\.9%, Strategy \+3\.0%, Tesla \+2\.1%\.$/);
    expect(sent[0].url).toBe(`${BASE}/app/`);

    at("2026-10-12T11:09:00Z"); // the next sample, same morning
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);

    at("2026-10-13T11:40:00Z"); // Tuesday, but 40 minutes late: skipped rather than sent stale
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
  });
});

describe("the scripted planner routes briefing schedules", () => {
  it.each([
    ["brief me every weekday at 7", { tool: "schedule_briefing", args: { time: "7", days: "weekdays" } }],
    ["send my briefing every day at 6:30 am", { tool: "schedule_briefing", args: { time: "6:30 am", days: "daily" } }],
    ["schedule my briefing for weekends at 9", { tool: "schedule_briefing", args: { time: "9", days: "weekends" } }],
    ["stop my morning briefing", { tool: "schedule_briefing", args: { off: true } }],
    ["when is my briefing?", { tool: "schedule_briefing", args: {} }],
    ["give me my briefing", { tool: "overnight_brief", args: {} }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
