import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { readTransaction } from "../src/chain/txmessage.js";
import { recordTape } from "../src/market/tape.js";

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

async function proposal(h: ReturnType<typeof harness>, stock = "Tesla", amount = 25) {
  const { tokens, wallet } = await linkWallet(h.app);
  const session = await mcp(h, tokens.access_token);
  const { code } = (await session.call("propose_trade", { stock, side: "buy", amount_usd: amount })).structured as { code: string };
  return { code, wallet, session };
}

const get = (h: ReturnType<typeof harness>, path: string) => h.app(new Request(`${BASE}${path}`));
const post = (h: ReturnType<typeof harness>, path: string, body: unknown) =>
  h.app(new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("Solana Actions for proposed trades", () => {
  it("publishes actions.json and the spec's headers, preflight included", async () => {
    const { h } = liveHarness();
    const res = await get(h, "/actions.json");
    expect(await res.json()).toEqual({ rules: [{ pathPattern: "/go/*", apiPath: "/api/actions/trade/*" }] });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-action-version")).toBe("2.4");
    expect(res.headers.get("x-blockchain-ids")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    const pre = await h.app(new Request(`${BASE}/api/actions/trade/123456`, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-Accept-Action-Version");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("describes a proposal as an action with one signing button", async () => {
    const { h } = liveHarness();
    const { code, wallet } = await proposal(h);
    const action = await (await get(h, `/api/actions/trade/${code}`)).json();
    expect(action).toMatchObject({ type: "action", title: "Buy $25 of TSLAx", label: "Review & sign", disabled: false });
    expect(action.description).toContain(`${wallet.address.slice(0, 4)}…`);
    expect(action.icon).toBe(`${BASE}/api/actions/trade/${code}/card.svg`);
    expect(action.links.actions).toEqual([{ type: "transaction", label: "Buy $25", href: `${BASE}/api/actions/trade/${code}` }]);
    const card = await get(h, `/api/actions/trade/${code}/card.svg`);
    expect(card.headers.get("content-type")).toBe("image/svg+xml");
    expect(await card.text()).toContain("Buy $25 of TSLAx");
  });

  it("builds the transaction only for the proposal's wallet", async () => {
    const { h, state } = liveHarness();
    const { code, wallet } = await proposal(h);
    const other = await post(h, `/api/actions/trade/${code}`, { account: OTHER });
    expect(other.status).toBe(403);
    expect((await other.json()).message).toContain("Switch to that account");
    expect((await post(h, `/api/actions/trade/${code}`, { account: "not-a-key" })).status).toBe(400);
    expect(state.calls).not.toContain("/swap/v1/swap");

    const res = await post(h, `/api/actions/trade/${code}`, { account: wallet.address });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.type).toBe("transaction");
    expect(readTransaction(body.transaction)?.payer).toBe(wallet.address);
    expect(body.message).toMatch(/^You pay 25 USDC and receive about 0\.0\d+ TSLAx/);
    expect(body.links.next).toEqual({ type: "post", href: `/api/actions/trade/${code}/next` });
  });

  it("finds a trade signed from a blink or QR code on chain, with no signature reported", async () => {
    const { h, state } = liveHarness();
    const { code, wallet, session } = await proposal(h);
    await post(h, `/api/actions/trade/${code}`, { account: wallet.address });

    // Unrelated activity in the same wallet isn't mistaken for the trade.
    state.transactions["5".repeat(88)] = { payer: wallet.address, blockTime: SUNDAY / 1000 };
    let view = await (await get(h, `/api/trade?code=${code}`)).json();
    expect(view.status).toBe("awaiting_signature");

    // The wallet signs the transaction we built and sends it itself.
    const sig = "6".repeat(88);
    state.transactions[sig] = { payer: wallet.address, blockhash: state.built!.at(-1), blockTime: SUNDAY / 1000 };
    await recordTape(h.svc); // the 5-minute sampler settles pending trades
    view = await (await get(h, `/api/trade?code=${code}`)).json();
    expect(view).toMatchObject({ status: "confirmed", signature: sig });
    expect((await session.call("trade_status", { code })).text).toBe("Your $25 buy of Tesla is confirmed on Solana.");
    const action = await (await get(h, `/api/actions/trade/${code}`)).json();
    expect(action).toMatchObject({ disabled: true, label: "Confirmed on Solana" });
    expect(action.links).toBeUndefined();
  });

  it("records the signature from the action's callback, and lets the chain decide", async () => {
    const { h, state } = liveHarness();
    const { code, wallet } = await proposal(h);
    await post(h, `/api/actions/trade/${code}`, { account: wallet.address });
    const sig = "7".repeat(88);
    const done = await (await post(h, `/api/actions/trade/${code}/next`, { account: wallet.address, signature: sig })).json();
    expect(done).toMatchObject({ type: "completed", label: "Sent" });
    expect((await (await get(h, `/api/trade?code=${code}`)).json()).status).toBe("submitted");
    state.transactions[sig] = { payer: wallet.address, blockhash: state.built!.at(-1) };
    expect((await (await get(h, `/api/trade?code=${code}`)).json()).status).toBe("confirmed");
  });

  it("refuses cleanly on sample data and for unknown codes", async () => {
    const h = harness();
    const { code, wallet } = await proposal(h);
    const res = await post(h, `/api/actions/trade/${code}`, { account: wallet.address });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("sample data");
    const missing = await get(h, "/api/actions/trade/000000");
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toContain("No trade matches");
    expect((await get(h, "/api/actions/trade/abc")).status).toBe(404);
  });

  it("offers the action as a Solana Pay QR code and a /go/<code> page", async () => {
    const h = harness();
    const { code } = await proposal(h);
    const qr = await get(h, `/qr.svg?pay=${code}`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
    expect((await get(h, "/qr.svg?pay=https://evil.example")).status).toBe(400);
    const page = await (await get(h, `/go/${code}`)).text();
    expect(page).toContain(`value="${code}"`);
    expect(page).toContain("Or sign on your phone");
  });
});
