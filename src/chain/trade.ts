/**
 * Voice proposes, wallet disposes.
 *
 * Alexa can be asked to buy or sell, but a voice assistant must never be able
 * to move money on its own: a misheard "fifty" is not "fifteen hundred", and a
 * TV in the background is not the account holder. So a trade request only ever
 * creates a *proposal*, with a six-digit code Alexa reads out. The trade
 * happens when the account holder opens the confirm page, sees a fresh quote,
 * and signs it in their own wallet. Afterhours holds no keys and cannot sign.
 *
 * The code is safe to say out loud. It only reveals a proposal, and the
 * transaction it builds can only be signed by the wallet that was linked — any
 * other wallet's signature is not a valid one.
 */

import { readTransaction } from "./txmessage.js";
import { randomBytes, randomInt } from "node:crypto";
import type { Store } from "../store/store.js";
import { USDC, listingByTicker } from "../market/universe.js";

export type TradeSide = "buy" | "sell";

export type TradeStatus = "armed" | "awaiting_signature" | "submitted" | "confirmed" | "failed" | "expired" | "cancelled";

/**
 * "Buy 50 dollars of Tesla if it drops below 360." An armed trade has no code
 * and can't be signed: it waits for the tape to see the token cross `price`,
 * then becomes an ordinary proposal with a fresh code and a signing window,
 * and the account's devices get a push notification.
 */
export interface TradeCondition {
  price: number;
  /** true: when the token rises above `price`; false: when it drops below. */
  above: boolean;
  triggeredAt?: number;
  /** Token price when it triggered. */
  triggerPrice?: number;
}

export interface TradeIntent {
  id: string;
  code: string;
  sub: string;
  wallet: string;
  ticker: string;
  side: TradeSide;
  /** Notional in USD, as asked. */
  usd: number;
  /** Token price when proposed, for the read-back. The confirm page re-quotes. */
  priceAtProposal: number;
  createdAt: number;
  expiresAt: number;
  status: TradeStatus;
  signature?: string;
  submittedAt?: number;
  error?: string;
  condition?: TradeCondition;
  /**
   * Blockhashes of the transactions built for this trade (newest last). A
   * wallet that signs from a blink or a QR code never tells us the signature,
   * so the trade is found on chain by fee payer and blockhash instead.
   */
  builtBlockhashes?: string[];
  builtAt?: number;
}

export const INTENT_TTL_SECONDS = 15 * 60;
/** How long an armed trade waits for its price. */
export const ARMED_TTL_SECONDS = 7 * 24 * 3600;
/** Signing window once a conditional trade triggers (people may be asleep). */
export const TRIGGERED_TTL_SECONDS = 60 * 60;
export const MAX_ARMED = 5;
const ARMED_INDEX = "armed-intents";

export function maxTradeUsd(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MAX_TRADE_USD);
  return Number.isFinite(v) && v > 0 ? v : 500;
}

/**
 * A six-digit code pointing at an intent. Six digits is what a person can
 * hold in their head between hearing it and typing it. Collisions are retried
 * rather than allowed to overwrite.
 */
async function allocateCode(store: Store, id: string, ttlSeconds: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (await store.setNew(`code:${candidate}`, id, ttlSeconds)) return candidate;
  }
  throw new Error("Could not allocate a confirmation code");
}

/** Keeps an intent readable for an hour past its own expiry, for status questions. */
function retention(intent: TradeIntent, now: number): number {
  return Math.max(3600, Math.ceil((intent.expiresAt - now) / 1000) + 3600);
}

export async function createIntent(
  store: Store,
  input: Omit<TradeIntent, "id" | "code" | "createdAt" | "expiresAt" | "status">,
  now = Date.now(),
): Promise<TradeIntent> {
  const id = randomBytes(16).toString("base64url");
  const code = await allocateCode(store, id, INTENT_TTL_SECONDS);
  const intent: TradeIntent = {
    ...input,
    id,
    code,
    createdAt: now,
    expiresAt: now + INTENT_TTL_SECONDS * 1000,
    status: "awaiting_signature",
  };
  await store.set(`intent:${id}`, intent, retention(intent, now));
  await store.set(`latest-intent:${input.sub}`, id, retention(intent, now));
  return intent;
}

/** Arms a conditional trade. It has no code until it triggers. */
export async function armIntent(
  store: Store,
  input: Omit<TradeIntent, "id" | "code" | "createdAt" | "expiresAt" | "status" | "condition">,
  condition: { price: number; above: boolean },
  now = Date.now(),
): Promise<TradeIntent> {
  const index = (await store.get<string[]>(ARMED_INDEX)) ?? [];
  const mine = (await Promise.all(index.map((id) => getIntent(store, id, now)))).filter((i) => i?.sub === input.sub && i.status === "armed");
  if (mine.length >= MAX_ARMED) throw new Error(`You can keep up to ${MAX_ARMED} conditional trades waiting. Cancel one first.`);
  const intent: TradeIntent = {
    ...input,
    id: randomBytes(16).toString("base64url"),
    code: "",
    createdAt: now,
    expiresAt: now + ARMED_TTL_SECONDS * 1000,
    status: "armed",
    condition,
  };
  await store.set(`intent:${intent.id}`, intent, retention(intent, now));
  await store.set(`latest-intent:${input.sub}`, intent.id, retention(intent, now));
  await store.set(ARMED_INDEX, [...index, intent.id]);
  return intent;
}

/**
 * Checks every armed trade against the latest token prices. Each one whose
 * price has been crossed becomes a signable proposal with a fresh code.
 * Returns those, for notifying their owners.
 */
export async function triggerArmed(store: Store, prices: Map<string, number>, now: number): Promise<TradeIntent[]> {
  const index = (await store.get<string[]>(ARMED_INDEX)) ?? [];
  if (index.length === 0) return [];
  const triggered: TradeIntent[] = [];
  const keep: string[] = [];
  for (const id of index) {
    const intent = await getIntent(store, id, now);
    if (!intent || intent.status !== "armed" || !intent.condition) {
      if (intent?.status === "expired") await saveIntent(store, intent, now);
      continue;
    }
    const price = prices.get(intent.ticker);
    const crossed = price !== undefined && (intent.condition.above ? price >= intent.condition.price : price <= intent.condition.price);
    if (!crossed) {
      keep.push(id);
      continue;
    }
    intent.code = await allocateCode(store, id, TRIGGERED_TTL_SECONDS);
    intent.status = "awaiting_signature";
    intent.expiresAt = now + TRIGGERED_TTL_SECONDS * 1000;
    intent.priceAtProposal = price!;
    intent.condition = { ...intent.condition, triggeredAt: now, triggerPrice: price };
    await saveIntent(store, intent, now);
    const recent = (await store.get<string[]>(`triggered:${intent.sub}`)) ?? [];
    await store.set(`triggered:${intent.sub}`, [...recent, id].slice(-5), 2 * 86_400);
    triggered.push(intent);
  }
  await store.set(ARMED_INDEX, keep);
  return triggered;
}

/** Conditional trades of this account that triggered and still await a signature. */
export async function recentlyTriggered(store: Store, sub: string, now: number): Promise<TradeIntent[]> {
  const ids = (await store.get<string[]>(`triggered:${sub}`)) ?? [];
  const intents = await Promise.all(ids.map((id) => getIntent(store, id, now)));
  return intents.filter((i): i is TradeIntent => i?.status === "awaiting_signature" && i.sub === sub);
}

export async function intentByCode(store: Store, code: string, now = Date.now()): Promise<TradeIntent | null> {
  const id = await store.get<string>(`code:${code.replace(/\D/g, "")}`);
  return id ? getIntent(store, id, now) : null;
}

export async function getIntent(store: Store, id: string, now = Date.now()): Promise<TradeIntent | null> {
  const intent = await store.get<TradeIntent>(`intent:${id}`);
  if (intent && (intent.status === "awaiting_signature" || intent.status === "armed") && intent.expiresAt <= now) {
    intent.status = "expired";
  }
  return intent;
}

export async function saveIntent(store: Store, intent: TradeIntent, now = Date.now()): Promise<void> {
  // The code keeps pointing at the intent until it expires, so the confirm
  // page can keep showing its progress after it has been signed.
  await store.set(`intent:${intent.id}`, intent, retention(intent, now));
}

/** Mints and base-unit amount for a Jupiter ExactIn quote. */
export function swapLegs(intent: TradeIntent, tokenPrice: number) {
  const listing = listingByTicker(intent.ticker);
  if (!listing) throw new Error(`Unknown ticker ${intent.ticker}`);
  if (intent.side === "buy") {
    return {
      inputMint: USDC.mint,
      outputMint: listing.mint,
      amount: BigInt(Math.round(intent.usd * 10 ** USDC.decimals)),
    };
  }
  const tokens = intent.usd / tokenPrice;
  return {
    inputMint: listing.mint,
    outputMint: USDC.mint,
    amount: BigInt(Math.floor(tokens * 10 ** listing.decimals)),
  };
}

/** Thin client for Jupiter's keyless swap API. */
export class JupiterSwap {
  constructor(
    private readonly endpoint = "https://lite-api.jup.ag",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }) {
    const params = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: String(p.slippageBps),
      swapMode: "ExactIn",
    });
    const res = await this.fetchImpl(`${this.endpoint}/swap/v1/quote?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Jupiter quote: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    return (await res.json()) as Record<string, unknown> & { outAmount: string; inAmount: string; priceImpactPct?: string };
  }

  /** Returns a base64 unsigned versioned transaction for the user to sign. */
  async build(quote: unknown, userPublicKey: string): Promise<string> {
    const res = await this.fetchImpl(`${this.endpoint}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: "medium", maxLamports: 1_500_000 } },
      }),
    });
    if (!res.ok) throw new Error(`Jupiter swap: HTTP ${res.status}`);
    const body = (await res.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) throw new Error("Jupiter swap: no transaction returned");
    return body.swapTransaction;
  }
}

/**
 * Whether a submitted trade landed, read from Solana itself.
 *
 * The confirm page reports a signature, but a page can report anything. So a
 * trade only counts as confirmed when the transaction exists on chain,
 * succeeded, and was signed and paid for by the wallet the trade was proposed
 * for (the fee payer is always the first account key).
 */
export async function confirmOnChain(
  rpcUrl: string,
  signature: string,
  wallet: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "confirmed" | "failed" | "pending"; error?: string }> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(4000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    }),
  });
  const body = (await res.json()) as {
    result?: {
      meta?: { err: unknown } | null;
      transaction?: { message?: { accountKeys?: ({ pubkey: string; signer?: boolean } | string)[] } };
    } | null;
  };
  const tx = body.result;
  if (!tx) return { status: "pending" };
  const first = tx.transaction?.message?.accountKeys?.[0];
  const payer = typeof first === "string" ? first : first?.pubkey;
  if (payer !== wallet) return { status: "failed", error: "that transaction wasn't signed by your linked wallet" };
  if (tx.meta?.err) return { status: "failed", error: "the swap failed on chain" };
  return { status: "confirmed" };
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T | null> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(4000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { result?: T }).result ?? null;
}

/**
 * Looks through the wallet's latest transactions for one we built: paid for
 * by the wallet, against a blockhash we handed out for this trade. Only
 * transactions since the trade was built are read.
 */
export async function findLanded(
  rpcUrl: string,
  wallet: string,
  blockhashes: string[],
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ signature: string; failed: boolean } | null> {
  if (blockhashes.length === 0) return null;
  const recent = (await rpc<{ signature: string; blockTime?: number | null }[]>(rpcUrl, "getSignaturesForAddress", [wallet, { limit: 20, commitment: "confirmed" }], fetchImpl)) ?? [];
  const candidates = recent.filter((s) => !s.blockTime || s.blockTime * 1000 >= since - 60_000).slice(0, 8);
  const found = await Promise.all(
    candidates.map(async ({ signature }) => {
      const tx = await rpc<{ transaction?: [string, string]; meta?: { err: unknown } | null }>(
        rpcUrl,
        "getTransaction",
        [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        fetchImpl,
      ).catch(() => null);
      const read = tx?.transaction?.[0] ? readTransaction(tx.transaction[0]) : null;
      return read && read.payer === wallet && blockhashes.includes(read.blockhash) ? { signature, failed: Boolean(tx?.meta?.err) } : null;
    }),
  );
  return found.find((f) => f !== null) ?? null;
}
