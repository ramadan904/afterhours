/**
 * The companion app's few non-MCP endpoints. Everything the app *shows* comes
 * from the MCP tools, exactly as Alexa gets it; these cover what MCP doesn't:
 * registering a device for push notifications, and the overnight tape as a
 * series to draw.
 *
 * Authenticated with the same bearer token the MCP endpoint takes.
 */

import type { Services } from "../services.js";
import { authenticate } from "../auth/oauth.js";
import { addSubscription, notify, removeSubscription, validSubscription, vapidKeys, MAX_SUBSCRIPTIONS } from "../notify/push.js";
import { readTape } from "../market/tape.js";
import { lastRegularClose } from "../market/session.js";
import { listingByTicker, resolveSymbol } from "../market/universe.js";
import { RateLimit } from "./limit.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const testLimit = new RateLimit(5, 10 * 60_000);
const readLimit = new RateLimit(120, 60_000);

export async function accountApi(svc: Services, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/push/key" && request.method === "GET") {
    return json({ publicKey: (await vapidKeys(svc)).publicKey });
  }

  if (path === "/api/tape" && request.method === "GET") {
    if (readLimit.exceeded(request)) return json({ error: "Slow down." }, 429);
    const listing = resolveSymbol(url.searchParams.get("ticker") ?? "");
    if (!listing) return json({ error: "Unknown ticker" }, 404);
    const since = lastRegularClose(new Date(svc.now())).getTime();
    const points = (await readTape(svc))
      .filter((p) => p.at >= since && p.gaps[listing.ticker] !== undefined)
      .map((p) => ({ at: new Date(p.at).toISOString(), gapPercent: Math.round(p.gaps[listing.ticker]) / 100 }));
    return json({ ticker: listing.ticker, name: listingByTicker(listing.ticker)?.spoken, since: new Date(since).toISOString(), points });
  }

  const claims = authenticate(svc, request);
  if (!claims) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  const body = (await request.json().catch(() => ({}))) as { subscription?: unknown; endpoint?: unknown };

  if (path === "/api/push/subscribe") {
    if (!validSubscription(body.subscription)) {
      return json({ error: "That push subscription isn't from a supported browser push service." }, 400);
    }
    const devices = await addSubscription(svc, claims.sub, body.subscription);
    return json({ ok: true, devices, max: MAX_SUBSCRIPTIONS });
  }

  if (path === "/api/push/unsubscribe") {
    if (typeof body.endpoint !== "string") return json({ error: "endpoint required" }, 400);
    await removeSubscription(svc, claims.sub, body.endpoint);
    return json({ ok: true });
  }

  if (path === "/api/push/test") {
    if (testLimit.exceeded(request)) return json({ error: "Too many test notifications." }, 429);
    const delivered = await notify(svc, claims.sub, {
      title: "Afterhours notifications are on",
      body: "Alerts will reach you here the moment they go off, day or night.",
      url: `${svc.baseUrl}/app/`,
      tag: "test",
    });
    return json({ ok: true, delivered });
  }

  return json({ error: "Not found" }, 404);
}
