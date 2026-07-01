import { describe, expect, it } from "vitest";

import { evaluateMergeGate } from "./index.js";

import type { GitSecretScanResult, MergeGatePullRequest } from "./index.js";
import type {
  HarnessEvidenceCommandName,
  HarnessEvidenceCommandResult,
  HarnessEvidenceCommandStatus,
  HarnessEvidenceReport,
} from "../security/index.js";

const secret = (): string => `sk-${"a".repeat(24)}`;

const pullRequest = (): MergeGatePullRequest => ({
  url: "https://github.com/owner/repo/pull/123",
  number: 123,
});

const command = (
  name: HarnessEvidenceCommandName,
  status: HarnessEvidenceCommandStatus = "passed",
): HarnessEvidenceCommandResult => ({
  name,
  command: "npm",
  args: name === "test" ? ["test"] : ["run", name],
  status,
  exitCode: status === "passed" ? 0 : 1,
  durationMs: 1,
  stdout: "",
  stderr: "",
});

const harnessEvidence = (passed = true): HarnessEvidenceReport => ({
  projectRoot: "/repo",
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:01.000Z",
  passed,
  commands: [command("test"), command("typecheck"), command("lint")],
});

const secretScan = (passed = true): GitSecretScanResult => ({
  passed,
  findings: [],
  reason: passed
    ? "Git diff secret scan passed."
    : "Git diff secret scan blocked 1 secret-shaped finding.",
});

describe("merge gate", () => {
  it("allows merge when PR, harness evidence, and secret scan pass", () => {
    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: harnessEvidence(),
        secretScan: secretScan(),
      }),
    ).toEqual({
      decision: "merge-allowed",
      passed: true,
      blockers: [],
      reason: "Merge gate passed.",
    });
  });

  it("blocks missing PR", () => {
    expect(
      evaluateMergeGate({ harnessEvidence: harnessEvidence(), secretScan: secretScan() }).blockers,
    ).toEqual([
      { code: "missing-pull-request", reason: "No pull request was opened for this story." },
    ]);
  });

  it("blocks missing harness evidence", () => {
    expect(
      evaluateMergeGate({ pullRequest: pullRequest(), secretScan: secretScan() }).blockers,
    ).toEqual([{ code: "harness-evidence-missing", reason: "Harness-owned evidence is missing." }]);
  });

  it("blocks failed harness evidence", () => {
    const evidence = { ...harnessEvidence(false), commands: [command("test", "failed")] };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
      }).blockers,
    ).toEqual([
      { code: "harness-evidence-failed", reason: "Harness-owned evidence failed: test." },
    ]);
  });

  it("lists failing command names in order", () => {
    const evidence = {
      ...harnessEvidence(false),
      commands: [command("test", "failed"), command("typecheck"), command("lint", "failed")],
    };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
      }).blockers[0]?.reason,
    ).toBe("Harness-owned evidence failed: test, lint.");
  });

  it("uses generic failed evidence reason without command details", () => {
    const evidence = { ...harnessEvidence(false), commands: [] };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
      }).blockers[0]?.reason,
    ).toBe("Harness-owned evidence failed.");
  });

  it("blocks missing secret scan", () => {
    expect(
      evaluateMergeGate({ pullRequest: pullRequest(), harnessEvidence: harnessEvidence() })
        .blockers,
    ).toEqual([{ code: "secret-scan-blocked", reason: "Git diff secret scan result is missing." }]);
  });

  it("blocks blocked secret scan and preserves reason", () => {
    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: harnessEvidence(),
        secretScan: secretScan(false),
      }).blockers,
    ).toEqual([
      {
        code: "secret-scan-blocked",
        reason: "Git diff secret scan blocked 1 secret-shaped finding.",
      },
    ]);
  });

  it("detects testsPassed divergence", () => {
    const evidence = { ...harnessEvidence(), commands: [command("typecheck"), command("lint")] };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
        agentClaim: { testsPassed: true },
      }).blockers,
    ).toEqual([
      {
        code: "agent-claim-diverged",
        reason: "Agent evidence claim diverged from harness-owned evidence: testsPassed.",
      },
    ]);
  });

  it("detects typecheckPassed divergence", () => {
    const evidence = { ...harnessEvidence(), commands: [command("test"), command("lint")] };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
        agentClaim: { typecheckPassed: true },
      }).blockers[0]?.reason,
    ).toBe("Agent evidence claim diverged from harness-owned evidence: typecheckPassed.");
  });

  it("detects lintPassed divergence", () => {
    const evidence = { ...harnessEvidence(), commands: [command("test"), command("typecheck")] };

    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: evidence,
        secretScan: secretScan(),
        agentClaim: { lintPassed: true },
      }).blockers[0]?.reason,
    ).toBe("Agent evidence claim diverged from harness-owned evidence: lintPassed.");
  });

  it("aggregates multiple claim divergences", () => {
    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: { ...harnessEvidence(), commands: [command("typecheck")] },
        secretScan: secretScan(),
        agentClaim: { testsPassed: true, lintPassed: true },
      }).blockers[0]?.reason,
    ).toBe("Agent evidence claim diverged from harness-owned evidence: testsPassed, lintPassed.");
  });

  it("ignores agent claims set to false", () => {
    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: { ...harnessEvidence(), commands: [] },
        secretScan: secretScan(),
        agentClaim: { testsPassed: false, typecheckPassed: false, lintPassed: false },
      }).blockers,
    ).toEqual([]);
  });

  it("ignores absent agent claim fields", () => {
    expect(
      evaluateMergeGate({
        pullRequest: pullRequest(),
        harnessEvidence: harnessEvidence(),
        secretScan: secretScan(),
        agentClaim: {},
      }).blockers,
    ).toEqual([]);
  });

  it("uses deterministic blocker order", () => {
    const result = evaluateMergeGate({ agentClaim: { testsPassed: true } });

    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "missing-pull-request",
      "harness-evidence-missing",
      "secret-scan-blocked",
      "agent-claim-diverged",
    ]);
  });

  it("uses singular blocked summary", () => {
    expect(
      evaluateMergeGate({ pullRequest: pullRequest(), harnessEvidence: harnessEvidence() }).reason,
    ).toBe("Merge gate blocked 1 issue.");
  });

  it("uses plural blocked summary", () => {
    expect(evaluateMergeGate({}).reason).toBe("Merge gate blocked 3 issues.");
  });

  it("redacts credentials in blocker reasons", () => {
    const result = evaluateMergeGate({
      pullRequest: pullRequest(),
      harnessEvidence: harnessEvidence(),
      secretScan: { passed: false, findings: [], reason: `blocked ${secret()}` },
    });

    expect(result.blockers[0]?.reason).toBe("blocked [REDACTED]");
  });

  it("freezes result and blockers", () => {
    const result = evaluateMergeGate({});

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.blockers)).toBe(true);
    expect(Object.isFrozen(result.blockers[0])).toBe(true);
  });

  it("does not mutate input request or nested objects", () => {
    const request = {
      pullRequest: pullRequest(),
      harnessEvidence: harnessEvidence(),
      secretScan: secretScan(),
      agentClaim: { testsPassed: true },
    };
    const before = JSON.stringify(request);

    evaluateMergeGate(request);

    expect(JSON.stringify(request)).toBe(before);
  });
});
