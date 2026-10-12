/**
 * A briefing that comes to you: "Every weekday at 7, tell me what happened."
 *
 * Alexa only speaks when spoken to. So an account can ask for its briefing
 * at a time of day, in its own time zone, and the tape sampler (every 5
 * minutes) sends it as a push notification once that time comes around:
 * how your positions moved, the watched names that moved, and the market's
 * biggest moves. Tapping it opens the companion app.
 */

import type { Services } from "../services.js";
import type { Notice } from "./push.js";
import { notify } from "./push.js";
import { rankByGap, readGap, NOISE_FLOOR_BPS, type GapReading } from "../market/gap.js";
import { getMarketSession } from "../market/session.js";
import { LISTINGS } from "../market/universe.js";
import { getWatchlist } from "../market/watchlist.js";
import { valuePortfolio } from "../market/portfolio.js";
import { getZone, zoneParts, type Zone } from "../market/zones.js";
import { capitalise, usd } from "../market/speech.js";

export type BriefingDays = "weekdays" | "daily" | "weekends";

export interface BriefingSchedule {
  /** Minutes after local midnight. */
  minutes: number;
  days: BriefingDays;
  /** The linked wallet when it was set, for the portfolio line. */
  wallet?: string;
  /** Local date (YYYY-MM-DD) of the last one sent, so each day sends once. */
  lastSent?: string;
}

const key = (sub: string) => `briefing:${sub}`;
const INDEX = "briefing:index";
/** A sample can land up to 5 minutes late; anything later waits for tomorrow. */
const WINDOW_MIN = 15;

/** "7", "7am", "7:30 a.m.", "19:00", "noon", "6 in the morning" → minutes after midnight. */
export function parseTime(said: string): number | null {
  const t = said.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (/^(noon|midday|12 noon)$/.test(t)) return 12 * 60;
  const m = /^(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm|o'?clock|in the morning|in the afternoon|in the evening|at night)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  const suffix = m[3] ?? "";
  const pm = /pm|afternoon|evening|night/.test(suffix);
  const am = /am|morning/.test(suffix);
  if ((pm || am) && (hour < 1 || hour > 12)) return null;
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** "7 a.m.", "7:30 p.m.", "noon". */
export function spokenTime(minutes: number): string {
  if (minutes === 12 * 60) return "noon";
  if (minutes === 0) return "midnight";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "a.m." : "p.m."}`;
}

export const DAYS_SPOKEN: Record<BriefingDays, string> = { weekdays: "every weekday", daily: "every day", weekends: "on weekends" };

export async function getBriefing(svc: Services, sub: string): Promise<BriefingSchedule | null> {
  return svc.store.get<BriefingSchedule>(key(sub));
}

export async function setBriefing(svc: Services, sub: string, schedule: BriefingSchedule | null): Promise<void> {
  const index = (await svc.store.get<string[]>(INDEX)) ?? [];
  if (schedule) {
    await svc.store.set(key(sub), schedule);
    if (!index.includes(sub)) await svc.store.set(INDEX, [...index, sub]);
  } else {
    await svc.store.del(key(sub));
    if (index.includes(sub)) await svc.store.set(INDEX, index.filter((s) => s !== sub));
  }
}

function dueOn(days: BriefingDays, weekday: number): boolean {
  const weekend = weekday === 0 || weekday === 6;
  return days === "daily" || (days === "weekends" ? weekend : !weekend);
}

const signedPct = (r: GapReading) => `${r.gapBps! >= 0 ? "+" : "−"}${(Math.abs(r.gapBps!) / 100).toFixed(1)}%`;
const brief = (r: GapReading) => `${capitalise(r.spoken.replace(/^the /, ""))} ${signedPct(r)}`;

/** The lock-screen version of the briefing. */
export async function briefingNotice(svc: Services, sub: string, schedule: BriefingSchedule, zone: Zone): Promise<Notice> {
  const board = await svc.prices.read();
  const now = svc.now();
  const session = getMarketSession(new Date(now));
  const readings = LISTINGS.flatMap((l) => {
    const q = board.quotes.get(l.ticker);
    return q ? [readGap(l, q, now, session)] : [];
  }).filter((r) => r.gapBps !== null && r.kind !== "stale_reference");
  const lines: string[] = [];

  const wallet = schedule.wallet || svc.sample ? await svc.holdings.read(schedule.wallet ?? "").catch(() => null) : null;
  const mine = wallet ? valuePortfolio(wallet, readings) : null;
  if (mine && mine.positions.length > 0) {
    lines.push(`Your ${usd(mine.total)} portfolio is ${mine.change >= 0 ? "up" : "down"} ${usd(Math.abs(mine.change))} since the close.`);
  }
  const watched = new Set(await getWatchlist(svc.store, sub));
  const said = new Set<string>();
  const watchMoves = rankByGap(readings.filter((r) => watched.has(r.ticker) && Math.abs(r.gapBps!) >= NOISE_FLOOR_BPS)).slice(0, 3);
  if (watchMoves.length) {
    lines.push(`Watchlist: ${watchMoves.map(brief).join(", ")}.`);
    for (const r of watchMoves) said.add(r.ticker);
  }
  const movers = rankByGap(readings.filter((r) => !said.has(r.ticker))).slice(0, 3);
  if (movers.length) lines.push(`Biggest: ${movers.map(brief).join(", ")}.`);
  if (!lines.length) lines.push("Tokenized stocks are within normal noise of their share prices.");

  const { weekday } = zoneParts(new Date(now), zone.tz);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday];
  const part = schedule.minutes < 12 * 60 ? "morning" : schedule.minutes < 17 * 60 ? "afternoon" : "evening";
  return {
    title: `${board.source === "sample" ? "[Sample] " : ""}Your ${day} ${part} briefing`,
    body: lines.join(" "),
    url: `${svc.baseUrl}/app/`,
    tag: "briefing",
  };
}

/** Sends every briefing whose time has come. Called from the tape sampler. */
export async function sendDueBriefings(svc: Services): Promise<number> {
  const subs = (await svc.store.get<string[]>(INDEX)) ?? [];
  const now = svc.now();
  let sent = 0;
  for (const sub of subs) {
    const schedule = await getBriefing(svc, sub);
    if (!schedule) continue;
    const zone = await getZone(svc.store, sub);
    const local = zoneParts(new Date(now), zone.tz);
    const late = local.minutes - schedule.minutes;
    if (late < 0 || late >= WINDOW_MIN || schedule.lastSent === local.date || !dueOn(schedule.days, local.weekday)) continue;
    // Claim the day first, so two samplers never both send it.
    await svc.store.set(key(sub), { ...schedule, lastSent: local.date });
    const notice = await briefingNotice(svc, sub, schedule, zone).catch(() => null);
    if (notice && (await notify(svc, sub, notice).catch(() => 0)) > 0) sent += 1;
  }
  return sent;
}
