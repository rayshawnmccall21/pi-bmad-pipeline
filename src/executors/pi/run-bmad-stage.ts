import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import type { ModelThinking } from "../../model/index.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  StageExecutionUsage,
} from "../workflow-executor.js";
import {
  buildStageArgs,
  type BuildStageArgsRequest,
  type BuiltStageArgs,
} from "./build-stage-args.js";
import { HeadlessJsonlParser } from "./headless-jsonl-parser.js";

/** Maximum captured stderr characters retained for diagnostics. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- small fixed diagnostic cap.
export const MAX_STAGE_STDERR_CHARS = 16_384 as const;

const millisecondsPerSecond = 1000;

/** Minimal spawn function used by runBmadStage; injectable for tests. */
export type BmadStageSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** Request for running one BMAD stage through the Pi CLI. */
export interface RunBmadStageRequest extends Omit<StageExecutionRequest, "signal"> {
  /** Abort signal that cancels the child process. */
  readonly signal: AbortSignal;

  /** Resolved model name. */
  readonly model: string;

  /** Resolved default thinking effort. */
  readonly thinking: ModelThinking;

  /** Optional stage extension directory path. */
  readonly stageExtensionPath?: string;

  /** Optional Pi executable name/path. */
  readonly piBin?: string;

  /** Optional BMAD headless command name. */
  readonly command?: string;

  /** Optional spawn implementation for tests. */
  readonly spawn?: BmadStageSpawn;

  /** Optional timeout override in milliseconds. Defaults to stage timeout seconds. */
  readonly timeoutMs?: number;

  /** Optional clock for tests. */
  readonly now?: () => number;
}

/** Error thrown when a child process cannot be spawned. */
export class BmadStageSpawnError extends Error {
  /** Executable that failed to spawn. */
  public readonly command: string;

  /**
   * Creates a spawn error.
   *
   * @param command - Executable that failed to spawn.
   * @param cause - Original spawn failure.
   *
   * @example
   * ```ts
   * throw new BmadStageSpawnError("pi", error);
   * ```
   */
  public constructor(command: string, cause: unknown) {
    super(`Failed to spawn BMAD stage process "${command}".`, { cause });
    this.name = "BmadStageSpawnError";
    this.command = command;
  }
}

/**
 * Runs one BMAD stage through a fresh Pi child process.
 *
 * @param request - Stage execution request.
 *
 * @returns Stage execution result.
 *
 * @throws RangeError When timeout configuration is invalid.
 * @throws BmadStageSpawnError When the child process cannot be spawned.
 *
 * @example
 * ```ts
 * const result = await runBmadStage(request);
 * ```
 */
export function runBmadStage(request: RunBmadStageRequest): Promise<StageExecutionResult> {
  const timeoutMs = resolveTimeoutMs(request);
  const invocation = buildStageArgs(toBuildStageArgsRequest(request));
  const now = request.now ?? Date.now;
  const startMs = now();
  const parser = new HeadlessJsonlParser();
  const stderr = createStderrCapture();
  const state = createRunState();
  const spawn = request.spawn ?? nodeSpawn;

  return new Promise((resolve, reject) => {
    const child = spawnChild({ spawn, invocation, cwd: request.worktreeCwd, reject });
    if (child === undefined) {
      return;
    }
    const timeout = setTimeout(() => {
      killTimedOut(child, state);
    }, timeoutMs);
    const onAbort = (): void => {
      killAborted(child, state);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    attachChildHandlers(child, {
      parser,
      stderr,
      state,
      startMs,
      now,
      timeout,
      onAbort,
      request,
      command: invocation.bin,
      resolve,
      reject,
    });
    if (request.signal.aborted) {
      onAbort();
    }
  });
}

/**
 * Builds the argv request used by runBmadStage.
 *
 * @param request - Stage execution request.
 *
 * @returns Fields consumed by buildStageArgs.
 *
 * @example
 * ```ts
 * const argvRequest = toBuildStageArgsRequest(request);
 * ```
 */
export function toBuildStageArgsRequest(request: RunBmadStageRequest): BuildStageArgsRequest {
  return {
    stage: request.stage,
    storyId: request.storyId,
    specFile: request.specFile,
    projectRoot: request.projectRoot,
    worktreeCwd: request.worktreeCwd,
    attempt: request.attempt,
    model: request.model,
    thinking: request.thinking,
    ...(request.priorFindings === undefined ? {} : { priorFindings: request.priorFindings }),
    ...(request.stageExtensionPath === undefined
      ? {}
      : { stageExtensionPath: request.stageExtensionPath }),
    ...(request.piBin === undefined ? {} : { piBin: request.piBin }),
    ...(request.command === undefined ? {} : { command: request.command }),
  };
}

interface RunState {
  aborted: boolean;
  timedOut: boolean;
  settled: boolean;
}

interface CloseContext {
  readonly parser: HeadlessJsonlParser;
  readonly stderr: ReturnType<typeof createStderrCapture>;
  readonly state: RunState;
  readonly startMs: number;
  readonly now: () => number;
  readonly timeout: NodeJS.Timeout;
  readonly onAbort: () => void;
  readonly request: RunBmadStageRequest;
  readonly command: string;
  readonly resolve: (result: StageExecutionResult) => void;
  readonly reject: (error: unknown) => void;
}

const resolveTimeoutMs = (request: RunBmadStageRequest): number => {
  const timeoutMs = request.timeoutMs ?? request.stage.timeoutSeconds * millisecondsPerSecond;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
  return timeoutMs;
};

interface SpawnChildRequest {
  readonly spawn: BmadStageSpawn;
  readonly invocation: BuiltStageArgs;
  readonly cwd: string;
  readonly reject: (error: unknown) => void;
}

const spawnChild = (request: SpawnChildRequest): ChildProcessWithoutNullStreams | undefined => {
  try {
    return request.spawn(request.invocation.bin, request.invocation.args, {
      cwd: request.cwd,
      env: process.env,
    });
  } catch (error) {
    request.reject(new BmadStageSpawnError(request.invocation.bin, error));
    return undefined;
  }
};

const attachChildHandlers = (
  child: ChildProcessWithoutNullStreams,
  context: CloseContext,
): void => {
  child.stdout.on("data", (chunk: Uint8Array | string) => {
    context.parser.push(chunk);
  });
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    context.stderr.push(chunk);
  });
  child.once("error", (error: unknown) => {
    rejectOnce(context, new BmadStageSpawnError(context.command, error));
  });
  child.once("close", (code: number | null) => {
    resolveClose(context, code);
  });
};

const resolveClose = (context: CloseContext, exitCode: number | null): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  clearTimeout(context.timeout);
  context.request.signal.removeEventListener("abort", context.onAbort);
  const snapshot = context.parser.finish();
  context.resolve(buildResult(context, snapshot.output, exitCode));
};

const rejectOnce = (context: CloseContext, error: unknown): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  clearTimeout(context.timeout);
  context.request.signal.removeEventListener("abort", context.onAbort);
  context.reject(error);
};

const buildResult = (
  context: CloseContext,
  output: unknown,
  exitCode: number | null,
): StageExecutionResult => {
  const parseError = getParseError({
    snapshot: context.parser.snapshot(),
    output,
    exitCode,
    stderr: context.stderr.value(),
  });
  return {
    output: isRecord(output) ? output : null,
    exitCode,
    durationMs: Math.max(0, context.now() - context.startMs),
    ...(parseError === undefined ? {} : { parseError }),
    ...usageField(output),
    ...(context.state.timedOut ? { timedOut: true } : {}),
    ...(context.state.aborted ? { aborted: true } : {}),
  };
};

interface ParseErrorRequest {
  readonly snapshot: ReturnType<HeadlessJsonlParser["snapshot"]>;
  readonly output: unknown;
  readonly exitCode: number | null;
  readonly stderr: string;
}

const getParseError = (request: ParseErrorRequest): string | undefined => {
  const firstIssue = request.snapshot.issues[0];
  if (firstIssue !== undefined) {
    return `Invalid JSONL on line ${String(firstIssue.line)}: ${firstIssue.message}`;
  }
  return request.exitCode !== 0 && request.output === null && request.stderr.length > 0
    ? `Child stderr: ${request.stderr}`
    : undefined;
};

const usageField = (output: unknown): Partial<Pick<StageExecutionResult, "usage">> => {
  const usage = isRecord(output) && isUsage(output["usage"]) ? output["usage"] : undefined;
  return usage === undefined ? {} : { usage };
};

const isUsage = (value: unknown): value is StageExecutionUsage =>
  isRecord(value) && isNonNegativeFinite(value["tokens"]) && isNonNegativeFinite(value["dollars"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const killTimedOut = (child: ChildProcessWithoutNullStreams, state: RunState): void => {
  state.timedOut = true;
  child.kill("SIGTERM");
};

const killAborted = (child: ChildProcessWithoutNullStreams, state: RunState): void => {
  state.aborted = true;
  child.kill("SIGTERM");
};

const createRunState = (): RunState => ({ aborted: false, timedOut: false, settled: false });

const createStderrCapture = (): {
  readonly push: (chunk: Uint8Array | string) => void;
  readonly value: () => string;
} => {
  let captured = "";
  return {
    push(chunk) {
      captured = `${captured}${chunkToString(chunk)}`.slice(0, MAX_STAGE_STDERR_CHARS);
    },
    value() {
      return captured;
    },
  };
};

const chunkToString = (chunk: Uint8Array | string): string =>
  typeof chunk === "string" ? chunk : new TextDecoder("utf-8").decode(chunk);
