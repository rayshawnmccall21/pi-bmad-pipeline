import { describe, expect, it, vi } from "vitest";

import { PI_CLI_WORKFLOW_EXECUTOR_ID, PiCliWorkflowExecutor } from "./index.js";

import type { CompiledStageDef } from "../../rundef/index.js";
import type { StageExecutionRequest, StageExecutionResult } from "../workflow-executor.js";
import type { RunBmadStageFunction, RunBmadStageRequest } from "./index.js";

const stage = (): CompiledStageDef => ({
  id: "dev-story",
  kind: "agent",
  workflow: "dev-story",
  agent: "dev",
  index: 0,
  timeoutSeconds: 1800,
});

const request = (): StageExecutionRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story.md",
  projectRoot: "/repo",
  worktreeCwd: "/repo-worktree",
  attempt: 1,
  priorFindings: ["fix test"],
  signal: new AbortController().signal,
});

const result: StageExecutionResult = {
  output: { ok: true },
  exitCode: 0,
  durationMs: 10,
};

const runner = (): [RunBmadStageFunction, RunBmadStageRequest[]] => {
  const calls: RunBmadStageRequest[] = [];
  return [
    vi.fn(async (input: RunBmadStageRequest) => {
      calls.push(input);
      return result;
    }),
    calls,
  ];
};

describe("PiCliWorkflowExecutor", () => {
  it("exports executor id", () => {
    expect(PI_CLI_WORKFLOW_EXECUTOR_ID).toBe("pi-cli");
  });

  it("constructor sets id", () => {
    const [runStage] = runner();

    expect(new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).id).toBe(
      "pi-cli",
    );
  });

  it("constructor rejects blank model", () => {
    const [runStage] = runner();

    expect(() => new PiCliWorkflowExecutor({ model: " ", thinking: "medium", runStage })).toThrow(
      new RangeError("model must not be blank."),
    );
  });

  it("constructor rejects blank optional piBin", () => {
    const [runStage] = runner();

    expect(
      () => new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", piBin: "", runStage }),
    ).toThrow(new RangeError("piBin must not be blank."));
  });

  it("constructor rejects blank optional piBmadExtensionPath", () => {
    const [runStage] = runner();

    expect(
      () =>
        new PiCliWorkflowExecutor({
          model: "gpt-5",
          thinking: "medium",
          piBmadExtensionPath: " ",
          runStage,
        }),
    ).toThrow(new RangeError("piBmadExtensionPath must not be blank."));
  });

  it("execute calls injected runStage with required request fields", async () => {
    const [runStage, calls] = runner();
    const input = request();

    await new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).execute(
      input,
    );

    expect(calls[0]).toMatchObject({
      stage: input.stage,
      storyId: "STORY-123",
      specFile: "./specs/story.md",
      projectRoot: "/repo",
      worktreeCwd: "/repo-worktree",
      attempt: 1,
      priorFindings: ["fix test"],
      signal: input.signal,
    });
  });

  it("execute passes configured model and thinking", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "high", runStage }).execute(
      request(),
    );

    expect(calls[0]).toMatchObject({ model: "gpt-5", thinking: "high" });
  });

  it("execute passes optional piBin and piBmadExtensionPath when configured", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({
      model: "gpt-5",
      thinking: "medium",
      piBin: "pix",
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      runStage,
    }).execute(request());

    expect(calls[0]).toMatchObject({
      piBin: "pix",
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
    });
  });

  it("execute omits optional piBin and piBmadExtensionPath when absent", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).execute(
      request(),
    );

    expect(calls[0]).not.toHaveProperty("piBin");
    expect(calls[0]).not.toHaveProperty("piBmadExtensionPath");
  });

  it("execute passes injected spawn", async () => {
    const [runStage, calls] = runner();
    const spawn = vi.fn();

    await new PiCliWorkflowExecutor({
      model: "gpt-5",
      thinking: "medium",
      spawn,
      runStage,
    }).execute(request());

    expect(calls[0]?.spawn).toBe(spawn);
  });

  it("execute passes stageExtensionPath from resolver", async () => {
    const [runStage, calls] = runner();
    const input = request();

    await new PiCliWorkflowExecutor({
      model: "gpt-5",
      thinking: "medium",
      resolveStageExtensionPath: (stageRequest) => `${stageRequest.projectRoot}/.pi/ext`,
      runStage,
    }).execute(input);

    expect(calls[0]).toMatchObject({ stageExtensionPath: "/repo/.pi/ext" });
  });

  it("execute omits stageExtensionPath when resolver returns undefined", async () => {
    const [runStage, calls] = runner();

    await new PiCliWorkflowExecutor({
      model: "gpt-5",
      thinking: "medium",
      resolveStageExtensionPath: () => undefined,
      runStage,
    }).execute(request());

    expect(calls[0]).not.toHaveProperty("stageExtensionPath");
  });

  it("execute returns the exact result from runStage", async () => {
    const expected = { ...result, output: { exact: true } };
    const runStage = vi.fn(async () => expected);

    await expect(
      new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).execute(
        request(),
      ),
    ).resolves.toBe(expected);
  });

  it("execute propagates runStage errors", async () => {
    const error = new Error("boom");
    const runStage = vi.fn(async () => {
      throw error;
    });

    await expect(
      new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).execute(
        request(),
      ),
    ).rejects.toBe(error);
  });

  it("execute does not mutate input request or priorFindings", async () => {
    const [runStage] = runner();
    const input = request();
    const before = JSON.stringify(input);

    await new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium", runStage }).execute(
      input,
    );

    expect(JSON.stringify(input)).toBe(before);
  });
});
