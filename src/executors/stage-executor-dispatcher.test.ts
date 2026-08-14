import { describe, expect, it, vi } from "vitest";

import { StageExecutorDispatcher } from "./index.js";

import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "./workflow-executor.js";

const codeRequest = (): StageExecutionRequest => ({
  stage: {
    id: "check",
    kind: "code",
    command: "npm",
    args: Object.freeze(["run", "check"]),
    index: 0,
    timeoutSeconds: 1800,
  },
  storyId: "STORY-123",
  specFile: "./specs/story.md",
  projectRoot: "/repo",
  attempt: 1,
  signal: new AbortController().signal,
});

describe("StageExecutorDispatcher", () => {
  it("routes an agent request only to the agent delegate without copying values", async () => {
    const request: StageExecutionRequest = {
      stage: {
        id: "dev-story",
        kind: "agent",
        workflow: "dev-story",
        agent: "dev",
        index: 0,
        timeoutSeconds: 1800,
      },
      storyId: "STORY-123",
      specFile: "./specs/story.md",
      projectRoot: "/repo",
      attempt: 1,
      signal: new AbortController().signal,
    };
    const result: StageExecutionResult = { output: { ok: true }, exitCode: 0, durationMs: 10 };
    const agentExecute = vi.fn<WorkflowExecutor["execute"]>().mockResolvedValue(result);
    const codeExecute = vi.fn<WorkflowExecutor["execute"]>();
    const dispatcher = new StageExecutorDispatcher(
      { id: "agent", execute: agentExecute },
      { id: "code", execute: codeExecute },
    );

    const actual = await dispatcher.execute(request);

    expect(agentExecute).toHaveBeenCalledOnce();
    expect(agentExecute.mock.calls[0]?.[0]).toBe(request);
    expect(codeExecute).not.toHaveBeenCalled();
    expect(actual).toBe(result);
  });

  it("routes a code request only to the code delegate without copying values", async () => {
    const request = codeRequest();
    const result: StageExecutionResult = { output: null, exitCode: 0, durationMs: 10 };
    const agentExecute = vi.fn<WorkflowExecutor["execute"]>();
    const codeExecute = vi.fn<WorkflowExecutor["execute"]>().mockResolvedValue(result);
    const dispatcher = new StageExecutorDispatcher(
      { id: "agent", execute: agentExecute },
      { id: "code", execute: codeExecute },
    );

    const actual = await dispatcher.execute(request);

    expect(codeExecute).toHaveBeenCalledOnce();
    expect(codeExecute.mock.calls[0]?.[0]).toBe(request);
    expect(agentExecute).not.toHaveBeenCalled();
    expect(actual).toBe(result);
  });

  it("preserves a code delegate error and never calls the agent delegate", async () => {
    const error = new Error("code failed");
    const agentExecute = vi.fn<WorkflowExecutor["execute"]>();
    const codeExecute = vi.fn<WorkflowExecutor["execute"]>().mockRejectedValue(error);
    const dispatcher = new StageExecutorDispatcher(
      { id: "agent", execute: agentExecute },
      { id: "code", execute: codeExecute },
    );

    await expect(dispatcher.execute(codeRequest())).rejects.toBe(error);
    expect(agentExecute).not.toHaveBeenCalled();
  });

  it("names an unsupported runtime kind without calling either delegate", () => {
    const agentExecute = vi.fn<WorkflowExecutor["execute"]>();
    const codeExecute = vi.fn<WorkflowExecutor["execute"]>();
    const dispatcher = new StageExecutorDispatcher(
      { id: "agent", execute: agentExecute },
      { id: "code", execute: codeExecute },
    );
    const invalidRequest = {
      ...codeRequest(),
      stage: { ...codeRequest().stage, kind: "plugin" },
    } as unknown as StageExecutionRequest;

    expect(() => dispatcher.execute(invalidRequest)).toThrow(/plugin/u);
    expect(agentExecute).not.toHaveBeenCalled();
    expect(codeExecute).not.toHaveBeenCalled();
  });
});
