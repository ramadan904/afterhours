/**
 * NYSE/Nasdaq trading calendar.
 *
 * Dates are keyed as `YYYY-MM-DD` in America/New_York, never UTC — a holiday is
 * a calendar day in New York, and a UTC-keyed date is wrong for a third of every
 * day. Half days close at 13:00 ET instead of 16:00 ET.
 */

/** Full-day closures. Observed dates, so a Saturday holiday appears on the Friday. */
export const MARKET_HOLIDAYS: Record<string, string> = {
  // 2025
  "2025-01-01": "New Year's Day",
  "2025-01-09": "National Day of Mourning (Carter)",
  "2025-01-20": "Martin Luther King Jr. Day",
  "2025-02-17": "Presidents' Day",
  "2025-04-18": "Good Friday",
  "2025-05-26": "Memorial Day",
  "2025-06-19": "Juneteenth",
  "2025-07-04": "Independence Day",
  "2025-09-01": "Labor Day",
  "2025-11-27": "Thanksgiving Day",
  "2025-12-25": "Christmas Day",
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Presidents' Day",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Presidents' Day",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};

/** Early closes: regular session ends 13:00 ET, after-hours runs 13:00–17:00 ET. */
export const HALF_DAYS: Record<string, string> = {
  "2025-07-03": "Day before Independence Day",
  "2025-11-28": "Day after Thanksgiving",
  "2025-12-24": "Christmas Eve",
  "2026-11-27": "Day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
  "2027-11-26": "Day after Thanksgiving",
};

/** Years the tables above actually cover. Outside this range we degrade loudly. */
export const CALENDAR_YEARS = { first: 2025, last: 2027 } as const;

export function isCalendarCovered(etDate: string): boolean {
  const year = Number(etDate.slice(0, 4));
  return year >= CALENDAR_YEARS.first && year <= CALENDAR_YEARS.last;
}
