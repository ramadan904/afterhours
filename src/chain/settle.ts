/**
 * Getting a proposal from "waiting for your signature" to an answer, however
 * it was signed: on the confirm page, in a wallet from a blink, or by scanning
 * the Solana Pay QR code with a phone.
 *
 * - `buildTrade` asks Jupiter for a fresh transaction for the proposal's
 *   wallet and remembers its blockhash.
 * - `refreshIntent` reads Solana for the outcome: by signature when one was
 *   reported, otherwise by finding a transaction we built in the wallet's
 *   history.
 * - `settlePending` runs on every tape sample, so a trade signed from a QR
 *   code is confirmed (and Alexa can say so) even if no page is open.
 */

import type { Services } from "../services.js";
import { USDC, listingByTicker } from "../market/universe.js";
import { confirmOnChain, findLanded, getIntent, saveIntent, swapLegs, type TradeIntent } from "./trade.js";
import { readTransaction } from "./txmessage.js";
import { noteSettled } from "../notify/wallet-watch.js";
import { logActivity } from "../account/activity.js";
import { count } from "../obs/metrics.js";
import { usd } from "../market/speech.js";

/** Records a trade's outcome in its owner's activity log. */
async function logOutcome(svc: Services, intent: TradeIntent): Promise<void> {
  if (intent.status !== "confirmed" && intent.status !== "failed") return;
  if (intent.status === "confirmed") count("TradesConfirmed");
  const what = `${intent.side === "buy" ? "Buy" : "Sale"} of ${usd(intent.usd)} of ${listingByTicker(intent.ticker)?.token ?? intent.ticker}`;
  await logActivity(svc.store, intent.sub, {
    at: svc.now(),
    kind: `trade.${intent.status}`,
    text: intent.status === "confirmed" ? `${what} confirmed on Solana.` : `${what} didn't go through${intent.error ? `: ${intent.error}` : ""}.`,
    ok: intent.status === "confirmed",
  }).catch(() => undefined);
}

const SLIPPAGE_BPS = Number(process.env.TRADE_SLIPPAGE_BPS ?? 50);
/** A signature that hasn't landed by now never will (blockhashes expire in ~90s). */
const NEVER_LANDED_MS = 120_000;
const PENDING = "settle:pending";

export class TradeNotReady extends Error {}

export interface BuiltTrade {
  /** Base64 unsigned transaction. */
  transaction: string;
  pay: string;
  receive: string;
  impact: string;
  slippage: string;
}

export async function buildTrade(svc: Services, intent: TradeIntent): Promise<BuiltTrade> {
  if (intent.status !== "awaiting_signature") throw new TradeNotReady(`This trade is ${intent.status.replace("_", " ")}.`);
  if (svc.sample) {
    throw new TradeNotReady("This server is running on sample data, so it can't build a real transaction. Deploy with live data to sign trades.");
  }
  const board = await svc.prices.read();
  const price = board.quotes.get(intent.ticker)?.tokenPrice ?? intent.priceAtProposal;
  const quote = await svc.swap.quote({ ...swapLegs(intent, price), slippageBps: SLIPPAGE_BPS });
  const transaction = await svc.swap.build(quote, intent.wallet);

  const read = readTransaction(transaction);
  if (read && read.payer !== intent.wallet) throw new Error("Jupiter built a transaction for the wrong wallet");
  if (read) {
    intent.builtBlockhashes = [...(intent.builtBlockhashes ?? []), read.blockhash].slice(-5);
    intent.builtAt = svc.now();
    await saveIntent(svc.store, intent, svc.now());
    await trackPending(svc, intent.id);
  }

  const listing = listingByTicker(intent.ticker)!;
  const inDecimals = intent.side === "buy" ? USDC.decimals : listing.decimals;
  const outDecimals = intent.side === "buy" ? listing.decimals : USDC.decimals;
  const fmt = (raw: string, d: number, unit: string) =>
    `${(Number(raw) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: d === 6 ? 2 : 6 })} ${unit}`;
  return {
    transaction,
    pay: fmt(quote.inAmount, inDecimals, intent.side === "buy" ? "USDC" : listing.token),
    receive: fmt(quote.outAmount, outDecimals, intent.side === "buy" ? listing.token : "USDC"),
    impact: `${(Math.abs(Number(quote.priceImpactPct ?? 0)) * 100).toFixed(2)}%`,
    slippage: `${(SLIPPAGE_BPS / 100).toFixed(1)}%`,
  };
}

/** Records a signature the wallet (or page) reported. Checked against the chain later. */
export async function markSubmitted(svc: Services, intent: TradeIntent, signature: string): Promise<void> {
  intent.status = "submitted";
  intent.signature = signature;
  intent.submittedAt = svc.now();
  intent.error = undefined;
  await saveIntent(svc.store, intent, svc.now());
  await trackPending(svc, intent.id);
}

/** Brings an intent up to date with Solana. Never throws; an unreachable RPC leaves it as it was. */
export async function refreshIntent(svc: Services, intent: TradeIntent): Promise<TradeIntent> {
  if (svc.sample) return intent;
  const now = svc.now();
  try {
    if (intent.status === "submitted" && intent.signature) {
      const check = await confirmOnChain(svc.rpcUrl, intent.signature, intent.wallet, intent.builtBlockhashes ?? []).catch(() => ({ status: "pending" as const, error: undefined }));
      if (check.status === "confirmed" || check.status === "failed") {
        intent.status = check.status;
        intent.error = check.error;
        await saveIntent(svc.store, intent, now);
        await noteSettled(svc, intent);
        await logOutcome(svc, intent);
        return intent;
      }
      // The reported signature may be bogus, foreign or dropped, while the
      // wallet's real one (from a blink or QR code) landed. Look for ours.
      const landed = await findLanded(svc.rpcUrl, intent.wallet, intent.builtBlockhashes ?? [], intent.builtAt ?? intent.createdAt);
      if (landed) return settle(svc, intent, landed);
      const foreign = check.status === "foreign";
      if (foreign || now - (intent.submittedAt ?? 0) > NEVER_LANDED_MS) {
        // Not this trade, or nothing on chain: give it back to its owner while
        // it can still be signed, and let it expire honestly when it can't.
        intent.status = intent.expiresAt > now ? "awaiting_signature" : "expired";
        intent.signature = undefined;
        intent.error = foreign ? check.error : "the last signature never landed on Solana";
        await saveIntent(svc.store, intent, now);
      }
      return intent;
    }
    if ((intent.status === "awaiting_signature" || intent.status === "expired") && intent.builtBlockhashes?.length) {
      const landed = await findLanded(svc.rpcUrl, intent.wallet, intent.builtBlockhashes, intent.builtAt ?? intent.createdAt);
      if (landed) return settle(svc, intent, landed);
    }
  } catch {
    // Leave it for the next look.
  }
  return intent;
}

async function settle(svc: Services, intent: TradeIntent, landed: { signature: string; failed: boolean }): Promise<TradeIntent> {
  intent.signature = landed.signature;
  intent.submittedAt ??= svc.now();
  intent.status = landed.failed ? "failed" : "confirmed";
  intent.error = landed.failed ? "the swap failed on chain" : undefined;
  await saveIntent(svc.store, intent, svc.now());
  await noteSettled(svc, intent);
  await logOutcome(svc, intent);
  return intent;
}

async function trackPending(svc: Services, id: string): Promise<void> {
  const ids = (await svc.store.get<string[]>(PENDING)) ?? [];
  if (!ids.includes(id)) await svc.store.set(PENDING, [...ids, id].slice(-200), 3600);
}

/**
 * Settles every trade that was built or submitted in the last while. Called
 * from the tape sampler. Returns the trades that reached an outcome.
 */
export async function settlePending(svc: Services): Promise<TradeIntent[]> {
  if (svc.sample) return [];
  const ids = (await svc.store.get<string[]>(PENDING)) ?? [];
  if (ids.length === 0) return [];
  const now = svc.now();
  const settled: TradeIntent[] = [];
  const keep: string[] = [];
  for (const id of ids) {
    const intent = await getIntent(svc.store, id, now);
    if (!intent) continue;
    const before = intent.status;
    const after = (await refreshIntent(svc, intent)).status;
    if (after !== before && (after === "confirmed" || after === "failed")) settled.push(intent);
    const open = after === "submitted" || ((after === "awaiting_signature" || after === "expired") && now - (intent.builtAt ?? 0) < 10 * 60_000);
    if (open) keep.push(id);
  }
  await svc.store.set(PENDING, keep, 3600);
  return settled;
}
