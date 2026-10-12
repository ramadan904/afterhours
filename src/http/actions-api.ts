/**
 * Every proposal Alexa reads out is also a Solana Action.
 *
 * The confirm page is one way to sign. A Solana Action is the other: a URL
 * that any Actions client (Phantom, Backpack, Solflare, Dialect blinks) can
 * turn into a signing prompt on its own, and that a phone wallet can scan as a
 * Solana Pay transaction request. Same guarantees as the page:
 *
 * - The code reveals only a proposal (and is rate-limited per client).
 * - The transaction is built for the proposal's wallet only. Any other account
 *   gets a refusal, not a transaction to sign.
 * - Nothing executes until the wallet signs, and a trade is reported confirmed
 *   only once Solana shows it (see chain/settle.ts).
 *
 *   GET  /actions.json                        which site paths are actions
 *   GET  /api/actions/trade/:code             the action (title, icon, button)
 *   POST /api/actions/trade/:code             { account } → { transaction }
 *   POST /api/actions/trade/:code/next        { account, signature } → completed
 *   GET  /api/actions/trade/:code/card.svg    the action's image
 *
 * Spec: https://solana.com/docs/advanced/actions (v2.4 headers).
 */

import bs58 from "bs58";
import type { Services } from "../services.js";
import type { TradeIntent } from "../chain/trade.js";
import { buildTrade, markSubmitted, refreshIntent, TradeNotReady } from "../chain/settle.js";
import { listingByTicker } from "../market/universe.js";
import { usd } from "../market/speech.js";
import { SIGNATURE, findByCode, tradeLimit } from "./trade-api.js";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export const ACTION_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "access-control-expose-headers": "X-Action-Version, X-Blockchain-Ids",
  "x-action-version": "2.4",
  "x-blockchain-ids": MAINNET,
};

export const isActionPath = (path: string) => path === "/actions.json" || path.startsWith("/api/actions/");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...ACTION_HEADERS, "content-type": "application/json", "cache-control": "no-store" } });

/** Actions report errors as `{ message }`. */
const refuse = (message: string, status = 400) => json({ message }, status);

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function isAccount(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function headline(i: TradeIntent): string {
  const token = listingByTicker(i.ticker)?.token ?? i.ticker;
  return `${i.side === "buy" ? "Buy" : "Sell"} ${usd(i.usd)} of ${token}`;
}

const STATUS_LABEL: Record<string, string> = {
  awaiting_signature: "Waiting for your signature",
  submitted: "Sent, confirming",
  confirmed: "Confirmed on Solana",
  failed: "Not confirmed",
  expired: "Expired",
  cancelled: "Cancelled",
  armed: "Waiting for its price",
};

function action(svc: Services, i: TradeIntent) {
  const href = `${svc.baseUrl}/api/actions/trade/${i.code}`;
  const open = i.status === "awaiting_signature";
  const name = listingByTicker(i.ticker)?.spoken ?? i.ticker;
  return {
    type: "action",
    icon: `${href}/card.svg`,
    title: headline(i),
    description: open
      ? `Proposed by voice through Afterhours for ${short(i.wallet)}, at about ${usd(i.priceAtProposal)} a token. You'll get a fresh Jupiter quote with at most ${(Number(process.env.TRADE_SLIPPAGE_BPS ?? 50) / 100).toFixed(1)}% slippage. Nothing moves until you sign.`
      : `This ${name} trade is ${(STATUS_LABEL[i.status] ?? i.status).toLowerCase()}.`,
    label: open ? "Review & sign" : (STATUS_LABEL[i.status] ?? i.status),
    disabled: !open,
    links: open ? { actions: [{ type: "transaction", label: `${i.side === "buy" ? "Buy" : "Sell"} ${usd(i.usd)}`, href }] } : undefined,
  };
}

/** The action's image: the trade, large, in the site's colours. */
function card(i: TradeIntent | null): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = i ? headline(i) : "Afterhours";
  const sub = i ? `${STATUS_LABEL[i.status] ?? i.status} · code ${i.code}` : "Your tokenized stocks, by voice";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<rect width="600" height="600" fill="#0b1020"/>
<circle cx="470" cy="130" r="70" fill="#ffb547"/><circle cx="500" cy="110" r="62" fill="#0b1020"/>
<text x="48" y="96" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="30" font-weight="700" fill="#ffb547">Afterhours</text>
<text x="48" y="330" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="${title.length > 22 ? 46 : 58}" font-weight="700" fill="#e9ecf7">${esc(title)}</text>
<text x="48" y="390" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="28" fill="#9aa4c4">${esc(sub)}</text>
<text x="48" y="540" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="24" fill="#9aa4c4">Voice proposes. Your wallet disposes.</text>
</svg>`;
  return new Response(svg, { headers: { ...ACTION_HEADERS, "content-type": "image/svg+xml", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function actionsApi(svc: Services, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: ACTION_HEADERS });

  if (path === "/actions.json") {
    return json({ rules: [{ pathPattern: "/go/*", apiPath: "/api/actions/trade/*" }] });
  }

  const m = /^\/api\/actions\/trade\/(\d{6})(\/next|\/card\.svg)?$/.exec(path);
  if (!m) return refuse("Not found", 404);
  if (await tradeLimit.exceeded(svc.store, request)) return refuse("Too many attempts. Wait a few minutes.", 429);
  const [, code, tail] = m;
  const found = await findByCode(svc, code);

  if (tail === "/card.svg") return card("missing" in found ? null : found);
  if ("missing" in found) return refuse(found.missing, found.httpStatus);
  const intent = found;

  if (method === "GET" && !tail) {
    await refreshIntent(svc, intent);
    return json(action(svc, intent));
  }
  if (method !== "POST") return refuse("Not found", 404);

  const body = (await request.json().catch(() => ({}))) as { account?: unknown; signature?: unknown };
  if (!isAccount(body.account)) return refuse("That isn't a Solana account.");
  if (body.account !== intent.wallet) {
    return refuse(`This trade was proposed for ${short(intent.wallet)}. Switch to that account in your wallet.`, 403);
  }

  if (tail === "/next") {
    // The wallet signed and sent; record what it reports. The chain decides.
    if (typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) return refuse("That isn't a transaction signature.");
    if (intent.status === "awaiting_signature") await markSubmitted(svc, intent, body.signature);
    return json({
      type: "completed",
      icon: `${svc.baseUrl}/api/actions/trade/${intent.code}/card.svg`,
      title: headline(intent),
      description: "Sent to Solana. Ask Alexa \"did my trade go through?\" or watch it on the confirm page.",
      label: "Sent",
    });
  }

  try {
    const built = await buildTrade(svc, intent);
    return json({
      type: "transaction",
      transaction: built.transaction,
      message: `You pay ${built.pay} and receive about ${built.receive} (price impact ${built.impact}, max slippage ${built.slippage}).`,
      links: { next: { type: "post", href: `/api/actions/trade/${intent.code}/next` } },
    });
  } catch (err) {
    if (err instanceof TradeNotReady) return refuse(err.message, 409);
    return refuse("Couldn't get a quote from Jupiter right now. Try again in a moment.", 502);
  }
}
