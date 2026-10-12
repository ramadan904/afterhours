import { describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { BASE, SUNDAY, harness, linkWallet, mcp } from "./helpers.js";
import { recordTape } from "../src/market/tape.js";
import type { PushSender } from "../src/notify/push.js";

async function setup() {
  const sent: { title: string; body: string; url: string }[] = [];
  const push: PushSender = { send: async (_s, payload) => (sent.push(JSON.parse(payload)), { gone: false }) };
  const h = harness({ push });
  const { tokens } = await linkWallet(h.app);
  const session = await mcp(h, tokens.access_token);
  const subscribe = async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
    await h.app(new Request(`${BASE}/api/push/subscribe`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ subscription }) }));
  };
  /** Moves Tesla's token on the cached board, as the market would. */
  const tesla = async (price: number) => {
    const board = await h.svc.prices.read();
    board.quotes.get("TSLA")!.tokenPrice = price;
  };
  return { h, session, sent, subscribe, tesla };
}

describe("conditional trades", () => {
  it("arms by voice, triggers on the tape, notifies the phone, and waits for a signature", async () => {
    const { h, session, sent, subscribe, tesla } = await setup();
    await subscribe();
    const armed = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 50, trigger_price: 360 });
    expect(armed.text).toBe(
      "Using sample data. OK. When Tesla's token drops below $360, I'll get a $50 buy ready. It's at $370.56 now. I'll prepare it then and send a notification to your phone to sign it. Nothing happens without your signature.",
    );
    expect(armed.structured).toMatchObject({ status: "armed", code: "", triggerPrice: 360, triggerDirection: "below" });
    expect((await session.call("trade_status", {})).text).toBe("Your $50 buy of Tesla is set for when its token drops below $360.");

    // Not crossed yet: nothing happens.
    await recordTape(h.svc);
    expect(sent).toHaveLength(0);

    // Overnight, Tesla's token falls through $360.
    await tesla(358.4);
    h.svc.now = () => SUNDAY + 10 * 60_000;
    const tape = await recordTape(h.svc);
    expect(tape.triggered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Tesla dropped below $360");
    expect(sent[0].body).toMatch(/^Your \$50 buy is ready to sign\. Code \d{6}, until 12:10 p\.m\. ET\.$/);
    const code = /Code (\d{6})/.exec(sent[0].body)![1];
    expect(sent[0].url).toBe(`${BASE}/go?code=${code}`);

    // It's now an ordinary proposal: the confirm page finds it, priced at the trigger.
    const view = await (await h.app(new Request(`${BASE}/api/trade?code=${code}`))).json();
    expect(view).toMatchObject({ status: "awaiting_signature", usd: 50, priceAtProposal: 358.4 });

    // Alexa leads the next briefing with it.
    const brief = await session.call("overnight_brief", {});
    expect(brief.text).toContain(
      `Your $50 buy of Tesla triggered at 11:10 a.m. Eastern, when the token dropped below $360. It's waiting for your signature: the code is ${code.split("").join(" ")}.`,
    );
    // It triggers once.
    h.svc.now = () => SUNDAY + 20 * 60_000;
    expect((await recordTape(h.svc)).triggered).toBe(0);
  });

  it("tells people without notifications where to turn them on, and can be cancelled", async () => {
    const { h, session, sent, tesla } = await setup();
    const armed = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 50, trigger_price: 400 });
    expect(armed.text).toContain("rises above $400");
    expect(armed.text).toContain("Turn on notifications in the Afterhours app");
    const cancelled = await session.call("cancel_trade", {});
    expect(cancelled.text).toBe("Your $50 buy of Tesla was cancelled, so nothing happened.");
    await tesla(401);
    expect((await recordTape(h.svc)).triggered).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await session.call("cancel_trade", {})).isError).toBe(true);
  });

  it("limits how many can wait, and expires them after a week", async () => {
    const { h, session, tesla } = await setup();
    for (let i = 0; i < 5; i += 1) await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10, trigger_price: 300 + i });
    const sixth = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10, trigger_price: 290 });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toContain("up to 5 waiting trades");

    h.svc.now = () => SUNDAY + 8 * 86_400_000;
    await tesla(250);
    expect((await recordTape(h.svc)).triggered).toBe(0);
    // Expiry is saved, so it reads as expired from then on. (The clock goes
    // back only because the test's access token lasts an hour.)
    h.svc.now = () => SUNDAY;
    expect((await session.call("trade_status", {})).text).toContain("expired before its price was reached");
  });

  it("treats a trigger at today's price as an ordinary proposal", async () => {
    const { session } = await setup();
    const now = await session.call("propose_trade", { stock: "Tesla", side: "buy", amount_usd: 10, trigger_price: 370.6 });
    expect((now.structured as { status: string }).status).toBe("awaiting_signature");
  });
});
