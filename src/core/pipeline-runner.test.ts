import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MAX_REGRESSIONS, runPipelineStages } from "./index.js";
import { createInitialPipelineState } from "../state/index.js";
import { getPipelineStateInvalidReason } from "../state/fs-state-validation.js";
import {
  MAX_STAGE_HANDOFF_BYTES,
  createStageHandoff,
  type StageHandoff,
} from "../security/stage-handoff.js";

import type {
  FinalScopeReceipt,
  PipelineState,
  ReviewScopeCheckpoint,
  StageState,
} from "../state/index.js";
import type { CompiledAgentStage, CompiledCodeStage, CompiledStageDef } from "../rundef/index.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "../executors/index.js";
import type { RunPipelineStagesRequest, ScopeAttestor } from "./pipeline-runner.js";

const T0 = "2026-08-05T00:00:00.000Z";
const digest = (character: string): string => character.repeat(64);

const reviewCheckpoint: ReviewScopeCheckpoint = {
  version: 1,
  storyId: "SH-1",
  runId: "run-1",
  runDefId: "legacy-unbound",
  runDefDigest: "legacy-unbound",
  branch: "sty-139/landing-integrity",
  baseOid: "a".repeat(40),
  reviewed: { paths: ["src/app.ts"], digest: digest("b") },
  qualityGate: {
    stageId: "code-review",
    attempt: 1,
    status: "passed",
    finishedAt: T0,
  },
};

const finalScopeReceipt: FinalScopeReceipt = {
  ...reviewCheckpoint,
  docs: { paths: ["README.md"], digest: digest("c") },
  finalWorkingTreeDigest: digest("d"),
};

const createScopeAttestor = () =>
  vi.fn<ScopeAttestor>(async (request) =>
    request.phase === "review"
      ? { kind: "review-checkpoint", checkpoint: reviewCheckpoint }
      : { kind: "final-receipt", receipt: finalScopeReceipt },
  );

const stage = (
  id: string,
  index: number,
  overrides: Partial<CompiledAgentStage> = {},
): CompiledAgentStage => ({
  id,
  kind: "agent",
  workflow: `wf-${id}`,
  agent: "dev",
  index,
  timeoutSeconds: 60,
  ...overrides,
});

const okGate = (payload: Record<string, unknown>) =>
  payload["ok"] === true
    ? { passed: true }
    : {
        passed: false,
        reason: "gate rejected payload",
        ...(Array.isArray(payload["findings"])
          ? { findings: payload["findings"] as string[] }
          : {}),
      };

const okResult = (overrides: Partial<StageExecutionResult> = {}): StageExecutionResult => ({
  output: { payload: { ok: true } },
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

const gateFailResult = (findings?: readonly string[]): StageExecutionResult =>
  okResult({
    output: { payload: { ok: false, ...(findings === undefined ? {} : { findings }) } },
  });

interface ScriptedExecutor extends WorkflowExecutor {
  readonly requests: StageExecutionRequest[];
}

type ScriptEntry = StageExecutionResult | Error | string | (() => StageExecutionResult);

const scriptedExecutor = (script: ScriptEntry[]): ScriptedExecutor => {
  const requests: StageExecutionRequest[] = [];
  return {
    id: "stub",
    requests,
    async execute(request) {
      requests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error("executor script exhausted");
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises non-Error throws.
      if (next instanceof Error || typeof next === "string") throw next;
      return typeof next === "function" ? next() : next;
    },
  };
};

const fixedClock = (): (() => Date) => {
  let tick = 0;
  return () => new Date(Date.parse(T0) + tick++ * 1000);
};

interface Harness {
  readonly request: RunPipelineStagesRequest;
  readonly saves: PipelineState[];
  readonly executor: ScriptedExecutor;
  readonly attestScope: ReturnType<typeof createScopeAttestor>;
}

const harness = (
  stages: readonly CompiledStageDef[],
  script: ScriptEntry[],
  overrides: Partial<RunPipelineStagesRequest> = {},
): Harness => {
  const saves: PipelineState[] = [];
  const executor = scriptedExecutor(script);
  const attestScope = createScopeAttestor();
  const state = createInitialPipelineState({
    storyId: "SH-1",
    specFile: "spec.md",
    stages,
    model: "test-model",
    thinking: "medium",
  });
  return {
    saves,
    executor,
    attestScope,
    request: {
      stages,
      state,
      storyId: "SH-1",
      runId: "run-1",
      specFile: "spec.md",
      projectRoot: "/root",
      executor,
      attestScope,
      saveState: async (next) => {
        saves.push(next);
      },
      now: fixedClock(),
      ...overrides,
    },
  };
};

const codeStage = (id: string, index: number): CompiledCodeStage => ({
  id,
  kind: "code",
  command: "npm",
  args: ["run", id],
  index,
  timeoutSeconds: 60,
});

const twoStages = (): readonly CompiledStageDef[] => [stage("a", 0), stage("b", 1)];

const gatedStages = (): readonly CompiledStageDef[] => [
  stage("a", 0),
  stage("b", 1, { payloadGate: okGate, payloadGateName: "ok-gate", onFail: "a" }),
];

const receiptStages = (): readonly CompiledStageDef[] => [
  stage("dev-story", 0),
  stage("code-review", 1, {
    payloadGate: okGate,
    payloadGateName: "code-review",
    onFail: "dev-story",
  }),
  stage("docs", 2),
];

const durablyPassedStage = (
  state: StageState,
  attempts: number,
  finishedAt: string,
): StageState => ({
  ...state,
  status: "passed",
  attempts,
  startedAt: T0,
  finishedAt,
  history: Array.from({ length: attempts }, (_, attemptIndex) => ({
    attempt: attemptIndex + 1,
    status: "passed" as const,
    startedAt: T0,
    finishedAt: attemptIndex + 1 === attempts ? finishedAt : T0,
    durationMs: 1,
    exitCode: 0,
    reason: "durable passed attempt",
  })),
  reason: "durable passed attempt",
});

type StageStateWithHandoff = StageState & { readonly upstreamHandoff?: StageHandoff };
const handoffOf = (state: StageState | undefined): StageHandoff | undefined =>
  (state as StageStateWithHandoff | undefined)?.upstreamHandoff;

describe("runPipelineStages", () => {
  it("runs all stages to done and accumulates economics", async () => {
    const usage = { tokens: 10, dollars: 0.25 };
    const { request, executor } = harness(twoStages(), [okResult({ usage }), okResult({ usage })]);
    const { now, ...withoutClock } = request;
    expect(now).toBeTypeOf("function");

    const result = await runPipelineStages(withoutClock);

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["a", "b"]);
    expect(result.regressions).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.state.status).toBe("done");
    expect(result.state.currentStage).toBeNull();
    expect(result.state.startedAt).not.toBeNull();
    expect(result.state.finishedAt).not.toBeNull();
    expect(result.state.economics).toEqual({ tokens: 20, dollars: 0.5 });
    expect(result.state.stages["a"]?.status).toBe("passed");
    expect(result.state.stages["b"]?.status).toBe("passed");
    expect(result.state.stages["a"]?.attempts).toBe(1);
    expect(result.state.stages["a"]?.history).toHaveLength(1);
    expect(result.state.stages["a"]?.history[0]?.usage).toEqual(usage);
    expect(executor.requests[0]).toMatchObject({
      storyId: "SH-1",
      specFile: "spec.md",
      projectRoot: "/root",
      attempt: 1,
    });
    expect(executor.requests[0]?.priorFindings).toBeUndefined();
    expect(executor.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("persists review and final attestations before docs and terminal done", async () => {
    const { request, saves, attestScope } = harness(receiptStages(), [
      okResult(),
      okResult(),
      okResult(),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(attestScope).toHaveBeenCalledTimes(2);
    expect(attestScope).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "review",
        projectRoot: "/root",
        storyId: "SH-1",
        runId: "run-1",
        runDefId: request.state.runDefId,
        runDefDigest: request.state.runDefDigest,
        qualityGate: expect.objectContaining({
          stageId: "code-review",
          attempt: 1,
          status: "passed",
        }),
      }),
    );
    expect(attestScope).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "final",
        reviewCheckpoint,
      }),
    );

    const checkpointSave = saves.findIndex((state) => state.reviewCheckpoint !== undefined);
    const docsStartSave = saves.findIndex(
      (state) => state.currentStage === "docs" && state.stages["docs"]?.status === "running",
    );
    const receiptSave = saves.findIndex(
      (state) => state.status !== "done" && state.finalScopeReceipt !== undefined,
    );
    const doneSave = saves.findIndex((state) => state.status === "done");

    expect(checkpointSave).toBeGreaterThanOrEqual(0);
    expect(docsStartSave).toBeGreaterThan(checkpointSave);
    expect(receiptSave).toBeGreaterThan(docsStartSave);
    expect(doneSave).toBeGreaterThan(receiptSave);
    expect(result.state.reviewCheckpoint).toEqual(reviewCheckpoint);
    expect(result.state.finalScopeReceipt).toEqual(finalScopeReceipt);
    expect(Object.isFrozen(result.state.finalScopeReceipt)).toBe(true);
    expect(Object.isFrozen(result.state.finalScopeReceipt?.docs.paths)).toBe(true);
  });

  it("reruns review and downstream docs after final attestation invalidates reviewed bytes", async () => {
    const fixture = harness(receiptStages(), [
      okResult(),
      okResult(),
      okResult(),
      okResult(),
      okResult(),
    ]);
    const refreshedCheckpoint: ReviewScopeCheckpoint = {
      ...reviewCheckpoint,
      reviewed: { paths: ["src/app.ts"], digest: digest("e") },
      qualityGate: { ...reviewCheckpoint.qualityGate, attempt: 2 },
    };
    const refreshedReceipt: FinalScopeReceipt = {
      ...finalScopeReceipt,
      ...refreshedCheckpoint,
      finalWorkingTreeDigest: digest("f"),
    };
    fixture.attestScope
      .mockResolvedValueOnce({ kind: "review-checkpoint", checkpoint: reviewCheckpoint })
      .mockResolvedValueOnce({ kind: "review-invalidated", changedPaths: ["src/app.ts"] })
      .mockResolvedValueOnce({ kind: "review-checkpoint", checkpoint: refreshedCheckpoint })
      .mockResolvedValueOnce({ kind: "final-receipt", receipt: refreshedReceipt });

    const result = await runPipelineStages(fixture.request);

    expect(result.status).toBe("done");
    expect(fixture.executor.requests.map(({ stage }) => stage.id)).toEqual([
      "dev-story",
      "code-review",
      "docs",
      "code-review",
      "docs",
    ]);
    const rerunStart = fixture.saves.find(
      (state) =>
        state.currentStage === "code-review" && state.stages["code-review"]?.attempts === 1,
    );
    expect(rerunStart?.reviewCheckpoint).toBeUndefined();
    expect(result.state.reviewCheckpoint).toEqual(refreshedCheckpoint);
    expect(result.state.finalScopeReceipt).toEqual(refreshedReceipt);
  });

  it("clears prior review approval when final PR review regresses through development", async () => {
    const stages: readonly CompiledStageDef[] = [
      stage("dev-story", 0),
      stage("e2e-verify", 1),
      stage("code-review", 2, {
        workflow: "code-review",
        payloadGate: okGate,
        payloadGateName: "code-review-critical-only",
        onFail: "dev-story",
      }),
      stage("docs", 3),
      stage("update-pr", 4),
      stage("pr-review", 5, {
        workflow: "code-review",
        payloadGate: okGate,
        payloadGateName: "code-review-critical-only",
        onFail: "dev-story",
      }),
    ];
    const attestScope: ScopeAttestor = async (request) => {
      if (request.phase === "review") {
        return {
          kind: "review-checkpoint",
          checkpoint: {
            ...reviewCheckpoint,
            runId: request.runId,
            runDefId: request.runDefId,
            runDefDigest: request.runDefDigest,
            qualityGate: request.qualityGate,
          },
        };
      }
      return {
        kind: "final-receipt",
        receipt: {
          ...finalScopeReceipt,
          ...request.reviewCheckpoint,
          docs: { paths: ["README.md"], digest: digest("c") },
          finalWorkingTreeDigest: digest("d"),
        },
      };
    };
    const fixture = harness(
      stages,
      [
        okResult(),
        okResult(),
        okResult(),
        okResult(),
        okResult(),
        gateFailResult(["critical finding"]),
        okResult(),
        okResult(),
        okResult(),
        okResult(),
        okResult(),
        okResult(),
      ],
      { attestScope },
    );
    const invalidReasons: (string | undefined)[] = [];
    const result = await runPipelineStages({
      ...fixture.request,
      state: {
        ...fixture.request.state,
        runDefId: "sdlc-critical-only",
        runDefDigest: digest("a"),
      },
      attestScope,
      saveState: async (state) => {
        const reason = getPipelineStateInvalidReason(state);
        invalidReasons.push(reason);
        if (reason !== undefined) {
          throw new Error(reason);
        }
        fixture.saves.push(state);
      },
    });

    expect(result.status).toBe("done");
    expect(invalidReasons.every((reason) => reason === undefined)).toBe(true);
    expect(fixture.executor.requests.map(({ stage: executedStage }) => executedStage.id)).toEqual([
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
      "update-pr",
      "pr-review",
      "dev-story",
      "e2e-verify",
      "code-review",
      "docs",
      "update-pr",
      "pr-review",
    ]);
    const regressionSave = fixture.saves.find(
      (state) => state.regressions === 1 && state.stages["dev-story"]?.status === "pending",
    );
    expect(regressionSave).not.toHaveProperty("reviewCheckpoint");
    expect(regressionSave).not.toHaveProperty("finalScopeReceipt");
  });

  it("fails closed without saving done when final attestation is rejected", async () => {
    const fixture = harness(receiptStages(), [okResult(), okResult(), okResult()]);
    fixture.attestScope
      .mockResolvedValueOnce({ kind: "review-checkpoint", checkpoint: reviewCheckpoint })
      .mockResolvedValueOnce({
        kind: "rejected",
        reason: "Final Git scope could not be attested.",
      });

    const result = await runPipelineStages(fixture.request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({
      code: "scope-attestation-failed",
      reason: "Final Git scope could not be attested.",
    });
    expect(result.state.finalScopeReceipt).toBeUndefined();
    expect(fixture.saves.some((state) => state.status === "done")).toBe(false);
    expect(fixture.saves.at(-1)?.status).toBe("needs-attention");
  });

  it("resumes interrupted preterminal finalization without rerunning stages", async () => {
    const fixture = harness(receiptStages(), []);
    const resumedStages = Object.fromEntries(
      Object.entries(fixture.request.state.stages).map(([id, state]) => [
        id,
        { ...state, status: "passed" as const },
      ]),
    );
    const state: PipelineState = {
      ...fixture.request.state,
      status: "running",
      currentStage: null,
      stages: resumedStages,
      reviewCheckpoint,
    };

    const result = await runPipelineStages({ ...fixture.request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual([]);
    expect(fixture.executor.requests).toEqual([]);
    expect(fixture.attestScope).toHaveBeenCalledOnce();
    expect(fixture.attestScope).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "final", reviewCheckpoint }),
    );
    const receiptSave = fixture.saves.findIndex(
      (saved) => saved.status !== "done" && saved.finalScopeReceipt !== undefined,
    );
    const doneSave = fixture.saves.findIndex((saved) => saved.status === "done");
    expect(receiptSave).toBeGreaterThanOrEqual(0);
    expect(doneSave).toBeGreaterThan(receiptSave);
  });

  it("backfills a missing current-version review checkpoint before finalizing", async () => {
    const fixture = harness(receiptStages(), []);
    const reviewFinishedAt = "2026-08-04T23:47:19.321Z";
    const state: PipelineState = {
      ...fixture.request.state,
      runDefId: "review-recovery",
      runDefDigest: digest("a"),
      status: "needs-attention",
      currentStage: null,
      regressions: 2,
      stages: {
        "dev-story": durablyPassedStage(fixture.request.state.stages["dev-story"]!, 1, T0),
        "code-review": durablyPassedStage(
          fixture.request.state.stages["code-review"]!,
          3,
          reviewFinishedAt,
        ),
        docs: durablyPassedStage(fixture.request.state.stages["docs"]!, 1, T0),
      },
    };
    expect(getPipelineStateInvalidReason(state)).toBeUndefined();
    const expectedQualityGate = {
      stageId: "code-review",
      attempt: 3,
      status: "passed" as const,
      finishedAt: reviewFinishedAt,
    };
    const events: string[] = [];
    fixture.attestScope.mockImplementation(async (request) => {
      events.push(request.phase);
      if (request.phase === "review") {
        return {
          kind: "review-checkpoint",
          checkpoint: {
            ...reviewCheckpoint,
            storyId: request.storyId,
            runId: request.runId,
            runDefId: request.runDefId,
            runDefDigest: request.runDefDigest,
            qualityGate: request.qualityGate,
          },
        };
      }
      return {
        kind: "final-receipt",
        receipt: {
          ...finalScopeReceipt,
          ...request.reviewCheckpoint,
          qualityGate: request.qualityGate,
        },
      };
    });

    const result = await runPipelineStages({
      ...fixture.request,
      state,
      saveState: async (saved) => {
        fixture.saves.push(saved);
        if (saved.reviewCheckpoint !== undefined || saved.finalScopeReceipt !== undefined) {
          expect(getPipelineStateInvalidReason(saved)).toBeUndefined();
        }
        events.push(
          saved.status === "done"
            ? "done"
            : saved.finalScopeReceipt !== undefined
              ? "receipt"
              : saved.reviewCheckpoint !== undefined
                ? "checkpoint"
                : "other",
        );
      },
    });

    expect(result.status).toBe("done");
    expect(result.failure).toBeUndefined();
    expect(result.stagesRun).toEqual([]);
    expect(fixture.executor.requests).toEqual([]);
    expect(result.regressions).toBe(2);
    expect(result.state.regressions).toBe(2);
    expect(
      Object.fromEntries(
        Object.entries(result.state.stages).map(([id, stageState]) => [id, stageState.attempts]),
      ),
    ).toEqual({ "dev-story": 1, "code-review": 3, docs: 1 });
    expect(fixture.attestScope.mock.calls.map(([request]) => request.phase)).toEqual([
      "review",
      "final",
    ]);
    expect(fixture.attestScope.mock.calls[0]?.[0]).toMatchObject({
      phase: "review",
      qualityGate: expectedQualityGate,
    });
    expect(fixture.attestScope.mock.calls[1]?.[0]).toMatchObject({
      phase: "final",
      reviewCheckpoint: { qualityGate: expectedQualityGate },
      qualityGate: expectedQualityGate,
    });
    expect(events).toEqual(["review", "checkpoint", "final", "receipt", "done"]);
    expect(result.state.reviewCheckpoint?.qualityGate).toEqual(expectedQualityGate);
    expect(result.state.finalScopeReceipt?.qualityGate).toEqual(expectedQualityGate);
    expect(result.state.status).toBe("done");
  });

  it("fails closed when a backfilled checkpoint cannot be persisted", async () => {
    const fixture = harness(receiptStages(), []);
    const state: PipelineState = {
      ...fixture.request.state,
      runDefId: "review-recovery",
      runDefDigest: digest("a"),
      status: "needs-attention",
      currentStage: null,
      stages: Object.fromEntries(
        Object.entries(fixture.request.state.stages).map(([id, stageState]) => [
          id,
          durablyPassedStage(stageState, 1, T0),
        ]),
      ),
    };
    expect(getPipelineStateInvalidReason(state)).toBeUndefined();
    fixture.attestScope.mockImplementation(async (request) => {
      if (request.phase !== "review") {
        throw new Error("final phase must not run");
      }
      return {
        kind: "review-checkpoint",
        checkpoint: {
          ...reviewCheckpoint,
          storyId: request.storyId,
          runId: request.runId,
          runDefId: request.runDefId,
          runDefDigest: request.runDefDigest,
          qualityGate: request.qualityGate,
        },
      };
    });

    const result = await runPipelineStages({
      ...fixture.request,
      state,
      saveState: async (saved) => {
        if (saved.reviewCheckpoint !== undefined) {
          throw new Error("checkpoint write failed");
        }
        fixture.saves.push(saved);
      },
    });

    expect(result.status).toBe("needs-attention");
    expect(result.stagesRun).toEqual([]);
    expect(fixture.executor.requests).toEqual([]);
    expect(fixture.attestScope.mock.calls.map(([request]) => request.phase)).toEqual(["review"]);
    expect(result.state.reviewCheckpoint).toBeUndefined();
    expect(result.state.finalScopeReceipt).toBeUndefined();
    expect(fixture.saves.some((saved) => saved.finalScopeReceipt !== undefined)).toBe(false);
    expect(fixture.saves.some((saved) => saved.status === "done")).toBe(false);
  });

  it("reroutes unchanged after backfill when final scope invalidates non-doc bytes", async () => {
    const fixture = harness(receiptStages(), [okResult(), okResult()]);
    const state: PipelineState = {
      ...fixture.request.state,
      runDefId: "review-recovery",
      runDefDigest: digest("a"),
      status: "needs-attention",
      currentStage: null,
      stages: Object.fromEntries(
        Object.entries(fixture.request.state.stages).map(([id, stageState]) => [
          id,
          durablyPassedStage(stageState, 1, T0),
        ]),
      ),
    };
    expect(getPipelineStateInvalidReason(state)).toBeUndefined();
    const checkpointFor = (
      request: Extract<Parameters<ScopeAttestor>[0], { phase: "review" }>,
    ): ReviewScopeCheckpoint => ({
      ...reviewCheckpoint,
      storyId: request.storyId,
      runId: request.runId,
      runDefId: request.runDefId,
      runDefDigest: request.runDefDigest,
      qualityGate: request.qualityGate,
    });
    fixture.attestScope
      .mockImplementationOnce(async (request) => {
        if (request.phase !== "review") throw new Error("expected review backfill");
        return { kind: "review-checkpoint", checkpoint: checkpointFor(request) };
      })
      .mockResolvedValueOnce({ kind: "review-invalidated", changedPaths: ["src/app.ts"] })
      .mockImplementationOnce(async (request) => {
        if (request.phase !== "review") throw new Error("expected rerun review");
        return { kind: "review-checkpoint", checkpoint: checkpointFor(request) };
      })
      .mockImplementationOnce(async (request) => {
        if (request.phase !== "final") throw new Error("expected final retry");
        return {
          kind: "final-receipt",
          receipt: { ...finalScopeReceipt, ...request.reviewCheckpoint },
        };
      });

    const result = await runPipelineStages({ ...fixture.request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["code-review", "docs"]);
    expect(fixture.executor.requests.map(({ stage: executedStage }) => executedStage.id)).toEqual([
      "code-review",
      "docs",
    ]);
    expect(fixture.attestScope.mock.calls.map(([request]) => request.phase)).toEqual([
      "review",
      "final",
      "review",
      "final",
    ]);
    expect(
      fixture.saves
        .filter(
          (saved) => saved.reviewCheckpoint !== undefined || saved.finalScopeReceipt !== undefined,
        )
        .every((saved) => getPipelineStateInvalidReason(saved) === undefined),
    ).toBe(true);
    const invalidated = fixture.saves.find(
      (saved) => saved.regressions === 1 && saved.stages["code-review"]?.status === "pending",
    );
    expect(invalidated).not.toHaveProperty("reviewCheckpoint");
    expect(invalidated).not.toHaveProperty("finalScopeReceipt");
  });

  it("reruns a passed legacy review before docs when its checkpoint was never persisted", async () => {
    const fixture = harness(receiptStages(), [okResult(), okResult()]);
    const passedStage = (state: StageState): StageState => ({
      ...state,
      status: "passed",
      attempts: 1,
      startedAt: T0,
      finishedAt: T0,
      history: [
        {
          attempt: 1,
          status: "passed",
          startedAt: T0,
          finishedAt: T0,
          durationMs: 1,
          exitCode: 0,
          reason: "passed before checkpoint persistence failed",
        },
      ],
    });
    const legacyState: PipelineState = {
      ...fixture.request.state,
      runnerFeatureVersion: 1,
      status: "running",
      currentStage: "code-review",
      stages: {
        ...fixture.request.state.stages,
        "dev-story": passedStage(fixture.request.state.stages["dev-story"]!),
        "code-review": passedStage(fixture.request.state.stages["code-review"]!),
      },
    };
    fixture.attestScope.mockImplementation(async (request) => {
      if (request.phase === "review") {
        return {
          kind: "review-checkpoint",
          checkpoint: {
            ...reviewCheckpoint,
            runId: request.runId,
            runDefId: request.runDefId,
            runDefDigest: request.runDefDigest,
            qualityGate: request.qualityGate,
          },
        };
      }
      return {
        kind: "final-receipt",
        receipt: {
          ...finalScopeReceipt,
          ...request.reviewCheckpoint,
          runId: request.runId,
          runDefId: request.runDefId,
          runDefDigest: request.runDefDigest,
          qualityGate: request.qualityGate,
        },
      };
    });

    const result = await runPipelineStages({ ...fixture.request, state: legacyState });

    expect(result.status).toBe("done");
    expect(fixture.executor.requests.map(({ stage: executedStage }) => executedStage.id)).toEqual([
      "code-review",
      "docs",
    ]);
    expect(fixture.attestScope.mock.calls.map(([request]) => request.phase)).toEqual([
      "review",
      "final",
    ]);
    expect(result.state.runnerFeatureVersion).toBe(2);
    expect(result.state.reviewCheckpoint?.qualityGate.attempt).toBe(2);
  });

  it("persists an agent payload on its normal successor and forwards the exact handoff", async () => {
    const payload = { ok: true, result: { files: ["src/example.ts"], count: 1 } };
    const expected = createStageHandoff(payload);
    expect(expected).toBeDefined();
    const { request, executor, saves } = harness(twoStages(), [
      okResult({ output: { payload } }),
      okResult(),
    ]);

    await runPipelineStages(request);

    const successorSave = saves.find((saved) => handoffOf(saved.stages["b"]) === expected);
    expect(handoffOf(successorSave?.stages["b"])).toBe(expected);
    expect(executor.requests[1]?.upstreamHandoff).toBe(expected);
  });

  it("redacts a payload before every durable save and successor request", async () => {
    const rawSecret = "Bearer test-secret-token-1234567890";
    const payload = { ok: true, nested: [{ authorization: rawSecret }] };
    const { request, executor, saves } = harness(twoStages(), [
      okResult({ output: { payload } }),
      okResult(),
    ]);

    await runPipelineStages(request);

    const captures = [...saves, ...executor.requests].map((value) => JSON.stringify(value));
    expect(captures.every((capture) => !capture.includes(rawSecret))).toBe(true);
    expect(captures.some((capture) => capture.includes("[REDACTED]"))).toBe(true);
    expect(executor.requests[1]?.upstreamHandoff).toContain("[REDACTED]");
  });

  it("runs mixed agent, code, agent stages in declared order without stale code output", async () => {
    const stages = [stage("a", 0), codeStage("check", 1), stage("b", 2)];
    const agentPayload = { ok: true, source: "agent-a" };
    const expected = createStageHandoff(agentPayload);
    const { request, executor } = harness(stages, [
      okResult({ output: { payload: agentPayload } }),
      okResult({ output: null }),
      okResult(),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["a", "check", "b"]);
    expect(executor.requests.map((executionRequest) => executionRequest.stage.kind)).toEqual([
      "agent",
      "code",
      "agent",
    ]);
    expect(executor.requests[1]?.upstreamHandoff).toBe(expected);
    expect(executor.requests[2]?.upstreamHandoff).toBeUndefined();
  });

  it("stops terminally on a nonzero code exit without increasing regressions", async () => {
    const stages = [stage("a", 0), codeStage("check", 1), stage("b", 2)];
    const { request, executor } = harness(stages, [
      okResult(),
      okResult({ output: null, exitCode: 2, diagnostic: "check failed" }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.stagesRun).toEqual(["a", "check"]);
    expect(result.regressions).toBe(0);
    expect(result.failure?.reason).toContain("check failed");
    expect(executor.requests).toHaveLength(2);
  });

  it("freezes the result, final state, and stagesRun", async () => {
    const { request } = harness(twoStages(), [okResult(), okResult()]);

    const result = await runPipelineStages(request);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.stages)).toBe(true);
    expect(Object.isFrozen(result.state.stages["a"])).toBe(true);
    expect(Object.isFrozen(result.state.stages["a"]?.history)).toBe(true);
    expect(Object.isFrozen(result.stagesRun)).toBe(true);
  });

  it("does not mutate the caller's starting state", async () => {
    const { request } = harness(twoStages(), [okResult(), okResult()]);
    const snapshot = JSON.parse(JSON.stringify(request.state));

    await runPipelineStages(request);

    expect(JSON.parse(JSON.stringify(request.state))).toEqual(snapshot);
  });

  it("resumes from the first incomplete stage", async () => {
    const { request, executor } = harness(twoStages(), [okResult()]);
    const passed: StageState = {
      id: "a",
      status: "passed",
      attempts: 1,
      startedAt: T0,
      finishedAt: T0,
      history: [
        {
          attempt: 1,
          status: "passed",
          startedAt: T0,
          finishedAt: T0,
          durationMs: 5,
          exitCode: 0,
          reason: "ok",
        },
      ],
    };
    const state: PipelineState = {
      ...request.state,
      startedAt: T0,
      stages: { ...request.state.stages, a: passed },
    };

    const result = await runPipelineStages({ ...request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual(["b"]);
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.stage.id).toBe("b");
    expect(result.state.startedAt).toBe(T0);
    expect(result.state.stages["a"]?.attempts).toBe(1);
  });

  it("reuses the exact persisted handoff when resuming an incomplete successor", async () => {
    const { request, executor } = harness(twoStages(), [okResult()]);
    const persisted = createStageHandoff({ z: 1, a: ["kept exactly"] });
    expect(persisted).toBeDefined();
    const passed: StageState = {
      id: "a",
      status: "passed",
      attempts: 1,
      startedAt: T0,
      finishedAt: T0,
      history: [],
    };
    const pendingB: StageStateWithHandoff = {
      ...request.state.stages["b"]!,
      upstreamHandoff: persisted!,
    };
    const state: PipelineState = {
      ...request.state,
      startedAt: T0,
      stages: { ...request.state.stages, a: passed, b: pendingB },
    };

    await runPipelineStages({ ...request, state });

    expect(executor.requests[0]?.upstreamHandoff).toBe(persisted);
  });

  it("returns done without executing when every stage is complete", async () => {
    const { request, executor } = harness(twoStages(), []);
    const stages = Object.fromEntries(
      twoStages().map((def) => [
        def.id,
        { ...request.state.stages[def.id]!, status: "passed" as const },
      ]),
    );
    const state: PipelineState = { ...request.state, stages };

    const result = await runPipelineStages({ ...request, state });

    expect(result.status).toBe("done");
    expect(result.stagesRun).toEqual([]);
    expect(executor.requests).toHaveLength(0);
    expect(result.state.status).toBe("done");
    expect(result.state.finishedAt).not.toBeNull();
  });

  it("creates pending stage state for stages missing from the starting state", async () => {
    const base = harness(twoStages(), [okResult(), okResult()]);
    const state = createInitialPipelineState({
      storyId: "SH-1",
      specFile: "spec.md",
      stages: [stage("a", 0)],
      model: "test-model",
      thinking: "medium",
    });

    const result = await runPipelineStages({ ...base.request, state });

    expect(result.status).toBe("done");
    expect(result.state.stages["b"]?.status).toBe("passed");
    expect(result.state.stages["b"]?.attempts).toBe(1);
  });

  it("regresses on gate failure and carries findings to the target attempt", async () => {
    const findings = ["fix the login flow"];
    const usage = { tokens: 10, dollars: 0.25 };
    const { request, executor, saves } = harness(gatedStages(), [
      okResult({ usage }),
      gateFailResult(findings),
      okResult({ usage }),
      okResult({ usage }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(result.regressions).toBe(1);
    expect(result.stagesRun).toEqual(["a", "b", "a", "b"]);
    expect(executor.requests[2]?.stage.id).toBe("a");
    expect(executor.requests[2]?.attempt).toBe(2);
    expect(executor.requests[2]?.priorFindings).toEqual(findings);
    expect(result.state.stages["a"]?.attempts).toBe(2);
    expect(result.state.stages["b"]?.history[0]?.status).toBe("gate-failed");
    expect(result.state.stages["b"]?.history[0]?.findings).toEqual(findings);
    const regressed = saves.find(
      (state) => state.stages["a"]?.status === "pending" && state.regressions === 1,
    );
    expect(regressed?.stages["a"]?.findings).toEqual(findings);
    expect(regressed?.stages["a"]?.startedAt).toBeNull();
  });

  it("regresses with the full review finding while retaining gate routing and summaries", async () => {
    const priorFindings = ["Findings by severity: high=1"];
    const finding = {
      severity: "high",
      title: "Unsafe call",
      locations: [{ path: "src/example.ts", line: 42 }],
      requiredAction: "Validate before use",
    };
    const failedPayload = { ok: false, findings: priorFindings, reviewFindings: [finding] };
    const expected = createStageHandoff(failedPayload);
    const { request, executor, saves } = harness(gatedStages(), [
      okResult(),
      okResult({ output: { payload: failedPayload } }),
      okResult(),
      okResult(),
    ]);

    const result = await runPipelineStages(request);

    expect(result.regressions).toBe(1);
    expect(result.stagesRun).toEqual(["a", "b", "a", "b"]);
    expect(executor.requests[2]).toMatchObject({
      attempt: 2,
      priorFindings,
      upstreamHandoff: expected,
    });
    expect(executor.requests[2]?.upstreamHandoff).toContain("src/example.ts");
    expect(executor.requests[2]?.upstreamHandoff).toContain("42");
    const regressed = saves.find(
      (saved) => saved.regressions === 1 && saved.stages["a"]?.status === "pending",
    );
    expect(handoffOf(regressed?.stages["a"])).toBe(expected);
    expect(regressed?.stages["a"]?.findings).toEqual(priorFindings);
  });

  it("rejects an oversized handoff whole while retaining the findings fallback", async () => {
    const priorFindings = ["Findings by severity: high=1"];
    const oversized = `OVER_CAP_${"x".repeat(MAX_STAGE_HANDOFF_BYTES + 1)}_END`;
    const payload = { ok: false, findings: priorFindings, detail: oversized };
    const { request, executor, saves } = harness(gatedStages(), [
      okResult(),
      okResult({ output: { payload } }),
      okResult(),
      okResult(),
    ]);

    await runPipelineStages(request);

    expect(executor.requests[2]?.priorFindings).toEqual(priorFindings);
    expect(executor.requests[2]?.upstreamHandoff).toBeUndefined();
    expect(handoffOf(saves.find((saved) => saved.regressions === 1)?.stages["a"])).toBeUndefined();
    for (const captured of [...saves, ...executor.requests]) {
      expect(JSON.stringify(captured)).not.toContain("OVER_CAP_");
      expect(JSON.stringify(captured)).not.toContain("_END");
    }
  });

  it("fails closed when the regression limit is exceeded", async () => {
    const { request } = harness(
      gatedStages(),
      [okResult(), gateFailResult(), okResult(), gateFailResult()],
      { maxRegressions: 1 },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "regression-limit-exceeded", stageId: "b" });
    expect(result.regressions).toBe(1);
    expect(result.stagesRun).toEqual(["a", "b", "a", "b"]);
    expect(result.state.status).toBe("failed");
  });

  it("uses DEFAULT_MAX_REGRESSIONS when maxRegressions is omitted", async () => {
    expect(DEFAULT_MAX_REGRESSIONS).toBe(3);
    const script: ScriptEntry[] = [okResult()];
    for (let index = 0; index < DEFAULT_MAX_REGRESSIONS + 1; index += 1) {
      script.push(gateFailResult(), okResult());
    }
    const { request } = harness(gatedStages(), script);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("regression-limit-exceeded");
    expect(result.regressions).toBe(DEFAULT_MAX_REGRESSIONS);
  });

  it("fails closed on gate failure without onFail", async () => {
    const stages = [stage("a", 0, { payloadGate: okGate, payloadGateName: "ok-gate" })];
    const { request } = harness(stages, [gateFailResult()]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "gate-failed-without-on-fail", stageId: "a" });
  });

  it("fails the run when a stage exits non-zero", async () => {
    const { request } = harness(twoStages(), [okResult({ exitCode: 3 })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ code: "stage-failed", stageId: "a" });
    expect(result.failure?.reason).toContain("exited with code 3");
    expect(result.state.stages["a"]?.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("failed");
    expect(result.stagesRun).toEqual(["a"]);
  });

  it("records timed-out attempts and fails the run", async () => {
    const { request } = harness(twoStages(), [
      okResult({ timedOut: true, output: null, exitCode: null }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.code).toBe("stage-failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("timed-out");
  });

  it("records parse errors on the attempt", async () => {
    const { request } = harness(twoStages(), [okResult({ parseError: "bad line", output: null })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("parse-error");
    expect(result.state.stages["a"]?.history[0]?.parseError).toBe("bad line");
  });

  it.each([
    ["array", []],
    ["null", null],
    ["string", "nope"],
  ])("treats a %s payload as missing output", async (_label, payload) => {
    const { request } = harness(twoStages(), [okResult({ output: { payload } })]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toContain("did not produce validated output");
  });

  it("fails closed to needs-attention when a stage budget is exceeded", async () => {
    const stages = [stage("a", 0, { budget: { maxTokens: 5 } }), stage("b", 1)];
    const { request, executor } = harness(stages, [
      okResult({ usage: { tokens: 10, dollars: 0 } }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "stage-budget-exceeded", stageId: "a" });
    expect(result.state.status).toBe("needs-attention");
    expect(executor.requests).toHaveLength(1);
    expect(result.state.stages["a"]?.status).toBe("passed");
  });

  it("fails closed when a budgeted stage reports no usage", async () => {
    const stages = [stage("a", 0, { budget: { maxDollars: 1 } })];
    const { request } = harness(stages, [okResult()]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.code).toBe("stage-budget-exceeded");
    expect(result.failure?.reason).toContain("no valid usage");
  });

  it("fails closed when the run budget is exceeded", async () => {
    const { request, executor } = harness(
      twoStages(),
      [okResult({ usage: { tokens: 1, dollars: 0.5 } })],
      { runBudget: { maxDollars: 0.25 } },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "run-budget-exceeded", stageId: "a" });
    expect(executor.requests).toHaveLength(1);
  });

  it("aborts before spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { request, executor } = harness(twoStages(), [], { signal: controller.signal });

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "aborted", stageId: "a" });
    expect(executor.requests).toHaveLength(0);
    expect(result.stagesRun).toEqual([]);
    expect(result.state.status).toBe("needs-attention");
    expect(result.state.finishedAt).not.toBeNull();
  });

  it("stops between stages when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const { request, executor } = harness(
      twoStages(),
      [
        () => {
          controller.abort();
          return okResult();
        },
      ],
      { signal: controller.signal },
    );

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "aborted", stageId: "b" });
    expect(result.stagesRun).toEqual(["a"]);
    expect(executor.requests).toHaveLength(1);
    expect(result.state.stages["a"]?.status).toBe("passed");
  });

  it("treats an aborted execution result as needs-attention", async () => {
    const { request } = harness(twoStages(), [
      okResult({ aborted: true, output: null, exitCode: null }),
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.code).toBe("aborted");
    expect(result.state.stages["a"]?.history[0]?.status).toBe("aborted");
  });

  it("turns an executor error into needs-attention with durable evidence", async () => {
    const { request, saves } = harness(twoStages(), [new Error("spawn exploded")]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure).toMatchObject({ code: "executor-error", stageId: "a" });
    expect(result.failure?.reason).toBe("spawn exploded");
    expect(result.state.stages["a"]?.status).toBe("failed");
    expect(result.state.stages["a"]?.history[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      exitCode: null,
      durationMs: null,
      reason: "spawn exploded",
    });
    expect(result.stagesRun).toEqual(["a"]);
    expect(saves.at(-1)?.status).toBe("needs-attention");
  });

  it("stringifies non-Error executor throws", async () => {
    const { request } = harness(twoStages(), ["boom"]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.reason).toBe("boom");
  });

  it("serializes non-Error non-string executor throws", async () => {
    const { request } = harness(twoStages(), [
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises unknown throws.
        throw 42;
      },
    ]);

    const result = await runPipelineStages(request);

    expect(result.status).toBe("needs-attention");
    expect(result.failure?.reason).toBe("42");
  });

  it("saves state after every transition and before observer finish callbacks", async () => {
    const events: string[] = [];
    const base = harness([stage("a", 0)], []);
    const request: RunPipelineStagesRequest = {
      ...base.request,
      executor: {
        id: "stub",
        async execute() {
          events.push("execute:a");
          return okResult();
        },
      },
      saveState: async (state) => {
        events.push(
          `save:${state.status}:${String(state.currentStage)}:${String(state.finalScopeReceipt !== undefined)}`,
        );
      },
      observer: {
        onStageStarted: (info) => events.push(`started:${info.stage.id}:${info.attempt}`),
        onStageFinished: (info) =>
          events.push(
            `finished:${info.stage.id}:${info.decision.kind}:${info.route.action}:${String(info.execution.exitCode)}`,
          ),
      },
    };

    const result = await runPipelineStages(request);

    expect(result.status).toBe("done");
    expect(events).toEqual([
      "started:a:1",
      "save:running:a:false",
      "execute:a",
      "save:running:a:false",
      "finished:a:passed:complete:0",
      "save:running:a:true",
      "save:done:null:true",
    ]);
  });

  it("supports observers with only one callback", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    const first = harness([stage("a", 0)], [okResult()], {
      observer: { onStageStarted: started },
    });
    await runPipelineStages(first.request);
    const second = harness([stage("a", 0)], [okResult()], {
      observer: { onStageFinished: finished },
    });
    await runPipelineStages(second.request);

    expect(started).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("throws RangeError for an empty stage list", async () => {
    const { request } = harness(twoStages(), []);

    await expect(runPipelineStages({ ...request, stages: [] })).rejects.toThrow(RangeError);
  });

  it.each([[-1], [1.5]])("throws RangeError for maxRegressions %s", async (maxRegressions) => {
    const { request } = harness(twoStages(), []);

    await expect(runPipelineStages({ ...request, maxRegressions })).rejects.toThrow(RangeError);
  });
});
