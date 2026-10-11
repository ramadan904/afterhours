/**
 * Stand-ins for Jupiter and Solana RPC that answer in their real response
 * shapes, so the live data path (not just the sample board) is exercised in
 * tests and in local browser runs without network access.
 */

import { LISTINGS, USDC } from "../src/market/universe.js";
import { SAMPLE_BOARD } from "../src/market/prices.js";

export interface FakeState {
  /** Wallet → ticker → human amount. */
  balances: Record<string, Record<string, number>>;
  /** Signature → fee payer and outcome. */
  transactions: Record<string, { payer: string; err?: unknown }>;
  /** ISO time of the share leg's last print. */
  shareUpdatedAt: string;
  calls: string[];
}

export function fakeUpstreams(state: FakeState) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push(url.pathname + (body?.method ? `#${body.method}` : ""));

    if (url.pathname === "/price/v3") {
      const out: Record<string, unknown> = {};
      for (const mint of (url.searchParams.get("ids") ?? "").split(",")) {
        const l = LISTINGS.find((x) => x.mint === mint);
        if (!l) continue;
        const { share, moveBps } = SAMPLE_BOARD[l.ticker];
        out[mint] = {
          usdPrice: Math.round(share * (1 + moveBps / 10_000) * 100) / 100,
          blockId: 1,
          decimals: 8,
          priceChange24h: 0.4,
          stockData: { price: share, updatedAt: state.shareUpdatedAt },
        };
      }
      return json(out);
    }

    if (url.pathname === "/swap/v1/quote") {
      const amount = Number(url.searchParams.get("amount"));
      const buying = url.searchParams.get("inputMint") === USDC.mint;
      const l = LISTINGS.find((x) => x.mint === (buying ? url.searchParams.get("outputMint") : url.searchParams.get("inputMint")))!;
      const { share, moveBps } = SAMPLE_BOARD[l.ticker];
      const price = share * (1 + moveBps / 10_000);
      const out = buying ? (amount / 1e6 / price) * 0.997 * 1e8 : ((amount / 1e8) * price) * 0.997 * 1e6;
      return json({ inAmount: String(amount), outAmount: String(Math.floor(out)), priceImpactPct: "0.0012", routePlan: [] });
    }

    if (url.pathname === "/swap/v1/swap") {
      return json({ swapTransaction: Buffer.from(`unsigned-tx-for-${body.userPublicKey}`).toString("base64") });
    }

    if (body?.jsonrpc === "2.0" && body.method === "getTokenAccountsByOwner") {
      const held = state.balances[body.params[0]] ?? {};
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          value: Object.entries(held).map(([ticker, amount]) => ({
            pubkey: `ata-${ticker}`,
            account: { data: { parsed: { info: { mint: LISTINGS.find((l) => l.ticker === ticker)!.mint, tokenAmount: { uiAmount: amount, decimals: 8 } } } } },
          })),
        },
      });
    }

    if (body?.jsonrpc === "2.0" && body.method === "getTransaction") {
      const tx = state.transactions[body.params[0]];
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: tx ? { meta: { err: tx.err ?? null }, transaction: { message: { accountKeys: [{ pubkey: tx.payer, signer: true }] } } } : null,
      });
    }

    return json({ error: "not faked" }, 404);
  }) as typeof fetch;
}
