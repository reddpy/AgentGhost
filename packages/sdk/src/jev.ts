import { AgentGhostConfigError, AgentGhostError } from "./errors.js";
import {
  buildQuestions,
  buildState,
  interpretAnswers,
  type InterpretOptions,
  type JevQuestions,
  type SystemOneClient,
  type SystemOneInput,
  type SystemOneResponse,
} from "./judge.js";
import type { AuthorizeRequest, Judge } from "./types.js";
import { getEnv, sleep } from "./util.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_GATEWAY_MODEL = "typesafe-ai/jev";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_STATE_BUDGET = 24_000;

export interface JevJudgeOptions extends InterpretOptions {
  /** Bring your own `@typesafe-ai/sdk` client. Takes precedence over fetch. */
  client?: SystemOneClient;
  /** Defaults to TYPESAFE_API_KEY, then TYPESAFE_AI_API_KEY. */
  apiKey?: string;
  /** Defaults to https://api.typesafe.ai */
  baseUrl?: string;
  /** Defaults to `jev-latest`. Pin a versioned id for reproducible behavior. */
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Character budget for the serialized state. */
  stateBudget?: number;
  fetch?: typeof fetch;
}

/**
 * The default AgentGhost judge, backed by TypeSafe's Jev System One model.
 *
 * Jev returns typed, calibrated answers, which is exactly what an
 * authorization check needs: a bounded decision plus a confidence we can
 * threshold. It is also fast (~100ms) and cheap ($0.042 / M input tokens),
 * which matters because AgentGhost runs on the hot path of every tool call.
 */
export function createJevJudge(options: JevJudgeOptions = {}): Judge {
  const client = options.client ?? createFetchClient(options);
  const model = options.model ?? DEFAULT_MODEL;
  const stateBudget = options.stateBudget ?? DEFAULT_STATE_BUDGET;
  const questions = buildQuestions();

  return {
    name: "jev",
    async judge(request: AuthorizeRequest, signal?: AbortSignal) {
      const started = Date.now();
      const state = buildState(request, stateBudget);
      const response = await client.systemOne({ model, state, questions }, { signal });
      const interpreted = interpretAnswers(response.answers, options);
      return {
        ...interpreted,
        model: response.model,
        latencyMs: Date.now() - started,
        raw: response,
      };
    },
  };
}

/** Build a Jev judge from a raw client, for tests or custom transports. */
export function createJevJudgeFromClient(
  client: SystemOneClient,
  options: Omit<JevJudgeOptions, "client" | "fetch" | "baseUrl" | "apiKey"> = {},
): Judge {
  return createJevJudge({ ...options, client });
}

export interface AiSdkEvaluate {
  (args: {
    model: unknown;
    state: unknown;
    questions: Record<string, unknown>;
    providerOptions?: unknown;
  }): Promise<{ answers: Record<string, unknown>; providerMetadata?: unknown }>;
}

export interface GatewayJudgeOptions extends InterpretOptions {
  /**
   * Gateway evaluation model id. Defaults to `typesafe-ai/jev`.
   * Use `typesafe-ai/jev-1.13.0` to pin a version.
   */
  model?: string;
  /**
   * Vercel AI Gateway key. Defaults to `AI_GATEWAY_API_KEY`. If provided and
   * the env var is unset, AgentGhost sets it for the AI SDK to pick up.
   */
  apiKey?: string;
  /** Pre-resolved `experimental_evaluate` — mainly for tests/bundlers. */
  evaluate?: AiSdkEvaluate;
  /** Passed through as `providerOptions` (e.g. `{ gateway: { zeroDataRetention: true } }`). */
  providerOptions?: Record<string, unknown>;
  stateBudget?: number;
}

let cachedEvaluate: AiSdkEvaluate | undefined;

/**
 * The default judge when only a Vercel AI Gateway key is available.
 *
 * Jev is reachable through the Gateway only via AI SDK 7's
 * `experimental_evaluate`, so this lazily imports `ai` on first use. Auth comes
 * from `AI_GATEWAY_API_KEY` (or the `apiKey` option). The default model id is
 * `typesafe-ai/jev`.
 */
export function createGatewayJudge(options: GatewayJudgeOptions = {}): Judge {
  const model = options.model ?? DEFAULT_GATEWAY_MODEL;
  const stateBudget = options.stateBudget ?? DEFAULT_STATE_BUDGET;

  if (options.apiKey && !getEnv("AI_GATEWAY_API_KEY")) {
    const proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
    if (proc?.env) proc.env.AI_GATEWAY_API_KEY = options.apiKey;
  }

  return {
    name: "jev",
    async judge(request: AuthorizeRequest) {
      const started = Date.now();
      const evaluate = options.evaluate ?? (await loadEvaluate());
      const state = buildState(request, stateBudget);
      const questions = toAiSdkQuestions(buildQuestions());
      const result = await evaluate({
        model,
        state,
        questions,
        providerOptions: options.providerOptions,
      });
      const answers = fromAiSdkAnswers(result.answers, result.providerMetadata);
      const interpreted = interpretAnswers(answers, options);
      return {
        ...interpreted,
        model,
        latencyMs: Date.now() - started,
        raw: result,
      };
    },
  };
}

/** A Jev transport AgentGhost knows how to talk to out of the box. */
export type JudgeKind = "gateway" | "typesafe";

/**
 * Read the requested judge provider from `AGENTGHOST_JUDGE`. Accepts `"gateway"`
 * (Vercel AI Gateway) or `"typesafe"` (TypeSafe direct API). Throws on an
 * unknown value so typos fail fast instead of silently picking a provider.
 */
export function resolveJudgeKind(): JudgeKind | undefined {
  const value = getEnv("AGENTGHOST_JUDGE")?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "gateway" || value === "vercel") return "gateway";
  if (value === "typesafe" || value === "direct" || value === "jev") return "typesafe";
  throw new AgentGhostConfigError(
    `Unknown AGENTGHOST_JUDGE="${value}". Use "gateway" (Vercel AI Gateway) or "typesafe" (direct).`,
  );
}

/**
 * Whether a built-in judge can be created from the environment. Honors an
 * explicit `AGENTGHOST_JUDGE`; otherwise any known key counts.
 */
export function isJudgeConfigured(): boolean {
  const kind = resolveJudgeKind();
  if (kind === "gateway") return Boolean(getEnv("AI_GATEWAY_API_KEY"));
  if (kind === "typesafe") return Boolean(directApiKey());
  return Boolean(getEnv("AI_GATEWAY_API_KEY") ?? directApiKey());
}

/**
 * Pick the judge to use when none is supplied. Precedence:
 *
 * 1. `AGENTGHOST_JUDGE=gateway` -> Vercel AI Gateway
 * 2. `AGENTGHOST_JUDGE=typesafe` -> TypeSafe direct API
 * 3. otherwise `AI_GATEWAY_API_KEY`, then `TYPESAFE_API_KEY`
 * 4. fall back to the Gateway so the error points at the common path
 *
 * To use a different gateway or decision model, pass your own `judge` to
 * `guard()` — see `createJevJudge`, `createJevJudgeFromEvaluate`, and
 * `defineJudge`.
 */
export function createDefaultJudge(): Judge {
  const kind = resolveJudgeKind();
  if (kind === "gateway") return createGatewayJudge();
  if (kind === "typesafe") return createJevJudge();
  if (getEnv("AI_GATEWAY_API_KEY")) return createGatewayJudge();
  if (directApiKey()) return createJevJudge();
  return createGatewayJudge();
}

function directApiKey(): string | undefined {
  return getEnv("TYPESAFE_API_KEY") ?? getEnv("TYPESAFE_AI_API_KEY");
}

/**
 * Use Jev through the Vercel AI SDK's `experimental_evaluate` with a model you
 * resolved yourself, e.g. `typeSafeAi.evaluationModel("jev-latest")` or a
 * Gateway provider instance.
 */
export function createJevJudgeFromEvaluate(config: {
  evaluate: AiSdkEvaluate;
  model: unknown;
  interpret?: InterpretOptions;
  providerOptions?: Record<string, unknown>;
  stateBudget?: number;
}): Judge {
  const { evaluate, model } = config;
  const options = config.interpret ?? {};
  const stateBudget = config.stateBudget ?? DEFAULT_STATE_BUDGET;
  return {
    name: "jev",
    async judge(request: AuthorizeRequest) {
      const started = Date.now();
      const state = buildState(request, stateBudget);
      const questions = toAiSdkQuestions(buildQuestions());
      const result = await evaluate({ model, state, questions, providerOptions: config.providerOptions });
      const answers = fromAiSdkAnswers(result.answers, result.providerMetadata);
      const interpreted = interpretAnswers(answers, options);
      return {
        ...interpreted,
        model: typeof model === "string" ? model : "typesafe-ai/jev",
        latencyMs: Date.now() - started,
        raw: result,
      };
    },
  };
}

async function loadEvaluate(): Promise<AiSdkEvaluate> {
  if (cachedEvaluate) return cachedEvaluate;
  const specifier = "ai";
  try {
    const mod = (await import(specifier)) as { experimental_evaluate?: AiSdkEvaluate };
    if (typeof mod.experimental_evaluate !== "function") {
      throw new Error("`experimental_evaluate` is not exported");
    }
    cachedEvaluate = mod.experimental_evaluate;
    return cachedEvaluate;
  } catch (error) {
    throw new AgentGhostConfigError(
      "Jev through Vercel AI Gateway requires the `ai` package (AI SDK 7.0.105+). " +
        "Install it with `npm install ai` and set AI_GATEWAY_API_KEY, or pass a " +
        "custom `judge` / use createJevJudge() for TypeSafe's direct API. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function toAiSdkQuestions(questions: JevQuestions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      out[id] = {
        type: "boolean",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    } else {
      out[id] = question;
    }
  }
  return out;
}

function fromAiSdkAnswers(
  answers: Record<string, unknown>,
  providerMetadata: unknown,
): Record<string, import("./judge.js").JevAnswer> {
  const confidenceByQuestion =
    (providerMetadata as { typesafe?: { confidence?: Record<string, number> } })
      ?.typesafe?.confidence ?? {};
  const out: Record<string, import("./judge.js").JevAnswer> = {};
  for (const [id, raw] of Object.entries(answers)) {
    const answer = raw as Record<string, unknown>;
    if (typeof answer.probability === "number") {
      out[id] = { type: "noul", noul: answer.probability };
      continue;
    }
    if (typeof answer.choice === "string") {
      out[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: (answer.probabilities as Record<string, number>) ?? {},
        confidence: confidenceByQuestion[id] ?? (answer.confidence as number) ?? 0,
      };
      continue;
    }
    if (typeof answer.score === "number") {
      out[id] = {
        type: "score",
        score: answer.score,
        confidence: confidenceByQuestion[id] ?? (answer.confidence as number) ?? 0,
        legend: (answer.legend as Record<string, string>) ?? {},
        probabilities: (answer.probabilities as Record<string, number>) ?? {},
      };
    }
  }
  return out;
}

interface FetchClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

function createFetchClient(options: FetchClientOptions): SystemOneClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);

  return {
    async systemOne(input: SystemOneInput, callOptions): Promise<SystemOneResponse> {
      const apiKey =
        options.apiKey ?? getEnv("TYPESAFE_API_KEY") ?? getEnv("TYPESAFE_AI_API_KEY");
      if (!apiKey) {
        throw new AgentGhostConfigError(
          "No TypeSafe API key found. Set TYPESAFE_API_KEY, pass `apiKey`, " +
            "use `client`, or provide a custom `judge`.",
        );
      }
      if (!fetchImpl) {
        throw new AgentGhostConfigError("No global fetch available. Pass `fetch` or `client`.");
      }

      const signal = callOptions?.signal;
      const timeout = callOptions?.timeout ?? timeoutMs;
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("AgentGhost judge timed out")), timeout);
        try {
          const response = await fetchImpl(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(input),
            signal: controller.signal,
          });
          if (response.status === 429 || response.status === 529) {
            lastError = new AgentGhostError(`TypeSafe overloaded (HTTP ${response.status})`);
          } else if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new AgentGhostError(
              `TypeSafe request failed (HTTP ${response.status})${body ? `: ${body}` : ""}`,
            );
          } else {
            return (await response.json()) as SystemOneResponse;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
          if (error instanceof AgentGhostConfigError) throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
        if (attempt < maxRetries) {
          await sleep(150 * 2 ** attempt, signal);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new AgentGhostError("TypeSafe request failed");
    },
  };
}
