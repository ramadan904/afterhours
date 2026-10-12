/**
 * Prints every listing whose token and share prices disagree by more than a
 * real move could, with Jupiter's raw row, so a broken leg can be traced.
 * Run in CI's live job.
 *
 *   npx tsx scripts/price-audit.ts
 */

import { LISTINGS } from "../src/market/universe.js";
import { SUSPECT_RATIO } from "../src/market/gap.js";

const JUPITER = (process.env.JUPITER_ENDPOINT ?? "https://lite-api.jup.ag").replace(/\/$/, "");
const rows: Record<string, Record<string, unknown>> = {};
for (let i = 0; i < LISTINGS.length; i += 50) {
  const ids = LISTINGS.slice(i, i + 50).map((l) => l.mint).join(",");
  Object.assign(rows, await fetch(`${JUPITER}/price/v3?ids=${ids}`).then((r) => r.json()));
}
let suspect = 0;
const ratios: number[] = [];
for (const l of LISTINGS) {
  const row = rows[l.mint];
  const token = Number(row?.usdPrice);
  const share = Number((row?.stockData as { price?: number } | undefined)?.price);
  if (!(token > 0) || !(share > 0)) {
    console.log(`${l.ticker}: ${row ? "no share price" : "not priced"}`);
    continue;
  }
  const ratio = token / share;
  ratios.push(ratio);
  if (ratio > SUSPECT_RATIO || ratio < 1 / SUSPECT_RATIO) {
    suspect += 1;
    console.log(`SUSPECT ${l.ticker} token ${token} / share ${share} = ${ratio.toFixed(3)}  ${JSON.stringify(row)}`);
  }
}
ratios.sort((a, b) => a - b);
console.log(`${ratios.length} priced, ${suspect} suspect; middle ratio ${ratios[Math.floor(ratios.length / 2)]?.toFixed(4)}`);
