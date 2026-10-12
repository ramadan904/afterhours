/**
 * The names someone follows without owning, or setting an alert on.
 *
 * With 68 names on the board, "biggest moves" is the market's story, not
 * yours. A watchlist lets the briefing lead with the names you asked about
 * ("On your watchlist: Netflix up 0.6 percent, Palantir up 0.8 percent")
 * before it gets to whatever the market did.
 */

import type { Store } from "../store/store.js";

export const MAX_WATCHED = 20;
const key = (sub: string) => `watch:${sub}`;

export async function getWatchlist(store: Store, sub: string): Promise<string[]> {
  return (await store.get<string[]>(key(sub))) ?? [];
}

/** Adds and removes tickers; returns what changed and the list after. */
export async function editWatchlist(
  store: Store,
  sub: string,
  change: { add?: string[]; remove?: string[] },
): Promise<{ added: string[]; removed: string[]; full: string[]; list: string[] }> {
  const current = await getWatchlist(store, sub);
  const remove = new Set(change.remove ?? []);
  const kept = current.filter((t) => !remove.has(t));
  const removed = current.filter((t) => remove.has(t));
  const added: string[] = [];
  const full: string[] = [];
  for (const t of change.add ?? []) {
    if (kept.includes(t)) continue;
    if (kept.length >= MAX_WATCHED) {
      full.push(t);
      continue;
    }
    kept.push(t);
    added.push(t);
  }
  if (added.length || removed.length) await store.set(key(sub), kept);
  return { added, removed, full, list: kept };
}
