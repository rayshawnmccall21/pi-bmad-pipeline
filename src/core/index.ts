/** Public core subsystem exports. */

export { evaluateRunBudget, evaluateStageBudget, isBudgetUsage } from "./budgets.js";
export { DEFAULT_MAX_REGRESSIONS, runPipelineStages } from "./pipeline-runner.js";
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
} from "./pipeline-runner.js";

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
