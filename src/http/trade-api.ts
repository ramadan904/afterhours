/**
 * The confirm page's API. Everything is keyed by the six-digit code Alexa read
 * out, so the page needs no login: the code reveals only a proposal, and the
 * transaction it builds can only be signed by the wallet it was proposed for.
 *
 * Guessing codes is rate-limited per client address.
 */

import type { Services } from "../services.js";
import { intentByCode, saveIntent, type TradeIntent } from "../chain/trade.js";
import { buildTrade, markSubmitted, refreshIntent, TradeNotReady } from "../chain/settle.js";
import { listingByTicker } from "../market/universe.js";
import { SharedRateLimit } from "./limit.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Code lookups and actions: generous for a person, useless for guessing a 1-in-a-million code. */
export const tradeLimit = new SharedRateLimit("trade", 60, 10 * 60_000);

function view(i: TradeIntent) {
  const listing = listingByTicker(i.ticker);
  return {
    code: i.code,
    status: i.status,
    side: i.side,
    ticker: i.ticker,
    token: listing?.token ?? i.ticker,
    usd: i.usd,
    priceAtProposal: i.priceAtProposal,
    wallet: i.wallet,
    expiresAt: new Date(i.expiresAt).toISOString(),
    signature: i.signature ?? null,
    error: i.error ?? null,
  };
}

/** The intent for a code, or why there isn't one. Shared with the Solana Actions endpoints. */
export async function findByCode(svc: Services, code: unknown): Promise<TradeIntent | { missing: string; httpStatus: number }> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.replace(/\D/g, ""))) return { missing: "Enter the six-digit code.", httpStatus: 400 };
  const intent = await intentByCode(svc.store, code, svc.now());
  if (!intent) return { missing: "No trade matches that code. Codes expire after 15 minutes.", httpStatus: 404 };
  if (intent.status === "awaiting_signature" && intent.expiresAt <= svc.now()) intent.status = "expired";
  return intent;
}

async function find(svc: Services, code: unknown): Promise<TradeIntent | Response> {
  const found = await findByCode(svc, code);
  return "missing" in found ? json({ error: found.missing }, found.httpStatus) : found;
}

export async function tradeApi(svc: Services, request: Request, url: URL): Promise<Response> {
  if (await tradeLimit.exceeded(svc.store, request)) return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const path = url.pathname;

  if (path === "/api/trade" && request.method === "GET") {
    const intent = await find(svc, url.searchParams.get("code"));
    if (intent instanceof Response) return intent;
    await refreshIntent(svc, intent);
    return json(view(intent));
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => ({}))) as { code?: string; signature?: string };
  const intent = await find(svc, body.code);
  if (intent instanceof Response) return intent;

  if (path === "/api/trade/build") {
    try {
      return json(await buildTrade(svc, intent));
    } catch (err) {
      if (err instanceof TradeNotReady) return json({ error: err.message }, 409);
      throw err;
    }
  }

  if (path === "/api/trade/submitted") {
    if (intent.status !== "awaiting_signature") return json({ error: `This trade is ${intent.status.replace("_", " ")}.` }, 409);
    if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) return json({ error: "That isn't a transaction signature." }, 400);
    await markSubmitted(svc, intent, body.signature);
    return json(view(intent));
  }

  if (path === "/api/trade/cancel") {
    if (intent.status !== "awaiting_signature") return json({ error: `This trade is ${intent.status.replace("_", " ")}.` }, 409);
    intent.status = "cancelled";
    await saveIntent(svc.store, intent, svc.now());
    return json(view(intent));
  }

  return json({ error: "Not found" }, 404);
}
