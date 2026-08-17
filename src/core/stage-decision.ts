import type { CompiledStageDef, PayloadGate } from "../rundef/index.js";
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

  /** Bounded, already-redacted failure diagnostic from the executor. */
  readonly diagnostic?: string;

  /** Findings lifted from a code stage's findings file on exit 1 (v1.1). */
  readonly findings?: readonly string[];

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
  readonly stage: Pick<CompiledStageDef, "id" | "kind"> & {
    readonly payloadGateName?: string;
    readonly payloadGate?: PayloadGate;
  };

  /** Story id being supervised by the active run. */
  readonly storyId?: string;

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

  /** Human-readable decision reason. */
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
    return passedWithoutGate(request);
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
  codeGateFailure(request) ??
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
  request.stage.kind === "agent" && request.result.output === null
    ? missingOutputDecision(request)
    : undefined;

const missingOutputDecision = (request: CheckStageDecisionRequest): StageDecision =>
  failure(request, "failed", `Stage "${request.stage.id}" did not produce validated output.`);

/**
 * Applies the v1.1 code-stage gate: the exit code is the gate.
 *
 * Exit 1 with lifted findings becomes "gate-failed" (routable via onFail).
 * Exit 1 without findings is fail-closed terminal, so an empty-findings
 * regress is never manufactured. Exit codes of two or greater fall
 * through to the terminal exit failure.
 *
 * @param request - Compiled stage and execution result to evaluate.
 *
 * @returns A gate decision for code-stage exit 1, or undefined otherwise.
 */
const codeGateFailure = (request: CheckStageDecisionRequest): StageDecision | undefined => {
  if (request.stage.kind !== "code" || request.result.exitCode !== 1) {
    return undefined;
  }
  const findings = request.result.findings;
  if (findings === undefined || findings.length === 0) {
    return failure(
      request,
      "failed",
      `Stage "${request.stage.id}" exited with code 1 but no valid findings ` +
        "file was lifted; failing closed instead of regressing empty.",
    );
  }
  return freezeDecision({
    stageId: request.stage.id,
    kind: "gate-failed",
    passed: false,
    reason:
      `Stage "${request.stage.id}" code gate failed with ` +
      `${String(findings.length)} findings.`,
    ...usageField(request.result.usage),
    findings: [...findings],
  });
};

const exitFailure = (request: CheckStageDecisionRequest): StageDecision | undefined =>
  request.result.exitCode === 0
    ? undefined
    : failure(
        request,
        "failed",
        exitReason(request.stage.id, request.result.exitCode, request.result.diagnostic),
      );

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
  const gateResult = gate(payload, payloadGateContext(request.storyId));
  return freezeDecision({
    stageId: request.stage.id,
    kind: gateResult.passed ? "passed" : "gate-failed",
    passed: gateResult.passed,
    reason: payloadGateReason(request, gateResult),
    ...usageField(request.result.usage),
    ...findingsField(gateResult.findings),
  });
};

const payloadGateContext = (
  storyId: string | undefined,
): { readonly storyId: string } | undefined => (storyId === undefined ? undefined : { storyId });

const payloadGateReason = (
  request: CheckStageDecisionRequest,
  gateResult: ReturnType<NonNullable<CheckStageDecisionRequest["stage"]["payloadGate"]>>,
): string =>
  gateResult.reason ??
  `Stage "${request.stage.id}" payload gate "${request.stage.payloadGateName ?? "unnamed"}" ${gateResult.passed ? "passed" : "failed"}.`;

const findingsField = (
  findings: readonly string[] | undefined,
): Partial<Pick<StageDecision, "findings">> =>
  findings === undefined ? {} : { findings: [...findings] };

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

const exitReason = (
  stageId: string,
  exitCode: number | null,
  diagnostic: string | undefined,
): string => {
  const reason =
    exitCode === null
      ? `Stage "${stageId}" exited without an exit code.`
      : `Stage "${stageId}" exited with code ${String(exitCode)}.`;
  return diagnostic === undefined || diagnostic.length === 0 ? reason : `${reason} ${diagnostic}`;
};

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
