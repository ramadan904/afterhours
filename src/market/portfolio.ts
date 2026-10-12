/** What a wallet's tokenized stocks are worth, and how much that moved against the shares. */

import type { GapReading } from "./gap.js";
import { listingByTicker } from "./universe.js";

export function valuePortfolio(holdings: { ticker: string; amount: number }[], readings: GapReading[]) {
  const positions = holdings
    .map((h) => {
      const r = readings.find((x) => x.ticker === h.ticker);
      const listing = listingByTicker(h.ticker);
      if (!r || !listing) return null;
      const valueUsd = h.amount * r.tokenPrice;
      const changeUsd = r.sharePrice && r.kind !== "stale_reference" && r.kind !== "suspect_price" && r.kind !== "thin_market" ? h.amount * (r.tokenPrice - r.sharePrice) : null;
      return { ticker: h.ticker, name: listing.spoken, amount: h.amount, valueUsd, changeUsd, reading: r };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => b.valueUsd - a.valueUsd);
  const total = positions.reduce((t, p) => t + p.valueUsd, 0);
  const change = positions.reduce((t, p) => t + (p.changeUsd ?? 0), 0);
  const biggest = [...positions].sort((a, b) => Math.abs(b.changeUsd ?? 0) - Math.abs(a.changeUsd ?? 0))[0] ?? null;
  return { positions, total, change, biggest };
}
