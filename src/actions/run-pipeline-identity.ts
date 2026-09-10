/**
 * Identity validation and recovery state reconciliation helpers for locked pipeline execution.
 *
 * @packageDocumentation
 */

import {
  computeRunDefDigest,
  runDefsEqualExceptStageTimeouts,
  type CompiledStageDef,
  type RunDef,
} from "../rundef/index.js";
import { freezePipelineState } from "../state/fs-state-validation.js";
import type { PipelineState } from "../state/index.js";
import { TERMINAL_RECOVERY_REJECTED_CODE } from "../core/index.js";
import type { ResolvedModelConfig } from "../model/index.js";

import type { PipelineActionContext, RunPipelineActionRequest } from "./run-pipeline-action.js";

/** Input fields for starting state resolution. */
export interface StartingStateInput {
  /** Previously loaded state from disk, if present. */
  readonly loaded: PipelineState | undefined;
  /** Compiled stage definitions. */
  readonly stages: readonly CompiledStageDef[];
  /** Resolved model configuration. */
  readonly model: ResolvedModelConfig;
  /** Compiled RunDef ID. */
  readonly runDefId: string;
  /** Compiled RunDef content digest. */
  readonly runDefDigest: string;
  /** Validated RunDef. */
  readonly runDef: RunDef;
}

const recoveryRetryStatuses: ReadonlySet<PipelineState["status"]> = new Set([
  "pending",
  "running",
  "failed",
  "needs-attention",
]);

/**
 * Asserts that the loaded durable state matches the active run configuration.
 *
 * @param loaded - Persisted state loaded from disk.
 * @param request - Active run action request.
 * @param input - Starting state configuration inputs.
 *
 * @throws Error when identity or configuration differs.
 */
export const assertResumeIdentity = (
  loaded: PipelineState,
  request: RunPipelineActionRequest,
  input: StartingStateInput,
): void => {
  const configurationMatches = [
    loaded.storyId === request.storyId,
    loaded.runDefId === input.runDefId,
    loaded.specFile === request.specFile,
    loaded.model === input.model.model,
    loaded.thinking === input.model.thinking,
  ].every(Boolean);
  const runDefMatches =
    loaded.runDefDigest === input.runDefDigest ||
    isTimeoutOnlyRecoveryRetry(loaded, request, input.runDef);
  if (!configurationMatches || !runDefMatches) {
    throw Object.assign(
      new Error("Loaded state RunDef identity or run configuration does not match the active run."),
      { code: "state-identity-mismatch" },
    );
  }
};

/**
 * Asserts that a terminal recovery state is coherent and needs no reconciliation.
 *
 * @param context - Active action context.
 * @param input - Starting state inputs.
 * @param loaded - Pipeline state loaded from disk.
 *
 * @throws Error when the state requires reconciliation.
 */
export const assertRecoveryStateNeedsNoReconciliation = (
  context: PipelineActionContext,
  input: StartingStateInput,
  loaded: PipelineState,
): void => {
  const reconciled =
    loaded.status === "done"
      ? context.deps.reconcileState({
          state: loaded,
          stages: input.stages,
          now: context.now,
        })
      : undefined;
  if (reconciled?.changed === true) {
    throw Object.assign(
      new Error("Terminal recovery requires a coherent done state that needs no reconciliation."),
      { code: TERMINAL_RECOVERY_REJECTED_CODE },
    );
  }
};

const isTimeoutOnlyRecoveryRetry = (
  loaded: PipelineState,
  request: RunPipelineActionRequest,
  activeRunDef: RunDef,
): boolean => {
  const recovery = request.terminalRecovery;
  const persistedRunDef = loaded.runDefIdentity;
  if (recovery === undefined || persistedRunDef === undefined) {
    return false;
  }
  const tail = loaded.supersededFinalScopeReceipts?.at(-1);
  return [
    tail?.expectedReceiptRunId === recovery.expectedReceiptRunId,
    tail?.reason === recovery.reason,
    recoveryRetryStatuses.has(loaded.status),
    loaded.reviewCheckpoint === undefined,
    loaded.finalScopeReceipt === undefined,
    runDefsEqualExceptStageTimeouts(persistedRunDef, activeRunDef),
  ].every(Boolean);
};

/**
 * Attaches the active RunDef identity to a loaded state and backfills legacy archives.
 *
 * @param loaded - Loaded pipeline state.
 * @param input - Starting state input carrying the active RunDef and digest.
 *
 * @returns Frozen updated state with active and backfilled RunDef identities.
 */
export const withActiveRunDefIdentity = (
  loaded: PipelineState,
  input: StartingStateInput,
): PipelineState => {
  const records = backfillArchivedRunDefIdentities(loaded);
  return freezePipelineState({
    ...loaded,
    runDefDigest: input.runDefDigest,
    runDefIdentity: structuredClone(input.runDef),
    ...(records === undefined ? {} : { supersededFinalScopeReceipts: records }),
  });
};

const backfillArchivedRunDefIdentities = (
  state: PipelineState,
): PipelineState["supersededFinalScopeReceipts"] => {
  const identity = state.runDefIdentity;
  if (identity === undefined) {
    return state.supersededFinalScopeReceipts;
  }
  const digest = computeRunDefDigest(identity);
  return state.supersededFinalScopeReceipts?.map((record) =>
    record.runDefIdentity === undefined && record.finalScopeReceipt.runDefDigest === digest
      ? { ...record, runDefIdentity: structuredClone(identity) }
      : record,
  );
};
