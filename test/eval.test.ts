import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { score, summarise, type EvalCase } from "../src/sim/eval.js";
import { LISTINGS } from "../src/market/universe.js";
import { resolveSector } from "../src/market/sectors.js";

describe("planner scoring", () => {
  it("compares arguments by meaning", () => {
    const c: EvalCase = { say: "", tool: "recurring_buy", args: { stock: "SPY", time: "7", day: "monday", amount_usd: 25 } };
    expect(score(c, "recurring_buy", { stock: "the S&P 500", time: "7:00 am", day: "Mondays", amount_usd: 25 }).argsOk).toBe(true);
    expect(score(c, "recurring_buy", { stock: "QQQ", time: "7", day: "monday", amount_usd: 25 }).why).toBe('stock: wanted "SPY", got "QQQ"');
    expect(score(c, "propose_trade", {}).why).toBe("picked propose_trade");
    expect(score({ say: "", tool: "edit_watchlist", args: { add: ["NFLX", "PLTR"] } }, "edit_watchlist", { add: ["palantir", "Netflix"] }).argsOk).toBe(true);
    expect(score({ say: "", tool: "set_trade_pin", args: { new_pin: "4719" } }, "set_trade_pin", { new_pin: "four seven one nine" }).argsOk).toBe(true);
    expect(score({ say: "", tool: "set_spending_limit", args: { remove: true } }, "set_spending_limit", { remove: true }).argsOk).toBe(true);
  });

  it("summarises per tool", () => {
    const s = summarise([score({ say: "a", tool: "x" }, "x", {}), score({ say: "b", tool: "x" }, "y", {})]);
    expect(s).toMatchObject({ cases: 2, tool: 0.5, full: 0.5, byTool: { x: { cases: 2, full: 1 } } });
  });

  it("keeps the eval sets well-formed: known tools, resolvable stocks", () => {
    for (const set of ["planner", "planner-holdout"]) {
      const { cases } = JSON.parse(readFileSync(`eval/${set}.json`, "utf8")) as { cases: EvalCase[] };
      expect(cases.length).toBeGreaterThan(30);
      for (const c of cases) {
        const stock = c.args?.stock;
        if (typeof stock === "string") expect(LISTINGS.some((l) => l.ticker === stock) || resolveSector(stock) !== null, `${set}: ${c.say}`).toBe(true);
      }
    }
  });
});
