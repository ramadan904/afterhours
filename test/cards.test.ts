import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { harness, linkWallet, mcp } from "./helpers.js";

/** Runs a card's script against a stub DOM and renders a tool result into it. */
function renderCard(html: string, data: unknown): string {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const body = { innerHTML: "" };
  const el = { dataset: {}, scrollWidth: 300, scrollHeight: 200 };
  const ctx: Record<string, unknown> = {
    document: { body, documentElement: el, getElementById: () => null, querySelector: () => null },
    parent: { postMessage() {} },
    window: { addEventListener() {} },
    addEventListener() {},
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(`${script};globalThis.__render=render`, ctx);
  (ctx.__render as (d: unknown) => void)(data);
  return body.innerHTML;
}

describe("the new MCP Apps cards render their tool's result", () => {
  it.each([
    ["market_depth", { stock: "Palantir" }, /cost of size.*\$10,000/],
    ["my_returns", {}, /On what you paid.*TSLAx/],
    ["weekly_recap", {}, /Your week.*TSLAx/],
    ["how_did_the_open_go", { stock: "Tesla" }, /The open, scored.*TSLAx.*opened/],
  ])("%s", async (tool, args, expected) => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    const step = await session.call(tool, args);
    expect(step.ui?.uri).toMatch(/^ui:\/\/afterhours\//);
    expect(renderCard(step.ui!.html, step.structured)).toMatch(expected);
  });

  it("rebalance shows the mix against the target and the legs", async () => {
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    await session.call("set_target_allocation", { targets: [{ stock: "Nvidia", percent: 60 }, { stock: "SPY", percent: 40 }] });
    const step = await session.call("rebalance", {});
    const html = renderCard(step.ui!.html, step.structured);
    expect(html).toMatch(/NVDAx.*66% \/ 60%/);
    expect(html).toMatch(/To rebalance.*sell NVDAx/);
  });
});
