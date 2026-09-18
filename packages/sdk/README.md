<p align="center">
  <img src="https://raw.githubusercontent.com/reddpy/agentghost/main/docs/agentghost_icon.png" alt="AgentGhost" width="76">
</p>

# @agentghost/sdk

Intent-aware authorization for AI agent tools. AgentGhost wraps a tool's
execution function so every consequential action passes an `ALLOW` / `ASK` /
`DENY` check before it runs. Decisions come from [Jev](https://typesafe.ai), a
fast System One model, with deterministic rules as a first pass.

This is the core package. Most apps use a framework adapter:
[`@agentghost/vercel`](https://www.npmjs.com/package/@agentghost/vercel),
[`@agentghost/langchain`](https://www.npmjs.com/package/@agentghost/langchain),
or [`@agentghost/openai`](https://www.npmjs.com/package/@agentghost/openai).

## Install

```bash
npm install @agentghost/sdk
```

Set a judge key — AgentGhost reads it automatically:

```bash
export AI_GATEWAY_API_KEY=...        # Jev via Vercel AI Gateway
# or
export TYPESAFE_API_KEY=...          # Jev direct API
```

## Requirements

- **Node.js 20+** (ESM and CommonJS, with TypeScript types).
- A judge key as above (the Gateway path needs the optional `ai` peer at AI SDK
  7.0.105+; the direct path uses `fetch`), or your own `Judge`.
- No runtime dependencies.

## Usage

```ts
import { guard } from "@agentghost/sdk";

const safeTools = guard(tools, { intent: () => currentTask });
```

`guard()` returns the same tools with each execution wrapped. `intent` is a
function because the user's task changes during a conversation.

## Handling ASK

`ASK` and `DENY` throw by default. Wire approval in one line:

```ts
import { approveWith, terminalApproval } from "@agentghost/sdk";

guard(tools, { intent, onAsk: approveWith((req) => ui.confirm(req)) });
guard(tools, { intent, onAsk: terminalApproval() }); // y/N prompt
```

## Policies without the model

```ts
guard(tools, {
  intent,
  allow: ["read_file", "search"], // read-only: skip the judge
  ask: ["send_email"],
  deny: ["drop_database"],
});
```

## Switching the judge

Jev is reachable through several transports behind the same `Judge` interface:

```ts
import { createJevJudge, createJevJudgeFromEvaluate, defineJudge } from "@agentghost/sdk";

createJevJudge({ baseUrl, apiKey });                 // any System One endpoint
createJevJudgeFromEvaluate({ evaluate, model });     // any AI-SDK gateway/model
defineJudge("my-model", async (request) => ({ decision: "ALLOW" }));
```

Force a built-in provider with `AGENTGHOST_JUDGE=gateway` or `=typesafe`.

## Config

```ts
guard(tools, {
  intent,
  rules: [],                 // deterministic checks, run first
  protect: ["send_email"],   // only protect these (default: all)
  failMode: "closed",        // deny when the judge errors (default)
  evaluate: "always",        // "once" caches identical decisions
  historyLimit: 50,          // past actions kept in context
  onDecision: (req, verdict) => audit.log(verdict),
});
```

Missing config fails fast: `guard()` throws `AgentGhostConfigError` if there is
no judge, no key, and no `judge: null`.

See the [full documentation](https://github.com/reddpy/agentghost#readme).
