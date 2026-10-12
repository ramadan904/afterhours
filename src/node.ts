/**
 * Runs Afterhours as a plain Node HTTP server (local dev, Docker, App Runner).
 */

import { startMetrics } from "./obs/metrics.js";
import { createServer } from "node:http";
import { createApp } from "./http/app.js";
import { servicesFromEnv } from "./services.js";
import { SAMPLE_EVERY_MS, recordTape, seedSampleTape } from "./market/tape.js";

const svc = servicesFromEnv();
const app = createApp(svc);
const port = Number(process.env.PORT ?? 8787);
/** No request here needs more than a few kilobytes. */
const MAX_BODY_BYTES = 1024 * 1024;

// A long-running process can keep the price cache warm, so even the first
// voice request after a quiet spell is served from memory.
void svc.prices.warm?.();
// CloudWatch metrics when METRICS=cloudwatch (set by the AWS stack).
void startMetrics().then((on) => on && console.log("Publishing metrics to CloudWatch (namespace Afterhours)."));
setInterval(() => void svc.prices.warm?.(), 8_000).unref();

// The overnight tape: sample the board and check everyone's alerts on a timer.
const sample = () =>
  recordTape(svc).catch((err: Error) => console.error("tape:", err.message));
void seedSampleTape(svc).then(sample);
setInterval(sample, SAMPLE_EVERY_MS).unref();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" }).end('{"error":"payload_too_large"}');
      req.destroy();
      return;
    }
    chunks.push(c as Buffer);
  }
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
