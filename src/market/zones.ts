/**
 * Whose clock a time is spoken in.
 *
 * The market runs on New York time, but most people holding tokenized stocks
 * don't live there. "It opens at 9:30 a.m. Eastern" makes a listener in Lagos
 * do arithmetic; "It opens at 2:30 p.m. Lagos time" doesn't. An account can
 * set its place once ("I'm in London"), and every time Afterhours speaks or
 * sends is then in that zone. The default stays Eastern, the market's own.
 */

export interface Zone {
  /** IANA time zone, e.g. `Europe/London`. */
  tz: string;
  /** How the zone is said: "Eastern", or the place the person named. */
  label: string;
}

export const EASTERN: Zone = { tz: "America/New_York", label: "Eastern" };

/** Places people say, lowercased, to IANA zones. Cities first; countries for one-zone countries. */
const PLACES: Record<string, string> = {
  "new york": "America/New_York", nyc: "America/New_York", boston: "America/New_York", miami: "America/New_York", atlanta: "America/New_York", toronto: "America/Toronto", "washington": "America/New_York", eastern: "America/New_York",
  chicago: "America/Chicago", dallas: "America/Chicago", houston: "America/Chicago", austin: "America/Chicago", central: "America/Chicago",
  denver: "America/Denver", phoenix: "America/Phoenix", mountain: "America/Denver",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", seattle: "America/Los_Angeles", vancouver: "America/Vancouver", pacific: "America/Los_Angeles",
  "mexico city": "America/Mexico_City", mexico: "America/Mexico_City", "sao paulo": "America/Sao_Paulo", "são paulo": "America/Sao_Paulo", brazil: "America/Sao_Paulo",
  "buenos aires": "America/Argentina/Buenos_Aires", argentina: "America/Argentina/Buenos_Aires", bogota: "America/Bogota", colombia: "America/Bogota", lima: "America/Lima", peru: "America/Lima",
  london: "Europe/London", uk: "Europe/London", "united kingdom": "Europe/London", england: "Europe/London", dublin: "Europe/Dublin", ireland: "Europe/Dublin", lisbon: "Europe/Lisbon", portugal: "Europe/Lisbon",
  paris: "Europe/Paris", france: "Europe/Paris", berlin: "Europe/Berlin", germany: "Europe/Berlin", madrid: "Europe/Madrid", spain: "Europe/Madrid", rome: "Europe/Rome", italy: "Europe/Rome",
  amsterdam: "Europe/Amsterdam", netherlands: "Europe/Amsterdam", zurich: "Europe/Zurich", switzerland: "Europe/Zurich", stockholm: "Europe/Stockholm", warsaw: "Europe/Warsaw", poland: "Europe/Warsaw",
  athens: "Europe/Athens", greece: "Europe/Athens", istanbul: "Europe/Istanbul", turkey: "Europe/Istanbul", kyiv: "Europe/Kyiv", ukraine: "Europe/Kyiv",
  lagos: "Africa/Lagos", abuja: "Africa/Lagos", nigeria: "Africa/Lagos", accra: "Africa/Accra", ghana: "Africa/Accra", nairobi: "Africa/Nairobi", kenya: "Africa/Nairobi",
  johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg", "south africa": "Africa/Johannesburg", cairo: "Africa/Cairo", egypt: "Africa/Cairo", casablanca: "Africa/Casablanca", morocco: "Africa/Casablanca",
  dubai: "Asia/Dubai", uae: "Asia/Dubai", "abu dhabi": "Asia/Dubai", riyadh: "Asia/Riyadh", "saudi arabia": "Asia/Riyadh", "tel aviv": "Asia/Jerusalem", israel: "Asia/Jerusalem",
  karachi: "Asia/Karachi", pakistan: "Asia/Karachi", mumbai: "Asia/Kolkata", delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", bangalore: "Asia/Kolkata", bengaluru: "Asia/Kolkata", india: "Asia/Kolkata",
  dhaka: "Asia/Dhaka", bangladesh: "Asia/Dhaka", bangkok: "Asia/Bangkok", thailand: "Asia/Bangkok", jakarta: "Asia/Jakarta", indonesia: "Asia/Jakarta", "ho chi minh city": "Asia/Ho_Chi_Minh", vietnam: "Asia/Ho_Chi_Minh",
  singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur", malaysia: "Asia/Kuala_Lumpur", manila: "Asia/Manila", philippines: "Asia/Manila",
  "hong kong": "Asia/Hong_Kong", shanghai: "Asia/Shanghai", beijing: "Asia/Shanghai", china: "Asia/Shanghai", taipei: "Asia/Taipei", taiwan: "Asia/Taipei",
  seoul: "Asia/Seoul", korea: "Asia/Seoul", "south korea": "Asia/Seoul", tokyo: "Asia/Tokyo", japan: "Asia/Tokyo",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", perth: "Australia/Perth", auckland: "Pacific/Auckland", "new zealand": "Pacific/Auckland",
};

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/**
 * "London", "I'm in Lagos", "Asia/Tokyo", "india" → a Zone, or null.
 * The label is the place as said (title-cased), so it's spoken back the way
 * the person thinks of it.
 */
export function resolveZone(said: string): Zone | null {
  const raw = said.trim();
  if (raw.includes("/") && isTimeZone(raw)) return { tz: raw, label: titleCase(raw.split("/").at(-1)!.replace(/_/g, " ")) };
  const place = raw
    .toLowerCase()
    .replace(/^(i'?m|i am|i live|we're|we are)\s+(in|at|from)\s+/, "")
    .replace(/^(in|at)\s+/, "")
    .replace(/\s+time$/, "")
    .replace(/[.!?]+$/, "")
    .trim();
  const tz = PLACES[place];
  if (!tz) return null;
  const label = tz === EASTERN.tz && ["eastern", "new york", "nyc"].includes(place) ? "Eastern" : place.length <= 3 ? place.toUpperCase() : titleCase(place);
  return { tz, label };
}

/** "Eastern" stays "Eastern"; anything else is "<place> time". */
export function zoneName(zone: Zone): string {
  return zone.label === "Eastern" ? "Eastern" : `${zone.label} time`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date, weekday and minutes in a zone. */
export function zoneParts(at: Date, tz: string): { date: string; weekday: number; minutes: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))),
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

const key = (sub: string) => `prefs:${sub}`;

export async function getZone(store: { get<T>(k: string): Promise<T | null> }, sub: string): Promise<Zone> {
  return (await store.get<{ zone?: Zone }>(key(sub)))?.zone ?? EASTERN;
}

export async function setZone(store: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> }, sub: string, zone: Zone): Promise<void> {
  const prefs = (await store.get<Record<string, unknown>>(key(sub))) ?? {};
  await store.set(key(sub), { ...prefs, zone });
}
