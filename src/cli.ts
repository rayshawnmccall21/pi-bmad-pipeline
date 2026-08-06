#!/usr/bin/env node
/**
 * CLI entry point for the bmad-pipeline command.
 *
 * Thin imperative shell over the action layer: argv parsing (cli-args) and
 * output policy (cli-output) are pure sibling modules; this module owns the
 * dispatcher whose effects are all injected with real defaults. Protocol
 * output — JSONL pipeline events, JSON reports, or their one-line
 * human-readable renderings — goes to the stdout sink; diagnostics go to the
 * stderr sink.
 *
 * @packageDocumentation
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runPipelineAction } from "./actions/index.js";
import { generatePipelineAuditReport } from "./audit/index.js";
import { CLI_USAGE_LINES, parseCliArgs } from "./cli-args.js";
import type {
  CliAuditCommand,
  CliCommand,
  CliIsoCommand,
  CliMergeCommand,
  CliRunCommand,
} from "./cli-command.js";
import {
  CLI_EXIT_BLOCKED,
  CLI_EXIT_ERROR,
  CLI_EXIT_OK,
  createProcessLineSink,
  formatHumanEventLine,
  runStatusExitCode,
} from "./cli-output.js";
import { errorMessage } from "./core/runner-evaluation.js";
import { createPipelineEventEmitter, type PipelineEventSink } from "./events/index.js";
import { registerBmadPayloadGates } from "./gates/index.js";
import { SDLC_RUNDEF_ID, selectAndCompileRunDef, type CompiledStageDef } from "./rundef/index.js";
import {
  ensureStoryWorktree,
  evaluateMergeGate,
  type AgentEvidenceClaim,
  type EvaluateMergeGateRequest,
} from "./git/index.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.js";
import { loadHarnessEvidence, redactText, type HarnessEvidenceReport } from "./security/index.js";
import {
  loadCurrentRunPointer,
  loadPipelineState,
  type CurrentRunPointer,
  type PipelineState,
} from "./state/index.js";

/**
 * Prints the CLI version banner.
 *
 * @returns The version string.
 *
 * @example
 * Calling `versionBanner()` returns the string `pi-bmad-pipeline v0.1.0`.
 */
export function versionBanner(): string {
  return `${PACKAGE_NAME} v${PACKAGE_VERSION}`;
}

/** Stable error code emitted when durable state is missing for a story. */
export const STATE_NOT_FOUND_ERROR_CODE = "state-not-found" as const;

/** Injected effects used by {@link runCli}; defaults are real implementations. */
export interface RunCliDeps {
  /** Protocol output line sink. */
  readonly stdout: PipelineEventSink;

  /** Diagnostics line sink. */
  readonly stderr: PipelineEventSink;

  /** Provides the default project root. */
  readonly cwd: () => string;

  /** Environment map forwarded to the run action (D7 boundary read). */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** Runs one durable pipeline action. */
  readonly runPipeline: typeof runPipelineAction;

  /** Loads durable pipeline state. */
  readonly loadState: typeof loadPipelineState;

  /** Loads persisted harness-owned evidence. */
  readonly loadEvidence: typeof loadHarnessEvidence;

  /** Resolves and compiles the rundef whose stage definitions the audit joins. */
  readonly compileStages: (
    projectRoot: string,
    rundefId: string,
  ) => Promise<readonly CompiledStageDef[]>;

  /** Loads the current-run pointer carrying the agent claim. */
  readonly loadCurrentRun: typeof loadCurrentRunPointer;

  /** Generates the sanitized pipeline audit report. */
  readonly generateAudit: typeof generatePipelineAuditReport;

  /** Ensures the isolated story worktree exists. */
  readonly ensureWorktree: typeof ensureStoryWorktree;

  /** Evaluates default-branch merge eligibility. */
  readonly evaluateMerge: typeof evaluateMergeGate;
}

// Registers built-in gates then resolves + compiles the audited rundef.
const defaultCompileStages = async (
  projectRoot: string,
  rundefId: string,
): Promise<readonly CompiledStageDef[]> => {
  registerBmadPayloadGates();
  const selection = await selectAndCompileRunDef(projectRoot, rundefId);
  return selection.stages;
};

/** Real default dependencies used when the caller injects no overrides. */
export const defaultRunCliDeps: RunCliDeps = Object.freeze({
  stdout: createProcessLineSink(process.stdout),
  stderr: createProcessLineSink(process.stderr),
  cwd: (): string => process.cwd(),
  env: process.env,
  runPipeline: runPipelineAction,
  loadState: loadPipelineState,
  loadEvidence: loadHarnessEvidence,
  compileStages: defaultCompileStages,
  loadCurrentRun: loadCurrentRunPointer,
  generateAudit: generatePipelineAuditReport,
  ensureWorktree: ensureStoryWorktree,
  evaluateMerge: evaluateMergeGate,
} satisfies RunCliDeps);

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
    openPr: command.openPr,
    env: deps.env,
    sink: createRunEventSink(command.jsonl, deps.stdout),
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.thinking === undefined ? {} : { thinking: command.thinking }),
    ...(command.maxRegressions === undefined ? {} : { maxRegressions: command.maxRegressions }),
  });
  return runStatusExitCode(result.status);
};

const reportMissingState = (storyId: string, deps: RunCliDeps): number => {
  createPipelineEventEmitter({ sink: deps.stdout, storyId }).emit("error", {
    code: STATE_NOT_FOUND_ERROR_CODE,
    message: `No durable pipeline state found for story "${storyId}".`,
  });
  return CLI_EXIT_BLOCKED;
};

/** Stable error code emitted when the audit rundef cannot be resolved or compiled. */
export const RUNDEF_UNAVAILABLE_ERROR_CODE = "rundef-unavailable" as const;

const stateDurationMs = (state: PipelineState): number => {
  if (state.startedAt === null || state.finishedAt === null) {
    return 0;
  }
  const span = Date.parse(state.finishedAt) - Date.parse(state.startedAt);
  return Number.isFinite(span) && span > 0 ? span : 0;
};

const compileAuditStages = async (
  command: CliAuditCommand,
  projectRoot: string,
  deps: RunCliDeps,
): Promise<readonly CompiledStageDef[] | undefined> => {
  try {
    return await deps.compileStages(projectRoot, command.rundefId ?? SDLC_RUNDEF_ID);
  } catch (error) {
    createPipelineEventEmitter({ sink: deps.stdout, storyId: command.storyId }).emit("error", {
      code: RUNDEF_UNAVAILABLE_ERROR_CODE,
      message: errorMessage(error),
    });
    return undefined;
  }
};

interface AuditReportInputs {
  readonly state: PipelineState;
  readonly stages: readonly CompiledStageDef[];
  readonly evidence: HarnessEvidenceReport | undefined;
}

const buildAuditReport = (
  inputs: AuditReportInputs,
  deps: RunCliDeps,
): ReturnType<RunCliDeps["generateAudit"]> =>
  deps.generateAudit({
    state: inputs.state,
    stages: inputs.stages,
    action: "audit",
    startedAt: inputs.state.startedAt ?? "",
    finishedAt: inputs.state.finishedAt ?? "",
    durationMs: stateDurationMs(inputs.state),
    ...(inputs.evidence === undefined ? {} : { harnessEvidence: inputs.evidence }),
  });

const executeAudit = async (command: CliAuditCommand, deps: RunCliDeps): Promise<number> => {
  const projectRoot = command.projectRoot ?? deps.cwd();
  const state = await deps.loadState(projectRoot, command.storyId);
  if (state === undefined) {
    return reportMissingState(command.storyId, deps);
  }
  const evidence = await deps.loadEvidence({ projectRoot, storyId: command.storyId });
  const stages = await compileAuditStages(command, projectRoot, deps);
  if (stages === undefined) {
    return CLI_EXIT_BLOCKED;
  }
  const report = buildAuditReport({ state, stages, evidence }, deps);
  deps.stdout.write(JSON.stringify(report));
  return runStatusExitCode(report.status);
};

const executeIso = async (command: CliIsoCommand, deps: RunCliDeps): Promise<number> => {
  const worktree = await deps.ensureWorktree({
    projectRoot: command.projectRoot ?? deps.cwd(),
    storyId: command.storyId,
  });
  deps.stdout.write(
    JSON.stringify({
      command: "iso",
      storyId: worktree.storyId,
      specFile: command.specFile,
      branch: worktree.branch,
      path: worktree.path,
    }),
  );
  return CLI_EXIT_OK;
};

const mergeClaimFor = (
  pointer: CurrentRunPointer | undefined,
  storyId: string,
): AgentEvidenceClaim | undefined => {
  if (pointer?.storyId !== storyId) {
    return undefined;
  }
  return pointer.agentClaim;
};

const mergeGateRequestFor = (
  evidence: HarnessEvidenceReport | undefined,
  claim: AgentEvidenceClaim | undefined,
): EvaluateMergeGateRequest => ({
  ...(evidence === undefined ? {} : { harnessEvidence: evidence }),
  ...(claim === undefined ? {} : { agentClaim: claim }),
});

const executeMerge = async (command: CliMergeCommand, deps: RunCliDeps): Promise<number> => {
  const projectRoot = command.projectRoot ?? deps.cwd();
  const state = await deps.loadState(projectRoot, command.storyId);
  if (state === undefined) {
    return reportMissingState(command.storyId, deps);
  }
  const evidence = await deps.loadEvidence({ projectRoot, storyId: command.storyId });
  const claim = mergeClaimFor(await deps.loadCurrentRun(projectRoot), command.storyId);
  const evaluation = deps.evaluateMerge(mergeGateRequestFor(evidence, claim));
  createPipelineEventEmitter({ sink: deps.stdout, storyId: command.storyId }).emit(
    "merge.decision",
    {
      decision: evaluation.decision,
      blockers: evaluation.blockers.map((blocker) => `${blocker.code}: ${blocker.reason}`),
    },
  );
  return evaluation.passed ? CLI_EXIT_OK : CLI_EXIT_BLOCKED;
};

const dispatchCommand = (command: CliCommand, deps: RunCliDeps): Promise<number> => {
  switch (command.kind) {
    case "help":
      writeUsage(deps.stdout);
      return Promise.resolve(CLI_EXIT_OK);
    case "version":
      deps.stdout.write(versionBanner());
      return Promise.resolve(CLI_EXIT_OK);
    case "run":
      return executeRun(command, deps);
    case "audit":
      return executeAudit(command, deps);
    case "iso":
      return executeIso(command, deps);
    case "merge":
      return executeMerge(command, deps);
  }
};

/**
 * Runs the CLI: parses argv, dispatches through injected effects, and maps
 * every outcome to an exit code.
 *
 * Exit codes: 0 for passing outcomes, 1 for usage or internal errors, 2 for
 * evaluated non-passing outcomes. Protocol output goes to the stdout sink;
 * diagnostics go to the stderr sink.
 *
 * @param argv - Raw argument vector starting at the command word.
 * @param deps - Optional injected effect overrides; omitted effects use real
 * defaults.
 *
 * @returns Process exit code; never throws.
 *
 * @example
 * ```ts
 * process.exitCode = await runCli(process.argv.slice(2));
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
 * Checks whether a module URL is the executed process entry point.
 *
 * The entry path is passed through a resolver (realpath by default) so npm
 * bin symlink shims still match the realpathed import.meta.url.
 *
 * @param moduleUrl - The import.meta.url of the candidate module.
 * @param argv - Raw process argv whose second entry is the executed script.
 * @param resolvePath - Injectable path resolver; defaults to realpath with a
 * fall-through to the unresolved path.
 *
 * @returns True when the module is the process entry point.
 *
 * @example
 * ```ts
 * if (isMainModule(import.meta.url, process.argv)) {
 *   // run the CLI
 * }
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

const ARGV_COMMAND_START = 2;

if (isMainModule(import.meta.url, process.argv)) {
  void runCli(process.argv.slice(ARGV_COMMAND_START)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
