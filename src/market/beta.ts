/**
 * Is it Tesla, or is it the market?
 *
 * "Tesla's token is up 2.1 percent" means something different when the whole
 * market's token basket is up 1.5 percent too. Each name's beta (how much it
 * typically moves per 1% move in the S&P 500) is estimated from a month of
 * daily closes of the real shares, fetched with the daily history refresh.
 * Overnight, the S&P 500 token's own move stands in for the market, so a move
 * can be split into the part the market explains and the part that's the
 * company's own.
 */

import type { Services } from "../services.js";
import type { Bar } from "./history.js";
import { regularCloseMinute, toEasternParts } from "./session.js";

export interface Beta {
  beta: number;
  /** How much of the name's daily variance the market explains, 0 to 1. */
  r2: number;
  days: number;
}

const KEY = "betas:v1";
const OPEN_MINUTE = 9 * 60 + 30;

/** Last regular-session close per New York date. */
export function dailyCloses(bars: Bar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of [...bars].sort((x, y) => x.t - y.t)) {
    const et = toEasternParts(new Date(b.t * 1000));
    if (et.minutes >= OPEN_MINUTE && et.minutes < regularCloseMinute(et.date)) out.set(et.date, b.close);
  }
  return out;
}

/** Ordinary least squares of the name's daily returns on the market's, over shared dates. */
export function estimateBeta(name: Map<string, number>, market: Map<string, number>): Beta | null {
  const dates = [...name.keys()].filter((d) => market.has(d)).sort();
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    x.push(market.get(dates[i])! / market.get(dates[i - 1])! - 1);
    y.push(name.get(dates[i])! / name.get(dates[i - 1])! - 1);
  }
  if (x.length < 10) return null;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < x.length; i += 1) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) ** 2;
    vy += (y[i] - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null;
  const beta = cov / vx;
  return { beta: Math.round(beta * 100) / 100, r2: Math.round(((cov * cov) / (vx * vy)) * 100) / 100, days: x.length };
}

export async function saveBetas(svc: Services, betas: Record<string, Beta>): Promise<void> {
  await svc.store.set(KEY, { at: svc.now(), betas });
}

/** Plausible betas for the offline board, labelled as sample data wherever used. */
const SAMPLE_BETAS: Record<string, number> = {
  TSLA: 2.0, NVDA: 1.8, AAPL: 1.1, MSFT: 1.0, META: 1.3, AMZN: 1.2, GOOGL: 1.1, COIN: 2.6, MSTR: 3.0, CRCL: 2.2, QQQ: 1.15, SPY: 1,
  AMD: 1.9, PLTR: 2.2, NFLX: 1.2, KO: 0.5, PEP: 0.5, PG: 0.4, JNJ: 0.5, WMT: 0.6, GLD: 0.1, TQQQ: 3.4, IWM: 1.2, VTI: 1.0,
};

export async function readBetas(svc: Services): Promise<Record<string, Beta>> {
  if (svc.sample) return Object.fromEntries(Object.entries(SAMPLE_BETAS).map(([t, beta]) => [t, { beta, r2: 0.5, days: 21 }]));
  return (await svc.store.get<{ betas: Record<string, Beta> }>(KEY))?.betas ?? {};
}

export interface MoveSplit {
  /** The market's (S&P 500 token's) move, bps. */
  marketBps: number;
  /** What the beta says the market alone would explain, bps. */
  explainedBps: number;
  /** The rest: the company's own move, bps. */
  ownBps: number;
  beta: number;
  verdict: "mostly_market" | "mostly_own" | "both";
}

/** Splits a name's move into market and own, when there's enough to say. */
export function splitMove(gapBps: number, marketBps: number, beta: Beta | undefined): MoveSplit | null {
  if (!beta || beta.r2 < 0.1 || Math.abs(gapBps) < 30) return null;
  const explainedBps = beta.beta * marketBps;
  const ownBps = gapBps - explainedBps;
  const share = explainedBps / gapBps;
  const verdict = share >= 0.65 ? "mostly_market" : share <= 0.35 ? "mostly_own" : "both";
  return { marketBps, explainedBps, ownBps, beta: beta.beta, verdict };
}
