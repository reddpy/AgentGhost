import { describe, expect, test } from "bun:test";
import { AgentGhostDeniedError, type Judge, type JudgeResult } from "@agentghost/sdk";
import { guard } from "../src/index.js";

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

describe("@agentghost/vercel", () => {
  test("wraps AI SDK tools and executes on ALLOW", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const calls: unknown[] = [];
    const tools = {
      read_file: {
        description: "Read a file",
        inputSchema: { type: "object" },
        execute: async (args: { path: string }) => {
          calls.push(args);
          return `contents of ${args.path}`;
        },
      },
    };

    const safe = guard(tools, { intent: () => "read the readme", judge });
    await expect(safe.read_file.execute({ path: "README.md" })).resolves.toBe(
      "contents of README.md",
    );
    expect(calls).toEqual([{ path: "README.md" }]);
    expect(judge.count).toBe(1);
  });

  test("blocks execution on DENY", async () => {
    const judge = judgeReturning({ decision: "DENY", reason: "no" });
    let executed = false;
    const tools = {
      delete_file: {
        description: "Delete a file",
        inputSchema: { type: "object" },
        execute: async () => {
          executed = true;
        },
      },
    };

    const safe = guard(tools, { intent: "read", judge });
    await expect(safe.delete_file.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(executed).toBe(false);
  });

  test("preserves the original tool shape", async () => {
    const judge = judgeReturning({ decision: "ALLOW", reason: "ok" });
    const tools = {
      ping: {
        description: "Ping",
        inputSchema: { type: "object" },
        execute: async () => "pong",
      },
    };
    const safe = guard(tools, { intent: "test", judge });
    expect(safe.ping.description).toBe("Ping");
    expect(safe.ping.inputSchema).toEqual({ type: "object" });
  });
});
