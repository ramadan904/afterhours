import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { harness, linkWallet, mcp } from "./helpers.js";
import { bedrockTurn, historyMessages, type PlannerClient } from "../src/sim/planner.js";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** A stand-in for Claude on Bedrock that replays scripted responses and records requests. */
function fakeClaude(responses: Partial<Anthropic.Beta.BetaMessage>[]) {
  const requests: Params[] = [];
  const client: PlannerClient = {
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("no more scripted responses");
          return { id: "msg", type: "message", role: "assistant", model: params.model, usage: {}, ...next } as Anthropic.Beta.BetaMessage;
        },
      },
    },
  };
  return { client, requests };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaToolUseBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;

async function session() {
  const h = harness();
  const { tokens } = await linkWallet(h.app);
  return mcp(h, tokens.access_token);
}

describe("Bedrock planner loop", () => {
  it("offers the server's own tools, runs the call over MCP, and returns Claude's reply", async () => {
    const s = await session();
    const { client, requests } = fakeClaude([
      { stop_reason: "tool_use", content: [text("Let me check."), toolUse("tu_1", "check_stock", { stock: "Tesla" })] },
      { stop_reason: "end_turn", content: [text("Tesla's token is up about 2 percent since Friday's close.")] },
    ]);
    const turn = await bedrockTurn(s, "How's Tesla doing?", [], client);

    expect(turn.planner).toBe("bedrock");
    expect(turn.reply).toBe("Tesla's token is up about 2 percent since Friday's close.");
    expect(turn.steps.map((x) => x.tool)).toEqual(["check_stock"]);
    expect(turn.steps[0].text).toContain("Tesla's token is up 2.1 percent");

    const first = requests[0];
    expect(first.model).toBe("anthropic.claude-opus-5-5");
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first.tools!.map((t) => (t as Anthropic.Beta.BetaTool).name)).toContain("propose_trade");
    const check = first.tools!.find((t) => (t as Anthropic.Beta.BetaTool).name === "check_stock") as Anthropic.Beta.BetaTool;
    expect(check.input_schema.properties).toHaveProperty("stock");

    // Second request: the assistant turn verbatim, then one tool_result for it.
    const second = requests[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant" });
    const results = second.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
    expect(JSON.parse(results[0].content as string).say).toContain("Tesla's token");
  });

  it("runs parallel tool calls and returns all results in one message", async () => {
    const s = await session();
    const { client, requests } = fakeClaude([
      { stop_reason: "tool_use", content: [toolUse("a", "check_stock", { stock: "Tesla" }), toolUse("b", "check_stock", { stock: "Blockbuster" })] },
      { stop_reason: "end_turn", content: [text("Tesla is up; I don't cover Blockbuster.")] },
    ]);
    const turn = await bedrockTurn(s, "Tesla and Blockbuster?", [], client);
    expect(turn.steps).toHaveLength(2);
    const results = requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("says no politely on a refusal, and stops after five rounds", async () => {
    const s = await session();
    const refused = await bedrockTurn(s, "…", [], fakeClaude([{ stop_reason: "refusal", content: [] }]).client);
    expect(refused.reply).toBe("Sorry, I can't help with that one.");

    const looping = Array.from({ length: 5 }, (_, i) => ({ stop_reason: "tool_use" as const, content: [toolUse(`t${i}`, "market_status", {})] }));
    const capped = await bedrockTurn(s, "loop", [], fakeClaude(looping).client);
    expect(capped.steps).toHaveLength(5);
    expect(capped.reply).toContain("The US stock market");
  });

  it("never sends a history that starts with the assistant", () => {
    const h = [
      { role: "user" as const, text: "1" },
      { role: "assistant" as const, text: "2" },
      { role: "user" as const, text: "3" },
      { role: "assistant" as const, text: "4" },
    ];
    expect(historyMessages(h, 3).map((m) => m.content)).toEqual(["3", "4"]);
    expect(historyMessages(h, 8)[0].role).toBe("user");
  });
});
