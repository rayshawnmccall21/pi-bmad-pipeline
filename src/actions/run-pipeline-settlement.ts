/**
 * Outcome settlement policy for one pipeline run.
 *
 * Owns the policy half of the action after the FSM returns: harness-owned
 * evidence collection (fail closed on any failure), the explicit D3 PR policy
 * (openPr false terminates a passing run as "passed"), terminal state
 * persistence, audit-report generation, and the terminal result event. Every
 * outcome is data; this module never throws for run failures.
 *
 * @packageDocumentation
 */

import { finalizeState } from "../core/runner-transitions.js";
import {
  toRunResultStatus,
  type PipelineState,
  type PipelineStatus,
  type RunResult,
  type RunResultStatus,
} from "../state/index.js";

import type { PipelineActionContext } from "./run-pipeline-action.js";
import type { PreparedPipeline } from "./run-pipeline-execution.js";
import type { RunPipelineStagesResult } from "../core/index.js";
import type { StoryPullRequest } from "../git/index.js";
import type { HarnessEvidenceReport } from "../security/index.js";

/** Action name recorded on run results and audit reports. */
export const RUN_PIPELINE_ACTION_NAME = "run" as const;

/** Settled terminal outcome folded from FSM, evidence, and PR policy. */
export interface SettledOutcome {
  /** Public terminal status. */
  readonly status: RunResultStatus;

  /** Final durable state for reporting. */
  readonly state: PipelineState;

  /** Stage ids executed during the run. */
  readonly stagesRun: readonly string[];

  /** Number of gate-triggered regressions performed. */
  readonly regressions: number;

  /** Terminal error message for non-passing outcomes. */
  readonly error?: string;

  /** Harness evidence report when evidence ran. */
  readonly evidence?: HarnessEvidenceReport;

  /** Opened pull request when the D3 policy requested one. */
  readonly pullRequest?: StoryPullRequest;
}

/**
 * Settles a completed FSM run: evidence fail-closed, then the D3 PR policy.
 *
 * @param context - Action context with injected dependencies.
 * @param prepared - Prepared pipeline inputs.
 * @param fsm - Terminal FSM result with status "done".
 *
 * @returns Settled outcome carrying status, state, and artifacts.
 *
 * @example
 * ```ts
 * const settled = await settleDone(context, prepared, fsm);
 * ```
 */
export const settleDone = async (
  context: PipelineActionContext,
  prepared: PreparedPipeline,
  fsm: RunPipelineStagesResult,
): Promise<SettledOutcome> => {
  const evidence = await collectEvidence(context, prepared);
  if (!evidence.passed) {
    return failEvidence(context, { fsm, evidence });
  }
  if (!context.request.openPr) {
    return {
      status: "passed",
      state: fsm.state,
      stagesRun: fsm.stagesRun,
      regressions: fsm.regressions,
      evidence,
    };
  }
  return openStoryPr(context, { prepared, fsm, evidence });
};

/**
 * Converts a non-done FSM result into a settled failure outcome.
 *
 * @param fsm - Terminal FSM result with status "failed" or "needs-attention".
 *
 * @returns Settled outcome mirroring the FSM failure as data.
 *
 * @example
 * ```ts
 * const settled = settleFsmFailure(fsm);
 * ```
 */
export const settleFsmFailure = (fsm: RunPipelineStagesResult): SettledOutcome => ({
  status: toRunResultStatus(fsm.status),
  state: fsm.state,
  stagesRun: fsm.stagesRun,
  regressions: fsm.regressions,
  ...(fsm.failure === undefined ? {} : { error: fsm.failure.reason }),
});

/**
 * Generates the audit report, emits the result event, and builds the result.
 *
 * @param context - Action context with injected dependencies.
 * @param prepared - Prepared pipeline inputs.
 * @param settled - Settled terminal outcome.
 *
 * @returns Frozen terminal {@link RunResult}.
 *
 * @example
 * ```ts
 * return finishAction(context, prepared, settled);
 * ```
 */
export const finishAction = (
  context: PipelineActionContext,
  prepared: PreparedPipeline,
  settled: SettledOutcome,
): RunResult => {
  const result = buildRunResult(context, prepared, settled);
  context.deps.generateAuditReport({
    state: settled.state,
    stages: prepared.stages,
    action: RUN_PIPELINE_ACTION_NAME,
    startedAt: context.startedAtIso,
    finishedAt: context.now().toISOString(),
    durationMs: result.durationMs,
    result,
    ...(settled.evidence === undefined ? {} : { harnessEvidence: settled.evidence }),
    ...(settled.pullRequest === undefined ? {} : { pullRequest: settled.pullRequest }),
    ...(settled.error === undefined ? {} : { error: settled.error }),
  });
  emitResult(context, result);
  return result;
};

/**
 * Builds, emits, and returns a minimal needs-attention result.
 *
 * Used for terminal outcomes reached before a pipeline was prepared, such as
 * dispatch-lock contention or a thrown step.
 *
 * @param context - Action context with injected dependencies.
 * @param error - Terminal error message.
 *
 * @returns Frozen needs-attention {@link RunResult}.
 *
 * @example
 * ```ts
 * return emitMinimalResult(context, "lock held");
 * ```
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

const collectEvidence = async (
  context: PipelineActionContext,
  prepared: PreparedPipeline,
): Promise<HarnessEvidenceReport> => {
  const { deps, request } = context;
  const report = await deps.runEvidence({
    projectRoot: request.projectRoot,
    commandCwd: prepared.worktree.path,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    now: context.now,
  });
  await deps.saveEvidence({
    projectRoot: request.projectRoot,
    storyId: request.storyId,
    report,
  });
  context.emitter.emit("evidence.finished", {
    passed: report.passed,
    failedCommands: failedCommandNames(report),
  });
  return report;
};

const failEvidence = async (
  context: PipelineActionContext,
  input: { readonly fsm: RunPipelineStagesResult; readonly evidence: HarnessEvidenceReport },
): Promise<SettledOutcome> => {
  const state = await persistTerminalState(context, input.fsm.state, "needs-attention");
  return {
    status: "needs-attention",
    state,
    stagesRun: input.fsm.stagesRun,
    regressions: input.fsm.regressions,
    evidence: input.evidence,
    error: `Harness evidence failed: ${failedCommandNames(input.evidence).join(", ")}.`,
  };
};

const openStoryPr = async (
  context: PipelineActionContext,
  input: {
    readonly prepared: PreparedPipeline;
    readonly fsm: RunPipelineStagesResult;
    readonly evidence: HarnessEvidenceReport;
  },
): Promise<SettledOutcome> => {
  const pullRequest = await context.deps.openPullRequest({
    projectRoot: context.request.projectRoot,
    worktreePath: input.prepared.worktree.path,
    storyId: context.request.storyId,
    branch: input.prepared.worktree.branch,
  });
  context.emitter.emit("pr.opened", {
    prUrl: pullRequest.url,
    prNumber: pullRequest.number ?? 0,
    branch: pullRequest.branch,
  });
  const state = await persistTerminalState(context, input.fsm.state, "pr-opened");
  return {
    status: "pr-opened",
    state,
    stagesRun: input.fsm.stagesRun,
    regressions: input.fsm.regressions,
    evidence: input.evidence,
    pullRequest,
  };
};

const persistTerminalState = async (
  context: PipelineActionContext,
  state: PipelineState,
  status: PipelineStatus,
): Promise<PipelineState> => {
  const terminal = finalizeState(state, status, context.now().toISOString());
  await context.deps.saveState(context.request.projectRoot, terminal);
  return terminal;
};

const buildRunResult = (
  context: PipelineActionContext,
  prepared: PreparedPipeline,
  settled: SettledOutcome,
): RunResult =>
  Object.freeze({
    storyId: context.request.storyId,
    specFile: context.request.specFile,
    action: RUN_PIPELINE_ACTION_NAME,
    status: settled.status,
    stagesRun: Object.freeze([...settled.stagesRun]),
    regressions: settled.regressions,
    durationMs: elapsedMs(context),
    ...(settled.error === undefined ? {} : { error: settled.error }),
    worktreePath: prepared.worktree.path,
    branch: prepared.worktree.branch,
    ...(settled.pullRequest === undefined ? {} : { prUrl: settled.pullRequest.url }),
    ...(settled.pullRequest?.number === undefined ? {} : { prNumber: settled.pullRequest.number }),
    economics: settled.state.economics,
  });

const emitResult = (context: PipelineActionContext, result: RunResult): void => {
  context.emitter.emit("result", {
    status: result.status,
    stagesRun: result.stagesRun,
    regressions: result.regressions,
    durationMs: result.durationMs,
    ...(result.error === undefined ? {} : { error: result.error }),
  });
};

const failedCommandNames = (report: HarnessEvidenceReport): readonly string[] =>
  Object.freeze(
    report.commands.filter((command) => command.status !== "passed").map((command) => command.name),
  );

const elapsedMs = (context: PipelineActionContext): number =>
  Math.max(0, context.now().getTime() - context.startedAtMs);
