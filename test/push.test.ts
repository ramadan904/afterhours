import { describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import { BASE, harness, linkWallet, mcp, SUNDAY } from "./helpers.js";
import { validSubscription, vapidKeys, type PushSender, type PushSubscription } from "../src/notify/push.js";
import { recordTape, sampleTape, writeTape } from "../src/market/tape.js";

function browserSubscription(host = "fcm.googleapis.com"): PushSubscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${randomBytes(8).toString("hex")}`,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

function fakeSender(gone: string[] = []) {
  const sent: { endpoint: string; notice: { title: string; body: string; url: string } }[] = [];
  const sender: PushSender = {
    async send(s, payload) {
      sent.push({ endpoint: s.endpoint, notice: JSON.parse(payload) });
      return { gone: gone.includes(s.endpoint) };
    },
  };
  return { sender, sent };
}

describe("push subscriptions", () => {
  it("accepts only HTTPS endpoints at browser push services", () => {
    expect(validSubscription(browserSubscription())).toBe(true);
    expect(validSubscription(browserSubscription("updates.push.services.mozilla.com"))).toBe(true);
    expect(validSubscription(browserSubscription("web.push.apple.com"))).toBe(true);
    const bad = (endpoint: string) => validSubscription({ ...browserSubscription(), endpoint });
    expect(bad("http://fcm.googleapis.com/x")).toBe(false);
    expect(bad("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(bad("https://localhost/x")).toBe(false);
    expect(bad("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(bad("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(validSubscription({ endpoint: "https://fcm.googleapis.com/x" })).toBe(false);
  });

  it("needs a linked account, and stores up to five devices", async () => {
    const h = harness();
    const post = (path: string, body: unknown, token?: string) =>
      h.app(new Request(`${BASE}${path}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
    expect((await post("/api/push/subscribe", { subscription: browserSubscription() })).status).toBe(401);
    const { tokens } = await linkWallet(h.app);
    expect((await post("/api/push/subscribe", { subscription: { endpoint: "https://evil.example/x", keys: { p256dh: "a", auth: "b" } } }, tokens.access_token)).status).toBe(400);
    let devices = 0;
    for (let i = 0; i < 7; i += 1) devices = (await (await post("/api/push/subscribe", { subscription: browserSubscription() }, tokens.access_token)).json()).devices;
    expect(devices).toBe(5);
  });
});

describe("alerts reach the phone when they fire", () => {
  it("pushes a fired alert to the account's devices, and drops dead ones", async () => {
    const phone = browserSubscription();
    const oldLaptop = browserSubscription();
    const { sender, sent } = fakeSender([oldLaptop.endpoint]);
    const h = harness({ push: sender });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    for (const s of [phone, oldLaptop]) {
      await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: s }) }));
    }
    await session.call("set_alert", { stock: "Tesla", percent: 2 });
    await session.call("set_alert", { stock: "Nvidia", price: 210 });

    await recordTape(h.svc);
    const titles = sent.map((s) => s.notice.title).sort();
    expect(titles).toEqual(["Tesla is up 2.1 percent", "Tesla is up 2.1 percent"]);
    expect(sent[0].notice.body).toBe("Your 2.0 percent alert went off at 11:00 a.m. ET, against the share's last close.");
    expect(sent[0].notice.url).toBe(`${BASE}/app/#TSLA`);

    // The dead laptop was pruned: the next alert only goes to the phone.
    sent.length = 0;
    await session.call("set_alert", { stock: "Coinbase", percent: 3 });
    h.svc.now = () => SUNDAY + 10 * 60_000;
    await recordTape(h.svc);
    expect(sent.map((s) => s.endpoint)).toEqual([phone.endpoint]);
    expect(sent[0].notice.title).toBe("Coinbase is up 3.9 percent");
  });

  it("never lets a failing push service stop the tape", async () => {
    const h = harness({ push: { send: async () => { throw new Error("push service down"); } } });
    const { tokens } = await linkWallet(h.app);
    const session = await mcp(h, tokens.access_token);
    await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription: browserSubscription() }) }));
    await session.call("set_alert", { stock: "Tesla", percent: 2 });
    expect(await recordTape(h.svc)).toMatchObject({ recorded: true, fired: 1 });
  });
});

describe("web push plumbing", () => {
  it("keeps one VAPID key pair per deployment and builds a valid encrypted request with it", async () => {
    const h = harness();
    const a = await vapidKeys(h.svc);
    expect(await vapidKeys(h.svc)).toEqual(a);
    const key = await (await h.app(new Request(`${BASE}/api/push/key`))).json();
    expect(key.publicKey).toBe(a.publicKey);

    const details = webpush.generateRequestDetails(browserSubscription(), JSON.stringify({ title: "t" }), {
      vapidDetails: { subject: "mailto:afterhours@example.com", publicKey: a.publicKey, privateKey: a.privateKey },
      TTL: 60,
    });
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=.+/);
  });

  it("serves the night's tape for a chart", async () => {
    const h = harness();
    await writeTape(h.svc.store, sampleTape(SUNDAY));
    const tape = await (await h.app(new Request(`${BASE}/api/tape?ticker=coinbase`))).json();
    expect(tape.ticker).toBe("COIN");
    expect(tape.points.length).toBeGreaterThan(100);
    expect(tape.points.at(-1).gapPercent).toBe(3.88);
  });
});
