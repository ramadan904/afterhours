import { describe, expect, it } from "vitest";
import { BASE, harness, linkWallet, mcp } from "./helpers.js";
import { setSimulatorFetch } from "../src/http/sim-api.js";

async function linked() {
  const h = harness();
  const { tokens, wallet } = await linkWallet(h.app);
  const session = await mcp(h, tokens.access_token);
  return { h, session, tokens, wallet };
}

describe("MCP over Streamable HTTP", () => {
  it("negotiates protocol 2025-11-25 and lists every tool with truthful annotations", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const res = await h.app(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).result.protocolVersion).toBe("2025-11-25");

    const session = await mcp(h, tokens.access_token);
    const tools = await session.tools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ["cancel_trade", "check_stock", "explain", "list_alerts", "market_status", "my_portfolio", "overnight_brief", "propose_trade", "remove_alert", "set_alert", "trade_status"].sort(),
    );
    for (const name of ["explain", "market_status", "overnight_brief", "check_stock", "my_portfolio", "list_alerts", "trade_status"]) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.remove_alert.annotations?.destructiveHint).toBe(true);
    expect(byName.cancel_trade.annotations?.destructiveHint).toBe(true);
    expect(byName.propose_trade.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.propose_trade.description).toMatch(/does NOT execute/);
    for (const t of tools) expect(t.outputSchema, t.name).toBeDefined();
    await session.close();
  });

  it("briefs the weekend: market shut, biggest moves since Friday's close", async () => {
    const { session } = await linked();
    const step = await session.call("overnight_brief", {});
    expect(step.isError).toBe(false);
    expect(step.text).toContain("Using sample data.");
    expect(step.text).toContain("closed for the weekend");
    expect(step.text).toContain("opens tomorrow at 9:30 a.m. Eastern");
    expect(step.text).toContain("Biggest moves since Friday's close: Coinbase up 3.9 percent, Strategy up 3.0 percent and Tesla up 2.1 percent.");
    const data = step.structured as { movers: { ticker: string }[]; marketPhase: string };
    expect(data.marketPhase).toBe("weekend");
    expect(data.movers.map((m) => m.ticker)).toEqual(["COIN", "MSTR", "TSLA"]);
  });

  it("checks one stock from how it is said, and calls a weekend gap a bet, not a hedge", async () => {
    const { session } = await linked();
    const step = await session.call("check_stock", { stock: "the Tesla token" });
    expect(step.text).toBe(
      "Using sample data. Tesla's token is up 2.1 percent since Friday's close, at $370.56. With the share market shut, that's a bet on the open tomorrow, not a hedge.",
    );
    const apple = await session.call("check_stock", { stock: "AAPL" });
    expect(apple.text).toContain("Apple's token is down 1.4 percent");
    const flat = await session.call("check_stock", { stock: "microsoft" });
    expect(flat.text).toContain("in line with Friday's close");
    const unknown = await session.call("check_stock", { stock: "Blockbuster" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("I can check Tesla");
  });

  it("reads the linked portfolio and its overnight change", async () => {
    const { session } = await linked();
    const step = await session.call("my_portfolio", {});
    expect(step.isError).toBe(false);
    const d = step.structured as { totalUsd: number; changeUsd: number; positions: { ticker: string }[] };
    expect(d.positions.map((p) => p.ticker)).toEqual(["NVDA", "AAPL", "TSLA", "SPY"]);
    expect(d.changeUsd).toBeGreaterThan(0);
    expect(step.text).toMatch(/^Using sample data\. Your 4 positions are worth \$\d,\d{3}\. That's up \$\d+(\.\d\d)? since Friday's close\./);
  });

  it("keeps alerts per account and reads triggered ones in the brief", async () => {
    const { session, h } = await linked();
    expect((await session.call("set_alert", { stock: "Coinbase", percent: 3 })).text).toBe(
      "Done. I'll tell you when Coinbase moves 3.0 percent or more from its share price.",
    );
    await session.call("set_alert", { stock: "Microsoft", percent: 1 });
    expect((await session.call("list_alerts", {})).text).toBe("You have 2 alerts: Coinbase at 3.0 percent and Microsoft at 1.0 percent.");
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).toContain("Your Coinbase alert at 3.0 percent has triggered: Coinbase is up 3.9 percent.");
    expect(brief.text).not.toContain("Microsoft alert");

    // Another account sees none of them.
    const other = await linkWallet(h.app);
    const otherSession = await mcp(h, other.tokens.access_token);
    expect((await otherSession.call("list_alerts", {})).text).toMatch(/^You don't have any alerts/);

    expect((await session.call("remove_alert", { stock: "COIN" })).text).toBe("Removed your Coinbase alert.");
    expect((await session.call("remove_alert", { stock: "COIN" })).text).toBe("You didn't have an alert for Coinbase.");
  });

  it("proposes a trade with a spoken code, never executes it, and tracks it", async () => {
    const { session, h, wallet } = await linked();
    const step = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 25 });
    expect(step.isError).toBe(false);
    const d = step.structured as { code: string; status: string; confirmUrl: string };
    expect(d.code).toMatch(/^\d{6}$/);
    expect(d.status).toBe("awaiting_signature");
    expect(step.text).toContain(`enter code ${d.code.split("").join(" ")}`);
    expect(step.text).toContain("localhost colon 8787 slash go");
    expect(step.text).toContain("you'd be buying after that move");
    expect(step.text).not.toMatch(/\b(bought|done|executed|complete)\b/i);

    const api = await (await h.app(new Request(`${BASE}/api/trade?code=${d.code}`))).json();
    expect(api).toMatchObject({ code: d.code, side: "buy", ticker: "TSLA", usd: 25, wallet: wallet.address, status: "awaiting_signature" });

    // Sample mode refuses to build a real transaction rather than faking one.
    const build = await h.app(new Request(`${BASE}/api/trade/build`, { method: "POST", body: JSON.stringify({ code: d.code }) }));
    expect(build.status).toBe(409);

    expect((await session.call("trade_status", {})).text).toContain("is waiting for your signature");
    const sig = "5YyfS2csucHcc7e4U1XsrvA3gk8whBLHt5CcEHL1M7ZyBHU1a86NM8K2qxoJWZGzGxn9ZC9XMmLeJ1rNSbMe9MhY";
    const sub = await h.app(new Request(`${BASE}/api/trade/submitted`, { method: "POST", body: JSON.stringify({ code: d.code, signature: sig }) }));
    expect((await sub.json()).status).toBe("submitted");
    expect((await session.call("trade_status", { code: d.code })).text).toContain("was signed and sent");
  });

  it("refuses trades it should not prepare", async () => {
    const { session } = await linked();
    expect((await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 5000 })).text).toContain("up to $500");
    const tooBig = await session.call("propose_trade", { stock: "Circle", side: "sell", amount_usd: 20 });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.text).toContain("You hold about $0 of Circle");
  });

  it("answers tools/call well inside Alexa+'s 500ms budget", async () => {
    const { session } = await linked();
    const times: number[] = [];
    for (let i = 0; i < 40; i += 1) times.push((await session.call(i % 2 ? "check_stock" : "overnight_brief", { stock: "Nvidia" })).ms);
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(p95).toBeLessThan(100);
  });
});

describe("simulator turn", () => {
  it("routes speech through the real MCP endpoint with the linked token", async () => {
    const h = harness();
    setSimulatorFetch(h.fetch);
    try {
      const { tokens } = await linkWallet(h.app);
      const res = await h.app(
        new Request(`${BASE}/sim/api/turn`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ utterance: "Alexa, how's Nvidia doing?" }),
        }),
      );
      const turn = await res.json();
      expect(turn.planner).toBe("scripted");
      expect(turn.steps[0].tool).toBe("check_stock");
      expect(turn.reply).toContain("Nvidia's token is up 1.0 percent");

      const noAuth = await h.app(new Request(`${BASE}/sim/api/turn`, { method: "POST", body: JSON.stringify({ utterance: "hi" }) }));
      expect(noAuth.status).toBe(401);
    } finally {
      setSimulatorFetch(undefined);
    }
  });
});

describe("MCP Apps cards", () => {
  it("declares a ui:// card on the visual tools and serves it as an MCP App", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const rpc = async (method: string, params: unknown) =>
      (
        await (
          await h.app(
            new Request(`${BASE}/mcp`, {
              method: "POST",
              headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            }),
          )
        ).json()
      ).result;

    const tools = (await rpc("tools/list", {})).tools as { name: string; _meta?: { ui?: { resourceUri?: string } } }[];
    const uiOf = (n: string) => tools.find((t) => t.name === n)?._meta?.ui?.resourceUri;
    expect(uiOf("overnight_brief")).toBe("ui://afterhours/brief");
    expect(uiOf("propose_trade")).toBe("ui://afterhours/trade");
    expect(uiOf("set_alert")).toBeUndefined();

    const resources = (await rpc("resources/list", {})).resources as { uri: string; mimeType: string }[];
    expect(resources.map((r) => r.uri).sort()).toEqual(["ui://afterhours/brief", "ui://afterhours/portfolio", "ui://afterhours/stock", "ui://afterhours/trade"]);
    expect(resources.every((r) => r.mimeType === "text/html;profile=mcp-app")).toBe(true);

    const read = (await rpc("resources/read", { uri: "ui://afterhours/trade" })).contents[0];
    expect(read.mimeType).toBe("text/html;profile=mcp-app");
    expect(read.text).toContain('"ui/initialize"');
    expect(read._meta.ui.csp.resourceDomains).toEqual([BASE]);
  });

  it("hands the simulator each step's card", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("check_stock", { stock: "Tesla" });
    expect(step.ui?.uri).toBe("ui://afterhours/stock");
    expect(step.ui?.html).toMatch(/^<!doctype html>/);
    expect((await session.call("list_alerts", {})).ui).toBeNull();
  });
});

describe("personal briefing", () => {
  it("leads the market moves with the linked wallet's own overnight change", async () => {
    const { session } = await linked();
    const step = await session.call("overnight_brief", {});
    expect(step.text).toMatch(/Your 4 positions are up \$31\.83 since Friday's close, led by Tesla\. Biggest moves since Friday's close/);
    expect((step.structured as { portfolio: { leader: string } }).portfolio.leader).toBe("TSLA");
  });

  it("leaves the wallet out rather than blow the latency budget", async () => {
    const h = harness({ holdings: { read: () => new Promise((r) => setTimeout(() => r([{ ticker: "TSLA", amount: 1 }]), 2000)) } });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call("overnight_brief", {});
    expect(step.ms).toBeLessThan(500);
    expect(step.text).not.toContain("Your 1 position");
    expect((step.structured as { portfolio: unknown }).portfolio).toBeNull();
  });
});

describe("/health", () => {
  it("reports per-tool latency and the tape", async () => {
    const { session, h } = await linked();
    await session.call("check_stock", { stock: "Tesla" });
    await session.call("check_stock", { stock: "Apple" });
    const health = await (await h.app(new Request(`${BASE}/health`))).json();
    expect(health.ok).toBe(true);
    expect(health.tools.check_stock.calls).toBeGreaterThanOrEqual(2);
    expect(health.tools.check_stock.p95Ms).toBeLessThan(500);
    expect(health.tape).toEqual({ points: 0, lastSampleAt: null });
  });
});
