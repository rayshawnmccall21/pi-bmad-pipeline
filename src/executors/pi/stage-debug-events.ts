/**
 * Structured debug events for the run-bmad-stage decision seams.
 *
 * Emits the `stage.spawn` and `stage.envelope-gate` events through the
 * pipeline debug-log seam (`BMAD_PIPELINE_DEBUG`). The spawn event carries the
 * child argv and cwd but intentionally excludes the emission env
 * (`PI_BMAD_EMISSION_KEY`): emission keys must never be logged.
 *
 * @packageDocumentation
 */

import { debugLog } from "../../events/index.js";
import { PI_BMAD_RUN_ID_ENV_VAR, type BuiltStageArgs } from "./build-stage-args.js";

import type { GatedHeadlessOutputExtraction } from "./headless-stream-output.js";
import type { RunBmadStageRequest } from "./run-bmad-stage.js";

/** Envelope-gate verdict context captured by the stage.envelope-gate event. */
export interface EnvelopeGateLogContext {
  /** Stage execution request whose terminal envelope was gated. */
  readonly request: RunBmadStageRequest;

  /** Fail-closed headless envelope extraction verdict. */
  readonly extraction: GatedHeadlessOutputExtraction;

  /** Child process exit code. */
  readonly exitCode: number | null;

  /** True when the stage was killed by its timeout. */
  readonly timedOut: boolean;

  /** True when the stage was aborted through the abort signal. */
  readonly aborted: boolean;
}

/**
 * Emits the stage.spawn debug event with argv context but never the emission key.
 *
 * @param request - Stage execution request being spawned.
 * @param invocation - Built Pi invocation (bin, args, emission env).
 * @param timeoutMs - Supervisor-owned stage timeout in milliseconds.
 *
 * @example
 * ```ts
 * logStageSpawn(request, invocation, timeoutMs);
 * ```
 */
export function logStageSpawn(
  request: RunBmadStageRequest,
  invocation: BuiltStageArgs,
  timeoutMs: number,
): void {
  debugLog("stage.spawn", {
    storyId: request.storyId,
    stageId: request.stage.id,
    workflow: request.stage.workflow,
    attempt: request.attempt,
    bin: invocation.bin,
    args: invocation.args,
    cwd: request.worktreeCwd,
    runId: invocation.env[PI_BMAD_RUN_ID_ENV_VAR],
    timeoutMs,
  });
}

/**
 * Emits the stage.envelope-gate debug event with the fail-closed gate verdict.
 *
 * @param context - Request, extraction verdict, and child termination context.
 *
 * @example
 * ```ts
 * logEnvelopeGate({ request, extraction, exitCode, timedOut: false, aborted: false });
 * ```
 */
export function logEnvelopeGate(context: EnvelopeGateLogContext): void {
  debugLog("stage.envelope-gate", {
    storyId: context.request.storyId,
    stageId: context.request.stage.id,
    attempt: context.request.attempt,
    accepted: context.extraction.output !== null,
    exitCode: context.exitCode,
    timedOut: context.timedOut,
    aborted: context.aborted,
    ...(context.extraction.failure === undefined ? {} : { reason: context.extraction.failure }),
  });
}
