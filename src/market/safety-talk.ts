/**
 * The token safety answer, written to be heard.
 *
 * Plain about what the issuer can do, plain that this is normal for a
 * regulated tokenized stock, and honest about the half the chain can't show:
 * whether real shares sit behind the tokens.
 */

import type { Listing } from "./universe.js";
import { describeRescale, multiplierAt, type MintFacts } from "../chain/mint-facts.js";
import { capitalise, usd } from "./speech.js";
import { spokenDate } from "./calendar-talk.js";
import { zoneParts, type Zone } from "./zones.js";

/** "$9.3 million" rather than "$9,264,000", which nobody says aloud. */
function bigUsd(n: number): string {
  if (n >= 1e9) return `$${Math.round(n / 1e8) / 10} billion`;
  if (n >= 1e6) return `$${Math.round(n / 1e5) / 10} million`;
  return usd(Math.round(n));
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What the issuer can do, as spoken phrases. */
export function issuerPowers(f: MintFacts): string[] {
  const powers: string[] = [];
  if (f.mintAuthority) powers.push("issue new tokens");
  if (f.freezeAuthority) powers.push("freeze any holder's tokens");
  if (f.permanentDelegate) powers.push("move or burn tokens in any wallet");
  if (f.pausable) powers.push("pause all transfers");
  if (f.scaledUiAmount) powers.push("rescale every balance for splits and dividends");
  if (f.transferHook) powers.push("run its own program on every transfer");
  if (f.transferFeeBps !== null) powers.push(f.transferFeeBps > 0 ? `take ${f.transferFeeBps / 100} percent of every transfer` : "add a fee to transfers");
  if (f.closeAuthority) powers.push("close the token entirely");
  return powers;
}

/** "On Thursday, October 15, every Apple balance becomes 1.0042 times what it was: about a 0.42% dividend, paid as more tokens." */
export function rescaleSentence(listing: Listing, from: number, to: number, at: number, zone: Zone): string {
  const day = spokenDate(zoneParts(new Date(at), zone.tz).date);
  const what = describeRescale(from, to);
  const value = to > from ? "The price per token should fall by about as much, so what your holding is worth shouldn't change." : "The price per token should rise by about as much, so what your holding is worth shouldn't change.";
  return `On ${day}, every ${listing.spoken} token balance gets multiplied by ${Math.round((to / from) * 10_000) / 10_000}: ${what}. ${value}`;
}

export function safetyAnswer(o: { listing: Listing; facts: MintFacts; price: number | null; frozen: boolean | null; now: number; zone: Zone; sample: boolean }): string {
  const { listing, facts: f, price, frozen, now, zone } = o;
  // "the S&P 500 fund" already has its article.
  const name = `The ${listing.spoken.replace(/^the /, "")} token, ${listing.token},`;
  const parts: string[] = [];
  const powers = issuerPowers(f);
  if (f.nonTransferable) parts.push(`${name} can't be transferred at all.`);
  parts.push(
    powers.length
      ? `${name} is a ${f.program === "token-2022" ? "Token-2022" : "classic SPL"} token, and its issuer can, on chain: ${list(powers)}.`
      : `${name} gives no one special powers on chain: its supply is fixed and no one can freeze or move holders' tokens.`,
  );
  if (f.defaultFrozen) parts.push("New holders start frozen until the issuer approves them.");
  if (f.pausable?.paused) parts.push("Transfers are paused right now, so it can't be bought, sold or moved until the issuer resumes them.");
  else if (f.pausable) parts.push("Transfers are running normally right now.");
  if (frozen === true) parts.push(`Your own ${listing.spoken} tokens are frozen by the issuer at the moment, so you can't move or sell them until it lifts that.`);
  else if (frozen === false) parts.push(`Your own ${listing.spoken} tokens aren't frozen.`);
  const s = f.scaledUiAmount;
  if (s?.next) parts.push(`A corporate action is scheduled. ${rescaleSentence(listing, s.multiplier, s.next.multiplier, s.next.at, zone)}`);
  else if (s?.last && now - s.last.at < 14 * 86_400_000) parts.push(`A corporate action took effect recently: ${describeRescale(s.last.from, s.last.to)}, applied to every balance.`);
  const outstanding = f.supply * multiplierAt(f, now);
  if (outstanding > 0) {
    const count = outstanding >= 1000 ? Math.round(outstanding).toLocaleString("en-US") : String(Math.round(outstanding * 100) / 100);
    parts.push(`About ${count} tokens exist${price ? `, worth about ${bigUsd(outstanding * price)}` : ""}.`);
  }
  if (powers.length) parts.push("That's normal for a regulated tokenized stock, and it means the token is only as trustworthy as its issuer.");
  parts.push("Whether real shares back every token is something the issuer attests to off chain; the chain can't show it.");
  if (o.sample) parts.push("This is sample data, not a live read of the chain.");
  return parts.map((p) => capitalise(p)).join(" ");
}
