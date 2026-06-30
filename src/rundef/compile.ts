/**
 * RunDef compiler — converts validated RunDef into immutable compiled stage definitions.
 *
 * This module is the pure-logic compilation layer. It resolves payload gate names
 * into executable functions via the registry, applies default timeouts, copies and
 * freezes budget objects, and produces frozen compiled stage definitions for
 * the pipeline FSM.
 *
 * It does NOT import Pi, child_process, filesystem APIs, YAML, or pi-bmad/contracts.
 *
 * @packageDocumentation
 */

import { parseRunDef } from "./schema.js";
import { payloadGateRegistry } from "./registry.js";
import type {
  CompiledStageDef,
  PayloadGate,
  PayloadGateRegistry,
  RunDef,
  StageBudget,
} from "./types.js";

/** Default timeout applied to stages that omit timeout. */
export const DEFAULT_STAGE_TIMEOUT_SECONDS = 1800;

/** Error code emitted by RunDef compilation failures. */
export type RunDefCompileErrorCode = "unregistered-payload-gate";

/** Details used to construct a RunDef compilation error. */
export interface RunDefCompileErrorDetails {
  /** Stable machine-readable error code. */
  readonly code: RunDefCompileErrorCode;

  /** RunDef identifier being compiled. */
  readonly runDefId: string;

  /** Stage identifier that failed compilation. */
  readonly stageId: string;

  /** Payload gate name that could not be resolved. */
  readonly gateName: string;
}

/** Options controlling RunDef compilation. */
export interface CompileRunDefOptions {
  /** Registry used to resolve payload gate functions. */
  readonly registry?: PayloadGateRegistry;

  /** Timeout to apply to stages without an explicit timeout. */
  readonly defaultTimeoutSeconds?: number;
}

/** Context object for single-stage compilation. */
interface StageCompileContext {
  /** Zero-based position in the stage list. */
  readonly index: number;

  /** Effective default timeout in seconds. */
  readonly defaultTimeout: number;

  /** Registry for payload gate resolution. */
  readonly registry: PayloadGateRegistry;

  /** RunDef identifier for error reporting. */
  readonly runDefId: string;

  /** Stage identifier for error reporting. */
  readonly stageId: string;
}

/** Error thrown when a structurally valid RunDef cannot be compiled. */
export class RunDefCompileError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: RunDefCompileErrorCode;

  /** RunDef identifier being compiled. */
  public readonly runDefId: string;

  /** Stage identifier that failed compilation. */
  public readonly stageId: string;

  /** Payload gate name that could not be resolved. */
  public readonly gateName: string;

  /**
   * Creates a RunDef compilation error.
   *
   * @param details - Error details for the failed stage.
   *
   * @example
   * ```ts
   * throw new RunDefCompileError({
   *   code: "unregistered-payload-gate",
   *   runDefId: "sdlc",
   *   stageId: "e2e-verify",
   *   gateName: "e2e-verify",
   * });
   * ```
   */
  public constructor(details: RunDefCompileErrorDetails) {
    super(
      `RunDef "${details.runDefId}" stage "${details.stageId}" references unregistered payload gate "${details.gateName}".`,
    );
    this.name = "RunDefCompileError";
    this.code = details.code;
    this.runDefId = details.runDefId;
    this.stageId = details.stageId;
    this.gateName = details.gateName;
  }
}

/**
 * Validates a default timeout seconds value.
 *
 * @param value - Candidate timeout value.
 *
 * @returns The validated positive integer.
 *
 * @throws RangeError When the value is not a positive integer.
 *
 * @example
 * ```ts
 * const valid = validateDefaultTimeout(1800);
 * ```
 */
function validateDefaultTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `defaultTimeoutSeconds must be a positive integer, received ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Copies and freezes a stage budget object.
 *
 * @param budget - Source budget from a RunDef stage.
 *
 * @returns A frozen copy of the budget.
 *
 * @example
 * ```ts
 * const frozen = copyBudget(stage.budget);
 * ```
 */
function copyBudget(budget: StageBudget): StageBudget {
  return Object.freeze({ ...budget });
}

/**
 * Resolves a payload gate for a stage that declares one.
 *
 * @param gateName - Gate name declared on the RunDef stage.
 * @param ctx - Compilation context carrying the registry and identifiers.
 *
 * @returns The resolved payload gate function.
 *
 * @throws RunDefCompileError When the gate name is not registered.
 *
 * @example
 * ```ts
 * const gate = resolveStageGate("e2e-verify", ctx);
 * ```
 */
function resolveStageGate(gateName: string, ctx: StageCompileContext): PayloadGate {
  const resolved = ctx.registry.resolve(gateName);
  if (resolved === undefined) {
    throw new RunDefCompileError({
      code: "unregistered-payload-gate",
      runDefId: ctx.runDefId,
      stageId: ctx.stageId,
      gateName,
    });
  }
  return resolved;
}

/**
 * Builds the optional compiled stage fields from a raw stage.
 *
 * @param stage - Raw RunDef stage.
 * @param ctx - Compilation context.
 *
 * @returns An object containing only the present optional fields.
 *
 * @example
 * ```ts
 * const opts = buildOptionalFields(stage, ctx);
 * ```
 */
function buildOptionalFields(
  stage: RunDef["stages"][number],
  ctx: StageCompileContext,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (stage.gate !== undefined) {
    fields["payloadGateName"] = stage.gate;
    fields["payloadGate"] = resolveStageGate(stage.gate, ctx);
  }

  if (stage.onFail !== undefined) {
    fields["onFail"] = stage.onFail;
  }

  if (stage.thinking !== undefined) {
    fields["thinking"] = stage.thinking;
  }

  if (stage.budget !== undefined) {
    fields["budget"] = copyBudget(stage.budget);
  }

  return fields;
}

/**
 * Compiles a single RunDef stage into a compiled stage definition.
 *
 * @param stage - Raw RunDef stage to compile.
 * @param ctx - Compilation context carrying index, timeout, registry, and identifiers.
 *
 * @returns A frozen compiled stage definition.
 *
 * @example
 * ```ts
 * const compiled = compileStage(rawStage, ctx);
 * ```
 */
function compileStage(stage: RunDef["stages"][number], ctx: StageCompileContext): CompiledStageDef {
  const stageCtx: StageCompileContext = { ...ctx, stageId: stage.id };

  const base = {
    id: stage.id,
    kind: stage.kind,
    workflow: stage.workflow,
    agent: stage.agent,
    index: stageCtx.index,
    timeoutSeconds: stage.timeout ?? stageCtx.defaultTimeout,
  };

  const compiled = Object.freeze({ ...base, ...buildOptionalFields(stage, stageCtx) });
  return compiled;
}

/**
 * Validates and compiles an unknown candidate into compiled stage definitions.
 *
 * @param candidate - Candidate RunDef loaded from YAML, JSON, or a built-in definition.
 * @param options - Optional compilation dependencies and defaults.
 *
 * @returns Frozen compiled stage definitions in execution order.
 *
 * @throws RunDefValidationError When the candidate is not a valid RunDef.
 * @throws RunDefCompileError When a configured payload gate cannot be resolved.
 * @throws RangeError When defaultTimeoutSeconds is not a positive integer.
 *
 * @example
 * ```ts
 * const stages = compileRunDef(candidate);
 * ```
 */
export function compileRunDef(
  candidate: unknown,
  options?: CompileRunDefOptions,
): readonly CompiledStageDef[] {
  const runDef = parseRunDef(candidate);
  return compileValidatedRunDef(runDef, options);
}

/**
 * Compiles an already validated RunDef into compiled stage definitions.
 *
 * @param runDef - Validated RunDef to compile.
 * @param options - Optional compilation dependencies and defaults.
 *
 * @returns Frozen compiled stage definitions in execution order.
 *
 * @throws RunDefCompileError When a configured payload gate cannot be resolved.
 * @throws RangeError When defaultTimeoutSeconds is not a positive integer.
 *
 * @example
 * ```ts
 * const stages = compileValidatedRunDef(runDef);
 * ```
 */
export function compileValidatedRunDef(
  runDef: RunDef,
  options?: CompileRunDefOptions,
): readonly CompiledStageDef[] {
  const registry = options?.registry ?? payloadGateRegistry;
  const defaultTimeout = validateDefaultTimeout(
    options?.defaultTimeoutSeconds ?? DEFAULT_STAGE_TIMEOUT_SECONDS,
  );

  const stages = runDef.stages.map((stage, index) =>
    compileStage(stage, {
      index,
      defaultTimeout,
      registry,
      runDefId: runDef.id,
      stageId: stage.id,
    }),
  );

  return Object.freeze(stages);
}
