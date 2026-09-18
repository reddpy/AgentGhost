/**
 * A chatbot that can act on your email, built with the Vercel AI SDK.
 *
 * Run: bun run example:real:vercel
 *
 * Read-only tools run freely. Sending and deleting go through AgentGhost first: in a
 * terminal you'll be asked to approve; without a terminal they are denied.
 */
import { ToolLoopAgent, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { guard, terminalApproval } from "@agentghost/vercel";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}
const model = process.env.AGENTGHOST_MODEL ?? "openai/gpt-5.6-luna";

// --- A tiny inbox the assistant can act on ---------------------------------
const inbox = [
  { id: "1", from: "maya@example.com", subject: "Where is my order?", body: "My order hasn't arrived yet." },
  { id: "2", from: "sam@example.com", subject: "Invoice question", body: "Could you resend last month's invoice?" },
];
const sent: string[] = [];

const tools = {
  list_inbox: tool({
    description: "List the emails in the inbox",
    inputSchema: z.object({}),
    execute: async () => inbox.map((e) => `${e.id} — ${e.from}: ${e.subject}`).join("\n"),
  }),
  read_email: tool({
    description: "Read one email by id",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const email = inbox.find((e) => e.id === id);
      return email ? `${email.from} — ${email.subject}\n${email.body}` : `No email ${id}`;
    },
  }),
  send_email: tool({
    description: "Send an email to a real person",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    execute: async ({ to, body }) => {
      sent.push(`${to}: ${body}`);
      return `Email sent to ${to}`;
    },
  }),
  delete_email: tool({
    description: "Permanently delete an email",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const index = inbox.findIndex((e) => e.id === id);
      if (index === -1) return `No email ${id}`;
      inbox.splice(index, 1);
      return `Deleted email ${id}`;
    },
  }),
};

// --- Guard the tools. This is the only AgentGhost-specific part. ----------------
let currentRequest = "Say hello.";

const safeTools = guard(tools, {
  intent: () => currentRequest,
  allow: ["list_inbox", "read_email"], // read-only: skip the judge
  onAsk: terminalApproval({ autoApprove: process.env.AGENTGHOST_AUTO_APPROVE === "1" }),
  onDecision: (request, verdict) =>
    console.log(`  [agentghost] ${verdict.decision.padEnd(5)} ${request.action.tool.name}`),
});

// --- Run a short conversation ----------------------------------------------
const agent = new ToolLoopAgent({
  model,
  instructions: "You are Ava, an email assistant. Use the tools to read and reply to email. Be concise.",
  tools: safeTools,
  stopWhen: stepCountIs(10),
});

const conversation = [
  "What's in my inbox?",
  "Read Maya's email and reply that her order ships tomorrow.",
  "Delete both emails.",
];

const history: ModelMessage[] = [];
for (const user of conversation) {
  currentRequest = user;
  history.push({ role: "user", content: user });
  console.log(`\nUser: ${user}`);
  const result = await agent.generate({ messages: history });
  history.push(...result.responseMessages);
  console.log(`Ava: ${result.text}`);
}

console.log(`\nSent ${sent.length} email(s):`);
for (const email of sent) console.log(`  ${email}`);
