/**
 * `toly.sol` instead of a 44-character address.
 *
 * Solana Name Service domains resolve to the wallet that owns them. People
 * remember their name, not their address, and on a phone keyboard typing an
 * address is miserable. Resolution goes through Bonfida's public SNS proxy
 * (configurable with SNS_RESOLVER), and the result is checked to be a real
 * public key before it's used.
 */

import { isAddress } from "../auth/wallet.js";

const NAME = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}\.sol$/;

export function isSolName(value: string): boolean {
  return NAME.test(value.trim().toLowerCase());
}

export async function resolveSolName(name: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!isSolName(n)) return null;
  const base = (process.env.SNS_RESOLVER ?? "https://sns-sdk-proxy.bonfida.workers.dev").replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${base}/resolve/${encodeURIComponent(n.replace(/\.sol$/, ""))}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { s?: string; result?: unknown };
    return body.s === "ok" && isAddress(body.result) ? body.result : null;
  } catch {
    return null;
  }
}
