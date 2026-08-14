import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "./workflow-executor.js";

/** Stable executor id for the closed agent/code dispatcher. */
export const STAGE_EXECUTOR_DISPATCHER_ID = "stage-executor-dispatcher" as const;

/** Exhaustive mechanism selector for compiled agent and code stages. */
export class StageExecutorDispatcher implements WorkflowExecutor {
  /** Stable executor identifier. */
  public readonly id = STAGE_EXECUTOR_DISPATCHER_ID;

  /**
   * Creates a dispatcher with exactly one delegate for each supported stage kind.
   *
   * @param agentExecutor - Executor for agent stages.
   * @param codeExecutor - Executor for code stages.
   */
  public constructor(
    private readonly agentExecutor: WorkflowExecutor,
    private readonly codeExecutor: WorkflowExecutor,
  ) {}

  /**
   * Routes the original request to its matching concrete executor.
   *
   * @param request - Compiled stage execution request.
   *
   * @returns The matching delegate's result.
   *
   * @throws RangeError When an invalid runtime stage kind bypasses compilation.
   *
   * @example
   * ```ts
   * await dispatcher.execute(request);
   * ```
   */
  public execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const runtimeKind: string = request.stage.kind;
    switch (request.stage.kind) {
      case "agent":
        return this.agentExecutor.execute(request);
      case "code":
        return this.codeExecutor.execute(request);
    }
    const exhaustive: never = request.stage;
    void exhaustive;
    throw new RangeError(`Unsupported compiled stage kind: ${runtimeKind}`);
  }
}
