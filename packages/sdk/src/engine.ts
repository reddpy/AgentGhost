import {
  genericAdapter,
  isExecutableTool,
  selectAdapter,
  type AuthorizeAndCall,
  type ToolAdapter,
} from "./adapter.js";
import { AgentGhostApprovalRequiredError, AgentGhostConfigError, AgentGhostDeniedError } from "./errors.js";
import { createDefaultJudge, isJudgeConfigured } from "./jev.js";
import { allowTools, askTools, denyTools } from "./rules.js";
import type {
  AskHandler,
  AuthorizeRequest,
  DecisionHandler,
  DenyHandler,
  AgentGhostActionRecord,
  AgentGhostContext,
  AgentGhostIntent,
  IntentInput,
  Judge,
  Rule,
  ToolDescriptor,
  Verdict,
} from "./types.js";
import { isPlainObject, now, resolve, safeStringify } from "./util.js";

export interface GuardOptions {
  /**
   * What the user is trying to do. Prefer the function form so the task is
   * read at call time: `intent: () => currentTask`.
   */
  intent: IntentInput;
  /**
   * Decision engine. Defaults to Jev, configured from `AI_GATEWAY_API_KEY`
   * (Vercel AI Gateway) or `TYPESAFE_API_KEY` (TypeSafe direct). Pass your own
   * `Judge`, or `null` to run rules-only and never call a model.
   */
  judge?: Judge | null;
  /** Deterministic checks that run before the judge and can short-circuit it. */
  rules?: Rule[];
  /** Tool names that always skip the judge (e.g. read-only tools). */
  allow?: string[];
  /** Tool names that always require approval. */
  ask?: string[];
  /** Tool names that are always blocked. */
  deny?: string[];
  /**
   * Which tools to protect. By default every tool AgentGhost can wrap is protected.
   * Pass an allow-list of names or a predicate.
   */
  protect?: string[] | ((tool: ToolDescriptor) => boolean);
  /** Called on ASK. Return "ALLOW" to proceed or "DENY" to block. */
  onAsk?: AskHandler;
  /**
   * Notification hook called on DENY before the error is thrown. The action is
   * always blocked; throw here to customize the error the caller sees.
   */
  onDeny?: DenyHandler;
  /** Behavior when a rule or the judge throws. Default "closed" (deny). */
  failMode?: "open" | "closed";
  /** Cache identical (intent, tool, args) decisions. Default "always". */
  evaluate?: "always" | "once";
  /** How many past actions to keep in context. Default 50. */
  historyLimit?: number;
  /** Explicit run id, or a getter. */
  runId?: string | (() => string);
  /** Static metadata attached to every authorization context. */
  context?: Record<string, unknown>;
  /** Opaque agent handle surfaced to judges and audit logs. */
  agent?: unknown;
  /** Audit hook invoked with every resolved verdict. */
  onDecision?: DecisionHandler;
  /** Called for tools no adapter can wrap (e.g. provider-hosted tools). */
  onUnprotected?: (tool: unknown) => void;
  /** Extra adapters, tried before the built-in generic adapter. */
  adapter?: ToolAdapter | ToolAdapter[];
}

export interface GuardEngine {
  authorize(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Verdict>;
  /** Normalize + protect a single tool, returning a wrapped copy. */
  guardTool(tool: unknown, nameHint?: string): unknown;
  /** Normalize + protect an array, record, or single tool. */
  guardTools<T>(tools: T): T;
  /** True when the given descriptor is in scope for this guard. */
  shouldProtect(tool: ToolDescriptor): boolean;
  readonly adapters: readonly ToolAdapter[];
}

export function createGuardEngine(options: GuardOptions): GuardEngine {
  const adapters = normalizeAdapters(options.adapter);
  const failMode = options.failMode ?? "closed";
  const evaluateMode = options.evaluate ?? "always";
  // `allow`/`ask`/`deny` are shorthands. Hard blocks win over user rules, and
  // `allow` is a last-resort fast path so it can never silently bypass a rule.
  const rules: Rule[] = [
    ...(options.deny?.length ? [denyTools(options.deny)] : []),
    ...(options.ask?.length ? [askTools(options.ask)] : []),
    ...(options.rules ?? []),
    ...(options.allow?.length ? [allowTools(options.allow)] : []),
  ];
  const rulesOnly = options.judge === null;
  const history: AgentGhostActionRecord[] = [];
  const historyLimit = options.historyLimit ?? 50;
  const cache = new Map<string, Verdict>();
  const cacheLimit = 500;
  const shouldProtect = resolveProtector(options.protect);
  const defaultRunId = `agentghost_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let judge: Judge | undefined = options.judge ?? undefined;

  if (options.judge === undefined && failMode !== "open") assertJudgeAvailable();

  function getJudge(): Judge | undefined {
    if (rulesOnly) return undefined;
    if (!judge) judge = createDefaultJudge();
    return judge;
  }

  async function buildRequest(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
  ): Promise<AuthorizeRequest> {
    const intent = normalizeIntent(await resolve(options.intent));
    const context: AgentGhostContext = {
      runId: typeof options.runId === "function" ? options.runId() : options.runId ?? defaultRunId,
      previousActions: [...history],
      metadata: options.context ?? {},
    };
    if (options.agent !== undefined) context.agent = options.agent;
    return { intent, action: { tool, args }, context };
  }

  async function decide(request: AuthorizeRequest, signal?: AbortSignal): Promise<Verdict> {
    for (const rule of rules) {
      try {
        const result = await rule.evaluate(request);
        if (result) return { ...result, by: `rule:${rule.name}` };
      } catch (error) {
        return failureVerdict(`rule:${rule.name}`, error);
      }
    }

    const cacheKey =
      evaluateMode === "once"
        ? `${safeStringify(request.intent)}|${request.action.tool.name}|${safeStringify(request.action.args)}`
        : undefined;
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    }

    const activeJudge = getJudge();
    if (!activeJudge) {
      return {
        decision: "DENY",
        by: "no-judge",
        reason: "No judge configured and no rule matched this action.",
      };
    }
    try {
      const result = await activeJudge.judge(request, signal);
      const verdict: Verdict = { ...result, by: `judge:${activeJudge.name}` };
      if (cacheKey) {
        cache.set(cacheKey, verdict);
        if (cache.size > cacheLimit) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      return verdict;
    } catch (error) {
      return failureVerdict(`judge:${activeJudge.name}`, error);
    }
  }

  function failureVerdict(source: string, error: unknown): Verdict {
    const message = error instanceof Error ? error.message : String(error);
    if (failMode === "open") {
      return {
        decision: "ALLOW",
        by: "fail-open",
        reason: `${source} failed (${message}); allowed by failMode="open".`,
      };
    }
    return {
      decision: "DENY",
      by: "fail-closed",
      reason: `${source} failed (${message}); denied by failMode="closed".`,
    };
  }

  async function finalize(request: AuthorizeRequest, verdict: Verdict): Promise<Verdict> {
    if (verdict.decision === "ALLOW") return verdict;

    if (verdict.decision === "ASK") {
      if (!options.onAsk) throw new AgentGhostApprovalRequiredError(request, verdict);
      const outcome = await options.onAsk(request, verdict);
      if (outcome === "ALLOW") {
        return { ...verdict, decision: "ALLOW", reason: appendReason(verdict.reason, "approved by host") };
      }
      if (outcome === "DENY") return deny(request, verdict);
      throw new AgentGhostApprovalRequiredError(request, verdict);
    }

    return deny(request, verdict);
  }

  async function deny(request: AuthorizeRequest, verdict: Verdict): Promise<Verdict> {
    // onDeny is a notification hook, not an override: a DENY always blocks.
    // Throw your own error from it to customize what the caller sees.
    if (options.onDeny) await options.onDeny(request, verdict);
    throw new AgentGhostDeniedError(request, verdict);
  }

  async function authorize(
    tool: ToolDescriptor,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Verdict> {
    const request = await buildRequest(tool, args);
    const verdict = await decide(request, signal);
    history.push({
      tool: tool.name,
      args,
      decision: verdict.decision,
      reason: verdict.reason,
      at: now(),
    });
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    options.onDecision?.(request, verdict);
    return finalize(request, verdict);
  }

  function guardTool(tool: unknown, nameHint?: string): unknown {
    const adapter = selectAdapter(tool, adapters);
    if (!adapter) {
      options.onUnprotected?.(tool);
      return tool;
    }
    const descriptor = adapter.describe(tool);
    if (!descriptor.name) descriptor.name = nameHint ?? "anonymous_tool";
    if (!shouldProtect(descriptor)) return tool;
    const authorizeAndCall: AuthorizeAndCall = (args, signal) =>
      authorize(descriptor, args, signal).then(() => undefined);
    return adapter.wrap(tool, authorizeAndCall);
  }

  function guardTools<T>(tools: T): T {
    if (Array.isArray(tools)) {
      return tools.map((tool) => guardTool(tool)) as unknown as T;
    }
    if (isPlainObject(tools) && !isToolDescriptor(tools)) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(tools)) {
        out[key] = guardTool(value, key);
      }
      return out as unknown as T;
    }
    return guardTool(tools) as T;
  }

  return {
    authorize,
    guardTool,
    guardTools,
    shouldProtect,
    adapters,
  };
}

function normalizeAdapters(
  adapter: ToolAdapter | ToolAdapter[] | undefined,
): readonly ToolAdapter[] {
  if (!adapter) return [genericAdapter];
  const list = Array.isArray(adapter) ? [...adapter] : [adapter];
  if (!list.some((candidate) => candidate.name === genericAdapter.name)) {
    list.push(genericAdapter);
  }
  return list;
}

function resolveProtector(
  protect: GuardOptions["protect"],
): (tool: ToolDescriptor) => boolean {
  if (!protect) return () => true;
  if (typeof protect === "function") return protect;
  const set = new Set(protect);
  return (tool) => set.has(tool.name);
}

/**
 * Fail fast on missing configuration instead of silently denying every tool at
 * call time. Skipped when a judge is supplied, when `judge: null` requests
 * rules-only mode, or when `failMode: "open"` opts out of hard failure.
 */
function assertJudgeAvailable(): void {
  if (isJudgeConfigured()) return;
  throw new AgentGhostConfigError(
    "AgentGhost has no judge configured. Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or " +
      "TYPESAFE_API_KEY (TypeSafe direct), set AGENTGHOST_JUDGE to choose between them, " +
      "pass a custom `judge`, or pass `judge: null` to run rules-only.",
  );
}

function normalizeIntent(intent: IntentInput): AgentGhostIntent {
  if (typeof intent === "string") return { text: intent };
  if (typeof intent === "function") return { text: safeStringify(intent) };
  return intent;
}

function isToolDescriptor(value: Record<string, unknown>): boolean {
  if (isExecutableTool(value)) return true;
  if (value.type === "function") return true;
  return (
    typeof value.name === "string" &&
    (value.parameters !== undefined || value.input_schema !== undefined) &&
    typeof value.execute !== "function"
  );
}

function appendReason(reason: string | undefined, extra: string): string {
  return reason ? `${reason}; ${extra}` : extra;
}
