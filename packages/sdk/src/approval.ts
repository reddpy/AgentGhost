import type { AskHandler, AuthorizeRequest, Verdict } from "./types.js";

/** Your yes/no function for an ASK decision. */
export type ApprovalDecider = (
  request: AuthorizeRequest,
  verdict: Verdict,
) => boolean | Promise<boolean>;

/**
 * Turn any yes/no function into an ASK handler. The one-line way to wire
 * approval into an app you already have a UI for:
 *
 * ```ts
 * guard(tools, {
 *   intent: () => currentTask,
 *   onAsk: approveWith(async (request, verdict) => myUi.confirm(request, verdict)),
 * });
 * ```
 */
export function approveWith(decide: ApprovalDecider): AskHandler {
  return async (request, verdict) => ((await decide(request, verdict)) ? "ALLOW" : "DENY");
}

export interface TerminalApprovalOptions {
  /** Custom prompt text. Defaults to a readable description of the action. */
  prompt?: (request: AuthorizeRequest, verdict: Verdict) => string;
  /** Approve everything without prompting. Handy for demos and tests. */
  autoApprove?: boolean;
}

/**
 * Batteries-included approval for CLIs and scripts: prompts `y/N` on a TTY and
 * denies when there is no terminal, so unattended runs can never silently
 * approve a consequential action.
 *
 * ```ts
 * import { terminalApproval } from "@agentghost/sdk";
 * guard(tools, { intent: () => currentTask, onAsk: terminalApproval() });
 * ```
 */
export function terminalApproval(options: TerminalApprovalOptions = {}): AskHandler {
  return async (request, verdict) => {
    if (options.autoApprove) return "ALLOW";

    const proc = (
      globalThis as {
        process?: {
          stdin?: { isTTY?: boolean };
          stdout?: unknown;
        };
      }
    ).process;
    if (!proc?.stdin?.isTTY) return "DENY";

    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({
      input: proc.stdin as NodeJS.ReadStream,
      output: proc.stdout as NodeJS.WritableStream,
    });
    try {
      const message =
        options.prompt?.(request, verdict) ??
        `Allow ${request.action.tool.name}?${verdict.reason ? ` (${verdict.reason})` : ""}`;
      const answer = (await rl.question(`\n${message} [y/N] `)).trim();
      return /^y(es)?$/i.test(answer) ? "ALLOW" : "DENY";
    } finally {
      rl.close();
    }
  };
}
