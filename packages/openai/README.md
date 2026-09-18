<p align="center">
  <img src="https://raw.githubusercontent.com/reddpy/AgentGhost/main/docs/agentghost_icon.png" alt="AgentGhost" width="76">
</p>

# @agentghost/openai

Intent-aware authorization for OpenAI and Anthropic tool calling. Wrap the
dispatcher that executes tool calls so every consequential action passes an
`ALLOW` / `ASK` / `DENY` check before it runs, decided by
[Jev](https://typesafe.ai).

## Install

```bash
npm install @agentghost/openai
export AI_GATEWAY_API_KEY=... # Jev via Vercel AI Gateway
```

## Usage

OpenAI hands the model schemas and expects your code to run the call. Wrap that
dispatcher, then call `run(name, args)` instead of switching on the name:

```ts
import { guardOpenAI } from "@agentghost/openai";

const run = guardOpenAI(executeTool, { tools, intent: () => currentTask });

for (const call of message.tool_calls ?? []) {
  const args = JSON.parse(call.function.arguments);
  const result = await run(call.function.name, args);
}
```

Anthropic's flatter `input_schema` format is supported too:

```ts
import { guardAnthropic } from "@agentghost/openai";
const run = guardAnthropic(executeTool, { tools, intent: () => currentTask });
```

## Handling ASK

`ASK` and `DENY` throw by default. Catch them to feed a denial back to the model,
or wire approval in one line:

```ts
import { guardOpenAI, approveWith, terminalApproval } from "@agentghost/openai";

guardOpenAI(execute, { tools, intent, onAsk: terminalApproval() });
```

Read-only tools can skip the judge entirely:

```ts
guardOpenAI(execute, { tools, intent, allow: ["get_order", "list_tickets"] });
```

See the [full documentation](https://github.com/reddpy/AgentGhost#readme).
