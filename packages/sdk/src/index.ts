export type {
  AuthorizeRequest,
  Decision,
  DecisionHandler,
  AskHandler,
  DenyHandler,
  AgentGhostAction,
  AgentGhostActionRecord,
  AgentGhostContext,
  AgentGhostIntent,
  IntentInput,
  Judge,
  JudgeResult,
  RiskLevel,
  Rule,
  RuleResult,
  ToolDescriptor,
  Verdict,
} from "./types.js";

export {
  AgentGhostApprovalRequiredError,
  AgentGhostConfigError,
  AgentGhostDeniedError,
  AgentGhostError,
} from "./errors.js";

export {
  allowOnly,
  allowTools,
  askTools,
  custom,
  denyTools,
  matchArg,
  type ArgPatternOptions,
} from "./rules.js";

export {
  buildQuestions,
  buildState,
  defineJudge,
  interpretAnswers,
  type InterpretOptions,
  type JevAnswer,
  type JevQuestion,
  type JevQuestions,
  type SystemOneClient,
  type SystemOneInput,
  type SystemOneResponse,
} from "./judge.js";

export {
  createDefaultJudge,
  createGatewayJudge,
  createJevJudge,
  createJevJudgeFromClient,
  createJevJudgeFromEvaluate,
  isJudgeConfigured,
  resolveJudgeKind,
  type AiSdkEvaluate,
  type GatewayJudgeOptions,
  type JevJudgeOptions,
  type JudgeKind,
} from "./jev.js";

export {
  createGenericAdapter,
  findExecutableKey,
  genericAdapter,
  isExecutableTool,
  selectAdapter,
  type AuthorizeAndCall,
  type ToolAdapter,
} from "./adapter.js";

export {
  createGuardEngine,
  type GuardEngine,
  type GuardOptions,
} from "./engine.js";

export {
  authorize,
  defineGuard,
  guard,
  guardDispatcher,
  type AuthorizeOptions,
  type DispatcherTool,
  type ToolDispatcher,
} from "./guard.js";

export {
  approveWith,
  terminalApproval,
  type ApprovalDecider,
  type TerminalApprovalOptions,
} from "./approval.js";

export { extractArgs, extractSignal, isPlainObject, safeStringify, truncate } from "./util.js";
