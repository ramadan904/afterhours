import { describe, expect, it } from "vitest";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { readTape, writeTape } from "../src/market/tape.js";
import { lastRegularClose, toEasternParts } from "../src/market/session.js";

describe("tool definitions built once per process", () => {
  it("never mixes up callers, however their requests interleave", async () => {
    const h = harness();
    const [a, b] = await Promise.all([linkWallet(h.app), linkWallet(h.app)]);
    const [sa, sb] = await Promise.all([mcp(h, a.tokens.access_token), mcp(h, b.tokens.access_token)]);
    await Promise.all([sa.call("edit_watchlist", { add: ["Tesla", "Nvidia"] }), sb.call("edit_watchlist", { add: ["Coinbase"] })]);
    const rounds = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? sb : sa).call(i % 4 < 2 ? "my_watchlist" : "my_portfolio", {}).then((r) => ({ i, r }))),
    );
    for (const { i, r } of rounds) {
      const s = r.structured as { names?: { ticker: string }[]; wallet?: string | null };
      const mine = i % 2 ? b : a;
      if (s.names) expect(s.names.map((n) => n.ticker).sort()).toEqual(i % 2 ? ["COIN"] : ["NVDA", "TSLA"]);
      else expect(s.wallet).toBe(mine.wallet.address);
    }
  });

  it("answers tools/list the same way every time", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const list = () =>
      h
        .app(
          new Request(`${BASE}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${tokens.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          }),
        )
        .then((r) => r.json());
    const [first, second] = [await list(), await list()];
    expect(first.result.tools).toHaveLength(35);
    expect(second).toEqual(first);
    expect(first.result.tools.every((t: { inputSchema?: unknown; outputSchema?: unknown }) => t.inputSchema && t.outputSchema)).toBe(true);
  });
});

describe("per-minute and per-bucket caches", () => {
  it("hands out copies of cached clock readings", () => {
    const at = new Date(SUNDAY + 17_000);
    const first = toEasternParts(at);
    first.date = "1999-01-01";
    expect(toEasternParts(new Date(SUNDAY + 42_000)).date).toBe("2026-10-11");
    expect(lastRegularClose(at).toISOString()).toBe("2026-10-09T20:00:00.000Z");
    // A close at 4:00:00 p.m. counts from that minute on, not the one before.
    expect(lastRegularClose(new Date(Date.parse("2026-10-09T19:59:59Z"))).toISOString()).toBe("2026-10-08T20:00:00.000Z");
    expect(lastRegularClose(new Date(Date.parse("2026-10-09T20:00:00Z"))).toISOString()).toBe("2026-10-09T20:00:00.000Z");
  });

  it("re-reads a finished tape bucket after this process writes to it", async () => {
    const h = harness();
    const old = SUNDAY - 12 * 3600_000;
    await writeTape(h.svc.store, [{ at: old, gaps: { TSLA: 10 } }]);
    expect((await readTape(h.svc)).find((p) => p.at === old)?.gaps).toEqual({ TSLA: 10 });
    await writeTape(h.svc.store, [{ at: old + 60_000, gaps: { TSLA: 12 } }]);
    expect((await readTape(h.svc)).filter((p) => p.at >= old).map((p) => p.gaps.TSLA)).toEqual([10, 12]);
  });
});
