import { isDeepStrictEqual } from "node:util";

import {
  FINAL_SCOPE_RECEIPT_VERSION,
  createCanonicalRepositoryScope,
} from "../security/final-scope-receipt.js";
import { sanitizeStageHandoff } from "../security/stage-handoff.js";

import { RUNNER_FEATURE_VERSION, type PipelineState } from "./pipeline-state.js";
import {
  qualityGateMatchesDurableStage,
  receiptIntegrityFactsAreValid,
  repositoryScopesHaveDisjointPaths,
} from "./scope-receipt-validation.js";

const pipelineStatuses = new Set([
  "pending",
  "running",
  "done",
  "failed",
  "needs-approval",
  "paused",
  "needs-attention",
]);

const stageStatuses = new Set(["pending", "running", "passed", "failed", "skipped", "blocked"]);

const stageAttemptStatuses = new Set([
  "passed",
  "failed",
  "timed-out",
  "aborted",
  "parse-error",
  "gate-failed",
]);

const requiredStrings = "storyId runDefId runDefDigest specFile model thinking".split(" ");

const repositoryScopeKeys = "paths digest".split(" ");
const qualityGateKeys = "stageId attempt status finishedAt".split(" ");
const reviewCheckpointKeys =
  "version storyId runId runDefId runDefDigest branch baseOid reviewed qualityGate".split(" ");
const finalScopeReceiptKeys = [...reviewCheckpointKeys, "docs", "finalWorkingTreeDigest"];
const checkpointStringKeys = "storyId runId runDefId branch".split(" ");
const lowercaseOidPattern = /^[0-9a-f]{40}$/u;
const lowercaseDigestPattern = /^[0-9a-f]{64}$/u;
const emptyFileBytes = new Uint8Array();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isNonNegativeFinite = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNonBlankString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

const hasCanonicalRepositoryPaths = (paths: readonly string[]): boolean => {
  try {
    const files = paths.map((path) => ({ path, bytes: emptyFileBytes }));
    return isDeepStrictEqual(createCanonicalRepositoryScope(files).paths, paths);
  } catch {
    return false;
  }
};

const validRepositoryScope = (value: unknown): boolean => {
  if (!isRecord(value) || !hasExactKeys(value, repositoryScopeKeys)) {
    return false;
  }
  const paths = value["paths"];
  return (
    isStringArray(paths) &&
    hasCanonicalRepositoryPaths(paths) &&
    isString(value["digest"]) &&
    lowercaseDigestPattern.test(value["digest"])
  );
};

const validQualityGate = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, qualityGateKeys) &&
  isNonBlankString(value["stageId"]) &&
  isPositiveInteger(value["attempt"]) &&
  value["status"] === "passed" &&
  isNonBlankString(value["finishedAt"]);

const validCheckpointFields = (value: Record<string, unknown>): boolean =>
  value["version"] === FINAL_SCOPE_RECEIPT_VERSION &&
  checkpointStringKeys.every((key) => isNonBlankString(value[key])) &&
  isString(value["runDefDigest"]) &&
  lowercaseDigestPattern.test(value["runDefDigest"]) &&
  isString(value["baseOid"]) &&
  lowercaseOidPattern.test(value["baseOid"]) &&
  validRepositoryScope(value["reviewed"]) &&
  validQualityGate(value["qualityGate"]);

const validReviewCheckpoint = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && hasExactKeys(value, reviewCheckpointKeys) && validCheckpointFields(value);

const validFinalScopeReceipt = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  hasExactKeys(value, finalScopeReceiptKeys) &&
  validCheckpointFields(value) &&
  validRepositoryScope(value["docs"]) &&
  isString(value["finalWorkingTreeDigest"]) &&
  lowercaseDigestPattern.test(value["finalWorkingTreeDigest"]);

const matchesStateIdentity = (
  receipt: Record<string, unknown>,
  state: Record<string, unknown>,
): boolean =>
  receipt["storyId"] === state["storyId"] &&
  receipt["runDefId"] === state["runDefId"] &&
  receipt["runDefDigest"] === state["runDefDigest"];

const receiptMatchesCheckpoint = (
  checkpoint: Record<string, unknown>,
  receipt: Record<string, unknown>,
): boolean => reviewCheckpointKeys.every((key) => isDeepStrictEqual(checkpoint[key], receipt[key]));

const hasOptionalString = (record: Record<string, unknown>, key: string): boolean =>
  !(key in record) || isString(record[key]);

const hasOptionalStringArray = (record: Record<string, unknown>, key: string): boolean =>
  !(key in record) || isStringArray(record[key]);

const hasValidOptionalStageHandoff = (record: Record<string, unknown>): boolean => {
  const persistedHandoff = record["upstreamHandoff"];
  return (
    !("upstreamHandoff" in record) ||
    (isString(persistedHandoff) && sanitizeStageHandoff(persistedHandoff) === persistedHandoff)
  );
};

const validStatus = (value: unknown, statuses: ReadonlySet<string>): boolean =>
  typeof value === "string" && statuses.has(value);

const validUsage = (value: unknown): boolean =>
  isRecord(value) && isNonNegativeInteger(value["tokens"]) && isNonNegativeFinite(value["dollars"]);

const validAttemptNumbers = (value: Record<string, unknown>): boolean =>
  isPositiveInteger(value["attempt"]) &&
  (value["durationMs"] === null || isNonNegativeFinite(value["durationMs"])) &&
  (value["exitCode"] === null ||
    (typeof value["exitCode"] === "number" && Number.isFinite(value["exitCode"])));

const validAttemptCore = (value: Record<string, unknown>): boolean =>
  [
    validAttemptNumbers(value),
    validStatus(value["status"], stageAttemptStatuses),
    isStringOrNull(value["startedAt"]),
    isStringOrNull(value["finishedAt"]),
  ].every(Boolean);

const validAttemptOptionals = (value: Record<string, unknown>): boolean =>
  [
    hasOptionalString(value, "parseError"),
    hasOptionalString(value, "reason"),
    hasOptionalStringArray(value, "findings"),
    !("usage" in value) || validUsage(value["usage"]),
  ].every(Boolean);

const validAttempt = (value: unknown): boolean =>
  isRecord(value) && validAttemptCore(value) && validAttemptOptionals(value);

const validStageCore = (value: Record<string, unknown>): boolean =>
  [
    isString(value["id"]),
    validStatus(value["status"], stageStatuses),
    isNonNegativeInteger(value["attempts"]),
    isStringOrNull(value["startedAt"]),
    isStringOrNull(value["finishedAt"]),
    Array.isArray(value["history"]) && value["history"].every(validAttempt),
  ].every(Boolean);

const validStage = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  validStageCore(value) &&
  hasOptionalString(value, "reason") &&
  hasOptionalStringArray(value, "findings") &&
  hasValidOptionalStageHandoff(value);

const validStages = (value: unknown): boolean =>
  isRecord(value) &&
  Object.entries(value).every(
    ([stageId, stageState]) => validStage(stageState) && stageState["id"] === stageId,
  );

const validEconomics = (value: unknown): boolean =>
  isRecord(value) && isNonNegativeInteger(value["tokens"]) && isNonNegativeFinite(value["dollars"]);

const rootStringReason = (candidate: Record<string, unknown>): string | undefined => {
  for (const field of requiredStrings) {
    if (!isString(candidate[field])) {
      return `Field "${field}" is missing or not a string.`;
    }
  }
  return undefined;
};

const rootVersionReason = (candidate: Record<string, unknown>): string | undefined =>
  isNonNegativeInteger(candidate["runnerFeatureVersion"])
    ? undefined
    : 'Field "runnerFeatureVersion" is not a non-negative integer.';

const rootStatusReason = (candidate: Record<string, unknown>): string | undefined =>
  validStatus(candidate["status"], pipelineStatuses)
    ? undefined
    : 'Field "status" is not a valid PipelineStatus.';

const rootCurrentStageReason = (candidate: Record<string, unknown>): string | undefined =>
  isStringOrNull(candidate["currentStage"])
    ? undefined
    : 'Field "currentStage" is not a string or null.';

const rootStagesReason = (candidate: Record<string, unknown>): string | undefined =>
  validStages(candidate["stages"]) ? undefined : 'Field "stages" contains invalid stage state.';

const rootRegressionReason = (candidate: Record<string, unknown>): string | undefined =>
  isNonNegativeInteger(candidate["regressions"])
    ? undefined
    : 'Field "regressions" is not a non-negative integer.';

const rootStartedAtReason = (candidate: Record<string, unknown>): string | undefined =>
  isStringOrNull(candidate["startedAt"]) ? undefined : 'Field "startedAt" is not a string or null.';

const rootFinishedAtReason = (candidate: Record<string, unknown>): string | undefined =>
  isStringOrNull(candidate["finishedAt"])
    ? undefined
    : 'Field "finishedAt" is not a string or null.';

const rootEconomicsReason = (candidate: Record<string, unknown>): string | undefined =>
  validEconomics(candidate["economics"])
    ? undefined
    : 'Field "economics" is not a valid RunEconomicsSummary.';

const rootOptionalOldFields = (candidate: Record<string, unknown>): string | undefined =>
  hasOptionalString(candidate, "worktreePath") && hasOptionalString(candidate, "branch")
    ? undefined
    : 'Optional fields "worktreePath" or "branch" must be strings when present.';

const unsupportedVersionReason = (version: unknown): string | undefined =>
  isNonNegativeInteger(version) && version > RUNNER_FEATURE_VERSION
    ? `Field "runnerFeatureVersion" ${String(version)} is newer than supported version ${String(RUNNER_FEATURE_VERSION)}.`
    : undefined;

const incompatibleReceiptVersionReason = (
  candidate: Record<string, unknown>,
): string | undefined =>
  (Object.hasOwn(candidate, "reviewCheckpoint") || Object.hasOwn(candidate, "finalScopeReceipt")) &&
  candidate["runnerFeatureVersion"] !== RUNNER_FEATURE_VERSION
    ? `Fields "reviewCheckpoint" and "finalScopeReceipt" require runnerFeatureVersion ${String(RUNNER_FEATURE_VERSION)}.`
    : undefined;

const rootReceiptVersionReason = (candidate: Record<string, unknown>): string | undefined => {
  const unsupportedReason = unsupportedVersionReason(candidate["runnerFeatureVersion"]);
  if (unsupportedReason !== undefined) {
    return unsupportedReason;
  }
  if (candidate["status"] === "done" && !Object.hasOwn(candidate, "finalScopeReceipt")) {
    return 'Field "finalScopeReceipt" is required when status is "done".';
  }
  return incompatibleReceiptVersionReason(candidate);
};

const validReceiptIntegrity = (candidate: Record<string, unknown>): boolean => {
  const checkpoint = candidate["reviewCheckpoint"];
  const receipt = candidate["finalScopeReceipt"];
  const checkpointValid = validReviewCheckpoint(checkpoint);
  const receiptValid = validFinalScopeReceipt(receipt);
  const checkpointRecord = checkpointValid ? checkpoint : {};
  const receiptRecord = receiptValid ? receipt : {};
  return receiptIntegrityFactsAreValid({
    checkpointPresent: Object.hasOwn(candidate, "reviewCheckpoint"),
    checkpointValid,
    checkpointMatches:
      matchesStateIdentity(checkpointRecord, candidate) &&
      qualityGateMatchesDurableStage(checkpointRecord["qualityGate"], candidate["stages"]),
    receiptPresent: Object.hasOwn(candidate, "finalScopeReceipt"),
    receiptValid,
    receiptMatches: [
      matchesStateIdentity(receiptRecord, candidate),
      receiptMatchesCheckpoint(checkpointRecord, receiptRecord),
      repositoryScopesHaveDisjointPaths(receiptRecord["reviewed"], receiptRecord["docs"]),
    ].every(Boolean),
  });
};

const rootReceiptIntegrityReason = (candidate: Record<string, unknown>): string | undefined =>
  validReceiptIntegrity(candidate)
    ? undefined
    : 'Fields "reviewCheckpoint" or "finalScopeReceipt" are malformed, inconsistent, or name no matching quality stage attempt.';

const rootReasonChecks = [
  rootStringReason,
  rootVersionReason,
  rootStatusReason,
  rootCurrentStageReason,
  rootStagesReason,
  rootRegressionReason,
  rootStartedAtReason,
  rootFinishedAtReason,
  rootEconomicsReason,
  rootOptionalOldFields,
  rootReceiptVersionReason,
  rootReceiptIntegrityReason,
] as const;

/**
 * Returns the first structural validation failure for a pipeline state candidate.
 *
 * @param candidate - Parsed JSON value to validate as durable pipeline state.
 *
 * @returns A human-readable failure reason, or undefined when the shape is valid.
 *
 * @example
 * ```ts
 * const reason = getPipelineStateInvalidReason(candidate);
 * ```
 */
export function getPipelineStateInvalidReason(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) {
    return "State root is not an object.";
  }
  for (const check of rootReasonChecks) {
    const reason = check(candidate);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

/**
 * Checks whether a value has the durable PipelineState structure.
 *
 * @param candidate - Value to test.
 *
 * @returns True when the value has a valid PipelineState shape.
 *
 * @example
 * ```ts
 * if (isPipelineState(candidate)) {
 *   console.log(candidate.storyId);
 * }
 * ```
 */
export function isPipelineState(candidate: unknown): candidate is PipelineState {
  return getPipelineStateInvalidReason(candidate) === undefined;
}

/**
 * Deep-freezes a loaded PipelineState snapshot.
 *
 * @param state - Validated state to freeze.
 *
 * @returns The same state object after recursively freezing child objects.
 *
 * @example
 * ```ts
 * const frozen = freezePipelineState(state);
 * ```
 */
export function freezePipelineState(state: PipelineState): PipelineState {
  freezeValue(state);
  return state;
}

const freezeValue = (value: unknown): void => {
  if (value === null || typeof value !== "object") {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeValue(child);
  }
};
