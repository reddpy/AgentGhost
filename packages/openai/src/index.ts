import {
  guardDispatcher,
  type DispatcherTool,
  type GuardOptions,
  type ToolDispatcher,
} from "@agentghost/sdk";

/**
 * OpenAI-style function tool definition.
 * (`ChatCompletionTool` with `type: "function"`.)
 */
export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface GuardOpenAIOptions
  extends Omit<GuardOptions, "adapter" | "tools"> {
  /** The tool definitions passed to the model. */
  tools?: readonly OpenAIFunctionTool[];
}

/** Normalize OpenAI function definitions into AgentGhost dispatcher descriptors. */
export function fromOpenAITools(
  tools: readonly OpenAIFunctionTool[],
): DispatcherTool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    schema: tool.function.parameters,
  }));
}

/**
 * Guard the dispatcher that executes OpenAI tool calls.
 *
 * ```ts
 * const run = guardOpenAI(executeTool, {
 *   tools,
 *   intent: () => currentTask,
 * });
 *
 * for (const call of message.tool_calls ?? []) {
 *   const args = JSON.parse(call.function.arguments);
 *   const result = await run(call.function.name, args);
 *   // ...
 * }
 * ```
 */
export function guardOpenAI(
  execute: ToolDispatcher,
  options: GuardOpenAIOptions,
): ToolDispatcher {
  return guardDispatcher(execute, {
    ...options,
    tools: options.tools ? fromOpenAITools(options.tools) : [],
  });
}

/**
 * Anthropic's tool definitions are flatter: `{ name, description, input_schema }`.
 * The same dispatcher guard applies.
 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface GuardAnthropicOptions
  extends Omit<GuardOptions, "adapter" | "tools"> {
  tools?: readonly AnthropicTool[];
}

export function guardAnthropic(
  execute: ToolDispatcher,
  options: GuardAnthropicOptions,
): ToolDispatcher {
  return guardDispatcher(execute, {
    ...options,
    tools: (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.input_schema,
    })),
  });
}

export type { GuardOptions, ToolDispatcher } from "@agentghost/sdk";
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
