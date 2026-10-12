import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap, type TradeIntent } from "../src/chain/trade.js";
import { recordTape } from "../src/market/tape.js";
import { noteSettled } from "../src/notify/wallet-watch.js";
import type { PushSender } from "../src/notify/push.js";

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

async function setup() {
  const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
  const upstream = fakeUpstreams(state);
  vi.stubGlobal("fetch", upstream);
  const sent: { title: string; body: string }[] = [];
  const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
  const h = harness({
    sample: false,
    push,
    prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => SUNDAY),
    holdings: new RpcHoldings("http://rpc.test", upstream, 0),
    swap: new JupiterSwap("http://jup.test", upstream),
    rpcUrl: "http://rpc.test",
  });
  const { tokens, wallet } = await linkWallet(h.app);
  state.balances[wallet.address] = { TSLA: 4.25, SPY: 1 };
  await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));
  return { h, state, sent, wallet: wallet.address };
}
afterEach(() => vi.unstubAllGlobals());

describe("wallet watch", () => {
  it("takes a baseline, then pushes when a position leaves the wallet", async () => {
    const { h, state, sent, wallet } = await setup();
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);
    state.balances[wallet] = { SPY: 1 };
    await recordTape(h.svc);
    expect(sent).toEqual([
      {
        title: "4.25 TSLAx left your wallet",
        body: "About $1,575. That wasn't a trade Afterhours prepared. If it wasn't you, move what's left to a wallet only you control. Afterhours can't move funds.",
        url: `${BASE}/app/`,
        tag: "wallet-watch",
      },
    ]);
    await recordTape(h.svc); // no change, no notice
    expect(sent).toHaveLength(1);
  });

  it("reports tokens arriving from elsewhere", async () => {
    const { h, state, sent, wallet } = await setup();
    await recordTape(h.svc);
    state.balances[wallet] = { TSLA: 4.25, SPY: 1, NVDA: 12 };
    await recordTape(h.svc);
    expect(sent[0].title).toBe("12 NVDAx arrived in your wallet");
    expect(sent[0].body).toMatch(/^Worth about \$2,\d{3} now\. A transfer in, or a trade made outside Afterhours\.$/);
  });

  it("stays quiet about a trade Afterhours prepared and saw confirmed", async () => {
    const { h, state, sent, wallet } = await setup();
    await recordTape(h.svc);
    await noteSettled(h.svc, { wallet, ticker: "TSLA", side: "buy", status: "confirmed" } as TradeIntent);
    state.balances[wallet] = { TSLA: 4.4, SPY: 1 };
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);
  });
});
