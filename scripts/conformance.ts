/**
 * Checks a running Afterhours deployment against what Alexa+'s MCP onboarding
 * asks for, and measures latency the way Alexa+ will experience it: over the
 * network, from wherever this script runs.
 *
 *   npm run conformance -- https://your-host [access-token]
 *
 * Without a token, it mints one when AUTH_SECRET is set (same secret as the
 * server), otherwise it runs only the unauthenticated checks.
 */

import { sign } from "../src/auth/tokens.js";

const base = (process.argv[2] ?? process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
let token = process.argv[3] ?? process.env.CONFORMANCE_TOKEN ?? "";
if (!token && process.env.AUTH_SECRET) {
  token = sign({ iss: base, aud: `${base}/mcp`, sub: "conformance", wallet: null, verified: false, scope: "market portfolio trade", client_id: "cli" }, process.env.AUTH_SECRET, 600);
}

const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ check: name, ok, detail });
const rpc = (method: string, params: unknown, id = 1, auth = true) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

function pct(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function timed(fn: () => Promise<Response>, n: number) {
  const ms: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = performance.now();
    const res = await fn();
    await res.text();
    ms.push(performance.now() - t);
  }
  return { p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
}

const prm = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) => r.json()).catch(() => null);
check("RFC 9728 protected resource metadata", prm?.resource === `${base}/mcp` && Array.isArray(prm?.authorization_servers), prm ? `resource=${prm.resource}` : "missing");

const asm = await fetch(`${(prm?.authorization_servers?.[0] ?? base).replace(/\/$/, "")}/.well-known/oauth-authorization-server`).then((r) => r.json()).catch(() => null);
check("Authorization server advertises PKCE S256", Array.isArray(asm?.code_challenge_methods_supported) && asm.code_challenge_methods_supported.includes("S256"), JSON.stringify(asm?.code_challenge_methods_supported));
check("No dynamic client registration required", !asm?.registration_endpoint, asm?.registration_endpoint ?? "none");
check("HTTPS endpoint", base.startsWith("https://"), base.startsWith("https://") ? "" : "Alexa+ will need HTTPS; fine for local runs");

const unauth = await rpc("tools/list", {}, 1, false);
check("Unauthenticated request → 401", unauth.status === 401, `status ${unauth.status}`);
check("401 carries no WWW-Authenticate header", unauth.headers.get("www-authenticate") === null, unauth.headers.get("www-authenticate") ?? "absent");

if (token) {
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "conformance", version: "1" } });
  const initBody = await init.json().catch(() => ({}));
  check("Negotiates MCP 2025-11-25 over Streamable HTTP", initBody?.result?.protocolVersion === "2025-11-25", initBody?.result?.protocolVersion ?? `status ${init.status}`);

  const list = await (await rpc("tools/list", {})).json();
  const tools = (list?.result?.tools ?? []) as { name: string; annotations?: Record<string, boolean>; outputSchema?: unknown }[];
  check("tools/list returns tools", tools.length > 0, `${tools.length} tools`);
  check("Every tool declares readOnlyHint or destructiveHint", tools.every((t) => t.annotations && ("readOnlyHint" in t.annotations || "destructiveHint" in t.annotations)), tools.filter((t) => !t.annotations).map((t) => t.name).join(", ") || "all annotated");
  check("Every tool declares an outputSchema", tools.every((t) => t.outputSchema), "");

  const n = Number(process.env.RUNS ?? 20);
  const lat = await timed(() => rpc("tools/list", {}), n);
  check(`tools/list p95 < 500ms (${n} runs)`, lat.p95 < 500, `p50 ${lat.p50.toFixed(0)}ms · p95 ${lat.p95.toFixed(0)}ms`);
  const sample = await (await rpc("tools/call", { name: "overnight_brief", arguments: {} })).json();
  console.log(`overnight_brief says: ${sample?.result?.content?.[0]?.text ?? JSON.stringify(sample)}\n`);
  for (const [name, args] of [["overnight_brief", {}], ["check_stock", { stock: "Tesla" }], ["market_status", {}]] as const) {
    const l = await timed(() => rpc("tools/call", { name, arguments: args }), n);
    check(`tools/call ${name} p95 < 500ms`, l.p95 < 500, `p50 ${l.p50.toFixed(0)}ms · p95 ${l.p95.toFixed(0)}ms`);
  }
} else {
  check("Authenticated checks", false, "skipped: pass a token or set AUTH_SECRET");
}

const width = Math.max(...results.map((r) => r.check.length));
const ADVISORY = new Set(["HTTPS endpoint"]);
for (const r of results) console.log(`${r.ok ? "PASS" : ADVISORY.has(r.check) ? "WARN" : "FAIL"}  ${r.check.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok && !ADVISORY.has(r.check));
process.exitCode = failed.length ? 1 : 0;
