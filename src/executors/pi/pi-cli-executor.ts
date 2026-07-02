import type { ModelThinking } from "../../model/index.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "../workflow-executor.js";
import { runBmadStage, type BmadStageSpawn, type RunBmadStageRequest } from "./run-bmad-stage.js";

/** Stable executor id for the Pi CLI executor. */
export const PI_CLI_WORKFLOW_EXECUTOR_ID = "pi-cli" as const;

/** Callable used by PiCliWorkflowExecutor to run one stage. */
export type RunBmadStageFunction = (request: RunBmadStageRequest) => Promise<StageExecutionResult>;

/** Options for constructing a Pi CLI workflow executor. */
export interface PiCliWorkflowExecutorOptions {
  /** Resolved model name passed to every stage. */
  readonly model: string;

  /** Resolved default thinking effort. */
  readonly thinking: ModelThinking;

  /** Optional Pi executable name/path. */
  readonly piBin?: string;

  /** Optional pi-bmad extension file path loaded via -e. */
  readonly piBmadExtensionPath?: string;

  /** Optional spawn implementation for tests. */
  readonly spawn?: BmadStageSpawn;

  /** Optional stage extension path resolver. */
  readonly resolveStageExtensionPath?: (request: StageExecutionRequest) => string | undefined;

  /** Optional stage runner implementation for tests. */
  readonly runStage?: RunBmadStageFunction;
}

/** WorkflowExecutor implementation backed by the Pi CLI. */
export class PiCliWorkflowExecutor implements WorkflowExecutor {
  /** Stable executor id. */
  public readonly id = PI_CLI_WORKFLOW_EXECUTOR_ID;

  private readonly options: PiCliWorkflowExecutorOptions;

  private readonly runStage: RunBmadStageFunction;

  /**
   * Creates a Pi CLI workflow executor.
   *
   * @param options - Configuration for Pi-backed stage execution.
   *
   * @throws RangeError When model, piBin, or piBmadExtensionPath are blank.
   *
   * @example
   * ```ts
   * const executor = new PiCliWorkflowExecutor({ model: "gpt-5", thinking: "medium" });
   * ```
   */
  public constructor(options: PiCliWorkflowExecutorOptions) {
    validateOptions(options);
    this.options = options;
    this.runStage = options.runStage ?? runBmadStage;
  }

  /**
   * Executes one stage through the Pi CLI.
   *
   * @param request - Stage execution request.
   *
   * @returns Stage execution result.
   *
   * @example
   * ```ts
   * await executor.execute(request);
   * ```
   */
  public execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    return this.runStage(toRunBmadStageRequest(request, this.options));
  }
}

const validateOptions = (options: PiCliWorkflowExecutorOptions): void => {
  validateNonBlank("model", options.model);
  if (options.piBin !== undefined) {
    validateNonBlank("piBin", options.piBin);
  }
  if (options.piBmadExtensionPath !== undefined) {
    validateNonBlank("piBmadExtensionPath", options.piBmadExtensionPath);
  }
};

const validateNonBlank = (field: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new RangeError(`${field} must not be blank.`);
  }
};

const toRunBmadStageRequest = (
  request: StageExecutionRequest,
  options: PiCliWorkflowExecutorOptions,
): RunBmadStageRequest => ({
  ...request,
  model: options.model,
  thinking: options.thinking,
  ...optionalCliFields(options),
  ...optionalStageExtensionPath(request, options),
});

const optionalCliFields = (
  options: PiCliWorkflowExecutorOptions,
): Partial<Pick<RunBmadStageRequest, "piBin" | "piBmadExtensionPath" | "spawn">> => ({
  ...(options.piBin === undefined ? {} : { piBin: options.piBin }),
  ...(options.piBmadExtensionPath === undefined
    ? {}
    : { piBmadExtensionPath: options.piBmadExtensionPath }),
  ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
});

const optionalStageExtensionPath = (
  request: StageExecutionRequest,
  options: PiCliWorkflowExecutorOptions,
): Partial<Pick<RunBmadStageRequest, "stageExtensionPath">> => {
  const stageExtensionPath = options.resolveStageExtensionPath?.(request);
  return stageExtensionPath === undefined ? {} : { stageExtensionPath };
};
