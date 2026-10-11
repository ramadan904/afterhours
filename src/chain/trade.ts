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

import { randomBytes, randomInt } from "node:crypto";
import type { Store } from "../store/store.js";
import { USDC, listingByTicker } from "../market/universe.js";

export type TradeSide = "buy" | "sell";

export type TradeStatus = "awaiting_signature" | "submitted" | "confirmed" | "failed" | "expired" | "cancelled";

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
}

export const INTENT_TTL_SECONDS = 15 * 60;

export function maxTradeUsd(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MAX_TRADE_USD);
  return Number.isFinite(v) && v > 0 ? v : 500;
}

export async function createIntent(
  store: Store,
  input: Omit<TradeIntent, "id" | "code" | "createdAt" | "expiresAt" | "status">,
  now = Date.now(),
): Promise<TradeIntent> {
  const id = randomBytes(16).toString("base64url");
  // Six digits is what a person can hold in their head between hearing it and
  // typing it. Collisions are retried rather than allowed to overwrite.
  let code = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (await store.setNew(`code:${candidate}`, id, INTENT_TTL_SECONDS)) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("Could not allocate a confirmation code");

  const intent: TradeIntent = {
    ...input,
    id,
    code,
    createdAt: now,
    expiresAt: now + INTENT_TTL_SECONDS * 1000,
    status: "awaiting_signature",
  };
  await store.set(`intent:${id}`, intent, INTENT_TTL_SECONDS * 4);
  await store.set(`latest-intent:${input.sub}`, id, INTENT_TTL_SECONDS * 4);
  return intent;
}

export async function intentByCode(store: Store, code: string, now = Date.now()): Promise<TradeIntent | null> {
  const id = await store.get<string>(`code:${code.replace(/\D/g, "")}`);
  return id ? getIntent(store, id, now) : null;
}

export async function getIntent(store: Store, id: string, now = Date.now()): Promise<TradeIntent | null> {
  const intent = await store.get<TradeIntent>(`intent:${id}`);
  if (intent && intent.status === "awaiting_signature" && intent.expiresAt <= now) {
    intent.status = "expired";
  }
  return intent;
}

export async function saveIntent(store: Store, intent: TradeIntent): Promise<void> {
  // The code keeps pointing at the intent until it expires, so the confirm
  // page can keep showing its progress after it has been signed.
  await store.set(`intent:${intent.id}`, intent, INTENT_TTL_SECONDS * 4);
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
