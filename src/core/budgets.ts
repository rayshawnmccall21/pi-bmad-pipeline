import type { CompiledStageDef, StageBudget } from "../rundef/index.js";

/** Usage shape used for budget evaluation. */
export interface BudgetUsage {
  /** Token usage reported by a stage execution. */
  readonly tokens: number;

  /** Dollar usage reported by a stage execution. */
  readonly dollars: number;
}

/** Limit kind that can be exceeded. */
export type StageBudgetLimitKind = "tokens" | "dollars";

/** One exceeded budget limit. */
export interface StageBudgetExceededLimit {
  /** Exceeded limit kind. */
  readonly kind: StageBudgetLimitKind;

  /** Actual usage value. */
  readonly actual: number;

  /** Configured budget limit. */
  readonly limit: number;
}

/** Minimal compiled stage shape required for budget evaluation. */
export type BudgetedStage = Pick<CompiledStageDef, "id" | "budget">;

/** Request for evaluating one stage budget. */
export interface EvaluateStageBudgetRequest {
  /** Stage whose optional budget should be evaluated. */
  readonly stage: BudgetedStage;

  /** Usage reported by the stage execution. */
  readonly usage?: BudgetUsage;
}

/** Result of evaluating one stage budget. */
export interface StageBudgetEvaluation {
  /** Stage id. */
  readonly stageId: string;

  /** True when no configured budget was exceeded. */
  readonly passed: boolean;

  /** Configured stage budget, when present. */
  readonly budget?: StageBudget;

  /** Usage used for evaluation, when valid and present. */
  readonly usage?: BudgetUsage;

  /** Exceeded limits. Empty when passed. */
  readonly exceeded: readonly StageBudgetExceededLimit[];

  /** Human-readable audit reason. */
  readonly reason: string;
}

/** Aggregate run-level budget ceiling. */
export interface RunBudget {
  /** Maximum total token spend allowed for the run. */
  readonly maxTokens?: number;

  /** Maximum total dollar spend allowed for the run. */
  readonly maxDollars?: number;
}

/** Request for evaluating aggregate run budget. */
export interface EvaluateRunBudgetRequest {
  /** Optional aggregate run budget. */
  readonly budget?: RunBudget;

  /** Aggregate usage accumulated so far. */
  readonly usage?: BudgetUsage;
}

/** Result of evaluating aggregate run budget. */
export interface RunBudgetEvaluation {
  /** True when no configured run budget was exceeded. */
  readonly passed: boolean;

  /** Configured run budget, when present. */
  readonly budget?: RunBudget;

  /** Usage used for evaluation, when valid and present. */
  readonly usage?: BudgetUsage;

  /** Exceeded limits. Empty when passed. */
  readonly exceeded: readonly StageBudgetExceededLimit[];

  /** Human-readable audit reason. */
  readonly reason: string;
}

/**
 * Evaluates whether stage usage stays within the configured stage budget.
 *
 * @param request - Stage budget evaluation request.
 *
 * @returns Frozen budget evaluation result.
 *
 * @example
 * ```ts
 * const result = evaluateStageBudget({ stage, usage: { tokens: 10, dollars: 0.01 } });
 * ```
 */
export function evaluateStageBudget(request: EvaluateStageBudgetRequest): StageBudgetEvaluation {
  const budget = copyStageBudget(request.stage.budget);
  if (budget === undefined) {
    return freezeStageResult({
      stageId: request.stage.id,
      passed: true,
      exceeded: [],
      reason: `Stage "${request.stage.id}" has no budget ceiling.`,
    });
  }
  if (!isBudgetUsage(request.usage)) {
    return freezeStageResult({
      stageId: request.stage.id,
      passed: false,
      budget,
      exceeded: [],
      reason: `Stage "${request.stage.id}" has a budget ceiling but no valid usage was reported.`,
    });
  }
  return evaluateStageWithUsage(request.stage.id, budget, copyUsage(request.usage));
}

/**
 * Evaluates whether aggregate usage stays within the configured run budget.
 *
 * @param request - Run budget evaluation request.
 *
 * @returns Frozen run budget evaluation result.
 *
 * @example
 * ```ts
 * const result = evaluateRunBudget({
 *   budget: { maxTokens: 10_000 },
 *   usage: { tokens: 9_000, dollars: 1.25 },
 * });
 * ```
 */
export function evaluateRunBudget(request: EvaluateRunBudgetRequest): RunBudgetEvaluation {
  const budget = copyRunBudget(request.budget);
  if (budget === undefined) {
    return freezeRunResult({ passed: true, exceeded: [], reason: "Run has no budget ceiling." });
  }
  if (!isBudgetUsage(request.usage)) {
    return freezeRunResult({
      passed: false,
      budget,
      exceeded: [],
      reason: "Run has a budget ceiling but no valid usage was reported.",
    });
  }
  return evaluateRunWithUsage(budget, copyUsage(request.usage));
}

/**
 * Checks whether a usage object is valid for budget evaluation.
 *
 * @param usage - Candidate usage object.
 *
 * @returns True when usage has finite non-negative token and dollar values.
 *
 * @example
 * ```ts
 * if (isBudgetUsage({ tokens: 1, dollars: 0 })) {
 *   console.log("valid");
 * }
 * ```
 */
export function isBudgetUsage(usage: unknown): usage is BudgetUsage {
  return (
    isRecord(usage) && isNonNegativeFinite(usage["tokens"]) && isNonNegativeFinite(usage["dollars"])
  );
}

type BudgetCeiling = StageBudget | RunBudget;

const evaluateStageWithUsage = (
  stageId: string,
  budget: StageBudget,
  usage: BudgetUsage,
): StageBudgetEvaluation => {
  const exceeded = buildExceededLimits(budget, usage);
  return freezeStageResult({
    stageId,
    passed: exceeded.length === 0,
    budget,
    usage,
    exceeded,
    reason:
      exceeded.length === 0
        ? `Stage "${stageId}" stayed within budget.`
        : `Stage "${stageId}" exceeded budget: ${formatExceededLimits(exceeded)}.`,
  });
};

const evaluateRunWithUsage = (budget: RunBudget, usage: BudgetUsage): RunBudgetEvaluation => {
  const exceeded = buildExceededLimits(budget, usage);
  return freezeRunResult({
    passed: exceeded.length === 0,
    budget,
    usage,
    exceeded,
    reason:
      exceeded.length === 0
        ? "Run stayed within budget."
        : `Run exceeded budget: ${formatExceededLimits(exceeded)}.`,
  });
};

const buildExceededLimits = (
  budget: BudgetCeiling,
  usage: BudgetUsage,
): readonly StageBudgetExceededLimit[] => {
  const exceeded: StageBudgetExceededLimit[] = [];
  if (budget.maxTokens !== undefined && usage.tokens > budget.maxTokens) {
    exceeded.push({ kind: "tokens", actual: usage.tokens, limit: budget.maxTokens });
  }
  if (budget.maxDollars !== undefined && usage.dollars > budget.maxDollars) {
    exceeded.push({ kind: "dollars", actual: usage.dollars, limit: budget.maxDollars });
  }
  return exceeded;
};

const formatExceededLimits = (exceeded: readonly StageBudgetExceededLimit[]): string =>
  exceeded.map(formatExceededLimit).join(", ");

const formatExceededLimit = (limit: StageBudgetExceededLimit): string =>
  `${limit.kind} ${String(limit.actual)} > ${String(limit.limit)}`;

const copyStageBudget = (budget: StageBudget | undefined): StageBudget | undefined =>
  budget === undefined ? undefined : copyBudgetFields(budget);

const copyRunBudget = (budget: RunBudget | undefined): RunBudget | undefined =>
  budget === undefined ? undefined : copyBudgetFields(budget);

const copyBudgetFields = (budget: BudgetCeiling): BudgetCeiling =>
  Object.freeze({
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    ...(budget.maxDollars === undefined ? {} : { maxDollars: budget.maxDollars }),
  });

const copyUsage = (usage: BudgetUsage): BudgetUsage =>
  Object.freeze({ tokens: usage.tokens, dollars: usage.dollars });

const freezeStageResult = (result: StageBudgetEvaluation): StageBudgetEvaluation => {
  const exceeded = freezeExceeded(result.exceeded);
  return Object.freeze({
    stageId: result.stageId,
    passed: result.passed,
    exceeded,
    reason: result.reason,
    ...(result.budget === undefined ? {} : { budget: result.budget }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  });
};

const freezeRunResult = (result: RunBudgetEvaluation): RunBudgetEvaluation => {
  const exceeded = freezeExceeded(result.exceeded);
  return Object.freeze({
    passed: result.passed,
    exceeded,
    reason: result.reason,
    ...(result.budget === undefined ? {} : { budget: result.budget }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  });
};

const freezeExceeded = (
  exceeded: readonly StageBudgetExceededLimit[],
): readonly StageBudgetExceededLimit[] =>
  Object.freeze(exceeded.map((limit) => Object.freeze(limit)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
