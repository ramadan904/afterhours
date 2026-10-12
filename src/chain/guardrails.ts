/**
 * Guardrails a person sets for themselves, for the hours this product exists
 * for: late at night, on a weekend, with a voice assistant that never says
 * "are you sure?" on its own.
 *
 * - A daily spending limit on buys. Tightening it (or setting one) applies at
 *   once. Loosening it (raising or removing it) takes 24 hours, the way
 *   self-exclusion tools work: the person who set a limit while calm gets to
 *   overrule the one asking at 2 a.m.
 * - Sleep mode: a trade asked for during the night (default 11 p.m. to
 *   7 a.m., local time) isn't prepared until the morning. It's set aside, then
 *   becomes signable at wake-up and is pushed to the phone. Cancelling is
 *   always instant.
 *
 * None of this is custody. Trades still need the wallet's signature; these
 * rules only decide whether and when Afterhours prepares one.
 */

import type { Store } from "../store/store.js";
import { getIntent } from "./trade.js";
import { zoneParts, type Zone } from "../market/zones.js";

export const COOLING_OFF_MS = 24 * 3600_000;
export const DEFAULT_SLEEP = { from: 23 * 60, to: 7 * 60 };

export interface Guardrails {
  /** Max USD of buys per local calendar day; null for none. */
  dailyLimitUsd: number | null;
  /** A loosening that waits out the cooling-off period. */
  pending?: { dailyLimitUsd: number | null; effectiveAt: number };
  /** Local minutes after midnight; null when sleep mode is off. */
  sleep: { from: number; to: number } | null;
  /** Turning sleep mode off, or changing its hours, waits out the cooling-off period too. */
  pendingSleep?: { sleep: { from: number; to: number } | null; effectiveAt: number };
}

const key = (sub: string) => `guardrails:${sub}`;
const ledger = (sub: string, date: string) => `spend:${sub}:${date}`;

/** Current rules, with pending changes applied once their time has come. */
export async function getGuardrails(store: Store, sub: string, now: number): Promise<Guardrails> {
  const g = (await store.get<Guardrails>(key(sub))) ?? { dailyLimitUsd: null, sleep: null };
  let changed = false;
  if (g.pending && g.pending.effectiveAt <= now) {
    g.dailyLimitUsd = g.pending.dailyLimitUsd;
    delete g.pending;
    changed = true;
  }
  if (g.pendingSleep && g.pendingSleep.effectiveAt <= now) {
    g.sleep = g.pendingSleep.sleep;
    delete g.pendingSleep;
    changed = true;
  }
  if (changed) await store.set(key(sub), g);
  return g;
}

/**
 * Sets or removes the daily limit. Returns when it takes effect: now for a
 * tighter limit, after the cooling-off period for a looser one.
 */
export async function setDailyLimit(
  store: Store,
  sub: string,
  limit: number | null,
  now: number,
): Promise<{ effective: "now" | "later"; effectiveAt: number; guardrails: Guardrails }> {
  const g = await getGuardrails(store, sub, now);
  const current = g.dailyLimitUsd;
  const tighter = limit !== null && (current === null || limit <= current);
  const { pending: _p, ...rest } = g;
  const next: Guardrails = tighter
    ? { ...rest, dailyLimitUsd: limit }
    : current === null
      ? { ...rest, dailyLimitUsd: null } // removing a limit that doesn't exist
      : { ...rest, dailyLimitUsd: current, pending: { dailyLimitUsd: limit, effectiveAt: now + COOLING_OFF_MS } };
  await store.set(key(sub), next);
  return { effective: next.pending ? "later" : "now", effectiveAt: next.pending?.effectiveAt ?? now, guardrails: next };
}

/**
 * Sets, changes or turns off sleep mode. Turning it on applies at once;
 * turning it off or changing its hours waits out the cooling-off period, so
 * the 2 a.m. self can't switch off what the daytime self switched on.
 */
export async function setSleep(
  store: Store,
  sub: string,
  sleep: { from: number; to: number } | null,
  now: number,
): Promise<{ effective: "now" | "later"; effectiveAt: number; guardrails: Guardrails }> {
  const g = await getGuardrails(store, sub, now);
  const { pendingSleep: _p, ...rest } = g;
  const same = JSON.stringify(g.sleep) === JSON.stringify(sleep);
  const next: Guardrails = !g.sleep || same ? { ...rest, sleep } : { ...rest, pendingSleep: { sleep, effectiveAt: now + COOLING_OFF_MS } };
  await store.set(key(sub), next);
  return { effective: next.pendingSleep ? "later" : "now", effectiveAt: next.pendingSleep?.effectiveAt ?? now, guardrails: next };
}

/**
 * Starts removing every guardrail through the usual cooling-off period (used
 * when an account deletes its data): the protections stay for a day, then go.
 * Returns true when there was anything to remove.
 */
export async function retireGuardrails(store: Store, sub: string, now: number): Promise<boolean> {
  const g = await getGuardrails(store, sub, now);
  if (g.dailyLimitUsd === null && !g.sleep) {
    await store.del(key(sub));
    return false;
  }
  const at = now + COOLING_OFF_MS;
  await store.set(
    key(sub),
    { ...g, pending: g.dailyLimitUsd === null ? undefined : { dailyLimitUsd: null, effectiveAt: at }, pendingSleep: g.sleep ? { sleep: null, effectiveAt: at } : undefined },
    Math.ceil((COOLING_OFF_MS + 86_400_000) / 1000),
  );
  return true;
}

/** Whether local minutes-after-midnight fall in a window that may wrap midnight. */
export function inWindow(minutes: number, w: { from: number; to: number }): boolean {
  return w.from <= w.to ? minutes >= w.from && minutes < w.to : minutes >= w.from || minutes < w.to;
}

/** The next moment the local clock reads `to` (minutes after midnight). */
export function nextLocal(now: number, zone: Zone, to: number): number {
  const { minutes } = zoneParts(new Date(now), zone.tz);
  const ahead = (to - minutes + 1440) % 1440 || 1440;
  return Math.floor(now / 60_000) * 60_000 + ahead * 60_000;
}

/** USD of buys proposed today (local date) that are still live or went through. */
export async function spentToday(store: Store, sub: string, zone: Zone, now: number): Promise<number> {
  const { date } = zoneParts(new Date(now), zone.tz);
  const entries = (await store.get<{ id: string; usd: number }[]>(ledger(sub, date))) ?? [];
  const intents = await Promise.all(entries.map((e) => getIntent(store, e.id, now)));
  return entries.reduce((sum, e, i) => {
    const status = intents[i]?.status;
    return status === "cancelled" || status === "expired" || status === "failed" ? sum : sum + e.usd;
  }, 0);
}

export async function recordSpend(store: Store, sub: string, zone: Zone, now: number, id: string, usd: number): Promise<void> {
  const { date } = zoneParts(new Date(now), zone.tz);
  const entries = (await store.get<{ id: string; usd: number }[]>(ledger(sub, date))) ?? [];
  await store.set(ledger(sub, date), [...entries, { id, usd }], 2 * 86_400);
}
