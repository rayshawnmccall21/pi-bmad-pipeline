/** Durable stage-history correlation for final-scope quality receipts. */

/** Precomputed structural facts for durable receipt/checkpoint integrity. */
interface ReceiptIntegrityFacts {
  /** Whether the checkpoint property exists. */
  readonly checkpointPresent: boolean;
  /** Whether the checkpoint shape is valid. */
  readonly checkpointValid: boolean;
  /** Whether checkpoint identity and quality history match state. */
  readonly checkpointMatches: boolean;
  /** Whether the final receipt property exists. */
  readonly receiptPresent: boolean;
  /** Whether the final receipt shape is valid. */
  readonly receiptValid: boolean;
  /** Whether receipt identity, checkpoint, and path scopes agree. */
  readonly receiptMatches: boolean;
}

const checkpointFactsAreValid = (facts: ReceiptIntegrityFacts): boolean =>
  facts.checkpointValid ? facts.checkpointMatches : true;

const receiptFactsAreValid = (facts: ReceiptIntegrityFacts): boolean => {
  if (!facts.receiptValid) {
    return true;
  }
  return facts.checkpointValid && facts.receiptMatches;
};

/**
 * Correlates optional receipt properties with their validated integrity facts.
 *
 * @param facts - Presence, shape, and cross-record integrity observations.
 *
 * @returns Whether optional checkpoint and final-receipt state is consistent.
 *
 * @example
 * ```ts
 * receiptIntegrityFactsAreValid(facts);
 * ```
 */
export function receiptIntegrityFactsAreValid(facts: ReceiptIntegrityFacts): boolean {
  return [
    facts.checkpointPresent === facts.checkpointValid,
    facts.receiptPresent === facts.receiptValid,
    checkpointFactsAreValid(facts),
    receiptFactsAreValid(facts),
  ].every(Boolean);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repositoryPaths = (scope: unknown): readonly string[] => {
  if (!isRecord(scope) || !Array.isArray(scope["paths"])) {
    return [];
  }
  return scope["paths"].filter((path): path is string => typeof path === "string");
};

/**
 * Checks whether two receipt scopes share no repository path.
 *
 * @param left - First candidate repository scope.
 * @param right - Second candidate repository scope.
 *
 * @returns Whether the candidate path sets are disjoint.
 *
 * @example
 * ```ts
 * repositoryScopesHaveDisjointPaths(receipt.reviewed, receipt.docs);
 * ```
 */
export function repositoryScopesHaveDisjointPaths(left: unknown, right: unknown): boolean {
  const leftPaths = new Set(repositoryPaths(left));
  return repositoryPaths(right).every((path) => !leftPaths.has(path));
}

const qualityAttemptMatches = (attempt: unknown, qualityGate: Record<string, unknown>): boolean =>
  isRecord(attempt) &&
  attempt["attempt"] === qualityGate["attempt"] &&
  attempt["status"] === "passed" &&
  attempt["finishedAt"] === qualityGate["finishedAt"];

const historyMatches = (history: unknown, qualityGate: Record<string, unknown>): boolean =>
  Array.isArray(history) && history.some((attempt) => qualityAttemptMatches(attempt, qualityGate));

const qualityStage = (
  qualityGate: unknown,
  stages: unknown,
): { qualityGate: Record<string, unknown>; stage: unknown } | undefined => {
  if (!isRecord(qualityGate) || !isRecord(stages)) {
    return undefined;
  }
  const stageId = qualityGate["stageId"];
  return typeof stageId === "string" ? { qualityGate, stage: stages[stageId] } : undefined;
};

/**
 * Checks that a receipt names the exact durable passed stage attempt.
 *
 * @param qualityGate - Candidate final-scope quality receipt.
 * @param stages - Candidate durable stage record.
 *
 * @returns Whether stage id, attempt, status, and finish time all correlate.
 *
 * @example
 * ```ts
 * qualityGateMatchesDurableStage(receipt.qualityGate, state.stages);
 * ```
 */
export function qualityGateMatchesDurableStage(qualityGate: unknown, stages: unknown): boolean {
  const correlated = qualityStage(qualityGate, stages);
  if (correlated === undefined || !isRecord(correlated.stage)) {
    return false;
  }
  const { stage } = correlated;
  return [
    stage["status"] === "passed",
    stage["attempts"] === correlated.qualityGate["attempt"],
    stage["finishedAt"] === correlated.qualityGate["finishedAt"],
    historyMatches(stage["history"], correlated.qualityGate),
  ].every(Boolean);
}
