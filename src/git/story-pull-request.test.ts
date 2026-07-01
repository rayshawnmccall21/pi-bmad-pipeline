import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  MAX_GH_STDERR_CHARS,
  StoryPullRequestError,
  buildStoryPullRequestBody,
  buildStoryPullRequestTitle,
  openStoryPullRequest,
  parsePullRequestNumber,
} from "./index.js";

import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";
import type { StoryPullRequestSpawn } from "./index.js";

const projectRoot = "/repo";
const worktreePath = "/repo/.pi/pipeline/worktrees/STORY-123";
const storyId = "STORY-123";
const branch = "bmad/STORY-123";
const prUrl = "https://github.com/owner/repo/pull/123";
const secret = (): string => `sk-${"a".repeat(24)}`;

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
  readonly child: FakeChild;
}

const fakeSpawn = (): { readonly calls: SpawnCall[]; readonly spawn: StoryPullRequestSpawn } => {
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

const request = (spawn: StoryPullRequestSpawn) => ({
  projectRoot,
  worktreePath,
  storyId,
  branch,
  spawn,
});

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
  child.stdout.emit("data", text);
};

const writeStderr = (child: FakeChild, text: string): void => {
  child.stderr.emit("data", text);
};

const tick = async (): Promise<void> =>
  new Promise((resolvePromise) => {
    setImmediate(() => {
      resolvePromise();
    });
  });

const finishHappyPath = async (calls: readonly SpawnCall[], url = prUrl): Promise<void> => {
  writeStdout(call(calls, 0).child, "+clean\n");
  await tick();
  close(call(calls, 0).child, 0);
  await tick();
  close(call(calls, 1).child, 0);
  await tick();
  writeStdout(call(calls, 2).child, `${url}\n`);
  await tick();
  close(call(calls, 2).child, 0);
};

describe("story pull request", () => {
  it("builds default title", () => {
    expect(buildStoryPullRequestTitle(storyId)).toBe("BMAD: STORY-123");
  });

  it("uses custom title unchanged", () => {
    expect(buildStoryPullRequestTitle(storyId, " Custom title ")).toBe(" Custom title ");
  });

  it("builds default body", () => {
    expect(buildStoryPullRequestBody(storyId)).toBe(
      "Automated BMAD pipeline output for STORY-123.",
    );
  });

  it("uses custom body unchanged", () => {
    expect(buildStoryPullRequestBody(storyId, " Custom body ")).toBe(" Custom body ");
  });

  it("rejects unsafe story ids", () => {
    expect(() => buildStoryPullRequestTitle("../bad")).toThrow(
      new RangeError('Invalid story id "../bad".'),
    );
  });

  it("parses PR number from GitHub URL", () => {
    expect(parsePullRequestNumber(prUrl)).toBe(123);
  });

  it("returns undefined for URLs without PR number", () => {
    expect(parsePullRequestNumber("https://github.com/owner/repo/issues/123")).toBeUndefined();
  });

  it("runs staged diff scan before push and PR create", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    await finishHappyPath(fake.calls);
    await promise;

    expect(fake.calls.map((spawnCall) => spawnCall.command)).toEqual(["git", "git", "gh"]);
    expect(call(fake.calls, 0).args).toEqual(["diff", "--cached", "--unified=0"]);
    expect(call(fake.calls, 0).options.cwd).toBe(worktreePath);
  });

  it("falls back to unstaged diff when staged diff is blank", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    close(call(fake.calls, 0).child, 0);
    await tick();
    expect(call(fake.calls, 1).args).toEqual(["diff", "--unified=0"]);
    close(call(fake.calls, 1).child, 0);
    await tick();
    close(call(fake.calls, 2).child, 0);
    await tick();
    writeStdout(call(fake.calls, 3).child, `${prUrl}\n`);
    await tick();
    close(call(fake.calls, 3).child, 0);

    await promise;
  });

  it("blocks PR when diff scan finds a secret", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    writeStdout(call(fake.calls, 0).child, `+key = ${secret()}`);
    await tick();
    close(call(fake.calls, 0).child, 0);

    await expect(promise).rejects.toMatchObject({ code: "secret-scan-blocked" });
    expect(fake.calls).toHaveLength(1);
  });

  it("pushes branch", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    await finishHappyPath(fake.calls);
    await promise;

    expect(call(fake.calls, 1).args).toEqual(["push", "--set-upstream", "origin", branch]);
  });

  it("creates PR with title and body", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest({ ...request(fake.spawn), title: "Title", body: "Body" });

    await finishHappyPath(fake.calls);
    await promise;

    expect(call(fake.calls, 2).command).toBe("gh");
    expect(call(fake.calls, 2).args).toEqual([
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      "Title",
      "--body",
      "Body",
    ]);
  });

  it("uses default base branch main", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    await finishHappyPath(fake.calls);

    await expect(promise).resolves.toMatchObject({ baseBranch: "main" });
  });

  it("supports custom base branch", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest({ ...request(fake.spawn), baseBranch: "develop" });

    await finishHappyPath(fake.calls);

    await expect(promise).resolves.toMatchObject({ baseBranch: "develop" });
    expect(call(fake.calls, 2).args).toContain("develop");
  });

  it("returns frozen PR with parsed number", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    await finishHappyPath(fake.calls);
    const result = await promise;

    expect(result).toMatchObject({ storyId, branch, baseBranch: "main", url: prUrl, number: 123 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("omits number when URL lacks PR number", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    await finishHappyPath(fake.calls, "https://github.com/owner/repo/pulls");

    await expect(promise).resolves.not.toHaveProperty("number");
  });

  it("wraps command nonzero exit", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    writeStderr(call(fake.calls, 0).child, "bad");
    close(call(fake.calls, 0).child, 1);

    await expect(promise).rejects.toMatchObject({
      code: "command-failed",
      command: "git",
      stderr: "bad",
    });
  });

  it("wraps spawn error", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    call(fake.calls, 0).child.emit("error", new Error(`failed ${secret()}`));

    await expect(promise).rejects.toMatchObject({
      code: "command-failed",
      stderr: "failed [REDACTED]",
    });
  });

  it("rejects blank and non-HTTPS PR URLs", async () => {
    const fakeBlank = fakeSpawn();
    const blankPromise = openStoryPullRequest(request(fakeBlank.spawn));
    await finishHappyPath(fakeBlank.calls, " ");
    await expect(blankPromise).rejects.toMatchObject({ code: "invalid-pr-url" });

    const fakeHttp = fakeSpawn();
    const httpPromise = openStoryPullRequest(request(fakeHttp.spawn));
    await finishHappyPath(fakeHttp.calls, "http://github.com/owner/repo/pull/1");
    await expect(httpPromise).rejects.toMatchObject({ code: "invalid-pr-url" });
  });

  it("redacts stderr in command errors and caps it", async () => {
    const fake = fakeSpawn();
    const promise = openStoryPullRequest(request(fake.spawn));

    writeStderr(call(fake.calls, 0).child, `${"x".repeat(MAX_GH_STDERR_CHARS - 40)} ${secret()}`);
    await tick();
    close(call(fake.calls, 0).child, 1);

    await expect(promise).rejects.toMatchObject({ code: "command-failed" });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(StoryPullRequestError);
      const prError = error as StoryPullRequestError;
      expect(prError.stderr).toContain("[REDACTED]");
      expect(prError.stderr).not.toContain(secret());
      expect(prError.stderr?.length).toBeLessThanOrEqual(MAX_GH_STDERR_CHARS);
    });
  });

  it("validates required request strings", async () => {
    await expect(
      openStoryPullRequest({ ...request(fakeSpawn().spawn), projectRoot: " " }),
    ).rejects.toThrow("projectRoot must not be blank.");
    await expect(
      openStoryPullRequest({ ...request(fakeSpawn().spawn), worktreePath: " " }),
    ).rejects.toThrow("worktreePath must not be blank.");
    await expect(
      openStoryPullRequest({ ...request(fakeSpawn().spawn), branch: " " }),
    ).rejects.toThrow("branch must not be blank.");
  });

  it("does not mutate inputs", async () => {
    const fake = fakeSpawn();
    const input = { ...request(fake.spawn), title: "Title", body: "Body" };
    const before = JSON.stringify({ ...input, spawn: undefined });
    const promise = openStoryPullRequest(input);

    await finishHappyPath(fake.calls);
    await promise;

    expect(JSON.stringify({ ...input, spawn: undefined })).toBe(before);
  });
});
