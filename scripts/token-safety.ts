/**
 * Reads a few xStock mints from Solana mainnet and prints what the issuer can
 * do to each, as Afterhours would say it. Run in CI's live job, so the parser
 * meets the real Token-2022 accounts on every push.
 *
 *   npx tsx scripts/token-safety.ts TSLA NVDA SPY
 */

import { MemoryStore } from "../src/store/store.js";
import { RpcMints } from "../src/chain/mint-facts.js";
import { listingByTicker } from "../src/market/universe.js";
import { safetyAnswer } from "../src/market/safety-talk.js";
import { EASTERN } from "../src/market/zones.js";

const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const mints = new RpcMints(new MemoryStore(), rpc);
let read = 0;
const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["TSLA", "NVDA", "SPY"];
for (const ticker of tickers) {
  const listing = listingByTicker(ticker);
  if (!listing) continue;
  const facts = await mints.facts(listing, Date.now());
  if (!facts) {
    console.log(`${ticker}: couldn't read ${listing.mint}`);
    continue;
  }
  read += 1;
  const { readAt: _r, ...shown } = facts;
  console.log(`${ticker} ${JSON.stringify(shown)}`);
  console.log(`  "${safetyAnswer({ listing, facts, price: null, frozen: null, now: Date.now(), zone: EASTERN, sample: false })}"`);
}
process.exit(read > 0 ? 0 : 1);
