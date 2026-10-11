/**
 * Signed, self-contained tokens (JWT, HS256).
 *
 * Access tokens are verified on every MCP request, which has a 500ms budget, so
 * they carry everything the request needs — who the caller is and which wallet
 * they linked — and verifying one is a single HMAC, with no store lookup.
 * The same signer protects the authorization request while the person is on
 * the link page, so its parameters cannot be edited between steps.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export interface Claims {
  [key: string]: unknown;
  exp: number;
  iat: number;
}

export function sign(payload: Record<string, unknown>, secret: string, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const body = { ...payload, iat, exp: iat + ttlSeconds, jti: randomBytes(9).toString("base64url") };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const mac = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${mac}`;
}

/** The claims if the token is authentic and unexpired, else null. Never throws. */
export function verify<T extends { exp: number } = Claims>(token: string, secret: string, now = Date.now()): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, mac] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString());
    if (header.alg !== "HS256") return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
