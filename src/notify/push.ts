/**
 * Push notifications: the one thing a voice assistant can't do.
 *
 * Alexa only speaks when spoken to, so an alert that fires at 2 a.m. would
 * otherwise wait for the morning briefing. Afterhours also delivers it as a
 * standard Web Push notification to any browser or installed app (the `/app`
 * PWA) the account has enabled, at the moment the tape sees it fire.
 *
 * Subscriptions are URLs the user's browser hands us, and the server POSTs to
 * them later, so they're accepted only on HTTPS at a known push service.
 * Anything else (an internal address, say) is refused at subscribe time.
 */

import webpush from "web-push";
import type { Services } from "../services.js";

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Notice {
  title: string;
  body: string;
  /** Opened when the notification is tapped. */
  url: string;
  /** Replaces an earlier notification with the same tag rather than stacking. */
  tag?: string;
}

export interface PushSender {
  /** Delivers one payload. `gone` means the subscription is dead and should be dropped. */
  send(subscription: PushSubscription, payload: string): Promise<{ gone: boolean }>;
}

export const MAX_SUBSCRIPTIONS = 5;

/** Push services run by the browser vendors. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];

export function validSubscription(value: unknown): value is PushSubscription {
  const s = value as PushSubscription | undefined;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 1000) return false;
  if (typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return false;
  if (s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return false;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * VAPID keys: from the environment if set, otherwise generated once and kept
 * in the store, so they survive restarts wherever the store does (DynamoDB,
 * Redis). Changing keys would silently orphan every subscription.
 */
export async function vapidKeys(svc: Services): Promise<VapidKeys> {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const stored = await svc.store.get<VapidKeys>("vapid:keys");
  if (stored) return stored;
  const fresh = webpush.generateVAPIDKeys();
  if (await svc.store.setNew("vapid:keys", fresh)) return fresh;
  return (await svc.store.get<VapidKeys>("vapid:keys"))!;
}

/** The real sender, signing with this deployment's VAPID keys. */
export function webPushSender(svc: Services): PushSender {
  return {
    async send(subscription, payload) {
      const keys = await vapidKeys(svc);
      const subject = svc.baseUrl.startsWith("https://") ? svc.baseUrl : "mailto:afterhours@example.com";
      try {
        await webpush.sendNotification(subscription, payload, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 3600,
          urgency: "high",
          timeout: 5000,
        });
        return { gone: false };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return { gone: true };
        throw err;
      }
    },
  };
}

const key = (sub: string) => `push:${sub}`;
const PUSH_INDEX = "push:index";

export async function listSubscriptions(svc: Services, sub: string): Promise<PushSubscription[]> {
  return (await svc.store.get<PushSubscription[]>(key(sub))) ?? [];
}

export async function addSubscription(svc: Services, sub: string, subscription: PushSubscription): Promise<number> {
  const current = (await listSubscriptions(svc, sub)).filter((s) => s.endpoint !== subscription.endpoint);
  const next = [...current, subscription].slice(-MAX_SUBSCRIPTIONS);
  await svc.store.set(key(sub), next);
  const index = (await svc.store.get<string[]>(PUSH_INDEX)) ?? [];
  if (!index.includes(sub)) await svc.store.set(PUSH_INDEX, [...index, sub].slice(-5000));
  return next.length;
}

/** Every account that has turned notifications on at some point (devices may since be gone). */
export async function pushAccounts(svc: Services): Promise<string[]> {
  return (await svc.store.get<string[]>(PUSH_INDEX)) ?? [];
}

export async function removeSubscription(svc: Services, sub: string, endpoint: string): Promise<void> {
  const current = await listSubscriptions(svc, sub);
  await svc.store.set(key(sub), current.filter((s) => s.endpoint !== endpoint));
}

/**
 * Sends a notice to every device the account enabled. Dead subscriptions are
 * dropped; a failing push service never fails the caller. Returns how many
 * deliveries succeeded.
 */
export async function notify(svc: Services, sub: string, notice: Notice): Promise<number> {
  const subscriptions = await listSubscriptions(svc, sub);
  if (subscriptions.length === 0) return 0;
  const sender = svc.push ?? webPushSender(svc);
  const payload = JSON.stringify(notice);
  let delivered = 0;
  const dead: string[] = [];
  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        const { gone } = await sender.send(s, payload);
        if (gone) dead.push(s.endpoint);
        else delivered += 1;
      } catch (err) {
        console.error("push:", (err as Error).message);
      }
    }),
  );
  if (dead.length) await svc.store.set(key(sub), subscriptions.filter((s) => !dead.includes(s.endpoint)));
  return delivered;
}
