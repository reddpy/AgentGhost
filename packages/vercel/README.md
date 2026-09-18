<p align="center">
  <img src="https://raw.githubusercontent.com/reddpy/AgentGhost/main/docs/agentghost_icon.png" alt="AgentGhost" width="76">
</p>

# @agentghost/vercel

Intent-aware authorization for [Vercel AI SDK](https://ai-sdk.dev) tools. Wrap
your tools so every consequential action passes an `ALLOW` / `ASK` / `DENY`
check before it runs, decided by [Jev](https://typesafe.ai).

## Install

```bash
npm install @agentghost/vercel ai
export AI_GATEWAY_API_KEY=... # Jev via Vercel AI Gateway
```

## Usage

```ts
import { generateText } from "ai";
import { guard } from "@agentghost/vercel";

const safeTools = guard(tools, { intent: () => currentTask });

const result = await generateText({ model, tools: safeTools, prompt });
```

`guard()` returns the same tool set with each `execute` wrapped, so it drops
into `generateText`, `streamText`, or a `ToolLoopAgent` unchanged.

```ts
import { ToolLoopAgent, stepCountIs } from "ai";

const agent = new ToolLoopAgent({ model, tools: safeTools, stopWhen: stepCountIs(10) });
```

## Handling ASK

`ASK` and `DENY` throw by default; a blocked call surfaces to the model as a
tool error. Add approval in one line:

```ts
import { guard, approveWith, terminalApproval } from "@agentghost/vercel";

guard(tools, { intent, onAsk: approveWith((req) => ui.confirm(req)) });
guard(tools, { intent, onAsk: terminalApproval() }); // y/N, denies without a TTY
```

Read-only tools can skip the judge entirely:

```ts
guard(tools, { intent, allow: ["list_files", "read_file"] });
```

See the [full documentation](https://github.com/reddpy/AgentGhost#readme).
