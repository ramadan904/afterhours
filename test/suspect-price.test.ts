import { describe, expect, it } from "vitest";
import { FRIDAY_CLOSE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { JupiterPrices, SamplePrices, type Board, type PriceSource } from "../src/market/prices.js";
import { readGap } from "../src/market/gap.js";
import { gapSentence } from "../src/market/speech.js";
import { listingByTicker } from "../src/market/universe.js";

/** The sample board with one leg broken, the way the live board once read "Super Micro up 17722 percent". */
class Broken implements PriceSource {
  private readonly inner = new SamplePrices(() => SUNDAY, FRIDAY_CLOSE);
  async read(): Promise<Board> {
    const board = await this.inner.read();
    const quotes = new Map(board.quotes);
    const smci = quotes.get("SMCI")!;
    quotes.set("SMCI", { ...smci, tokenPrice: smci.sharePrice! * 178.22 });
    const bac = quotes.get("BAC")!;
    quotes.set("BAC", { ...bac, sharePrice: bac.tokenPrice / 8.28 });
    return { ...board, quotes };
  }
}

describe("a price that doesn't add up", () => {
  it("isn't a move: no gap, its own kind, and an honest sentence", () => {
    const r = readGap(listingByTicker("TSLA")!, { ticker: "TSLA", tokenPrice: 600, sharePrice: 362.8, shareUpdatedAt: FRIDAY_CLOSE }, SUNDAY);
    expect(r).toMatchObject({ kind: "suspect_price", gapBps: null, direction: "flat" });
    expect(gapSentence(r)).toBe(
      "Tesla's token is showing $600 against a share price of $362.80, which is too far apart to be a real move. One of those prices is wrong, most likely because hardly anyone is trading the token, so I wouldn't rely on it or trade on it right now.",
    );
    // A 49% premium or a 33% discount still reads as a (big) move.
    expect(readGap(listingByTicker("TSLA")!, { ticker: "TSLA", tokenPrice: 362.8 * 1.49, sharePrice: 362.8, shareUpdatedAt: FRIDAY_CLOSE }, SUNDAY).kind).toBe("overnight_move");
    expect(readGap(listingByTicker("TSLA")!, { ticker: "TSLA", tokenPrice: 362.8 * 0.67, sharePrice: 362.8, shareUpdatedAt: FRIDAY_CLOSE }, SUNDAY).kind).toBe("overnight_move");
  });

  it("is left out of the brief and sectors, explained when asked about, and never traded on", async () => {
    const h = harness({ prices: new Broken() });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).not.toMatch(/Super Micro|Bank of America|17722|728/);
    const chips = await session.call("sector_moves", { sector: "chips" });
    expect((chips.structured as { members: { ticker: string }[] }).members.map((m) => m.ticker)).not.toContain("SMCI");
    const check = await session.call("check_stock", { stock: "Super Micro" });
    expect(check.text).toContain("which is too far apart to be a real move");
    const trade = await session.call("propose_trade", { stock: "Super Micro", side: "buy", amount_usd: 25 });
    expect(trade).toMatchObject({ isError: true });
    expect(trade.text).toMatch(/^Super Micro's token price doesn't add up right now: .* I won't prepare a trade on a price that looks wrong\. Try again later\.$/);
  });
});

describe("a token hardly anyone trades", () => {
  it("reads Jupiter's liquidity and doesn't treat a dead pool's last swap as a price", async () => {
    const tsla = listingByTicker("TSLA")!;
    const smci = listingByTicker("SMCI")!;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          [tsla.mint]: { usdPrice: 370, liquidity: 2_400_000, stockData: { price: 362.8, updatedAt: "2026-10-09T20:00:00Z" } },
          // Straight from CI's live audit.
          [smci.mint]: { usdPrice: 7344.62024794069, liquidity: 2.8943361553295013, stockData: { price: 41.28, updatedAt: "2026-10-12T11:46:18.292Z" } },
        }),
      )) as unknown as typeof fetch;
    const board = await new JupiterPrices({ endpoint: "http://jup.test", fetchImpl }).read();
    expect(board.quotes.get("SMCI")?.liquidityUsd).toBeCloseTo(2.894, 3);
    expect(readGap(tsla, board.quotes.get("TSLA")!, SUNDAY).kind).toBe("overnight_move");
    const r = readGap(smci, board.quotes.get("SMCI")!, SUNDAY);
    expect(r).toMatchObject({ kind: "thin_market", gapBps: null });
    expect(gapSentence(r)).toBe("Hardly anyone is trading Super Micro's token on Solana right now, so its last price of $7,345, against $41.28 for the share, isn't a real read on the stock. I'd leave it alone until there's a market.");
    // Even a believable price is thin if the pool is.
    expect(readGap(tsla, { ticker: "TSLA", tokenPrice: 370, sharePrice: 362.8, shareUpdatedAt: FRIDAY_CLOSE, liquidityUsd: 900 }, SUNDAY).kind).toBe("thin_market");
  });
});
