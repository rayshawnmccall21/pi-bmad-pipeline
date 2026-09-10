/** Public core subsystem exports. */

export { evaluateRunBudget, evaluateStageBudget, isBudgetUsage } from "./budgets.js";

export {
  DEFAULT_MAX_REGRESSIONS,
  TERMINAL_RECOVERY_KIND,
  TERMINAL_RECOVERY_REASON_MAX_BYTES,
  TERMINAL_RECOVERY_REJECTED_CODE,
  normalizeTerminalRecoveryReason,
  runPipelineStages,
} from "./pipeline-runner.js";
export { findNextStage, findStageById, routeStageDecision } from "./routing.js";
export { checkStageDecision } from "./stage-decision.js";

export type {
  BudgetUsage,
  BudgetedStage,
  EvaluateRunBudgetRequest,
  EvaluateStageBudgetRequest,
  RunBudget,
  RunBudgetEvaluation,
  StageBudgetEvaluation,
  StageBudgetExceededLimit,
  StageBudgetLimitKind,
} from "./budgets.js";

export type {
  PipelineRunFailure,
  PipelineRunFailureCode,
  PipelineRunStatus,
  PipelineStageFinishInfo,
  PipelineStageObserver,
  PipelineStageStartInfo,
  RunPipelineStagesRequest,
  RunPipelineStagesResult,
  TerminalRecoveryRequest,
} from "./pipeline-runner.js";

export type { TerminalRecoveryKind } from "../state/index.js";
export {
  EXPECTED_RECEIPT_RUN_ID_MAX_CHARS,
  RECEIPT_INTRODUCED_FEATURE_VERSION,
} from "../state/index.js";

export type {
  FinalScopeAttestationRequest,
  ReviewScopeAttestationRequest,
  ScopeAttestationRequest,
  ScopeAttestationResult,
  ScopeAttestor,
} from "./scope-attestation.js";

export type {
  EvaluateStageExecutionRequest,
  StageEvaluation,
  StageFailureOutcome,
} from "./runner-evaluation.js";

export type { ExecutorErrorOutcome, StageAttemptOutcome } from "./runner-transitions.js";

export type {
  RouteStageDecisionRequest,
  StageRouteAction,
  StageRouteDecision,
  StageRouteFailureCode,
} from "./routing.js";

export type {
  CheckStageDecisionRequest,
  StageDecision,
  StageDecisionExecutionResult,
  StageDecisionKind,
  StageDecisionOutput,
} from "./stage-decision.js";
