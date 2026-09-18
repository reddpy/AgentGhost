<p align="center">
  <img src="https://raw.githubusercontent.com/reddpy/AgentGhost/main/docs/agentghost_icon.png" alt="AgentGhost" width="76">
</p>

# @agentghost/langchain

Intent-aware authorization for [LangChain.js](https://js.langchain.com) tools.
Wrap your tools so every consequential action passes an `ALLOW` / `ASK` / `DENY`
check before it runs, decided by [Jev](https://typesafe.ai).

## Install

```bash
npm install @agentghost/langchain
export AI_GATEWAY_API_KEY=... # Jev via Vercel AI Gateway
```

## Usage

```ts
import { createAgent } from "langchain";
import { guard } from "@agentghost/langchain";

const safeTools = guard(tools, { intent: () => currentTask });
const agent = createAgent({ model, tools: safeTools });
```

Tools keep their prototype: `guard()` wraps each tool in a Proxy that intercepts
its call method, so the authorization check runs exactly once however the tool
is invoked.

## Handling ASK

`ASK` and `DENY` throw by default. Add approval in one line:

```ts
import { guard, approveWith, terminalApproval } from "@agentghost/langchain";

guard(tools, { intent, onAsk: approveWith((req) => ui.confirm(req)) });
guard(tools, { intent, onAsk: terminalApproval() }); // y/N, denies without a TTY
```

Read-only tools can skip the judge entirely:

```ts
guard(tools, { intent, allow: ["search", "read_file"] });
```

See the [full documentation](https://github.com/reddpy/AgentGhost#readme).
