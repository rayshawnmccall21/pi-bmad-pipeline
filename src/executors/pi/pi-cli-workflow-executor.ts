import {
  resolveModelConfig,
  type ModelConfigCandidate,
  type ModelThinking,
} from "../../model/index.js";
import type {
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowExecutor,
} from "../workflow-executor.js";
import { runBmadStage, type BmadStageSpawn, type RunBmadStageRequest } from "./run-bmad-stage.js";

/** Default identifier for the Pi CLI workflow executor. */
export const DEFAULT_PI_CLI_WORKFLOW_EXECUTOR_ID = "pi-cli" as const;

/** Injectable stage runner used by PiCliWorkflowExecutor tests. */
export type PiCliRunBmadStage = (request: RunBmadStageRequest) => Promise<StageExecutionResult>;

/** Options for constructing a Pi CLI workflow executor. */
export interface PiCliWorkflowExecutorOptions {
  /** Stable executor identifier. */
  readonly id?: string;

  /** Explicit model override used for every stage. */
  readonly model?: string;

  /** Explicit default thinking effort used unless a stage overrides it. */
  readonly thinking?: ModelThinking;

  /** Optional stage extension directory path passed to Pi. */
  readonly stageExtensionPath?: string;

  /** Optional Pi executable name/path. */
  readonly piBin?: string;

  /** Optional BMAD headless command name. */
  readonly command?: string;

  /** Optional spawn implementation for tests. */
  readonly spawn?: BmadStageSpawn;

  /** Optional timeout override in milliseconds. */
  readonly timeoutMs?: number;

  /** Optional clock for tests. */
  readonly now?: () => number;

  /** Optional stage runner for tests. */
  readonly runStage?: PiCliRunBmadStage;
}

/** WorkflowExecutor implementation backed by the Pi CLI. */
export class PiCliWorkflowExecutor implements WorkflowExecutor {
  /** Stable executor identifier. */
  public readonly id: string;

  private readonly options: PiCliWorkflowExecutorOptions;

  private readonly runStage: PiCliRunBmadStage;

  /**
   * Creates a Pi CLI workflow executor.
   *
   * @param options - Values used for every stage execution.
   *
   * @throws RangeError When id is blank.
   *
   * @example
   * ```ts
   * const executor = new PiCliWorkflowExecutor({ model: "gpt-5.5-pro" });
   * ```
   */
  public constructor(options: PiCliWorkflowExecutorOptions = {}) {
    this.id = options.id ?? DEFAULT_PI_CLI_WORKFLOW_EXECUTOR_ID;
    if (this.id.trim().length === 0) {
      throw new RangeError("id must not be blank.");
    }
    this.options = options;
    this.runStage = options.runStage ?? runBmadStage;
  }

  /**
   * Executes one compiled stage through a fresh Pi child process.
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

/**
 * Creates a Pi CLI workflow executor.
 *
 * @param options - Values used by the created executor.
 *
 * @returns Configured executor.
 *
 * @example
 * ```ts
 * const executor = createPiCliWorkflowExecutor();
 * ```
 */
export function createPiCliWorkflowExecutor(
  options: PiCliWorkflowExecutorOptions = {},
): PiCliWorkflowExecutor {
  return new PiCliWorkflowExecutor(options);
}

const toRunBmadStageRequest = (
  request: StageExecutionRequest,
  options: PiCliWorkflowExecutorOptions,
): RunBmadStageRequest => {
  const model = resolveModelConfig({ explicit: toModelConfigCandidate(options) });
  return {
    ...request,
    model: model.model,
    thinking: model.thinking,
    ...optionalCliFields(options),
    ...optionalRunnerFields(options),
  };
};

const optionalCliFields = (
  options: PiCliWorkflowExecutorOptions,
): Partial<Pick<RunBmadStageRequest, "stageExtensionPath" | "piBin" | "command">> => ({
  ...(options.stageExtensionPath === undefined
    ? {}
    : { stageExtensionPath: options.stageExtensionPath }),
  ...(options.piBin === undefined ? {} : { piBin: options.piBin }),
  ...(options.command === undefined ? {} : { command: options.command }),
});

const optionalRunnerFields = (
  options: PiCliWorkflowExecutorOptions,
): Partial<Pick<RunBmadStageRequest, "spawn" | "timeoutMs" | "now">> => ({
  ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  ...(options.now === undefined ? {} : { now: options.now }),
});

const toModelConfigCandidate = (options: PiCliWorkflowExecutorOptions): ModelConfigCandidate => ({
  ...(options.model === undefined ? {} : { model: options.model }),
  ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
});
