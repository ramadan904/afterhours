/**
 * "Is the market open on Thanksgiving?" "When's the next holiday?"
 *
 * The NYSE calendar (calendar.ts) already decides every session; this turns
 * it into answers about days: a holiday by name, a date ("December 24",
 * "Friday", "tomorrow"), or simply the next closures and early closes. Every
 * answer says the token keeps trading, because that's the point.
 */

import { HALF_DAYS, MARKET_HOLIDAYS, isCalendarCovered } from "./calendar.js";
import { toEasternParts } from "./session.js";

export type DayVerdict = { date: string; status: "open" | "closed" | "half_day" | "weekend" | "unknown"; label: string | null };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function dayStatus(date: string): DayVerdict {
  if (!isCalendarCovered(date)) return { date, status: "unknown", label: null };
  if (MARKET_HOLIDAYS[date]) return { date, status: "closed", label: MARKET_HOLIDAYS[date] };
  const wd = weekdayOf(date);
  if (wd === 0 || wd === 6) return { date, status: "weekend", label: null };
  if (HALF_DAYS[date]) return { date, status: "half_day", label: HALF_DAYS[date] };
  return { date, status: "open", label: null };
}

/** The next full closures and early closes from `today` (inclusive), soonest first. */
export function upcoming(today: string, count = 3): DayVerdict[] {
  const dates = [...Object.keys(MARKET_HOLIDAYS), ...Object.keys(HALF_DAYS)].filter((d) => d >= today).sort();
  return dates.slice(0, count).map(dayStatus);
}

// Longer phrases first: "the day after Thanksgiving" isn't Thanksgiving.
const NAMED: [RegExp, string][] = [
  [/black friday|day after thanksgiving/, "Day after Thanksgiving"],
  [/thanksgiving/, "Thanksgiving"],
  [/christmas eve/, "Christmas Eve"],
  [/christmas|xmas/, "Christmas Day"],
  [/new year/, "New Year's Day"],
  [/(mlk|martin luther king)/, "Martin Luther King"],
  [/president/, "Presidents' Day"],
  [/good friday/, "Good Friday"],
  [/memorial/, "Memorial Day"],
  [/juneteenth/, "Juneteenth"],
  [/(independence|july 4|4th of july|fourth of july)/, "Independence Day"],
  [/labor day/, "Labor Day"],
];

/**
 * A day as said, resolved to its next occurrence on or after `today`:
 * a holiday name, "December 24", "12/24", "2026-12-24", a weekday, "today",
 * "tomorrow". Null when it isn't a day.
 */
export function resolveDay(said: string, today: string): string | null {
  const t = said.toLowerCase().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  for (const [re, name] of NAMED) {
    if (!re.test(t)) continue;
    const table = name === "Christmas Eve" || name === "Day after Thanksgiving" ? HALF_DAYS : MARKET_HOLIDAYS;
    const hit = Object.entries(table).filter(([d, n]) => d >= today && n.startsWith(name)).sort()[0];
    if (hit) return hit[0];
    // Not a closure this year (e.g. Christmas Eve on a weekend): find the calendar date.
    if (name === "Christmas Eve") return nextMonthDay(today, 12, 24);
  }
  const md = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/.exec(t) ?? null;
  if (md) return nextMonthDay(today, MONTHS.indexOf(md[1]) + 1, Number(md[2]));
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (slash) return nextMonthDay(today, Number(slash[1]), Number(slash[2]));
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
  if (wd >= 0) return addDays(today, (wd - weekdayOf(today) + 7) % 7);
  return null;
}

function nextMonthDay(today: string, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = Number(today.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  const real = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, day));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? `${y}-${pad(month)}-${pad(day)}` : null;
  };
  // "February 30" isn't a day; February 29 is the next one that exists.
  for (let y = year; y <= year + 4; y += 1) {
    const date = real(y);
    if (date && date >= today) return date;
  }
  return null;
}

/** "Thursday, November 26" */
export function spokenDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export function todayEt(now: number): string {
  return toEasternParts(new Date(now)).date;
}
