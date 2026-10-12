import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, FRIDAY_CLOSE, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices, SAMPLE_BOARD } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { recordTape } from "../src/market/tape.js";
import { openNotice } from "../src/notify/open-verdict.js";
import type { PushSender } from "../src/notify/push.js";
import { route } from "../src/sim/planner.js";

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
afterEach(() => vi.unstubAllGlobals());

describe("the open, scored", () => {
  it("keeps the call before 9:30, scores it a few minutes in, and pushes holders and watchers once", async () => {
    let now = Date.parse("2026-10-12T13:00:00Z"); // Monday 9:00 a.m. Eastern
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const sent: { title: string; body: string }[] = [];
    const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
    const h = harness({
      sample: false,
      push,
      now: () => now,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 0, 0, () => now),
      holdings: new RpcHoldings("http://rpc.test", upstream, 0),
      swap: new JupiterSwap("http://jup.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const { tokens, wallet } = await linkWallet(h.app);
    state.balances[wallet.address] = { TSLA: 2 };
    const session = await mcp(h, tokens.access_token);
    await session.call("edit_watchlist", { add: ["Coinbase"] });
    await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));

    now = Date.parse("2026-10-12T13:25:00Z"); // 9:25: the call is kept
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);

    // The bell: Tesla opens up 1.9% (the token called +2.1%); Coinbase opens down.
    state.shareOverride = { TSLA: SAMPLE_BOARD.TSLA.share * 1.019, COIN: SAMPLE_BOARD.COIN.share * 0.996 };
    state.shareUpdatedAt = new Date(Date.parse("2026-10-12T13:36:00Z")).toISOString();
    now = Date.parse("2026-10-12T13:36:00Z"); // 9:36
    await recordTape(h.svc);
    expect(sent).toEqual([
      expect.objectContaining({
        title: "At the open: Tesla +1.9%, Coinbase −0.4%",
        body: "Tesla's token had called +2.1%; Coinbase's token had called +3.9%. Some overnight moves held, some didn't.",
      }),
    ]);
    now = Date.parse("2026-10-12T13:41:00Z");
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
  });

  it("says nothing when nothing moved", () => {
    expect(openNotice([{ ticker: "TSLA", calledBps: 5, openBps: -8 }], "https://x")).toBeNull();
  });

  it("answers 'how did the open go?' (sample data)", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("how_did_the_open_go", { stock: "Tesla" });
    expect(step.text).toMatch(/^Using sample data\. At the \w+ open: Tesla opened (up|down) \d\.\d percent; its token had called (up|down) \d\.\d percent(, so that one didn't hold)?\.$/);
  });
});

describe("routing", () => {
  it.each([
    ["how did the open go?", { tool: "how_did_the_open_go", args: {} }],
    ["did Tesla's weekend move hold?", { tool: "how_did_the_open_go", args: { stock: "tesla" } }],
    ["was the token right this morning", { tool: "how_did_the_open_go", args: {} }],
  ])("%s", (said, expected) => expect(route(said)).toEqual(expected));
});
