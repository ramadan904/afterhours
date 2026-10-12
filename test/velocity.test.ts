import { describe, expect, it } from "vitest";
import { SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { pastGaps, recordTape, writeTape } from "../src/market/tape.js";
import { nearestWindow } from "../src/market/alerts.js";
import { alertNotice } from "../src/notify/notices.js";
import { route } from "../src/sim/planner.js";

describe("sudden-move alerts", () => {
  it("round windows and read the tape that far back", () => {
    expect([10, 45, 60, 90, 200].map(nearestWindow)).toEqual([15, 30, 60, 60, 240]);
    const past = pastGaps([{ at: SUNDAY - 62 * 60_000, gaps: { TSLA: 100, NVDA: 50, AMD: 30 } }], SUNDAY);
    expect(past.get("TSLA:60")).toBe(100);
    expect(past.get("sector:chips:60")).toBe(40);
    expect(past.has("TSLA:15")).toBe(false);
  });

  it("fire when a name moves that much within the window, and say so in the briefing", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const s = await mcp(h, tokens.access_token);
    expect((await s.call("set_alert", { stock: "Tesla", percent: 1, within_minutes: 50 })).text).toBe(
      "Done. I'll tell you if Tesla moves 1.0 percent or more within an hour, up or down, day or night.",
    );
    await s.call("set_alert", { stock: "Tesla", percent: 5 }); // a plain move alert lives alongside
    expect((await s.call("list_alerts", {})).text).toBe("You have 2 alerts: Tesla at 1.0 percent within an hour and Tesla at 5.0 percent.");
    // An hour ago the token was up 1.0%; now (sample board) it's up 2.1%.
    await writeTape(h.svc.store, [{ at: SUNDAY - 60 * 60_000, gaps: { TSLA: 100 } }]);
    await recordTape(h.svc);
    const brief = (await s.call("overnight_brief", {})).text;
    expect(brief).toContain("Tesla's sudden-move alert went off at 11:00 a.m. Eastern: it moved up 1.1 percent within an hour.");
  });

  it("read well on a lock screen", () => {
    const n = alertNotice({ ticker: "TSLA", thresholdBps: 100, windowMin: 60, createdAt: 0, firedAt: SUNDAY, firedGapBps: 114 }, "https://x");
    expect(n.title).toBe("Tesla moved up 1.1 percent in an hour");
    expect(n.body).toBe("Your 1.0 percent within an hour alert went off at 11:00 a.m. ET.");
  });

  it.each([
    ["tell me if Tesla moves 2 percent within an hour", { stock: "tesla", percent: 2, within_minutes: 60 }],
    ["alert me if Nvidia moves 3 percent in 30 minutes", { stock: "nvidia", percent: 3, within_minutes: 30 }],
    ["tell me if Tesla moves more than 2 percent", { stock: "tesla", percent: 2 }],
  ])("routes %s", (said, args) => expect(route(said)).toEqual({ tool: "set_alert", args }));
});
