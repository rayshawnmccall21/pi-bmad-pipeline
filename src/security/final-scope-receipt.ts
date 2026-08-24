import { createHash } from "node:crypto";

import type {
  FinalScopeReceipt,
  QualityGateReceipt,
  RepositoryScope,
  ReviewScopeCheckpoint,
} from "../state/pipeline-state.js";

/** Current schema version for review checkpoints and final scope receipts. */
export const FINAL_SCOPE_RECEIPT_VERSION = 1 as const;

/** Present or absent repository file supplied to scope construction. */
export type RepositoryFileSnapshot =
  | {
      /** Canonical repository-relative path. */
      readonly path: string;

      /** Raw file bytes. */
      readonly bytes: Uint8Array;

      /** Present snapshots cannot also be absent. */
      readonly absent?: never;
    }
  | {
      /** Canonical repository-relative path. */
      readonly path: string;

      /** Marks a repository file that is absent. */
      readonly absent: true;

      /** Absent snapshots cannot also contain bytes. */
      readonly bytes?: never;
    };

/** Input for constructing a review scope checkpoint. */
export interface CreateReviewScopeCheckpointInput {
  /** Story id bound to the review. */
  readonly storyId: string;

  /** Pipeline run id bound to the review. */
  readonly runId: string;

  /** Selected RunDef id. */
  readonly runDefId: string;

  /** Selected RunDef content digest. */
  readonly runDefDigest: string;

  /** Branch observed at review time. */
  readonly branch: string;

  /** Base object id observed at review time. */
  readonly baseOid: string;

  /** Source, test, and configuration files covered by review. */
  readonly reviewedFiles: readonly RepositoryFileSnapshot[];

  /** Passing quality-gate attempt authorizing the checkpoint. */
  readonly qualityGate: QualityGateReceipt;
}

/** Successful docs-only comparison against a reviewed checkpoint. */
export interface AttestedFinalScopeComparison {
  /** Successful comparison discriminator. */
  readonly kind: "attested";

  /** Allowlisted documentation files in the final scope. */
  readonly docs: RepositoryScope;

  /** Digest of every file in the final working-tree scope. */
  readonly finalWorkingTreeDigest: string;
}

/** Failed comparison identifying paths no longer covered by review. */
export interface ReviewInvalidatedFinalScopeComparison {
  /** Failed comparison discriminator. */
  readonly kind: "review-invalidated";

  /** Canonical paths whose reviewed scope no longer matches. */
  readonly changedPaths: readonly string[];
}

/** Result of comparing a final scope with a reviewed checkpoint. */
export type FinalScopeComparison =
  AttestedFinalScopeComparison | ReviewInvalidatedFinalScopeComparison;

/** Input for comparing final files with a reviewed checkpoint. */
export interface CompareFinalScopeToReviewInput {
  /** Previously attested review checkpoint. */
  readonly checkpoint: ReviewScopeCheckpoint;

  /** Complete final file scope to attest. */
  readonly finalFiles: readonly RepositoryFileSnapshot[];

  /** Exact repository-relative paths allowed to change after review. */
  readonly allowedDocsPaths: readonly string[];
}

/** Input for constructing a final scope receipt. */
export interface CreateFinalScopeReceiptInput {
  /** Review checkpoint to bind into the receipt. */
  readonly checkpoint: ReviewScopeCheckpoint;

  /** Final comparison that must have attested successfully. */
  readonly comparison: FinalScopeComparison;
}

/**
 * Creates a canonical immutable scope from repository file bytes.
 *
 * @param files - Repository-relative paths and their raw bytes.
 *
 * @returns Frozen sorted paths and their deterministic SHA-256 digest.
 *
 * @throws TypeError When a path is absolute, non-canonical, traversing, or duplicated.
 *
 * @example
 * ```ts
 * createCanonicalRepositoryScope([{ path: "src/app.ts", bytes: new Uint8Array() }]);
 * ```
 */
export function createCanonicalRepositoryScope(
  files: readonly RepositoryFileSnapshot[],
): RepositoryScope {
  return createScope(canonicalizeFiles(files));
}

/**
 * Creates an immutable checkpoint for a passing review scope.
 *
 * @param input - Review identity, reviewed bytes, and passing quality gate.
 *
 * @returns Frozen checkpoint bound to the canonical reviewed scope.
 *
 * @throws TypeError When a reviewed path is invalid or duplicated.
 *
 * @example
 * ```ts
 * createReviewScopeCheckpoint({
 *   storyId: "STY-144", runId: "run-1", runDefId: "sdlc", runDefDigest: "abc",
 *   branch: "feature", baseOid: "abc", reviewedFiles: [],
 *   qualityGate: { stageId: "code-review", attempt: 1, status: "passed", finishedAt: "now" },
 * });
 * ```
 */
export function createReviewScopeCheckpoint(
  input: CreateReviewScopeCheckpointInput,
): ReviewScopeCheckpoint {
  return Object.freeze({
    version: FINAL_SCOPE_RECEIPT_VERSION,
    storyId: input.storyId,
    runId: input.runId,
    runDefId: input.runDefId,
    runDefDigest: input.runDefDigest,
    branch: input.branch,
    baseOid: input.baseOid,
    reviewed: createCanonicalRepositoryScope(input.reviewedFiles),
    qualityGate: cloneQualityGate(input.qualityGate),
  });
}

/**
 * Compares a final file scope with its reviewed source scope.
 *
 * @param input - Checkpoint, complete final files, and exact documentation allowlist.
 *
 * @returns A frozen attestation for docs-only changes, otherwise an invalidation.
 *
 * @throws TypeError When a supplied repository path is invalid or duplicated.
 *
 * @example
 * ```ts
 * compareFinalScopeToReview({ checkpoint, finalFiles: [], allowedDocsPaths: ["README.md"] });
 * ```
 */
export function compareFinalScopeToReview(
  input: CompareFinalScopeToReviewInput,
): FinalScopeComparison {
  const finalFiles = canonicalizeFiles(input.finalFiles);
  const allowedDocsPaths = new Set(canonicalizePaths(input.allowedDocsPaths));
  const docsFiles = finalFiles.filter(({ path }) => allowedDocsPaths.has(path));
  const reviewedFiles = finalFiles.filter(({ path }) => !allowedDocsPaths.has(path));
  const finalReviewed = createScope(reviewedFiles);

  if (!scopesMatch(finalReviewed, input.checkpoint.reviewed)) {
    return Object.freeze({
      kind: "review-invalidated",
      changedPaths: Object.freeze(changedScopePaths(finalReviewed, input.checkpoint.reviewed)),
    });
  }

  return Object.freeze({
    kind: "attested",
    docs: createScope(docsFiles),
    finalWorkingTreeDigest: createScope(finalFiles).digest,
  });
}

/**
 * Creates an immutable final receipt from an attested comparison.
 *
 * @param input - Reviewed checkpoint and its final scope comparison.
 *
 * @returns Frozen final scope receipt bound to the checkpoint.
 *
 * @throws RangeError When the comparison invalidated the review.
 *
 * @example
 * ```ts
 * createFinalScopeReceipt({ checkpoint, comparison });
 * ```
 */
export function createFinalScopeReceipt(input: CreateFinalScopeReceiptInput): FinalScopeReceipt {
  if (input.comparison.kind !== "attested") {
    throw new RangeError("Cannot create a final scope receipt after review was invalidated.");
  }

  return Object.freeze({
    version: FINAL_SCOPE_RECEIPT_VERSION,
    storyId: input.checkpoint.storyId,
    runId: input.checkpoint.runId,
    runDefId: input.checkpoint.runDefId,
    runDefDigest: input.checkpoint.runDefDigest,
    branch: input.checkpoint.branch,
    baseOid: input.checkpoint.baseOid,
    reviewed: cloneScope(input.checkpoint.reviewed),
    docs: cloneScope(input.comparison.docs),
    qualityGate: cloneQualityGate(input.checkpoint.qualityGate),
    finalWorkingTreeDigest: input.comparison.finalWorkingTreeDigest,
  });
}

const canonicalizeFiles = (
  files: readonly RepositoryFileSnapshot[],
): readonly RepositoryFileSnapshot[] => {
  const seen = new Set<string>();
  const canonical = files.map((file) => {
    validateRepositoryPath(file.path);
    const hasBytes = Reflect.has(file, "bytes");
    const hasAbsent = Reflect.has(file, "absent");
    if (hasBytes === hasAbsent || (hasAbsent && Reflect.get(file, "absent") !== true)) {
      throw new TypeError("Repository snapshot must be either present or absent.");
    }
    if (seen.has(file.path)) {
      throw new TypeError(`duplicate repository path: "${file.path}".`);
    }
    seen.add(file.path);
    return file;
  });
  return canonical.sort(compareFilePaths);
};

const canonicalizePaths = (paths: readonly string[]): readonly string[] =>
  canonicalizeFiles(paths.map((path) => ({ path, bytes: new Uint8Array() }))).map(
    ({ path }) => path,
  );

const invalidRepositoryPath =
  /(?:[\u0000-\u001f\u007f]|^$|^\/|^[A-Za-z]:|\\|\/\/|\/$|(?:^|\/)\.{1,2}(?:\/|$))/u;

const validateRepositoryPath = (path: string): void => {
  if (invalidRepositoryPath.test(path)) {
    throw new TypeError(
      `Repository path "${path}" must be canonical and repository-relative; absolute paths and traversal are not allowed.`,
    );
  }
};

const compareFilePaths = (left: RepositoryFileSnapshot, right: RepositoryFileSnapshot): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

const createScope = (files: readonly RepositoryFileSnapshot[]): RepositoryScope => {
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(String(pathBytes.byteLength)).update(":").update(pathBytes);
    if (file.absent === true) {
      hash.update("absent:");
    } else {
      hash.update(String(file.bytes.byteLength)).update(":").update(file.bytes);
    }
  }
  return Object.freeze({
    paths: Object.freeze(files.map(({ path }) => path)),
    digest: hash.digest("hex"),
  });
};

const scopesMatch = (left: RepositoryScope, right: RepositoryScope): boolean =>
  left.digest === right.digest &&
  left.paths.length === right.paths.length &&
  left.paths.every((path, index) => path === right.paths[index]);

const changedScopePaths = (finalScope: RepositoryScope, reviewed: RepositoryScope): string[] => {
  const finalPaths = new Set(finalScope.paths);
  const reviewedPaths = new Set(reviewed.paths);
  const different = [...finalScope.paths, ...reviewed.paths].filter(
    (path) => !finalPaths.has(path) || !reviewedPaths.has(path),
  );
  return different.length === 0 ? [...reviewed.paths] : [...new Set(different)].sort();
};

const cloneScope = (scope: RepositoryScope): RepositoryScope =>
  Object.freeze({ paths: Object.freeze([...scope.paths]), digest: scope.digest });

const cloneQualityGate = (qualityGate: QualityGateReceipt): QualityGateReceipt =>
  Object.freeze({
    stageId: qualityGate.stageId,
    attempt: qualityGate.attempt,
    status: qualityGate.status,
    finishedAt: qualityGate.finishedAt,
  });
