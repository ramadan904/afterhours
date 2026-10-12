/**
 * Load test: many listeners asking at once, the way a busy Sunday evening
 * would look from the server's side.
 *
 *   npm run load                          # starts a sample-data server, then loads it
 *   npm run load -- https://your-host     # loads a deployment (needs AUTH_SECRET)
 *   npm run load -- --concurrency 100 --seconds 30
 *
 * Each virtual listener sends one MCP request after another, picked from a
 * weighted mix of what people ask a voice assistant about stocks at night.
 * Every request is a full stateless Streamable HTTP round trip with a bearer
 * token. A request counts as failed if the HTTP status isn't 200, the
 * JSON-RPC reply carries an error, or the tool result is an error.
 *
 * Prints throughput and p50/p95/p99 latency per tool, and writes the same as
 * JSON with --json <file>.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { sign } from "../src/auth/tokens.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const concurrency = Number(flag("concurrency", "50"));
const seconds = Number(flag("seconds", "20"));
const jsonOut = args.includes("--json") ? flag("json", "") : "";
const target = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

/** What people ask, and how often, on a weekend evening. */
const MIX: { weight: number; label: string; method: string; params: () => unknown }[] = [
  { weight: 25, label: "overnight_brief", method: "tools/call", params: () => ({ name: "overnight_brief", arguments: {} }) },
  { weight: 25, label: "check_stock", method: "tools/call", params: () => ({ name: "check_stock", arguments: { stock: pick(["Tesla", "Nvidia", "the S&P 500", "Apple", "Coinbase", "MicroStrategy", "Meta", "Amazon"]) } }) },
  { weight: 12, label: "market_status", method: "tools/call", params: () => ({ name: "market_status", arguments: {} }) },
  { weight: 10, label: "my_portfolio", method: "tools/call", params: () => ({ name: "my_portfolio", arguments: {} }) },
  { weight: 10, label: "sector_moves", method: "tools/call", params: () => ({ name: "sector_moves", arguments: { sector: pick(["tech", "chips", "banks", "crypto"]) } }) },
  { weight: 6, label: "market_calendar", method: "tools/call", params: () => ({ name: "market_calendar", arguments: { day: pick(["Thanksgiving", "tomorrow", "Christmas Eve"]) } }) },
  { weight: 6, label: "explain", method: "tools/call", params: () => ({ name: "explain", arguments: { topic: pick(["tokenized_stocks", "price_gap", "trading_safety"]) } }) },
  { weight: 6, label: "tools/list", method: "tools/list", params: () => ({}) },
];
const TOTAL = MIX.reduce((t, m) => t + m.weight, 0);
function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}
function draw() {
  let r = Math.random() * TOTAL;
  for (const m of MIX) if ((r -= m.weight) < 0) return m;
  return MIX[0];
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function startLocal(): Promise<{ base: string; secret: string; child: ChildProcess }> {
  const port = await freePort();
  const secret = "load-test-secret-0123456789abcdef0123";
  const child = spawn(process.execPath, ["--import", "tsx", "src/node.ts"], {
    env: { ...process.env, PORT: String(port), AFTERHOURS_DATA: "sample", AUTH_SECRET: secret, PUBLIC_URL: "", NODE_ENV: "development", UPSTASH_REDIS_REST_URL: "", KV_REST_API_URL: "", DYNAMODB_TABLE: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i += 1) {
    const up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    if (up) return { base, secret, child };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("The local server didn't start.");
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
const round = (n: number) => Math.round(n * 10) / 10;

const local = target ? null : await startLocal();
const base = (target ?? local!.base).replace(/\/$/, "");
const secret = local?.secret ?? process.env.AUTH_SECRET;
if (!secret) {
  console.error("Set AUTH_SECRET (the deployment's signing secret) to mint load-test tokens.");
  process.exit(2);
}
// One token per virtual listener, each with a sample wallet, like real linked accounts.
const tokens = Array.from({ length: concurrency }, (_, i) =>
  sign(
    { iss: base, aud: `${base}/mcp`, sub: `load:${i}`, wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", verified: false, scope: "market portfolio trade", client_id: "load" },
    secret,
    3600,
  ),
);

type Sample = { label: string; ms: number; ok: boolean; at: number };
const samples: Sample[] = [];
const errors = new Map<string, number>();
let id = 0;

async function once(token: string): Promise<void> {
  const m = draw();
  const t = performance.now();
  let ok = false;
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: m.method, params: m.params() }),
    });
    const text = await res.text();
    const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
    ok = res.status === 200 && !json.error && !json.result?.isError;
    if (!ok) errors.set(`${m.label}: ${res.status} ${json.error?.message ?? json.result?.content?.[0]?.text ?? ""}`.slice(0, 160), (errors.get(m.label) ?? 0) + 1);
  } catch (err) {
    errors.set(`${m.label}: ${(err as Error).message}`, 1);
  }
  samples.push({ label: m.label, ms: performance.now() - t, ok, at: t });
}

// Warm-up, so first-call costs aren't counted. They're mostly this script's
// own: opening a connection per listener and JIT-compiling the client. (curl
// shows a cold server answering a burst of 100 in about 200 ms.)
for (let i = 0; i < 3; i += 1) await Promise.all(tokens.map((tk) => once(tk)));
samples.length = 0;
errors.clear();

console.log(`Loading ${base}/mcp with ${concurrency} listeners for ${seconds}s…`);
const started = performance.now();
const deadline = started + seconds * 1000;
await Promise.all(
  tokens.map(async (tk) => {
    while (performance.now() < deadline) await once(tk);
  }),
);
const elapsed = (performance.now() - started) / 1000;
local?.child.kill();
if (process.env.LOAD_DEBUG) console.log([...samples].sort((a, b) => b.ms - a.ms).slice(0, 8).map((s) => `${s.label} ${Math.round(s.ms)}ms at +${Math.round(s.at - started)}ms`).join("\n"));

const summarise = (xs: Sample[]) => {
  const ms = xs.map((s) => s.ms).sort((a, b) => a - b);
  return { requests: xs.length, failed: xs.filter((s) => !s.ok).length, p50: round(pct(ms, 0.5)), p95: round(pct(ms, 0.95)), p99: round(pct(ms, 0.99)), max: round(ms[ms.length - 1] ?? NaN) };
};
const overall = { ...summarise(samples), rps: round(samples.length / elapsed) };
const byTool = Object.fromEntries(MIX.map((m) => [m.label, summarise(samples.filter((s) => s.label === m.label))]));

console.log(`\n${overall.requests} requests in ${round(elapsed)}s: ${overall.rps} requests/s, ${overall.failed} failed`);
console.log(`latency ms  p50 ${overall.p50}  p95 ${overall.p95}  p99 ${overall.p99}  max ${overall.max}\n`);
console.log("tool".padEnd(18) + "requests".padStart(9) + "failed".padStart(8) + "p50".padStart(8) + "p95".padStart(8) + "p99".padStart(8));
for (const [label, s] of Object.entries(byTool)) {
  console.log(label.padEnd(18) + String(s.requests).padStart(9) + String(s.failed).padStart(8) + String(s.p50).padStart(8) + String(s.p95).padStart(8) + String(s.p99).padStart(8));
}
if (errors.size) {
  console.log("\nFailures:");
  for (const [msg, n] of errors) console.log(`  ${n}× ${msg}`);
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ target: target ? base : "local sample-data server", concurrency, seconds, node: process.version, at: new Date().toISOString(), overall, byTool }, null, 2) + "\n");
}
process.exit(overall.failed / Math.max(1, overall.requests) > 0.01 ? 1 : 0);
