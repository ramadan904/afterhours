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
  /** Fires when |gap| reaches this, in basis points. */
  thresholdBps: number;
  createdAt: number;
  /** When it last crossed its line (unix ms); cleared when it re-arms. */
  firedAt?: number;
  /** The gap at the moment it fired. */
  firedGapBps?: number;
}

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

/** Adds or replaces the alert for a ticker. Returns the full list. */
export async function upsertAlert(store: Store, sub: string, alert: Alert): Promise<Alert[]> {
  const current = (await listAlerts(store, sub)).filter((a) => a.ticker !== alert.ticker);
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
  return reading !== undefined && reading.gapBps !== null && reading.kind !== "stale_reference" && reading.kind !== "no_reference";
}

/**
 * Updates fired/re-armed state for one account's alerts against a board.
 * Returns the alerts that fired on this check.
 */
export function evaluate(alerts: Alert[], readings: GapReading[], now: number): { next: Alert[]; fired: Alert[] } {
  const fired: Alert[] = [];
  const next = alerts.map((alert) => {
    const reading = readings.find((r) => r.ticker === alert.ticker);
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

/** Checks every account's alerts. Returns how many fired. */
export async function evaluateAll(store: Store, readings: GapReading[], now: number): Promise<number> {
  let count = 0;
  for (const sub of await index(store)) {
    const alerts = await listAlerts(store, sub);
    const { next, fired } = evaluate(alerts, readings, now);
    if (JSON.stringify(next) !== JSON.stringify(alerts)) await store.set(key(sub), next);
    count += fired.length;
  }
  return count;
}

export interface AlertNews {
  alert: Alert;
  reading: GapReading;
  /** When it crossed, if the tape saw it happen; null when only seen now. */
  firedAt: number | null;
  firedGapBps: number;
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
    if (!usable(reading)) continue;
    if (alert.firedAt && now - alert.firedAt <= FIRED_ALERT_WINDOW_MS) {
      out.push({ alert, reading, firedAt: alert.firedAt, firedGapBps: alert.firedGapBps ?? reading.gapBps });
    } else if (Math.abs(reading.gapBps) >= alert.thresholdBps) {
      out.push({ alert, reading, firedAt: null, firedGapBps: reading.gapBps });
    }
  }
  return out;
}
