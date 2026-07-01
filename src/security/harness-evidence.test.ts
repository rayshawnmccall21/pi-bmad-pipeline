import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HARNESS_EVIDENCE_COMMANDS,
  DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS,
  MAX_HARNESS_EVIDENCE_OUTPUT_CHARS,
  runHarnessEvidence,
  runHarnessEvidenceCommand,
} from "./index.js";

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  HarnessEvidenceCommand,
  HarnessEvidenceCommandResult,
  HarnessEvidenceSpawn,
} from "./index.js";

const command = (overrides: Partial<HarnessEvidenceCommand> = {}): HarnessEvidenceCommand => ({
  name: "test",
  command: "npm",
  args: ["test"],
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
  children: readonly ChildProcessWithoutNullStreams[] = [createFakeChild()],
): [HarnessEvidenceSpawn, readonly ChildProcessWithoutNullStreams[]] => {
  let index = 0;
  return [
    vi.fn(() => {
      const child = childAt(children, index);
      index += 1;
      if (child === undefined) {
        throw new Error("missing fake child");
      }
      return child;
    }),
    children,
  ];
};

const childAt = (
  children: readonly ChildProcessWithoutNullStreams[],
  index: number,
): ChildProcessWithoutNullStreams => {
  const child = children[index];
  if (child === undefined) {
    throw new Error(`Missing fake child ${String(index)}.`);
  }
  return child;
};

const close = (child: ChildProcessWithoutNullStreams, code: number | null): void => {
  child.emit("close", code, null);
};

const writeStdout = (child: ChildProcessWithoutNullStreams, text: string): void => {
  (child.stdout as PassThrough).write(text);
};

const writeStderr = (child: ChildProcessWithoutNullStreams, text: string): void => {
  (child.stderr as PassThrough).write(text);
};

describe("harness evidence", () => {
  it("defines default commands", () => {
    expect(DEFAULT_HARNESS_EVIDENCE_COMMANDS).toEqual([
      { name: "test", command: "npm", args: ["test"] },
      { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
      { name: "lint", command: "npm", args: ["run", "lint"] },
    ]);
  });

  it("rejects blank project root", async () => {
    await expect(runHarnessEvidence({ projectRoot: " " })).rejects.toThrow(
      new RangeError("Project root must not be blank."),
    );
  });

  it("rejects blank command", () => {
    expect(() => runHarnessEvidenceCommand("/repo", command({ command: " " }))).toThrow(
      new RangeError("command must not be blank."),
    );
  });

  it("rejects blank args", () => {
    expect(() => runHarnessEvidenceCommand("/repo", command({ args: [""] }))).toThrow(
      new RangeError("arg must not be blank."),
    );
  });

  it("rejects invalid timeout", () => {
    expect(() => runHarnessEvidenceCommand("/repo", command({ timeoutMs: 0 }))).toThrow(
      new RangeError("timeoutMs must be a positive integer."),
    );
  });

  it("spawns with cwd and env", async () => {
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
    close(childAt(children, 0), 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["test"],
      expect.objectContaining({ cwd: "/repo", env: process.env }) as SpawnOptionsWithoutStdio,
    );
  });

  it("captures stdout and stderr", async () => {
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
    writeStdout(childAt(children, 0), "ok");
    writeStderr(childAt(children, 0), "warn");
    close(childAt(children, 0), 0);

    await expect(promise).resolves.toMatchObject({ stdout: "ok", stderr: "warn" });
  });

  it("redacts credentials from stdout, stderr, and errors", async () => {
    const [spawn, children] = createSpawn();
    const token = "Bearer abcdefghijklmnopqrstuvwxyz123456";

    const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
    writeStdout(childAt(children, 0), token);
    writeStderr(childAt(children, 0), token);
    childAt(children, 0).emit("error", new Error(token));

    const result = await promise;

    expect(result).toMatchObject({ stdout: "", stderr: "" });
    expect(result.error).toContain("Error: [REDACTED]");
    expect(result.error).not.toContain(token);
  });

  it("caps stdout and stderr length", async () => {
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
    writeStdout(childAt(children, 0), "x".repeat(MAX_HARNESS_EVIDENCE_OUTPUT_CHARS + 1));
    writeStderr(childAt(children, 0), "y".repeat(MAX_HARNESS_EVIDENCE_OUTPUT_CHARS + 1));
    close(childAt(children, 0), 0);
    const result = await promise;

    expect(result.stdout).toHaveLength(MAX_HARNESS_EVIDENCE_OUTPUT_CHARS);
    expect(result.stderr).toHaveLength(MAX_HARNESS_EVIDENCE_OUTPUT_CHARS);
  });

  it("returns passed for exit 0", async () => {
    await expect(runClosedCommand(0)).resolves.toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("returns failed for nonzero exits", async () => {
    await expect(runClosedCommand(1)).resolves.toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("returns failed for null exit code", async () => {
    await expect(runClosedCommand(null)).resolves.toMatchObject({
      status: "failed",
      exitCode: null,
    });
  });

  it("returns spawn-failed for spawn errors", async () => {
    const spawn = vi.fn(() => {
      throw new Error("spawn failed");
    });

    const result = await runHarnessEvidenceCommand("/repo", command(), { spawn });

    expect(result).toMatchObject({ status: "spawn-failed", exitCode: null });
    expect(result.error).toContain("Error: spawn failed");
  });

  it("returns timed-out and kills child on timeout", async () => {
    vi.useFakeTimers();
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command({ timeoutMs: 1 }), { spawn });
    await vi.advanceTimersByTimeAsync(1);
    close(childAt(children, 0), null);

    await expect(promise).resolves.toMatchObject({ status: "timed-out", timedOut: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(childAt(children, 0).kill)).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("returns aborted and kills child on abort", async () => {
    const controller = new AbortController();
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command(), {
      spawn,
      signal: controller.signal,
    });
    controller.abort();
    close(childAt(children, 0), null);

    await expect(promise).resolves.toMatchObject({ status: "aborted", aborted: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- fake child kill is a vi.fn.
    expect(vi.mocked(childAt(children, 0).kill)).toHaveBeenCalledWith("SIGTERM");
  });

  it("runs commands sequentially", async () => {
    const children = [createFakeChild(), createFakeChild()];
    const [spawn] = createSpawn(children);
    const commands = [command(), command({ name: "lint", args: ["run", "lint"] })];

    const promise = runHarnessEvidence({ projectRoot: "/repo", commands, spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    close(childAt(children, 0), 0);
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    close(childAt(children, 1), 0);

    await expect(promise).resolves.toMatchObject({ passed: true });
  });

  it("continues after failed commands", async () => {
    const children = [createFakeChild(), createFakeChild()];
    const [spawn] = createSpawn(children);
    const commands = [command(), command({ name: "lint", args: ["run", "lint"] })];

    const promise = runHarnessEvidence({ projectRoot: "/repo", commands, spawn });
    close(childAt(children, 0), 1);
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    close(childAt(children, 1), 0);
    const report = await promise;

    expect(report.passed).toBe(false);
    expect(report.commands.map((result) => result.status)).toEqual(["failed", "passed"]);
  });

  it("sets report passed only when all commands pass", async () => {
    expect(await runReportWithExitCodes([0, 0])).toMatchObject({ passed: true });
    expect(await runReportWithExitCodes([0, 1])).toMatchObject({ passed: false });
  });

  it("freezes report and nested results", async () => {
    const report = await runReportWithExitCodes([0]);

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.commands)).toBe(true);
    expect(Object.isFrozen(report.commands[0])).toBe(true);
  });

  it("does not mutate inputs", async () => {
    const [spawn, children] = createSpawn();
    const input = command({ args: ["test"] });
    const before = JSON.stringify(input);

    const promise = runHarnessEvidenceCommand("/repo", input, { spawn });
    close(childAt(children, 0), 0);
    await promise;

    expect(JSON.stringify(input)).toBe(before);
  });

  it("uses default timeout", async () => {
    const [spawn, children] = createSpawn();

    const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
    close(childAt(children, 0), 0);
    await promise;

    expect(DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

const runClosedCommand = async (code: number | null): Promise<HarnessEvidenceCommandResult> => {
  const [spawn, children] = createSpawn();
  const promise = runHarnessEvidenceCommand("/repo", command(), { spawn });
  close(childAt(children, 0), code);
  return promise;
};

const runReportWithExitCodes = async (
  codes: readonly number[],
): Promise<Awaited<ReturnType<typeof runHarnessEvidence>>> => {
  const children = codes.map(() => createFakeChild());
  const [spawn] = createSpawn(children);
  const commands = codes.map((_, index) => command({ name: index === 0 ? "test" : "lint" }));
  const promise = runHarnessEvidence({ projectRoot: "/repo", commands, spawn });
  for (const [index, code] of codes.entries()) {
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(index + 1);
    });
    close(childAt(children, index), code);
  }
  return promise;
};
