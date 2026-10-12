import { afterEach, describe, expect, it } from "vitest";
import { BASE, harness, linkWallet } from "./helpers.js";
import { setSynth } from "../src/sim/voice.js";

afterEach(() => setSynth(null));
const post = (h: ReturnType<typeof harness>, body: unknown, token?: string) =>
  h.app(new Request(`${BASE}/sim/api/speak`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));

describe("Amazon Polly voice for the simulator", () => {
  it("is off unless configured, and the page says so", async () => {
    const h = harness();
    expect((await post(h, { text: "hi" })).status).toBe(404);
    expect(await (await h.app(new Request(`${BASE}/sim/`))).text()).toContain('"polly":false');
  });

  it("speaks for linked sessions only, falling back from the generative engine to neural, capped at 600 characters", async () => {
    const calls: { text: string; voice: string; engine: string }[] = [];
    setSynth(async (text, voice, engine) => {
      calls.push({ text, voice, engine });
      if (engine === "generative") throw new Error("not in this region");
      return new Uint8Array([0x49, 0x44, 0x33]);
    });
    const h = harness();
    expect(await (await h.app(new Request(`${BASE}/sim/`))).text()).toContain('"polly":true');
    expect((await post(h, { text: "hi" })).status).toBe(401);
    const { tokens } = await linkWallet(h.app);
    const res = await post(h, { text: "x".repeat(900) }, tokens.access_token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(calls.map((c) => c.engine)).toEqual(["generative", "neural"]);
    expect(calls[1]).toMatchObject({ voice: "Ruth" });
    expect(calls[1].text).toHaveLength(600);
    expect((await post(h, { text: "  " }, tokens.access_token)).status).toBe(400);
  });
});
