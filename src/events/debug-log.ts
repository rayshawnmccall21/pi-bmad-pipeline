/**
 * Structured debug logging seam for the pipeline supervisor.
 *
 * Debug events are single-line JSON records written to stderr, gated by the
 * `BMAD_PIPELINE_DEBUG` environment variable so production runs stay silent.
 * Every line is passed through credential redaction before it is written, and
 * call sites must never include emission keys or other secrets in fields.
 * Events cover supervisor decision seams only (stage spawn argv, envelope
 * gating verdicts, merge-gate decisions, state-store transitions, dispatch
 * lock acquire/release) — never per-iteration stream chatter.
 *
 * @packageDocumentation
 */

import { redactText } from "../security/index.js";

/** Environment variable that enables pipeline debug logging. */
export const PIPELINE_DEBUG_ENV_VAR = "BMAD_PIPELINE_DEBUG" as const;

/** Prefix stamped on every debug log line for grep-ability. */
export const DEBUG_LOG_PREFIX = "bmad-pipeline:debug" as const;

/** JSON-safe value accepted in debug event fields. */
export type DebugLogFieldValue = string | number | boolean | null | readonly (string | number)[];

/** Structured fields carried by one debug event. */
export type DebugLogFields = Readonly<Record<string, DebugLogFieldValue>>;

/** Injectable environment and sink seams used by tests. */
export interface DebugLogOptions {
  /** Environment map consulted for the debug flag. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Sink receiving one rendered line (without trailing newline). Defaults to stderr. */
  readonly write?: (line: string) => void;
}

/**
 * Checks whether pipeline debug logging is enabled.
 *
 * @param env - Environment map to consult. Defaults to process.env.
 *
 * @returns True unless the flag is unset, blank, "0", or "false".
 *
 * @example
 * ```ts
 * if (isPipelineDebugEnabled()) {
 *   debugLog("lock.release", { path: lockDir });
 * }
 * ```
 */
export function isPipelineDebugEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env[PIPELINE_DEBUG_ENV_VAR];
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * Emits one redacted single-line JSON debug event when debug logging is on.
 *
 * @param event - Dotted event name (for example "stage.spawn").
 * @param fields - Structured event fields. Must never contain secrets.
 * @param options - Optional environment and sink seams for tests.
 *
 * @example
 * ```ts
 * debugLog("merge-gate.decision", { decision: "merge-blocked", blockers: ["secret-scan-blocked"] });
 * ```
 */
export function debugLog(
  event: string,
  fields: DebugLogFields,
  options: DebugLogOptions = {},
): void {
  if (!isPipelineDebugEnabled(options.env ?? process.env)) {
    return;
  }
  const record = { event, ts: new Date().toISOString(), ...fields };
  const line = `${DEBUG_LOG_PREFIX} ${redactText(JSON.stringify(record)).value}`;
  const write = options.write ?? writeToStderr;
  write(line);
}

const writeToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
