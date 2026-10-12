/**
 * What you paid, read from the chain: "How much have I made on Nvidia?"
 *
 * Wallets don't keep cost basis; brokers do. Afterhours has no broker
 * records, so it reconstructs them from the wallet's own Solana history:
 * every transaction where the wallet's balance of an xStock changed, paired
 * with the USDC that moved the other way in the same transaction, is a buy
 * or a sell at a real price. Average-cost accounting turns that into a cost
 * per token and realized gains.
 *
 * Tokens that arrived without USDC leaving (a transfer in, or a swap paid in
 * SOL) have an unknown cost. They're counted as held but kept out of the
 * average, and the answer says so, rather than inventing a price.
 *
 * Indexing is incremental (only signatures newer than the last one seen) and
 * runs in the background; a voice turn reads what's already indexed.
 */

import type { Services } from "../services.js";
import { USDC, listingByMint } from "../market/universe.js";

export interface PositionBasis {
  /** Tokens currently attributed by history. */
  qty: number;
  /** Of those, tokens with a known cost. */
  coveredQty: number;
  /** USD cost of the covered tokens. */
  cost: number;
  /** USD gained (or lost) on sales, at average cost. */
  realized: number;
  buys: number;
  sells: number;
  /** USD spent across all buys. */
  invested: number;
}

/** One balance change, as it would appear on a statement. */
export interface TradeRow {
  signature: string;
  /** Unix ms; null when the chain didn't say. */
  at: number | null;
  ticker: string;
  kind: "buy" | "sell" | "transfer_in" | "transfer_out";
  qty: number;
  /** USDC paid (buy) or received (sell); null when it wasn't a USDC trade. */
  usdc: number | null;
  /** Gain on a sale at average cost; null otherwise or when the cost is unknown. */
  realized: number | null;
}

export interface WalletBasis {
  wallet: string;
  positions: Record<string, PositionBasis>;
  /** Every change seen, oldest first (the last 1,000). */
  trades?: TradeRow[];
  /** Newest signature processed. */
  lastSignature: string | null;
  /** Transactions read so far. */
  transactions: number;
  indexedAt: number;
  /** True when older history exists than was read (the first pass is capped). */
  truncated: boolean;
}

const key = (wallet: string) => `basis:${wallet}`;
const STALE_MS = 10 * 60_000;
const FIRST_PASS_PAGES = 3;
const PAGE = 100;

type Rpc = <T>(method: string, params: unknown[]) => Promise<T | null>;

function rpcClient(rpcUrl: string, fetchImpl: typeof fetch): Rpc {
  return async <T>(method: string, params: unknown[]) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result ?? null;
  };
}

interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount?: { uiAmount: number | null; uiAmountString?: string };
}

/** Per-mint change in the wallet's token balances across one transaction. */
export function balanceDeltas(wallet: string, pre: TokenBalance[] = [], post: TokenBalance[] = []): Map<string, number> {
  const amount = (b: TokenBalance) => Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
  const deltas = new Map<string, number>();
  for (const b of pre) if (b.owner === wallet) deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - amount(b));
  for (const b of post) if (b.owner === wallet) deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + amount(b));
  for (const [mint, d] of deltas) if (Math.abs(d) < 1e-12) deltas.delete(mint);
  return deltas;
}

const empty = (): PositionBasis => ({ qty: 0, coveredQty: 0, cost: 0, realized: 0, buys: 0, sells: 0, invested: 0 });

/** Applies one transaction's deltas to the positions, average-cost. Returns the rows it made. */
export function applyDeltas(positions: Record<string, PositionBasis>, deltas: Map<string, number>): Omit<TradeRow, "signature" | "at">[] {
  const rows: Omit<TradeRow, "signature" | "at">[] = [];
  const usdc = deltas.get(USDC.mint) ?? 0;
  const moved = [...deltas].filter(([mint]) => listingByMint(mint));
  for (const [mint, d] of moved) {
    const ticker = listingByMint(mint)!.ticker;
    const p = (positions[ticker] ??= empty());
    // USDC is only attributable when a single xStock moved against it.
    const priced = moved.length === 1 && Math.sign(usdc) === -Math.sign(d) && usdc !== 0;
    if (d > 0) {
      p.qty += d;
      if (priced) {
        p.coveredQty += d;
        p.cost += -usdc;
        p.invested += -usdc;
        p.buys += 1;
      }
      rows.push({ ticker, kind: priced ? "buy" : "transfer_in", qty: d, usdc: priced ? -usdc : null, realized: null });
    } else {
      const sold = Math.min(-d, p.qty);
      const share = p.qty > 0 ? sold / p.qty : 0;
      const coveredSold = p.coveredQty * share;
      const costOut = p.cost * share;
      const gain = priced && coveredSold > 0 ? usdc * (coveredSold / sold) - costOut : null;
      if (gain !== null) p.realized += gain;
      if (priced) p.sells += 1;
      rows.push({ ticker, kind: priced ? "sell" : "transfer_out", qty: -d, usdc: priced ? usdc : null, realized: gain === null ? null : Math.round(gain * 100) / 100 });
      p.qty -= sold;
      p.coveredQty -= coveredSold;
      p.cost -= costOut;
    }
  }
  return rows;
}

/**
 * Reads the wallet's history newer than what's indexed and updates the
 * stored basis. The first pass reads up to 300 signatures.
 */
export async function indexWallet(svc: Services, wallet: string, fetchImpl: typeof fetch = fetch): Promise<WalletBasis> {
  const rpc = rpcClient(svc.rpcUrl, fetchImpl);
  const held = await svc.store.get<WalletBasis>(key(wallet));
  const basis: WalletBasis = held ?? { wallet, positions: {}, lastSignature: null, transactions: 0, indexedAt: 0, truncated: false };

  const fresh: { signature: string; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < (held ? 10 : FIRST_PASS_PAGES); page += 1) {
    const opts: Record<string, unknown> = { limit: PAGE, commitment: "confirmed" };
    if (before) opts.before = before;
    if (basis.lastSignature) opts.until = basis.lastSignature;
    const sigs = (await rpc<{ signature: string; err: unknown; blockTime?: number | null }[]>("getSignaturesForAddress", [wallet, opts])) ?? [];
    fresh.push(...sigs);
    if (sigs.length < PAGE) break;
    before = sigs.at(-1)!.signature;
    if (!held && page === FIRST_PASS_PAGES - 1) basis.truncated = true;
  }

  // Oldest first, so average cost accrues in order. A few at a time, to be
  // gentle with public RPC.
  const ordered = fresh.filter((s) => !s.err).reverse();
  for (let i = 0; i < ordered.length; i += 4) {
    const batch = ordered.slice(i, i + 4);
    const txs = await Promise.all(
      batch.map((s) =>
        rpc<{ meta?: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null }>("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
        ]).catch(() => null),
      ),
    );
    txs.forEach((tx, j) => {
      if (!tx?.meta || tx.meta.err) return;
      const made = applyDeltas(basis.positions, balanceDeltas(wallet, tx.meta.preTokenBalances, tx.meta.postTokenBalances));
      const { signature, blockTime } = batch[j];
      basis.trades = [...(basis.trades ?? []), ...made.map((r) => ({ ...r, signature, at: blockTime ? blockTime * 1000 : null }))].slice(-1000);
    });
  }
  if (fresh.length) basis.lastSignature = fresh[0].signature;
  basis.transactions += ordered.length;
  basis.indexedAt = svc.now();
  await svc.store.set(key(wallet), basis);
  return basis;
}

const running = new Set<string>();

/**
 * The wallet's basis as indexed, starting a background refresh when it's
 * stale. Null until the first pass has finished.
 */
export async function readBasis(svc: Services, wallet: string): Promise<WalletBasis | null> {
  if (svc.sample) return sampleBasis(wallet, svc.now());
  const held = await svc.store.get<WalletBasis>(key(wallet));
  if ((!held || svc.now() - held.indexedAt > STALE_MS) && !running.has(wallet)) {
    running.add(wallet);
    const work = indexWallet(svc, wallet).finally(() => running.delete(wallet));
    if (!held) return work.catch(() => null);
    void work.catch(() => null);
  }
  return held;
}

/** The sample portfolio's history: a few buys over the summer, one trim. */
export function sampleBasis(wallet: string, now: number): WalletBasis {
  const positions: Record<string, PositionBasis> = {
    NVDA: { qty: 12, coveredQty: 12, cost: 12 * 198.4, realized: 0, buys: 4, sells: 0, invested: 12 * 198.4 },
    AAPL: { qty: 6.5, coveredQty: 6.5, cost: 6.5 * 341.1, realized: 0, buys: 2, sells: 0, invested: 6.5 * 341.1 },
    TSLA: { qty: 4.25, coveredQty: 4.25, cost: 4.25 * 318.9, realized: 61.2, buys: 3, sells: 1, invested: 5.25 * 318.9 },
    SPY: { qty: 1.8, coveredQty: 1.8, cost: 1.8 * 701.5, realized: 0, buys: 6, sells: 0, invested: 1.8 * 701.5 },
  };
  // A plausible history behind those positions, spread over the summer.
  const trades: TradeRow[] = [];
  const day = 86_400_000;
  let n = 0;
  for (const [ticker, p] of Object.entries(positions)) {
    const bought = p.invested / (p.cost / p.coveredQty);
    for (let i = 0; i < p.buys; i += 1) {
      n += 1;
      trades.push({ signature: `sample${String(n).padStart(3, "0")}`, at: now - (120 - n * 4) * day, ticker, kind: "buy", qty: bought / p.buys, usdc: p.invested / p.buys, realized: null });
    }
    if (p.sells) {
      n += 1;
      const sold = bought - p.qty;
      trades.push({ signature: `sample${String(n).padStart(3, "0")}`, at: now - (120 - n * 4) * day, ticker, kind: "sell", qty: sold, usdc: sold * (p.cost / p.coveredQty) + p.realized, realized: p.realized });
    }
  }
  trades.sort((a, b) => a.at! - b.at!);
  return { wallet, positions, trades, lastSignature: null, transactions: 41, indexedAt: now, truncated: false };
}
