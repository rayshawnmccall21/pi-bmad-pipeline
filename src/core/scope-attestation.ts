/** Trusted repository-scope attestation adapter for the durable FSM. */

import { errorMessage } from "./runner-evaluation.js";
import { attachFinalScopeReceipt, attachReviewCheckpoint } from "./runner-transitions.js";

import type { CompiledStageDef } from "../rundef/index.js";
import type {
  FinalScopeReceipt,
  PipelineState,
  QualityGateReceipt,
  ReviewScopeCheckpoint,
} from "../state/index.js";

/** Request to attest repository scope immediately after review passes. */
export interface ReviewScopeAttestationRequest {
  /** Attestation phase. */
  readonly phase: "review";
  /** Exact project root. */
  readonly projectRoot: string;
  /** Supervised story id. */
  readonly storyId: string;
  /** Authenticated runner invocation id. */
  readonly runId: string;
  /** Selected RunDef id. */
  readonly runDefId: string;
  /** Selected RunDef digest. */
  readonly runDefDigest: string;
  /** Passed review attempt. */
  readonly qualityGate: QualityGateReceipt;
}

/** Request to attest final repository scope before terminal success. */
export interface FinalScopeAttestationRequest {
  /** Attestation phase. */
  readonly phase: "final";
  /** Exact project root. */
  readonly projectRoot: string;
  /** Supervised story id. */
  readonly storyId: string;
  /** Authenticated runner invocation id. */
  readonly runId: string;
  /** Selected RunDef id. */
  readonly runDefId: string;
  /** Selected RunDef digest. */
  readonly runDefDigest: string;
  /** Persisted review checkpoint, when the pipeline includes review. */
  readonly reviewCheckpoint?: ReviewScopeCheckpoint;
  /** Last passed stage used as the quality receipt for pipelines without review. */
  readonly qualityGate: QualityGateReceipt;
}

/** Trusted scope-attestation request. */
export type ScopeAttestationRequest = ReviewScopeAttestationRequest | FinalScopeAttestationRequest;

/** Trusted scope-attestation result. */
export type ScopeAttestationResult =
  | { readonly kind: "review-checkpoint"; readonly checkpoint: ReviewScopeCheckpoint }
  | { readonly kind: "final-receipt"; readonly receipt: FinalScopeReceipt }
  | { readonly kind: "review-invalidated"; readonly changedPaths: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string };

/** Injected trusted repository-scope attestation effect. */
export type ScopeAttestor = (request: ScopeAttestationRequest) => Promise<ScopeAttestationResult>;

/** Stable run identity passed to attestation helpers. */
interface ScopeAttestationIdentity {
  /** Exact project root. */
  readonly projectRoot: string;
  /** Supervised story id. */
  readonly storyId: string;
  /** Authenticated runner invocation id. */
  readonly runId: string;
}

/** Result of applying one trusted attestation. */
type AppliedScopeAttestation =
  | { readonly kind: "attested"; readonly state: PipelineState; readonly changed: boolean }
  | { readonly kind: "review-invalidated"; readonly changedPaths: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string };

/** Input for applying one passed review attestation. */
interface ApplyReviewScopeAttestationRequest {
  /** Trusted run identity. */
  readonly identity: ScopeAttestationIdentity;
  /** Current durable state. */
  readonly state: PipelineState;
  /** Passed review attempt. */
  readonly qualityGate: QualityGateReceipt;
  /** Injected attestation effect. */
  readonly attestScope: ScopeAttestor;
}

/**
 * Attests and attaches a passed review checkpoint.
 *
 * @param request - Trusted identity, durable state, review attempt, and effect.
 *
 * @returns Applied checkpoint state or a typed rejection.
 */
const attestReviewScope = async (
  request: ApplyReviewScopeAttestationRequest,
): Promise<AppliedScopeAttestation> => {
  const result = await invoke(request.attestScope, {
    phase: "review",
    ...request.identity,
    runDefId: request.state.runDefId,
    runDefDigest: request.state.runDefDigest,
    qualityGate: request.qualityGate,
  });
  if (
    result.kind !== "review-checkpoint" ||
    !matchesIdentity(result.checkpoint, request.identity, request.state)
  ) {
    return reject(
      result,
      "Review Git scope attestation returned an invalid run identity or result.",
    );
  }
  return {
    kind: "attested",
    state: attachReviewCheckpoint(request.state, result.checkpoint),
    changed: true,
  };
};

const applyFinalScopeResult = (
  result: ScopeAttestationResult,
  identity: ScopeAttestationIdentity,
  state: PipelineState,
): AppliedScopeAttestation => {
  if (result.kind === "review-invalidated") {
    return {
      kind: "review-invalidated",
      changedPaths: Object.freeze([...result.changedPaths]),
    };
  }
  if (result.kind !== "final-receipt" || !matchesIdentity(result.receipt, identity, state)) {
    return reject(
      result,
      "Final Git scope attestation returned an invalid run identity or result.",
    );
  }
  return {
    kind: "attested",
    state: attachFinalScopeReceipt(state, result.receipt),
    changed: true,
  };
};

/**
 * Re-attests current scope and attaches the resulting final receipt.
 *
 * @param identity - Trusted run identity.
 * @param state - Current durable state.
 * @param attestScope - Injected attestation effect.
 *
 * @returns Applied receipt state or a typed rejection.
 */
const attestFinalScope = async (
  identity: ScopeAttestationIdentity,
  state: PipelineState,
  attestScope: ScopeAttestor,
): Promise<AppliedScopeAttestation> => {
  const qualityGate = finalQualityGate(state);
  if (qualityGate === undefined) {
    return { kind: "rejected", reason: "Final scope attestation requires a passed stage." };
  }
  const durableIdentity = finalAttestationIdentity(identity, state.reviewCheckpoint);
  const result = await invoke(attestScope, {
    phase: "final",
    ...durableIdentity,
    runDefId: state.runDefId,
    runDefDigest: state.runDefDigest,
    ...(state.reviewCheckpoint === undefined ? {} : { reviewCheckpoint: state.reviewCheckpoint }),
    qualityGate,
  });
  return applyFinalScopeResult(result, durableIdentity, state);
};

/** Minimal mutable FSM context used while persisting scope transitions. */
interface RunnerScopeAttestationContext {
  /** Current durable state. */
  state: PipelineState;
  /** Trusted request identity and effects. */
  readonly request: {
    /** Exact project root. */
    readonly projectRoot: string;
    /** Supervised story id. */
    readonly storyId: string;
    /** Authenticated runner invocation id. */
    readonly runId: string;
    /** Compiled stages in execution order. */
    readonly stages: readonly CompiledStageDef[];
    /** Trusted attestation effect. */
    readonly attestScope: ScopeAttestor;
    /** Durable persistence effect. */
    readonly saveState: (state: PipelineState) => Promise<void>;
  };
}

/** Input describing a settled stage that may be a passed review. */
interface PassedReviewAttestationInput {
  /** Settled stage. */
  readonly stage: CompiledStageDef;
  /** One-based attempt number. */
  readonly attempt: number;
  /** Whether evaluation passed. */
  readonly passed: boolean;
  /** Durable finish timestamp. */
  readonly finishedAt: string;
}

/**
 * Attests and persists a passed code-review stage when applicable.
 *
 * @param context - Mutable FSM scope context.
 * @param input - Settled stage identity and result.
 *
 * @returns Rejection reason, or undefined after success or a non-review stage.
 */
export const persistPassedReviewAttestation = async (
  context: RunnerScopeAttestationContext,
  input: PassedReviewAttestationInput,
): Promise<string | undefined> => {
  if (!input.passed || !isCodeReviewStage(input.stage)) {
    return undefined;
  }
  const result = await attestReviewScope({
    identity: identityOf(context),
    state: context.state,
    qualityGate: {
      stageId: input.stage.id,
      attempt: input.attempt,
      status: "passed",
      finishedAt: input.finishedAt,
    },
    attestScope: context.request.attestScope,
  });
  if (result.kind !== "attested") {
    return result.kind === "rejected"
      ? result.reason
      : "Review scope attestation cannot invalidate before a checkpoint exists.";
  }
  await persist(context, result.state);
  return undefined;
};

/**
 * Attests and persists final scope before terminal success.
 *
 * @param context - Mutable FSM scope context.
 *
 * @returns Rejection reason, or undefined after a durable receipt exists.
 */
type FinalScopePersistenceResult =
  | { readonly kind: "attested" }
  | { readonly kind: "review-invalidated"; readonly changedPaths: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string };

export const persistFinalScopeAttestation = async (
  context: RunnerScopeAttestationContext,
): Promise<FinalScopePersistenceResult> => {
  if (passedReviewLacksCheckpoint(context)) {
    return {
      kind: "rejected",
      reason: "Passed code review is missing its durable repository-scope checkpoint.",
    };
  }
  const result = await attestFinalScope(
    identityOf(context),
    context.state,
    context.request.attestScope,
  );
  if (result.kind === "rejected") {
    return result;
  }
  if (result.kind === "review-invalidated") {
    return result;
  }
  if (result.changed) {
    await persist(context, result.state);
  }
  return { kind: "attested" };
};

/**
 * Returns the stage id used for a final attestation failure.
 *
 * @param context - Current FSM scope context.
 *
 * @returns Review stage id, last stage id, or a stable pipeline fallback.
 */
export const finalScopeFailureStageId = (context: RunnerScopeAttestationContext): string =>
  context.state.reviewCheckpoint?.qualityGate.stageId ??
  context.request.stages.at(-1)?.id ??
  "pipeline";

const persist = async (
  context: RunnerScopeAttestationContext,
  state: PipelineState,
): Promise<void> => {
  context.state = state;
  await context.request.saveState(state);
};

const finalQualityGate = (state: PipelineState): QualityGateReceipt | undefined => {
  if (state.reviewCheckpoint !== undefined) {
    return state.reviewCheckpoint.qualityGate;
  }
  const stage = Object.values(state.stages)
    .filter(({ status }) => status === "passed")
    .at(-1);
  return stage === undefined
    ? undefined
    : {
        stageId: stage.id,
        attempt: Math.max(1, stage.attempts),
        status: "passed",
        finishedAt: stage.finishedAt ?? state.startedAt ?? new Date(0).toISOString(),
      };
};

const identityOf = (context: RunnerScopeAttestationContext): ScopeAttestationIdentity => ({
  projectRoot: context.request.projectRoot,
  storyId: context.request.storyId,
  runId: context.request.runId,
});

const finalAttestationIdentity = (
  identity: ScopeAttestationIdentity,
  checkpoint: ReviewScopeCheckpoint | undefined,
): ScopeAttestationIdentity =>
  checkpoint === undefined ? identity : { ...identity, runId: checkpoint.runId };

const passedReviewLacksCheckpoint = (context: RunnerScopeAttestationContext): boolean =>
  context.state.reviewCheckpoint === undefined &&
  context.request.stages.some(
    (stage) => isCodeReviewStage(stage) && context.state.stages[stage.id]?.status === "passed",
  );

export const isCodeReviewStage = (stage: CompiledStageDef): boolean =>
  stage.kind === "agent" && stage.payloadGateName?.startsWith("code-review") === true;

const invoke = async (
  attestScope: ScopeAttestor,
  request: ScopeAttestationRequest,
): Promise<ScopeAttestationResult> => {
  try {
    return await attestScope(request);
  } catch (error) {
    return { kind: "rejected", reason: errorMessage(error) };
  }
};

const matchesIdentity = (
  attestation: ReviewScopeCheckpoint | FinalScopeReceipt,
  identity: ScopeAttestationIdentity,
  state: PipelineState,
): boolean =>
  attestation.storyId === identity.storyId &&
  attestation.runId === identity.runId &&
  attestation.runDefId === state.runDefId &&
  attestation.runDefDigest === state.runDefDigest;

const reject = (result: ScopeAttestationResult, fallback: string): AppliedScopeAttestation => ({
  kind: "rejected",
  reason: result.kind === "rejected" ? result.reason : fallback,
});
