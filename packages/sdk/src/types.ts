/**
 * Core, framework-agnostic types for AgentGhost.
 *
 * AgentGhost sits between the model's structured tool call and the real tool
 * function. It never asks the model whether it should be invoked: wrapping the
 * tool's execution function means a call inherently passes through AgentGhost.
 */

/** The only three outcomes a protected action can produce. */
export type Decision = "ALLOW" | "ASK" | "DENY";

/** Coarse risk signal returned alongside the decision, useful for audit logs. */
export type RiskLevel = "low" | "medium" | "high";

/** A normalized, adapter-independent view of a tool. */
export interface ToolDescriptor {
  /** Stable tool name, e.g. `delete_repository`. */
  name: string;
  /** Natural-language description shown to the model. */
  description?: string;
  /** Argument schema (JSON Schema, Zod, etc). Never interpreted by core. */
  schema?: unknown;
  /** Adapter-specific extras that adapters may want to surface to a judge. */
  metadata?: Record<string, unknown>;
}

/** What the user is currently trying to accomplish. */
export interface AgentGhostIntent {
  /** The canonical, human-readable statement of intent. */
  text?: string;
  /** Optional short task label, e.g. `refactor auth`. */
  task?: string;
  /** Stable id for the intent, if the host app tracks it. */
  id?: string;
  /** Anything else the judge may find useful. */
  [key: string]: unknown;
}

/**
 * Intent may be supplied eagerly (a string or object) or lazily as a function.
 * The function form is preferred because the user's task changes during a
 * conversation and should be read at call time.
 */
export type IntentInput =
  | string
  | AgentGhostIntent
  | (() => IntentInput | Promise<IntentInput>);

/** The thing AgentGhost is being asked to authorize. */
export interface AgentGhostAction {
  tool: ToolDescriptor;
  args: Record<string, unknown>;
}

/** A record of a previous authorization decision in the same run. */
export interface AgentGhostActionRecord {
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  reason?: string;
  at: number;
}

/** Ambient information about the run the action belongs to. */
export interface AgentGhostContext {
  runId: string;
  previousActions: AgentGhostActionRecord[];
  agent?: unknown;
  metadata: Record<string, unknown>;
}

/** The full request handed to rules, the judge, and every callback. */
export interface AuthorizeRequest {
  intent: AgentGhostIntent;
  action: AgentGhostAction;
  context: AgentGhostContext;
}

/** A resolved authorization outcome. */
export interface Verdict {
  decision: Decision;
  /** Human-readable justification. */
  reason?: string;
  /** Calibrated confidence in [0, 1] when the judge provides one. */
  confidence?: number;
  risk?: RiskLevel;
  /** Which rule or judge produced this verdict. */
  by: string;
  /** Versioned model id that answered, when a model was involved. */
  model?: string;
  latencyMs?: number;
  /** Raw judge payload for logging/debugging. */
  raw?: unknown;
}

/** A pluggable decision engine. The default is backed by Jev. */
export interface Judge {
  readonly name: string;
  judge(request: AuthorizeRequest, signal?: AbortSignal): Promise<JudgeResult>;
}

/** The subset of a verdict a judge is responsible for producing. */
export interface JudgeResult {
  decision: Decision;
  reason?: string;
  confidence?: number;
  risk?: RiskLevel;
  model?: string;
  latencyMs?: number;
  raw?: unknown;
}

/** Deterministic, cheap policy checks that run before the model judge. */
export interface Rule {
  readonly name: string;
  evaluate(request: AuthorizeRequest): RuleResult | null | Promise<RuleResult | null>;
}

export interface RuleResult {
  decision: Decision;
  reason: string;
  confidence?: number;
  risk?: RiskLevel;
}

/** Callback invoked when the judge returns ASK. */
export type AskHandler = (
  request: AuthorizeRequest,
  verdict: Verdict,
) => Decision | void | Promise<Decision | void>;

/** Callback invoked when the judge returns DENY. The action is always blocked. */
export type DenyHandler = (
  request: AuthorizeRequest,
  verdict: Verdict,
) => void | Promise<void>;

export type DecisionHandler = (
  request: AuthorizeRequest,
  verdict: Verdict,
) => void;
