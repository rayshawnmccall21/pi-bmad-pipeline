/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-example, jsdoc/require-param, jsdoc/require-returns, max-params, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-confusing-void-expression -- PR boundary mirrors public contract. */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import { redactText } from "../security/index.js";
import { isPipelineStateStoryId } from "../state/index.js";

import { scanGitDiffForSecrets, type GitSecretScanResult } from "./secret-scan.js";

/** Default PR title prefix. */
export const DEFAULT_STORY_PR_TITLE_PREFIX = "BMAD";

/** Maximum captured gh stderr characters. */
export const MAX_GH_STDERR_CHARS = 8_192 as const;

/** Injectable spawn function for gh/git commands. */
export type StoryPullRequestSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ReturnType<typeof nodeSpawn>;

/** Pull request opening result. */
export interface StoryPullRequest {
  readonly storyId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly number?: number;
}

/** Request for opening a story pull request. */
export interface OpenStoryPullRequestRequest {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly storyId: string;
  readonly branch: string;
  readonly baseBranch?: string;
  readonly title?: string;
  readonly body?: string;
  readonly spawn?: StoryPullRequestSpawn;
  readonly now?: () => number;
}

/** PR error code. */
export type StoryPullRequestErrorCode = "secret-scan-blocked" | "command-failed" | "invalid-pr-url";

/** PR error details. */
export interface StoryPullRequestErrorDetails {
  readonly code: StoryPullRequestErrorCode;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stderr?: string;
  readonly secretScan?: GitSecretScanResult;
}

/** Error thrown by story PR helpers. */
export class StoryPullRequestError extends Error {
  public readonly code: StoryPullRequestErrorCode;
  public readonly command?: string;
  public readonly args?: readonly string[];
  public readonly cwd?: string;
  public readonly stderr?: string;
  public readonly secretScan?: GitSecretScanResult;

  public constructor(details: StoryPullRequestErrorDetails) {
    super(errorMessage(details));
    this.name = "StoryPullRequestError";
    this.code = details.code;
    if (details.command !== undefined) {
      this.command = details.command;
    }
    if (details.args !== undefined) {
      this.args = Object.freeze([...details.args]);
    }
    if (details.cwd !== undefined) {
      this.cwd = details.cwd;
    }
    if (details.stderr !== undefined) {
      this.stderr = details.stderr;
    }
    if (details.secretScan !== undefined) {
      this.secretScan = details.secretScan;
    }
  }
}

/** Builds a story pull request title. */
export function buildStoryPullRequestTitle(storyId: string, title?: string): string {
  assertStoryId(storyId);
  return title !== undefined && title.trim().length > 0
    ? title
    : `${DEFAULT_STORY_PR_TITLE_PREFIX}: ${storyId}`;
}

/** Builds a story pull request body. */
export function buildStoryPullRequestBody(storyId: string, body?: string): string {
  assertStoryId(storyId);
  return body !== undefined && body.trim().length > 0
    ? body
    : `Automated BMAD pipeline output for ${storyId}.`;
}

/** Parses a pull request number from a GitHub PR URL. */
export function parsePullRequestNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)\/?$/u.exec(url.trim());
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

/** Opens a story pull request with fail-closed secret scanning. */
export async function openStoryPullRequest(
  request: OpenStoryPullRequestRequest,
): Promise<StoryPullRequest> {
  validateOpenRequest(request);
  const baseBranch = request.baseBranch ?? "main";
  const title = buildStoryPullRequestTitle(request.storyId, request.title);
  const body = buildStoryPullRequestBody(request.storyId, request.body);
  await assertDiffHasNoSecrets(request);
  await runCommand(
    gitCommand(request.worktreePath, ["push", "--set-upstream", "origin", request.branch], request),
  );
  const prUrl = (
    await runCommand(
      ghCreateCommand(request.worktreePath, baseBranch, request.branch, title, body, request),
    )
  ).stdout.trim();
  assertPrUrl(prUrl);
  return freezePr({
    storyId: request.storyId,
    branch: request.branch,
    baseBranch,
    title,
    body,
    url: prUrl,
  });
}

interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly spawn?: StoryPullRequestSpawn;
  readonly now?: () => number;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly rawStdout: string;
}

const assertDiffHasNoSecrets = async (request: OpenStoryPullRequestRequest): Promise<void> => {
  const staged = await runCommand(
    gitCommand(request.worktreePath, ["diff", "--cached", "--unified=0"], request),
  );
  const unstaged = staged.rawStdout.trim()
    ? ""
    : (await runCommand(gitCommand(request.worktreePath, ["diff", "--unified=0"], request)))
        .rawStdout;
  const scan = scanGitDiffForSecrets(`${staged.rawStdout}${unstaged}`);
  if (scan.findings.length > 0) {
    throw new StoryPullRequestError({ code: "secret-scan-blocked", secretScan: scan });
  }
};

const runCommand = async (request: CommandRequest): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const stdout = capture(Number.POSITIVE_INFINITY);
    const stderr = capture(MAX_GH_STDERR_CHARS);
    const child = spawnChild(request);
    child.stdout?.on("data", (chunk: Uint8Array | string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array | string) => stderr.push(chunk));
    child.once("error", (error) =>
      rejectCommand(request, rejectPromise, stderr.value() || error.message),
    );
    child.once("close", (code) => {
      resolveClose(request, resolvePromise, rejectPromise, code, stdout.value(), stderr.value());
    });
  });

const spawnChild = (request: CommandRequest): ChildProcess =>
  (request.spawn ?? nodeSpawn)(request.command, request.args, {
    cwd: request.cwd,
    env: process.env,
  });

const resolveClose = (
  request: CommandRequest,
  resolvePromise: (value: CommandResult) => void,
  rejectPromise: (error: StoryPullRequestError) => void,
  code: number | null,
  stdout: string,
  stderr: string,
): void => {
  if (code === 0) {
    resolvePromise(
      Object.freeze({
        stdout: redactText(stdout).value,
        stderr: redactText(stderr).value,
        rawStdout: stdout,
      }),
    );
    return;
  }
  rejectCommand(request, rejectPromise, stderr);
};

const rejectCommand = (
  request: CommandRequest,
  rejectPromise: (error: StoryPullRequestError) => void,
  stderr: string,
): void => {
  rejectPromise(
    new StoryPullRequestError({
      code: "command-failed",
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      stderr: redactText(stderr).value,
    }),
  );
};

const gitCommand = (
  cwd: string,
  args: readonly string[],
  request: OpenStoryPullRequestRequest,
): CommandRequest => ({
  command: "git",
  args,
  cwd,
  ...(request.spawn === undefined ? {} : { spawn: request.spawn }),
  ...(request.now === undefined ? {} : { now: request.now }),
});

const ghCreateCommand = (
  cwd: string,
  baseBranch: string,
  branch: string,
  title: string,
  body: string,
  request: OpenStoryPullRequestRequest,
): CommandRequest => ({
  command: "gh",
  args: ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body", body],
  cwd,
  ...(request.spawn === undefined ? {} : { spawn: request.spawn }),
  ...(request.now === undefined ? {} : { now: request.now }),
});

const freezePr = (request: Omit<StoryPullRequest, "number">): StoryPullRequest => {
  const number = parsePullRequestNumber(request.url);
  return Object.freeze({ ...request, ...(number === undefined ? {} : { number }) });
};

const validateOpenRequest = (request: OpenStoryPullRequestRequest): void => {
  validateNonBlank(request.projectRoot, "projectRoot");
  validateNonBlank(request.worktreePath, "worktreePath");
  validateNonBlank(request.branch, "branch");
  if (request.baseBranch !== undefined) {
    validateNonBlank(request.baseBranch, "baseBranch");
  }
  assertStoryId(request.storyId);
};

const assertPrUrl = (url: string): void => {
  if (!url.startsWith("https://")) {
    throw new StoryPullRequestError({ code: "invalid-pr-url" });
  }
};

const assertStoryId = (storyId: string): void => {
  if (!isPipelineStateStoryId(storyId)) {
    throw new RangeError(`Invalid story id "${storyId}".`);
  }
};

const validateNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

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

const errorMessage = (details: StoryPullRequestErrorDetails): string => {
  if (details.code === "secret-scan-blocked") {
    return "Story pull request blocked by secret scan.";
  }
  if (details.code === "invalid-pr-url") {
    return "gh pr create did not return a valid pull request URL.";
  }
  return `Command "${details.command ?? "unknown"}" failed.`;
};

const chunkToString = (chunk: Uint8Array | string): string =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
