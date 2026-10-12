/**
 * What a gap between a token and its share means, in words someone can hear.
 *
 * The same 2% gap is two different facts depending on the clock. At 11:00 on a
 * Tuesday it is a live dislocation against a ticking share price — something a
 * trader could hedge. At 11:00 on a Sunday it is how far the token market has
 * moved since Friday's close, with no share price to check it against until
 * Monday — a bet on the open, not a hedge. Every reading is labelled with the
 * session it was taken in, and nothing here ever calls the second kind
 * arbitrage.
 */

import { getMarketSession, lastRegularClose, toEasternParts, type MarketSession } from "./session.js";
import type { PairQuote } from "./prices.js";
import type { Listing } from "./universe.js";

/**
 * Below this, a gap is rounding rather than a signal.
 *
 * Jupiter publishes no confidence interval, so this is an assumption, set
 * deliberately wide (about 1.5× an assumed ±6bps on each leg): a floor that is
 * too tight turns noise into something Alexa reads out as news.
 */
export const NOISE_FLOOR_BPS = 20;

/**
 * Token and share more than 1.5× apart (a 50% premium or a 33% discount) is
 * not a move, it's a broken price. Large caps don't gap like that between a
 * close and the next morning; when the live board showed "Super Micro up
 * 17722 percent", one leg was simply wrong.
 */
export const SUSPECT_RATIO = 1.5;

/**
 * Below this much on-chain liquidity, a token's price is the last stray swap,
 * not a market. CI's live audit found the outliers at $3 to $813 (Super Micro
 * at 178x its share); names people actually trade sit far above.
 */
export const MIN_LIQUIDITY_USD = Number(process.env.MIN_TOKEN_LIQUIDITY_USD ?? 10_000);

/** During the regular session, a share print older than this is a stalled feed. */
export const STALE_SHARE_MS = 5 * 60_000;

export type GapKind =
  /** Inside the noise floor. */
  | "in_line"
  /** Market shut: the token has moved since the share last traded. */
  | "overnight_move"
  /** Market open: token and live share disagree. */
  | "live_gap"
  /** Market open, but the share price has stopped updating. */
  | "stale_reference"
  /** No share price at all. */
  | "no_reference"
  /** Too little liquidity behind the token for its price to mean anything. */
  | "thin_market"
  /**
   * The two legs disagree by more than any real overnight move: one of them
   * is wrong (a thinly traded token's last swap, or a bad share print). Never
   * ranked, averaged, alerted on or read out as a move.
   */
  | "suspect_price";

export interface GapReading {
  ticker: string;
  token: string;
  spoken: string;
  tokenPrice: number;
  sharePrice: number | null;
  /** (token / share − 1) in basis points; null without a share price. */
  gapBps: number | null;
  kind: GapKind;
  /** "rich" when the token is above the share, "cheap" when below. */
  direction: "rich" | "cheap" | "flat";
  /** ISO time of the share print the gap is measured against. */
  referenceAt: string | null;
  /** "Friday's close", "yesterday's close", "the live price". */
  referenceLabel: string;
  /** While the market is shut: when the regular session last closed (unix ms). */
  closedAt?: number;
}

export function gapBps(tokenPrice: number, sharePrice: number | null): number | null {
  if (!sharePrice || !(tokenPrice > 0)) return null;
  return Math.round((tokenPrice / sharePrice - 1) * 10_000 * 10) / 10;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * How to name the share print being compared against: "Friday's close",
 * "yesterday's close", "today's close". Spoken from New York's calendar,
 * because that is the calendar the close happened on.
 */
export function closeLabel(referenceAt: number, now: number): string {
  const ref = toEasternParts(new Date(referenceAt));
  const today = toEasternParts(new Date(now));
  if (ref.date === today.date) return "today's close";
  const days = Math.round((Date.parse(today.date) - Date.parse(ref.date)) / 86_400_000);
  if (days === 1) return "yesterday's close";
  if (days > 1 && days < 7) return `${DAY_NAMES[ref.weekday]}'s close`;
  return "the last close";
}

export function readGap(
  listing: Listing,
  quote: PairQuote,
  now: number,
  session: MarketSession = getMarketSession(new Date(now)),
): GapReading {
  const bps = gapBps(quote.tokenPrice, quote.sharePrice);
  const base = {
    ticker: listing.ticker,
    token: listing.token,
    spoken: listing.spoken,
    tokenPrice: quote.tokenPrice,
    sharePrice: quote.sharePrice,
    gapBps: bps,
    referenceAt: quote.shareUpdatedAt ? new Date(quote.shareUpdatedAt).toISOString() : null,
  };
  const direction: GapReading["direction"] =
    bps === null || Math.abs(bps) < NOISE_FLOOR_BPS ? "flat" : bps > 0 ? "rich" : "cheap";

  if (quote.liquidityUsd != null && quote.liquidityUsd < MIN_LIQUIDITY_USD) {
    return { ...base, gapBps: null, kind: "thin_market", direction: "flat", referenceLabel: "a token hardly anyone is trading" };
  }
  if (bps === null) {
    return { ...base, kind: "no_reference", direction: "flat", referenceLabel: "no share price" };
  }
  const ratio = quote.tokenPrice / quote.sharePrice!;
  if (ratio > SUSPECT_RATIO || ratio < 1 / SUSPECT_RATIO) {
    return { ...base, gapBps: null, kind: "suspect_price", direction: "flat", referenceLabel: "a price that doesn't add up" };
  }

  if (session.isRegularHours) {
    const age = quote.shareUpdatedAt ? now - quote.shareUpdatedAt : Infinity;
    if (age > STALE_SHARE_MS) {
      return { ...base, kind: "stale_reference", direction, referenceLabel: "a stalled share price" };
    }
    return {
      ...base,
      kind: Math.abs(bps) < NOISE_FLOOR_BPS ? "in_line" : "live_gap",
      direction,
      referenceLabel: "the live share price",
    };
  }

  // While the market is shut, the share price *is* the last close, so the
  // close is named from the exchange calendar. The feed's own timestamp can't
  // be used: Jupiter's `updatedAt` is when it refreshed the price, which on a
  // Sunday reads as "today's close" (caught by the live CI run).
  const closedAt = lastRegularClose(new Date(now)).getTime();
  const label = closeLabel(closedAt, now);
  return {
    ...base,
    closedAt,
    kind: Math.abs(bps) < NOISE_FLOOR_BPS ? "in_line" : "overnight_move",
    direction,
    referenceLabel: label,
  };
}

/** Largest absolute moves first; readings without a gap last. */
export function rankByGap(readings: GapReading[]): GapReading[] {
  return [...readings].sort((a, b) => Math.abs(b.gapBps ?? -1) - Math.abs(a.gapBps ?? -1));
}
