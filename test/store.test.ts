import { describe, expect, it } from "vitest";
import { DeleteItemCommand, GetItemCommand, PutItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { MemoryStore, UpstashStore, type Store } from "../src/store/store.js";
import { DynamoStore, type DynamoLike } from "../src/store/dynamo.js";

/** DynamoDB's semantics for the three commands the store uses, in memory. */
function fakeDynamo(now: () => number): DynamoLike {
  const table = new Map<string, Record<string, AttributeValue>>();
  return {
    async send(cmd) {
      const input = cmd.input as { Key?: { k: { S: string } }; Item?: Record<string, AttributeValue>; ConditionExpression?: string; ReturnValues?: string };
      if (cmd instanceof GetItemCommand) return { Item: table.get(input.Key!.k.S) };
      if (cmd instanceof PutItemCommand) {
        const key = input.Item!.k.S!;
        const existing = table.get(key);
        if (input.ConditionExpression) {
          const expired = existing?.ttl?.N !== undefined && Number(existing.ttl.N) <= Math.floor(now() / 1000);
          if (existing && !expired) {
            const err = new Error("The conditional request failed");
            err.name = "ConditionalCheckFailedException";
            throw err;
          }
        }
        table.set(key, input.Item!);
        return {};
      }
      if (cmd instanceof DeleteItemCommand) {
        const old = table.get(input.Key!.k.S);
        table.delete(input.Key!.k.S);
        return input.ReturnValues === "ALL_OLD" ? { Attributes: old } : {};
      }
      throw new Error("unexpected command");
    },
  };
}

/** Upstash's REST protocol for the commands the store uses, in memory. */
function fakeUpstash(now: () => number): typeof fetch {
  const data = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const hit = data.get(k);
    if (hit && hit.exp && hit.exp <= now()) data.delete(k);
    return data.get(k);
  };
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const [cmd, key, value, ...rest] = JSON.parse(String(init!.body)) as string[];
    const ex = rest.indexOf("EX");
    const exp = ex >= 0 ? now() + Number(rest[ex + 1]) * 1000 : 0;
    let result: unknown = null;
    if (cmd === "GET") result = live(key)?.v ?? null;
    if (cmd === "SET") {
      if (rest.includes("NX") && live(key)) result = null;
      else (data.set(key, { v: value, exp }), (result = "OK"));
    }
    if (cmd === "DEL") data.delete(key);
    if (cmd === "GETDEL") ((result = live(key)?.v ?? null), data.delete(key));
    return new Response(JSON.stringify({ result }));
  }) as typeof fetch;
}

const backends: [string, (now: () => number) => Store][] = [
  ["memory", (now) => new MemoryStore(now)],
  ["dynamodb", (now) => new DynamoStore("afterhours", fakeDynamo(now), now)],
  ["upstash", (now) => new UpstashStore("https://upstash.test", "token", fakeUpstash(now))],
];

describe.each(backends)("%s store contract", (_name, make) => {
  it("round-trips JSON values", async () => {
    const store = make(() => 0);
    await store.set("a", { n: 1, list: [1, 2] });
    expect(await store.get("a")).toEqual({ n: 1, list: [1, 2] });
    expect(await store.get("missing")).toBeNull();
  });

  it("expires values after their TTL, even before the backend deletes them", async () => {
    let t = 1_000_000;
    const store = make(() => t);
    await store.set("code", "x", 120);
    t += 119_000;
    expect(await store.get("code")).toBe("x");
    t += 2_000;
    expect(await store.get("code")).toBeNull();
    expect(await store.take("code")).toBeNull();
  });

  it("sets only when absent (or expired)", async () => {
    let t = 1_000_000;
    const store = make(() => t);
    expect(await store.setNew("code:123456", "a", 60)).toBe(true);
    expect(await store.setNew("code:123456", "b", 60)).toBe(false);
    expect(await store.get("code:123456")).toBe("a");
    t += 61_000;
    expect(await store.setNew("code:123456", "c", 60)).toBe(true);
  });

  it("hands out a one-time value exactly once", async () => {
    const store = make(() => 0);
    await store.set("authcode:x", { sub: "s" });
    expect(await store.take("authcode:x")).toEqual({ sub: "s" });
    expect(await store.take("authcode:x")).toBeNull();
    await store.set("k", 1);
    await store.del("k");
    expect(await store.get("k")).toBeNull();
  });
});
