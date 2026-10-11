/**
 * Fake Jupiter + Solana RPC on one port, for running the live data path with
 * no network (local demos, browser tests). Not used in production.
 *
 *   npx tsx scripts/fake-upstreams.ts 9900
 *   JUPITER_ENDPOINT=http://localhost:9900 SOLANA_RPC_URL=http://localhost:9900 npm run dev
 *
 * Any wallet holds a small sample portfolio, and any signature reported for a
 * swap is treated as landed, paid for by the wallet the last swap was built for.
 */

import { createServer } from "node:http";
import { fakeUpstreams, type FakeState } from "../test/fake-upstreams.js";
import { lastRegularClose } from "../src/market/session.js";

const port = Number(process.argv[2] ?? 9900);
let lastSwapUser = "";
const state: FakeState = {
  balances: new Proxy({}, { get: () => ({ TSLA: 4.25, NVDA: 12, AAPL: 6.5, SPY: 1.8 }) }),
  transactions: new Proxy({}, { get: () => (lastSwapUser ? { payer: lastSwapUser } : undefined) }),
  shareUpdatedAt: lastRegularClose(new Date()).toISOString(),
  calls: [],
};
const upstream = fakeUpstreams(state);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
  if (req.url?.startsWith("/swap/v1/swap") && body) lastSwapUser = JSON.parse(body).userPublicKey;
  const out = await upstream(`http://localhost:${port}${req.url}`, { method: req.method, body });
  res.writeHead(out.status, { "content-type": "application/json" });
  res.end(await out.text());
}).listen(port, () => console.log(`fake Jupiter + Solana RPC on :${port}`));
