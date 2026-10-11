/**
 * Account linking: OAuth 2.1 authorization code with PKCE, as Alexa+ requires
 * of an MCP server that serves user-specific data.
 *
 * What Alexa+'s MCP onboarding asks for, and where it lives here:
 *
 * - Protected resource metadata at the RFC 9728 well-known URI
 *   → `protectedResourceMetadata`
 * - Authorization server metadata advertising PKCE with S256
 *   → `authorizationServerMetadata` (`code_challenge_methods_supported`)
 * - The `resource` parameter equal to the server's canonical MCP URI
 *   → checked at /authorize and /token
 * - No Dynamic Client Registration: clients are registered by configuration
 *   → `clientsFromEnv`
 * - Unauthenticated MCP requests answered 401
 *   → `app.ts`
 *
 * The person proves which wallet they are linking by signing a message in it
 * (see `wallet.ts`), so the account Alexa holds a token for is a Solana
 * address, and nothing else about them is stored.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Services } from "../services.js";
import { randomToken, sign, verify } from "./tokens.js";
import { isAddress, linkMessage, verifyWalletSignature } from "./wallet.js";
import { authorizePage, errorPage } from "../http/pages.js";

export const SCOPES = ["market", "portfolio", "trade"] as const;
export const ACCESS_TOKEN_TTL = 3600;
export const REFRESH_TOKEN_TTL = 90 * 24 * 3600;
const CODE_TTL = 120;
const REQUEST_TTL = 600;

export interface OAuthClient {
  client_id: string;
  /** Absent for public clients, which must rely on PKCE alone. */
  client_secret?: string;
  redirect_uris: string[];
  name: string;
}

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  wallet: string | null;
  verified: boolean;
  scope: string;
  client_id: string;
  exp: number;
  iat: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  resource: string;
  sub: string;
  wallet: string | null;
  verified: boolean;
}

interface RefreshRecord {
  clientId: string;
  scope: string;
  resource: string;
  sub: string;
  wallet: string | null;
  verified: boolean;
}

export const mcpResource = (svc: Services) => `${svc.baseUrl}/mcp`;

/**
 * Registered clients. The simulator is always present (a public client: it
 * runs in a browser and keeps no secret). Alexa's client is added from the
 * credentials and redirect URLs shown on the add-on's account-linking page.
 */
export function clientsFromEnv(svc: Services, env: NodeJS.ProcessEnv = process.env): OAuthClient[] {
  const clients: OAuthClient[] = [
    { client_id: "afterhours-simulator", redirect_uris: [`${svc.baseUrl}/sim/`], name: "Afterhours Alexa+ simulator" },
  ];
  if (env.ALEXA_CLIENT_ID) {
    clients.push({
      client_id: env.ALEXA_CLIENT_ID,
      client_secret: env.ALEXA_CLIENT_SECRET || undefined,
      redirect_uris: (env.ALEXA_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      name: "Alexa",
    });
  }
  if (env.OAUTH_CLIENTS) {
    for (const c of JSON.parse(env.OAUTH_CLIENTS) as OAuthClient[]) clients.push({ ...c, name: c.name ?? c.client_id });
  }
  return clients;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

export function protectedResourceMetadata(svc: Services): Response {
  return json({
    resource: mcpResource(svc),
    authorization_servers: [svc.baseUrl],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Afterhours",
    resource_documentation: `${svc.baseUrl}/`,
  });
}

export function authorizationServerMetadata(svc: Services): Response {
  return json({
    issuer: svc.baseUrl,
    authorization_endpoint: `${svc.baseUrl}/authorize`,
    token_endpoint: `${svc.baseUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  });
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function normaliseScope(scope: string | null): string {
  const asked = (scope ?? "").split(/\s+/).filter(Boolean);
  const granted = asked.length ? asked.filter((s) => (SCOPES as readonly string[]).includes(s)) : [...SCOPES];
  return granted.join(" ");
}

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string;
  resource: string;
  nonce: string;
}

/**
 * Validates an authorization request. Errors that make the redirect target
 * untrustworthy (unknown client, unregistered redirect) are shown on a page and
 * never redirected, per OAuth 2.1; everything else goes back to the client.
 */
function readAuthRequest(svc: Services, params: URLSearchParams): AuthRequest | Response {
  const clients = clientsFromEnv(svc);
  const client = clients.find((c) => c.client_id === params.get("client_id"));
  if (!client) return errorPage("This app isn't registered with Afterhours.", 400);
  const redirectUri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirectUri)) {
    return errorPage("The return address for this link request isn't registered.", 400);
  }

  const back = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (params.get("state")) url.searchParams.set("state", params.get("state")!);
    url.searchParams.set("iss", svc.baseUrl);
    return Response.redirect(url.toString(), 302);
  };

  if (params.get("response_type") !== "code") return back("unsupported_response_type", "response_type must be code");
  const challenge = params.get("code_challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "A PKCE code_challenge is required");
  if ((params.get("code_challenge_method") ?? "plain") !== "S256") {
    return back("invalid_request", "code_challenge_method must be S256");
  }
  const resource = params.get("resource") ?? mcpResource(svc);
  if (resource !== mcpResource(svc)) return back("invalid_target", `resource must be ${mcpResource(svc)}`);
  const scope = normaliseScope(params.get("scope"));
  if (!scope) return back("invalid_scope", `Supported scopes: ${SCOPES.join(" ")}`);

  return {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: params.get("state"),
    code_challenge: challenge,
    scope,
    resource,
    nonce: randomToken(12),
  };
}

export function authorizeGet(svc: Services, url: URL): Response {
  const req = readAuthRequest(svc, url.searchParams);
  if (req instanceof Response) return req;
  const client = clientsFromEnv(svc).find((c) => c.client_id === req.client_id)!;
  const requestToken = sign({ kind: "authreq", ...req }, svc.secret, REQUEST_TTL, svc.now());
  const issuedAt = new Date(svc.now()).toISOString();
  const expiresAt = new Date(svc.now() + REQUEST_TTL * 1000).toISOString();
  return authorizePage({
    clientName: client.name,
    requestToken,
    host: new URL(svc.baseUrl).host,
    uri: svc.baseUrl,
    nonce: req.nonce,
    issuedAt,
    expiresAt,
    sample: svc.sample,
    scope: req.scope,
  });
}

/**
 * The person has chosen how to link: a signed message from their wallet, a
 * watch-only address, or (offline sample mode only) the sample portfolio.
 */
export async function authorizePost(svc: Services, form: URLSearchParams): Promise<Response> {
  const req = verify<AuthRequest & { kind: string; exp: number; iat: number }>(form.get("request") ?? "", svc.secret, svc.now());
  if (!req || req.kind !== "authreq") return errorPage("This link request has expired. Start again from the Alexa app.", 400);

  let sub: string;
  let wallet: string | null;
  let verified: boolean;
  const mode = form.get("mode");
  const address = form.get("address") ?? "";

  if (mode === "wallet") {
    // Browsers submit form fields with CRLF line breaks; the wallet signed LF.
    const message = (form.get("message") ?? "").replace(/\r\n/g, "\n");
    const signature = form.get("signature") ?? "";
    const expected = linkMessage({
      host: new URL(svc.baseUrl).host,
      address,
      nonce: req.nonce,
      issuedAt: form.get("issuedAt") ?? "",
      expiresAt: form.get("expiresAt") ?? "",
      uri: svc.baseUrl,
    });
    const expiry = Date.parse(form.get("expiresAt") ?? "");
    if (message !== expected || !(expiry > svc.now())) {
      return errorPage("The signed message didn't match this link request. Please try again.", 400);
    }
    if (!verifyWalletSignature(address, message, signature)) {
      return errorPage("That signature doesn't belong to this wallet address. Please try again.", 400);
    }
    sub = `sol:${address}`;
    wallet = address;
    verified = true;
  } else if (mode === "watch") {
    if (!isAddress(address)) return errorPage("That isn't a valid Solana address.", 400);
    // Watch-only: balances are public, and a proposed trade can still only be
    // signed by this address's own wallet. Kept distinct from a verified link.
    // Each watch-only link is its own account: anyone can watch any address,
    // so two people watching the same one must not share alerts or proposals.
    sub = `watch:${address}:${randomToken(8)}`;
    wallet = address;
    verified = false;
  } else if (mode === "sample" && svc.sample) {
    sub = `sample:${randomToken(8)}`;
    wallet = "SampLeWa11et1111111111111111111111111111111";
    verified = false;
  } else {
    return errorPage("Choose how to link your account.", 400);
  }

  const code = randomToken(32);
  const record: CodeRecord = {
    clientId: req.client_id,
    redirectUri: req.redirect_uri,
    challenge: req.code_challenge,
    scope: req.scope,
    resource: req.resource,
    sub,
    wallet,
    verified,
  };
  await svc.store.set(`authcode:${code}`, record, CODE_TTL);

  const to = new URL(req.redirect_uri);
  to.searchParams.set("code", code);
  if (req.state) to.searchParams.set("state", req.state);
  to.searchParams.set("iss", svc.baseUrl);
  // 303: the browser follows a POST with a GET to the client's redirect URI.
  return new Response(null, { status: 303, headers: { location: to.toString(), "cache-control": "no-store" } });
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function clientCredentials(request: Request, form: URLSearchParams): { id: string | null; secret: string | null } {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    const i = decoded.indexOf(":");
    if (i > 0) {
      return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
    }
  }
  return { id: form.get("client_id"), secret: form.get("client_secret") };
}

function issue(svc: Services, rec: RefreshRecord & { clientId: string }, refreshToken: string) {
  const claims: Omit<AccessClaims, "exp" | "iat"> = {
    iss: svc.baseUrl,
    aud: rec.resource,
    sub: rec.sub,
    wallet: rec.wallet,
    verified: rec.verified,
    scope: rec.scope,
    client_id: rec.clientId,
  };
  return json({
    access_token: sign(claims, svc.secret, ACCESS_TOKEN_TTL, svc.now()),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: rec.scope,
  });
}

export async function token(svc: Services, request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const creds = clientCredentials(request, form);
  const client = clientsFromEnv(svc).find((c) => c.client_id === creds.id);
  if (!client) return oauthError("invalid_client", "Unknown client", 401);
  if (client.client_secret && !sameSecret(creds.secret ?? "", client.client_secret)) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    // take(): a code works once. A replayed code finds nothing.
    const rec = await svc.store.take<CodeRecord>(`authcode:${code}`);
    if (!rec || rec.clientId !== client.client_id) return oauthError("invalid_grant", "Code is invalid, expired or already used");
    const redirect = form.get("redirect_uri");
    if (redirect && redirect !== rec.redirectUri) return oauthError("invalid_grant", "redirect_uri does not match");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== rec.challenge) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    const resource = form.get("resource");
    if (resource && resource !== rec.resource) return oauthError("invalid_target", "resource does not match");

    const refresh = randomToken(32);
    const refreshRec: RefreshRecord = { clientId: rec.clientId, scope: rec.scope, resource: rec.resource, sub: rec.sub, wallet: rec.wallet, verified: rec.verified };
    await svc.store.set(`refresh:${refresh}`, refreshRec, REFRESH_TOKEN_TTL);
    return issue(svc, refreshRec, refresh);
  }

  if (grant === "refresh_token") {
    const old = form.get("refresh_token") ?? "";
    // Rotation: each refresh token is single-use, as OAuth 2.1 asks of public clients.
    const rec = await svc.store.take<RefreshRecord>(`refresh:${old}`);
    if (!rec || rec.clientId !== client.client_id) return oauthError("invalid_grant", "Refresh token is invalid or expired");
    const refresh = randomToken(32);
    await svc.store.set(`refresh:${refresh}`, rec, REFRESH_TOKEN_TTL);
    return issue(svc, rec, refresh);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** Claims from a bearer token, if it is valid for this MCP server. */
export function authenticate(svc: Services, request: Request): AccessClaims | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const claims = verify<AccessClaims>(match[1].trim(), svc.secret, svc.now());
  if (!claims || claims.aud !== mcpResource(svc) || claims.iss !== svc.baseUrl) return null;
  return claims;
}
