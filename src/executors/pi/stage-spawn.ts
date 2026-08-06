/**
 * Process-spawn seam for BMAD stage children.
 *
 * Owns the stdio contract and the default node:child_process adapter. Stdin is
 * deliberately ignored so Pi print-mode children observe EOF immediately instead
 * of blocking forever on an open supervisor pipe; stdout/stderr are piped for
 * JSONL parsing and diagnostics.
 *
 * @packageDocumentation
 */
import { spawn as nodeChildProcessSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** Child stdio contract: stdin ignored, stdout/stderr piped. */
export const BMAD_STAGE_STDIO = Object.freeze(["ignore", "pipe", "pipe"] as const);

/** Child process shape produced by the stage stdio contract (no stdin stream). */
export type BmadStageChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Spawn options passed across the stage process seam. */
export interface BmadStageSpawnOptions {
  /** Worktree cwd for the child. */
  readonly cwd: string;
  /** Full child environment (parent env plus emission variables). */
  readonly env: NodeJS.ProcessEnv;
  /** Stdio contract; always {@link BMAD_STAGE_STDIO}. */
  readonly stdio: typeof BMAD_STAGE_STDIO;
}

/** Minimal spawn function used by runBmadStage; injectable for tests. */
export type BmadStageSpawn = (
  command: string,
  args: readonly string[],
  options: BmadStageSpawnOptions,
) => BmadStageChildProcess;

/**
 * Default spawn adapter binding the seam contract to node:child_process.
 *
 * @param command - Executable to spawn.
 * @param args - Argv passed to the executable.
 * @param options - Seam spawn options (cwd, env, stdio contract).
 *
 * @returns The spawned child with stdin ignored and stdout/stderr piped.
 *
 * @example
 * ```ts
 * const child = nodeStageSpawn("pi", ["--version"], { cwd, env, stdio: BMAD_STAGE_STDIO });
 * ```
 */
export const nodeStageSpawn: BmadStageSpawn = (command, args, options) =>
  nodeChildProcessSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio],
  });
