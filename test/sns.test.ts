import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, authorizeUrl, harness, pkce } from "./helpers.js";
import { isSolName, resolveSolName } from "../src/chain/sns.js";

const TOLY = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const fakeSns = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/resolve/toly")) return Response.json({ s: "ok", result: TOLY });
  if (url.endsWith("/resolve/evil")) return Response.json({ s: "ok", result: "not-a-key" });
  return Response.json({ s: "error", result: "Domain not found" });
}) as typeof fetch;

afterEach(() => vi.unstubAllGlobals());

describe(".sol names", () => {
  it("recognises names, subdomains included", () => {
    expect(["toly.sol", "Bonfida.SOL", "pay.toly.sol", "a-b.sol"].map(isSolName)).toEqual([true, true, true, true]);
    expect(["toly", "toly.eth", ".sol", "to ly.sol"].map(isSolName)).toEqual([false, false, false, false]);
  });

  it("resolves through the SNS proxy and checks the result is a key", async () => {
    expect(await resolveSolName("toly.sol", fakeSns)).toBe(TOLY);
    expect(await resolveSolName("evil.sol", fakeSns)).toBeNull();
    expect(await resolveSolName("nobody.sol", fakeSns)).toBeNull();
  });

  it("links a watch-only account from a .sol name", async () => {
    vi.stubGlobal("fetch", fakeSns);
    const h = harness();
    const { challenge } = pkce();
    const page = await (await h.app(new Request(authorizeUrl(challenge)))).text();
    const request = /name="request" value="([^"]+)"/.exec(page)![1];
    const post = (address: string) =>
      h.app(new Request(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, mode: "watch", address }).toString() }));
    const ok = await post("Toly.sol");
    expect(ok.status).toBe(303);
    const bad = await post("nobody.sol");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("nobody.sol doesn&#39;t resolve to a wallet");
  });
});
