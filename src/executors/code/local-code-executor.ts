import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { CompiledCodeStage } from "../../rundef/index.js";
import { createDiagnosticCapture, type DiagnosticCapture } from "./code-diagnostic.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "../workflow-executor.js";

/** Stable executor id for trusted local code stages. */
export const LOCAL_CODE_EXECUTOR_ID = "local-code" as const;

export { MAX_CODE_DIAGNOSTIC_CHARS } from "./code-diagnostic.js";

/** Default delay before a terminated process group is force-killed. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- fixed bounded grace period.
export const DEFAULT_CODE_KILL_ESCALATION_MS = 10_000 as const;

/** Child stdio contract: closed stdin with drained stdout and stderr. */
export const CODE_STAGE_STDIO = Object.freeze(["ignore", "pipe", "pipe"] as const);

const millisecondsPerSecond = 1000;

/** Child process returned by the local code spawn seam. */
export type LocalCodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Spawn options fixed by the local code execution boundary. */
export interface LocalCodeSpawnOptions {
  /** Exact project root used as the child working directory. */
  readonly cwd: string;
  /** Parent process environment inherited by identity. */
  readonly env: NodeJS.ProcessEnv;
  /** Shell execution is always disabled. */
  readonly shell: false;
  /** Child starts a process group used for cancellation. */
  readonly detached: true;
  /** Fixed ignored/piped stdio tuple. */
  readonly stdio: typeof CODE_STAGE_STDIO;
}

/** Injectable local process spawn function. */
export type LocalCodeSpawn = (
  command: string,
  args: readonly string[],
  options: LocalCodeSpawnOptions,
) => LocalCodeChildProcess;

/** Injectable process-group signal function. */
export type LocalCodeKill = (pid: number, signal: NodeJS.Signals) => unknown;

/** Options for deterministic local code execution. */
export interface LocalCodeExecutorOptions {
  /** Optional process spawn implementation. */
  readonly spawn?: LocalCodeSpawn;
  /** Optional wall clock used for duration measurement. */
  readonly now?: () => number;
  /** Optional process-group signal implementation. */
  readonly kill?: LocalCodeKill;
  /** Optional timeout override in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional SIGTERM grace period before SIGKILL. */
  readonly killEscalationMs?: number;
}

/** Error raised when a local code process cannot be spawned. */
export class LocalCodeSpawnError extends Error {
  /** Executable whose spawn failed. */
  public readonly command: string;

  /**
   * Creates a typed local spawn error.
   *
   * @param command - Executable whose spawn failed.
   * @param cause - Original synchronous or asynchronous spawn error.
   */
  public constructor(command: string, cause: unknown) {
    super(`Failed to spawn local code process "${command}".`, { cause });
    this.name = "LocalCodeSpawnError";
    this.command = command;
  }
}

/** Workflow executor backed by a direct local child process. */
export class LocalCodeExecutor implements WorkflowExecutor {
  /** Stable executor identifier. */
  public readonly id = LOCAL_CODE_EXECUTOR_ID;

  private readonly options: LocalCodeExecutorOptions;

  /**
   * Creates a local code executor.
   *
   * @param options - Optional deterministic process seams.
   *
   * @throws RangeError When a timeout option is not a positive integer.
   */
  public constructor(options: LocalCodeExecutorOptions = {}) {
    validatePositiveInteger("timeoutMs", options.timeoutMs);
    validatePositiveInteger("killEscalationMs", options.killEscalationMs);
    this.options = options;
  }

  /**
   * Executes one compiled code stage without a shell.
   *
   * @param request - Stage execution request.
   *
   * @returns Local child exit data with null workflow output.
   *
   * @throws RangeError When the concrete executor receives a non-code stage.
   * @throws LocalCodeSpawnError When the child process cannot be spawned.
   *
   * @example
   * ```ts
   * await new LocalCodeExecutor().execute(request);
   * ```
   */
  public execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    if (request.stage.kind !== "code") {
      throw new RangeError('LocalCodeExecutor requires a stage with kind "code".');
    }
    return executeCodeStage(request, request.stage, this.options);
  }
}

interface RunState {
  aborted: boolean;
  timedOut: boolean;
  settled: boolean;
  terminating: boolean;
  exitCode: number | null;
  killTimer: ReturnType<typeof setTimeout> | undefined;
}

interface RunContext {
  readonly request: StageExecutionRequest;
  readonly stage: CompiledCodeStage;
  readonly child: LocalCodeChildProcess;
  readonly state: RunState;
  readonly capture: DiagnosticCapture;
  readonly now: () => number;
  readonly startedAt: number;
  readonly kill: LocalCodeKill;
  readonly escalationMs: number;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  readonly resolve: (result: StageExecutionResult) => void;
  readonly reject: (error: unknown) => void;
}

const executeCodeStage = (
  request: StageExecutionRequest,
  stage: CompiledCodeStage,
  options: LocalCodeExecutorOptions,
): Promise<StageExecutionResult> => {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  return new Promise((resolve, reject) => {
    const child = spawnChild(stage, request.projectRoot, options);
    const context = createRunContext({
      request,
      stage,
      child,
      options,
      now,
      startedAt,
      resolve,
      reject,
    });
    attachHandlers(context);
    listenForAbort(context);
  });
};

const spawnChild = (
  stage: CompiledCodeStage,
  projectRoot: string,
  options: LocalCodeExecutorOptions,
): LocalCodeChildProcess => {
  try {
    return (options.spawn ?? nodeLocalCodeSpawn)(stage.command, stage.args, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      detached: true,
      stdio: CODE_STAGE_STDIO,
    });
  } catch (error) {
    throw new LocalCodeSpawnError(stage.command, error);
  }
};

interface CreateRunContextRequest {
  readonly request: StageExecutionRequest;
  readonly stage: CompiledCodeStage;
  readonly child: LocalCodeChildProcess;
  readonly options: LocalCodeExecutorOptions;
  readonly now: () => number;
  readonly startedAt: number;
  readonly resolve: (result: StageExecutionResult) => void;
  readonly reject: (error: unknown) => void;
}

const createRunContext = (input: CreateRunContextRequest): RunContext => {
  const context: RunContext = {
    request: input.request,
    stage: input.stage,
    child: input.child,
    state: createRunState(),
    capture: createDiagnosticCapture(),
    now: input.now,
    startedAt: input.startedAt,
    kill: input.options.kill ?? ((pid, signal) => process.kill(pid, signal)),
    escalationMs: input.options.killEscalationMs ?? DEFAULT_CODE_KILL_ESCALATION_MS,
    timeout: setTimeout(
      () => {
        terminate(context, "timedOut");
      },
      input.options.timeoutMs ?? input.stage.timeoutSeconds * millisecondsPerSecond,
    ),
    onAbort: () => {
      terminate(context, "aborted");
    },
    resolve: input.resolve,
    reject: input.reject,
  };
  return context;
};

const listenForAbort = (context: RunContext): void => {
  context.request.signal.addEventListener("abort", context.onAbort, { once: true });
  if (context.request.signal.aborted) {
    context.onAbort();
  }
};

const attachHandlers = (context: RunContext): void => {
  context.child.stdout.on("data", context.capture.pushStdout);
  context.child.stderr.on("data", context.capture.pushStderr);
  context.child.once("error", (error: unknown) => {
    if (!context.state.terminating) {
      rejectOnce(context, new LocalCodeSpawnError(context.stage.command, error));
    }
  });
  context.child.once("close", (exitCode: number | null) => {
    context.state.exitCode = exitCode;
    resolveOnce(context);
  });
};

// ponytail: duplicated Pi lifecycle; extract only if a third process adapter needs it.
const terminate = (context: RunContext, reason: "aborted" | "timedOut"): void => {
  context.state[reason] = true;
  if (context.state.terminating || context.state.settled) {
    return;
  }
  context.state.terminating = true;
  signalGroup(context, "SIGTERM");
  context.state.killTimer = setTimeout(() => {
    signalGroup(context, "SIGKILL");
    resolveOnce(context);
  }, context.escalationMs);
};

const signalGroup = (context: RunContext, signal: NodeJS.Signals): void => {
  const pid = context.child.pid;
  if (pid === undefined || pid < 1) {
    return;
  }
  try {
    context.kill(-pid, signal);
  } catch {
    // The process group may have exited between close observation and signaling.
  }
};

const resolveOnce = (context: RunContext): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  cleanup(context, context.state.terminating);
  context.resolve(buildResult(context));
};

const buildResult = (context: RunContext): StageExecutionResult => {
  const diagnostic = failureDiagnostic(context);
  return {
    output: null,
    exitCode: context.state.exitCode,
    durationMs: Math.max(0, context.now() - context.startedAt),
    ...(diagnostic.length === 0 ? {} : { diagnostic }),
    ...(context.state.timedOut ? { timedOut: true } : {}),
    ...(context.state.aborted ? { aborted: true } : {}),
  };
};

const failureDiagnostic = (context: RunContext): string =>
  context.state.exitCode !== 0 || context.state.timedOut || context.state.aborted
    ? context.capture.value()
    : "";

const rejectOnce = (context: RunContext, error: unknown): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  cleanup(context);
  context.reject(error);
};

const cleanup = (context: RunContext, preserveKillEscalation = false): void => {
  clearTimeout(context.timeout);
  if (!preserveKillEscalation) {
    clearTimeout(context.state.killTimer);
  }
  context.request.signal.removeEventListener("abort", context.onAbort);
};

const createRunState = (): RunState => ({
  aborted: false,
  timedOut: false,
  settled: false,
  terminating: false,
  exitCode: null,
  killTimer: undefined,
});

const validatePositiveInteger = (name: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
};

const nodeLocalCodeSpawn: LocalCodeSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    detached: options.detached,
    stdio: [...options.stdio],
  });
