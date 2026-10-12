/**
 * The week in one breath: "How was my week?"
 *
 * Sunday evening, before the next week's first open, is when people take
 * stock. The recap says what the wallet's tokenized stocks did over seven
 * days (from a daily snapshot of token prices, not a guess), which names led
 * and lagged, how many recurring buys were signed, and how many alerts went
 * off. Spoken on request, and pushed Sunday at 6 p.m. local time to accounts
 * that turned it on.
 */

import type { Services } from "../services.js";
import type { GapReading } from "../market/gap.js";
import type { Holding } from "../chain/holdings.js";
import { SAMPLE_BOARD } from "../market/prices.js";
import { listingByTicker } from "../market/universe.js";
import { getZone, zoneParts } from "../market/zones.js";
import { toEasternParts } from "../market/session.js";
import { listPlans } from "../chain/recurring.js";
import { getIntent } from "../chain/trade.js";
import { notify, pushAccounts, type Notice } from "./push.js";
import { walletOf } from "./wallet-watch.js";
import { capitalise, usd } from "../market/speech.js";

const dayKey = (date: string) => `dayprice:${date}`;
const firedKey = (sub: string) => `firedlog:${sub}`;
const prefKey = (sub: string) => `weekly:${sub}`;
const WEEK = 7 * 86_400_000;
const SEND_MINUTES = 18 * 60;

/** Once per New York day, keeps every token's price, for week-over-week comparisons. */
export async function snapshotDay(svc: Services, readings: GapReading[]): Promise<void> {
  const date = toEasternParts(new Date(svc.now())).date;
  await svc.store.setNew(dayKey(date), Object.fromEntries(readings.map((r) => [r.ticker, r.tokenPrice])), 10 * 86_400);
}

/** Keeps a week of alert fires per account (alerts themselves re-arm). */
export async function logFired(svc: Services, sub: string, ticker: string): Promise<void> {
  const log = (await svc.store.get<{ ticker: string; at: number }[]>(firedKey(sub))) ?? [];
  const now = svc.now();
  await svc.store.set(firedKey(sub), [...log.filter((e) => now - e.at < WEEK), { ticker, at: now }].slice(-100), 8 * 86_400);
}

export async function setWeekly(svc: Services, sub: string, on: boolean): Promise<void> {
  await svc.store.set(prefKey(sub), { on });
}

export async function weeklyOn(svc: Services, sub: string): Promise<boolean> {
  return Boolean((await svc.store.get<{ on: boolean }>(prefKey(sub)))?.on);
}

/** Token prices about a week ago: the snapshot from 7 days back, or the nearest older one. */
async function weekAgoPrices(svc: Services): Promise<Record<string, number> | null> {
  if (svc.sample) {
    // The sample week: each name started where its weekend move began, a bit further back.
    return Object.fromEntries(Object.entries(SAMPLE_BOARD).map(([t, { share, moveBps }]) => [t, share * (1 - (moveBps * 0.8) / 10_000)]));
  }
  for (let back = 7; back <= 9; back += 1) {
    const date = toEasternParts(new Date(svc.now() - back * 86_400_000)).date;
    const found = await svc.store.get<Record<string, number>>(dayKey(date));
    if (found) return found;
  }
  return null;
}

export interface WeekRecap {
  changeUsd: number | null;
  changePercent: number | null;
  best: { ticker: string; percent: number } | null;
  worst: { ticker: string; percent: number } | null;
  recurring: { runs: number; signed: number };
  alertsFired: number;
}

export async function weekRecap(svc: Services, sub: string, holdings: Holding[] | null, prices: Map<string, number>): Promise<WeekRecap> {
  const now = svc.now();
  const then = await weekAgoPrices(svc);
  let changeUsd: number | null = null;
  let changePercent: number | null = null;
  let best: WeekRecap["best"] = null;
  let worst: WeekRecap["worst"] = null;
  if (then && holdings?.length) {
    const rows = holdings
      .filter((h) => prices.has(h.ticker) && then[h.ticker])
      .map((h) => ({ ticker: h.ticker, nowUsd: h.amount * prices.get(h.ticker)!, thenUsd: h.amount * then[h.ticker], percent: (prices.get(h.ticker)! / then[h.ticker] - 1) * 100 }));
    if (rows.length) {
      const nowUsd = rows.reduce((t, r) => t + r.nowUsd, 0);
      const thenUsd = rows.reduce((t, r) => t + r.thenUsd, 0);
      changeUsd = Math.round((nowUsd - thenUsd) * 100) / 100;
      changePercent = Math.round(((nowUsd / thenUsd - 1) * 100) * 10) / 10;
      const sorted = [...rows].sort((a, b) => b.percent - a.percent);
      best = { ticker: sorted[0].ticker, percent: Math.round(sorted[0].percent * 10) / 10 };
      if (sorted.length > 1) worst = { ticker: sorted.at(-1)!.ticker, percent: Math.round(sorted.at(-1)!.percent * 10) / 10 };
    }
  }
  const weekAgoDate = toEasternParts(new Date(now - WEEK)).date;
  let runs = 0;
  let signed = 0;
  for (const plan of await listPlans(svc, sub)) {
    for (const r of plan.runs.filter((x) => x.date > weekAgoDate && x.intentId)) {
      runs += 1;
      const i = await getIntent(svc.store, r.intentId!, now);
      if (i?.status === "confirmed" || i?.status === "submitted") signed += 1;
    }
  }
  const fired = ((await svc.store.get<{ ticker: string; at: number }[]>(firedKey(sub))) ?? []).filter((e) => now - e.at < WEEK).length;
  return { changeUsd, changePercent, best, worst, recurring: { runs, signed }, alertsFired: fired };
}

const name = (t: string) => listingByTicker(t)?.spoken ?? t;
const pctWord = (p: number) => `${p >= 0 ? "up" : "down"} ${Math.abs(p).toFixed(1)} percent`;

/** The recap as one or two spoken sentences. */
export function recapSentence(r: WeekRecap): string {
  const parts: string[] = [];
  if (r.changeUsd !== null && r.changePercent !== null) {
    let line = `This week your tokenized stocks are ${r.changeUsd >= 0 ? "up" : "down"} ${usd(Math.abs(r.changeUsd))}, ${Math.abs(r.changePercent).toFixed(1)} percent`;
    if (r.best && r.worst) line += `. ${capitalise(name(r.best.ticker))} led, ${pctWord(r.best.percent)}, and ${name(r.worst.ticker)} lagged, ${pctWord(r.worst.percent)}`;
    else if (r.best) line += `, all ${name(r.best.ticker)}`;
    parts.push(`${line}.`);
  } else {
    parts.push("I don't have a full week of prices for your holdings yet.");
  }
  if (r.recurring.runs) parts.push(`You signed ${r.recurring.signed} of ${r.recurring.runs} recurring ${r.recurring.runs === 1 ? "buy" : "buys"}.`);
  if (r.alertsFired) parts.push(`${r.alertsFired === 1 ? "One alert" : `${r.alertsFired} alerts`} went off.`);
  return parts.join(" ");
}

export function recapNotice(r: WeekRecap, baseUrl: string): Notice {
  const title = r.changeUsd !== null ? `Your week: ${r.changeUsd >= 0 ? "+" : "−"}${usd(Math.abs(r.changeUsd))} (${r.changePercent! >= 0 ? "+" : "−"}${Math.abs(r.changePercent!).toFixed(1)}%)` : "Your week in tokenized stocks";
  return { title, body: recapSentence(r), url: `${baseUrl}/app/`, tag: "weekly-recap" };
}

/** Sunday at 6 p.m. local, once, for accounts that asked for it. Called from the sampler. */
export async function sendWeeklyRecaps(svc: Services, prices: Map<string, number>): Promise<number> {
  const now = svc.now();
  let sent = 0;
  for (const sub of await pushAccounts(svc)) {
    if (!(await weeklyOn(svc, sub))) continue;
    const zone = await getZone(svc.store, sub);
    const local = zoneParts(new Date(now), zone.tz);
    if (local.weekday !== 0 || local.minutes < SEND_MINUTES || local.minutes >= SEND_MINUTES + 15) continue;
    if (!(await svc.store.setNew(`weeklysent:${sub}:${local.date}`, true, 2 * 86_400))) continue;
    const wallet = await walletOf(svc, sub);
    const holdings = wallet ? await svc.holdings.read(wallet).catch(() => null) : null;
    const recap = await weekRecap(svc, sub, holdings, prices);
    if ((await notify(svc, sub, recapNotice(recap, svc.baseUrl)).catch(() => 0)) > 0) sent += 1;
  }
  return sent;
}
