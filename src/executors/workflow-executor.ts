import type { CompiledStageDef } from "../rundef/index.js";

/** Usage reported by one stage execution. */
export interface StageExecutionUsage {
  /** Token usage reported for this execution. */
  readonly tokens: number;

  /** Dollar usage reported for this execution. */
  readonly dollars: number;
}

/** Validated child output placeholder. Contract provider will narrow this later. */
export type StageExecutionOutput = Record<string, unknown>;

/** Request passed to a WorkflowExecutor. */
export interface StageExecutionRequest {
  /** Compiled stage to execute. */
  readonly stage: CompiledStageDef;

  /** Story id being supervised. */
  readonly storyId: string;

  /** Story/spec file path provided to the run. */
  readonly specFile: string;

  /** Project root directory. */
  readonly projectRoot: string;

  /** Worktree current working directory for child execution. */
  readonly worktreeCwd: string;

  /** One-based stage attempt number. */
  readonly attempt: number;

  /** Optional findings from prior failed gates. */
  readonly priorFindings?: readonly string[];

  /** Abort signal controlled by the supervisor. */
  readonly signal: AbortSignal;
}

/** Result returned by a WorkflowExecutor. */
export interface StageExecutionResult {
  /** Validated child output, or null when no valid output was produced. */
  readonly output: StageExecutionOutput | null;

  /** Child process exit code, or null when no process exit code exists. */
  readonly exitCode: number | null;

  /** Stage duration in milliseconds. */
  readonly durationMs: number;

  /** Optional JSONL parse error. */
  readonly parseError?: string;

  /** Optional usage reported by the child execution. */
  readonly usage?: StageExecutionUsage;

  /** True when the stage timed out. */
  readonly timedOut?: boolean;

  /** True when the stage was aborted by the supervisor. */
  readonly aborted?: boolean;
}

/** Executor boundary used by the future pipeline FSM. */
export interface WorkflowExecutor {
  /** Stable executor identifier. */
  readonly id: string;

  /**
   * Executes one compiled stage.
   *
   * @param request - Stage execution request.
   *
   * @returns Stage execution result.
   */
  execute(request: StageExecutionRequest): Promise<StageExecutionResult>;
}
