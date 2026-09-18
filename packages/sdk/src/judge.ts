import type { AuthorizeRequest, Judge, JudgeResult } from "./types.js";
import { safeStringify, truncate } from "./util.js";

/**
 * Helpers for building custom judges. The built-in Jev judge lives in
 * `jev.ts`; these utilities keep the request -> model-state mapping out of the
 * core engine and reusable by anyone writing their own.
 */

/** The question primitives Jev understands. */
export type JevQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: string | Record<string, string>;
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: (string | { what: string; examples?: string[] })[];
    };

export type JevQuestions = Record<string, JevQuestion>;

export interface JevAnswerNoul {
  type: "noul";
  noul: number;
}

export interface JevAnswerChoice {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevAnswerScore {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type JevAnswer = JevAnswerNoul | JevAnswerChoice | JevAnswerScore;

export interface SystemOneInput {
  model?: string;
  state: unknown;
  questions: JevQuestions;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The minimal client shape AgentGhost needs; matches `@typesafe-ai/sdk`. */
export interface SystemOneClient {
  systemOne(
    input: SystemOneInput,
    options?: { timeout?: number; signal?: AbortSignal; retry?: unknown },
  ): Promise<SystemOneResponse>;
}

/** Build the shared state object handed to the judge. */
export function buildState(request: AuthorizeRequest, maxChars: number): Record<string, unknown> {
  const { intent, action, context } = request;
  const state: Record<string, unknown> = {
    intent: intent.text ?? intent.task ?? safeStringify(intent),
    action: {
      tool: action.tool.name,
      description: action.tool.description,
      arguments: action.args,
    },
  };
  if (action.tool.schema !== undefined) {
    state.action_schema = truncate(safeStringify(action.tool.schema), 2_000);
  }
  if (context.previousActions.length > 0) {
    state.recent_actions = context.previousActions.slice(-5).map((record) => ({
      tool: record.tool,
      decision: record.decision,
    }));
  }

  if (safeStringify(state).length <= maxChars) return state;

  return {
    intent: truncate(String(state.intent), 2_000),
    action: {
      tool: action.tool.name,
      description: action.tool.description,
      arguments: truncate(safeStringify(action.args), Math.max(1_000, maxChars - 3_000)),
    },
    note: "state truncated to fit the judge budget",
  };
}

/**
 * The default decision questions. A single `choice` carries the verdict, and
 * the supporting `noul`/`score` answers give the audit trail its reasons.
 */
export function buildQuestions(): JevQuestions {
  return {
    decision: {
      type: "choice",
      instructions:
        "An autonomous agent proposes `action` to make progress on `intent`. " +
        "Decide what must happen before `action` executes. " +
        "Choose `allow` when the action clearly serves `intent` and is safe and reversible. " +
        "Choose `ask` when the action plausibly serves `intent` but is consequential: " +
        "irreversible, deletes or overwrites data, spends money, contacts real people, " +
        "changes production, or grants access. " +
        "Choose `deny` when the action does not serve `intent`, is out of scope, or would cause harm.",
      criteria: {
        allow: "Clearly serves `intent`, low risk, read-only or reversible.",
        ask: "Plausibly serves `intent` but is consequential or irreversible and should be confirmed by a human.",
        deny: "Does not serve `intent`, is out of scope, malicious, or clearly harmful.",
      },
    },
    serves_intent: {
      type: "noul",
      instructions: "Does `action` directly serve the user's `intent`?",
    },
    reversible: {
      type: "noul",
      instructions:
        "Can the effect of `action` be fully undone or reversed, and is it read-only or idempotent?",
    },
    risk: {
      type: "score",
      instructions: "How much harm could `action` cause if `intent` were wrong or the action failed?",
      criteria: [
        "No lasting harm. Read-only or trivially reversible.",
        "Limited, recoverable impact. Can be fixed with effort.",
        "Severe or externally visible impact that is hard or impossible to undo.",
      ],
    },
  };
}

export interface InterpretOptions {
  confidenceFloor?: number;
  intentFloor?: number;
}

/** Turn raw Jev answers into a normalized judge result. */
export function interpretAnswers(
  answers: Record<string, JevAnswer>,
  options: InterpretOptions = {},
): JudgeResult {
  const confidenceFloor = options.confidenceFloor ?? 0.4;
  const intentFloor = options.intentFloor ?? 0.5;

  const decisionAnswer = answers.decision;
  const serves = answers.serves_intent;
  const reversible = answers.reversible;
  const risk = answers.risk;

  const servesIntent = serves?.type === "noul" ? serves.noul : 1;
  const isReversible = reversible?.type === "noul" ? reversible.noul : 0.5;
  const riskScore = risk?.type === "score" ? risk.score : 1;
  const confidence = decisionAnswer?.type === "choice" ? decisionAnswer.confidence : undefined;

  let decision: JudgeResult["decision"] = "ASK";
  const reasons: string[] = [];

  if (decisionAnswer?.type === "choice") {
    if (decisionAnswer.choice === "allow") decision = "ALLOW";
    else if (decisionAnswer.choice === "deny") decision = "DENY";
    else decision = "ASK";
  } else {
    reasons.push("judge did not return a decision");
  }

  if (decision === "ALLOW" && servesIntent < intentFloor) {
    decision = "DENY";
    reasons.push("does not appear to serve the current intent");
  }
  if (
    decision === "ALLOW" &&
    confidence !== undefined &&
    confidence < confidenceFloor
  ) {
    decision = "ASK";
    reasons.push("judge confidence is below the auto-allow floor");
  }
  if (decision === "ALLOW" && riskScore >= 2 && isReversible < 0.5) {
    decision = "ASK";
    reasons.push("high-impact and hard to reverse");
  }

  if (decision === "ASK" && reasons.length === 0) {
    reasons.push("judge flagged the action as requiring confirmation");
  }
  if (decision === "DENY" && reasons.length === 0) {
    reasons.push("judge flagged the action as out of scope or harmful");
  }

  const riskLevel: JudgeResult["risk"] =
    riskScore >= 2 ? "high" : riskScore >= 1 ? "medium" : "low";

  const result: JudgeResult = {
    decision,
    reason: reasons.join("; "),
    confidence,
    risk: riskLevel,
  };
  if (serves?.type === "noul") {
    result.reason = `${result.reason} (serves_intent=${serves.noul.toFixed(2)}, reversible=${isReversible.toFixed(2)})`;
  }
  return result;
}

/** Adapt any judge function into the {@link Judge} interface. */
export function defineJudge(
  name: string,
  judge: Judge["judge"],
): Judge {
  return { name, judge };
}
