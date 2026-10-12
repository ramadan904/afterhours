/**
 * What the issuer of a tokenized stock can do to it, read from the chain.
 *
 * "Is my Tesla token safe?" has two halves. Whether real shares back it is an
 * off-chain question, answered by the issuer's attestations. What the issuer
 * can *do* to the token is on chain, in the Token-2022 mint account, and most
 * holders never look: whether it can freeze a holder's tokens, take them back
 * (a permanent delegate), pause every transfer, change balances for splits and
 * dividends (a scaled UI amount), or charge a fee on transfers.
 *
 * This reads the mint with `jsonParsed` encoding and interprets whatever
 * extensions are there, so the answer follows the chain, not a hard-coded
 * list. Mint accounts change rarely; answers are cached for ten minutes.
 */

import type { Store } from "../store/store.js";
import type { Services } from "../services.js";
import { TOKEN_2022_PROGRAM_ID, type Listing } from "../market/universe.js";

export interface MintFacts {
  mint: string;
  program: "token-2022" | "token";
  decimals: number;
  /** Raw supply over 10^decimals, before any scaled-UI multiplier. */
  supply: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  permanentDelegate: string | null;
  pausable: { authority: string | null; paused: boolean } | null;
  /**
   * Balances shown = raw amount × multiplier, so the issuer can apply a split
   * or pay a dividend as more tokens without touching any account. `next` is a
   * change still to come; `last` one that has taken effect.
   */
  scaledUiAmount: {
    authority: string | null;
    multiplier: number;
    next: { multiplier: number; at: number } | null;
    last: { from: number; to: number; at: number } | null;
  } | null;
  /** New token accounts start frozen until the issuer approves them (KYC gating). */
  defaultFrozen: boolean;
  transferHook: string | null;
  transferFeeBps: number | null;
  nonTransferable: boolean;
  closeAuthority: string | null;
  /** Extensions present that this module doesn't explain. */
  otherExtensions: string[];
  readAt: number;
}

type Ext = { extension: string; state?: Record<string, unknown> };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const EXPLAINED = new Set([
  "permanentDelegate",
  "pausableConfig",
  "scaledUiAmountConfig",
  "defaultAccountState",
  "transferHook",
  "transferFeeConfig",
  "nonTransferable",
  "mintCloseAuthority",
  // Present on most mints and harmless: where metadata lives, and the metadata itself.
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "groupMemberPointer",
  "tokenGroup",
  "tokenGroupMember",
]);

/** Interprets a `getAccountInfo` jsonParsed result for a mint. */
export function parseMint(mint: string, value: { owner?: string; data?: { parsed?: { type?: string; info?: Record<string, unknown> } } } | null, now: number): MintFacts | null {
  const info = value?.data?.parsed?.info;
  if (!info || value?.data?.parsed?.type !== "mint") return null;
  const exts = (Array.isArray(info.extensions) ? info.extensions : []) as Ext[];
  const ext = (name: string) => exts.find((e) => e.extension === name)?.state ?? (exts.some((e) => e.extension === name) ? {} : undefined);
  const decimals = num(info.decimals) ?? 0;
  const pause = ext("pausableConfig");
  const scaled = ext("scaledUiAmountConfig");
  const fee = ext("transferFeeConfig") as { newerTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
  const hook = ext("transferHook");
  // On chain the extension keeps the old multiplier, the new one and when the
  // new one takes effect; which is in force depends on the clock.
  const m = scaled ? (num(scaled.multiplier) ?? 1) : 1;
  const nm = scaled ? num(scaled.newMultiplier) : null;
  const at = scaled ? num(scaled.newMultiplierEffectiveTimestamp) : null;
  const changes = nm !== null && at !== null && nm !== m;
  return {
    mint,
    program: value?.owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : "token",
    decimals,
    supply: (num(info.supply) ?? 0) / 10 ** decimals,
    mintAuthority: str(info.mintAuthority),
    freezeAuthority: str(info.freezeAuthority),
    permanentDelegate: str(ext("permanentDelegate")?.delegate),
    pausable: pause ? { authority: str(pause.authority), paused: pause.paused === true } : null,
    scaledUiAmount: scaled
      ? {
          authority: str(scaled.authority),
          multiplier: changes && at! * 1000 <= now ? nm! : m,
          next: changes && at! * 1000 > now ? { multiplier: nm!, at: at! * 1000 } : null,
          last: changes && at! * 1000 <= now ? { from: m, to: nm!, at: at! * 1000 } : null,
        }
      : null,
    defaultFrozen: ext("defaultAccountState")?.accountState === "frozen",
    transferHook: hook ? str(hook.programId) : null,
    transferFeeBps: fee ? (num(fee.newerTransferFee?.transferFeeBasisPoints) ?? 0) : null,
    nonTransferable: ext("nonTransferable") !== undefined,
    closeAuthority: str(ext("mintCloseAuthority")?.closeAuthority),
    otherExtensions: exts.map((e) => e.extension).filter((e) => !EXPLAINED.has(e)),
    readAt: now,
  };
}

/** The multiplier in force at `at`, as far as these facts know. */
export function multiplierAt(f: MintFacts, at: number): number {
  const s = f.scaledUiAmount;
  if (!s) return 1;
  if (s.next) return at >= s.next.at ? s.next.multiplier : s.multiplier;
  if (s.last) return at >= s.last.at ? s.last.to : s.last.from;
  return s.multiplier;
}

/** "a 2-for-1 split", "a 1-for-10 reverse split", "about a 0.42% dividend, paid as more tokens". */
export function describeRescale(from: number, to: number): string {
  const r = to / from;
  const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-6 && Math.round(x) >= 2;
  if (whole(r)) return `a ${Math.round(r)}-for-1 split`;
  if (whole(1 / r)) return `a 1-for-${Math.round(1 / r)} reverse split`;
  if (r > 1 && r < 1.2) return `about a ${(Math.round((r - 1) * 10_000) / 100).toString()}% dividend, paid as more tokens`;
  return `balances multiplied by ${Math.round(r * 10_000) / 10_000}`;
}

/** Where mint facts come from: the chain, the sample board, or a test fake. */
export interface MintSource {
  facts(listing: Listing, now: number): Promise<MintFacts | null>;
  /** Whether this wallet's own account for the mint is frozen; null when unknown or none. */
  frozen(wallet: string, listing: Listing): Promise<boolean | null>;
}

export class RpcMints implements MintSource {
  constructor(
    private readonly store: Store,
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  facts(listing: Listing, now: number) {
    return readMintFacts(this.store, this.rpcUrl, listing, now, this.fetchImpl);
  }
  frozen(wallet: string, listing: Listing) {
    return walletFrozen(this.rpcUrl, wallet, listing.mint, this.fetchImpl);
  }
}

export class SampleMints implements MintSource {
  constructor(private readonly start: number = Date.now()) {}
  async facts(listing: Listing) {
    // Anchored to when the board started, so the sample dividend has a fixed date.
    return sampleMintFacts(listing, this.start);
  }
  async frozen() {
    return false;
  }
}

const defaults = new WeakMap<Services, MintSource>();

/** The mint source for these services: the injected one, else sample or chain. */
export function mintsOf(svc: Services): MintSource {
  if (svc.mints) return svc.mints;
  let m = defaults.get(svc);
  if (!m) defaults.set(svc, (m = svc.sample ? new SampleMints(svc.now()) : new RpcMints(svc.store, svc.rpcUrl)));
  return m;
}

const cacheKey = (mint: string) => `mintfacts:${mint}`;
const TTL_S = 600;

/** Reads (or recalls) a mint's facts. Null when the chain can't be read. */
export async function readMintFacts(store: Store, rpcUrl: string, listing: Listing, now: number, fetchImpl: typeof fetch = fetch): Promise<MintFacts | null> {
  const hit = await store.get<MintFacts>(cacheKey(listing.mint));
  if (hit && now - hit.readAt < TTL_S * 1000) return hit;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [listing.mint, { encoding: "jsonParsed", commitment: "confirmed" }] }),
    });
    if (!res.ok) return hit;
    const body = (await res.json()) as { result?: { value?: Parameters<typeof parseMint>[1] } };
    const facts = parseMint(listing.mint, body.result?.value ?? null, now);
    if (facts) await store.set(cacheKey(listing.mint), facts, TTL_S * 4);
    return facts ?? hit;
  } catch {
    return hit;
  }
}

/** Whether a wallet's own token account for this mint is frozen; null when unknown or none. */
export async function walletFrozen(rpcUrl: string, wallet: string, mint: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { value?: { account: { data: { parsed: { info: { state?: string } } } } }[] } };
    const accounts = body.result?.value ?? [];
    if (accounts.length === 0) return null;
    return accounts.some((a) => a.account.data.parsed.info.state === "frozen");
  } catch {
    return null;
  }
}

/**
 * What the sample board's tokens look like: the shape xStocks have on chain
 * (Token-2022; freeze, permanent delegate, pause and scaled-UI authorities),
 * with Apple carrying a scheduled dividend so the corporate-action path shows.
 */
export function sampleMintFacts(listing: Listing, now: number): MintFacts {
  const issuer = "sample-issuer-authority";
  const dividend = listing.ticker === "AAPL";
  return {
    mint: listing.mint,
    program: "token-2022",
    decimals: listing.decimals,
    supply: 25_000 + (listing.ticker.charCodeAt(0) % 7) * 3_000,
    mintAuthority: issuer,
    freezeAuthority: issuer,
    permanentDelegate: issuer,
    pausable: { authority: issuer, paused: false },
    scaledUiAmount: { authority: issuer, multiplier: 1, next: dividend ? { multiplier: 1.0042, at: now + 3 * 86_400_000 } : null, last: null },
    defaultFrozen: false,
    transferHook: null,
    transferFeeBps: null,
    nonTransferable: false,
    closeAuthority: null,
    otherExtensions: [],
    readAt: now,
  };
}
