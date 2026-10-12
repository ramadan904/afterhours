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

const SECRET_ARGS = new Set(["pin", "current_pin", "new_pin"]);

/** A PIN never shows in the call trace on screen. */
export function redact(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, SECRET_ARGS.has(k) && v ? "••••" : v]));
}

export interface Step {
  tool: string;
  /** As shown on screen: secrets masked. */
  args: Record<string, unknown>;
  /** As sent, for evaluation. Never rendered. */
  rawArgs?: Record<string, unknown>;
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
    return { tool, args: redact(args), rawArgs: args, ms, text, isError: Boolean(res.isError), structured: res.structuredContent ?? null, ui };
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
/**
 * Everyday ways of saying the same thing, folded into the words the rules
 * below listen for: "grab me 15 dollars of Amazon" is a buy, "ping me if"
 * is an alert, "keep an eye on" is a watchlist add.
 */
export function canonical(utterance: string): string {
  let t = utterance.toLowerCase().trim();
  const money = /\$\s*\d|\d+\s*(dollars?|bucks|usd)|\b(dollars?|bucks)\b/.test(t);
  if (money) {
    t = t.replace(/\b(pick up|grab|scoop up|get me|pick me up|load up on)\b/g, "buy").replace(/\b(dump|unload|offload|get rid of|cash out)\b/g, "sell");
  }
  return t
    .replace(/\b(ping|buzz|text) me\b/g, "tell me")
    .replace(/\bnight mode\b/g, "sleep mode")
    .replace(/^(please )?(keep an eye on|keep tabs on)\b/, "watch")
    .replace(/\bwall street\b/g, "the stock market")
    .replace(/\bstop (alerting|notifying|warning) me about\b/g, "remove my alert for")
    .replace(/\bcap my (daily )?(buying|spending)\b/g, "set my daily limit")
    .replace(/\bhow (thin|thick)\b/g, "how deep");
}

export function route(utterance: string): { tool: string; args: Record<string, unknown> } | null {
  const t = canonical(utterance);

  if (/\b(did|has|is)\b.*\b(trade|order|swap|buy|sale|purchase)\b.*\b(go through|done|complete|confirmed|status|happen)/.test(t) || /\btrade status\b/.test(t)) {
    const code = /\b(\d[\d\s]{4,10}\d)\b/.exec(t)?.[1]?.replace(/\s/g, "");
    return { tool: "trade_status", args: code ? { code } : {} };
  }
  if (/\b(how was my week|weekly recap|my week|week in review|recap every sunday)\b/.test(t)) {
    const off = /\b(stop|cancel|turn off|no more)\b/.test(t);
    const on = /\b(send|every sunday|turn on|push)\b/.test(t);
    return { tool: "weekly_recap", args: off ? { push: false } : on ? { push: true } : {} };
  }
  if (/\bhow did the open go\b|\b(move|token) (hold|right)\b|\bwas the token right\b/.test(t)) {
    const named = resolveSymbol(t.replace(/\b(did|the|weekend|overnight|move|hold|token|right|this morning|was|how|open|go)\b/g, " "));
    return { tool: "how_did_the_open_go", args: named ? { stock: named.aliases[0] } : {} };
  }
  if (/\b(how deep|liquid|liquidity|depth|without moving)\b/.test(t)) {
    const named = resolveSymbol(t.replace(/\b(how deep|is|the|market|liquid|liquidity|depth|right now|without moving it)\b/g, " "));
    return { tool: "market_depth", args: { stock: named ? named.aliases[0] : stockIn(t), ...(/\bsell/.test(t) ? { side: "sell" } : {}) } };
  }
  if (/\b(how much have i (made|lost)|what did i pay|am i up overall|my returns|cost basis|made on|lost on|my (profit|gains?|losses|p&l|pnl))\b/.test(t)) {
    const named = resolveSymbol(t.replace(/\b(how much have i|made|lost|on|what did i pay|for|my|returns|cost basis|profit|gains?|losses|what's|what is)\b/g, " "));
    return { tool: "my_returns", args: named ? { stock: named.aliases[0] } : {} };
  }
  if (/\brebalanc/.test(t) || /\bhow far\b.*\btarget\b/.test(t)) {
    return { tool: "rebalance", args: /\b(now|go ahead|do it|yes)\b/.test(t) ? { confirm: true } : {} };
  }
  if (/\btarget (mix|allocation)\b/.test(t) && /\b(what|clear)\b/.test(t)) {
    return { tool: "set_target_allocation", args: /\bclear\b/.test(t) ? { clear: true } : {} };
  }
  const mix = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:in\s+|of\s+)?([a-z&.' ]+?)(?=\s*(?:,|\band\b|$|\d))/g)];
  if (mix.length >= 2 && /\b(keep|target|mix|allocation|split)\b/.test(t)) {
    return { tool: "set_target_allocation", args: { targets: mix.map((m) => ({ stock: stockIn(m[2].trim()), percent: Number(m[1]) })) } };
  }
  if (/\b(trade |voice )?pin\b/.test(t) && /\b(set|add|change|new|remove|delete|turn off|do i have|have a)\b/.test(t)) {
    if (/\b(remove|delete|turn off)\b/.test(t)) return { tool: "set_trade_pin", args: { remove: true } };
    if (/\b(do i have|have a)\b/.test(t) && !/\bset\b/.test(t)) return { tool: "set_trade_pin", args: {} };
    const digits = /(\d[\d\s-]{2,})/.exec(t)?.[1]?.trim();
    return { tool: "set_trade_pin", args: digits ? { new_pin: digits } : {} };
  }
  if (/\b(spending|daily) limit\b|\bspend more than\b|\blimit me\b/.test(t)) {
    if (/\b(remove|drop|get rid of|no)\b.*\blimit\b/.test(t)) return { tool: "set_spending_limit", args: { remove: true } };
    const usd = amount(t);
    return { tool: "set_spending_limit", args: usd ? { daily_usd: usd } : {} };
  }
  if (/\bsleep mode\b|\b(trade|trading|buy|buying) at night\b/.test(t)) {
    if (/\b(off|disable|stop)\b/.test(t)) return { tool: "set_sleep_mode", args: { on: false } };
    if (/\bis\b.*\bon\b|\?$/.test(t) && !/\b(turn|set|don'?t)\b/.test(t)) return { tool: "set_sleep_mode", args: {} };
    const from = /\bfrom\s+(midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/.exec(t)?.[1];
    const until = /\b(?:to|until|till)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/.exec(t)?.[1];
    return { tool: "set_sleep_mode", args: { on: true, ...(from ? { from: from.trim() } : {}), ...(until ? { until: until.trim() } : {}) } };
  }
  if (/\bbrief(ing)?\b/.test(t) && /\b(stop|cancel|turn off|no more)\b/.test(t)) return { tool: "schedule_briefing", args: { off: true } };
  if (/\bbrief(ing)?\b/.test(t) && /\bwhen\b.*\b(is|do i get|does)\b/.test(t)) return { tool: "schedule_briefing", args: {} };
  const timed = /\b(?:at|@)\s+(noon|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|in the morning|in the evening)?)/.exec(t);
  if (/\bbrief(ing)?\b/.test(t) && timed && /\b(every|each|daily|send|schedule|set|weekdays?|weekends?|mornings?)\b/.test(t)) {
    const days = /\bweekends?\b/.test(t) ? "weekends" : /\b(every day|daily|each day)\b/.test(t) ? "daily" : "weekdays";
    return { tool: "schedule_briefing", args: { time: timed[1].trim(), days } };
  }
  if (/\b(watch ?list|watching)\b/.test(t) && /\b(how|what)\b/.test(t) && !/\b(add|put|remove|take|drop|stop)\b/.test(t)) {
    return { tool: "my_watchlist", args: {} };
  }
  if (/\b(stop watching|unwatch)\b/.test(t) || (/\b(remove|take|drop|delete)\b/.test(t) && /\bwatch ?list\b/.test(t))) {
    const names = t.replace(/\b(stop watching|unwatch|remove|take|drop|delete|from|off|my|the|watch ?list|please)\b/g, " ");
    return { tool: "edit_watchlist", args: { remove: splitNames(names) } };
  }
  if (/^(please )?(watch|follow)\b/.test(t) || (/\b(add|put)\b/.test(t) && /\bwatch ?list\b/.test(t))) {
    const names = t.replace(/\b(watch|follow|add|put|to|on|onto|my|the|watch ?list|please|for me)\b/g, " ");
    return { tool: "edit_watchlist", args: { add: splitNames(names) } };
  }
  if (/\b(cancel|forget|scrap|drop)\b.*\b(order|trade|buy|sell|purchase)\b/.test(t)) {
    const code = /\b(\d[\d\s]{4,10}\d)\b/.exec(t)?.[1]?.replace(/\s/g, "");
    return { tool: "cancel_trade", args: code ? { code } : {} };
  }
  if (/\b(stop|cancel|end)\b.*\b(recurring|weekly|daily|monthly)\b/.test(t)) {
    const named = resolveSymbol(t.replace(/\b(stop|cancel|end|my|recurring|weekly|daily|monthly|buys?|plan)\b/g, " "));
    return { tool: "stop_recurring_buy", args: named ? { stock: named.ticker } : {} };
  }
  if (/\b(recurring|regular) buys?\b/.test(t) && /\b(what|which|my|how)\b/.test(t) && !/\b(buy|invest)\s+\$?\d/.test(t)) return { tool: "my_recurring_buys", args: {} };
  const every = /\b(every|each)\s+(day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\b(daily|weekly|monthly)\b|\bon the (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (/\b(buy|invest|purchase)\b/.test(t) && every) {
    const word = (every[2] ?? every[3] ?? "").replace(/s$/, "");
    const cadence = every[4] || word === "month" || word === "monthly" ? "monthly" : word === "day" || word === "daily" ? "daily" : "weekly";
    const day = every[4] ?? (cadence === "weekly" && word !== "week" && word !== "weekly" ? word : undefined);
    const time = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/.exec(t)?.[1]?.trim();
    // "Buy 5 dollars of X every Monday" or "Every Monday buy 5 dollars of X".
    const before = t.slice(0, every.index);
    const head = /\b(buy|invest|purchase)\b/.test(before) ? before : t.slice(every.index + every[0].length).replace(/\bat\s+\d.*$/, "");
    const stock = head.replace(/^.*?\b(buy|invest|purchase)\b/, "").replace(/\$?\d+(\.\d+)?|dollars?|bucks|usd|worth|\b(of|me|some|in|into)\b/g, " ").trim();
    return { tool: "recurring_buy", args: { stock: stock ? stockIn(stock) : "unknown", amount_usd: amount(head) ?? 0, cadence, ...(day ? { day } : {}), ...(time ? { time } : {}) } };
  }
  if (/\b(buy|purchase|sell)\b/.test(t)) {
    // "... if it drops below 360" / "when it hits $400": a conditional trade.
    const cond = /\b(?:if|when|once)\b(.*?)\b(?:below|under|above|over|hits?|reach(?:es)?|to)\s+\$?(\d+(?:\.\d+)?)/.exec(t);
    if (cond) {
      const head = t.slice(0, cond.index);
      const side = /\bsell\b/.test(head) ? "sell" : "buy";
      const usd = amount(head);
      const stock = head.replace(/^.*?\b(buy|purchase|sell)\b/, "").replace(/\$?\d+(\.\d+)?|dollars?|bucks|usd|worth|\b(of|me|some)\b/g, " ").trim();
      return { tool: "propose_trade", args: { stock: stock ? stockIn(stock) : "unknown", side, amount_usd: usd ?? 0, trigger_price: Number(cond[2]) } };
    }
    const side = /\bsell\b/.test(t) ? "sell" : "buy";
    const usd = amount(t);
    const stock = t.replace(/^.*?\b(buy|purchase|sell)\b/, "").replace(/\$?\d+(\.\d+)?|dollars?|bucks|usd|worth|\b(of|me|some)\b/g, " ").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|twenty five|thirty|forty|fifty|a hundred|hundred)\b/g, " ").trim();
    return { tool: "propose_trade", args: { stock: stock ? stockIn(stock) : "unknown", side, amount_usd: usd ?? 0 } };
  }
  if (/\b(remove|delete|stop|cancel)\b.*\balert\b/.test(t)) return { tool: "remove_alert", args: { stock: stockIn(t.replace(/\b(remove|delete|stop|cancel)\b|\b(my|the)\b|\balert\b/g, " ")) } };
  if (/\b(what|which|list|my)\b.*\balerts\b/.test(t)) return { tool: "list_alerts", args: {} };
  if (/\b(tell|let|alert|notify|warn)\b.*\b(if|when)\b/.test(t) || /\bset (an |a )?(price )?alert\b/.test(t)) {
    // "goes above 400", "drops below $300", "hits 250 dollars": a price alert.
    const level = /\b(?:above|over|below|under|hits?|reach(?:es)?|to)\s+\$?(\d+(?:\.\d+)?)(?!\s*(?:%|percent))/.exec(t);
    if (level) {
      const named = /\b(?:if|when)\s+(.+?)\s+(?:goes|gets|is|trades|drops|falls|rises|climbs|hits|reaches)/.exec(t)?.[1] ?? t;
      return { tool: "set_alert", args: { stock: stockIn(named), price: Number(level[1]) } };
    }
    const percent = /(\d+(?:\.\d+)?)\s*(?:%|percent)/.exec(t)?.[1] ?? Object.entries(NUMBER_WORDS).find(([w]) => new RegExp(`\\b${w}\\s+percent`).test(t))?.[1];
    const named = /\b(?:if|when)\s+(.+?)\s+(?:moves|goes|drifts|jumps|drops|is|gets|changes)/.exec(t)?.[1] ?? t;
    return { tool: "set_alert", args: { stock: stockIn(named), percent: Number(percent ?? 2) } };
  }
  const place = /^(?:i'?m|i am|i live|we're|we are)\s+(?:in|at)\s+(.+)$|\b(?:time ?zone|use)\s+(?:is\s+|to\s+)?(.+?)(?:\s+time)?$/.exec(t.replace(/[.!?]+$/, ""));
  if (place && (place[1] || /\btime ?zone\b|\btime$/.test(t.replace(/[.!?]+$/, "")))) return { tool: "set_timezone", args: { place: (place[1] ?? place[2]).trim() } };
  if (/\b(usually hold|track record|trust (the|its)|how accurate|predict|does the (weekend|overnight) move)\b/.test(t)) {
    const named = resolveSymbol(t);
    return { tool: "open_track_record", args: { stock: named ? named.aliases[0] : stockIn(t) } };
  }
  const topic = explainTopic(t);
  if (topic) return { tool: "explain", args: { topic } };
  // About the night: one named stock is a stock check; otherwise it's the briefing.
  if (/\b(overnight|last night|while i (was )?(asleep|sleeping|slept))\b/.test(t)) {
    const named = resolveSymbol(t.replace(/\b(overnight|last night|my stocks)\b/g, " "));
    return named ? { tool: "check_stock", args: { stock: named.aliases[0] } } : { tool: "overnight_brief", args: {} };
  }
  if (/\b(portfolio|my (stocks|holdings|positions|wallet)|what do i own|how much am i (up|down))\b/.test(t)) return { tool: "my_portfolio", args: {} };
  if (/\b(market|stock market)\b.*\b(open|closed|close)\b|\b(when|what time) does\b.*\bopen\b/.test(t)) return { tool: "market_status", args: {} };
  if (/\b(overnight|while i (was )?(asleep|sleeping|slept)|briefing|brief|what happened|what moved|anything i should know|how are (the )?(stocks|markets)|weekend)\b/.test(t)) {
    return { tool: "overnight_brief", args: {} };
  }
  if (/\b(how('s| is)|what('s| is)|check|price|trading|rich|cheap|doing)\b/.test(t)) return { tool: "check_stock", args: { stock: stockIn(t) } };
  // A stock named with nothing else asked of it: "Apple, up or down since Friday?"
  const named = resolveSymbol(t);
  if (named) return { tool: "check_stock", args: { stock: named.aliases[0] } };
  return null;
}

/** "Palantir, AMD and Intel" → each name, resolved where possible. */
function splitNames(text: string): string[] {
  return text
    .split(/,|\band\b|&/)
    .map((x) => x.replace(/[.!?]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((x) => resolveSymbol(x)?.ticker ?? x);
}

/** Questions about the concepts, rather than about a price. */
function explainTopic(t: string): string | null {
  if (/\b(what can you do|what do you do|help me|how does this work|what is afterhours)\b/.test(t)) return "what_you_can_do";
  if (/\b(safe|secure|can you (trade|buy|sell) (for me|without)|how do (trades|trading) work)\b/.test(t)) return "trading_safety";
  if (/\bwhy\b.*\b(different|differ|gap|not the same|higher|lower)\b/.test(t)) return "price_gap";
  if (/\bwhy\b.*\b(trade|trading|move|moving)\b.*\b(closed|weekend|night|after hours)\b/.test(t)) return "after_hours";
  if (/\bwhat (is|are) (a |an )?(tokenized stocks?|xstocks?|stock tokens?)\b/.test(t)) return "tokenized_stocks";
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

  // A PIN, said after a trade asked for one: "4 7 1 9", "my pin is four seven one nine".
  const pinWords = t.replace(/^(my )?(trade )?pin( is)?\s*/, "");
  if (
    previous &&
    ["propose_trade", "recurring_buy", "set_trade_pin"].includes(previous.tool) &&
    /^(?:\d|zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.-]*(?:\d|zero|oh|one|two|three|four|five|six|seven|eight|nine))*$/.test(pinWords)
  ) {
    // Trades take it as `pin`; changing or removing a PIN asks for the current one first.
    const field = previous.tool !== "set_trade_pin" ? "pin" : previous.args.new_pin || previous.args.remove ? "current_pin" : "new_pin";
    return { tool: previous.tool, args: { ...previous.args, [field]: pinWords } };
  }

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

/** The one Messages call the planner makes; Bedrock's client in production, a fake in tests. */
export interface PlannerClient {
  beta: {
    messages: {
      create(
        params: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: { fallbackState?: BetaFallbackState },
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

/** Conversation history as the API wants it: alternating, starting with the user. */
export function historyMessages(history: HistoryItem[], keep = 8): Anthropic.Beta.BetaMessageParam[] {
  const recent = history.slice(-keep);
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent.map((h) => ({ role: h.role, content: h.text }));
}

export async function bedrockTurn(
  mcp: McpSession,
  utterance: string,
  history: HistoryItem[],
  client: PlannerClient = bedrockClient() as unknown as PlannerClient,
): Promise<Turn> {
  const tools: Anthropic.Beta.BetaTool[] = (await mcp.tools()).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const messages: Anthropic.Beta.BetaMessageParam[] = [...historyMessages(history), { role: "user", content: utterance }];
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
