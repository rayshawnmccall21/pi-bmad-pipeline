/* eslint-disable jsdoc/require-jsdoc, max-params -- internal command runner helpers. */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { redactError, redactText } from "./redaction.js";

import type {
  HarnessEvidenceCommand,
  HarnessEvidenceCommandResult,
  HarnessEvidenceCommandStatus,
  HarnessEvidenceSpawn,
  RunHarnessEvidenceRequest,
} from "./harness-evidence.js";

/** Default command timeout: 10 minutes. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- documented default timeout.
export const DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS = 600_000 as const;

/** Maximum captured stdout/stderr chars per stream. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- documented output cap.
export const MAX_HARNESS_EVIDENCE_OUTPUT_CHARS = 32_768 as const;

/** Default evidence commands: npm test, npm run typecheck, npm run lint. */
export const DEFAULT_HARNESS_EVIDENCE_COMMANDS: readonly HarnessEvidenceCommand[] = Object.freeze([
  freezeCommand({ name: "test", command: "npm", args: ["test"] }),
  freezeCommand({ name: "typecheck", command: "npm", args: ["run", "typecheck"] }),
  freezeCommand({ name: "lint", command: "npm", args: ["run", "lint"] }),
]);

export function runHarnessEvidenceCommand(
  projectRoot: string,
  command: HarnessEvidenceCommand,
  options: Pick<RunHarnessEvidenceRequest, "signal" | "spawn" | "now"> = {},
): Promise<HarnessEvidenceCommandResult> {
  validateCommandRequest(projectRoot, command);
  const timeoutMs = resolveTimeoutMs(command);
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const state = createCommandState();
  const stdout = createCapture();
  const stderr = createCapture();
  const spawn = options.spawn ?? nodeSpawn;

  return new Promise((resolve) => {
    const child = spawnChild(spawn, projectRoot, command, startedAt, now, resolve);
    if (child === undefined) {
      return;
    }
    watchChild({
      child,
      command,
      startedAt,
      now,
      stdout,
      stderr,
      state,
      timeoutMs,
      options,
      resolve,
    });
  });
}

interface WatchChildRequest {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: HarnessEvidenceCommand;
  readonly startedAt: number;
  readonly now: () => Date;
  readonly stdout: ReturnType<typeof createCapture>;
  readonly stderr: ReturnType<typeof createCapture>;
  readonly state: CommandState;
  readonly timeoutMs: number;
  readonly options: Pick<RunHarnessEvidenceRequest, "signal">;
  readonly resolve: (result: HarnessEvidenceCommandResult) => void;
}

interface CommandState {
  aborted: boolean;
  timedOut: boolean;
  settled: boolean;
}

interface CloseContext {
  readonly command: HarnessEvidenceCommand;
  readonly startedAt: number;
  readonly now: () => Date;
  readonly stdout: ReturnType<typeof createCapture>;
  readonly stderr: ReturnType<typeof createCapture>;
  readonly state: CommandState;
  readonly timeout: NodeJS.Timeout;
  readonly options: Pick<RunHarnessEvidenceRequest, "signal">;
  readonly onAbort: () => void;
  readonly resolve: (result: HarnessEvidenceCommandResult) => void;
}

const watchChild = (request: WatchChildRequest): void => {
  const timeout = setTimeout(() => {
    request.state.timedOut = true;
    request.child.kill("SIGTERM");
  }, request.timeoutMs);
  const onAbort = (): void => {
    request.state.aborted = true;
    request.child.kill("SIGTERM");
  };
  request.options.signal?.addEventListener("abort", onAbort, { once: true });
  attachChildHandlers(request.child, { ...request, timeout, onAbort });
  if (request.options.signal?.aborted === true) {
    onAbort();
  }
};

const validateProjectRoot = (projectRoot: string): void => {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
};

const validateCommandRequest = (projectRoot: string, command: HarnessEvidenceCommand): void => {
  validateProjectRoot(projectRoot);
  validateNonBlank("command", command.command);
  for (const arg of command.args) {
    validateNonBlank("arg", arg);
  }
};

const validateNonBlank = (field: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const resolveTimeoutMs = (command: HarnessEvidenceCommand): number => {
  const timeoutMs = command.timeoutMs ?? DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive integer.");
  }
  return timeoutMs;
};

const spawnChild = (
  spawn: HarnessEvidenceSpawn,
  projectRoot: string,
  command: HarnessEvidenceCommand,
  startedAt: number,
  now: () => Date,
  resolve: (result: HarnessEvidenceCommandResult) => void,
): ChildProcessWithoutNullStreams | undefined => {
  try {
    return spawn(command.command, command.args, { cwd: projectRoot, env: process.env });
  } catch (error) {
    resolve(buildSpawnFailedResult(command, startedAt, now, sanitizeUnknownError(error)));
    return undefined;
  }
};

const attachChildHandlers = (
  child: ChildProcessWithoutNullStreams,
  context: CloseContext,
): void => {
  child.stdout.on("data", (chunk: Uint8Array | string) => {
    context.stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Uint8Array | string) => {
    context.stderr.push(chunk);
  });
  child.once("error", (error: unknown) => {
    resolveOnce(
      context,
      buildSpawnFailedResult(
        context.command,
        context.startedAt,
        context.now,
        sanitizeUnknownError(error),
      ),
    );
  });
  child.once("close", (exitCode: number | null) => {
    resolveOnce(context, buildClosedResult(context, exitCode));
  });
};

const resolveOnce = (context: CloseContext, result: HarnessEvidenceCommandResult): void => {
  if (context.state.settled) {
    return;
  }
  context.state.settled = true;
  clearTimeout(context.timeout);
  context.options.signal?.removeEventListener("abort", context.onAbort);
  context.resolve(result);
};

const buildClosedResult = (
  context: CloseContext,
  exitCode: number | null,
): HarnessEvidenceCommandResult => {
  if (context.state.timedOut) {
    return buildResult(
      context.command,
      "timed-out",
      exitCode,
      context.startedAt,
      context.now,
      context.stdout.value(),
      context.stderr.value(),
      { timedOut: true },
    );
  }
  if (context.state.aborted) {
    return buildResult(
      context.command,
      "aborted",
      exitCode,
      context.startedAt,
      context.now,
      context.stdout.value(),
      context.stderr.value(),
      { aborted: true },
    );
  }
  return buildResult(
    context.command,
    exitCode === 0 ? "passed" : "failed",
    exitCode,
    context.startedAt,
    context.now,
    context.stdout.value(),
    context.stderr.value(),
  );
};

const buildSpawnFailedResult = (
  command: HarnessEvidenceCommand,
  startedAt: number,
  now: () => Date,
  error: string,
): HarnessEvidenceCommandResult =>
  buildResult(command, "spawn-failed", null, startedAt, now, "", "", { error });

const buildResult = (
  command: HarnessEvidenceCommand,
  status: HarnessEvidenceCommandStatus,
  exitCode: number | null,
  startedAt: number,
  now: () => Date,
  stdout: string,
  stderr: string,
  optionals: Partial<Pick<HarnessEvidenceCommandResult, "error" | "timedOut" | "aborted">> = {},
): HarnessEvidenceCommandResult =>
  Object.freeze({
    name: command.name,
    command: command.command,
    args: Object.freeze([...command.args]),
    status,
    exitCode,
    durationMs: Math.max(0, now().getTime() - startedAt),
    stdout: redactText(stdout).value,
    stderr: redactText(stderr).value,
    ...optionals,
  });

const createCommandState = (): CommandState => ({
  aborted: false,
  timedOut: false,
  settled: false,
});

const createCapture = (): {
  readonly push: (chunk: Uint8Array | string) => void;
  readonly value: () => string;
} => {
  let captured = "";
  return {
    push(chunk) {
      captured = `${captured}${chunkToString(chunk)}`.slice(0, MAX_HARNESS_EVIDENCE_OUTPUT_CHARS);
    },
    value() {
      return captured;
    },
  };
};

const sanitizeUnknownError = (error: unknown): string =>
  error instanceof Error ? redactError(error).value : redactText(String(error)).value;

const chunkToString = (chunk: Uint8Array | string): string =>
  typeof chunk === "string" ? chunk : new TextDecoder("utf-8").decode(chunk);

function freezeCommand(command: HarnessEvidenceCommand): HarnessEvidenceCommand {
  return Object.freeze({ ...command, args: Object.freeze([...command.args]) });
}
