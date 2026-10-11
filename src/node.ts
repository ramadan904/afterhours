/**
 * Runs Afterhours as a plain Node HTTP server (local dev, Docker, App Runner).
 */

import { createServer } from "node:http";
import { createApp } from "./http/app.js";
import { servicesFromEnv } from "./services.js";

const svc = servicesFromEnv();
const app = createApp(svc);
const port = Number(process.env.PORT ?? 8787);

// A long-running process can keep the price cache warm, so even the first
// voice request after a quiet spell is served from memory.
void svc.prices.warm?.();
setInterval(() => void svc.prices.warm?.(), 8_000).unref();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const request = new Request(new URL(req.url ?? "/", svc.baseUrl), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await app(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
}).listen(port, () => {
  console.log(`Afterhours on ${svc.baseUrl} (${svc.sample ? "sample data" : "live data"}${svc.authRequired ? "" : ", AUTH OFF"})`);
  console.log(`  MCP endpoint: ${svc.baseUrl}/mcp`);
  console.log(`  Simulator:    ${svc.baseUrl}/sim/`);
});
