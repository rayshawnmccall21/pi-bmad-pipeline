/**
 * Durable pipeline state contracts and factory helpers.
 *
 * Defines the serializable JSON state shape persisted to
 * `.pi/pipeline/state/<story-id>.json`, the per-stage lifecycle shape,
 * aggregated run economics, and small frozen factory helpers for initial
 * pipeline state.
 *
 * This module is pure types and constructors — no filesystem access, no
 * child-process spawning, no reconciliation logic.
 *
 * @packageDocumentation
 */

import type { CompiledStageDef } from "../rundef/index.js";

/** Current durable state feature version written by this runner. */
export const RUNNER_FEATURE_VERSION = 1 as const;

/** Durable pipeline state statuses persisted across crashes. */
export type PipelineStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "needs-approval"
  | "paused"
  | "pr-opened"
  | "needs-attention";

/** Public action result statuses returned by the pipeline action layer. */
export type RunResultStatus =
  "passed" | "failed" | "needs-approval" | "paused" | "pr-opened" | "needs-attention";

/** Durable per-stage lifecycle status. */
export type StageStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";

/** Per-attempt terminal result recorded in stage attempt history. */
export type StageAttemptStatus =
  "passed" | "failed" | "timed-out" | "aborted" | "parse-error" | "gate-failed";

/** Token and dollar usage reported by a single child stage execution. */
export interface StageUsage {
  /** Token usage reported for this execution. */
  readonly tokens: number;

  /** Dollar usage reported for this execution. */
  readonly dollars: number;
}

/** Aggregated run economics written to durable pipeline state. */
export interface RunEconomicsSummary {
  /** Total token usage accumulated across all stage attempts. */
  readonly tokens: number;

  /** Total dollar usage accumulated across all stage attempts. */
  readonly dollars: number;
}

/** Durable record for one stage attempt. */
export interface StageAttemptState {
  /** One-based attempt number for the stage. */
  readonly attempt: number;

  /** Attempt lifecycle result. */
  readonly status: StageAttemptStatus;

  /** ISO timestamp when the attempt started, or null when unknown. */
  readonly startedAt: string | null;

  /** ISO timestamp when the attempt finished, or null when unknown. */
  readonly finishedAt: string | null;

  /** Attempt duration in milliseconds, or null when unknown. */
  readonly durationMs: number | null;

  /** Child process exit code, or null when no exit code exists. */
  readonly exitCode: number | null;

  /** Optional parse error emitted while reading child JSONL. */
  readonly parseError?: string;

  /** Optional human-readable failure or gate reason. */
  readonly reason?: string;

  /** Optional findings captured for regression routing. */
  readonly findings?: readonly string[];

  /** Optional token and dollar usage for this attempt. */
  readonly usage?: StageUsage;
}

/** Durable state for one pipeline stage. */
export interface StageState {
  /** Stage id matching a compiled RunDef stage id. */
  readonly id: string;

  /** Stage lifecycle status. */
  readonly status: StageStatus;

  /** Number of attempts recorded for this stage. */
  readonly attempts: number;

  /** ISO timestamp when the current or latest stage run started, or null when never started. */
  readonly startedAt: string | null;

  /** ISO timestamp when the current or latest stage run finished, or null when not finished. */
  readonly finishedAt: string | null;

  /** Durable attempt history for this stage. */
  readonly history: readonly StageAttemptState[];

  /** Optional latest failure or gate reason. */
  readonly reason?: string;

  /** Optional latest findings used for regression routing. */
  readonly findings?: readonly string[];
}

/** Durable state for one pipeline run, persisted as JSON. */
export interface PipelineState {
  /** Story id being supervised. */
  readonly storyId: string;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Git worktree path for the isolated run. */
  readonly worktreePath: string;

  /** Git branch used for the isolated run. */
  readonly branch: string;

  /** Feature version of the runner that wrote this state. */
  readonly runnerFeatureVersion: number;

  /** Overall pipeline lifecycle status. */
  readonly status: PipelineStatus;

  /** Current stage id, or null before or after stage execution. */
  readonly currentStage: string | null;

  /** Per-stage durable state keyed by stage id. */
  readonly stages: Readonly<Record<string, StageState>>;

  /** Number of gate-triggered regressions performed. */
  readonly regressions: number;

  /** ISO timestamp when the pipeline started, or null when not started. */
  readonly startedAt: string | null;

  /** ISO timestamp when the pipeline finished, or null when not finished. */
  readonly finishedAt: string | null;

  /** Resolved model name used for child stage execution. */
  readonly model: string;

  /** Resolved thinking effort used for child stage execution. */
  readonly thinking: string;

  /** Aggregated run economics. */
  readonly economics: RunEconomicsSummary;
}

/** Final action result returned by the public runner or action layer. */
export interface RunResult {
  /** Story id that was supervised. */
  readonly storyId: string;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Action name, for example "run", "iso", "merge", or "audit". */
  readonly action: string;

  /** Public terminal status. */
  readonly status: RunResultStatus;

  /** Stage ids executed during this action. */
  readonly stagesRun: readonly string[];

  /** Number of gate-triggered regressions performed. */
  readonly regressions: number;

  /** Total action duration in milliseconds. */
  readonly durationMs: number;

  /** Optional terminal error message. */
  readonly error?: string;

  /** Optional worktree path used by the run. */
  readonly worktreePath?: string;

  /** Optional branch used by the run. */
  readonly branch?: string;

  /** Optional pull request URL opened by the run. */
  readonly prUrl?: string;

  /** Optional pull request number opened by the run. */
  readonly prNumber?: number;

  /** Optional aggregated economics. */
  readonly economics?: RunEconomicsSummary;
}

/** Request for constructing initial durable pipeline state. */
export interface CreateInitialPipelineStateRequest {
  /** Story id being supervised. */
  readonly storyId: string;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Git worktree path for the isolated run. */
  readonly worktreePath: string;

  /** Git branch used for the isolated run. */
  readonly branch: string;

  /** Compiled stages to initialize as pending. */
  readonly stages: readonly CompiledStageDef[];

  /** Resolved model name used for child stage execution. */
  readonly model: string;

  /** Resolved thinking effort used for child stage execution. */
  readonly thinking: string;

  /** Optional ISO timestamp to use as the initial startedAt value. */
  readonly startedAt?: string | null;
}

/** Set of pipeline statuses considered terminal (no further execution). */
const TERMINAL_PIPELINE_STATUSES: ReadonlySet<PipelineStatus> = new Set([
  "done",
  "failed",
  "needs-approval",
  "paused",
  "pr-opened",
  "needs-attention",
]);

/** Set of stage statuses considered terminal. */
const TERMINAL_STAGE_STATUSES: ReadonlySet<StageStatus> = new Set([
  "passed",
  "failed",
  "skipped",
  "blocked",
]);

/**
 * Creates an empty frozen run economics summary.
 *
 * @returns A frozen zero-value run economics summary.
 *
 * @example
 * Calling `createEmptyRunEconomicsSummary()` returns a frozen object
 * `{ tokens: 0, dollars: 0 }`.
 */
export function createEmptyRunEconomicsSummary(): RunEconomicsSummary {
  return Object.freeze({ tokens: 0, dollars: 0 });
}

/**
 * Creates initial pending state for one stage.
 *
 * @param stage - Compiled stage definition or any object with an `id` property.
 *
 * @returns A frozen pending stage state with empty history.
 *
 * @example
 * Calling `createInitialStageState({ id: "dev-story" })` returns a frozen
 * stage state with status "pending" and zero attempts.
 */
export function createInitialStageState(stage: Pick<CompiledStageDef, "id">): StageState {
  return Object.freeze({
    id: stage.id,
    status: "pending",
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    history: Object.freeze([]),
  });
}

/**
 * Creates initial durable pipeline state with all stages set to pending.
 *
 * @param request - Initial state request containing story metadata, compiled stages, and model config.
 *
 * @returns A frozen initial pipeline state.
 *
 * @example
 * Calling `createInitialPipelineState({ storyId: "SH-1", specFile: "spec.md", worktreePath: "/wt", branch: "bmad/sh-1", stages: [], model: "gpt-5", thinking: "high" })`
 * returns a frozen pipeline state with status "pending".
 */
export function createInitialPipelineState(
  request: CreateInitialPipelineStateRequest,
): PipelineState {
  const stages: Record<string, StageState> = {};

  for (const compiledStage of request.stages) {
    stages[compiledStage.id] = createInitialStageState(compiledStage);
  }

  const startedAt = request.startedAt ?? null;

  return Object.freeze({
    storyId: request.storyId,
    specFile: request.specFile,
    worktreePath: request.worktreePath,
    branch: request.branch,
    runnerFeatureVersion: RUNNER_FEATURE_VERSION,
    status: "pending",
    currentStage: null,
    stages: Object.freeze(stages),
    regressions: 0,
    startedAt,
    finishedAt: null,
    model: request.model,
    thinking: request.thinking,
    economics: createEmptyRunEconomicsSummary(),
  });
}

const PIPELINE_TO_RESULT_MAP: Readonly<Record<string, RunResultStatus>> = {
  done: "passed",
  failed: "failed",
  "needs-approval": "needs-approval",
  paused: "paused",
  "pr-opened": "pr-opened",
  "needs-attention": "needs-attention",
};

/**
 * Converts a durable pipeline status into a public run result status.
 *
 * @param status - Durable pipeline status; must be terminal.
 *
 * @returns Public run result status, mapping "done" to "passed".
 *
 * @throws RangeError When the durable status is not terminal.
 *
 * @example
 * Calling `toRunResultStatus("done")` returns `"passed"`.
 */
export function toRunResultStatus(status: PipelineStatus): RunResultStatus {
  const mapped = PIPELINE_TO_RESULT_MAP[status];
  if (mapped === undefined) {
    throw new RangeError(`Cannot convert non-terminal status "${status}" to RunResultStatus.`);
  }
  return mapped;
}

/**
 * Checks whether a pipeline status is terminal.
 *
 * @param status - Durable pipeline status.
 *
 * @returns True when no further pipeline execution should occur.
 *
 * @example
 * Calling `isTerminalPipelineStatus("done")` returns `true`, while
 * `isTerminalPipelineStatus("running")` returns `false`.
 */
export function isTerminalPipelineStatus(status: PipelineStatus): boolean {
  return TERMINAL_PIPELINE_STATUSES.has(status);
}

/**
 * Checks whether a stage status is terminal.
 *
 * @param status - Durable stage status.
 *
 * @returns True when the stage is not actively running or pending.
 *
 * @example
 * Calling `isTerminalStageStatus("passed")` returns `true`, while
 * `isTerminalStageStatus("running")` returns `false`.
 */
export function isTerminalStageStatus(status: StageStatus): boolean {
  return TERMINAL_STAGE_STATUSES.has(status);
}
