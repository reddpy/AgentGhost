import { createGuardEngine, type GuardOptions } from "./engine.js";
import type { ToolAdapter } from "./adapter.js";
import { AgentGhostConfigError } from "./errors.js";
import type { AuthorizeRequest, Judge, Rule, Verdict } from "./types.js";
import { safeStringify } from "./util.js";

/**
 * Wrap one or more tools so every execution passes an intent-aware
 * authorization check first.
 *
 * ```ts
 * const safeTools = guard(tools, { intent: () => currentTask });
 * ```
 *
 * Accepts a single tool, an array of tools, or a `Record<string, Tool>`.
 * Returns the same shape with each protected tool's execution function
 * replaced by a wrapper that calls AgentGhost before the real implementation.
 */
export function guard<T>(tools: T, options: GuardOptions): T {
  return createGuardEngine(options).guardTools(tools);
}

/**
 * Build a framework-specific `guard()` from one or more adapters. Used by the
 * integration packages; adapter authors can use it to support a new framework:
 *
 * ```ts
 * export const guard = defineGuard(myAdapter);
 * ```
 */
export function defineGuard(
  adapters: ToolAdapter | ToolAdapter[],
): <T>(tools: T, options: GuardOptions) => T {
  return function guardWithAdapters<T>(tools: T, options: GuardOptions): T {
    return createGuardEngine({ ...options, adapter: adapters }).guardTools(tools);
  };
}

/** A tool definition as seen by a dispatch-based provider (OpenAI, Anthropic). */
export interface DispatcherTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  schema?: unknown;
}

/** Maps a tool call to its result. */
export type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

/**
 * Wrap a dispatcher function instead of the tools themselves. This is the
 * integration point for providers that hand the model a list of schemas and
 * expect the host to execute the call.
 *
 * ```ts
 * const run = guardDispatcher(execute, { tools, intent: () => currentTask });
 * ```
 */
export function guardDispatcher(
  execute: ToolDispatcher,
  options: GuardOptions & { tools?: readonly DispatcherTool[] },
): ToolDispatcher {
  const engine = createGuardEngine(options);
  const descriptors = new Map(
    (options.tools ?? []).map((tool) => [
      tool.name,
      { name: tool.name, description: tool.description, schema: tool.schema },
    ]),
  );

  return async (name, args, signal) => {
    const descriptor = descriptors.get(name) ?? { name };
    if (engine.shouldProtect(descriptor)) {
      await engine.authorize(descriptor, args, signal);
    }
    return execute(name, args);
  };
}

export interface AuthorizeOptions {
  judge?: Judge;
  rules?: Rule[];
  failMode?: "open" | "closed";
}

/**
 * Low-level, callback-free authorization. Runs the deterministic rules, then
 * the judge, and returns the verdict. Use this when you already have your own
 * middleware pipeline and just want AgentGhost's decision.
 */
export async function authorize(
  request: AuthorizeRequest,
  options: AuthorizeOptions = {},
): Promise<Verdict> {
  for (const rule of options.rules ?? []) {
    try {
      const result = await rule.evaluate(request);
      if (result) return { ...result, by: `rule:${rule.name}` };
    } catch (error) {
      return fail(`rule:${rule.name}`, error, options.failMode ?? "closed");
    }
  }

  const judge = options.judge;
  if (!judge) {
    return fail(
      "judge",
      new AgentGhostConfigError("authorize() requires a `judge` or a matching `rule`."),
      options.failMode ?? "closed",
    );
  }
  try {
    const result = await judge.judge(request);
    return { ...result, by: `judge:${judge.name}` };
  } catch (error) {
    return fail(`judge:${judge.name}`, error, options.failMode ?? "closed");
  }
}

function fail(source: string, error: unknown, failMode: "open" | "closed"): Verdict {
  const message = error instanceof Error ? error.message : safeStringify(error);
  if (failMode === "open") {
    return { decision: "ALLOW", by: "fail-open", reason: `${source} failed (${message}).` };
  }
  return { decision: "DENY", by: "fail-closed", reason: `${source} failed (${message}).` };
}
