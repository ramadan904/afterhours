import { describe, expect, it } from "vitest";
import { BASE, harness, linkWallet } from "./helpers.js";
import { maskPhone, normalisePhone } from "../src/notify/sms.js";
import { notify } from "../src/notify/push.js";
import type { SmsSender } from "../src/notify/sms.js";

function setup() {
  const texts: { phone: string; message: string }[] = [];
  const sms: SmsSender = { async send(phone, message) { texts.push({ phone, message }); } };
  const h = harness({ sms });
  return { h, texts };
}

async function linked(h: ReturnType<typeof harness>) {
  const { tokens } = await linkWallet(h.app);
  const sub = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()).sub as string;
  const call = async (path: string, body?: unknown) =>
    h.app(new Request(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { sub, call };
}

describe("phone numbers", () => {
  it("accepts E.164 however it's typed, and masks it for display", () => {
    expect(normalisePhone("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalisePhone("00234 801 234 5678")).toBe("+2348012345678");
    expect(normalisePhone("415 555 0100")).toBeNull();
    expect(maskPhone("+14155550100")).toBe("+1 •••• 0100");
    expect(maskPhone("+2348012345678")).toBe("+234 •••• 5678");
  });
});

describe("text alerts", () => {
  it("verifies a number with a code, then sends every notice by text too", async () => {
    const { h, texts } = setup();
    const { sub, call } = await linked(h);
    expect(await (await call("/api/sms")).json()).toEqual({ available: true, phone: null });
    expect((await call("/api/sms/start", { phone: "415 555 0100" })).status).toBe(400);
    expect(await (await call("/api/sms/start", { phone: "+1 415 555 0100" })).json()).toEqual({ ok: true, phone: "+1 •••• 0100" });
    const code = /code: (\d{6})/.exec(texts[0].message)![1];
    expect(texts[0].phone).toBe("+14155550100");
    expect((await call("/api/sms/verify", { code: "000000" === code ? "111111" : "000000" })).status).toBe(400);
    expect(await (await call("/api/sms/verify", { code })).json()).toEqual({ ok: true, phone: "+1 •••• 0100" });

    // No push device at all: the text still goes.
    const delivered = await notify(h.svc, sub, { title: "Tesla went above $400", body: "The token was at $401.20 at 2:14 a.m. ET.", url: `${BASE}/app/#TSLA`, tag: "t" });
    expect(delivered).toBe(1);
    expect(texts.at(-1)).toEqual({ phone: "+14155550100", message: `Tesla went above $400. The token was at $401.20 at 2:14 a.m. ET. ${BASE}/app/#TSLA` });

    await call("/api/sms/stop", {});
    expect(await notify(h.svc, sub, { title: "x", body: "y", url: "z" })).toBe(0);
  });

  it("limits codes: five tries each, three an hour", async () => {
    const { h, texts } = setup();
    const { call } = await linked(h);
    await call("/api/sms/start", { phone: "+14155550100" });
    const code = /code: (\d{6})/.exec(texts[0].message)![1];
    const wrong = code === "999999" ? "888888" : "999999";
    for (let i = 0; i < 4; i += 1) expect((await (await call("/api/sms/verify", { code: wrong })).json()).error).toBe("That code isn't right.");
    expect((await (await call("/api/sms/verify", { code: wrong })).json()).error).toBe("Too many wrong codes. Ask for a new one.");
    expect((await (await call("/api/sms/verify", { code })).json()).error).toBe("That code has expired. Ask for a new one.");
    await call("/api/sms/start", { phone: "+14155550100" });
    await call("/api/sms/start", { phone: "+14155550100" });
    expect((await (await call("/api/sms/start", { phone: "+14155550100" })).json()).error).toBe("That's three codes this hour. Try again later.");
  });

  it("says when the server has no SMS", async () => {
    const h = harness();
    const { call } = await linked(h);
    expect(await (await call("/api/sms")).json()).toEqual({ available: false, phone: null });
    expect((await (await call("/api/sms/start", { phone: "+14155550100" })).json()).error).toBe("Text messages aren't set up on this server.");
  });
});
