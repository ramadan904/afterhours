/**
 * One web-standard handler, `(Request) => Response`, for the whole product.
 *
 * Because it only speaks Request and Response, the same code runs under Node
 * (`src/node.ts`), as a Vercel function (`api/index.ts`), or behind any other
 * fetch-style runtime, with no adapter in between.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Services } from "../services.js";
import { asCaller, install, sharedValidator } from "../mcp/registry.js";
import {
  authenticate,
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  mcpResource,
  protectedResourceMetadata,
  token,
} from "../auth/oauth.js";
import { confirmPage, errorPage, landingPage } from "./pages.js";
import { simulatorPage } from "./simulator.js";
import { tradeApi } from "./trade-api.js";
import { simulatorTurn } from "./sim-api.js";
import { pollyEnabled, speak } from "../sim/voice.js";
import { qrSvg } from "./qr.js";
import { accountApi } from "./account-api.js";
import { companionPage } from "./companion.js";
import { icon, manifest, serviceWorker } from "./pwa.js";
import { readTape, recordTape } from "../market/tape.js";
import { ACTION_HEADERS, actionsApi, isActionPath } from "./actions-api.js";
import { maybeFlush } from "../obs/metrics.js";
import { toolStats, uptimeSeconds } from "./stats.js";
import { timingSafeEqual } from "node:crypto";

export { VERSION } from "../version.js";
import { VERSION } from "../version.js";
const REPO_URL = process.env.REPO_URL ?? "https://github.com/ramadan904/afterhours";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * MCP over Streamable HTTP, stateless: a fresh server per request, JSON
 * responses rather than an SSE stream. Every tool answers in one round trip,
 * so there is nothing to stream, and statelessness means any instance can
 * serve any request — which is what keeps a serverless deployment inside
 * Alexa+'s latency budget.
 */
async function handleMcp(svc: Services, request: Request): Promise<Response> {
  let authInfo: AuthInfo | undefined;
  if (svc.authRequired) {
    const claims = authenticate(svc, request);
    if (!claims) {
      // Alexa+'s MCP onboarding asks for a bare 401 with no WWW-Authenticate
      // header; clients discover auth from the RFC 9728 well-known URI.
      // Generic MCP clients that rely on the header can opt in.
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (process.env.WWW_AUTHENTICATE === "on") {
        headers["www-authenticate"] = `Bearer resource_metadata="${svc.baseUrl}/.well-known/oauth-protected-resource"`;
      }
      return new Response(JSON.stringify({ error: "unauthorized", error_description: "A valid bearer token is required" }), {
        status: 401,
        headers,
      });
    }
    authInfo = {
      token: "",
      clientId: claims.client_id,
      scopes: claims.scope.split(" "),
      expiresAt: claims.exp,
      resource: new URL(mcpResource(svc)),
      extra: { sub: claims.sub, wallet: claims.wallet, verified: claims.verified },
    };
  } else {
    authInfo = {
      token: "",
      clientId: "local",
      scopes: ["market", "portfolio", "trade"],
      extra: { sub: "local", wallet: process.env.LOCAL_WALLET ?? null },
    };
  }

  const server = new McpServer(
    { name: "afterhours", title: "Afterhours", version: VERSION },
    {
      instructions:
        "Afterhours answers questions about tokenized US stocks (xStocks on Solana) at any hour, including when the stock market is closed. Tool results are written to be spoken. Trades are only ever proposed: the user signs them in their own wallet.",
      jsonSchemaValidator: sharedValidator,
    },
  );
  const extra = authInfo.extra as { sub: string; wallet: string | null };
  install(server, svc);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await asCaller({ sub: extra.sub, wallet: extra.wallet }, () => transport.handleRequest(request, { authInfo }));
  } finally {
    // The JSON response is fully built by now; closing frees the per-request server.
    void transport.close();
  }
}

/**
 * The tape recorder, for deployments without a long-running process: a
 * scheduler (GitHub Actions, Vercel Cron, EventBridge) calls this every few
 * minutes with `Authorization: Bearer $CRON_SECRET`. Disabled when the secret
 * isn't set.
 */
async function cronTape(svc: Services, request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "not_found" }, 404);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return json({ error: "unauthorized" }, 401);
  return json(await recordTape(svc));
}

export function createApp(svc: Services) {
  const handle = async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // Solana Actions carry their own CORS and version headers, OPTIONS included.
    if (isActionPath(path)) {
      try {
        return await actionsApi(svc, request, url);
      } catch {
        return new Response(JSON.stringify({ message: "Something went wrong." }), { status: 500, headers: { ...ACTION_HEADERS, "content-type": "application/json" } });
      }
    }
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === "/mcp") return withCors(await handleMcp(svc, request));

      if (path.startsWith("/.well-known/oauth-protected-resource")) return withCors(protectedResourceMetadata(svc));
      if (path.startsWith("/.well-known/oauth-authorization-server")) return withCors(authorizationServerMetadata(svc));

      if (path === "/authorize" && method === "GET") return authorizeGet(svc, url);
      if (path === "/authorize" && method === "POST") return authorizePost(svc, new URLSearchParams(await request.text()));
      if (path === "/token" && method === "POST") return withCors(await token(svc, request));

      if (path === "/" && method === "GET") return landingPage({ baseUrl: svc.baseUrl, sample: svc.sample, repoUrl: REPO_URL });
      if (path === "/go" && method === "GET") return confirmPage({ code: url.searchParams.get("code") ?? "" });
      // /go/123456 is the same page, and the URL a blink client maps to the action (see /actions.json).
      if (/^\/go\/\d{6}$/.test(path) && method === "GET") return confirmPage({ code: path.slice(4) });
      if (path.startsWith("/api/trade")) return await tradeApi(svc, request, url);
      if (path.startsWith("/api/push/") || path.startsWith("/api/export/") || path === "/api/sms" || path.startsWith("/api/sms/") || path === "/api/tape") return await accountApi(svc, request, url);

      if (path === "/qr.svg" && method === "GET") return qrSvg(svc, url);
      if (path === "/app") return Response.redirect(`${svc.baseUrl}/app/${url.search}`, 301);
      if (path === "/app/" && method === "GET") return companionPage({ baseUrl: svc.baseUrl, sample: svc.sample });
      if (path === "/sw.js") return serviceWorker();
      if (path === "/manifest.webmanifest") return manifest(svc);
      if (path.startsWith("/icons/")) return icon(path) ?? errorPage("There's nothing here.", 404);
      if (path === "/api/cron/tape") return await cronTape(svc, request);
      if (path === "/sim") return Response.redirect(`${svc.baseUrl}/sim/${url.search}`, 301);
      if (path === "/sim/" && method === "GET") return simulatorPage({ baseUrl: svc.baseUrl, sample: svc.sample, polly: pollyEnabled() });
      if (path === "/sim/api/turn" && method === "POST") return await simulatorTurn(svc, request);
      if (path === "/sim/api/speak" && method === "POST") return await speak(svc, request);

      if (path === "/health") {
        const started = performance.now();
        const board = await svc.prices.read().catch((e: Error) => e);
        return json({
          ok: !(board instanceof Error),
          version: VERSION,
          data: svc.sample ? "sample" : "live",
          prices: board instanceof Error ? { error: board.message } : { source: board.source, asOf: new Date(board.at).toISOString(), listings: board.quotes.size },
          priceReadMs: Math.round(performance.now() - started),
          mcp: mcpResource(svc),
          uptimeSeconds: uptimeSeconds(),
          tape: await readTape(svc).then(
            (t) => ({ points: t.length, lastSampleAt: t.length ? new Date(t.at(-1)!.at).toISOString() : null }),
            () => null,
          ),
          // Server-side handler time per tool over the last 500 calls.
          tools: toolStats(),
        });
      }

      return errorPage("There's nothing here.", 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal_error" }, 500);
    }
  };
  // Each response is a chance to publish metrics (see obs/metrics.ts).
  return async (request: Request): Promise<Response> => {
    try {
      return await handle(request);
    } finally {
      maybeFlush();
    }
  };
}
