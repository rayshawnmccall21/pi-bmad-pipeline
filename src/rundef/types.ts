/**
 * Defines the pure type contracts for the RunDef pipeline definition subsystem.
 *
 * These types describe the serializable pipeline configuration (RunDef) and the
 * compiled runtime stage (StageDef), along with the payload gate contracts used
 * for routing decisions after child-process execution.
 *
 * @packageDocumentation
 */

/** Identifies the stage execution kind supported by the initial RunDef model. */
export type StageKind = "agent";

/** Controls the model thinking effort for stages that override the run default. */
export type StageThinking = "low" | "medium" | "high";

/** Defines optional per-stage economic ceilings enforced during execution. */
export interface StageBudget {
  /** Maximum token spend permitted for the stage before the budget gate halts. */
  readonly maxTokens?: number;

  /** Maximum dollar spend permitted for the stage before the budget gate halts. */
  readonly maxDollars?: number;
}

/** Represents one raw stage entry loaded from a RunDef YAML file or built-in definition. */
export interface RunDefStage {
  /** Stable stage identifier used for sequencing, state keys, and fail routing. */
  readonly id: string;

  /** Stage execution kind, always "agent" in the initial model. */
  readonly kind: StageKind;

  /** Pi-bmad workflow name to invoke inside the child process. */
  readonly workflow: string;

  /** Pi-bmad agent identifier to invoke for the workflow. */
  readonly agent: string;

  /** Optional payload gate name to resolve after the child process returns. */
  readonly gate?: string;

  /** Optional target stage identifier to regress to when the payload gate fails. */
  readonly onFail?: string;

  /** Optional stage timeout in seconds; zero or absent means unbounded. */
  readonly timeout?: number;

  /** Optional stage-level thinking effort override. */
  readonly thinking?: StageThinking;

  /** Optional per-stage economic ceiling override. */
  readonly budget?: StageBudget;
}

/** Represents a raw pipeline definition before validation and compilation. */
export interface RunDef {
  /** Stable pipeline identifier, for example "sdlc". */
  readonly id: string;

  /** Ordered stage list defining the pipeline execution sequence. */
  readonly stages: readonly RunDefStage[];
}

/** Represents the normalized compiled stage consumed by the pipeline FSM. */
export interface StageDef {
  /** Stable stage identifier used for state keys and routing decisions. */
  readonly id: string;

  /** Stage execution kind, always "agent" in the initial model. */
  readonly kind: StageKind;

  /** Pi-bmad workflow name to invoke inside the child process. */
  readonly workflow: string;

  /** Pi-bmad agent identifier to invoke for the workflow. */
  readonly agent: string;

  /** Zero-based stage position after compilation into the ordered stage table. */
  readonly index: number;

  /** Effective stage timeout in seconds after applying compilation defaults. */
  readonly timeoutSeconds: number;

  /** Optional payload gate name retained for audit and event output. */
  readonly payloadGateName?: string;

  /** Optional payload gate function resolved from the registry at compile time. */
  readonly payloadGate?: PayloadGate;

  /** Optional target stage identifier to regress to when the payload gate fails. */
  readonly onFail?: string;

  /** Optional stage-level thinking effort override. */
  readonly thinking?: StageThinking;

  /** Optional per-stage economic ceiling override. */
  readonly budget?: StageBudget;
}

/** Reports the outcome of evaluating a child-process payload against a gate. */
export interface PayloadGateResult {
  /** True when the payload satisfies the gate, false when it fails. */
  readonly passed: boolean;

  /** Optional human-readable reason for audit logging and event emission. */
  readonly reason?: string;

  /** Optional findings to carry into a regression attempt when the gate fails. */
  readonly findings?: readonly string[];
}

/** Evaluates a validated headless workflow output payload and returns a gate result. */
export type PayloadGate = (payload: Record<string, unknown>) => PayloadGateResult;

/** Resolves payload gate functions by their configured name from a RunDef stage. */
export interface PayloadGateRegistry {
  /**
   * Resolves a payload gate by name.
   *
   * @param name - Configured payload gate name from a RunDef stage.
   *
   * @returns The registered gate function, or undefined when no gate is registered.
   */
  resolve(name: string): PayloadGate | undefined;
}
