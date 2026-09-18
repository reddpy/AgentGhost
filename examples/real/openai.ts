/**
 * A chatbot that can act on your email, built with the OpenAI SDK.
 *
 * Run: bun run example:real:openai
 *
 * This is the usual Chat Completions tool loop (routed through the Vercel AI
 * Gateway). AgentGhost wraps the dispatcher, so `run(name, args)` replaces the
 * switch on the tool name. Read-only calls pass; sending and deleting ask first.
 */
import OpenAI from "openai";
import { guardOpenAI, terminalApproval, type OpenAIFunctionTool } from "@agentghost/openai";

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

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required };
}

const tools: OpenAIFunctionTool[] = [
  {
    type: "function",
    function: { name: "list_inbox", description: "List the emails in the inbox", parameters: schema({}) },
  },
  {
    type: "function",
    function: {
      name: "read_email",
      description: "Read one email by id",
      parameters: schema({ id: { type: "string" } }, ["id"]),
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email to a real person",
      parameters: schema({ to: { type: "string" }, body: { type: "string" } }, ["to", "body"]),
    },
  },
  {
    type: "function",
    function: {
      name: "delete_email",
      description: "Permanently delete an email",
      parameters: schema({ id: { type: "string" } }, ["id"]),
    },
  },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "list_inbox") return inbox.map((e) => `${e.id} — ${e.from}: ${e.subject}`).join("\n");
  if (name === "read_email") {
    const email = inbox.find((e) => e.id === args.id);
    return email ? `${email.from} — ${email.subject}\n${email.body}` : `No email ${args.id}`;
  }
  if (name === "send_email") {
    sent.push(`${args.to}: ${args.body}`);
    return `Email sent to ${args.to}`;
  }
  if (name === "delete_email") {
    const index = inbox.findIndex((e) => e.id === args.id);
    if (index === -1) return `No email ${args.id}`;
    inbox.splice(index, 1);
    return `Deleted email ${args.id}`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// --- Guard the dispatcher. This is the only AgentGhost-specific part. -----------
let currentRequest = "Say hello.";

const run = guardOpenAI(executeTool, {
  tools,
  intent: () => currentRequest,
  allow: ["list_inbox", "read_email"], // read-only: skip the judge
  onAsk: terminalApproval({ autoApprove: process.env.AGENTGHOST_AUTO_APPROVE === "1" }),
  onDecision: (request, verdict) =>
    console.log(`  [agentghost] ${verdict.decision.padEnd(5)} ${request.action.tool.name}`),
});

// --- Run a short conversation ----------------------------------------------
const client = new OpenAI({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: "https://ai-gateway.vercel.sh/v1",
});

const conversation = [
  "What's in my inbox?",
  "Read Maya's email and reply that her order ships tomorrow.",
  "Delete both emails.",
];

const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  { role: "system", content: "You are Ava, an email assistant. Use the tools to read and reply to email. Be concise." },
];

for (const user of conversation) {
  currentRequest = user;
  messages.push({ role: "user", content: user });
  console.log(`\nUser: ${user}`);

  for (let step = 0; step < 10; step += 1) {
    const completion = await client.chat.completions.create({ model, messages, tools });
    const message = completion.choices[0]!.message;
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log(`Ava: ${message.content}`);
      break;
    }
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      let output: string;
      try {
        output = await run(call.function.name, args);
      } catch (error) {
        output = `Blocked by AgentGhost: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}

console.log(`\nSent ${sent.length} email(s):`);
for (const email of sent) console.log(`  ${email}`);
