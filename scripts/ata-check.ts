/**
 * Checks the associated-token-account derivation the pre-sign check relies on
 * against mainnet: for the largest TSLAx holders, derive each owner's ATA and
 * see that it's the account that actually holds the tokens. Run in CI's live job.
 *
 *   npx tsx scripts/ata-check.ts
 */

import { associatedTokenAddress, TOKEN_2022_PROGRAM } from "../src/chain/preflight.js";
import { listingByTicker } from "../src/market/universe.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const call = async <T>(method: string, params: unknown[]): Promise<T> => {
  const body = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
};

const mint = listingByTicker("TSLA")!.mint;
const largest = await call<{ value: { address: string }[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
const addresses = largest.value.map((a) => a.address);
const accounts = await call<{ value: ({ data: { parsed: { info: { owner: string } } } } | null)[] }>("getMultipleAccounts", [addresses, { encoding: "jsonParsed" }]);
let matched = 0;
addresses.forEach((address, i) => {
  const owner = accounts.value[i]?.data.parsed.info.owner;
  const derived = owner ? associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM) : null;
  const ok = derived === address;
  if (ok) matched += 1;
  console.log(`${ok ? "ATA  " : "other"} ${address} owner ${owner ?? "?"}`);
});
console.log(`${matched} of ${addresses.length} largest TSLAx accounts are their owner's derived ATA`);
// Some large holders are program-owned vaults, not ATAs; none matching would mean the derivation is wrong.
process.exit(matched > 0 ? 0 : 1);
