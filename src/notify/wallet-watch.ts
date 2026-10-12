/**
 * "4.25 TSLAx just left your wallet."
 *
 * Afterhours can't move funds, so it can't steal or protect them either. What
 * it can do is notice. Every account with notifications on has its wallet's
 * xStock balances compared on each tape sample (every 5 minutes). A change
 * that a trade Afterhours prepared and saw confirmed explains is left alone;
 * anything else is pushed:
 *
 * - tokens leaving: the drained-wallet case, where minutes matter;
 * - tokens arriving: a transfer, or a trade made somewhere else.
 *
 * The first look at a wallet only records a baseline.
 */

import type { Services } from "../services.js";
import type { Notice } from "./push.js";
import { listSubscriptions, notify } from "./push.js";
import type { TradeIntent } from "../chain/trade.js";
import { listingByTicker } from "../market/universe.js";
import { usd } from "../market/speech.js";

const INDEX = "walletwatch:index";
const snapKey = (sub: string) => `walletsnap:${sub}`;
const settledKey = (wallet: string) => `settled:${wallet}`;
const EXPLAIN_MS = 30 * 60_000;
const MAX_WATCHED = 500;

export async function watchWallet(svc: Services, sub: string, wallet: string): Promise<void> {
  const index = (await svc.store.get<{ sub: string; wallet: string }[]>(INDEX)) ?? [];
  if (index.some((e) => e.sub === sub && e.wallet === wallet)) return;
  await svc.store.set(INDEX, [...index.filter((e) => e.sub !== sub), { sub, wallet }].slice(-MAX_WATCHED));
}

/** Remembers a trade that landed, so its balance change isn't reported as a surprise. */
export async function noteSettled(svc: Services, intent: TradeIntent): Promise<void> {
  if (intent.status !== "confirmed") return;
  const list = (await svc.store.get<{ ticker: string; side: string; at: number }[]>(settledKey(intent.wallet))) ?? [];
  await svc.store.set(settledKey(intent.wallet), [...list, { ticker: intent.ticker, side: intent.side, at: svc.now() }].slice(-20), 3600);
}

const amount = (n: number) => (Math.abs(n) >= 100 ? Math.abs(n).toFixed(0) : Number(Math.abs(n).toPrecision(4)).toString());

export function walletNotice(moves: { ticker: string; delta: number; price?: number }[], baseUrl: string): Notice {
  const out = moves.filter((m) => m.delta < 0);
  const tokens = (list: typeof moves) => list.map((m) => `${amount(m.delta)} ${listingByTicker(m.ticker)?.token ?? m.ticker}`).join(" and ");
  const worth = (list: typeof moves) => list.reduce((t, m) => t + Math.abs(m.delta) * (m.price ?? 0), 0);
  if (out.length) {
    const value = worth(out);
    return {
      title: `${tokens(out)} left your wallet`,
      body: `${value >= 1 ? `About ${usd(value)}. ` : ""}That wasn't a trade Afterhours prepared. If it wasn't you, move what's left to a wallet only you control. Afterhours can't move funds.`,
      url: `${baseUrl}/app/`,
      tag: "wallet-watch",
    };
  }
  const value = worth(moves);
  return {
    title: `${tokens(moves)} arrived in your wallet`,
    body: `${value >= 1 ? `Worth about ${usd(value)} now. ` : ""}A transfer in, or a trade made outside Afterhours.`,
    url: `${baseUrl}/app/`,
    tag: "wallet-watch",
  };
}

/** Compares each watched wallet with its last snapshot. Returns how many notices went out. */
export async function checkWallets(svc: Services, prices: Map<string, number>): Promise<number> {
  if (svc.sample) return 0;
  const index = (await svc.store.get<{ sub: string; wallet: string }[]>(INDEX)) ?? [];
  const now = svc.now();
  let sent = 0;
  for (const { sub, wallet } of index) {
    if ((await listSubscriptions(svc, sub)).length === 0) continue;
    const holdings = await svc.holdings.read(wallet).catch(() => null);
    if (!holdings) continue;
    const current = Object.fromEntries(holdings.map((h) => [h.ticker, h.amount]));
    const previous = await svc.store.get<Record<string, number>>(snapKey(sub));
    await svc.store.set(snapKey(sub), current);
    if (!previous) continue;

    const settled = ((await svc.store.get<{ ticker: string; side: string; at: number }[]>(settledKey(wallet))) ?? []).filter((s) => now - s.at < EXPLAIN_MS);
    const moves = [...new Set([...Object.keys(current), ...Object.keys(previous)])]
      .map((ticker) => ({ ticker, delta: (current[ticker] ?? 0) - (previous[ticker] ?? 0), price: prices.get(ticker) }))
      .filter((m) => Math.abs(m.delta) > 1e-9)
      .filter((m) => !settled.some((s) => s.ticker === m.ticker && (s.side === "buy") === m.delta > 0));
    if (!moves.length) continue;
    if ((await notify(svc, sub, walletNotice(moves, svc.baseUrl)).catch(() => 0)) > 0) sent += 1;
  }
  return sent;
}
