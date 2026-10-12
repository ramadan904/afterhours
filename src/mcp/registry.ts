/**
 * Building the tool definitions (34 tools, each with zod input and output
 * schemas) costs more CPU than answering most tool calls does. Stateless MCP
 * needs a fresh server per request, but not fresh definitions: they're
 * recorded once per process against a stand-in server and replayed onto each
 * request's server. Handlers read the caller from AsyncLocalStorage rather
 * than from a closure, so one recorded handler serves every account.
 *
 * The tools/list answer is the same for everyone, so it's built once too.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Services } from "../services.js";
import { registerTools, type Caller } from "./tools.js";
import { registerApps } from "./apps.js";

const scope = new AsyncLocalStorage<Caller>();

function inScope(): Caller {
  const caller = scope.getStore();
  if (!caller) throw new Error("A tool ran outside a request.");
  return caller;
}

/** The caller of the request being handled, read when a handler runs. */
const currentCaller: Caller = {
  get sub() {
    return inScope().sub;
  },
  get wallet() {
    return inScope().wallet;
  },
};

type Recorded = { method: "registerTool" | "registerResource"; args: unknown[] }[];
type ListHandler = (request: unknown, extra: unknown) => Promise<unknown>;

const recorded = new WeakMap<Services, { calls: Recorded; list?: Promise<unknown> }>();

function record(svc: Services) {
  let entry = recorded.get(svc);
  if (!entry) {
    const calls: Recorded = [];
    const standIn = {
      registerTool: (...args: unknown[]) => void calls.push({ method: "registerTool", args }),
      registerResource: (...args: unknown[]) => void calls.push({ method: "registerResource", args }),
    } as unknown as McpServer;
    registerTools(standIn, svc, currentCaller);
    registerApps(standIn, svc);
    entry = { calls };
    recorded.set(svc, entry);
  }
  return entry;
}

/** One validator for the process: Ajv caches what it compiles. */
export const sharedValidator = new AjvJsonSchemaValidator();

/** Puts every tool and resource on a request's server. */
export function install(server: McpServer, svc: Services): void {
  const entry = record(svc);
  for (const { method, args } of entry.calls) (server[method] as (...a: unknown[]) => unknown)(...args);
  // Memoize the SDK's own tools/list answer. If the SDK ever stops keeping
  // handlers where we look, this quietly does nothing.
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  const original = handlers instanceof Map ? handlers.get("tools/list") : undefined;
  if (original) {
    server.server.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
      entry.list ??= original(request, extra).catch((err) => {
        entry.list = undefined;
        throw err;
      });
      return entry.list as never;
    });
  }
}

/** Runs a request's handling with its caller in scope. */
export function asCaller<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return scope.run(caller, fn);
}
