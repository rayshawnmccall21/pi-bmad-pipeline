/**
 * Resolves project-contained paths for per-stage extension directories.
 *
 * This module is the final Phase 2 RunDef subsystem module. It provides
 * deterministic, project-contained path resolution for per-stage extension
 * directories without checking the filesystem or importing executor/Pi runtime
 * code. Custom base directories must remain inside the project root to prevent
 * loading extension assets from outside the supervised project boundary.
 *
 * @packageDocumentation
 */

import { isAbsolute, join, relative, resolve } from "node:path";

import { RUNDEF_IDENTIFIER_PATTERN } from "./schema.js";

import type { CompiledStageDef } from "./types.js";

/** Relative project directory containing optional per-stage extension directories. */
export const RUNDEF_STAGE_EXTENSIONS_RELATIVE_DIR = ".pi/bmad/extensions" as const;

/** Minimal stage shape required by the extension path resolver. */
export type StageExtensionPathStage = Pick<CompiledStageDef, "id">;

/** Request for resolving the project stage extension base directory. */
export interface ResolveStageExtensionBaseDirRequest {
  /** Project root directory. */
  readonly projectRoot: string;

  /** Optional custom stage extension base directory, resolved relative to projectRoot when relative. */
  readonly stageExtensionsDir?: string;
}

/** Request for resolving one stage extension path. */
export interface ResolveStageExtensionPathRequest extends ResolveStageExtensionBaseDirRequest {
  /** Stage whose extension directory should be resolved. */
  readonly stage: StageExtensionPathStage;
}

/** Request for resolving multiple stage extension paths. */
export interface ResolveStageExtensionPathsRequest extends ResolveStageExtensionBaseDirRequest {
  /** Stages whose extension directories should be resolved. */
  readonly stages: readonly StageExtensionPathStage[];
}

/** Resolved project-local extension path for one stage. */
export interface ResolvedStageExtensionPath {
  /** Stage id. */
  readonly stageId: string;

  /** Absolute normalized project root. */
  readonly projectRoot: string;

  /** Absolute normalized stage extension base directory. */
  readonly baseDir: string;

  /** Absolute normalized extension directory for the stage. */
  readonly path: string;
}

/** Compiled identifier regex used to validate stage ids. */
const runDefIdentifierPattern = new RegExp(RUNDEF_IDENTIFIER_PATTERN, "u");

/**
 * Rejects blank project root strings.
 *
 * @param projectRoot - Project root to validate.
 *
 * @throws When `projectRoot` is blank.
 *
 * @example
 * ```ts
 * assertProjectRoot("/tmp/project");
 * ```
 */
function assertProjectRoot(projectRoot: string): void {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
}

/**
 * Checks whether a candidate path is inside a project root.
 *
 * @param projectRoot - Absolute normalized project root.
 * @param candidatePath - Absolute normalized candidate path.
 *
 * @returns True when the candidate is inside the project root.
 *
 * @example
 * ```ts
 * const inside = isInsideProjectRoot(root, candidate);
 * ```
 */
function isInsideProjectRoot(projectRoot: string, candidatePath: string): boolean {
  const relativePath = relative(projectRoot, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Validates a stage id against the RunDef identifier pattern.
 *
 * @param stageId - Stage id to validate.
 *
 * @throws When the stage id is invalid.
 *
 * @example
 * ```ts
 * assertValidStageId("dev-story");
 * ```
 */
function assertValidStageId(stageId: string): void {
  if (!runDefIdentifierPattern.test(stageId)) {
    throw new RangeError(`Invalid stage id "${stageId}".`);
  }
}

/**
 * Resolves the default project stage extension base directory.
 *
 * @param projectRoot - Project root directory.
 *
 * @returns Absolute `.pi/bmad/extensions` directory path.
 *
 * @throws When `projectRoot` is blank.
 *
 * @example
 * ```ts
 * const directory = getStageExtensionsDir(process.cwd());
 * ```
 */
export function getStageExtensionsDir(projectRoot: string): string {
  assertProjectRoot(projectRoot);
  return resolve(projectRoot, ".pi", "bmad", "extensions");
}

/**
 * Resolves a project-contained stage extension base directory.
 *
 * @param request - Base directory resolution request.
 *
 * @returns Absolute stage extension base directory.
 *
 * @throws When `projectRoot` or `stageExtensionsDir` is blank, or when the resolved base directory escapes the project root.
 *
 * @example
 * ```ts
 * const baseDir = resolveStageExtensionBaseDir({ projectRoot: process.cwd() });
 * ```
 */
export function resolveStageExtensionBaseDir(request: ResolveStageExtensionBaseDirRequest): string {
  assertProjectRoot(request.projectRoot);
  const projectRoot = resolve(request.projectRoot);

  if (request.stageExtensionsDir === undefined) {
    return join(projectRoot, ".pi", "bmad", "extensions");
  }

  const customDir = request.stageExtensionsDir;
  if (customDir.trim().length === 0) {
    throw new RangeError("Stage extensions directory must not be blank.");
  }

  const candidate = isAbsolute(customDir) ? resolve(customDir) : resolve(projectRoot, customDir);

  if (!isInsideProjectRoot(projectRoot, candidate)) {
    throw new RangeError(
      `Stage extensions directory "${candidate}" must be inside project root "${projectRoot}".`,
    );
  }

  return candidate;
}

/**
 * Resolves one project-contained stage extension directory path.
 *
 * @param request - Stage extension path resolution request.
 *
 * @returns Frozen resolved stage extension path metadata.
 *
 * @throws When the project root, base directory, or stage id is invalid.
 *
 * @example
 * ```ts
 * const extension = resolveStageExtensionPath({
 *   projectRoot: process.cwd(),
 *   stage: { id: "dev-story" }
 * });
 * ```
 */
export function resolveStageExtensionPath(
  request: ResolveStageExtensionPathRequest,
): ResolvedStageExtensionPath {
  const projectRoot = resolve(request.projectRoot);
  const baseDir = resolveStageExtensionBaseDir(request);
  assertValidStageId(request.stage.id);

  return Object.freeze({
    stageId: request.stage.id,
    projectRoot,
    baseDir,
    path: join(baseDir, request.stage.id),
  });
}

/**
 * Resolves project-contained stage extension directory paths in stage order.
 *
 * @param request - Multi-stage extension path resolution request.
 *
 * @returns Frozen resolved stage extension path metadata in input order.
 *
 * @throws When the project root, base directory, or any stage id is invalid.
 *
 * @example
 * ```ts
 * const extensions = resolveStageExtensionPaths({
 *   projectRoot: process.cwd(),
 *   stages,
 * });
 * ```
 */
export function resolveStageExtensionPaths(
  request: ResolveStageExtensionPathsRequest,
): readonly ResolvedStageExtensionPath[] {
  const projectRoot = resolve(request.projectRoot);
  const baseDir = resolveStageExtensionBaseDir(request);

  const resolved = request.stages.map((stage) => {
    assertValidStageId(stage.id);
    return Object.freeze({
      stageId: stage.id,
      projectRoot,
      baseDir,
      path: join(baseDir, stage.id),
    }) satisfies ResolvedStageExtensionPath;
  });

  return Object.freeze(resolved);
}
