/**
 * Classifies any instant into a US equity market session, in America/New_York.
 *
 * This is the spine of the product. The same 80bps gap between an xStock and its
 * underlying means completely different things at 11:00 on a Tuesday (a live
 * dislocation against a ticking reference) and at 11:00 on a Sunday (44 hours of
 * accumulated drift against a stale Friday close). Every basis reading is
 * labelled with the session it was taken in, and the UI never shows one without
 * the other.
 */

import {
  HALF_DAYS,
  MARKET_HOLIDAYS,
  isCalendarCovered,
} from "./calendar.js";

export type SessionPhase =
  | "premarket"
  | "regular"
  | "afterhours"
  | "closed"
  | "weekend"
  | "holiday";

export interface MarketSession {
  phase: SessionPhase;
  /** True only during the 09:30–16:00 ET continuous session (13:00 on half days). */
  isRegularHours: boolean;
  /** True when *some* US venue is quoting: pre, regular or post. */
  isTradingHours: boolean;
  /** `YYYY-MM-DD` in America/New_York. */
  etDate: string;
  /** Wall-clock `HH:MM` in America/New_York. */
  etTime: string;
  /** Minutes until the phase changes; null when the next boundary is unknown. */
  minutesToNextPhase: number | null;
  /** The phase that begins at the next boundary. */
  nextPhase: SessionPhase | null;
  /** Set on holidays and half days. */
  label: string | null;
  isHalfDay: boolean;
  /** True when the date falls outside the hardcoded calendar tables. */
  calendarStale: boolean;
}

const PREMARKET_OPEN = 4 * 60; // 04:00 ET
const REGULAR_OPEN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE = 16 * 60; // 16:00 ET
const HALF_DAY_CLOSE = 13 * 60; // 13:00 ET
const AFTERHOURS_CLOSE = 20 * 60; // 20:00 ET
const HALF_DAY_AFTERHOURS_CLOSE = 17 * 60; // 17:00 ET

interface EtParts {
  date: string;
  minutes: number;
  time: string;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

// formatToParts is slow next to everything else a brief does, and a brief
// asks about the same few minutes hundreds of times. Every zone offset is a
// whole number of minutes, so the answer for a minute is the answer for every
// instant in it.
const etCache = new Map<number, Readonly<EtParts>>();
const ET_CACHE_MAX = 4096;

/**
 * Wall-clock time in New York. Uses Intl rather than a fixed UTC offset so DST
 * transitions are handled by the platform's tz database instead of by us.
 */
export function toEasternParts(at: Date): EtParts {
  const minute = Math.floor(at.getTime() / 60_000);
  const hit = etCache.get(minute);
  if (hit) return { ...hit };
  const parts = readEasternParts(at);
  if (etCache.size >= ET_CACHE_MAX) etCache.clear();
  etCache.set(minute, parts);
  return { ...parts };
}

function readEasternParts(at: Date): EtParts {
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  // Intl renders midnight as hour "24" in some ICU versions; normalise to 0.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const date = `${get("year")}-${get("month")}-${get("day")}`;

  return {
    date,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Minute at which the continuous session ends on a given ET date. */
export function regularCloseMinute(etDate: string): number {
  return etDate in HALF_DAYS ? HALF_DAY_CLOSE : REGULAR_CLOSE;
}

export function getMarketSession(at: Date = new Date()): MarketSession {
  const { date, minutes, time, weekday } = toEasternParts(at);

  const isHalfDay = date in HALF_DAYS;
  const holiday = MARKET_HOLIDAYS[date];
  const calendarStale = !isCalendarCovered(date);

  const base = {
    etDate: date,
    etTime: time,
    isHalfDay,
    calendarStale,
  };

  if (weekday === 0 || weekday === 6) {
    return {
      ...base,
      phase: "weekend",
      isRegularHours: false,
      isTradingHours: false,
      label: "Weekend",
      // Monday's premarket open is knowable, but a Monday holiday would make the
      // countdown a lie. Left null rather than risk being confidently wrong.
      minutesToNextPhase: null,
      nextPhase: "premarket",
    };
  }

  if (holiday) {
    return {
      ...base,
      phase: "holiday",
      isRegularHours: false,
      isTradingHours: false,
      label: holiday,
      minutesToNextPhase: null,
      nextPhase: "premarket",
    };
  }

  const close = isHalfDay ? HALF_DAY_CLOSE : REGULAR_CLOSE;
  const postClose = isHalfDay ? HALF_DAY_AFTERHOURS_CLOSE : AFTERHOURS_CLOSE;
  const label = isHalfDay ? `${HALF_DAYS[date]} — early close` : null;

  if (minutes < PREMARKET_OPEN) {
    return {
      ...base,
      phase: "closed",
      isRegularHours: false,
      isTradingHours: false,
      label,
      minutesToNextPhase: PREMARKET_OPEN - minutes,
      nextPhase: "premarket",
    };
  }

  if (minutes < REGULAR_OPEN) {
    return {
      ...base,
      phase: "premarket",
      isRegularHours: false,
      isTradingHours: true,
      label,
      minutesToNextPhase: REGULAR_OPEN - minutes,
      nextPhase: "regular",
    };
  }

  if (minutes < close) {
    return {
      ...base,
      phase: "regular",
      isRegularHours: true,
      isTradingHours: true,
      label,
      minutesToNextPhase: close - minutes,
      nextPhase: "afterhours",
    };
  }

  if (minutes < postClose) {
    return {
      ...base,
      phase: "afterhours",
      isRegularHours: false,
      isTradingHours: true,
      label,
      minutesToNextPhase: postClose - minutes,
      nextPhase: "closed",
    };
  }

  return {
    ...base,
    phase: "closed",
    isRegularHours: false,
    isTradingHours: false,
    label,
    // Next premarket is tomorrow, which may be a weekend or holiday.
    minutesToNextPhase: null,
    nextPhase: "premarket",
  };
}

export const SESSION_COPY: Record<SessionPhase, string> = {
  regular: "Open",
  premarket: "Pre-market",
  afterhours: "After hours",
  closed: "Closed",
  weekend: "Weekend",
  holiday: "Holiday",
};

/**
 * How much to trust the equity reference during a phase. Only the continuous
 * session gives a price you can actually hedge against.
 */
export function referenceQualityFor(phase: SessionPhase): "live" | "thin" | "stale" {
  if (phase === "regular") return "live";
  if (phase === "premarket" || phase === "afterhours") return "thin";
  return "stale";
}

/**
 * Plain-language time until the continuous session ends.
 *
 * Null whenever the market is not open, or the boundary is not knowable — the
 * calm-state copy promises the reader something specific, and a countdown that
 * is confidently wrong is worse than none.
 */
export function timeUntilClose(session: MarketSession): string | null {
  if (!session.isRegularHours || session.minutesToNextPhase === null) return null;
  const minutes = session.minutesToNextPhase;
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hours` : `${hours}h ${rest}m`;
}

/**
 * Minutes until the next 09:30 ET regular open, or null when the next trading
 * day cannot be known for certain — past the end of the holiday calendar, the
 * honest answer is "at the next open", not a countdown that might be a day out.
 */
export function minutesToNextOpen(at: Date = new Date()): number | null {
  const { date, minutes, weekday } = toEasternParts(at);
  const tradingDay = (d: string, day: number) =>
    day >= 1 && day <= 5 && !(d in MARKET_HOLIDAYS) && isCalendarCovered(d);

  // Today, if the open has not passed yet.
  if (tradingDay(date, weekday) && minutes < REGULAR_OPEN) return REGULAR_OPEN - minutes;

  // Otherwise the first trading day ahead, up to a long weekend's worth.
  const start = new Date(`${date}T12:00:00Z`);
  for (let ahead = 1; ahead <= 5; ahead += 1) {
    const next = new Date(start.getTime() + ahead * 86_400_000);
    const iso = next.toISOString().slice(0, 10);
    if (!tradingDay(iso, next.getUTCDay())) continue;
    return ahead * 24 * 60 - minutes + REGULAR_OPEN;
  }
  return null;
}

/** The UTC instant of a New York wall-clock time, DST included. */
export function easternToUtc(etDate: string, minutes: number): Date {
  const [y, m, d] = etDate.split("-").map(Number);
  for (const offsetHours of [4, 5]) {
    const guess = new Date(Date.UTC(y, m - 1, d, 0, minutes) + offsetHours * 3600_000);
    const parts = toEasternParts(guess);
    if (parts.date === etDate && parts.minutes === minutes) return guess;
  }
  return new Date(Date.UTC(y, m - 1, d, 0, minutes) + 5 * 3600_000);
}

const closeCache = new Map<number, number>();

/**
 * When the regular session last closed at or before `at`: today's close if it
 * has passed, else the most recent trading day's (Friday's, over a weekend).
 */
export function lastRegularClose(at: Date = new Date()): Date {
  // Closes fall on whole minutes, so the answer holds for the whole minute.
  const minute = Math.floor(at.getTime() / 60_000);
  const hit = closeCache.get(minute);
  if (hit !== undefined) return new Date(hit);
  const today = toEasternParts(at).date;
  const noon = new Date(`${today}T12:00:00Z`);
  for (let back = 0; back <= 7; back += 1) {
    const day = new Date(noon.getTime() - back * 86_400_000);
    const iso = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6 || iso in MARKET_HOLIDAYS) continue;
    const close = easternToUtc(iso, regularCloseMinute(iso));
    if (close.getTime() <= at.getTime()) {
      if (closeCache.size >= ET_CACHE_MAX) closeCache.clear();
      closeCache.set(minute, close.getTime());
      return close;
    }
  }
  return new Date(at.getTime() - 86_400_000);
}
