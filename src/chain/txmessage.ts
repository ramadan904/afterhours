/**
 * Just enough of Solana's wire format to recognise our own transactions.
 *
 * A transaction is `shortvec(n) + n × 64-byte signatures + message`. The
 * message (legacy, or v0 with a 0x80 prefix) starts with a 3-byte header, then
 * `shortvec(k) + k × 32-byte account keys` (the first is the fee payer), then
 * the 32-byte recent blockhash. That's all we read: who pays, and which
 * blockhash the transaction was built against. Built by Jupiter for one
 * proposal, the pair identifies it on chain even if a wallet adds its own
 * instructions before signing, and without trusting anything a page reports.
 */

import bs58 from "bs58";

function shortvec(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const b = bytes[at + i];
    if (b === undefined) throw new Error("truncated");
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error("bad shortvec");
}

/** Fee payer and recent blockhash of a serialized transaction, or null if it isn't one. */
export function readTransaction(base64: string): { payer: string; blockhash: string } | null {
  try {
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    const [sigs, afterSigs] = shortvec(bytes, 0);
    let at = afterSigs + sigs * 64;
    if (bytes[at] === undefined) return null;
    if (bytes[at] & 0x80) {
      if ((bytes[at] & 0x7f) !== 0) return null; // only v0 exists
      at += 1;
    }
    at += 3; // header
    const [keys, afterKeys] = shortvec(bytes, at);
    if (keys < 1) return null;
    const payer = bytes.slice(afterKeys, afterKeys + 32);
    const hashAt = afterKeys + keys * 32;
    const blockhash = bytes.slice(hashAt, hashAt + 32);
    if (payer.length !== 32 || blockhash.length !== 32) return null;
    return { payer: bs58.encode(payer), blockhash: bs58.encode(blockhash) };
  } catch {
    return null;
  }
}

/** Builds a minimal unsigned v0 transaction. Used by tests and the offline fakes. */
export function minimalTransaction(payer: string, blockhash: string): string {
  const out = [1, ...new Array(64).fill(0), 0x80, 1, 0, 0, 1, ...bs58.decode(payer), ...bs58.decode(blockhash), 0, 0];
  return Buffer.from(Uint8Array.from(out)).toString("base64");
}
