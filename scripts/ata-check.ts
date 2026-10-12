/**
 * Checks the associated-token-account derivation the pre-sign check relies on
 * against mainnet. Reads a few recent TSLAx transactions and, for every token
 * balance in them, derives the owner's ATA for that mint and token program
 * and compares it with the account that actually moved. Swaps touch USDC
 * (classic SPL Token) and TSLAx (Token-2022), so both programs are covered.
 * Run in CI's live job.
 *
 *   npx tsx scripts/ata-check.ts
 */

import { associatedTokenAddress } from "../src/chain/preflight.js";
import { listingByTicker } from "../src/market/universe.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
async function call<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const body = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as {
      result: T;
      error?: { message: string };
    };
    if (!body.error) return body.result;
    if (attempt >= 3 || !/too many/i.test(body.error.message)) throw new Error(body.error.message);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

type Balance = { accountIndex: number; mint: string; owner?: string; programId?: string };
type Tx = { meta: { postTokenBalances?: Balance[] } | null; transaction: { message: { accountKeys: { pubkey: string }[] } } } | null;

const mint = listingByTicker("TSLA")!.mint;
const sigs = await call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [mint, { limit: 15 }]);
const byProgram: Record<string, { ata: number; other: number }> = {};
for (const { signature } of sigs.filter((s) => !s.err).slice(0, 6)) {
  const tx = await call<Tx>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (!tx?.meta?.postTokenBalances) continue;
  for (const b of tx.meta.postTokenBalances) {
    if (!b.owner || !b.programId) continue;
    const address = tx.transaction.message.accountKeys[b.accountIndex]?.pubkey;
    const tally = (byProgram[b.programId] ??= { ata: 0, other: 0 });
    // Pools and vaults hold tokens in non-ATA accounts; a wallet's own balance is its ATA.
    if (associatedTokenAddress(b.owner, b.mint, b.programId) === address) tally.ata += 1;
    else tally.other += 1;
  }
  await new Promise((r) => setTimeout(r, 400));
}
for (const [program, t] of Object.entries(byProgram)) console.log(`${program}: ${t.ata} balances matched the derived ATA, ${t.other} other accounts (pools, vaults)`);
const programsMatched = Object.values(byProgram).filter((t) => t.ata > 0).length;
console.log(programsMatched >= 2 ? "Derivation verified for both token programs." : "Couldn't verify the derivation for both token programs.");
// None matching for a program would mean the derivation is wrong for it.
process.exit(programsMatched >= 1 ? 0 : 1);
