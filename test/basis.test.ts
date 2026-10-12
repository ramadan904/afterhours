import { afterEach, describe, expect, it, vi } from "vitest";
import { FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { applyDeltas, indexWallet, type PositionBasis } from "../src/chain/basis.js";
import { USDC, listingByTicker } from "../src/market/universe.js";

const TSLA = listingByTicker("TSLA")!.mint;
const NVDA = listingByTicker("NVDA")!.mint;

function liveHarness() {
  const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
  const upstream = fakeUpstreams(state);
  vi.stubGlobal("fetch", upstream);
  let now = SUNDAY;
  const h = harness({
    sample: false,
    now: () => now,
    prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => SUNDAY),
    holdings: new RpcHoldings("http://rpc.test", upstream),
    swap: new JupiterSwap("http://jup.test", upstream),
    rpcUrl: "http://rpc.test",
  });
  return { h, state, advance: (ms: number) => (now += ms) };
}
afterEach(() => vi.unstubAllGlobals());

describe("average-cost accounting from balance changes", () => {
  it("prices buys and sells by the USDC that moved, and keeps uncosted transfers out of the average", () => {
    const p: Record<string, PositionBasis> = {};
    applyDeltas(p, new Map([[TSLA, 2], [USDC.mint, -700]]));
    applyDeltas(p, new Map([[TSLA, 2], [USDC.mint, -800]]));
    expect(p.TSLA).toMatchObject({ qty: 4, coveredQty: 4, cost: 1500, buys: 2 });
    applyDeltas(p, new Map([[TSLA, -1], [USDC.mint, 400]]));
    expect(p.TSLA).toMatchObject({ qty: 3, coveredQty: 3, cost: 1125, realized: 25, sells: 1 });
    applyDeltas(p, new Map([[TSLA, 1]])); // a transfer in
    expect(p.TSLA).toMatchObject({ qty: 4, coveredQty: 3, cost: 1125, buys: 2 });
  });

  it("won't split one USDC payment across two stocks", () => {
    const p: Record<string, PositionBasis> = {};
    applyDeltas(p, new Map([[TSLA, 1], [NVDA, 1], [USDC.mint, -600]]));
    expect(p.TSLA).toMatchObject({ qty: 1, coveredQty: 0, cost: 0 });
    expect(p.NVDA).toMatchObject({ qty: 1, coveredQty: 0, cost: 0 });
  });
});

describe("my_returns", () => {
  it("reconstructs what was paid from the wallet's own history", async () => {
    const { h, state } = liveHarness();
    const { tokens, wallet } = await linkWallet(h.app);
    state.balances[wallet.address] = { TSLA: 4 };
    const tx = (deltas: Record<string, number>) => ({ payer: wallet.address, deltas });
    state.transactions["a".repeat(88)] = tx({ [TSLA]: 2, [USDC.mint]: -700 });
    state.transactions["b".repeat(88)] = tx({ [TSLA]: 2, [USDC.mint]: -800 });
    state.transactions["c".repeat(88)] = tx({ [TSLA]: -1, [USDC.mint]: 400 });
    state.transactions["d".repeat(88)] = tx({ [TSLA]: 1 });
    state.transactions["e".repeat(88)] = { payer: wallet.address, err: { InstructionError: [0, "x"] }, deltas: { [TSLA]: 50, [USDC.mint]: -1 } };
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("my_returns", { stock: "Tesla" });
    expect(step.text).toBe(
      "You've bought Tesla 2 times and sold once, paying an average of $375 a token. At $370.56 now, what you hold is down $13.32, or minus 1.2 percent. Sales locked in another $25. Some of your TSLAx arrived without a USDC payment, so I don't know what it cost and left it out.",
    );
    expect(step.structured).toMatchObject({ transactionsRead: 4, complete: true, positions: [{ ticker: "TSLA", held: 4, averageCost: 375, uncostedQty: 1 }] });
  });

  it("indexes only what's new on later passes", async () => {
    const { h, state } = liveHarness();
    const { wallet } = await linkWallet(h.app);
    state.transactions["a".repeat(88)] = { payer: wallet.address, deltas: { [TSLA]: 1, [USDC.mint]: -300 } };
    expect((await indexWallet(h.svc, wallet.address)).transactions).toBe(1);
    state.transactions["b".repeat(88)] = { payer: wallet.address, deltas: { [TSLA]: 1, [USDC.mint]: -400 } };
    const again = await indexWallet(h.svc, wallet.address);
    expect(again.transactions).toBe(2);
    expect(again.positions.TSLA).toMatchObject({ qty: 2, cost: 700, buys: 2 });
  });

  it("sums up the whole portfolio on sample data", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("my_returns", {});
    expect(step.text).toMatch(
      /^Using sample data\. You paid \$[\d,]+ for what you hold, and it's up \$[\d,.]+, [\d.]+ percent, read from your wallet's history on Solana\. Tesla has done best, up [\d.]+ percent; Apple is down [\d.]+ percent\.$/,
    );
  });
});
