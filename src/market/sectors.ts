/**
 * Groups of names, for "how's tech doing tonight?" and "tell me if chip
 * stocks move 2 percent".
 *
 * With 68 names, one stock at a time is too narrow and the whole market too
 * broad. A sector's move is the equal-weighted average of its members' gaps
 * against their shares (the same number the briefing uses per stock), so a
 * sector reading is simply another reading: it can be ranked, spoken, and
 * watched by an alert, under the ticker `sector:<id>`.
 */

import type { GapReading } from "./gap.js";
import { listingByTicker } from "./universe.js";

export interface Sector {
  id: string;
  /** As spoken: "chip stocks". */
  spoken: string;
  members: string[];
  aliases: string[];
}

export const SECTORS: Sector[] = [
  { id: "chips", spoken: "chip stocks", members: ["NVDA", "AMD", "AVGO", "INTC", "MRVL", "MU", "TSM", "ASML", "ARM", "SMCI"], aliases: ["chips", "chip stocks", "semiconductors", "semis", "chipmakers"] },
  { id: "software", spoken: "software and cloud", members: ["MSFT", "ORCL", "CRM", "CSCO", "IBM", "ACN", "PLTR", "CRWD", "APP", "SHOP", "AAPL"], aliases: ["software", "cloud", "software stocks", "enterprise tech"] },
  { id: "internet", spoken: "internet and media", members: ["META", "GOOGL", "AMZN", "NFLX", "DIS", "CMCSA", "UBER", "BABA"], aliases: ["internet", "media", "internet stocks", "streaming", "social media"] },
  { id: "consumer", spoken: "consumer names", members: ["TSLA", "HD", "MCD", "NKE", "SBUX", "WMT", "KO", "PEP", "PG", "GME"], aliases: ["consumer", "consumer stocks", "retail", "retailers"] },
  { id: "financials", spoken: "banks and payments", members: ["JPM", "BAC", "GS", "V"], aliases: ["banks", "financials", "bank stocks", "payments", "finance"] },
  { id: "crypto", spoken: "crypto stocks", members: ["COIN", "MSTR", "CRCL"], aliases: ["crypto", "crypto stocks", "bitcoin stocks", "crypto names"] },
  { id: "health", spoken: "healthcare", members: ["LLY", "NVO", "UNH", "JNJ", "MRK", "PFE", "ABBV", "ABT", "AZN", "TMO", "DHR", "MDT"], aliases: ["healthcare", "health care", "pharma", "drug stocks", "biotech", "health"] },
  { id: "energy", spoken: "energy and industrials", members: ["XOM", "CVX", "LIN", "HON"], aliases: ["energy", "oil", "oil stocks", "industrials"] },
  { id: "funds", spoken: "index funds", members: ["SPY", "QQQ", "VTI", "IWM", "TQQQ", "GLD"], aliases: ["index funds", "etfs", "funds", "the indexes"] },
];

/** "Tech" is a family of sectors, the way people use the word. */
const FAMILIES: Record<string, string[]> = {
  tech: ["chips", "software", "internet"],
  "big tech": ["software", "internet"],
};

export function sectorById(id: string): Sector | undefined {
  if (FAMILIES[id]) {
    const parts = FAMILIES[id].map((p) => SECTORS.find((s) => s.id === p)!);
    return { id, spoken: id === "tech" ? "tech" : "big tech", members: [...new Set(parts.flatMap((p) => p.members))], aliases: [id] };
  }
  return SECTORS.find((s) => s.id === id);
}

/** "tech", "the chip stocks", "Pharma" → a sector; null when it isn't one. */
export function resolveSector(said: string): Sector | null {
  const t = said.toLowerCase().replace(/[?.!]+$/, "").replace(/^(the|my)\s+/, "").replace(/\s+(sector|names|space)$/, "").trim();
  if (t === "big tech") return sectorById("big tech")!;
  if (t === "tech" || t === "tech stocks" || t === "technology") return sectorById("tech")!;
  return SECTORS.find((s) => s.id === t || s.aliases.includes(t) || s.aliases.includes(t.replace(/ stocks$/, ""))) ?? null;
}

export const SECTOR_PREFIX = "sector:";
export const isSectorTicker = (t: string) => t.startsWith(SECTOR_PREFIX);

/** Spoken name for a stock ticker or a `sector:` ticker. */
export function nameFor(ticker: string): string {
  if (isSectorTicker(ticker)) return sectorById(ticker.slice(SECTOR_PREFIX.length))?.spoken ?? ticker;
  return listingByTicker(ticker)?.spoken ?? ticker;
}

/** One reading per sector: the equal-weighted average gap of the members that have one. */
export function sectorReadings(readings: GapReading[], sectors: Sector[] = [...SECTORS, sectorById("tech")!]): GapReading[] {
  return sectors.flatMap((s) => {
    const members = readings.filter((r) => s.members.includes(r.ticker) && r.gapBps !== null && (r.kind === "overnight_move" || r.kind === "live_gap" || r.kind === "in_line"));
    if (members.length < 2) return [];
    const avg = members.reduce((t, r) => t + r.gapBps!, 0) / members.length;
    const first = members[0];
    const kind = members.some((m) => m.kind === "live_gap") ? "live_gap" : Math.abs(avg) < 20 ? "in_line" : "overnight_move";
    return [{ ...first, ticker: `${SECTOR_PREFIX}${s.id}`, token: s.spoken, spoken: s.spoken, tokenPrice: 0, sharePrice: null, gapBps: Math.round(avg * 10) / 10, kind } as GapReading];
  });
}
