import type { CompiledStageDef } from "../rundef/index.js";
import type { BudgetUsage } from "./budgets.js";

/** Minimal validated child output shape needed by gate evaluation. */
export interface StageDecisionOutput {
  /** Validated payload from HeadlessWorkflowOutput. */
  readonly payload: Record<string, unknown>;
}

/** Minimal execution result shape needed by gate evaluation. */
export interface StageDecisionExecutionResult {
  /** Validated child output, or null when no valid output was produced. */
  readonly output: StageDecisionOutput | null;

  /** Child process exit code, or null when no process exit code exists. */
  readonly exitCode: number | null;

  /** Stage duration in milliseconds. */
  readonly durationMs: number;

  /** Optional JSONL parse error. */
  readonly parseError?: string;

  /** Optional usage reported by the child execution. */
  readonly usage?: BudgetUsage;

  /** True when the stage timed out. */
  readonly timedOut?: boolean;

  /** True when the stage was aborted by the supervisor. */
  readonly aborted?: boolean;
}

/** Terminal decision kind for one stage execution. */
export type StageDecisionKind =
  "passed" | "failed" | "timed-out" | "aborted" | "parse-error" | "gate-failed";

/** Request for checking one stage execution. */
export interface CheckStageDecisionRequest {
  /** Compiled stage definition. */
  readonly stage: Pick<CompiledStageDef, "id" | "payloadGate" | "payloadGateName">;

  /** Execution result returned by the stage executor. */
  readonly result: StageDecisionExecutionResult;
}

/** Pure gate decision for one stage execution. */
export interface StageDecision {
  /** Stage id. */
  readonly stageId: string;

  /** Terminal decision kind. */
  readonly kind: StageDecisionKind;

  /** True only when the execution and optional payload gate passed. */
  readonly passed: boolean;

  /** Human-readable audit reason. */
  readonly reason: string;

  /** Optional findings emitted by a failed payload gate. */
  readonly findings?: readonly string[];

  /** Usage copied from the execution result when present. */
  readonly usage?: BudgetUsage;
}

/**
 * Checks one stage execution result and optional payload gate.
 *
 * @param request - Compiled stage and execution result to evaluate.
 *
 * @returns Frozen stage decision.
 *
 * @example
 * ```ts
 * const decision = checkStageDecision({ stage, result });
 * ```
 */
export function checkStageDecision(request: CheckStageDecisionRequest): StageDecision {
  const failure = checkExecutionFailure(request);
  if (failure !== undefined) {
    return failure;
  }
  if (request.result.output === null) {
    return missingOutputDecision(request);
  }
  const gate = request.stage.payloadGate;
  if (gate === undefined) {
    return passedWithoutGate(request);
  }
  return checkPayloadGate(request, gate, request.result.output.payload);
}

const checkExecutionFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  abortedFailure(request) ??
  timedOutFailure(request) ??
  parseFailure(request) ??
  missingOutputFailure(request) ??
  exitFailure(request);

const abortedFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.aborted === true
    ? failure(request, "aborted", `Stage "${request.stage.id}" was aborted.`)
    : undefined;

const timedOutFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.timedOut === true
    ? failure(request, "timed-out", `Stage "${request.stage.id}" timed out.`)
    : undefined;

const parseFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.parseError === undefined
    ? undefined
    : failure(
        request,
        "parse-error",
        `Stage "${request.stage.id}" produced invalid JSONL: ${request.result.parseError}`,
      );

const missingOutputFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.output === null ? missingOutputDecision(request) : undefined;

const missingOutputDecision = (request: CheckStageDecisionRequest): StageDecision =>
  failure(request, "failed", `Stage "${request.stage.id}" did not produce validated output.`);

const exitFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.exitCode === 0
    ? undefined
    : failure(request, "failed", exitReason(request.stage.id, request.result.exitCode));

const passedWithoutGate = (request: CheckStageDecisionRequest): StageDecision =>
  freezeDecision({
    stageId: request.stage.id,
    kind: "passed",
    passed: true,
    reason: `Stage "${request.stage.id}" passed without a payload gate.`,
    ...usageField(request.result.usage),
  });

const checkPayloadGate = (
  request: CheckStageDecisionRequest,
  gate: NonNullable<CheckStageDecisionRequest["stage"]["payloadGate"]>,
  payload: Record<string, unknown>,
): StageDecision => {
  const gateResult = gate(payload);
  const gateName = request.stage.payloadGateName ?? "unnamed";
  const reason =
    gateResult.reason ??
    `Stage "${request.stage.id}" payload gate "${gateName}" ${gateResult.passed ? "passed" : "failed"}.`;
  return freezeDecision({
    stageId: request.stage.id,
    kind: gateResult.passed ? "passed" : "gate-failed",
    passed: gateResult.passed,
    reason,
    ...usageField(request.result.usage),
    ...(gateResult.findings === undefined ? {} : { findings: [...gateResult.findings] }),
  });
};

const failure = (
  request: CheckStageDecisionRequest,
  kind: Exclude<StageDecisionKind, "passed">,
  reason: string,
): StageDecision =>
  freezeDecision({
    stageId: request.stage.id,
    kind,
    passed: false,
    reason,
    ...usageField(request.result.usage),
  });

const exitReason = (stageId: string, exitCode: number | null): string =>
  exitCode === null
    ? `Stage "${stageId}" exited without an exit code.`
    : `Stage "${stageId}" exited with code ${String(exitCode)}.`;

const usageField = (usage: BudgetUsage | undefined): Partial<Pick<StageDecision, "usage">> =>
  usage === undefined ? {} : { usage: copyUsage(usage) };

const copyUsage = (usage: BudgetUsage): BudgetUsage =>
  Object.freeze({ tokens: usage.tokens, dollars: usage.dollars });

const freezeDecision = (decision: StageDecision): StageDecision =>
  Object.freeze({
    stageId: decision.stageId,
    kind: decision.kind,
    passed: decision.passed,
    reason: decision.reason,
    ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    ...(decision.findings === undefined ? {} : { findings: Object.freeze([...decision.findings]) }),
  });
