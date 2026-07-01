import type { PipelineState } from "./pipeline-state.js";

const pipelineStatuses = new Set([
  "pending",
  "running",
  "done",
  "failed",
  "needs-approval",
  "paused",
  "pr-opened",
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

const requiredStrings = [
  "storyId",
  "specFile",
  "worktreePath",
  "branch",
  "model",
  "thinking",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isNonNegativeFinite = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasOptionalString = (record: Record<string, unknown>, key: string): boolean =>
  !(key in record) || isString(record[key]);

const hasOptionalStringArray = (record: Record<string, unknown>, key: string): boolean =>
  !(key in record) || isStringArray(record[key]);

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

const validStage = (value: unknown): boolean =>
  isRecord(value) &&
  validStageCore(value) &&
  hasOptionalString(value, "reason") &&
  hasOptionalStringArray(value, "findings");

const validStages = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).every(validStage);

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
