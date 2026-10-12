/**
 * How well does the voice layer understand people?
 *
 *   npx tsx scripts/eval-planner.ts                  # the scripted planner (no network)
 *   npx tsx scripts/eval-planner.ts --bedrock        # Claude on Amazon Bedrock (needs AWS credentials)
 *   ... --min 0.8                                    # exit non-zero below this full-match rate
 *   ... --json report.json                           # write every result
 *   ... --set planner-holdout                        # the held-out set (never used for tuning)
 *
 * Runs every case in eval/planner.json. The Bedrock run calls the real model
 * against an in-process server on sample data, with the tools taken from its
 * own tools/list, and scores the first tool the model calls.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createApp } from "../src/http/app.js";
import { servicesFromEnv } from "../src/services.js";
import { sign } from "../src/auth/tokens.js";
import { McpSession, bedrockTurn, routeInContext, previousRoute, type HistoryItem } from "../src/sim/planner.js";
import { score, summarise, type EvalCase, type EvalResult } from "../src/sim/eval.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const set = value("--set") ?? "planner";
const { cases } = JSON.parse(readFileSync(new URL(`../eval/${set}.json`, import.meta.url), "utf8")) as { cases: EvalCase[] };
const history = (c: EvalCase): HistoryItem[] => (c.context ?? []).flatMap((u) => [{ role: "user" as const, text: u }, { role: "assistant" as const, text: "OK." }]);

async function scripted(): Promise<EvalResult[]> {
  return cases.map((c) => {
    const pick = routeInContext(c.say, previousRoute(history(c)));
    return pick && "tool" in pick ? score(c, pick.tool, pick.args) : score(c, null, null);
  });
}

async function bedrock(): Promise<EvalResult[]> {
  const svc = servicesFromEnv({ ...process.env, AFTERHOURS_DATA: "sample", PUBLIC_URL: "http://eval.local", NODE_ENV: "test" });
  const app = createApp(svc);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => app(input instanceof Request ? input : new Request(input, init))) as typeof fetch;
  const results: EvalResult[] = [];
  for (const c of cases) {
    // A fresh sample account per case, so one case's state can't steer another.
    const token = sign(
      { iss: svc.baseUrl, aud: `${svc.baseUrl}/mcp`, sub: `sample:eval-${results.length}`, wallet: "SampLeWa11et1111111111111111111111111111111", verified: false, scope: "market portfolio trade", client_id: "eval" },
      svc.secret,
      3600,
    );
    const mcp = await McpSession.open(`${svc.baseUrl}/mcp`, token, fetchImpl);
    try {
      const turn = await bedrockTurn(mcp, c.say, history(c));
      const first = turn.steps[0];
      results.push(score(c, first?.tool ?? null, (first?.rawArgs ?? first?.args) ?? null));
    } catch (err) {
      results.push({ ...score(c, null, null), why: `error: ${(err as Error).message}` });
    }
    process.stderr.write(results.at(-1)!.argsOk ? "." : "x");
  }
  process.stderr.write("\n");
  return results;
}

const mode = flag("--bedrock") ? "bedrock" : "scripted";
const results = mode === "bedrock" ? await bedrock() : await scripted();
const s = summarise(results);
console.log(`Planner: ${mode} · ${set} · ${s.cases} cases · right tool ${(s.tool * 100).toFixed(1)}% · right tool and arguments ${(s.full * 100).toFixed(1)}%`);
for (const r of results.filter((x) => !x.argsOk)) console.log(`  ✗ "${r.case.say}" → wanted ${r.case.tool}: ${r.why}`);
const out = value("--json");
if (out) writeFileSync(out, JSON.stringify({ mode, at: new Date().toISOString(), summary: s, results }, null, 2));
const min = Number(value("--min") ?? 0);
if (s.full < min) {
  console.error(`Below the ${(min * 100).toFixed(0)}% bar.`);
  process.exit(1);
}
