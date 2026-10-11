/**
 * What a push notification says. Written for a lock screen: the news in the
 * title, the detail in one line, times in Eastern because that's the market's
 * clock (until the account sets its own time zone).
 */

import type { Alert } from "../market/alerts.js";
import { isPriceAlert } from "../market/alerts.js";
import { listingByTicker } from "../market/universe.js";
import { capitalise, clockTime, pct, usd } from "../market/speech.js";
import type { Notice } from "./push.js";
import type { TradeIntent } from "../chain/trade.js";
import { EASTERN, type Zone } from "../market/zones.js";

/** "ET" on a lock screen; "London time" elsewhere. */
const short = (zone: Zone) => (zone.label === "Eastern" ? "ET" : `${zone.label} time`);

const signed = (bps: number) => `${bps >= 0 ? "up" : "down"} ${pct(bps)}`;

export function alertNotice(alert: Alert, baseUrl: string, zone: Zone = EASTERN): Notice {
  const name = capitalise(listingByTicker(alert.ticker)?.spoken ?? alert.ticker);
  const at = alert.firedAt ? `${clockTime(alert.firedAt, zone)} ${short(zone)}` : "just now";
  const url = `${baseUrl}/app/#${alert.ticker}`;
  if (isPriceAlert(alert)) {
    const dir = alert.above ? "above" : "below";
    return {
      title: `${name} went ${dir} ${usd(alert.price!)}`,
      body: `The token was at ${usd(alert.firedPrice ?? alert.price!)} at ${at}.`,
      url,
      tag: `alert-${alert.ticker}-price`,
    };
  }
  return {
    title: `${name} is ${signed(alert.firedGapBps ?? 0)}`,
    body: `Your ${pct(alert.thresholdBps)} alert went off at ${at}, against the share's last close.`,
    url,
    tag: `alert-${alert.ticker}-move`,
  };
}

export function triggeredTradeNotice(intent: TradeIntent, baseUrl: string, zone: Zone = EASTERN): Notice {
  const name = capitalise(listingByTicker(intent.ticker)?.spoken ?? intent.ticker);
  const c = intent.condition!;
  return {
    title: `${name} ${c.above ? "rose above" : "dropped below"} ${usd(c.price)}`,
    body: `Your ${usd(intent.usd)} ${intent.side} is ready to sign. Code ${intent.code}, until ${clockTime(intent.expiresAt, zone)} ${short(zone)}.`,
    url: `${baseUrl}/go?code=${intent.code}`,
    tag: `trade-${intent.id}`,
  };
}
