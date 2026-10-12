/**
 * Scoring a planner: given what a person said, did it pick the right tool,
 * with the right arguments?
 *
 * Arguments are compared by meaning, not spelling: "the S&P" and "SPY" are the
 * same stock, "7:00 am" and "7" the same time, and lists of names match as
 * sets. Only the arguments a case names are checked; a planner may add others.
 */

import { resolveSymbol } from "../market/universe.js";
import { parseTime } from "../notify/briefing.js";
import { normalisePin } from "../auth/pin.js";

export interface EvalCase {
  say: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Earlier utterances in the same conversation. */
  context?: string[];
}

export interface EvalResult {
  case: EvalCase;
  tool: string | null;
  args: Record<string, unknown> | null;
  toolOk: boolean;
  argsOk: boolean;
  why?: string;
}

const ticker = (v: unknown) => (typeof v === "string" ? (resolveSymbol(v)?.ticker ?? v.toUpperCase()) : v);
const TIME_KEYS = new Set(["time", "from", "until"]);
const PIN_KEYS = new Set(["pin", "new_pin", "current_pin"]);

function same(key: string, want: unknown, got: unknown): boolean {
  if (want === undefined) return true;
  if (got === undefined || got === null) return false;
  if (key === "stock") return ticker(want) === ticker(got);
  if (TIME_KEYS.has(key)) return parseTime(String(want)) === parseTime(String(got)) || String(want).toLowerCase() === String(got).toLowerCase();
  if (PIN_KEYS.has(key)) return normalisePin(String(want)) === normalisePin(String(got));
  if ((key === "add" || key === "remove") && Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    const a = new Set(want.map(ticker));
    const b = new Set(got.map(ticker));
    return a.size === b.size && [...a].every((x) => b.has(x));
  }
  if (key === "targets") {
    if (!Array.isArray(want) || !Array.isArray(got) || want.length !== got.length) return false;
    const norm = (list: { stock: string; percent: number }[]) => list.map((t) => `${ticker(t.stock)}:${Math.round(Number(t.percent))}`).sort().join(",");
    return norm(want as never) === norm(got as never);
  }
  if (key === "day") return String(want).toLowerCase().replace(/s$/, "") === String(got).toLowerCase().replace(/s$/, "").replace(/^(\d+).*$/, "$1");
  if (typeof want === "number") return Math.abs(Number(got) - want) < 1e-6;
  if (typeof want === "string") return want.toLowerCase() === String(got).toLowerCase();
  return JSON.stringify(want) === JSON.stringify(got);
}

export function score(c: EvalCase, tool: string | null, args: Record<string, unknown> | null): EvalResult {
  const toolOk = tool === c.tool;
  const wrong = toolOk ? Object.entries(c.args ?? {}).find(([k, v]) => !same(k, v, args?.[k])) : undefined;
  return {
    case: c,
    tool,
    args,
    toolOk,
    argsOk: toolOk && !wrong,
    why: !toolOk ? `picked ${tool ?? "nothing"}` : wrong ? `${wrong[0]}: wanted ${JSON.stringify(wrong[1])}, got ${JSON.stringify(args?.[wrong[0]])}` : undefined,
  };
}

export function summarise(results: EvalResult[]): { cases: number; tool: number; full: number; byTool: Record<string, { cases: number; full: number }> } {
  const byTool: Record<string, { cases: number; full: number }> = {};
  for (const r of results) {
    const b = (byTool[r.case.tool] ??= { cases: 0, full: 0 });
    b.cases += 1;
    if (r.argsOk) b.full += 1;
  }
  return {
    cases: results.length,
    tool: results.filter((r) => r.toolOk).length / results.length,
    full: results.filter((r) => r.argsOk).length / results.length,
    byTool,
  };
}
