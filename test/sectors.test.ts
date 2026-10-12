import { describe, expect, it } from "vitest";
import { harness, linkWallet, mcp } from "./helpers.js";
import { LISTINGS } from "../src/market/universe.js";
import { SECTORS, nameFor, resolveSector } from "../src/market/sectors.js";
import { route } from "../src/sim/planner.js";
import { recordTape } from "../src/market/tape.js";

async function session() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return { h, s: await mcp(h, tokens.access_token) };
}

describe("sectors", () => {
  it("cover every listing exactly once", () => {
    const all = SECTORS.flatMap((s) => s.members);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(LISTINGS.map((l) => l.ticker).sort());
  });

  it("are heard the way people say them", () => {
    expect(["tech", "the chip stocks", "Semis", "pharma", "banks", "big tech", "crypto names", "oil"].map((x) => resolveSector(x)?.id)).toEqual(["tech", "chips", "chips", "health", "financials", "big tech", "crypto", "energy"]);
    expect(resolveSector("tesla")).toBeNull();
    expect(nameFor("sector:chips")).toBe("chip stocks");
    expect(nameFor("TSLA")).toBe("Tesla");
  });

  it("ranks every sector, and reads one sector's members", async () => {
    const { s } = await session();
    expect((await s.call("sector_moves", {})).text).toMatch(/^Using sample data\. On average since Friday's close: crypto stocks up 2\.7 percent, chip stocks up 0\.\d percent and .+ (up|down) \d\.\d percent; \d sectors are flat\.$/);
    const chips = await s.call("sector_moves", { sector: "semis" });
    expect(chips.text).toMatch(/^Using sample data\. Chip stocks are up 0\.\d percent on average since Friday's close\. Biggest: Nvidia up 1\.0 percent, Super Micro up 0\.9 percent and Micron up 0\.8 percent; Intel moved least, up 0\.4 percent\.$/);
  });

  it("can be watched by an alert, which fires on the members' average", async () => {
    const { h, s } = await session();
    expect((await s.call("set_alert", { stock: "crypto stocks", percent: 2 })).text).toBe("Done. I'll tell you when crypto stocks, on average, move 2.0 percent or more from their share prices.");
    expect((await s.call("set_alert", { stock: "crypto stocks", price: 100 })).isError).toBe(true);
    expect((await s.call("list_alerts", {})).text).toBe("You have one alert: crypto stocks at 2.0 percent.");
    await recordTape(h.svc);
    expect((await s.call("overnight_brief", {})).text).toMatch(/Your crypto stocks alert went off at 11:00 a\.m\. Eastern, when it was up 2\.7 percent\./);
    expect((await s.call("remove_alert", { stock: "crypto" })).text).toBe("Removed your crypto stocks alert.");
  });

  it.each([
    ["how's tech doing tonight?", { sector: "tech" }],
    ["what are chip stocks doing?", { sector: "chips" }],
    ["how is pharma doing", { sector: "health" }],
    ["which sectors are moving?", {}],
  ])("routes %s", (said, args) => expect(route(said)).toEqual({ tool: "sector_moves", args }));
});
