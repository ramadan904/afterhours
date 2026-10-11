/**
 * The names Afterhours knows, and every way a person might say them.
 *
 * Voice is the whole interface, so resolution matters more than it would on a
 * screen. Nobody says "XsDoVfqe…" or even "TSLAX" out loud: they say "Tesla",
 * "Tesla stock", "the Tesla token", or "S and P". Each entry carries the spoken
 * forms it answers to, and `resolveSymbol` is the only place that turns speech
 * into a ticker.
 *
 * Mints are the xStock SPL (Token-2022) mints, verified on 2026-09-20 against
 * the Jupiter token registry and mainnet (exact symbol, Token-2022 owner,
 * matching decimals). A wrong mint does not fail loudly — it routes an order
 * into a different asset — so these are pinned here rather than looked up by
 * symbol at runtime.
 */

export interface Listing {
  /** Underlying ticker, e.g. `TSLA`. */
  ticker: string;
  /** Tokenized twin, e.g. `TSLAx`. */
  token: string;
  /** How it is said aloud. */
  spoken: string;
  mint: string;
  decimals: number;
  /** Lowercase phrases that resolve to this listing, besides the tickers. */
  aliases: string[];
}

export const USDC = {
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
} as const;

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const LISTINGS: Listing[] = [
  { ticker: "TSLA", token: "TSLAx", spoken: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, aliases: ["tesla"] },
  { ticker: "NVDA", token: "NVDAx", spoken: "Nvidia", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, aliases: ["nvidia", "invidia", "n video"] },
  { ticker: "SPY", token: "SPYx", spoken: "the S&P 500 fund", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, aliases: ["s&p", "s and p", "s&p 500", "s and p 500", "the s&p", "sp500", "spider", "the market"] },
  { ticker: "AAPL", token: "AAPLx", spoken: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, aliases: ["apple"] },
  { ticker: "QQQ", token: "QQQx", spoken: "the Nasdaq 100 fund", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8, aliases: ["nasdaq", "nasdaq 100", "the nasdaq", "triple q", "qqq"] },
  { ticker: "MSFT", token: "MSFTx", spoken: "Microsoft", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", decimals: 8, aliases: ["microsoft"] },
  { ticker: "META", token: "METAx", spoken: "Meta", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", decimals: 8, aliases: ["meta", "facebook"] },
  { ticker: "AMZN", token: "AMZNx", spoken: "Amazon", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", decimals: 8, aliases: ["amazon"] },
  { ticker: "GOOGL", token: "GOOGLx", spoken: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", decimals: 8, aliases: ["alphabet", "google"] },
  { ticker: "COIN", token: "COINx", spoken: "Coinbase", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8, aliases: ["coinbase"] },
  { ticker: "MSTR", token: "MSTRx", spoken: "Strategy", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8, aliases: ["strategy", "microstrategy", "micro strategy"] },
  { ticker: "CRCL", token: "CRCLx", spoken: "Circle", mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", decimals: 8, aliases: ["circle"] },
];

const FILLER = /\b(stock|stocks|shares?|token|tokens|tokenized|the|x|price|of|ticker)\b/g;

function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turns whatever was said into a listing, or null.
 *
 * Accepts tickers in either form (`TSLA`, `TSLAx`), company names, and the
 * aliases above, with filler words ("the Tesla token", "Apple stock") ignored.
 */
export function resolveSymbol(input: string): Listing | null {
  if (!input) return null;
  const raw = input.trim();
  const upper = raw.toUpperCase().replace(/^\$/, "");
  for (const l of LISTINGS) {
    if (upper === l.ticker || upper === l.token.toUpperCase()) return l;
  }

  const said = normalise(raw);
  for (const l of LISTINGS) {
    if (l.aliases.includes(said)) return l;
  }

  const stripped = said.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  for (const l of LISTINGS) {
    if (l.aliases.includes(stripped) || stripped === l.ticker.toLowerCase()) return l;
  }

  // Last resort: an alias appearing as a whole word inside a longer phrase
  // ("how is tesla doing"). Longest alias first so "nasdaq 100" beats "nasdaq".
  const byLength = LISTINGS.flatMap((l) => l.aliases.map((a) => [a, l] as const)).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [alias, l] of byLength) {
    const pattern = new RegExp(`(^|\\s)${alias.replace(/[&]/g, "\\&")}(\\s|$)`);
    if (pattern.test(said)) return l;
  }
  return null;
}

export function listingByTicker(ticker: string): Listing | undefined {
  return LISTINGS.find((l) => l.ticker === ticker);
}

export function listingByMint(mint: string): Listing | undefined {
  return LISTINGS.find((l) => l.mint === mint);
}
