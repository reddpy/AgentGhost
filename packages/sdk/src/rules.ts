import type { AuthorizeRequest, Rule, RuleResult } from "./types.js";
import { safeStringify } from "./util.js";

/**
 * Rules are the deterministic first pass: cheap, synchronous, and auditable.
 * If a rule returns a result, the model judge is skipped entirely. This is how
 * you hard-code "never delete a production table" without paying for a model
 * round-trip or hoping the model agrees.
 */

/** Always DENY these tool names. */
export function denyTools(names: readonly string[], reason?: string): Rule {
  const set = new Set(names);
  return {
    name: `denyTools(${names.join(",")})`,
    evaluate({ action }) {
      if (!set.has(action.tool.name)) return null;
      return {
        decision: "DENY",
        reason: reason ?? `Tool "${action.tool.name}" is never allowed.`,
        risk: "high",
        confidence: 1,
      };
    },
  };
}

/** Always ASK before these tool names run. */
export function askTools(names: readonly string[], reason?: string): Rule {
  const set = new Set(names);
  return {
    name: `askTools(${names.join(",")})`,
    evaluate({ action }) {
      if (!set.has(action.tool.name)) return null;
      return {
        decision: "ASK",
        reason: reason ?? `Tool "${action.tool.name}" requires confirmation.`,
        risk: "medium",
        confidence: 1,
      };
    },
  };
}

/**
 * Always ALLOW these tool names, skipping the judge. Use sparingly and only
 * for provably safe, read-only tools.
 */
export function allowTools(names: readonly string[], reason?: string): Rule {
  const set = new Set(names);
  return {
    name: `allowTools(${names.join(",")})`,
    evaluate({ action }) {
      if (!set.has(action.tool.name)) return null;
      return {
        decision: "ALLOW",
        reason: reason ?? `Tool "${action.tool.name}" is trusted.`,
        risk: "low",
        confidence: 1,
      };
    },
  };
}

export interface ArgPatternOptions {
  /** Restrict to a single tool. Omit to match any tool. */
  tool?: string;
  /** Dot path into the args, e.g. `path` or `repo.name`. */
  field: string;
  /** RegExp tested against the stringified field value. */
  pattern: RegExp;
  decision: "ALLOW" | "ASK" | "DENY";
  reason: string;
  risk?: RuleResult["risk"];
}

/** Match a tool argument against a regex and return a fixed decision. */
export function matchArg(options: ArgPatternOptions): Rule {
  return {
    name: `matchArg(${options.tool ?? "*"}.${options.field})`,
    evaluate({ action }) {
      if (options.tool && action.tool.name !== options.tool) return null;
      const value = readPath(action.args, options.field);
      if (value === undefined) return null;
      if (!options.pattern.test(safeStringify(value))) return null;
      return {
        decision: options.decision,
        reason: options.reason,
        risk: options.risk,
      };
    },
  };
}

/** DENY when an action runs a tool not present in the allow-list. */
export function allowOnly(names: readonly string[], reason?: string): Rule {
  const set = new Set(names);
  return {
    name: "allowOnly",
    evaluate({ action }) {
      if (set.has(action.tool.name)) return null;
      return {
        decision: "DENY",
        reason: reason ?? `Tool "${action.tool.name}" is not in the allow-list.`,
        risk: "high",
        confidence: 1,
      };
    },
  };
}

/** Escape hatch for arbitrary synchronous policy code. */
export function custom(
  name: string,
  evaluate: (request: AuthorizeRequest) => RuleResult | null | Promise<RuleResult | null>,
): Rule {
  return { name, evaluate };
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
