/** Public state subsystem exports. */

export {
  RUNNER_FEATURE_VERSION,
  createEmptyRunEconomicsSummary,
  createInitialPipelineState,
  createInitialStageState,
  isTerminalPipelineStatus,
  isTerminalStageStatus,
  toRunResultStatus,
} from "./pipeline-state.js";

export type {
  CreateInitialPipelineStateRequest,
  PipelineState,
  PipelineStatus,
  RunEconomicsSummary,
  RunResult,
  RunResultStatus,
  StageAttemptState,
  StageAttemptStatus,
  StageState,
  StageStatus,
  StageUsage,
} from "./pipeline-state.js";

export {
  PIPELINE_STATE_FILE_EXTENSION,
  PIPELINE_STATE_RELATIVE_DIR,
  PIPELINE_STATE_STORY_ID_PATTERN,
  PipelineStateStoreError,
  fsPipelineStateStore,
  getPipelineStateDir,
  getPipelineStatePath,
  isPipelineStateStoryId,
  loadPipelineState,
  savePipelineState,
} from "./fs-state-store.js";

export type {
  LoadPipelineStateRequest,
  PipelineStateStore,
  PipelineStateStoreErrorCode,
  PipelineStateStoreErrorDetails,
  SavePipelineStateRequest,
} from "./fs-state-store.js";

export {
  CURRENT_RUN_POINTER_FILE_NAME,
  CURRENT_RUN_POINTER_RELATIVE_PATH,
  CurrentRunStoreError,
  getCurrentRunPointerPath,
  loadCurrentRunPointer,
  saveCurrentRunPointer,
} from "./current-run-store.js";

export type { CurrentRunPointer, CurrentRunStoreErrorCode } from "./current-run-store.js";

export {
  DEFAULT_DISPATCH_LOCK_STALE_MS,
  DISPATCH_LOCK_INFO_FILE_NAME,
  DISPATCH_LOCK_RELATIVE_DIR,
  acquireDispatchLock,
  getDispatchLockDir,
  getDispatchLocksDir,
  isDispatchLockStale,
  readDispatchLockInfo,
  releaseDispatchLock,
} from "./dispatch-lock.js";

export type {
  AcquireDispatchLockRequest,
  DispatchLock,
  DispatchLockInfo,
} from "./dispatch-lock.js";

export { getFirstIncompleteStageId, reconcilePipelineState } from "./state-reconcile.js";

export type {
  ReconcilePipelineStateRequest,
  StateReconciliationIssue,
  StateReconciliationIssueCode,
  StateReconciliationResult,
} from "./state-reconcile.js";
