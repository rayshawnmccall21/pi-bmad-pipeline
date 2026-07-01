import {
  createInitialStageState,
  isTerminalPipelineStatus,
  type PipelineState,
  type RunEconomicsSummary,
  type StageAttemptState,
  type StageState,
} from "./pipeline-state.js";

import type { CompiledStageDef } from "../rundef/index.js";

/** Stable issue code emitted by PipelineState reconciliation. */
export type StateReconciliationIssueCode =
  | "missing-stage-added"
  | "unknown-stage-removed"
  | "running-pipeline-reset"
  | "running-stage-reset"
  | "current-stage-repaired"
  | "terminal-current-stage-cleared"
  | "finished-at-repaired"
  | "stage-attempts-repaired"
  | "economics-recomputed";

/** One repair performed during PipelineState reconciliation. */
export interface StateReconciliationIssue {
  /** Stable machine-readable issue code. */
  readonly code: StateReconciliationIssueCode;

  /** JSON-ish path to the repaired field. */
  readonly path: string;

  /** Human-readable repair summary. */
  readonly message: string;
}

/** Request for reconciling loaded durable PipelineState. */
export interface ReconcilePipelineStateRequest {
  /** Loaded durable state snapshot. */
  readonly state: PipelineState;

  /** Compiled stages that define the expected stage set and order. */
  readonly stages: readonly Pick<CompiledStageDef, "id">[];

  /** Optional clock seam used when terminal finishedAt is missing. */
  readonly now?: () => Date;
}

/** Result of PipelineState reconciliation. */
export interface StateReconciliationResult {
  /** Reconciled, deeply frozen state snapshot. */
  readonly state: PipelineState;

  /** Whether any repair was applied. */
  readonly changed: boolean;

  /** Stable repair issues emitted during reconciliation. */
  readonly issues: readonly StateReconciliationIssue[];
}

/**
 * Repairs valid-but-contradictory durable PipelineState after load.
 *
 * @param request - Loaded state, compiled stages, and optional clock seam.
 *
 * @returns A frozen reconciled state plus repair issues.
 *
 * @example
 * ```ts
 * const result = reconcilePipelineState({ state, stages });
 * ```
 */
export function reconcilePipelineState(
  request: ReconcilePipelineStateRequest,
): StateReconciliationResult {
  const issues: StateReconciliationIssue[] = [];
  const stages = reconcileStageRecord(request.state, request.stages, issues);
  const state = repairPipelineFields({ ...request.state, stages }, request, issues);
  repairEconomics(state, issues);
  const frozenState = freezeState(state);
  const frozenIssues = Object.freeze(issues.map((issue) => Object.freeze(issue)));

  return Object.freeze({
    state: frozenState,
    changed: frozenIssues.length > 0,
    issues: frozenIssues,
  });
}

/**
 * Finds the first compiled stage that still needs execution.
 *
 * @param state - Pipeline state to inspect.
 * @param stages - Compiled stages in execution order.
 *
 * @returns The first incomplete stage id, or null when all are complete.
 *
 * @example
 * ```ts
 * const nextStage = getFirstIncompleteStageId(state, stages);
 * ```
 */
export function getFirstIncompleteStageId(
  state: PipelineState,
  stages: readonly Pick<CompiledStageDef, "id">[],
): string | null {
  return stages.find((stage) => !isCompleteStageStatus(state.stages[stage.id]?.status))?.id ?? null;
}

const reconcileStageRecord = (
  state: PipelineState,
  stages: readonly Pick<CompiledStageDef, "id">[],
  issues: StateReconciliationIssue[],
): Readonly<Record<string, StageState>> => {
  const expected = new Set(stages.map((stage) => stage.id));
  const next: Record<string, StageState> = {};
  for (const stage of stages) {
    next[stage.id] = reconcileStage(stage.id, state.stages[stage.id], issues);
  }
  for (const id of Object.keys(state.stages)) {
    if (!expected.has(id)) {
      pushIssue(issues, {
        code: "unknown-stage-removed",
        path: `/stages/${id}`,
        message: `Removed unknown stage "${id}".`,
      });
    }
  }
  return next;
};

const reconcileStage = (
  id: string,
  stage: StageState | undefined,
  issues: StateReconciliationIssue[],
): StageState => {
  if (stage === undefined) {
    pushIssue(issues, {
      code: "missing-stage-added",
      path: `/stages/${id}`,
      message: `Added missing stage "${id}".`,
    });
    return createInitialStageState({ id });
  }
  return repairStageAttempts(repairRunningStage(cloneStage(stage), issues), issues);
};

const repairRunningStage = (stage: StageState, issues: StateReconciliationIssue[]): StageState => {
  if (stage.status !== "running") {
    return stage;
  }
  pushIssue(issues, {
    code: "running-stage-reset",
    path: `/stages/${stage.id}/status`,
    message: "Reset running stage.",
  });
  return { ...stage, status: "pending", startedAt: null, finishedAt: null };
};

const repairStageAttempts = (stage: StageState, issues: StateReconciliationIssue[]): StageState => {
  if (stage.attempts === stage.history.length) {
    return stage;
  }
  pushIssue(issues, {
    code: "stage-attempts-repaired",
    path: `/stages/${stage.id}/attempts`,
    message: "Repaired attempts.",
  });
  return { ...stage, attempts: stage.history.length };
};

const repairPipelineFields = (
  state: PipelineState,
  request: ReconcilePipelineStateRequest,
  issues: StateReconciliationIssue[],
): PipelineState => {
  let next = resetRunningPipeline(state, issues);
  next = repairCurrentStage(next, request.stages, issues);
  return repairFinishedAt(next, request.now, issues);
};

const resetRunningPipeline = (
  state: PipelineState,
  issues: StateReconciliationIssue[],
): PipelineState => {
  if (state.status !== "running") {
    return state;
  }
  pushIssue(issues, {
    code: "running-pipeline-reset",
    path: "/status",
    message: "Reset running pipeline.",
  });
  return { ...state, status: "pending", finishedAt: null };
};

const repairCurrentStage = (
  state: PipelineState,
  stages: readonly Pick<CompiledStageDef, "id">[],
  issues: StateReconciliationIssue[],
): PipelineState => {
  if (isTerminalPipelineStatus(state.status) && state.currentStage !== null) {
    pushIssue(issues, {
      code: "terminal-current-stage-cleared",
      path: "/currentStage",
      message: "Cleared terminal currentStage.",
    });
    return { ...state, currentStage: null };
  }
  const known = new Set(stages.map((stage) => stage.id));
  if (
    !isTerminalPipelineStatus(state.status) &&
    state.currentStage !== null &&
    !known.has(state.currentStage)
  ) {
    pushIssue(issues, {
      code: "current-stage-repaired",
      path: "/currentStage",
      message: "Cleared unknown currentStage.",
    });
    return { ...state, currentStage: null };
  }
  return state;
};

const repairFinishedAt = (
  state: PipelineState,
  now: (() => Date) | undefined,
  issues: StateReconciliationIssue[],
): PipelineState => {
  if (isTerminalPipelineStatus(state.status) && state.finishedAt === null) {
    pushIssue(issues, {
      code: "finished-at-repaired",
      path: "/finishedAt",
      message: "Set missing terminal finishedAt.",
    });
    return { ...state, finishedAt: (now?.() ?? new Date()).toISOString() };
  }
  if (!isTerminalPipelineStatus(state.status) && state.finishedAt !== null) {
    pushIssue(issues, {
      code: "finished-at-repaired",
      path: "/finishedAt",
      message: "Cleared non-terminal finishedAt.",
    });
    return { ...state, finishedAt: null };
  }
  return state;
};

const repairEconomics = (state: PipelineState, issues: StateReconciliationIssue[]): void => {
  const economics = recomputeEconomics(state);
  if (
    state.economics.tokens === economics.tokens &&
    state.economics.dollars === economics.dollars
  ) {
    return;
  }
  pushIssue(issues, {
    code: "economics-recomputed",
    path: "/economics",
    message: "Recomputed economics.",
  });
  Object.assign(state, { economics });
};

const recomputeEconomics = (state: PipelineState): RunEconomicsSummary => {
  let tokens = 0;
  let dollars = 0;
  for (const stage of Object.values(state.stages)) {
    for (const attempt of stage.history) {
      tokens += attempt.usage?.tokens ?? 0;
      dollars += attempt.usage?.dollars ?? 0;
    }
  }
  return { tokens, dollars };
};

const cloneStage = (stage: StageState): StageState => ({
  id: stage.id,
  status: stage.status,
  attempts: stage.attempts,
  startedAt: stage.startedAt,
  finishedAt: stage.finishedAt,
  history: stage.history.map(cloneAttempt),
  ...(stage.reason === undefined ? {} : { reason: stage.reason }),
  ...(stage.findings === undefined ? {} : { findings: [...stage.findings] }),
});

const cloneAttempt = (attempt: StageAttemptState): StageAttemptState => ({
  attempt: attempt.attempt,
  status: attempt.status,
  startedAt: attempt.startedAt,
  finishedAt: attempt.finishedAt,
  durationMs: attempt.durationMs,
  exitCode: attempt.exitCode,
  ...(attempt.parseError === undefined ? {} : { parseError: attempt.parseError }),
  ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
  ...(attempt.findings === undefined ? {} : { findings: [...attempt.findings] }),
  ...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
});

const isCompleteStageStatus = (status: StageState["status"] | undefined): boolean =>
  status === "passed" || status === "skipped";

const pushIssue = (issues: StateReconciliationIssue[], issue: StateReconciliationIssue): void => {
  issues.push(Object.freeze(issue));
};

const freezeState = (state: PipelineState): PipelineState => {
  freezeValue(state);
  return state;
};

const freezeValue = (value: unknown): void => {
  if (value === null || typeof value !== "object") {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeValue(child);
  }
};
