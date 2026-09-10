/* eslint-disable max-lines -- stage process lifecycle stays in one boundary module. */
import { randomUUID } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";

import type { ModelThinking } from "../../model/index.js";
import type { CompiledAgentStage } from "../../rundef/index.js";
import type { StageExecutionRequest, StageExecutionResult } from "../workflow-executor.js";
import {
  buildStageArgs,
  type BuildStageArgsRequest,
  type BuiltStageArgs,
} from "./build-stage-args.js";
import {
  createHeadlessJsonlParser,
  type HeadlessJsonlParser,
  type HeadlessJsonlParserSnapshot,
} from "./headless-jsonl-parser.js";
import {
  extractGatedHeadlessOutput,
  extractStageUsage,
  type GatedHeadlessOutputExtraction,
} from "./headless-stream-output.js";
import { resolvePiBmadExtensionPath } from "./pi-bmad-extension.js";
import { createStderrCapture } from "./stderr-capture.js";
import {
  BMAD_STAGE_STDIO,
  nodeStageSpawn,
  type BmadStageChildProcess,
  type BmadStageSpawn,
} from "./stage-spawn.js";
import {
  logEnvelopeGate,
  logStageSpawn,
  type EnvelopeGateLogContext,
} from "./stage-debug-events.js";

/** Maximum captured stderr characters retained for diagnostics. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- small fixed diagnostic cap.
export const MAX_STAGE_STDERR_CHARS = 16_384 as const;

/** Default grace period in milliseconds before SIGTERM escalates to SIGKILL. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- small fixed escalation grace.
const DEFAULT_KILL_ESCALATION_MS = 10_000 as const;

const millisecondsPerSecond = 1000;

/** Request for running one BMAD stage through the Pi CLI. */
export interface RunBmadStageRequest extends Omit<StageExecutionRequest, "signal" | "stage"> {
  /** Compiled agent stage executed through Pi. */
  readonly stage: CompiledAgentStage;

  /** Abort signal that cancels the child process. */
  readonly signal: AbortSignal;

  /** Resolved model name. */
  readonly model: string;

  /** Resolved default thinking effort. */
  readonly thinking: ModelThinking;

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

  /**
   * Optional grace period in milliseconds before a SIGTERM-ignoring child is
   * escalated to SIGKILL. Defaults to DEFAULT_KILL_ESCALATION_MS.
   */
  readonly killEscalationMs?: number;

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
 * @throws RangeError When timeout or kill-escalation configuration is invalid.
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
  const parser = createHeadlessJsonlParser();
  const stderr = createStderrCapture(MAX_STAGE_STDERR_CHARS);
  const state = createRunState(resolveKillEscalationMs(request));
  const spawn = request.spawn ?? nodeStageSpawn;
  logStageSpawn(request, invocation, timeoutMs);

  return new Promise((resolve, reject) => {
    const child = spawnChild({ spawn, invocation, cwd: request.projectRoot, reject });
    if (child === undefined) {
      return;
    }
    const timeout = setTimeout(() => {
      killWithEscalation(child, state, "timedOut");
    }, timeoutMs);
    const onAbort = (): void => {
      killWithEscalation(child, state, "aborted");
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
      cleanupHandlers: undefined,
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
    attempt: request.attempt,
    model: request.model,
    thinking: request.thinking,
    piBmadExtensionPath: request.piBmadExtensionPath ?? resolvePiBmadExtensionPath(),
    emissionKey: request.emissionKey ?? randomUUID(),
    ...optionalStageArgsFields(request),
  };
}

type OptionalStageArgsFields = Partial<
  Pick<BuildStageArgsRequest, "runId" | "priorFindings" | "upstreamHandoff" | "piBin">
>;

const optionalStageArgsFields = (request: RunBmadStageRequest): OptionalStageArgsFields => ({
  ...(request.runId === undefined ? {} : { runId: request.runId }),
  ...(request.priorFindings === undefined ? {} : { priorFindings: request.priorFindings }),
  ...(request.upstreamHandoff === undefined ? {} : { upstreamHandoff: request.upstreamHandoff }),
  ...(request.piBin === undefined ? {} : { piBin: request.piBin }),
});

interface RunState {
  aborted: boolean;
  timedOut: boolean;
  parserFailed: boolean;
  streamFailure: string | undefined;
  settled: boolean;
  killTimer: NodeJS.Timeout | undefined;
  readonly killEscalationMs: number;
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
  cleanupHandlers: (() => void) | undefined;
}

const resolveTimeoutMs = (request: RunBmadStageRequest): number => {
  const timeoutMs = request.timeoutMs ?? request.stage.timeoutSeconds * millisecondsPerSecond;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
  return timeoutMs;
};

const resolveKillEscalationMs = (request: RunBmadStageRequest): number => {
  const killEscalationMs = request.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  if (!Number.isInteger(killEscalationMs) || killEscalationMs < 1) {
    throw new RangeError("killEscalationMs must be a positive integer.");
  }
  return killEscalationMs;
};

interface SpawnChildRequest {
  readonly spawn: BmadStageSpawn;
  readonly invocation: BuiltStageArgs;
  readonly cwd: string;
  readonly reject: (error: unknown) => void;
}

const inheritedStageEnvKeyPattern =
  /^PI_(?:SESSION_ID|SESSION_FILE|PROVIDER|MODEL|REASONING_LEVEL|SUBAGENT_PARENT_SESSION|BMAD_RUN_ID|BMAD_EMISSION_KEY|PACKAGE_DIR|EXTENSIONS|CODING_AGENT_DIR)$/u;

/**
 * Builds an isolated Pi child environment without mutating either input.
 *
 * @param parentEnv - Environment inherited by the pipeline process.
 * @param invocationEnv - Reviewed environment generated for this stage invocation.
 *
 * @returns A fresh child environment with inherited Pi control state removed.
 *
 * @example
 * ```ts
 * const env = buildStageEnvironment(process.env, invocation.env);
 * ```
 */
export function buildStageEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv>,
  invocationEnv: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([key]) => !inheritedStageEnvKeyPattern.test(key) && !key.startsWith("PI_SUBAGENT_CHILD"),
    ),
  );
  return { ...inherited, ...invocationEnv, PI_TELEMETRY: "0" };
}

const spawnChild = (request: SpawnChildRequest): BmadStageChildProcess | undefined => {
  try {
    return request.spawn(request.invocation.bin, request.invocation.args, {
      cwd: request.cwd,
      env: buildStageEnvironment(process.env, request.invocation.env),
      stdio: BMAD_STAGE_STDIO,
    });
  } catch (error) {
    request.reject(new BmadStageSpawnError(request.invocation.bin, error));
    return undefined;
  }
};

const attachChildHandlers = (child: BmadStageChildProcess, context: CloseContext): void => {
  const onStdoutData = (chunk: Uint8Array | string): void => {
    handleStdoutChunk(child, context, chunk);
  };
  const onStderrData = (chunk: Uint8Array | string): void => {
    context.stderr.push(chunk);
  };
  const onStdoutError = (): void => {
    handleStreamError(child, context, "Child stdout stream error.");
  };
  const onStderrError = (): void => {
    handleStreamError(child, context, "Child stderr stream error.");
  };
  const onChildError = (error: unknown): void => {
    handleChildError(context, error);
  };
  const onClose = (code: number | null): void => {
    resolveClose(context, code);
  };
  child.stdout.on("data", onStdoutData);
  child.stdout.on("error", onStdoutError);
  child.stderr.on("data", onStderrData);
  child.stderr.on("error", onStderrError);
  child.once("error", onChildError);
  child.once("close", onClose);
  context.cleanupHandlers = (): void => {
    child.stdout.off("data", onStdoutData);
    child.stdout.off("error", onStdoutError);
    child.stderr.off("data", onStderrData);
    child.stderr.off("error", onStderrError);
    child.off("error", onChildError);
    child.off("close", onClose);
  };
};

const handleChildError = (context: CloseContext, error: unknown): void => {
  if (!context.state.timedOut && !context.state.aborted && !context.state.parserFailed) {
    rejectOnce(context, new BmadStageSpawnError(context.command, error));
  }
};

const handleStdoutChunk = (
  child: BmadStageChildProcess,
  context: CloseContext,
  chunk: Uint8Array | string,
): void => {
  if (context.state.settled || context.state.parserFailed) {
    return;
  }
  const snapshot = context.parser.push(chunk);
  if (snapshot.fatalError !== undefined) {
    killWithEscalation(child, context.state, "parserFailed");
  }
};

const handleStreamError = (
  child: BmadStageChildProcess,
  context: CloseContext,
  failure: string,
): void => {
  if (context.state.settled || context.state.parserFailed) {
    return;
  }
  context.state.streamFailure = failure;
  killWithEscalation(child, context.state, "parserFailed");
};

const resolveClose = (context: CloseContext, exitCode: number | null): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  clearTimeout(context.timeout);
  clearTimeout(context.state.killTimer);
  context.request.signal.removeEventListener("abort", context.onAbort);
  context.cleanupHandlers?.();
  context.parser.finish();
  context.resolve(buildResult(context, exitCode));
};

const rejectOnce = (context: CloseContext, error: unknown): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  clearTimeout(context.timeout);
  clearTimeout(context.state.killTimer);
  context.request.signal.removeEventListener("abort", context.onAbort);
  context.cleanupHandlers?.();
  context.reject(error);
};

const buildResult = (context: CloseContext, exitCode: number | null): StageExecutionResult => {
  const snapshot = context.parser.snapshot();
  const extraction = extractOutput(context, snapshot);
  const gateContext: EnvelopeGateLogContext = {
    request: context.request,
    extraction,
    exitCode,
    timedOut: context.state.timedOut,
    aborted: context.state.aborted,
  };
  logEnvelopeGate(gateContext);
  const parseError = getParseError({
    snapshot,
    extraction,
    exitCode,
    stderr: context.stderr.value(),
  });
  const usage = extractUsage(context, snapshot);
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

const extractOutput = (
  context: CloseContext,
  snapshot: HeadlessJsonlParserSnapshot,
): GatedHeadlessOutputExtraction => {
  const failure = context.state.streamFailure ?? snapshot.fatalError;
  return failure === undefined
    ? extractGatedHeadlessOutput(snapshot.records, {
        emissionKey: context.emissionKey,
        rootDir: context.schemaRootDir,
        expectedWorkflow: context.request.stage.workflow,
        expectedStoryId: context.request.storyId,
      })
    : { output: null, failure };
};

const extractUsage = (context: CloseContext, snapshot: HeadlessJsonlParserSnapshot) =>
  !context.state.parserFailed && snapshot.fatalError === undefined
    ? extractStageUsage(snapshot.records)
    : undefined;

interface ParseErrorRequest {
  readonly snapshot: ReturnType<HeadlessJsonlParser["snapshot"]>;
  readonly extraction: GatedHeadlessOutputExtraction;
  readonly exitCode: number | null;
  readonly stderr: string;
}

const getParseError = (request: ParseErrorRequest): string | undefined => {
  if (request.snapshot.fatalError !== undefined) {
    return request.snapshot.fatalError;
  }
  const firstIssue = request.snapshot.issues[0];
  if (firstIssue !== undefined) {
    return `Invalid JSONL on line ${String(firstIssue.line)}: ${firstIssue.message}`;
  }
  return request.extraction.output === null ? missingOutputError(request) : undefined;
};

const missingOutputError = (request: ParseErrorRequest): string | undefined =>
  request.exitCode !== 0 && request.stderr.length > 0
    ? `Child stderr: ${request.stderr}`
    : request.extraction.failure;

/**
 * Resolves the pi-bmad package root (payload schema root) from its extension path.
 *
 * @param extensionPath - The pi-bmad extension file path passed to `pi -e`.
 *
 * @returns The pi-bmad package root containing `content/schemas`.
 */
const piBmadSchemaRootDir = (extensionPath: string): string =>
  resolvePath(dirname(extensionPath), "..");

// Marks why the child is being killed, sends SIGTERM, and schedules one SIGKILL escalation.
const killWithEscalation = (
  child: BmadStageChildProcess,
  state: RunState,
  reason: "timedOut" | "aborted" | "parserFailed",
): void => {
  if (reason === "parserFailed" && state.parserFailed) {
    return;
  }
  state[reason] = true;
  child.kill("SIGTERM");
  state.killTimer ??= setTimeout(() => child.kill("SIGKILL"), state.killEscalationMs);
};

const createRunState = (killEscalationMs: number): RunState => ({
  aborted: false,
  timedOut: false,
  parserFailed: false,
  streamFailure: undefined,
  settled: false,
  killTimer: undefined,
  killEscalationMs,
});
