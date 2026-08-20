/** Fail-closed code-review gate that blocks only on critical findings. */
import type { PayloadGate, PayloadGateResult } from "../rundef/index.js";

/** Public registry name for the critical-only code-review gate. */
export const CODE_REVIEW_CRITICAL_ONLY_GATE_NAME = "code-review-critical-only" as const;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const V1_KEYS = ["storyId", "verdict", "findingsBySeverity", "autoFixed"] as const;
const V2_KEYS = [...V1_KEYS, "findings", "payloadVersion"] as const;
const V2_VERSION = "pi-bmad.code-review.payload.v2" as const;
const VERDICTS = ["approved", "needs-dev", "needs-verify"] as const;

type Severity = (typeof SEVERITIES)[number];
type SeverityCounts = Readonly<Record<Severity, number>>;

interface StructuredFindingLocation {
  readonly path: string;
  readonly line: number;
}

interface StructuredFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly locations: readonly StructuredFindingLocation[];
  readonly requiredAction: string;
}

const FINDING_KEYS = ["id", "severity", "title", "locations", "requiredAction"] as const;
const LOCATION_KEYS = ["path", "line"] as const;
const MAX_FINDINGS = 50;
const MAX_LOCATIONS = 20;
const MAX_TITLE_CODE_POINTS = 1024;
const MAX_REQUIRED_ACTION_CODE_POINTS = 2048;
const MAX_LOCATION_PATH_CODE_POINTS = 512;
const MAX_TITLE_UTF8_BYTES = 2048;
const MAX_REQUIRED_ACTION_UTF8_BYTES = 4096;
const MAX_SERIALIZED_PAYLOAD_UTF8_BYTES = 262_144;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length && actualKeys.every((actualKey) => keys.includes(actualKey))
  );
};

const isBoundedString = (value: unknown, maximumCodePoints: number): value is string =>
  typeof value === "string" && Array.from(value).length <= maximumCodePoints;

const isStructuredFindingLocation = (value: unknown): value is StructuredFindingLocation =>
  isRecord(value) &&
  hasExactKeys(value, LOCATION_KEYS) &&
  isBoundedString(value["path"], MAX_LOCATION_PATH_CODE_POINTS) &&
  typeof value["line"] === "number" &&
  Number.isInteger(value["line"]) &&
  value["line"] >= 1;

const hasStructuredFindingFields = (value: Record<string, unknown>): boolean =>
  typeof value["id"] === "string" &&
  SEVERITIES.some((severity) => value["severity"] === severity) &&
  isBoundedString(value["title"], MAX_TITLE_CODE_POINTS) &&
  isBoundedString(value["requiredAction"], MAX_REQUIRED_ACTION_CODE_POINTS);

const hasStructuredFindingLocations = (value: Record<string, unknown>): boolean => {
  const locations = value["locations"];
  return (
    isUnknownList(locations) &&
    locations.length <= MAX_LOCATIONS &&
    [...locations].every(isStructuredFindingLocation)
  );
};

const isStructuredFinding = (value: unknown): value is StructuredFinding =>
  isRecord(value) &&
  hasExactKeys(value, FINDING_KEYS) &&
  hasStructuredFindingFields(value) &&
  hasStructuredFindingLocations(value);

const isStructuredFindingList = (value: unknown): value is readonly StructuredFinding[] =>
  isUnknownList(value) && value.length <= MAX_FINDINGS && [...value].every(isStructuredFinding);

const hasProducerV2Bounds = (payload: Record<string, unknown>): boolean => {
  const findings = payload["findings"];
  if (!isStructuredFindingList(findings)) {
    return false;
  }
  try {
    return (
      findings.every(
        (finding) =>
          Buffer.byteLength(finding.title, "utf8") <= MAX_TITLE_UTF8_BYTES &&
          Buffer.byteLength(finding.requiredAction, "utf8") <= MAX_REQUIRED_ACTION_UTF8_BYTES,
      ) && Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_SERIALIZED_PAYLOAD_UTF8_BYTES
    );
  } catch {
    return false;
  }
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isCanonicalEnvelope = (payload: Record<string, unknown>): boolean =>
  hasExactKeys(payload, V1_KEYS) ||
  (hasExactKeys(payload, V2_KEYS) &&
    payload["payloadVersion"] === V2_VERSION &&
    hasProducerV2Bounds(payload));

const severityCounts = (payload: Record<string, unknown>): SeverityCounts | undefined => {
  const counts = payload["findingsBySeverity"];
  if (
    !isRecord(counts) ||
    !hasExactKeys(counts, SEVERITIES) ||
    !isNonNegativeInteger(counts["critical"]) ||
    !isNonNegativeInteger(counts["high"]) ||
    !isNonNegativeInteger(counts["medium"]) ||
    !isNonNegativeInteger(counts["low"]) ||
    !isNonNegativeInteger(counts["info"])
  ) {
    return undefined;
  }
  return Object.freeze({
    critical: counts["critical"],
    high: counts["high"],
    medium: counts["medium"],
    low: counts["low"],
    info: counts["info"],
  });
};

const structuredFindingsMatchCounts = (
  payload: Record<string, unknown>,
  counts: SeverityCounts,
): boolean => {
  if (!hasExactKeys(payload, V2_KEYS)) {
    return true;
  }
  const findings = payload["findings"];
  return (
    isStructuredFindingList(findings) &&
    SEVERITIES.every(
      (severity) =>
        findings.filter((finding) => finding.severity === severity).length === counts[severity],
    )
  );
};

const hasCanonicalReviewFields = (payload: Record<string, unknown>): boolean =>
  typeof payload["storyId"] === "string" &&
  payload["storyId"].length > 0 &&
  VERDICTS.some((verdict) => payload["verdict"] === verdict) &&
  typeof payload["autoFixed"] === "boolean";

const canonicalCounts = (payload: Record<string, unknown>): SeverityCounts | undefined => {
  if (!isCanonicalEnvelope(payload) || !hasCanonicalReviewFields(payload)) {
    return undefined;
  }
  const counts = severityCounts(payload);
  return counts !== undefined && structuredFindingsMatchCounts(payload, counts)
    ? counts
    : undefined;
};

const failure = (reason: string, findings?: readonly string[]): PayloadGateResult =>
  findings === undefined
    ? Object.freeze({ passed: false, reason })
    : Object.freeze({ passed: false, reason, findings: Object.freeze([...findings]) });

const findingDetails = (payload: Record<string, unknown>): readonly string[] => {
  const findings = payload["findings"];
  if (!isStructuredFindingList(findings)) {
    return [];
  }
  return findings.map((finding) => {
    const locations = finding.locations
      .map(({ path, line }) => `${path}:${String(line)}`)
      .join(", ");
    return `[${finding.severity}] ${finding.id}: ${finding.title} (${locations}) Required action: ${finding.requiredAction}`;
  });
};

const storyIdentityFailure = (
  payload: Record<string, unknown>,
  activeStoryId: string | undefined,
): PayloadGateResult | undefined =>
  activeStoryId !== undefined && payload["storyId"] !== activeStoryId
    ? failure(
        `Payload story identity ${JSON.stringify(payload["storyId"])} does not match active story ${JSON.stringify(activeStoryId)}.`,
      )
    : undefined;

/**
 * Evaluates an exact canonical v1/v2 code-review envelope.
 *
 * @param payload - Authenticated code-review result payload.
 * @param context - Optional active story identity.
 *
 * @returns A frozen result that passes only when the envelope is valid and its critical count is zero.
 */
export const codeReviewCriticalOnlyGate: PayloadGate = (payload, context) => {
  const counts = canonicalCounts(payload);
  if (counts === undefined) {
    return failure("Code review payload is malformed; failing closed.");
  }
  const identityFailure = storyIdentityFailure(payload, context?.storyId);
  if (identityFailure !== undefined) {
    return identityFailure;
  }
  if (counts.critical === 0) {
    return Object.freeze({ passed: true, reason: "Code review has no critical findings." });
  }

  const summary = `Findings by severity: ${SEVERITIES.map(
    (severity) => `${severity}=${String(counts[severity])}`,
  ).join(", ")}.`;
  return failure("Code review has critical findings.", [summary, ...findingDetails(payload)]);
};
