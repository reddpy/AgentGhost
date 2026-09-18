import type { AuthorizeRequest, Verdict } from "./types.js";

/** Base class for every error AgentGhost throws. */
export class AgentGhostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a protected action is denied. Carries the full request and
 * verdict so hosts can render a useful message or audit entry.
 */
export class AgentGhostDeniedError extends AgentGhostError {
  readonly request: AuthorizeRequest;
  readonly verdict: Verdict;

  constructor(request: AuthorizeRequest, verdict: Verdict) {
    super(
      `AgentGhost denied tool "${request.action.tool.name}"` +
        (verdict.reason ? `: ${verdict.reason}` : ""),
    );
    this.request = request;
    this.verdict = verdict;
  }
}

/**
 * Thrown by the default ASK handler. Hosts catch this to surface an approval
 * prompt, then retry the tool call once the human has decided.
 */
export class AgentGhostApprovalRequiredError extends AgentGhostError {
  readonly request: AuthorizeRequest;
  readonly verdict: Verdict;

  constructor(request: AuthorizeRequest, verdict: Verdict) {
    super(
      `AgentGhost requires approval before running tool "${request.action.tool.name}"` +
        (verdict.reason ? `: ${verdict.reason}` : "") +
        " (provide `onAsk`, e.g. `approveWith(...)` or `terminalApproval()`, to handle it).",
    );
    this.request = request;
    this.verdict = verdict;
  }
}

/** Thrown when AgentGhost is misconfigured (e.g. no TypeSafe API key). */
export class AgentGhostConfigError extends AgentGhostError {}
