/**
 * The chain's second opinion, before anyone signs.
 *
 * A wallet shows its own preview, and Afterhours trusts neither the wallet nor
 * itself: once Jupiter has built the transaction, it's run through Solana's
 * `simulateTransaction` against the live state, and the balances the
 * simulation ends with are compared with the balances now. The answer is what
 * this exact transaction would do: "you pay 25.00 USDC and get 0.0674 TSLAx,
 * plus 0.0021 SOL for the network fee and a new token account". If the chain
 * would refuse it, the reason comes back in plain words *before* signing: not
 * enough USDC, the price moved past the slippage allowed, an account frozen
 * by its issuer, no SOL for the fee.
 *
 * Read-only and keyless: simulation never lands anything, needs no signature
 * (`sigVerify: false`), and runs against a fresh blockhash.
 */

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana's `find_program_address`: the first bump (from 255 down) whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): [address: string, bump: number] {
  const program = bs58.decode(programId);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update("ProgramDerivedAddress");
    const out = new Uint8Array(h.digest());
    if (!onCurve(out)) return [bs58.encode(out), bump];
  }
  throw new Error("no viable bump");
}

/** The associated token account a wallet holds a mint in. */
export function associatedTokenAddress(wallet: string, mint: string, tokenProgram: string): string {
  return findProgramAddress([bs58.decode(wallet), bs58.decode(tokenProgram), bs58.decode(mint)], ATA_PROGRAM)[0];
}

export interface Leg {
  /** "USDC", "TSLAx". */
  symbol: string;
  mint: string;
  decimals: number;
  tokenProgram: string;
}

export interface BalanceChange {
  asset: string;
  before: number;
  after: number;
  delta: number;
}

export interface Preflight {
  /** False when the chain couldn't be asked; the trade isn't blocked on that. */
  checked: boolean;
  /** The simulation ran without error. */
  ok: boolean;
  changes: BalanceChange[];
  /** Why the chain would refuse it, in plain words. */
  failure?: string;
  unitsConsumed?: number;
}

type ParsedToken = { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string } } } } } | null;

/** A token account's balance in display units (scaled UI amount applied when the RPC reports one). */
function tokenBalance(acct: ParsedToken, decimals: number): number {
  const t = acct?.data?.parsed?.info?.tokenAmount;
  if (!t) return 0;
  if (t.uiAmountString !== undefined) return Number(t.uiAmountString);
  return Number(t.amount ?? 0) / 10 ** (t.decimals ?? decimals);
}

/** Turns a simulation error and its logs into something a person can act on. */
export function explainFailure(err: unknown, logs: string[], o: { pay: Leg; receive: Leg; payBefore: number; payAmount: number; solBefore: number }): string {
  const text = `${JSON.stringify(err)}\n${logs.join("\n")}`;
  if (/AccountNotFound|insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(text) || o.solBefore === 0) {
    return "Your wallet needs a little SOL for the network fee before this can go through.";
  }
  if (/[Ii]nsufficient funds/.test(text) || (o.payBefore + 1e-9 < o.payAmount && /\{"Custom":1\}/.test(text))) {
    return `Your wallet doesn't have enough ${o.pay.symbol} for this: it holds ${fmt(o.payBefore, o.pay)} and the trade needs ${fmt(o.payAmount, o.pay)}.`;
  }
  if (/[Aa]ccount is frozen|\{"Custom":17\}/.test(text)) {
    const token = o.pay.symbol === "USDC" ? o.receive.symbol : o.pay.symbol;
    return `Your ${token} account is frozen by its issuer, so this can't go through.`;
  }
  if (/SlippageToleranceExceeded|0x1771|\{"Custom":6001\}/.test(text)) {
    return "The price has moved more than this trade allows since the quote. Get a fresh quote and try again.";
  }
  const line = logs.find((l) => /failed|error/i.test(l));
  return `Solana rejected it in a dry run${line ? `: ${line.replace(/^Program log: /, "").slice(0, 140)}` : ""}. Nothing was sent.`;
}

export function fmt(n: number, leg: { symbol: string; decimals: number }): string {
  const digits = leg.symbol === "USDC" ? 2 : leg.symbol === "SOL" ? 4 : Math.min(6, leg.decimals);
  return `${n.toLocaleString("en-US", { minimumFractionDigits: leg.symbol === "USDC" ? 2 : 0, maximumFractionDigits: digits })} ${leg.symbol}`;
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(4000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`Solana RPC: ${body.error.message ?? "error"}`);
  return body.result as T;
}

/**
 * Simulates `transaction` (base64, unsigned) for `wallet` and reports what it
 * would do to the wallet's SOL and the two legs. `payAmount` is what the trade
 * spends of `pay`, in display units, for the "not enough" message.
 */
export async function preflight(
  rpcUrl: string,
  transaction: string,
  wallet: string,
  legs: { pay: Leg; receive: Leg; payAmount: number },
  fetchImpl: typeof fetch = fetch,
): Promise<Preflight> {
  const accounts = [legs.pay, legs.receive].map((l) => associatedTokenAddress(wallet, l.mint, l.tokenProgram));
  const addresses = [wallet, ...accounts];
  try {
    const [before, sim] = await Promise.all([
      rpc<{ value: (ParsedToken & { lamports?: number })[] }>(rpcUrl, "getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }], fetchImpl),
      rpc<{ value: { err: unknown; logs?: string[] | null; accounts?: ((ParsedToken & { lamports?: number }) | null)[] | null; unitsConsumed?: number } }>(
        rpcUrl,
        "simulateTransaction",
        [transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "jsonParsed", addresses } }],
        fetchImpl,
      ),
    ]);
    const pre = before.value ?? [];
    const solBefore = (pre[0]?.lamports ?? 0) / 1e9;
    const payBefore = tokenBalance(pre[1] ?? null, legs.pay.decimals);
    const v = sim.value;
    if (v.err) {
      return {
        checked: true,
        ok: false,
        changes: [],
        failure: explainFailure(v.err, v.logs ?? [], { pay: legs.pay, receive: legs.receive, payBefore, payAmount: legs.payAmount, solBefore }),
        unitsConsumed: v.unitsConsumed,
      };
    }
    const post = v.accounts ?? [];
    const row = (asset: string, b: number, a: number): BalanceChange => ({ asset, before: b, after: a, delta: a - b });
    const changes = [
      row(legs.pay.symbol, payBefore, tokenBalance(post[1] ?? null, legs.pay.decimals)),
      row(legs.receive.symbol, tokenBalance(pre[2] ?? null, legs.receive.decimals), tokenBalance(post[2] ?? null, legs.receive.decimals)),
      row("SOL", solBefore, (post[0]?.lamports ?? pre[0]?.lamports ?? 0) / 1e9),
    ];
    return { checked: true, ok: true, changes, unitsConsumed: v.unitsConsumed };
  } catch {
    return { checked: false, ok: false, changes: [] };
  }
}

/** "The chain checked it just now: you pay 25.00 USDC and get 0.0674 TSLAx, plus 0.0021 SOL for the network fee." */
export function preflightSentence(p: Preflight, legs: { pay: Leg; receive: Leg }): string | null {
  if (!p.checked) return null;
  if (!p.ok) return `Checked on Solana just now, and it would fail: ${p.failure}`;
  const by = (a: string) => p.changes.find((c) => c.asset === a);
  const pay = by(legs.pay.symbol);
  const get = by(legs.receive.symbol);
  const sol = by("SOL");
  if (!pay || !get) return null;
  const fee = sol && sol.delta < 0 ? `, plus ${fmt(-sol.delta, { symbol: "SOL", decimals: 9 })} for the network fee${-sol.delta > 0.0015 ? " and a new token account" : ""}` : "";
  return `Checked on Solana just now: you pay ${fmt(-pay.delta, legs.pay)} and get ${fmt(get.delta, legs.receive)}${fee}.`;
}
