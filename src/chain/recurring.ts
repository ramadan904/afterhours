/**
 * Recurring buys, without custody: "Buy 25 dollars of the S&P every Monday."
 *
 * Exchanges do dollar-cost averaging by holding your money and your keys.
 * Afterhours holds neither. At each run it prepares an ordinary proposal at
 * the current price and pushes it to the phone. One tap opens the confirm page
 * (in a wallet's browser, or as a Solana Action) and the wallet signs it, or
 * doesn't. A run that's ignored simply lapses, and the plan keeps count of
 * what was signed, so the person can hear how consistent they've been.
 *
 * Runs respect the account's daily spending limit; a run that would break it
 * is skipped and the person is told. Sleep mode doesn't apply: the time was
 * chosen in daylight.
 */

import { randomBytes } from "node:crypto";
import type { Services } from "../services.js";
import type { Notice } from "../notify/push.js";
import { notify } from "../notify/push.js";
import { createIntent, getIntent, maxTradeUsd, type TradeIntent } from "./trade.js";
import { getGuardrails, recordSpend, spentToday } from "./guardrails.js";
import { getZone, zoneParts, type Zone } from "../market/zones.js";
import { listingByTicker } from "../market/universe.js";
import { capitalise, clockTime, usd } from "../market/speech.js";

export type Cadence = "daily" | "weekly" | "monthly";
export const MAX_PLANS = 5;
/** A run's proposal stays signable for an hour: it arrives unannounced. */
export const RUN_TTL_SECONDS = 3600;
const WINDOW_MIN = 15;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface RecurringPlan {
  id: string;
  ticker: string;
  usd: number;
  cadence: Cadence;
  /** Weekly: 0 (Sunday) to 6. */
  weekday?: number;
  /** Monthly: 1 to 31; short months run on their last day. */
  dayOfMonth?: number;
  /** Local minutes after midnight. */
  minutes: number;
  wallet: string;
  createdAt: number;
  /** Local date of the last run, so each date runs once. */
  lastRun?: string;
  /** Recent runs, newest last: the proposal, or why there wasn't one. */
  runs: { date: string; intentId?: string; skipped?: "limit" | "no_price" }[];
}

const key = (sub: string) => `recurring:${sub}`;
const INDEX = "recurring:index";

export async function listPlans(svc: Services, sub: string): Promise<RecurringPlan[]> {
  return (await svc.store.get<RecurringPlan[]>(key(sub))) ?? [];
}

async function savePlans(svc: Services, sub: string, plans: RecurringPlan[]): Promise<void> {
  const index = (await svc.store.get<string[]>(INDEX)) ?? [];
  if (plans.length) {
    await svc.store.set(key(sub), plans);
    if (!index.includes(sub)) await svc.store.set(INDEX, [...index, sub]);
  } else {
    await svc.store.del(key(sub));
    if (index.includes(sub)) await svc.store.set(INDEX, index.filter((s) => s !== sub));
  }
}

/** "monday", "Mondays", "mon" → 1. */
export function parseWeekday(said: string): number | null {
  const t = said.toLowerCase().trim().replace(/s$/, "");
  const i = WEEKDAYS.findIndex((d) => d === t || d.slice(0, 3) === t.slice(0, 3));
  return i >= 0 && t.length >= 3 ? i : null;
}

export async function addPlan(svc: Services, sub: string, plan: Omit<RecurringPlan, "id" | "createdAt" | "runs">): Promise<RecurringPlan> {
  const plans = await listPlans(svc, sub);
  if (plans.length >= MAX_PLANS) throw new Error(`You can have up to ${MAX_PLANS} recurring buys. Stop one first.`);
  if (plan.usd > maxTradeUsd()) throw new Error(`Each recurring buy can be up to ${usd(maxTradeUsd())}.`);
  const created: RecurringPlan = { ...plan, id: randomBytes(8).toString("base64url"), createdAt: svc.now(), runs: [] };
  await savePlans(svc, sub, [...plans, created]);
  return created;
}

export async function removePlans(svc: Services, sub: string, ticker?: string): Promise<RecurringPlan[]> {
  const plans = await listPlans(svc, sub);
  const removed = plans.filter((p) => !ticker || p.ticker === ticker);
  await savePlans(svc, sub, plans.filter((p) => !removed.includes(p)));
  return removed;
}

function lastDayOfMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whether a plan runs on a local date. */
export function runsOn(plan: RecurringPlan, local: { date: string; weekday: number }): boolean {
  if (plan.cadence === "daily") return true;
  if (plan.cadence === "weekly") return local.weekday === plan.weekday;
  const day = Number(local.date.slice(8));
  return day === Math.min(plan.dayOfMonth ?? 1, lastDayOfMonth(local.date));
}

/** "every Monday at 9 a.m.", "on the 1st of each month at 9 a.m." */
export function cadencePhrase(plan: RecurringPlan, spokenTime: (m: number) => string): string {
  const at = `at ${spokenTime(plan.minutes)}`;
  if (plan.cadence === "daily") return `every day ${at}`;
  if (plan.cadence === "weekly") return `every ${capitalise(WEEKDAYS[plan.weekday ?? 1])} ${at}`;
  const d = plan.dayOfMonth ?? 1;
  const nth = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
  return `on the ${d}${nth} of each month ${at}`;
}

/** How a plan has gone: proposals signed out of runs. */
export async function planRecord(svc: Services, plan: RecurringPlan): Promise<{ runs: number; signed: number; skipped: number }> {
  const intents = await Promise.all(plan.runs.map((r) => (r.intentId ? getIntent(svc.store, r.intentId, svc.now()) : null)));
  return {
    runs: plan.runs.length,
    signed: intents.filter((i) => i?.status === "confirmed" || i?.status === "submitted").length,
    skipped: plan.runs.filter((r) => r.skipped).length,
  };
}

/** "S&P 500 fund", not "The S&P 500 fund", mid-sentence on a lock screen. */
const label = (ticker: string) => capitalise((listingByTicker(ticker)?.spoken ?? ticker).replace(/^the /, ""));

export function runNotice(intent: TradeIntent, plan: RecurringPlan, baseUrl: string, zone: Zone): Notice {
  const name = label(plan.ticker);
  const every = plan.cadence === "daily" ? "daily" : plan.cadence === "weekly" ? "weekly" : "monthly";
  return {
    title: `Your ${every} ${usd(plan.usd)} ${name} buy is ready`,
    body: `At about ${usd(intent.priceAtProposal)}. Tap to review and sign it in your wallet. Code ${intent.code}, until ${clockTime(intent.expiresAt, zone)}.`,
    url: `${baseUrl}/go/${intent.code}`,
    tag: `plan-${plan.id}`,
  };
}

/**
 * Prepares every recurring buy whose time has come. Called from the tape
 * sampler with the latest token prices. Returns the proposals made.
 */
export async function runDuePlans(svc: Services, prices: Map<string, number>): Promise<TradeIntent[]> {
  const subs = (await svc.store.get<string[]>(INDEX)) ?? [];
  const now = svc.now();
  const made: TradeIntent[] = [];
  for (const sub of subs) {
    const plans = await listPlans(svc, sub);
    const zone = await getZone(svc.store, sub);
    const local = zoneParts(new Date(now), zone.tz);
    let changed = false;
    for (const plan of plans) {
      const late = local.minutes - plan.minutes;
      if (late < 0 || late >= WINDOW_MIN || plan.lastRun === local.date || !runsOn(plan, local)) continue;
      plan.lastRun = local.date;
      changed = true;
      const name = label(plan.ticker);
      const price = prices.get(plan.ticker);
      if (!price) {
        plan.runs = [...plan.runs, { date: local.date, skipped: "no_price" as const }].slice(-12);
        continue;
      }
      const rules = await getGuardrails(svc.store, sub, now);
      if (rules.dailyLimitUsd !== null && (await spentToday(svc.store, sub, zone, now)) + plan.usd > rules.dailyLimitUsd + 0.001) {
        plan.runs = [...plan.runs, { date: local.date, skipped: "limit" as const }].slice(-12);
        await notify(svc, sub, {
          title: `Skipped today's ${name} buy`,
          body: `It would have gone over your ${usd(rules.dailyLimitUsd)} daily limit. The plan carries on next time.`,
          url: `${svc.baseUrl}/app/`,
          tag: `plan-${plan.id}`,
        }).catch(() => 0);
        continue;
      }
      const intent = await createIntent(
        svc.store,
        { sub, wallet: plan.wallet, ticker: plan.ticker, side: "buy", usd: plan.usd, priceAtProposal: price, planId: plan.id },
        now,
        RUN_TTL_SECONDS,
      );
      await recordSpend(svc.store, sub, zone, now, intent.id, plan.usd);
      plan.runs = [...plan.runs, { date: local.date, intentId: intent.id }].slice(-12);
      made.push(intent);
      await notify(svc, sub, runNotice(intent, plan, svc.baseUrl, zone)).catch(() => 0);
    }
    if (changed) await savePlans(svc, sub, plans);
  }
  return made;
}
