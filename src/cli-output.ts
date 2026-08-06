/**
 * Output policy for the bmad-pipeline CLI.
 *
 * Owns the exit-code mapping, the human-readable renderer for serialized
 * PipelineCliEvent lines, and the process line-sink factory. Pure decision
 * functions live here; the CLI shell composes them with injected streams.
 *
 * @packageDocumentation
 */

import type { PipelineEventSink } from "./events/index.js";
import type { RunResultStatus } from "./state/index.js";

/** Exit code for passing terminal outcomes ("passed", "pr-opened"). */
export const CLI_EXIT_OK = 0;

/** Exit code for usage errors and unexpected internal failures. */
export const CLI_EXIT_ERROR = 1;

/** Exit code for evaluated non-passing outcomes (failed, blocked, attention). */
export const CLI_EXIT_BLOCKED = 2;

/**
 * Maps a terminal run status to the CLI exit code policy.
 *
 * @param status - Terminal run or audit status.
 *
 * @returns 0 for "passed" and "pr-opened", otherwise 2.
 *
 * @example
 * ```ts
 * process.exitCode = runStatusExitCode(result.status);
 * ```
 */
export function runStatusExitCode(status: RunResultStatus): number {
  return status === "passed" || status === "pr-opened" ? CLI_EXIT_OK : CLI_EXIT_BLOCKED;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEventRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const ISO_TS_MIN_LENGTH = 20;
const ISO_TIME_START = 11;
const ISO_TIME_END = 19;

const timePart = (ts: unknown): string =>
  typeof ts === "string" && ts.length >= ISO_TS_MIN_LENGTH
    ? ts.slice(ISO_TIME_START, ISO_TIME_END)
    : "";

const storyPart = (storyId: unknown): string =>
  typeof storyId === "string" && storyId !== "" ? `[${storyId}]` : "";

const textPart = (value: unknown): string => (typeof value === "string" ? value : "");

const renderScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "boolean" ? String(value) : undefined;
};

const renderFieldValue = (value: unknown): string => {
  const scalar = renderScalar(value);
  if (scalar !== undefined) {
    return scalar;
  }
  if (value === null) {
    return "null";
  }
  return Array.isArray(value)
    ? value.map((entry: unknown) => renderFieldValue(entry)).join(",")
    : JSON.stringify(value);
};

const envelopeKeys: ReadonlySet<string> = new Set(["ts", "storyId", "event"]);

/**
 * Renders one serialized PipelineCliEvent line as a concise human line.
 *
 * The same wire events feed both output modes: with the jsonl flag the raw
 * line is printed, otherwise this adapter derives a "time [story] event
 * key=value" rendering. Lines that are not JSON objects pass through
 * unchanged.
 *
 * @param line - One serialized single-line JSON event.
 *
 * @returns Human-readable one-line rendering of the same event.
 *
 * @example
 * ```ts
 * stdout.write(formatHumanEventLine(serializedEventLine));
 * ```
 */
export function formatHumanEventLine(line: string): string {
  const record = parseEventRecord(line);
  if (record === undefined) {
    return line;
  }
  const head = [timePart(record["ts"]), storyPart(record["storyId"]), textPart(record["event"])]
    .filter((part) => part !== "")
    .join(" ");
  const tail = Object.entries(record)
    .filter(([key]) => !envelopeKeys.has(key))
    .map(([key, value]) => `${key}=${renderFieldValue(value)}`)
    .join(" ");
  if (head === "" || tail === "") {
    return `${head}${tail}`;
  }
  return `${head} ${tail}`;
}

/** Minimal writable stream shape needed to build a process line sink. */
export interface CliWritableStream {
  /**
   * Writes raw text to the stream.
   *
   * @param text - Text chunk to write.
   *
   * @returns True when the chunk was buffered without backpressure.
   *
   * @example
   * ```ts
   * process.stdout.write("line\n");
   * ```
   */
  write(text: string): boolean;
}

/**
 * Creates a line sink that writes one newline-terminated line per call.
 *
 * @param stream - Writable stream such as process.stdout.
 *
 * @returns Frozen line sink for the stream.
 *
 * @example
 * ```ts
 * const stdout = createProcessLineSink(process.stdout);
 * ```
 */
export function createProcessLineSink(stream: CliWritableStream): PipelineEventSink {
  return Object.freeze({
    write: (line: string): void => {
      stream.write(`${line}\n`);
    },
  });
}
