import { afterEach, describe, expect, it } from "vitest";
import { BASE, FRIDAY_CLOSE, SUNDAY, harness } from "./helpers.js";
import { setSimulatorFetch } from "../src/http/sim-api.js";
import { demoTour, hourPhrase } from "../src/http/demo-api.js";
import { SamplePrices, type Board, type PriceSource } from "../src/market/prices.js";

/** The sample board, with Super Micro's token on a nearly empty pool, as it was live. */
class WithThinMarket implements PriceSource {
  private readonly inner = new SamplePrices(() => SUNDAY, FRIDAY_CLOSE);
  async read(): Promise<Board> {
    const board = await this.inner.read();
    const quotes = new Map(board.quotes);
    quotes.set("SMCI", { ...quotes.get("SMCI")!, tokenPrice: 7344.62, liquidityUsd: 2.89 });
    return { ...board, quotes };
  }
}

async function startDemo(h: ReturnType<typeof harness>, tz = "Africa/Lagos") {
  const res = await h.app(new Request(`${BASE}/sim/api/demo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz }) }));
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; wallet: string; walletKind: string; tour: { say: string; note: string }[] };
}

async function turn(h: ReturnType<typeof harness>, token: string, utterance: string, history: { role: string; text: string }[] = []) {
  const res = await h.app(
    new Request(`${BASE}/sim/api/turn`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ utterance, history }) }),
  );
  return (await res.json()) as { reply: string; steps: { tool: string; structured?: Record<string, unknown> }[] };
}

afterEach(() => setSimulatorFetch(undefined));

describe("the guided demo", () => {
  it("says hours the way people do", () => {
    expect([0, 9, 12, 14, 23, 25, -1].map(hourPhrase)).toEqual(["midnight", "9 am", "noon", "2 pm", "11 pm", "1 am", "11 pm"]);
    expect(demoTour({ thin: null, hour: 22 }).map((s) => s.say)).toContain("Don't let me trade between 10 pm and 1 am");
  });

  it("runs end to end on real turns: a proposal, then a guardrail that holds the next one and won't come off tonight", async () => {
    const h = harness({ prices: new WithThinMarket() });
    setSimulatorFetch(h.fetch);
    const demo = await startDemo(h);
    expect(demo.walletKind).toBe("sample");
    // Sunday 15:00 UTC is 4 p.m. in Lagos: the guardrail covers the visitor's "now".
    expect(demo.tour.map((s) => s.say)).toEqual([
      "What happened overnight?",
      "Is the Tesla token trading rich?",
      "How's Super Micro doing?",
      "Is the Tesla token safe?",
      "Buy 25 dollars of Apple because people love the new phone",
      "Don't let me trade between 4 pm and 7 pm",
      "Buy 25 dollars of Nvidia",
      "Turn off sleep mode",
    ]);
    const history: { role: string; text: string }[] = [];
    const replies: { tool: string; reply: string; structured?: Record<string, unknown> }[] = [];
    for (const s of demo.tour) {
      const t = await turn(h, demo.access_token, s.say, history);
      history.push({ role: "user", text: s.say }, { role: "assistant", text: t.reply });
      replies.push({ tool: t.steps.at(-1)?.tool ?? "none", reply: t.reply, structured: t.steps.at(-1)?.structured });
    }
    expect(replies.map((r) => r.tool)).toEqual(["overnight_brief", "check_stock", "check_stock", "token_safety", "propose_trade", "set_sleep_mode", "propose_trade", "set_sleep_mode"]);
    expect(replies[0].reply).not.toContain("Super Micro");
    expect(replies[2].reply).toContain("Hardly anyone is trading Super Micro's token on Solana right now");
    expect(replies[4].structured).toMatchObject({ status: "awaiting_signature", ticker: "AAPL" });
    expect(replies[4].reply).toMatch(/I've kept your reason in your journal\.$/);
    expect(replies[6].reply).toContain("sleep mode is on, so I've set this $25 buy of Nvidia aside");
    expect(replies[6].reply).toContain("Lagos time");
    expect(replies[7].reply).toMatch(/24 hours/);
  });

  it("leaves out the thin-market step when nothing is thin, and keeps demo accounts apart", async () => {
    const h = harness();
    const [a, b] = [await startDemo(h, "Not/AZone"), await startDemo(h)];
    expect(a.tour).toHaveLength(7);
    expect(a.tour.some((s) => /Super Micro/.test(s.say))).toBe(false);
    // An unknown zone falls back to Eastern: 11 a.m. in New York.
    expect(a.tour.map((s) => s.say)).toContain("Don't let me trade between 11 am and 2 pm");
    const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    expect(claims(a.access_token).sub).not.toBe(claims(b.access_token).sub);
    expect(claims(a.access_token)).toMatchObject({ demo: true, verified: false, aud: `${BASE}/mcp` });
    expect(claims(a.access_token).exp - claims(a.access_token).iat).toBe(1800);
  });

  it("gives a live deployment a wallet no one can sign for, unless one is configured", async () => {
    const h = harness({ sample: false, prices: new WithThinMarket() });
    const demo = await startDemo(h);
    expect(demo.walletKind).toBe("throwaway");
    expect(demo.wallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    process.env.DEMO_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    try {
      expect(await startDemo(h)).toMatchObject({ walletKind: "configured", wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
    } finally {
      delete process.env.DEMO_WALLET;
    }
  });
});
