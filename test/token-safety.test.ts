import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { CachedPrices, JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { recordTape } from "../src/market/tape.js";
import { describeRescale, multiplierAt, parseMint, RpcMints, sampleMintFacts, type MintFacts, type MintSource } from "../src/chain/mint-facts.js";
import { rescaleKind } from "../src/notify/wallet-watch.js";
import { listingByTicker, TOKEN_2022_PROGRAM_ID } from "../src/market/universe.js";
import { MemoryStore } from "../src/store/store.js";
import { route } from "../src/sim/planner.js";
import type { PushSender } from "../src/notify/push.js";

const TSLA = listingByTicker("TSLA")!;
const ISSUER = "Issuer1111111111111111111111111111111111111";

/** A Token-2022 mint as `getAccountInfo` with jsonParsed encoding returns it. */
function mintAccount(o: { paused?: boolean; multiplier?: string; newMultiplier?: string; at?: number; supply?: string; extra?: object[] } = {}) {
  return {
    owner: TOKEN_2022_PROGRAM_ID,
    data: {
      program: "spl-token-2022",
      parsed: {
        type: "mint",
        info: {
          decimals: 8,
          supply: o.supply ?? "3100000000000",
          mintAuthority: ISSUER,
          freezeAuthority: ISSUER,
          isInitialized: true,
          extensions: [
            { extension: "permanentDelegate", state: { delegate: ISSUER } },
            { extension: "pausableConfig", state: { authority: ISSUER, paused: o.paused ?? false } },
            {
              extension: "scaledUiAmountConfig",
              state: { authority: ISSUER, multiplier: o.multiplier ?? "1", newMultiplier: o.newMultiplier ?? o.multiplier ?? "1", newMultiplierEffectiveTimestamp: o.at ?? 0 },
            },
            { extension: "metadataPointer", state: { authority: ISSUER, metadataAddress: TSLA.mint } },
            { extension: "tokenMetadata", state: { name: "Tesla xStock", symbol: "TSLAx", uri: "https://example.invalid/tsla.json" } },
            ...(o.extra ?? []),
          ],
        },
      },
    },
  };
}

describe("reading a mint", () => {
  it("interprets Token-2022 extensions the way the chain reports them", () => {
    const f = parseMint(TSLA.mint, mintAccount({ extra: [{ extension: "confidentialTransferMint", state: {} }] }), SUNDAY)!;
    expect(f).toMatchObject({
      program: "token-2022",
      supply: 31_000,
      mintAuthority: ISSUER,
      freezeAuthority: ISSUER,
      permanentDelegate: ISSUER,
      pausable: { authority: ISSUER, paused: false },
      scaledUiAmount: { multiplier: 1, next: null, last: null },
      defaultFrozen: false,
      transferHook: null,
      transferFeeBps: null,
      otherExtensions: ["confidentialTransferMint"],
    });
    expect(parseMint(TSLA.mint, { data: { parsed: { type: "account", info: {} } } }, SUNDAY)).toBeNull();
  });

  it("knows which multiplier is in force: a change to come, or one that has happened", () => {
    const at = SUNDAY / 1000 + 86_400;
    const before = parseMint(TSLA.mint, mintAccount({ multiplier: "1", newMultiplier: "2", at }), SUNDAY)!;
    expect(before.scaledUiAmount).toMatchObject({ multiplier: 1, next: { multiplier: 2, at: at * 1000 }, last: null });
    expect(multiplierAt(before, SUNDAY)).toBe(1);
    expect(multiplierAt(before, at * 1000)).toBe(2);
    const after = parseMint(TSLA.mint, mintAccount({ multiplier: "1", newMultiplier: "2", at }), at * 1000 + 1)!;
    expect(after.scaledUiAmount).toMatchObject({ multiplier: 2, next: null, last: { from: 1, to: 2, at: at * 1000 } });
    expect(multiplierAt(after, SUNDAY)).toBe(1);
  });

  it("names splits, reverse splits and dividends", () => {
    expect(describeRescale(1, 2)).toBe("a 2-for-1 split");
    expect(describeRescale(1.5, 4.5)).toBe("a 3-for-1 split");
    expect(describeRescale(1, 0.1)).toBe("a 1-for-10 reverse split");
    expect(describeRescale(1, 1.0042)).toBe("about a 0.42% dividend, paid as more tokens");
    expect(describeRescale(1, 1.5)).toBe("balances multiplied by 1.5");
    expect([rescaleKind(1, 2), rescaleKind(2, 1), rescaleKind(1, 1.01), rescaleKind(1, 1.5)]).toEqual(["split", "reverse split", "dividend", "corporate action"]);
  });

  it("caches a mint for ten minutes, and keeps the last answer when the chain can't be read", async () => {
    const store = new MemoryStore(() => SUNDAY);
    let calls = 0;
    let up = true;
    const fetchImpl = (async () => {
      calls += 1;
      if (!up) throw new Error("down");
      return new Response(JSON.stringify({ result: { value: mintAccount() } }));
    }) as typeof fetch;
    const mints = new RpcMints(store, "http://rpc.test", fetchImpl);
    await mints.facts(TSLA, SUNDAY);
    await mints.facts(TSLA, SUNDAY + 60_000);
    expect(calls).toBe(1);
    up = false;
    expect((await mints.facts(TSLA, SUNDAY + 11 * 60_000))?.supply).toBe(31_000);
    expect(calls).toBe(2);
  });
});

describe("token_safety", () => {
  it("says what the issuer can do, plainly, and what the chain can't show", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const r = await session.call("token_safety", { stock: "Tesla" });
    expect(r.text).toBe(
      "The Tesla token, TSLAx, is a Token-2022 token, and its issuer can, on chain: issue new tokens, freeze any holder's tokens, move or burn tokens in any wallet, pause all transfers and rescale every balance for splits and dividends. Transfers are running normally right now. Your own Tesla tokens aren't frozen. About 25,000 tokens exist, worth about $9.3 million. That's normal for a regulated tokenized stock, and it means the token is only as trustworthy as its issuer. Whether real shares back every token is something the issuer attests to off chain; the chain can't show it. This is sample data, not a live read of the chain.",
    );
    expect(r.structured).toMatchObject({ dataSource: "sample", tokens: [{ ticker: "TSLA", program: "token-2022", paused: false, frozenForYou: false, multiplier: 1, scheduled: null }] });
  });

  it("checks everything held, and brings up a scheduled dividend", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const r = await session.call("token_safety", {});
    expect(r.text).toMatch(/^All 4 tokens you hold give their issuer the same powers on chain: it can issue new tokens, .* None of your tokens are frozen\. /);
    expect(r.text).toContain("Coming up for Apple: On Wednesday, October 14, every Apple token balance gets multiplied by 1.0042: about a 0.42% dividend, paid as more tokens. The price per token should fall by about as much");
    expect((r.structured as { tokens: { ticker: string; scheduled: unknown }[] }).tokens.find((t) => t.ticker === "AAPL")?.scheduled).toMatchObject({ multiplier: 1.0042, what: "about a 0.42% dividend, paid as more tokens" });
  });

  it("reads the live chain: a pause, and the user's own frozen account", async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "getAccountInfo") return new Response(JSON.stringify({ result: { value: mintAccount({ paused: true }) } }));
      if (body.method === "getTokenAccountsByOwner") return new Response(JSON.stringify({ result: { value: [{ account: { data: { parsed: { info: { state: "frozen" } } } } }] } }));
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const store = new MemoryStore(() => SUNDAY);
    const h = harness({ store, mints: new RpcMints(store, "http://rpc.test", fetchImpl) });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const r = await session.call("token_safety", { stock: "TSLA" });
    expect(r.text).toContain("Transfers are paused right now, so it can't be bought, sold or moved until the issuer resumes them. Your own Tesla tokens are frozen by the issuer at the moment, so you can't move or sell them until it lifts that.");
    expect(r.text).not.toContain("sample data");
    expect(r.structured).toMatchObject({ dataSource: "chain", tokens: [{ paused: true, frozenForYou: true, supply: 31_000 }] });
  });

  it("is what the planner picks for safety questions", () => {
    expect(route("is my Tesla token safe")).toMatchObject({ tool: "token_safety", args: { stock: "tesla" } });
    expect(route("is this safe")).toMatchObject({ tool: "explain" });
    expect(route("can they freeze my tokens")).toMatchObject({ tool: "token_safety", args: {} });
    expect(route("who controls the Nvidia token")).toMatchObject({ tool: "token_safety", args: { stock: "nvidia" } });
    expect(route("any splits or dividends coming")).toMatchObject({ tool: "token_safety", args: {} });
  });
});

function subscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

/** A mint source whose Tesla facts the test can change. */
class FakeMints implements MintSource {
  constructor(public tsla: MintFacts) {}
  async facts(listing: { ticker: string }) {
    return listing.ticker === "TSLA" ? this.tsla : sampleMintFacts(listingByTicker(listing.ticker)!, 0);
  }
  async frozen() {
    return false;
  }
}

describe("corporate actions in the background", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    let now = SUNDAY;
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const sent: { title: string; body: string }[] = [];
    const push: PushSender = { async send(_s, payload) { sent.push(JSON.parse(payload)); return { gone: false }; } };
    const splitAt = SUNDAY + 2 * 3600_000;
    const mints = new FakeMints(parseMint(TSLA.mint, mintAccount({ multiplier: "1", newMultiplier: "2", at: splitAt / 1000 }), SUNDAY)!);
    const h = harness({
      sample: false,
      push,
      mints,
      now: () => now,
      prices: new CachedPrices(new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), 10_000, 120_000, () => now),
      holdings: new RpcHoldings("http://rpc.test", upstream, 0),
      swap: new JupiterSwap("http://jup.test", upstream),
      rpcUrl: "http://rpc.test",
    });
    const { tokens, wallet } = await linkWallet(h.app);
    state.balances[wallet.address] = { TSLA: 4.25 };
    await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: subscription() }) }));
    return { h, state, sent, wallet: wallet.address, mints, splitAt, at: (t: number) => (now = t) };
  }

  it("tells holders about a split once, before it lands", async () => {
    const { h, sent } = await setup();
    await recordTape(h.svc);
    await recordTape(h.svc);
    expect(sent).toEqual([
      expect.objectContaining({
        title: "A split is coming to your TSLAx",
        body: "On Sunday, October 11, every Tesla token balance gets multiplied by 2: a 2-for-1 split. The price per token should fall by about as much, so what your holding is worth shouldn't change.",
      }),
    ]);
  });

  it("doesn't call the split's new tokens an arrival, but still reports a real one", async () => {
    const { h, state, sent, wallet, mints, splitAt, at } = await setup();
    await recordTape(h.svc); // baseline, and the heads-up
    sent.length = 0;
    at(splitAt + 60_000);
    mints.tsla = parseMint(TSLA.mint, mintAccount({ multiplier: "1", newMultiplier: "2", at: splitAt / 1000 }), splitAt + 60_000)!;
    state.balances[wallet] = { TSLA: 8.5 };
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);
    at(splitAt + 6 * 60_000);
    state.balances[wallet] = { TSLA: 10.5 };
    await recordTape(h.svc);
    expect(sent.map((n) => n.title)).toEqual(["2 TSLAx arrived in your wallet"]);
  });
});
