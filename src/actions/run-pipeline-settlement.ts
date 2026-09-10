/**
 * Settles terminal FSM outcomes and emits results.
 *
 * @packageDocumentation
 */

import {
  toRunResultStatus,
  type PipelineState,
  type RunResult,
  type RunResultStatus,
} from "../state/index.js";

import type { PipelineActionContext } from "./run-pipeline-action.js";
import type { PreparedPipeline } from "./run-pipeline-execution.js";
import type {
  PipelineStageFinishInfo,
  PipelineStageObserver,
  RunPipelineStagesResult,
} from "../core/index.js";
import type { PipelineEventEmitter } from "../events/index.js";

/** Action name recorded on run results. */
export const RUN_PIPELINE_ACTION_NAME = "run" as const;

/** Terminal outcome folded directly from the FSM. */
export interface SettledOutcome {
  /** Public terminal status. */
  readonly status: RunResultStatus;
  /** Final durable FSM state. */
  readonly state: PipelineState;
  /** Executed stage identifiers. */
  readonly stagesRun: readonly string[];
  /** Regression count. */
  readonly regressions: number;
  /** Optional terminal failure reason. */
  readonly error?: string;
}

/**
 * Maps a completed FSM directly to a passing outcome.
 *
 * @param fsm - Completed FSM result.
 *
 * @returns Passing terminal outcome.
 */
export const settleDone = (fsm: RunPipelineStagesResult): SettledOutcome => ({
  status: "passed",
  state: fsm.state,
  stagesRun: fsm.stagesRun,
  regressions: fsm.regressions,
});

/**
 * Converts a non-done FSM result into a terminal failure outcome.
 *
 * @param fsm - Failed or attention-required FSM result.
 *
 * @returns Corresponding terminal outcome.
 */
export const settleFsmFailure = (fsm: RunPipelineStagesResult): SettledOutcome => ({
  status: toRunResultStatus(fsm.status),
  state: fsm.state,
  stagesRun: fsm.stagesRun,
  regressions: fsm.regressions,
  ...(fsm.failure === undefined ? {} : { error: fsm.failure.reason }),
});

/**
 * Builds the immutable result and emits exactly one terminal result event.
 *
 * @param context - Active action context.
 * @param _prepared - Prepared pipeline mechanism.
 * @param settled - Terminal FSM outcome.
 *
 * @returns Frozen public run result.
 */
export const finishAction = (
  context: PipelineActionContext,
  _prepared: PreparedPipeline,
  settled: SettledOutcome,
): RunResult => {
  const result: RunResult = Object.freeze({
    storyId: context.request.storyId,
    specFile: context.request.specFile,
    action: RUN_PIPELINE_ACTION_NAME,
    status: settled.status,
    stagesRun: Object.freeze([...settled.stagesRun]),
    regressions: settled.regressions,
    durationMs: elapsedMs(context),
    ...(settled.error === undefined ? {} : { error: settled.error }),
    economics: settled.state.economics,
  });
  emitResult(context, result);
  return result;
};

/**
 * Builds and emits a minimal needs-attention result before preparation.
 *
 * @param context - Active action context.
 * @param error - Terminal failure reason.
 *
 * @returns Frozen public run result.
 */
export const emitMinimalResult = (context: PipelineActionContext, error: string): RunResult => {
  const result: RunResult = Object.freeze({
    storyId: context.request.storyId,
    specFile: context.request.specFile,
    action: RUN_PIPELINE_ACTION_NAME,
    status: "needs-attention",
    stagesRun: Object.freeze([]),
    regressions: 0,
    durationMs: elapsedMs(context),
    error,
  });
  emitResult(context, result);
  return result;
};

const emitResult = (context: PipelineActionContext, result: RunResult): void => {
  context.emitter.emit("result", {
    status: result.status,
    stagesRun: result.stagesRun,
    regressions: result.regressions,
    durationMs: result.durationMs,
    ...(result.error === undefined ? {} : { error: result.error }),
  });
};

/**
 * Creates the stage lifecycle observer translating stage execution into CLI events.
 *
 * @param emitter - Action event emitter.
 *
 * @returns Frozen stage observer.
 */
export const createStageObserver = (emitter: PipelineEventEmitter): PipelineStageObserver =>
  Object.freeze({
    onStageStarted: (info): void => {
      emitter.emit("stage.started", { stageId: info.stage.id, attempt: info.attempt });
    },
    onStageFinished: (info): void => {
      emitStageFinished(emitter, info);
    },
  } satisfies PipelineStageObserver);

const emitStageFinished = (emitter: PipelineEventEmitter, info: PipelineStageFinishInfo): void => {
  emitter.emit("stage.finished", {
    stageId: info.stage.id,
    attempt: info.attempt,
    kind: info.decision.kind,
    passed: info.decision.passed,
    exitCode: info.execution.exitCode,
    durationMs: info.execution.durationMs,
    reason: info.decision.reason,
  });
  if (info.stage.kind === "agent" && info.stage.payloadGateName !== undefined) {
    emitter.emit("gate.decision", {
      stageId: info.stage.id,
      gate: info.stage.payloadGateName,
      passed: info.decision.passed,
      reason: info.decision.reason,
      findings: info.decision.findings ?? [],
    });
  }
};

const elapsedMs = (context: PipelineActionContext): number =>
  Math.max(0, context.now().getTime() - context.startedAtMs);
