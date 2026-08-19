/**
 * Pure per-stage evaluation policy for the pipeline FSM.
 *
 * Adapts a raw stage execution into the decision kernel's shape, runs the pure
 * decision, routing, and budget functions, and classifies the combined result
 * into a typed run failure or a go-ahead. No I/O and no state mutation — the
 * FSM shell owns sequencing and persistence.
 *
 * @packageDocumentation
 */

import { evaluateRunBudget, evaluateStageBudget, type RunBudget } from "./budgets.js";
import {
  routeStageDecision,
  type StageRouteDecision,
  type StageRouteFailureCode,
} from "./routing.js";
import {
  checkStageDecision,
  type StageDecision,
  type StageDecisionExecutionResult,
  type StageDecisionOutput,
} from "./stage-decision.js";

import type { CompiledStageDef } from "../rundef/index.js";
import type { StageExecutionOutput, StageExecutionResult } from "../executors/index.js";
import type { RunEconomicsSummary } from "../state/index.js";

/** Terminal status of one FSM run over the compiled stages. */
export type PipelineRunStatus = "done" | "failed" | "needs-attention";

/** Stable machine-readable failure code for a non-done FSM run. */
export type PipelineRunFailureCode =
  | StageRouteFailureCode
  | "aborted"
  | "executor-error"
  | "scope-attestation-failed"
  | "stage-budget-exceeded"
  | "run-budget-exceeded";

/** Typed terminal failure attached to a non-done FSM run result. */
export interface PipelineRunFailure {
  /** Stable machine-readable failure code. */
  readonly code: PipelineRunFailureCode;

  /** Stage id the failure is attributed to, when known. */
  readonly stageId?: string;

  /** Human-readable failure reason. */
  readonly reason: string;
}

/** Request for evaluating one raw stage execution. */
export interface EvaluateStageExecutionRequest {
  /** Story id being supervised by the active run. */
  readonly storyId?: string;

  /** Compiled stages in execution order. */
  readonly stages: readonly CompiledStageDef[];

  /** Stage that was executed. */
  readonly stage: CompiledStageDef;

  /** Raw execution result returned by the executor. */
  readonly execution: StageExecutionResult;

  /** Regressions performed before this execution. */
  readonly regressions: number;

  /** Maximum allowed regressions before failing closed. */
  readonly maxRegressions: number;

  /** Optional aggregate run budget ceiling. */
  readonly runBudget?: RunBudget;

  /** Run economics including this execution's usage. */
  readonly economicsAfter: RunEconomicsSummary;
}

/** Combined pure evaluation of one stage execution. */
export interface StageEvaluation {
  /** Pure gate decision for the execution. */
  readonly decision: StageDecision;

  /** Pure route decision derived from the gate decision. */
  readonly route: StageRouteDecision;

  /** Typed budget failure, or null when all budgets passed. */
  readonly budgetFailure: PipelineRunFailure | null;
}

/** Terminal classification of one evaluated stage execution. */
export interface StageFailureOutcome {
  /** Terminal run status implied by the failure. */
  readonly status: "failed" | "needs-attention";

  /** Typed failure details. */
  readonly failure: PipelineRunFailure;
}

/**
 * Evaluates one raw stage execution with the pure decision/route/budget kernel.
 *
 * @param request - Stage, execution result, regression counters, and budgets.
 *
 * @returns Combined decision, route, and budget evaluation.
 *
 * @example
 * ```ts
 * const evaluation = evaluateStageExecution({ stages, stage, execution,
 *   regressions: 0, maxRegressions: 3, economicsAfter: { tokens: 1, dollars: 0 } });
 * ```
 */
export const evaluateStageExecution = (request: EvaluateStageExecutionRequest): StageEvaluation => {
  const decision = checkStageDecision({
    stage: request.stage,
    ...(request.storyId === undefined ? {} : { storyId: request.storyId }),
    result: toDecisionResult(request.execution),
  });
  const route = routeStageDecision({
    stages: request.stages,
    stage: request.stage,
    decision,
    regressions: request.regressions,
    maxRegressions: request.maxRegressions,
  });
  return { decision, route, budgetFailure: evaluateBudgetFailure(request, decision) };
};

/**
 * Classifies an evaluation into a terminal failure outcome, or null to proceed.
 *
 * @param evaluation - Combined stage evaluation.
 * @param stageId - Stage id the evaluation belongs to.
 *
 * @returns Terminal failure outcome, or null when the run should proceed.
 *
 * @example
 * ```ts
 * const outcome = stageFailureOutcome(evaluation, "dev-story");
 * ```
 */
export const stageFailureOutcome = (
  evaluation: StageEvaluation,
  stageId: string,
): StageFailureOutcome | null => {
  if (evaluation.decision.kind === "aborted") {
    return {
      status: "needs-attention",
      failure: failureOf("aborted", evaluation.decision.reason, stageId),
    };
  }
  if (evaluation.budgetFailure !== null) {
    return { status: "needs-attention", failure: evaluation.budgetFailure };
  }
  if (evaluation.route.action === "fail") {
    const code = evaluation.route.failureCode ?? "stage-failed";
    return { status: "failed", failure: failureOf(code, evaluation.route.reason, stageId) };
  }
  return null;
};

/**
 * Builds a frozen typed run failure.
 *
 * @param code - Stable machine-readable failure code.
 * @param reason - Human-readable failure reason.
 * @param stageId - Stage id the failure is attributed to.
 *
 * @returns Frozen typed failure.
 *
 * @example
 * ```ts
 * const failure = failureOf("aborted", "Run aborted.", "dev-story");
 * ```
 */
export const failureOf = (
  code: PipelineRunFailureCode,
  reason: string,
  stageId: string,
): PipelineRunFailure => Object.freeze({ code, stageId, reason });

/**
 * Extracts a stable message from an unknown thrown value.
 *
 * @param error - Unknown thrown value.
 *
 * @returns Error message, the string itself, or a JSON rendering.
 *
 * @example
 * ```ts
 * const reason = errorMessage(new Error("spawn failed"));
 * ```
 */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
};

const evaluateBudgetFailure = (
  request: EvaluateStageExecutionRequest,
  decision: StageDecision,
): PipelineRunFailure | null => {
  const stageEval = evaluateStageBudget({
    stage: request.stage,
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
  });
  if (!stageEval.passed) {
    return failureOf("stage-budget-exceeded", stageEval.reason, request.stage.id);
  }
  const runEval = evaluateRunBudget({
    ...(request.runBudget === undefined ? {} : { budget: request.runBudget }),
    usage: request.economicsAfter,
  });
  return runEval.passed ? null : failureOf("run-budget-exceeded", runEval.reason, request.stage.id);
};

const toDecisionResult = (execution: StageExecutionResult): StageDecisionExecutionResult => ({
  ...execution,
  output: toDecisionOutput(execution.output),
});

const toDecisionOutput = (output: StageExecutionOutput | null): StageDecisionOutput | null => {
  if (output === null) {
    return null;
  }
  const payload = output["payload"];
  return isPayloadRecord(payload) ? { payload } : null;
};

const isPayloadRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
