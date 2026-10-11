/**
 * Finds and verifies the mints for every xStock Afterhours could cover.
 *
 *   npx tsx scripts/discover-universe.ts > src/market/universe-extended.json
 *
 * A wrong mint doesn't fail loudly: it routes an order into a different asset
 * that happens to share a ticker. So a candidate is accepted only if it clears
 * every gate (as in Kolu's discovery, plus one):
 *
 *   1. Jupiter's token registry returns it for an exact symbol match.
 *   2. The mint has Backed's xStock vanity prefix `Xs`. Copycat tokens reuse
 *      the symbol, not the address.
 *   3. The mint account exists on chain, is a mint, and is owned by Token-2022.
 *   4. The registry's decimals match the chain's.
 *   5. Exactly one candidate survives. Ambiguity is reported, never guessed.
 *
 * Runs in GitHub Actions (.github/workflows/discover-universe.yml), where the
 * network is open. Progress goes to stderr; the verified list is the only
 * thing on stdout.
 */

const JUPITER = (process.env.JUPITER_ENDPOINT ?? "https://lite-api.jup.ag").replace(/\/$/, "");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Ticker → how it's said. The 12 core names live in universe.ts already. */
const CANDIDATES: Record<string, string> = {
  ABBV: "AbbVie", ABT: "Abbott", ACN: "Accenture", AMD: "AMD", APP: "AppLovin", AVGO: "Broadcom", AZN: "AstraZeneca",
  BAC: "Bank of America", BRKB: "Berkshire Hathaway", CMCSA: "Comcast", CRM: "Salesforce", CRWD: "CrowdStrike",
  CSCO: "Cisco", CVX: "Chevron", DHR: "Danaher", GLD: "the gold fund", GME: "GameStop", GS: "Goldman Sachs",
  HD: "Home Depot", HON: "Honeywell", HOOD: "Robinhood", IBM: "IBM", INTC: "Intel", IWM: "the Russell 2000 fund",
  JNJ: "Johnson & Johnson", JPM: "JPMorgan", KO: "Coca-Cola", LIN: "Linde", LLY: "Eli Lilly", MA: "Mastercard",
  MCD: "McDonald's", MDT: "Medtronic", MRK: "Merck", MRVL: "Marvell", NFLX: "Netflix", NVO: "Novo Nordisk",
  ORCL: "Oracle", PEP: "PepsiCo", PFE: "Pfizer", PG: "Procter & Gamble", PLTR: "Palantir", PM: "Philip Morris",
  TMO: "Thermo Fisher", TQQQ: "the triple Nasdaq fund", UNH: "UnitedHealth", V: "Visa", VTI: "the total market fund",
  WMT: "Walmart", XOM: "Exxon Mobil", UBER: "Uber", SHOP: "Shopify", DIS: "Disney", NKE: "Nike", SBUX: "Starbucks",
  BABA: "Alibaba", TSM: "TSMC", ASML: "ASML", MU: "Micron", SMCI: "Super Micro", ARM: "Arm",
};

interface Row {
  id?: string;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function rows(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  const b = body as { tokens?: Row[]; data?: Row[] };
  return b?.tokens ?? b?.data ?? [];
}

async function onChain(mint: string): Promise<{ owner: string; decimals: number } | null> {
  const body = (await json(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
  })) as { result?: { value?: { owner?: string; data?: { parsed?: { type?: string; info?: { decimals?: number } } } } | null } };
  const v = body.result?.value;
  if (!v || v.data?.parsed?.type !== "mint" || typeof v.data.parsed.info?.decimals !== "number" || typeof v.owner !== "string") return null;
  return { owner: v.owner, decimals: v.data.parsed.info.decimals };
}

const accepted: { ticker: string; token: string; spoken: string; mint: string; decimals: number }[] = [];
for (const [ticker, spoken] of Object.entries(CANDIDATES)) {
  const token = `${ticker}x`;
  let found: Row[] = [];
  try {
    found = rows(await json(`${JUPITER}/tokens/v2/search?query=${encodeURIComponent(token)}`));
  } catch (err) {
    console.error(`${token}: registry failed (${(err as Error).message})`);
    continue;
  }
  const exact = found.filter((r) => r.symbol?.toLowerCase() === token.toLowerCase());
  const prefixed = exact.filter((r) => (r.id ?? r.address ?? "").startsWith("Xs"));
  const verified = [];
  for (const r of prefixed) {
    const mint = (r.id ?? r.address)!;
    const chain = await onChain(mint).catch(() => null);
    if (chain && chain.owner === TOKEN_2022 && chain.decimals === r.decimals) verified.push({ mint, decimals: chain.decimals });
    await new Promise((res) => setTimeout(res, 250));
  }
  if (verified.length === 1) {
    accepted.push({ ticker, token, spoken, ...verified[0] });
    console.error(`${token}: ok ${verified[0].mint}`);
  } else {
    console.error(`${token}: ${verified.length === 0 ? "not verified" : "AMBIGUOUS"} (exact ${exact.length}, Xs-prefixed ${prefixed.length}, verified ${verified.length})`);
  }
  await new Promise((res) => setTimeout(res, 300));
}

console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), gates: "exact symbol, Xs prefix, Token-2022 owner, matching decimals, unique", listings: accepted }, null, 2));
console.error(`\n${accepted.length} of ${Object.keys(CANDIDATES).length} verified`);
