/**
 * What a wallet holds, read straight from Solana.
 *
 * xStocks are Token-2022 mints, so one `getTokenAccountsByOwner` call against
 * the Token-2022 program returns every position at once. Nothing here signs or
 * needs a key: a wallet's balances are public, and Afterhours only ever reads
 * them.
 *
 * Results are cached per wallet for a short while for the same reason prices
 * are: a voice turn has a 500ms budget and an RPC round trip can eat most of it.
 */

import { LISTINGS, TOKEN_2022_PROGRAM_ID, listingByMint } from "../market/universe.js";

export interface Holding {
  ticker: string;
  /** Human units (decimals applied). */
  amount: number;
}

export interface HoldingsSource {
  read(wallet: string): Promise<Holding[]>;
}

export class RpcHoldings implements HoldingsSource {
  private readonly cache = new Map<string, { at: number; holdings: Holding[] }>();

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 20_000,
  ) {}

  async read(wallet: string): Promise<Holding[]> {
    const hit = this.cache.get(wallet);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.holdings;

    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [wallet, { programId: TOKEN_2022_PROGRAM_ID }, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
    });
    if (!res.ok) throw new Error(`Solana RPC: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { value?: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] };
      error?: { message?: string };
    };
    if (body.error) throw new Error(`Solana RPC: ${body.error.message ?? "error"}`);

    const totals = new Map<string, number>();
    for (const acct of body.result?.value ?? []) {
      const info = acct.account.data.parsed.info;
      const listing = listingByMint(info.mint);
      const amount = info.tokenAmount.uiAmount ?? 0;
      if (!listing || !(amount > 0)) continue;
      totals.set(listing.ticker, (totals.get(listing.ticker) ?? 0) + amount);
    }
    const holdings = [...totals].map(([ticker, amount]) => ({ ticker, amount }));
    this.cache.set(wallet, { at: Date.now(), holdings });
    return holdings;
  }
}

/** The offline portfolio that goes with the sample board. */
export const SAMPLE_HOLDINGS: Holding[] = [
  { ticker: "TSLA", amount: 4.25 },
  { ticker: "NVDA", amount: 12 },
  { ticker: "AAPL", amount: 6.5 },
  { ticker: "SPY", amount: 1.8 },
];

export class SampleHoldings implements HoldingsSource {
  async read(): Promise<Holding[]> {
    return SAMPLE_HOLDINGS;
  }
}

export const KNOWN_TICKERS = new Set(LISTINGS.map((l) => l.ticker));
