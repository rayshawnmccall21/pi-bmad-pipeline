/**
 * Extracts and gates the headless terminal output from a Pi JSONL event stream.
 *
 * The pi-bmad headless contract transports the terminal envelope inside
 * `tool_execution_end` events (`result.details.headlessOutput`), stamped as
 * `HeadlessWorkflowOutput & { emissionProvenance }`. Consumers must gate every
 * candidate with `gateHeadlessTerminalOutput` under the out-of-band emission
 * key, so a forged stdout line is never trusted as a stage completion.
 *
 * @packageDocumentation
 */

import { gateHeadlessTerminalOutput } from "pi-bmad/contracts";

import type { StageExecutionUsage } from "../workflow-executor.js";
import type { HeadlessJsonlRecord } from "./headless-jsonl-parser.js";

/** Out-of-band gating context for headless terminal output extraction. */
export interface GatedHeadlessOutputContext {
  /** Emission key issued to the child through PI_BMAD_EMISSION_KEY. */
  readonly emissionKey: string;

  /** The pi-bmad package root used to resolve result payload schemas. */
  readonly rootDir: string;
}

/** Fail-closed extraction result for the gated headless terminal output. */
export interface GatedHeadlessOutputExtraction {
  /** Verified terminal envelope, or null when none verified. */
  readonly output: Record<string, unknown> | null;

  /** Fail-closed reason, present exactly when output is null. */
  readonly failure?: string;
}

/**
 * Extracts the last emission-gated headless terminal envelope from a stream.
 *
 * @param records - Parsed JSONL records from the child stdout.
 * @param context - Emission key and schema root used for gating.
 *
 * @returns The last verified envelope, or a fail-closed failure reason.
 *
 * @example
 * ```ts
 * const extraction = extractGatedHeadlessOutput(snapshot.records, { emissionKey, rootDir });
 * ```
 */
export function extractGatedHeadlessOutput(
  records: readonly HeadlessJsonlRecord[],
  context: GatedHeadlessOutputContext,
): GatedHeadlessOutputExtraction {
  const candidates = records
    .map((record) => headlessOutputCandidate(record.value))
    .filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  if (candidates.length === 0) {
    return {
      output: null,
      failure: "No headless terminal output found in tool_execution_end events.",
    };
  }
  return gateCandidates(candidates, context);
}

/**
 * Aggregates assistant usage reported by message_end events into stage usage.
 *
 * @param records - Parsed JSONL records from the child stdout.
 *
 * @returns Total tokens and dollars, or undefined when no usage was reported.
 *
 * @example
 * ```ts
 * const usage = extractStageUsage(snapshot.records);
 * ```
 */
export function extractStageUsage(
  records: readonly HeadlessJsonlRecord[],
): StageExecutionUsage | undefined {
  const reports = records
    .map((record) => assistantUsage(record.value))
    .filter((usage): usage is StageExecutionUsage => usage !== undefined);
  if (reports.length === 0) {
    return undefined;
  }
  return reports.reduce((total, usage) => ({
    tokens: total.tokens + usage.tokens,
    dollars: total.dollars + usage.dollars,
  }));
}

const gateCandidates = (
  candidates: readonly Record<string, unknown>[],
  context: GatedHeadlessOutputContext,
): GatedHeadlessOutputExtraction => {
  const gated = candidates.map((candidate) => ({
    candidate,
    verdict: gateHeadlessTerminalOutput(candidate, context),
  }));
  const accepted = gated.filter((entry) => entry.verdict.accepted).at(-1);
  if (accepted !== undefined) {
    return { output: accepted.candidate };
  }
  const lastVerdict = gated[gated.length - 1]?.verdict;
  const stage = lastVerdict !== undefined && !lastVerdict.accepted ? lastVerdict.stage : "unknown";
  return {
    output: null,
    failure: `Headless terminal output rejected at the ${stage} gate under the emission key.`,
  };
};

const headlessOutputCandidate = (value: unknown): Record<string, unknown> | undefined => {
  const event = eventOfType(value, "tool_execution_end");
  return recordField(recordField(recordField(event, "result"), "details"), "headlessOutput");
};

const assistantUsage = (value: unknown): StageExecutionUsage | undefined => {
  const usage = recordField(messageEndAssistantMessage(value), "usage");
  const tokens = usage?.["totalTokens"];
  const dollars = recordField(usage, "cost")?.["total"];
  return isNonNegativeFinite(tokens) && isNonNegativeFinite(dollars)
    ? { tokens, dollars }
    : undefined;
};

const messageEndAssistantMessage = (value: unknown): Record<string, unknown> | undefined => {
  const message = recordField(eventOfType(value, "message_end"), "message");
  return message?.["role"] === "assistant" ? message : undefined;
};

const eventOfType = (value: unknown, type: string): Record<string, unknown> | undefined =>
  isRecord(value) && value["type"] === type ? value : undefined;

const recordField = (
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const field = value === undefined ? undefined : value[key];
  return isRecord(field) ? field : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
