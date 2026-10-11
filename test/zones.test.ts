import { describe, expect, it } from "vitest";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { resolveZone } from "../src/market/zones.js";
import { whenSpoken, nextOpenPhrase } from "../src/market/speech.js";
import { recordTape } from "../src/market/tape.js";
import { alertNotice } from "../src/notify/notices.js";

describe("resolving where someone is", () => {
  it.each([
    ["London", "Europe/London", "London"],
    ["I'm in Lagos", "Africa/Lagos", "Lagos"],
    ["nigeria", "Africa/Lagos", "Nigeria"],
    ["Asia/Tokyo", "Asia/Tokyo", "Tokyo"],
    ["new york", "America/New_York", "Eastern"],
    ["UK", "Europe/London", "UK"],
    ["mumbai.", "Asia/Kolkata", "Mumbai"],
  ])("%s", (said, tz, label) => {
    expect(resolveZone(said)).toEqual({ tz, label });
  });

  it("refuses places it doesn't know", () => {
    expect(resolveZone("Atlantis")).toBeNull();
    expect(resolveZone("Not/AZone")).toBeNull();
  });
});

describe("times in the listener's zone", () => {
  const lagos = { tz: "Africa/Lagos", label: "Lagos" };
  const tokyo = { tz: "Asia/Tokyo", label: "Tokyo" };

  it("names the open in local time, with the local day", () => {
    const sunday = new Date(SUNDAY); // Sun 11:00 New York = 16:00 Lagos = Mon 00:00 Tokyo
    expect(nextOpenPhrase(sunday)).toBe("tomorrow at 9:30 a.m. Eastern");
    expect(nextOpenPhrase(sunday, lagos)).toBe("tomorrow at 2:30 p.m. Lagos time");
    expect(nextOpenPhrase(sunday, tokyo)).toBe("today at 10:30 p.m. Tokyo time");
  });

  it("says when things happened in local time", () => {
    const fired = Date.parse("2026-10-11T06:14:00Z");
    expect(whenSpoken(fired, SUNDAY, lagos)).toBe("at 7:14 a.m. Lagos time");
    expect(alertNotice({ ticker: "TSLA", thresholdBps: 200, createdAt: 0, firedAt: fired, firedGapBps: 230 }, BASE, lagos).body).toBe(
      "Your 2.0 percent alert went off at 7:14 a.m. Lagos time, against the share's last close.",
    );
  });

  it("is set by voice and used everywhere after", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    expect((await session.call("set_timezone", { place: "Lagos" })).text).toBe(
      "Got it, I'll use Lagos time. The US market next opens tomorrow at 2:30 p.m. Lagos time.",
    );
    expect((await session.call("market_status", {})).text).toBe(
      "The US stock market is closed for the weekend. It opens tomorrow at 2:30 p.m. Lagos time. Tokenized stocks are still trading.",
    );
    await session.call("set_alert", { stock: "Tesla", percent: 2 });
    await recordTape(h.svc);
    expect((await session.call("overnight_brief", {})).text).toContain("Your Tesla alert went off at 4:00 p.m. Lagos time");
    expect((await session.call("set_timezone", { place: "Atlantis" })).isError).toBe(true);
  });
});
