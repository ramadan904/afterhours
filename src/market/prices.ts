/**
 * Prices for both legs of every pair: the token, and the share it tracks.
 *
 * Jupiter's price endpoint answers both in one keyless call — the on-chain
 * token price and, for tokenized equities, the underlying share's last print
 * with its timestamp:
 *
 *   { "<mint>": { usdPrice: 333.96, stockData: { price: 334.875, updatedAt } } }
 *
 * While the US market is shut, that share print is the last close, so the gap
 * between the two *is* the overnight move: what the token market has decided
 * while the share could not trade.
 *
 * Alexa+ expects an MCP round trip under 500ms. A tool that waits on an
 * upstream API every time it is asked cannot promise that, so prices are served
 * from a short-lived cache that refreshes behind the request
 * (stale-while-revalidate). Only a cold cache waits on the network.
 */

import { LISTINGS, type Listing } from "./universe.js";
import { getMarketSession, lastRegularClose } from "./session.js";

export interface PairQuote {
  ticker: string;
  /** Token price in USD. */
  tokenPrice: number;
  /** Underlying share's last print in USD; null when the venue sent none. */
  sharePrice: number | null;
  /** Unix ms of the share print; null when unknown. */
  shareUpdatedAt: number | null;
  /**
   * USD of on-chain liquidity behind the token price, as Jupiter reports it;
   * absent when the source doesn't say. A few dollars means the "price" is
   * the last stray swap in a dead pool.
   */
  liquidityUsd?: number | null;
}

export interface Board {
  /** Unix ms when the board was read. */
  at: number;
  /**
   * `jupiter` is live mainnet data. `sample` is the built-in offline board,
   * and every answer built from it says so.
   */
  source: "jupiter" | "sample";
  quotes: Map<string, PairQuote>;
}

export interface PriceSource {
  read(): Promise<Board>;
}

export class PriceSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceSourceError";
  }
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class JupiterPrices implements PriceSource {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.endpoint = (options.endpoint ?? "https://lite-api.jup.ag").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  /** Jupiter's price endpoint takes at most 50 ids a call. */
  static readonly MAX_IDS = 50;

  private async fetchChunk(mints: string[]): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/price/v3?ids=${mints.join(",")}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
    } catch (err) {
      throw new PriceSourceError(`Jupiter prices unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new PriceSourceError(`Jupiter prices: HTTP ${res.status}`);
    return ((await res.json()) as Record<string, unknown>) ?? {};
  }

  async read(): Promise<Board> {
    const mints = LISTINGS.map((l) => l.mint);
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += JupiterPrices.MAX_IDS) chunks.push(mints.slice(i, i + JupiterPrices.MAX_IDS));
    // Chunks are read in parallel; one failing chunk costs only its names, so
    // the board degrades rather than going dark. All failing is an outage.
    const settled = await Promise.allSettled(chunks.map((c) => this.fetchChunk(c)));
    const ok = settled.filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === "fulfilled");
    if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    const body = Object.assign({}, ...ok.map((r) => r.value)) as Record<string, unknown>;
    const quotes = new Map<string, PairQuote>();
    for (const l of LISTINGS) {
      const row = body?.[l.mint] as Record<string, unknown> | undefined;
      const tokenPrice = num(row?.usdPrice);
      if (!tokenPrice) continue;
      const stock = row?.stockData as Record<string, unknown> | undefined;
      const updated = typeof stock?.updatedAt === "string" ? Date.parse(stock.updatedAt) : NaN;
      quotes.set(l.ticker, {
        ticker: l.ticker,
        tokenPrice,
        // Missing rather than filled with the token price: a substituted leg
        // would report every gap as exactly zero.
        sharePrice: num(stock?.price),
        shareUpdatedAt: Number.isFinite(updated) ? updated : null,
        liquidityUsd: typeof row?.liquidity === "number" && Number.isFinite(row.liquidity) ? row.liquidity : null,
      });
    }
    if (quotes.size === 0) throw new PriceSourceError("Jupiter prices: no listings priced");
    return { at: Date.now(), source: "jupiter", quotes };
  }
}

/**
 * The offline board: one fixed weekend, so anyone can clone the repo and hear
 * the product work with no network, and so tests are deterministic.
 *
 * Share prices are the levels observed from live Jupiter routes on 2026-09-20.
 * The token-side moves are written out by hand rather than generated, so the
 * story a reviewer hears is the same on every run: a risk-on weekend led by
 * Tesla and Coinbase, with Apple drifting the other way on its own news.
 */
export const SAMPLE_BOARD: Record<string, { share: number; moveBps: number }> = {
  TSLA: { share: 362.8, moveBps: 214 },
  NVDA: { share: 220.5, moveBps: 96 },
  SPY: { share: 767.2, moveBps: 31 },
  AAPL: { share: 334.8, moveBps: -142 },
  QQQ: { share: 721.2, moveBps: 44 },
  MSFT: { share: 496.9, moveBps: 3 },
  META: { share: 671.9, moveBps: 58 },
  AMZN: { share: 252.3, moveBps: 27 },
  GOOGL: { share: 350.3, moveBps: -4 },
  COIN: { share: 192.5, moveBps: 388 },
  MSTR: { share: 151.4, moveBps: 301 },
  CRCL: { share: 90.0, moveBps: 122 },
  // The wider universe, at illustrative levels (not observed prices): the
  // same weekend, so chips and leverage lean up with the risk-on names while
  // the defensives drift lower. Kept smaller than the core moves so the
  // story above still leads the brief.
  AMD: { share: 212, moveBps: 74 }, MU: { share: 198, moveBps: 81 }, AVGO: { share: 341, moveBps: 62 },
  TSM: { share: 298, moveBps: 55 }, ASML: { share: 1012, moveBps: 48 }, MRVL: { share: 86, moveBps: 69 },
  ARM: { share: 161, moveBps: 77 }, SMCI: { share: 46, moveBps: 88 }, INTC: { share: 37, moveBps: 35 },
  PLTR: { share: 182, moveBps: 84 }, APP: { share: 612, moveBps: 71 }, GME: { share: 24, moveBps: 66 },
  SHOP: { share: 158, moveBps: 52 }, CRWD: { share: 476, moveBps: 41 }, UBER: { share: 94, moveBps: 29 },
  ORCL: { share: 281, moveBps: 58 }, NFLX: { share: 116, moveBps: 46 }, BABA: { share: 168, moveBps: 64 },
  TQQQ: { share: 104, moveBps: 89 }, IWM: { share: 246, moveBps: 38 }, VTI: { share: 331, moveBps: 33 },
  JPM: { share: 309, moveBps: 17 }, BAC: { share: 51, moveBps: 21 }, GS: { share: 784, moveBps: 33 },
  V: { share: 344, moveBps: 8 }, CRM: { share: 246, moveBps: 23 }, IBM: { share: 289, moveBps: 11 },
  CSCO: { share: 71, moveBps: 6 }, ACN: { share: 252, moveBps: 4 }, HD: { share: 391, moveBps: 7 },
  HON: { share: 211, moveBps: 2 }, LIN: { share: 468, moveBps: 1 }, DIS: { share: 114, moveBps: 14 },
  SBUX: { share: 86, moveBps: 3 }, CMCSA: { share: 31, moveBps: -3 }, NKE: { share: 67, moveBps: -7 },
  XOM: { share: 116, moveBps: 12 }, CVX: { share: 154, moveBps: 9 }, GLD: { share: 382, moveBps: -26 },
  KO: { share: 69, moveBps: -18 }, PEP: { share: 146, moveBps: -22 }, PG: { share: 151, moveBps: -15 },
  JNJ: { share: 189, moveBps: -12 }, MCD: { share: 301, moveBps: -9 }, WMT: { share: 104, moveBps: -6 },
  MRK: { share: 86, moveBps: -24 }, PFE: { share: 25, moveBps: -31 }, ABBV: { share: 228, moveBps: -11 },
  LLY: { share: 948, moveBps: -38 }, NVO: { share: 54, moveBps: -57 }, UNH: { share: 332, moveBps: -44 },
  MDT: { share: 96, moveBps: -8 }, ABT: { share: 131, moveBps: -5 }, TMO: { share: 561, moveBps: -14 },
  DHR: { share: 201, moveBps: -10 }, AZN: { share: 84, moveBps: -19 },
};

export class SamplePrices implements PriceSource {
  constructor(
    private readonly now: () => number = Date.now,
    /** When the share leg last printed. Defaults to the last regular close. */
    private readonly closedAt?: number,
  ) {}

  async read(): Promise<Board> {
    const at = this.now();
    // While the market is open, the sample's share print is "just now", so the
    // sample answers like a live session rather than claiming a stale feed.
    const close = lastRegularClose(new Date(at)).getTime();
    const open = getMarketSession(new Date(at)).isRegularHours;
    const shareUpdatedAt = this.closedAt ?? (open ? at - 2000 : close);
    const quotes = new Map<string, PairQuote>();
    for (const [ticker, { share, moveBps }] of Object.entries(SAMPLE_BOARD)) {
      quotes.set(ticker, {
        ticker,
        sharePrice: share,
        tokenPrice: Math.round(share * (1 + moveBps / 10_000) * 100) / 100,
        shareUpdatedAt,
      });
    }
    return { at, source: "sample", quotes };
  }
}

/**
 * Stale-while-revalidate over any source.
 *
 * - Fresh (younger than `freshMs`): served as is.
 * - Stale but usable (younger than `maxAgeMs`): served at once, and one
 *   refresh starts behind it.
 * - Cold or too old: the request waits for a read.
 *
 * Concurrent misses share one in-flight read, so a burst of voice requests
 * never fans out into a burst of upstream calls.
 */
export class CachedPrices implements PriceSource {
  private board: Board | null = null;
  private inflight: Promise<Board> | null = null;

  constructor(
    private readonly source: PriceSource,
    private readonly freshMs = 10_000,
    private readonly maxAgeMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  private refresh(): Promise<Board> {
    if (!this.inflight) {
      this.inflight = this.source
        .read()
        .then((b) => (this.board = b))
        .finally(() => (this.inflight = null));
    }
    return this.inflight;
  }

  async read(): Promise<Board> {
    const age = this.board ? this.now() - this.board.at : Infinity;
    if (age < this.freshMs) return this.board!;
    if (age < this.maxAgeMs) {
      this.refresh().catch(() => {});
      return this.board!;
    }
    return this.refresh();
  }

  /** Warms the cache. Safe to call on a timer from a long-running process. */
  warm(): Promise<void> {
    return this.refresh().then(
      () => undefined,
      () => undefined,
    );
  }
}

export function quoteFor(board: Board, listing: Listing): PairQuote | undefined {
  return board.quotes.get(listing.ticker);
}
