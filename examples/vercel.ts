/**
 * The Vercel AI SDK, in about 50 lines.
 *
 * Run: bun run example:vercel
 *
 * `guard()` returns the same tools with each `execute` wrapped, so you pass
 * `safeTools` straight into generateText / streamText / an agent.
 */
import { tool } from "ai";
import { z } from "zod";
import { guard } from "@agentghost/vercel";
import { AgentGhostApprovalRequiredError, AgentGhostDeniedError } from "@agentghost/sdk";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}

const tools = {
  read_file: tool({
    description: "Read a file",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => `contents of ${path}`,
  }),
  send_email: tool({
    description: "Send an email to a real person",
    inputSchema: z.object({ to: z.string() }),
    execute: async ({ to }) => `email sent to ${to}`,
  }),
  delete_file: tool({
    description: "Permanently delete a file",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => `deleted ${path}`,
  }),
};

let currentTask = "";

const safeTools = guard(tools, {
  intent: () => currentTask,
  allow: ["read_file"], // read-only tools skip the judge
});

async function run(task: string, tool: keyof typeof safeTools, args: Record<string, unknown>) {
  currentTask = task;
  console.log(`\nTask:    ${task}`);
  console.log(`Call:    ${tool}(${JSON.stringify(args)})`);
  try {
    const result = await safeTools[tool].execute?.(args as never);
    console.log(`Verdict: ALLOW — ${result}`);
  } catch (error) {
    if (error instanceof AgentGhostApprovalRequiredError) console.log("Verdict: ASK — needs human approval");
    else if (error instanceof AgentGhostDeniedError) console.log("Verdict: DENY — blocked");
    else throw error;
  }
}

await run("Summarize the changelog", "read_file", { path: "CHANGELOG.md" });
await run("Email the changelog to the team", "send_email", { to: "team@example.com" });
await run("Email the changelog to the team", "delete_file", { path: "secrets.env" });
