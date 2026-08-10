/**
 * Preparation and FSM wiring for one locked pipeline run.
 *
 * Owns the mechanism half of the action: explicit payload-gate registration,
 * RunDef selection/compilation, model resolution from D7 candidate sources,
 * worktree creation, durable starting-state resolution, and the FSM invocation
 * with saveState persistence plus the observer-to-event adapter. All effects
 * arrive through the injected context dependencies; this module performs no
 * direct I/O.
 *
 * @packageDocumentation
 */

import {
  computeRunDefDigest,
  payloadGateRegistry,
  type CompiledStageDef,
} from "../rundef/index.js";
import { createInitialPipelineState, type PipelineState } from "../state/index.js";

import type { PipelineActionContext, RunPipelineActionRequest } from "./run-pipeline-action.js";
import type {
  PipelineStageFinishInfo,
  PipelineStageObserver,
  RunPipelineStagesResult,
} from "../core/index.js";
import type { PipelineEventEmitter } from "../events/index.js";
import type { WorkflowExecutor } from "../executors/index.js";
import type {
  ModelConfigCandidate,
  ResolveModelConfigRequest,
  ResolvedModelConfig,
} from "../model/index.js";

/** Env var supplying the environment-sourced model candidate (D7). */
export const BMAD_PIPELINE_MODEL_ENV_VAR = "BMAD_PIPELINE_MODEL" as const;

/** Env var supplying the environment-sourced thinking candidate (D7). */
export const BMAD_PIPELINE_THINKING_ENV_VAR = "BMAD_PIPELINE_THINKING" as const;

/** Env var overriding the Pi executable spawned for child stages. */
export const BMAD_PIPELINE_PI_BIN_ENV_VAR = "BMAD_PIPELINE_PI_BIN" as const;

/** Everything prepared before the FSM runs. */
export interface PreparedPipeline {
  /** Compiled stages in execution order. */
  readonly stages: readonly CompiledStageDef[];

  /** Resolved model configuration. */
  readonly model: ResolvedModelConfig;

  /** Starting durable state, fresh or reconciled. */
  readonly state: PipelineState;

  /** Executor constructed for the resolved model config. */
  readonly executor: WorkflowExecutor;
}

/**
 * Prepares everything the FSM needs: gates, stages, model, state.
 *
 * @param context - Action context with injected dependencies.
 *
 * @returns Frozen prepared pipeline inputs.
 *
 * @example
 * ```ts
 * const prepared = await preparePipeline(context);
 * ```
 */
export const preparePipeline = async (
  context: PipelineActionContext,
): Promise<PreparedPipeline> => {
  const { deps, request } = context;
  const loaded = await deps.loadState(request.projectRoot, request.storyId);
  deps.registerGates();
  const selection = await deps.selectAndCompile(request.projectRoot, request.rundefId, {
    registry: payloadGateRegistry,
  });
  const model = deps.resolveModel(buildModelRequest(request));
  const state = await resolveStartingState(context, {
    loaded,
    stages: selection.stages,
    model,
    runDefId: selection.id,
    runDefDigest: computeRunDefDigest(selection.runDef),
  });
  const executor = deps.createExecutor({
    model: model.model,
    thinking: model.thinking,
    ...envPiBin(request.env),
  });
  return Object.freeze({ stages: selection.stages, model, state, executor });
};

/**
 * Runs the pipeline FSM with persistence and event observation wired in.
 *
 * @param context - Action context with injected dependencies.
 * @param prepared - Prepared stages, state, and executor.
 *
 * @returns Terminal FSM result.
 *
 * @example
 * ```ts
 * const fsm = await executeStages(context, prepared);
 * ```
 */
export const executeStages = (
  context: PipelineActionContext,
  prepared: PreparedPipeline,
): Promise<RunPipelineStagesResult> => {
  const { deps, request } = context;
  return deps.runStages({
    stages: prepared.stages,
    state: prepared.state,
    storyId: request.storyId,
    specFile: request.specFile,
    projectRoot: request.projectRoot,
    executor: prepared.executor,
    saveState: async (state) => {
      await deps.saveState(request.projectRoot, state);
    },
    ...(request.maxRegressions === undefined ? {} : { maxRegressions: request.maxRegressions }),
    ...(request.runBudget === undefined ? {} : { runBudget: request.runBudget }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    now: context.now,
    observer: createStageObserver(context.emitter),
  });
};

const buildModelRequest = (request: RunPipelineActionRequest): ResolveModelConfigRequest => {
  const env = request.env ?? {};
  return {
    explicit: candidateOf(request.model, request.thinking),
    environment: candidateOf(env[BMAD_PIPELINE_MODEL_ENV_VAR], env[BMAD_PIPELINE_THINKING_ENV_VAR]),
  };
};

const candidateOf = (
  model: string | undefined,
  thinking: string | undefined,
): ModelConfigCandidate => ({
  ...(model === undefined ? {} : { model }),
  ...(thinking === undefined ? {} : { thinking }),
});

const envPiBin = (
  env: Readonly<Record<string, string | undefined>> | undefined,
): { readonly piBin?: string } => {
  const value = env?.[BMAD_PIPELINE_PI_BIN_ENV_VAR];
  return value !== undefined && value.trim().length > 0 ? { piBin: value } : {};
};

interface StartingStateInput {
  readonly loaded: PipelineState | undefined;
  readonly stages: readonly CompiledStageDef[];
  readonly model: ResolvedModelConfig;
  readonly runDefId: string;
  readonly runDefDigest: string;
}

const resolveStartingState = async (
  context: PipelineActionContext,
  input: StartingStateInput,
): Promise<PipelineState> => {
  const { deps, request } = context;
  if (input.loaded === undefined) {
    const initial = createInitialPipelineState({
      storyId: request.storyId,
      runDefId: input.runDefId,
      runDefDigest: input.runDefDigest,
      specFile: request.specFile,
      stages: input.stages,
      model: input.model.model,
      thinking: input.model.thinking,
      startedAt: context.startedAtIso,
    });
    await deps.saveState(request.projectRoot, initial);
    return initial;
  }
  assertResumeIdentity(input.loaded, request, input);
  const reconciled = deps.reconcileState({
    state: input.loaded,
    stages: input.stages,
    now: context.now,
  });
  if (reconciled.changed) {
    await deps.saveState(request.projectRoot, reconciled.state);
  }
  return reconciled.state;
};

const assertResumeIdentity = (
  loaded: PipelineState,
  request: RunPipelineActionRequest,
  input: StartingStateInput,
): void => {
  const matches = [
    loaded.storyId === request.storyId,
    loaded.runDefId === input.runDefId,
    loaded.runDefDigest === input.runDefDigest,
    loaded.specFile === request.specFile,
    loaded.model === input.model.model,
    loaded.thinking === input.model.thinking,
  ].every(Boolean);
  if (!matches) {
    throw Object.assign(
      new Error("Loaded state RunDef identity or run configuration does not match the active run."),
      {
        code: "state-identity-mismatch",
      },
    );
  }
};

const createStageObserver = (emitter: PipelineEventEmitter): PipelineStageObserver =>
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
  if (info.stage.payloadGateName !== undefined) {
    emitter.emit("gate.decision", {
      stageId: info.stage.id,
      gate: info.stage.payloadGateName,
      passed: info.decision.passed,
      reason: info.decision.reason,
      findings: info.decision.findings ?? [],
    });
  }
};
