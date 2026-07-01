import { describe, expect, it } from "vitest";

import type { CompiledStageDef } from "../rundef/index.js";
import {
  createInitialPipelineState,
  getFirstIncompleteStageId,
  reconcilePipelineState,
} from "./index.js";

import type { PipelineState, StageAttemptState, StageState } from "./index.js";

const stage = (id: string, index: number): CompiledStageDef => ({
  id,
  kind: "agent",
  workflow: id,
  agent: "dev",
  index,
  timeoutSeconds: 1800,
});

const compiledStages = (): readonly CompiledStageDef[] => [
  stage("create-story", 0),
  stage("dev-story", 1),
];

const createState = (): PipelineState =>
  createInitialPipelineState({
    storyId: "STORY-123",
    specFile: "./specs/story-123.md",
    worktreePath: "/tmp/worktree",
    branch: "bmad/story-123",
    stages: compiledStages(),
    model: "gpt-5.5-pro",
    thinking: "high",
  });

const attempt = (usage?: {
  readonly tokens: number;
  readonly dollars: number;
}): StageAttemptState => ({
  attempt: 1,
  status: "passed",
  startedAt: "2026-07-01T00:00:00.000Z",
  finishedAt: "2026-07-01T00:00:01.000Z",
  durationMs: 1000,
  exitCode: 0,
  ...(usage === undefined ? {} : { usage }),
});

const withStage = (state: PipelineState, id: string, next: Partial<StageState>): PipelineState => ({
  ...state,
  stages: {
    ...state.stages,
    [id]: {
      ...state.stages[id]!,
      ...next,
    },
  },
});

describe("pipeline state reconciliation", () => {
  it("returns no changes for valid initial state", () => {
    const state = createState();

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.changed).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.state).toEqual(state);
  });

  it("adds missing compiled stages as pending", () => {
    const state = createState();
    const remaining = { "create-story": state.stages["create-story"]! };

    const result = reconcilePipelineState({
      state: { ...state, stages: remaining },
      stages: compiledStages(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("missing-stage-added");
    expect(result.state.stages["dev-story"]?.status).toBe("pending");
  });

  it("removes unknown stages", () => {
    const state = createState();
    const unknown = { ...state.stages["dev-story"]!, id: "unknown-stage" };

    const result = reconcilePipelineState({
      state: { ...state, stages: { ...state.stages, "unknown-stage": unknown } },
      stages: compiledStages(),
    });

    expect(result.issues.map((issue) => issue.code)).toContain("unknown-stage-removed");
    expect(result.state.stages["unknown-stage"]).toBeUndefined();
  });

  it("rebuilds stage records in compiled stage order", () => {
    const state = createState();
    const reversed = {
      "dev-story": state.stages["dev-story"]!,
      "create-story": state.stages["create-story"]!,
    };

    const result = reconcilePipelineState({
      state: { ...state, stages: reversed },
      stages: compiledStages(),
    });

    expect(Object.keys(result.state.stages)).toEqual(["create-story", "dev-story"]);
  });

  it("resets top-level running pipeline state", () => {
    const state = {
      ...createState(),
      status: "running",
      finishedAt: "2026-07-01T00:00:00.000Z",
    } as PipelineState;

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.status).toBe("pending");
    expect(result.state.finishedAt).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("running-pipeline-reset");
  });

  it("resets running stages without adding fake history", () => {
    const state = withStage(createState(), "dev-story", {
      status: "running",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.stages["dev-story"]?.status).toBe("pending");
    expect(result.state.stages["dev-story"]?.startedAt).toBeNull();
    expect(result.state.stages["dev-story"]?.finishedAt).toBeNull();
    expect(result.state.stages["dev-story"]?.history).toEqual([]);
  });

  it("clears currentStage for terminal pipeline states", () => {
    const state = {
      ...createState(),
      status: "done",
      currentStage: "dev-story",
      finishedAt: "2026-07-01T00:00:00.000Z",
    } as PipelineState;

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.currentStage).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("terminal-current-stage-cleared");
  });

  it("clears invalid currentStage for non-terminal states", () => {
    const state = { ...createState(), currentStage: "unknown-stage" };

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.currentStage).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("current-stage-repaired");
  });

  it("sets missing terminal finishedAt with injected time", () => {
    const state = { ...createState(), status: "failed", finishedAt: null } as PipelineState;

    const result = reconcilePipelineState({
      state,
      stages: compiledStages(),
      now: () => new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(result.state.finishedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(result.issues.map((issue) => issue.code)).toContain("finished-at-repaired");
  });

  it("clears non-terminal finishedAt", () => {
    const state = { ...createState(), finishedAt: "2026-07-01T00:00:00.000Z" };

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.finishedAt).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("finished-at-repaired");
  });

  it("repairs stage attempts to history length", () => {
    const state = withStage(createState(), "dev-story", { attempts: 99, history: [attempt()] });

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.stages["dev-story"]?.attempts).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain("stage-attempts-repaired");
  });

  it("recomputes economics from attempt usage", () => {
    const state = withStage(createState(), "dev-story", {
      attempts: 1,
      history: [attempt({ tokens: 10, dollars: 0.25 })],
    });

    const result = reconcilePipelineState({ state, stages: compiledStages() });

    expect(result.state.economics).toEqual({ tokens: 10, dollars: 0.25 });
    expect(result.issues.map((issue) => issue.code)).toContain("economics-recomputed");
  });

  it("finds the first incomplete stage", () => {
    const state = withStage(createState(), "create-story", { status: "passed" });

    expect(getFirstIncompleteStageId(state, compiledStages())).toBe("dev-story");
  });

  it("returns null when all stages are passed or skipped", () => {
    let state = withStage(createState(), "create-story", { status: "passed" });
    state = withStage(state, "dev-story", { status: "skipped" });

    expect(getFirstIncompleteStageId(state, compiledStages())).toBeNull();
  });

  it("returns frozen output state and nested objects", () => {
    const result = reconcilePipelineState({ state: createState(), stages: compiledStages() });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.stages)).toBe(true);
    expect(Object.isFrozen(result.state.economics)).toBe(true);
    for (const stageState of Object.values(result.state.stages)) {
      expect(Object.isFrozen(stageState)).toBe(true);
      expect(Object.isFrozen(stageState.history)).toBe(true);
    }
  });

  it("does not mutate input state", () => {
    const state = withStage(createState(), "dev-story", { status: "running" });
    const before = JSON.stringify(state);

    reconcilePipelineState({ state, stages: compiledStages() });

    expect(JSON.stringify(state)).toBe(before);
  });
});
