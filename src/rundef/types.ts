/**
 * Defines the pure type contracts for the RunDef pipeline definition subsystem.
 *
 * These types describe the serializable pipeline configuration (RunDef) and the
 * compiled runtime stage (StageDef), along with the payload gate contracts used
 * for routing decisions after child-process execution.
 *
 * @packageDocumentation
 */

/** Identifies the stage execution kind supported by the RunDef model. */
export type StageKind = "agent" | "code";

/** Controls the model thinking effort for stages that override the run default. */
export type StageThinking = "low" | "medium" | "high";

/** Defines optional per-stage economic ceilings enforced during execution. */
export interface StageBudget {
  /** Maximum token spend permitted for the stage before the budget gate halts. */
  readonly maxTokens?: number;

  /** Maximum dollar spend permitted for the stage before the budget gate halts. */
  readonly maxDollars?: number;
}

/** Represents one raw agent stage entry loaded from a discovered RunDef YAML file. */
export interface AgentRunDefStage {
  /** Stable stage identifier used for sequencing, state keys, and fail routing. */
  readonly id: string;

  /** Optional human-readable stage description. */
  readonly description?: string;

  /** Agent stage discriminator. */
  readonly kind: "agent";

  /** Pi-bmad workflow name to invoke inside the child process. */
  readonly workflow: string;

  /** Pi-bmad agent identifier to invoke for the workflow. */
  readonly agent: string;

  /** Optional payload gate name to resolve after the child process returns. */
  readonly gate?: string;

  /** Optional target stage identifier to regress to when the payload gate fails. */
  readonly onFail?: string;

  /** Optional stage timeout in seconds. */
  readonly timeout?: number;

  /** Optional stage-level thinking effort override. */
  readonly thinking?: StageThinking;

  /** Optional per-stage economic ceiling override. */
  readonly budget?: StageBudget;

  /** Optional extra Pi extension file paths loaded via repeated -e flags. */
  readonly extensions?: readonly string[];

  /** Optional observability pool name passed via --o-pool. */
  readonly oPool?: string;

  /** Optional observability session name passed via --o-name. */
  readonly oName?: string;

  /** Optional observability tag passed via --o-tag. */
  readonly oTag?: string;
}

/** Represents one raw code stage entry loaded from a discovered RunDef YAML file. */
export interface CodeRunDefStage {
  /** Stable stage identifier used for sequencing and state keys. */
  readonly id: string;

  /** Optional human-readable stage description. */
  readonly description?: string;

  /** Code stage discriminator. */
  readonly kind: "code";

  /** Local command to execute. */
  readonly command: string;

  /** Optional command arguments. */
  readonly args?: readonly string[];

  /** Optional stage timeout in seconds. */
  readonly timeout?: number;

  /** Optional regression target; the exit code is the gate (v1.1). */
  readonly onFail?: string;

  /** Optional projectRoot-relative findings file lifted on exit 1 (v1.1). */
  readonly findingsFile?: string;
}

/** Represents one raw stage entry loaded from a discovered RunDef YAML file. */
export type RunDefStage = AgentRunDefStage | CodeRunDefStage;

/** Represents a raw pipeline definition before validation and compilation. */
export interface RunDef {
  /** Stable pipeline identifier, for example "sdlc". */
  readonly id: string;

  /** Optional human-readable pipeline description. */
  readonly description?: string;

  /** Ordered stage list defining the pipeline execution sequence. */
  readonly stages: readonly RunDefStage[];
}

/** Fields shared by every normalized compiled stage. */
interface CompiledStageCommon {
  /** Stable stage identifier used for state keys and routing decisions. */
  readonly id: string;

  /** Zero-based stage position in the ordered stage table. */
  readonly index: number;

  /** Effective stage timeout in seconds after applying compilation defaults. */
  readonly timeoutSeconds: number;

  /** Optional human-readable stage description. */
  readonly description?: string;
}

/** Normalized compiled agent stage consumed by the Pi executor. */
export interface CompiledAgentStage extends CompiledStageCommon {
  /** Agent stage discriminator. */
  readonly kind: "agent";

  /** Pi-bmad workflow name to invoke. */
  readonly workflow: string;

  /** Pi-bmad agent identifier to invoke. */
  readonly agent: string;

  /** Optional payload gate name retained for state and event output. */
  readonly payloadGateName?: string;

  /** Optional payload gate function resolved at compile time. */
  readonly payloadGate?: PayloadGate;

  /** Optional target stage identifier for failed payload gates. */
  readonly onFail?: string;

  /** Optional stage-level thinking effort override. */
  readonly thinking?: StageThinking;

  /** Optional per-stage economic ceiling override. */
  readonly budget?: StageBudget;

  /** Optional extra Pi extension file paths. */
  readonly extensions?: readonly string[];

  /** Optional observability pool name. */
  readonly oPool?: string;

  /** Optional observability session name. */
  readonly oName?: string;

  /** Optional observability tag. */
  readonly oTag?: string;
}

/** Normalized compiled code stage consumed by the local executor. */
export interface CompiledCodeStage extends CompiledStageCommon {
  /** Code stage discriminator. */
  readonly kind: "code";

  /** Local command to execute. */
  readonly command: string;

  /** Command arguments, normalized to an array. */
  readonly args: readonly string[];

  /** Optional regression target; the exit code is the gate (v1.1). */
  readonly onFail?: string;

  /** Optional projectRoot-relative findings file lifted on exit 1 (v1.1). */
  readonly findingsFile?: string;
}

/** Closed normalized stage union consumed by the pipeline FSM. */
export type CompiledStageDef = CompiledAgentStage | CompiledCodeStage;

/** Legacy alias for CompiledStageDef. */
export type StageDef = CompiledStageDef;

/** Legacy alias for AgentRunDefStage. */
export type AgentStageDef = AgentRunDefStage;

/** Reports the outcome of evaluating a child-process payload against a gate. */
export interface PayloadGateResult {
  /** True when the payload satisfies the gate, false when it fails. */
  readonly passed: boolean;

  /** Optional human-readable reason for state and event emission. */
  readonly reason?: string;

  /** Optional findings to carry into a regression attempt when the gate fails. */
  readonly findings?: readonly string[];
}

/** Active run identity supplied to payload gates. */
export interface PayloadGateContext {
  /** Story id being supervised by the active run. */
  readonly storyId: string;
}

/** Evaluates a validated headless workflow output payload and returns a gate result. */
export type PayloadGate = (
  payload: Record<string, unknown>,
  context?: PayloadGateContext,
) => PayloadGateResult;

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
