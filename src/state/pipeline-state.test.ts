import { describe, expect, it } from "vitest";

import {
  RUNNER_FEATURE_VERSION,
  createEmptyRunEconomicsSummary,
  createInitialPipelineState,
  createInitialStageState,
  isTerminalPipelineStatus,
  isTerminalStageStatus,
  toRunResultStatus,
} from "./pipeline-state.js";

import type { CompiledStageDef } from "../rundef/index.js";
import type { PipelineStatus, StageStatus } from "./pipeline-state.js";

const stage = (id: string, index: number): CompiledStageDef =>
  Object.freeze({
    id,
    kind: "agent",
    workflow: id,
    agent: "dev",
    index,
    timeoutSeconds: 1800,
  });

const twoStages = (): readonly CompiledStageDef[] => [
  stage("create-story", 0),
  stage("dev-story", 1),
];

describe("pipeline state contracts", () => {
  it("creates an empty frozen economics summary", () => {
    const economics = createEmptyRunEconomicsSummary();

    expect(economics).toEqual({ tokens: 0, dollars: 0 });
    expect(Object.isFrozen(economics)).toBe(true);
  });

  it("creates initial pending state for a stage", () => {
    const state = createInitialStageState(stage("dev-story", 0));

    expect(state).toEqual({
      id: "dev-story",
      status: "pending",
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      history: [],
    });
  });

  it("freezes initial stage state and history", () => {
    const state = createInitialStageState(stage("dev-story", 0));

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.history)).toBe(true);
  });

  it("creates initial durable pipeline state", () => {
    const state = createInitialPipelineState({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      stages: twoStages(),
      model: "gpt-5.5-pro",
      thinking: "high",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(state).toEqual({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      runnerFeatureVersion: RUNNER_FEATURE_VERSION,
      status: "pending",
      currentStage: null,
      stages: {
        "create-story": {
          id: "create-story",
          status: "pending",
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          history: [],
        },
        "dev-story": {
          id: "dev-story",
          status: "pending",
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          history: [],
        },
      },
      regressions: 0,
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: null,
      model: "gpt-5.5-pro",
      thinking: "high",
      economics: { tokens: 0, dollars: 0 },
    });
  });

  it("defaults initial pipeline startedAt to null", () => {
    const state = createInitialPipelineState({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      stages: twoStages(),
      model: "gpt-5.5-pro",
      thinking: "medium",
    });

    expect(state.startedAt).toBeNull();
  });

  it("freezes initial pipeline state, stage record, stage states, histories, and economics", () => {
    const state = createInitialPipelineState({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      stages: twoStages(),
      model: "gpt-5.5-pro",
      thinking: "medium",
    });

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.stages)).toBe(true);
    expect(Object.isFrozen(state.economics)).toBe(true);

    for (const stageState of Object.values(state.stages)) {
      expect(Object.isFrozen(stageState)).toBe(true);
      expect(Object.isFrozen(stageState.history)).toBe(true);
    }
  });

  it("preserves stage ids as state record keys", () => {
    const state = createInitialPipelineState({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      stages: twoStages(),
      model: "gpt-5.5-pro",
      thinking: "medium",
    });

    expect(Object.keys(state.stages)).toEqual(["create-story", "dev-story"]);
  });

  it("does not mutate compiled stage inputs", () => {
    const compiledStages = twoStages();
    const before = JSON.stringify(compiledStages);

    createInitialPipelineState({
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      worktreePath: "/tmp/worktree",
      branch: "bmad/story-123",
      stages: compiledStages,
      model: "gpt-5.5-pro",
      thinking: "medium",
    });

    expect(JSON.stringify(compiledStages)).toBe(before);
  });

  it.each([
    ["done", "passed"],
    ["failed", "failed"],
    ["needs-approval", "needs-approval"],
    ["paused", "paused"],
    ["pr-opened", "pr-opened"],
    ["needs-attention", "needs-attention"],
  ] satisfies readonly [PipelineStatus, string][])(
    "maps terminal pipeline status %j to run result status %j",
    (pipelineStatus, runResultStatus) => {
      expect(toRunResultStatus(pipelineStatus)).toBe(runResultStatus);
    },
  );

  it.each(["pending", "running"] satisfies readonly PipelineStatus[])(
    "rejects non-terminal pipeline status %j for run result conversion",
    (status) => {
      expect(() => toRunResultStatus(status)).toThrow(RangeError);
    },
  );

  it.each([
    ["pending", false],
    ["running", false],
    ["done", true],
    ["failed", true],
    ["needs-approval", true],
    ["paused", true],
    ["pr-opened", true],
    ["needs-attention", true],
  ] satisfies readonly [PipelineStatus, boolean][])(
    "detects terminal pipeline status %j",
    (status, expected) => {
      expect(isTerminalPipelineStatus(status)).toBe(expected);
    },
  );

  it.each([
    ["pending", false],
    ["running", false],
    ["passed", true],
    ["failed", true],
    ["skipped", true],
    ["blocked", true],
  ] satisfies readonly [StageStatus, boolean][])(
    "detects terminal stage status %j",
    (status, expected) => {
      expect(isTerminalStageStatus(status)).toBe(expected);
    },
  );
});
