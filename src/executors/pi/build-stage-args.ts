/**
 * Builds the real pi-bmad headless invocation for one pipeline stage.
 *
 * The emitted shape follows pi-bmad docs/CLI.md ("JSON Output for CI"): pi
 * runs with JSON mode, print, no session, no extension discovery, an explicit
 * pi-bmad extension file, the bmad workflow and story flags, and a trailing
 * prompt, while the PI_BMAD_RUN_ID / PI_BMAD_EMISSION_KEY environment
 * contract stamps and gates the headless output envelope. Pipeline-only
 * metadata (spec file, stage id, attempt, prior findings) is folded into the
 * prompt because pi exposes no flags for it; timeouts and the worktree cwd
 * stay supervisor-owned.
 *
 * @packageDocumentation
 */

import type { ModelThinking } from "../../model/index.js";
import type { CompiledStageDef } from "../../rundef/index.js";

/** Default Pi executable name. */
export const DEFAULT_PI_BIN = "pi" as const;

/** Environment variable carrying the run id stamped into headless output. */
export const PI_BMAD_RUN_ID_ENV_VAR = "PI_BMAD_RUN_ID" as const;

/** Environment variable carrying the emission key that gates headless output. */
export const PI_BMAD_EMISSION_KEY_ENV_VAR = "PI_BMAD_EMISSION_KEY" as const;

/** Minimal stage shape required to construct Pi stage argv. */
export type StageArgsStage = Pick<CompiledStageDef, "id" | "workflow" | "thinking">;

/** Request for building Pi CLI argv for one stage. */
export interface BuildStageArgsRequest {
  /** Stage to execute. */
  readonly stage: StageArgsStage;

  /** Story id passed to the workflow via --bmad-story. */
  readonly storyId: string;

  /** Story/spec file path referenced in the stage prompt. */
  readonly specFile: string;

  /** Project root supervised by the pipeline. */
  readonly projectRoot: string;

  /** Isolated worktree cwd used by the spawned process. */
  readonly worktreeCwd: string;

  /** One-based attempt number. */
  readonly attempt: number;

  /** Resolved model name. */
  readonly model: string;

  /** Resolved default thinking effort. Stage thinking overrides this when present. */
  readonly thinking: ModelThinking;

  /** Resolved pi-bmad extension file loaded via -e. */
  readonly piBmadExtensionPath: string;

  /** Emission key exported as PI_BMAD_EMISSION_KEY for envelope gating. */
  readonly emissionKey: string;

  /** Optional run id exported as PI_BMAD_RUN_ID. Defaults to story/stage/attempt. */
  readonly runId?: string;

  /** Optional prior findings folded into regression attempt prompts. */
  readonly priorFindings?: readonly string[];

  /** Optional additional stage extension file loaded via a second -e. */
  readonly stageExtensionPath?: string;

  /** Optional Pi executable name/path. */
  readonly piBin?: string;
}

/** Environment variables required by the headless emission contract. */
export type BuiltStageEnv = Readonly<
  Record<typeof PI_BMAD_RUN_ID_ENV_VAR | typeof PI_BMAD_EMISSION_KEY_ENV_VAR, string>
>;

/** Built Pi invocation. */
export interface BuiltStageArgs {
  /** Executable name/path. */
  readonly bin: string;

  /** CLI arguments passed to the executable. */
  readonly args: readonly string[];

  /** Effective thinking effort after stage override. */
  readonly thinking: ModelThinking;

  /** Headless emission environment contract for the child process. */
  readonly env: BuiltStageEnv;
}

/**
 * Builds the Pi CLI argv and emission env for one hermetic BMAD stage process.
 *
 * @param request - Stage argv build request.
 *
 * @returns Frozen executable, args, effective thinking, and emission env.
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
    ...headlessPrefixArgs(),
    ...extensionArgs(request),
    ...bmadArgs(request, thinking),
    buildStagePrompt(request),
  ];
  return Object.freeze({
    bin: request.piBin ?? DEFAULT_PI_BIN,
    args: Object.freeze(args),
    thinking,
    env: Object.freeze({
      [PI_BMAD_RUN_ID_ENV_VAR]: request.runId ?? defaultRunId(request),
      [PI_BMAD_EMISSION_KEY_ENV_VAR]: request.emissionKey,
    }),
  });
}

const headlessPrefixArgs = (): readonly string[] => [
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--no-extensions",
];

const extensionArgs = (request: BuildStageArgsRequest): readonly string[] => [
  "-e",
  request.piBmadExtensionPath,
  ...(request.stageExtensionPath === undefined ? [] : ["-e", request.stageExtensionPath]),
];

const bmadArgs = (request: BuildStageArgsRequest, thinking: ModelThinking): readonly string[] => [
  "--bmad-workflow",
  request.stage.workflow,
  "--bmad-story",
  request.storyId,
  "--model",
  request.model,
  "--thinking",
  thinking,
];

const buildStagePrompt = (request: BuildStageArgsRequest): string =>
  [
    `Run the ${request.stage.workflow} BMAD workflow for story ${request.storyId}.`,
    `Spec file: ${request.specFile}`,
    `Pipeline stage: ${request.stage.id} (attempt ${String(request.attempt)})`,
    ...priorFindingsLines(request.priorFindings),
  ].join("\n");

const priorFindingsLines = (priorFindings: readonly string[] | undefined): readonly string[] =>
  priorFindings === undefined || priorFindings.length === 0
    ? []
    : ["Prior findings to address:", ...priorFindings.map((finding) => `- ${finding}`)];

const defaultRunId = (request: BuildStageArgsRequest): string =>
  `${request.storyId}.${request.stage.id}.${String(request.attempt)}`;

const validateRequest = (request: BuildStageArgsRequest): void => {
  validateRequiredStrings(request);
  validateOptionalStrings(request);
  validatePositiveInteger("attempt", request.attempt);
};

const validateRequiredStrings = (request: BuildStageArgsRequest): void => {
  const fields = [
    ["stage.id", request.stage.id],
    ["stage.workflow", request.stage.workflow],
    ["storyId", request.storyId],
    ["specFile", request.specFile],
    ["projectRoot", request.projectRoot],
    ["worktreeCwd", request.worktreeCwd],
    ["model", request.model],
    ["piBmadExtensionPath", request.piBmadExtensionPath],
    ["emissionKey", request.emissionKey],
  ] as const;
  for (const [field, value] of fields) {
    validateNonBlank(field, value);
  }
};

const validateOptionalStrings = (request: BuildStageArgsRequest): void => {
  const fields = [
    ["piBin", request.piBin],
    ["runId", request.runId],
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
