import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  freezePipelineState,
  getPipelineStateInvalidReason,
  isPipelineState,
} from "./fs-state-validation.js";

import type { PipelineState } from "./pipeline-state.js";

/** Relative project directory where durable pipeline state files are stored. */
export const PIPELINE_STATE_RELATIVE_DIR = ".pi/pipeline/state" as const;

/** Durable pipeline state file extension. */
export const PIPELINE_STATE_FILE_EXTENSION = ".json" as const;

/** Filename-safe story id pattern for durable state files. */
export const PIPELINE_STATE_STORY_ID_PATTERN =
  "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$" as const;

const storyIdPattern = new RegExp(PIPELINE_STATE_STORY_ID_PATTERN, "u");
const prettyJsonSpaces = 2;

/** Error code emitted by filesystem PipelineState persistence failures. */
export type PipelineStateStoreErrorCode =
  "read-failed" | "write-failed" | "json-parse-failed" | "invalid-state";

/** Details used to construct a PipelineState store error. */
export interface PipelineStateStoreErrorDetails {
  /** Stable machine-readable error code. */
  readonly code: PipelineStateStoreErrorCode;

  /** Absolute state file or directory path related to the failure. */
  readonly path: string;

  /** Optional story id related to the failure. */
  readonly storyId?: string;

  /** Optional human-readable invalid-state reason. */
  readonly reason?: string;

  /** Optional original cause. */
  readonly cause?: unknown;
}

/** Request for loading a pipeline state file. */
export interface LoadPipelineStateRequest {
  /** Project root directory. */
  readonly projectRoot: string;

  /** Story id whose state should be loaded. */
  readonly storyId: string;
}

/** Request for saving a pipeline state file. */
export interface SavePipelineStateRequest {
  /** Project root directory. */
  readonly projectRoot: string;

  /** Durable pipeline state to save. */
  readonly state: PipelineState;
}

/** Filesystem-backed PipelineState store contract. */
export interface PipelineStateStore {
  /**
   * Loads durable pipeline state.
   *
   * @param request - Request containing the project root and story id.
   *
   * @returns Frozen state, or undefined when no state file exists.
   *
   * @throws RangeError When project root or story id is invalid.
   * @throws PipelineStateStoreError When reading, parsing, or validation fails.
   */
  load(request: LoadPipelineStateRequest): Promise<PipelineState | undefined>;

  /**
   * Saves durable pipeline state.
   *
   * @param request - Request containing the project root and state snapshot.
   *
   * @returns Absolute state file path written.
   *
   * @throws RangeError When project root or story id is invalid.
   * @throws PipelineStateStoreError When writing fails.
   */
  save(request: SavePipelineStateRequest): Promise<string>;
}

/** Error thrown when filesystem PipelineState persistence fails. */
export class PipelineStateStoreError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: PipelineStateStoreErrorCode;

  /** Absolute state file or directory path related to the failure. */
  public readonly path: string;

  /** Optional story id related to the failure. */
  public readonly storyId?: string;

  /** Optional human-readable invalid-state reason. */
  public readonly reason?: string;

  /**
   * Creates a PipelineState store error.
   *
   * @param details - Store failure details.
   *
   * @example
   * ```ts
   * throw new PipelineStateStoreError({ code: "read-failed", path: "/tmp/state.json" });
   * ```
   */
  public constructor(details: PipelineStateStoreErrorDetails) {
    super(buildStoreErrorMessage(details));
    this.name = "PipelineStateStoreError";
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

const buildStoreErrorMessage = (details: PipelineStateStoreErrorDetails): string => {
  switch (details.code) {
    case "read-failed": {
      return `Failed to read pipeline state file "${details.path}".`;
    }
    case "write-failed": {
      return `Failed to write pipeline state file "${details.path}".`;
    }
    case "json-parse-failed": {
      const message = details.cause instanceof Error ? details.cause.message : "Unknown error";
      return `Failed to parse pipeline state JSON file "${details.path}": ${message}.`;
    }
    case "invalid-state": {
      return `Invalid pipeline state file "${details.path}": ${details.reason ?? "unknown"}`;
    }
  }
};

const isPathInside = (parent: string, candidate: string): boolean => {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

/**
 * Resolves the project directory that contains durable pipeline state files.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Absolute project-local pipeline state directory path.
 *
 * @throws RangeError When projectRoot is blank.
 *
 * @example
 * ```ts
 * const directory = getPipelineStateDir(process.cwd());
 * ```
 */
export function getPipelineStateDir(projectRoot: string): string {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
  return resolve(projectRoot, ".pi", "pipeline", "state");
}

/**
 * Checks whether a story id is safe for direct use as a durable state filename.
 *
 * @param storyId - Candidate story id.
 *
 * @returns True when the story id can be stored as a JSON state file.
 *
 * @example
 * ```ts
 * isPipelineStateStoryId("STORY-123");
 * ```
 */
export function isPipelineStateStoryId(storyId: string): boolean {
  return storyIdPattern.test(storyId);
}

/**
 * Resolves the durable state file path for a story.
 *
 * @param projectRoot - Project root directory.
 * @param storyId - Story id whose state file should be resolved.
 *
 * @returns Absolute project-local JSON state file path.
 *
 * @throws RangeError When projectRoot or storyId is invalid.
 *
 * @example
 * ```ts
 * const statePath = getPipelineStatePath(process.cwd(), "STORY-123");
 * ```
 */
export function getPipelineStatePath(projectRoot: string, storyId: string): string {
  const stateDir = getPipelineStateDir(projectRoot);
  if (!isPipelineStateStoryId(storyId)) {
    throw new RangeError(`Invalid pipeline state story id "${storyId}".`);
  }
  const statePath = join(stateDir, `${storyId}${PIPELINE_STATE_FILE_EXTENSION}`);
  if (!isPathInside(stateDir, statePath)) {
    throw new RangeError(`Invalid pipeline state story id "${storyId}".`);
  }
  return statePath;
}

/**
 * Loads durable pipeline state from a project-local JSON state file.
 *
 * @param projectRoot - Project root directory.
 * @param storyId - Story id whose state should be loaded.
 *
 * @returns Frozen state, or undefined when no state file exists.
 *
 * @throws RangeError When projectRoot or storyId is invalid.
 * @throws PipelineStateStoreError When reading, parsing, or validation fails.
 *
 * @example
 * ```ts
 * const state = await loadPipelineState(process.cwd(), "STORY-123");
 * ```
 */
export async function loadPipelineState(
  projectRoot: string,
  storyId: string,
): Promise<PipelineState | undefined> {
  const statePath = getPipelineStatePath(projectRoot, storyId);
  const raw = await readStateFile(statePath, storyId);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseStateFile(raw, statePath, storyId);
  validateLoadedState(parsed, statePath, storyId);
  if (!isPipelineState(parsed)) {
    throw invalidState(statePath, storyId, "State root is not an object.");
  }
  if (parsed.storyId !== storyId) {
    throw invalidState(
      statePath,
      storyId,
      `State storyId "${parsed.storyId}" does not match requested storyId "${storyId}".`,
    );
  }
  return freezePipelineState(parsed);
}

const readStateFile = async (statePath: string, storyId: string): Promise<string | undefined> => {
  try {
    return await readFile(statePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw new PipelineStateStoreError({ code: "read-failed", path: statePath, storyId });
  }
};

const parseStateFile = (raw: string, statePath: string, storyId: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PipelineStateStoreError({
      code: "json-parse-failed",
      path: statePath,
      storyId,
      cause: error,
    });
  }
};

const validateLoadedState = (parsed: unknown, statePath: string, storyId: string): void => {
  const reason = getPipelineStateInvalidReason(parsed);
  if (reason !== undefined) {
    throw invalidState(statePath, storyId, reason);
  }
};

const invalidState = (
  statePath: string,
  storyId: string,
  reason: string,
): PipelineStateStoreError =>
  new PipelineStateStoreError({ code: "invalid-state", path: statePath, storyId, reason });

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/**
 * Saves durable pipeline state to a project-local JSON state file.
 *
 * @param projectRoot - Project root directory.
 * @param state - Pipeline state to save.
 *
 * @returns Absolute state file path written.
 *
 * @throws RangeError When projectRoot or story id is invalid.
 * @throws PipelineStateStoreError When validation or writing fails.
 *
 * @example
 * ```ts
 * await savePipelineState(process.cwd(), state);
 * ```
 */
export async function savePipelineState(
  projectRoot: string,
  state: PipelineState,
): Promise<string> {
  const statePath = getPipelineStatePath(projectRoot, state.storyId);
  const reason = getPipelineStateInvalidReason(state);
  if (reason !== undefined) {
    throw invalidState(statePath, state.storyId, reason);
  }
  const content = `${JSON.stringify(state, null, prettyJsonSpaces)}\n`;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    return await atomicWrite(statePath, content, state.storyId);
  } catch (error) {
    if (error instanceof PipelineStateStoreError) {
      throw error;
    }
    throw new PipelineStateStoreError({
      code: "write-failed",
      path: statePath,
      storyId: state.storyId,
    });
  }
}

const atomicWrite = async (
  statePath: string,
  content: string,
  storyId: string,
): Promise<string> => {
  const tempPath = `${statePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, statePath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new PipelineStateStoreError({ code: "write-failed", path: statePath, storyId });
  }
  return statePath;
};

/** Default filesystem-backed PipelineState store. */
export const fsPipelineStateStore: PipelineStateStore = Object.freeze({
  load(request) {
    return loadPipelineState(request.projectRoot, request.storyId);
  },
  save(request) {
    return savePipelineState(request.projectRoot, request.state);
  },
} satisfies PipelineStateStore);
