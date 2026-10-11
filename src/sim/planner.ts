/**
 * The "Alexa" half of the simulator: turns an utterance into MCP tool calls and
 * a spoken reply.
 *
 * Alexa+'s own MCP client is not open to hackathon participants, so the
 * simulator stands in for it. It talks to Afterhours exactly as Alexa+ would:
 * over Streamable HTTP, with the OAuth access token from account linking, and
 * only through the tools the server lists. Nothing here reaches into the
 * server's internals.
 *
 * Two planners:
 *
 * - `bedrock`: Claude on Amazon Bedrock picks tools from the server's own
 *   `tools/list` and phrases the reply. Used when AWS credentials are present.
 * - `scripted`: a small deterministic intent matcher. It needs no credentials,
 *   so anyone can run the demo, and every reply is the tool's own spoken text.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Anthropic, { BetaFallbackState, betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { resolveSymbol } from "../market/universe.js";
import { VERSION } from "../version.js";

export interface Step {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  text: string;
  isError: boolean;
  structured: unknown;
  /** The tool's MCP Apps card, when it declares one (`_meta.ui.resourceUri`). */
  ui?: { uri: string; html: string } | null;
}

export interface Turn {
  reply: string;
  steps: Step[];
  planner: "bedrock" | "scripted";
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

/** An MCP session against the Afterhours endpoint, timed per call. */
export class McpSession {
  private constructor(private readonly client: Client) {}

  static async open(endpoint: string, accessToken: string | null, fetchImpl?: typeof fetch): Promise<McpSession> {
    const client = new Client({ name: "afterhours-alexa-simulator", version: VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: accessToken ? { headers: { authorization: `Bearer ${accessToken}` } } : undefined,
      fetch: fetchImpl,
    });
    await client.connect(transport);
    return new McpSession(client);
  }

  private listed: Awaited<ReturnType<Client["listTools"]>>["tools"] | null = null;
  private cards = new Map<string, string>();

  async tools() {
    this.listed ??= (await this.client.listTools()).tools;
    return this.listed;
  }

  /** Fetches the MCP Apps card a tool declares, as a host would. */
  async card(tool: string): Promise<{ uri: string; html: string } | null> {
    const meta = (await this.tools()).find((t) => t.name === tool)?._meta as { ui?: { resourceUri?: string } } | undefined;
    const uri = meta?.ui?.resourceUri;
    if (!uri) return null;
    if (!this.cards.has(uri)) {
      const res = await this.client.readResource({ uri });
      const first = res.contents[0] as { text?: string } | undefined;
      if (typeof first?.text !== "string") return null;
      this.cards.set(uri, first.text);
    }
    return { uri, html: this.cards.get(uri)! };
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Step> {
    const started = performance.now();
    const res = await this.client.callTool({ name: tool, arguments: args });
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
    const ui = res.isError ? null : await this.card(tool).catch(() => null);
    return { tool, args, ms, text, isError: Boolean(res.isError), structured: res.structuredContent ?? null, ui };
  }

  async close() {
    await this.client.close();
  }
}

// ---------------------------------------------------------------- scripted

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, "twenty five": 25, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  "a hundred": 100, "one hundred": 100, "two hundred": 200, "five hundred": 500,
};

function amount(text: string): number | null {
  const digits = /\$?\s*(\d+(?:\.\d+)?)\s*(?:dollars|bucks|usd)?/i.exec(text);
  if (digits) return Number(digits[1]);
  for (const [word, n] of Object.entries(NUMBER_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return n;
  }
  return null;
}

/** The stock named anywhere in a phrase, as its first alias; else the raw phrase. */
function stockIn(text: string): string {
  return resolveSymbol(text)?.aliases[0] ?? subject(text);
}

/** The stock phrase after a verb, e.g. "of Tesla", "on Nvidia", "is Apple". */
function subject(text: string): string {
  const m =
    /\b(?:of|on|for|about|is|check|sell|buy|watch)\s+(?:my\s+)?(?:the\s+)?([a-z&\s0-9]+?)(?:\s+(?:doing|trading|token|stock|shares?|moves?|moving|goes|alert|right now|today|tonight|at|by|more|over|is))?\s*[?.!]*$/i.exec(
      text,
    );
  return (m?.[1] ?? text).trim();
}

/** Picks one tool and its arguments from what was said. Null when nothing matches. */
export function route(utterance: string): { tool: string; args: Record<string, unknown> } | null {
  const t = utterance.toLowerCase().trim();

  if (/\b(did|has|is)\b.*\b(trade|order|swap|buy|sale|purchase)\b.*\b(go through|done|complete|confirmed|status|happen)/.test(t) || /\btrade status\b/.test(t)) {
    const code = /\b(\d[\d\s]{4,10}\d)\b/.exec(t)?.[1]?.replace(/\s/g, "");
    return { tool: "trade_status", args: code ? { code } : {} };
  }
  if (/\b(buy|purchase|sell)\b/.test(t)) {
    const side = /\bsell\b/.test(t) ? "sell" : "buy";
    const usd = amount(t);
    const stock = t.replace(/^.*?\b(buy|purchase|sell)\b/, "").replace(/\$?\d+(\.\d+)?|dollars?|bucks|usd|worth|\b(of|me|some)\b/g, " ").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|twenty five|thirty|forty|fifty|a hundred|hundred)\b/g, " ").trim();
    return { tool: "propose_trade", args: { stock: stock ? stockIn(stock) : "unknown", side, amount_usd: usd ?? 0 } };
  }
  if (/\b(remove|delete|stop|cancel)\b.*\balert\b/.test(t)) return { tool: "remove_alert", args: { stock: stockIn(t.replace(/\b(remove|delete|stop|cancel)\b|\b(my|the)\b|\balert\b/g, " ")) } };
  if (/\b(what|which|list|my)\b.*\balerts\b/.test(t)) return { tool: "list_alerts", args: {} };
  if (/\b(tell|let|alert|notify|warn)\b.*\b(if|when)\b/.test(t) || /\bset (an |a )?alert\b/.test(t)) {
    const percent = /(\d+(?:\.\d+)?)\s*(?:%|percent)/.exec(t)?.[1] ?? Object.entries(NUMBER_WORDS).find(([w]) => new RegExp(`\\b${w}\\s+percent`).test(t))?.[1];
    const named = /\b(?:if|when)\s+(.+?)\s+(?:moves|goes|drifts|jumps|drops|is|gets|changes)/.exec(t)?.[1] ?? t;
    return { tool: "set_alert", args: { stock: stockIn(named), percent: Number(percent ?? 2) } };
  }
  if (/\b(portfolio|my (stocks|holdings|positions|wallet)|what do i own|how much am i (up|down))\b/.test(t)) return { tool: "my_portfolio", args: {} };
  if (/\b(market|stock market)\b.*\b(open|closed|close)\b|\bwhen does\b.*\bopen\b/.test(t)) return { tool: "market_status", args: {} };
  if (/\b(overnight|while i (was )?(asleep|sleeping|slept)|briefing|brief|what happened|what moved|anything i should know|how are (stocks|markets)|weekend)\b/.test(t)) {
    return { tool: "overnight_brief", args: {} };
  }
  if (/\b(how('s| is)|what('s| is)|check|price|trading|rich|cheap|doing)\b/.test(t)) return { tool: "check_stock", args: { stock: stockIn(t) } };
  return null;
}

export type Route = { tool: string; args: Record<string, unknown> };

/**
 * `route`, plus the context a conversation carries: "what about Nvidia?"
 * repeats the last question for a new stock, "buy 20 dollars of it" means the
 * stock just discussed, and "make it 50" changes the amount of the trade just
 * proposed. Returns a question instead of a tool call when something needed
 * (a trade amount) is missing, rather than guessing.
 */
export function routeInContext(utterance: string, previous: Route | null): Route | { ask: string } | null {
  const t = utterance.toLowerCase().replace(/^alexa,?\s*/, "").trim();
  const prevStock = typeof previous?.args.stock === "string" ? (previous.args.stock as string) : null;
  const named = resolveSymbol(t);

  // "make it 50", "actually 30 dollars", "make that a hundred"
  if (previous?.tool === "propose_trade" && /\b(make (it|that)|actually|instead|change (it|that) to)\b/.test(t)) {
    const usd = amount(t);
    if (usd) return { tool: "propose_trade", args: { ...previous.args, amount_usd: usd } };
  }

  // "what about Nvidia?", "and Apple?", "how about the Nasdaq"
  if (named && /^(and|what about|how about|what's about|and what about|same for|also)\b/.test(t)) {
    const reuse = previous && ["check_stock", "set_alert", "remove_alert"].includes(previous.tool) ? previous : null;
    return { tool: reuse?.tool ?? "check_stock", args: { ...(reuse?.args ?? {}), stock: named.aliases[0] } };
  }

  let pick: Route | null = route(t);
  if (pick?.tool === "propose_trade") {
    const unnamed = !resolveSymbol(String(pick.args.stock)) && /\b(it|that|them|some|more|those)\b/.test(t);
    if (unnamed && prevStock) pick = { ...pick, args: { ...pick.args, stock: prevStock } };
    if (!resolveSymbol(String(pick.args.stock))) {
      return { ask: `Which stock would you like to ${pick.args.side}?` };
    }
    if (!(Number(pick.args.amount_usd) > 0)) {
      const name = resolveSymbol(String(pick.args.stock))!.spoken;
      return { ask: `How many dollars of ${name} would you like to ${pick.args.side}?` };
    }
  }
  return pick;
}

/** Rebuilds the last routed request from the conversation so far. */
export function previousRoute(history: HistoryItem[]): Route | null {
  let prev: Route | null = null;
  for (const h of history) {
    if (h.role !== "user") continue;
    const r = routeInContext(h.text, prev);
    if (r && "tool" in r) prev = r;
  }
  return prev;
}

export async function scriptedTurn(mcp: McpSession, utterance: string, history: HistoryItem[] = []): Promise<Turn> {
  const pick = routeInContext(utterance, previousRoute(history));
  if (pick && "ask" in pick) return { reply: pick.ask, steps: [], planner: "scripted" };
  if (!pick) {
    return {
      reply: "I can tell you what moved overnight, check a stock like Tesla, read your portfolio, set an alert, or prepare a trade for you to sign.",
      steps: [],
      planner: "scripted",
    };
  }
  const step = await mcp.call(pick.tool, pick.args);
  return { reply: step.text, steps: [step], planner: "scripted" };
}

// ----------------------------------------------------------------- bedrock

const SYSTEM = `You are Alexa+, speaking aloud through a smart speaker, using the Afterhours add-on to answer questions about tokenized stocks (xStocks on Solana).
Reply in one to three short spoken sentences: no markdown, no lists, no symbols other than $ and %.
Use the tools for every market, portfolio, alert or trade question; never make up prices.
The tools' text results are already written for speech, so stay close to them.
A proposed trade is NOT executed: say it is ready to sign, and read the six-digit code digit by digit. Never say a trade happened unless trade_status says it is confirmed.
If a request is ambiguous (for example a trade without an amount), ask one short question instead of guessing.`;

export function bedrockConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env.AWS_REGION || env.AWS_DEFAULT_REGION) && (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE) && env.PLANNER !== "scripted");
}

let bedrock: AnthropicBedrockMantle | null = null;

function bedrockClient(): AnthropicBedrockMantle {
  // Claude on Bedrock has no server-side refusal fallback, so the SDK's
  // client-side middleware retries a declined turn on the fallback model.
  bedrock ??= new AnthropicBedrockMantle({
    middleware: [betaRefusalFallbackMiddleware([{ model: process.env.BEDROCK_FALLBACK_MODEL ?? "anthropic.claude-opus-4-8" }])],
  });
  return bedrock;
}

export async function bedrockTurn(mcp: McpSession, utterance: string, history: HistoryItem[]): Promise<Turn> {
  const client = bedrockClient();
  const tools: Anthropic.Beta.BetaTool[] = (await mcp.tools()).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: utterance },
  ];
  const steps: Step[] = [];
  const fallbackState = new BetaFallbackState();

  for (let i = 0; i < 5; i += 1) {
    const response = await client.beta.messages.create(
      {
        model: process.env.BEDROCK_MODEL ?? "anthropic.claude-opus-5-5",
        max_tokens: 16000,
        // A voice turn is a short, well-specified task; low effort keeps the
        // spoken reply quick without changing which tools get called.
        output_config: { effort: "low" },
        system: SYSTEM,
        tools,
        messages,
      },
      { fallbackState },
    );

    if (response.stop_reason === "refusal") {
      return { reply: "Sorry, I can't help with that one.", steps, planner: "bedrock" };
    }
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      return { reply: reply || steps.at(-1)?.text || "Done.", steps, planner: "bedrock" };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const step = await mcp.call(use.name, (use.input ?? {}) as Record<string, unknown>);
      steps.push(step);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify({ say: step.text, data: step.structured }),
        is_error: step.isError,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: steps.at(-1)?.text ?? "Sorry, that took too many steps.", steps, planner: "bedrock" };
}
