import { describe, expect, it } from "vitest";
import { LISTINGS, resolveSymbol } from "../src/market/universe.js";
import { SAMPLE_BOARD } from "../src/market/prices.js";

describe("the wider universe", () => {
  it("has unique tickers and mints, all Backed xStock mints", () => {
    expect(new Set(LISTINGS.map((l) => l.ticker)).size).toBe(LISTINGS.length);
    expect(new Set(LISTINGS.map((l) => l.mint)).size).toBe(LISTINGS.length);
    for (const l of LISTINGS) expect(l.mint).toMatch(/^Xs/);
    expect(LISTINGS.length).toBeGreaterThanOrEqual(60);
  });

  it("gives every listing a sample price, so the offline demo covers all of it", () => {
    for (const l of LISTINGS) expect(SAMPLE_BOARD[l.ticker], l.ticker).toBeDefined();
  });

  it("never lets two listings answer to the same phrase", () => {
    const seen = new Map<string, string>();
    for (const l of LISTINGS) {
      for (const a of l.aliases) {
        expect(seen.get(a) ?? l.ticker, `"${a}"`).toBe(l.ticker);
        seen.set(a, l.ticker);
      }
    }
  });

  it.each([
    ["Netflix", "NFLX"], ["coke", "KO"], ["how is AMD doing", "AMD"], ["the gold fund", "GLD"], ["gold", "GLD"],
    ["J P Morgan", "JPM"], ["Johnson and Johnson", "JNJ"], ["McDonald's", "MCD"], ["Procter and Gamble", "PG"],
    ["Russell 2000", "IWM"], ["eli lilly", "LLY"], ["TSMC", "TSM"], ["Super Micro", "SMCI"], ["PLTRx", "PLTR"],
    ["what about bank of america", "BAC"], ["exxon", "XOM"], ["the S&P 500", "SPY"], ["Tesla stock", "TSLA"],
  ])("%s → %s", (said, ticker) => {
    expect(resolveSymbol(said)?.ticker).toBe(ticker);
  });

  it("doesn't mistake common words for a ticker inside a sentence", () => {
    // "V", "KO", "PG" are tickers, but only whole-input tickers resolve.
    expect(resolveSymbol("tell me about a stock")).toBeNull();
    expect(resolveSymbol("what is going on")).toBeNull();
  });
});
