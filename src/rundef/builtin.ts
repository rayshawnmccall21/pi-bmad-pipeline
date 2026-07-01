/**
 * Built-in pipeline definitions and resolution helpers.
 *
 * This module owns the canonical SDLC RunDef stage table and provides lookup
 * helpers for built-in pipeline ids. The SDLC definition is validated at module
 * load time through the schema and cross-field invariants from schema.ts, then
 * frozen so callers receive an immutable, trusted control-plane object.
 *
 * @packageDocumentation
 */

import { parseRunDef } from "./schema.js";

import type { RunDef, RunDefStage } from "./types.js";

/** Built-in SDLC RunDef identifier. */
export const SDLC_RUNDEF_ID = "sdlc" as const;

/** Identifiers supported by the built-in RunDef registry. */
export type BuiltinRunDefId = typeof SDLC_RUNDEF_ID;

/** Frozen stage definitions for the canonical SDLC pipeline. */
const sdlcRunDefStages = Object.freeze([
  Object.freeze({
    id: "create-story",
    kind: "agent",
    workflow: "create-story",
    agent: "sm",
    timeout: 1800,
  } satisfies RunDefStage),
  Object.freeze({
    id: "e2e-plan",
    kind: "agent",
    workflow: "e2e-plan",
    agent: "tea",
    timeout: 1800,
  } satisfies RunDefStage),
  Object.freeze({
    id: "dev-story",
    kind: "agent",
    workflow: "dev-story",
    agent: "dev",
    timeout: 3600,
  } satisfies RunDefStage),
  Object.freeze({
    id: "e2e-verify",
    kind: "agent",
    workflow: "e2e-verify",
    agent: "tea",
    gate: "e2e-verify",
    onFail: "dev-story",
    timeout: 7200,
  } satisfies RunDefStage),
  Object.freeze({
    id: "code-review",
    kind: "agent",
    workflow: "code-review",
    agent: "dev",
    gate: "code-review",
    onFail: "dev-story",
    thinking: "high",
    timeout: 1800,
  } satisfies RunDefStage),
  Object.freeze({
    id: "docs",
    kind: "agent",
    workflow: "docs",
    agent: "architect",
    thinking: "high",
    timeout: 1800,
  } satisfies RunDefStage),
] satisfies readonly RunDefStage[]);

/** Raw SDLC RunDef before schema validation. */
const rawSdlcRunDef = Object.freeze({
  id: SDLC_RUNDEF_ID,
  stages: sdlcRunDefStages,
} satisfies RunDef);

/** Canonical built-in SDLC RunDef, validated at module load. */
export const SDLC_RUNDEF: RunDef = parseRunDef(rawSdlcRunDef);

/** Built-in RunDef identifiers in deterministic order. */
export const BUILTIN_RUNDEF_IDS = Object.freeze([
  SDLC_RUNDEF_ID,
] satisfies readonly BuiltinRunDefId[]);

/**
 * Lists built-in RunDef identifiers in deterministic order.
 *
 * @returns A defensive copy of built-in RunDef identifiers.
 *
 * @example
 * ```ts
 * const ids = listBuiltinRunDefIds();
 * ```
 */
export function listBuiltinRunDefIds(): readonly BuiltinRunDefId[] {
  return [...BUILTIN_RUNDEF_IDS];
}

/**
 * Checks whether an identifier names a built-in RunDef.
 *
 * @param id - Candidate RunDef identifier.
 *
 * @returns True when the identifier names a built-in RunDef.
 *
 * @example
 * ```ts
 * if (isBuiltinRunDefId("sdlc")) {
 *   console.log("built-in");
 * }
 * ```
 */
export function isBuiltinRunDefId(id: string): id is BuiltinRunDefId {
  return id === SDLC_RUNDEF_ID;
}

/**
 * Resolves a built-in RunDef by identifier.
 *
 * @param id - Candidate RunDef identifier.
 *
 * @returns The built-in RunDef, or undefined when the identifier is not built in.
 *
 * @example
 * ```ts
 * const runDef = resolveBuiltinRunDef("sdlc");
 * ```
 */
export function resolveBuiltinRunDef(id: string): RunDef | undefined {
  if (id === SDLC_RUNDEF_ID) {
    return SDLC_RUNDEF;
  }
  return undefined;
}

/**
 * Resolves a RunDef by identifier, checking built-ins first.
 *
 * This function is the built-in-only resolver for now. A future selector module
 * will extend it to also check discovered YAML pipelines from disk.
 *
 * @param id - Candidate RunDef identifier.
 *
 * @returns The resolved RunDef, or undefined when the identifier is not found.
 *
 * @example
 * ```ts
 * const runDef = resolveRunDef("sdlc");
 * ```
 */
export function resolveRunDef(id: string): RunDef | undefined {
  return resolveBuiltinRunDef(id);
}
