/**
 * Proving a wallet is yours, without giving anything away.
 *
 * Linking Afterhours to Alexa asks the wallet to sign a short plain-text
 * message (in the style of Sign-In With Solana). Signing a message cannot move
 * funds and costs nothing; it only proves the person linking controls the
 * address. The message names this site, the address, a one-time nonce bound to
 * this authorization request, and an expiry, so a signature cannot be replayed
 * against another site or another link attempt.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function linkMessage(p: { host: string; address: string; nonce: string; issuedAt: string; expiresAt: string; uri: string }): string {
  return [
    `${p.host} wants you to link your Solana account to Alexa:`,
    p.address,
    "",
    "Afterhours can read your tokenized stock balances. It can never move funds: every trade needs your signature in this wallet.",
    "",
    `URI: ${p.uri}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expiresAt}`,
  ].join("\n");
}

export function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || !ADDRESS.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** True when `signature` (base58 or base64) is the address's ed25519 signature over `message`. */
export function verifyWalletSignature(address: string, message: string, signature: string): boolean {
  if (!isAddress(address)) return false;
  let sig: Uint8Array;
  try {
    sig = /^[1-9A-HJ-NP-Za-km-z]+$/.test(signature) ? bs58.decode(signature) : Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, new TextEncoder().encode(message), bs58.decode(address));
  } catch {
    return false;
  }
}
