import type { ModelThinking } from "../../model/index.js";
import type { CompiledStageDef } from "../../rundef/index.js";

/** Default Pi executable name. */
export const DEFAULT_PI_BIN = "pi" as const;

/** Default BMAD headless command exposed by the pi-bmad extension. */
export const DEFAULT_BMAD_HEADLESS_COMMAND = "bmad:run-workflow" as const;

/** Minimal stage shape required to construct Pi stage argv. */
export type StageArgsStage = Pick<
  CompiledStageDef,
  "id" | "workflow" | "agent" | "timeoutSeconds" | "thinking"
>;

/** Request for building Pi CLI argv for one stage. */
export interface BuildStageArgsRequest {
  /** Stage to execute. */
  readonly stage: StageArgsStage;

  /** Story id passed to the workflow. */
  readonly storyId: string;

  /** Story/spec file path passed to the workflow. */
  readonly specFile: string;

  /** Project root passed to the workflow. */
  readonly projectRoot: string;

  /** Isolated worktree cwd used by the spawned process. */
  readonly worktreeCwd: string;

  /** One-based attempt number. */
  readonly attempt: number;

  /** Resolved model name. */
  readonly model: string;

  /** Resolved default thinking effort. Stage thinking overrides this when present. */
  readonly thinking: ModelThinking;

  /** Optional prior findings to feed into regression attempts. */
  readonly priorFindings?: readonly string[];

  /** Optional stage extension directory path. */
  readonly stageExtensionPath?: string;

  /** Optional Pi executable name/path. */
  readonly piBin?: string;

  /** Optional BMAD headless command name. */
  readonly command?: string;
}

/** Built Pi invocation. */
export interface BuiltStageArgs {
  /** Executable name/path. */
  readonly bin: string;

  /** CLI arguments passed to the executable. */
  readonly args: readonly string[];

  /** Effective thinking effort after stage override. */
  readonly thinking: ModelThinking;
}

/**
 * Builds the Pi CLI argv for one hermetic BMAD stage process.
 *
 * @param request - Stage argv build request.
 *
 * @returns Frozen executable, args, and effective thinking metadata.
 *
 * @throws RangeError When required string fields are blank or attempt is invalid.
 *
 * @example
 * ```ts
 * const invocation = buildStageArgs(request);
 * ```
 */
export function buildStageArgs(request: BuildStageArgsRequest): BuiltStageArgs {
  validateRequest(request);
  const thinking = request.stage.thinking ?? request.thinking;
  const args = [
    "--no-session",
    "--no-extensions",
    "--jsonl",
    request.command ?? DEFAULT_BMAD_HEADLESS_COMMAND,
    ...namedArgs(request, thinking),
    ...optionalArgs(request),
  ];
  return Object.freeze({
    bin: request.piBin ?? DEFAULT_PI_BIN,
    args: Object.freeze(args),
    thinking,
  });
}

const namedArgs = (request: BuildStageArgsRequest, thinking: ModelThinking): readonly string[] => [
  "--workflow",
  request.stage.workflow,
  "--agent",
  request.stage.agent,
  "--stage-id",
  request.stage.id,
  "--story-id",
  request.storyId,
  "--spec-file",
  request.specFile,
  "--project-root",
  request.projectRoot,
  "--worktree-cwd",
  request.worktreeCwd,
  "--attempt",
  String(request.attempt),
  "--model",
  request.model,
  "--thinking",
  thinking,
  "--timeout-seconds",
  String(request.stage.timeoutSeconds),
];

const optionalArgs = (request: BuildStageArgsRequest): readonly string[] => [
  ...(request.stageExtensionPath === undefined
    ? []
    : ["--stage-extension", request.stageExtensionPath]),
  ...(request.priorFindings === undefined
    ? []
    : ["--prior-findings-json", JSON.stringify([...request.priorFindings])]),
];

const validateRequest = (request: BuildStageArgsRequest): void => {
  validateRequiredStrings(request);
  validateOptionalStrings(request);
  validatePositiveInteger("attempt", request.attempt);
  validatePositiveInteger("stage.timeoutSeconds", request.stage.timeoutSeconds);
};

const validateRequiredStrings = (request: BuildStageArgsRequest): void => {
  const fields = [
    ["stage.id", request.stage.id],
    ["stage.workflow", request.stage.workflow],
    ["stage.agent", request.stage.agent],
    ["storyId", request.storyId],
    ["specFile", request.specFile],
    ["projectRoot", request.projectRoot],
    ["worktreeCwd", request.worktreeCwd],
    ["model", request.model],
  ] as const;
  for (const [field, value] of fields) {
    validateNonBlank(field, value);
  }
};

const validateOptionalStrings = (request: BuildStageArgsRequest): void => {
  const fields = [
    ["piBin", request.piBin],
    ["command", request.command],
    ["stageExtensionPath", request.stageExtensionPath],
  ] as const;
  for (const [field, value] of fields) {
    if (value !== undefined) {
      validateNonBlank(field, value);
    }
  }
};

const validateNonBlank = (field: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const validatePositiveInteger = (field: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer.`);
  }
};
