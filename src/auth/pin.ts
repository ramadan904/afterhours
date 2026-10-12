/**
 * A spoken trade PIN, like Alexa's voice purchasing code.
 *
 * A wallet signature already stands between a proposal and any money moving.
 * The PIN guards the step before: a television, a guest or a child saying
 * "buy 500 dollars of Tesla" to a speaker in the kitchen. With a PIN set, no
 * proposal is prepared (and nothing is pushed to the phone) unless it's said.
 *
 * Stored as a salted scrypt hash, compared in constant time. Five wrong tries
 * lock voice trading for an hour. Changing or removing the PIN needs the
 * current one.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.js";

export const MAX_TRIES = 5;
export const LOCK_MS = 3600_000;

interface PinRecord {
  salt: string;
  hash: string;
  failures: number;
  lockedUntil?: number;
}

const key = (sub: string) => `pin:${sub}`;

const digest = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, "base64"), 32).toString("base64");

/** "4 3 2 1", "4-3-2-1", "four three two one" → "4321". */
export function normalisePin(said: string): string {
  const words: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  return said
    .toLowerCase()
    .split(/[\s,.-]+/)
    .map((w) => words[w] ?? w)
    .join("")
    .replace(/\D/g, "");
}

export const validPin = (pin: string) => /^\d{4,6}$/.test(pin);

export async function hasPin(store: Store, sub: string): Promise<boolean> {
  return Boolean(await store.get<PinRecord>(key(sub)));
}

export async function setPin(store: Store, sub: string, pin: string): Promise<void> {
  const salt = randomBytes(16).toString("base64");
  await store.set(key(sub), { salt, hash: digest(pin, salt), failures: 0 } satisfies PinRecord);
}

export async function removePin(store: Store, sub: string): Promise<void> {
  await store.del(key(sub));
}

export type PinCheck = { ok: true } | { ok: false; reason: "missing" | "wrong" | "locked"; triesLeft?: number; lockedUntil?: number };

/** Checks a spoken PIN. Accounts without one always pass. */
export async function checkPin(store: Store, sub: string, said: string | undefined, now: number): Promise<PinCheck> {
  const rec = await store.get<PinRecord>(key(sub));
  if (!rec) return { ok: true };
  if (rec.lockedUntil && rec.lockedUntil > now) return { ok: false, reason: "locked", lockedUntil: rec.lockedUntil };
  if (said === undefined || said.trim() === "") return { ok: false, reason: "missing" };
  const given = Buffer.from(digest(normalisePin(said), rec.salt), "base64");
  const want = Buffer.from(rec.hash, "base64");
  if (given.length === want.length && timingSafeEqual(given, want)) {
    if (rec.failures) await store.set(key(sub), { ...rec, failures: 0, lockedUntil: undefined });
    return { ok: true };
  }
  const failures = (rec.lockedUntil && rec.lockedUntil <= now ? 0 : rec.failures) + 1;
  const locked = failures >= MAX_TRIES ? now + LOCK_MS : undefined;
  await store.set(key(sub), { ...rec, failures: locked ? 0 : failures, lockedUntil: locked });
  return locked ? { ok: false, reason: "locked", lockedUntil: locked } : { ok: false, reason: "wrong", triesLeft: MAX_TRIES - failures };
}
