/**
 * Builds the open track record for a few names from the live public sources
 * (GeckoTerminal + Yahoo) and prints it. Run in CI's live job.
 *
 *   npx tsx scripts/track-record.ts TSLA NVDA
 */

import { openRecords, shareBars, tokenHourly, trackRecord } from "../src/market/history.js";

for (const ticker of process.argv.slice(2).length ? process.argv.slice(2) : ["TSLA", "NVDA"]) {
  try {
    const [token, share] = await Promise.all([tokenHourly(ticker), shareBars(ticker)]);
    const records = openRecords(token, share);
    const t = trackRecord(records);
    console.log(`${ticker}: ${token.length} token bars, ${share.length} share bars → ${records.length} opens (${t.from} … ${t.to})`);
    console.log(`  calls ${t.calls}, same direction ${t.sameDirection}, median miss ${(t.medianMissBps / 100).toFixed(2)}%`);
    for (const r of records.slice(-3)) console.log(`  ${r.date}: overnight ${(r.overnightBps / 100).toFixed(2)}% → open ${(r.openBps / 100).toFixed(2)}%`);
  } catch (err) {
    console.log(`${ticker}: ${(err as Error).message}`);
  }
  // Spaced like the server's daily refresh, for GeckoTerminal's free tier.
  await new Promise((r) => setTimeout(r, 4_000));
}
