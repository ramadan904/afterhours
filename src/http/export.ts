/**
 * The wallet's trade history as a spreadsheet, for tax time.
 *
 * Every buy, sale and transfer of an xStock that Afterhours reconstructed
 * from the chain (see chain/basis.ts), one row each, with the USDC paid or
 * received, the price per token, and each sale's gain at average cost. Tax
 * rules differ by country (many need FIFO, not average cost), so the method
 * is named in its own column, and the transaction link lets anyone check a
 * row against Solana itself.
 */

import type { TradeRow } from "../chain/basis.js";
import { listingByTicker } from "../market/universe.js";

const cell = (v: string | number | null) => {
  if (v === null) return "";
  const s = String(v);
  // Quote anything with a delimiter, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const round = (n: number, d: number) => Number(n.toFixed(d));

export function tradesCsv(trades: TradeRow[]): string {
  const header = ["date_utc", "type", "token", "quantity", "usdc", "price_per_token", "realized_gain_usd", "cost_method", "transaction"];
  const lines = trades.map((t) =>
    [
      t.at ? new Date(t.at).toISOString() : null,
      t.kind,
      listingByTicker(t.ticker)?.token ?? t.ticker,
      round(t.qty, 8),
      t.usdc === null ? null : round(t.usdc, 2),
      t.usdc === null || !t.qty ? null : round(t.usdc / t.qty, 4),
      t.realized,
      t.kind === "sell" && t.realized !== null ? "average_cost" : null,
      t.signature.startsWith("sample") ? null : `https://solscan.io/tx/${t.signature}`,
    ]
      .map(cell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
