import { describe, expect, it } from "vitest";

import { generatePipelineAuditReport, PIPELINE_AUDIT_REPORT_VERSION } from "./index.js";

import type { MergeGateEvaluation, StoryPullRequest } from "../git/index.js";
import type { CompiledStageDef } from "../rundef/index.js";
import type { HarnessEvidenceReport } from "../security/index.js";
import type {
  PipelineState,
  PipelineStatus,
  RunResult,
  RunResultStatus,
  StageState,
} from "../state/index.js";

const stage = (id: string, index: number): CompiledStageDef => ({
  id,
  kind: "agent",
  workflow: `${id}-workflow`,
  agent: `${id}-agent`,
  index,
  timeoutSeconds: 1800,
});

const stageState = (id: string, overrides: Partial<StageState> = {}): StageState => ({
  id,
  status: "pending",
  attempts: 0,
  startedAt: null,
  finishedAt: null,
  history: [],
  ...overrides,
});

const pipelineState = (overrides: Partial<PipelineState> = {}): PipelineState => ({
  storyId: "story-1",
  specFile: "docs/story.md",
  worktreePath: "/tmp/worktree",
  branch: "bmad/story-1",
  runnerFeatureVersion: 1,
  status: "done",
  currentStage: null,
  stages: {
    plan: stageState("plan", { status: "passed", attempts: 1 }),
    dev: stageState("dev", {
      status: "failed",
      attempts: 2,
      reason: "gate failed",
      history: [attempt(1, 11), attempt(2, 22)],
    }),
  },
  regressions: 1,
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:02.000Z",
  model: "model-a",
  thinking: "high",
  economics: { tokens: 123, dollars: 4.56 },
  ...overrides,
});

const attempt = (number: number, durationMs: number) => ({
  attempt: number,
  status: "passed" as const,
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:01.000Z",
  durationMs,
  exitCode: 0,
});

const harnessEvidence = (): HarnessEvidenceReport => ({
  projectRoot: "/repo",
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:01.000Z",
  passed: false,
  commands: [
    command("test", "passed"),
    command("typecheck", "failed"),
    command("lint", "timed-out"),
  ],
});

const command = (
  name: "test" | "typecheck" | "lint",
  status: "passed" | "failed" | "timed-out",
) => ({
  name,
  command: "npm",
  args: ["run", name],
  status,
  exitCode: status === "passed" ? 0 : 1,
  durationMs: 1,
  stdout: "",
  stderr: "",
});

const pullRequest = (number?: number): StoryPullRequest => ({
  storyId: "story-1",
  branch: "bmad/story-1",
  baseBranch: "main",
  title: "BMAD: story-1",
  body: "body",
  url: "https://github.com/owner/repo/pull/123",
  ...(number === undefined ? {} : { number }),
});

const mergeGate = (): MergeGateEvaluation => ({
  decision: "merge-blocked",
  passed: false,
  blockers: [
    { code: "harness-evidence-failed", reason: "Harness-owned evidence failed: lint." },
    { code: "secret-scan-blocked", reason: "Git diff secret scan blocked 1 finding." },
  ],
  reason: "Merge gate blocked 2 issues.",
});

const result = (status: RunResultStatus): RunResult => ({
  storyId: "story-1",
  specFile: "docs/story.md",
  action: "run",
  status,
  stagesRun: ["plan"],
  regressions: 0,
  durationMs: 10,
});

const report = (overrides = {}) =>
  generatePipelineAuditReport({
    state: pipelineState(),
    stages: [stage("plan", 0), stage("dev", 1)],
    action: "audit",
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:03.000Z",
    durationMs: 3000,
    ...overrides,
  });

describe("generatePipelineAuditReport", () => {
  it("generates report with version 1", () => {
    expect(report().version).toBe(PIPELINE_AUDIT_REPORT_VERSION);
  });

  it("uses RunResult.status when result is provided", () => {
    expect(
      report({ state: pipelineState({ status: "done" }), result: result("failed") }).status,
    ).toBe("failed");
  });

  it("converts terminal PipelineState.status when no result is provided", () => {
    expect(report({ state: pipelineState({ status: "done" }) }).status).toBe("passed");
  });

  it("uses needs-attention for non-terminal state status", () => {
    expect(report({ state: pipelineState({ status: "running" }) }).status).toBe("needs-attention");
  });

  it("summarizes stages in compiled stage order", () => {
    expect(
      report({ stages: [stage("dev", 1), stage("plan", 0)] }).stages.map((entry) => entry.id),
    ).toEqual(["dev", "plan"]);
  });

  it("uses latest attempt duration for stage durationMs", () => {
    expect(report().stages[1]?.durationMs).toBe(22);
  });

  it("handles missing stage state with missing summary", () => {
    expect(report({ stages: [stage("missing", 2)] }).stages[0]).toMatchObject({
      id: "missing",
      status: "missing",
      attempts: 0,
      durationMs: null,
      reason: "Stage state is missing.",
    });
  });

  it("includes economics from state", () => {
    expect(report().economics).toEqual({ tokens: 123, dollars: 4.56 });
  });

  it("includes harness evidence summary", () => {
    expect(report({ harnessEvidence: harnessEvidence() }).harnessEvidence).toEqual({
      passed: false,
      commandCount: 3,
      failedCommands: ["typecheck", "lint"],
    });
  });

  it("lists failed harness commands in command order", () => {
    expect(report({ harnessEvidence: harnessEvidence() }).harnessEvidence?.failedCommands).toEqual([
      "typecheck",
      "lint",
    ]);
  });

  it("omits harness evidence summary when absent", () => {
    expect(report()).not.toHaveProperty("harnessEvidence");
  });

  it("includes PR url and number when present", () => {
    expect(report({ pullRequest: pullRequest(123) }).pullRequest).toEqual({
      url: "https://github.com/owner/repo/pull/123",
      number: 123,
    });
  });

  it("omits PR number when absent", () => {
    expect(report({ pullRequest: pullRequest() }).pullRequest).toEqual({
      url: "https://github.com/owner/repo/pull/123",
    });
  });

  it("includes merge gate summary when present", () => {
    expect(report({ mergeGate: mergeGate() }).mergeGate).toEqual({
      passed: false,
      decision: "merge-blocked",
      blockerCount: 2,
    });
  });

  it("includes sanitized error when provided", () => {
    expect(report({ error: "failed with Bearer bbbbbbbbbbbbbbbb" }).error).toBe(
      "failed with [REDACTED]",
    );
  });

  it("redacts credentials from public string fields", () => {
    const secret = "Bearer bbbbbbbbbbbbbbbb";
    const redacted = report({
      state: pipelineState({
        storyId: `story ${secret}`,
        specFile: `spec ${secret}`,
        worktreePath: `/tmp/${secret}`,
        branch: `branch-${secret}`,
        model: `model ${secret}`,
        thinking: `thinking ${secret}`,
        stages: {
          [`stage ${secret}`]: stageState(`stage ${secret}`, { reason: `reason ${secret}` }),
        },
      }),
      stages: [
        {
          ...stage(`stage ${secret}`, 0),
          workflow: `workflow ${secret}`,
          agent: `agent ${secret}`,
        },
      ],
      action: `action ${secret}`,
      pullRequest: { ...pullRequest(123), url: `https://example.test/${secret}` },
    });

    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });

  it("freezes report and nested arrays/objects", () => {
    const output = report({
      harnessEvidence: harnessEvidence(),
      pullRequest: pullRequest(123),
      mergeGate: mergeGate(),
    });

    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.stages)).toBe(true);
    expect(Object.isFrozen(output.stages[0])).toBe(true);
    expect(Object.isFrozen(output.economics)).toBe(true);
    expect(Object.isFrozen(output.harnessEvidence)).toBe(true);
    expect(Object.isFrozen(output.harnessEvidence?.failedCommands)).toBe(true);
    expect(Object.isFrozen(output.pullRequest)).toBe(true);
    expect(Object.isFrozen(output.mergeGate)).toBe(true);
  });

  it("does not mutate input request or nested objects", () => {
    const state = pipelineState({ status: "paused" as PipelineStatus });
    const stages = [stage("plan", 0)];
    const evidence = harnessEvidence();
    const request = {
      state,
      stages,
      action: "audit",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:01.000Z",
      durationMs: 1,
      harnessEvidence: evidence,
      pullRequest: pullRequest(123),
      mergeGate: mergeGate(),
      error: "boom",
    };
    const before = JSON.stringify(request);

    generatePipelineAuditReport(request);

    expect(JSON.stringify(request)).toBe(before);
  });
});
