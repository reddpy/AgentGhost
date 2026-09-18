/**
 * LangChain.js, in about 50 lines.
 *
 * Run: bun run example:langchain
 *
 * `guard()` returns the same tools (their prototype intact), so you pass
 * `safeTools` straight into an agent or executor.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { guard } from "@agentghost/langchain";
import { AgentGhostApprovalRequiredError, AgentGhostDeniedError } from "@agentghost/sdk";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}

const readFile = tool(async ({ path }: { path: string }) => `contents of ${path}`, {
  name: "read_file",
  description: "Read a file",
  schema: z.object({ path: z.string() }),
});
const sendEmail = tool(async ({ to }: { to: string }) => `email sent to ${to}`, {
  name: "send_email",
  description: "Send an email to a real person",
  schema: z.object({ to: z.string() }),
});
const deleteFile = tool(async ({ path }: { path: string }) => `deleted ${path}`, {
  name: "delete_file",
  description: "Permanently delete a file",
  schema: z.object({ path: z.string() }),
});

let currentTask = "";

const [safeRead, safeSend, safeDelete] = guard([readFile, sendEmail, deleteFile], {
  intent: () => currentTask,
  allow: ["read_file"], // read-only tools skip the judge
});

async function run(task: string, name: string, invoke: () => Promise<unknown>) {
  currentTask = task;
  console.log(`\nTask:    ${task}`);
  console.log(`Call:    ${name}`);
  try {
    console.log(`Verdict: ALLOW — ${await invoke()}`);
  } catch (error) {
    if (error instanceof AgentGhostApprovalRequiredError) console.log("Verdict: ASK — needs human approval");
    else if (error instanceof AgentGhostDeniedError) console.log("Verdict: DENY — blocked");
    else throw error;
  }
}

await run("Summarize the changelog", "read_file", () => safeRead.invoke({ path: "CHANGELOG.md" }));
await run("Email the changelog to the team", "send_email", () => safeSend.invoke({ to: "team@example.com" }));
await run("Email the changelog to the team", "delete_file", () => safeDelete.invoke({ path: "secrets.env" }));
