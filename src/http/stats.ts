/**
 * Rolling latency per tool, so the 500ms claim can be checked on a live
 * server (`/health`) rather than taken on trust. Server-side handler time
 * only: network time to Alexa is on top, and the conformance script measures
 * that end to end.
 */

const WINDOW = 500;
const samples = new Map<string, number[]>();
const startedAt = Date.now();

export function recordToolTime(tool: string, ms: number): void {
  const list = samples.get(tool) ?? [];
  list.push(ms);
  if (list.length > WINDOW) list.shift();
  samples.set(tool, list);
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function toolStats(): Record<string, { calls: number; p50Ms: number; p95Ms: number; maxMs: number }> {
  const out: Record<string, { calls: number; p50Ms: number; p95Ms: number; maxMs: number }> = {};
  for (const [tool, list] of samples) {
    const sorted = [...list].sort((a, b) => a - b);
    const round = (n: number) => Math.round(n * 10) / 10;
    out[tool] = { calls: list.length, p50Ms: round(quantile(sorted, 0.5)), p95Ms: round(quantile(sorted, 0.95)), maxMs: round(sorted.at(-1)!) };
  }
  return out;
}

export function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1000);
}
