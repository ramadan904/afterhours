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
import { LISTINGS, listingByTicker, resolveSymbol } from "../market/universe.js";
import { getMarketSession } from "../market/session.js";
import { rankByGap, readGap, NOISE_FLOOR_BPS, type GapReading } from "../market/gap.js";
import { capitalise, gapSentence, pct, sessionSentence, usd, verdictSentence, nextOpenPhrase } from "../market/speech.js";
import { PriceSourceError, type Board } from "../market/prices.js";
import { listAlerts, removeAlert, triggered, upsertAlert, MAX_ALERTS } from "../market/alerts.js";
import { createIntent, getIntent, intentByCode, maxTradeUsd, type TradeIntent } from "../chain/trade.js";

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

const KNOWN = "Tesla, Nvidia, Apple, Microsoft, Meta, Amazon, Alphabet, Coinbase, Strategy, Circle, the S&P 500 or the Nasdaq 100";

function unknownStock(said: string): Result {
  return fail(`I don't have a tokenized stock for "${said}". I can check ${KNOWN}.`);
}

function sampleNote(board: Board): string {
  return board.source === "sample" ? "Using sample data. " : "";
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
    confirmUrl: `${baseUrl}/go?code=${i.code}`,
    signature: i.signature ?? null,
  };
}

export function registerTools(server: McpServer, svc: Services, caller: Caller): void {
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
      const tail = s.isRegularHours ? "" : " Tokenized stocks are still trading.";
      return say(`${sessionSentence(s, now)}${tail}`, {
        phase: s.phase,
        isOpen: s.isRegularHours,
        easternTime: s.etTime,
        holiday: s.phase === "holiday" ? s.label : null,
        nextOpen: s.isRegularHours ? null : nextOpenPhrase(now),
      });
    },
  );

  server.registerTool(
    "overnight_brief",
    {
      title: "What moved while the market was closed",
      description:
        "A short spoken briefing: whether the market is open, which tokenized stocks have moved most against their real share price (since the last close when the market is shut), and any of the user's alerts that have triggered. Use for 'what happened overnight?', 'how are stocks doing?', 'anything I should know?', 'morning briefing'.",
      inputSchema: {
        count: z.number().int().min(1).max(5).optional().describe("How many movers to read out. Default 3."),
      },
      outputSchema: {
        dataSource: z.enum(["jupiter", "sample"]),
        marketPhase: z.string(),
        movers: z.array(z.object(readingShape)),
        alertsTriggered: z.array(z.object({ ticker: z.string(), thresholdPercent: z.number(), gapPercent: z.number() })),
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
        const hits = triggered(await listAlerts(svc.store, caller.sub), readings);

        const parts = [sampleNote(board) + sessionSentence(session, new Date(now))];
        if (movers.length === 0) {
          parts.push("Tokenized stocks are all within normal noise of their share prices.");
        } else {
          const against = session.isRegularHours ? "Biggest gaps against live share prices" : `Biggest moves since ${movers[0].referenceLabel}`;
          parts.push(`${against}: ${listPhrase(movers.map(shortMove))}.`);
        }
        for (const { alert, reading } of hits) {
          parts.push(`Your ${reading.spoken} alert at ${pct(alert.thresholdBps)} has triggered: ${shortMove(reading).replace(reading.spoken + " ", "")}.`);
        }

        return say(parts.join(" "), {
          dataSource: board.source,
          marketPhase: session.phase,
          movers: movers.map(readingOut),
          alertsTriggered: hits.map(({ alert, reading }) => ({
            ticker: alert.ticker,
            thresholdPercent: alert.thresholdBps / 100,
            gapPercent: Math.round(reading.gapBps!) / 100,
          })),
          asOf: new Date(board.at).toISOString(),
        });
      }),
  );

  server.registerTool(
    "check_stock",
    {
      title: "Check one tokenized stock",
      description:
        "Price of one tokenized stock (xStock on Solana) and how far it is from the real share: since the last close when the market is shut, or against the live price when it is open. Says whether the gap is a hedgeable dislocation or just a bet on the open. Use for 'how is Tesla doing?', 'is the Nvidia token trading rich?', 'what's Apple at?'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it, e.g. 'Tesla', 'NVDA', 'the S&P 500'."),
      },
      outputSchema: { dataSource: z.enum(["jupiter", "sample"]), ...readingShape, verdict: z.string().nullable() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ stock }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        const { board, now, readings } = await allReadings();
        const r = readings.find((x) => x.ticker === listing.ticker);
        if (!r) return fail(`I don't have a price for ${listing.spoken} right now.`);
        const verdict = verdictSentence(r, new Date(now));
        return say([sampleNote(board) + gapSentence(r), verdict].filter(Boolean).join(" "), {
          dataSource: board.source,
          ...readingOut(r),
          verdict,
        });
      }),
  );

  server.registerTool(
    "my_portfolio",
    {
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
        const positions = holdings
          .map((h) => {
            const r = readings.find((x) => x.ticker === h.ticker);
            const listing = listingByTicker(h.ticker)!;
            if (!r) return null;
            const valueUsd = h.amount * r.tokenPrice;
            const changeUsd = r.sharePrice && r.kind !== "stale_reference" ? h.amount * (r.tokenPrice - r.sharePrice) : null;
            return { ticker: h.ticker, name: listing.spoken, amount: h.amount, valueUsd, changeUsd, reading: r };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .sort((a, b) => b.valueUsd - a.valueUsd);

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

        const total = positions.reduce((s, p) => s + p.valueUsd, 0);
        const change = positions.reduce((s, p) => s + (p.changeUsd ?? 0), 0);
        const closedRef = positions.find((p) => p.reading.kind === "overnight_move" || p.reading.kind === "in_line");
        const since = closedRef && !getMarketSession(new Date(svc.now())).isRegularHours ? ` since ${closedRef.reading.referenceLabel}` : " against live share prices";
        const biggest = [...positions].sort((a, b) => Math.abs(b.changeUsd ?? 0) - Math.abs(a.changeUsd ?? 0))[0];
        const n = positions.length;
        const parts = [
          `${sampleNote(board)}Your ${n === 1 ? "position is" : `${n} positions are`} worth ${usd(total)}.`,
          Math.abs(change) >= 1
            ? `That's ${change > 0 ? "up" : "down"} ${usd(Math.abs(change))}${since}.`
            : `That's about flat${since}.`,
        ];
        if (n > 1 && biggest.changeUsd && Math.abs(biggest.changeUsd) >= 1) {
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
      title: "Set a move alert",
      description:
        "Remembers that the user wants to hear when a tokenized stock moves at least a given percent away from its share price. Triggered alerts are read out at the start of the next briefing. Replaces any existing alert for the same stock. Use for 'tell me if Tesla moves more than 2 percent'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it."),
        percent: z.number().min(0.2).max(50).describe("Move size in percent, e.g. 2 for two percent."),
      },
      outputSchema: { ticker: z.string(), thresholdPercent: z.number(), alertCount: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ stock, percent }) =>
      guard(async () => {
        const listing = resolveSymbol(stock);
        if (!listing) return unknownStock(stock);
        const thresholdBps = Math.max(NOISE_FLOOR_BPS, Math.round(percent * 100));
        const list = await upsertAlert(svc.store, caller.sub, { ticker: listing.ticker, thresholdBps, createdAt: svc.now() });
        return say(`Done. I'll tell you when ${listing.spoken} moves ${pct(thresholdBps)} or more from its share price.`, {
          ticker: listing.ticker,
          thresholdPercent: thresholdBps / 100,
          alertCount: list.length,
        });
      }),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "List my alerts",
      description: "Lists the move alerts the user has set. Use for 'what alerts do I have?'.",
      inputSchema: {},
      outputSchema: { alerts: z.array(z.object({ ticker: z.string(), name: z.string(), thresholdPercent: z.number() })), max: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const alerts = await listAlerts(svc.store, caller.sub);
        const named = alerts.map((a) => ({ ticker: a.ticker, name: listingByTicker(a.ticker)?.spoken ?? a.ticker, thresholdPercent: a.thresholdBps / 100 }));
        const text =
          named.length === 0
            ? "You don't have any alerts. You can say, tell me if Tesla moves more than 2 percent."
            : `You have ${named.length === 1 ? "one alert" : `${named.length} alerts`}: ${listPhrase(named.map((a) => `${a.name} at ${pct(a.thresholdPercent * 100)}`))}.`;
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
      title: "Propose a buy or sell (signed in the user's wallet)",
      description:
        "Prepares a buy or sell of a tokenized stock, paid in USDC, for the user to approve. This does NOT execute anything: it returns a six-digit code, and the trade only happens if the user opens the confirm page and signs it in their own wallet. Read the code to the user and never say the trade is done. Use for 'buy 50 dollars of Tesla', 'sell 100 dollars of Nvidia'.",
      inputSchema: {
        stock: z.string().min(1).describe("Company name or ticker as the user said it."),
        side: z.enum(["buy", "sell"]),
        amount_usd: z.number().positive().describe("Trade size in US dollars."),
      },
      outputSchema: {
        code: z.string(),
        status: z.string(),
        side: z.enum(["buy", "sell"]),
        ticker: z.string(),
        usd: z.number(),
        priceAtProposal: z.number(),
        expiresAt: z.string(),
        confirmUrl: z.string(),
        signature: z.string().nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ stock, side, amount_usd }) =>
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

        const intent = await createIntent(
          svc.store,
          { sub: caller.sub, wallet: caller.wallet, ticker: listing.ticker, side, usd: amount_usd, priceAtProposal: r.tokenPrice },
          now,
        );
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
      title: "Status of a proposed trade",
      description:
        "Says whether the user's most recent proposed trade (or the one with the given code) is still waiting for a signature, was submitted, confirmed on Solana, failed, or expired. Use for 'did my trade go through?'.",
      inputSchema: { code: z.string().optional().describe("Six-digit code, if the user says one.") },
      outputSchema: {
        code: z.string(),
        status: z.string(),
        side: z.enum(["buy", "sell"]),
        ticker: z.string(),
        usd: z.number(),
        priceAtProposal: z.number(),
        expiresAt: z.string(),
        confirmUrl: z.string(),
        signature: z.string().nullable(),
      },
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
        const name = listingByTicker(intent.ticker)?.spoken ?? intent.ticker;
        const what = `Your ${usd(intent.usd)} ${intent.side} of ${name}`;
        const text: Record<TradeIntent["status"], string> = {
          awaiting_signature: `${what} is waiting for your signature. The code is ${spokenCode(intent.code)}.`,
          submitted: `${what} was signed and sent. It's waiting for Solana to confirm it.`,
          confirmed: `${what} is confirmed on Solana.`,
          failed: `${what} didn't go through. Nothing was filled.`,
          expired: `${what} expired before it was signed, so nothing happened.`,
          cancelled: `${what} was cancelled, so nothing happened.`,
        };
        return say(capitalise(text[intent.status]), intentOut(intent, svc.baseUrl));
      }),
  );
}
