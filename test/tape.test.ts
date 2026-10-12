import { describe, expect, it } from "vitest";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { evaluate, type Alert } from "../src/market/alerts.js";
import { KEEP_MS, SAMPLE_EVERY_MS, overnightRange, readTape, recordTape, sampleTape, writeTape, type TapePoint } from "../src/market/tape.js";
import { LISTINGS } from "../src/market/universe.js";
import { rangeSentence } from "../src/mcp/tools.js";
import { whenSpoken } from "../src/market/speech.js";
import type { GapReading } from "../src/market/gap.js";

const reading = (ticker: string, gapBps: number): GapReading => ({
  ticker, token: `${ticker}x`, spoken: ticker, tokenPrice: 100, sharePrice: 100, gapBps, kind: "overnight_move", direction: "rich", referenceAt: null, referenceLabel: "Friday's close",
});

describe("alerts fire once, stamped, and re-arm", () => {
  const base: Alert = { ticker: "TSLA", thresholdBps: 200, createdAt: 0 };

  it("stamps the first crossing and doesn't fire again while over the line", () => {
    const first = evaluate([base], [reading("TSLA", 230)], 1000);
    expect(first.fired).toHaveLength(1);
    expect(first.next[0]).toMatchObject({ firedAt: 1000, firedGapBps: 230 });
    const again = evaluate(first.next, [reading("TSLA", 260)], 2000);
    expect(again.fired).toHaveLength(0);
    expect(again.next[0].firedAt).toBe(1000);
  });

  it("re-arms only once the move falls under half its line", () => {
    const fired = evaluate([base], [reading("TSLA", -210)], 1000).next;
    expect(evaluate(fired, [reading("TSLA", 150)], 2000).next[0].firedAt).toBe(1000);
    expect(evaluate(fired, [reading("TSLA", 90)], 2000).next[0].firedAt).toBeUndefined();
  });
});

describe("overnight range", () => {
  const tape: TapePoint[] = [
    { at: 1000, gaps: { TSLA: 50 } },
    { at: 2000, gaps: { TSLA: 310 } },
    { at: 3000, gaps: { TSLA: -20 } },
    { at: 4000, gaps: { TSLA: 214 } },
  ];

  it("finds the high and low after the reference time", () => {
    expect(overnightRange(tape, "TSLA", 1500)).toMatchObject({ high: { bps: 310, at: 2000 }, low: { bps: -20, at: 3000 }, samples: 3 });
    expect(overnightRange(tape, "NVDA", 0)).toBeNull();
  });

  it("says a run-up faded, or that it's near the high, and nothing without enough tape", () => {
    const many = (bps: number[]) => ({ high: { bps: Math.max(...bps), at: Date.parse("2026-10-10T05:10:00Z") }, low: { bps: Math.min(...bps), at: 0 }, samples: bps.length, from: 0 });
    const lastNight = { ...reading("TSLA", 214), referenceLabel: "yesterday's close" };
    const morning = Date.parse("2026-10-10T12:00:00Z");
    expect(rangeSentence(lastNight, many([50, 310, 200, 214, 214, 214]), morning)).toBe(
      "Overnight it peaked at up 3.1 percent around 1 a.m., and has faded since.",
    );
    expect(rangeSentence(lastNight, many([50, 230, 200, 214, 214, 214]), morning)).toBe("That's close to its high of the night.");
    expect(rangeSentence(lastNight, many([50, 310]), morning)).toBeNull();
    // Over a weekend it names the close and the day.
    expect(rangeSentence(reading("TSLA", 214), many([50, 310, 200, 214, 214, 214]), SUNDAY)).toBe(
      "Since Friday's close it peaked at up 3.1 percent yesterday around 1 a.m., and has faded since.",
    );
  });

  it("builds a sample night that overshoots and settles on the sample board", () => {
    const tape = sampleTape(SUNDAY);
    const last = tape.at(-1)!;
    expect(last.gaps.COIN).toBe(388);
    const coin = overnightRange(tape, "COIN", 0)!;
    expect(coin.high.bps).toBeGreaterThan(388 * 1.3);
    expect(tape.every((p) => SUNDAY - p.at <= 48 * 3600_000)).toBe(true);
  });
});

describe("tape recorder", () => {
  it("records a point, de-duplicates bursts, and fires alerts with their time", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    await session.call("set_alert", { stock: "Tesla", percent: 2 });

    const first = await recordTape(h.svc);
    expect(first).toMatchObject({ recorded: true, fired: 1, points: 1 });
    expect((await recordTape(h.svc)).recorded).toBe(false);

    const brief = await session.call("overnight_brief", {});
    expect(brief.text).toContain("Your Tesla alert went off at 11:00 a.m. Eastern, when it was up 2.1 percent.");
    const data = brief.structured as { alertsTriggered: { firedAt: string | null }[] };
    expect(data.alertsTriggered[0].firedAt).toBe(new Date(SUNDAY).toISOString());
  });

  it("tells the overnight story in check_stock when the tape has it", async () => {
    const h = harness();
    await writeTape(h.svc.store, sampleTape(SUNDAY));
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("check_stock", { stock: "Coinbase" });
    expect(step.text).toMatch(/Since Friday's close it peaked at up 5\.\d percent (yesterday|on Saturday) around \d{1,2}(:30)? [ap]\.m\., and has faded since\./);
    expect((step.structured as { overnight: { samples: number } }).overnight.samples).toBeGreaterThan(100);
  });

  it("guards the cron route with CRON_SECRET", async () => {
    const h = harness();
    expect((await h.app(new Request(`${BASE}/api/cron/tape`, { method: "POST" }))).status).toBe(404);
    process.env.CRON_SECRET = "cron-secret-value";
    try {
      expect((await h.app(new Request(`${BASE}/api/cron/tape`, { method: "POST", headers: { authorization: "Bearer nope" } }))).status).toBe(401);
      const ok = await h.app(new Request(`${BASE}/api/cron/tape`, { method: "POST", headers: { authorization: "Bearer cron-secret-value" } }));
      expect(await ok.json()).toMatchObject({ recorded: true });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe("spoken times", () => {
  it("names the day when it isn't today", () => {
    const now = Date.parse("2026-10-11T15:00:00Z");
    expect(whenSpoken(Date.parse("2026-10-11T06:14:00Z"), now)).toBe("at 2:14 a.m. Eastern");
    expect(whenSpoken(Date.parse("2026-10-11T01:05:00Z"), now)).toBe("yesterday at 9:05 p.m. Eastern");
    expect(whenSpoken(Date.parse("2026-10-09T23:30:00Z"), now)).toBe("Friday at 7:30 p.m. Eastern");
  });
});

describe("price alerts", () => {
  const priced = (ticker: string, tokenPrice: number): GapReading => ({ ...reading(ticker, 100), tokenPrice });
  const above: Alert = { ticker: "TSLA", thresholdBps: 0, price: 400, above: true, createdAt: 0 };

  it("fires on crossing the line, once, and re-arms 1% back on the other side", () => {
    expect(evaluate([above], [priced("TSLA", 399)], 1).fired).toHaveLength(0);
    const fired = evaluate([above], [priced("TSLA", 401.5)], 1000);
    expect(fired.next[0]).toMatchObject({ firedAt: 1000, firedPrice: 401.5 });
    expect(evaluate(fired.next, [priced("TSLA", 398)], 2000).next[0].firedAt).toBe(1000);
    expect(evaluate(fired.next, [priced("TSLA", 395)], 2000).next[0].firedAt).toBeUndefined();
  });

  it("works through the tools: set from where it trades, listed, and reported with its time", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    expect((await session.call("set_alert", { stock: "Tesla", price: 365 })).text).toBe(
      "Done. I'll tell you when Tesla's token goes below $365. It's at $370.56 now.",
    );
    expect((await session.call("set_alert", { stock: "Nvidia", price: 220 })).text).toContain("goes below $220");
    await session.call("set_alert", { stock: "Tesla", percent: 2 });
    expect((await session.call("list_alerts", {})).text).toBe("You have 3 alerts: Tesla below $365, Nvidia below $220 and Tesla at 2.0 percent.");
    expect((await session.call("set_alert", { stock: "Tesla" })).isError).toBe(true);

    // Tesla falls through $365 overnight.
    const board = await h.svc.prices.read();
    board.quotes.get("TSLA")!.tokenPrice = 360;
    await recordTape(h.svc);
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).toContain("Tesla's token went below $365 at 11:00 a.m. Eastern; it's at $360 now.");
  });
});

describe("tape storage", () => {
  it("keeps 48 hours of every listing in buckets well under DynamoDB's 400KB item limit", async () => {
    const h = harness({ sample: false });
    const now = h.svc.now();
    const tickers = LISTINGS.map((l) => l.ticker);
    const points: TapePoint[] = [];
    for (let at = now - KEEP_MS + SAMPLE_EVERY_MS; at <= now; at += SAMPLE_EVERY_MS) {
      points.push({ at, gaps: Object.fromEntries(tickers.map((t, i) => [t, Math.round(Math.sin(at / 1e7 + i) * 3000) / 10])) });
    }
    const sizes: number[] = [];
    const store = h.svc.store;
    const spy = { get: (k: string) => store.get(k), set: async (k: string, v: unknown, ttl?: number) => (sizes.push(JSON.stringify(v).length), store.set(k, v, ttl)) };
    await writeTape(spy as typeof store, points);
    expect(Math.max(...sizes)).toBeLessThan(64_000);
    const back = await readTape(h.svc);
    expect(back).toHaveLength(points.length);
    expect(back.at(-1)).toEqual(points.at(-1));
    expect(back[0]).toEqual(points[0]);
  });

  it("drops a name from a sample without inventing a value for it", async () => {
    const h = harness({ sample: false });
    const now = h.svc.now();
    await writeTape(h.svc.store, [
      { at: now - 2 * SAMPLE_EVERY_MS, gaps: { TSLA: 10, NVDA: 5 } },
      { at: now - SAMPLE_EVERY_MS, gaps: { TSLA: 12 } },
    ]);
    const back = await readTape(h.svc);
    expect(back[1].gaps).toEqual({ TSLA: 12 });
    expect(overnightRange(back, "NVDA", 0)?.samples).toBe(1);
  });
});
