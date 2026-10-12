import { describe, expect, it } from "vitest";
import { BASE, SUNDAY, exchange, harness, linkWallet, mcp } from "./helpers.js";
import { route } from "../src/sim/planner.js";

async function setup() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  const sub = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).sub as string;
  const get = (path: string) => h.app(new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
  return { h, sub, get, session: await mcp(h, tokens.access_token) };
}

async function fillAccount(session: Awaited<ReturnType<typeof setup>>["session"]) {
  await session.call("set_alert", { stock: "Tesla", percent: 3 });
  await session.call("edit_watchlist", { add: ["Netflix"] });
  await session.call("set_spending_limit", { daily_usd: 200 });
  await session.call("recurring_buy", { stock: "SPY", amount_usd: 25, cadence: "weekly" });
  await session.call("propose_trade", { stock: "Apple", side: "sell", amount_usd: 50, trigger_price: 400 });
  await session.call("set_trade_pin", { new_pin: "4719" });
}

describe("your data", () => {
  it("exports everything kept, with the PIN only as 'set'", async () => {
    const { session, get } = await setup();
    await fillAccount(session);
    const res = await get("/api/export/data.json");
    expect(res.headers.get("content-disposition")).toContain("afterhours-account.json");
    const data = await res.json();
    expect(Object.keys(data)).toEqual(expect.arrayContaining(["alerts", "watch", "guardrails", "recurring", "activity", "pin", "latest-intent"]));
    expect(data.pin).toEqual({ set: true });
    expect(JSON.stringify(data)).not.toMatch(/4719|"hash"|"salt"/);
  });

  it("deletes everything after confirmation and the PIN, and cancels what was waiting", async () => {
    const { h, sub, session, get } = await setup();
    await fillAccount(session);
    const ask = await session.call("delete_my_data", {});
    expect(ask.text).toMatch(/^That deletes everything Afterhours keeps for you: .* Say yes, delete everything, to go ahead\.$/);
    expect((await session.call("delete_my_data", { confirm: true })).text).toBe("Your account has a trade PIN. Say it to confirm deleting everything.");
    const done = await session.call("delete_my_data", { confirm: true, pin: "4719" });
    expect(done.text).toMatch(/^Done\. Everything Afterhours kept for you is deleted/);
    expect(done.text).toContain("Your spending limit and sleep mode stay in force for 24 hours, then they go too.");
    // What's left: guardrails on their way out, nothing else.
    const left = await (await get("/api/export/data.json")).json();
    expect(Object.keys(left).sort()).toEqual(["account", "exportedAt", "guardrails"]);
    expect(left.guardrails).toMatchObject({ dailyLimitUsd: 200, pending: { dailyLimitUsd: null } });
    expect((await h.svc.store.get<string[]>("alert-accounts")) ?? []).not.toContain(sub);
    expect((await h.svc.store.get<string[]>("recurring:index")) ?? []).not.toContain(sub);
    const armed = (await h.svc.store.get<string[]>("armed-intents")) ?? [];
    for (const id of armed) expect((await h.svc.store.get<{ status: string; sub: string }>(`intent:${id}`))?.status).not.toBe("armed");
  });

  it("cancels every proposal still waiting, and ends the link's refresh tokens", async () => {
    const { h, session } = await setup();
    const a = (await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 20 })).structured as { code: string };
    const b = (await session.call("propose_trade", { stock: "Apple", side: "buy", amount_usd: 20 })).structured as { code: string };
    await session.call("delete_my_data", { confirm: true });
    for (const code of [a.code, b.code]) {
      const view = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
      expect(view.status).toBe("cancelled");
    }
  });

  it("signs the old link out: its refresh token stops working, a new link works", async () => {
    let now = SUNDAY;
    const h = harness({ now: () => now });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    await session.call("delete_my_data", { confirm: true });
    now += 60_000;
    const refused = await exchange(h.app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error_description).toBe("This link was ended. Link the account again.");
    const again = await linkWallet(h.app);
    expect((await exchange(h.app, { grant_type: "refresh_token", refresh_token: again.tokens.refresh_token })).status).toBe(200);
  });

  it("routes the phrases", () => {
    expect(route("delete all my data")).toEqual({ tool: "delete_my_data", args: {} });
    expect(route("forget me")).toEqual({ tool: "delete_my_data", args: {} });
    expect(route("yes, delete everything")).toEqual({ tool: "delete_my_data", args: { confirm: true } });
  });
});
