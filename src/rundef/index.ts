/** Public RunDef type, registry, schema, and compile exports. */

export type {
  CompiledStageDef,
  PayloadGate,
  PayloadGateRegistry,
  PayloadGateResult,
  RunDef,
  RunDefStage,
  StageBudget,
  StageDef,
  StageKind,
  StageThinking,
} from "./types.js";

export {
  clearPayloadGateRegistry,
  listPayloadGateNames,
  payloadGateRegistry,
  registerPayloadGate,
  resolvePayloadGate,
} from "./registry.js";

export {
  RUNDEF_IDENTIFIER_PATTERN,
  RunDefSchema,
  RunDefStageSchema,
  RunDefValidationError,
  StageBudgetSchema,
  assertRunDef,
  isRunDef,
  parseRunDef,
  validateRunDef,
} from "./schema.js";

export type {
  RunDefSchemaValue,
  RunDefStageSchemaValue,
  RunDefValidationIssue,
  RunDefValidationResult,
  StageBudgetSchemaValue,
} from "./schema.js";

export {
  DEFAULT_STAGE_TIMEOUT_SECONDS,
  RunDefCompileError,
  compileRunDef,
  compileValidatedRunDef,
} from "./compile.js";

export type {
  CompileRunDefOptions,
  RunDefCompileErrorCode,
  RunDefCompileErrorDetails,
} from "./compile.js";

export {
  BUILTIN_RUNDEF_IDS,
  SDLC_RUNDEF,
  SDLC_RUNDEF_ID,
  isBuiltinRunDefId,
  listBuiltinRunDefIds,
  resolveBuiltinRunDef,
  resolveRunDef,
} from "./builtin.js";

export type { BuiltinRunDefId } from "./builtin.js";

export {
  RUNDEF_PIPELINE_EXTENSION,
  RUNDEF_PIPELINES_RELATIVE_DIR,
  RunDefLoadError,
  discoverRunDefs,
  getRunDefPipelinesDir,
  isRunDefYamlFileName,
  loadRunDefFile,
  resolveDiscoveredRunDef,
} from "./loader.js";

export type { DiscoveredRunDef, RunDefLoadErrorCode, RunDefLoadErrorDetails } from "./loader.js";
