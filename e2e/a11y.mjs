// Accessibility audit (axe-core: WCAG 2 A/AA + best practices) of every page,
// in dark and light themes, including the simulator after an answer and the
// app with a chart open. Run against a server on sample data:
//   AFTERHOURS_DATA=sample npm run dev & node e2e/a11y.mjs
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.env.BASE_URL ?? "http://localhost:8787";
const b = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const results = {};
for (const scheme of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  const p = await ctx.newPage();
  const audit = async (name) => {
    await p.addScriptTag({ content: axe });
    const r = await p.evaluate(async () => (await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, target: v.nodes.slice(0, 2).map((x) => x.target.join(" ")) })));
    results[scheme + " " + name] = r;
  };
  await p.goto(base + "/"); await audit("landing");
  await p.goto(base + "/go?code=000000"); await p.waitForTimeout(400); await audit("go");
  await p.goto(base + "/sim/"); await audit("sim");
  await p.click("#link"); await p.waitForURL(/authorize/); await audit("authorize");
  await p.click("text=Use the sample portfolio"); await p.waitForSelector("#unlink:not([hidden])");
  await p.fill("#q", "How's Coinbase doing?"); await p.click("button[type=submit]"); await p.waitForSelector(".card-frame"); await p.waitForTimeout(600); await audit("sim-answered");
  await p.goto(base + "/app/"); await p.click("#signin"); await p.waitForURL(/authorize/); await p.click("text=Use the sample portfolio");
  await p.waitForSelector("#prows .rowbtn"); await p.click("#movers .rowbtn >> nth=0"); await p.waitForSelector("#movers .chart svg"); await audit("app");
  await ctx.close();
}
let failures = 0;
for (const [k, v] of Object.entries(results)) {
  console.log("==", k, v.length ? "" : "clean");
  for (const x of v) console.log("  ", x.impact, x.id, "x" + x.n, "-", x.help, JSON.stringify(x.target));
  failures += v.length;
}
await b.close();
process.exitCode = failures ? 1 : 0;
