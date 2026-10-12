/**
 * QR codes rendered on the server, as SVG.
 *
 * Only paths on this site (the confirm page, mostly) and Solana Pay requests
 * for this site's trade actions are encoded, so the endpoint can't be used to
 * mint QR codes pointing anywhere else.
 */

import qrcode from "qrcode-generator";
import type { Services } from "../services.js";

export function qrSvg(svc: Services, url: URL): Response {
  const pay = url.searchParams.get("pay");
  const path = url.searchParams.get("path") ?? "/";
  let data: string;
  if (pay !== null) {
    // A Solana Pay transaction request for a trade's action: a phone wallet
    // scans it, fetches the transaction, and signs it there.
    if (!/^\d{6}$/.test(pay)) return new Response("Not a trade code", { status: 400 });
    data = `solana:${encodeURIComponent(`${svc.baseUrl}/api/actions/trade/${pay}`)}`;
  } else {
    if (!path.startsWith("/") || path.startsWith("//") || path.length > 200) {
      return new Response("Only paths on this site", { status: 400 });
    }
    data = svc.baseUrl + path;
  }
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
  });
}
