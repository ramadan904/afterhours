/**
 * The open, scored: did the overnight move hold?
 *
 * All night the token makes a call on where the share will open. At 9:30
 * the exchange answers. A few minutes in, Afterhours pushes the answer for
 * the names each person holds or watches: "Tesla opened up 1.9 percent. Its
 * token had called up 2.1 percent." The same results answer "how did the open
 * go?" for the rest of the day.
 *
 * Just before the open, the sampler keeps a snapshot of each share's previous
 * close and the token's move against it (the call). Once the regular session
 * is a few minutes old, the share's live price gives the open move.
 */

import type { Services } from "../services.js";
import type { GapReading } from "../market/gap.js";
import type { Board } from "../market/prices.js";
import { getMarketSession, toEasternParts } from "../market/session.js";
import { listingByTicker } from "../market/universe.js";
import { getWatchlist } from "../market/watchlist.js";
import { notify, pushAccounts, type Notice } from "./push.js";
import { walletOf } from "./wallet-watch.js";

export interface OpenResult {
  ticker: string;
  /** The token's move against the previous close just before 9:30, bps. */
  calledBps: number;
  /** The share's move against the previous close a few minutes into the session, bps. */
  openBps: number;
}

const OPEN = 9 * 60 + 30;
const snapKey = (date: string) => `preopen:${date}`;
export const openKey = (date: string) => `openday:${date}`;

/** Called on every tape sample. Returns how many accounts were told. */
export async function trackOpen(svc: Services, board: Board, readings: GapReading[]): Promise<number> {
  if (svc.sample) return 0;
  const now = svc.now();
  const session = getMarketSession(new Date(now));
  const { minutes } = toEasternParts(new Date(now));
  const date = session.etDate;

  // The half hour before the bell: keep the latest call against yesterday's close.
  if (session.phase === "premarket" && minutes >= OPEN - 30) {
    const snap: Record<string, { prevClose: number; calledBps: number }> = {};
    for (const r of readings) {
      const q = board.quotes.get(r.ticker);
      if (q?.sharePrice && r.gapBps !== null && (r.kind === "overnight_move" || r.kind === "in_line")) snap[r.ticker] = { prevClose: q.sharePrice, calledBps: r.gapBps };
    }
    if (Object.keys(snap).length) await svc.store.set(snapKey(date), snap, 2 * 86_400);
    return 0;
  }

  // A few minutes in, once: score it.
  if (!session.isRegularHours || minutes < OPEN + 5 || minutes >= OPEN + 30) return 0;
  const snap = await svc.store.get<Record<string, { prevClose: number; calledBps: number }>>(snapKey(date));
  if (!snap || !(await svc.store.setNew(`openscored:${date}`, true, 2 * 86_400))) return 0;
  const results: OpenResult[] = [];
  for (const [ticker, s] of Object.entries(snap)) {
    const share = board.quotes.get(ticker)?.sharePrice;
    if (!share) continue;
    results.push({ ticker, calledBps: s.calledBps, openBps: Math.round((share / s.prevClose - 1) * 100_000) / 10 });
  }
  await svc.store.set(openKey(date), results, 3 * 86_400);

  let told = 0;
  for (const sub of await pushAccounts(svc)) {
    const wallet = await walletOf(svc, sub);
    const held = wallet ? ((await svc.holdings.read(wallet).catch(() => [])) ?? []).map((h) => h.ticker) : [];
    const mine = new Set([...held, ...(await getWatchlist(svc.store, sub))]);
    const notice = openNotice(results.filter((r) => mine.has(r.ticker)), svc.baseUrl);
    if (notice && (await notify(svc, sub, notice).catch(() => 0)) > 0) told += 1;
  }
  return told;
}

const signed = (bps: number) => `${bps >= 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}%`;
const name = (t: string) => (listingByTicker(t)?.spoken ?? t).replace(/^the /, "").replace(/^./, (c) => c.toUpperCase());

/** "At the open: Tesla +1.9%, Nvidia +0.8%" with what each token had called. */
export function openNotice(results: OpenResult[], baseUrl: string): Notice | null {
  const worth = results.filter((r) => Math.abs(r.calledBps) >= 20 || Math.abs(r.openBps) >= 20).sort((a, b) => Math.abs(b.openBps) - Math.abs(a.openBps)).slice(0, 3);
  if (!worth.length) return null;
  const held = worth.filter((r) => Math.sign(r.calledBps) === Math.sign(r.openBps) || Math.abs(r.calledBps) < 20).length;
  return {
    title: `At the open: ${worth.map((r) => `${name(r.ticker)} ${signed(r.openBps)}`).join(", ")}`,
    body: `${worth.map((r) => `${name(r.ticker)}'s token had called ${signed(r.calledBps)}`).join("; ")}. ${held === worth.length ? "The overnight moves held." : held === 0 ? "The overnight moves didn't hold." : "Some overnight moves held, some didn't."}`,
    url: `${baseUrl}/app/`,
    tag: "open-verdict",
  };
}
