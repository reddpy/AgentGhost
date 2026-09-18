/**
 * The core SDK, with no agent framework.
 *
 * Run: bun run example:basic
 *
 * We call the tools directly (no model) to show exactly what AgentGhost does:
 * read-only calls pass, consequential calls ask, unrelated calls are denied.
 */
import { AgentGhostApprovalRequiredError, AgentGhostDeniedError, guard } from "@agentghost/sdk";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}

const tools = {
  read_file: {
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async ({ path }: { path: string }) => `contents of ${path}`,
  },
  send_email: {
    description: "Send an email to a real person",
    parameters: { type: "object", properties: { to: { type: "string" } } },
    execute: async ({ to }: { to: string }) => `email sent to ${to}`,
  },
  delete_file: {
    description: "Permanently delete a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async ({ path }: { path: string }) => `deleted ${path}`,
  },
};

// The user's task changes over time, so AgentGhost reads it at call time.
let currentTask = "";

const safe = guard(tools, {
  intent: () => currentTask,
  allow: ["read_file"], // read-only tools skip the judge
});

async function run(task: string, tool: keyof typeof safe, args: Record<string, unknown>) {
  currentTask = task;
  console.log(`\nTask:    ${task}`);
  console.log(`Call:    ${tool}(${JSON.stringify(args)})`);
  try {
    const result = await safe[tool].execute(args as never);
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
