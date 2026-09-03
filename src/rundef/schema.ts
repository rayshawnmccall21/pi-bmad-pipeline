/**
 * TypeBox schema validation and cross-field invariant enforcement for RunDef.
 *
 * This module is the runtime validation boundary for raw RunDef objects loaded
 * from discovered YAML. Structural validation runs first via TypeBox;
 * cross-field invariants run only after structural validation passes.
 *
 * @packageDocumentation
 */

import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

import type { RunDef } from "./types.js";

/** Identifier pattern shared by RunDef names and references. */
export const RUNDEF_IDENTIFIER_PATTERN = "^[a-z][a-z0-9-]*$" as const;

/** TypeBox schema for per-stage budget ceilings. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Established public TypeBox schema API name.
export const StageBudgetSchema = Type.Object(
  {
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    maxDollars: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** TypeBox schema for one raw agent stage entry. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Established public TypeBox schema API name.
export const AgentRunDefStageSchema = Type.Object(
  {
    id: Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN }),
    kind: Type.Literal("agent"),
    description: Type.Optional(Type.String()),
    workflow: Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN }),
    agent: Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN }),
    gate: Type.Optional(Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN })),
    onFail: Type.Optional(Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN })),
    timeout: Type.Optional(Type.Integer({ minimum: 1 })),
    thinking: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    model: Type.Optional(Type.String({ minLength: 1 })),
    budget: Type.Optional(StageBudgetSchema),
    extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    oPool: Type.Optional(Type.String({ minLength: 1 })),
    oName: Type.Optional(Type.String({ minLength: 1 })),
    oTag: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** TypeBox schema for one raw code stage entry. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Established public TypeBox schema API name.
export const CodeRunDefStageSchema = Type.Object(
  {
    id: Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN }),
    kind: Type.Literal("code"),
    description: Type.Optional(Type.String()),
    command: Type.String({ minLength: 1, pattern: "\\S" }),
    args: Type.Optional(Type.Array(Type.String())),
    timeout: Type.Optional(Type.Integer({ minimum: 1 })),
    onFail: Type.Optional(Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN })),
    findingsFile: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/** TypeBox schema for either supported raw stage kind. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Established public TypeBox schema API name.
export const RunDefStageSchema = Type.Union([AgentRunDefStageSchema, CodeRunDefStageSchema]);

/** TypeBox schema for a raw RunDef pipeline definition. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Established public TypeBox schema API name.
export const RunDefSchema = Type.Object(
  {
    id: Type.String({ pattern: RUNDEF_IDENTIFIER_PATTERN }),
    description: Type.Optional(Type.String()),
    stages: Type.Array(RunDefStageSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** Static type for StageBudgetSchema values. */
export type StageBudgetSchemaValue = Static<typeof StageBudgetSchema>;

/** Static type for AgentRunDefStageSchema values. */
export type AgentRunDefStageSchemaValue = Static<typeof AgentRunDefStageSchema>;

/** Static type for CodeRunDefStageSchema values. */
export type CodeRunDefStageSchemaValue = Static<typeof CodeRunDefStageSchema>;

/** Static type for RunDefStageSchema values. */
export type RunDefStageSchemaValue = Static<typeof RunDefStageSchema>;

/** Static type for RunDefSchema values. */
export type RunDefSchemaValue = Static<typeof RunDefSchema>;

/** Describes one validation issue in JSON-pointer path form. */
export interface RunDefValidationIssue {
  /** JSON pointer path to the failing value, or an empty string for the document root. */
  readonly path: string;

  /** Human-readable validation message. */
  readonly message: string;
}

/** Validation result returned by validateRunDef. */
export type RunDefValidationResult =
  | {
      /** Indicates the candidate is a valid RunDef. */
      readonly ok: true;

      /** The validated RunDef value, preserving object identity. */
      readonly value: RunDef;
    }
  | {
      /** Indicates the candidate is not a valid RunDef. */
      readonly ok: false;

      /** Validation issues collected from TypeBox and cross-field invariants. */
      readonly issues: readonly RunDefValidationIssue[];
    };

/** Error thrown by parseRunDef and assertRunDef on validation failure. */
export class RunDefValidationError extends Error {
  /** Validation issues that caused the error. */
  public readonly issues: readonly RunDefValidationIssue[];

  /**
   * Creates a RunDef validation error.
   *
   * @param issues - Validation issues that caused the error.
   *
   * @example
   * ```ts
   * throw new RunDefValidationError([{ path: "/id", message: "invalid" }]);
   * ```
   */
  public constructor(issues: readonly RunDefValidationIssue[]) {
    super(
      `Invalid RunDef: ${issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ")}`,
    );
    this.name = "RunDefValidationError";
    this.issues = issues;
  }
}

function collectTypeBoxIssues(
  schema: typeof RunDefSchema,
  candidate: unknown,
): RunDefValidationIssue[] {
  return [...Errors(schema, candidate)].map((error) => ({
    path: error.instancePath,
    message: error.message,
  }));
}

function checkCrossFieldInvariants(def: RunDef): RunDefValidationIssue[] {
  const issues: RunDefValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const [index, stage] of def.stages.entries()) {
    issues.push(...checkStageIdUnique(stage, index, seenIds));
    issues.push(...checkGateOnFailPairing(stage, index));
    issues.push(...checkOnFailTarget(stage, index, def.stages));
    if (stage.kind === "agent") {
      issues.push(...checkBudgetNonEmpty(stage, index));
    }
  }

  return issues;
}

function checkStageIdUnique(
  stage: RunDef["stages"][number],
  index: number,
  seenIds: Set<string>,
): RunDefValidationIssue[] {
  if (seenIds.has(stage.id)) {
    return [{ path: `/stages/${String(index)}/id`, message: `Duplicate stage id "${stage.id}".` }];
  }
  seenIds.add(stage.id);
  return [];
}

function checkGateOnFailPairing(
  stage: RunDef["stages"][number] & { readonly gate?: string; readonly onFail?: string },
  index: number,
): RunDefValidationIssue[] {
  if (stage.gate !== undefined && stage.onFail === undefined) {
    return [
      {
        path: `/stages/${String(index)}/onFail`,
        message: `Stage "${stage.id}" declares gate "${stage.gate}" but no onFail target.`,
      },
    ];
  }

  if (stage.onFail !== undefined && stage.gate === undefined && stage.kind === "agent") {
    // Agent stages need a payload gate to emit gate-failed. Code stages do
    // not: their exit code IS the gate (v1.1), so onFail alone is legal.
    return [
      {
        path: `/stages/${String(index)}/gate`,
        message: `Stage "${stage.id}" declares onFail "${stage.onFail}" but no gate.`,
      },
    ];
  }

  return [];
}

function checkOnFailTarget(
  stage: RunDef["stages"][number] & { readonly onFail?: string; readonly gate?: string },
  index: number,
  stages: RunDef["stages"],
): RunDefValidationIssue[] {
  if (stage.onFail === undefined) {
    return [];
  }

  const targetIndex = stages.findIndex((s) => s.id === stage.onFail);

  if (targetIndex === -1) {
    return [
      {
        path: `/stages/${String(index)}/onFail`,
        message: `Stage "${stage.id}" onFail target "${stage.onFail}" does not exist.`,
      },
    ];
  }

  if (targetIndex >= index) {
    return [
      {
        path: `/stages/${String(index)}/onFail`,
        message: `Stage "${stage.id}" onFail target "${stage.onFail}" must be an earlier stage.`,
      },
    ];
  }

  return [];
}

function checkBudgetNonEmpty(
  stage: RunDef["stages"][number] & {
    readonly budget?: { readonly maxTokens?: number; readonly maxDollars?: number };
  },
  index: number,
): RunDefValidationIssue[] {
  if (stage.budget === undefined) {
    return [];
  }

  if (stage.budget.maxTokens === undefined && stage.budget.maxDollars === undefined) {
    return [
      {
        path: `/stages/${String(index)}/budget`,
        message: `Stage "${stage.id}" budget must set maxTokens or maxDollars.`,
      },
    ];
  }

  return [];
}

/**
 * Validates an unknown candidate as a RunDef without mutating it.
 *
 * @param candidate - Candidate value loaded from discovered YAML.
 *
 * @returns A discriminated validation result.
 *
 * @example
 * ```ts
 * const result = validateRunDef(candidate);
 * ```
 */
export function validateRunDef(candidate: unknown): RunDefValidationResult {
  if (!Check(RunDefSchema, candidate)) {
    return { ok: false, issues: collectTypeBoxIssues(RunDefSchema, candidate) };
  }

  const issues = checkCrossFieldInvariants(candidate);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: candidate };
}

/**
 * Parses an unknown candidate as a RunDef, throwing on failure.
 *
 * @param candidate - Candidate value loaded from discovered YAML.
 *
 * @returns The validated RunDef.
 *
 * @throws RunDefValidationError When structural or cross-field validation fails.
 *
 * @example
 * ```ts
 * const runDef = parseRunDef(candidate);
 * ```
 */
export function parseRunDef(candidate: unknown): RunDef {
  const result = validateRunDef(candidate);
  if (!result.ok) {
    throw new RunDefValidationError(result.issues);
  }
  return result.value;
}

/**
 * Asserts that an unknown candidate is a RunDef.
 *
 * @param candidate - Candidate value loaded from discovered YAML.
 *
 * @throws RunDefValidationError When validation fails.
 *
 * @example
 * ```ts
 * assertRunDef(candidate);
 * ```
 */
export function assertRunDef(candidate: unknown): asserts candidate is RunDef {
  const result = validateRunDef(candidate);
  if (!result.ok) {
    throw new RunDefValidationError(result.issues);
  }
}

/**
 * Checks whether an unknown candidate is a valid RunDef.
 *
 * @param candidate - Candidate value loaded from discovered YAML.
 *
 * @returns True when the candidate is a valid RunDef.
 *
 * @example
 * ```ts
 * if (isRunDef(candidate)) console.log(candidate.stages.length);
 * ```
 */
export function isRunDef(candidate: unknown): candidate is RunDef {
  return validateRunDef(candidate).ok;
}
