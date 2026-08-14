import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { LocalCodeExecutor, LocalCodeSpawnError, type LocalCodeChildProcess } from "./index.js";

import type { StageExecutionRequest } from "../workflow-executor.js";

const request = (): StageExecutionRequest => ({
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
});

const codeRequest = (signal = new AbortController().signal): StageExecutionRequest => ({
  ...request(),
  stage: {
    id: "check",
    kind: "code",
    command: "npm",
    args: ["run", "check"],
    index: 0,
    timeoutSeconds: 1800,
  },
  signal,
});

const fakeChild = (pid = 4321): LocalCodeChildProcess =>
  Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as LocalCodeChildProcess;

describe("LocalCodeExecutor", () => {
  it("rejects an agent stage before spawn", () => {
    const spawn = vi.fn();
    const executor = new LocalCodeExecutor({ spawn });

    expect(() => executor.execute(request())).toThrow(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a synchronous spawn failure through the returned Promise", async () => {
    const cause = new Error("spawn failed");
    const executor = new LocalCodeExecutor({
      spawn: vi.fn(() => {
        throw cause;
      }),
    });
    let execution: Promise<unknown> | undefined;

    expect(() => {
      execution = executor.execute(codeRequest());
    }).not.toThrow();
    await expect(execution).rejects.toMatchObject({
      name: "LocalCodeSpawnError",
      command: "npm",
      cause,
    });
    await expect(execution).rejects.toBeInstanceOf(LocalCodeSpawnError);
  });

  it("spawns literal argv with the fixed process contract and discards successful output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const executor = new LocalCodeExecutor({ spawn, now: () => 10 });

    const execution = executor.execute(codeRequest());
    child.stdout.emit("data", "successful output must be discarded");
    child.stderr.emit("data", "also discarded");
    child.emit("close", 0);

    await expect(execution).resolves.toEqual({ output: null, exitCode: 0, durationMs: 0 });
    expect(spawn).toHaveBeenCalledWith("npm", ["run", "check"], {
      cwd: "/repo",
      env: process.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("caps and redacts a failing diagnostic before return", async () => {
    const child = fakeChild();
    const executor = new LocalCodeExecutor({ spawn: vi.fn(() => child) });
    const credential = `ghp_${"a".repeat(36)}`;

    const execution = executor.execute(codeRequest());
    child.stderr.emit("data", `${credential}${"x".repeat(20_000)}`);
    child.emit("close", 1);
    const result = await execution;

    expect(result.diagnostic).toContain("[REDACTED]");
    expect(result.diagnostic).not.toContain(credential);
    expect(result.diagnostic?.length).toBeLessThanOrEqual(16_384);
  });

  it("redacts credentials that straddle the diagnostic cap", async () => {
    const child = fakeChild();
    const executor = new LocalCodeExecutor({ spawn: vi.fn(() => child) });
    const credential = `ghp_${"a".repeat(36)}`;
    const visibleCredentialPrefix = credential.slice(0, 12);

    const execution = executor.execute(codeRequest());
    child.stderr.emit("data", `${"x".repeat(16_384 - 9)} ${credential}`);
    child.emit("close", 1);
    const result = await execution;

    expect(result.diagnostic).toContain("[REDACTED]");
    expect(result.diagnostic).not.toContain(visibleCredentialPrefix);
    expect(result.diagnostic?.length).toBeLessThanOrEqual(16_384);
  });

  it("preserves split UTF-8 in failure diagnostics", async () => {
    const child = fakeChild();
    const executor = new LocalCodeExecutor({ spawn: vi.fn(() => child) });
    const encoded = Buffer.from("failure: €");

    const execution = executor.execute(codeRequest());
    child.stderr.emit("data", encoded.subarray(0, encoded.length - 2));
    child.stderr.emit("data", encoded.subarray(encoded.length - 2));
    child.emit("close", 1);

    await expect(execution).resolves.toMatchObject({ diagnostic: "failure: €" });
  });

  it("decodes interleaved stdout and stderr UTF-8 independently", async () => {
    const child = fakeChild();
    const executor = new LocalCodeExecutor({ spawn: vi.fn(() => child) });
    const stdout = Buffer.from("stdout: €");

    const execution = executor.execute(codeRequest());
    child.stdout.emit("data", stdout.subarray(0, stdout.length - 2));
    child.stderr.emit("data", Buffer.from("stderr: ✓"));
    child.stdout.emit("data", stdout.subarray(stdout.length - 2));
    child.emit("close", 1);
    const result = await execution;

    expect(result.diagnostic).toBe("stdout: stderr: ✓€");
    expect(result.diagnostic).not.toContain("�");
    expect(result.diagnostic?.length).toBeLessThanOrEqual(16_384);
  });

  it("keeps SIGKILL escalation armed when the direct child closes after abort", async () => {
    vi.useFakeTimers();
    const childPid = 4321;
    const escalationMs = 25;
    const controller = new AbortController();
    const child = fakeChild(childPid);
    let descendantAlive = true;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") descendantAlive = false;
    });
    const executor = new LocalCodeExecutor({
      spawn: vi.fn(() => child),
      kill,
      killEscalationMs: escalationMs,
    });
    try {
      const execution = executor.execute(codeRequest(controller.signal));
      controller.abort();
      expect(kill).toHaveBeenCalledWith(-childPid, "SIGTERM");

      child.emit("close", null);
      await execution;
      expect(descendantAlive).toBe(true);

      vi.advanceTimersByTime(escalationMs);

      expect(kill).toHaveBeenNthCalledWith(2, -childPid, "SIGKILL");
      expect(descendantAlive).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("records a timed-out attempt when the child never closes after escalation", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const kill = vi.fn();
    const executor = new LocalCodeExecutor({
      spawn: vi.fn(() => child),
      kill,
      timeoutMs: 10,
      killEscalationMs: 20,
    });
    try {
      const execution = executor.execute(codeRequest());
      vi.advanceTimersByTime(30);

      expect(kill).toHaveBeenNthCalledWith(1, -4321, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -4321, "SIGKILL");
      await expect(execution).resolves.toMatchObject({
        output: null,
        exitCode: null,
        timedOut: true,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves timeout classification and escalation when a late child error races termination", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const kill = vi.fn();
    const executor = new LocalCodeExecutor({
      spawn: vi.fn(() => child),
      kill,
      timeoutMs: 10,
      killEscalationMs: 20,
    });
    try {
      const execution = executor.execute(codeRequest());
      const settlement = execution.then(
        (result) => ({ kind: "resolved" as const, result }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      vi.advanceTimersByTime(10);
      child.emit("error", new Error("late process error"));
      vi.advanceTimersByTime(20);

      expect(kill).toHaveBeenNthCalledWith(1, -4321, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -4321, "SIGKILL");
      expect(await settlement).toMatchObject({
        kind: "resolved",
        result: { output: null, exitCode: null, timedOut: true },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
