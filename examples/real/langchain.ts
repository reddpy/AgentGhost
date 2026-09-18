/**
 * A chatbot that can act on your email, built with LangChain.js.
 *
 * Run: bun run example:real:langchain
 *
 * Read-only tools run freely. Sending and deleting go through AgentGhost first: in a
 * terminal you'll be asked to approve; without a terminal they are denied.
 */
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { guard, terminalApproval } from "@agentghost/langchain";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Set AI_GATEWAY_API_KEY in .env (it powers the judge).");
  process.exit(1);
}
const modelId = process.env.AGENTGHOST_MODEL ?? "openai/gpt-5.6-luna";

// --- A tiny inbox the assistant can act on ---------------------------------
const inbox = [
  { id: "1", from: "maya@example.com", subject: "Where is my order?", body: "My order hasn't arrived yet." },
  { id: "2", from: "sam@example.com", subject: "Invoice question", body: "Could you resend last month's invoice?" },
];
const sent: string[] = [];

const listInbox = tool(async () => inbox.map((e) => `${e.id} — ${e.from}: ${e.subject}`).join("\n"), {
  name: "list_inbox",
  description: "List the emails in the inbox",
  schema: z.object({}),
});
const readEmail = tool(
  async ({ id }: { id: string }) => {
    const email = inbox.find((e) => e.id === id);
    return email ? `${email.from} — ${email.subject}\n${email.body}` : `No email ${id}`;
  },
  { name: "read_email", description: "Read one email by id", schema: z.object({ id: z.string() }) },
);
const sendEmail = tool(
  async ({ to, body }: { to: string; body: string }) => {
    sent.push(`${to}: ${body}`);
    return `Email sent to ${to}`;
  },
  {
    name: "send_email",
    description: "Send an email to a real person",
    schema: z.object({ to: z.string(), body: z.string() }),
  },
);
const deleteEmail = tool(
  async ({ id }: { id: string }) => {
    const index = inbox.findIndex((e) => e.id === id);
    if (index === -1) return `No email ${id}`;
    inbox.splice(index, 1);
    return `Deleted email ${id}`;
  },
  { name: "delete_email", description: "Permanently delete an email", schema: z.object({ id: z.string() }) },
);

// --- Guard the tools. This is the only AgentGhost-specific part. ----------------
let currentRequest = "Say hello.";

const safeTools = guard([listInbox, readEmail, sendEmail, deleteEmail], {
  intent: () => currentRequest,
  allow: ["list_inbox", "read_email"], // read-only: skip the judge
  onAsk: terminalApproval({ autoApprove: process.env.AGENTGHOST_AUTO_APPROVE === "1" }),
  onDecision: (request, verdict) =>
    console.log(`  [agentghost] ${verdict.decision.padEnd(5)} ${request.action.tool.name}`),
});

// --- Run a short conversation ----------------------------------------------
const model = new ChatOpenAI({
  model: modelId,
  apiKey: process.env.AI_GATEWAY_API_KEY,
  configuration: { baseURL: "https://ai-gateway.vercel.sh/v1" },
});

const agent = createAgent({
  model,
  tools: safeTools,
  systemPrompt: "You are Ava, an email assistant. Use the tools to read and reply to email. Be concise.",
});

const conversation = [
  "What's in my inbox?",
  "Read Maya's email and reply that her order ships tomorrow.",
  "Delete both emails.",
];

let history: unknown[] = [];
for (const user of conversation) {
  currentRequest = user;
  console.log(`\nUser: ${user}`);
  const result = await agent.invoke({ messages: [...history, { role: "user", content: user }] });
  history = result.messages;
  const content = result.messages.at(-1)?.content;
  console.log(`Ava: ${typeof content === "string" ? content : JSON.stringify(content)}`);
}

console.log(`\nSent ${sent.length} email(s):`);
for (const email of sent) console.log(`  ${email}`);
