/**
 * Text messages, for phones that can't get web push.
 *
 * Web push needs a browser that supports it and, on an iPhone, the app added
 * to the Home Screen. A text message needs neither. A person adds their number
 * in the companion app, proves it with a six-digit code, and from then on
 * every notice (an alert at 2 a.m., a trade ready to sign, a wallet warning)
 * is also sent by SMS through Amazon SNS, as a transactional message.
 *
 * Codes are stored hashed, expire in 10 minutes, allow five tries, and at
 * most three are sent an hour. Numbers must be E.164 ("+2348012345678").
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Services } from "../services.js";

export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const otpKey = (sub: string) => `smsotp:${sub}`;
const sentKey = (sub: string) => `smssent:${sub}`;
export const smsKey = (sub: string) => `sms:${sub}`;
const CODE_TTL_S = 600;
const MAX_TRIES = 5;
const MAX_PER_HOUR = 3;

let configured: SmsSender | null | undefined;

/** The SNS sender when SMS=on; tests pass `svc.sms`. */
export async function smsSender(svc: Services): Promise<SmsSender | null> {
  if (svc.sms) return svc.sms;
  if (configured !== undefined) return configured;
  if (process.env.SMS !== "on") return (configured = null);
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const client = new SNSClient({});
  configured = {
    async send(phone, message) {
      await client.send(
        new PublishCommand({
          PhoneNumber: phone,
          Message: message,
          MessageAttributes: {
            "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
            "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "Afterhours" },
          },
        }),
      );
    },
  };
  return configured;
}

export function normalisePhone(said: string): string | null {
  const p = said.replace(/[\s().-]/g, "").replace(/^00/, "+");
  return E164.test(p) ? p : null;
}

const hash = (svc: Services, code: string) => createHmac("sha256", svc.secret).update(`sms:${code}`).digest();

export async function startVerification(svc: Services, sub: string, phoneSaid: string): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const sender = await smsSender(svc);
  if (!sender) return { ok: false, error: "Text messages aren't set up on this server." };
  const phone = normalisePhone(phoneSaid);
  if (!phone) return { ok: false, error: "Enter the number with its country code, like +1 415 555 0100." };
  const sent = (await svc.store.get<number[]>(sentKey(sub))) ?? [];
  const recent = sent.filter((t) => svc.now() - t < 3600_000);
  if (recent.length >= MAX_PER_HOUR) return { ok: false, error: "That's three codes this hour. Try again later." };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await svc.store.set(otpKey(sub), { phone, hash: hash(svc, code).toString("base64"), tries: 0, expiresAt: svc.now() + CODE_TTL_S * 1000 }, CODE_TTL_S);
  await svc.store.set(sentKey(sub), [...recent, svc.now()], 3600);
  await sender.send(phone, `Afterhours code: ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this.`);
  return { ok: true, phone };
}

export async function verifyCode(svc: Services, sub: string, code: string): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const pending = await svc.store.get<{ phone: string; hash: string; tries: number; expiresAt?: number }>(otpKey(sub));
  if (!pending || (pending.expiresAt && pending.expiresAt <= svc.now())) return { ok: false, error: "That code has expired. Ask for a new one." };
  const given = hash(svc, code.replace(/\D/g, ""));
  const want = Buffer.from(pending.hash, "base64");
  if (given.length === want.length && timingSafeEqual(given, want)) {
    await svc.store.del(otpKey(sub));
    await svc.store.set(smsKey(sub), { phone: pending.phone, verifiedAt: svc.now() });
    return { ok: true, phone: pending.phone };
  }
  if (pending.tries + 1 >= MAX_TRIES) {
    await svc.store.del(otpKey(sub));
    return { ok: false, error: "Too many wrong codes. Ask for a new one." };
  }
  // A wrong try keeps the code's original expiry; it doesn't buy more time.
  const left = Math.max(1, Math.ceil(((pending.expiresAt ?? svc.now() + CODE_TTL_S * 1000) - svc.now()) / 1000));
  await svc.store.set(otpKey(sub), { ...pending, tries: pending.tries + 1 }, left);
  return { ok: false, error: "That code isn't right." };
}

export async function smsNumber(svc: Services, sub: string): Promise<string | null> {
  return (await svc.store.get<{ phone: string }>(smsKey(sub)))?.phone ?? null;
}

export async function stopSms(svc: Services, sub: string): Promise<void> {
  await svc.store.del(smsKey(sub));
}

/** "+14155550100" → "+1 •••• 0100", for showing which number is on file. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, phone.length - 10 > 0 ? phone.length - 10 : 2)} •••• ${phone.slice(-4)}`;
}
