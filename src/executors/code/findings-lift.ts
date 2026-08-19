/**
 * Findings-file lift for code stages (v1.1).
 *
 * The findings file is the ONLY channel lifted from a code stage into an
 * agent prompt, so this module is the trust boundary: schema-marked JSON
 * only, hard caps, control characters stripped. Anything invalid lifts
 * nothing — the decision kernel then fails closed instead of regressing
 * with empty findings.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { CompiledCodeStage } from "../../rundef/index.js";

/** Maximum findings lifted from one file. */
const FINDINGS_MAX_COUNT = 50;

/** Maximum characters per formatted finding. */
const FINDINGS_MAX_ITEM_CHARS = 2048;

/** Maximum total characters across all lifted findings. */
const FINDINGS_MAX_TOTAL_CHARS = 65536;

/** Raw-file ceiling before parsing is attempted (guards memory, not content). */
const RAW_FILE_CEILING_MULTIPLIER = 4;

/** Character cap for the severity token of one formatted finding. */
const SEVERITY_CHAR_CAP = 16;

/** Character cap for the file-name token of one formatted finding. */
const FILE_NAME_CHAR_CAP = 256;

/** Request describing one settled code-stage execution to lift from. */
export interface LiftFindingsRequest {
  /** Compiled code stage possibly declaring findingsFile. */
  readonly stage: Pick<CompiledCodeStage, "findingsFile">;

  /** Project root the findings path resolves against. */
  readonly projectRoot: string;

  /** Child exit code. */
  readonly exitCode: number | null;

  /** True when the stage timed out. */
  readonly timedOut: boolean;

  /** True when the stage was aborted. */
  readonly aborted: boolean;
}

/**
 * Lifts capped, sanitized findings from a code stage's findings file.
 *
 * @param request - Stage, project root, and settle flags.
 *
 * @returns Formatted findings, or undefined when nothing valid was lifted.
 *
 * @example
 * ```ts
 * const findings = liftFindings({ stage, projectRoot, exitCode: 1,
 *   timedOut: false, aborted: false });
 * ```
 */
export const liftFindings = (request: LiftFindingsRequest): readonly string[] | undefined => {
  const file = liftablePath(request);
  if (file === undefined) {
    return undefined;
  }
  const entries = readFindingEntries(resolvePath(request.projectRoot, file));
  const lifted = entries === undefined ? [] : collectFormatted(entries);
  return lifted.length === 0 ? undefined : Object.freeze(lifted);
};

/**
 * The findings file this settle may lift from.
 *
 * Only a clean gate-failure lifts: exit 1 with a declared file. A timeout
 * or an abort means the stage never reached a verdict, so whatever the file
 * holds describes an earlier run and must not reach a prompt.
 *
 * @param request - Stage, project root, and settle flags.
 *
 * @returns The declared findings path, or undefined when nothing may lift.
 */
const liftablePath = (request: LiftFindingsRequest): string | undefined => {
  if (request.exitCode !== 1 || request.timedOut || request.aborted) {
    return undefined;
  }
  return request.stage.findingsFile;
};

const readFindingEntries = (path: string): readonly unknown[] | undefined => {
  let parsed: unknown;
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > FINDINGS_MAX_TOTAL_CHARS * RAW_FILE_CEILING_MULTIPLIER) {
      return undefined;
    }
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["schema"] !== "stage-findings.v1") {
    return undefined;
  }
  const findings = parsed["findings"];
  return Array.isArray(findings) ? findings : undefined;
};

const collectFormatted = (entries: readonly unknown[]): string[] => {
  const lifted: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (lifted.length >= FINDINGS_MAX_COUNT) {
      break;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const formatted = formatFinding(entry);
    total += formatted.length;
    if (total > FINDINGS_MAX_TOTAL_CHARS) {
      break;
    }
    lifted.push(formatted);
  }
  return lifted;
};

const formatFinding = (item: Record<string, unknown>): string => {
  const severity = sanitize(stringOf(item["severity"], "high")).slice(0, SEVERITY_CHAR_CAP);
  const fileName = sanitize(stringOf(item["file"], "")).slice(0, FILE_NAME_CHAR_CAP);
  const line = typeof item["line"] === "number" ? `:${String(item["line"])}` : "";
  const text = sanitize(stringOf(item["text"], ""));
  return `[${severity}] ${fileName}${line} — ${text}`.slice(0, FINDINGS_MAX_ITEM_CHARS);
};

const stringOf = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const sanitize = (text: string): string => text.replace(CONTROL_CHARS, "").replace(/\r/g, "");
