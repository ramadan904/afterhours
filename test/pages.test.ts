import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { BASE, authorizeUrl, harness, pkce } from "./helpers.js";
import { CARD_URI, cardHtml, type CardKind } from "../src/mcp/apps.js";

/** Every inline <script> must at least parse: a syntax error silently kills a page. */
function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe("inline scripts compile", () => {
  const { app } = harness();
  it.each([["/"], ["/sim/"], ["/app/"], ["/go?code=123456"], ["authorize"]])("%s", async (path) => {
    const url = path === "authorize" ? authorizeUrl(pkce().challenge) : BASE + path;
    const html = await (await app(new Request(url))).text();
    const scripts = scriptsOf(html);
    if (path !== "/") expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Script(s)).not.toThrow();
  });

  it("service worker", async () => {
    const js = await (await app(new Request(`${BASE}/sw.js`))).text();
    expect(() => new Script(js)).not.toThrow();
  });

  it.each(Object.keys(CARD_URI))("card %s", (kind) => {
    const scripts = scriptsOf(cardHtml(kind as CardKind));
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0])).not.toThrow();
  });
});
