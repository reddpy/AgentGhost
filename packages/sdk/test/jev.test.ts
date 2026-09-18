import { describe, expect, test } from "bun:test";
import {
  AgentGhostApprovalRequiredError,
  AgentGhostConfigError,
  buildQuestions,
  createGatewayJudge,
  createJevJudge,
  createJevJudgeFromClient,
  guard,
  interpretAnswers,
  type AiSdkEvaluate,
  type JevAnswer,
  type SystemOneClient,
  type SystemOneInput,
} from "../src/index.js";

function clientReturning(answers: Record<string, JevAnswer>): SystemOneClient & {
  inputs: SystemOneInput[];
} {
  const inputs: SystemOneInput[] = [];
  return {
    inputs,
    async systemOne(input) {
      inputs.push(input);
      return { model: "jev-1.13.0", answers };
    },
  };
}

const allowAnswers: Record<string, JevAnswer> = {
  decision: {
    type: "choice",
    choice: "allow",
    probabilities: { allow: 0.93, ask: 0.06, deny: 0.01 },
    confidence: 0.88,
  },
  serves_intent: { type: "noul", noul: 0.97 },
  reversible: { type: "noul", noul: 0.9 },
  risk: {
    type: "score",
    score: 0.2,
    confidence: 0.8,
    legend: { "0": "none", "1": "limited", "2": "severe" },
    probabilities: { "0": 0.8, "1": 0.2, "2": 0 },
  },
};

describe("interpretAnswers", () => {
  test("maps allow", () => {
    const result = interpretAnswers(allowAnswers);
    expect(result.decision).toBe("ALLOW");
    expect(result.risk).toBe("low");
    expect(result.confidence).toBe(0.88);
  });

  test("maps deny", () => {
    const result = interpretAnswers({
      ...allowAnswers,
      decision: {
        type: "choice",
        choice: "deny",
        probabilities: { allow: 0.01, ask: 0.04, deny: 0.95 },
        confidence: 0.9,
      },
    });
    expect(result.decision).toBe("DENY");
  });

  test("maps ask", () => {
    const result = interpretAnswers({
      ...allowAnswers,
      decision: {
        type: "choice",
        choice: "ask",
        probabilities: { allow: 0.2, ask: 0.7, deny: 0.1 },
        confidence: 0.6,
      },
    });
    expect(result.decision).toBe("ASK");
  });

  test("escalates a low-confidence allow to ask", () => {
    const result = interpretAnswers({
      ...allowAnswers,
      decision: {
        type: "choice",
        choice: "allow",
        probabilities: { allow: 0.4, ask: 0.3, deny: 0.3 },
        confidence: 0.2,
      },
    });
    expect(result.decision).toBe("ASK");
  });

  test("overrides an allow that does not serve intent", () => {
    const result = interpretAnswers({
      ...allowAnswers,
      serves_intent: { type: "noul", noul: 0.1 },
    });
    expect(result.decision).toBe("DENY");
  });

  test("escalates a high-risk irreversible allow to ask", () => {
    const result = interpretAnswers({
      ...allowAnswers,
      reversible: { type: "noul", noul: 0.1 },
      risk: {
        type: "score",
        score: 2,
        confidence: 0.9,
        legend: {},
        probabilities: { "2": 1 },
      },
    });
    expect(result.decision).toBe("ASK");
    expect(result.risk).toBe("high");
  });
});

describe("createJevJudge", () => {
  test("sends intent, action, and the decision questions", async () => {
    const client = clientReturning(allowAnswers);
    const judge = createJevJudgeFromClient(client);

    const verdict = await judge.judge({
      intent: { text: "read the config" },
      action: {
        tool: { name: "read_file", description: "Read a file" },
        args: { path: "config.json" },
      },
      context: { runId: "run-1", previousActions: [], metadata: {} },
    });

    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.model).toBe("jev-1.13.0");
    expect(verdict.by).toBeUndefined();

    const input = client.inputs[0]!;
    expect(input.model).toBe("jev-latest");
    expect((input.state as Record<string, unknown>).intent).toBe("read the config");
    const action = (input.state as Record<string, unknown>).action as Record<string, unknown>;
    expect(action.tool).toBe("read_file");
    expect(action.arguments).toEqual({ path: "config.json" });
    expect(Object.keys(input.questions)).toContain("decision");
    expect(input.questions.decision?.type).toBe("choice");
  });

  test("throws a config error when no API key is available", async () => {
    const judge = createJevJudge({
      apiKey: "",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(
      judge.judge({
        intent: { text: "x" },
        action: { tool: { name: "t" }, args: {} },
        context: { runId: "r", previousActions: [], metadata: {} },
      }),
    ).rejects.toBeInstanceOf(AgentGhostConfigError);
  });

  test("uses the fetch transport when a key is provided", async () => {
    const judge = createJevJudge({
      apiKey: "test-key",
      fetch: (async () =>
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: allowAnswers }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const verdict = await judge.judge({
      intent: { text: "read" },
      action: { tool: { name: "read_file" }, args: {} },
      context: { runId: "r", previousActions: [], metadata: {} },
    });
    expect(verdict.decision).toBe("ALLOW");
  });
});

describe("createGatewayJudge", () => {
  test("uses AI SDK evaluate with boolean questions and the gateway model", async () => {
    const calls: Array<{ model: unknown; state: unknown; questions: Record<string, unknown> }> =
      [];
    const evaluate: AiSdkEvaluate = async (args) => {
      calls.push(args as (typeof calls)[number]);
      return {
        answers: {
          decision: { choice: "allow", probabilities: { allow: 0.95 }, confidence: 0.9 },
          serves_intent: { probability: 0.98 },
          reversible: { probability: 0.9 },
          risk: { score: 0.1, confidence: 0.8, legend: {}, probabilities: {} },
        },
        providerMetadata: { typesafe: { confidence: { decision: 0.9 } } },
      };
    };

    const judge = createGatewayJudge({ evaluate });
    const verdict = await judge.judge({
      intent: { text: "read the changelog" },
      action: { tool: { name: "read_file" }, args: { path: "CHANGELOG.md" } },
      context: { runId: "r", previousActions: [], metadata: {} },
    });

    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.model).toBe("typesafe-ai/jev");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("typesafe-ai/jev");
    expect(calls[0]!.questions.serves_intent).toMatchObject({ type: "boolean" });
    expect(calls[0]!.questions.decision).toMatchObject({ type: "choice" });
  });
});

describe("buildQuestions", () => {
  test("asks for a verdict plus supporting signals", () => {
    const questions = buildQuestions();
    expect(Object.keys(questions).sort()).toEqual([
      "decision",
      "reversible",
      "risk",
      "serves_intent",
    ]);
  });
});

describe("guard + Jev end to end", () => {
  test("authorizes a protected tool through the Jev judge", async () => {
    const client = clientReturning(allowAnswers);
    const executed: unknown[] = [];
    const tool = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        executed.push(args);
        return "data";
      },
    };

    const safe = guard(tool, {
      intent: () => "summarize the changelog",
      judge: createJevJudgeFromClient(client),
    });

    await expect(safe.execute({ path: "CHANGELOG.md" })).resolves.toBe("data");
    expect(executed).toEqual([{ path: "CHANGELOG.md" }]);
    const state = client.inputs[0]!.state as Record<string, unknown>;
    expect(state.intent).toBe("summarize the changelog");
  });

  test("propagates an ASK verdict to the host", async () => {
    const askAnswers: Record<string, JevAnswer> = {
      ...allowAnswers,
      decision: {
        type: "choice",
        choice: "ask",
        probabilities: { allow: 0.2, ask: 0.7, deny: 0.1 },
        confidence: 0.7,
      },
    };
    const client = clientReturning(askAnswers);
    const tool = {
      name: "send_email",
      execute: async () => "sent",
    };

    const safe = guard(tool, {
      intent: "reply to the customer",
      judge: createJevJudgeFromClient(client),
    });

    await expect(safe.execute({ to: "a@b.c" })).rejects.toBeInstanceOf(
      AgentGhostApprovalRequiredError,
    );
  });
});
