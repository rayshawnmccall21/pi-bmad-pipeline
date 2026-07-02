import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { buildEmissionProvenance } from "pi-bmad";
import { describe, expect, it, vi } from "vitest";

import {
  BmadStageSpawnError,
  MAX_STAGE_STDERR_CHARS,
  resolvePiBmadExtensionPath,
  runBmadStage,
  toBuildStageArgsRequest,
} from "./index.js";

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { CompiledStageDef } from "../../rundef/index.js";
import type { BmadStageSpawn, RunBmadStageRequest } from "./index.js";

const piBmadRootDir = resolve(dirname(resolvePiBmadExtensionPath()), "..");

const loadFixtureEnvelope = (): Record<string, unknown> => {
  const line = readFileSync(
    join(piBmadRootDir, "contracts", "fixtures", "dev-story", "success.jsonl"),
    "utf8",
  ).trim();
  const parsed = JSON.parse(line) as {
    result: { details: { headlessOutput: Record<string, unknown> } };
  };
  return parsed.result.details.headlessOutput;
};

const stampedEnvelope = (emissionKey: string): Record<string, unknown> => {
  const envelope = loadFixtureEnvelope();
  return { ...envelope, emissionProvenance: buildEmissionProvenance(emissionKey, envelope) };
};

const toolEndLine = (headlessOutput: unknown): string =>
  `${JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bmad_emit_result",
    isError: false,
    result: { details: { headlessOutput } },
  })}\n`;

const messageEndLine = (totalTokens: number, total: number): string =>
  `${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { totalTokens, cost: { total } } },
  })}\n`;

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
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      emissionKey: "key-1",
      runId: "run-9",
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
      piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
      emissionKey: "key-1",
      runId: "run-9",
    });
  });

  it("omits optional build-stage-args fields when absent", () => {
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("priorFindings");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("stageExtensionPath");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("piBin");
    expect(toBuildStageArgsRequest(request())).not.toHaveProperty("runId");
  });

  it("resolves the pi-bmad extension path when not provided", () => {
    const mapped = toBuildStageArgsRequest(request());

    expect(mapped.piBmadExtensionPath).toContain("pi-bmad");
  });

  it("generates a fresh emission key per run when not provided", () => {
    const first = toBuildStageArgsRequest(request());
    const second = toBuildStageArgsRequest(request());

    expect(first.emissionKey.trim().length).toBeGreaterThan(0);
    expect(first.emissionKey).not.toBe(second.emissionKey);
  });

  it("spawns with built bin, args, cwd, and the emission env contract", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(
      request({
        spawn,
        piBin: "pix",
        piBmadExtensionPath: "/deps/pi-bmad/extensions/pi-bmad.ts",
        emissionKey: "key-1",
      }),
    );
    close(child, 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "pix",
      expect.arrayContaining(["--bmad-workflow", "dev-story", "--bmad-story", "STORY-123"]),
      expect.objectContaining({
        cwd: "/repo/.worktrees/story-123",
        env: expect.objectContaining({
          PI_BMAD_RUN_ID: "STORY-123.dev-story.1",
          PI_BMAD_EMISSION_KEY: "key-1",
        }) as NodeJS.ProcessEnv,
      }) as SpawnOptionsWithoutStdio,
    );
  });

  it("returns the gated headless envelope from tool_execution_end, not the last record", async () => {
    const [spawn, child] = createSpawn();
    const envelope = stampedEnvelope("key-1");

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${toolEndLine(envelope)}{"type":"agent_end"}\n`);
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ output: envelope, exitCode: 0 });
  });

  it("fails closed when the terminal envelope is forged (bare last line)", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${JSON.stringify(loadFixtureEnvelope())}\n`);
    close(child, 0);
    const result = await promise;

    expect(result.output).toBeNull();
    expect(result.parseError).toMatch(/No headless terminal output/u);
  });

  it("fails closed when the envelope is stamped with a different emission key", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("other-key")));
    close(child, 0);
    const result = await promise;

    expect(result.output).toBeNull();
    expect(result.parseError).toMatch(/provenance/u);
  });

  it("aggregates assistant usage from message_end events", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, `${messageEndLine(10, 0.25)}${messageEndLine(5, 0.5)}`);
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
    close(child, 0);

    await expect(promise).resolves.toMatchObject({ usage: { tokens: 15, dollars: 0.75 } });
  });

  it("omits invalid usage", async () => {
    const [spawn, child] = createSpawn();

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(
      child,
      '{"type":"message_end","message":{"role":"assistant","usage":{"totalTokens":-1,"cost":{"total":0}}}}\n',
    );
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
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

    const promise = runBmadStage(request({ spawn, emissionKey: "key-1" }));
    writeStdout(child, toolEndLine(stampedEnvelope("key-1")));
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
