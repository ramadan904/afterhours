/**
 * "Keep me 60 percent S&P, 40 percent Nasdaq."
 *
 * A target mix drifts as prices move. Rebalancing means selling what's grown
 * past its share and buying what's fallen behind. Here it's planned from the
 * wallet's real balances and current token prices, and paid for by the
 * sales themselves (no new money), so the buys never exceed what the sales
 * raise. Holdings outside the plan are left alone and out of the sums.
 *
 * Small drifts aren't worth two swaps' fees: a name is only traded when it's
 * off by at least 2 percent of the plan's value (and $10).
 */

import type { Store } from "../store/store.js";

export interface RebalanceRow {
  ticker: string;
  valueUsd: number;
  weight: number;
  target: number;
  driftUsd: number;
}

export interface RebalanceLeg {
  ticker: string;
  side: "buy" | "sell";
  usd: number;
}

export interface RebalancePlan {
  baseUsd: number;
  rows: RebalanceRow[];
  legs: RebalanceLeg[];
}

const key = (sub: string) => `targets:${sub}`;

export async function getTargets(store: Store, sub: string): Promise<Record<string, number> | null> {
  return store.get<Record<string, number>>(key(sub));
}

export async function setTargets(store: Store, sub: string, targets: Record<string, number> | null): Promise<void> {
  if (targets) await store.set(key(sub), targets);
  else await store.del(key(sub));
}

/** `targets` are fractions summing to 1; `values` are USD by ticker. */
export function planRebalance(targets: Record<string, number>, values: Record<string, number>, minTradeUsd = 10): RebalancePlan {
  const tickers = Object.keys(targets);
  const baseUsd = tickers.reduce((t, k) => t + (values[k] ?? 0), 0);
  const rows = tickers
    .map((ticker) => {
      const valueUsd = values[ticker] ?? 0;
      return { ticker, valueUsd, weight: baseUsd ? valueUsd / baseUsd : 0, target: targets[ticker], driftUsd: valueUsd - targets[ticker] * baseUsd };
    })
    .sort((a, b) => b.driftUsd - a.driftUsd);
  const threshold = Math.max(minTradeUsd, 0.02 * baseUsd);
  const sells = rows.filter((r) => r.driftUsd >= threshold).map((r) => ({ ticker: r.ticker, side: "sell" as const, usd: r.driftUsd }));
  const buys = rows.filter((r) => -r.driftUsd >= threshold).map((r) => ({ ticker: r.ticker, side: "buy" as const, usd: -r.driftUsd }));
  // Self-funding: match the two sides to the smaller total.
  const sold = sells.reduce((t, l) => t + l.usd, 0);
  const bought = buys.reduce((t, l) => t + l.usd, 0);
  const matched = Math.min(sold, bought);
  const scale = (legs: RebalanceLeg[], total: number) =>
    legs.map((l) => ({ ...l, usd: Math.floor(total ? (l.usd * matched) / total : 0) })).filter((l) => l.usd >= 1);
  return { baseUsd, rows, legs: [...scale(sells, sold), ...scale(buys, bought)] };
}
