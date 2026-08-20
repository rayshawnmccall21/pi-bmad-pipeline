import { describe, expect, it } from "vitest";

import { CODE_REVIEW_CRITICAL_ONLY_GATE_NAME, codeReviewCriticalOnlyGate } from "./index.js";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const LOWER_SEVERITIES = ["high", "medium", "low", "info"] as const;

type Verdict = "approved" | "needs-dev" | "needs-verify";
type Severity = (typeof SEVERITIES)[number];

interface StructuredLocation {
  path: string;
  line: number;
}

interface StructuredFinding {
  id: string;
  severity: Severity;
  title: string;
  locations: StructuredLocation[];
  requiredAction: string;
}

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
  severity: Severity = "critical",
  overrides: Partial<StructuredFinding> = {},
): StructuredFinding => ({
  id: `R1-${severity.toUpperCase()}-1`,
  severity,
  title: `${severity} review finding`,
  locations: [structuredLocation()],
  requiredAction: `Resolve the ${severity} finding.`,
  ...overrides,
});

const unicodeText = (codePoints: number): string => "💥".repeat(codePoints);

const zeroCounts = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

const countsFor = (severity: Severity, count = 1): Record<Severity, number> => ({
  ...zeroCounts(),
  [severity]: count,
});

const v1Payload = (
  verdict: Verdict = "needs-dev",
  findingsBySeverity: Record<Severity, number> = zeroCounts(),
): Record<string, unknown> => ({
  storyId: "STY-185",
  verdict,
  findingsBySeverity,
  autoFixed: false,
});

const v2Payload = (
  verdict: Verdict = "needs-dev",
  findingsBySeverity: Record<Severity, number> = zeroCounts(),
  findings: unknown[] = [],
): Record<string, unknown> => ({
  ...v1Payload(verdict, findingsBySeverity),
  findings,
  payloadVersion: "pi-bmad.code-review.payload.v2",
});

const without = (payload: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([candidate]) => candidate !== key));

describe("code-review-critical-only payload gate (public contract)", () => {
  it("exports the exact public gate name", () => {
    expect(CODE_REVIEW_CRITICAL_ONLY_GATE_NAME).toBe("code-review-critical-only");
  });

  it.each([
    ["v1", "approved"],
    ["v1", "needs-dev"],
    ["v1", "needs-verify"],
    ["v2", "approved"],
    ["v2", "needs-dev"],
    ["v2", "needs-verify"],
  ] as const)("passes canonical %s verdict %s when critical is zero", (version, verdict) => {
    const payload = version === "v1" ? v1Payload(verdict) : v2Payload(verdict);
    const result = codeReviewCriticalOnlyGate(payload, { storyId: "STY-185" });

    expect(result.passed).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(LOWER_SEVERITIES)(
    "does not block on nonzero %s findings alone when structured details match",
    (severity) => {
      expect(
        codeReviewCriticalOnlyGate(v1Payload("needs-dev", countsFor(severity, 2))).passed,
      ).toBe(true);

      const result = codeReviewCriticalOnlyGate(
        v2Payload("needs-verify", countsFor(severity), [structuredFinding(severity)]),
      );

      expect(result).toEqual({
        passed: true,
        reason: "Code review has no critical findings.",
      });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it("accepts canonical structured v2 lower-severity findings without routing to development", () => {
    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-dev", { ...zeroCounts(), high: 1 }, [
        {
          id: "CONTRACT:src/gates/code-review-critical-only.ts:31-35",
          severity: "high",
          title: "Canonical structured v2 finding contract divergence",
          locations: [{ path: "src/gates/code-review-critical-only.ts", line: 31 }],
          requiredAction: "Validate the producer's bounded structured finding object contract.",
        },
      ]),
      { storyId: "STY-185" },
    );

    expect(result).toMatchObject({
      passed: true,
      reason: "Code review has no critical findings.",
    });
  });

  it.each(["approved", "needs-dev", "needs-verify"] as const)(
    "fails every canonical verdict when critical is positive (%s)",
    (verdict) => {
      const result = codeReviewCriticalOnlyGate(
        v1Payload(verdict, { critical: 1, high: 2, medium: 3, low: 4, info: 5 }),
      );

      expect(result.passed).toBe(false);
      expect(result.findings).toContain(
        "Findings by severity: critical=1, high=2, medium=3, low=4, info=5.",
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.findings)).toBe(true);
    },
  );

  it("formats structured Critical details deterministically into immutable regression findings", () => {
    const criticalFinding = structuredFinding("critical", {
      id: "R1-CRITICAL-7",
      title: "Unsafe authorization bypass",
      locations: [
        { path: "src/auth/check.ts", line: 17 },
        { path: "src/auth/caller.ts", line: 31 },
      ],
      requiredAction: "Reject unauthenticated access.",
    });
    const highFinding = structuredFinding("high", {
      id: "R1-HIGH-2",
      title: "Unhandled error path",
      locations: [{ path: "src/errors.ts", line: 9 }],
      requiredAction: "Handle the rejected promise.",
    });
    const payload = v2Payload("needs-dev", { ...zeroCounts(), critical: 1, high: 1 }, [
      criticalFinding,
      highFinding,
    ]);
    const before = structuredClone(payload);

    const result = codeReviewCriticalOnlyGate(payload);

    expect(result).toEqual({
      passed: false,
      reason: "Code review has critical findings.",
      findings: [
        "Findings by severity: critical=1, high=1, medium=0, low=0, info=0.",
        "[critical] R1-CRITICAL-7: Unsafe authorization bypass (src/auth/check.ts:17, src/auth/caller.ts:31) Required action: Reject unauthenticated access.",
        "[high] R1-HIGH-2: Unhandled error path (src/errors.ts:9) Required action: Handle the rejected promise.",
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(payload).toEqual(before);
  });

  it.each([
    ["finding is null", null],
    ["finding is an array", []],
    ["missing finding id", without(structuredFinding(), "id")],
    ["missing finding severity", without(structuredFinding(), "severity")],
    ["missing finding title", without(structuredFinding(), "title")],
    ["missing finding locations", without(structuredFinding(), "locations")],
    ["missing finding requiredAction", without(structuredFinding(), "requiredAction")],
    ["extra finding key", { ...structuredFinding(), unexpected: true }],
    ["id is not a string", { ...structuredFinding(), id: 1 }],
    ["title is not a string", { ...structuredFinding(), title: 1 }],
    ["locations is not an array", { ...structuredFinding(), locations: {} }],
    ["requiredAction is not a string", { ...structuredFinding(), requiredAction: 1 }],
    ["location is null", { ...structuredFinding(), locations: [null] }],
    ["location is an array", { ...structuredFinding(), locations: [[]] }],
    [
      "missing location path",
      { ...structuredFinding(), locations: [without(structuredLocation(), "path")] },
    ],
    [
      "missing location line",
      { ...structuredFinding(), locations: [without(structuredLocation(), "line")] },
    ],
    [
      "extra location key",
      { ...structuredFinding(), locations: [{ ...structuredLocation(), column: 3 }] },
    ],
    [
      "location path is not a string",
      { ...structuredFinding(), locations: [{ ...structuredLocation(), path: 1 }] },
    ],
  ] as const)(
    "fails closed unless finding and location keys/types are exact: %s",
    (_label, finding) => {
      const result = codeReviewCriticalOnlyGate(
        v2Payload("needs-dev", countsFor("critical"), [finding]),
      );

      expect(result).toMatchObject({
        passed: false,
        reason: expect.stringMatching(/malformed|failing closed/iu),
      });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each([
    ["unknown", "blocker"],
    ["wrong case", "Critical"],
    ["non-string", 1],
  ] as const)("fails closed for %s structured finding severity", (_label, severity) => {
    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-dev", countsFor("critical"), [{ ...structuredFinding(), severity }]),
    );

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/malformed|failing closed/iu),
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
    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-dev", countsFor("critical"), [
        { ...structuredFinding(), locations: [{ ...structuredLocation(), line }] },
      ]),
    );

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/malformed|failing closed/iu),
    });
  });

  it("accepts exactly 50 structured findings", () => {
    const findings = Array.from({ length: 50 }, (_, index) =>
      structuredFinding("info", { id: `R1-INFO-${String(index + 1)}` }),
    );

    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-verify", countsFor("info", 50), findings),
    );

    expect(result).toEqual({ passed: true, reason: "Code review has no critical findings." });
  });

  it("rejects 51 structured findings", () => {
    const findings = Array.from({ length: 51 }, (_, index) =>
      structuredFinding("info", { id: `R1-INFO-${String(index + 1)}` }),
    );

    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-dev", countsFor("info", 51), findings),
    );

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/malformed|failing closed/iu),
    });
  });

  it("accepts exactly 20 structured locations on a finding", () => {
    const finding = structuredFinding("low", { locations: structuredLocations(20) });

    const result = codeReviewCriticalOnlyGate(v2Payload("approved", countsFor("low"), [finding]));

    expect(result).toEqual({ passed: true, reason: "Code review has no critical findings." });
  });

  it("rejects 21 structured locations on a finding", () => {
    const finding = structuredFinding("low", { locations: structuredLocations(21) });

    const result = codeReviewCriticalOnlyGate(v2Payload("needs-dev", countsFor("low"), [finding]));

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/malformed|failing closed/iu),
    });
  });

  it.each([
    ["ASCII title at 1024 code points", structuredFinding("info", { title: "a".repeat(1024) })],
    ["multibyte title at 2048 UTF-8 bytes", structuredFinding("info", { title: unicodeText(512) })],
    [
      "path at 512 code points",
      structuredFinding("info", {
        locations: [structuredLocation(0, { path: unicodeText(512) })],
      }),
    ],
    [
      "ASCII requiredAction at 2048 code points",
      structuredFinding("info", { requiredAction: "a".repeat(2048) }),
    ],
    [
      "multibyte requiredAction at 4096 UTF-8 bytes",
      structuredFinding("info", { requiredAction: unicodeText(1024) }),
    ],
  ] as const)("accepts the exact producer boundary: %s", (_label, finding) => {
    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-verify", countsFor("info"), [finding]),
    );

    expect(result).toEqual({ passed: true, reason: "Code review has no critical findings." });
  });

  it.each([
    [
      "a title beyond the producer's 1024-code-point ceiling",
      structuredFinding("info", { title: "a".repeat(1025) }),
    ],
    [
      "a requiredAction beyond the producer's 2048-code-point ceiling",
      structuredFinding("info", { requiredAction: "a".repeat(2049) }),
    ],
    [
      "a title beyond the 2048-byte ceiling",
      structuredFinding("info", { title: unicodeText(513) }),
    ],
    [
      "a requiredAction beyond the 4096-byte ceiling",
      structuredFinding("info", { requiredAction: unicodeText(1025) }),
    ],
    [
      "a payload beyond the 262144-byte serialized ceiling",
      structuredFinding("info", { id: "x".repeat(262_144) }),
    ],
    [
      "a path beyond the 512-code-point ceiling",
      structuredFinding("info", {
        locations: [structuredLocation(0, { path: unicodeText(513) })],
      }),
    ],
  ] as const)("rejects producer-invalid structured evidence with %s", (_label, finding) => {
    const result = codeReviewCriticalOnlyGate(
      v2Payload("needs-verify", countsFor("info"), [finding]),
    );

    expect(result).toEqual({
      passed: false,
      reason: "Code review payload is malformed; failing closed.",
    });
  });

  it.each(SEVERITIES)(
    "fails closed when the %s count has no matching structured detail",
    (severity) => {
      const result = codeReviewCriticalOnlyGate(v2Payload("needs-dev", countsFor(severity), []));

      expect(result).toMatchObject({
        passed: false,
        reason: expect.stringMatching(/malformed|failing closed/iu),
      });
    },
  );

  it.each(SEVERITIES)(
    "fails closed when a %s structured detail has no matching count",
    (severity) => {
      const result = codeReviewCriticalOnlyGate(
        v2Payload("needs-dev", zeroCounts(), [structuredFinding(severity)]),
      );

      expect(result).toMatchObject({
        passed: false,
        reason: expect.stringMatching(/malformed|failing closed/iu),
      });
    },
  );

  it.each([
    [
      "legacy string array",
      () => v2Payload("needs-dev", countsFor("high"), ["high: legacy finding"]),
    ],
    [
      "mixed structured/string array",
      () =>
        v2Payload("needs-dev", countsFor("high", 2), [
          structuredFinding("high"),
          "high: legacy finding",
        ]),
    ],
  ] as const)("rejects a %s", (_label, payload) => {
    const result = codeReviewCriticalOnlyGate(payload());

    expect(result).toMatchObject({
      passed: false,
      reason: expect.stringMatching(/malformed|failing closed/iu),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["absent map", without(v1Payload(), "findingsBySeverity")],
    ["array map", { ...v1Payload(), findingsBySeverity: [] }],
    [
      "missing severity",
      { ...v1Payload(), findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 } },
    ],
    ["extra severity", { ...v1Payload(), findingsBySeverity: { ...zeroCounts(), blocker: 0 } }],
    ["negative", { ...v1Payload(), findingsBySeverity: { ...zeroCounts(), critical: -1 } }],
    ["fractional", { ...v1Payload(), findingsBySeverity: { ...zeroCounts(), critical: 0.5 } }],
    ["nonnumeric", { ...v1Payload(), findingsBySeverity: { ...zeroCounts(), critical: "0" } }],
    ["NaN", { ...v1Payload(), findingsBySeverity: { ...zeroCounts(), critical: Number.NaN } }],
    [
      "infinite",
      {
        ...v1Payload(),
        findingsBySeverity: { ...zeroCounts(), critical: Number.POSITIVE_INFINITY },
      },
    ],
  ] as const)("fails closed for malformed severity evidence: %s", (_label, payload) => {
    const result = codeReviewCriticalOnlyGate(payload);

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/malformed|failing closed/iu);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.findings === undefined || Object.isFrozen(result.findings)).toBe(true);
  });

  it.each([
    ["empty", {}],
    [
      "e2e envelope",
      {
        storyId: "STY-185",
        verdict: "pass",
        scenariosPassed: 1,
        scenariosFailed: 0,
        failedScenarioIds: [],
        partialScenarioIds: [],
      },
    ],
    ["empty story", { ...v1Payload(), storyId: "" }],
    ["nonstrings story", { ...v1Payload(), storyId: 185 }],
    ["fuzzy verdict", { ...v1Payload(), verdict: "APPROVED" }],
    ["unsupported verdict", { ...v1Payload(), verdict: "approve" }],
    ["nonboolean autoFixed", { ...v1Payload(), autoFixed: "false" }],
    ["missing v1 root key", without(v1Payload(), "autoFixed")],
    ["extra v1 root key", { ...v1Payload(), unexpected: true }],
    ["invalid v2 version", { ...v2Payload(), payloadVersion: "pi-bmad.code-review.payload.v3" }],
    ["missing v2 root key", without(v2Payload(), "findings")],
    ["extra v2 root key", { ...v2Payload(), unexpected: true }],
    ["findings is not an array", { ...v2Payload(), findings: {} }],
  ] as const)("fails closed for a noncanonical envelope: %s", (_label, payload) => {
    const result = codeReviewCriticalOnlyGate(payload);

    expect(result.passed).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails closed when the active story identity differs", () => {
    const result = codeReviewCriticalOnlyGate(v1Payload("needs-dev"), {
      storyId: "STY-OTHER",
    });

    expect(result).toMatchObject({ passed: false, reason: expect.stringMatching(/story/iu) });
  });

  it("does not mutate nested structured input or discard authenticated details", () => {
    const highFinding = structuredFinding("high", {
      locations: [
        { path: "src/high.ts", line: 7 },
        { path: "src/high-caller.ts", line: 11 },
      ],
    });
    const infoFinding = structuredFinding("info", {
      locations: [{ path: "src/info.ts", line: 3 }],
    });
    const highLocations = highFinding.locations;
    const infoLocations = infoFinding.locations;
    const details = [highFinding, infoFinding];
    const payload = v2Payload("needs-dev", { ...zeroCounts(), high: 1, info: 1 }, details);
    const counts = payload["findingsBySeverity"];
    const before = structuredClone(payload);

    const result = codeReviewCriticalOnlyGate(payload, { storyId: "STY-185" });

    expect(result).toEqual({ passed: true, reason: "Code review has no critical findings." });
    expect(Object.isFrozen(result)).toBe(true);
    expect(payload).toEqual(before);
    expect(payload["findings"]).toBe(details);
    expect(payload["findingsBySeverity"]).toBe(counts);
    expect(highFinding.locations).toBe(highLocations);
    expect(infoFinding.locations).toBe(infoLocations);
  });
});
