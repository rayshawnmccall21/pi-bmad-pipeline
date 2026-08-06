/**
 * Pure argv parsing for the bmad-pipeline CLI.
 *
 * Owns the command grammar as data (one spec table), a generic token scanner,
 * and per-command builders. Everything here is pure and effect-free: every
 * failure is returned as a structured {@link CliParseError} with a stable
 * machine-readable code, never thrown.
 *
 * @packageDocumentation
 */

/** Usage text, one line per entry, written via a line sink. */
export const CLI_USAGE_LINES: readonly string[] = Object.freeze([
  "Usage: bmad-pipeline [command] [options]",
  "Commands:",
  "  run [rundef-id] --story-id ID --spec-file PATH [--project-root DIR]",
  "      [--model NAME] [--thinking EFFORT] [--max-regressions N] [--no-pr] [--jsonl]",
  "  audit --story-id ID [--project-root DIR] [--rundef ID]",
  "  iso   --story-id ID --spec-file PATH [--project-root DIR]",
  "  merge --story-id ID [--project-root DIR]",
  "  help | version",
]);

import type {
  CliCommand,
  CliHelpCommand,
  CliIsoCommand,
  CliParseError,
  CliParseErrorCode,
  CliRunCommand,
  CliVersionCommand,
} from "./cli-command.js";

const STORY_ID_OPTION = "--story-id";
const SPEC_FILE_OPTION = "--spec-file";
const PROJECT_ROOT_OPTION = "--project-root";
const RUNDEF_OPTION = "--rundef";
const MODEL_OPTION = "--model";
const THINKING_OPTION = "--thinking";
const MAX_REGRESSIONS_OPTION = "--max-regressions";
const NO_PR_FLAG = "--no-pr";
const JSONL_FLAG = "--jsonl";

type CliCommandKind = "run" | "audit" | "iso" | "merge";

interface CliCommandSpec {
  readonly positional: string | undefined;
  readonly values: readonly string[];
  readonly flags: readonly string[];
}

const commandSpecs: Readonly<Record<CliCommandKind, CliCommandSpec>> = Object.freeze({
  run: {
    positional: "rundef-id",
    values: [
      STORY_ID_OPTION,
      SPEC_FILE_OPTION,
      PROJECT_ROOT_OPTION,
      MODEL_OPTION,
      THINKING_OPTION,
      MAX_REGRESSIONS_OPTION,
    ],
    flags: [NO_PR_FLAG, JSONL_FLAG],
  },
  audit: {
    positional: undefined,
    values: [STORY_ID_OPTION, PROJECT_ROOT_OPTION, RUNDEF_OPTION],
    flags: [],
  },
  iso: {
    positional: undefined,
    values: [STORY_ID_OPTION, SPEC_FILE_OPTION, PROJECT_ROOT_OPTION],
    flags: [],
  },
  merge: { positional: undefined, values: [STORY_ID_OPTION, PROJECT_ROOT_OPTION], flags: [] },
});

const commandKindList: readonly string[] = Object.freeze(["run", "audit", "iso", "merge"]);

const isCliCommandKind = (value: string): value is CliCommandKind =>
  commandKindList.includes(value);

interface ScannedArgs {
  readonly kind: "args";
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

interface MutableScan {
  readonly positionals: string[];
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
}

const parseError = (code: CliParseErrorCode, message: string): CliParseError =>
  Object.freeze({ kind: "parse-error", code, message });

const missingValueError = (option: string): CliParseError =>
  parseError("missing-option-value", `Option "${option}" requires a value.`);

const missingOptionError = (option: string): CliParseError =>
  parseError("missing-required-option", `Missing required option "${option}".`);

interface ScanContext {
  readonly spec: CliCommandSpec;
  readonly scan: MutableScan;
}

const collectToken = (token: string, context: ScanContext): CliParseError | string | undefined => {
  if (!token.startsWith("--")) {
    context.scan.positionals.push(token);
    return undefined;
  }
  if (context.spec.flags.includes(token)) {
    context.scan.flags.add(token);
    return undefined;
  }
  return context.spec.values.includes(token)
    ? token
    : parseError("unknown-option", `Unknown option "${token}".`);
};

const isScanFailure = (value: CliParseError | string | undefined): value is CliParseError =>
  typeof value === "object";

const scanStep = (
  pending: string | undefined,
  token: string,
  context: ScanContext,
): CliParseError | string | undefined => {
  if (pending === undefined) {
    return collectToken(token, context);
  }
  if (token.startsWith("--")) {
    return missingValueError(pending);
  }
  context.scan.values.set(pending, token);
  return undefined;
};

const scanArgs = (tokens: readonly string[], spec: CliCommandSpec): ScannedArgs | CliParseError => {
  const context: ScanContext = {
    spec,
    scan: { positionals: [], values: new Map(), flags: new Set() },
  };
  let pending: string | undefined;
  for (const token of tokens) {
    const outcome = scanStep(pending, token, context);
    if (isScanFailure(outcome)) {
      return outcome;
    }
    pending = outcome;
  }
  return pending === undefined
    ? Object.freeze({ kind: "args", ...context.scan })
    : missingValueError(pending);
};

const unexpectedPositional = (
  scanned: ScannedArgs,
  spec: CliCommandSpec,
): CliParseError | undefined => {
  const allowed = spec.positional === undefined ? 0 : 1;
  const extra = scanned.positionals[allowed];
  return extra === undefined
    ? undefined
    : parseError("unexpected-positional", `Unexpected argument "${extra}".`);
};

const projectRootOf = (scanned: ScannedArgs): { readonly projectRoot?: string } => {
  const projectRoot = scanned.values.get(PROJECT_ROOT_OPTION);
  return projectRoot === undefined ? {} : { projectRoot };
};

const maxRegressionsPattern = /^\d+$/;

type RunOptionFields = Pick<CliRunCommand, "projectRoot" | "model" | "thinking" | "maxRegressions">;

const runOptionFields = (scanned: ScannedArgs): RunOptionFields => {
  const model = scanned.values.get(MODEL_OPTION);
  const thinking = scanned.values.get(THINKING_OPTION);
  const maxRegressions = scanned.values.get(MAX_REGRESSIONS_OPTION);
  return {
    ...projectRootOf(scanned),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(maxRegressions === undefined ? {} : { maxRegressions: Number(maxRegressions) }),
  };
};

type StorySpecFields = Pick<CliIsoCommand, "storyId" | "specFile">;

const requiredStorySpec = (scanned: ScannedArgs): StorySpecFields | CliParseError => {
  const storyId = scanned.values.get(STORY_ID_OPTION);
  if (storyId === undefined) {
    return missingOptionError(STORY_ID_OPTION);
  }
  const specFile = scanned.values.get(SPEC_FILE_OPTION);
  if (specFile === undefined) {
    return missingOptionError(SPEC_FILE_OPTION);
  }
  return { storyId, specFile };
};

const buildRunCommand = (scanned: ScannedArgs): CliCommand | CliParseError => {
  const required = requiredStorySpec(scanned);
  if ("kind" in required) {
    return required;
  }
  const rundefId = scanned.positionals[0];
  if (rundefId === undefined) {
    return parseError("missing-positional", 'Missing required "rundef-id" argument.');
  }
  const maxRegressions = scanned.values.get(MAX_REGRESSIONS_OPTION);
  if (maxRegressions !== undefined && !maxRegressionsPattern.test(maxRegressions)) {
    return parseError(
      "invalid-number",
      `Option "${MAX_REGRESSIONS_OPTION}" requires a non-negative integer.`,
    );
  }
  return Object.freeze({
    kind: "run",
    rundefId,
    ...required,
    ...runOptionFields(scanned),
    openPr: !scanned.flags.has(NO_PR_FLAG),
    jsonl: scanned.flags.has(JSONL_FLAG),
  });
};

const buildAuditCommand = (scanned: ScannedArgs): CliCommand | CliParseError => {
  const storyId = scanned.values.get(STORY_ID_OPTION);
  const rundefId = scanned.values.get(RUNDEF_OPTION);
  return storyId === undefined
    ? missingOptionError(STORY_ID_OPTION)
    : Object.freeze({
        kind: "audit",
        storyId,
        ...projectRootOf(scanned),
        ...(rundefId === undefined ? {} : { rundefId }),
      });
};

const buildIsoCommand = (scanned: ScannedArgs): CliCommand | CliParseError => {
  const required = requiredStorySpec(scanned);
  if ("kind" in required) {
    return required;
  }
  return Object.freeze({ kind: "iso", ...required, ...projectRootOf(scanned) });
};

const buildMergeCommand = (scanned: ScannedArgs): CliCommand | CliParseError => {
  const storyId = scanned.values.get(STORY_ID_OPTION);
  return storyId === undefined
    ? missingOptionError(STORY_ID_OPTION)
    : Object.freeze({ kind: "merge", storyId, ...projectRootOf(scanned) });
};

const commandBuilders: Readonly<
  Record<CliCommandKind, (scanned: ScannedArgs) => CliCommand | CliParseError>
> = Object.freeze({
  run: buildRunCommand,
  audit: buildAuditCommand,
  iso: buildIsoCommand,
  merge: buildMergeCommand,
});

const builtinCommandOf = (word: string): CliHelpCommand | CliVersionCommand | undefined => {
  if (word === "help" || word === "--help" || word === "-h") {
    return Object.freeze({ kind: "help" });
  }
  if (word === "version" || word === "--version") {
    return Object.freeze({ kind: "version" });
  }
  return undefined;
};

const parseCommandArgs = (
  kind: CliCommandKind,
  rest: readonly string[],
): CliCommand | CliParseError => {
  const scanned = scanArgs(rest, commandSpecs[kind]);
  if (scanned.kind === "parse-error") {
    return scanned;
  }
  return unexpectedPositional(scanned, commandSpecs[kind]) ?? commandBuilders[kind](scanned);
};

/**
 * Parses CLI argv (without the node and script entries) into a typed command.
 *
 * Pure and effect-free: every failure is returned as a {@link CliParseError}
 * with a stable code, never thrown.
 *
 * @param argv - Raw argument vector starting at the command word.
 *
 * @returns Frozen parsed command, or a frozen parse error.
 *
 * @example
 * ```ts
 * const parsed = parseCliArgs(["run", "sdlc", "--story-id", "S-1", "--spec-file", "s.md"]);
 * ```
 */
export function parseCliArgs(argv: readonly string[]): CliCommand | CliParseError {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return parseError("missing-command", "No command given.");
  }
  const builtin = builtinCommandOf(command);
  if (builtin !== undefined) {
    return builtin;
  }
  if (!isCliCommandKind(command)) {
    return parseError("unknown-command", `Unknown command "${command}".`);
  }
  return parseCommandArgs(command, rest);
}
