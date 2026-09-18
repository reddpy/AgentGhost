import { describe, expect, test } from "bun:test";
import {
  AgentGhostApprovalRequiredError,
  AgentGhostDeniedError,
  allowTools,
  askTools,
  authorize,
  custom,
  denyTools,
  guard,
  matchArg,
  type AuthorizeRequest,
  type Judge,
  type JudgeResult,
} from "../src/index.js";

interface CallLog {
  calls: AuthorizeRequest[];
}

function fakeJudge(
  result: JudgeResult | ((request: AuthorizeRequest) => JudgeResult),
): Judge & CallLog {
  const calls: AuthorizeRequest[] = [];
  return {
    name: "fake",
    calls,
    async judge(request: AuthorizeRequest) {
      calls.push(request);
      return typeof result === "function" ? result(request) : result;
    },
  };
}

const allow: JudgeResult = { decision: "ALLOW", reason: "ok", risk: "low", confidence: 0.99 };

function makeTool(
  name: string,
  execute: (args: Record<string, unknown>) => unknown = (args) => ({ ok: true, args }),
) {
  return { name, description: `${name} tool`, parameters: { type: "object" }, execute };
}

describe("guard", () => {
  test("allows and executes the underlying tool", async () => {
    const judge = fakeJudge(allow);
    const calls: unknown[] = [];
    const tool = makeTool("read_file", (args) => {
      calls.push(args);
      return { contents: "hello" };
    });

    const safe = guard(tool, { intent: "read the config", judge });
    const result = await safe.execute({ path: "a.txt" });

    expect(result).toEqual({ contents: "hello" });
    expect(calls).toEqual([{ path: "a.txt" }]);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.action.tool.name).toBe("read_file");
    expect(judge.calls[0]!.intent.text).toBe("read the config");
  });

  test("denies without executing the tool", async () => {
    const judge = fakeJudge({ decision: "DENY", reason: "out of scope" });
    let executed = false;
    const tool = makeTool("delete_repo", () => {
      executed = true;
    });
    const safe = guard(tool, { intent: "read email", judge });

    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(executed).toBe(false);
  });

  test("ASK throws by default and does not execute", async () => {
    const judge = fakeJudge({ decision: "ASK", reason: "needs confirmation" });
    let executed = false;
    const tool = makeTool("send_email", () => {
      executed = true;
    });
    const safe = guard(tool, { intent: "reply to customer", judge });

    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostApprovalRequiredError);
    expect(executed).toBe(false);
  });

  test("ASK with onAsk returning ALLOW proceeds", async () => {
    const judge = fakeJudge({ decision: "ASK", reason: "needs confirmation" });
    const tool = makeTool("send_email", () => ({ sent: true }));
    const safe = guard(tool, {
      intent: "reply to customer",
      judge,
      onAsk: () => "ALLOW",
    });

    await expect(safe.execute({ to: "x" })).resolves.toEqual({ sent: true });
  });

  test("ASK with onAsk returning DENY blocks", async () => {
    const judge = fakeJudge({ decision: "ASK", reason: "needs confirmation" });
    const tool = makeTool("send_email", () => ({ sent: true }));
    const safe = guard(tool, { intent: "reply", judge, onAsk: () => "DENY" });

    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
  });

  test("dynamic intent is read at call time", async () => {
    const judge = fakeJudge(allow);
    let currentTask = "browse";
    const safe = guard(makeTool("http_get"), {
      intent: () => currentTask,
      judge,
    });

    await safe.execute({ url: "/a" });
    currentTask = "deploy";
    await safe.execute({ url: "/b" });

    expect(judge.calls.map((call) => call.intent.text)).toEqual(["browse", "deploy"]);
  });

  test("rules short-circuit the judge", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("rm_rf"), {
      intent: "clean up",
      judge,
      rules: [denyTools(["rm_rf"], "never delete")],
    });

    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(judge.calls).toHaveLength(0);
  });

  test("allowTools skips the judge", async () => {
    const judge = fakeJudge({ decision: "DENY", reason: "would deny" });
    const safe = guard(makeTool("read_file"), {
      intent: "read",
      judge,
      rules: [allowTools(["read_file"])],
    });

    await expect(safe.execute({})).resolves.toEqual({ ok: true, args: {} });
    expect(judge.calls).toHaveLength(0);
  });

  test("protect restricts which tools are guarded", async () => {
    const judge = fakeJudge({ decision: "DENY", reason: "no" });
    const safe = guard(
      {
        read_file: makeTool("read_file"),
        delete_file: makeTool("delete_file"),
      },
      { intent: "read", judge, protect: ["delete_file"] },
    );

    expect(await safe.read_file.execute({})).toEqual({ ok: true, args: {} });
    await expect(safe.delete_file.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
    expect(judge.calls).toHaveLength(1);
  });

  test("protect predicate is supported", async () => {
    const judge = fakeJudge({ decision: "ALLOW", reason: "ok" });
    const safe = guard(makeTool("read_file"), {
      intent: "read",
      judge,
      protect: (tool) => tool.name !== "read_file",
    });
    await safe.execute({});
    expect(judge.calls).toHaveLength(0);
  });

  test("fails closed when the judge throws", async () => {
    const judge: Judge = {
      name: "boom",
      async judge() {
        throw new Error("network down");
      },
    };
    const safe = guard(makeTool("read_file"), { intent: "read", judge });
    await expect(safe.execute({})).rejects.toBeInstanceOf(AgentGhostDeniedError);
  });

  test("fails open when asked to", async () => {
    const judge: Judge = {
      name: "boom",
      async judge() {
        throw new Error("network down");
      },
    };
    const safe = guard(makeTool("read_file"), {
      intent: "read",
      judge,
      failMode: "open",
    });
    await expect(safe.execute({})).resolves.toEqual({ ok: true, args: {} });
  });

  test("records previous actions in context", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("step"), { intent: "do a task", judge });

    await safe.execute({ n: 1 });
    await safe.execute({ n: 2 });

    expect(judge.calls[1]!.context.previousActions.map((a) => a.args.n)).toEqual([1]);
    expect(judge.calls[1]!.context.runId).toBe(judge.calls[0]!.context.runId);
  });

  test("caps previousActions at historyLimit", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("step"), { intent: "do a task", judge, historyLimit: 2 });

    await safe.execute({ n: 1 });
    await safe.execute({ n: 2 });
    await safe.execute({ n: 3 });

    expect(judge.calls[2]!.context.previousActions.map((a) => a.args.n)).toEqual([1, 2]);
  });

  test("passes the tool call's abort signal to the judge", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const judge: Judge = {
      name: "capture",
      async judge(_request, signal) {
        signals.push(signal);
        return allow;
      },
    };
    const controller = new AbortController();
    const safe = guard(makeTool("read_file"), { intent: "read", judge });

    await safe.execute({ path: "a.txt" }, { abortSignal: controller.signal });

    expect(signals[0]).toBe(controller.signal);
  });

  test("matchArg rule denies based on an argument", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("run_sql"), {
      intent: "inspect",
      judge,
      rules: [
        matchArg({
          field: "query",
          pattern: /\bDROP\b/i,
          decision: "DENY",
          reason: "no DDL",
        }),
      ],
    });

    await expect(safe.execute({ query: "SELECT 1" })).resolves.toBeDefined();
    await expect(safe.execute({ query: "drop table users" })).rejects.toBeInstanceOf(
      AgentGhostDeniedError,
    );
  });

  test("custom rules and onDecision audit hook run", async () => {
    const seen: string[] = [];
    const safe = guard(makeTool("read_file"), {
      intent: "read",
      judge: fakeJudge(allow),
      rules: [
        custom("never-ask", () => ({ decision: "ASK", reason: "always ask" })),
      ],
      onAsk: () => "ALLOW",
      onDecision: (_request, verdict) => seen.push(verdict.by),
    });

    await safe.execute({});
    expect(seen).toEqual(["rule:never-ask"]);
  });

  test("evaluate once caches identical decisions", async () => {
    const judge = fakeJudge(allow);
    const safe = guard(makeTool("read_file"), {
      intent: "read",
      judge,
      evaluate: "once",
    });

    await safe.execute({ path: "a" });
    await safe.execute({ path: "a" });
    await safe.execute({ path: "b" });

    expect(judge.calls).toHaveLength(2);
  });
});

describe("authorize", () => {
  test("runs rules then judge without callbacks", async () => {
    const judge = fakeJudge(allow);
    const verdict = await authorize(
      {
        intent: { text: "read" },
        action: { tool: { name: "read_file" }, args: {} },
        context: { runId: "run", previousActions: [], metadata: {} },
      },
      { judge, rules: [askTools(["read_file"])] },
    );

    expect(verdict.decision).toBe("ASK");
    expect(verdict.by).toBe("rule:askTools(read_file)");
    expect(judge.calls).toHaveLength(0);
  });
});
