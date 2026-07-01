/** Default model used when no source provides one. */
export const DEFAULT_PIPELINE_MODEL = "gpt-5.5-pro" as const;

/** Default thinking effort used when no source provides one. */
export const DEFAULT_PIPELINE_THINKING = "medium" as const;

/** Supported thinking effort values. */
export type ModelThinking = "low" | "medium" | "high";

/** Resolution source label. */
export type ModelConfigSource = "explicit" | "stage" | "project" | "environment" | "default";

/** Candidate model/thinking values from one source. */
export interface ModelConfigCandidate {
  /** Candidate model name. */
  readonly model?: string;

  /** Candidate thinking effort. */
  readonly thinking?: string;
}

/** Request for pure model config resolution. */
export interface ResolveModelConfigRequest {
  /** Highest-precedence explicit caller options. */
  readonly explicit?: ModelConfigCandidate;

  /** Compiled stage-level override values. */
  readonly stage?: ModelConfigCandidate;

  /** Project-level model configuration values. */
  readonly project?: ModelConfigCandidate;

  /** Environment adapter values. */
  readonly environment?: ModelConfigCandidate;

  /** Caller-provided defaults used before built-in defaults. */
  readonly defaults?: ModelConfigCandidate;
}

/** Final model and thinking values selected for stage execution. */
export interface ResolvedModelConfig {
  /** Resolved nonblank model name. */
  readonly model: string;

  /** Resolved thinking effort. */
  readonly thinking: ModelThinking;

  /** Source that supplied the resolved model. */
  readonly modelSource: ModelConfigSource;

  /** Source that supplied the resolved thinking effort. */
  readonly thinkingSource: ModelConfigSource;
}

/** Model config validation issue. */
export interface ModelConfigIssue {
  /** JSON-ish path to the invalid selected field. */
  readonly path: string;

  /** Human-readable validation failure. */
  readonly message: string;
}

/** Error thrown when model config cannot be resolved safely. */
export class ModelConfigError extends Error {
  /** Frozen validation issues. */
  public readonly issues: readonly ModelConfigIssue[];

  /**
   * Creates a model config error.
   *
   * @param issues - Validation issues that made the config unsafe.
   *
   * @example
   * ```ts
   * throw new ModelConfigError([{ path: "/explicit/model", message: "Model must not be blank." }]);
   * ```
   */
  public constructor(issues: readonly ModelConfigIssue[]) {
    super("Model config resolution failed.");
    this.name = "ModelConfigError";
    this.issues = freezeIssues(issues);
  }
}

/**
 * Checks whether a string is a supported thinking effort.
 *
 * @param value - Candidate thinking value.
 *
 * @returns True when value is low, medium, or high.
 *
 * @example
 * ```ts
 * isModelThinking("medium");
 * ```
 */
export function isModelThinking(value: string): value is ModelThinking {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * Resolves model and thinking independently from deterministic candidate sources.
 *
 * @param request - Optional model config resolution request.
 *
 * @returns Frozen resolved model config.
 *
 * @throws ModelConfigError When the selected model or thinking value is invalid.
 *
 * @example
 * ```ts
 * const config = resolveModelConfig({ explicit: { model: "openai/gpt-5" } });
 * ```
 */
export function resolveModelConfig(request: ResolveModelConfigRequest = {}): ResolvedModelConfig {
  const model = resolveSelectedValue(request, "model", DEFAULT_PIPELINE_MODEL);
  const thinking = resolveSelectedValue(request, "thinking", DEFAULT_PIPELINE_THINKING);
  const issues = [...validateModel(model), ...validateThinking(thinking)];
  if (issues.length > 0 || !isModelThinking(thinking.value)) {
    throw new ModelConfigError(issues);
  }
  return Object.freeze({
    model: model.value.trim(),
    thinking: thinking.value,
    modelSource: model.source,
    thinkingSource: thinking.source,
  });
}

/**
 * Asserts that a resolved model config is safe to use.
 *
 * @param config - Resolved model config to validate.
 *
 * @returns Nothing when the config is valid.
 *
 * @throws ModelConfigError When model is blank or thinking is invalid.
 *
 * @example
 * ```ts
 * assertResolvedModelConfig(config);
 * ```
 */
export function assertResolvedModelConfig(config: ResolvedModelConfig): void {
  const issues = [
    ...(config.model.trim().length === 0
      ? [{ path: "/model", message: "Model must not be blank." }]
      : []),
    ...(!isModelThinking(config.thinking)
      ? [{ path: "/thinking", message: 'Thinking must be "low", "medium", or "high".' }]
      : []),
  ];
  if (issues.length > 0) {
    throw new ModelConfigError(issues);
  }
}

type ModelConfigField = "model" | "thinking";

interface SelectedConfigValue {
  readonly value: string;
  readonly source: ModelConfigSource;
  readonly path: string;
}

const sourceOrder = ["explicit", "stage", "project", "environment", "defaults"] as const;

const resolveSelectedValue = (
  request: ResolveModelConfigRequest,
  field: ModelConfigField,
  builtInDefault: string,
): SelectedConfigValue => {
  for (const source of sourceOrder) {
    const value = request[source]?.[field];
    if (value !== undefined) {
      return {
        value,
        source: source === "defaults" ? "default" : source,
        path: `/${source}/${field}`,
      };
    }
  }
  return { value: builtInDefault, source: "default", path: `/default/${field}` };
};

const validateModel = (selected: SelectedConfigValue): readonly ModelConfigIssue[] =>
  selected.value.trim().length === 0
    ? [{ path: selected.path, message: "Model must not be blank." }]
    : [];

const validateThinking = (selected: SelectedConfigValue): readonly ModelConfigIssue[] =>
  isModelThinking(selected.value)
    ? []
    : [{ path: selected.path, message: 'Thinking must be "low", "medium", or "high".' }];

const freezeIssues = (issues: readonly ModelConfigIssue[]): readonly ModelConfigIssue[] =>
  Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
