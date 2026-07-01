import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  GitWorktreeError,
  MAX_GIT_STDERR_CHARS,
  PIPELINE_WORKTREE_RELATIVE_DIR,
  ensureStoryWorktree,
  getPipelineWorktreesDir,
  getStoryBranchName,
  getStoryWorktreePath,
  removeStoryWorktree,
  runGitCommand,
} from "./index.js";

import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import type { GitSpawn } from "./index.js";

const projectRoot = "/repo";
const storyId = "STORY-123";
const secret = `sk-${"x".repeat(20)}`;

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kills: string[] = [];

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(String(signal));
    return true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
  readonly child: FakeChild;
}

const fakeSpawn = (): { readonly calls: SpawnCall[]; readonly spawn: GitSpawn } => {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options): ChildProcess => {
      const child = new FakeChild();
      calls.push({ command, args: [...args], options, child });
      return child as unknown as ChildProcess;
    },
  };
};

const call = (calls: readonly SpawnCall[], index: number): SpawnCall => {
  const value = calls[index];
  if (value === undefined) {
    throw new Error(`Missing spawn call ${String(index)}.`);
  }
  return value;
};

const close = (child: FakeChild, code: number | null): void => {
  child.emit("close", code);
};

const writeStdout = (child: FakeChild, text: string): void => {
  child.stdout.write(text);
};

const writeStderr = (child: FakeChild, text: string): void => {
  child.stderr.write(text);
};

const tick = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setImmediate(() => {
      resolvePromise();
    });
  });

describe("git worktrees", () => {
  it("exports constants", () => {
    expect(PIPELINE_WORKTREE_RELATIVE_DIR).toBe(".pi/pipeline/worktrees");
    expect(DEFAULT_GIT_COMMAND_TIMEOUT_MS).toBe(60_000);
    expect(MAX_GIT_STDERR_CHARS).toBe(8_192);
  });

  it("resolves worktrees base dir", () => {
    expect(getPipelineWorktreesDir(projectRoot)).toBe("/repo/.pi/pipeline/worktrees");
  });

  it("resolves story worktree path", () => {
    expect(getStoryWorktreePath(projectRoot, storyId)).toBe(
      "/repo/.pi/pipeline/worktrees/STORY-123",
    );
  });

  it("builds branch name", () => {
    expect(getStoryBranchName(storyId)).toBe("bmad/STORY-123");
  });

  it("rejects blank project root", () => {
    expect(() => getPipelineWorktreesDir(" ")).toThrow(
      new RangeError("Project root must not be blank."),
    );
  });

  it("rejects unsafe story ids", () => {
    expect(() => getStoryWorktreePath(projectRoot, "../bad")).toThrow(
      new RangeError('Invalid worktree story id "../bad".'),
    );
  });

  it("spawns git with cwd and env", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    close(call(fake.calls, 0).child, 0);

    await promise;
    expect(call(fake.calls, 0)).toMatchObject({
      command: "git",
      args: ["status"],
      options: { cwd: projectRoot, env: process.env },
    });
  });

  it("captures and redacts stdout and stderr", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    writeStdout(call(fake.calls, 0).child, `ok ${secret}`);
    writeStderr(call(fake.calls, 0).child, `err ${secret}`);
    close(call(fake.calls, 0).child, 0);

    await expect(promise).resolves.toMatchObject({
      stdout: "ok [REDACTED]",
      stderr: "err [REDACTED]",
    });
  });

  it("caps stderr", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    writeStderr(call(fake.calls, 0).child, `a${"b".repeat(MAX_GIT_STDERR_CHARS)}`);
    close(call(fake.calls, 0).child, 0);

    await expect(promise).resolves.toMatchObject({ stderr: "b".repeat(MAX_GIT_STDERR_CHARS) });
  });

  it("resolves on exit code 0", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    close(call(fake.calls, 0).child, 0);

    await expect(promise).resolves.toMatchObject({ command: "git", exitCode: 0 });
  });

  it("rejects nonzero exit with GitWorktreeError", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    writeStderr(call(fake.calls, 0).child, "bad");
    close(call(fake.calls, 0).child, 1);

    await expect(promise).rejects.toMatchObject({
      code: "git-command-failed",
      exitCode: 1,
      stderr: "bad",
    });
  });

  it("rejects null exit with GitWorktreeError", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    close(call(fake.calls, 0).child, null);

    await expect(promise).rejects.toBeInstanceOf(GitWorktreeError);
  });

  it("rejects timeout and kills child", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({
      cwd: projectRoot,
      args: ["status"],
      spawn: fake.spawn,
      timeoutMs: 1,
    });

    await expect(promise).rejects.toMatchObject({ code: "git-command-timed-out" });
    expect(call(fake.calls, 0).child.kills).toEqual(["SIGTERM"]);
  });

  it("wraps spawn error", async () => {
    const fake = fakeSpawn();
    const promise = runGitCommand({ cwd: projectRoot, args: ["status"], spawn: fake.spawn });

    call(fake.calls, 0).child.emit("error", new Error(`failed ${secret}`));

    await expect(promise).rejects.toMatchObject({
      code: "git-command-failed",
      stderr: "failed [REDACTED]",
    });
  });

  it("validates git command inputs", async () => {
    await expect(runGitCommand({ cwd: " ", args: [] })).rejects.toThrow("cwd must not be blank.");
    await expect(runGitCommand({ cwd: projectRoot, args: [" "] })).rejects.toThrow(
      "args must not be blank.",
    );
    await expect(
      runGitCommand({ cwd: projectRoot, args: ["status"], timeoutMs: 0 }),
    ).rejects.toThrow("timeoutMs must be a positive integer.");
  });

  it("ensureStoryWorktree runs prune then add", async () => {
    const fake = fakeSpawn();
    const promise = ensureStoryWorktree({ projectRoot, storyId, spawn: fake.spawn });

    close(call(fake.calls, 0).child, 0);
    await tick();
    close(call(fake.calls, 1).child, 0);

    await expect(promise).resolves.toEqual({
      storyId,
      branch: "bmad/STORY-123",
      path: "/repo/.pi/pipeline/worktrees/STORY-123",
    });
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["worktree", "prune"],
      ["worktree", "add", "-B", "bmad/STORY-123", "/repo/.pi/pipeline/worktrees/STORY-123", "HEAD"],
    ]);
  });

  it("ensureStoryWorktree supports custom branch and base ref", async () => {
    const fake = fakeSpawn();
    const promise = ensureStoryWorktree({
      projectRoot,
      storyId,
      branch: "custom",
      baseRef: "main",
      spawn: fake.spawn,
    });

    close(call(fake.calls, 0).child, 0);
    await tick();
    close(call(fake.calls, 1).child, 0);

    await promise;
    expect(call(fake.calls, 1).args).toEqual([
      "worktree",
      "add",
      "-B",
      "custom",
      "/repo/.pi/pipeline/worktrees/STORY-123",
      "main",
    ]);
  });

  it("returns frozen story worktree", async () => {
    const fake = fakeSpawn();
    const promise = ensureStoryWorktree({ projectRoot, storyId, spawn: fake.spawn });

    close(call(fake.calls, 0).child, 0);
    await tick();
    close(call(fake.calls, 1).child, 0);

    expect(Object.isFrozen(await promise)).toBe(true);
  });

  it("removeStoryWorktree runs worktree remove", async () => {
    const fake = fakeSpawn();
    const promise = removeStoryWorktree({ projectRoot, storyId, spawn: fake.spawn });

    close(call(fake.calls, 0).child, 0);

    await promise;
    expect(call(fake.calls, 0).args).toEqual([
      "worktree",
      "remove",
      "--force",
      "/repo/.pi/pipeline/worktrees/STORY-123",
    ]);
  });

  it("removeStoryWorktree treats missing worktree errors as success", async () => {
    const fake = fakeSpawn();
    const promise = removeStoryWorktree({ projectRoot, storyId, spawn: fake.spawn });

    writeStderr(call(fake.calls, 0).child, "is not a working tree");
    close(call(fake.calls, 0).child, 1);

    await expect(promise).resolves.toBeUndefined();
  });

  it("does not mutate inputs", async () => {
    const fake = fakeSpawn();
    const request = { projectRoot, storyId, spawn: fake.spawn };
    const before = JSON.stringify({ projectRoot: request.projectRoot, storyId: request.storyId });
    const promise = ensureStoryWorktree(request);

    close(call(fake.calls, 0).child, 0);
    await tick();
    close(call(fake.calls, 1).child, 0);
    await promise;

    expect(JSON.stringify({ projectRoot: request.projectRoot, storyId: request.storyId })).toBe(
      before,
    );
  });
});
