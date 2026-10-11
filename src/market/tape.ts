/**
 * The overnight tape: what the token market did while you slept.
 *
 * A single price is a snapshot. The question people actually ask in the
 * morning is about the night: did Tesla run up and fade, or grind higher? So
 * the board is sampled every few minutes into a rolling 48-hour tape, and two
 * things are read back from it:
 *
 * - the overnight range for a name since the share last traded, with when the
 *   high and low happened ("it peaked at up 3.1 percent around 1 a.m.");
 * - alerts, checked on every sample, so one that fired at 2 a.m. is reported
 *   with its time even if the move has faded by breakfast.
 *
 * Sampling runs on a timer in a long-running process, or from a scheduled
 * request (`/api/cron/tape`) when deployed as serverless functions.
 */

import type { Services } from "../services.js";
import { LISTINGS } from "./universe.js";
import { readGap, type GapReading } from "./gap.js";
import { getMarketSession, lastRegularClose } from "./session.js";
import { SAMPLE_BOARD } from "./prices.js";
import { evaluateAll } from "./alerts.js";

export interface TapePoint {
  /** Unix ms. */
  at: number;
  /** Gap per ticker in basis points (one decimal). */
  gaps: Record<string, number>;
}

export const TAPE_KEY = "tape:v1";
export const SAMPLE_EVERY_MS = 5 * 60_000;
export const KEEP_MS = 48 * 3600_000;

export async function readTape(svc: Services): Promise<TapePoint[]> {
  return (await svc.store.get<TapePoint[]>(TAPE_KEY)) ?? [];
}

export function readingsFrom(board: Awaited<ReturnType<Services["prices"]["read"]>>, now: number): GapReading[] {
  const session = getMarketSession(new Date(now));
  return LISTINGS.flatMap((l) => {
    const q = board.quotes.get(l.ticker);
    return q ? [readGap(l, q, now, session)] : [];
  });
}

/**
 * Samples the board once: appends to the tape (unless another instance did so
 * within the last few minutes) and checks every account's alerts.
 */
export async function recordTape(svc: Services): Promise<{ recorded: boolean; fired: number; points: number }> {
  const now = svc.now();
  const board = await svc.prices.read();
  const readings = readingsFrom(board, now);
  const fired = await evaluateAll(svc.store, readings, now);

  const tape = await readTape(svc);
  const last = tape.at(-1);
  if (last && now - last.at < SAMPLE_EVERY_MS * 0.8) return { recorded: false, fired, points: tape.length };

  const gaps: Record<string, number> = {};
  for (const r of readings) if (r.gapBps !== null && r.kind !== "stale_reference") gaps[r.ticker] = r.gapBps;
  const next = [...tape.filter((p) => now - p.at <= KEEP_MS), { at: now, gaps }];
  await svc.store.set(TAPE_KEY, next);
  return { recorded: true, fired, points: next.length };
}

export interface Extreme {
  bps: number;
  at: number;
}

export interface OvernightRange {
  high: Extreme;
  low: Extreme;
  samples: number;
  /** Unix ms of the first sample in the window. */
  from: number;
}

/** High and low of a name's gap since `since` (the share's last print). */
export function overnightRange(tape: TapePoint[], ticker: string, since: number): OvernightRange | null {
  let high: Extreme | null = null;
  let low: Extreme | null = null;
  let samples = 0;
  let from = Infinity;
  for (const p of tape) {
    if (p.at < since) continue;
    const bps = p.gaps[ticker];
    if (bps === undefined) continue;
    samples += 1;
    from = Math.min(from, p.at);
    if (!high || bps > high.bps) high = { bps, at: p.at };
    if (!low || bps < low.bps) low = { bps, at: p.at };
  }
  return high && low ? { high, low, samples, from } : null;
}

/**
 * The sample board's night, so the offline demo has a tape too. Each name
 * overshoots its final move about a third of the way through the night and
 * eases back to where the sample board ends; Apple (down on the night) dips
 * and recovers. Deterministic, and only ever used with sample data.
 */
export function sampleTape(now: number): TapePoint[] {
  const start = lastRegularClose(new Date(now)).getTime();
  const points: TapePoint[] = [];
  const span = Math.max(1, now - start);
  for (let at = start + SAMPLE_EVERY_MS; at <= now; at += SAMPLE_EVERY_MS) {
    const t = (at - start) / span;
    // Rises to 1.45× the final move at t≈0.35, then settles to 1.0 at t=1.
    const shape = t < 0.35 ? (t / 0.35) * 1.45 : 1.45 - 0.45 * ((t - 0.35) / 0.65);
    const gaps: Record<string, number> = {};
    Object.entries(SAMPLE_BOARD).forEach(([ticker, { moveBps }], i) => {
      const wiggle = Math.sin(at / 2_700_000 + i) * 6;
      gaps[ticker] = Math.round((moveBps * shape + wiggle) * 10) / 10;
    });
    points.push({ at, gaps });
  }
  // The last point lands exactly on the board's final values.
  if (points.length) {
    points[points.length - 1].gaps = Object.fromEntries(Object.entries(SAMPLE_BOARD).map(([t, { moveBps }]) => [t, moveBps]));
  }
  return points.filter((p) => now - p.at <= KEEP_MS);
}

/** In sample mode, gives the store a tape to read from the start. */
export async function seedSampleTape(svc: Services): Promise<void> {
  if (!svc.sample) return;
  if ((await readTape(svc)).length > 0) return;
  await svc.store.set(TAPE_KEY, sampleTape(svc.now()));
}
