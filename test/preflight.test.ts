import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices, type Board, type PriceSource } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { minimalTransaction } from "../src/chain/txmessage.js";
import {
  ATA_PROGRAM,
  associatedTokenAddress,
  explainFailure,
  findProgramAddress,
  preflight,
  preflightSentence,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type Leg,
} from "../src/chain/preflight.js";
import { listingByTicker, USDC } from "../src/market/universe.js";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TSLA = listingByTicker("TSLA")!;
const usdc: Leg = { symbol: "USDC", mint: USDC.mint, decimals: 6, tokenProgram: TOKEN_PROGRAM };
const tslax: Leg = { symbol: "TSLAx", mint: TSLA.mint, decimals: 8, tokenProgram: TOKEN_2022_PROGRAM };
const TX = minimalTransaction(WALLET, bs58.encode(new Uint8Array(32).fill(3)));

function rpcWith(sim: NonNullable<FakeState["simulation"]>) {
  const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [], simulation: sim };
  return { state, fetchImpl: fakeUpstreams(state) };
}

describe("program-derived addresses", () => {
  it("derives an off-curve, deterministic associated token account per wallet, mint and token program", () => {
    const a = associatedTokenAddress(WALLET, TSLA.mint, TOKEN_2022_PROGRAM);
    expect(a).toBe(associatedTokenAddress(WALLET, TSLA.mint, TOKEN_2022_PROGRAM));
    expect(bs58.decode(a)).toHaveLength(32);
    expect(() => ed25519.Point.fromBytes(bs58.decode(a))).toThrow();
    // The token program is part of the seed: the same mint under the classic program is a different account.
    expect(associatedTokenAddress(WALLET, TSLA.mint, TOKEN_PROGRAM)).not.toBe(a);
    const [, bump] = findProgramAddress([bs58.decode(WALLET)], ATA_PROGRAM);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });
});

describe("the chain's second opinion", () => {
  it("reads what this exact transaction would do to the wallet", async () => {
    const { state, fetchImpl } = rpcWith({ before: [0.05, 100, null], after: [0.0479, 75, 0.0674] });
    const p = await preflight("http://rpc.test", TX, WALLET, { pay: usdc, receive: tslax, payAmount: 25 }, fetchImpl);
    expect(p).toMatchObject({ checked: true, ok: true, unitsConsumed: 182_340 });
    expect(p.changes.map((c) => [c.asset, Math.round(c.delta * 1e6) / 1e6])).toEqual([["USDC", -25], ["TSLAx", 0.0674], ["SOL", -0.0021]]);
    expect(preflightSentence(p, { pay: usdc, receive: tslax })).toBe(
      "Checked on Solana just now: you pay 25.00 USDC and get 0.0674 TSLAx, plus 0.0021 SOL for the network fee and a new token account.",
    );
    expect(state.calls).toEqual(expect.arrayContaining(["/#getMultipleAccounts", "/#simulateTransaction"]));
  });

  it("says why the chain would refuse it, in words someone can act on", async () => {
    const legs = { pay: usdc, receive: tslax, payAmount: 25 };
    const broke = rpcWith({ before: [0.05, 12.4, null], err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Program log: Instruction: TransferChecked", "Program log: Error: insufficient funds"] });
    const p = await preflight("http://rpc.test", TX, WALLET, legs, broke.fetchImpl);
    expect(p).toMatchObject({ checked: true, ok: false });
    expect(preflightSentence(p, legs)).toBe("Checked on Solana just now, and it would fail: Your wallet doesn't have enough USDC for this: it holds 12.40 USDC and the trade needs 25.00 USDC.");

    const ctx = { pay: usdc, receive: tslax, payBefore: 100, payAmount: 25, solBefore: 0.05 };
    expect(explainFailure({ InstructionError: [4, { Custom: 6001 }] }, ["Program log: Error: SlippageToleranceExceeded"], ctx)).toBe(
      "The price has moved more than this trade allows since the quote. Get a fresh quote and try again.",
    );
    expect(explainFailure({ InstructionError: [2, { Custom: 17 }] }, ["Program log: Error: Account is frozen"], ctx)).toBe("Your TSLAx account is frozen by its issuer, so this can't go through.");
    expect(explainFailure("AccountNotFound", [], { ...ctx, solBefore: 0 })).toBe("Your wallet needs a little SOL for the network fee before this can go through.");
    expect(explainFailure({ InstructionError: [5, { Custom: 42 }] }, ["Program JUP6 failed: custom program error: 0x2a"], ctx)).toBe(
      "Solana rejected it in a dry run: Program JUP6 failed: custom program error: 0x2a. Nothing was sent.",
    );
  });

  it("doesn't block anything when the chain can't be asked", async () => {
    const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const p = await preflight("http://rpc.test", TX, WALLET, { pay: usdc, receive: tslax, payAmount: 25 }, down);
    expect(p).toEqual({ checked: false, ok: false, changes: [] });
    expect(preflightSentence(p, { pay: usdc, receive: tslax })).toBeNull();
  });
});

describe("before signing, on every path", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function live(sim?: FakeState["simulation"]) {
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [], simulation: sim };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const h = harness({
      sample: false,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => SUNDAY),
      holdings: new RpcHoldings("http://rpc.test", upstream),
      swap: new JupiterSwap("http://jup.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const { tokens, wallet } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const { code } = (await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 25 })).structured as { code: string };
    const post = (path: string, body: unknown) => h.app(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { h, code, wallet, post };
  }

  it("puts the check on the confirm page's build and in the blink's message", async () => {
    const { code, wallet, post } = await live({ before: [0.05, 100, null], after: [0.0479, 75, 0.0674] });
    const built = await (await post("/api/trade/build", { code })).json();
    expect(built.preflight).toMatchObject({ checked: true, ok: true });
    expect(built.check).toBe("Checked on Solana just now: you pay 25.00 USDC and get 0.0674 TSLAx, plus 0.0021 SOL for the network fee and a new token account.");
    const blink = await (await post(`/api/actions/trade/${code}`, { account: wallet.address })).json();
    expect(blink.message).toMatch(/^You pay .* Checked on Solana just now: you pay 25\.00 USDC and get 0\.0674 TSLAx/);
  });

  it("still hands over the transaction when the dry run fails, with the reason, and when the RPC won't simulate", async () => {
    const failing = await live({ before: [0.05, 12.4, null], err: { InstructionError: [3, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] });
    const built = await (await failing.post("/api/trade/build", { code: failing.code })).json();
    expect(built.transaction).toBeTruthy();
    expect(built.preflight).toMatchObject({ checked: true, ok: false });
    expect(built.check).toContain("it holds 12.40 USDC and the trade needs 25.00 USDC");
    vi.unstubAllGlobals();
    const quiet = await live(undefined);
    const plain = await (await quiet.post("/api/trade/build", { code: quiet.code })).json();
    expect(plain.transaction).toBeTruthy();
    expect(plain.preflight).toBeUndefined();
    expect(plain.check).toBeUndefined();
  });
});

describe("the price cache keeps its own time", () => {
  it("goes stale on its own clock, even when the source stamps boards from a clock running ahead", async () => {
    let now = 1_000_000;
    let reads = 0;
    const source: PriceSource = {
      async read(): Promise<Board> {
        reads += 1;
        return { at: now + 10 * 3600_000, source: "jupiter", quotes: new Map() };
      },
    };
    const cache = new CachedPrices(source, 10_000, 120_000, () => now);
    await cache.read();
    now += 5_000;
    await cache.read();
    expect(reads).toBe(1);
    now += 200_000;
    await cache.read();
    expect(reads).toBe(2);
    // A clock that jumps backwards refetches rather than trusting the old board.
    now -= 500_000;
    await cache.read();
    expect(reads).toBe(3);
  });
});
