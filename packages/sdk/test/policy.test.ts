import { describe, expect, test } from "bun:test";
import {
  AgentGhostApprovalRequiredError,
  AgentGhostConfigError,
  AgentGhostDeniedError,
  approveWith,
  authorize,
  guard,
  terminalApproval,
  type AuthorizeRequest,
  type Judge,
  type JudgeResult,
  type Verdict,
} from "../src/index.js";
import { isJudgeConfigured, resolveJudgeKind } from "../src/jev.js";

const allow: JudgeResult = { decision: "ALLOW", reason: "ok" };

function fakeJudge(result: JudgeResult): Judge & { calls: AuthorizeRequest[] } {
  const calls: AuthorizeRequest[] = [];
  return {
    name: "fake",
    calls,
    async judge(request) {
      calls.push(request);
      return result;
    },
  };
}

function makeTool(name: string) {
  return { name, description: `${name} tool`, parameters: { type: "object" }, execute: async () => "ran" };
}

/** Run `fn` with every judge key removed from the environment. */
function withoutKeys<T>(fn: () => T): T {
  const keys = ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_AI_API_KEY"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run `fn` with environment variables temporarily overridden. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const request = (): AuthorizeRequest => ({
  intent: { text: "test" },
  action: { tool: { name: "read_file" }, args: {} },
  context: { runId: "run", previousActions: [], metadata: {} },
});
const verdict = (): Verdict => ({ decision: "ASK", by: "test" });

describe("fail-fast configuration", () => {
  test("guard throws AgentGhostConfigError when no judge and no key", () => {
    withoutKeys(() => {
      expect(() => guard(makeTool("read_file"), { intent: "read" })).toThrow(AgentGhostConfigError);
    });
  });

  test("does not throw when a custom judge is passed", () => {
    withoutKeys(() => {
      expect(() => guard(makeTool("read_file"), { intent: "read", judge: fakeJudge(allow) })).not.toThrow();
    });
  });

  test("does not throw with judge: null (rules-only)", () => {
    withoutKeys(() => {
      expect(() => guard(makeTool("read_file"), { intent: "read", judge: null })).not.toThrow();
    });
  });

  test("does not throw when failMode is open", () => {
    withoutKeys(() => {
      expect(() => guard(makeTool("read_file"), { intent: "read", failMode: "open" })).not.toThrow();
    });
  });
});

describe("allow / ask / deny shorthands", () => {
  test("allow skips the judge", async () => {
    const judge = fakeJudge({ decision: "DENY", reason: "would deny" });
    const safe = guard(makeTool("read_file"), { intent: "read", judge, allow: ["read_file"] });
    await expect(safe.execute({})).resolves.toBe("ran");
    expect(judge.calls).toHaveLength(0);
  });

  test("deny blocks without calling the judge", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("rm_rf"), { intent: "clean", judge, deny: ["rm_rf"] });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(judge.calls).toHaveLength(0);
  });

  test("ask requests approval without calling the judge", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("send_email"), { intent: "reply", judge, ask: ["send_email"] });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostApprovalRequiredError);
    expect(judge.calls).toHaveLength(0);
  });

  test("deny wins over allow when a name is in both", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("tricky"), {
      intent: "x",
      judge,
      allow: ["tricky"],
      deny: ["tricky"],
    });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
  });

  test("rules-only denies anything not explicitly allowed", async () => {
    const safe = guard(makeTool("mystery"), { intent: "x", judge: null });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
  });
});

describe("approval helpers", () => {
  test("approveWith maps a boolean to ALLOW / DENY", async () => {
    expect(await approveWith(() => true)(request(), verdict())).toBe("ALLOW");
    expect(await approveWith(async () => false)(request(), verdict())).toBe("DENY");
  });

  test("terminalApproval autoApprove returns ALLOW", async () => {
    expect(await terminalApproval({ autoApprove: true })(request(), verdict())).toBe("ALLOW");
  });

  test("approveWith drives the guard's ASK path", async () => {
    const safe = guard(makeTool("send_email"), {
      intent: "reply",
      judge: fakeJudge({ decision: "ASK", reason: "contacts a person" }),
      onAsk: approveWith(() => true),
    });
    await expect(safe.execute({})).resolves.toBe("ran");
  });
});

describe("judge provider selection", () => {
  test("AGENTGHOST_JUDGE selects the provider and rejects typos", () => {
    withEnv({ AGENTGHOST_JUDGE: "typesafe" }, () => expect(resolveJudgeKind()).toBe("typesafe"));
    withEnv({ AGENTGHOST_JUDGE: "vercel" }, () => expect(resolveJudgeKind()).toBe("gateway"));
    withEnv({ AGENTGHOST_JUDGE: "" }, () => expect(resolveJudgeKind()).toBeUndefined());
    withEnv({ AGENTGHOST_JUDGE: "bogus" }, () =>
      expect(() => resolveJudgeKind()).toThrow(AgentGhostConfigError),
    );
  });

  test("an explicit provider only counts its own key", () => {
    withEnv(
      {
        AGENTGHOST_JUDGE: "typesafe",
        AI_GATEWAY_API_KEY: "gateway-only",
        TYPESAFE_API_KEY: undefined,
        TYPESAFE_AI_API_KEY: undefined,
      },
      () => {
        expect(isJudgeConfigured()).toBe(false);
        expect(() => guard(makeTool("read_file"), { intent: "read" })).toThrow(AgentGhostConfigError);
      },
    );

    withEnv({ AGENTGHOST_JUDGE: "gateway", AI_GATEWAY_API_KEY: "gateway-only" }, () => {
      expect(isJudgeConfigured()).toBe(true);
      expect(() => guard(makeTool("read_file"), { intent: "read" })).not.toThrow();
    });
  });
});

describe("deny is always blocking", () => {
  test("an onDeny hook that returns normally still blocks the tool", async () => {
    const judge = fakeJudge({ decision: "DENY", reason: "no" });
    let notified = false;
    const safe = guard(makeTool("rm_rf"), {
      intent: "x",
      judge,
      onDeny: () => {
        notified = true;
      },
    });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(notified).toBe(true);
  });
});

describe("authorize()", () => {
  test("denies (fail-closed) when no judge is provided", async () => {
    const result = await authorize(request(), {});
    expect(result.decision).toBe("DENY");
    expect(result.by).toBe("fail-closed");
  });

  test("allows (fail-open) when configured to", async () => {
    const result = await authorize(request(), { failMode: "open" });
    expect(result.decision).toBe("ALLOW");
  });
});
