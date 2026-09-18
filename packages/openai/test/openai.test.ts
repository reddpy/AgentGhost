import { describe, expect, test } from "bun:test";
import { AgentGhostDeniedError, type Judge, type JudgeResult } from "@agentghost/sdk";
import { fromOpenAITools, guardAnthropic, guardOpenAI } from "../src/index.js";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "send_email",
      description: "Send an email",
      parameters: { type: "object", properties: { to: { type: "string" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_emails",
      description: "List inbox",
      parameters: { type: "object" },
    },
  },
];

function judgeReturning(result: JudgeResult): Judge & { count: number; last?: string } {
  const judge = {
    name: "fake",
    count: 0,
    last: undefined as string | undefined,
    async judge(request: { action: { tool: { name: string } } }) {
      judge.count += 1;
      judge.last = request.action.tool.name;
      return result;
    },
  };
  return judge;
}

describe("@agentghost/openai", () => {
  test("parses function tool definitions", () => {
    expect(fromOpenAITools(tools)).toEqual([
      {
        name: "send_email",
        description: "Send an email",
        schema: tools[0]!.function.parameters,
      },
      { name: "list_emails", description: "List inbox", schema: { type: "object" } },
    ]);
  });

  test("ALLOW runs the dispatcher", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const executed: Array<[string, Record<string, unknown>]> = [];
    const run = guardOpenAI(
      async (name, args) => {
        executed.push([name, args]);
        return { ok: true };
      },
      { tools, intent: () => "read the inbox", judge },
    );

    await expect(run("list_emails", {})).resolves.toEqual({ ok: true });
    expect(executed).toEqual([["list_emails", {}]]);
    expect(judge.last).toBe("list_emails");
  });

  test("DENY blocks the dispatcher", async () => {
    const judge = judgeReturning({ decision: "DENY", reason: "no" });
    let executed = false;
    const run = guardOpenAI(
      async () => {
        executed = true;
      },
      { tools, intent: "read the inbox", judge },
    );

    await expect(run("send_email", { to: "x@y.z" })).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(executed).toBe(false);
  });

  test("unknown tool calls are still protected", async () => {
    const judge = judgeReturning({ decision: "DENY", reason: "unknown" });
    const run = guardOpenAI(async () => "ran", {
      tools,
      intent: "read",
      judge,
    });
    await expect(run("mystery_tool", {})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(judge.last).toBe("mystery_tool");
  });

  test("guardAnthropic uses input_schema", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const run = guardAnthropic(async () => "ran", {
      tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
      intent: "read",
      judge,
    });
    await expect(run("read", {})).resolves.toBe("ran");
    expect(judge.last).toBe("read");
  });
});
