/* eslint-disable jsdoc/informative-docs, jsdoc/sort-tags -- keep task-specified public docs. */

import { redactText, type HarnessEvidenceReport } from "../security/index.js";
import type { GitSecretScanResult } from "./secret-scan.js";

/** Merge gate terminal decision. */
export type MergeGateDecisionKind = "merge-allowed" | "merge-blocked";

/** Merge gate blocker code. */
export type MergeGateBlockerCode =
  | "missing-pull-request"
  | "harness-evidence-missing"
  | "harness-evidence-failed"
  | "secret-scan-blocked"
  | "agent-claim-diverged";

/** Minimal pull request metadata needed by the merge gate. */
export interface MergeGatePullRequest {
  /** Pull request URL. */
  readonly url: string;

  /** Optional pull request number. */
  readonly number?: number;
}

/** Agent-reported claim that can be compared against harness evidence. */
export interface AgentEvidenceClaim {
  /** Whether the agent claimed tests passed. */
  readonly testsPassed?: boolean;

  /** Whether the agent claimed typecheck passed. */
  readonly typecheckPassed?: boolean;

  /** Whether the agent claimed lint passed. */
  readonly lintPassed?: boolean;
}

/** One merge blocker. */
export interface MergeGateBlocker {
  /** Stable blocker code. */
  readonly code: MergeGateBlockerCode;

  /** Human-readable sanitized blocker reason. */
  readonly reason: string;
}

/** Request for evaluating default-branch merge eligibility. */
export interface EvaluateMergeGateRequest {
  /** Pull request metadata. */
  readonly pullRequest?: MergeGatePullRequest;

  /** Harness-owned evidence report. */
  readonly harnessEvidence?: HarnessEvidenceReport;

  /** Latest git diff secret scan result. */
  readonly secretScan?: GitSecretScanResult;

  /** Optional agent claim to compare against harness-owned evidence. */
  readonly agentClaim?: AgentEvidenceClaim;
}

/** Merge gate evaluation result. */
export interface MergeGateEvaluation {
  /** Terminal merge gate decision. */
  readonly decision: MergeGateDecisionKind;

  /** True only when default-branch merge may proceed. */
  readonly passed: boolean;

  /** Merge blockers. Empty when passed. */
  readonly blockers: readonly MergeGateBlocker[];

  /** Human-readable summary. */
  readonly reason: string;
}

interface ClaimMapping {
  readonly field: keyof AgentEvidenceClaim;
  readonly commandName: string;
}

const claimMappings: readonly ClaimMapping[] = Object.freeze([
  { field: "testsPassed", commandName: "test" },
  { field: "typecheckPassed", commandName: "typecheck" },
  { field: "lintPassed", commandName: "lint" },
]);

/**
 * Evaluates whether a story PR may proceed to default-branch merge.
 *
 * @param request - Merge gate evaluation request.
 * @returns Frozen merge gate evaluation.
 *
 * @example
 * ```ts
 * const gate = evaluateMergeGate({ pullRequest, harnessEvidence, secretScan });
 * ```
 */
export function evaluateMergeGate(request: EvaluateMergeGateRequest): MergeGateEvaluation {
  const blockers = Object.freeze(
    [
      missingPullRequest(request),
      missingHarnessEvidence(request),
      failedHarnessEvidence(request),
      secretScanBlocker(request),
      agentClaimDivergence(request),
    ].filter((blocker): blocker is MergeGateBlocker => blocker !== undefined),
  );
  return freezeEvaluation(blockers);
}

const missingPullRequest = (request: EvaluateMergeGateRequest): MergeGateBlocker | undefined =>
  request.pullRequest === undefined
    ? blocker("missing-pull-request", "No pull request was opened for this story.")
    : undefined;

const missingHarnessEvidence = (request: EvaluateMergeGateRequest): MergeGateBlocker | undefined =>
  request.harnessEvidence === undefined
    ? blocker("harness-evidence-missing", "Harness-owned evidence is missing.")
    : undefined;

const failedHarnessEvidence = (request: EvaluateMergeGateRequest): MergeGateBlocker | undefined => {
  const evidence = request.harnessEvidence;
  if (evidence === undefined || evidence.passed) {
    return undefined;
  }
  const failingNames = evidence.commands
    .filter((command) => command.status !== "passed")
    .map((command) => command.name);
  return blocker("harness-evidence-failed", failedHarnessReason(failingNames));
};

const secretScanBlocker = (request: EvaluateMergeGateRequest): MergeGateBlocker | undefined => {
  if (request.secretScan === undefined) {
    return blocker("secret-scan-blocked", "Git diff secret scan result is missing.");
  }
  return request.secretScan.passed
    ? undefined
    : blocker("secret-scan-blocked", request.secretScan.reason);
};

const agentClaimDivergence = (request: EvaluateMergeGateRequest): MergeGateBlocker | undefined => {
  const diverged = claimMappings
    .filter((mapping) => claimDiverged(request, mapping))
    .map((mapping) => mapping.field);
  return diverged.length === 0
    ? undefined
    : blocker(
        "agent-claim-diverged",
        `Agent evidence claim diverged from harness-owned evidence: ${diverged.join(", ")}.`,
      );
};

const claimDiverged = (request: EvaluateMergeGateRequest, mapping: ClaimMapping): boolean =>
  request.agentClaim?.[mapping.field] === true &&
  !harnessCommandPassed(request.harnessEvidence, mapping.commandName);

const harnessCommandPassed = (
  evidence: HarnessEvidenceReport | undefined,
  commandName: string,
): boolean =>
  evidence?.commands.find((command) => command.name === commandName)?.status === "passed";

const failedHarnessReason = (failingNames: readonly string[]): string =>
  failingNames.length === 0
    ? "Harness-owned evidence failed."
    : `Harness-owned evidence failed: ${failingNames.join(", ")}.`;

const blocker = (code: MergeGateBlockerCode, reason: string): MergeGateBlocker =>
  Object.freeze({ code, reason: redactText(reason).value });

const freezeEvaluation = (blockers: readonly MergeGateBlocker[]): MergeGateEvaluation =>
  Object.freeze({
    decision: blockers.length === 0 ? "merge-allowed" : "merge-blocked",
    passed: blockers.length === 0,
    blockers,
    reason: summary(blockers.length),
  });

const summary = (blockerCount: number): string => {
  if (blockerCount === 0) {
    return "Merge gate passed.";
  }
  if (blockerCount === 1) {
    return "Merge gate blocked 1 issue.";
  }
  return `Merge gate blocked ${String(blockerCount)} issues.`;
};
