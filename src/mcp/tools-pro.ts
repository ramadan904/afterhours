/**
 * The tools beyond quotes and proposals: guardrails a person sets for their
 * own late-night self, recurring buys, returns read from the chain, market
 * depth, and moves adjusted for the market.
 *
 * Same contract as tools.ts: a sentence to speak, the numbers behind it, and
 * truthful annotations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "../services.js";
import type { Caller } from "./tools.js";
import type { GapReading } from "../market/gap.js";
import type { Board } from "../market/prices.js";
import type { MarketSession } from "../market/session.js";
import type { TradeIntent } from "../chain/trade.js";
import { fail, say, type Result } from "./result.js";
import { toolUiMeta } from "./apps.js";
import { COOLING_OFF_MS, DEFAULT_SLEEP, getGuardrails, inWindow, setDailyLimit, setSleep, spentToday } from "../chain/guardrails.js";
import { getZone, zoneName, zoneParts } from "../market/zones.js";
import { capitalise, clockTime, usd } from "../market/speech.js";
import { parseTime, spokenTime } from "../notify/briefing.js";
import { addPlan, cadencePhrase, listPlans, MAX_PLANS, parseWeekday, planRecord, removePlans, type Cadence } from "../chain/recurring.js";
import { listingByTicker, resolveSymbol } from "../market/universe.js";
import { channelCount } from "../notify/push.js";
import { readBasis } from "../chain/basis.js";
import { depthLadder, impactAt, sizeWithin } from "../chain/depth.js";
import { getTargets, planRebalance, setTargets } from "../market/rebalance.js";
import { openKey, type OpenResult } from "../notify/open-verdict.js";
import { recapSentence, setWeekly, weeklyOn, weekRecap } from "../notify/weekly.js";
import { readActivity } from "../account/activity.js";
import { deleteData } from "../account/data.js";
import { SECTORS, resolveSector, sectorById, sectorReadings } from "../market/sectors.js";
import { dayStatus, resolveDay, spokenDate, todayEt, upcoming } from "../market/calendar-talk.js";
import { readBetas } from "../market/beta.js";
import { rankByGap, NOISE_FLOOR_BPS } from "../market/gap.js";
import { whenSpoken } from "../market/speech.js";
import { sampleOpens } from "../market/history.js";
import { getMarketSession, toEasternParts } from "../market/session.js";
import { getWatchlist } from "../market/watchlist.js";
import { createIntent, maxTradeUsd } from "../chain/trade.js";
import { recordSpend } from "../chain/guardrails.js";
import { checkPin, hasPin, normalisePin, removePin, setPin, validPin, type PinCheck } from "../auth/pin.js";

/** Like tools.ts's `within`: an optional extra must never cost the voice turn its budget. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);
const listJoin = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const pctOf = (x: number) => `${(Math.abs(x) * 100).toFixed(1)} percent`;

/** What to say when a PIN check fails. Never repeats the PIN. */
export function pinRefusal(check: Exclude<PinCheck, { ok: true }>, zone: Parameters<typeof clockTime>[1]): string {
  if (check.reason === "missing") return "You've set a trade PIN. What is it?";
  if (check.reason === "locked") return `Trading by voice is locked until ${clockTime(check.lockedUntil!, zone)} after too many wrong PINs. Nothing was prepared.`;
  return `That PIN isn't right. ${check.triesLeft === 1 ? "One more wrong try" : `${check.triesLeft} more wrong tries`} and trading by voice locks for an hour.`;
}

export interface ToolKit {
  guard: (fn: () => Promise<Result>) => Promise<Result>;
  allReadings: () => Promise<{ board: Board; now: number; session: MarketSession; readings: GapReading[] }>;
  intentOut: (i: TradeIntent, baseUrl: string) => Record<string, unknown>;
  intentShape: Record<string, z.ZodType>;
}

const when = (at: number, now: number, zone: Parameters<typeof clockTime>[1]) =>
  `${at - now < 20 * 3600_000 ? "" : "tomorrow "}at ${clockTime(at, zone)}`;

export function registerProTools(server: McpServer, svc: Services, caller: Caller, kit: ToolKit): void {
  const { guard } = kit;

  server.registerTool(
    "set_spending_limit",
    {
      title: "Set a daily spending limit",
      description:
        "Sets, reads or removes the user's own daily limit on buys proposed through Afterhours. Lowering or setting a limit applies immediately; raising or removing one only takes effect after 24 hours, on purpose, so a late-night decision can't undo a calm one. Use for 'don't let me spend more than 200 dollars a day', 'what's my limit?', 'raise my limit to 500', 'remove my spending limit'. Call with no arguments to read it.",
      inputSchema: {
        daily_usd: z.number().positive().optional().describe("The new daily limit in dollars."),
        remove: z.boolean().optional().describe("True to remove the limit (takes 24 hours)."),
      },
      outputSchema: {
        dailyLimitUsd: z.number().nullable(),
        spentTodayUsd: z.number(),
        pendingLimitUsd: z.number().nullable(),
        pendingRemoval: z.boolean(),
        pendingAt: z.string().nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ daily_usd, remove }) =>
      guard(async () => {
        const now = svc.now();
        const zone = await getZone(svc.store, caller.sub);
        const out = async () => {
          const g = await getGuardrails(svc.store, caller.sub, now);
          return {
            g,
            data: {
              dailyLimitUsd: g.dailyLimitUsd,
              spentTodayUsd: Math.round((await spentToday(svc.store, caller.sub, zone, now)) * 100) / 100,
              pendingLimitUsd: g.pending?.dailyLimitUsd ?? null,
              pendingRemoval: Boolean(g.pending && g.pending.dailyLimitUsd === null),
              pendingAt: g.pending ? new Date(g.pending.effectiveAt).toISOString() : null,
            },
          };
        };
        if (daily_usd === undefined && !remove) {
          const { g, data } = await out();
          if (g.dailyLimitUsd === null) return say("You don't have a daily spending limit. You can say, don't let me spend more than 200 dollars a day.", data);
          const pending = g.pending
            ? ` It changes ${g.pending.dailyLimitUsd === null ? "to no limit" : `to ${usd(g.pending.dailyLimitUsd)}`} ${when(g.pending.effectiveAt, now, zone)} ${zoneName(zone)}.`
            : "";
          return say(`Your limit is ${usd(g.dailyLimitUsd)} of buys a day, and ${usd(data.spentTodayUsd)} is spoken for today.${pending}`, data);
        }
        const result = await setDailyLimit(svc.store, caller.sub, remove ? null : daily_usd!, now);
        const { data } = await out();
        if (result.effective === "now") {
          return say(
            remove
              ? "You don't have a daily limit to remove."
              : `Done. From now on I'll only prepare up to ${usd(daily_usd!)} of buys a day. Lowering it again works right away; raising it takes a day.`,
            data,
          );
        }
        const what = remove ? "remove your limit" : `raise your limit to ${usd(daily_usd!)}`;
        return say(
          `OK. I'll ${what} ${when(result.effectiveAt, now, zone)} ${zoneName(zone)}, ${COOLING_OFF_MS / 3600_000} hours from now. Until then it stays ${usd(result.guardrails.dailyLimitUsd!)}. The wait is on purpose.`,
          data,
        );
      }),
  );

  server.registerTool(
    "set_sleep_mode",
    {
      title: "Sleep on late-night trades",
      description:
        "Turns sleep mode on or off. With it on, a trade asked for during the night (default 11 p.m. to 7 a.m. in the user's time zone) isn't prepared right away: it's set aside and becomes ready to sign at wake-up time, with a notification. Use for 'don't let me trade at night', 'turn on sleep mode', 'sleep mode from midnight to 6', 'turn off sleep mode', 'is sleep mode on?'. Call with no arguments to read it.",
      inputSchema: {
        on: z.boolean().optional(),
        from: z.string().optional().describe("Start of the night, as said, e.g. '11 pm', 'midnight' → use '0:00'."),
        until: z.string().optional().describe("Wake-up time, as said, e.g. '7', '6:30 am'."),
      },
      outputSchema: { on: z.boolean(), from: z.string().nullable(), until: z.string().nullable(), timeZone: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ on, from, until }) =>
      guard(async () => {
        const now = svc.now();
        const zone = await getZone(svc.store, caller.sub);
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const data = (s: { from: number; to: number } | null) => ({ on: Boolean(s), from: s ? hhmm(s.from) : null, until: s ? hhmm(s.to) : null, timeZone: zone.tz });
        const g = await getGuardrails(svc.store, caller.sub, now);
        if (on === undefined && from === undefined && until === undefined) {
          return say(
            g.sleep
              ? `Sleep mode is on, from ${spokenTime(g.sleep.from)} to ${spokenTime(g.sleep.to)} ${zoneName(zone)}.`
              : "Sleep mode is off. You can say, don't let me trade at night.",
            data(g.sleep),
          );
        }
        if (on === false) {
          if (!g.sleep) return say("Sleep mode is already off.", data(null));
          const r = await setSleep(svc.store, caller.sub, null, now);
          return say(
            `OK. Sleep mode turns off ${when(r.effectiveAt, now, zone)} ${zoneName(zone)}, ${COOLING_OFF_MS / 3600_000} hours from now; until then it stays on. The wait is on purpose.`,
            data(g.sleep),
          );
        }
        const night = (said: string | undefined, fallback: number) => {
          if (said === undefined) return fallback;
          if (/^midnight$/i.test(said.trim())) return 0;
          return parseTime(said.trim()) ?? Number.NaN;
        };
        // "from 11" means 11 p.m.; "until 7" means 7 a.m.
        let start = night(from, g.sleep?.from ?? DEFAULT_SLEEP.from);
        if (from && !/[ap]\.?m|:|morning|evening|night/i.test(from) && start < 12 * 60 && start >= 6 * 60) start += 12 * 60;
        const end = night(until, g.sleep?.to ?? DEFAULT_SLEEP.to);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return fail("I didn't catch those times. Try something like from 11 p.m. until 7 a.m.");
        if (start === end) return fail("Sleep mode needs a start and an end that differ.");
        const sleep = { from: start, to: end };
        const r = await setSleep(svc.store, caller.sub, sleep, now);
        if (r.effective === "later") {
          return say(
            `OK. Your new sleep hours, ${spokenTime(start)} to ${spokenTime(end)}, start ${when(r.effectiveAt, now, zone)} ${zoneName(zone)}; until then the current ones stay. Changes that loosen sleep mode wait a day, on purpose.`,
            data(g.sleep),
          );
        }
        return say(
          `Sleep mode is on. Between ${spokenTime(start)} and ${spokenTime(end)} ${zoneName(zone)}, I'll set trades aside until morning instead of preparing them, and send them to your phone when you're up.`,
          data(sleep),
        );
      }),
  );

  const planOut = z.object({
    ticker: z.string(),
    usd: z.number(),
    cadence: z.enum(["daily", "weekly", "monthly"]),
    schedule: z.string(),
    runs: z.number(),
    signed: z.number(),
    skipped: z.number(),
  });

  server.registerTool(
    "recurring_buy",
    {
      title: "Set up a recurring buy",
      description:
        "Sets up a recurring buy (dollar-cost averaging) without custody: at each run Afterhours prepares a proposal at the current price and sends it to the user's phone, and it only happens if they sign it in their wallet. Use for 'buy 25 dollars of the S&P every Monday', 'buy 10 dollars of Nvidia every day at 9', 'invest 100 dollars in Apple on the 1st of every month'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as said."),
        amount_usd: z.number().positive(),
        cadence: z.enum(["daily", "weekly", "monthly"]).describe("How often."),
        day: z.string().optional().describe("Weekly: the weekday ('Monday'). Monthly: day of the month ('1', '15'). Default Monday or the 1st."),
        time: z.string().optional().describe("Time of day as said, e.g. '9', '8:30 am'. Default 9 a.m."),
        pin: z.string().optional().describe("The user's trade PIN, if they have one. Ask for it when told it's needed."),
      },
      outputSchema: { plan: planOut, plans: z.number(), max: z.number(), devices: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ stock, amount_usd, cadence, day, time, pin }) =>
      guard(async () => {
        const pinCheck = await checkPin(svc.store, caller.sub, pin, svc.now());
        if (!pinCheck.ok) return fail(pinRefusal(pinCheck, await getZone(svc.store, caller.sub)));
        const listing = resolveSymbol(stock);
        if (!listing) return fail(`I don't have a tokenized stock for "${stock}".`);
        if (!caller.wallet) return fail("No wallet is linked yet. Link Afterhours in the Alexa app before setting up buys.");
        if (amount_usd < 1) return fail("The smallest recurring buy is $1.");
        const minutes = time ? parseTime(time) : 9 * 60;
        if (minutes === null) return fail(`I didn't catch a time in "${time}". Try something like 9 a.m.`);
        let weekday: number | undefined;
        let dayOfMonth: number | undefined;
        if (cadence === "weekly") {
          weekday = day ? (parseWeekday(day) ?? undefined) : 1;
          if (weekday === undefined) return fail(`Which day of the week? I didn't catch "${day}".`);
        }
        if (cadence === "monthly") {
          dayOfMonth = day ? Number(/\d{1,2}/.exec(day)?.[0]) : 1;
          if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) return fail(`Which day of the month? I didn't catch "${day}".`);
        }
        const plan = await addPlan(svc, caller.sub, { ticker: listing.ticker, usd: amount_usd, cadence: cadence as Cadence, weekday, dayOfMonth, minutes, wallet: caller.wallet });
        const zone = await getZone(svc.store, caller.sub);
        const devices = await channelCount(svc, caller.sub);
        const plans = (await listPlans(svc, caller.sub)).length;
        return say(
          `Done. ${cadencePhrase(plan, spokenTime).replace(/^./, (c) => c.toUpperCase())} ${zoneName(zone)}, I'll prepare a ${usd(amount_usd)} buy of ${listing.spoken} and send it to your phone to sign. ${devices ? "" : "Turn on notifications in the Afterhours app so you get them. "}Nothing is bought unless you sign it.`,
          { plan: { ticker: plan.ticker, usd: plan.usd, cadence: plan.cadence, schedule: cadencePhrase(plan, spokenTime), runs: 0, signed: 0, skipped: 0 }, plans, max: MAX_PLANS, devices },
        );
      }),
  );

  server.registerTool(
    "my_recurring_buys",
    {
      title: "My recurring buys",
      description: "Lists the user's recurring buys and how consistently they've signed them. Use for 'what recurring buys do I have?', 'how's my S&P plan going?'.",
      inputSchema: {},
      outputSchema: { plans: z.array(planOut), max: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const plans = await listPlans(svc, caller.sub);
        if (!plans.length) return say("You don't have any recurring buys. You can say, buy 25 dollars of the S&P every Monday.", { plans: [], max: MAX_PLANS });
        const zone = await getZone(svc.store, caller.sub);
        const rows = await Promise.all(
          plans.map(async (p) => ({ p, rec: await planRecord(svc, p), name: listingByTicker(p.ticker)?.spoken ?? p.ticker })),
        );
        const sentences = rows.map(({ p, rec, name }) => {
          const record = rec.runs === 0 ? "it hasn't run yet" : `you've signed ${rec.signed} of ${rec.runs - rec.skipped} so far${rec.skipped ? `, and ${rec.skipped} ${rec.skipped === 1 ? "was" : "were"} skipped` : ""}`;
          return `${usd(p.usd)} of ${name} ${cadencePhrase(p, spokenTime)}: ${record}`;
        });
        return say(`You have ${plans.length === 1 ? "one recurring buy" : `${plans.length} recurring buys`}, times in ${zoneName(zone)}. ${sentences.join(". ")}.`, {
          plans: rows.map(({ p, rec }) => ({ ticker: p.ticker, usd: p.usd, cadence: p.cadence, schedule: cadencePhrase(p, spokenTime), ...rec })),
          max: MAX_PLANS,
        });
      }),
  );

  server.registerTool(
    "stop_recurring_buy",
    {
      title: "Stop a recurring buy",
      description: "Stops the user's recurring buy of one stock, or all of them when no stock is given. Use for 'stop my weekly S&P buy', 'cancel my recurring buys'.",
      inputSchema: { stock: z.string().optional().describe("Which stock's plan to stop; omit to stop all.") },
      outputSchema: { stopped: z.array(z.string()), remaining: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ stock }) =>
      guard(async () => {
        const listing = stock ? resolveSymbol(stock) : null;
        if (stock && !listing) return fail(`I don't have a tokenized stock for "${stock}".`);
        const removed = await removePlans(svc, caller.sub, listing?.ticker);
        const remaining = (await listPlans(svc, caller.sub)).length;
        if (!removed.length) return say(listing ? `You don't have a recurring buy of ${listing.spoken}.` : "You don't have any recurring buys.", { stopped: [], remaining });
        const names = [...new Set(removed.map((p) => listingByTicker(p.ticker)?.spoken ?? p.ticker))];
        return say(`Stopped your recurring ${names.join(" and ")} ${removed.length === 1 ? "buy" : "buys"}. Anything already sent to your phone can still be signed until it expires.`, {
          stopped: removed.map((p) => p.ticker),
          remaining,
        });
      }),
  );

  server.registerTool(
    "my_returns",
    {
      _meta: toolUiMeta("my_returns"),
      title: "What I paid and what I've made",
      description:
        "How much the user has made or lost on what they hold, against what they actually paid: reconstructed from their wallet's own Solana history (each buy and sale paired with the USDC that moved), at average cost. Use for 'how much have I made on Nvidia?', 'am I up overall?', 'what did I pay for my Tesla?'.",
      inputSchema: { stock: z.string().optional().describe("One stock, or omit for the whole portfolio.") },
      outputSchema: {
        positions: z.array(
          z.object({
            ticker: z.string(),
            held: z.number(),
            averageCost: z.number().nullable(),
            price: z.number(),
            costUsd: z.number(),
            valueUsd: z.number(),
            gainUsd: z.number(),
            gainPercent: z.number().nullable(),
            realizedUsd: z.number(),
            buys: z.number(),
            sells: z.number(),
            uncostedQty: z.number(),
          }),
        ),
        totalCostUsd: z.number(),
        totalValueUsd: z.number(),
        totalGainUsd: z.number(),
        transactionsRead: z.number(),
        complete: z.boolean().describe("False when older history exists than was read."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stock }) =>
      guard(async () => {
        const wallet = caller.wallet ?? (svc.sample ? "" : null);
        if (wallet === null) return fail("No wallet is linked yet. Link one in the Alexa app and I can read what you paid from its history.");
        const only = stock ? resolveSymbol(stock) : null;
        if (stock && !only) return fail(`I don't have a tokenized stock for "${stock}".`);
        const [basis, holdings, { board, readings }] = await Promise.all([within(readBasis(svc, wallet), 450), within(svc.holdings.read(wallet), 450), kit.allReadings()]);
        if (!basis) return fail("I'm reading your wallet's history on Solana for the first time. Ask me again in a minute.");
        if (!holdings) return fail("I couldn't read your wallet's balances just now. Try again in a moment.");
        const price = new Map(readings.map((r) => [r.ticker, r.tokenPrice]));
        const rows = holdings
          .filter((h) => (!only || h.ticker === only.ticker) && price.has(h.ticker))
          .map((h) => {
            const b = basis.positions[h.ticker];
            const avg = b && b.coveredQty > 1e-9 ? b.cost / b.coveredQty : null;
            const costed = avg === null ? 0 : Math.min(h.amount, b!.coveredQty);
            const p = price.get(h.ticker)!;
            const cost = avg === null ? 0 : avg * costed;
            const gain = avg === null ? 0 : (p - avg) * costed;
            return {
              ticker: h.ticker,
              held: h.amount,
              averageCost: avg === null ? null : Math.round(avg * 100) / 100,
              price: p,
              costUsd: Math.round(cost * 100) / 100,
              valueUsd: Math.round(h.amount * p * 100) / 100,
              gainUsd: Math.round(gain * 100) / 100,
              gainPercent: cost > 0 ? Math.round((gain / cost) * 10_000) / 100 : null,
              realizedUsd: Math.round((b?.realized ?? 0) * 100) / 100,
              buys: b?.buys ?? 0,
              sells: b?.sells ?? 0,
              uncostedQty: Math.max(0, h.amount - costed),
            };
          });
        const totalCost = rows.reduce((t, r) => t + r.costUsd, 0);
        const totalGain = rows.reduce((t, r) => t + r.gainUsd, 0);
        const data = {
          positions: rows,
          totalCostUsd: Math.round(totalCost * 100) / 100,
          totalValueUsd: Math.round(rows.reduce((t, r) => t + r.valueUsd, 0) * 100) / 100,
          totalGainUsd: Math.round(totalGain * 100) / 100,
          transactionsRead: basis.transactions,
          complete: !basis.truncated,
        };
        const note = board.source === "sample" ? "Using sample data. " : "";
        const upDown = (g: number) => `${g >= 0 ? "up" : "down"} ${usd(Math.abs(g))}`;
        const uncosted = rows.filter((r) => r.uncostedQty > 1e-6);
        const caveat = uncosted.length
          ? ` Some of your ${uncosted.map((r) => listingByTicker(r.ticker)?.token).join(" and ")} arrived without a USDC payment, so I don't know what it cost and left it out.`
          : "";
        const partial = basis.truncated ? ` That's from your last ${basis.transactions} transactions.` : "";
        if (only) {
          const r = rows[0];
          if (!r) return say(`${note}You don't hold any ${only.spoken} right now.`, data);
          const name = only.spoken;
          if (r.averageCost === null) return say(`${note}You hold ${r.held} ${only.token}, but none of it came from a USDC purchase I can see, so I can't say what you paid.${partial}`, data);
          const trades = `${r.buys === 1 ? "once" : `${r.buys} times`}${r.sells ? ` and sold ${r.sells === 1 ? "once" : `${r.sells} times`}` : ""}`;
          const realized = Math.abs(r.realizedUsd) >= 1 ? ` Sales ${r.realizedUsd >= 0 ? "locked in another" : "cost you"} ${usd(Math.abs(r.realizedUsd))}.` : "";
          return say(
            `${note}You've bought ${name} ${trades}, paying an average of ${usd(r.averageCost)} a token. At ${usd(r.price)} now, what you hold is ${upDown(r.gainUsd)}, or ${r.gainPercent! >= 0 ? "" : "minus "}${pctOf(r.gainPercent! / 100)}.${realized}${caveat}${partial}`,
            data,
          );
        }
        if (!rows.length) return say(`${note}You don't hold any tokenized stocks right now.`, data);
        const ranked = rows.filter((r) => r.gainPercent !== null).sort((a, b) => b.gainPercent! - a.gainPercent!);
        const name = (t: string) => listingByTicker(t)?.spoken ?? t;
        const best = ranked[0];
        const worst = ranked.at(-1);
        const spread =
          ranked.length > 1
            ? ` ${capitalise(name(best.ticker))} has done best, ${best.gainPercent! >= 0 ? "up" : "down"} ${pctOf(best.gainPercent! / 100)}; ${name(worst!.ticker)} ${worst!.gainPercent! >= 0 ? "the least, up" : "is down"} ${pctOf(worst!.gainPercent! / 100)}.`
            : "";
        return say(
          `${note}You paid ${usd(totalCost)} for what you hold, and it's ${upDown(totalGain)}${totalCost > 0 ? `, ${pctOf(totalGain / totalCost)}` : ""}, read from your wallet's history on Solana.${spread}${caveat}${partial}`,
          data,
        );
      }),
  );

  server.registerTool(
    "market_depth",
    {
      _meta: toolUiMeta("market_depth"),
      title: "How much size the token market can take",
      description:
        "Real quotes from Jupiter (the router that would fill a trade) at $100, $1,000 and $10,000, for buying or selling one tokenized stock right now: how much over (or under) the token's price each size would fill. On weekends and at night these markets are thinner than the stock exchange. Use for 'how deep is the Tesla market?', 'can I buy 10 thousand dollars of Nvidia without moving it?', 'how liquid is Palantir right now?'.",
      inputSchema: {
        stock: z.string().min(1),
        side: z.enum(["buy", "sell"]).optional().describe("Default buy."),
      },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        ticker: z.string(),
        side: z.enum(["buy", "sell"]),
        tokenPrice: z.number(),
        steps: z.array(z.object({ usd: z.number(), costPercent: z.number(), fillPrice: z.number() })),
        under1PercentUsd: z.number().nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stock, side }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return fail(`I don't have a tokenized stock for "${stock}".`);
        const { readings, session } = await kit.allReadings();
        const r = readings.find((x) => x.ticker === listing.ticker);
        if (!r) return fail(`I don't have a price for ${listing.spoken} right now.`);
        const s = side ?? "buy";
        const depth = await within(depthLadder(svc, listing.ticker, s, r.tokenPrice), 1200);
        if (!depth) return fail(`I'm still getting quotes for ${listing.spoken}. Ask me again in a few seconds.`);
        const cost = (bps: number) => (bps < 5 ? "almost nothing" : `about ${(bps / 100).toFixed(bps < 100 ? 2 : 1)} percent`);
        const ladder = depth.steps.map((st) => `${cost(st.impactBps)} for ${usd(st.usd)}`);
        const fine = sizeWithin(depth, 100);
        const verdict =
          fine === null
            ? "Even small trades are expensive right now; waiting for the market to open would likely fill better."
            : fine === depth.steps.at(-1)!.usd
              ? "It's deep enough for everyday sizes."
              : `Up to about ${usd(fine)} costs under 1 percent; beyond that, splitting the trade${session.isRegularHours ? "" : " or waiting for the open"} would likely fill better.`;
        const verb = s === "buy" ? "Buying" : "Selling";
        return say(
          `${depth.source === "sample" ? "Using sample data. " : ""}${verb} ${possessive(listing.spoken)} token right now costs ${listJoin(ladder)} over its price of ${usd(r.tokenPrice)}. ${verdict}`,
          {
            dataSource: depth.source,
            ticker: listing.ticker,
            side: s,
            tokenPrice: r.tokenPrice,
            steps: depth.steps.map((st) => ({ usd: st.usd, costPercent: st.impactBps / 100, fillPrice: Math.round(st.effectivePrice * 100) / 100 })),
            under1PercentUsd: fine,
          },
        );
      }),
  );

  server.registerTool(
    "set_trade_pin",
    {
      title: "Set, change or remove a spoken trade PIN",
      description:
        "Sets a 4 to 6 digit PIN that must be said before Afterhours prepares any trade or recurring buy, like a voice purchasing code: so a TV, a guest or a child can't get trades proposed. Changing or removing it needs the current PIN. Never repeat a PIN back to the user. Use for 'set a trade PIN', 'change my PIN', 'remove my trade PIN', 'do I have a PIN?'. Call with no arguments to check whether one is set.",
      inputSchema: {
        new_pin: z.string().optional().describe("The new PIN as said, digits or words."),
        current_pin: z.string().optional().describe("The current PIN, needed to change or remove one."),
        remove: z.boolean().optional(),
      },
      outputSchema: { pinSet: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ new_pin, current_pin, remove }) =>
      guard(async () => {
        const now = svc.now();
        const had = await hasPin(svc.store, caller.sub);
        if (!new_pin && !remove) {
          return say(had ? "Yes, trades need your PIN before I prepare them." : "You don't have a trade PIN. You can say, set a trade PIN.", { pinSet: had });
        }
        if (had) {
          const check = await checkPin(svc.store, caller.sub, current_pin, now);
          if (!check.ok) {
            return fail(check.reason === "missing" ? "To change or remove your PIN, I need your current one first." : pinRefusal(check, await getZone(svc.store, caller.sub)));
          }
        }
        if (remove) {
          await removePin(svc.store, caller.sub);
          return say(had ? "Your trade PIN is removed." : "You didn't have a trade PIN.", { pinSet: false });
        }
        const pin = normalisePin(new_pin!);
        if (!validPin(pin)) return fail("A trade PIN is 4 to 6 digits.");
        if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) return fail("That PIN is too easy to guess. Pick digits that aren't all the same or in a row.");
        await setPin(svc.store, caller.sub, pin);
        return say(`Done. ${had ? "Your new PIN is set." : "From now on I'll ask for your PIN before preparing a trade."} I won't say it back.`, { pinSet: true });
      }),
  );

  server.registerTool(
    "set_target_allocation",
    {
      title: "Set my target mix",
      description:
        "Sets the mix the user wants their tokenized stocks kept at, in percent per stock (summing to 100), for rebalancing. Use for 'keep me 60 percent S&P and 40 percent Nasdaq', 'my target is half Nvidia, half Apple', 'clear my targets', 'what's my target mix?'. Call with no arguments to read it.",
      inputSchema: {
        targets: z.array(z.object({ stock: z.string().min(1), percent: z.number().positive().max(100) })).max(10).optional(),
        clear: z.boolean().optional(),
      },
      outputSchema: { targets: z.array(z.object({ ticker: z.string(), percent: z.number() })) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ targets, clear }) =>
      guard(async () => {
        const name = (t: string) => listingByTicker(t)?.spoken ?? t;
        const out = (t: Record<string, number> | null) => ({ targets: Object.entries(t ?? {}).map(([ticker, f]) => ({ ticker, percent: Math.round(f * 1000) / 10 })) });
        if (clear) {
          await setTargets(svc.store, caller.sub, null);
          return say("Your target mix is cleared.", out(null));
        }
        if (!targets?.length) {
          const t = await getTargets(svc.store, caller.sub);
          if (!t) return say("You don't have a target mix. You can say, keep me 60 percent S&P and 40 percent Nasdaq.", out(null));
          return say(`Your target mix is ${listJoin(Object.entries(t).map(([k, f]) => `${Math.round(f * 100)} percent ${name(k)}`))}.`, out(t));
        }
        const mix: Record<string, number> = {};
        for (const { stock, percent } of targets) {
          const l = resolveSymbol(stock);
          if (!l) return fail(`I don't have a tokenized stock for "${stock}".`);
          mix[l.ticker] = (mix[l.ticker] ?? 0) + percent;
        }
        const total = Object.values(mix).reduce((a, b) => a + b, 0);
        if (Math.abs(total - 100) > 1) return fail(`Those add up to ${Math.round(total)} percent. A target mix needs to add up to 100.`);
        const fractions = Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, v / total]));
        await setTargets(svc.store, caller.sub, fractions);
        return say(
          `Done. Your target mix is ${listJoin(Object.entries(fractions).map(([k, f]) => `${Math.round(f * 100)} percent ${name(k)}`))}. Ask me to check my balance against it any time.`,
          out(fractions),
        );
      }),
  );

  server.registerTool(
    "rebalance",
    {
      _meta: toolUiMeta("rebalance"),
      title: "Rebalance to my target mix",
      description:
        "Compares the user's holdings with their target mix and works out the sells and buys that bring it back, paid for by the sales (no new money). Without confirm, it only explains the drift and the trades it would propose. With confirm (after the user says yes), it prepares those trades for the user to sign in their wallet, sales first. Use for 'how far am I from my target?', 'rebalance my portfolio', 'yes, rebalance now'.",
      inputSchema: {
        confirm: z.boolean().optional().describe("True only after the user has heard the plan and said to go ahead."),
        pin: z.string().optional().describe("The user's trade PIN, if they have one; needed with confirm."),
      },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        baseUsd: z.number(),
        rows: z.array(z.object({ ticker: z.string(), valueUsd: z.number(), percent: z.number(), targetPercent: z.number() })),
        legs: z.array(z.object({ ticker: z.string(), side: z.enum(["buy", "sell"]), usd: z.number(), code: z.string().nullable() })),
        prepared: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ confirm, pin }) =>
      guard(async () => {
        const targets = await getTargets(svc.store, caller.sub);
        if (!targets) return fail("You haven't set a target mix yet. You can say, keep me 60 percent S&P and 40 percent Nasdaq.");
        const wallet = caller.wallet ?? (svc.sample ? "" : null);
        if (wallet === null) return fail("No wallet is linked yet. Link one in the Alexa app first.");
        const [holdings, { board, readings, now }] = await Promise.all([within(svc.holdings.read(wallet), 450), kit.allReadings()]);
        if (!holdings) return fail("I couldn't read your wallet's balances just now. Try again in a moment.");
        const price = new Map(readings.map((r) => [r.ticker, r.tokenPrice]));
        const values = Object.fromEntries(holdings.filter((h) => price.has(h.ticker)).map((h) => [h.ticker, h.amount * price.get(h.ticker)!]));
        const plan = planRebalance(targets, values);
        const name = (t: string) => listingByTicker(t)?.spoken ?? t;
        const pctN = (f: number) => Math.round(f * 100);
        const data = (codes: Record<string, string> = {}) => ({
          dataSource: board.source,
          baseUsd: Math.round(plan.baseUsd * 100) / 100,
          rows: plan.rows.map((r) => ({ ticker: r.ticker, valueUsd: Math.round(r.valueUsd * 100) / 100, percent: Math.round(r.weight * 1000) / 10, targetPercent: Math.round(r.target * 1000) / 10 })),
          legs: plan.legs.map((l) => ({ ...l, code: codes[`${l.side}:${l.ticker}`] ?? null })),
          prepared: Object.keys(codes).length > 0,
        });
        const note = board.source === "sample" ? "Using sample data. " : "";
        if (plan.baseUsd < 1) return fail("You don't hold any of the stocks in your target mix yet, so there's nothing to rebalance. A buy would start it.");
        const off = plan.rows.filter((r) => Math.abs(r.weight - r.target) >= 0.02).map((r) => `${name(r.ticker)} is ${pctN(r.weight)} percent against a ${pctN(r.target)} percent target`);
        if (!plan.legs.length) return say(`${note}You're within 2 percent of your target mix, so there's nothing worth trading.`, data());
        const legsSaid = listJoin(plan.legs.map((l) => `${l.side} ${usd(l.usd)} of ${name(l.ticker)}`));
        if (!confirm) {
          return say(`${note}${capitalise(listJoin(off))}. To get back, I'd ${legsSaid}, paid for by the sale${plan.legs.filter((l) => l.side === "sell").length > 1 ? "s" : ""}. Say rebalance now and I'll prepare them for you to sign.`, data());
        }
        if (!caller.wallet) return fail("No wallet is linked yet. Link one in the Alexa app first.");
        const pinCheck = await checkPin(svc.store, caller.sub, pin, now);
        if (!pinCheck.ok) return fail(pinRefusal(pinCheck, await getZone(svc.store, caller.sub)));
        const sleepRules = await getGuardrails(svc.store, caller.sub, now);
        const sleepZone = await getZone(svc.store, caller.sub);
        if (sleepRules.sleep && inWindow(zoneParts(new Date(now), sleepZone.tz).minutes, sleepRules.sleep)) {
          return fail(`Sleep mode is on until ${spokenTime(sleepRules.sleep.to)}, so I won't prepare a rebalance now. Ask me again in the morning.`);
        }
        const cap = maxTradeUsd();
        if (plan.legs.some((l) => l.usd > cap)) return fail(`One of those trades is over the ${usd(cap)} I can prepare by voice. You can rebalance in smaller steps, or from the companion app.`);
        const zone = await getZone(svc.store, caller.sub);
        const rules = await getGuardrails(svc.store, caller.sub, now);
        const buying = plan.legs.filter((l) => l.side === "buy").reduce((t, l) => t + l.usd, 0);
        if (rules.dailyLimitUsd !== null && (await spentToday(svc.store, caller.sub, zone, now)) + buying > rules.dailyLimitUsd + 0.001) {
          return fail(`The buys add up to ${usd(buying)}, which is over your ${usd(rules.dailyLimitUsd)} daily limit. Nothing was prepared.`);
        }
        const codes: Record<string, string> = {};
        for (const l of plan.legs) {
          const intent = await createIntent(svc.store, { sub: caller.sub, wallet: caller.wallet, ticker: l.ticker, side: l.side, usd: l.usd, priceAtProposal: price.get(l.ticker)! }, now, 30 * 60);
          if (l.side === "buy") await recordSpend(svc.store, caller.sub, zone, now, intent.id, l.usd);
          codes[`${l.side}:${l.ticker}`] = intent.code;
        }
        // In order, as sentences, so the codes don't run together when spoken.
        const spoken = plan.legs.map((l, i) => `${i === 0 ? capitalise(l.side) : `Then ${l.side}`} ${usd(l.usd)} of ${name(l.ticker)}, code ${codes[`${l.side}:${l.ticker}`].split("").join(" ")}.`);
        return say(`${note}${plan.legs.length} trades are ready to sign for the next 30 minutes, sales first so they pay for the buys. ${spoken.join(" ")} They're also in the Afterhours app.`, data(codes));
      }),
  );

  server.registerTool(
    "how_did_the_open_go",
    {
      _meta: toolUiMeta("how_did_the_open_go"),
      title: "Did the overnight move hold at the open?",
      description:
        "After the US market opens, compares how each share actually opened with the move its token had called overnight, for one stock or for the names the user holds and watches. Use for 'how did the open go?', 'did Tesla's weekend move hold?', 'was the token right this morning?'.",
      inputSchema: { stock: z.string().optional() },
      outputSchema: {
        dataSource: z.enum(["live", "sample"]),
        date: z.string().nullable(),
        results: z.array(z.object({ ticker: z.string(), calledPercent: z.number(), openPercent: z.number(), held: z.boolean() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ stock }) =>
      guard(async () => {
        const only = stock ? resolveSymbol(stock) : null;
        if (stock && !only) return fail(`I don't have a tokenized stock for "${stock}".`);
        const now = svc.now();
        let date: string | null = null;
        let results: OpenResult[] = [];
        if (svc.sample) {
          const pick = only ? [only.ticker] : ["TSLA", "NVDA", "AAPL"];
          results = pick.map((t) => {
            const last = sampleOpens(t, now).at(-1)!;
            date = last.date;
            return { ticker: t, calledBps: last.overnightBps, openBps: last.openBps };
          });
        } else {
          for (let back = 0; back < 5 && !results.length; back += 1) {
            const d = toEasternParts(new Date(now - back * 86_400_000)).date;
            const found = await svc.store.get<OpenResult[]>(openKey(d));
            if (found?.length) {
              date = d;
              results = found;
            }
          }
          if (!results.length) {
            const s = getMarketSession(new Date(now));
            return fail(s.isRegularHours ? "I'm still scoring this morning's open. Ask again in a few minutes." : "I don't have a recent open scored yet. It's ready a few minutes after 9:30 a.m. Eastern.");
          }
          const mine = new Set([...(caller.wallet ? ((await within(svc.holdings.read(caller.wallet), 400)) ?? []).map((h) => h.ticker) : []), ...(await getWatchlist(svc.store, caller.sub))]);
          results = only
            ? results.filter((r) => r.ticker === only.ticker)
            : [...results].sort((a, b) => Number(mine.has(b.ticker)) - Number(mine.has(a.ticker)) || Math.abs(b.calledBps) - Math.abs(a.calledBps)).slice(0, 3);
          if (!results.length) return fail(`I didn't score ${only!.spoken} at that open.`);
        }
        const held = (r: OpenResult) => Math.abs(r.calledBps) < 20 || Math.sign(r.calledBps) === Math.sign(r.openBps);
        const pctS = (b: number) => `${b >= 0 ? "up" : "down"} ${(Math.abs(b) / 100).toFixed(1)} percent`;
        const lines = results.map((r) => {
          const n = listingByTicker(r.ticker)?.spoken ?? r.ticker;
          return `${capitalise(n)} opened ${pctS(r.openBps)}; its token had called ${pctS(r.calledBps)}${held(r) ? "" : ", so that one didn't hold"}.`;
        });
        const when = date === toEasternParts(new Date(now)).date ? "This morning" : `At the ${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} open`;
        return say(`${svc.sample ? "Using sample data. " : ""}${when}: ${lines.join(" ")}`, {
          dataSource: svc.sample ? "sample" : "live",
          date,
          results: results.map((r) => ({ ticker: r.ticker, calledPercent: r.calledBps / 100, openPercent: r.openBps / 100, held: held(r) })),
        });
      }),
  );

  server.registerTool(
    "weekly_recap",
    {
      _meta: toolUiMeta("weekly_recap"),
      title: "How was my week?",
      description:
        "The user's week in tokenized stocks: how their holdings moved over seven days, which led and lagged, how many recurring buys they signed, and how many alerts went off. Can also turn on or off a recap pushed Sunday at 6 p.m. their time. Use for 'how was my week?', 'weekly recap', 'send me a recap every Sunday', 'stop the weekly recap'.",
      inputSchema: { push: z.boolean().optional().describe("True to get it pushed every Sunday evening, false to stop. Omit to just hear it.") },
      outputSchema: {
        dataSource: z.enum(["live", "sample"]),
        changeUsd: z.number().nullable(),
        changePercent: z.number().nullable(),
        best: z.object({ ticker: z.string(), percent: z.number() }).nullable(),
        worst: z.object({ ticker: z.string(), percent: z.number() }).nullable(),
        recurringRuns: z.number(),
        recurringSigned: z.number(),
        alertsFired: z.number(),
        pushOn: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ push }) =>
      guard(async () => {
        if (push !== undefined) await setWeekly(svc, caller.sub, push);
        const wallet = caller.wallet ?? (svc.sample ? "" : null);
        const [holdings, { readings }] = await Promise.all([wallet === null ? Promise.resolve(null) : within(svc.holdings.read(wallet), 450), kit.allReadings()]);
        const recap = await weekRecap(svc, caller.sub, holdings, new Map(readings.map((r) => [r.ticker, r.tokenPrice])));
        const on = await weeklyOn(svc, caller.sub);
        const pushNote = push === true ? " I'll send this to your phone every Sunday at 6 p.m." : push === false ? " I've stopped the Sunday recap." : "";
        return say(`${svc.sample ? "Using sample data. " : ""}${recapSentence(recap)}${pushNote}`, {
          dataSource: svc.sample ? "sample" : "live",
          changeUsd: recap.changeUsd,
          changePercent: recap.changePercent,
          best: recap.best,
          worst: recap.worst,
          recurringRuns: recap.recurring.runs,
          recurringSigned: recap.recurring.signed,
          alertsFired: recap.alertsFired,
          pushOn: on,
        });
      }),
  );

  server.registerTool(
    "my_activity",
    {
      title: "What's changed on my account",
      description:
        "Reads back the account's activity log: changes made through Afterhours (limits, PINs, trades proposed, signed or confirmed, recurring buys, alerts) and background events (trades confirmed, wallet movements), newest first, with when. Use for 'what did I do on my account?', 'what's changed recently?', 'did anyone try to trade on my account?'.",
      inputSchema: { count: z.number().int().min(1).max(10).optional().describe("How many entries to read out. Default 5.") },
      outputSchema: { entries: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string(), ok: z.boolean() })), total: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ count }) =>
      guard(async () => {
        const all = await readActivity(svc.store, caller.sub);
        const recent = all.slice(-(count ?? 5)).reverse();
        const data = { entries: recent.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, text: e.text, ok: e.ok })), total: all.length };
        if (!recent.length) return say("Nothing has changed on your account through Afterhours yet.", data);
        const now = svc.now();
        const zone = await getZone(svc.store, caller.sub);
        const failed = all.filter((e) => !e.ok && now - e.at < 7 * 86_400_000 && /PIN/.test(e.text)).length;
        const lines = recent.map((e) => `${capitalise(whenSpoken(e.at, now, zone))}: ${e.text.replace(/\.$/, "")}.`);
        return say(`${failed ? `Heads up: ${failed === 1 ? "one wrong PIN was" : `${failed} wrong PINs were`} tried this week. ` : ""}Most recent first. ${lines.join(" ")}`, data);
      }),
  );

  server.registerTool(
    "delete_my_data",
    {
      title: "Delete everything Afterhours keeps about me",
      description:
        "Deletes every setting and record Afterhours keeps for this account (alerts, limits, PIN, watchlist, briefings, recurring buys, target mix, activity log, notification devices) and cancels anything waiting to be signed or triggered. Nothing on Solana or in the wallet is touched. Without confirm it explains what will go and asks; call with confirm only after the user says yes. Use for 'delete my data', 'forget me', 'erase my account'.",
      inputSchema: {
        confirm: z.boolean().optional().describe("True only after the user has heard what will be deleted and said yes."),
        pin: z.string().optional().describe("The trade PIN, if the account has one."),
      },
      outputSchema: { deleted: z.boolean(), records: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ confirm, pin }) =>
      guard(async () => {
        if (!confirm) {
          return say(
            "That deletes everything Afterhours keeps for you: alerts, limits, your PIN, watchlist, briefings, recurring buys, your target mix and the activity log, and it cancels anything waiting to be signed. Your wallet and everything on Solana stay as they are. Say yes, delete everything, to go ahead.",
            { deleted: false, records: 0 },
          );
        }
        const pinCheck = await checkPin(svc.store, caller.sub, pin, svc.now());
        if (!pinCheck.ok) return fail(pinCheck.reason === "missing" ? "Your account has a trade PIN. Say it to confirm deleting everything." : pinRefusal(pinCheck, await getZone(svc.store, caller.sub)));
        const g = await getGuardrails(svc.store, caller.sub, svc.now());
        const guarded = g.dailyLimitUsd !== null || Boolean(g.sleep);
        const records = await deleteData(svc, caller.sub, caller.wallet);
        return say(
          `Done. Everything Afterhours kept for you is deleted, anything waiting was cancelled, and this link is ending.${guarded ? " Your spending limit and sleep mode stay in force for 24 hours, then they go too." : ""} Your wallet is untouched. To link again, use the Alexa app.`,
          { deleted: true, records },
        );
      }),
  );

  server.registerTool(
    "sector_moves",
    {
      title: "How a sector, or every sector, is moving",
      description:
        "How groups of tokenized stocks are moving against their shares (since the last close while the market is shut, against live prices when it's open): every sector ranked, or one sector's members. Sectors: tech (chips, software and cloud, internet and media), consumer, banks and payments, crypto stocks, healthcare, energy and industrials, index funds. Use for 'how's tech doing tonight?', 'what are chip stocks doing?', 'which sectors are moving?', 'how's pharma?'.",
      inputSchema: { sector: z.string().optional().describe("A sector as said, e.g. 'tech', 'chips', 'banks', 'pharma'. Omit for all.") },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        sectors: z.array(z.object({ id: z.string(), name: z.string(), gapPercent: z.number(), members: z.number() })),
        members: z.array(z.object({ ticker: z.string(), name: z.string(), gapPercent: z.number() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sector }) =>
      guard(async () => {
        const { board, readings } = await kit.allReadings();
        const note = board.source === "sample" ? "Using sample data. " : "";
        const word = (bps: number) => `${bps >= 0 ? "up" : "down"} ${(Math.abs(bps) / 100).toFixed(1)} percent`;
        const since = readings.find((r) => r.kind === "overnight_move" || r.kind === "in_line")?.referenceLabel;
        const against = readings.some((r) => r.kind === "live_gap") ? "against live share prices" : since ? `since ${since}` : "";
        if (!sector) {
          const all = rankByGap(sectorReadings(readings, SECTORS));
          const data = { dataSource: board.source, sectors: all.map((r) => ({ id: r.ticker.slice(7), name: r.spoken, gapPercent: r.gapBps! / 100, members: sectorById(r.ticker.slice(7))!.members.length })), members: [] };
          if (!all.length) return fail("I don't have enough prices to compare sectors right now.");
          const moving = all.filter((r) => Math.abs(r.gapBps!) >= NOISE_FLOOR_BPS);
          if (!moving.length) return say(`${note}Every sector is within normal noise ${against}.`, data);
          const top = moving.slice(0, 3).map((r) => `${r.spoken} ${word(r.gapBps!)}`);
          const quiet = all.length - moving.length;
          return say(`${note}On average ${against}: ${listJoin(top)}${quiet ? `; ${quiet === 1 ? "one sector is" : `${quiet} sectors are`} flat` : ""}.`, data);
        }
        const s = resolveSector(sector);
        if (!s) return fail(`I don't know a sector called "${sector}". Try tech, chips, banks, crypto, healthcare, energy or consumer.`);
        const mine = rankByGap(readings.filter((r) => s.members.includes(r.ticker) && r.gapBps !== null));
        const avg = sectorReadings(readings, [s])[0];
        if (!avg) return fail(`I don't have enough prices for ${s.spoken} right now.`);
        const lead = mine.slice(0, 3).map((r) => `${r.spoken} ${word(r.gapBps!)}`);
        const last = mine.at(-1)!;
        return say(
          `${note}${capitalise(s.spoken)} ${s.spoken.endsWith("s") ? "are" : "is"} ${word(avg.gapBps!)} on average ${against}. Biggest: ${listJoin(lead)}${mine.length > 3 ? `; ${last.spoken} moved least, ${word(last.gapBps!)}` : ""}.`,
          {
            dataSource: board.source,
            sectors: [{ id: s.id, name: s.spoken, gapPercent: avg.gapBps! / 100, members: s.members.length }],
            members: mine.map((r) => ({ ticker: r.ticker, name: r.spoken, gapPercent: r.gapBps! / 100 })),
          },
        );
      }),
  );

  server.registerTool(
    "market_calendar",
    {
      title: "Is the market open on a day? Upcoming holidays",
      description:
        "Says whether the US stock market is open on a given day (a holiday name like Thanksgiving, a date, a weekday, tomorrow), including early closes, or lists the next closures. Tokenized stocks trade every day regardless. Use for 'is the market open on Thanksgiving?', 'is the market open Friday?', 'when's the next market holiday?', 'is Christmas Eve a half day?'.",
      inputSchema: { day: z.string().optional().describe("The day as said. Omit for the next holidays and early closes.") },
      outputSchema: {
        days: z.array(z.object({ date: z.string(), status: z.enum(["open", "closed", "half_day", "weekend", "unknown"]), label: z.string().nullable() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ day }) =>
      guard(async () => {
        const today = todayEt(svc.now());
        const tokens = "Tokenized stocks still trade around the clock.";
        if (!day) {
          const next = upcoming(today, 3);
          if (!next.length) return fail("My market calendar doesn't reach that far yet.");
          const said = next.map((d) => (d.status === "half_day" ? `an early close at 1 p.m. on ${spokenDate(d.date)} (${d.label})` : `${d.label} on ${spokenDate(d.date)}`));
          return say(`The next market closures: ${listJoin(said)}. ${tokens}`, { days: next });
        }
        const date = resolveDay(day, today);
        if (!date) return fail(`I didn't catch a day in "${day}". Try a date like December 24, or a holiday like Thanksgiving.`);
        const v = dayStatus(date);
        const when = date === today ? "today" : spokenDate(date);
        const text = {
          open: `Yes, the market is open ${date === today ? "today" : `on ${when}`}, 9:30 a.m. to 4 p.m. Eastern.`,
          half_day: `It's open ${date === today ? "today" : `on ${when}`}, but closes early, at 1 p.m. Eastern, for ${v.label}.`,
          closed: `No. The market is closed ${date === today ? "today" : `on ${when}`} for ${v.label}. ${tokens}`,
          weekend: `No, ${date === today ? "today" : when} is a weekend. ${tokens}`,
          unknown: "My market calendar doesn't cover that date yet.",
        }[v.status];
        return say(text, { days: [v] });
      }),
  );

  server.registerTool(
    "compare_stocks",
    {
      title: "Compare two to four tokenized stocks",
      description:
        "Side by side: each name's token price and its move against the share (since the last close while the market is shut), with how strongly each tends to move with the market. Use for 'compare Tesla and Nvidia', 'Apple versus Microsoft', 'which is doing better, Coinbase or Strategy?'.",
      inputSchema: { stocks: z.array(z.string().min(1)).min(2).max(4).describe("The names or tickers as said.") },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        rows: z.array(z.object({ ticker: z.string(), name: z.string(), tokenPrice: z.number(), gapPercent: z.number().nullable(), beta: z.number().nullable() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stocks }) =>
      guard(async () => {
        const listings = stocks.map((x) => ({ said: x, l: resolveSymbol(x) }));
        const unknown = listings.filter((x) => !x.l).map((x) => `"${x.said}"`);
        if (unknown.length) return fail(`I don't have a tokenized stock for ${listJoin(unknown)}.`);
        const { board, readings } = await kit.allReadings();
        const betas = await readBetas(svc);
        const rows = [...new Map(listings.map((x) => [x.l!.ticker, x.l!])).values()].map((l) => {
          const r = readings.find((x) => x.ticker === l.ticker);
          return { ticker: l.ticker, name: l.spoken, tokenPrice: r?.tokenPrice ?? 0, gapPercent: r?.gapBps == null ? null : r.gapBps / 100, beta: betas[l.ticker]?.beta ?? null, r };
        });
        if (rows.some((x) => !x.r)) return fail(`I don't have a price for ${listJoin(rows.filter((x) => !x.r).map((x) => x.name))} right now.`);
        const since = rows.find((x) => x.r!.kind === "overnight_move" || x.r!.kind === "in_line")?.r!.referenceLabel;
        const moved = (g: number | null) => (g === null ? "with no reference" : Math.abs(g) < 0.2 ? "flat" : `${g >= 0 ? "up" : "down"} ${Math.abs(g).toFixed(1)} percent`);
        const parts = rows.map((x) => `${possessive(x.name)} token is ${moved(x.gapPercent)}, at ${usd(x.tokenPrice)}`);
        const ranked = [...rows].filter((x) => x.gapPercent !== null).sort((a, b) => b.gapPercent! - a.gapPercent!);
        const lead = ranked.length > 1 && ranked[0].gapPercent! - ranked.at(-1)!.gapPercent! >= 0.2 ? ` ${capitalise(ranked[0].name)} is ahead.` : " They're moving about the same.";
        const withBeta = rows.filter((x) => x.beta !== null);
        const swing = withBeta.length === rows.length ? ` Usually, ${listJoin(withBeta.map((x) => `${x.name} moves about ${x.beta!.toFixed(1)} times the market`))}.` : "";
        return say(`${board.source === "sample" ? "Using sample data. " : ""}${since ? `Since ${since}, ` : ""}${listJoin(parts)}.${lead}${swing}`, {
          dataSource: board.source,
          rows: rows.map(({ r: _r, ...x }) => x),
        });
      }),
  );

  server.registerTool(
    "find_dislocations",
    {
      title: "Tokens out of line with their live shares",
      description:
        "During US market hours, finds tokenized stocks trading away from their live share price by more than it would cost to trade them (Jupiter's real quote at $1,000), biggest net gap first. Outside market hours, explains why a gap then is a bet on the open, not a dislocation. Use for 'any tokens mispriced right now?', 'where's the biggest gap against the stock?', 'find me dislocations'.",
      inputSchema: { size_usd: z.number().positive().max(100_000).optional().describe("Trade size to cost against. Default $1,000.") },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        marketOpen: z.boolean(),
        sizeUsd: z.number(),
        rows: z.array(z.object({ ticker: z.string(), name: z.string(), gapPercent: z.number(), costPercent: z.number(), netPercent: z.number(), side: z.enum(["buy", "sell"]) })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ size_usd }) =>
      guard(async () => {
        const size = size_usd ?? 1000;
        const { board, readings, session } = await kit.allReadings();
        const note = board.source === "sample" ? "Using sample data. " : "";
        const base = { dataSource: board.source, marketOpen: session.isRegularHours, sizeUsd: size };
        if (!session.isRegularHours) {
          return say(
            `${note}The share market is shut, so a token's move now is a bet on the next open, not a gap anyone can close against the stock. Ask me during market hours, 9:30 a.m. to 4 p.m. Eastern, and I'll look for real dislocations.`,
            { ...base, rows: [] },
          );
        }
        // The biggest live gaps, then what it would cost to trade each.
        const live = readings.filter((r) => r.kind === "live_gap" && r.gapBps !== null && Math.abs(r.gapBps) >= 10);
        const top = [...live].sort((a, b) => Math.abs(b.gapBps!) - Math.abs(a.gapBps!)).slice(0, 6);
        const costed = await Promise.all(
          top.map(async (r) => {
            // A rich token is sold (or not bought); a cheap one is bought.
            const side: "buy" | "sell" = r.gapBps! < 0 ? "buy" : "sell";
            const cost = await within(impactAt(svc, r.ticker, side, size, r.tokenPrice), 900);
            return cost ? { r, side, costBps: cost.impactBps, netBps: Math.abs(r.gapBps!) - cost.impactBps } : null;
          }),
        );
        const rows = costed
          .filter((x): x is NonNullable<typeof x> => x !== null && x.netBps > 0)
          .sort((a, b) => b.netBps - a.netBps)
          .map((x) => ({ ticker: x.r.ticker, name: x.r.spoken, gapPercent: x.r.gapBps! / 100, costPercent: Math.round(x.costBps) / 100, netPercent: Math.round(x.netBps) / 100, side: x.side }));
        if (!rows.length) {
          return say(`${note}Nothing worth it right now: every token is within its trading cost of its share price at ${usd(size)}.`, { ...base, rows });
        }
        const said = rows.slice(0, 3).map((x) => `${x.name}, ${x.gapPercent > 0 ? "rich" : "cheap"} by ${Math.abs(x.gapPercent).toFixed(2)} percent against about ${x.costPercent.toFixed(2)} to trade`);
        return say(
          `${note}Against live share prices, at ${usd(size)}: ${listJoin(said)}. That's before any fees on the stock side, and gaps like these usually close fast.`,
          { ...base, rows },
        );
      }),
  );
}
