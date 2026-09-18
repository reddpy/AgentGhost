import { describe, expect, test } from "bun:test";
import { AgentGhostApprovalRequiredError, type Judge, type JudgeResult } from "@agentghost/sdk";
import { guard } from "../src/index.js";

class FakeLangChainTool {
  name = "search";
  description = "Search the docs";
  schema = { type: "object", properties: { q: { type: "string" } } };
  calls: string[] = [];

  async _call(arg: { q: string }): Promise<string> {
    this.calls.push(arg.q);
    return `result:${arg.q}`;
  }

  async invoke(arg: { q: string }): Promise<string> {
    return this._call(arg);
  }
}

function judgeReturning(result: JudgeResult): Judge & { count: number } {
  return {
    name: "fake",
    count: 0,
    async judge() {
      this.count += 1;
      return result;
    },
  };
}

describe("@agentghost/langchain", () => {
  test("intercepts _call exactly once via invoke", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const tool = new FakeLangChainTool();
    const safe = guard(tool, { intent: "answer a question", judge });

    await expect(safe.invoke({ q: "agentghost" })).resolves.toBe("result:agentghost");
    expect(tool.calls).toEqual(["agentghost"]);
    expect(judge.count).toBe(1);
  });

  test("blocks on ASK by default", async () => {
    const judge = judgeReturning({ decision: "ASK", reason: "confirm" });
    const tool = new FakeLangChainTool();
    const safe = guard(tool, { intent: "answer", judge });

    await expect(safe._call({ q: "secret" })).rejects.toBeInstanceOf(
      AgentGhostApprovalRequiredError,
    );
    expect(tool.calls).toEqual([]);
  });

  test("arrays of tools are wrapped", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const tools = [new FakeLangChainTool(), new FakeLangChainTool()];
    tools[1]!.name = "search_two";
    const safe = guard(tools, { intent: "answer", judge });

    await safe[0]!.invoke({ q: "a" });
    await safe[1]!.invoke({ q: "b" });
    expect(judge.count).toBe(2);
  });
});
