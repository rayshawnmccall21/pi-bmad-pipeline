/**
 * Preparation and FSM wiring for one locked pipeline run.
 *
 * Owns the mechanism half of the action: explicit payload-gate registration,
 * RunDef selection/compilation, model resolution from D7 candidate sources,
 * durable starting-state resolution, and the FSM invocation with exact project-root
 * execution, saveState persistence, and the observer-to-event adapter. All effects
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

import { createStageObserver } from "./run-pipeline-settlement.js";
import {
  assertRecoveryStateNeedsNoReconciliation,
  assertResumeIdentity,
  withActiveRunDefIdentity,
  type StartingStateInput,
} from "./run-pipeline-identity.js";
import type { PipelineActionContext, RunPipelineActionRequest } from "./run-pipeline-action.js";
import {
  TERMINAL_RECOVERY_REJECTED_CODE,
  type RunBudget,
  type RunPipelineStagesResult,
  type TerminalRecoveryRequest,
} from "../core/index.js";
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
    runDef: selection.runDef,
  });
  const executor = deps.createExecutor({
    model: model.model,
    thinking: model.thinking,
    ...envPiBin(request.env),
  });
  return Object.freeze({ stages: selection.stages, model, state, executor });
};

const forwardedStageOptions = (
  context: PipelineActionContext,
): {
  readonly maxRegressions?: number;
  readonly runBudget?: RunBudget;
  readonly terminalRecovery?: TerminalRecoveryRequest;
  readonly readTerminalCorrectionHead: (projectRoot: string) => Promise<string>;
  readonly signal?: AbortSignal;
} => {
  const { deps, request } = context;
  return {
    ...(request.maxRegressions === undefined ? {} : { maxRegressions: request.maxRegressions }),
    ...(request.runBudget === undefined ? {} : { runBudget: request.runBudget }),
    ...(request.terminalRecovery === undefined
      ? {}
      : { terminalRecovery: request.terminalRecovery }),
    readTerminalCorrectionHead: deps.readGitHead,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
};

/**
 * Runs the pipeline FSM with persistence and event observation wired in.
 *
 * @param context - Action context with injected dependencies.
 * @param prepared - Prepared stages, state, and executor.
 * @param runId - Authenticated invocation id held by the dispatch lock.
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
  runId: string,
): Promise<RunPipelineStagesResult> => {
  const { deps, request } = context;
  return deps.runStages({
    stages: prepared.stages,
    state: prepared.state,
    storyId: request.storyId,
    runId,
    specFile: request.specFile,
    projectRoot: request.projectRoot,
    executor: prepared.executor,
    attestScope: deps.attestScope,
    saveState: async (state) => {
      await deps.saveState(request.projectRoot, state);
    },
    ...forwardedStageOptions(context),
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

const resolveRecoveryState = (
  context: PipelineActionContext,
  input: StartingStateInput,
): PipelineState => {
  if (input.loaded === undefined) {
    throw Object.assign(
      new Error(
        "Terminal recovery requires an existing done state with an active final receipt; no state file was found.",
      ),
      { code: TERMINAL_RECOVERY_REJECTED_CODE },
    );
  }
  assertResumeIdentity(input.loaded, context.request, input);
  assertRecoveryStateNeedsNoReconciliation(context, input, input.loaded);
  return withActiveRunDefIdentity(input.loaded, input);
};

const resolveInitialState = async (
  context: PipelineActionContext,
  input: StartingStateInput,
): Promise<PipelineState> => {
  const initial = createInitialPipelineState({
    storyId: context.request.storyId,
    runDefId: input.runDefId,
    runDefDigest: input.runDefDigest,
    specFile: context.request.specFile,
    stages: input.stages,
    model: input.model.model,
    thinking: input.model.thinking,
    startedAt: context.startedAtIso,
  });
  await context.deps.saveState(context.request.projectRoot, initial);
  return initial;
};

const resolveReconciledResumeState = async (
  context: PipelineActionContext,
  input: StartingStateInput,
  loaded: PipelineState,
): Promise<PipelineState> => {
  assertResumeIdentity(loaded, context.request, input);
  const stateToReconcile =
    loaded.runDefDigest !== input.runDefDigest ? withActiveRunDefIdentity(loaded, input) : loaded;
  const reconciled = context.deps.reconcileState({
    state: stateToReconcile,
    stages: input.stages,
    now: context.now,
  });
  if (reconciled.changed || stateToReconcile !== loaded) {
    await context.deps.saveState(context.request.projectRoot, reconciled.state);
  }
  return reconciled.state;
};

const resolveStartingState = async (
  context: PipelineActionContext,
  input: StartingStateInput,
): Promise<PipelineState> => {
  if (context.request.terminalRecovery !== undefined) {
    return resolveRecoveryState(context, input);
  }
  if (input.loaded === undefined) {
    return resolveInitialState(context, input);
  }
  return resolveReconciledResumeState(context, input, input.loaded);
};
