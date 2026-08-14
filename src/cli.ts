#!/usr/bin/env node
/**
 * Provides the thin run/help/version CLI shell.
 *
 * @packageDocumentation
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runPipelineAction } from "./actions/index.js";
import { CLI_USAGE_LINES, parseCliArgs } from "./cli-args.js";
import type { CliCommand, CliRunCommand } from "./cli-command.js";
import {
  CLI_EXIT_ERROR,
  CLI_EXIT_OK,
  createProcessLineSink,
  formatHumanEventLine,
  runStatusExitCode,
} from "./cli-output.js";
import { errorMessage } from "./core/runner-evaluation.js";
import type { PipelineEventSink } from "./events/index.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
import { redactText } from "./security/index.js";

/**
 * Returns the package version banner.
 *
 * @returns Package name and semantic version.
 *
 * @example
 * ```ts
 * versionBanner();
 * ```
 */
export function versionBanner(): string {
  return `${PACKAGE_NAME} v${PACKAGE_VERSION}`;
}

/** Injected effects used by the CLI shell. */
export interface RunCliDeps {
  /** Protocol output sink. */
  readonly stdout: PipelineEventSink;
  /** Diagnostic output sink. */
  readonly stderr: PipelineEventSink;
  /** Default project-root provider. */
  readonly cwd: () => string;
  /** Environment forwarded to the run action. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Durable pipeline action. */
  readonly runPipeline: typeof runPipelineAction;
  /** Optional cancellation signal forwarded to the run action. */
  readonly signal?: AbortSignal;
}

/** Real CLI dependencies. */
export const defaultRunCliDeps: RunCliDeps = Object.freeze({
  stdout: createProcessLineSink(process.stdout),
  stderr: createProcessLineSink(process.stderr),
  cwd: (): string => process.cwd(),
  env: process.env,
  runPipeline: runPipelineAction,
});

const writeUsage = (sink: PipelineEventSink): void => {
  for (const line of CLI_USAGE_LINES) {
    sink.write(line);
  }
};

const createRunEventSink = (jsonl: boolean, stdout: PipelineEventSink): PipelineEventSink =>
  jsonl
    ? stdout
    : Object.freeze({
        write: (line: string): void => {
          stdout.write(formatHumanEventLine(line));
        },
      });

const executeRun = async (command: CliRunCommand, deps: RunCliDeps): Promise<number> => {
  const result = await deps.runPipeline({
    rundefId: command.rundefId,
    storyId: command.storyId,
    specFile: command.specFile,
    projectRoot: command.projectRoot ?? deps.cwd(),
    env: deps.env,
    sink: createRunEventSink(command.jsonl, deps.stdout),
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.thinking === undefined ? {} : { thinking: command.thinking }),
    ...(command.maxRegressions === undefined ? {} : { maxRegressions: command.maxRegressions }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  return runStatusExitCode(result.status);
};

const dispatchCommand = (command: CliCommand, deps: RunCliDeps): Promise<number> => {
  if (command.kind === "help") {
    writeUsage(deps.stdout);
    return Promise.resolve(CLI_EXIT_OK);
  }
  if (command.kind === "version") {
    deps.stdout.write(versionBanner());
    return Promise.resolve(CLI_EXIT_OK);
  }
  return executeRun(command, deps);
};

/**
 * Parses and runs one CLI command.
 *
 * @param argv - Raw arguments beginning with the command word.
 * @param deps - Optional injected shell effects.
 *
 * @returns Process exit code.
 *
 * @example
 * ```ts
 * await runCli(["help"]);
 * ```
 */
export async function runCli(
  argv: readonly string[],
  deps: Partial<RunCliDeps> = {},
): Promise<number> {
  const resolved: RunCliDeps = Object.freeze({ ...defaultRunCliDeps, ...deps });
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "parse-error") {
    resolved.stderr.write(`${PACKAGE_NAME}: ${parsed.message} (${parsed.code})`);
    writeUsage(resolved.stderr);
    return CLI_EXIT_ERROR;
  }
  try {
    return await dispatchCommand(parsed, resolved);
  } catch (error) {
    resolved.stderr.write(`${PACKAGE_NAME}: ${redactText(errorMessage(error)).value}`);
    return CLI_EXIT_ERROR;
  }
}

const realpathOrSame = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Tests whether a module URL is the process entry point.
 *
 * @param moduleUrl - Candidate module URL.
 * @param argv - Process argument vector.
 * @param resolvePath - Injectable path resolver.
 *
 * @returns True when the module is the invoked entry.
 *
 * @example
 * ```ts
 * isMainModule(import.meta.url, process.argv);
 * ```
 */
export function isMainModule(
  moduleUrl: string,
  argv: readonly string[],
  resolvePath: (path: string) => string = realpathOrSame,
): boolean {
  const entryPath = argv[1];
  return entryPath === undefined ? false : pathToFileURL(resolvePath(entryPath)).href === moduleUrl;
}

const commandArgumentOffset = 2;

const runExecutable = async (): Promise<void> => {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  try {
    process.exitCode = await runCli(process.argv.slice(commandArgumentOffset), {
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
};

if (isMainModule(import.meta.url, process.argv)) {
  void runExecutable();
}
