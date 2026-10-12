import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { firstSentence, readActivity } from "../src/account/activity.js";

async function setup() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  const sub = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).sub as string;
  return { h, sub, session: await mcp(h, tokens.access_token) };
}

describe("activity log", () => {
  it("records every change made by voice, failures included, and nothing that only reads", async () => {
    const { h, sub, session } = await setup();
    await session.call("overnight_brief", {});
    await session.call("set_spending_limit", {}); // a read
    await session.call("set_spending_limit", { daily_usd: 200 });
    await session.call("set_trade_pin", { new_pin: "4719" });
    await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 25, pin: "1111" });
    await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 25, pin: "4719" });
    await session.call("cancel_trade", {});
    const log = await readActivity(h.svc.store, sub);
    expect(log.map((e) => [e.kind, e.ok])).toEqual([
      ["set_spending_limit", true],
      ["set_trade_pin", true],
      ["propose_trade", false],
      ["propose_trade", true],
      ["cancel_trade", true],
    ]);
    expect(log[2].text).toBe("That PIN isn't right.");
    expect(JSON.stringify(log)).not.toMatch(/4719|1111/);
  });

  it("reads back newest first, and flags wrong PINs", async () => {
    const { session } = await setup();
    expect((await session.call("my_activity", {})).text).toBe("Nothing has changed on your account through Afterhours yet.");
    await session.call("set_trade_pin", { new_pin: "4719" });
    await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 25, pin: "2222" });
    await session.call("edit_watchlist", { add: ["Netflix"] });
    const step = await session.call("my_activity", {});
    expect(step.text).toBe(
      "Heads up: one wrong PIN was tried this week. Most recent first. At 11:00 a.m. Eastern: Added Netflix. At 11:00 a.m. Eastern: That PIN isn't right. At 11:00 a.m. Eastern: Done. From now on I'll ask for your PIN before preparing a trade.",
    );
  });

  it("keeps the first sentence", () => {
    expect(firstSentence("Using sample data. A buy of $25 of Apple is ready. Open the page.")).toBe("A buy of $25 of Apple is ready.");
    expect(firstSentence("Done. Your limit is $200. Lowering is instant.")).toBe("Done. Your limit is $200.");
    expect(firstSentence("A buy of $25 of Apple at about $330.05 is ready for you to sign. Open the page.")).toBe("A buy of $25 of Apple at about $330.05 is ready for you to sign.");
  });
});
