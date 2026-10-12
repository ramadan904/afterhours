/**
 * The Afterhours tools, as Alexa+ sees them.
 *
 * Each tool returns two things: one or two sentences written to be spoken
 * (the `text` content), and a structured result with the exact numbers for any
 * client that renders a screen. Descriptions are written for the model that
 * picks tools, which is why they say what a user would ask, not what the code
 * does.
 *
 * Annotations are truthful rather than optimistic. Reads are `readOnlyHint`.
 * Removing an alert is `destructiveHint`. Proposing a trade is *not*
 * destructive — it moves nothing; the account holder's wallet signature does —
 * and the description says so, so the model never tells someone a trade has
 * happened when it has only been proposed.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Services } from "../services.js";
import { toolUiMeta } from "./apps.js";
import { recordToolTime } from "../http/stats.js";
import { LISTINGS, listingByTicker, resolveSymbol } from "../market/universe.js";
import { getMarketSession } from "../market/session.js";
import { rankByGap, readGap, NOISE_FLOOR_BPS, type GapReading } from "../market/gap.js";
import { MAX_WATCHED, editWatchlist, getWatchlist } from "../market/watchlist.js";
import { valuePortfolio } from "../market/portfolio.js";
import { DAYS_SPOKEN, getBriefing, parseTime, setBriefing, spokenTime, type BriefingDays } from "../notify/briefing.js";
import { listSubscriptions } from "../notify/push.js";
import { aroundTime, capitalise, gapSentence, move, pct, sessionSentence, usd, verdictSentence, nextOpenPhrase, whenSpoken } from "../market/speech.js";
import { PriceSourceError, type Board } from "../market/prices.js";
import { alertNews, isPriceAlert, listAlerts, removeAlert, upsertAlert, MAX_ALERTS } from "../market/alerts.js";
import { overnightRange, readTape, type OvernightRange } from "../market/tape.js";
import { armIntent, createIntent, getIntent, intentByCode, maxTradeUsd, recentlyTriggered, saveIntent, type TradeIntent } from "../chain/trade.js";
import { readOpens, sampleOpens, trackRecord, type OpenRecord } from "../market/history.js";
import { EASTERN, getZone, resolveZone, setZone, zoneName, type Zone } from "../market/zones.js";

export interface Caller {
  sub: string;
  wallet: string | null;
}

export function callerFrom(authInfo: AuthInfo | undefined): Caller {
  const extra = (authInfo?.extra ?? {}) as { sub?: string; wallet?: string | null };
  return { sub: extra.sub ?? "local", wallet: extra.wallet ?? null };
}

type Result = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function say(text: string, data?: Record<string, unknown>): Result {
  return data ? { content: [{ type: "text", text }], structuredContent: data } : { content: [{ type: "text", text }] };
}

function fail(text: string): Result {
  return { content: [{ type: "text", text }], isError: true };
}

const KNOWN = `${LISTINGS.length} names, Tesla, Nvidia, Apple, Netflix, Palantir and the S&P 500 among them`;

function unknownStock(said: string): Result {
  return fail(`I don't have a tokenized stock for "${said}". I can check ${KNOWN}.`);
}

function sampleNote(board: Board): string {
  return board.source === "sample" ? "Using sample data. " : "";
}

/** Answers for the explain tool: two or three sentences each, written to be heard. */
export const EXPLAIN = {
  tokenized_stocks:
    "A tokenized stock is a token on a blockchain, here Solana, that tracks a real company's share, like Tesla or Apple. Each one is backed by a real share held by the issuer, and you hold the token in your own crypto wallet.",
  after_hours:
    "The US stock market is open about 33 hours a week, but blockchains never close, so tokenized stocks trade all 168. Nights, weekends and holidays, the token keeps moving while the real share can't.",
  price_gap:
    "While the market is shut, the token's price is the crowd's guess at where the share will open, so it drifts away from the last close. When the market reopens, the share sets a real price again and the gap usually closes. A gap while both are trading is different: that one can be hedged.",
  trading_safety:
    "I can prepare a trade, but I can never make one. I read you a six-digit code; you open the confirm page, check a fresh quote, and sign it in your own wallet. Afterhours holds no keys, so nothing moves without your signature.",
  what_you_can_do:
    "Ask me what happened overnight, how a stock like Tesla is doing, or how your portfolio did since the close. I can watch a stock for a percent move or a price and tell you when it went off, and I can prepare a trade for you to sign in your wallet, now or when a price is reached. Tell me where you are, and I'll give you times in your own time zone.",
} as const;

/** The open history for a name: sample records with sample data, stored ones otherwise. */
async function opensFor(svc: Services, ticker: string): Promise<OpenRecord[]> {
  return svc.sample ? sampleOpens(ticker, svc.now()) : readOpens(svc, ticker);
}

/** "Its token has called the open's direction 12 of the last 14 times." */
export function trackClause(records: OpenRecord[]): string | null {
  const t = trackRecord(records);
  if (t.calls < 5) return null;
  return `Its token has called the open's direction ${t.sameDirection} of the last ${t.calls} times.`;
}

/** "Tesla's", "the S&P 500 fund's". */
function possessiveName(spoken: string): string {
  return `${spoken}'s`;
}

/** "4 7 2 9 1 3": digits spaced so a speech engine reads them one by one. */
export function spokenCode(code: string): string {
  return code.split("").join(" ");
}

/** "afterhours dot app slash go", from the public URL. */
export function spokenUrl(baseUrl: string, path: string): string {
  const host = new URL(baseUrl).host.replace(/^www\./, "");
  return `${host}${path}`.replace(/\./g, " dot ").replace(/\//g, " slash ").replace(/:/g, " colon ");
}

const readingShape = {
  ticker: z.string(),
  token: z.string(),
  name: z.string(),
  tokenPrice: z.number(),
  sharePrice: z.number().nullable(),
  gapPercent: z.number().nullable(),
  kind: z.enum(["in_line", "overnight_move", "live_gap", "stale_reference", "no_reference"]),
  comparedWith: z.string(),
  referenceAt: z.string().nullable(),
};

function readingOut(r: GapReading) {
  return {
    ticker: r.ticker,
    token: r.token,
    name: r.spoken,
    tokenPrice: r.tokenPrice,
    sharePrice: r.sharePrice,
    gapPercent: r.gapBps === null ? null : Math.round(r.gapBps) / 100,
    kind: r.kind,
    comparedWith: r.referenceLabel,
    referenceAt: r.referenceAt,
  };
}

/** Short form for lists: "Coinbase up 3.9 percent". */
function shortMove(r: GapReading): string {
  if (r.gapBps === null) return r.spoken;
  const verb = r.kind === "live_gap" ? (r.gapBps > 0 ? "above its share by" : "below its share by") : r.gapBps > 0 ? "up" : "down";
  return `${r.spoken} ${verb} ${pct(r.gapBps)}`;
}

/**
 * One sentence on how the night went, when the tape says something the
 * current number doesn't: a run-up that faded, or a dip that recovered.
 * Needs at least half an hour of samples to say anything.
 */
export function rangeSentence(r: GapReading, range: OvernightRange | null, now: number, zone: Zone = EASTERN): string | null {
  if (!range || range.samples < 6 || r.gapBps === null) return null;
  const current = r.gapBps;
  const up = current >= 0;
  const extreme = up ? range.high : range.low;
  if (Math.abs(extreme.bps) < 20) return null;
  // "Overnight" only fits a single night; over a weekend, name the close.
  const overnight = r.referenceLabel === "yesterday's close" || r.referenceLabel === "today's close";
  const lead = overnight ? "Overnight it" : `Since ${r.referenceLabel} it`;
  if (Math.abs(extreme.bps - current) >= 40) {
    return `${lead} ${up ? "peaked at" : "fell as far as"} ${move(extreme.bps)} ${aroundTime(extreme.at, now, zone)}, and has ${up ? "faded" : "recovered"} since.`;
  }
  return `That's close to its ${up ? "high" : "low"} ${overnight ? "of the night" : `since ${r.referenceLabel}`}.`;
}

/** Values holdings at token prices, with each one's move against its share. */
/**
 * Waits for `work` at most `ms`, then gives up with null. Used where an
 * optional extra (the wallet in a briefing) must never cost the voice turn
 * its latency budget; the RPC cache means the next turn usually has it.
 */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([work.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a briefing will wait on the wallet before leaving it out. */
export const BRIEF_WALLET_BUDGET_MS = 250;

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function intentOut(i: TradeIntent, baseUrl: string) {
  return {
    code: i.code,
    status: i.status,
    side: i.side,
    ticker: i.ticker,
    usd: i.usd,
    priceAtProposal: i.priceAtProposal,
    expiresAt: new Date(i.expiresAt).toISOString(),
    confirmUrl: i.code ? `${baseUrl}/go?code=${i.code}` : `${baseUrl}/app/`,
    // A Solana Action any blink client or phone wallet can sign; null until there's a code.
    actionUrl: i.code ? `solana-action:${baseUrl}/api/actions/trade/${i.code}` : null,
    signature: i.signature ?? null,
    triggerPrice: i.condition?.price ?? null,
    triggerDirection: i.condition ? (i.condition.above ? ("above" as const) : ("below" as const)) : null,
    triggeredAt: i.condition?.triggeredAt ? new Date(i.condition.triggeredAt).toISOString() : null,
  };
}

const intentShape = {
  code: z.string().describe("Six-digit code to sign with; empty while a conditional trade is still armed."),
  status: z.string(),
  side: z.enum(["buy", "sell"]),
  ticker: z.string(),
  usd: z.number(),
  priceAtProposal: z.number(),
  expiresAt: z.string(),
  confirmUrl: z.string(),
  actionUrl: z.string().nullable().describe("solana-action: URL for signing in a blink-capable wallet."),
  signature: z.string().nullable(),
  triggerPrice: z.number().nullable(),
  triggerDirection: z.enum(["above", "below"]).nullable(),
  triggeredAt: z.string().nullable(),
};

/** "Your $50 buy of Tesla …": shared by trade_status, cancel_trade and the brief. */
function tradeSentence(intent: TradeIntent, now: number, zone: Zone = EASTERN): string {
  const name = listingByTicker(intent.ticker)?.spoken ?? intent.ticker;
  const what = `Your ${usd(intent.usd)} ${intent.side} of ${name}`;
  const c = intent.condition;
  const line = c ? `${c.above ? "rises above" : "drops below"} ${usd(c.price)}` : "";
  const text: Record<TradeIntent["status"], string> = {
    armed: `${what} is set for when its token ${line}.`,
    awaiting_signature: c?.triggeredAt
      ? `${what} triggered ${whenSpoken(c.triggeredAt, now, zone)}, when the token ${c.above ? "rose above" : "dropped below"} ${usd(c.price)}. It's waiting for your signature: the code is ${spokenCode(intent.code)}.`
      : `${what} is waiting for your signature. The code is ${spokenCode(intent.code)}.`,
    submitted: `${what} was signed and sent. It's waiting for Solana to confirm it.`,
    confirmed: `${what} is confirmed on Solana.`,
    failed: intent.error?.includes("linked wallet")
      ? `${what} couldn't be confirmed: ${intent.error}.`
      : `${what} didn't go through. Nothing was filled.`,
    expired: c && !c.triggeredAt ? `${what} expired before its price was reached, so nothing happened.` : `${what} expired before it was signed, so nothing happened.`,
    cancelled: `${what} was cancelled, so nothing happened.`,
  };
  return capitalise(text[intent.status]);
}

export function registerTools(server: McpServer, svc: Services, caller: Caller): void {
  // Time every handler for /health. Wrapping registerTool once keeps the
  // tool definitions below free of timing code.
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => Promise<unknown>) =>
    register(name, config as never, (async (...a: unknown[]) => {
      const started = performance.now();
      try {
        return await cb(...a);
      } finally {
        recordToolTime(name, performance.now() - started);
      }
    }) as never)) as typeof server.registerTool;

  const allReadings = async () => {
    const board = await svc.prices.read();
    const now = svc.now();
    const session = getMarketSession(new Date(now));
    const readings = LISTINGS.flatMap((l) => {
      const q = board.quotes.get(l.ticker);
      return q ? [readGap(l, q, now, session)] : [];
    });
    return { board, now, session, readings };
  };

  const guard = async (fn: () => Promise<Result>): Promise<Result> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PriceSourceError) {
        return fail("I can't reach market prices right now. Please try again in a minute.");
      }
      return fail(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  server.registerTool(
    "open_track_record",
    {
      title: "How well the overnight move predicts the open",
      description:
        "For one stock, over roughly the last month of market opens: how often the token's overnight move (where it traded at 9 a.m. Eastern) pointed the way the real share then opened, and how close it usually was. Built from public on-chain and exchange history, refreshed daily. Use for 'does the weekend move usually hold?', 'can I trust the Tesla token overnight?', 'how accurate is the overnight price?'.",
      inputSchema: { stock: z.string().min(1).describe("Company name or ticker as the user said it.") },
      outputSchema: {
        dataSource: z.enum(["history", "sample"]),
        ticker: z.string(),
        opens: z.number(),
        calls: z.number(),
        sameDirection: z.number(),
        medianMissPercent: z.number(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        recent: z.array(z.object({ date: z.string(), overnightPercent: z.number(), openPercent: z.number() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stock }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        const records = await opensFor(svc, listing.ticker);
        const t = trackRecord(records);
        if (t.calls < 5) {
          return fail(`I don't have enough history for ${listing.spoken} yet. It builds from public market data once a day.`);
        }
        const hit = t.sameDirection / t.calls;
        const verdict =
          hit >= 0.75 ? "So far the overnight move has been a decent guide to the open." : hit >= 0.55 ? "So it's a hint, not a promise." : "So treat the overnight move with real caution.";
        const text = `${svc.sample ? "Using sample data. " : ""}Over the last ${t.opens} market opens, ${possessiveName(listing.spoken)} token moved meaningfully overnight ${t.calls} times, and the share opened the same way ${t.sameDirection} of them, typically within ${pct(t.medianMissBps)} of where the token pointed. ${verdict}`;
        return say(text, {
          dataSource: svc.sample ? "sample" : "history",
          ticker: listing.ticker,
          opens: t.opens,
          calls: t.calls,
          sameDirection: t.sameDirection,
          medianMissPercent: t.medianMissBps / 100,
          from: t.from,
          to: t.to,
          recent: records.slice(-5).map((r) => ({ date: r.date, overnightPercent: r.overnightBps / 100, openPercent: r.openBps / 100 })),
        });
      }),
  );

  server.registerTool(
    "set_timezone",
    {
      title: "Set my time zone",
      description:
        "Remembers where the user is, so every time Afterhours says (market open, when an alert went off, when a trade triggered) and every notification uses their local time instead of New York's. Use for 'I'm in London', 'my time zone is Lagos', 'use Tokyo time', 'use Eastern time'.",
      inputSchema: { place: z.string().min(2).describe("City, country or IANA zone as the user said it, e.g. 'London', 'Nigeria', 'Asia/Tokyo'.") },
      outputSchema: { timeZone: z.string(), label: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ place }) =>
      guard(async () => {
        const zone = resolveZone(place);
        if (!zone) return fail(`I don't know the time zone for "${place}". Try a nearby big city, like London, Lagos, Mumbai or Tokyo.`);
        await setZone(svc.store, caller.sub, zone);
        const now = new Date(svc.now());
        const opens = nextOpenPhrase(now, zone);
        return say(
          `Got it, I'll use ${zoneName(zone)}. ${getMarketSession(now).isRegularHours ? "The US market is open now." : opens ? `The US market next opens ${opens}.` : ""}`.trim(),
          { timeZone: zone.tz, label: zone.label },
        );
      }),
  );

  server.registerTool(
    "explain",
    {
      title: "Explain tokenized stocks and how Afterhours works",
      description:
        "Short spoken explanations for people new to this: what a tokenized stock is, why it trades when the stock market is closed, why its price can differ from the real share, how trading by voice works and why it's safe, and what Afterhours can do. Use for 'what is a tokenized stock?', 'why is the token different from the stock?', 'is this safe?', 'how do trades work?', 'what can you do?'.",
      inputSchema: {
        topic: z
          .enum(["tokenized_stocks", "after_hours", "price_gap", "trading_safety", "what_you_can_do"])
          .describe("tokenized_stocks: what they are. after_hours: why they trade when markets are shut. price_gap: why the token's price differs from the share's. trading_safety: how voice trades work and why they're safe. what_you_can_do: Afterhours' features."),
      },
      outputSchema: { topic: z.string(), text: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ topic }) => say(EXPLAIN[topic], { topic, text: EXPLAIN[topic] }),
  );

  server.registerTool(
    "market_status",
    {
      title: "Is the stock market open?",
      description:
        "Says whether the US stock market is open, closed, in pre-market or after-hours, and when it next opens. Use for 'is the market open?', 'when does the market open?'. Tokenized stocks trade around the clock even when it is closed.",
      inputSchema: {},
      outputSchema: {
        phase: z.enum(["premarket", "regular", "afterhours", "closed", "weekend", "holiday"]),
        isOpen: z.boolean(),
        easternTime: z.string(),
        holiday: z.string().nullable(),
        nextOpen: z.string().nullable(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      const now = new Date(svc.now());
      const s = getMarketSession(now);
      const zone = await getZone(svc.store, caller.sub);
      const tail = s.isRegularHours ? "" : " Tokenized stocks are still trading.";
      return say(`${sessionSentence(s, now, zone)}${tail}`, {
        phase: s.phase,
        isOpen: s.isRegularHours,
        easternTime: s.etTime,
        holiday: s.phase === "holiday" ? s.label : null,
        nextOpen: s.isRegularHours ? null : nextOpenPhrase(now, zone),
      });
    },
  );

  server.registerTool(
    "overnight_brief",
    {
      _meta: toolUiMeta("overnight_brief"),
      title: "What moved while the market was closed",
      description:
        "A short spoken briefing: whether the market is open, how the user's own positions moved (when a wallet is linked), how the names on their watchlist moved, which tokenized stocks have moved most against their real share price (since the last close when the market is shut), and any of the user's alerts that have triggered. Use for 'what happened overnight?', 'how are stocks doing?', 'anything I should know?', 'morning briefing'.",
      inputSchema: {
        count: z.number().int().min(1).max(5).optional().describe("How many movers to read out. Default 3."),
      },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        marketPhase: z.string(),
        movers: z.array(z.object(readingShape)),
        watchlist: z.array(z.object(readingShape)).describe("Watched names that moved beyond noise, biggest first."),
        portfolio: z
          .object({ totalUsd: z.number(), changeUsd: z.number(), leader: z.string().nullable() })
          .nullable()
          .describe("The linked wallet's overnight change, when it could be read within the latency budget."),
        alertsTriggered: z.array(
          z.object({
            ticker: z.string(),
            kind: z.enum(["move", "price"]),
            price: z.number().nullable(),
            tokenPrice: z.number(),
            thresholdPercent: z.number().nullable(),
            gapPercent: z.number(),
            firedAt: z.string().nullable(),
            firedGapPercent: z.number(),
          }),
        ),
        asOf: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ count }) =>
      guard(async () => {
        const { board, now, session, readings } = await allReadings();
        const movers = rankByGap(readings)
          .filter((r) => r.kind === "overnight_move" || r.kind === "live_gap")
          .slice(0, count ?? 3);
        const news = alertNews(await listAlerts(svc.store, caller.sub), readings, now);

        // Alerts lead: they are the names this person said they care about.
        const zone = await getZone(svc.store, caller.sub);
        const parts = [sampleNote(board) + sessionSentence(session, new Date(now), zone)];
        for (const n of news) {
          const name = capitalise(n.reading.spoken);
          if (isPriceAlert(n.alert)) {
            const dir = n.alert.above ? "above" : "below";
            const nowAt = `it's at ${usd(n.reading.tokenPrice)} now`;
            parts.push(
              n.firedAt
                ? `${capitalise(possessiveName(n.reading.spoken))} token went ${dir} ${usd(n.alert.price!)} ${whenSpoken(n.firedAt, now, zone)}; ${nowAt}.`
                : `${capitalise(possessiveName(n.reading.spoken))} token is ${dir} your ${usd(n.alert.price!)} line, at ${usd(n.reading.tokenPrice)}.`,
            );
            continue;
          }
          if (n.firedAt) {
            const still = Math.abs(n.reading.gapBps! - n.firedGapBps) < 15 ? "" : `; it's ${move(n.reading.gapBps!)} now`;
            parts.push(`Your ${n.reading.spoken} alert went off ${whenSpoken(n.firedAt, now, zone)}, when it was ${move(n.firedGapBps)}${still}.`);
          } else {
            parts.push(`Your ${n.reading.spoken} alert at ${pct(n.alert.thresholdBps)} has triggered: ${name} is ${move(n.reading.gapBps!)}.`);
          }
        }
        // A conditional trade that triggered overnight is the most urgent thing to say.
        for (const t of await recentlyTriggered(svc.store, caller.sub, now)) parts.push(tradeSentence(t, now, zone));

        // Your own positions come before the market's: it's your money.
        const wallet = caller.wallet || svc.sample ? await within(svc.holdings.read(caller.wallet ?? ""), BRIEF_WALLET_BUDGET_MS) : null;
        const mine = wallet ? valuePortfolio(wallet, readings) : null;
        if (mine && mine.positions.length > 0 && Math.abs(mine.change) >= 1) {
          const n = mine.positions.length;
          const lead = n > 1 && mine.biggest?.changeUsd && Math.abs(mine.biggest.changeUsd) >= 1 ? `, led by ${mine.biggest.name}` : "";
          const since = session.isRegularHours ? "against live share prices" : `since ${mine.positions[0].reading.referenceLabel}`;
          parts.push(`Your ${n === 1 ? "position is" : `${n} positions are`} ${mine.change > 0 ? "up" : "down"} ${usd(Math.abs(mine.change))} ${since}${lead}.`);
        }
        // Then the names they follow, loudest first; quiet ones are skipped, not read out.
        const said = new Set(news.map((n) => n.reading.ticker));
        const watched = new Set(await getWatchlist(svc.store, caller.sub));
        const watchMoves = rankByGap(readings.filter((r) => watched.has(r.ticker) && !said.has(r.ticker))).filter(
          (r) => r.gapBps !== null && Math.abs(r.gapBps) >= NOISE_FLOOR_BPS && (r.kind === "overnight_move" || r.kind === "live_gap"),
        );
        if (watched.size > 0) {
          const spoken = watchMoves.slice(0, 4);
          parts.push(
            spoken.length === 0
              ? "Your watchlist is quiet."
              : `On your watchlist: ${listPhrase(spoken.map(shortMove))}${watchMoves.length > 4 ? `, and ${watchMoves.length - 4} more moving` : ""}.`,
          );
          for (const r of spoken) said.add(r.ticker);
        }
        const fresh = movers.filter((r) => !said.has(r.ticker));
        if (movers.length === 0) {
          parts.push("Tokenized stocks are all within normal noise of their share prices.");
        } else if (fresh.length > 0) {
          const against = session.isRegularHours ? "Biggest gaps against live share prices" : `Biggest moves since ${movers[0].referenceLabel}`;
          parts.push(`${watched.size > 0 ? `Across the market, ${against.charAt(0).toLowerCase()}${against.slice(1)}` : against}: ${listPhrase(fresh.map(shortMove))}.`);
        }

        return say(parts.join(" "), {
          dataSource: board.source,
          marketPhase: session.phase,
          movers: movers.map(readingOut),
          watchlist: watchMoves.map(readingOut),
          portfolio: mine && mine.positions.length > 0 ? { totalUsd: Math.round(mine.total * 100) / 100, changeUsd: Math.round(mine.change * 100) / 100, leader: mine.biggest?.ticker ?? null } : null,
          alertsTriggered: news.map((n) => ({
            ticker: n.alert.ticker,
            kind: isPriceAlert(n.alert) ? ("price" as const) : ("move" as const),
            price: n.alert.price ?? null,
            tokenPrice: n.reading.tokenPrice,
            thresholdPercent: isPriceAlert(n.alert) ? null : n.alert.thresholdBps / 100,
            gapPercent: Math.round(n.reading.gapBps ?? 0) / 100,
            firedAt: n.firedAt ? new Date(n.firedAt).toISOString() : null,
            firedGapPercent: Math.round(n.firedGapBps) / 100,
          })),
          asOf: new Date(board.at).toISOString(),
        });
      }),
  );

  server.registerTool(
    "check_stock",
    {
      _meta: toolUiMeta("check_stock"),
      title: "Check one tokenized stock",
      description:
        "Price of one tokenized stock (xStock on Solana) and how far it is from the real share: since the last close when the market is shut, or against the live price when it is open. Says whether the gap is a hedgeable dislocation or just a bet on the open. Use for 'how is Tesla doing?', 'is the Nvidia token trading rich?', 'what's Apple at?'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it, e.g. 'Tesla', 'NVDA', 'the S&P 500'."),
      },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        ...readingShape,
        verdict: z.string().nullable(),
        overnight: z
          .object({ highPercent: z.number(), highAt: z.string(), lowPercent: z.number(), lowAt: z.string(), samples: z.number() })
          .nullable()
          .describe("Range of the gap since the share last traded, from the overnight tape."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stock }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        const { board, now, readings } = await allReadings();
        const r = readings.find((x) => x.ticker === listing.ticker);
        if (!r) return fail(`I don't have a price for ${listing.spoken} right now.`);
        const zone = await getZone(svc.store, caller.sub);
        const verdict = verdictSentence(r, new Date(now), zone);
        const range =
          r.kind === "overnight_move" || r.kind === "in_line"
            ? overnightRange(await readTape(svc, r.closedAt ?? now - 16 * 3600_000), r.ticker, r.closedAt ?? now - 16 * 3600_000)
            : null;
        const track = r.kind === "overnight_move" ? trackClause(await opensFor(svc, r.ticker)) : null;
        return say([sampleNote(board) + gapSentence(r), rangeSentence(r, range, now, zone), verdict, track].filter(Boolean).join(" "), {
          dataSource: board.source,
          ...readingOut(r),
          verdict,
          overnight: range
            ? {
                highPercent: Math.round(range.high.bps) / 100,
                highAt: new Date(range.high.at).toISOString(),
                lowPercent: Math.round(range.low.bps) / 100,
                lowAt: new Date(range.low.at).toISOString(),
                samples: range.samples,
              }
            : null,
        });
      }),
  );

  server.registerTool(
    "my_portfolio",
    {
      _meta: toolUiMeta("my_portfolio"),
      title: "My tokenized stock portfolio",
      description:
        "Reads the tokenized stocks held in the user's linked Solana wallet, what they are worth now, and how much they have gained or lost since the share market last closed. Read-only. Use for 'how's my portfolio?', 'what do I own?', 'how much am I up?'.",
      inputSchema: {},
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        wallet: z.string().nullable(),
        positions: z.array(
          z.object({ ticker: z.string(), name: z.string(), amount: z.number(), valueUsd: z.number(), changeUsd: z.number().nullable() }),
        ),
        totalUsd: z.number(),
        changeUsd: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        if (!caller.wallet && !svc.sample) {
          return fail("No wallet is linked yet. Link Afterhours in the Alexa app to hear your portfolio.");
        }
        const [{ board, readings }, holdings] = await Promise.all([allReadings(), svc.holdings.read(caller.wallet ?? "")]);
        const { positions, total, change, biggest } = valuePortfolio(holdings, readings);

        const short = caller.wallet ? `ending in ${caller.wallet.slice(-4).split("").join(" ")}` : "";
        if (positions.length === 0) {
          return say(`I don't see any tokenized stocks in your wallet ${short}.`.replace("  ", " "), {
            dataSource: board.source,
            wallet: caller.wallet,
            positions: [],
            totalUsd: 0,
            changeUsd: 0,
          });
        }

        const closedRef = positions.find((p) => p.reading.kind === "overnight_move" || p.reading.kind === "in_line");
        const since = closedRef && !getMarketSession(new Date(svc.now())).isRegularHours ? ` since ${closedRef.reading.referenceLabel}` : " against live share prices";
        const n = positions.length;
        const parts = [
          `${sampleNote(board)}Your ${n === 1 ? "position is" : `${n} positions are`} worth ${usd(total)}.`,
          Math.abs(change) >= 1
            ? `That's ${change > 0 ? "up" : "down"} ${usd(Math.abs(change))}${since}.`
            : `That's about flat${since}.`,
        ];
        if (n > 1 && biggest?.changeUsd && Math.abs(biggest.changeUsd) >= 1) {
          parts.push(`The biggest mover is ${biggest.name}, ${biggest.changeUsd > 0 ? "up" : "down"} ${usd(Math.abs(biggest.changeUsd))}.`);
        }
        return say(parts.join(" "), {
          dataSource: board.source,
          wallet: caller.wallet,
          positions: positions.map(({ reading: _r, ...p }) => ({
            ...p,
            valueUsd: Math.round(p.valueUsd * 100) / 100,
            changeUsd: p.changeUsd === null ? null : Math.round(p.changeUsd * 100) / 100,
          })),
          totalUsd: Math.round(total * 100) / 100,
          changeUsd: Math.round(change * 100) / 100,
        });
      }),
  );

  server.registerTool(
    "set_alert",
    {
      title: "Set a move or price alert",
      description:
        "Remembers that the user wants to hear about a tokenized stock: either when it moves at least a given percent away from its share price (percent), or when its token crosses a dollar price (price; direction is worked out from where it trades now). Alerts are watched around the clock and read out, with the time they went off, at the start of the next briefing. Replaces an existing alert of the same kind for that stock. Use for 'tell me if Tesla moves more than 2 percent', 'tell me if Nvidia goes above 250', 'let me know if Apple drops below 300'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it."),
        percent: z.number().min(0.2).max(50).optional().describe("Move size in percent, e.g. 2 for two percent."),
        price: z.number().positive().optional().describe("Token price in US dollars to watch for, e.g. 400."),
      },
      outputSchema: {
        ticker: z.string(),
        kind: z.enum(["move", "price"]),
        thresholdPercent: z.number().nullable(),
        price: z.number().nullable(),
        direction: z.enum(["above", "below"]).nullable(),
        alertCount: z.number(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ stock, percent, price }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        if ((percent === undefined) === (price === undefined)) {
          return fail(`Should I watch ${listing.spoken} for a percent move, or a price? For example, 2 percent, or above $400.`);
        }
        if (price !== undefined) {
          const { readings } = await allReadings();
          const now = readings.find((r) => r.ticker === listing.ticker)?.tokenPrice;
          if (!now) return fail(`I don't have a price for ${listing.spoken} right now, so I can't set that.`);
          const above = price > now;
          const list = await upsertAlert(svc.store, caller.sub, { ticker: listing.ticker, thresholdBps: 0, price, above, createdAt: svc.now() });
          return say(
            `Done. I'll tell you when ${possessiveName(listing.spoken)} token goes ${above ? "above" : "below"} ${usd(price)}. It's at ${usd(now)} now.`,
            { ticker: listing.ticker, kind: "price", thresholdPercent: null, price, direction: above ? "above" : "below", alertCount: list.length },
          );
        }
        const thresholdBps = Math.max(NOISE_FLOOR_BPS, Math.round(percent! * 100));
        const list = await upsertAlert(svc.store, caller.sub, { ticker: listing.ticker, thresholdBps, createdAt: svc.now() });
        return say(`Done. I'll tell you when ${listing.spoken} moves ${pct(thresholdBps)} or more from its share price.`, {
          ticker: listing.ticker,
          kind: "move",
          thresholdPercent: thresholdBps / 100,
          price: null,
          direction: null,
          alertCount: list.length,
        });
      }),
  );

  server.registerTool(
    "edit_watchlist",
    {
      title: "Add to or remove from my watchlist",
      description: `Adds stocks to, or removes them from, the user's watchlist (up to ${MAX_WATCHED} names). The morning briefing leads with watched names that moved. Use for 'add Netflix to my watchlist', 'watch Palantir and AMD', 'stop watching Intel'.`,
      inputSchema: {
        add: z.array(z.string().min(1)).max(10).optional().describe("Names or tickers to start watching, as the user said them."),
        remove: z.array(z.string().min(1)).max(20).optional().describe("Names or tickers to stop watching."),
      },
      outputSchema: { added: z.array(z.string()), removed: z.array(z.string()), unknown: z.array(z.string()), watching: z.array(z.string()), max: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ add, remove }) =>
      guard(async () => {
        const unknown: string[] = [];
        const resolve = (said: string[] = []) =>
          said.flatMap((x) => {
            const l = resolveSymbol(x);
            if (!l) unknown.push(x);
            return l ? [l.ticker] : [];
          });
        const result = await editWatchlist(svc.store, caller.sub, { add: resolve(add), remove: resolve(remove) });
        const name = (t: string) => listingByTicker(t)?.spoken ?? t;
        const parts: string[] = [];
        if (result.added.length) parts.push(`Added ${listPhrase(result.added.map(name))}.`);
        if (result.removed.length) parts.push(`Stopped watching ${listPhrase(result.removed.map(name))}.`);
        if (result.full.length) parts.push(`Your watchlist is full at ${MAX_WATCHED}, so I couldn't add ${listPhrase(result.full.map(name))}.`);
        if (unknown.length) parts.push(`I don't have a tokenized stock for ${listPhrase(unknown.map((u) => `"${u}"`))}.`);
        if (!parts.length) parts.push(result.list.length ? "Your watchlist already looks like that." : "Your watchlist is empty.");
        parts.push(result.list.length ? `You're watching ${result.list.length === 1 ? "one name" : `${result.list.length} names`}.` : "");
        return say(parts.filter(Boolean).join(" "), { added: result.added, removed: result.removed, unknown, watching: result.list, max: MAX_WATCHED });
      }),
  );

  server.registerTool(
    "my_watchlist",
    {
      title: "How my watchlist is doing",
      description: "Reads out each name on the user's watchlist with its move against the share (since the last close while the market is shut). Use for 'how's my watchlist?', 'what am I watching?'.",
      inputSchema: {},
      outputSchema: { dataSource: z.enum(["jupiter", "sample"]), names: z.array(z.object(readingShape)), max: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const watched = await getWatchlist(svc.store, caller.sub);
        if (watched.length === 0) {
          return say("You're not watching anything yet. You can say, add Netflix to my watchlist.", { dataSource: svc.sample ? "sample" : "jupiter", names: [], max: MAX_WATCHED });
        }
        const { board, readings } = await allReadings();
        const byTicker = new Map(readings.map((r) => [r.ticker, r]));
        const rows = watched.map((t) => byTicker.get(t)).filter((r): r is GapReading => r !== undefined);
        const unpriced = watched.filter((t) => !byTicker.has(t)).map((t) => listingByTicker(t)?.spoken ?? t);
        const ranked = rankByGap(rows);
        const phrase = (r: GapReading) => (r.gapBps === null || Math.abs(r.gapBps) < NOISE_FLOOR_BPS ? `${r.spoken} flat` : shortMove(r));
        const since = ranked.find((r) => r.kind === "overnight_move" || r.kind === "in_line")?.referenceLabel;
        const text = [
          sampleNote(board) + `You're watching ${watched.length === 1 ? "one name" : `${watched.length} names`}${since ? `. Since ${since}` : ""}: ${listPhrase(ranked.map(phrase))}.`,
          unpriced.length ? `I don't have a price for ${listPhrase(unpriced)} right now.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return say(text, { dataSource: board.source, names: ranked.map(readingOut), max: MAX_WATCHED });
      }),
  );

  server.registerTool(
    "schedule_briefing",
    {
      title: "Send my briefing at a time of day",
      description:
        "Sets, changes or turns off a briefing pushed to the user's phone at a time of day in their time zone (their positions, watched names that moved, and the biggest moves). Use for 'brief me every weekday at 7', 'send my briefing at 6:30 a.m.', 'stop my morning briefing', 'when is my briefing?'. Call with no arguments to read the current setting.",
      inputSchema: {
        time: z.string().optional().describe("Time of day as said, e.g. '7', '7:30 am', '18:00', 'noon'."),
        days: z.enum(["weekdays", "daily", "weekends"]).optional().describe("Default weekdays."),
        off: z.boolean().optional().describe("True to stop the briefing."),
      },
      outputSchema: {
        scheduled: z.boolean(),
        time: z.string().nullable().describe("HH:MM, 24-hour, in the account's time zone."),
        days: z.enum(["weekdays", "daily", "weekends"]).nullable(),
        timeZone: z.string(),
        devices: z.number().describe("Devices with notifications on; the briefing needs at least one."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ time, days, off }) =>
      guard(async () => {
        const zone = await getZone(svc.store, caller.sub);
        const devices = (await listSubscriptions(svc, caller.sub)).length;
        const out = (s: { minutes: number; days: BriefingDays } | null) => ({
          scheduled: Boolean(s),
          time: s ? `${String(Math.floor(s.minutes / 60)).padStart(2, "0")}:${String(s.minutes % 60).padStart(2, "0")}` : null,
          days: s?.days ?? null,
          timeZone: zone.tz,
          devices,
        });
        const where = zone.label === "Eastern" ? "Eastern" : `${zone.label} time`;
        const noDevice = devices === 0 ? " It comes as a notification, so turn notifications on in the Afterhours app on your phone." : "";
        const current = await getBriefing(svc, caller.sub);
        if (off) {
          await setBriefing(svc, caller.sub, null);
          return say(current ? "Done. I've stopped your scheduled briefing." : "You didn't have a scheduled briefing.", out(null));
        }
        if (!time && !days) {
          return say(
            current
              ? `Your briefing comes ${DAYS_SPOKEN[current.days]} at ${spokenTime(current.minutes)} ${where}.${noDevice}`
              : "You don't have a scheduled briefing. You can say, brief me every weekday at 7.",
            out(current),
          );
        }
        const minutes = time ? parseTime(time) : (current?.minutes ?? null);
        if (minutes === null) return fail(time ? `I didn't catch a time in "${time}". Try something like 7 a.m. or 6:30.` : "What time should I send it?");
        const schedule = { minutes, days: days ?? current?.days ?? ("weekdays" as const), wallet: caller.wallet ?? undefined };
        await setBriefing(svc, caller.sub, schedule);
        return say(`Done. I'll send your briefing ${DAYS_SPOKEN[schedule.days]} at ${spokenTime(minutes)} ${where}.${noDevice}`, out(schedule));
      }),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "List my alerts",
      description: "Lists the move and price alerts the user has set. Use for 'what alerts do I have?'.",
      inputSchema: {},
      outputSchema: {
        alerts: z.array(
          z.object({ ticker: z.string(), name: z.string(), kind: z.enum(["move", "price"]), thresholdPercent: z.number().nullable(), price: z.number().nullable(), direction: z.enum(["above", "below"]).nullable() }),
        ),
        max: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const alerts = await listAlerts(svc.store, caller.sub);
        const named = alerts.map((a) => ({
          ticker: a.ticker,
          name: listingByTicker(a.ticker)?.spoken ?? a.ticker,
          kind: isPriceAlert(a) ? ("price" as const) : ("move" as const),
          thresholdPercent: isPriceAlert(a) ? null : a.thresholdBps / 100,
          price: a.price ?? null,
          direction: isPriceAlert(a) ? (a.above ? ("above" as const) : ("below" as const)) : null,
        }));
        const text =
          named.length === 0
            ? "You don't have any alerts. You can say, tell me if Tesla moves more than 2 percent."
            : `You have ${named.length === 1 ? "one alert" : `${named.length} alerts`}: ${listPhrase(named.map((a) => (a.kind === "price" ? `${a.name} ${a.direction} ${usd(a.price!)}` : `${a.name} at ${pct(a.thresholdPercent! * 100)}`)))}.`;
        return say(text, { alerts: named, max: MAX_ALERTS });
      }),
  );

  server.registerTool(
    "remove_alert",
    {
      title: "Remove an alert",
      description: "Deletes the user's move alert for one stock. Use for 'stop the Tesla alert'.",
      inputSchema: { stock: z.string().min(1).describe("Company name or ticker as the user said it.") },
      outputSchema: { ticker: z.string(), removed: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ stock }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        const removed = await removeAlert(svc.store, caller.sub, listing.ticker);
        return say(removed ? `Removed your ${listing.spoken} alert.` : `You didn't have an alert for ${listing.spoken}.`, {
          ticker: listing.ticker,
          removed,
        });
      }),
  );

  server.registerTool(
    "propose_trade",
    {
      _meta: toolUiMeta("propose_trade"),
      title: "Propose a buy or sell (signed in the user's wallet)",
      description:
        "Prepares a buy or sell of a tokenized stock, paid in USDC, for the user to approve. This does NOT execute anything: it returns a six-digit code, and the trade only happens if the user opens the confirm page and signs it in their own wallet. Read the code to the user and never say the trade is done. With trigger_price it's a conditional trade: nothing is prepared until the token crosses that price, then the code is created and the user's phone is notified. Use for 'buy 50 dollars of Tesla', 'sell 100 dollars of Nvidia', 'buy 50 dollars of Tesla if it drops below 360'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it."),
        side: z.enum(["buy", "sell"]),
        amount_usd: z.number().positive().describe("Trade size in US dollars."),
        trigger_price: z
          .number()
          .positive()
          .optional()
          .describe("Only for 'if it drops below / rises above X': the token price in dollars that triggers the trade."),
      },
      outputSchema: intentShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ stock, side, amount_usd, trigger_price }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        if (!caller.wallet) return fail("No wallet is linked yet. Link Afterhours in the Alexa app before trading.");
        const cap = maxTradeUsd();
        if (amount_usd > cap) return fail(`By voice I can prepare trades up to ${usd(cap)}. Try a smaller amount.`);
        if (amount_usd < 1) return fail("The smallest trade I can prepare is $1.");

        const { board, now, readings } = await allReadings();
        const r = readings.find((x) => x.ticker === listing.ticker);
        if (!r) return fail(`I don't have a price for ${listing.spoken} right now, so I can't prepare that.`);

        if (side === "sell") {
          const held = await svc.holdings.read(caller.wallet).catch(() => null);
          const amount = held?.find((h) => h.ticker === listing.ticker)?.amount ?? 0;
          if (held && amount * r.tokenPrice < amount_usd * 0.98) {
            return fail(`You hold about ${usd(amount * r.tokenPrice)} of ${listing.spoken}, so I can't prepare a ${usd(amount_usd)} sale.`);
          }
        }

        const base = { sub: caller.sub, wallet: caller.wallet, ticker: listing.ticker, side, usd: amount_usd, priceAtProposal: r.tokenPrice };
        if (trigger_price !== undefined && Math.abs(trigger_price / r.tokenPrice - 1) > 0.001) {
          const above = trigger_price > r.tokenPrice;
          const armed = await armIntent(svc.store, base, { price: trigger_price, above }, now);
          const devices = (await listSubscriptions(svc, caller.sub)).length;
          const tell = devices
            ? "I'll prepare it then and send a notification to your phone to sign it."
            : "I'll prepare it then for you to sign. Turn on notifications in the Afterhours app to hear about it right away.";
          return say(
            `${sampleNote(board)}OK. When ${possessiveName(listing.spoken)} token ${above ? "rises above" : "drops below"} ${usd(trigger_price)}, I'll get a ${usd(amount_usd)} ${side} ready. It's at ${usd(r.tokenPrice)} now. ${tell} Nothing happens without your signature.`,
            intentOut(armed, svc.baseUrl),
          );
        }

        const intent = await createIntent(svc.store, base, now);
        const parts = [
          `${sampleNote(board)}A ${side} of ${usd(amount_usd)} of ${listing.spoken} at about ${usd(r.tokenPrice)} is ready for you to sign.`,
          `Open ${spokenUrl(svc.baseUrl, "/go")} and enter code ${spokenCode(intent.code)}. It expires in 15 minutes.`,
        ];
        if (r.kind === "overnight_move" && r.gapBps !== null) {
          const chasing = (side === "buy" && r.gapBps > 0) || (side === "sell" && r.gapBps < 0);
          if (chasing) {
            parts.push(
              `Heads up: the token is ${r.gapBps > 0 ? "up" : "down"} ${pct(r.gapBps)} since ${r.referenceLabel}, so you'd be ${side === "buy" ? "buying" : "selling"} after that move.`,
            );
          }
        }
        return say(parts.join(" "), intentOut(intent, svc.baseUrl));
      }),
  );

  server.registerTool(
    "trade_status",
    {
      _meta: toolUiMeta("trade_status"),
      title: "Status of a proposed trade",
      description:
        "Says whether the user's most recent proposed trade (or the one with the given code) is armed and waiting for its price, waiting for a signature, submitted, confirmed on Solana, failed, cancelled, or expired. Use for 'did my trade go through?', 'is my Tesla order still on?'.",
      inputSchema: { code: z.string().optional().describe("Six-digit code, if the user says one.") },
      outputSchema: intentShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ code }) =>
      guard(async () => {
        let intent: TradeIntent | null = null;
        if (code) intent = await intentByCode(svc.store, code, svc.now());
        if (!intent) {
          const id = await svc.store.get<string>(`latest-intent:${caller.sub}`);
          intent = id ? await getIntent(svc.store, id, svc.now()) : null;
        }
        if (!intent || intent.sub !== caller.sub) return fail("I don't see a recent trade for you.");
        return say(tradeSentence(intent, svc.now(), await getZone(svc.store, caller.sub)), intentOut(intent, svc.baseUrl));
      }),
  );

  server.registerTool(
    "cancel_trade",
    {
      _meta: toolUiMeta("cancel_trade"),
      title: "Cancel a proposed or conditional trade",
      description:
        "Cancels the user's most recent trade that hasn't been signed yet (an armed conditional trade, or one waiting for a signature), or the one with the given code. Use for 'cancel my order', 'forget the Tesla buy'.",
      inputSchema: { code: z.string().optional().describe("Six-digit code, if the user says one.") },
      outputSchema: intentShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ code }) =>
      guard(async () => {
        let intent: TradeIntent | null = null;
        if (code) intent = await intentByCode(svc.store, code, svc.now());
        if (!intent) {
          const id = await svc.store.get<string>(`latest-intent:${caller.sub}`);
          intent = id ? await getIntent(svc.store, id, svc.now()) : null;
        }
        if (!intent || intent.sub !== caller.sub) return fail("I don't see a trade to cancel.");
        if (intent.status !== "armed" && intent.status !== "awaiting_signature") {
          return fail(`${tradeSentence(intent, svc.now())} There's nothing to cancel.`);
        }
        intent.status = "cancelled";
        await saveIntent(svc.store, intent, svc.now());
        return say(tradeSentence(intent, svc.now()), intentOut(intent, svc.baseUrl));
      }),
  );
}
