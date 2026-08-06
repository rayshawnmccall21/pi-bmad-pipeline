import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import {
  DEFAULT_HARNESS_EVIDENCE_COMMANDS,
  runHarnessEvidenceCommand,
  validateCommandCwd,
} from "./harness-evidence-command.js";

/** Standard harness-owned evidence command names. */
export type HarnessEvidenceCommandName = "test" | "typecheck" | "lint";

/** Terminal status for one harness evidence command. */
export type HarnessEvidenceCommandStatus =
  "passed" | "failed" | "timed-out" | "aborted" | "spawn-failed";

/** Harness-owned command definition. */
export interface HarnessEvidenceCommand {
  /** Standard command label. */
  readonly name: HarnessEvidenceCommandName;

  /** Executable to spawn. */
  readonly command: string;

  /** Arguments passed to the executable. */
  readonly args: readonly string[];

  /** Optional command timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Result of one harness-owned command. */
export interface HarnessEvidenceCommandResult {
  /** Standard command label. */
  readonly name: HarnessEvidenceCommandName;

  /** Executable that was spawned. */
  readonly command: string;

  /** Arguments passed to the executable. */
  readonly args: readonly string[];

  /** Terminal command status. */
  readonly status: HarnessEvidenceCommandStatus;

  /** Child exit code, or null when unavailable. */
  readonly exitCode: number | null;

  /** Command duration in milliseconds. */
  readonly durationMs: number;

  /** Sanitized captured stdout. */
  readonly stdout: string;

  /** Sanitized captured stderr. */
  readonly stderr: string;

  /** Sanitized spawn error text. */
  readonly error?: string;

  /** True when the command timed out. */
  readonly timedOut?: boolean;

  /** True when the command was aborted. */
  readonly aborted?: boolean;
}

/** Complete harness-owned evidence report. */
export interface HarnessEvidenceReport {
  /** Supervised project root: the report identity and persistence root. */
  readonly projectRoot: string;

  /** Directory the evidence commands executed in. */
  readonly commandCwd?: string;

  /** Report start timestamp. */
  readonly startedAt: string;

  /** Report finish timestamp. */
  readonly finishedAt: string;

  /** True only when every command passed. */
  readonly passed: boolean;

  /** Sequential command results. */
  readonly commands: readonly HarnessEvidenceCommandResult[];
}

/** Injectable spawn function for tests. */
export type HarnessEvidenceSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** Request for running harness-owned evidence. */
export interface RunHarnessEvidenceRequest {
  /** Supervised project root recorded as the report identity. */
  readonly projectRoot: string;

  /** Directory to execute commands in; defaults to projectRoot. */
  readonly commandCwd?: string;

  /** Commands to run, or defaults when omitted. */
  readonly commands?: readonly HarnessEvidenceCommand[];

  /** Optional abort signal. */
  readonly signal?: AbortSignal;

  /** Optional spawn implementation. */
  readonly spawn?: HarnessEvidenceSpawn;

  /** Optional clock. */
  readonly now?: () => Date;
}

export {
  DEFAULT_HARNESS_EVIDENCE_COMMANDS,
  DEFAULT_HARNESS_EVIDENCE_TIMEOUT_MS,
  MAX_HARNESS_EVIDENCE_OUTPUT_CHARS,
  runHarnessEvidenceCommand,
} from "./harness-evidence-command.js";

/**
 * Runs all harness-owned evidence commands sequentially.
 *
 * The commands execute with cwd = `commandCwd` (mechanism), while the report
 * carries `projectRoot` as its identity (policy); the two are independent so
 * evidence can run in an isolated worktree yet persist at the supervised root.
 *
 * @param request - Identity root, command cwd, command list, and adapters.
 *
 * @returns Frozen harness-owned evidence report.
 *
 * @example
 * ```ts
 * const report = await runHarnessEvidence({
 *   projectRoot: "/repo",
 *   commandCwd: "/repo/.pi/pipeline/worktrees/SH-1",
 * });
 * ```
 */
export async function runHarnessEvidence(
  request: RunHarnessEvidenceRequest,
): Promise<HarnessEvidenceReport> {
  validateProjectRoot(request.projectRoot);
  const commandCwd = request.commandCwd ?? request.projectRoot;
  validateCommandCwd(commandCwd);
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  const results: HarnessEvidenceCommandResult[] = [];
  for (const command of request.commands ?? DEFAULT_HARNESS_EVIDENCE_COMMANDS) {
    results.push(await runHarnessEvidenceCommand(commandCwd, command, request));
  }
  return freezeReport({
    projectRoot: request.projectRoot,
    commandCwd,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    passed: results.every((result) => result.status === "passed"),
    commands: results,
  });
}

const validateProjectRoot = (projectRoot: string): void => {
  if (projectRoot.trim().length === 0) {
    throw new RangeError("Project root must not be blank.");
  }
};

const freezeReport = (report: HarnessEvidenceReport): HarnessEvidenceReport =>
  Object.freeze({
    ...report,
    commands: Object.freeze(report.commands.map((command) => Object.freeze(command))),
  });
