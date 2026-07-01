/* eslint-disable jsdoc/informative-docs, jsdoc/require-example, jsdoc/require-param, jsdoc/require-returns, max-params, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-confusing-void-expression -- git boundary mirrors public contract. */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isPipelineStateStoryId } from "../state/index.js";
import { redactText } from "../security/index.js";

/** Relative directory where pipeline worktrees are created. */
export const PIPELINE_WORKTREE_RELATIVE_DIR = ".pi/pipeline/worktrees" as const;

/** Git command timeout: 60 seconds. */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 60_000 as const;

/** Maximum captured git stderr chars. */
export const MAX_GIT_STDERR_CHARS = 8_192 as const;

/** Injectable spawn function for tests. */
export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ReturnType<typeof nodeSpawn>;

/** Result from one git command. */
export interface GitCommandResult {
  /** Command name. */
  readonly command: string;

  /** Arguments passed to the command. */
  readonly args: readonly string[];

  /** Process exit code. */
  readonly exitCode: number | null;

  /** Redacted stdout. */
  readonly stdout: string;

  /** Redacted stderr. */
  readonly stderr: string;

  /** Non-negative duration in milliseconds. */
  readonly durationMs: number;
}

/** Request for running a git command. */
export interface RunGitCommandRequest {
  /** Working directory. */
  readonly cwd: string;

  /** Git args. */
  readonly args: readonly string[];

  /** Optional spawn implementation. */
  readonly spawn?: GitSpawn;

  /** Optional timeout in milliseconds. */
  readonly timeoutMs?: number;

  /** Optional monotonic clock in milliseconds. */
  readonly now?: () => number;
}

/** Resolved worktree metadata. */
export interface StoryWorktree {
  /** Story id. */
  readonly storyId: string;

  /** Branch name. */
  readonly branch: string;

  /** Worktree path. */
  readonly path: string;
}

/** Request for ensuring a story worktree exists. */
export interface EnsureStoryWorktreeRequest {
  /** Project root. */
  readonly projectRoot: string;

  /** Story id. */
  readonly storyId: string;

  /** Optional base ref. */
  readonly baseRef?: string;

  /** Optional branch name. */
  readonly branch?: string;

  /** Optional spawn implementation. */
  readonly spawn?: GitSpawn;

  /** Optional monotonic clock in milliseconds. */
  readonly now?: () => number;
}

/** Request for removing a story worktree. */
export interface RemoveStoryWorktreeRequest {
  /** Project root. */
  readonly projectRoot: string;

  /** Story id. */
  readonly storyId: string;

  /** Optional spawn implementation. */
  readonly spawn?: GitSpawn;

  /** Optional monotonic clock in milliseconds. */
  readonly now?: () => number;
}

/** Git worktree error code. */
export type GitWorktreeErrorCode =
  "git-command-failed" | "git-command-timed-out" | "invalid-worktree-path";

/** Git worktree error details. */
export interface GitWorktreeErrorDetails {
  /** Error code. */
  readonly code: GitWorktreeErrorCode;

  /** Command name. */
  readonly command: string;

  /** Command args. */
  readonly args: readonly string[];

  /** Working directory. */
  readonly cwd: string;

  /** Optional exit code. */
  readonly exitCode?: number | null;

  /** Optional redacted stderr. */
  readonly stderr?: string;
}

/** Error thrown by Git worktree helpers. */
export class GitWorktreeError extends Error {
  /** Error code. */
  public readonly code: GitWorktreeErrorCode;

  /** Command name. */
  public readonly command: string;

  /** Command args. */
  public readonly args: readonly string[];

  /** Working directory. */
  public readonly cwd: string;

  /** Optional exit code. */
  public readonly exitCode?: number | null;

  /** Optional redacted stderr. */
  public readonly stderr?: string;

  /** Creates a git worktree error. */
  public constructor(details: GitWorktreeErrorDetails) {
    super(buildErrorMessage(details));
    this.name = "GitWorktreeError";
    this.code = details.code;
    this.command = details.command;
    this.args = Object.freeze([...details.args]);
    this.cwd = details.cwd;
    if (details.exitCode !== undefined) {
      this.exitCode = details.exitCode;
    }
    if (details.stderr !== undefined) {
      this.stderr = details.stderr;
    }
  }
}

/** Resolves the pipeline worktree base directory. */
export function getPipelineWorktreesDir(projectRoot: string): string {
  assertProjectRoot(projectRoot);
  return resolve(projectRoot, ".pi", "pipeline", "worktrees");
}

/** Resolves one story worktree path. */
export function getStoryWorktreePath(projectRoot: string, storyId: string): string {
  assertStoryId(storyId);
  const baseDir = getPipelineWorktreesDir(projectRoot);
  const worktreePath = join(baseDir, storyId);
  assertInside(baseDir, worktreePath);
  return worktreePath;
}

/** Builds the branch name for a story. */
export function getStoryBranchName(storyId: string): string {
  assertStoryId(storyId);
  return `bmad/${storyId}`;
}

/** Runs a git command and resolves only on successful exit. */
export async function runGitCommand(request: RunGitCommandRequest): Promise<GitCommandResult> {
  validateGitRequest(request);
  return spawnGit(request);
}

/** Ensures an isolated story worktree exists. */
export async function ensureStoryWorktree(
  request: EnsureStoryWorktreeRequest,
): Promise<StoryWorktree> {
  const path = getStoryWorktreePath(request.projectRoot, request.storyId);
  const branch = request.branch ?? getStoryBranchName(request.storyId);
  const baseRef = request.baseRef ?? "HEAD";
  const options = gitOptions(request);

  await runGitCommand({ ...options, args: ["worktree", "prune"] });
  await runGitCommand({ ...options, args: ["worktree", "add", "-B", branch, path, baseRef] });

  return Object.freeze({ storyId: request.storyId, branch, path });
}

/** Removes an isolated story worktree. */
export async function removeStoryWorktree(request: RemoveStoryWorktreeRequest): Promise<void> {
  const path = getStoryWorktreePath(request.projectRoot, request.storyId);
  try {
    await runGitCommand({ ...gitOptions(request), args: ["worktree", "remove", "--force", path] });
  } catch (error) {
    if (isMissingWorktreeError(error)) {
      return;
    }
    throw error;
  }
}

const gitOptions = (
  request: EnsureStoryWorktreeRequest | RemoveStoryWorktreeRequest,
): Pick<RunGitCommandRequest, "cwd" | "now" | "spawn"> => ({
  cwd: request.projectRoot,
  ...(request.spawn === undefined ? {} : { spawn: request.spawn }),
  ...(request.now === undefined ? {} : { now: request.now }),
});

const spawnGit = async (request: RunGitCommandRequest): Promise<GitCommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const start = (request.now ?? Date.now)();
    const stderr = capture(MAX_GIT_STDERR_CHARS);
    const stdout = capture(Number.POSITIVE_INFINITY);
    const child = spawnChild(request);
    const timer = setTimeout(
      () => rejectTimedOut(child, request, rejectPromise),
      timeoutMs(request),
    );

    child.stdout?.on("data", (chunk: Uint8Array | string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array | string) => stderr.push(chunk));
    child.once("error", (error) => rejectFailed(request, rejectPromise, stderr.value(), error));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveClose(request, resolvePromise, rejectPromise, {
        code,
        stdout: stdout.value(),
        stderr: stderr.value(),
        durationMs: Math.max(0, (request.now ?? Date.now)() - start),
      });
    });
  });

const spawnChild = (request: RunGitCommandRequest): ChildProcess =>
  (request.spawn ?? nodeSpawn)("git", request.args, { cwd: request.cwd, env: process.env });

const resolveClose = (
  request: RunGitCommandRequest,
  resolvePromise: (value: GitCommandResult) => void,
  rejectPromise: (error: GitWorktreeError) => void,
  result: CloseResult,
): void => {
  const redacted = redactStreams(result);
  if (result.code === 0) {
    resolvePromise(
      Object.freeze({
        command: "git",
        args: Object.freeze([...request.args]),
        exitCode: result.code,
        stdout: redacted.stdout,
        stderr: redacted.stderr,
        durationMs: result.durationMs,
      }),
    );
    return;
  }
  rejectPromise(errorFor("git-command-failed", request, result.code, redacted.stderr));
};

interface CloseResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

const rejectTimedOut = (
  child: ChildProcess,
  request: RunGitCommandRequest,
  rejectPromise: (error: GitWorktreeError) => void,
): void => {
  child.kill("SIGTERM");
  rejectPromise(errorFor("git-command-timed-out", request, null, "Git command timed out."));
};

const rejectFailed = (
  request: RunGitCommandRequest,
  rejectPromise: (error: GitWorktreeError) => void,
  stderr: string,
  error: Error,
): void => rejectPromise(errorFor("git-command-failed", request, null, stderr || error.message));

const errorFor = (
  code: GitWorktreeErrorCode,
  request: RunGitCommandRequest,
  exitCode: number | null,
  stderr: string,
): GitWorktreeError =>
  new GitWorktreeError({
    code,
    command: "git",
    args: request.args,
    cwd: request.cwd,
    exitCode,
    stderr: redactText(stderr).value,
  });

const capture = (
  limit: number,
): { readonly push: (chunk: Uint8Array | string) => void; readonly value: () => string } => {
  let value = "";
  return {
    push: (chunk): void => {
      value = `${value}${chunkToString(chunk)}`.slice(-limit);
    },
    value: () => value,
  };
};

const redactStreams = (result: CloseResult): Pick<GitCommandResult, "stderr" | "stdout"> => ({
  stdout: redactText(result.stdout).value,
  stderr: redactText(result.stderr).value,
});

const validateGitRequest = (request: RunGitCommandRequest): void => {
  validateNonBlank(request.cwd, "cwd");
  request.args.forEach((arg) => validateNonBlank(arg, "args"));
  if (!Number.isInteger(timeoutMs(request)) || timeoutMs(request) <= 0) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
};

const timeoutMs = (request: RunGitCommandRequest): number =>
  request.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;

const assertProjectRoot = (projectRoot: string): void => {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
};

const assertStoryId = (storyId: string): void => {
  if (!isPipelineStateStoryId(storyId)) {
    throw new RangeError(`Invalid worktree story id "${storyId}".`);
  }
};

const assertInside = (baseDir: string, candidate: string): void => {
  const relativePath = relative(baseDir, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new GitWorktreeError({
      code: "invalid-worktree-path",
      command: "git",
      args: [],
      cwd: baseDir,
      stderr: "Worktree path escaped base directory.",
    });
  }
};

const validateNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const isMissingWorktreeError = (error: unknown): boolean =>
  error instanceof GitWorktreeError &&
  ["not a working tree", "is not a working tree", "No such file or directory"].some((text) =>
    (error.stderr ?? "").includes(text),
  );

const buildErrorMessage = (details: GitWorktreeErrorDetails): string =>
  `Git worktree ${details.code}: git ${details.args.join(" ")}`;

const chunkToString = (chunk: Uint8Array | string): string =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
