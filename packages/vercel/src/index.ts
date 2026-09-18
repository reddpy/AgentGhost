import {
  defineGuard,
  extractSignal,
  type ToolAdapter,
  type ToolDescriptor,
} from "@agentghost/sdk";

/**
 * Vercel AI SDK tools are plain objects: `{ description, inputSchema |
 * parameters, execute }`. We mostly lean on the generic adapter, but match on
 * the AI SDK-specific `inputSchema`/`parameters` fields so the schema reaches
 * the judge even when `execute` is absent (e.g. client-side tools).
 */
export interface VercelToolLike {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  execute?: (...args: never[]) => unknown;
  [key: string]: unknown;
}

export function createVercelAdapter(): ToolAdapter<VercelToolLike> {
  return {
    name: "vercel",
    matches(tool) {
      if (typeof tool !== "object" || tool === null) return false;
      const candidate = tool as VercelToolLike;
      const hasSchema = candidate.inputSchema !== undefined || candidate.parameters !== undefined;
      const hasExecute = typeof candidate.execute === "function";
      return hasExecute || (hasSchema && typeof candidate.description === "string");
    },
    describe(tool) {
      const schema = tool.inputSchema ?? tool.parameters;
      const descriptor: ToolDescriptor = { name: String(tool.name ?? "") };
      if (typeof tool.description === "string") descriptor.description = tool.description;
      if (schema !== undefined) descriptor.schema = schema;
      return descriptor;
    },
    wrap(tool, authorizeAndCall) {
      if (typeof tool.execute !== "function") return tool;
      const original = tool.execute;
      return {
        ...tool,
        execute: async (...args: unknown[]) => {
          const first = args[0];
          const normalized =
            typeof first === "object" && first !== null && !Array.isArray(first)
              ? (first as Record<string, unknown>)
              : { value: first };
          await authorizeAndCall(normalized, extractSignal(args));
          return original.apply(tool, args as never[]);
        },
      };
    },
  };
}

export const vercelAdapter = createVercelAdapter();

/**
 * Guard a Vercel AI SDK tool set (a record, array, or single tool).
 *
 * ```ts
 * import { guard } from "@agentghost/vercel";
 * const safeTools = guard(tools, { intent: () => currentTask });
 * const result = await generateText({ model, tools: safeTools, prompt });
 * ```
 */
export const guard = defineGuard([vercelAdapter]);

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
