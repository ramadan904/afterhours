/**
 * "Tell me if Tesla moves more than two percent overnight."
 *
 * Alerts are watched continuously, not just when someone asks. The tape
 * recorder (`tape.ts`) checks every account's alerts each time it samples the
 * board, and stamps the moment an alert first crossed its line. So a move that
 * spiked at 2 a.m. and faded by breakfast is still reported, with the time it
 * happened, at the top of the next briefing.
 *
 * An alert re-arms once the move falls back under half its threshold, so a
 * name hovering at the line doesn't fire over and over.
 */

import type { Store } from "../store/store.js";
import type { GapReading } from "./gap.js";

export interface Alert {
  ticker: string;
  /** Move alert: fires when |gap| reaches this, in basis points. 0 for price alerts. */
  thresholdBps: number;
  /** Price alert: fires when the token crosses this USD price. */
  price?: number;
  /** Price alert direction: true for "goes above", false for "falls below". */
  above?: boolean;
  createdAt: number;
  /** When it last crossed its line (unix ms); cleared when it re-arms. */
  firedAt?: number;
  /** The gap at the moment it fired. */
  firedGapBps?: number;
  /** The token price at the moment it fired. */
  firedPrice?: number;
  /**
   * Velocity alert: fires when the gap changes by thresholdBps within this
   * many minutes ("2 percent within an hour"), read from the overnight tape.
   */
  windowMin?: number;
}

export const isPriceAlert = (a: Alert) => typeof a.price === "number";
export const isVelocityAlert = (a: Alert) => typeof a.windowMin === "number";
const kindOf = (a: Alert) => (isPriceAlert(a) ? "price" : isVelocityAlert(a) ? "velocity" : "move");

/** Windows a velocity alert can use, in minutes. Requests are rounded to the nearest. */
export const VELOCITY_WINDOWS = [15, 30, 60, 120, 240];
export const nearestWindow = (min: number) => VELOCITY_WINDOWS.reduce((a, b) => (Math.abs(b - min) < Math.abs(a - min) ? b : a));

/** `${ticker}:${windowMin}` → the gap that many minutes ago, from the tape. */
export type PastGaps = Map<string, number>;

/** Price alerts re-arm once the token is this far back on the other side of the line. */
const PRICE_REARM = 0.01;

export const MAX_ALERTS = 10;
/** How long a fired alert keeps being mentioned in briefings. */
export const FIRED_ALERT_WINDOW_MS = 24 * 3600_000;

const key = (sub: string) => `alerts:${sub}`;
const INDEX = "alert-accounts";

export async function listAlerts(store: Store, sub: string): Promise<Alert[]> {
  return (await store.get<Alert[]>(key(sub))) ?? [];
}

async function index(store: Store): Promise<string[]> {
  return (await store.get<string[]>(INDEX)) ?? [];
}

/** Adds or replaces the alert of the same kind for a ticker. Returns the full list. */
export async function upsertAlert(store: Store, sub: string, alert: Alert): Promise<Alert[]> {
  const current = (await listAlerts(store, sub)).filter((a) => a.ticker !== alert.ticker || kindOf(a) !== kindOf(alert));
  if (current.length >= MAX_ALERTS) {
    throw new Error(`You can keep up to ${MAX_ALERTS} alerts. Remove one first.`);
  }
  const next = [...current, alert];
  await store.set(key(sub), next);
  const accounts = await index(store);
  if (!accounts.includes(sub)) await store.set(INDEX, [...accounts, sub]);
  return next;
}

/** Removes the alert for a ticker. True when one existed. */
export async function removeAlert(store: Store, sub: string, ticker: string): Promise<boolean> {
  const current = await listAlerts(store, sub);
  const next = current.filter((a) => a.ticker !== ticker);
  if (next.length === current.length) return false;
  await store.set(key(sub), next);
  if (next.length === 0) await store.set(INDEX, (await index(store)).filter((s) => s !== sub));
  return true;
}

/** Readings that count: a real gap against a usable reference. */
function usable(reading: GapReading | undefined): reading is GapReading & { gapBps: number } {
  return reading !== undefined && reading.gapBps !== null && reading.kind !== "stale_reference" && reading.kind !== "no_reference" && reading.kind !== "suspect_price";
}

/**
 * Updates fired/re-armed state for one account's alerts against a board.
 * Returns the alerts that fired on this check.
 */
export function evaluate(alerts: Alert[], readings: GapReading[], now: number, past: PastGaps = new Map()): { next: Alert[]; fired: Alert[] } {
  const fired: Alert[] = [];
  const next = alerts.map((alert) => {
    const reading = readings.find((r) => r.ticker === alert.ticker);
    if (isVelocityAlert(alert)) {
      const then = past.get(`${alert.ticker}:${alert.windowMin}`);
      if (!usable(reading) || then === undefined) return alert;
      const change = reading.gapBps - then;
      if (!alert.firedAt && Math.abs(change) >= alert.thresholdBps) {
        const updated = { ...alert, firedAt: now, firedGapBps: Math.round(change * 10) / 10, firedPrice: reading.tokenPrice };
        fired.push(updated);
        return updated;
      }
      if (alert.firedAt && Math.abs(change) < alert.thresholdBps / 2) {
        const { firedAt: _f, firedGapBps: _g, firedPrice: _p, ...rearmed } = alert;
        return rearmed;
      }
      return alert;
    }
    if (isPriceAlert(alert)) {
      if (!reading) return alert;
      const price = reading.tokenPrice;
      const line = alert.price!;
      const crossed = alert.above ? price >= line : price <= line;
      if (!alert.firedAt && crossed) {
        const updated = { ...alert, firedAt: now, firedPrice: price, firedGapBps: reading.gapBps ?? 0 };
        fired.push(updated);
        return updated;
      }
      const back = alert.above ? price < line * (1 - PRICE_REARM) : price > line * (1 + PRICE_REARM);
      if (alert.firedAt && back) {
        const { firedAt: _f, firedGapBps: _g, firedPrice: _p, ...rearmed } = alert;
        return rearmed;
      }
      return alert;
    }
    if (!usable(reading)) return alert;
    const size = Math.abs(reading.gapBps);
    if (!alert.firedAt && size >= alert.thresholdBps) {
      const updated = { ...alert, firedAt: now, firedGapBps: reading.gapBps };
      fired.push(updated);
      return updated;
    }
    if (alert.firedAt && size < alert.thresholdBps / 2) {
      const { firedAt: _f, firedGapBps: _g, ...rearmed } = alert;
      return rearmed;
    }
    return alert;
  });
  return { next, fired };
}

/** Checks every account's alerts. Returns each alert that fired, with its account. */
export async function evaluateAll(store: Store, readings: GapReading[], now: number, past: PastGaps = new Map()): Promise<{ sub: string; alert: Alert }[]> {
  const out: { sub: string; alert: Alert }[] = [];
  for (const sub of await index(store)) {
    const alerts = await listAlerts(store, sub);
    const { next, fired } = evaluate(alerts, readings, now, past);
    if (JSON.stringify(next) !== JSON.stringify(alerts)) await store.set(key(sub), next);
    for (const alert of fired) out.push({ sub, alert });
  }
  return out;
}

export interface AlertNews {
  alert: Alert;
  reading: GapReading;
  /** When it crossed, if the tape saw it happen; null when only seen now. */
  firedAt: number | null;
  firedGapBps: number;
  /** Token price when it crossed (price alerts), else the current price. */
  firedPrice: number;
}

/**
 * What to say about alerts in a briefing: those that fired in the last day
 * (with when), plus any over their line right now that the tape hasn't
 * stamped yet (no recorder running, or it crossed since the last sample).
 */
export function alertNews(alerts: Alert[], readings: GapReading[], now: number): AlertNews[] {
  const out: AlertNews[] = [];
  for (const alert of alerts) {
    const reading = readings.find((r) => r.ticker === alert.ticker);
    if (!reading) continue;
    const recent = alert.firedAt && now - alert.firedAt <= FIRED_ALERT_WINDOW_MS;
    if (isPriceAlert(alert)) {
      const over = alert.above ? reading.tokenPrice >= alert.price! : reading.tokenPrice <= alert.price!;
      if (recent) out.push({ alert, reading, firedAt: alert.firedAt!, firedGapBps: alert.firedGapBps ?? 0, firedPrice: alert.firedPrice ?? reading.tokenPrice });
      else if (over) out.push({ alert, reading, firedAt: null, firedGapBps: reading.gapBps ?? 0, firedPrice: reading.tokenPrice });
      continue;
    }
    if (!usable(reading)) continue;
    if (isVelocityAlert(alert)) {
      if (recent) out.push({ alert, reading, firedAt: alert.firedAt!, firedGapBps: alert.firedGapBps ?? 0, firedPrice: alert.firedPrice ?? reading.tokenPrice });
      continue;
    }
    if (recent) {
      out.push({ alert, reading, firedAt: alert.firedAt!, firedGapBps: alert.firedGapBps ?? reading.gapBps, firedPrice: reading.tokenPrice });
    } else if (Math.abs(reading.gapBps) >= alert.thresholdBps) {
      out.push({ alert, reading, firedAt: null, firedGapBps: reading.gapBps, firedPrice: reading.tokenPrice });
    }
  }
  return out;
}
