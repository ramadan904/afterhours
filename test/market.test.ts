import { describe, expect, it } from "vitest";
import { resolveSymbol, LISTINGS } from "../src/market/universe.js";
import { readGap, closeLabel } from "../src/market/gap.js";
import { getMarketSession, lastRegularClose } from "../src/market/session.js";
import { sessionSentence, pct, usd } from "../src/market/speech.js";
import { CachedPrices, type Board, type PriceSource } from "../src/market/prices.js";
import { route, routeInContext, previousRoute } from "../src/sim/planner.js";
import { spokenCode, spokenUrl } from "../src/mcp/tools.js";

describe("resolveSymbol", () => {
  it.each([
    ["TSLA", "TSLA"],
    ["tslax", "TSLA"],
    ["$NVDA", "NVDA"],
    ["Tesla", "TSLA"],
    ["the Tesla token", "TSLA"],
    ["Apple stock", "AAPL"],
    ["Google", "GOOGL"],
    ["s and p 500", "SPY"],
    ["the Nasdaq", "QQQ"],
    ["MicroStrategy", "MSTR"],
    ["how is coinbase doing", "COIN"],
  ])("%s → %s", (said, ticker) => {
    expect(resolveSymbol(said)?.ticker).toBe(ticker);
  });

  it("returns null for names it does not carry", () => {
    expect(resolveSymbol("Blockbuster")).toBeNull();
    expect(resolveSymbol("")).toBeNull();
  });

  it("pins every mint as a 32-byte base58 Token-2022 xStock", () => {
    for (const l of LISTINGS) {
      expect(l.mint).toMatch(/^Xs[1-9A-HJ-NP-Za-km-z]{41,42}$/);
      expect(l.decimals).toBe(8);
    }
  });
});

describe("gaps mean different things at different hours", () => {
  const tsla = LISTINGS[0];

  it("open market + fresh share print = a live, hedgeable gap", () => {
    const now = Date.parse("2026-10-13T15:00:00Z"); // Tue 11:00 ET
    const r = readGap(tsla, { ticker: "TSLA", tokenPrice: 101, sharePrice: 100, shareUpdatedAt: now - 2000 }, now);
    expect(r.kind).toBe("live_gap");
    expect(r.gapBps).toBe(100);
  });

  it("open market + stale share print = no reliable gap", () => {
    const now = Date.parse("2026-10-13T15:00:00Z");
    const r = readGap(tsla, { ticker: "TSLA", tokenPrice: 101, sharePrice: 100, shareUpdatedAt: now - 10 * 60_000 }, now);
    expect(r.kind).toBe("stale_reference");
  });

  it("weekend = an overnight move against Friday's close", () => {
    const now = Date.parse("2026-10-11T15:00:00Z");
    const r = readGap(tsla, { ticker: "TSLA", tokenPrice: 102, sharePrice: 100, shareUpdatedAt: Date.parse("2026-10-09T20:00:00Z") }, now);
    expect(r.kind).toBe("overnight_move");
    expect(r.referenceLabel).toBe("Friday's close");
  });

  it("tiny gaps are noise", () => {
    const now = Date.parse("2026-10-11T15:00:00Z");
    const r = readGap(tsla, { ticker: "TSLA", tokenPrice: 100.1, sharePrice: 100, shareUpdatedAt: now - 3600_000 }, now);
    expect(r.kind).toBe("in_line");
  });

  it("names the close in New York's calendar", () => {
    const tueNight = Date.parse("2026-10-14T02:00:00Z"); // Tue 22:00 ET
    expect(closeLabel(Date.parse("2026-10-13T20:00:00Z"), tueNight)).toBe("today's close");
    expect(closeLabel(Date.parse("2026-10-13T20:00:00Z"), Date.parse("2026-10-14T12:00:00Z"))).toBe("yesterday's close");
  });
});

describe("lastRegularClose", () => {
  it.each([
    ["2026-10-11T15:00:00Z", "2026-10-09T20:00:00.000Z"], // Sunday → Friday 16:00 EDT
    ["2026-10-13T15:00:00Z", "2026-10-12T20:00:00.000Z"], // Tuesday morning → Monday
    ["2026-10-13T21:00:00Z", "2026-10-13T20:00:00.000Z"], // Tuesday evening → today
    ["2026-11-27T19:00:00Z", "2026-11-27T18:00:00.000Z"], // Day after Thanksgiving, 13:00 EST early close
    ["2026-11-26T15:00:00Z", "2026-11-25T21:00:00.000Z"], // Thanksgiving → Wednesday 16:00 EST
  ])("%s → %s", (at, close) => {
    expect(lastRegularClose(new Date(at)).toISOString()).toBe(close);
  });
});

describe("speech", () => {
  it("says the session and the next open", () => {
    const thanksgiving = new Date("2026-11-26T15:00:00Z");
    expect(sessionSentence(getMarketSession(thanksgiving), thanksgiving)).toBe(
      "The US stock market is closed for Thanksgiving Day. It opens tomorrow at 9:30 a.m. Eastern.",
    );
  });

  it("counts down to the bell when it's close", () => {
    const premarket = new Date("2026-10-13T12:45:00Z"); // Tue 08:45 ET
    expect(sessionSentence(getMarketSession(premarket), premarket)).toBe("The US market is in pre-market trading. It opens in 45 minutes.");
    const early = new Date("2026-10-13T11:20:00Z"); // 07:20 ET
    expect(sessionSentence(getMarketSession(early), early)).toBe("The US market is in pre-market trading. It opens in 2 hours and 10 minutes.");
    const night = new Date("2026-10-13T03:00:00Z"); // Mon 23:00 ET
    expect(sessionSentence(getMarketSession(night), night)).toBe("The US stock market is closed. It opens tomorrow at 9:30 a.m. Eastern.");
  });

  it("rounds for the ear", () => {
    expect(pct(214)).toBe("2.1 percent");
    expect(pct(-38)).toBe("0.4 percent");
    expect(usd(1234.56)).toBe("$1,235");
    expect(usd(370.5)).toBe("$370.50");
    expect(usd(25)).toBe("$25");
    expect(spokenCode("472913")).toBe("4 7 2 9 1 3");
    expect(spokenUrl("https://afterhours.example.com", "/go")).toBe("afterhours dot example dot com slash go");
  });
});

describe("price cache", () => {
  it("serves stale prices instantly and refreshes once behind the request", async () => {
    let t = 0;
    let reads = 0;
    const source: PriceSource = {
      async read(): Promise<Board> {
        reads += 1;
        return { at: t, source: "sample", quotes: new Map() };
      },
    };
    const cache = new CachedPrices(source, 10, 100, () => t);
    await cache.read();
    t = 50; // stale but usable
    const [a, b] = await Promise.all([cache.read(), cache.read()]);
    expect(a.at).toBe(0);
    expect(b.at).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(2);
  });
});

describe("scripted planner", () => {
  it.each([
    ["What happened overnight?", "overnight_brief", {}],
    ["Alexa, how's Tesla doing?", "check_stock", { stock: "tesla" }],
    ["Is the Nvidia token trading rich?", "check_stock", { stock: "nvidia" }],
    ["How's my portfolio?", "my_portfolio", {}],
    ["Tell me if Coinbase moves more than 3 percent", "set_alert", { stock: "coinbase", percent: 3 }],
    ["Tell me if Nvidia goes above 250", "set_alert", { stock: "nvidia", price: 250 }],
    ["Let me know if Apple drops below $300", "set_alert", { stock: "apple", price: 300 }],
    ["What alerts do I have?", "list_alerts", {}],
    ["Stop my Tesla alert", "remove_alert", { stock: "tesla" }],
    ["Buy 25 dollars of Apple", "propose_trade", { stock: "apple", side: "buy", amount_usd: 25 }],
    ["sell fifty dollars of nvidia", "propose_trade", { stock: "nvidia", side: "sell", amount_usd: 50 }],
    ["Did my trade go through?", "trade_status", {}],
    ["Buy 50 dollars of Tesla if it drops below 360", "propose_trade", { stock: "tesla", side: "buy", amount_usd: 50, trigger_price: 360 }],
    ["Sell 100 dollars of Nvidia when it hits $250", "propose_trade", { stock: "nvidia", side: "sell", amount_usd: 100, trigger_price: 250 }],
    ["Cancel my order", "cancel_trade", {}],
    ["Does the weekend move usually hold for Tesla?", "open_track_record", { stock: "tesla" }],
    ["I'm in Lagos", "set_timezone", { place: "lagos" }],
    ["Set my time zone to Tokyo", "set_timezone", { place: "tokyo" }],
    ["Use London time", "set_timezone", { place: "london" }],
    ["Is the stock market open?", "market_status", {}],
    ["What is a tokenized stock?", "explain", { topic: "tokenized_stocks" }],
    ["Why is the token different from the stock?", "explain", { topic: "price_gap" }],
    ["Is this safe?", "explain", { topic: "trading_safety" }],
    ["What can you do?", "explain", { topic: "what_you_can_do" }],
  ])("%s", (said, tool, args) => {
    const r = route(said);
    expect(r?.tool).toBe(tool);
    expect(r?.args).toEqual(args);
  });
});

describe("scripted planner in conversation", () => {
  const convo = (...lines: string[]) => lines.flatMap((text) => [{ role: "user" as const, text }, { role: "assistant" as const, text: "ok" }]);

  it("carries the question over to a new stock", () => {
    expect(routeInContext("What about Nvidia?", previousRoute(convo("How's Tesla doing?")))).toEqual({ tool: "check_stock", args: { stock: "nvidia" } });
    expect(routeInContext("and Apple", previousRoute(convo("Tell me if Tesla moves more than 2 percent")))).toEqual({
      tool: "set_alert",
      args: { stock: "apple", percent: 2 },
    });
  });

  it("resolves 'it' to the stock just discussed", () => {
    expect(routeInContext("Buy 20 dollars of it", previousRoute(convo("How's Tesla doing?")))).toEqual({
      tool: "propose_trade",
      args: { stock: "tesla", side: "buy", amount_usd: 20 },
    });
  });

  it("changes the amount of the trade just proposed", () => {
    const history = convo("How's Tesla doing?", "Buy 20 dollars of it");
    expect(routeInContext("Actually, make it 50", previousRoute(history))).toEqual({
      tool: "propose_trade",
      args: { stock: "tesla", side: "buy", amount_usd: 50 },
    });
  });

  it("asks instead of guessing a missing amount or stock", () => {
    expect(routeInContext("Buy some Apple", null)).toEqual({ ask: "How many dollars of Apple would you like to buy?" });
    expect(routeInContext("Sell 30 dollars", null)).toEqual({ ask: "Which stock would you like to sell?" });
  });
});
