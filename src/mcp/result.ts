/** What a tool returns: words to speak, and the numbers behind them. */

export type Result = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function say(text: string, data?: Record<string, unknown>): Result {
  return data ? { content: [{ type: "text", text }], structuredContent: data } : { content: [{ type: "text", text }] };
}

export function fail(text: string): Result {
  return { content: [{ type: "text", text }], isError: true };
}
