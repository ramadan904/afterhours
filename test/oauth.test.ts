import { describe, expect, it } from "vitest";
import { BASE, authorizeWallet, exchange, harness, linkWallet, openLinkPage, pkce, wallet, authorizeUrl } from "./helpers.js";
import { linkMessage } from "../src/auth/wallet.js";

describe("discovery", () => {
  it("serves RFC 9728 protected resource metadata, including at the path-suffixed URI", async () => {
    const { app } = harness();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = await (await app(new Request(BASE + path))).json();
      expect(body.resource).toBe(`${BASE}/mcp`);
      expect(body.authorization_servers).toEqual([BASE]);
    }
  });

  it("advertises PKCE with S256 only", async () => {
    const { app } = harness();
    const body = await (await app(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toBeUndefined();
  });

  it("answers an unauthenticated MCP request with 401 and no WWW-Authenticate header", async () => {
    const { app } = harness();
    const res = await app(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("rejects a token signed with another secret", async () => {
    const a = harness();
    const { tokens } = await linkWallet(a.app);
    const b = harness({ secret: "a-completely-different-secret-value-xx" });
    const res = await b.app(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("authorization code + PKCE", () => {
  it("links a wallet by signature and issues tokens bound to it", async () => {
    const { app } = harness();
    const { post, location, tokens, wallet: w } = await linkWallet(app);
    expect(post.status).toBe(303);
    expect(location.origin + location.pathname).toBe(`${BASE}/sim/`);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(BASE);
    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: `sol:${w.address}`, wallet: w.address, verified: true, aud: `${BASE}/mcp` });
  });

  it("refuses a wrong code_verifier", async () => {
    const { app } = harness();
    const { code, verifier } = await authorizeWallet(app);
    const res = await exchange(app, { grant_type: "authorization_code", code, redirect_uri: `${BASE}/sim/`, code_verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/PKCE/);
    // The failed attempt consumed the code: a stolen code is worth one guess.
    const retry = await exchange(app, { grant_type: "authorization_code", code, redirect_uri: `${BASE}/sim/`, code_verifier: verifier });
    expect(retry.status).toBe(400);
  });

  it("lets a code be used only once", async () => {
    const { app } = harness();
    const { code, verifier } = await linkWallet(app);
    const again = await exchange(app, { grant_type: "authorization_code", code, redirect_uri: `${BASE}/sim/`, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid_grant");
  });

  it("refuses plain PKCE and a missing challenge", async () => {
    const { app } = harness();
    for (const extra of [{ code_challenge_method: "plain" }, { code_challenge: "" }] as Record<string, string>[]) {
      const res = await app(new Request(authorizeUrl(pkce().challenge, extra)));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("refuses a resource other than this MCP server", async () => {
    const { app } = harness();
    const res = await app(new Request(authorizeUrl(pkce().challenge, { resource: "https://evil.example/mcp" })));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    const { app } = harness();
    const res = await app(new Request(authorizeUrl(pkce().challenge, { redirect_uri: "https://evil.example/cb" })));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a signature from a different wallet", async () => {
    const { app } = harness();
    const { request, cfg } = await openLinkPage(app, pkce().challenge);
    const claimed = wallet();
    const signer = wallet();
    const message = linkMessage({ host: cfg.host, address: claimed.address, nonce: cfg.nonce, issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt, uri: cfg.uri });
    const res = await app(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request, mode: "wallet", address: claimed.address, message, signature: signer.sign(message), issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses a signed message with another nonce (replay from another link attempt)", async () => {
    const { app } = harness();
    const { request, cfg } = await openLinkPage(app, pkce().challenge);
    const w = wallet();
    const message = linkMessage({ host: cfg.host, address: w.address, nonce: "someOtherNonce", issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt, uri: cfg.uri });
    const res = await app(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request, mode: "wallet", address: w.address, message, signature: w.sign(message), issuedAt: cfg.issuedAt, expiresAt: cfg.expiresAt }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rotates refresh tokens: each one works once", async () => {
    const { app } = harness();
    const { tokens } = await linkWallet(app);
    const first = await exchange(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(first.status).toBe(200);
    const next = await first.json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await exchange(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(replay.status).toBe(400);
  });

  it("authenticates a confidential client (Alexa) with HTTP Basic", async () => {
    process.env.ALEXA_CLIENT_ID = "alexa-test";
    process.env.ALEXA_CLIENT_SECRET = "s3cret";
    process.env.ALEXA_REDIRECT_URIS = "https://pitangui.amazon.com/api/skill/link/TEST";
    try {
      const { app } = harness();
      const { verifier, challenge } = pkce();
      const page = await app(new Request(authorizeUrl(challenge, { client_id: "alexa-test", redirect_uri: "https://pitangui.amazon.com/api/skill/link/TEST" })));
      const request = /name="request" value="([^"]+)"/.exec(await page.text())![1];
      const post = await app(
        new Request(`${BASE}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ request, mode: "watch", address: wallet().address }),
        }),
      );
      const code = new URL(post.headers.get("location")!).searchParams.get("code")!;
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://pitangui.amazon.com/api/skill/link/TEST", code_verifier: verifier });
      const wrong = await app(new Request(`${BASE}/token`, { method: "POST", headers: { authorization: `Basic ${btoa("alexa-test:nope")}`, "content-type": "application/x-www-form-urlencoded" }, body }));
      expect(wrong.status).toBe(401);
      const ok = await app(new Request(`${BASE}/token`, { method: "POST", headers: { authorization: `Basic ${btoa("alexa-test:s3cret")}`, "content-type": "application/x-www-form-urlencoded" }, body }));
      expect(ok.status).toBe(200);
      const claims = JSON.parse(Buffer.from((await ok.json()).access_token.split(".")[1], "base64url").toString());
      expect(claims.verified).toBe(false);
    } finally {
      delete process.env.ALEXA_CLIENT_ID;
      delete process.env.ALEXA_CLIENT_SECRET;
      delete process.env.ALEXA_REDIRECT_URIS;
    }
  });
});
