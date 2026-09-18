import {
  defineGuard,
  extractArgs,
  extractSignal,
  type ToolAdapter,
  type ToolDescriptor,
} from "@agentghost/sdk";

/**
 * LangChain.js tools are class instances, so we cannot simply spread them to
 * replace a method without losing the prototype. Instead we wrap the tool in a
 * Proxy that intercepts its lowest-level call method — `_call` for
 * `DynamicStructuredTool`, `func` for legacy tools, `invoke` as a fallback.
 *
 * Because `invoke()` calls `this._call()`, intercepting `_call` means the
 * authorization check runs exactly once, however the tool is invoked.
 */
const INTERCEPT_KEYS = ["_call", "func", "call", "invoke"] as const;

export interface LangChainToolLike {
  name?: string;
  description?: string;
  schema?: unknown;
  inputSchema?: unknown;
  _call?: (...args: never[]) => unknown;
  func?: (...args: never[]) => unknown;
  invoke?: (...args: never[]) => unknown;
  [key: string]: unknown;
}

export function createLangChainAdapter(): ToolAdapter<LangChainToolLike> {
  return {
    name: "langchain",
    matches(tool) {
      if (typeof tool !== "object" || tool === null) return false;
      const candidate = tool as LangChainToolLike;
      if (typeof candidate.name !== "string") return false;
      return INTERCEPT_KEYS.some((key) => typeof candidate[key] === "function");
    },
    describe(tool) {
      const schema = tool.schema ?? tool.inputSchema;
      const descriptor: ToolDescriptor = { name: String(tool.name ?? "") };
      if (typeof tool.description === "string") descriptor.description = tool.description;
      if (schema !== undefined) descriptor.schema = schema;
      return descriptor;
    },
    wrap(tool, authorizeAndCall) {
      const key = INTERCEPT_KEYS.find((candidate) => typeof tool[candidate] === "function");
      if (!key) return tool;
      return new Proxy(tool, {
        get(target, property, receiver) {
          if (property === key) {
            const original = Reflect.get(target, property, receiver) as (
              ...args: unknown[]
            ) => unknown;
            return async (...raw: unknown[]) => {
              await authorizeAndCall(extractArgs(raw), extractSignal(raw));
              return original.apply(receiver, raw);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
}

export const langChainAdapter = createLangChainAdapter();

/**
 * Guard a LangChain.js tool (or array of tools, or record).
 *
 * ```ts
 * import { guard } from "@agentghost/langchain";
 * const safeTools = guard(tools, { intent: () => currentTask });
 * const agent = createReactAgent({ llm, tools: safeTools });
 * ```
 */
export const guard = defineGuard([langChainAdapter]);

export type { GuardOptions, ToolAdapter, ToolDescriptor } from "@agentghost/sdk";
export {
  AgentGhostApprovalRequiredError,
  AgentGhostDeniedError,
  AgentGhostError,
  allowTools,
  approveWith,
  askTools,
  denyTools,
  terminalApproval,
} from "@agentghost/sdk";
