/* eslint-disable max-lines, jsdoc/require-param, jsdoc/require-returns, jsdoc/require-throws, @typescript-eslint/no-unsafe-assignment -- Cohesive frozen structural transitions preserve dynamic stage records and atomic receipt migration. */
/**
 * Pure durable-state transition constructors for the pipeline FSM.
 *
 * Every function takes the previous {@link PipelineState} plus a small update
 * description and returns a new frozen state — no I/O, no clocks, no mutation.
 * The FSM shell in pipeline-runner.ts sequences these transitions and persists
 * each returned state.
 *
 * @packageDocumentation
 */

import {
  RUNNER_FEATURE_VERSION,
  createInitialStageState,
  type FinalScopeReceipt,
  type PipelineState,
  type PipelineStatus,
  type ReviewScopeCheckpoint,
  type RunEconomicsSummary,
  type StageAttemptState,
  type StageState,
} from "../state/index.js";

import type { StageDecision } from "./stage-decision.js";
import type { StageExecutionResult, StageExecutionUsage } from "../executors/index.js";
import type { StageHandoff } from "../security/stage-handoff.js";

/** Update describing one settled stage attempt to fold into durable state. */
export interface StageAttemptOutcome {
  /** Stage id the attempt belongs to. */
  readonly stageId: string;

  /** One-based attempt number. */
  readonly attempt: number;

  /** Pure gate decision for the execution. */
  readonly decision: StageDecision;

  /** Raw execution result returned by the executor. */
  readonly execution: StageExecutionResult;

  /** Updated regression count after routing. */
  readonly regressions: number;

  /** Actual routed successor stage id, or null when terminal. */
  readonly successorId: string | null;

  /** Regression target stage id, or null when not regressing. */
  readonly regressionTargetId: string | null;

  /** Optional normalized payload to attach to the routed successor. */
  readonly upstreamHandoff?: StageHandoff;

  /** ISO timestamp when the attempt finished. */
  readonly finishedAt: string;
}

/** Update describing an executor throw for one stage attempt. */
export interface ExecutorErrorOutcome {
  /** Stage id the attempt belongs to. */
  readonly stageId: string;

  /** One-based attempt number. */
  readonly attempt: number;

  /** Failure reason extracted from the thrown error. */
  readonly reason: string;

  /** ISO timestamp when the failure was observed. */
  readonly finishedAt: string;
}

/**
 * Returns the durable stage state, or fresh pending state when absent.
 *
 * @param state - Durable pipeline state.
 * @param stageId - Stage id to look up.
 *
 * @returns Existing stage state, or a fresh pending stage state.
 *
 * @example
 * ```ts
 * const stageState = stageStateOf(state, "dev-story");
 * ```
 */
export const stageStateOf = (state: PipelineState, stageId: string): StageState =>
  state.stages[stageId] ?? createInitialStageState({ id: stageId });

/**
 * Marks one stage (and the pipeline) as running; preserves carried findings.
 *
 * @param state - Durable pipeline state.
 * @param stageId - Stage id to mark running.
 * @param startedAt - ISO timestamp when the attempt started.
 *
 * @returns New frozen state with the stage and pipeline marked running.
 *
 * @example
 * ```ts
 * const next = markStageRunning(state, "dev-story", new Date().toISOString());
 * ```
 */
export const markStageRunning = (
  state: PipelineState,
  stageId: string,
  startedAt: string,
): PipelineState => {
  const previous = stageStateOf(state, stageId);
  const running: StageState = Object.freeze({
    id: stageId,
    status: "running",
    attempts: previous.attempts,
    startedAt,
    finishedAt: null,
    history: previous.history,
    ...(previous.reason === undefined ? {} : { reason: previous.reason }),
    ...(previous.findings === undefined ? {} : { findings: previous.findings }),
    ...(previous.upstreamHandoff === undefined
      ? {}
      : { upstreamHandoff: previous.upstreamHandoff }),
  });
  return withStage(
    {
      ...state,
      status: "running",
      currentStage: stageId,
      startedAt: state.startedAt ?? startedAt,
    },
    running,
  );
};

/**
 * Folds one settled stage attempt into durable state, including regression resets.
 *
 * @param state - Durable pipeline state.
 * @param outcome - Settled attempt description.
 *
 * @returns New frozen state with the attempt recorded.
 *
 * @example
 * ```ts
 * const next = applyStageOutcome(state, outcome);
 * ```
 */
export const applyStageOutcome = (
  state: PipelineState,
  outcome: StageAttemptOutcome,
): PipelineState => {
  const previous = stageStateOf(state, outcome.stageId);
  const base = withStage(
    {
      ...state,
      regressions: outcome.regressions,
      economics: accumulateEconomics(state.economics, outcome.execution.usage),
    },
    buildFinishedStage(previous, outcome),
  );
  if (outcome.regressionTargetId !== null) {
    return resetRegressionTarget(base, {
      targetId: outcome.regressionTargetId,
      decision: outcome.decision,
      upstreamHandoff: outcome.upstreamHandoff,
    });
  }
  return outcome.successorId === null
    ? base
    : replaceSuccessorHandoff(base, outcome.successorId, outcome.upstreamHandoff);
};

/**
 * Folds an executor throw into durable state as a failed attempt.
 *
 * @param state - Durable pipeline state.
 * @param outcome - Executor failure description.
 *
 * @returns New frozen state with the failed attempt recorded.
 *
 * @example
 * ```ts
 * const next = applyExecutorError(state, outcome);
 * ```
 */
export const applyExecutorError = (
  state: PipelineState,
  outcome: ExecutorErrorOutcome,
): PipelineState => {
  const previous = stageStateOf(state, outcome.stageId);
  const attempt: StageAttemptState = Object.freeze({
    attempt: outcome.attempt,
    status: "failed",
    startedAt: previous.startedAt,
    finishedAt: outcome.finishedAt,
    durationMs: null,
    exitCode: null,
    reason: outcome.reason,
  });
  return withStage(
    state,
    Object.freeze({
      id: outcome.stageId,
      status: "failed",
      attempts: outcome.attempt,
      startedAt: previous.startedAt,
      finishedAt: outcome.finishedAt,
      history: Object.freeze([...previous.history, attempt]),
      reason: outcome.reason,
    }),
  );
};

/**
 * Attaches a review checkpoint and removes any stale final receipt.
 *
 * @param state - Current durable state.
 * @param checkpoint - Trusted review checkpoint.
 *
 * @returns Frozen state containing only the current review attestation.
 */
export const attachReviewCheckpoint = (
  state: PipelineState,
  checkpoint: ReviewScopeCheckpoint,
): PipelineState => {
  const withoutReceipt = structuredClone(state);
  Reflect.deleteProperty(withoutReceipt, "finalScopeReceipt");
  return cloneFrozenState({
    ...withoutReceipt,
    runnerFeatureVersion: scopeAttachmentFeatureVersion(state),
    reviewCheckpoint: checkpoint,
  });
};

/**
 * Attaches a final receipt, deriving its matching checkpoint when necessary.
 *
 * @param state - Current durable state.
 * @param receipt - Trusted final scope receipt.
 *
 * @returns Frozen receipt-bearing preterminal state.
 */
export const attachFinalScopeReceipt = (
  state: PipelineState,
  receipt: FinalScopeReceipt,
): PipelineState =>
  cloneFrozenState({
    ...state,
    runnerFeatureVersion: scopeAttachmentFeatureVersion(state),
    reviewCheckpoint: state.reviewCheckpoint ?? checkpointOf(receipt),
    finalScopeReceipt: receipt,
  });

/**
 * Builds the frozen terminal state for a finished run.
 *
 * @param state - Durable pipeline state.
 * @param status - Terminal pipeline status.
 * @param finishedAt - ISO timestamp when the run finished.
 *
 * @returns New frozen terminal state.
 *
 * @throws TypeError When terminal success has no final scope receipt.
 *
 * @example
 * ```ts
 * const terminal = finalizeState(state, "done", new Date().toISOString());
 * ```
 */
export const finalizeState = (
  state: PipelineState,
  status: PipelineStatus,
  finishedAt: string,
): PipelineState => {
  if (status === "done" && state.finalScopeReceipt === undefined) {
    throw new TypeError("A final scope receipt is required before terminal success.");
  }
  return Object.freeze({
    ...state,
    status,
    currentStage: null,
    startedAt: state.startedAt ?? finishedAt,
    finishedAt,
  });
};

/** Clears scope approval and resets review plus downstream without consuming regression budget. */
export const resetReviewAndDownstream = (
  state: PipelineState,
  orderedStageIds: readonly string[],
  reviewStageId: string,
): PipelineState => {
  const reviewIndex = orderedStageIds.indexOf(reviewStageId);
  if (reviewIndex < 0) {
    throw new RangeError(`Review stage "${reviewStageId}" is not in the compiled pipeline.`);
  }
  const stages = Object.fromEntries(
    Object.entries(state.stages).map(([stageId, stageState]) => {
      const stageIndex = orderedStageIds.indexOf(stageId);
      return stageIndex < reviewIndex
        ? [stageId, stageState]
        : [
            stageId,
            Object.freeze({
              id: stageState.id,
              status: "pending" as const,
              attempts: stageState.attempts,
              startedAt: null,
              finishedAt: null,
              history: stageState.history,
            }),
          ];
    }),
  );
  const withoutApproval = structuredClone(state);
  Reflect.deleteProperty(withoutApproval, "reviewCheckpoint");
  Reflect.deleteProperty(withoutApproval, "finalScopeReceipt");
  return cloneFrozenState({
    ...withoutApproval,
    status: "running",
    currentStage: null,
    stages,
    finishedAt: null,
  });
};

/** Clears stale scope approval and consumes one regression before rerun. */
export const invalidateReviewApproval = (
  state: PipelineState,
  orderedStageIds: readonly string[],
  reviewStageId: string,
): PipelineState =>
  resetReviewAndDownstream(
    { ...state, regressions: state.regressions + 1 },
    orderedStageIds,
    reviewStageId,
  );

/**
 * Adds attempt usage onto aggregated run economics.
 *
 * @param economics - Aggregated run economics so far.
 * @param usage - Optional usage reported by one execution.
 *
 * @returns Frozen updated economics, or the input when usage is absent.
 *
 * @example
 * ```ts
 * const next = accumulateEconomics(state.economics, { tokens: 10, dollars: 0.1 });
 * ```
 */
export const accumulateEconomics = (
  economics: RunEconomicsSummary,
  usage: StageExecutionUsage | undefined,
): RunEconomicsSummary =>
  usage === undefined
    ? economics
    : Object.freeze({
        tokens: economics.tokens + usage.tokens,
        dollars: economics.dollars + usage.dollars,
      });

/**
 * Returns a deeply frozen defensive copy of durable state.
 *
 * @param state - Durable pipeline state to copy.
 *
 * @returns Deeply frozen structural clone.
 *
 * @example
 * ```ts
 * const frozen = cloneFrozenState(state);
 * ```
 */
export const cloneFrozenState = (state: PipelineState): PipelineState =>
  deepFreeze(structuredClone(state));

const withStage = (state: PipelineState, stageState: StageState): PipelineState =>
  Object.freeze({
    ...state,
    stages: Object.freeze({ ...state.stages, [stageState.id]: stageState }),
  });

const buildAttempt = (previous: StageState, outcome: StageAttemptOutcome): StageAttemptState =>
  Object.freeze({
    attempt: outcome.attempt,
    status: outcome.decision.kind,
    startedAt: previous.startedAt,
    finishedAt: outcome.finishedAt,
    durationMs: outcome.execution.durationMs,
    exitCode: outcome.execution.exitCode,
    ...(outcome.execution.parseError === undefined
      ? {}
      : { parseError: outcome.execution.parseError }),
    reason: outcome.decision.reason,
    ...(outcome.decision.findings === undefined
      ? {}
      : { findings: Object.freeze([...outcome.decision.findings]) }),
    ...(outcome.execution.usage === undefined
      ? {}
      : { usage: Object.freeze({ ...outcome.execution.usage }) }),
  });

const buildFinishedStage = (previous: StageState, outcome: StageAttemptOutcome): StageState =>
  Object.freeze({
    id: outcome.stageId,
    status: outcome.decision.passed ? "passed" : "failed",
    attempts: outcome.attempt,
    startedAt: previous.startedAt,
    finishedAt: outcome.finishedAt,
    history: Object.freeze([...previous.history, buildAttempt(previous, outcome)]),
    reason: outcome.decision.reason,
  });

const replaceSuccessorHandoff = (
  state: PipelineState,
  targetId: string,
  upstreamHandoff: StageHandoff | undefined,
): PipelineState => {
  const previous = stageStateOf(state, targetId);
  return withStage(
    state,
    Object.freeze({
      id: previous.id,
      status: previous.status,
      attempts: previous.attempts,
      startedAt: previous.startedAt,
      finishedAt: previous.finishedAt,
      history: previous.history,
      ...(previous.reason === undefined ? {} : { reason: previous.reason }),
      ...(previous.findings === undefined ? {} : { findings: previous.findings }),
      ...(upstreamHandoff === undefined ? {} : { upstreamHandoff }),
    }),
  );
};

interface ResetRegressionTargetRequest {
  readonly targetId: string;
  readonly decision: StageDecision;
  readonly upstreamHandoff: StageHandoff | undefined;
}

const resetRegressionTarget = (
  state: PipelineState,
  request: ResetRegressionTargetRequest,
): PipelineState => {
  const previous = stageStateOf(state, request.targetId);
  // Any regression can mutate reviewed bytes. Drop stale approval before the
  // target runs so a later review may transition from passed back to running.
  const withoutApproval = structuredClone(state);
  Reflect.deleteProperty(withoutApproval, "reviewCheckpoint");
  Reflect.deleteProperty(withoutApproval, "finalScopeReceipt");
  return withStage(
    withoutApproval,
    Object.freeze({
      id: request.targetId,
      status: "pending",
      attempts: previous.attempts,
      startedAt: null,
      finishedAt: null,
      history: previous.history,
      ...(request.decision.findings === undefined
        ? {}
        : { findings: Object.freeze([...request.decision.findings]) }),
      ...(request.upstreamHandoff === undefined
        ? {}
        : { upstreamHandoff: request.upstreamHandoff }),
    }),
  );
};

const scopeAttachmentFeatureVersion = (state: PipelineState): number =>
  (state.status === "pending" || state.status === "running") &&
  Number.isInteger(state.runnerFeatureVersion) &&
  state.runnerFeatureVersion >= 0 &&
  state.runnerFeatureVersion < RUNNER_FEATURE_VERSION &&
  state.reviewCheckpoint === undefined &&
  state.finalScopeReceipt === undefined
    ? RUNNER_FEATURE_VERSION
    : state.runnerFeatureVersion;

const checkpointOf = (receipt: FinalScopeReceipt): ReviewScopeCheckpoint => ({
  version: receipt.version,
  storyId: receipt.storyId,
  runId: receipt.runId,
  runDefId: receipt.runDefId,
  runDefDigest: receipt.runDefDigest,
  branch: receipt.branch,
  baseOid: receipt.baseOid,
  reviewed: receipt.reviewed,
  qualityGate: receipt.qualityGate,
});

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
};
