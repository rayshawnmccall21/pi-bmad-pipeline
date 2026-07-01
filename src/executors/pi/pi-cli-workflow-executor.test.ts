import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PI_CLI_WORKFLOW_EXECUTOR_ID,
  PiCliWorkflowExecutor,
  createPiCliWorkflowExecutor,
} from "./index.js";

import type { CompiledStageDef } from "../../rundef/index.js";
import type { StageExecutionRequest, StageExecutionResult } from "../workflow-executor.js";
import type { PiCliRunBmadStage, RunBmadStageRequest } from "./index.js";

const stage = (overrides: Partial<CompiledStageDef> = {}): CompiledStageDef => ({
  id: "dev-story",
  kind: "agent",
  workflow: "dev-story",
  agent: "dev",
  index: 0,
  timeoutSeconds: 1800,
  ...overrides,
});

const request = (overrides: Partial<StageExecutionRequest> = {}): StageExecutionRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story-123.md",
  projectRoot: "/repo",
  worktreeCwd: "/repo/.worktrees/story-123",
  attempt: 1,
  signal: new AbortController().signal,
  ...overrides,
});

const result = (overrides: Partial<StageExecutionResult> = {}): StageExecutionResult => ({
  output: { ok: true },
  exitCode: 0,
  durationMs: 10,
  ...overrides,
});

const runner = (): [PiCliRunBmadStage, RunBmadStageRequest[]] => {
  const calls: RunBmadStageRequest[] = [];
  return [
    vi.fn(async (input: RunBmadStageRequest) => {
      calls.push(input);
      return result();
    }),
    calls,
  ];
};

describe("PiCliWorkflowExecutor", () => {
  it("uses the default executor id", () => {
    const [runStage] = runner();

    expect(new PiCliWorkflowExecutor({ runStage }).id).toBe(DEFAULT_PI_CLI_WORKFLOW_EXECUTOR_ID);
  });

  it("uses a custom executor id", () => {
    const [runStage] = runner();

    expect(new PiCliWorkflowExecutor({ id: "custom", runStage }).id).toBe("custom");
  });

  it("rejects blank executor ids", () => {
    const [runStage] = runner();

    expect(() => new PiCliWorkflowExecutor({ id: "  ", runStage })).toThrow(RangeError);
  });

  it("creates executors via factory", () => {
    const [runStage] = runner();

    expect(createPiCliWorkflowExecutor({ runStage })).toBeInstanceOf(PiCliWorkflowExecutor);
  });

  it("returns the stage runner result", async () => {
    const expected = result({ output: { passed: true } });
    const runStage = vi.fn(async () => expected);

    await expect(new PiCliWorkflowExecutor({ runStage }).execute(request())).resolves.toBe(
      expected,
    );
  });

  it("passes stage execution fields to runBmadStage", async () => {
    const [runStage, calls] = runner();
    const input = request({ priorFindings: ["fix lint"] });

    await new PiCliWorkflowExecutor({ runStage }).execute(input);

    expect(calls[0]).toMatchObject({
      stage: input.stage,
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      projectRoot: "/repo",
      worktreeCwd: "/repo/.worktrees/story-123",
      attempt: 1,
      priorFindings: ["fix lint"],
      signal: input.signal,
    });
  });

  it("uses default model config", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ runStage }).execute(request());

    expect(calls[0]).toMatchObject({ model: "gpt-5.5-pro", thinking: "medium" });
  });

  it("uses explicit model config", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ model: "sonnet", thinking: "high", runStage }).execute(
      request(),
    );

    expect(calls[0]).toMatchObject({ model: "sonnet", thinking: "high" });
  });

  it("leaves stage thinking for buildStageArgs to apply", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ thinking: "low", runStage }).execute(
      request({ stage: stage({ thinking: "high" }) }),
    );

    expect(calls[0]?.thinking).toBe("low");
    expect(calls[0]?.stage.thinking).toBe("high");
  });

  it("passes Pi runner options when present", async () => {
    const [runStage, calls] = runner();
    const now = (): number => 1;

    await new PiCliWorkflowExecutor({
      stageExtensionPath: "/repo/.pi/bmad/extensions/dev-story",
      piBin: "pix",
      command: "cmd",
      timeoutMs: 5,
      now,
      runStage,
    }).execute(request());

    expect(calls[0]).toMatchObject({
      stageExtensionPath: "/repo/.pi/bmad/extensions/dev-story",
      piBin: "pix",
      command: "cmd",
      timeoutMs: 5,
      now,
    });
  });

  it("omits Pi runner options when absent", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ runStage }).execute(request());

    expect(calls[0]).not.toHaveProperty("stageExtensionPath");
    expect(calls[0]).not.toHaveProperty("piBin");
    expect(calls[0]).not.toHaveProperty("command");
    expect(calls[0]).not.toHaveProperty("timeoutMs");
    expect(calls[0]).not.toHaveProperty("now");
  });

  it("does not mutate execution input", async () => {
    const [runStage] = runner();
    const input = request({ priorFindings: ["a"] });
    const before = JSON.stringify(input);

    await new PiCliWorkflowExecutor({ runStage }).execute(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});
