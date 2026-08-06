/**
 * Selects and compiles RunDefs discovered from project YAML.
 *
 * @packageDocumentation
 */

import { compileValidatedRunDef, type CompileRunDefOptions } from "./compile.js";
import { discoverRunDefs, type DiscoveredRunDef } from "./loader.js";
import { RUNDEF_IDENTIFIER_PATTERN } from "./schema.js";
import type { CompiledStageDef, RunDef } from "./types.js";

const identifierPattern = new RegExp(RUNDEF_IDENTIFIER_PATTERN, "u");

/** Selected RunDef origin. */
export type RunDefSelectionSource = "discovered";

/** Metadata for a discovered RunDef selection. */
export interface DiscoveredRunDefSelection {
  /** Selected RunDef identifier. */
  readonly id: string;
  /** Indicates that project YAML supplied the definition. */
  readonly source: "discovered";
  /** Absolute path to the defining YAML file. */
  readonly path: string;
  /** Validated raw RunDef. */
  readonly runDef: RunDef;
}

/** Selected raw RunDef metadata. */
export type RunDefSelection = DiscoveredRunDefSelection;

/** Selected and compiled discovered RunDef metadata. */
export interface CompiledDiscoveredRunDefSelection extends DiscoveredRunDefSelection {
  /** Immutable compiled stages. */
  readonly stages: readonly CompiledStageDef[];
}

/** Selected and compiled RunDef metadata. */
export type CompiledRunDefSelection = CompiledDiscoveredRunDefSelection;

/** Options for selecting a RunDef. */
export interface SelectRunDefOptions {
  /** Optional catalog supplied by an existing discovery pass. */
  readonly discoveredRunDefs?: readonly DiscoveredRunDef[];
}

/** Options shared by selection and compilation. */
export interface SelectAndCompileRunDefOptions extends SelectRunDefOptions, CompileRunDefOptions {}

/** Stable selection failure code. */
export type RunDefSelectionErrorCode = "rundef-not-found";

/** Machine-readable selection error details. */
export interface RunDefSelectionErrorDetails {
  /** Stable failure code. */
  readonly code: RunDefSelectionErrorCode;
  /** Requested RunDef identifier. */
  readonly id: string;
  /** Project root searched by discovery. */
  readonly projectRoot?: string;
  /** Optional related YAML path. */
  readonly path?: string;
}

/** Error raised when discovered YAML does not contain the requested RunDef. */
export class RunDefSelectionError extends Error {
  /** Stable failure code. */
  public readonly code: RunDefSelectionErrorCode;
  /** Requested RunDef identifier. */
  public readonly id: string;
  /** Project root searched by discovery. */
  public readonly projectRoot?: string;
  /** Optional related YAML path. */
  public readonly path?: string;

  /**
   * Creates a typed selection error.
   *
   * @param details - Machine-readable failure details.
   */
  public constructor(details: RunDefSelectionErrorDetails) {
    super(
      `RunDef "${details.id}" was not found in discovered project RunDefs for "${details.projectRoot ?? ""}".`,
    );
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

const assertValidRunDefId = (id: string): void => {
  if (!identifierPattern.test(id)) {
    throw new RangeError(`Invalid RunDef id "${id}".`);
  }
};

const assertProjectRoot = (projectRoot: string): void => {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
};

/**
 * Resolves an identifier from an already discovered catalog.
 *
 * @param id - Requested RunDef identifier.
 * @param discoveredRunDefs - Validated discovered catalog.
 *
 * @returns Frozen selection metadata, or undefined when absent.
 *
 * @example
 * ```ts
 * resolveRunDefSelection("custom", catalog);
 * ```
 */
export function resolveRunDefSelection(
  id: string,
  discoveredRunDefs: readonly DiscoveredRunDef[],
): RunDefSelection | undefined {
  assertValidRunDefId(id);
  const discovered = discoveredRunDefs.find((entry) => entry.id === id);
  return discovered === undefined
    ? undefined
    : Object.freeze({
        id,
        source: "discovered" as const,
        path: discovered.path,
        runDef: discovered.runDef,
      });
}

/**
 * Selects a RunDef from project-discovered YAML only.
 *
 * @param projectRoot - Project root containing the pipeline catalog.
 * @param id - Requested RunDef identifier.
 * @param options - Optional preloaded catalog.
 *
 * @returns Frozen discovered selection metadata.
 *
 * @example
 * ```ts
 * await selectRunDef(process.cwd(), "sdlc");
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
    throw new RunDefSelectionError({ code: "rundef-not-found", id, projectRoot });
  }
  return selection;
}

/**
 * Selects and compiles one discovered RunDef.
 *
 * @param projectRoot - Project root containing the pipeline catalog.
 * @param id - Requested RunDef identifier.
 * @param options - Optional selection and compilation settings.
 *
 * @returns Frozen selection metadata with compiled stages.
 *
 * @example
 * ```ts
 * await selectAndCompileRunDef(process.cwd(), "sdlc");
 * ```
 */
export async function selectAndCompileRunDef(
  projectRoot: string,
  id: string,
  options?: SelectAndCompileRunDefOptions,
): Promise<CompiledRunDefSelection> {
  const selection = await selectRunDef(projectRoot, id, options);
  return Object.freeze({ ...selection, stages: compileValidatedRunDef(selection.runDef, options) });
}
