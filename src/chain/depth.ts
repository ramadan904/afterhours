/**
 * How much size the token market can take right now.
 *
 * On a weekend, a tokenized stock trades against on-chain pools, not an
 * exchange with market makers in every size. A $100 buy and a $10,000 buy
 * of the same token can fill at very different prices, and nobody says so
 * out loud. This asks Jupiter, the router that would fill the trade, for real
 * quotes at a few sizes, and turns each into what it costs over the token's
 * price.
 *
 * Results are cached for a minute; a voice turn waits for them only briefly.
 */

import type { Services } from "../services.js";
import { USDC, listingByTicker } from "../market/universe.js";

export interface DepthStep {
  usd: number;
  /** Cost of size: how far the fill is from the token's price, in basis points. */
  impactBps: number;
  effectivePrice: number;
}

export interface Depth {
  ticker: string;
  side: "buy" | "sell";
  midPrice: number;
  steps: DepthStep[];
  at: number;
  source: "jupiter" | "sample";
}

export const LADDER = [100, 1_000, 10_000];
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; work: Promise<Depth> }>();

/** Liquidity tiers for the offline model: deep for the names everyone trades, thin for the rest. */
const SAMPLE_DEPTH_USD: Record<string, number> = { SPY: 4e6, TSLA: 3e6, NVDA: 2.5e6, QQQ: 2.5e6, AAPL: 2e6, MSFT: 1.5e6, META: 1.2e6, AMZN: 1.2e6, GOOGL: 1.2e6, COIN: 8e5, MSTR: 8e5, CRCL: 5e5 };

function sampleStep(ticker: string, usd: number, mid: number, side: "buy" | "sell"): DepthStep {
  const depth = SAMPLE_DEPTH_USD[ticker] ?? 1.5e5;
  const impactBps = 8 + (usd / depth) * 10_000 * 0.6;
  const effectivePrice = mid * (1 + ((side === "buy" ? 1 : -1) * impactBps) / 10_000);
  return { usd, impactBps: Math.round(impactBps * 10) / 10, effectivePrice };
}

async function quoteStep(svc: Services, ticker: string, side: "buy" | "sell", usd: number, mid: number): Promise<DepthStep> {
  const listing = listingByTicker(ticker)!;
  if (side === "buy") {
    const q = await svc.swap.quote({ inputMint: USDC.mint, outputMint: listing.mint, amount: BigInt(Math.round(usd * 10 ** USDC.decimals)), slippageBps: 50 });
    const tokens = Number(q.outAmount) / 10 ** listing.decimals;
    const effectivePrice = usd / tokens;
    return { usd, impactBps: Math.round((effectivePrice / mid - 1) * 100_000) / 10, effectivePrice };
  }
  const tokens = usd / mid;
  const q = await svc.swap.quote({ inputMint: listing.mint, outputMint: USDC.mint, amount: BigInt(Math.floor(tokens * 10 ** listing.decimals)), slippageBps: 50 });
  const effectivePrice = Number(q.outAmount) / 10 ** USDC.decimals / tokens;
  return { usd, impactBps: Math.round((1 - effectivePrice / mid) * 100_000) / 10, effectivePrice };
}

/** Quotes at each size in `sizes`, in parallel, cached for a minute per name and side. */
export function depthLadder(svc: Services, ticker: string, side: "buy" | "sell", mid: number, sizes = LADDER): Promise<Depth> {
  const k = `${ticker}:${side}:${sizes.join(",")}`;
  const hit = cache.get(k);
  if (hit && svc.now() - hit.at < TTL_MS) return hit.work;
  const at = svc.now();
  const work = svc.sample
    ? Promise.resolve({ ticker, side, midPrice: mid, steps: sizes.map((u) => sampleStep(ticker, u, mid, side)), at, source: "sample" as const })
    : Promise.all(sizes.map((u) => quoteStep(svc, ticker, side, u, mid))).then((steps) => ({ ticker, side, midPrice: mid, steps, at, source: "jupiter" as const }));
  cache.set(k, { at, work });
  work.catch(() => cache.delete(k));
  return work;
}

/** The cost of one size, for warning before a big proposal. */
export async function impactAt(svc: Services, ticker: string, side: "buy" | "sell", usd: number, mid: number): Promise<DepthStep> {
  return (await depthLadder(svc, ticker, side, mid, [usd])).steps[0];
}

/** Largest ladder size that costs under `bps`, or null if even the smallest doesn't. */
export function sizeWithin(depth: Depth, bps: number): number | null {
  const ok = depth.steps.filter((s) => s.impactBps <= bps);
  return ok.length ? ok[ok.length - 1].usd : null;
}

export function clearDepthCache(): void {
  cache.clear();
}
