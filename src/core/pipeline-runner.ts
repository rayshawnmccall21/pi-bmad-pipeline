/* eslint-disable max-lines, @typescript-eslint/no-unnecessary-condition -- The FSM loop explicitly sequences durable attestation and bounded review rerouting. */
/**
 * Durable pipeline FSM: a thin imperative shell over the pure stage kernel.
 *
 * Runs compiled stages in order through an injected {@link WorkflowExecutor},
 * evaluates each execution with the pure kernel (runner-evaluation.ts), folds
 * results into durable state with pure transition constructors
 * (runner-transitions.ts), persists state after every transition, and reports
 * every run outcome as data. Throws are reserved for programmer errors
 * (invalid requests). No process, filesystem, or event-protocol access — all
 * effects are injected.
 *
 * @packageDocumentation
 */

import { findStageById, type StageRouteDecision } from "./routing.js";
import {
  errorMessage,
  evaluateStageExecution,
  failureOf,
  stageFailureOutcome,
  type PipelineRunFailure,
  type PipelineRunStatus,
  type StageEvaluation,
} from "./runner-evaluation.js";
import {
  accumulateEconomics,
  applyExecutorError,
  applyStageOutcome,
  cloneFrozenState,
  finalizeState,
  invalidateReviewApproval,
  markStageRunning,
  resetReviewAndDownstream,
  stageStateOf,
} from "./runner-transitions.js";
import {
  finalScopeFailureStageId,
  isCodeReviewStage,
  persistFinalScopeAttestation,
  persistPassedReviewAttestation,
  type ScopeAttestor,
} from "./scope-attestation.js";
import { getPipelineStateInvalidReason } from "../state/fs-state-validation.js";
import {
  RUNNER_FEATURE_VERSION,
  getFirstIncompleteStageId,
  isTerminalPipelineStatus,
  type PipelineState,
} from "../state/index.js";
import { createStageHandoff } from "../security/stage-handoff.js";

import type { RunBudget } from "./budgets.js";
import type { StageDecision } from "./stage-decision.js";
import type { CompiledStageDef } from "../rundef/index.js";
import type { StageExecutionResult, WorkflowExecutor } from "../executors/index.js";

export type {
  PipelineRunFailure,
  PipelineRunFailureCode,
  PipelineRunStatus,
} from "./runner-evaluation.js";

/** Default number of gate-triggered regressions allowed before failing closed. */
export const DEFAULT_MAX_REGRESSIONS = 3;

/** Info passed to the observer when a stage attempt starts. */
export interface PipelineStageStartInfo {
  /** Compiled stage that is starting. */
  readonly stage: CompiledStageDef;

  /** One-based attempt number for the stage. */
  readonly attempt: number;
}

/** Info passed to the observer after a stage attempt is persisted. */
export interface PipelineStageFinishInfo {
  /** Compiled stage that finished. */
  readonly stage: CompiledStageDef;

  /** One-based attempt number for the stage. */
  readonly attempt: number;

  /** Pure gate decision for the execution. */
  readonly decision: StageDecision;

  /** Pure route decision derived from the gate decision. */
  readonly route: StageRouteDecision;

  /** Raw execution result returned by the executor. */
  readonly execution: StageExecutionResult;
}

/** Narrow observer callbacks for stage lifecycle; no event-protocol coupling. */
export interface PipelineStageObserver {
  /** Called before a stage attempt is executed. */
  readonly onStageStarted?: (info: PipelineStageStartInfo) => void;

  /** Called after a stage attempt outcome has been persisted. */
  readonly onStageFinished?: (info: PipelineStageFinishInfo) => void;
}

/** Request for running compiled pipeline stages to a terminal outcome. */
export interface RunPipelineStagesRequest {
  /** Compiled stages in execution order. */
  readonly stages: readonly CompiledStageDef[];

  /** Starting durable state, fresh or reconciled. */
  readonly state: PipelineState;

  /** Story id being supervised. */
  readonly storyId: string;

  /** Authenticated runner invocation id. */
  readonly runId: string;

  /** Trusted repository-scope attestation effect. */
  readonly attestScope: ScopeAttestor;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Project root directory for child execution. */
  readonly projectRoot: string;

  /** Executor used to run each stage. */
  readonly executor: WorkflowExecutor;

  /** Durable persistence effect awaited after every state transition. */
  readonly saveState: (state: PipelineState) => Promise<void>;

  /** Optional regression ceiling; defaults to {@link DEFAULT_MAX_REGRESSIONS}. */
  readonly maxRegressions?: number;

  /** Optional aggregate run budget ceiling. */
  readonly runBudget?: RunBudget;

  /** Optional abort signal checked before each stage spawn. */
  readonly signal?: AbortSignal;

  /** Optional clock seam for deterministic timestamps. */
  readonly now?: () => Date;

  /** Optional stage lifecycle observer. */
  readonly observer?: PipelineStageObserver;
}

/** Terminal result of one FSM run; outcomes are data, never throws. */
export interface RunPipelineStagesResult {
  /** Final frozen durable state. */
  readonly state: PipelineState;

  /** Terminal run status. */
  readonly status: PipelineRunStatus;

  /** Stage ids executed during this run, in execution order. */
  readonly stagesRun: readonly string[];

  /** Number of gate-triggered regressions performed. */
  readonly regressions: number;

  /** Typed failure details when the run did not complete. */
  readonly failure?: PipelineRunFailure;
}

interface RunContext {
  readonly request: RunPipelineStagesRequest;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly maxRegressions: number;
  readonly stagesRun: string[];
  state: PipelineState;
}

interface RunOutcome {
  readonly status: PipelineRunStatus;
  readonly failure?: PipelineRunFailure;
}

type StageStep =
  | { readonly kind: "advance"; readonly next: CompiledStageDef | null }
  | { readonly kind: "outcome"; readonly outcome: RunOutcome };

type ExecutionAttempt =
  | { readonly kind: "result"; readonly result: StageExecutionResult }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Runs compiled pipeline stages to a terminal outcome with durable state.
 *
 * @param request - Stages, starting state, executor, and injected effects.
 *
 * @returns Frozen terminal run result; all run outcomes are data.
 *
 * @throws RangeError When stages are empty or maxRegressions is invalid.
 *
 * @example
 * ```ts
 * const result = await runPipelineStages({ stages, state, storyId, specFile,
 *   projectRoot, executor, saveState });
 * ```
 */
export async function runPipelineStages(
  request: RunPipelineStagesRequest,
): Promise<RunPipelineStagesResult> {
  validateRunRequest(request);
  const context = createRunContext(request);
  const outcome = await runLoop(context);
  return finalizeRun(context, outcome);
}

const validateRunRequest = (request: RunPipelineStagesRequest): void => {
  if (request.stages.length === 0) {
    throw new RangeError("stages must not be empty.");
  }
  const max = request.maxRegressions;
  if (max !== undefined && (!Number.isInteger(max) || max < 0)) {
    throw new RangeError("maxRegressions must be a non-negative integer.");
  }
};

const createRunContext = (request: RunPipelineStagesRequest): RunContext => ({
  request,
  signal: request.signal ?? new AbortController().signal,
  now: request.now ?? ((): Date => new Date()),
  maxRegressions: request.maxRegressions ?? DEFAULT_MAX_REGRESSIONS,
  stagesRun: [],
  state: cloneFrozenState(request.state),
});

const runLoop = async (context: RunContext): Promise<RunOutcome> => {
  const stages = context.request.stages;
  await persistLegacyReviewRecovery(context);
  let stage = stageForId(stages, getFirstIncompleteStageId(context.state, stages));
  while (true) {
    const step =
      stage === null ? await runFinalScopeStep(context) : await runStageStep(context, stage);
    if (step.kind === "outcome") {
      return step.outcome;
    }
    stage = step.next;
  }
};

const persistLegacyReviewRecovery = async (context: RunContext): Promise<void> => {
  const reviewStageId = legacyPassedReviewStageId(context);
  if (reviewStageId === undefined) {
    return;
  }
  await transition(
    context,
    resetReviewAndDownstream(
      context.state,
      context.request.stages.map(({ id }) => id),
      reviewStageId,
    ),
  );
};

const legacyPassedReviewStageId = (context: RunContext): string | undefined =>
  isRecoverableLegacyState(context.state)
    ? context.request.stages.find(
        (stage) => isCodeReviewStage(stage) && context.state.stages[stage.id]?.status === "passed",
      )?.id
    : undefined;

const isRecoverableLegacyState = (state: PipelineState): boolean =>
  getPipelineStateInvalidReason(state) === undefined &&
  state.runnerFeatureVersion < RUNNER_FEATURE_VERSION &&
  !isTerminalPipelineStatus(state.status) &&
  state.reviewCheckpoint === undefined &&
  state.finalScopeReceipt === undefined;

const runFinalScopeStep = async (context: RunContext): Promise<StageStep> => {
  const finalScope = await persistFinalScopeAttestation(context);
  if (finalScope.kind === "attested") {
    return { kind: "outcome", outcome: { status: "done" } };
  }
  if (finalScope.kind === "rejected") {
    return outcomeStep(
      "needs-attention",
      failureOf("scope-attestation-failed", finalScope.reason, finalScopeFailureStageId(context)),
    );
  }
  return reviewInvalidationStep(context, finalScope.changedPaths);
};

const reviewInvalidationStep = async (
  context: RunContext,
  changedPaths: readonly string[],
): Promise<StageStep> => {
  const reviewStageId = context.state.reviewCheckpoint?.qualityGate.stageId;
  if (reviewStageId === undefined || context.state.regressions >= context.maxRegressions) {
    return outcomeStep(
      "needs-attention",
      failureOf(
        "scope-attestation-failed",
        `Reviewed scope changed after approval: ${changedPaths.join(", ")}.`,
        reviewStageId ?? finalScopeFailureStageId(context),
      ),
    );
  }
  const stages = context.request.stages;
  await transition(
    context,
    invalidateReviewApproval(
      context.state,
      stages.map(({ id }) => id),
      reviewStageId,
    ),
  );
  return { kind: "advance", next: stageForId(stages, reviewStageId) };
};

const runStageStep = async (context: RunContext, stage: CompiledStageDef): Promise<StageStep> => {
  if (context.signal.aborted) {
    const reason = `Run aborted before stage "${stage.id}".`;
    return outcomeStep("needs-attention", failureOf("aborted", reason, stage.id));
  }
  const attempt = stageStateOf(context.state, stage.id).attempts + 1;
  context.request.observer?.onStageStarted?.(Object.freeze({ stage, attempt }));
  await transition(context, markStageRunning(context.state, stage.id, isoTime(context)));
  const execution = await executeStage(context, stage, attempt);
  if (execution.kind === "error") {
    return settleExecutorError(context, { stage, attempt, reason: execution.reason });
  }
  return settleExecution(context, { stage, attempt, execution: execution.result });
};

const executeStage = async (
  context: RunContext,
  stage: CompiledStageDef,
  attempt: number,
): Promise<ExecutionAttempt> => {
  const invokedStage = stageStateOf(context.state, stage.id);
  const findings = invokedStage.findings;
  const { storyId, specFile, projectRoot } = context.request;
  try {
    const result = await context.request.executor.execute({
      stage,
      storyId,
      specFile,
      projectRoot,
      attempt,
      ...(findings === undefined ? {} : { priorFindings: [...findings] }),
      ...(invokedStage.upstreamHandoff === undefined
        ? {}
        : { upstreamHandoff: invokedStage.upstreamHandoff }),
      signal: context.signal,
    });
    return { kind: "result", result };
  } catch (error) {
    return { kind: "error", reason: errorMessage(error) };
  }
};

interface SettleInput {
  readonly stage: CompiledStageDef;
  readonly attempt: number;
  readonly execution: StageExecutionResult;
}

const settleExecution = async (context: RunContext, input: SettleInput): Promise<StageStep> => {
  const evaluated = evaluateStageExecution({
    storyId: context.request.storyId,
    stages: context.request.stages,
    stage: input.stage,
    execution: input.execution,
    regressions: context.state.regressions,
    maxRegressions: context.maxRegressions,
    ...(context.request.runBudget === undefined ? {} : { runBudget: context.request.runBudget }),
    economicsAfter: accumulateEconomics(context.state.economics, input.execution.usage),
  });
  await transition(context, stateAfterOutcome(context, input, evaluated));
  context.request.observer?.onStageFinished?.(
    Object.freeze({
      stage: input.stage,
      attempt: input.attempt,
      decision: evaluated.decision,
      route: evaluated.route,
      execution: input.execution,
    }),
  );
  context.stagesRun.push(input.stage.id);
  const attestationFailure = await persistPassedReviewAttestation(context, {
    stage: input.stage,
    attempt: input.attempt,
    passed: evaluated.decision.passed,
    finishedAt: context.state.stages[input.stage.id]?.finishedAt ?? isoTime(context),
  });
  return attestationFailure === undefined
    ? concludeStep(context, evaluated, input.stage)
    : outcomeStep(
        "needs-attention",
        failureOf("scope-attestation-failed", attestationFailure, input.stage.id),
      );
};

const stateAfterOutcome = (
  context: RunContext,
  input: SettleInput,
  evaluated: StageEvaluation,
): PipelineState => {
  const upstreamHandoff =
    input.execution.output === null
      ? undefined
      : createStageHandoff(input.execution.output["payload"]);
  return applyStageOutcome(context.state, {
    stageId: input.stage.id,
    attempt: input.attempt,
    decision: evaluated.decision,
    execution: input.execution,
    regressions: evaluated.route.regressions,
    successorId: evaluated.route.nextStageId ?? null,
    regressionTargetId:
      evaluated.route.action === "regress" ? (evaluated.route.nextStageId ?? null) : null,
    ...(upstreamHandoff === undefined ? {} : { upstreamHandoff }),
    finishedAt: isoTime(context),
  });
};

const concludeStep = (
  context: RunContext,
  evaluated: StageEvaluation,
  stage: CompiledStageDef,
): StageStep => {
  const failureStep = stageFailureOutcome(evaluated, stage.id);
  if (failureStep !== null) {
    return { kind: "outcome", outcome: failureStep };
  }
  const next = stageForId(context.request.stages, evaluated.route.nextStageId ?? null);
  return { kind: "advance", next };
};

const settleExecutorError = async (
  context: RunContext,
  input: { readonly stage: CompiledStageDef; readonly attempt: number; readonly reason: string },
): Promise<StageStep> => {
  const outcome = {
    stageId: input.stage.id,
    attempt: input.attempt,
    reason: input.reason,
    finishedAt: isoTime(context),
  };
  await transition(context, applyExecutorError(context.state, outcome));
  context.stagesRun.push(input.stage.id);
  return outcomeStep("needs-attention", failureOf("executor-error", input.reason, input.stage.id));
};

const finalizeRun = async (
  context: RunContext,
  outcome: RunOutcome,
): Promise<RunPipelineStagesResult> => {
  const terminal = finalizeState(context.state, outcome.status, isoTime(context));
  await transition(context, terminal);
  return Object.freeze({
    state: terminal,
    status: outcome.status,
    stagesRun: Object.freeze([...context.stagesRun]),
    regressions: terminal.regressions,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  });
};

const transition = async (context: RunContext, state: PipelineState): Promise<void> => {
  context.state = state;
  await context.request.saveState(state);
};

const stageForId = (
  stages: readonly CompiledStageDef[],
  stageId: string | null,
): CompiledStageDef | null => (stageId === null ? null : (findStageById(stages, stageId) ?? null));

const outcomeStep = (status: PipelineRunStatus, failure: PipelineRunFailure): StageStep => ({
  kind: "outcome",
  outcome: { status, failure },
});

const isoTime = (context: RunContext): string => context.now().toISOString();
