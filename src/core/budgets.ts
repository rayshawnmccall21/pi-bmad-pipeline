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
  const budget = cloneBudget(request.stage.budget);
  if (budget === undefined) {
    return freezeResult({
      stageId: request.stage.id,
      passed: true,
      exceeded: [],
      reason: `Stage "${request.stage.id}" has no budget ceiling.`,
    });
  }
  if (!isBudgetUsage(request.usage)) {
    return freezeResult({
      stageId: request.stage.id,
      passed: false,
      budget,
      exceeded: [],
      reason: `Stage "${request.stage.id}" has a budget ceiling but no valid usage was reported.`,
    });
  }
  return evaluateWithUsage(request.stage.id, budget, cloneUsage(request.usage));
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

const evaluateWithUsage = (
  stageId: string,
  budget: StageBudget,
  usage: BudgetUsage,
): StageBudgetEvaluation => {
  const exceeded = getExceededLimits(budget, usage);
  return freezeResult({
    stageId,
    passed: exceeded.length === 0,
    budget,
    usage,
    exceeded,
    reason:
      exceeded.length === 0
        ? `Stage "${stageId}" stayed within budget.`
        : exceededReason(stageId, exceeded),
  });
};

const getExceededLimits = (
  budget: StageBudget,
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

const exceededReason = (stageId: string, exceeded: readonly StageBudgetExceededLimit[]): string =>
  `Stage "${stageId}" exceeded budget: ${exceeded.map(formatExceededLimit).join(", ")}.`;

const formatExceededLimit = (limit: StageBudgetExceededLimit): string =>
  `${limit.kind} ${String(limit.actual)} > ${String(limit.limit)}`;

const cloneBudget = (budget: StageBudget | undefined): StageBudget | undefined => {
  if (budget === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
    ...(budget.maxDollars === undefined ? {} : { maxDollars: budget.maxDollars }),
  });
};

const cloneUsage = (usage: BudgetUsage): BudgetUsage =>
  Object.freeze({ tokens: usage.tokens, dollars: usage.dollars });

const freezeResult = (result: StageBudgetEvaluation): StageBudgetEvaluation => {
  const exceeded = Object.freeze(result.exceeded.map((limit) => Object.freeze(limit)));
  return Object.freeze({
    stageId: result.stageId,
    passed: result.passed,
    exceeded,
    reason: result.reason,
    ...(result.budget === undefined ? {} : { budget: result.budget }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
