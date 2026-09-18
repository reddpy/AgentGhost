import type { ToolDescriptor } from "./types.js";
import { extractArgs, extractSignal, isFunction, isPlainObject } from "./util.js";

/**
 * Adapters reconcile AgentGhost's single authorization model with each framework's
 * tool shape. The core engine only ever sees a {@link ToolDescriptor} and a
 * normalized args object; adapters do the framework-specific wrapping.
 */

/** Normalized authorization callback passed to an adapter's `wrap`. */
export type AuthorizeAndCall = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<void>;

export interface ToolAdapter<TTool = unknown> {
  readonly name: string;
  /** Cheap structural check: can this adapter wrap the given tool? */
  matches(tool: unknown): boolean;
  /** Normalize the tool into the adapter-independent descriptor. */
  describe(tool: TTool): ToolDescriptor;
  /**
   * Return a copy of the tool whose execution calls `authorizeAndCall` with the
   * raw arguments before invoking the original implementation.
   */
  wrap(tool: TTool, authorizeAndCall: AuthorizeAndCall): TTool;
}

/** Function-valued properties we know how to intercept, in priority order. */
const EXECUTABLE_KEYS = [
  "execute",
  "handler",
  "func",
  "run",
  "call",
  "_call",
  "invoke",
] as const;

export function findExecutableKey(tool: Record<string, unknown>): string | undefined {
  for (const key of EXECUTABLE_KEYS) {
    if (isFunction(tool[key])) return key;
  }
  return undefined;
}

export function isExecutableTool(tool: unknown): boolean {
  return isPlainObject(tool) && findExecutableKey(tool) !== undefined;
}

/**
 * The default adapter. Covers plain objects and the many frameworks whose
 * tools are just `{ name, description, schema, execute }` — including the
 * Vercel AI SDK, Mastra, and most hand-rolled tool registries.
 */
export function createGenericAdapter(): ToolAdapter<Record<string, unknown>> {
  return {
    name: "generic",
    matches: isExecutableTool,
    describe(tool) {
      const schema =
        tool.inputSchema ?? tool.parameters ?? tool.schema ?? tool.input_schema;
      const descriptor: ToolDescriptor = { name: String(tool.name ?? "") };
      if (typeof tool.description === "string") descriptor.description = tool.description;
      if (schema !== undefined) descriptor.schema = schema;
      return descriptor;
    },
    wrap(tool, authorizeAndCall) {
      const key = findExecutableKey(tool);
      if (!key) return tool;
      const original = tool[key] as (...args: unknown[]) => unknown;
      return {
        ...tool,
        [key]: async (...raw: unknown[]) => {
          await authorizeAndCall(extractArgs(raw), extractSignal(raw));
          return original.apply(tool, raw);
        },
      } as Record<string, unknown>;
    },
  };
}

export const genericAdapter = createGenericAdapter();

/** Pick the first adapter that claims the tool. */
export function selectAdapter(
  tool: unknown,
  adapters: readonly ToolAdapter[],
): ToolAdapter | undefined {
  return adapters.find((adapter) => adapter.matches(tool));
}
