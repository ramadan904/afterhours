/**
 * QR codes rendered on the server, as SVG.
 *
 * Only paths on this site are encoded (the confirm page, mostly), so the
 * endpoint can't be used to mint QR codes pointing anywhere else.
 */

import qrcode from "qrcode-generator";
import type { Services } from "../services.js";

export function qrSvg(svc: Services, url: URL): Response {
  const path = url.searchParams.get("path") ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 200) {
    return new Response("Only paths on this site", { status: 400 });
  }
  const qr = qrcode(0, "M");
  qr.addData(svc.baseUrl + path);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
  });
}
