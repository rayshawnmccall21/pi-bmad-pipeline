/** Public discovered RunDef type, registry, schema, loader, selector, and compile exports. */

export type {
  CompiledStageDef,
  PayloadGate,
  PayloadGateContext,
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
export { computeRunDefDigest } from "./identity.js";
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
export {
  RunDefSelectionError,
  resolveRunDefSelection,
  selectAndCompileRunDef,
  selectRunDef,
} from "./selector.js";
export type {
  CompiledDiscoveredRunDefSelection,
  CompiledRunDefSelection,
  DiscoveredRunDefSelection,
  RunDefSelection,
  RunDefSelectionErrorCode,
  RunDefSelectionErrorDetails,
  RunDefSelectionSource,
  SelectAndCompileRunDefOptions,
  SelectRunDefOptions,
} from "./selector.js";
