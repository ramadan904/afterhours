# Performance

Alexa+ gives an MCP server 500 ms per round trip. This page shows how much of that budget Afterhours uses under load,
what it cost before profiling, and how to reproduce every number.

## Numbers

`npm run load` starts a sample-data server in a separate process and has N virtual listeners send MCP requests back to
back for 20 seconds. Each request is a full stateless Streamable HTTP round trip with its own bearer token. The mix
matches what people ask at night: 25% `overnight_brief`, 25% `check_stock` across eight names, 12% `market_status`,
10% `my_portfolio`, 10% `sector_moves`, 6% each `market_calendar`, `explain` and `tools/list`. A request counts as
failed on any non-200 status, JSON-RPC error, or tool error.

The test machine had 4 vCPUs (Xeon, 2.8 GHz) and Node 22. The server is **one Node process**, so it uses one core, and
it shares the machine with the load generator.

| Listeners | Requests/s | p50 | p95 | p99 | Failed |
| --: | --: | --: | --: | --: | --: |
| 10 | 537 | 15.8 ms | 36.5 ms | 45.5 ms | 0 of 10,753 |
| 20 | 572 | 30.5 ms | 63.3 ms | 85.0 ms | 0 of 11,462 |
| 50 | 554 | 84.8 ms | 138.9 ms | 196.4 ms | 0 of 11,110 |
| 100 | 591 | 159.3 ms | 226.1 ms | 331.0 ms | 0 of 11,963 |

The raw results, with figures for each tool, are in [`docs/perf/`](perf/).

Throughput levels off at about 550–590 requests/s per process. Past that point, extra listeners only add queueing
(Little's law: 50 listeners ÷ 554/s ≈ 90 ms, which matches the measured p50). Even with 100 listeners all talking at
once on one core, p99 stays under the 500 ms budget.

What that means for people: a voice question takes one to three tool calls, and someone in a conversation asks one
every 20–30 seconds or so. So one core serves several thousand people talking at the same moment. The App Runner
service scales out horizontally beyond that, because every request is stateless.

### Before and after

The same test at 20 listeners, before and after the profiling work below:

|  | Requests/s | p50 | p95 | p99 |
| --- | --: | --: | --: | --: |
| Before | 95 | 189 ms | 383 ms | 455 ms |
| After | 572 | 30.5 ms | 63.3 ms | 85.0 ms |

That's **6× the throughput** at a sixth of the median latency, on the same hardware, with the same tools and answers.

## What the profiles found

CPU profiles of the server under load (`node --cpu-prof`) showed three fixable costs. Then three changes followed:

1. **Tool definitions were rebuilt for every request.**
   - **Cost:** stateless MCP needs a fresh server per request. Building its 34 tools re-created their zod input and
     output schemas, a new Ajv instance, and tool-list JSON Schemas. That was about 3.8 ms of CPU per request, more
     than most tool handlers take.
   - **Fix:** the definitions are now recorded once per process ([`src/mcp/registry.ts`](../src/mcp/registry.ts)) and
     replayed onto each request's server. The validator is shared, and the `tools/list` answer is built once.
   - **Caller isolation:** handlers read the caller from `AsyncLocalStorage`, not from a closure. A test interleaves
     two accounts' requests and checks that neither ever sees the other's watchlist or wallet. The test fails if the
     storage is swapped for a plain variable.
2. **The overnight tape was decoded on every stock check.**
   - **Cost:** `check_stock` reads up to nine 6-hour buckets of the overnight tape (68 names each) to say how far a
     stock ranged overnight.
   - **Fix:** a bucket whose six hours are over doesn't change, so it's now cached decoded. A write from this process
     invalidates the bucket it touches.
3. **New York time was formatted hundreds of times per brief.**
   - **Cost:** `Intl.DateTimeFormat.formatToParts` was the hottest function in the profile. A brief labels 68
     readings, and each needs the Eastern date and the last close.
   - **Fix:** every time-zone offset is a whole number of minutes, so these answers are memoized per minute. Callers
     get copies, and a test checks that the cache can't be poisoned.

The 500 ms budget was never at risk at normal load. What these changes buy is headroom, and a smaller bill: the same
traffic needs a sixth of the CPU.

## A note on the load generator

The first version of the test showed multi-second maximums right at the start. curl, as an independent client, showed a
cold server answering a burst of 100 parallel requests in about 200 ms. So those spikes were the load generator's own
cold start: opening 100 connections and JIT-compiling its client. Every listener now warms up before measuring starts.
The server's own per-tool timings (in `/health`) stayed under 16 ms throughout.

## Reproduce

```sh
npm run load                                   # 50 listeners, 20 s, against a local sample-data server
npm run load -- --concurrency 100 --seconds 30
npm run load -- --json result.json             # also write the results as JSON
AUTH_SECRET=... npm run load -- https://your-host   # against a deployment (mints tokens with its secret)
```

The script exits non-zero if more than 1% of requests fail. CI runs a short version on every push.

Sample data takes the Jupiter network out of the picture. In production, prices come from an in-memory cache that a
background loop refreshes every 8 seconds, so requests don't wait on Jupiter either. The live CI job and
`npm run conformance` measure the real network path against a deployment.
