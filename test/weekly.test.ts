import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, FRIDAY_CLOSE, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { recordTape } from "../src/market/tape.js";
import { route } from "../src/sim/planner.js";
import type { PushSender } from "../src/notify/push.js";

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
afterEach(() => vi.unstubAllGlobals());

describe("weekly recap", () => {
  it("compares holdings with a week-old price snapshot and pushes it Sunday at 6 p.m.", async () => {
    let now = Date.parse("2026-10-02T15:00:00Z"); // Friday
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const sent: { title: string; body: string }[] = [];
    const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
    const h = harness({
      sample: false,
      push,
      now: () => now,
      prices: new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }),
      holdings: new RpcHoldings("http://rpc.test", upstream, 0),
      swap: new JupiterSwap("http://jup.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const { tokens, wallet } = await linkWallet(h.app);
    state.balances[wallet.address] = { TSLA: 2, NVDA: 4 };
    const session = await mcp(h, tokens.access_token);
    expect((await session.call("weekly_recap", { push: true })).text).toBe(
      "I don't have a full week of prices for your holdings yet. I'll send this to your phone every Sunday at 6 p.m.",
    );
    await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));
    await recordTape(h.svc); // Friday's snapshot

    state.tokenFactor = { TSLA: 1.1, NVDA: 0.95 };
    now = Date.parse("2026-10-11T21:50:00Z"); // Sunday 5:50 p.m. Eastern
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);
    now = Date.parse("2026-10-11T22:05:00Z"); // 6:05 p.m.
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/^Your week: \+\$\d+\.\d\d \(\+\d\.\d%\)$/);
    expect(sent[0].body).toBe(
      `This week your tokenized stocks are up ${sent[0].title.match(/\$[\d.]+/)![0]}, ${sent[0].title.match(/\+(\d\.\d)%/)![1]} percent. Tesla led, up 10.0 percent, and Nvidia lagged, down 5.0 percent.`,
    );
    now = Date.parse("2026-10-11T22:10:00Z");
    await recordTape(h.svc);
    expect(sent).toHaveLength(1);
  });

  it("speaks the recap on request (sample data)", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    expect((await session.call("weekly_recap", {})).text).toMatch(
      /^Using sample data\. This week your tokenized stocks are up \$[\d,.]+, \d\.\d percent\. Tesla led, up \d\.\d percent, and Apple lagged, down \d\.\d percent\.$/,
    );
  });

  it.each([
    ["how was my week?", {}],
    ["send me a weekly recap every sunday", { push: true }],
    ["stop the weekly recap", { push: false }],
  ])("routes %s", (said, args) => expect(route(said)).toEqual({ tool: "weekly_recap", args }));
});
