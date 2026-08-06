/**
 * Built-in BMAD payload gates.
 *
 * Each gate is policy over ONE canonical pi-bmad result contract
 * (content/schemas/e2e-verify-result.schema.json and
 * code-review-result.schema.json). Verdict vocabularies are the schemas'
 * literal enums — no fuzzy field sniffing — and unknown shapes fail closed.
 *
 * @packageDocumentation
 */
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

/** Severity keys of the canonical code-review findings summary, worst first. */
export const CODE_REVIEW_SEVERITIES = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const);

/**
 * Evaluates the canonical e2e-verify result payload.
 *
 * @param payload - Validated e2e-verify workflow payload.
 *
 * @returns Pass only for verdict "pass"; "fail" carries failed/partial scenario
 * ids as findings; any other shape fails closed.
 *
 * @example
 * ```ts
 * const result = e2eVerifyPayloadGate({ verdict: "pass" });
 * ```
 */
export const e2eVerifyPayloadGate: PayloadGate = (payload) => {
  const verdict = payload["verdict"];
  if (verdict === "pass") {
    return Object.freeze({ passed: true, reason: "E2E verification passed." });
  }
  if (verdict === "fail") {
    return failedResult(
      `E2E verification failed (${String(countOf(payload, "scenariosFailed"))} scenario(s) failed).`,
      scenarioFindings(payload),
    );
  }
  return failClosed("e2e-verify", verdict);
};

/**
 * Evaluates the canonical code-review result payload.
 *
 * @param payload - Validated code-review workflow payload.
 *
 * @returns Pass only for verdict "approved"; "needs-dev" and "needs-verify"
 * carry a severity summary as findings; any other shape fails closed.
 *
 * @example
 * ```ts
 * const result = codeReviewPayloadGate({ verdict: "approved" });
 * ```
 */
export const codeReviewPayloadGate: PayloadGate = (payload) => {
  const verdict = payload["verdict"];
  if (verdict === "approved") {
    return Object.freeze({ passed: true, reason: "Code review approved." });
  }
  if (verdict === "needs-dev" || verdict === "needs-verify") {
    return failedResult(`Code review verdict: ${verdict}.`, severityFindings(payload));
  }
  return failClosed("code-review", verdict);
};

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

const failedResult = (reason: string, findings: readonly string[]): PayloadGateResult =>
  findings.length === 0
    ? Object.freeze({ passed: false, reason })
    : Object.freeze({ passed: false, reason, findings: Object.freeze([...findings]) });

const failClosed = (gate: string, verdict: unknown): PayloadGateResult =>
  Object.freeze({
    passed: false,
    reason: `Unrecognized ${gate} verdict ${JSON.stringify(verdict ?? null)}; failing closed.`,
  });

const countOf = (payload: Record<string, unknown>, field: string): number => {
  const value = payload[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
};

const stringList = (payload: Record<string, unknown>, field: string): readonly string[] => {
  const value = payload[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
};

const scenarioFindings = (payload: Record<string, unknown>): readonly string[] => [
  ...stringList(payload, "failedScenarioIds").map((id) => `Failed scenario: ${id}`),
  ...stringList(payload, "partialScenarioIds").map((id) => `Partial scenario: ${id}`),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const severityFindings = (payload: Record<string, unknown>): readonly string[] => {
  const counts = payload["findingsBySeverity"];
  if (!isRecord(counts)) {
    return [];
  }
  const parts = CODE_REVIEW_SEVERITIES.map(
    (severity) => `${severity}=${String(countOf(counts, severity))}`,
  );
  return [`Findings by severity: ${parts.join(", ")}.`];
};
