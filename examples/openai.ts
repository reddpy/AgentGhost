/**
 * OpenAI / Anthropic tool calling, in about 60 lines.
 *
 * Run: bun run example:openai
 *
 * The model only returns tool calls; your code runs them. AgentGhost wraps that
 * dispatcher, so `run(name, args)` replaces the usual switch on the tool name.
 */
import { guardOpenAI, type OpenAIFunctionTool } from "@agentghost/openai";
import { AgentGhostApprovalRequiredError, AgentGhostDeniedError } from "@agentghost/sdk";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}

const tools: OpenAIFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email to a real person",
      parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Permanently delete a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "read_file") return `contents of ${args.path}`;
  if (name === "send_email") return `email sent to ${args.to}`;
  if (name === "delete_file") return `deleted ${args.path}`;
  throw new Error(`unknown tool: ${name}`);
}

let currentTask = "";

const run = guardOpenAI(executeTool, {
  tools,
  intent: () => currentTask,
  allow: ["read_file"], // read-only tools skip the judge
});

async function scenario(task: string, name: string, args: Record<string, unknown>) {
  currentTask = task;
  console.log(`\nTask:    ${task}`);
  console.log(`Call:    ${name}(${JSON.stringify(args)})`);
  try {
    console.log(`Verdict: ALLOW — ${await run(name, args)}`);
  } catch (error) {
    if (error instanceof AgentGhostApprovalRequiredError) console.log("Verdict: ASK — needs human approval");
    else if (error instanceof AgentGhostDeniedError) console.log("Verdict: DENY — blocked");
    else throw error;
  }
}

await scenario("Summarize the changelog", "read_file", { path: "CHANGELOG.md" });
await scenario("Email the changelog to the team", "send_email", { to: "team@example.com" });
await scenario("Email the changelog to the team", "delete_file", { path: "secrets.env" });
