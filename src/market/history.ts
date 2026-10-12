/**
 * Does the overnight move hold at the open?
 *
 * A token that's up 2% on a Sunday is a forecast of Monday's open, and a
 * listener deserves to know how good that forecast usually is. For every
 * market open in the last month this computes two numbers against the
 * previous regular-session close:
 *
 * - the overnight call: where the token traded at 9 a.m. Eastern, half an
 *   hour before the bell;
 * - what happened: where the real share actually opened at 9:30.
 *
 * Sources, both public and keyless (as in Kolu): hourly candles from the
 * xStock's deepest on-chain pool on GeckoTerminal, and the share's 15-minute
 * bars, pre- and post-market included, from Yahoo's chart endpoint. Both are
 * unofficial and rate-limited, so this runs once a day in the background and
 * every failure just leaves yesterday's records in place.
 */

import type { Services } from "../services.js";
import { LISTINGS, listingByTicker } from "./universe.js";
import { easternToUtc, regularCloseMinute, toEasternParts } from "./session.js";
import { SAMPLE_BOARD } from "./prices.js";

export interface Bar {
  /** Unix seconds, bar start. */
  t: number;
  open: number;
  close: number;
}

export interface OpenRecord {
  /** Trading day, `YYYY-MM-DD` in New York. */
  date: string;
  /** Previous regular-session close of the share. */
  prevClose: number;
  /** Token price at 9:00 ET (close of the 8:00 hourly bar). */
  tokenPreOpen: number;
  /** The share's first regular-session price. */
  shareOpen: number;
  /** tokenPreOpen vs prevClose, basis points. */
  overnightBps: number;
  /** shareOpen vs prevClose, basis points. */
  openBps: number;
}

/** Deepest pools per xStock on GeckoTerminal (from Kolu), so a refresh is one request per name. */
export const KNOWN_POOLS: Record<string, string> = {
  TSLA: "8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF",
  NVDA: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6",
  SPY: "7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49",
  AAPL: "CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y",
  QQQ: "GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG",
  MSFT: "CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL",
  META: "3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j",
  AMZN: "6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD",
  GOOGL: "B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw",
  COIN: "w7SGmPeXoMCsjvXqgsAmUn56uypyDsjAtsxeVkaiqxa",
  MSTR: "2ngTuP7xA581dqX9uJkGRqxmKuehY3k4SDfPebeoRG2J",
  CRCL: "GYqHjuDzTiw7i52Xv1qohDE6eJr6eSZpsrBVikGZyaFV",
};

const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; Afterhours/0.2)", accept: "application/json" };

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    // GeckoTerminal's free tier is ~30 requests a minute and shared by IP;
    // back off twice (3s, then 10s) before giving up on this name for today.
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 3_000 : 10_000));
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return res.json();
  }
}

/** The most liquid pool for a mint, for names without a known pool. */
async function deepestPool(mint: string, fetchImpl: typeof fetch): Promise<string | null> {
  const body = (await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`, fetchImpl)) as {
    data?: { attributes?: { address?: string; reserve_in_usd?: string } }[];
  };
  const pools = (body.data ?? [])
    .map((p) => ({ address: p.attributes?.address, reserve: Number(p.attributes?.reserve_in_usd ?? 0) }))
    .filter((p): p is { address: string; reserve: number } => typeof p.address === "string")
    .sort((a, b) => b.reserve - a.reserve);
  return pools[0]?.address ?? null;
}

/** ~30 days of hourly token candles from the deepest pool. */
export async function tokenHourly(ticker: string, fetchImpl: typeof fetch = fetch): Promise<Bar[]> {
  const listing = listingByTicker(ticker);
  if (!listing) return [];
  const pool = KNOWN_POOLS[ticker] ?? (await deepestPool(listing.mint, fetchImpl));
  if (!pool) return [];
  const body = (await getJson(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=720&currency=usd&token=${listing.mint}`,
    fetchImpl,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  return (body.data?.attributes?.ohlcv_list ?? [])
    .filter((row) => row.length >= 5 && row[4] > 0)
    .map((row) => ({ t: row[0], open: row[1], close: row[4] }));
}

/** A month of the share's 15-minute bars, extended hours included. */
export async function shareBars(ticker: string, fetchImpl: typeof fetch = fetch): Promise<Bar[]> {
  const body = (await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=15m&range=1mo&includePrePost=true`,
    fetchImpl,
  )) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; close?: (number | null)[] }[] } }[] } };
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const out: Bar[] = [];
  (result?.timestamp ?? []).forEach((t, i) => {
    const open = quote?.open?.[i];
    const close = quote?.close?.[i];
    if (typeof close === "number" && close > 0) out.push({ t, open: typeof open === "number" && open > 0 ? open : close, close });
  });
  return out.sort((a, b) => a.t - b.t);
}

const OPEN_MINUTE = 9 * 60 + 30;

/**
 * One record per trading day that has a previous close, a 9:30 share bar and
 * a token price at 9:00. Days missing any of the three are skipped rather
 * than guessed.
 */
export function openRecords(token: Bar[], share: Bar[]): OpenRecord[] {
  // Regular-session bars, grouped by New York trading day.
  const days = new Map<string, Bar[]>();
  for (const b of share) {
    const et = toEasternParts(new Date(b.t * 1000));
    if (et.minutes >= OPEN_MINUTE && et.minutes < regularCloseMinute(et.date)) {
      const list = days.get(et.date) ?? [];
      list.push(b);
      days.set(et.date, list);
    }
  }
  const dates = [...days.keys()].sort();
  const tokenSorted = [...token].sort((a, b) => a.t - b.t);
  const out: OpenRecord[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    const today = days.get(dates[i])!;
    const yesterday = days.get(dates[i - 1])!;
    const first = today[0];
    if (toEasternParts(new Date(first.t * 1000)).minutes !== OPEN_MINUTE) continue;
    const prevClose = yesterday[yesterday.length - 1].close;
    // The hourly bar that closes at 9:00 ET starts at 8:00 ET.
    const nineEt = easternToUtc(dates[i], 9 * 60).getTime() / 1000;
    let pre: Bar | undefined;
    for (const b of tokenSorted) {
      if (b.t + 3600 <= nineEt) pre = b;
      else break;
    }
    if (!pre || nineEt - (pre.t + 3600) > 3 * 3600) continue;
    out.push({
      date: dates[i],
      prevClose,
      tokenPreOpen: pre.close,
      shareOpen: first.open,
      overnightBps: Math.round((pre.close / prevClose - 1) * 100_000) / 10,
      openBps: Math.round((first.open / prevClose - 1) * 100_000) / 10,
    });
  }
  return out;
}

export interface TrackRecord {
  /** Opens where the token had moved meaningfully overnight. */
  calls: number;
  /** Of those, how many opened in the same direction. */
  sameDirection: number;
  /** Median |open − overnight call|, basis points. */
  medianMissBps: number;
  /** Opens in the window, including quiet ones. */
  opens: number;
  from: string | null;
  to: string | null;
}

/** Below this, the token didn't really "call" anything. */
export const CALL_THRESHOLD_BPS = 20;

export function trackRecord(records: OpenRecord[]): TrackRecord {
  const calls = records.filter((r) => Math.abs(r.overnightBps) >= CALL_THRESHOLD_BPS);
  const misses = calls.map((r) => Math.abs(r.openBps - r.overnightBps)).sort((a, b) => a - b);
  return {
    calls: calls.length,
    sameDirection: calls.filter((r) => Math.sign(r.openBps) === Math.sign(r.overnightBps)).length,
    medianMissBps: misses.length ? Math.round(misses[Math.floor(misses.length / 2)]) : 0,
    opens: records.length,
    from: records[0]?.date ?? null,
    to: records.at(-1)?.date ?? null,
  };
}

const key = (ticker: string) => `opens:${ticker}`;
const REFRESHED = "opens:refreshedAt";
const REFRESH_EVERY_MS = 12 * 3600_000;

export async function readOpens(svc: Services, ticker: string): Promise<OpenRecord[]> {
  return (await svc.store.get<OpenRecord[]>(key(ticker))) ?? [];
}

/**
 * Rebuilds every name's records from the public sources, gently (one name at
 * a time, spaced out for GeckoTerminal's free tier). A name whose sources fail
 * keeps its previous records.
 */
export async function refreshOpenHistory(svc: Services, fetchImpl: typeof fetch = fetch, spacingMs = 2_500): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];
  for (const l of LISTINGS) {
    try {
      const [token, share] = await Promise.all([tokenHourly(l.ticker, fetchImpl), shareBars(l.ticker, fetchImpl)]);
      const records = openRecords(token, share);
      if (records.length === 0) throw new Error("no complete opens");
      await svc.store.set(key(l.ticker), records.slice(-40));
      updated.push(l.ticker);
    } catch {
      failed.push(l.ticker);
    }
    if (spacingMs) await new Promise((r) => setTimeout(r, spacingMs));
  }
  await svc.store.set(REFRESHED, svc.now());
  return { updated, failed };
}

/** Starts a refresh if the last one is older than 12 hours. Never awaited by a request. */
export async function refreshOpenHistoryIfStale(svc: Services): Promise<boolean> {
  if (svc.sample) return false;
  const last = (await svc.store.get<number>(REFRESHED)) ?? 0;
  if (svc.now() - last < REFRESH_EVERY_MS) return false;
  // Claim the refresh so concurrent tape samples don't all start one.
  if (!(await svc.store.setNew("opens:refreshing", true, 600))) return false;
  void refreshOpenHistory(svc).finally(() => svc.store.del("opens:refreshing"));
  return true;
}

/**
 * The sample board's history: 20 opens where the token called the open's
 * direction most of the time, with misses scaled to each name. Deterministic,
 * and only ever used (and labelled) with sample data.
 */
export function sampleOpens(ticker: string, now: number): OpenRecord[] {
  const share = SAMPLE_BOARD[ticker]?.share ?? 100;
  const out: OpenRecord[] = [];
  const day = 86_400_000;
  let seed = [...ticker].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 4_294_967_296);
  for (let back = 40; out.length < 20 && back > 0; back -= 1) {
    const at = new Date(now - back * day);
    const et = toEasternParts(at);
    if (et.weekday === 0 || et.weekday === 6) continue;
    const overnight = (rand() - 0.45) * 260;
    const flip = rand() < 0.18;
    const open = flip ? -overnight * rand() * 0.6 : overnight * (0.55 + rand() * 0.6);
    out.push({
      date: et.date,
      prevClose: share,
      tokenPreOpen: share * (1 + overnight / 10_000),
      shareOpen: share * (1 + open / 10_000),
      overnightBps: Math.round(overnight * 10) / 10,
      openBps: Math.round(open * 10) / 10,
    });
  }
  return out;
}
