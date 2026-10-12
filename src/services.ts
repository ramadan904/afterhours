/**
 * Everything a request needs, built once per process from the environment.
 *
 * `AFTERHOURS_DATA=sample` swaps live Jupiter prices and Solana balances for
 * the built-in offline board and portfolio. Answers built from it say so.
 */

import type { SmsSender } from "./notify/sms.js";
import { CachedPrices, JupiterPrices, SamplePrices, type PriceSource } from "./market/prices.js";
import { RpcHoldings, SampleHoldings, type HoldingsSource } from "./chain/holdings.js";
import { JupiterSwap } from "./chain/trade.js";
import { storeFromEnv, type Store } from "./store/store.js";
import type { PushSender } from "./notify/push.js";
import type { MintSource } from "./chain/mint-facts.js";

export interface Services {
  baseUrl: string;
  prices: PriceSource & { warm?: () => Promise<void> };
  holdings: HoldingsSource;
  swap: JupiterSwap;
  store: Store;
  rpcUrl: string;
  now: () => number;
  /** HMAC key for access tokens and signed form state. */
  secret: string;
  /** False only for local tooling; never in a deployment Alexa talks to. */
  authRequired: boolean;
  sample: boolean;
  /** Push delivery; the Web Push sender when unset. Tests inject a fake. */
  push?: PushSender;
  /** SMS delivery; Amazon SNS when SMS=on. Tests inject a fake. */
  sms?: SmsSender;
  /** Token mint facts; the chain (or the sample set) when unset. Tests inject a fake. */
  mints?: MintSource;
}

export function servicesFromEnv(env: NodeJS.ProcessEnv = process.env): Services {
  const sample = env.AFTERHOURS_DATA === "sample";
  const port = env.PORT ?? "8787";
  // The public origin: set explicitly, or taken from the platform.
  const platformUrl =
    env.RENDER_EXTERNAL_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  const baseUrl = (env.PUBLIC_URL || platformUrl || `http://localhost:${port}`).replace(/\/$/, "");
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const jupiter = env.JUPITER_ENDPOINT ?? "https://lite-api.jup.ag";

  // Anything served over HTTPS is a deployment someone can reach: it must
  // have its own signing key, and it must not run with auth switched off.
  const deployed = env.NODE_ENV === "production" || baseUrl.startsWith("https://");
  const secret = env.AUTH_SECRET ?? "";
  if (deployed && secret.length < 32) {
    throw new Error("AUTH_SECRET must be set to at least 32 random characters on a deployed server.");
  }
  if (deployed && env.AUTH === "off") throw new Error("AUTH=off is for local development only.");

  return {
    baseUrl,
    prices: new CachedPrices(sample ? new SamplePrices() : new JupiterPrices({ endpoint: jupiter })),
    holdings: sample ? new SampleHoldings() : new RpcHoldings(rpcUrl),
    swap: new JupiterSwap(jupiter),
    store: storeFromEnv(env),
    rpcUrl,
    now: Date.now,
    secret: secret || "afterhours-dev-secret-do-not-use-in-production",
    authRequired: env.AUTH !== "off",
    sample,
  };
}
