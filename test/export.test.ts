import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness, linkWallet } from "./helpers.js";
import { fakeUpstreams, type FakeState } from "./fake-upstreams.js";
import { JupiterPrices } from "../src/market/prices.js";
import { RpcHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { tradesCsv } from "../src/http/export.js";
import { USDC, listingByTicker } from "../src/market/universe.js";

afterEach(() => vi.unstubAllGlobals());
const TSLA = listingByTicker("TSLA")!.mint;

describe("trade history CSV", () => {
  it("writes one row per change, prices and gains included, safe for spreadsheets", () => {
    const csv = tradesCsv([
      { signature: "abc", at: Date.parse("2026-09-01T14:00:00Z"), ticker: "TSLA", kind: "buy", qty: 2, usdc: 700, realized: null },
      { signature: "def", at: Date.parse("2026-09-08T14:00:00Z"), ticker: "TSLA", kind: "sell", qty: 1, usdc: 400, realized: 50 },
      { signature: "=cmd", at: null, ticker: "TSLA", kind: "transfer_in", qty: 0.5, usdc: null, realized: null },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "date_utc,type,token,quantity,usdc,price_per_token,realized_gain_usd,cost_method,transaction",
      "2026-09-01T14:00:00.000Z,buy,TSLAx,2,700,350,,,https://solscan.io/tx/abc",
      "2026-09-08T14:00:00.000Z,sell,TSLAx,1,400,400,50,average_cost,https://solscan.io/tx/def",
      ",transfer_in,TSLAx,0.5,,,,,https://solscan.io/tx/=cmd",
      "",
    ]);
  });

  it("exports the linked wallet's history from the chain, for its owner only", async () => {
    const state: FakeState = { balances: {}, transactions: {}, shareUpdatedAt: new Date(FRIDAY_CLOSE).toISOString(), calls: [] };
    const upstream = fakeUpstreams(state);
    vi.stubGlobal("fetch", upstream);
    const h = harness({ sample: false, prices: new JupiterPrices({ endpoint: "http://jup.test", fetchImpl: upstream }), holdings: new RpcHoldings("http://rpc.test", upstream), swap: new JupiterSwap("http://jup.test", upstream), rpcUrl: "http://rpc.test" });
    const { tokens, wallet } = await linkWallet(h.app);
    state.transactions["a".repeat(88)] = { payer: wallet.address, blockTime: SUNDAY / 1000 - 86_400, deltas: { [TSLA]: 2, [USDC.mint]: -700 } };
    state.transactions["b".repeat(88)] = { payer: wallet.address, blockTime: SUNDAY / 1000, deltas: { [TSLA]: -1, [USDC.mint]: 400 } };
    expect((await h.app(new Request(`${BASE}/api/export/trades.csv`))).status).toBe(401);
    const res = await h.app(new Request(`${BASE}/api/export/trades.csv`, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="afterhours-trades-\w{6}\.csv"$/);
    const rows = (await res.text()).trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^2026-10-10T15:00:00\.000Z,buy,TSLAx,2,700,350,,,https:\/\/solscan\.io\/tx\/a+$/);
    expect(rows[2]).toMatch(/,sell,TSLAx,1,400,400,50,average_cost,/);
  });

  it("exports a plausible sample history that matches the sample positions", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const text = await (await h.app(new Request(`${BASE}/api/export/trades.csv`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).text();
    const rows = text.trim().split("\r\n").slice(1).map((r) => r.split(","));
    const net = (token: string) => rows.filter((r) => r[2] === token).reduce((t, r) => t + (r[1] === "sell" ? -1 : 1) * Number(r[3]), 0);
    expect(net("NVDAx")).toBeCloseTo(12, 6);
    expect(net("TSLAx")).toBeCloseTo(4.25, 6);
    expect(rows.filter((r) => r[1] === "sell")).toHaveLength(1);
  });
});
