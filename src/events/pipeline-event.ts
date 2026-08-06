/**
 * PipelineCliEvent — the CLI's line-oriented JSONL wire protocol.
 *
 * Every event is one single-line JSON record: an `event` discriminator plus an
 * envelope (`ts`, `storyId`) stamped by the emitter, and a minimal per-variant
 * payload. Serialization always passes through the shared credential redaction
 * patterns (single source of truth in ../security), and embedded newlines are
 * JSON-escaped so one event never spans more than one line. This module owns
 * pure types, a pure serializer, and an emitter factory with an injected sink
 * and clock — it never touches process, stdout, or any other ambient state.
 * Vocabularies owned by other modules (stage decision kinds, run statuses,
 * merge decisions) are carried as opaque strings; their sources of truth stay
 * in the owning modules.
 *
 * @packageDocumentation
 */

import { redactText } from "../security/index.js";

/** Envelope fields present on every pipeline CLI event. */
export interface PipelineCliEventBase {
  /** ISO-8601 event timestamp produced by the emitter clock. */
  readonly ts: string;

  /** Story id the pipeline run is executing. */
  readonly storyId: string;
}

/** Emitted once when a pipeline run begins. */
export interface PipelineRunStartedEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "run.started";

  /** Compiled rundef id driving this run. */
  readonly rundefId: string;

  /** Story spec file path. */
  readonly specFile: string;
}

/** Emitted when one stage attempt starts. */
export interface PipelineStageStartedEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "stage.started";

  /** Stage id being executed. */
  readonly stageId: string;

  /** 1-based attempt number for this stage. */
  readonly attempt: number;
}

/** Emitted when one stage attempt finishes. */
export interface PipelineStageFinishedEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "stage.finished";

  /** Stage id that finished. */
  readonly stageId: string;

  /** 1-based attempt number for this stage. */
  readonly attempt: number;

  /** Stage decision kind (vocabulary owned by core/stage-decision). */
  readonly kind: string;

  /** True only when the execution and optional payload gate passed. */
  readonly passed: boolean;

  /** Child process exit code, or null when no exit code exists. */
  readonly exitCode: number | null;

  /** Stage duration in milliseconds. */
  readonly durationMs: number;

  /** Human-readable audit reason. */
  readonly reason: string;
}

/** Emitted after a payload gate evaluates a stage's output. */
export interface PipelineGateDecisionEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "gate.decision";

  /** Stage id whose output was gated. */
  readonly stageId: string;

  /** Payload gate name. */
  readonly gate: string;

  /** True when the gate passed. */
  readonly passed: boolean;

  /** Human-readable gate reason. */
  readonly reason: string;

  /** Findings reported by the gate. */
  readonly findings: readonly string[];
}

/** Budget scope evaluated by a budget decision. */
export type PipelineBudgetScope = "stage" | "run";

/** Emitted after a stage or run budget evaluation. */
export interface PipelineBudgetDecisionEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "budget.decision";

  /** Whether a stage budget or the run budget was evaluated. */
  readonly scope: PipelineBudgetScope;

  /** Stage id for stage-scoped decisions. */
  readonly stageId?: string;

  /** True when spending stayed within budget. */
  readonly withinBudget: boolean;

  /** Human-readable budget reason. */
  readonly reason: string;
}

/** Emitted after harness-owned evidence collection finishes. */
export interface PipelineEvidenceFinishedEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "evidence.finished";

  /** True when every harness evidence command passed. */
  readonly passed: boolean;

  /** Names of harness evidence commands that failed. */
  readonly failedCommands: readonly string[];
}

/** Emitted after a story pull request is opened. */
export interface PipelinePrOpenedEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "pr.opened";

  /** Opened pull request URL. */
  readonly prUrl: string;

  /** Opened pull request number. */
  readonly prNumber: number;

  /** Story branch the pull request was opened from. */
  readonly branch: string;
}

/** Emitted after the merge gate evaluates a story. */
export interface PipelineMergeDecisionEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "merge.decision";

  /** Merge gate decision (vocabulary owned by git/merge-gate). */
  readonly decision: string;

  /** Blockers preventing the merge, empty when allowed. */
  readonly blockers: readonly string[];
}

/** Emitted for human-oriented progress updates. */
export interface PipelineProgressEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "progress";

  /** Progress message. */
  readonly message: string;
}

/** Emitted exactly once as the terminal run summary. */
export interface PipelineResultEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "result";

  /** Terminal run status (vocabulary owned by state/pipeline-state RunResult). */
  readonly status: string;

  /** Stage ids executed during the run, in order. */
  readonly stagesRun: readonly string[];

  /** Number of regressions taken during the run. */
  readonly regressions: number;

  /** Total run duration in milliseconds. */
  readonly durationMs: number;

  /** Failure description for non-passing terminal statuses. */
  readonly error?: string;
}

/** Emitted when the supervisor hits an internal error. */
export interface PipelineErrorEvent extends PipelineCliEventBase {
  /** Event type discriminator. */
  readonly event: "error";

  /** Stable machine-readable error code. */
  readonly code: string;

  /** Redacted error message. */
  readonly message: string;
}

/** Discriminated union of all pipeline CLI wire events. */
export type PipelineCliEvent =
  | PipelineRunStartedEvent
  | PipelineStageStartedEvent
  | PipelineStageFinishedEvent
  | PipelineGateDecisionEvent
  | PipelineBudgetDecisionEvent
  | PipelineEvidenceFinishedEvent
  | PipelinePrOpenedEvent
  | PipelineMergeDecisionEvent
  | PipelineProgressEvent
  | PipelineResultEvent
  | PipelineErrorEvent;

/** Event type discriminator vocabulary. */
export type PipelineCliEventType = PipelineCliEvent["event"];

/** Event variant selected by its type discriminator. */
export type PipelineCliEventOf<T extends PipelineCliEventType> = Extract<
  PipelineCliEvent,
  Record<"event", T>
>;

/** Variant payload fields for one event type, without envelope fields. */
export type PipelineCliEventFields<T extends PipelineCliEventType> = Omit<
  PipelineCliEventOf<T>,
  "event" | "ts" | "storyId"
>;

/** Error code emitted by pipeline event emitter construction failures. */
export type PipelineEventErrorCode = "invalid-story-id";

/** Error thrown when a pipeline event emitter is misconfigured. */
export class PipelineEventError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: PipelineEventErrorCode;

  /**
   * Creates a pipeline event error.
   *
   * @param code - Stable machine-readable error code.
   * @param reason - Human-readable failure reason.
   *
   * @example
   * ```ts
   * throw new PipelineEventError("invalid-story-id", "storyId must not be blank");
   * ```
   */
  public constructor(code: PipelineEventErrorCode, reason: string) {
    super(reason);
    this.name = "PipelineEventError";
    this.code = code;
  }
}

/** Line sink receiving serialized pipeline events. */
export interface PipelineEventSink {
  /**
   * Writes one serialized event line.
   *
   * @param line - Single-line JSON event without a trailing newline.
   *
   * @example
   * ```ts
   * const sink: PipelineEventSink = { write: (line) => lines.push(line) };
   * ```
   */
  write(line: string): void;
}

/** Options for creating a pipeline event emitter. */
export interface CreatePipelineEventEmitterOptions {
  /** Sink receiving one serialized line per emitted event. */
  readonly sink: PipelineEventSink;

  /** Story id stamped on every emitted event. */
  readonly storyId: string;

  /** Injectable clock. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** Emitter that builds, redacts, serializes, and writes pipeline events. */
export interface PipelineEventEmitter {
  /**
   * Emits one pipeline event: stamps the envelope, deep-redacts the fields,
   * serializes to one line, and writes it to the sink.
   *
   * @param type - Event type discriminator.
   * @param fields - Variant payload fields; envelope fields are stamped by the
   * emitter and cannot be overridden.
   *
   * @returns Deep-frozen redacted event that was written.
   *
   * @example
   * ```ts
   * emitter.emit("progress", { message: "compiling rundef" });
   * ```
   */
  emit<T extends PipelineCliEventType>(
    type: T,
    fields: PipelineCliEventFields<T>,
  ): PipelineCliEventOf<T>;
}

/**
 * Serializes a pipeline event as one redacted single-line JSON string.
 *
 * Embedded newlines in field values are JSON-escaped, so the returned string
 * never contains a raw line break; credential-looking substrings are replaced
 * via the shared redaction patterns.
 *
 * @param event - Pipeline event to serialize.
 *
 * @returns Single-line JSON without a trailing newline.
 *
 * @example
 * ```ts
 * sink.write(serializePipelineEvent(event));
 * ```
 */
export function serializePipelineEvent(event: PipelineCliEvent): string {
  return redactText(JSON.stringify(event)).value;
}

/**
 * Creates a pipeline event emitter bound to a sink, story id, and clock.
 *
 * @param options - Sink, story id, and optional injectable clock.
 *
 * @returns Frozen emitter whose emit() builds, redacts, serializes, and writes
 * one event line per call.
 *
 * @throws PipelineEventError When the story id is blank.
 *
 * @example
 * ```ts
 * const emitter = createPipelineEventEmitter({ sink, storyId: "STORY-1" });
 * emitter.emit("stage.started", { stageId: "dev-story", attempt: 1 });
 * ```
 */
export function createPipelineEventEmitter(
  options: CreatePipelineEventEmitterOptions,
): PipelineEventEmitter {
  const { sink, storyId } = options;
  if (storyId.trim() === "") {
    throw new PipelineEventError("invalid-story-id", "storyId must not be blank");
  }
  const now = options.now ?? defaultNow;
  const emit = <T extends PipelineCliEventType>(
    type: T,
    fields: PipelineCliEventFields<T>,
  ): PipelineCliEventOf<T> => {
    const base: PipelineCliEventBase = Object.freeze({ ts: now().toISOString(), storyId });
    const event = eventBuilders[type](base, fields);
    sink.write(serializePipelineEvent(event));
    return event;
  };
  return Object.freeze({ emit } satisfies PipelineEventEmitter);
}

const defaultNow = (): Date => new Date();

const redactString = (value: string): string => redactText(value).value;

const redactStringList = (values: readonly string[]): readonly string[] =>
  Object.freeze(values.map((value) => redactString(value)));

type PipelineEventBuilder<K extends PipelineCliEventType> = (
  base: PipelineCliEventBase,
  fields: PipelineCliEventFields<K>,
) => PipelineCliEventOf<K>;

type PipelineEventBuilders = {
  readonly [K in PipelineCliEventType]: PipelineEventBuilder<K>;
};

const buildRunStarted: PipelineEventBuilder<"run.started"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "run.started",
    rundefId: redactString(fields.rundefId),
    specFile: redactString(fields.specFile),
  });

const buildStageStarted: PipelineEventBuilder<"stage.started"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "stage.started",
    stageId: redactString(fields.stageId),
    attempt: fields.attempt,
  });

const buildStageFinished: PipelineEventBuilder<"stage.finished"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "stage.finished",
    stageId: redactString(fields.stageId),
    attempt: fields.attempt,
    kind: redactString(fields.kind),
    passed: fields.passed,
    exitCode: fields.exitCode,
    durationMs: fields.durationMs,
    reason: redactString(fields.reason),
  });

const buildGateDecision: PipelineEventBuilder<"gate.decision"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "gate.decision",
    stageId: redactString(fields.stageId),
    gate: redactString(fields.gate),
    passed: fields.passed,
    reason: redactString(fields.reason),
    findings: redactStringList(fields.findings),
  });

const buildBudgetDecision: PipelineEventBuilder<"budget.decision"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "budget.decision",
    scope: fields.scope,
    ...(fields.stageId === undefined ? {} : { stageId: redactString(fields.stageId) }),
    withinBudget: fields.withinBudget,
    reason: redactString(fields.reason),
  });

const buildEvidenceFinished: PipelineEventBuilder<"evidence.finished"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "evidence.finished",
    passed: fields.passed,
    failedCommands: redactStringList(fields.failedCommands),
  });

const buildPrOpened: PipelineEventBuilder<"pr.opened"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "pr.opened",
    prUrl: redactString(fields.prUrl),
    prNumber: fields.prNumber,
    branch: redactString(fields.branch),
  });

const buildMergeDecision: PipelineEventBuilder<"merge.decision"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "merge.decision",
    decision: redactString(fields.decision),
    blockers: redactStringList(fields.blockers),
  });

const buildProgress: PipelineEventBuilder<"progress"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "progress",
    message: redactString(fields.message),
  });

const buildResult: PipelineEventBuilder<"result"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "result",
    status: redactString(fields.status),
    stagesRun: redactStringList(fields.stagesRun),
    regressions: fields.regressions,
    durationMs: fields.durationMs,
    ...(fields.error === undefined ? {} : { error: redactString(fields.error) }),
  });

const buildError: PipelineEventBuilder<"error"> = (base, fields) =>
  Object.freeze({
    ...base,
    event: "error",
    code: redactString(fields.code),
    message: redactString(fields.message),
  });

const eventBuilders: PipelineEventBuilders = Object.freeze({
  "run.started": buildRunStarted,
  "stage.started": buildStageStarted,
  "stage.finished": buildStageFinished,
  "gate.decision": buildGateDecision,
  "budget.decision": buildBudgetDecision,
  "evidence.finished": buildEvidenceFinished,
  "pr.opened": buildPrOpened,
  "merge.decision": buildMergeDecision,
  progress: buildProgress,
  result: buildResult,
  error: buildError,
});
