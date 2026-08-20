import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { resolvePiBmadExtensionPath } from "../executors/pi/index.js";
import {
  clearPayloadGateRegistry,
  resolvePayloadGate,
  selectAndCompileRunDef,
} from "../rundef/index.js";
import {
  CODE_REVIEW_CRITICAL_ONLY_GATE_NAME,
  CODE_REVIEW_LENIENT_GATE_NAME,
  CODE_REVIEW_PAYLOAD_GATE_NAME,
  CODE_REVIEW_SEVERITIES,
  E2E_VERIFY_PAYLOAD_GATE_NAME,
  codeReviewCriticalOnlyGate,
  codeReviewLenientGate,
  codeReviewPayloadGate,
  e2eVerifyPayloadGate,
  registerBmadPayloadGates,
} from "./index.js";

const piBmadRootDir = resolve(dirname(resolvePiBmadExtensionPath()), "..");

const fixturePayload = (workflow: string, kind: string): Record<string, unknown> => {
  const line = readFileSync(
    join(piBmadRootDir, "contracts", "fixtures", workflow, `${kind}.jsonl`),
    "utf8",
  ).trim();
  const parsed = JSON.parse(line) as {
    result: { details: { headlessOutput: { payload: Record<string, unknown> } } };
  };
  return parsed.result.details.headlessOutput.payload;
};

type ReviewVerdict = "approved" | "needs-dev" | "needs-verify";
type ReviewSeverity = (typeof CODE_REVIEW_SEVERITIES)[number];

interface StructuredLocation {
  path: string;
  line: number;
}

interface StructuredFinding {
  id: string;
  severity: ReviewSeverity;
  title: string;
  locations: StructuredLocation[];
  requiredAction: string;
}

const zeroReviewCounts = (): Record<ReviewSeverity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

const reviewCountsFor = (severity: ReviewSeverity, count = 1): Record<ReviewSeverity, number> => ({
  ...zeroReviewCounts(),
  [severity]: count,
});

const structuredLocation = (
  index = 0,
  overrides: Partial<StructuredLocation> = {},
): StructuredLocation => ({
  path: `src/example-${String(index)}.ts`,
  line: index + 1,
  ...overrides,
});

const structuredLocations = (count: number): StructuredLocation[] =>
  Array.from({ length: count }, (_, index) => structuredLocation(index));

const structuredFinding = (
  severity: ReviewSeverity = "high",
  overrides: Partial<StructuredFinding> = {},
): StructuredFinding => ({
  id: `R1-${severity.toUpperCase()}-1`,
  severity,
  title: `${severity} review finding`,
  locations: [structuredLocation()],
  requiredAction: `Resolve the ${severity} finding.`,
  ...overrides,
});

const structuredV2ReviewPayload = (
  verdict: ReviewVerdict = "approved",
  findingsBySeverity: Record<ReviewSeverity, number> = zeroReviewCounts(),
  findings: unknown[] = [],
): Record<string, unknown> => ({
  storyId: "s-1",
  verdict,
  findingsBySeverity,
  autoFixed: false,
  findings,
  payloadVersion: "pi-bmad.code-review.payload.v2",
});

const withoutKey = (value: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));

const unicodeText = (codePoints: number): string => "💥".repeat(codePoints);

beforeEach(() => {
  clearPayloadGateRegistry();
});

describe("e2e-verify payload gate (canonical contract)", () => {
  it("passes the canonical success fixture", () => {
    expect(e2eVerifyPayloadGate(fixturePayload("e2e-verify", "success"))).toMatchObject({
      passed: true,
      reason: "E2E verification passed.",
    });
  });

  it("fails a schema-conformant fail verdict with scenario findings", () => {
    const result = e2eVerifyPayloadGate({
      storyId: "s-1",
      scenariosPassed: 2,
      scenariosFailed: 1,
      failedScenarioIds: ["AC-3"],
      partialScenarioIds: ["AC-4"],
      verdict: "fail",
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("E2E verification failed (1 scenario(s) failed).");
    expect(result.findings).toEqual(["Failed scenario: AC-3", "Partial scenario: AC-4"]);
  });

  it("fails closed when a pass verdict contradicts scenario failures", () => {
    const result = e2eVerifyPayloadGate({
      storyId: "s-1",
      scenariosPassed: 2,
      scenariosFailed: 1,
      failedScenarioIds: ["AC-3"],
      partialScenarioIds: [],
      verdict: "pass",
    });

    expect(result).toMatchObject({ passed: false, reason: expect.stringContaining("contradict") });
  });

  it.each([
    ["storyId", undefined],
    ["storyId", 1],
    ["scenariosPassed", undefined],
    ["scenariosPassed", "2"],
    ["scenariosFailed", undefined],
    ["scenariosFailed", "0"],
    ["failedScenarioIds", undefined],
    ["failedScenarioIds", [1]],
    ["partialScenarioIds", undefined],
    ["partialScenarioIds", [1]],
  ] as const)("fails closed when pass field %s has malformed value %j", (field, value) => {
    const payload: Record<string, unknown> = {
      storyId: "s-1",
      scenariosPassed: 2,
      scenariosFailed: 0,
      failedScenarioIds: [],
      partialScenarioIds: [],
      verdict: "pass",
      [field]: value,
    };

    expect(e2eVerifyPayloadGate(payload)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("malformed"),
    });
  });

  it("fails closed when a pass payload has an unknown root property", () => {
    const result = e2eVerifyPayloadGate({
      storyId: "s-1",
      scenariosPassed: 2,
      scenariosFailed: 0,
      failedScenarioIds: [],
      partialScenarioIds: [],
      verdict: "pass",
      unexpected: true,
    });

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringContaining("malformed"),
    });
  });

  it("fails closed when the payload belongs to another story", () => {
    const result = e2eVerifyPayloadGate(
      {
        storyId: "other-story",
        scenariosPassed: 2,
        scenariosFailed: 0,
        failedScenarioIds: [],
        partialScenarioIds: [],
        verdict: "pass",
      },
      { storyId: "s-1" },
    );

    expect(result).toMatchObject({ passed: false, reason: expect.stringContaining("story") });
  });

  it.each([{}, { verdict: "passed" }, { verdict: true }, { verdict: "ok" }])(
    "fails closed on non-contract payload %j",
    (payload) => {
      const result = e2eVerifyPayloadGate(payload);

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/failing closed/u);
    },
  );

  it("returns frozen results", () => {
    const result = e2eVerifyPayloadGate({ verdict: "fail", failedScenarioIds: ["AC-1"] });

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.findings === undefined || Object.isFrozen(result.findings)).toBe(true);
  });
});

describe("code-review payload gate (canonical contract)", () => {
  it("passes an approved canonical payload with zero findings", () => {
    expect(
      codeReviewPayloadGate({
        ...fixturePayload("code-review", "success"),
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      }),
    ).toMatchObject({ passed: true, reason: "Code review approved." });
  });

  it("fails a schema-conformant needs-dev verdict with a severity summary finding", () => {
    const result = codeReviewPayloadGate({
      storyId: "s-1",
      verdict: "needs-dev",
      findingsBySeverity: { critical: 0, high: 2, medium: 1, low: 0, info: 3 },
      autoFixed: false,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Code review verdict: needs-dev.");
    expect(result.findings?.[0]).toBe(
      "Findings by severity: critical=0, high=2, medium=1, low=0, info=3.",
    );
  });

  it("fails needs-verify with the verdict in the reason", () => {
    const result = codeReviewPayloadGate({ verdict: "needs-verify" });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Code review verdict: needs-verify.");
  });

  it.each([
    ["storyId", undefined],
    ["storyId", 1],
    ["autoFixed", undefined],
    ["autoFixed", "false"],
    ["findingsBySeverity", undefined],
    ["findingsBySeverity", []],
  ] as const)("fails closed when approval field %s has malformed value %j", (field, value) => {
    const payload: Record<string, unknown> = {
      storyId: "s-1",
      verdict: "approved",
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      autoFixed: false,
      [field]: value,
    };

    expect(codeReviewPayloadGate(payload)).toMatchObject({
      passed: false,
      reason: expect.stringContaining("malformed"),
    });
  });

  it.each(CODE_REVIEW_SEVERITIES)(
    "fails closed when approval severity %s is missing or the wrong type",
    (severity) => {
      const missingCounts = Object.fromEntries(
        CODE_REVIEW_SEVERITIES.filter((candidateSeverity) => candidateSeverity !== severity).map(
          (candidateSeverity) => [candidateSeverity, 0],
        ),
      );
      const wrongTypeCounts = { ...missingCounts, [severity]: "0" };
      const basePayload = { storyId: "s-1", verdict: "approved", autoFixed: false };

      expect(
        codeReviewPayloadGate({ ...basePayload, findingsBySeverity: missingCounts }),
      ).toMatchObject({ passed: false, reason: expect.stringContaining("malformed") });
      expect(
        codeReviewPayloadGate({ ...basePayload, findingsBySeverity: wrongTypeCounts }),
      ).toMatchObject({ passed: false, reason: expect.stringContaining("malformed") });
    },
  );

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ] as const)("fails closed when a structured-v2 severity count is %s", (_label, count) => {
    expect(
      codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", { ...zeroReviewCounts(), critical: count }),
      ),
    ).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    ["root", { unexpected: true }],
    [
      "findings summary",
      {
        findingsBySeverity: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          info: 0,
          blocker: 99,
        },
      },
    ],
  ] as const)("fails closed when an approval has an unknown %s property", (_location, extra) => {
    const result = codeReviewPayloadGate({
      storyId: "s-1",
      verdict: "approved",
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      autoFixed: false,
      ...extra,
    });

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringContaining("malformed"),
    });
  });

  it("fails closed when approval contradicts nonzero findings", () => {
    const result = codeReviewPayloadGate({
      storyId: "s-1",
      verdict: "approved",
      findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      autoFixed: false,
    });

    expect(result).toMatchObject({ passed: false, reason: expect.stringContaining("contradict") });
  });

  it("orders the severity summary worst-first per the canonical vocabulary", () => {
    const result = codeReviewPayloadGate({
      verdict: "needs-dev",
      findingsBySeverity: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
    });

    expect(CODE_REVIEW_SEVERITIES).toEqual(["critical", "high", "medium", "low", "info"]);
    expect(result.findings?.[0]).toBe(
      "Findings by severity: critical=1, high=2, medium=3, low=4, info=5.",
    );
  });

  it("omits findings when the severity summary is malformed", () => {
    const result = codeReviewPayloadGate({ verdict: "needs-dev", findingsBySeverity: [1, 2] });

    expect(result.passed).toBe(false);
    expect(result.findings).toBeUndefined();
  });

  it("passes the exact empty structured-v2 approved payload", () => {
    expect(codeReviewPayloadGate(structuredV2ReviewPayload())).toEqual({
      passed: true,
      reason: "Code review approved.",
    });
  });

  it("still passes a v1 approved payload with exactly the four canonical keys", () => {
    expect(
      codeReviewPayloadGate({
        storyId: "s-1",
        verdict: "approved",
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        autoFixed: false,
      }),
    ).toMatchObject({ passed: true, reason: "Code review approved." });
  });

  it.each(CODE_REVIEW_SEVERITIES)(
    "treats any nonempty canonical %s finding as an approval contradiction",
    (severity) => {
      const result = codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", reviewCountsFor(severity), [
          structuredFinding(severity),
        ]),
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe("Code review approval contradicts reported findings.");
      expect(result.findings?.[0]).toMatch(
        /^Findings by severity: critical=\d+, high=\d+, medium=\d+, low=\d+, info=\d+\.$/u,
      );
    },
  );

  it.each([
    ["finding is null", null],
    ["finding is an array", []],
    ["finding is a number", 1],
    ["missing finding id", withoutKey(structuredFinding(), "id")],
    ["missing finding severity", withoutKey(structuredFinding(), "severity")],
    ["missing finding title", withoutKey(structuredFinding(), "title")],
    ["missing finding locations", withoutKey(structuredFinding(), "locations")],
    ["missing finding requiredAction", withoutKey(structuredFinding(), "requiredAction")],
    ["extra finding key", { ...structuredFinding(), unexpected: true }],
    ["id is not a string", { ...structuredFinding(), id: 1 }],
    ["title is not a string", { ...structuredFinding(), title: 1 }],
    ["locations is not an array", { ...structuredFinding(), locations: {} }],
    ["requiredAction is not a string", { ...structuredFinding(), requiredAction: 1 }],
    ["location is null", { ...structuredFinding(), locations: [null] }],
    ["location is an array", { ...structuredFinding(), locations: [[]] }],
    [
      "missing location path",
      { ...structuredFinding(), locations: [withoutKey(structuredLocation(), "path")] },
    ],
    [
      "missing location line",
      { ...structuredFinding(), locations: [withoutKey(structuredLocation(), "line")] },
    ],
    [
      "extra location key",
      { ...structuredFinding(), locations: [{ ...structuredLocation(), column: 3 }] },
    ],
    [
      "location path is not a string",
      { ...structuredFinding(), locations: [{ ...structuredLocation(), path: 1 }] },
    ],
  ] as const)("fails closed for malformed structured-v2 nested data: %s", (_label, finding) => {
    expect(
      codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [finding]),
      ),
    ).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    ["unknown", "blocker"],
    ["wrong case", "High"],
    ["non-string", 1],
  ] as const)("fails closed for %s structured finding severity", (_label, severity) => {
    const finding = { ...structuredFinding(), severity };

    expect(
      codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [finding]),
      ),
    ).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["string", "1"],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ] as const)("fails closed for %s structured location line", (_label, line) => {
    const finding = {
      ...structuredFinding(),
      locations: [{ ...structuredLocation(), line }],
    };

    expect(
      codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [finding]),
      ),
    ).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    [
      "50 findings",
      () =>
        structuredV2ReviewPayload(
          "approved",
          reviewCountsFor("info", 50),
          Array.from({ length: 50 }, (_, index) =>
            structuredFinding("info", { id: `R1-INFO-${String(index + 1)}` }),
          ),
        ),
    ],
    [
      "20 locations",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("low"), [
          structuredFinding("low", { locations: structuredLocations(20) }),
        ]),
    ],
    [
      "1024-code-point ASCII title",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("medium"), [
          structuredFinding("medium", { title: "a".repeat(1024) }),
        ]),
    ],
    [
      "2048-byte multibyte title",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("medium"), [
          structuredFinding("medium", { title: unicodeText(512) }),
        ]),
    ],
    [
      "512-code-point path",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [
          structuredFinding("high", {
            locations: [structuredLocation(0, { path: unicodeText(512) })],
          }),
        ]),
    ],
    [
      "2048-code-point ASCII requiredAction",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { requiredAction: "a".repeat(2048) }),
        ]),
    ],
    [
      "4096-byte multibyte requiredAction",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { requiredAction: unicodeText(1024) }),
        ]),
    ],
  ] as const)(
    "admits the exact producer boundary before contradicting approval: %s",
    (_label, payload) => {
      expect(codeReviewPayloadGate(payload())).toMatchObject({
        passed: false,
        reason: "Code review approval contradicts reported findings.",
      });
    },
  );

  it.each([
    [
      "a title beyond the producer's 1024-code-point ceiling",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { title: "a".repeat(1025) }),
        ]),
    ],
    [
      "a requiredAction beyond the producer's 2048-code-point ceiling",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { requiredAction: "a".repeat(2049) }),
        ]),
    ],
    [
      "a title beyond the 2048-byte ceiling",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { title: unicodeText(513) }),
        ]),
    ],
    [
      "a requiredAction beyond the 4096-byte ceiling",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { requiredAction: unicodeText(1025) }),
        ]),
    ],
    [
      "a payload beyond the 262144-byte serialized ceiling",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("info"), [
          structuredFinding("info", { id: "x".repeat(262_144) }),
        ]),
    ],
  ] as const)("rejects producer-invalid structured evidence with %s", (_label, payload) => {
    expect(codeReviewPayloadGate(payload())).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    [
      "51 findings",
      () =>
        structuredV2ReviewPayload(
          "approved",
          reviewCountsFor("info", 51),
          Array.from({ length: 51 }, (_, index) =>
            structuredFinding("info", { id: `R1-INFO-${String(index + 1)}` }),
          ),
        ),
    ],
    [
      "21 locations",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("low"), [
          structuredFinding("low", { locations: structuredLocations(21) }),
        ]),
    ],
    [
      "513-code-point path",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [
          structuredFinding("high", {
            locations: [structuredLocation(0, { path: unicodeText(513) })],
          }),
        ]),
    ],
  ] as const)("fails closed beyond the structured-v2 producer bound: %s", (_label, payload) => {
    expect(codeReviewPayloadGate(payload())).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each(CODE_REVIEW_SEVERITIES)(
    "fails closed when the %s count has no matching structured detail",
    (severity) => {
      expect(
        codeReviewPayloadGate(structuredV2ReviewPayload("approved", reviewCountsFor(severity), [])),
      ).toEqual({
        passed: false,
        reason: "Code review approval payload is malformed; failing closed.",
      });
    },
  );

  it.each(CODE_REVIEW_SEVERITIES)(
    "fails closed when a %s structured detail has no matching count",
    (severity) => {
      expect(
        codeReviewPayloadGate(
          structuredV2ReviewPayload("approved", zeroReviewCounts(), [structuredFinding(severity)]),
        ),
      ).toEqual({
        passed: false,
        reason: "Code review approval payload is malformed; failing closed.",
      });
    },
  );

  it("fails closed when severity totals match but per-severity detail counts do not", () => {
    expect(
      codeReviewPayloadGate(
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), [structuredFinding("low")]),
      ),
    ).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each([
    [
      "legacy string array",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("high"), ["high: legacy finding"]),
    ],
    [
      "mixed structured/string array",
      () =>
        structuredV2ReviewPayload("approved", reviewCountsFor("high", 2), [
          structuredFinding("high"),
          "high: legacy finding",
        ]),
    ],
  ] as const)("rejects a %s as malformed", (_label, payload) => {
    expect(codeReviewPayloadGate(payload())).toEqual({
      passed: false,
      reason: "Code review approval payload is malformed; failing closed.",
    });
  });

  it.each(["needs-dev", "needs-verify"] as const)(
    "never passes exact empty structured-v2 %s evidence",
    (verdict) => {
      const result = codeReviewPayloadGate(structuredV2ReviewPayload(verdict));

      expect(result.passed).toBe(false);
      expect(result.reason).toBe(`Code review verdict: ${verdict}.`);
    },
  );

  it.each(["pi-bmad.code-review.payload.v3", "pi-bmad.code-review.payload.v2.1", "", 2])(
    "fails closed on non-canonical payloadVersion %j",
    (payloadVersion) => {
      const result = codeReviewPayloadGate({
        storyId: "s-1",
        verdict: "approved",
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        autoFixed: false,
        findings: [],
        payloadVersion,
      });

      expect(result).toMatchObject({
        passed: false,
        reason: expect.stringContaining("malformed"),
      });
    },
  );

  it("fails closed when a v2 approval has an unknown root property", () => {
    const result = codeReviewPayloadGate({
      storyId: "s-1",
      verdict: "approved",
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      autoFixed: false,
      findings: [],
      payloadVersion: "pi-bmad.code-review.payload.v2",
      unexpected: true,
    });

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringContaining("malformed"),
    });
  });

  it("still fails a v2 needs-dev payload with a severity summary finding", () => {
    const result = codeReviewPayloadGate(
      structuredV2ReviewPayload("needs-dev", reviewCountsFor("high"), [
        structuredFinding("high", {
          title: "Unhandled error path",
          requiredAction: "Handle the rejected promise.",
        }),
      ]),
    );

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("Code review verdict: needs-dev.");
    expect(result.findings?.[0]).toBe(
      "Findings by severity: critical=0, high=1, medium=0, low=0, info=0.",
    );
  });

  it.each([{}, { verdict: "approve" }, { verdict: "APPROVED" }, { approved: true }])(
    "fails closed on non-contract payload %j",
    (payload) => {
      const result = codeReviewPayloadGate(payload);

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/failing closed/u);
    },
  );
});

describe("code-review-lenient payload gate (compatibility contract)", () => {
  it.each([
    ["lower-severity-only findings", { critical: 0, high: 0, medium: 1, low: 2, info: 3 }, true],
    ["a critical finding", { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, false],
    ["a high finding", { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, false],
  ] as const)("preserves the zero-critical/zero-high threshold for %s", (_case, counts, passed) => {
    expect(
      codeReviewLenientGate({ verdict: "needs-dev", findingsBySeverity: counts }),
    ).toMatchObject({ passed });
  });

  it("normalizes malformed counts to zero for compatibility", () => {
    const result = codeReviewLenientGate({
      verdict: "needs-verify",
      findingsBySeverity: {
        critical: "1",
        high: -1,
        medium: 0.5,
        low: Number.NaN,
        info: Number.POSITIVE_INFINITY,
      },
    });

    expect(result).toEqual({
      passed: true,
      reason:
        "Code review needs-verify accepted: 0 critical, 0 high. Remaining: critical=0, high=0, medium=0, low=0, info=0",
    });
  });
});

describe("gate registration", () => {
  it("exports gate names exactly", () => {
    expect(E2E_VERIFY_PAYLOAD_GATE_NAME).toBe("e2e-verify");
    expect(CODE_REVIEW_PAYLOAD_GATE_NAME).toBe("code-review");
    expect(CODE_REVIEW_LENIENT_GATE_NAME).toBe("code-review-lenient");
    expect(CODE_REVIEW_CRITICAL_ONLY_GATE_NAME).toBe("code-review-critical-only");
  });

  it("registers all gates and resolves them from the registry", () => {
    const summary = registerBmadPayloadGates();

    expect(summary.registered).toEqual(["e2e-verify", "code-review"]);
    expect(resolvePayloadGate("e2e-verify")).toBe(e2eVerifyPayloadGate);
    expect(resolvePayloadGate("code-review")).toBe(codeReviewPayloadGate);
    expect(resolvePayloadGate(CODE_REVIEW_LENIENT_GATE_NAME)).toBe(codeReviewLenientGate);
    expect(resolvePayloadGate("code-review-critical-only")).toBe(codeReviewCriticalOnlyGate);
  });

  it("is idempotent", () => {
    registerBmadPayloadGates();

    expect(() => {
      registerBmadPayloadGates();
    }).not.toThrow();
  });

  it("allows the discovered SDLC YAML to compile after registration", async () => {
    registerBmadPayloadGates();

    await expect(
      selectAndCompileRunDef(resolve(import.meta.dirname, "../.."), "sdlc"),
    ).resolves.toMatchObject({ source: "discovered" });
  });
});
