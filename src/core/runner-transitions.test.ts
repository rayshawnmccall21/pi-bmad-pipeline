import { describe, expect, it } from "vitest";

import { type CompiledStageDef } from "../rundef/index.js";
import {
  RUNNER_FEATURE_VERSION,
  createInitialPipelineState,
  type FinalScopeReceipt,
  type PipelineState,
  type ReviewScopeCheckpoint,
} from "../state/index.js";
import {
  freezePipelineState,
  getPipelineStateInvalidReason,
} from "../state/fs-state-validation.js";
import type { StageState } from "../state/index.js";
import {
  applyStageOutcome,
  applyTerminalCorrection,
  attachFinalScopeReceipt,
  attachReviewCheckpoint,
  markStageRunning,
} from "./runner-transitions.js";

const finishedAt = "2026-08-19T00:00:00.000Z";
const correctionTime = "2026-08-21T00:00:00.000Z";
const digest = (character: string): string => character.repeat(64);

const reviewStage: CompiledStageDef = {
  id: "code-review",
  kind: "agent",
  workflow: "code-review",
  agent: "dev",
  index: 0,
  timeoutSeconds: 60,
};

const legacyReviewedState = (): PipelineState => {
  const initial = createInitialPipelineState({
    storyId: "STY-144",
    runDefId: "review-docs",
    runDefDigest: digest("a"),
    specFile: "story.md",
    stages: [reviewStage],
    model: "test-model",
    thinking: "high",
    startedAt: finishedAt,
  });
  return freezePipelineState({
    ...initial,
    runnerFeatureVersion: 1,
    status: "running",
    stages: {
      "code-review": {
        ...initial.stages["code-review"]!,
        status: "passed",
        attempts: 1,
        startedAt: finishedAt,
        finishedAt,
        history: [
          {
            attempt: 1,
            status: "passed",
            startedAt: finishedAt,
            finishedAt,
            durationMs: 1,
            exitCode: 0,
            reason: "approved",
          },
        ],
      },
    },
  });
};

const checkpointFor = (state: PipelineState): ReviewScopeCheckpoint => ({
  version: 1,
  storyId: state.storyId,
  runId: "run-144",
  runDefId: state.runDefId,
  runDefDigest: state.runDefDigest,
  branch: "sty-139/landing-integrity",
  baseOid: "b".repeat(40),
  reviewed: { paths: ["src/app.ts"], digest: digest("c") },
  qualityGate: {
    stageId: "code-review",
    attempt: 1,
    status: "passed",
    finishedAt,
  },
});

const receiptFor = (state: PipelineState): FinalScopeReceipt => ({
  ...checkpointFor(state),
  docs: { paths: ["README.md"], digest: digest("d") },
  finalWorkingTreeDigest: digest("e"),
});

describe("runner scope attachment transitions", () => {
  it("atomically upgrades a legacy state when attaching its first review checkpoint", () => {
    const state = legacyReviewedState();
    const checkpoint = checkpointFor(state);

    expect(getPipelineStateInvalidReason(state)).toBeUndefined();

    const attached = attachReviewCheckpoint(state, checkpoint);

    expect(attached).toEqual({
      ...state,
      runnerFeatureVersion: RUNNER_FEATURE_VERSION,
      reviewCheckpoint: checkpoint,
    });
    expect(getPipelineStateInvalidReason(attached)).toBeUndefined();
    expect(state.runnerFeatureVersion).toBe(1);
    expect(state).not.toHaveProperty("reviewCheckpoint");
    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached.reviewCheckpoint)).toBe(true);
    expect(Object.isFrozen(attached.reviewCheckpoint?.reviewed.paths)).toBe(true);
    expect(Object.isFrozen(attached.reviewCheckpoint?.qualityGate)).toBe(true);
  });

  it("atomically upgrades a legacy state and derives its checkpoint from a direct final receipt", () => {
    const state = legacyReviewedState();
    const receipt = receiptFor(state);
    const checkpoint = checkpointFor(state);

    expect(getPipelineStateInvalidReason(state)).toBeUndefined();

    const attached = attachFinalScopeReceipt(state, receipt);

    expect(attached).toEqual({
      ...state,
      runnerFeatureVersion: RUNNER_FEATURE_VERSION,
      reviewCheckpoint: checkpoint,
      finalScopeReceipt: receipt,
    });
    expect(getPipelineStateInvalidReason(attached)).toBeUndefined();
    expect(state.runnerFeatureVersion).toBe(1);
    expect(state).not.toHaveProperty("reviewCheckpoint");
    expect(state).not.toHaveProperty("finalScopeReceipt");
    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached.reviewCheckpoint)).toBe(true);
    expect(Object.isFrozen(attached.finalScopeReceipt)).toBe(true);
    expect(Object.isFrozen(attached.finalScopeReceipt?.docs.paths)).toBe(true);
  });

  it("clears stale scope approval when a later review regresses to development", () => {
    const state = legacyReviewedState();
    const approved = attachFinalScopeReceipt(state, receiptFor(state));

    const regressed = applyStageOutcome(approved, {
      stageId: "pr-review",
      attempt: 1,
      decision: {
        stageId: "pr-review",
        kind: "gate-failed",
        passed: false,
        reason: "Critical PR review finding.",
        findings: ["critical finding"],
      },
      execution: { output: null, exitCode: 0, durationMs: 1 },
      regressions: 1,
      successorId: "dev-story",
      regressionTargetId: "dev-story",
      finishedAt,
    });

    expect(regressed).not.toHaveProperty("reviewCheckpoint");
    expect(regressed).not.toHaveProperty("finalScopeReceipt");
    expect(regressed.stages["dev-story"]?.status).toBe("pending");
    expect(getPipelineStateInvalidReason(regressed)).toBeUndefined();

    const reviewRerun = markStageRunning(regressed, "code-review", finishedAt);
    expect(reviewRerun.stages["code-review"]?.status).toBe("running");
    expect(getPipelineStateInvalidReason(reviewRerun)).toBeUndefined();
  });

  it.each([
    [
      "newer",
      RUNNER_FEATURE_VERSION + 1,
      (state: PipelineState): PipelineState => attachReviewCheckpoint(state, checkpointFor(state)),
    ],
    [
      "malformed",
      -1,
      (state: PipelineState): PipelineState => attachFinalScopeReceipt(state, receiptFor(state)),
    ],
  ] as const)(
    "does not normalize a %s state into persistence compatibility",
    (_name, version, attach) => {
      const state = freezePipelineState({
        ...legacyReviewedState(),
        runnerFeatureVersion: version,
      });
      const attached = attach(state);

      expect(attached.runnerFeatureVersion).toBe(version);
      expect(getPipelineStateInvalidReason(attached)).toBeDefined();
    },
  );

  it("does not migrate a terminal legacy state while attaching a receipt", () => {
    const state = freezePipelineState({
      ...legacyReviewedState(),
      status: "failed",
      currentStage: null,
      finishedAt,
    });

    const attached = attachFinalScopeReceipt(state, receiptFor(state));

    expect(attached.runnerFeatureVersion).toBe(1);
    expect(getPipelineStateInvalidReason(attached)).toBeDefined();
  });
});

const correctionStages: readonly CompiledStageDef[] = [
  {
    id: "dev-story",
    kind: "agent",
    workflow: "dev-story",
    agent: "dev",
    index: 0,
    timeoutSeconds: 60,
  },
  {
    id: "code-review",
    kind: "agent",
    workflow: "code-review",
    agent: "dev",
    index: 1,
    timeoutSeconds: 60,
    payloadGateName: "code-review",
    onFail: "dev-story",
  },
  {
    id: "docs",
    kind: "agent",
    workflow: "docs",
    agent: "architect",
    index: 2,
    timeoutSeconds: 60,
  },
];

const passedStage = (id: string): StageState =>
  Object.freeze({
    id,
    status: "passed",
    attempts: 1,
    startedAt: finishedAt,
    finishedAt,
    history: Object.freeze([
      {
        attempt: 1,
        status: "passed" as const,
        startedAt: finishedAt,
        finishedAt,
        durationMs: 1,
        exitCode: 0,
        reason: "ok",
      },
    ]),
    reason: "ok",
  });

const doneCorrectionState = (): PipelineState => {
  const initial = createInitialPipelineState({
    storyId: "STY-321",
    runDefId: "create-story-dev-story-code-review-docs",
    runDefDigest: digest("a"),
    specFile: "story.md",
    stages: correctionStages,
    model: "test-model",
    thinking: "medium",
    startedAt: finishedAt,
  });
  const done = freezePipelineState({
    ...initial,
    runnerFeatureVersion: RUNNER_FEATURE_VERSION,
    status: "done",
    currentStage: null,
    finishedAt,
    stages: Object.freeze(
      Object.fromEntries(correctionStages.map((stage) => [stage.id, passedStage(stage.id)])),
    ),
  });
  const receipt = {
    ...checkpointFor(done),
    docs: { paths: ["README.md"], digest: digest("d") },
    finalWorkingTreeDigest: digest("e"),
  };
  return attachFinalScopeReceipt(done, receipt);
};

const correctionRequest = (overrides = {}) =>
  Object.freeze({
    kind: "supersede-contract-invalid-candidate" as const,
    expectedReceiptRunId: "run-144",
    reason: "Known contract defect: review passed but the delivered payload is invalid.",
    resetTargetStageId: "dev-story",
    supersededAt: correctionTime,
    supersededByRunId: "run-correction-1",
    ...overrides,
  });

const orderedStageIds = correctionStages.map(({ id }) => id);

describe("terminal correction transition", () => {
  it("atomically archives the exact old receipt and resets the inferred target plus downstream", () => {
    const done = doneCorrectionState();
    const oldReceipt = done.finalScopeReceipt;
    expect(oldReceipt).toBeDefined();

    const corrected = applyTerminalCorrection(done, orderedStageIds, correctionRequest());

    expect(corrected.runnerFeatureVersion).toBe(RUNNER_FEATURE_VERSION);
    expect(corrected.status).toBe("running");
    expect(corrected.currentStage).toBeNull();
    expect(corrected.finishedAt).toBeNull();
    expect(corrected).not.toHaveProperty("reviewCheckpoint");
    expect(corrected).not.toHaveProperty("finalScopeReceipt");
    expect(corrected.supersededFinalScopeReceipts).toEqual([
      {
        version: 1,
        sequence: 1,
        kind: "supersede-contract-invalid-candidate",
        supersededAt: correctionTime,
        supersededByRunId: "run-correction-1",
        expectedReceiptRunId: "run-144",
        reason: correctionRequest().reason,
        resetTargetStageId: "dev-story",
        finalScopeReceipt: oldReceipt,
      },
    ]);
    expect(corrected?.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt).toEqual(oldReceipt);
    expect(getPipelineStateInvalidReason(corrected)).toBeUndefined();
  });

  it("preserves earlier stages and all histories, attempts, economics, and regressions", () => {
    const done = doneCorrectionState();
    const corrected = applyTerminalCorrection(done, orderedStageIds, correctionRequest());

    for (const stageId of orderedStageIds) {
      expect(corrected.stages[stageId]?.history).toEqual(done.stages[stageId]?.history);
      expect(corrected.stages[stageId]?.attempts).toBe(done.stages[stageId]?.attempts);
      expect(corrected.stages[stageId]?.status).toBe("pending");
      expect(corrected.stages[stageId]?.startedAt).toBeNull();
      expect(corrected.stages[stageId]?.finishedAt).toBeNull();
    }
    expect(corrected.regressions).toBe(done.regressions);
    expect(corrected.economics).toEqual(done.economics);
    expect(corrected.startedAt).toBe(done.startedAt);
  });

  it("carries the normalized reason into the reset target findings only", () => {
    const corrected = applyTerminalCorrection(
      doneCorrectionState(),
      orderedStageIds,
      correctionRequest(),
    );

    expect(corrected.stages["dev-story"]?.findings).toEqual([correctionRequest().reason]);
    expect(corrected.stages["dev-story"]?.reason).toBeUndefined();
    expect(corrected.stages["dev-story"]?.upstreamHandoff).toBeUndefined();
    expect(corrected.stages["code-review"]?.findings).toBeUndefined();
    expect(corrected.stages["docs"]?.findings).toBeUndefined();
  });

  it("returns deeply frozen archived history", () => {
    const corrected = applyTerminalCorrection(
      doneCorrectionState(),
      orderedStageIds,
      correctionRequest(),
    );

    expect(Object.isFrozen(corrected)).toBe(true);
    expect(Object.isFrozen(corrected.supersededFinalScopeReceipts)).toBe(true);
    expect(Object.isFrozen(corrected.supersededFinalScopeReceipts?.[0])).toBe(true);
    expect(Object.isFrozen(corrected.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt)).toBe(
      true,
    );
    expect(
      Object.isFrozen(corrected.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt?.docs.paths),
    ).toBe(true);
  });

  it("appends archive records without replacing prior superseded history", () => {
    const first = applyTerminalCorrection(
      doneCorrectionState(),
      orderedStageIds,
      correctionRequest(),
    );
    const record1 = first.supersededFinalScopeReceipts?.[0];
    expect(record1).toBeDefined();

    const priorReceipt = first.supersededFinalScopeReceipts?.[0]?.finalScopeReceipt;
    if (priorReceipt === undefined) throw new Error("missing archived receipt fixture");
    const freshReceipt: FinalScopeReceipt = {
      version: 1,
      storyId: first.storyId,
      runId: "run-correction-2",
      runDefId: first.runDefId,
      runDefDigest: first.runDefDigest,
      branch: "sty-321/recovery",
      baseOid: "f".repeat(40),
      reviewed: priorReceipt.reviewed,
      qualityGate: priorReceipt.qualityGate,
      docs: priorReceipt.docs,
      finalWorkingTreeDigest: digest("f"),
    };
    const freshDone = freezePipelineState({
      ...first,
      status: "done",
      currentStage: null,
      finishedAt: correctionTime,
      stages: Object.freeze(
        Object.fromEntries(correctionStages.map((stage) => [stage.id, passedStage(stage.id)])),
      ),
      reviewCheckpoint: freshReceipt,
      finalScopeReceipt: freshReceipt,
      supersededFinalScopeReceipts: first.supersededFinalScopeReceipts ?? Object.freeze([]),
    });

    const second = applyTerminalCorrection(
      freshDone,
      orderedStageIds,
      correctionRequest({ expectedReceiptRunId: "run-correction-2", supersededByRunId: "run-c2" }),
    );

    expect(second.supersededFinalScopeReceipts).toHaveLength(2);
    expect(second.supersededFinalScopeReceipts?.[0]).toEqual(record1);
    expect(second.supersededFinalScopeReceipts?.[1]?.expectedReceiptRunId).toBe("run-correction-2");
    expect(second.supersededFinalScopeReceipts?.[1]?.finalScopeReceipt).toEqual(freshReceipt);
    expect(getPipelineStateInvalidReason(second)).toBeUndefined();
  });

  it("throws when the active receipt is missing or does not match the expected run id", () => {
    const done = doneCorrectionState();
    const withoutReceipt: PipelineState = { ...done, status: "running" };
    Reflect.deleteProperty(withoutReceipt, "reviewCheckpoint");
    Reflect.deleteProperty(withoutReceipt, "finalScopeReceipt");
    const frozenWithout = freezePipelineState(withoutReceipt);

    expect(() =>
      applyTerminalCorrection(frozenWithout, orderedStageIds, correctionRequest()),
    ).toThrow(RangeError);
    expect(() =>
      applyTerminalCorrection(
        done,
        orderedStageIds,
        correctionRequest({ expectedReceiptRunId: "run-wrong" }),
      ),
    ).toThrow(RangeError);
  });

  it("rejects an unknown reset stage like the shared reset helper", () => {
    expect(() =>
      applyTerminalCorrection(
        doneCorrectionState(),
        orderedStageIds,
        correctionRequest({ resetTargetStageId: "missing-stage" }),
      ),
    ).toThrow(RangeError);
  });

  it("preserves earlier stage state while resuming an already-applied correction", () => {
    const corrected = applyTerminalCorrection(
      doneCorrectionState(),
      orderedStageIds,
      correctionRequest(),
    );

    expect(corrected.stages["code-review"]?.status).toBe("pending");
    expect(corrected.stages["docs"]?.status).toBe("pending");
    expect(corrected.stages["code-review"]?.history).toEqual(
      doneCorrectionState().stages["code-review"]?.history,
    );
    expect(corrected.stages["code-review"]?.findings).toBeUndefined();
    expect(corrected.stages["docs"]?.findings).toBeUndefined();
  });
});
