import { it } from "vitest";
import { appendFileSync } from "node:fs";
import { harness, linkWallet, mcp } from "./helpers.js";
const out = (s: string) => appendFileSync("/tmp/claude-0/-home-user/a8e9f42c-90b4-5f70-843b-d958e3b4cf53/scratchpad/probe.out", s + "\n");
it("probe", async () => {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  const s = await mcp(h, tokens.access_token);
  for (const q of ["Netflix", "Palantir", "coke", "berkshire", "how is AMD doing"]) out(q + " => " + (await s.call("check_stock", { stock: q })).text);
  out("TRADE => " + (await s.call("propose_trade", { stock: "Netflix", side: "buy", usd: 50 })).text);
  out("TRACK => " + (await s.call("open_track_record", { stock: "Netflix" })).text);
  out("ALERT => " + (await s.call("set_alert", { stock: "Netflix", percent: 2 })).text);
});
