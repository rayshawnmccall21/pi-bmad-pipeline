/** Public Pi executor helper exports. */

export {
  DEFAULT_PI_BIN,
  PI_BMAD_EMISSION_KEY_ENV_VAR,
  PI_BMAD_RUN_ID_ENV_VAR,
  buildStageArgs,
} from "./build-stage-args.js";

export { HeadlessJsonlParser, parseHeadlessJsonl } from "./headless-jsonl-parser.js";

export { extractGatedHeadlessOutput, extractStageUsage } from "./headless-stream-output.js";

export {
  DEFAULT_PI_BMAD_EXTENSION_FALLBACK_PATH,
  PI_BMAD_EXTENSION_MODULE_SPECIFIER,
  PI_BMAD_EXTENSION_PATH_ENV_VAR,
  resolvePiBmadExtensionPath,
} from "./pi-bmad-extension.js";

export { PI_CLI_WORKFLOW_EXECUTOR_ID, PiCliWorkflowExecutor } from "./pi-cli-executor.js";

export {
  BmadStageSpawnError,
  MAX_STAGE_STDERR_CHARS,
  runBmadStage,
  toBuildStageArgsRequest,
} from "./run-bmad-stage.js";

export type {
  BuildStageArgsRequest,
  BuiltStageArgs,
  BuiltStageEnv,
  StageArgsStage,
} from "./build-stage-args.js";

export type {
  HeadlessJsonlParseIssue,
  HeadlessJsonlParserSnapshot,
  HeadlessJsonlRecord,
} from "./headless-jsonl-parser.js";

export type {
  GatedHeadlessOutputContext,
  GatedHeadlessOutputExtraction,
} from "./headless-stream-output.js";

export type { ResolvePiBmadExtensionPathOptions } from "./pi-bmad-extension.js";

export type { PiCliWorkflowExecutorOptions, RunBmadStageFunction } from "./pi-cli-executor.js";

export type { BmadStageSpawn, RunBmadStageRequest } from "./run-bmad-stage.js";
