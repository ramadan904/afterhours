/**
 * What happened on this account, and when: an append-only log.
 *
 * Every change made through Afterhours lands here: a limit raised (and when
 * it takes effect), a PIN set or a wrong PIN tried, a trade proposed, signed
 * or confirmed, a recurring buy prepared or skipped, a wallet alert sent.
 * "What did I change on my account?" reads it back, so a person can audit
 * what their voice assistant did, including what someone else in the room
 * asked it to do.
 *
 * Entries keep what Afterhours said, never the arguments it was given, so a
 * spoken PIN can't end up in the log.
 */

import type { Store } from "../store/store.js";

export interface Activity {
  at: number;
  /** A tool name, or a background event such as `trade.confirmed`. */
  kind: string;
  text: string;
  ok: boolean;
}

const key = (sub: string) => `activity:${sub}`;
const KEEP = 200;
const TTL_S = 90 * 86_400;

export async function logActivity(store: Store, sub: string, entry: Activity): Promise<void> {
  const list = (await store.get<Activity[]>(key(sub))) ?? [];
  const text = entry.text.length > 240 ? `${entry.text.slice(0, 237)}…` : entry.text;
  await store.set(key(sub), [...list, { ...entry, text }].slice(-KEEP), TTL_S);
}

export async function readActivity(store: Store, sub: string): Promise<Activity[]> {
  return (await store.get<Activity[]>(key(sub))) ?? [];
}

/** The first sentence of what was said, for a short line in the log; two when the first is just "Done." or "OK." */
export function firstSentence(text: string): string {
  // Split only where punctuation meets a space, so "$330.05" stays whole.
  const sentences = text.replace(/^Using sample data\. /, "").split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return "";
  return (sentences[0].length < 12 && sentences[1] ? `${sentences[0]} ${sentences[1]}` : sentences[0]).trim();
}
