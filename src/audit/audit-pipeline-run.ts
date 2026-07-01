/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-example, jsdoc/informative-docs -- audit report schema mirrors the task contract. */

import type { StoryPullRequest, MergeGateEvaluation } from "../git/index.js";
import type { CompiledStageDef } from "../rundef/index.js";
import { redactText, type HarnessEvidenceReport } from "../security/index.js";
import {
  isTerminalPipelineStatus,
  toRunResultStatus,
  type PipelineState,
  type RunResult,
  type StageState,
} from "../state/index.js";

/** Audit report schema version. */
export const PIPELINE_AUDIT_REPORT_VERSION = 1 as const;

/** Terminal audit status. */
export type PipelineAuditStatus =
  "passed" | "failed" | "needs-approval" | "paused" | "pr-opened" | "needs-attention";

/** One audited stage summary. */
export interface PipelineAuditStageSummary {
  readonly id: string;
  readonly index: number;
  readonly status: string;
  readonly attempts: number;
  readonly workflow: string;
  readonly agent: string;
  readonly durationMs: number | null;
  readonly reason?: string;
}

/** Request for generating an audit report. */
export interface GeneratePipelineAuditReportRequest {
  readonly state: PipelineState;
  readonly stages: readonly CompiledStageDef[];
  readonly action: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly result?: RunResult;
  readonly harnessEvidence?: HarnessEvidenceReport;
  readonly pullRequest?: StoryPullRequest;
  readonly mergeGate?: MergeGateEvaluation;
  readonly error?: string;
}

/** Immutable pipeline audit report. */
export interface PipelineAuditReport {
  readonly version: typeof PIPELINE_AUDIT_REPORT_VERSION;
  readonly storyId: string;
  readonly specFile: string;
  readonly action: string;
  readonly status: PipelineAuditStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly worktreePath: string;
  readonly branch: string;
  readonly model: string;
  readonly thinking: string;
  readonly regressions: number;
  readonly stages: readonly PipelineAuditStageSummary[];
  readonly economics: {
    readonly tokens: number;
    readonly dollars: number;
  };
  readonly harnessEvidence?: {
    readonly passed: boolean;
    readonly commandCount: number;
    readonly failedCommands: readonly string[];
  };
  readonly pullRequest?: {
    readonly url: string;
    readonly number?: number;
  };
  readonly mergeGate?: {
    readonly passed: boolean;
    readonly decision: string;
    readonly blockerCount: number;
  };
  readonly error?: string;
}

/**
 * Generates a sanitized immutable pipeline audit report.
 *
 * @param request - Audit report request.
 *
 * @returns Frozen audit report.
 */
export function generatePipelineAuditReport(
  request: GeneratePipelineAuditReportRequest,
): PipelineAuditReport {
  return freezeReport({
    version: PIPELINE_AUDIT_REPORT_VERSION,
    storyId: clean(request.state.storyId),
    specFile: clean(request.state.specFile),
    action: clean(request.action),
    status: auditStatus(request),
    startedAt: clean(request.startedAt),
    finishedAt: clean(request.finishedAt),
    durationMs: request.durationMs,
    worktreePath: clean(request.state.worktreePath),
    branch: clean(request.state.branch),
    model: clean(request.state.model),
    thinking: clean(request.state.thinking),
    regressions: request.state.regressions,
    stages: request.stages.map((stage) => stageSummary(stage, request.state.stages[stage.id])),
    economics: {
      tokens: request.state.economics.tokens,
      dollars: request.state.economics.dollars,
    },
    ...optionalHarness(request.harnessEvidence),
    ...optionalPullRequest(request.pullRequest),
    ...optionalMergeGate(request.mergeGate),
    ...optionalError(request.error),
  });
}

const auditStatus = (request: GeneratePipelineAuditReportRequest): PipelineAuditStatus => {
  if (request.result !== undefined) {
    return request.result.status;
  }
  return isTerminalPipelineStatus(request.state.status)
    ? toRunResultStatus(request.state.status)
    : "needs-attention";
};

const stageSummary = (
  stage: CompiledStageDef,
  state: StageState | undefined,
): PipelineAuditStageSummary => {
  if (state === undefined) {
    return Object.freeze({
      id: clean(stage.id),
      index: stage.index,
      status: "missing",
      attempts: 0,
      workflow: clean(stage.workflow),
      agent: clean(stage.agent),
      durationMs: null,
      reason: "Stage state is missing.",
    });
  }
  return freezeStage({
    id: clean(stage.id),
    index: stage.index,
    status: clean(state.status),
    attempts: state.attempts,
    workflow: clean(stage.workflow),
    agent: clean(stage.agent),
    durationMs: latestDuration(state),
    ...optionalReason(state.reason),
  });
};

const latestDuration = (state: StageState): number | null =>
  state.history.at(-1)?.durationMs ?? null;

const optionalHarness = (
  report: HarnessEvidenceReport | undefined,
): Pick<PipelineAuditReport, "harnessEvidence"> | Record<string, never> =>
  report === undefined
    ? {}
    : {
        harnessEvidence: Object.freeze({
          passed: report.passed,
          commandCount: report.commands.length,
          failedCommands: Object.freeze(
            report.commands
              .filter((command) => command.status !== "passed")
              .map((command) => clean(command.name)),
          ),
        }),
      };

const optionalPullRequest = (
  pullRequest: StoryPullRequest | undefined,
): Pick<PipelineAuditReport, "pullRequest"> | Record<string, never> => {
  if (pullRequest === undefined) {
    return {};
  }
  return {
    pullRequest: Object.freeze({
      url: clean(pullRequest.url),
      ...(pullRequest.number === undefined ? {} : { number: pullRequest.number }),
    }),
  };
};

const optionalMergeGate = (
  mergeGate: MergeGateEvaluation | undefined,
): Pick<PipelineAuditReport, "mergeGate"> | Record<string, never> =>
  mergeGate === undefined
    ? {}
    : {
        mergeGate: Object.freeze({
          passed: mergeGate.passed,
          decision: clean(mergeGate.decision),
          blockerCount: mergeGate.blockers.length,
        }),
      };

const optionalReason = (
  reason: string | undefined,
): Pick<PipelineAuditStageSummary, "reason"> | Record<string, never> =>
  reason === undefined ? {} : { reason: clean(reason) };

const optionalError = (
  error: string | undefined,
): Pick<PipelineAuditReport, "error"> | Record<string, never> =>
  error === undefined ? {} : { error: clean(error) };

const freezeReport = (report: PipelineAuditReport): PipelineAuditReport =>
  Object.freeze({
    ...report,
    stages: Object.freeze(report.stages),
    economics: Object.freeze(report.economics),
  });

const freezeStage = (stage: PipelineAuditStageSummary): PipelineAuditStageSummary =>
  Object.freeze(stage);

const clean = (value: string): string => redactText(value).value;
