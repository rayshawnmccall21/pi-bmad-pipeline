/**
 * Durable current-run pointer store for the merge-review boundary.
 *
 * The project checkpoint module `.pi/workflows/checkpoints/merge-gate.mjs`
 * enters the pipeline's durable contracts through a static pointer at
 * `.pi/pipeline/state/current-run.json` carrying `{ storyId, agentClaim? }`.
 * This module is the producer side of that contract: the pipeline refreshes
 * the pointer whenever a story reaches merge review (see openStoryPullRequest),
 * so the gate can resolve the story's durable state and harness evidence.
 *
 * @packageDocumentation
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentEvidenceClaim } from "../git/merge-gate.js";

import { getPipelineStateDir, isPipelineStateStoryId } from "./fs-state-store.js";

/** Current-run pointer filename inside the pipeline state directory. */
export const CURRENT_RUN_POINTER_FILE_NAME = "current-run.json" as const;

/** Project-relative pointer path consumed by the merge-gate checkpoint module. */
export const CURRENT_RUN_POINTER_RELATIVE_PATH = ".pi/pipeline/state/current-run.json" as const;

const prettyJsonSpaces = 2;

/** Durable pointer to the run currently under merge review. */
export interface CurrentRunPointer {
  /** Story id under merge review. */
  readonly storyId: string;

  /** Optional agent-reported claim compared against harness evidence. */
  readonly agentClaim?: AgentEvidenceClaim;
}

/** Error code emitted by current-run pointer persistence failures. */
export type CurrentRunStoreErrorCode = "read-failed" | "json-parse-failed" | "invalid-pointer";

/** Error thrown when the current-run pointer cannot be loaded. */
export class CurrentRunStoreError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: CurrentRunStoreErrorCode;

  /** Absolute pointer path related to the failure. */
  public readonly path: string;

  /**
   * Creates a current-run store error.
   *
   * @param code - Stable machine-readable error code.
   * @param path - Absolute pointer path related to the failure.
   * @param reason - Human-readable failure reason.
   *
   * @example
   * ```ts
   * throw new CurrentRunStoreError("invalid-pointer", path, "storyId missing");
   * ```
   */
  public constructor(code: CurrentRunStoreErrorCode, path: string, reason: string) {
    super(`Current-run pointer ${code} at "${path}": ${reason}`);
    this.name = "CurrentRunStoreError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Resolves the absolute current-run pointer path for a project.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Absolute pointer file path.
 *
 * @throws RangeError When projectRoot is blank.
 *
 * @example
 * ```ts
 * const pointerPath = getCurrentRunPointerPath(process.cwd());
 * ```
 */
export function getCurrentRunPointerPath(projectRoot: string): string {
  return join(getPipelineStateDir(projectRoot), CURRENT_RUN_POINTER_FILE_NAME);
}

/**
 * Saves (refreshes) the current-run pointer atomically.
 *
 * @param projectRoot - Project root directory.
 * @param pointer - Pointer to the run under merge review.
 *
 * @returns Absolute pointer file path written.
 *
 * @throws RangeError When projectRoot is blank or the story id is unsafe.
 *
 * @example
 * ```ts
 * await saveCurrentRunPointer(process.cwd(), { storyId: "STORY-123" });
 * ```
 */
export async function saveCurrentRunPointer(
  projectRoot: string,
  pointer: CurrentRunPointer,
): Promise<string> {
  const pointerPath = getCurrentRunPointerPath(projectRoot);
  if (!isPipelineStateStoryId(pointer.storyId)) {
    throw new RangeError(`Invalid current-run story id "${pointer.storyId}".`);
  }
  await mkdir(dirname(pointerPath), { recursive: true });
  await atomicWrite(pointerPath, `${JSON.stringify(pointer, null, prettyJsonSpaces)}\n`);
  return pointerPath;
}

/**
 * Loads the current-run pointer when present.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Frozen pointer, or undefined when no pointer file exists.
 *
 * @throws RangeError When projectRoot is blank.
 * @throws CurrentRunStoreError When reading, parsing, or validation fails.
 *
 * @example
 * ```ts
 * const pointer = await loadCurrentRunPointer(process.cwd());
 * ```
 */
export async function loadCurrentRunPointer(
  projectRoot: string,
): Promise<CurrentRunPointer | undefined> {
  const pointerPath = getCurrentRunPointerPath(projectRoot);
  const raw = await readPointerFile(pointerPath);
  if (raw === undefined) {
    return undefined;
  }
  return freezePointer(validatePointer(parsePointer(raw, pointerPath), pointerPath));
}

const readPointerFile = async (pointerPath: string): Promise<string | undefined> => {
  try {
    return await readFile(pointerPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw new CurrentRunStoreError("read-failed", pointerPath, "pointer file is unreadable");
  }
};

const parsePointer = (raw: string, pointerPath: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new CurrentRunStoreError("json-parse-failed", pointerPath, reason);
  }
};

const validatePointer = (parsed: unknown, pointerPath: string): CurrentRunPointer => {
  if (!isRecord(parsed) || typeof parsed["storyId"] !== "string") {
    throw new CurrentRunStoreError("invalid-pointer", pointerPath, "storyId must be a string");
  }
  const storyId = parsed["storyId"];
  if (!isPipelineStateStoryId(storyId)) {
    throw new CurrentRunStoreError("invalid-pointer", pointerPath, "storyId is not filename-safe");
  }
  const agentClaim = "agentClaim" in parsed ? parsed["agentClaim"] : undefined;
  if (agentClaim === undefined) {
    return { storyId };
  }
  if (!isAgentClaim(agentClaim)) {
    throw new CurrentRunStoreError("invalid-pointer", pointerPath, "agentClaim is malformed");
  }
  return { storyId, agentClaim };
};

const claimFields = ["testsPassed", "typecheckPassed", "lintPassed"] as const;

const isAgentClaim = (value: unknown): value is AgentEvidenceClaim =>
  isRecord(value) &&
  claimFields.every((field) => !(field in value) || typeof value[field] === "boolean");

const freezePointer = (pointer: CurrentRunPointer): CurrentRunPointer =>
  Object.freeze({
    storyId: pointer.storyId,
    ...(pointer.agentClaim === undefined
      ? {}
      : { agentClaim: Object.freeze({ ...pointer.agentClaim }) }),
  });

const atomicWrite = async (pointerPath: string, contents: string): Promise<void> => {
  const tempPath = `${pointerPath}.tmp-${String(process.pid)}`;
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, pointerPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const isErrno = (error: unknown, code: string): boolean =>
  isRecord(error) && error["code"] === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
