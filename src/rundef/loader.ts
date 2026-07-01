/**
 * Project RunDef YAML loader.
 *
 * Scans a project's `.pi/bmad/pipelines/*.yaml` directory, parses each file,
 * validates it through the schema boundary, and returns a deterministic catalog
 * of discovered RunDefs. Built-in RunDefs are not loaded here; the selector
 * module handles built-in-vs-discovered resolution.
 *
 * @packageDocumentation
 */

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { parseRunDef } from "./schema.js";
import type { RunDef } from "./types.js";

/** Relative project path where custom RunDef YAML files are discovered. */
export const RUNDEF_PIPELINES_RELATIVE_DIR = ".pi/bmad/pipelines" as const;

/** File extension discovered by the RunDef loader. */
export const RUNDEF_PIPELINE_EXTENSION = ".yaml" as const;

/** A RunDef loaded from a project YAML file. */
export interface DiscoveredRunDef {
  /** RunDef identifier from the validated YAML document. */
  readonly id: string;

  /** Absolute path to the YAML file that defined the RunDef. */
  readonly path: string;

  /** Validated RunDef value. */
  readonly runDef: RunDef;
}

/** Stable machine-readable error code emitted by RunDef loading failures. */
export type RunDefLoadErrorCode =
  "read-failed" | "yaml-parse-failed" | "invalid-rundef" | "duplicate-rundef-id";

/** Details used to construct a RunDef loading error. */
export interface RunDefLoadErrorDetails {
  /** Stable machine-readable error code. */
  readonly code: RunDefLoadErrorCode;

  /** Absolute file or directory path related to the failure. */
  readonly path: string;

  /** Optional RunDef identifier related to the failure. */
  readonly runDefId?: string;

  /** Optional first path when reporting a duplicate RunDef identifier. */
  readonly duplicatePath?: string;

  /** Optional original cause. */
  readonly cause?: unknown;
}

/** Error thrown when RunDef discovery or loading fails. */
export class RunDefLoadError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: RunDefLoadErrorCode;

  /** Absolute file or directory path related to the failure. */
  public readonly path: string;

  /** Optional RunDef identifier related to the failure. */
  public readonly runDefId?: string;

  /** Optional first path when reporting a duplicate RunDef identifier. */
  public readonly duplicatePath?: string;

  /**
   * Creates a RunDef loading error.
   *
   * @param details - Error details for the failed load operation.
   *
   * @example
   * ```ts
   * throw new RunDefLoadError({ code: "yaml-parse-failed", path: "/x.yaml", cause: err });
   * ```
   */
  public constructor(details: RunDefLoadErrorDetails) {
    super(buildLoadErrorMessage(details));

    this.name = "RunDefLoadError";
    this.code = details.code;
    this.path = details.path;

    if (details.runDefId !== undefined) {
      this.runDefId = details.runDefId;
    }
    if (details.duplicatePath !== undefined) {
      this.duplicatePath = details.duplicatePath;
    }
  }
}

/**
 * Builds a deterministic error message for a RunDef load failure.
 *
 * @param details - Error details for the failed load operation.
 *
 * @returns A human-readable error message.
 *
 * @example
 * ```ts
 * const message = buildLoadErrorMessage({ code: "read-failed", path: "/x" });
 * ```
 */
function buildLoadErrorMessage(details: RunDefLoadErrorDetails): string {
  switch (details.code) {
    case "read-failed": {
      return `Failed to read RunDef path "${details.path}".`;
    }
    case "yaml-parse-failed": {
      const causeMsg = extractCauseMessage(details.cause);
      return `Failed to parse RunDef YAML file "${details.path}": ${causeMsg}.`;
    }
    case "invalid-rundef": {
      const causeMsg = extractCauseMessage(details.cause);
      return `Invalid RunDef file "${details.path}": ${causeMsg}`;
    }
    case "duplicate-rundef-id": {
      return `Duplicate discovered RunDef id "${details.runDefId ?? "unknown"}" in "${details.duplicatePath ?? "unknown"}" and "${details.path}".`;
    }
  }
}

/**
 * Extracts a message from an unknown cause value.
 *
 * @param cause - Original error or unknown value.
 *
 * @returns The error message, or a fallback string.
 *
 * @example
 * ```ts
 * const msg = extractCauseMessage(new Error("boom"));
 * ```
 */
function extractCauseMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown error";
}

/**
 * Resolves the project directory that contains discovered RunDef YAML files.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Absolute pipelines directory path.
 *
 * @throws RangeError When `projectRoot` is blank.
 *
 * @example
 * ```ts
 * const directory = getRunDefPipelinesDir(process.cwd());
 * ```
 */
export function getRunDefPipelinesDir(projectRoot: string): string {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("projectRoot must not be blank.");
  }
  return resolve(projectRoot, ".pi", "bmad", "pipelines");
}

/**
 * Checks whether a directory entry name is a discoverable RunDef YAML file.
 *
 * @param fileName - Directory entry name.
 *
 * @returns True when the name matches the discovered RunDef YAML pattern.
 *
 * @example
 * ```ts
 * if (isRunDefYamlFileName("sdlc.yaml")) {
 *   console.log("discoverable");
 * }
 * ```
 */
export function isRunDefYamlFileName(fileName: string): boolean {
  return fileName.endsWith(RUNDEF_PIPELINE_EXTENSION) && !fileName.startsWith(".");
}

/**
 * Loads and validates one RunDef YAML file.
 *
 * @param filePath - YAML file path.
 *
 * @returns Discovered RunDef metadata.
 *
 * @throws RangeError When `filePath` is blank.
 * @throws RunDefLoadError When reading, YAML parsing, or RunDef validation fails.
 *
 * @example
 * ```ts
 * const discovered = await loadRunDefFile(".pi/bmad/pipelines/custom.yaml");
 * ```
 */
export async function loadRunDefFile(filePath: string): Promise<DiscoveredRunDef> {
  if (filePath.trim().length === 0) {
    throw new RangeError("filePath must not be blank.");
  }

  const absolutePath = resolve(filePath);

  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (cause) {
    throw new RunDefLoadError({ code: "read-failed", path: absolutePath, cause });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (cause) {
    throw new RunDefLoadError({ code: "yaml-parse-failed", path: absolutePath, cause });
  }

  let runDef: RunDef;
  try {
    runDef = parseRunDef(parsed);
  } catch (cause) {
    throw new RunDefLoadError({ code: "invalid-rundef", path: absolutePath, cause });
  }

  return { id: runDef.id, path: absolutePath, runDef };
}

/**
 * Reads directory entries from the pipelines directory, or returns empty when missing.
 *
 * @param pipelinesDir - Absolute pipelines directory path.
 *
 * @returns Directory entries, or an empty array when the directory does not exist.
 *
 * @throws RunDefLoadError When the directory exists but cannot be read.
 *
 * @example
 * ```ts
 * const entries = await readPipelineEntries(dir);
 * ```
 */
async function readPipelineEntries(pipelinesDir: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(pipelinesDir, { withFileTypes: true });
  } catch (cause) {
    if (isEnoentError(cause)) {
      return [];
    }
    throw new RunDefLoadError({ code: "read-failed", path: pipelinesDir, cause });
  }
}

/**
 * Extracts discoverable YAML file paths from directory entries, sorted lexicographically.
 *
 * @param pipelinesDir - Absolute pipelines directory path.
 * @param entries - Directory entries from readdir.
 *
 * @returns Sorted absolute file paths for discoverable YAML files.
 *
 * @example
 * ```ts
 * const paths = collectYamlFilePaths(dir, entries);
 * ```
 */
function collectYamlFilePaths(pipelinesDir: string, entries: readonly Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isFile() && isRunDefYamlFileName(entry.name))
    .map((entry) => resolve(pipelinesDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Loads RunDef files and fails on duplicate ids.
 *
 * @param filePaths - Sorted absolute file paths to load.
 *
 * @returns Discovered RunDefs in the same order as the input paths.
 *
 * @throws RunDefLoadError When any file fails to load or a duplicate id is found.
 *
 * @example
 * ```ts
 * const discovered = await loadRunDefFiles(paths);
 * ```
 */
async function loadRunDefFiles(filePaths: readonly string[]): Promise<DiscoveredRunDef[]> {
  const discovered: DiscoveredRunDef[] = [];
  const seenIds = new Map<string, string>();

  for (const absolutePath of filePaths) {
    const result = await loadRunDefFile(absolutePath);
    const existingPath = seenIds.get(result.id);
    if (existingPath !== undefined) {
      throw new RunDefLoadError({
        code: "duplicate-rundef-id",
        path: result.path,
        runDefId: result.id,
        duplicatePath: existingPath,
      });
    }
    seenIds.set(result.id, result.path);
    discovered.push(result);
  }

  return discovered;
}

/**
 * Determines whether a readdir error is a missing-directory (ENOENT) condition.
 *
 * @param cause - Error caught from readdir.
 *
 * @returns True when the error indicates the directory does not exist.
 *
 * @example
 * ```ts
 * const missing = isEnoentError(caughtError);
 * ```
 */
function isEnoentError(cause: unknown): boolean {
  if (cause instanceof Error) {
    return cause.message.includes("ENOENT");
  }
  return false;
}

/**
 * Discovers all project RunDefs under `.pi/bmad/pipelines/*.yaml`.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Discovered RunDefs sorted by absolute file path.
 *
 * @throws RangeError When `projectRoot` is blank.
 * @throws RunDefLoadError When the directory cannot be read, a YAML file is invalid, or duplicate ids are found.
 *
 * @example
 * ```ts
 * const runDefs = await discoverRunDefs(process.cwd());
 * ```
 */
export async function discoverRunDefs(projectRoot: string): Promise<readonly DiscoveredRunDef[]> {
  const pipelinesDir = getRunDefPipelinesDir(projectRoot);
  const entries = await readPipelineEntries(pipelinesDir);
  const filePaths = collectYamlFilePaths(pipelinesDir, entries);
  return loadRunDefFiles(filePaths);
}

/**
 * Resolves one discovered project RunDef by id.
 *
 * @param projectRoot - Project root directory.
 * @param id - RunDef identifier to resolve.
 *
 * @returns The discovered RunDef, or undefined when not found.
 *
 * @throws RangeError When `projectRoot` is blank.
 * @throws RunDefLoadError When discovery fails.
 *
 * @example
 * ```ts
 * const runDef = await resolveDiscoveredRunDef(process.cwd(), "custom");
 * ```
 */
export async function resolveDiscoveredRunDef(
  projectRoot: string,
  id: string,
): Promise<DiscoveredRunDef | undefined> {
  const all = await discoverRunDefs(projectRoot);
  return all.find((entry) => entry.id === id);
}
