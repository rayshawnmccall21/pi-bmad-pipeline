import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";

import type { ModelThinking } from "../../model/index.js";
import type { StageExecutionRequest, StageExecutionResult } from "../workflow-executor.js";
import {
  buildStageArgs,
  type BuildStageArgsRequest,
  type BuiltStageArgs,
} from "./build-stage-args.js";
import { HeadlessJsonlParser } from "./headless-jsonl-parser.js";
import {
  extractGatedHeadlessOutput,
  extractStageUsage,
  type GatedHeadlessOutputExtraction,
} from "./headless-stream-output.js";
import { resolvePiBmadExtensionPath } from "./pi-bmad-extension.js";

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

  /** Optional pi-bmad extension file path. Resolved from env/dependency when absent. */
  readonly piBmadExtensionPath?: string;

  /** Optional emission key for headless output gating. Generated per run when absent. */
  readonly emissionKey?: string;

  /** Optional run id stamped into headless output via PI_BMAD_RUN_ID. */
  readonly runId?: string;

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
  const argsRequest = toBuildStageArgsRequest(request);
  const invocation = buildStageArgs(argsRequest);
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
      emissionKey: argsRequest.emissionKey,
      schemaRootDir: piBmadSchemaRootDir(argsRequest.piBmadExtensionPath),
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
    piBmadExtensionPath: request.piBmadExtensionPath ?? resolvePiBmadExtensionPath(),
    emissionKey: request.emissionKey ?? randomUUID(),
    ...optionalStageArgsFields(request),
  };
}

type OptionalStageArgsFields = Partial<
  Pick<BuildStageArgsRequest, "runId" | "priorFindings" | "stageExtensionPath" | "piBin">
>;

const optionalStageArgsFields = (request: RunBmadStageRequest): OptionalStageArgsFields => ({
  ...(request.runId === undefined ? {} : { runId: request.runId }),
  ...(request.priorFindings === undefined ? {} : { priorFindings: request.priorFindings }),
  ...(request.stageExtensionPath === undefined
    ? {}
    : { stageExtensionPath: request.stageExtensionPath }),
  ...(request.piBin === undefined ? {} : { piBin: request.piBin }),
});

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
  readonly emissionKey: string;
  readonly schemaRootDir: string;
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
      env: { ...process.env, ...request.invocation.env },
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
  context.parser.finish();
  context.resolve(buildResult(context, exitCode));
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

const buildResult = (context: CloseContext, exitCode: number | null): StageExecutionResult => {
  const snapshot = context.parser.snapshot();
  const extraction = extractGatedHeadlessOutput(snapshot.records, {
    emissionKey: context.emissionKey,
    rootDir: context.schemaRootDir,
  });
  const parseError = getParseError({
    snapshot,
    extraction,
    exitCode,
    stderr: context.stderr.value(),
  });
  const usage = extractStageUsage(snapshot.records);
  return {
    output: extraction.output,
    exitCode,
    durationMs: Math.max(0, context.now() - context.startMs),
    ...(parseError === undefined ? {} : { parseError }),
    ...(usage === undefined ? {} : { usage }),
    ...(context.state.timedOut ? { timedOut: true } : {}),
    ...(context.state.aborted ? { aborted: true } : {}),
  };
};

interface ParseErrorRequest {
  readonly snapshot: ReturnType<HeadlessJsonlParser["snapshot"]>;
  readonly extraction: GatedHeadlessOutputExtraction;
  readonly exitCode: number | null;
  readonly stderr: string;
}

const getParseError = (request: ParseErrorRequest): string | undefined => {
  const firstIssue = request.snapshot.issues[0];
  if (firstIssue !== undefined) {
    return `Invalid JSONL on line ${String(firstIssue.line)}: ${firstIssue.message}`;
  }
  if (request.extraction.output !== null) {
    return undefined;
  }
  return request.exitCode !== 0 && request.stderr.length > 0
    ? `Child stderr: ${request.stderr}`
    : request.extraction.failure;
};

/**
 * Resolves the pi-bmad package root (payload schema root) from its extension path.
 *
 * @param extensionPath - The pi-bmad extension file path passed to `pi -e`.
 *
 * @returns The pi-bmad package root containing `content/schemas`.
 */
const piBmadSchemaRootDir = (extensionPath: string): string =>
  resolvePath(dirname(extensionPath), "..");

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
