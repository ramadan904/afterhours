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
import { COOLING_OFF_MS, DEFAULT_SLEEP, getGuardrails, setDailyLimit, setSleep, spentToday } from "../chain/guardrails.js";
import { getZone, zoneName } from "../market/zones.js";
import { clockTime, usd } from "../market/speech.js";
import { parseTime, spokenTime } from "../notify/briefing.js";
import { addPlan, cadencePhrase, listPlans, MAX_PLANS, parseWeekday, planRecord, removePlans, type Cadence } from "../chain/recurring.js";
import { listingByTicker, resolveSymbol } from "../market/universe.js";
import { listSubscriptions } from "../notify/push.js";

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
          await setSleep(svc.store, caller.sub, null, now);
          return say("Sleep mode is off. Trades are prepared whenever you ask.", data(null));
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
        await setSleep(svc.store, caller.sub, sleep, now);
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
      },
      outputSchema: { plan: planOut, plans: z.number(), max: z.number(), devices: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ stock, amount_usd, cadence, day, time }) =>
      guard(async () => {
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
        const devices = (await listSubscriptions(svc, caller.sub)).length;
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
}
