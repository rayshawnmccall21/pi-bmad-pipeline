import type { CompiledStageDef } from "../rundef/index.js";
import type { StageDecision } from "./stage-decision.js";

/** Routing action after one stage decision. */
export type StageRouteAction = "continue" | "regress" | "complete" | "fail";

/** Terminal failure reason category for route failures. */
export type StageRouteFailureCode =
  | "stage-failed"
  | "gate-failed-without-on-fail"
  | "on-fail-target-missing"
  | "on-fail-target-not-earlier"
  | "regression-limit-exceeded";

/** Request for routing after a stage decision. */
export interface RouteStageDecisionRequest {
  /** Compiled stages in execution order. */
  readonly stages: readonly CompiledStageDef[];

  /** Stage that just completed. */
  readonly stage: CompiledStageDef;

  /** Decision produced for the stage. */
  readonly decision: StageDecision;

  /** Number of regressions already performed before this decision. */
  readonly regressions: number;

  /** Maximum allowed regressions before failing closed. */
  readonly maxRegressions: number;
}

/** Pure route decision after one stage. */
export interface StageRouteDecision {
  /** Routing action. */
  readonly action: StageRouteAction;

  /** Stage that produced the decision. */
  readonly fromStageId: string;

  /** Next stage id when action is continue or regress. */
  readonly nextStageId?: string;

  /** Updated regression count. */
  readonly regressions: number;

  /** Human-readable sanitized reason. */
  readonly reason: string;

  /** Failure code when action is fail. */
  readonly failureCode?: StageRouteFailureCode;
}

/**
 * Routes one completed stage decision.
 *
 * @param request - Stage routing request.
 *
 * @returns Frozen route decision.
 *
 * @example
 * ```ts
 * const route = routeStageDecision({ stages, stage, decision, regressions: 0, maxRegressions: 3 });
 * ```
 */
export function routeStageDecision(request: RouteStageDecisionRequest): StageRouteDecision {
  validateCounters(request);
  if (request.decision.passed) {
    return passedRoute(request);
  }
  if (request.decision.kind !== "gate-failed") {
    return fail(
      request,
      "stage-failed",
      `Stage "${request.stage.id}" failed: ${request.decision.reason}`,
    );
  }
  return gateFailedRoute(request);
}

/**
 * Finds the next stage after the current stage.
 *
 * @param stages - Compiled stages in execution order.
 * @param stageId - Current stage id.
 *
 * @returns The next stage, or undefined when the current stage is last or absent.
 *
 * @example
 * ```ts
 * const next = findNextStage(stages, "dev-story");
 * ```
 */
export function findNextStage(
  stages: readonly CompiledStageDef[],
  stageId: string,
): CompiledStageDef | undefined {
  const index = stages.findIndex((stage) => stage.id === stageId);
  return index < 0 ? undefined : stages[index + 1];
}

/**
 * Finds a stage by id.
 *
 * @param stages - Compiled stages.
 * @param stageId - Stage id to find.
 *
 * @returns The stage, or undefined when absent.
 *
 * @example
 * ```ts
 * const stage = findStageById(stages, "dev-story");
 * ```
 */
export function findStageById(
  stages: readonly CompiledStageDef[],
  stageId: string,
): CompiledStageDef | undefined {
  return stages.find((stage) => stage.id === stageId);
}

const passedRoute = (request: RouteStageDecisionRequest): StageRouteDecision => {
  const next = findNextStage(request.stages, request.stage.id);
  return next === undefined
    ? complete(request)
    : route({
        action: "continue",
        fromStageId: request.stage.id,
        nextStageId: next.id,
        regressions: request.regressions,
        reason: `Stage "${request.stage.id}" passed; continuing to "${next.id}".`,
      });
};

const complete = (request: RouteStageDecisionRequest): StageRouteDecision =>
  route({
    action: "complete",
    fromStageId: request.stage.id,
    regressions: request.regressions,
    reason: `Stage "${request.stage.id}" passed; pipeline stages are complete.`,
  });

const gateFailedRoute = (request: RouteStageDecisionRequest): StageRouteDecision =>
  missingOnFail(request) ?? invalidOnFail(request) ?? regressionLimit(request) ?? regress(request);

const missingOnFail = (request: RouteStageDecisionRequest): StageRouteDecision | undefined =>
  request.stage.onFail === undefined
    ? fail(
        request,
        "gate-failed-without-on-fail",
        `Stage "${request.stage.id}" gate failed without onFail.`,
      )
    : undefined;

const invalidOnFail = (request: RouteStageDecisionRequest): StageRouteDecision | undefined => {
  const target = findStageById(request.stages, request.stage.onFail ?? "");
  if (target === undefined) {
    return fail(
      request,
      "on-fail-target-missing",
      `Stage "${request.stage.id}" onFail target is missing.`,
    );
  }
  return target.index >= request.stage.index
    ? fail(
        request,
        "on-fail-target-not-earlier",
        `Stage "${request.stage.id}" onFail target is not earlier.`,
      )
    : undefined;
};

const regressionLimit = (request: RouteStageDecisionRequest): StageRouteDecision | undefined =>
  request.regressions >= request.maxRegressions
    ? fail(
        request,
        "regression-limit-exceeded",
        `Stage "${request.stage.id}" regression limit exceeded.`,
      )
    : undefined;

const regress = (request: RouteStageDecisionRequest): StageRouteDecision => {
  const nextStageId = request.stage.onFail;
  if (nextStageId === undefined) {
    return (
      missingOnFail(request) ?? fail(request, "gate-failed-without-on-fail", "Missing onFail.")
    );
  }
  return route({
    action: "regress",
    fromStageId: request.stage.id,
    nextStageId,
    regressions: request.regressions + 1,
    reason: `Stage "${request.stage.id}" gate failed; regressing to "${nextStageId}".`,
  });
};

const fail = (
  request: RouteStageDecisionRequest,
  failureCode: StageRouteFailureCode,
  reason: string,
): StageRouteDecision =>
  route({
    action: "fail",
    fromStageId: request.stage.id,
    regressions: request.regressions,
    failureCode,
    reason,
  });

const route = (decision: StageRouteDecision): StageRouteDecision => Object.freeze(decision);

const validateCounters = (request: RouteStageDecisionRequest): void => {
  validateNonNegativeInteger(request.regressions, "regressions");
  validateNonNegativeInteger(request.maxRegressions, "maxRegressions");
};

const validateNonNegativeInteger = (value: number, field: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer.`);
  }
};
