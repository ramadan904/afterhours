/**
 * "Tell me if Tesla moves more than two percent overnight."
 *
 * Alerts are stored per linked account and checked whenever the account asks
 * for a briefing, so the answer to "anything I should know?" leads with the
 * names the person said they cared about.
 */

import type { Store } from "../store/store.js";
import type { GapReading } from "./gap.js";

export interface Alert {
  ticker: string;
  /** Fires when |gap| reaches this, in basis points. */
  thresholdBps: number;
  createdAt: number;
}

export const MAX_ALERTS = 10;

const key = (sub: string) => `alerts:${sub}`;

export async function listAlerts(store: Store, sub: string): Promise<Alert[]> {
  return (await store.get<Alert[]>(key(sub))) ?? [];
}

/** Adds or replaces the alert for a ticker. Returns the full list. */
export async function upsertAlert(store: Store, sub: string, alert: Alert): Promise<Alert[]> {
  const current = (await listAlerts(store, sub)).filter((a) => a.ticker !== alert.ticker);
  if (current.length >= MAX_ALERTS) {
    throw new Error(`You can keep up to ${MAX_ALERTS} alerts. Remove one first.`);
  }
  const next = [...current, alert];
  await store.set(key(sub), next);
  return next;
}

/** Removes the alert for a ticker. True when one existed. */
export async function removeAlert(store: Store, sub: string, ticker: string): Promise<boolean> {
  const current = await listAlerts(store, sub);
  const next = current.filter((a) => a.ticker !== ticker);
  if (next.length === current.length) return false;
  await store.set(key(sub), next);
  return true;
}

export function triggered(alerts: Alert[], readings: GapReading[]): { alert: Alert; reading: GapReading }[] {
  const out: { alert: Alert; reading: GapReading }[] = [];
  for (const alert of alerts) {
    const reading = readings.find((r) => r.ticker === alert.ticker);
    if (reading?.gapBps === null || reading?.gapBps === undefined) continue;
    if (reading.kind === "stale_reference" || reading.kind === "no_reference") continue;
    if (Math.abs(reading.gapBps) >= alert.thresholdBps) out.push({ alert, reading });
  }
  return out;
}
