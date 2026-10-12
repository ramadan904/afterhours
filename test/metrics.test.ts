import { afterEach, describe, expect, it } from "vitest";
import { count, flush, maybeFlush, recordLatency, startMetrics, stopMetrics } from "../src/obs/metrics.js";
import { harness, linkWallet, mcp } from "./helpers.js";

afterEach(() => stopMetrics());

describe("CloudWatch metrics", () => {
  it("does nothing unless switched on", async () => {
    expect(await startMetrics({})).toBe(false);
    recordLatency("check_stock", 12);
    expect(await flush()).toEqual([]);
  });

  it("publishes raw latencies per tool and overall, plus counters, then resets", async () => {
    const sent: { Namespace: string; MetricData: Record<string, unknown>[] }[] = [];
    await startMetrics({}, async (input) => sent.push(input as never));
    for (const ms of [10, 10, 12, 400]) recordLatency("check_stock", ms);
    recordLatency("overnight_brief", 8);
    count("TapeSamples");
    count("AlertsFired", 3);
    const data = (await flush(new Date("2026-10-12T00:00:00Z"))) as Record<string, unknown>[];
    expect(sent[0].Namespace).toBe("Afterhours");
    expect(data).toContainEqual(expect.objectContaining({ MetricName: "ToolLatency", Dimensions: [{ Name: "Tool", Value: "check_stock" }], Values: [10, 12, 400], Counts: [2, 1, 1], Unit: "Milliseconds" }));
    expect(data).toContainEqual(expect.objectContaining({ MetricName: "ToolLatency", Values: [10, 12, 400, 8], Counts: [2, 1, 1, 1] }));
    expect(data).toContainEqual(expect.objectContaining({ MetricName: "AlertsFired", Value: 3, Unit: "Count" }));
    expect(await flush()).toEqual([]);
  });

  it("is fed by real tool calls, and flushes at most once a minute", async () => {
    const sent: unknown[] = [];
    await startMetrics({}, async (input) => sent.push(input));
    const h = harness();
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    await session.call("check_stock", { stock: "Tesla" });
    await session.call("check_stock", { stock: "nonsense stock" });
    const data = (await flush()) as { MetricName: string; Dimensions?: unknown[]; Value?: number }[];
    expect(data.some((d) => d.MetricName === "ToolLatency" && JSON.stringify(d.Dimensions).includes("check_stock"))).toBe(true);
    expect(data.find((d) => d.MetricName === "ToolErrors")?.Value).toBe(1);
    const before = sent.length;
    recordLatency("x", 1);
    maybeFlush(Date.now()); // just flushed via the requests? at most one more
    maybeFlush(Date.now());
    expect(sent.length - before).toBeLessThanOrEqual(1);
  });
});
