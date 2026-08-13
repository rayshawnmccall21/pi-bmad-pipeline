/**
 * Defines pure command and parse-error contracts for the core CLI.
 *
 * @packageDocumentation
 */

/** Stable argv parse error codes. */
export type CliParseErrorCode =
  | "missing-command"
  | "unknown-command"
  | "unknown-option"
  | "missing-option-value"
  | "missing-required-option"
  | "missing-positional"
  | "unexpected-positional"
  | "invalid-number";

/** Structured argv parse failure returned as data. */
export interface CliParseError {
  /** Result discriminator. */
  readonly kind: "parse-error";
  /** Stable machine-readable error code. */
  readonly code: CliParseErrorCode;
  /** Human-readable failure message. */
  readonly message: string;
}

/** Parsed run command. */
export interface CliRunCommand {
  /** Command discriminator. */
  readonly kind: "run";
  /** RunDef identifier selected from YAML. */
  readonly rundefId: string;
  /** Story identifier being supervised; defaults to the rundef-id when --story-id is omitted. */
  readonly storyId: string;
  /** Story specification path; empty string when --spec-file is omitted. */
  readonly specFile: string;
  /** Optional project root. */
  readonly projectRoot?: string;
  /** Optional explicit model. */
  readonly model?: string;
  /** Optional explicit thinking effort. */
  readonly thinking?: string;
  /** Optional regression ceiling. */
  readonly maxRegressions?: number;
  /** Whether raw JSONL output was requested. */
  readonly jsonl: boolean;
}

/** Parsed help request. */
export interface CliHelpCommand {
  /** Command discriminator. */
  readonly kind: "help";
}

/** Parsed version request. */
export interface CliVersionCommand {
  /** Command discriminator. */
  readonly kind: "version";
}

/** Every supported CLI command. */
export type CliCommand = CliRunCommand | CliHelpCommand | CliVersionCommand;
