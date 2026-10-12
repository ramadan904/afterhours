import { LISTINGS } from "../src/market/universe.js";
import { readTransaction } from "../src/chain/txmessage.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";

function liveHarness() {
  const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
  const upstream = fakeUpstreams(state);
  vi.stubGlobal("fetch", upstream);
  const h = harness({
    sample: false,
    prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => SUNDAY),
    holdings: new RpcHoldings("http://rpc.test", upstream),
    swap: new JupiterSwap("http://jup.test", upstream),
    rpcUrl: "http://rpc.test",
  });
  return { h, state };
}

afterEach(() => vi.unstubAllGlobals());

describe("live data path (Jupiter + Solana RPC shapes)", () => {
  it("names the close from the calendar, not the feed's refresh time", async () => {
    const { h, state } = liveHarness();
    // Jupiter stamps the share price when it refreshed it, which on a Sunday is today.
    state.shareUpdatedAt = new Date(SUNDAY - 60_000).toISOString();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).toContain("Biggest moves since Friday's close");
    expect(brief.text).not.toContain("today's close");
  });

  it("prices both legs from one Jupiter call and never says 'sample'", async () => {
    const { h, state } = liveHarness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).not.toContain("sample");
    expect(brief.text).toContain("Biggest moves since Friday's close: Coinbase up 3.9 percent");
    expect((brief.structured as { dataSource: string }).dataSource).toBe("jupiter");
    await session.call("check_stock", { stock: "Tesla" });
    // Second call is served from cache: still one board read (50 ids a call).
    expect(state.calls.filter((c) => c === "/price/v3")).toHaveLength(Math.ceil(LISTINGS.length / 50));
  });

  it("reads the linked wallet's Token-2022 balances", async () => {
    const { h, state } = liveHarness();
    const { tokens, wallet } = await linkWallet(h.app);
    state.balances[wallet.address] = { TSLA: 2, COIN: 1.5 };
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("my_portfolio", {});
    expect(step.text).toMatch(/^Your 2 positions are worth \$1,\d{3}\. That's up \$\d+\.\d\d since Friday's close\./);
    expect((step.structured as { wallet: string }).wallet).toBe(wallet.address);
  });

  it("builds a swap for the linked wallet, and confirms only a transaction that wallet paid for", async () => {
    const { h, state } = liveHarness();
    const { tokens, wallet } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const { code } = (await session.call("propose_trade", { stock: "Nvidia", side: "buy", amount_usd: 40 })).structured as { code: string };

    const post = (path: string, body: unknown) => h.app(new Request(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) }));
    const built = await (await post("/api/trade/build", { code })).json();
    expect(readTransaction(built.transaction)).toEqual({ payer: wallet.address, blockhash: state.built!.at(-1) });
    expect(built.pay).toBe("40 USDC");
    expect(built.receive).toMatch(/^0\.17\d+ NVDAx$/);
    expect(state.calls).toContain("/swap/v1/quote");

    // A signature from someone else's transaction is not a confirmation:
    // the trade goes back to its owner, still signable.
    const forged = "3".repeat(88);
    state.transactions[forged] = { payer: "SomeoneElse1111111111111111111111111111111" };
    await post("/api/trade/submitted", { code, signature: forged });
    const after = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(after.status).toBe("awaiting_signature");
    expect(after.error).toContain("wasn't signed by your linked wallet");

    // Nor is an old, real transaction from the same wallet: whoever heard the
    // code can't "confirm" the trade with it.
    const old = "8".repeat(88);
    state.transactions[old] = { payer: wallet.address, blockhash: "11111111111111111111111111111111" };
    await post("/api/trade/submitted", { code, signature: old });
    const again = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(again.status).toBe("awaiting_signature");
    expect(again.error).toContain("isn't the one built for this trade");
    expect((await session.call("trade_status", {})).text).toContain("waiting for your signature");
  });

  it("marks a trade confirmed once the wallet's transaction lands", async () => {
    const { h, state } = liveHarness();
    const { tokens, wallet } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const { code } = (await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10 })).structured as { code: string };
    await h.app(new Request(`${BASE}/api/trade/build`, { method: "POST", body: JSON.stringify({ code }) }));
    const sig = "4".repeat(88);
    await h.app(new Request(`${BASE}/api/trade/submitted`, { method: "POST", body: JSON.stringify({ code, signature: sig }) }));

    let view = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(view.status).toBe("submitted"); // not on chain yet

    state.transactions[sig] = { payer: wallet.address, blockhash: state.built!.at(-1) };
    view = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(view.status).toBe("confirmed");
    expect((await session.call("trade_status", { code })).text).toBe("Your $10 buy of Tesla is confirmed on Solana.");
  });
});
