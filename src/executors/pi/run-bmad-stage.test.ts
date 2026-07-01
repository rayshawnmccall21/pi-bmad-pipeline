import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BmadStageSpawnError,
  MAX_STAGE_STDERR_CHARS,
  runBmadStage,
  toBuildStageArgsRequest,
} from "./index.js";

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { CompiledStageDef } from "../../rundef/index.js";
import type { BmadStageSpawn, RunBmadStageRequest } from "./index.js";

const stage = (overrides: Partial<CompiledStageDef> = {}): CompiledStageDef => ({
  id: "dev-story",
  kind: "agent",
  workflow: "dev-story",
  agent: "dev",
  index: 0,
  timeoutSeconds: 1800,
  ...overrides,
});

const request = (overrides: Partial<RunBmadStageRequest> = {}): RunBmadStageRequest => ({
  stage: stage(),
  storyId: "STORY-123",
  specFile: "./specs/story-123.md",
  projectRoot: "/repo",
  worktreeCwd: "/repo/.worktrees/story-123",
  attempt: 1,
  model: "gpt-5.5-pro",
  thinking: "medium",
  signal: new AbortController().signal,
  ...overrides,
});

const createFakeChild = (): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
};

const createSpawn = (
  child = createFakeChild(),
): [BmadStageSpawn, ChildProcessWithoutNullStreams] => [vi.fn(() => child), child];

const close = (child: ChildProcessWithoutNullStreams, code: number | null): void => {
  child.emit("close", code, null);
};

const writeStdout = (child: ChildProcessWithoutNullStreams, text: string): void => {
  (child.stdout as PassThrough).write(text);
};

const writeStderr = (child: ChildProcessWithoutNullStreams, text: string): void => {
  (child.stderr as PassThrough).write(text);
};

describe("run BMAD stage", () => {
  it("maps requests to build-stage-args requests", () => {
    const input = request({
      priorFindings: ["a"],
      stageExtensionPath: "/ext",
      piBin: "pix",
      command: "cmd",
    });

    expect(toBuildStageArgsRequest(input)).toEqual({
      stage: input.stage,
      storyId: "STORY-123",
      specFile: "./specs/story-123.md",
      projectRoot: "/repo",
      worktreeCwd: "/repo/.worktrees/story-123",
      attempt: 1,
      model: "gpt-5.5-pro",
      thinking: "medium",
      priorFindings: ["a"],
      stageExtensionPath: "/ext",
      piBin: "pix",
      command: "cmd",
    });
  });

  it("omits optional build-stage-args fields when absent", () => {
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("priorFindings");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("stageExtensionPath");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("piBin");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("command");
  });

  it("spawns with built bin, args, and cwd", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, piBin: "pix", command: "cmd" }));
    close(child, 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "pix",
      expect.arrayContaining(["cmd", "--workflow", "dev-story"]),
      expect.objectContaining({ cwd: "/repo/.worktrees/story-123" }) as SpawnOptionsWithoutStdio,
    );
  });

  it("parses stdout JSONL and returns the last output", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{"first":true}\n{"second":true}\n');
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ output: { second: true }, exitCode: 0 });
  });

  it("extracts valid usage from final output", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{"usage":{"tokens":10,"dollars":0.25}}\n');
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ usage: { tokens: 10, dollars: 0.25 } });
  });

  it("omits invalid usage", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{"usage":{"tokens":-1,"dollars":0}}\n');
    close(child, 0);

    expect(await promise).not.toHaveProperty("usage");
  });

  it("captures the first JSONL issue as parseError", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{bad}\n{"ok":true}\n');
    close(child, 0);

    expect((await promise).parseError).toMatch(/^Invalid JSONL on line 1:/u);
  });

  it("uses stderr fallback for nonzero exit with no output", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStderr(child, "boom");
    close(child, 1);

    await expect(promise).resolves.toMatchObject({ parseError: "Child stderr: boom" });
  });

  it("caps captured stderr", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStderr(child, "x".repeat(MAX_STAGE_STDERR_CHARS + 10));
    close(child, 1);

    expect((await promise).parseError).toHaveLength(
      "Child stderr: ".length + MAX_STAGE_STDERR_CHARS,
    );
  });

  it("returns child exit code from close", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    close(child, 7);

    await expect(promise).resolves.toMatchObject({ exitCode: 7 });
  });

  it("returns non-negative duration using injected clock", async () => {
    const [spawn, child] = createSpawn();
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(90);

    const promise = runBmadStage(request({ spawn, now }));
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ durationMs: 0 });
  });

  it("marks timedOut and kills child on timeout", async () => {
    vi.useFakeTimers();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, timeoutMs: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    close(child, null);

    await expect(promise).resolves.toMatchObject({ timedOut: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("marks aborted and kills child on abort", async () => {
    const controller = new AbortController();
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, signal: controller.signal }));
    controller.abort();
    close(child, null);

    await expect(promise).resolves.toMatchObject({ aborted: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks already aborted requests", async () => {
    const controller = new AbortController();
    const [spawn, child] = createSpawn();
    controller.abort();

    const promise = runBmadStage(request({ spawn, signal: controller.signal }));
    close(child, null);

    await expect(promise).resolves.toMatchObject({ aborted: true });
  });

  it("rejects with BmadStageSpawnError when spawn throws", async () => {
    const spawn = vi.fn(() => {
      throw new Error("missing binary");
    });

    await expect(runBmadStage(request({ spawn }))).rejects.toBeInstanceOf(BmadStageSpawnError);
  });

  it("rejects with BmadStageSpawnError on child error", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    child.emit("error", new Error("spawn failed"));
    close(child, 1);

    await expect(promise).rejects.toBeInstanceOf(BmadStageSpawnError);
  });

  it("ignores child errors after close", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    close(child, 0);
    child.emit("error", new Error("late error"));

    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("rejects invalid timeoutMs", () => {
    expect(() => runBmadStage(request({ timeoutMs: 0 }))).toThrow(RangeError);
  });

  it("omits optional result fields when absent", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn }));
    writeStdout(child, '{"ok":true}\n');
    close(child, 0);
    const result = await promise;

    expect(result).not.toHaveProperty("parseError");
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("timedOut");
    expect(result).not.toHaveProperty("aborted");
  });

  it("does not mutate request or prior findings", async () => {
    const findings = ["a"];
    const [spawn, child] = createSpawn();
    const input = request({ spawn, priorFindings: findings });
    const before = JSON.stringify({ input, findings });

    const promise = runBmadStage(input);
    close(child, 0);
    await promise;

    expect(JSON.stringify({ input, findings })).toBe(before);
  });
});
