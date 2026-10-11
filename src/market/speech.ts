/**
 * Sentences for the ear.
 *
 * Alexa+ reads tool results to a person who cannot scroll back. So every
 * sentence here leads with the answer, rounds to what a listener can hold
 * (one decimal of a percent, cents only below a thousand dollars), and says
 * "percent" rather than "bps". The structured result carries exact numbers for
 * anything that wants them.
 */

import type { GapReading } from "./gap.js";
import { minutesToNextOpen, type MarketSession } from "./session.js";
import { EASTERN, zoneName, zoneParts, type Zone } from "./zones.js";

export function pct(bps: number): string {
  const p = Math.abs(bps) / 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)} percent`;
}

export function usd(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "minus " : "";
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  if (Number.isInteger(abs)) return `${sign}$${abs}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** "Tesla's" / "the S&P 500 fund's" — spoken possessive, sentence-cased. */
export function possessive(spoken: string): string {
  return `${spoken}'s`;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "today", "yesterday", "tomorrow" or a weekday, for an instant, in the listener's zone. */
function dayWord(at: number, now: number, zone: Zone): string {
  const day = zoneParts(new Date(at), zone.tz);
  const today = zoneParts(new Date(now), zone.tz);
  if (day.date === today.date) return "today";
  const days = Math.round((Date.parse(day.date) - Date.parse(today.date)) / 86_400_000);
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return WEEKDAY[day.weekday];
}

/** "Monday at 9:30 a.m. Eastern", "tomorrow at 2:30 p.m. Lagos time"; null when not knowable. */
export function nextOpenPhrase(now: Date, zone: Zone = EASTERN): string | null {
  const minutes = minutesToNextOpen(now);
  if (minutes === null) return null;
  const open = now.getTime() + minutes * 60_000;
  return `${dayWord(open, now.getTime(), zone)} at ${clockTime(open, zone)} ${zoneName(zone)}`;
}

/** "45 minutes", "1 hour and 10 minutes", "2 hours". */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return m === 0 ? hours : `${hours} and ${m} minute${m === 1 ? "" : "s"}`;
}

export function sessionSentence(session: MarketSession, now: Date, zone: Zone = EASTERN): string {
  const next = nextOpenPhrase(now, zone);
  // Within three hours of the bell, a countdown is what people want to hear.
  const toOpen = minutesToNextOpen(now);
  const opens = toOpen !== null && toOpen <= 180 ? ` It opens in ${duration(toOpen)}.` : next ? ` It opens ${next}.` : "";
  switch (session.phase) {
    case "regular":
      return "The US stock market is open.";
    case "premarket":
      return `The US market is in pre-market trading.${opens}`;
    case "afterhours":
      return `The US market has closed for the day; after-hours trading is thin.${opens}`;
    case "weekend":
      return `The US stock market is closed for the weekend.${opens}`;
    case "holiday":
      return `The US stock market is closed for ${session.label ?? "a holiday"}.${opens}`;
    default:
      return `The US stock market is closed.${opens}`;
  }
}

/** One sentence: where the token is and how far it is from its share. */
export function gapSentence(r: GapReading): string {
  const who = `${capitalise(possessive(r.spoken))} token`;
  const at = `at ${usd(r.tokenPrice)}`;
  switch (r.kind) {
    case "overnight_move":
      return `${who} is ${r.gapBps! > 0 ? "up" : "down"} ${pct(r.gapBps!)} since ${r.referenceLabel}, ${at}.`;
    case "live_gap":
      return `${who} is trading ${pct(r.gapBps!)} ${r.gapBps! > 0 ? "above" : "below"} the live share price, ${at}.`;
    case "in_line":
      return `${who} is in line with ${r.referenceLabel}, ${at}.`;
    case "stale_reference":
      return `${who} is ${at}, but the share price has stopped updating, so I can't give you a reliable gap right now.`;
    case "no_reference":
      return `${who} is ${at}. I don't have a share price to compare it with.`;
  }
}

/** What the gap is, as a decision: a hedge, a bet, or nothing. */
export function verdictSentence(r: GapReading, now: Date, zone: Zone = EASTERN): string | null {
  if (r.kind === "overnight_move") {
    const next = nextOpenPhrase(now, zone);
    return `With the share market shut, that's a bet on ${next ? `the open ${next.split(" at ")[0]}` : "the next open"}, not a hedge.`;
  }
  if (r.kind === "live_gap") {
    return `Both sides are trading, so that gap could be hedged, before fees.`;
  }
  return null;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "2:14 a.m." in the listener's zone (New York by default). */
export function clockTime(at: number, zone: Zone = EASTERN): string {
  let f = clocks.get(zone.tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone.tz, hour: "numeric", minute: "2-digit", hour12: true });
    clocks.set(zone.tz, f);
  }
  return f.format(new Date(at)).replace("AM", "a.m.").replace("PM", "p.m.");
}

/** "at 2:14 a.m. Eastern", "yesterday at 9:05 p.m. London time", "Saturday at …". */
export function whenSpoken(at: number, now: number, zone: Zone = EASTERN): string {
  const time = `${clockTime(at, zone)} ${zoneName(zone)}`;
  const day = dayWord(at, now, zone);
  return day === "today" ? `at ${time}` : `${day} at ${time}`;
}

/**
 * "around 1 a.m." for a time told in passing, rounded to the half hour, with
 * the day when it wasn't today: "yesterday around 11 p.m.", "on Saturday
 * around 10:30 a.m.".
 */
export function aroundTime(at: number, now: number = at, zone: Zone = EASTERN): string {
  const rounded = Math.round(at / 1_800_000) * 1_800_000;
  const clock = `around ${clockTime(rounded, zone).replace(":00", "")}`;
  const day = dayWord(rounded, now, zone);
  if (day === "today") return clock;
  return day === "yesterday" ? `yesterday ${clock}` : `on ${day} ${clock}`;
}

/** Signed move for speech: "up 2.1 percent" / "down 0.4 percent". */
export function move(bps: number): string {
  return `${bps >= 0 ? "up" : "down"} ${pct(bps)}`;
}
