/**
 * RunDef selector — resolves which RunDef to use from built-ins or discovered YAML.
 *
 * This module ties together {@link resolveBuiltinRunDef}, {@link discoverRunDefs},
 * and {@link compileValidatedRunDef} into a single coordination layer. It answers
 * the question of which definition to execute and what compiled stages to run
 * for a given RunDef id.
 *
 * Selection policy is fail-closed. A discovered RunDef with the same id as a
 * built-in produces a conflict error rather than silent shadowing.
 *
 * @packageDocumentation
 */

import { compileValidatedRunDef, type CompileRunDefOptions } from "./compile.js";
import { resolveBuiltinRunDef } from "./builtin.js";
import { discoverRunDefs, type DiscoveredRunDef } from "./loader.js";
import { RUNDEF_IDENTIFIER_PATTERN } from "./schema.js";

import type { CompiledStageDef, RunDef } from "./types.js";

/** Pre-compiled regex for validating RunDef identifiers. */
const identifierPattern = new RegExp(RUNDEF_IDENTIFIER_PATTERN, "u");

/** Identifies where a selected RunDef originated. */
export type RunDefSelectionSource = "builtin" | "discovered";

/** Selected built-in RunDef metadata. */
export interface BuiltinRunDefSelection {
  /** Selected RunDef id. */
  readonly id: string;

  /** Indicates the RunDef came from the built-in catalog. */
  readonly source: "builtin";

  /** Selected raw RunDef. */
  readonly runDef: RunDef;
}

/** Selected discovered RunDef metadata. */
export interface DiscoveredRunDefSelection {
  /** Selected RunDef id. */
  readonly id: string;

  /** Indicates the RunDef came from a project YAML file. */
  readonly source: "discovered";

  /** Absolute YAML file path that defined the RunDef. */
  readonly path: string;

  /** Selected raw RunDef. */
  readonly runDef: RunDef;
}

/** Selected raw RunDef metadata. */
export type RunDefSelection = BuiltinRunDefSelection | DiscoveredRunDefSelection;

/** Selected and compiled built-in RunDef metadata. */
export interface CompiledBuiltinRunDefSelection extends BuiltinRunDefSelection {
  /** Immutable compiled stage definitions produced by the compiler. */
  readonly stages: readonly CompiledStageDef[];
}

/** Selected and compiled discovered RunDef metadata. */
export interface CompiledDiscoveredRunDefSelection extends DiscoveredRunDefSelection {
  /** Immutable compiled stage definitions produced by the compiler. */
  readonly stages: readonly CompiledStageDef[];
}

/** Selected and compiled RunDef metadata. */
export type CompiledRunDefSelection =
  CompiledBuiltinRunDefSelection | CompiledDiscoveredRunDefSelection;

/** Options for selecting a RunDef. */
export interface SelectRunDefOptions {
  /** Preloaded discovered catalog, for tests or callers that already loaded it. */
  readonly discoveredRunDefs?: readonly DiscoveredRunDef[];
}

/** Options for selecting and compiling a RunDef. */
export interface SelectAndCompileRunDefOptions extends SelectRunDefOptions, CompileRunDefOptions {}

/** Error code emitted by RunDef selection failures. */
export type RunDefSelectionErrorCode = "rundef-not-found" | "builtin-discovered-conflict";

/** Details used to construct a RunDef selection error. */
export interface RunDefSelectionErrorDetails {
  /** Categorizes the failure as not-found or conflict for programmatic handling. */
  readonly code: RunDefSelectionErrorCode;

  /** Identifier the caller requested when selection failed. */
  readonly id: string;

  /** Absolute path of the project root used for the lookup. */
  readonly projectRoot?: string;

  /** Absolute path of the discovered YAML file involved in the failure. */
  readonly path?: string;
}

/**
 * Error thrown when RunDef selection fails.
 *
 * @example
 * ```ts
 * try {
 *   await selectRunDef("/repo", "missing");
 * } catch (error) {
 *   if (error instanceof RunDefSelectionError) {
 *     console.error(error.code);
 *   }
 * }
 * ```
 */
export class RunDefSelectionError extends Error {
  /** Categorizes the failure as not-found or conflict for programmatic handling. */
  public readonly code: RunDefSelectionErrorCode;

  /** Identifier the caller requested when selection failed. */
  public readonly id: string;

  /** Absolute path of the project root used for the lookup. */
  public readonly projectRoot?: string;

  /** Absolute path of the discovered YAML file involved in the failure. */
  public readonly path?: string;

  /**
   * Creates a RunDef selection error.
   *
   * @param details - Fields describing the selection failure for error construction.
   *
   * @example
   * ```ts
   * throw new RunDefSelectionError({
   *   code: "rundef-not-found",
   *   id: "missing",
   *   projectRoot: "/repo",
   * });
   * ```
   */
  public constructor(details: RunDefSelectionErrorDetails) {
    const message = buildSelectionErrorMessage(details);
    super(message);
    this.name = "RunDefSelectionError";
    this.code = details.code;
    this.id = details.id;
    if (details.projectRoot !== undefined) {
      this.projectRoot = details.projectRoot;
    }
    if (details.path !== undefined) {
      this.path = details.path;
    }
  }
}

/**
 * Builds a deterministic error message from selection error details.
 *
 * @param details - Fields describing the selection failure for error construction.
 *
 * @returns The error message string.
 *
 * @example
 * ```ts
 * const msg = buildSelectionErrorMessage({ code: "rundef-not-found", id: "missing" });
 * ```
 */
function buildSelectionErrorMessage(details: RunDefSelectionErrorDetails): string {
  if (details.code === "builtin-discovered-conflict") {
    return `RunDef "${details.id}" is defined both as a built-in RunDef and by discovered file "${details.path ?? ""}".`;
  }
  const root = details.projectRoot ?? "";
  return `RunDef "${details.id}" was not found in built-ins or discovered project RunDefs for "${root}".`;
}

/**
 * Asserts that a RunDef id matches the identifier pattern.
 *
 * @param id - Candidate RunDef id.
 *
 * @throws RangeError When the id does not match the pattern.
 *
 * @example
 * ```ts
 * assertValidRunDefId("sdlc"); // passes
 * assertValidRunDefId("BAD");  // throws RangeError
 * ```
 */
function assertValidRunDefId(id: string): void {
  if (!identifierPattern.test(id)) {
    throw new RangeError(`Invalid RunDef id "${id}".`);
  }
}

/**
 * Asserts that a project root is not blank.
 *
 * @param projectRoot - Candidate project root.
 *
 * @throws RangeError When the project root is blank.
 *
 * @example
 * ```ts
 * assertProjectRoot("/repo"); // passes
 * assertProjectRoot("   ");   // throws RangeError
 * ```
 */
function assertProjectRoot(projectRoot: string): void {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
}

/**
 * Resolves a RunDef from an already-loaded discovered catalog plus built-ins.
 *
 * @param id - Requested RunDef id.
 * @param discoveredRunDefs - Discovered project RunDefs.
 *
 * @returns The selected RunDef, or undefined when no RunDef matches.
 *
 * @throws RangeError When id is not a valid RunDef id.
 * @throws RunDefSelectionError When a built-in and discovered RunDef share the same id.
 *
 * @example
 * ```ts
 * const selection = resolveRunDefSelection("sdlc", []);
 * ```
 */
export function resolveRunDefSelection(
  id: string,
  discoveredRunDefs: readonly DiscoveredRunDef[],
): RunDefSelection | undefined {
  assertValidRunDefId(id);

  const builtin = resolveBuiltinRunDef(id);
  const discovered = discoveredRunDefs.find((entry) => entry.id === id);

  if (builtin !== undefined && discovered !== undefined) {
    throw new RunDefSelectionError({
      code: "builtin-discovered-conflict",
      id,
      path: discovered.path,
    });
  }

  if (discovered !== undefined) {
    return Object.freeze({
      id,
      source: "discovered" as const,
      path: discovered.path,
      runDef: discovered.runDef,
    });
  }

  if (builtin !== undefined) {
    return Object.freeze({
      id,
      source: "builtin" as const,
      runDef: builtin,
    });
  }

  return undefined;
}

/**
 * Selects a RunDef by id from built-ins and project-discovered YAML RunDefs.
 *
 * @param projectRoot - Project root directory.
 * @param id - Requested RunDef id.
 * @param options - Optional preloaded discovered catalog.
 *
 * @returns The selected RunDef.
 *
 * @throws RangeError When projectRoot is blank or id is not a valid RunDef id.
 * @throws RunDefLoadError When discovered RunDef loading fails.
 * @throws RunDefSelectionError When the RunDef is absent or ambiguous.
 *
 * @example
 * ```ts
 * const selection = await selectRunDef(process.cwd(), "sdlc");
 * ```
 */
export async function selectRunDef(
  projectRoot: string,
  id: string,
  options?: SelectRunDefOptions,
): Promise<RunDefSelection> {
  assertProjectRoot(projectRoot);
  assertValidRunDefId(id);

  const discovered = options?.discoveredRunDefs ?? (await discoverRunDefs(projectRoot));

  const selection = resolveRunDefSelection(id, discovered);

  if (selection === undefined) {
    throw new RunDefSelectionError({
      code: "rundef-not-found",
      id,
      projectRoot,
    });
  }

  return selection;
}

/**
 * Selects and compiles a RunDef by id.
 *
 * @param projectRoot - Project root directory.
 * @param id - Requested RunDef id.
 * @param options - Optional selection and compilation options.
 *
 * @returns The selected RunDef plus frozen compiled stages.
 *
 * @throws RangeError When projectRoot is blank, id is invalid, or compile defaults are invalid.
 * @throws RunDefLoadError When discovered RunDef loading fails.
 * @throws RunDefSelectionError When the RunDef is absent or ambiguous.
 * @throws RunDefCompileError When compilation fails, for example when a payload gate is unregistered.
 *
 * @example
 * ```ts
 * const selection = await selectAndCompileRunDef(process.cwd(), "sdlc");
 * ```
 */
export async function selectAndCompileRunDef(
  projectRoot: string,
  id: string,
  options?: SelectAndCompileRunDefOptions,
): Promise<CompiledRunDefSelection> {
  const selection = await selectRunDef(projectRoot, id, options);
  const stages = compileValidatedRunDef(selection.runDef, options);

  return Object.freeze({
    ...selection,
    stages,
  });
}
