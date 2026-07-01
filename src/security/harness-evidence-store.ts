/* eslint-disable jsdoc/informative-docs, jsdoc/require-example, max-params -- store boundary mirrors public contract fields. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isPipelineStateStoryId } from "../state/fs-state-store.js";

import type { HarnessEvidenceCommandResult, HarnessEvidenceReport } from "./harness-evidence.js";

const jsonIndent = 2;

/** Relative directory for persisted harness-owned evidence. */
export const HARNESS_EVIDENCE_RELATIVE_DIR = ".pi/pipeline/evidence" as const;

/** Harness evidence artifact filename. */
export const HARNESS_EVIDENCE_FILE_NAME = "harness-evidence.json" as const;

/** Store error code. */
export type HarnessEvidenceStoreErrorCode =
  "read-failed" | "write-failed" | "json-parse-failed" | "invalid-evidence";

/** Store error details. */
export interface HarnessEvidenceStoreErrorDetails {
  /** Store error code. */
  readonly code: HarnessEvidenceStoreErrorCode;

  /** Artifact path involved in the failure. */
  readonly path: string;

  /** Optional story id. */
  readonly storyId?: string;

  /** Optional validation or IO reason. */
  readonly reason?: string;

  /** Optional underlying cause. */
  readonly cause?: unknown;
}

/** Request for saving harness-owned evidence. */
export interface SaveHarnessEvidenceRequest {
  /** Project root. */
  readonly projectRoot: string;

  /** Story id. */
  readonly storyId: string;

  /** Sanitized evidence report. */
  readonly report: HarnessEvidenceReport;
}

/** Request for loading harness-owned evidence. */
export interface LoadHarnessEvidenceRequest {
  /** Project root. */
  readonly projectRoot: string;

  /** Story id. */
  readonly storyId: string;
}

/** Error thrown for harness evidence persistence failures. */
export class HarnessEvidenceStoreError extends Error {
  /** Store error code. */
  public readonly code: HarnessEvidenceStoreErrorCode;

  /** Artifact path involved in the failure. */
  public readonly path: string;

  /** Optional story id. */
  public readonly storyId?: string;

  /** Optional validation or IO reason. */
  public readonly reason?: string;

  /**
   * Creates a harness evidence store error.
   *
   * @param details - Failure details.
   *
   * @example
   * ```ts
   * throw new HarnessEvidenceStoreError({ code: "read-failed", path });
   * ```
   */
  public constructor(details: HarnessEvidenceStoreErrorDetails) {
    super(buildErrorMessage(details), { cause: details.cause });
    this.name = "HarnessEvidenceStoreError";
    this.code = details.code;
    this.path = details.path;
    if (details.storyId !== undefined) {
      this.storyId = details.storyId;
    }
    if (details.reason !== undefined) {
      this.reason = details.reason;
    }
  }
}

/**
 * Resolves the harness evidence base directory.
 *
 * @param projectRoot - Project root.
 *
 * @returns Absolute evidence base directory.
 *
 * @example
 * ```ts
 * getHarnessEvidenceDir("/repo");
 * ```
 */
export function getHarnessEvidenceDir(projectRoot: string): string {
  assertProjectRoot(projectRoot);
  return resolve(projectRoot, ".pi", "pipeline", "evidence");
}

/**
 * Resolves one story evidence directory.
 *
 * @param projectRoot - Project root.
 * @param storyId - Safe story id.
 *
 * @returns Absolute story evidence directory.
 */
export function getHarnessEvidenceStoryDir(projectRoot: string, storyId: string): string {
  assertStoryId(storyId);
  const baseDir = getHarnessEvidenceDir(projectRoot);
  const storyDir = join(baseDir, storyId);
  assertInside(baseDir, storyDir, storyId);
  return storyDir;
}

/**
 * Resolves one story evidence artifact path.
 *
 * @param projectRoot - Project root.
 * @param storyId - Safe story id.
 *
 * @returns Absolute evidence artifact path.
 */
export function getHarnessEvidencePath(projectRoot: string, storyId: string): string {
  return join(getHarnessEvidenceStoryDir(projectRoot, storyId), HARNESS_EVIDENCE_FILE_NAME);
}

/**
 * Loads persisted harness-owned evidence.
 *
 * @param request - Load request.
 *
 * @returns Frozen report, or undefined when absent.
 */
export async function loadHarnessEvidence(
  request: LoadHarnessEvidenceRequest,
): Promise<HarnessEvidenceReport | undefined> {
  const path = getHarnessEvidencePath(request.projectRoot, request.storyId);
  const text = await readEvidenceFile(path, request.storyId);
  if (text === undefined) {
    return undefined;
  }
  return parseEvidenceFile(text, path, request.storyId);
}

/**
 * Saves sanitized harness-owned evidence.
 *
 * @param request - Save request.
 *
 * @returns Final artifact path.
 */
export async function saveHarnessEvidence(request: SaveHarnessEvidenceRequest): Promise<string> {
  const path = getHarnessEvidencePath(request.projectRoot, request.storyId);
  validateReportProjectRoot(request.report, request.projectRoot, path, request.storyId);
  try {
    await mkdir(getHarnessEvidenceStoryDir(request.projectRoot, request.storyId), {
      recursive: true,
    });
    await atomicWrite(path, `${JSON.stringify(request.report, null, jsonIndent)}\n`);
    return path;
  } catch (error) {
    throw storeError("write-failed", path, request.storyId, undefined, error);
  }
}

const readEvidenceFile = async (path: string, storyId: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw storeError("read-failed", path, storyId, undefined, error);
  }
};

const parseEvidenceFile = (text: string, path: string, storyId: string): HarnessEvidenceReport => {
  try {
    return freezeReport(assertReport(JSON.parse(text), path, storyId));
  } catch (error) {
    if (error instanceof HarnessEvidenceStoreError) {
      throw error;
    }
    throw storeError("json-parse-failed", path, storyId, undefined, error);
  }
};

const validateReportProjectRoot = (
  report: HarnessEvidenceReport,
  projectRoot: string,
  path: string,
  storyId: string,
): void => {
  if (report.projectRoot !== projectRoot) {
    throw storeError(
      "invalid-evidence",
      path,
      storyId,
      "Report projectRoot does not match request.",
    );
  }
};

const assertReport = (value: unknown, path: string, storyId: string): HarnessEvidenceReport => {
  if (!isReport(value)) {
    throw storeError("invalid-evidence", path, storyId, "Invalid harness evidence report.");
  }
  return value;
};

const reportStringFields = ["projectRoot", "startedAt", "finishedAt"] as const;

const isReport = (value: unknown): value is HarnessEvidenceReport =>
  isRecord(value) &&
  hasStringFields(value, reportStringFields) &&
  typeof value["passed"] === "boolean" &&
  Array.isArray(value["commands"]) &&
  value["commands"].every(isCommandResult);

const hasStringFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  fields.every((field) => typeof value[field] === "string");

const commandStringFields = ["name", "command", "status", "stdout", "stderr"] as const;

const isCommandResult = (value: unknown): value is HarnessEvidenceCommandResult =>
  isRecord(value) &&
  hasStringFields(value, commandStringFields) &&
  hasCommandNumbers(value) &&
  Array.isArray(value["args"]);

const hasCommandNumbers = (value: Record<string, unknown>): boolean =>
  (typeof value["exitCode"] === "number" || value["exitCode"] === null) &&
  isNonNegativeFinite(value["durationMs"]);

const freezeReport = (report: HarnessEvidenceReport): HarnessEvidenceReport =>
  Object.freeze({
    ...report,
    commands: Object.freeze(
      report.commands.map((command) =>
        Object.freeze({ ...command, args: Object.freeze([...command.args]) }),
      ),
    ),
  });

const atomicWrite = async (path: string, contents: string): Promise<void> => {
  const tempPath = `${path}.tmp-${String(process.pid)}`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, path);
};

const assertProjectRoot = (projectRoot: string): void => {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
};

const assertStoryId = (storyId: string): void => {
  if (!isPipelineStateStoryId(storyId)) {
    throw new RangeError(`Invalid harness evidence story id "${storyId}".`);
  }
};

const assertInside = (baseDir: string, candidate: string, storyId: string): void => {
  const relativePath = relative(baseDir, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new RangeError(`Invalid harness evidence story id "${storyId}".`);
  }
};

const storeError = (
  code: HarnessEvidenceStoreErrorCode,
  path: string,
  storyId?: string,
  reason?: string,
  cause?: unknown,
): HarnessEvidenceStoreError =>
  new HarnessEvidenceStoreError({
    code,
    path,
    ...(storyId === undefined ? {} : { storyId }),
    ...(reason === undefined ? {} : { reason }),
    ...(cause === undefined ? {} : { cause }),
  });

const buildErrorMessage = (details: HarnessEvidenceStoreErrorDetails): string =>
  `Harness evidence ${details.code} at ${details.path}${details.reason === undefined ? "" : `: ${details.reason}`}`;

const isErrno = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
