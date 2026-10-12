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
import { notify } from "../notify/push.js";
import { alertNotice, settledTradeNotice, triggeredTradeNotice } from "../notify/notices.js";
import { settlePending } from "../chain/settle.js";
import { logActivity } from "../account/activity.js";
import { count } from "../obs/metrics.js";
import { sendDueBriefings } from "../notify/briefing.js";
import { runDuePlans } from "../chain/recurring.js";
import { checkWallets } from "../notify/wallet-watch.js";
import { trackOpen } from "../notify/open-verdict.js";
import { logFired, sendWeeklyRecaps, snapshotDay } from "../notify/weekly.js";
import { triggerArmed } from "../chain/trade.js";
import { getZone } from "./zones.js";
import { refreshOpenHistoryIfStale } from "./history.js";

export interface TapePoint {
  /** Unix ms. */
  at: number;
  /** Gap per ticker in basis points (one decimal). */
  gaps: Record<string, number>;
}

export const SAMPLE_EVERY_MS = 5 * 60_000;
export const KEEP_MS = 48 * 3600_000;

/**
 * The tape is stored in 6-hour buckets, each a small table: the tickers once,
 * then one row per sample (`[at, gap for tickers[0], …]`). 48 hours of 68
 * names as one JSON value would be ~550KB, past DynamoDB's 400KB item limit
 * and slow to rewrite every 5 minutes; a bucket is ~30KB, and a sample
 * rewrites only the current one. Buckets expire on their own.
 */
const BUCKET_MS = 6 * 3600_000;
const BUCKET_TTL_S = (KEEP_MS + 2 * BUCKET_MS) / 1000;
export const tapeBucketKey = (start: number) => `tape:v2:${start}`;
const bucketOf = (at: number) => Math.floor(at / BUCKET_MS) * BUCKET_MS;

interface Bucket {
  tickers: string[];
  rows: (number | null)[][];
}

function encode(points: TapePoint[]): Bucket {
  const tickers = [...new Set(points.flatMap((p) => Object.keys(p.gaps)))];
  return { tickers, rows: points.map((p) => [p.at, ...tickers.map((t) => p.gaps[t] ?? null)]) };
}

function decode(bucket: Bucket): TapePoint[] {
  return bucket.rows.map(([at, ...values]) => {
    const gaps: Record<string, number> = {};
    values.forEach((v, i) => {
      if (typeof v === "number") gaps[bucket.tickers[i]] = v;
    });
    return { at: at as number, gaps };
  });
}

/** Samples from `since` (default: the whole 48 hours kept) to now, oldest first. */
export async function readTape(svc: Services, since = svc.now() - KEEP_MS): Promise<TapePoint[]> {
  const now = svc.now();
  const starts: number[] = [];
  for (let s = bucketOf(Math.max(since, now - KEEP_MS)); s <= now; s += BUCKET_MS) starts.push(s);
  const buckets = await Promise.all(starts.map((s) => svc.store.get<Bucket>(tapeBucketKey(s))));
  return buckets.flatMap((b) => (b ? decode(b) : [])).filter((p) => p.at >= since && now - p.at <= KEEP_MS);
}

/** Writes points into their buckets, merging with what each bucket holds. */
export async function writeTape(store: Services["store"], points: TapePoint[]): Promise<void> {
  const byBucket = new Map<number, TapePoint[]>();
  for (const p of points) byBucket.set(bucketOf(p.at), [...(byBucket.get(bucketOf(p.at)) ?? []), p]);
  await Promise.all(
    [...byBucket].map(async ([start, added]) => {
      const held = await store.get<Bucket>(tapeBucketKey(start));
      const merged = new Map((held ? decode(held) : []).map((p) => [p.at, p]));
      for (const p of added) merged.set(p.at, p);
      const sorted = [...merged.values()].sort((a, b) => a.at - b.at);
      await store.set(tapeBucketKey(start), encode(sorted), BUCKET_TTL_S);
    }),
  );
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
export async function recordTape(svc: Services): Promise<{ recorded: boolean; fired: number; triggered: number; points: number }> {
  const now = svc.now();
  const board = await svc.prices.read();
  const readings = readingsFrom(board, now);
  const firedAlerts = await evaluateAll(svc.store, readings, now);
  const fired = firedAlerts.length;
  count("TapeSamples");
  if (fired) count("AlertsFired", fired);
  // Tell people now, not at their next briefing. Push failures never stop the tape.
  const send = async (sub: string, make: (zone: Awaited<ReturnType<typeof getZone>>) => Parameters<typeof notify>[2]) =>
    notify(svc, sub, make(await getZone(svc.store, sub))).catch(() => 0);
  await Promise.all(firedAlerts.map(({ sub, alert }) => send(sub, (zone) => alertNotice(alert, svc.baseUrl, zone))));
  for (const { sub, alert } of firedAlerts) await logFired(svc, sub, alert.ticker).catch(() => undefined);

  // Conditional trades whose price was crossed become signable now.
  const prices = new Map(readings.map((r) => [r.ticker, r.tokenPrice]));
  const triggered = await triggerArmed(svc.store, prices, now);
  await Promise.all(triggered.map((t) => send(t.sub, (zone) => triggeredTradeNotice(t, svc.baseUrl, zone))));
  for (const t of triggered) {
    await logActivity(svc.store, t.sub, { at: now, kind: "trade.ready", text: `${triggeredTradeNotice(t, svc.baseUrl).title}: ready to sign with code ${t.code}.`, ok: true }).catch(() => undefined);
  }

  // Trades signed from a blink or a phone's QR scan land without telling us; find them.
  const settled = await settlePending(svc).catch(() => []);
  await Promise.all(settled.map((t) => send(t.sub, () => settledTradeNotice(t, svc.baseUrl))));

  // Briefings people asked to have sent at a time of day.
  await sendDueBriefings(svc).catch(() => 0);
  // Recurring buys whose time has come become proposals on the phone.
  await runDuePlans(svc, prices).catch(() => []);
  // Positions that left (or arrived in) a wallet without a trade we prepared.
  await checkWallets(svc, prices).catch(() => 0);
  // Just before 9:30 keep the overnight call; a few minutes after, score it.
  await trackOpen(svc, board, readings).catch(() => 0);
  // A daily price snapshot for week-over-week, and Sunday-evening recaps.
  await snapshotDay(svc, readings).catch(() => undefined);
  await sendWeeklyRecaps(svc, prices).catch(() => 0);

  // Once a day, rebuild the open track record from public history (background).
  void refreshOpenHistoryIfStale(svc).catch(() => false);

  const recent = await readTape(svc, now - SAMPLE_EVERY_MS);
  const last = recent.at(-1);
  if (last && now - last.at < SAMPLE_EVERY_MS * 0.8) return { recorded: false, fired, triggered: triggered.length, points: recent.length };

  const gaps: Record<string, number> = {};
  for (const r of readings) if (r.gapBps !== null && r.kind !== "stale_reference") gaps[r.ticker] = r.gapBps;
  await writeTape(svc.store, [{ at: now, gaps }]);
  return { recorded: true, fired, triggered: triggered.length, points: recent.length + 1 };
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
  await writeTape(svc.store, sampleTape(svc.now()));
}
