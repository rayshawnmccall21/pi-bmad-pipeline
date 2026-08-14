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
import {
  registerPayloadGate,
  type PayloadGate,
  type PayloadGateContext,
  type PayloadGateResult,
} from "../rundef/index.js";
import { codeReviewLenientGate } from "./code-review-lenient.js";

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
 * @param context - Optional active story identity.
 *
 * @returns Pass only for verdict "pass"; "fail" carries failed/partial scenario
 * ids as findings; any other shape fails closed.
 *
 * @example
 * ```ts
 * const result = e2eVerifyPayloadGate({ verdict: "pass" });
 * ```
 */
export const e2eVerifyPayloadGate: PayloadGate = (payload, context) => {
  const identityFailure = storyIdentityFailure(payload, context);
  if (identityFailure !== undefined) {
    return identityFailure;
  }
  const verdict = payload["verdict"];
  if (verdict === "pass") {
    return e2ePassResult(payload);
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
 * @param context - Optional active story identity.
 *
 * @returns Pass only for verdict "approved"; "needs-dev" and "needs-verify"
 * carry a severity summary as findings; any other shape fails closed.
 *
 * @example
 * ```ts
 * const result = codeReviewPayloadGate({ verdict: "approved" });
 * ```
 */
export const codeReviewPayloadGate: PayloadGate = (payload, context) => {
  const identityFailure = storyIdentityFailure(payload, context);
  if (identityFailure !== undefined) {
    return identityFailure;
  }
  const verdict = payload["verdict"];
  if (verdict === "approved") {
    return codeReviewApprovalResult(payload);
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

  // Register lenient code-review gate — passes on 0 critical + 0 high
  // Use gate: code-review-lenient in pipeline YAML to use this instead of the strict gate
  registerPayloadGate("code-review-lenient", codeReviewLenientGate);
  return Object.freeze({
    registered: Object.freeze([E2E_VERIFY_PAYLOAD_GATE_NAME, CODE_REVIEW_PAYLOAD_GATE_NAME]),
  });
}

const storyIdentityFailure = (
  payload: Record<string, unknown>,
  context: PayloadGateContext | undefined,
): PayloadGateResult | undefined =>
  context !== undefined && payload["storyId"] !== context.storyId
    ? failedResult(
        `Payload story identity ${JSON.stringify(payload["storyId"] ?? null)} does not match active story ${JSON.stringify(context.storyId)}.`,
        [],
      )
    : undefined;

const e2ePassResult = (payload: Record<string, unknown>): PayloadGateResult => {
  if (!isValidE2ePassPayload(payload)) {
    return failedResult("E2E pass payload is malformed; failing closed.", []);
  }
  const contradictory =
    countOf(payload, "scenariosFailed") !== 0 ||
    stringList(payload, "failedScenarioIds").length !== 0 ||
    stringList(payload, "partialScenarioIds").length !== 0;
  return contradictory
    ? failedResult("E2E pass verdict contradicts reported failed or partial scenarios.", [])
    : Object.freeze({ passed: true, reason: "E2E verification passed." });
};

const codeReviewApprovalResult = (payload: Record<string, unknown>): PayloadGateResult => {
  if (!isValidCodeReviewApprovalPayload(payload)) {
    return failedResult("Code review approval payload is malformed; failing closed.", []);
  }
  const counts = payload["findingsBySeverity"];
  const contradictory =
    !isRecord(counts) ||
    CODE_REVIEW_SEVERITIES.some((severity) => countOf(counts, severity) !== 0) ||
    stringList(payload, "findings").length !== 0;
  return contradictory
    ? failedResult("Code review approval contradicts reported findings.", severityFindings(payload))
    : Object.freeze({ passed: true, reason: "Code review approved." });
};

const failedResult = (reason: string, findings: readonly string[]): PayloadGateResult =>
  findings.length === 0
    ? Object.freeze({ passed: false, reason })
    : Object.freeze({ passed: false, reason, findings: Object.freeze([...findings]) });

const failClosed = (gate: string, verdict: unknown): PayloadGateResult =>
  Object.freeze({
    passed: false,
    reason: `Unrecognized ${gate} verdict ${JSON.stringify(verdict ?? null)}; failing closed.`,
  });

const E2E_VERIFY_PAYLOAD_KEYS = Object.freeze([
  "storyId",
  "scenariosPassed",
  "scenariosFailed",
  "failedScenarioIds",
  "partialScenarioIds",
  "verdict",
] as const);

const CODE_REVIEW_PAYLOAD_KEYS = Object.freeze([
  "storyId",
  "verdict",
  "findingsBySeverity",
  "autoFixed",
] as const);

/** Canonical version stamp of the v2 code-review payload envelope. */
const CODE_REVIEW_PAYLOAD_VERSION_V2 = "pi-bmad.code-review.payload.v2" as const;

/** V2 code-review envelope keys: the four v1 keys plus findings and payloadVersion. */
const CODE_REVIEW_V2_PAYLOAD_KEYS = Object.freeze([
  ...CODE_REVIEW_PAYLOAD_KEYS,
  "findings",
  "payloadVersion",
] as const);

const isValidE2ePassPayload = (payload: Record<string, unknown>): boolean =>
  hasExactKeys(payload, E2E_VERIFY_PAYLOAD_KEYS) &&
  isNonEmptyString(payload["storyId"]) &&
  isNonNegativeInteger(payload["scenariosPassed"]) &&
  isNonNegativeInteger(payload["scenariosFailed"]) &&
  isStringList(payload["failedScenarioIds"]) &&
  isStringList(payload["partialScenarioIds"]);

const isValidCodeReviewApprovalPayload = (payload: Record<string, unknown>): boolean => {
  const counts = payload["findingsBySeverity"];
  return (
    isApprovalShape(payload) &&
    isNonEmptyString(payload["storyId"]) &&
    typeof payload["autoFixed"] === "boolean" &&
    isRecord(counts) &&
    hasExactKeys(counts, CODE_REVIEW_SEVERITIES) &&
    CODE_REVIEW_SEVERITIES.every((severity) => isNonNegativeInteger(counts[severity]))
  );
};

/**
 * Checks the payload approval envelope shape.
 *
 * @param payload - Validated code-review workflow payload.
 *
 * @returns True for the exact v1 four-key shape or the exact v2 six-key
 * shape with the canonical version stamp and a string-list findings field.
 */
const isApprovalShape = (payload: Record<string, unknown>): boolean => {
  if (hasExactKeys(payload, CODE_REVIEW_PAYLOAD_KEYS)) {
    return true;
  }
  return (
    hasExactKeys(payload, CODE_REVIEW_V2_PAYLOAD_KEYS) &&
    payload["payloadVersion"] === CODE_REVIEW_PAYLOAD_VERSION_V2 &&
    isStringList(payload["findings"])
  );
};

const hasExactKeys = (
  payload: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(payload);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

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
