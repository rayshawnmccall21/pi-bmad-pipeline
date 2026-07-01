import { registerPayloadGate, type PayloadGate, type PayloadGateResult } from "../rundef/index.js";

/** Built-in payload gate name for E2E verification. */
export const E2E_VERIFY_PAYLOAD_GATE_NAME = "e2e-verify" as const;

/** Built-in payload gate name for code review. */
export const CODE_REVIEW_PAYLOAD_GATE_NAME = "code-review" as const;

/** Built-in BMAD payload gate name. */
export type BmadPayloadGateName =
  typeof E2E_VERIFY_PAYLOAD_GATE_NAME | typeof CODE_REVIEW_PAYLOAD_GATE_NAME;

/** Built-in BMAD gate registration result. */
export interface RegisterBmadPayloadGatesResult {
  /** Gate names registered in deterministic order. */
  readonly registered: readonly BmadPayloadGateName[];
}

const verdictFields = ["passed", "success", "ok", "approved", "verdict", "status"] as const;
const findingFields = [
  "findings",
  "failures",
  "issues",
  "errors",
  "blockingIssues",
  "recommendations",
] as const;

const passingValues = new Set([
  "passed",
  "pass",
  "success",
  "successful",
  "approved",
  "ok",
  "clean",
]);
const failingValues = new Set([
  "failed",
  "fail",
  "failure",
  "error",
  "errors",
  "rejected",
  "blocked",
  "needs-work",
  "changes-requested",
]);

/**
 * Evaluates the E2E verification payload.
 *
 * @param payload - Validated e2e-verify workflow payload.
 *
 * @returns Payload gate result.
 *
 * @example
 * ```ts
 * const result = e2eVerifyPayloadGate({ passed: true });
 * ```
 */
export const e2eVerifyPayloadGate: PayloadGate = (payload) =>
  evaluatePayloadGate(payload, {
    passed: "E2E verification passed.",
    failed: "E2E verification failed.",
    unknown: "E2E verification payload did not include a recognized pass/fail verdict.",
  });

/**
 * Evaluates the code review payload.
 *
 * @param payload - Validated code-review workflow payload.
 *
 * @returns Payload gate result.
 *
 * @example
 * ```ts
 * const result = codeReviewPayloadGate({ approved: true });
 * ```
 */
export const codeReviewPayloadGate: PayloadGate = (payload) =>
  evaluatePayloadGate(payload, {
    passed: "Code review passed.",
    failed: "Code review failed.",
    unknown: "Code review payload did not include a recognized pass/fail verdict.",
  });

/**
 * Registers built-in BMAD payload gates in the module-level RunDef registry.
 *
 * @returns Frozen registration summary.
 *
 * @example
 * ```ts
 * registerBmadPayloadGates();
 * ```
 */
export function registerBmadPayloadGates(): RegisterBmadPayloadGatesResult {
  registerPayloadGate(E2E_VERIFY_PAYLOAD_GATE_NAME, e2eVerifyPayloadGate);
  registerPayloadGate(CODE_REVIEW_PAYLOAD_GATE_NAME, codeReviewPayloadGate);
  return Object.freeze({
    registered: Object.freeze([E2E_VERIFY_PAYLOAD_GATE_NAME, CODE_REVIEW_PAYLOAD_GATE_NAME]),
  });
}

type NormalizedVerdict = "passed" | "failed" | "unknown";

interface GateReasons {
  readonly passed: string;
  readonly failed: string;
  readonly unknown: string;
}

const evaluatePayloadGate = (
  payload: Record<string, unknown>,
  reasons: GateReasons,
): PayloadGateResult => {
  const verdict = normalizePayloadVerdict(payload);
  const result = buildGateResult(verdict, reasons);
  return withFindings(result, extractFindings(payload));
};

const buildGateResult = (verdict: NormalizedVerdict, reasons: GateReasons): PayloadGateResult => {
  if (verdict === "passed") {
    return Object.freeze({ passed: true, reason: reasons.passed });
  }
  return Object.freeze({
    passed: false,
    reason: verdict === "failed" ? reasons.failed : reasons.unknown,
  });
};

const normalizePayloadVerdict = (payload: Record<string, unknown>): NormalizedVerdict => {
  for (const field of verdictFields) {
    const verdict = normalizeVerdictValue(payload[field]);
    if (verdict !== "unknown") {
      return verdict;
    }
  }
  return "unknown";
};

const normalizeVerdictValue = (value: unknown): NormalizedVerdict => {
  if (value === true) {
    return "passed";
  }
  if (value === false) {
    return "failed";
  }
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase();
  return passingValues.has(normalized) ? "passed" : normalizeFailingString(normalized);
};

const normalizeFailingString = (value: string): NormalizedVerdict =>
  failingValues.has(value) ? "failed" : "unknown";

const extractFindings = (payload: Record<string, unknown>): readonly string[] | undefined => {
  for (const field of findingFields) {
    const value = payload[field];
    if (Array.isArray(value)) {
      const findings = value.filter((item): item is string => typeof item === "string");
      return findings.length === 0 ? undefined : Object.freeze([...findings]);
    }
  }
  return undefined;
};

const withFindings = (
  result: PayloadGateResult,
  findings: readonly string[] | undefined,
): PayloadGateResult => (findings === undefined ? result : Object.freeze({ ...result, findings }));
