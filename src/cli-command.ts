/**
 * Command and parse-error shapes for the bmad-pipeline CLI.
 *
 * Pure type contract shared by the argv parser and the command executors —
 * no runtime code lives here.
 *
 * @packageDocumentation
 */

/** Stable machine-readable argv parse error codes. */
export type CliParseErrorCode =
  | "missing-command"
  | "unknown-command"
  | "unknown-option"
  | "missing-option-value"
  | "missing-required-option"
  | "missing-positional"
  | "unexpected-positional"
  | "invalid-number";

/** Structured argv parse failure returned as data, never thrown. */
export interface CliParseError {
  /** Result discriminator. */
  readonly kind: "parse-error";

  /** Stable machine-readable parse error code. */
  readonly code: CliParseErrorCode;

  /** Human-readable parse failure message. */
  readonly message: string;
}

/** Parsed run command. */
export interface CliRunCommand {
  /** Command discriminator. */
  readonly kind: "run";

  /** RunDef id to select and compile. */
  readonly rundefId: string;

  /** Story id being supervised. */
  readonly storyId: string;

  /** Story or spec file path provided to the run. */
  readonly specFile: string;

  /** Optional explicit project root; defaults to the working directory. */
  readonly projectRoot?: string;

  /** Optional explicit model name. */
  readonly model?: string;

  /** Optional explicit thinking effort. */
  readonly thinking?: string;

  /** Optional regression ceiling. */
  readonly maxRegressions?: number;

  /** Explicit PR policy: false when the no-pr flag was given. */
  readonly openPr: boolean;

  /** True when raw JSONL event lines were requested. */
  readonly jsonl: boolean;
}

/** Parsed audit command. */
export interface CliAuditCommand {
  /** Command discriminator. */
  readonly kind: "audit";

  /** Story id whose durable run is audited. */
  readonly storyId: string;

  /** Optional explicit project root; defaults to the working directory. */
  readonly projectRoot?: string;

  /** Optional rundef id used to resolve stage definitions; defaults to sdlc. */
  readonly rundefId?: string;
}

/** Parsed iso (worktree isolation) command. */
export interface CliIsoCommand {
  /** Command discriminator. */
  readonly kind: "iso";

  /** Story id whose worktree is ensured. */
  readonly storyId: string;

  /** Story or spec file path recorded with the worktree output. */
  readonly specFile: string;

  /** Optional explicit project root; defaults to the working directory. */
  readonly projectRoot?: string;
}

/** Parsed merge command. */
export interface CliMergeCommand {
  /** Command discriminator. */
  readonly kind: "merge";

  /** Story id whose merge eligibility is evaluated. */
  readonly storyId: string;

  /** Optional explicit project root; defaults to the working directory. */
  readonly projectRoot?: string;
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

/** Discriminated union of all parsed CLI commands. */
export type CliCommand =
  | CliRunCommand
  | CliAuditCommand
  | CliIsoCommand
  | CliMergeCommand
  | CliHelpCommand
  | CliVersionCommand;
