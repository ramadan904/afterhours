/**
 * What makes /app an installable app: a manifest, icons, and a service worker
 * whose main job is showing push notifications and opening the app when one
 * is tapped.
 */

import type { Services } from "../services.js";
import { icon192, icon512, maskable512 } from "./icons.js";

const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Afterhours", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Afterhours", {
    body: d.body || "", tag: d.tag, renotify: Boolean(d.tag),
    icon: "/icons/192.png", badge: "/icons/192.png", data: { url: d.url || "/app/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const wanted = (e.notification.data && e.notification.data.url) || "/app/";
  // Only ever open this site.
  const url = new URL(wanted, self.location.origin);
  const target = url.origin === self.location.origin ? url.href : self.location.origin + "/app/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const w of windows) if (w.url.startsWith(self.location.origin + "/app")) return w.navigate(target).then((c) => (c || w).focus());
    return self.clients.openWindow(target);
  }));
});
`;

export function serviceWorker(): Response {
  return new Response(SW, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" },
  });
}

export function manifest(svc: Services): Response {
  const body = {
    name: "Afterhours",
    short_name: "Afterhours",
    description: "Your tokenized stocks at any hour: overnight moves, alerts that wake you, trades your wallet signs.",
    start_url: "/app/",
    scope: "/",
    id: `${svc.baseUrl}/app/`,
    display: "standalone",
    background_color: "#0b1020",
    theme_color: "#0b1020",
    icons: [
      { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
}

const ICONS: Record<string, string> = { "/icons/192.png": icon192, "/icons/512.png": icon512, "/icons/maskable-512.png": maskable512 };

export function icon(path: string): Response | null {
  const b64 = ICONS[path];
  if (!b64) return null;
  return new Response(Buffer.from(b64, "base64"), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}
