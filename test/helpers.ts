import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { createApp } from "../src/http/app.js";
import { SamplePrices, CachedPrices } from "../src/market/prices.js";
import { SampleHoldings } from "../src/chain/holdings.js";
import { JupiterSwap } from "../src/chain/trade.js";
import { MemoryStore } from "../src/store/store.js";
import { linkMessage } from "../src/auth/wallet.js";
import type { Services } from "../src/services.js";
import { McpSession } from "../src/sim/planner.js";

export const BASE = "http://localhost:8787";
/** Sunday 11 Oct 2026, 11:00 New York. The share market last closed Friday 16:00 ET. */
export const SUNDAY = Date.parse("2026-10-11T15:00:00Z");
export const FRIDAY_CLOSE = Date.parse("2026-10-09T20:00:00Z");

export function makeServices(overrides: Partial<Services> = {}): Services {
  const now = () => SUNDAY;
  return {
    baseUrl: BASE,
    prices: new CachedPrices(new SamplePrices(now, FRIDAY_CLOSE), 10_000, 120_000, now),
    holdings: new SampleHoldings(),
    swap: new JupiterSwap("http://jupiter.invalid"),
    store: new MemoryStore(),
    rpcUrl: "http://rpc.invalid",
    now,
    secret: "test-secret-0123456789abcdef0123456789",
    authRequired: true,
    sample: true,
    ...overrides,
  };
}

export function harness(overrides: Partial<Services> = {}) {
  const svc = makeServices(overrides);
  const app = createApp(svc);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    app(input instanceof Request ? input : new Request(input, init))) as typeof fetch;
  return { svc, app, fetch: fetchImpl };
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: "afterhours-simulator",
    redirect_uri: `${BASE}/sim/`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "market portfolio trade",
    resource: `${BASE}/mcp`,
    ...extra,
  }).toString();
  return u.toString();
}

/** Reads the signed request and the message parameters out of the link page. */
export async function openLinkPage(app: (r: Request) => Promise<Response>, challenge: string) {
  const res = await app(new Request(authorizeUrl(challenge)));
  const html = await res.text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1];
  const cfg = JSON.parse(/const CFG=(\{.*?\});/.exec(html)![1]);
  return { res, request, cfg };
}

export function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  return {
    address,
    sign: (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret)).toString("base64"),
  };
}

/** The wallet-signature half of linking: returns an unexchanged code. */
export async function authorizeWallet(app: (r: Request) => Promise<Response>) {
  const { verifier, challenge } = pkce();
  const { request, cfg } = await openLinkPage(app, challenge);
  const w = wallet();
  const message = linkMessage({ host: cfg.host, address: w.address, nonce: cfg.nonce, issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt, uri: cfg.uri });
  const post = await app(
    new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, mode: "wallet", address: w.address, message, signature: w.sign(message), issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt }),
    }),
  );
  const location = new URL(post.headers.get("location") ?? `${BASE}/`);
  const code = location.searchParams.get("code")!;
  return { post, location, code, verifier, wallet: w };
}

/** Full account link with a wallet signature. Returns the token response. */
export async function linkWallet(app: (r: Request) => Promise<Response>) {
  const a = await authorizeWallet(app);
  const tokenRes = await exchange(app, { grant_type: "authorization_code", code: a.code, redirect_uri: `${BASE}/sim/`, code_verifier: a.verifier, resource: `${BASE}/mcp` });
  return { ...a, tokenRes, tokens: (await tokenRes.clone().json()) as { access_token: string; refresh_token: string } };
}

export function exchange(app: (r: Request) => Promise<Response>, params: Record<string, string>) {
  return app(
    new Request(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "afterhours-simulator", ...params }),
    }),
  );
}

export async function mcp(h: ReturnType<typeof harness>, token: string | null) {
  return McpSession.open(`${BASE}/mcp`, token, h.fetch);
}
