/**
 * Everything Afterhours keeps about an account: download it, or delete it.
 *
 * Afterhours stores settings, not money: alerts, limits, a PIN hash, a
 * watchlist, plans, the activity log. Each lives under a key named for the
 * account. The export is that set, readable (the PIN only as "set"); deletion
 * removes every key, takes the account out of every background schedule,
 * and cancels anything still waiting to be signed or triggered, so nothing
 * fires afterwards. The wallet and anything on Solana are untouched.
 */

import type { Services } from "../services.js";
import { getIntent, saveIntent, type TradeIntent } from "../chain/trade.js";
import { getGuardrails, retireGuardrails } from "../chain/guardrails.js";

// Guardrails are not on this list: deleting data retires them through the
// usual 24-hour wait instead (see retireGuardrails), so deletion can't be a
// way around a limit or sleep mode at 2 a.m.
const PER_ACCOUNT = ["activity", "alerts", "briefing", "pin", "prefs", "push", "recurring", "targets", "watch", "weekly", "walletsnap", "firedlog", "triggered", "latest-intent", "sms", "smsotp", "smssent", "journal"];
const INDEXES = ["alert-accounts", "briefing:index", "recurring:index", "push:index"];

export async function exportData(svc: Services, sub: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { account: sub, exportedAt: new Date(svc.now()).toISOString() };
  for (const name of PER_ACCOUNT) {
    const value = await svc.store.get<unknown>(`${name}:${sub}`);
    if (value === null || value === undefined) continue;
    if (name === "pin") out.pin = { set: true };
    else if (name === "push") out.push = { devices: Array.isArray(value) ? value.length : 0 };
    else if (name === "smsotp" || name === "smssent") continue;
    else if (name === "sms") out.sms = { phone: (value as { phone: string }).phone, verifiedAt: new Date((value as { verifiedAt: number }).verifiedAt).toISOString() };
    else out[name] = value;
  }
  const g = await getGuardrails(svc.store, sub, svc.now());
  if (g.dailyLimitUsd !== null || g.sleep || g.pending || g.pendingSleep) out.guardrails = g;
  const latest = out["latest-intent"];
  if (typeof latest === "string") {
    const intent = await getIntent(svc.store, latest, svc.now());
    if (intent) out["latest-intent"] = { ...intent, builtBlockhashes: undefined };
  }
  return out;
}

/**
 * Deletes the account's data. Returns how many records went. Guardrails are
 * retired through their 24-hour wait rather than deleted, refresh tokens from
 * before now stop working, and the wallet's derived records (cost basis,
 * settled trades) go too when this account is the wallet's verified owner.
 */
export async function deleteData(svc: Services, sub: string, wallet: string | null = null): Promise<number> {
  const now = svc.now();
  // Anything still waiting would otherwise trigger or be signable later.
  const armed = (await svc.store.get<string[]>("armed-intents")) ?? [];
  const mine = (await svc.store.get<string[]>(`intents:${sub}`)) ?? [];
  const waiting = [...mine, ...armed, ...((await svc.store.get<string[]>(`triggered:${sub}`)) ?? [])];
  const latest = await svc.store.get<string>(`latest-intent:${sub}`);
  if (latest) waiting.push(latest);
  for (const id of new Set(waiting)) {
    const intent: TradeIntent | null = await getIntent(svc.store, id, now);
    if (intent?.sub === sub && (intent.status === "armed" || intent.status === "awaiting_signature")) {
      intent.status = "cancelled";
      await saveIntent(svc.store, intent, now);
    }
  }

  let removed = 0;
  for (const name of [...PER_ACCOUNT, "intents"]) {
    if ((await svc.store.get(`${name}:${sub}`)) !== null) removed += 1;
    await svc.store.del(`${name}:${sub}`);
  }
  // Dated records (the spending ledger, weekly-recap markers) around today.
  for (let d = -3; d <= 1; d += 1) {
    const date = new Date(now + d * 86_400_000).toISOString().slice(0, 10);
    await svc.store.del(`spend:${sub}:${date}`);
    await svc.store.del(`weeklysent:${sub}:${date}`);
  }
  if (wallet && sub === `sol:${wallet}`) {
    await svc.store.del(`basis:${wallet}`);
    await svc.store.del(`settled:${wallet}`);
  }
  for (const index of INDEXES) {
    const list = (await svc.store.get<string[]>(index)) ?? [];
    if (list.includes(sub)) await svc.store.set(index, list.filter((s) => s !== sub));
  }
  const watch = (await svc.store.get<{ sub: string; wallet: string }[]>("walletwatch:index")) ?? [];
  if (watch.some((e) => e.sub === sub)) await svc.store.set("walletwatch:index", watch.filter((e) => e.sub !== sub));
  await retireGuardrails(svc.store, sub, now);
  await svc.store.set(`revoked:${sub}`, now, 60 * 86_400);
  return removed;
}
