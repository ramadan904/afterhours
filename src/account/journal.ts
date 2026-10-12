/**
 * A trading journal kept by voice, and a mirror for the 2 a.m. investor.
 *
 * "Buy 25 dollars of Nvidia because earnings are next week": the reason is
 * kept with the trade. Later, "why did I buy Nvidia?" reads it back, with the
 * hour it was asked and how it has done since. Across the whole journal, the
 * trades asked for late at night are compared with the daytime ones, because
 * that is the question this product exists for: are the 2 a.m. decisions any
 * good?
 *
 * Only trades that were signed and confirmed on Solana count. A proposal
 * nobody signed is not a decision. The hour is the asker's local hour when
 * the trade was *asked for*, which is when the impulse happened, even if
 * sleep mode held it until morning.
 */

import type { Store } from "../store/store.js";
import type { TradeIntent } from "../chain/trade.js";
import { zoneParts, type Zone } from "../market/zones.js";

export interface JournalEntry {
  /** The trade intent's id. */
  id: string;
  ticker: string;
  side: "buy" | "sell";
  usd: number;
  /** Token price when asked. */
  price: number;
  askedAt: number;
  /** Local hour (0–23) when asked. */
  hour: number;
  why: string | null;
  confirmedAt?: number;
}

const key = (sub: string) => `journal:${sub}`;
const MAX = 200;

/** 11 p.m. to 5 a.m., local. */
export const isLateNight = (hour: number) => hour >= 23 || hour < 5;

/** Cleans up a spoken reason: no "because", no trailing punctuation, a sane length. */
export function cleanReason(why: string | undefined): string | null {
  const t = (why ?? "")
    .trim()
    .replace(/^(because|cause|since|as)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .slice(0, 200)
    .trim();
  return t.length >= 2 ? t : null;
}

export async function recordProposal(store: Store, intent: TradeIntent, why: string | null, zone: Zone): Promise<void> {
  const list = (await store.get<JournalEntry[]>(key(intent.sub))) ?? [];
  if (list.some((e) => e.id === intent.id)) return;
  const entry: JournalEntry = {
    id: intent.id,
    ticker: intent.ticker,
    side: intent.side,
    usd: intent.usd,
    price: intent.priceAtProposal,
    askedAt: intent.createdAt,
    hour: Math.floor(zoneParts(new Date(intent.createdAt), zone.tz).minutes / 60),
    why,
  };
  // Unconfirmed proposals are pruned first when the journal is full.
  const next = [...list, entry];
  while (next.length > MAX) {
    const i = next.findIndex((e) => !e.confirmedAt);
    next.splice(i >= 0 ? i : 0, 1);
  }
  await store.set(key(intent.sub), next);
}

export async function markConfirmed(store: Store, sub: string, id: string, at: number): Promise<void> {
  const list = (await store.get<JournalEntry[]>(key(sub))) ?? [];
  const e = list.find((x) => x.id === id);
  if (!e || e.confirmedAt) return;
  e.confirmedAt = at;
  await store.set(key(sub), list);
}

/** Confirmed trades, newest first. */
export async function readJournal(store: Store, sub: string): Promise<JournalEntry[]> {
  return ((await store.get<JournalEntry[]>(key(sub))) ?? []).filter((e) => e.confirmedAt).sort((a, b) => b.askedAt - a.askedAt);
}

/** How a trade has done since: for a buy, the move since; for a sale, what holding on would have made. */
export function changeSince(e: JournalEntry, priceNow: number | undefined): number | null {
  if (!priceNow || !(e.price > 0)) return null;
  return (priceNow / e.price - 1) * 100;
}

export interface Mirror {
  trades: number;
  /** Average change since, in percent, across buys with a price now. */
  avgChangePercent: number | null;
}

/** Late-night buys against daytime buys. */
export function mirror(entries: JournalEntry[], prices: Map<string, number>): { lateNight: Mirror; daytime: Mirror } {
  const group = (late: boolean): Mirror => {
    const buys = entries.filter((e) => e.side === "buy" && isLateNight(e.hour) === late);
    const changes = buys.map((e) => changeSince(e, prices.get(e.ticker))).filter((c): c is number => c !== null);
    return { trades: buys.length, avgChangePercent: changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null };
  };
  return { lateNight: group(true), daytime: group(false) };
}
