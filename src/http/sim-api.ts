/**
 * The simulator's one endpoint: an utterance in, a spoken reply and the tool
 * trace out. The browser sends the access token it got from account linking;
 * it is forwarded unchanged to the MCP endpoint, exactly as Alexa+ would.
 */

import type { Services } from "../services.js";
import { SharedRateLimit } from "./limit.js";
import { McpSession, bedrockConfigured, bedrockTurn, scriptedTurn, type HistoryItem } from "../sim/planner.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Lets tests route the simulator's MCP calls back into the app in-process. */
let loopback: typeof fetch | undefined;
export function setSimulatorFetch(f: typeof fetch | undefined) {
  loopback = f;
}

/** Each turn may run a Bedrock model, so turns are rate-limited per client. */
const turnLimit = new SharedRateLimit("sim", 30, 60_000);

export async function simulatorTurn(svc: Services, request: Request): Promise<Response> {
  if (await turnLimit.exceeded(svc.store, request)) return json({ error: "That's a lot of questions. Give it a minute." }, 429);
  const body = (await request.json().catch(() => ({}))) as { utterance?: unknown; history?: unknown };
  const utterance = typeof body.utterance === "string" ? body.utterance.trim().slice(0, 300) : "";
  if (!utterance) return json({ error: "Say something first." }, 400);
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((h): h is HistoryItem => typeof h?.text === "string" && (h.role === "user" || h.role === "assistant"))
    .slice(-8);

  const auth = request.headers.get("authorization");
  const accessToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (svc.authRequired && !accessToken) return json({ error: "Link your account first." }, 401);

  const started = performance.now();
  let mcp: McpSession;
  try {
    mcp = await McpSession.open(`${svc.baseUrl}/mcp`, accessToken, loopback);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/401/.test(message)) return json({ error: "Your link has expired. Link your account again." }, 401);
    throw err;
  }
  try {
    const useBedrock = bedrockConfigured();
    let turn;
    try {
      turn = useBedrock ? await bedrockTurn(mcp, utterance, history) : await scriptedTurn(mcp, utterance, history);
    } catch (err) {
      if (!useBedrock) throw err;
      // A Bedrock outage shouldn't end the demo: fall back to the scripted
      // planner and say so in the trace.
      console.error("Bedrock planner failed:", err);
      turn = { ...(await scriptedTurn(mcp, utterance, history)), fallbackReason: (err as Error).message };
    }
    return json({ ...turn, totalMs: Math.round(performance.now() - started) });
  } finally {
    await mcp.close();
  }
}
