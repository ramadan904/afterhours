/**
 * Metrics for CloudWatch: what /health shows, kept over time and alarmed on.
 *
 * Every tool call's latency is buffered and published once a minute with
 * PutMetricData as raw values (so CloudWatch can compute true p95s, per tool
 * and across all tools), with counts of errors, tape samples, alerts fired
 * and notifications sent. The CloudFormation stack (infra/aws.yaml) draws a
 * dashboard from these and alarms when tool p95 passes 400 ms or the tape
 * sampler goes quiet, since a silent sampler means alerts, briefings and
 * settlements have all stopped.
 *
 * Off unless METRICS=cloudwatch. Publishing failures are swallowed: metrics
 * must never take the service down.
 */

export const NAMESPACE = "Afterhours";

type Sink = (input: { Namespace: string; MetricData: unknown[] }) => Promise<unknown>;

const latencies = new Map<string, number[]>();
const counters = new Map<string, number>();
let sink: Sink | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastFlush = Date.now();

/**
 * Flushes if a minute has passed. Called after every request, because App
 * Runner throttles CPU between requests and a timer can't be relied on there;
 * the 5-minute EventBridge call to /api/cron/tape guarantees a regular one.
 */
export function maybeFlush(now = Date.now()): void {
  if (!sink || now - lastFlush < 60_000) return;
  lastFlush = now;
  void flush(new Date(now));
}

export function recordLatency(tool: string, ms: number): void {
  if (!sink) return;
  const list = latencies.get(tool) ?? [];
  list.push(Math.round(ms * 10) / 10);
  latencies.set(tool, list);
}

export function count(name: "ToolErrors" | "TapeSamples" | "AlertsFired" | "PushSent" | "TradesConfirmed" | "PreflightOk" | "PreflightFailed", n = 1): void {
  if (!sink) return;
  counters.set(name, (counters.get(name) ?? 0) + n);
}

/**
 * Values and counts, compressed. CloudWatch takes up to 150 distinct values
 * per datum, so a busy minute is split over several datums rather than
 * dropping values (which would skew the percentiles).
 */
function valuesAndCounts(values: number[]): { Values: number[]; Counts: number[] }[] {
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  const entries = [...tally];
  const out: { Values: number[]; Counts: number[] }[] = [];
  for (let i = 0; i < entries.length; i += 150) {
    const part = entries.slice(i, i + 150);
    out.push({ Values: part.map(([v]) => v), Counts: part.map(([, c]) => c) });
  }
  return out;
}

/** Builds and sends one minute's metrics; returns what was sent (for tests). */
export async function flush(now = new Date()): Promise<unknown[]> {
  if (!sink) return [];
  const data: unknown[] = [];
  const all: number[] = [];
  for (const [tool, list] of latencies) {
    if (!list.length) continue;
    all.push(...list);
    for (const part of valuesAndCounts(list)) data.push({ MetricName: "ToolLatency", Dimensions: [{ Name: "Tool", Value: tool }], Unit: "Milliseconds", Timestamp: now, ...part });
  }
  if (all.length) for (const part of valuesAndCounts(all)) data.push({ MetricName: "ToolLatency", Unit: "Milliseconds", Timestamp: now, ...part });
  for (const [name, n] of counters) data.push({ MetricName: name, Unit: "Count", Timestamp: now, Value: n });
  latencies.clear();
  counters.clear();
  for (let i = 0; i < data.length; i += 1000) {
    await sink({ Namespace: NAMESPACE, MetricData: data.slice(i, i + 1000) }).catch(() => undefined);
  }
  return data;
}

/** Starts publishing every minute. Tests pass their own sink. */
export async function startMetrics(env: NodeJS.ProcessEnv = process.env, custom?: Sink): Promise<boolean> {
  if (custom) {
    sink = custom;
    return true;
  }
  if (env.METRICS !== "cloudwatch") return false;
  const { CloudWatchClient, PutMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
  const client = new CloudWatchClient({});
  sink = (input) => client.send(new PutMetricDataCommand(input as never));
  timer = setInterval(() => void flush(), 60_000);
  timer.unref?.();
  return true;
}

export function stopMetrics(): void {
  if (timer) clearInterval(timer);
  timer = null;
  sink = null;
  latencies.clear();
  counters.clear();
}
