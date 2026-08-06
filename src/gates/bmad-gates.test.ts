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
  CODE_REVIEW_PAYLOAD_GATE_NAME,
  CODE_REVIEW_SEVERITIES,
  E2E_VERIFY_PAYLOAD_GATE_NAME,
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

  it.each([{}, { verdict: "approve" }, { verdict: "APPROVED" }, { approved: true }])(
    "fails closed on non-contract payload %j",
    (payload) => {
      const result = codeReviewPayloadGate(payload);

      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/failing closed/u);
    },
  );
});

describe("gate registration", () => {
  it("exports gate names exactly", () => {
    expect(E2E_VERIFY_PAYLOAD_GATE_NAME).toBe("e2e-verify");
    expect(CODE_REVIEW_PAYLOAD_GATE_NAME).toBe("code-review");
  });

  it("registers both gates and resolves them from the registry", () => {
    const summary = registerBmadPayloadGates();

    expect(summary.registered).toEqual(["e2e-verify", "code-review"]);
    expect(resolvePayloadGate("e2e-verify")).toBe(e2eVerifyPayloadGate);
    expect(resolvePayloadGate("code-review")).toBe(codeReviewPayloadGate);
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
