/**
 * The guided demo: try Afterhours without a wallet.
 *
 * A judge opening the simulator shouldn't need Phantom to see the product.
 * This creates a short-lived demo account and hands back a tour: real
 * utterances that go through the same planner and the same MCP endpoint, with
 * the same bearer-token auth, as everything else. Nothing is faked; the tour
 * is only chosen so each step lands on something worth seeing:
 *
 * - the honesty layer, on whichever live token is too thin to price right now;
 * - a trade proposal, with its code and QR, that only a wallet could sign;
 * - a guardrail set *around the current time*, so the held trade and the
 *   24-hour cooling-off happen live rather than being described.
 *
 * The demo wallet is DEMO_WALLET when the deployment sets one (so its
 * portfolio is real), otherwise a freshly generated address no one holds the
 * key to: proposals for it can be prepared and shown, never signed.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import type { Services } from "../services.js";
import { sign } from "../auth/tokens.js";
import { mcpResource } from "../auth/oauth.js";
import { SharedRateLimit } from "./limit.js";
import { readingsFrom } from "../market/tape.js";
import { listingByTicker } from "../market/universe.js";
import { EASTERN, resolveZone, setZone, zoneParts, type Zone } from "../market/zones.js";

export const DEMO_TTL_SECONDS = 30 * 60;
const demoLimit = new SharedRateLimit("demo", 20, 3600_000);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Names people know, tried first when picking a thin market to show. */
const FAMILIAR = ["SMCI", "BAC", "MRK", "JPM", "V", "PFE", "CRM", "IBM", "JNJ", "PG"];

/** "2 pm", "midnight", "noon" for a local hour. */
export function hourPhrase(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return `${h % 12} ${h < 12 ? "am" : "pm"}`;
}

export interface TourStep {
  say: string;
  /** What to look at, shown above the device while the step runs. */
  note: string;
}

export function demoTour(o: { thin: string | null; hour: number }): TourStep[] {
  return [
    { say: "What happened overnight?", note: "The live board: how far each token has moved since the share last traded. Every MCP call shows its latency on the right." },
    { say: "Is the Tesla token trading rich?", note: "With the share market shut, a gap is a bet on the open, not a hedge. Afterhours says which it is." },
    ...(o.thin
      ? [{ say: `How's ${o.thin} doing?`, note: "The honesty layer: a token almost nobody trades on Solana doesn't get read out as a price." }]
      : []),
    { say: "Is the Tesla token safe?", note: "Read from the token's Token-2022 mint on Solana: what its issuer can actually do." },
    {
      say: "Buy 25 dollars of Apple because people love the new phone",
      note: "Alexa can't trade. It prepares a proposal with a code and QR; only the wallet can sign it. The reason goes in the trading journal, with the hour it was asked.",
    },
    {
      say: `Don't let me trade between ${hourPhrase(o.hour)} and ${hourPhrase(o.hour + 3)}`,
      note: "A guardrail, set while calm. This one covers right now, so you can see it work.",
    },
    { say: "Buy 25 dollars of Nvidia", note: "Same request as before, but now sleep mode holds it until the window ends." },
    { say: "Turn off sleep mode", note: "Loosening a guardrail takes 24 hours: the person asking at 2 a.m. can't undo what the daytime self set." },
  ];
}

function throwawayAddress(): string {
  return bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
}

export async function simulatorDemo(svc: Services, request: Request): Promise<Response> {
  if (await demoLimit.exceeded(svc.store, request)) return json({ error: "Lots of demos from here lately. Try again in a while." }, 429);
  const body = (await request.json().catch(() => ({}))) as { tz?: unknown };
  const now = svc.now();

  const sub = `demo:${bs58.encode(crypto.getRandomValues(new Uint8Array(9)))}`;
  const configured = process.env.DEMO_WALLET?.trim();
  const wallet = configured || (svc.sample ? "SampLeWa11et1111111111111111111111111111111" : throwawayAddress());

  // The visitor's own clock, so "now" in the tour is their now.
  const zone: Zone = (typeof body.tz === "string" && body.tz.length < 64 ? resolveZone(body.tz) : null) ?? EASTERN;
  await setZone(svc.store, sub, zone);

  const board = await svc.prices.read().catch(() => null);
  const thinTickers = new Set(board ? readingsFrom(board, now).filter((r) => r.kind === "thin_market").map((r) => r.ticker) : []);
  const thinTicker = FAMILIAR.find((t) => thinTickers.has(t)) ?? [...thinTickers][0] ?? null;
  const thin = thinTicker ? (listingByTicker(thinTicker)?.spoken ?? null) : null;

  const accessToken = sign(
    { iss: svc.baseUrl, aud: mcpResource(svc), sub, wallet, verified: false, scope: "market portfolio trade", client_id: "afterhours-simulator", demo: true },
    svc.secret,
    DEMO_TTL_SECONDS,
    now,
  );
  return json({
    access_token: accessToken,
    expires_in: DEMO_TTL_SECONDS,
    wallet,
    walletKind: configured ? "configured" : svc.sample ? "sample" : "throwaway",
    tour: demoTour({ thin, hour: Math.floor(zoneParts(new Date(now), zone.tz).minutes / 60) }),
  });
}
