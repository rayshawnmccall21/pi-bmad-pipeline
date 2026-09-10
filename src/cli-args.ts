/**
 * Parses arguments for the run/help/version CLI.
 *
 * @packageDocumentation
 */

import {
  EXPECTED_RECEIPT_RUN_ID_MAX_CHARS,
  TERMINAL_RECOVERY_KIND,
  TERMINAL_RECOVERY_REASON_MAX_BYTES,
  type TerminalRecoveryRequest,
} from "./core/index.js";
import type { CliCommand, CliParseError, CliParseErrorCode, CliRunCommand } from "./cli-command.js";

/** Usage text written one line at a time by the CLI shell. */
export const CLI_USAGE_LINES: readonly string[] = Object.freeze([
  "Usage: bmad-pipeline [command] [options]",
  "Commands:",
  "  run <rundef-id> [--story-id ID] [--spec-file PATH] [--project-root DIR]",
  "      [--model NAME] [--thinking EFFORT] [--max-regressions N] [--jsonl]",
  "      [--terminal-recovery-kind KIND] [--expected-receipt-run-id RUN_ID]",
  "      [--recovery-reason REASON]",
  "  help | version",
]);

const valueOptions = new Set([
  "--story-id",
  "--spec-file",
  "--project-root",
  "--model",
  "--thinking",
  "--max-regressions",
  "--terminal-recovery-kind",
  "--expected-receipt-run-id",
  "--recovery-reason",
]);
const flagOptions = new Set(["--jsonl"]);
const helpWords = new Set(["help", "--help", "-h"]);
const versionWords = new Set(["version", "--version"]);
const optionTokenWidth = 2;

const parseError = (code: CliParseErrorCode, message: string): CliParseError =>
  Object.freeze({ kind: "parse-error", code, message });

interface ScannedRunArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

interface MutableRunArgs {
  readonly positionals: string[];
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
}

const isOptionValue = (optionValue: string | undefined): optionValue is string =>
  optionValue !== undefined && !optionValue.startsWith("--");

const collectRunToken = (
  token: string,
  optionValue: string | undefined,
  scanned: MutableRunArgs,
): number | CliParseError => {
  if (!token.startsWith("--")) {
    scanned.positionals.push(token);
    return 1;
  }
  if (flagOptions.has(token)) {
    scanned.flags.add(token);
    return 1;
  }
  if (!valueOptions.has(token)) {
    return parseError("unknown-option", `Unknown option "${token}".`);
  }
  if (!isOptionValue(optionValue)) {
    return parseError("missing-option-value", `Option "${token}" requires a value.`);
  }
  scanned.values.set(token, optionValue);
  return optionTokenWidth;
};

const scanRunArgs = (tokens: readonly string[]): ScannedRunArgs | CliParseError => {
  const scanned: MutableRunArgs = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < tokens.length;) {
    const outcome = collectRunToken(tokens[index] ?? "", tokens[index + 1], scanned);
    if (typeof outcome !== "number") {
      return outcome;
    }
    index += outcome;
  }
  return Object.freeze(scanned);
};

interface RequiredRunFields {
  readonly rundefId: string;
  readonly storyId: string;
  readonly specFile: string;
}
const positionalFields = (
  scanned: ScannedRunArgs,
): { readonly rundefId: string } | CliParseError => {
  const extra = scanned.positionals[1];
  if (extra !== undefined) {
    return parseError("unexpected-positional", `Unexpected argument "${extra}".`);
  }
  const rundefId = scanned.positionals[0];
  return rundefId === undefined
    ? parseError("missing-positional", 'Missing required "rundef-id" argument.')
    : { rundefId };
};

const runOptionFields = (
  scanned: ScannedRunArgs,
  rundefId: string,
): Omit<RequiredRunFields, "rundefId"> => ({
  storyId: scanned.values.get("--story-id") ?? rundefId,
  specFile: scanned.values.get("--spec-file") ?? "",
});

const requiredRunFields = (scanned: ScannedRunArgs): RequiredRunFields | CliParseError => {
  const positional = positionalFields(scanned);
  return "kind" in positional
    ? positional
    : { ...positional, ...runOptionFields(scanned, positional.rundefId) };
};

const regressionError = (scanned: ScannedRunArgs): CliParseError | undefined => {
  const regressions = scanned.values.get("--max-regressions");
  return regressions !== undefined && !/^\d+$/u.test(regressions)
    ? parseError("invalid-number", 'Option "--max-regressions" requires a non-negative integer.')
    : undefined;
};

const isBoundedRecoveryReason = (reason: string | undefined): boolean =>
  reason !== undefined &&
  reason.trim().length > 0 &&
  Buffer.byteLength(reason, "utf8") <= TERMINAL_RECOVERY_REASON_MAX_BYTES;

const isBoundedExpectedReceiptRunId = (expectedReceiptRunId: string | undefined): boolean =>
  expectedReceiptRunId !== undefined &&
  expectedReceiptRunId.trim().length > 0 &&
  Array.from(expectedReceiptRunId).length <= EXPECTED_RECEIPT_RUN_ID_MAX_CHARS;

const terminalRecoveryValueError = (
  kind: string | undefined,
  expectedReceiptRunId: string | undefined,
  reason: string | undefined,
): CliParseError | undefined => {
  if (kind !== TERMINAL_RECOVERY_KIND) {
    return parseError(
      "invalid-option-value",
      `Option "--terminal-recovery-kind" must be "${TERMINAL_RECOVERY_KIND}".`,
    );
  }
  if (!isBoundedExpectedReceiptRunId(expectedReceiptRunId)) {
    return parseError(
      "invalid-option-value",
      `Option "--expected-receipt-run-id" must be a nonblank receipt run id no larger than ${String(EXPECTED_RECEIPT_RUN_ID_MAX_CHARS)} characters.`,
    );
  }
  if (!isBoundedRecoveryReason(reason)) {
    return parseError(
      "invalid-option-value",
      `Option "--recovery-reason" must be a nonblank reason no larger than ${String(TERMINAL_RECOVERY_REASON_MAX_BYTES)} UTF-8 bytes.`,
    );
  }
  return undefined;
};

const terminalRecoveryRequestOrError = (
  kind: string,
  expectedReceiptRunId: string,
  reason: string,
): { readonly terminalRecovery?: TerminalRecoveryRequest } | CliParseError => {
  const valueError = terminalRecoveryValueError(kind, expectedReceiptRunId, reason);
  if (valueError !== undefined) {
    return valueError;
  }
  return {
    terminalRecovery: Object.freeze({
      kind: TERMINAL_RECOVERY_KIND,
      expectedReceiptRunId,
      reason,
    }),
  };
};

const allUndefined = (values: readonly (string | undefined)[]): boolean =>
  values.every((value) => value === undefined);

const terminalRecoveryFields = (
  scanned: ScannedRunArgs,
): { readonly terminalRecovery?: TerminalRecoveryRequest } | CliParseError => {
  const kind = scanned.values.get("--terminal-recovery-kind");
  const expectedReceiptRunId = scanned.values.get("--expected-receipt-run-id");
  const reason = scanned.values.get("--recovery-reason");
  if (kind !== undefined && expectedReceiptRunId !== undefined && reason !== undefined) {
    return terminalRecoveryRequestOrError(kind, expectedReceiptRunId, reason);
  }
  return allUndefined([kind, expectedReceiptRunId, reason])
    ? {}
    : parseError(
        "missing-required-option",
        "Options --terminal-recovery-kind, --expected-receipt-run-id, and --recovery-reason must be provided together.",
      );
};

const optionalFields = (scanned: ScannedRunArgs): Partial<CliRunCommand> => {
  const projectRoot = scanned.values.get("--project-root");
  const model = scanned.values.get("--model");
  const thinking = scanned.values.get("--thinking");
  const regressions = scanned.values.get("--max-regressions");
  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(regressions === undefined ? {} : { maxRegressions: Number(regressions) }),
  };
};

const buildRunCommand = (
  scanned: ScannedRunArgs,
  required: RequiredRunFields,
  terminalRecovery: TerminalRecoveryRequest | undefined,
): CliRunCommand =>
  Object.freeze({
    kind: "run",
    ...required,
    ...optionalFields(scanned),
    ...(terminalRecovery === undefined ? {} : { terminalRecovery }),
    jsonl: scanned.flags.has("--jsonl"),
  });

const runOptionOutcome = (
  scanned: ScannedRunArgs,
  required: RequiredRunFields,
): CliCommand | CliParseError => {
  const regression = regressionError(scanned);
  if (regression !== undefined) {
    return regression;
  }
  const recovery = terminalRecoveryFields(scanned);
  if ("kind" in recovery) {
    return recovery;
  }
  return buildRunCommand(scanned, required, recovery.terminalRecovery);
};

const buildRun = (tokens: readonly string[]): CliCommand | CliParseError => {
  const scanned = scanRunArgs(tokens);
  if ("kind" in scanned) {
    return scanned;
  }
  const required = requiredRunFields(scanned);
  if ("kind" in required) {
    return required;
  }
  return runOptionOutcome(scanned, required);
};

/**
 * Parses argv without node/script entries into a command or typed error.
 *
 * @param argv - Raw command arguments.
 *
 * @returns A frozen command or typed parse error.
 *
 * @example
 * ```ts
 * parseCliArgs(["help"]);
 * ```
 */
export function parseCliArgs(argv: readonly string[]): CliCommand | CliParseError {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return parseError("missing-command", "No command given.");
  }
  if (helpWords.has(command)) {
    return Object.freeze({ kind: "help" });
  }
  if (versionWords.has(command)) {
    return Object.freeze({ kind: "version" });
  }
  return command === "run"
    ? buildRun(rest)
    : parseError("unknown-command", `Unknown command "${command}".`);
}
