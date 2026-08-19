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
import { attachFinalScopeReceipt, attachReviewCheckpoint } from "./runner-transitions.js";

const finishedAt = "2026-08-19T00:00:00.000Z";
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
