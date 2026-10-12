import { describe, expect, it } from "vitest";
import { estimateBeta, splitMove, dailyCloses } from "../src/market/beta.js";
import { splitSentence } from "../src/mcp/tools.js";
import { easternToUtc } from "../src/market/session.js";

function series(returns: number[], start = 100): Map<string, number> {
  const out = new Map<string, number>();
  let p = start;
  returns.forEach((r, i) => {
    p *= 1 + r;
    out.set(`2026-09-${String(i + 1).padStart(2, "0")}`, p);
  });
  return out;
}

describe("beta from daily closes", () => {
  const market = [0.01, -0.005, 0.002, 0.012, -0.008, 0.004, -0.011, 0.007, 0.003, -0.002, 0.006, -0.004, 0.009];
  it("recovers a known beta exactly when the name tracks the market", () => {
    const b = estimateBeta(series(market.map((r) => 2 * r)), series(market))!;
    expect(b.beta).toBe(2);
    expect(b.r2).toBe(1);
    expect(b.days).toBe(12);
  });
  it("needs at least ten shared days", () => {
    expect(estimateBeta(series(market.slice(0, 8)), series(market.slice(0, 8)))).toBeNull();
  });
  it("takes the last regular-session bar of each New York day", () => {
    const sec = (min: number) => easternToUtc("2026-10-09", min).getTime() / 1000;
    const closes = dailyCloses([
      { t: sec(9 * 60 + 30), open: 1, close: 1 },
      { t: sec(15 * 60 + 45), open: 2, close: 2 },
      { t: sec(16 * 60 + 15), open: 3, close: 3 }, // after hours
    ]);
    expect(closes.get("2026-10-09")).toBe(2);
  });
});

describe("splitting a move", () => {
  const beta = { beta: 1.8, r2: 0.6, days: 21 };
  it("calls a move mostly the market when the beta explains it", () => {
    const s = splitMove(200, 100, beta)!;
    expect(s.verdict).toBe("mostly_market");
    expect(splitSentence("Nvidia", s)).toBe("That's mostly the market: the S&P 500 token is up 1.0 percent, and Nvidia usually moves about 1.8 times as much.");
  });
  it("calls it the company's own when the market barely moved", () => {
    expect(splitSentence("Tesla", splitMove(214, 10, beta)!)).toBe("Most of that is Tesla's own; the S&P 500 token is up 0.1 percent.");
  });
  it("splits the difference out loud", () => {
    expect(splitSentence("Apple", splitMove(-200, -60, beta)!)).toBe("About 1.1 percent of that is the market, and 0.9 percent is Apple's own.");
  });
  it("stays quiet for small moves or betas the market doesn't explain", () => {
    expect(splitMove(20, 10, beta)).toBeNull();
    expect(splitMove(200, 10, { beta: 1, r2: 0.05, days: 21 })).toBeNull();
    expect(splitMove(200, 10, undefined)).toBeNull();
  });
});
