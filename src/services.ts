/**
 * Everything a request needs, built once per process from the environment.
 *
 * `AFTERHOURS_DATA=sample` swaps live Jupiter prices and Solana balances for
 * the built-in offline board and portfolio. Answers built from it say so.
 */

import { CachedPrices, JupiterPrices, SamplePrices, type PriceSource } from "./market/prices.js";
import { RpcHoldings, SampleHoldings, type HoldingsSource } from "./chain/holdings.js";
import { JupiterSwap } from "./chain/trade.js";
import { storeFromEnv, type Store } from "./store/store.js";

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
}

export function servicesFromEnv(env: NodeJS.ProcessEnv = process.env): Services {
  const sample = env.AFTERHOURS_DATA === "sample";
  const port = env.PORT ?? "8787";
  const baseUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const jupiter = env.JUPITER_ENDPOINT ?? "https://lite-api.jup.ag";

  const secret = env.AUTH_SECRET ?? "";
  if (secret.length < 32 && env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set to at least 32 characters in production.");
  }

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
