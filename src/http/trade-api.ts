/**
 * The confirm page's API. Everything is keyed by the six-digit code Alexa read
 * out, so the page needs no login: the code reveals only a proposal, and the
 * transaction it builds can only be signed by the wallet it was proposed for.
 *
 * Guessing codes is rate-limited per client address.
 */

import type { Services } from "../services.js";
import { confirmOnChain, intentByCode, saveIntent, swapLegs, type TradeIntent } from "../chain/trade.js";
import { USDC, listingByTicker } from "../market/universe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const SLIPPAGE_BPS = Number(process.env.TRADE_SLIPPAGE_BPS ?? 50);

const attempts = new Map<string, { n: number; reset: number }>();
function limited(request: Request): boolean {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 10 * 60_000 });
    return false;
  }
  a.n += 1;
  return a.n > 60;
}

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

async function find(svc: Services, code: unknown): Promise<TradeIntent | Response> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.replace(/\D/g, ""))) return json({ error: "Enter the six-digit code." }, 400);
  const intent = await intentByCode(svc.store, code, svc.now());
  if (!intent) return json({ error: "No trade matches that code. Codes expire after 15 minutes." }, 404);
  if (intent.status === "awaiting_signature" && intent.expiresAt <= svc.now()) intent.status = "expired";
  return intent;
}

export async function tradeApi(svc: Services, request: Request, url: URL): Promise<Response> {
  if (limited(request)) return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const path = url.pathname;

  if (path === "/api/trade" && request.method === "GET") {
    const intent = await find(svc, url.searchParams.get("code"));
    if (intent instanceof Response) return intent;
    if (intent.status === "submitted" && intent.signature && !svc.sample) {
      const check = await confirmOnChain(svc.rpcUrl, intent.signature, intent.wallet).catch(() => ({ status: "pending" as const, error: undefined }));
      if (check.status !== "pending") {
        intent.status = check.status;
        intent.error = check.error;
        await saveIntent(svc.store, intent);
      }
    }
    return json(view(intent));
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => ({}))) as { code?: string; signature?: string };
  const intent = await find(svc, body.code);
  if (intent instanceof Response) return intent;

  if (path === "/api/trade/build") {
    if (intent.status !== "awaiting_signature") return json({ error: `This trade is ${intent.status.replace("_", " ")}.` }, 409);
    if (svc.sample) {
      return json({ error: "This server is running on sample data, so it can't build a real transaction. Deploy with live data to sign trades." }, 409);
    }
    const board = await svc.prices.read();
    const price = board.quotes.get(intent.ticker)?.tokenPrice ?? intent.priceAtProposal;
    const legs = swapLegs(intent, price);
    const quote = await svc.swap.quote({ ...legs, slippageBps: SLIPPAGE_BPS });
    const transaction = await svc.swap.build(quote, intent.wallet);
    const listing = listingByTicker(intent.ticker)!;
    const inDecimals = intent.side === "buy" ? USDC.decimals : listing.decimals;
    const outDecimals = intent.side === "buy" ? listing.decimals : USDC.decimals;
    const fmt = (raw: string, d: number, unit: string) => `${(Number(raw) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: d === 6 ? 2 : 6 })} ${unit}`;
    return json({
      transaction,
      pay: fmt(quote.inAmount, inDecimals, intent.side === "buy" ? "USDC" : listing.token),
      receive: fmt(quote.outAmount, outDecimals, intent.side === "buy" ? listing.token : "USDC"),
      impact: `${(Math.abs(Number(quote.priceImpactPct ?? 0)) * 100).toFixed(2)}%`,
      slippage: `${(SLIPPAGE_BPS / 100).toFixed(1)}%`,
    });
  }

  if (path === "/api/trade/submitted") {
    if (intent.status !== "awaiting_signature") return json({ error: `This trade is ${intent.status.replace("_", " ")}.` }, 409);
    if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) return json({ error: "That isn't a transaction signature." }, 400);
    intent.status = "submitted";
    intent.signature = body.signature;
    await saveIntent(svc.store, intent);
    return json(view(intent));
  }

  if (path === "/api/trade/cancel") {
    if (intent.status !== "awaiting_signature") return json({ error: `This trade is ${intent.status.replace("_", " ")}.` }, 409);
    intent.status = "cancelled";
    await saveIntent(svc.store, intent);
    return json(view(intent));
  }

  return json({ error: "Not found" }, 404);
}
