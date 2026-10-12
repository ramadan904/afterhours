import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp, SUNDAY } from "./helpers.js";
import { openRecords, refreshOpenHistory, readOpens, trackRecord, type Bar } from "../src/market/history.js";
import { easternToUtc } from "../src/market/session.js";

const sec = (date: string, minuteEt: number) => easternToUtc(date, minuteEt).getTime() / 1000;

/** A share's regular-session 15m bars for a day: opens at `open`, drifts to `close`. */
function shareDay(date: string, open: number, close: number): Bar[] {
  const bars: Bar[] = [];
  const n = 26; // 9:30 → 16:00
  for (let i = 0; i < n; i += 1) {
    const p = open + ((close - open) * (i + 1)) / n;
    bars.push({ t: sec(date, 9 * 60 + 30 + i * 15), open: i === 0 ? open : p, close: p });
  }
  // Pre/post-market bars must be ignored.
  bars.push({ t: sec(date, 8 * 60), open: 1, close: 1 }, { t: sec(date, 17 * 60), open: 1, close: 1 });
  return bars;
}

describe("open records", () => {
  // Thu 8 Oct, Fri 9 Oct, Mon 12 Oct 2026.
  const share = [...shareDay("2026-10-08", 100, 101), ...shareDay("2026-10-09", 101, 102), ...shareDay("2026-10-12", 104, 103)];
  const token: Bar[] = [
    { t: sec("2026-10-09", 8 * 60), open: 101, close: 101.5 }, // closes 9:00 Fri → Fri's call
    { t: sec("2026-10-11", 20 * 60), open: 103, close: 103.5 },
    { t: sec("2026-10-12", 8 * 60), open: 104.2, close: 104.08 }, // closes 9:00 Mon → Mon's call
  ];

  it("compares the token at 9 a.m. with the share's 9:30 open, both against the previous close", () => {
    const records = openRecords(token, share);
    expect(records.map((r) => r.date)).toEqual(["2026-10-09", "2026-10-12"]);
    const monday = records[1];
    expect(monday.prevClose).toBe(102); // Friday's last regular bar, not post-market
    expect(monday.tokenPreOpen).toBe(104.08);
    expect(monday.shareOpen).toBe(104);
    expect(monday.overnightBps).toBe(203.9);
    expect(monday.openBps).toBe(196.1);
  });

  it("skips days without a token price near 9 a.m.", () => {
    const records = openRecords([token[2]], share);
    expect(records.map((r) => r.date)).toEqual(["2026-10-12"]);
  });

  it("scores the calls", () => {
    const t = trackRecord([
      { date: "a", prevClose: 1, tokenPreOpen: 1, shareOpen: 1, overnightBps: 200, openBps: 150 },
      { date: "b", prevClose: 1, tokenPreOpen: 1, shareOpen: 1, overnightBps: -100, openBps: -140 },
      { date: "c", prevClose: 1, tokenPreOpen: 1, shareOpen: 1, overnightBps: 80, openBps: -20 },
      { date: "d", prevClose: 1, tokenPreOpen: 1, shareOpen: 1, overnightBps: 5, openBps: 60 }, // no call
    ]);
    expect(t).toMatchObject({ opens: 4, calls: 3, sameDirection: 2, medianMissBps: 50, from: "a", to: "d" });
  });
});

describe("daily refresh from public sources", () => {
  it("parses GeckoTerminal and Yahoo responses into stored records, keeping old ones when a source fails", async () => {
    const h = harness({ sample: false });
    const share = [...shareDay("2026-10-08", 100, 101), ...shareDay("2026-10-09", 101, 102)];
    const fake = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.host === "api.geckoterminal.com") {
        if (url.pathname.includes("49iMat")) return new Response("busy", { status: 503 }); // NVDA's pool is down
        return Response.json({ data: { attributes: { ohlcv_list: [[sec("2026-10-09", 8 * 60), 101, 101.6, 101, 101.5, 1000]] } } });
      }
      if (url.host === "query1.finance.yahoo.com") {
        return Response.json({ chart: { result: [{ timestamp: share.map((b) => b.t), indicators: { quote: [{ open: share.map((b) => b.open), close: share.map((b) => b.close) }] } }] } });
      }
      return new Response("not faked", { status: 404 });
    }) as typeof fetch;
    await h.svc.store.set("opens:NVDA", [{ date: "old", prevClose: 1, tokenPreOpen: 1, shareOpen: 1, overnightBps: 0, openBps: 0 }]);
    const result = await refreshOpenHistory(h.svc, fake, 0);
    expect(result.failed).toContain("NVDA");
    expect(result.failed).not.toContain("TSLA");
    expect(result.updated).toContain("TSLA");
    expect((await readOpens(h.svc, "TSLA"))[0]).toMatchObject({ date: "2026-10-09", overnightBps: 49.5, openBps: 0 });
    expect((await readOpens(h.svc, "NVDA"))[0].date).toBe("old");
  });
});

describe("open_track_record tool", () => {
  it("tells you how far to trust the overnight move", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("open_track_record", { stock: "Tesla" });
    expect(step.text).toMatch(
      /^Using sample data\. Over the last 20 market opens, Tesla's token moved meaningfully overnight \d+ times, and the share opened the same way \d+ of them, typically within \d\.\d percent of where the token pointed\. (So far the overnight move has been a decent guide to the open\.|So it's a hint, not a promise\.|So treat the overnight move with real caution\.)$/,
    );
    expect((step.structured as { recent: unknown[] }).recent).toHaveLength(5);

    const stock = await session.call("check_stock", { stock: "Tesla" });
    expect(stock.text).toMatch(/Its token has called the open's direction \d+ of the last \d+ times\.$/);
  });

  it("says so when there isn't enough history yet", async () => {
    const h = harness({ sample: false, now: () => SUNDAY });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("open_track_record", { stock: "Apple" });
    expect(step.isError).toBe(true);
    expect(step.text).toContain("I don't have enough history for Apple yet");
  });
});
