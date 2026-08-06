/**
 * Composition root for one durable pipeline run.
 *
 * Owns the public action boundary: the request/dependency contracts with real
 * implementations as defaults, request validation, the per-story dispatch
 * lock, and throw-safety. The prepared-pipeline mechanism lives in
 * run-pipeline-execution.ts and the outcome-settlement policy lives in
 * run-pipeline-settlement.ts; this module sequences them. All run outcomes
 * are returned as data ({@link RunResult}); throws are reserved for programmer
 * errors (invalid requests). Progress is emitted as PipelineCliEvent lines
 * through an injected sink.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";

import { executeStages, preparePipeline } from "./run-pipeline-execution.js";
import {
  emitMinimalResult,
  settleDone,
  settleFsmFailure,
  finishAction,
} from "./run-pipeline-settlement.js";
import { runPipelineStages, type RunBudget } from "../core/index.js";
import { errorMessage } from "../core/runner-evaluation.js";
import {
  createPipelineEventEmitter,
  type PipelineEventEmitter,
  type PipelineEventSink,
} from "../events/index.js";
import { PiCliWorkflowExecutor, type WorkflowExecutor } from "../executors/index.js";
import { registerBmadPayloadGates } from "../gates/index.js";
import { ensureStoryWorktree } from "../git/index.js";
import { resolveModelConfig, type ModelThinking } from "../model/index.js";
import { selectAndCompileRunDef } from "../rundef/index.js";
import {
  acquireDispatchLock,
  isPipelineStateStoryId,
  loadPipelineState,
  reconcilePipelineState,
  savePipelineState,
  type RunResult,
} from "../state/index.js";

/** Stable error code emitted when the per-story dispatch lock is held. */
export const LOCK_HELD_ERROR_CODE = "lock-held" as const;

/** Stable fallback error code for thrown values without a string code. */
export const INTERNAL_ERROR_CODE = "internal-error" as const;

/** Options passed to the injected stage-executor factory. */
export interface CreateStageExecutorOptions {
  /** Resolved model name for child stage execution. */
  readonly model: string;

  /** Resolved thinking effort for child stage execution. */
  readonly thinking: ModelThinking;
}

/** Injected effects used by {@link runPipelineAction}; defaults are real. */
export interface RunPipelineActionDeps {
  /** Acquires the per-story dispatch lock. */
  readonly acquireLock: typeof acquireDispatchLock;

  /** Loads durable pipeline state. */
  readonly loadState: typeof loadPipelineState;

  /** Saves durable pipeline state. */
  readonly saveState: typeof savePipelineState;

  /** Repairs contradictory loaded state. */
  readonly reconcileState: typeof reconcilePipelineState;

  /** Ensures the isolated story worktree exists. */
  readonly ensureWorktree: typeof ensureStoryWorktree;

  /** Registers built-in BMAD payload gates before compilation (D6). */
  readonly registerGates: typeof registerBmadPayloadGates;

  /** Selects and compiles the RunDef into stages. */
  readonly selectAndCompile: typeof selectAndCompileRunDef;

  /** Resolves model and thinking from candidate sources (D7). */
  readonly resolveModel: typeof resolveModelConfig;

  /** Builds the workflow executor for resolved model config. */
  readonly createExecutor: (options: CreateStageExecutorOptions) => WorkflowExecutor;

  /** Runs compiled stages to a terminal outcome. */
  readonly runStages: typeof runPipelineStages;

  /** Creates the unique runner invocation id for the dispatch lock. */
  readonly createRunId: () => string;
}

/** Request for running one durable pipeline action. */
export interface RunPipelineActionRequest {
  /** RunDef id to select and compile. */
  readonly rundefId: string;

  /** Story id being supervised. */
  readonly storyId: string;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Project root directory. */
  readonly projectRoot: string;

  /** Optional explicit model name (highest-precedence source). */
  readonly model?: string;

  /** Optional explicit thinking effort (highest-precedence source). */
  readonly thinking?: string;

  /** Injected env map read for environment model candidates (D7). */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Optional regression ceiling forwarded to the FSM. */
  readonly maxRegressions?: number;

  /** Optional aggregate run budget forwarded to the FSM. */
  readonly runBudget?: RunBudget;

  /** Optional abort signal forwarded to stage execution. */
  readonly signal?: AbortSignal;

  /** Optional event sink receiving serialized PipelineCliEvent lines. */
  readonly sink?: PipelineEventSink;

  /** Optional clock seam for deterministic timestamps. */
  readonly now?: () => Date;

  /** Optional injected effect overrides; omitted effects use real defaults. */
  readonly deps?: Partial<RunPipelineActionDeps>;
}

/** Immutable per-run context shared by the execution and settlement modules. */
export interface PipelineActionContext {
  /** Validated action request. */
  readonly request: RunPipelineActionRequest;

  /** Fully resolved injected dependencies. */
  readonly deps: RunPipelineActionDeps;

  /** Event emitter bound to the story id and sink. */
  readonly emitter: PipelineEventEmitter;

  /** Injected clock. */
  readonly now: () => Date;

  /** Action start time in epoch milliseconds. */
  readonly startedAtMs: number;

  /** Action start time as an ISO timestamp. */
  readonly startedAtIso: string;
}

/** Real default dependencies used when the request injects no overrides. */
export const defaultRunPipelineActionDeps: RunPipelineActionDeps = Object.freeze({
  acquireLock: acquireDispatchLock,
  loadState: loadPipelineState,
  saveState: savePipelineState,
  reconcileState: reconcilePipelineState,
  ensureWorktree: ensureStoryWorktree,
  registerGates: registerBmadPayloadGates,
  selectAndCompile: selectAndCompileRunDef,
  resolveModel: resolveModelConfig,
  createExecutor: (options: CreateStageExecutorOptions): WorkflowExecutor =>
    new PiCliWorkflowExecutor(options),
  runStages: runPipelineStages,
  createRunId: (): string => randomUUID(),
} satisfies RunPipelineActionDeps);

/**
 * Runs one durable pipeline action end to end and returns the outcome as data.
 *
 * @param request - Story, RunDef, and injected effects.
 *
 * @returns Frozen terminal {@link RunResult}; run failures are data, never throws.
 *
 * @throws RangeError When the request contains blank or unsafe identifiers.
 *
 * @example
 * ```ts
 * const result = await runPipelineAction({
 *   rundefId: "sdlc",
 *   storyId: "SH-1",
 *   specFile: "docs/stories/sh-1.md",
 *   projectRoot: process.cwd(),
 * * });
 * ```
 */
export async function runPipelineAction(request: RunPipelineActionRequest): Promise<RunResult> {
  validateActionRequest(request);
  const context = createActionContext(request);
  const lock = await context.deps.acquireLock({
    projectRoot: request.projectRoot,
    storyId: request.storyId,
    runId: context.deps.createRunId(),
  });
  if (lock === undefined) {
    return settleLockHeld(context);
  }
  try {
    return await runLockedPipeline(context);
  } catch (error) {
    return settleThrow(context, error);
  } finally {
    await lock.release();
  }
}

const validateActionRequest = (request: RunPipelineActionRequest): void => {
  if (!isPipelineStateStoryId(request.storyId)) {
    throw new RangeError(`Invalid pipeline story id "${request.storyId}".`);
  }
  for (const [field, value] of [
    ["rundefId", request.rundefId],
    ["specFile", request.specFile],
    ["projectRoot", request.projectRoot],
  ] as const) {
    if (value.trim().length === 0) {
      throw new RangeError(`${field} must not be blank.`);
    }
  }
};

const createActionContext = (request: RunPipelineActionRequest): PipelineActionContext => {
  const now = request.now ?? defaultNow;
  const startedAt = now();
  return Object.freeze({
    request,
    deps: Object.freeze({ ...defaultRunPipelineActionDeps, ...request.deps }),
    emitter: createPipelineEventEmitter({
      sink: request.sink ?? noopEventSink,
      storyId: request.storyId,
      now,
    }),
    now,
    startedAtMs: startedAt.getTime(),
    startedAtIso: startedAt.toISOString(),
  });
};

const runLockedPipeline = async (context: PipelineActionContext): Promise<RunResult> => {
  context.emitter.emit("run.started", {
    rundefId: context.request.rundefId,
    specFile: context.request.specFile,
  });
  const prepared = await preparePipeline(context);
  const fsm = await executeStages(context, prepared);
  const settled = fsm.status === "done" ? settleDone(fsm) : settleFsmFailure(fsm);
  return finishAction(context, prepared, settled);
};

const settleLockHeld = (context: PipelineActionContext): RunResult => {
  const reason = `Dispatch lock for story "${context.request.storyId}" is held by another live run.`;
  context.emitter.emit("error", { code: LOCK_HELD_ERROR_CODE, message: reason });
  return emitMinimalResult(context, reason);
};

const settleThrow = (context: PipelineActionContext, error: unknown): RunResult => {
  const message = errorMessage(error);
  context.emitter.emit("error", { code: errorCodeOf(error), message });
  return emitMinimalResult(context, message);
};

const errorCodeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : INTERNAL_ERROR_CODE;

const defaultNow = (): Date => new Date();

const noopEventSink: PipelineEventSink = Object.freeze({
  write: (): void => {
    /* Events are dropped when no sink is injected. */
  },
});
