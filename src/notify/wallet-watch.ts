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
 * A split or a dividend paid as tokens changes every holder's balance with no
 * transfer at all (Token-2022's scaled UI amount). Those are read from the
 * mint and taken out before comparing, and holders hear about them ahead of
 * time instead.
 *
 * The first look at a wallet only records a baseline.
 */

import type { Services } from "../services.js";
import type { Notice } from "./push.js";
import { channelCount, notify } from "./push.js";
import type { TradeIntent } from "../chain/trade.js";
import { listingByTicker } from "../market/universe.js";
import { mintsOf, multiplierAt } from "../chain/mint-facts.js";
import { rescaleSentence } from "../market/safety-talk.js";
import { getZone } from "../market/zones.js";
import { usd } from "../market/speech.js";
import { logActivity } from "../account/activity.js";

const INDEX = "walletwatch:index";
const snapKey = (sub: string) => `walletsnap:${sub}`;
const settledKey = (wallet: string) => `settled:${wallet}`;
const EXPLAIN_MS = 30 * 60_000;

interface Settled {
  ticker: string;
  side: string;
  at: number;
  /** Tokens the trade moved, estimated from its size and price. */
  qty?: number;
}
const MAX_WATCHED = 500;

interface Snapshot {
  at: number;
  balances: Record<string, number>;
}
const isSnapshot = (v: Snapshot | Record<string, number>): v is Snapshot => typeof (v as Snapshot).balances === "object" && typeof (v as Snapshot).at === "number";

export async function watchWallet(svc: Services, sub: string, wallet: string): Promise<void> {
  const index = (await svc.store.get<{ sub: string; wallet: string }[]>(INDEX)) ?? [];
  if (index.some((e) => e.sub === sub && e.wallet === wallet)) return;
  await svc.store.set(INDEX, [...index.filter((e) => e.sub !== sub), { sub, wallet }].slice(-MAX_WATCHED));
}

/** Remembers a trade that landed, so its balance change isn't reported as a surprise. */
export async function noteSettled(svc: Services, intent: TradeIntent): Promise<void> {
  if (intent.status !== "confirmed") return;
  const list = (await svc.store.get<Settled[]>(settledKey(intent.wallet))) ?? [];
  // Roughly how many tokens it moved: the fill differs from the proposal price a little.
  const qty = intent.priceAtProposal > 0 ? intent.usd / intent.priceAtProposal : 0;
  await svc.store.set(settledKey(intent.wallet), [...list, { ticker: intent.ticker, side: intent.side, at: svc.now(), qty }].slice(-20), 3600);
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
    if ((await channelCount(svc, sub)) === 0) continue;
    const holdings = await svc.holdings.read(wallet).catch(() => null);
    if (!holdings) continue;
    const current = Object.fromEntries(holdings.map((h) => [h.ticker, h.amount]));
    const held = await svc.store.get<Snapshot | Record<string, number>>(snapKey(sub));
    await svc.store.set(snapKey(sub), { at: now, balances: current } satisfies Snapshot);
    if (!held) continue;
    // Older snapshots were the balances alone, with no time.
    const previous = isSnapshot(held) ? held.balances : held;
    const previousAt = isSnapshot(held) ? held.at : null;

    const settled = ((await svc.store.get<Settled[]>(settledKey(wallet))) ?? []).filter((s) => now - s.at < EXPLAIN_MS);
    const changed = [...new Set([...Object.keys(current), ...Object.keys(previous)])].filter((t) => Math.abs((current[t] ?? 0) - (previous[t] ?? 0)) > 1e-6);
    const moves = (
      await Promise.all(
        changed.map(async (ticker) => {
          // What the old balance is worth after any split or dividend in between.
          let was = previous[ticker] ?? 0;
          const listing = listingByTicker(ticker);
          if (was > 0 && previousAt !== null && listing) {
            const f = await mintsOf(svc).facts(listing, now).catch(() => null);
            if (f) was *= multiplierAt(f, now) / multiplierAt(f, previousAt);
          }
          const delta = (current[ticker] ?? 0) - was;
          // A confirmed trade explains about its own size (15% slack for the fill),
          // never the rest: a small sale can't hide the position being drained.
          const explained = settled.filter((s) => s.ticker === ticker && (s.side === "buy") === delta > 0).reduce((t, s) => t + (s.qty ?? Infinity) * 1.15, 0);
          const residual = Math.max(0, Math.abs(delta) - explained);
          return { ticker, delta: Math.sign(delta) * residual, price: prices.get(ticker) };
        }),
      )
    ).filter((m) => Math.abs(m.delta) > 1e-6);
    if (!moves.length) continue;
    const notice = walletNotice(moves, svc.baseUrl);
    await logActivity(svc.store, sub, { at: now, kind: "wallet.moved", text: `${notice.title}, not through a trade Afterhours prepared.`, ok: !moves.some((m) => m.delta < 0) }).catch(() => undefined);
    if ((await notify(svc, sub, notice).catch(() => 0)) > 0) sent += 1;
  }
  return sent;
}

/** "dividend", "split", "reverse split", or "corporate action" for anything else. */
export function rescaleKind(from: number, to: number): string {
  const r = to / from;
  const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-6 && Math.round(x) >= 2;
  if (whole(r)) return "split";
  if (whole(1 / r)) return "reverse split";
  if (r > 1 && r < 1.2) return "dividend";
  return "corporate action";
}

/**
 * Tells holders about a split or a dividend before it lands: once per account,
 * token and scheduled time, as soon as the mint shows it.
 */
export async function checkCorporateActions(svc: Services): Promise<number> {
  if (svc.sample && !svc.mints) return 0;
  const index = (await svc.store.get<{ sub: string; wallet: string }[]>(INDEX)) ?? [];
  const now = svc.now();
  let sent = 0;
  for (const { sub, wallet } of index) {
    if ((await channelCount(svc, sub)) === 0) continue;
    const holdings = await svc.holdings.read(wallet).catch(() => null);
    for (const h of holdings ?? []) {
      const listing = listingByTicker(h.ticker);
      if (!listing || !(h.amount > 0)) continue;
      const f = await mintsOf(svc).facts(listing, now).catch(() => null);
      const s = f?.scaledUiAmount;
      if (!s?.next) continue;
      const ttl = Math.max(86_400, Math.ceil((s.next.at - now) / 1000) + 86_400);
      if ((await svc.store.incr(`corpaction:${sub}:${listing.mint}:${s.next.at}`, ttl)) > 1) continue;
      const zone = await getZone(svc.store, sub);
      const sentence = rescaleSentence(listing, s.multiplier, s.next.multiplier, s.next.at, zone);
      const kind = rescaleKind(s.multiplier, s.next.multiplier);
      await logActivity(svc.store, sub, { at: now, kind: "token.corporate_action", text: `A ${kind} is scheduled for your ${listing.spoken} tokens.`, ok: true }).catch(() => undefined);
      const n = await notify(svc, sub, { title: `A ${kind} is coming to your ${listing.token}`, body: sentence, url: `${svc.baseUrl}/app/`, tag: `corp-${listing.ticker}` }).catch(() => 0);
      if (n > 0) sent += 1;
    }
  }
  return sent;
}

/** The wallet an account watches, if it has one on file. */
export async function walletOf(svc: Services, sub: string): Promise<string | null> {
  const index = (await svc.store.get<{ sub: string; wallet: string }[]>(INDEX)) ?? [];
  return index.find((e) => e.sub === sub)?.wallet ?? null;
}
