/* eslint-disable jsdoc/sort-tags -- keep task-specified JSDoc order. */

import { redactText } from "../security/index.js";

/** Secret scan finding severity. */
export type GitSecretScanSeverity = "blocker";

/** Secret pattern names reported by git diff scanning. */
export type GitSecretPatternName =
  | "bearer-token"
  | "openai-api-key"
  | "anthropic-api-key"
  | "google-api-key"
  | "github-token"
  | "aws-access-key-id"
  | "aws-secret-access-key";

/** One secret-shaped finding in a git diff. */
export interface GitSecretScanFinding {
  /** Secret pattern name. */
  readonly pattern: GitSecretPatternName;

  /** Finding severity. */
  readonly severity: GitSecretScanSeverity;

  /** One-based line number in the scanned diff text. */
  readonly line: number;

  /** Sanitized line preview. */
  readonly preview: string;
}

/** Git diff secret scan result. */
export interface GitSecretScanResult {
  /** True when no secret-shaped findings were detected. */
  readonly passed: boolean;

  /** Findings in deterministic input order. */
  readonly findings: readonly GitSecretScanFinding[];

  /** Human-readable summary. */
  readonly reason: string;
}

interface SecretPattern {
  readonly name: GitSecretPatternName;
  readonly regexes: readonly RegExp[];
}

const patterns: readonly SecretPattern[] = Object.freeze([
  { name: "bearer-token", regexes: [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/u] },
  { name: "openai-api-key", regexes: [/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/u] },
  { name: "anthropic-api-key", regexes: [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/u] },
  { name: "google-api-key", regexes: [/\bAIza[0-9A-Za-z_-]{25,}\b/u] },
  {
    name: "github-token",
    regexes: [/\bgh[opusra]_[A-Za-z0-9_]{30,}\b/u, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
  },
  { name: "aws-access-key-id", regexes: [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u] },
  {
    name: "aws-secret-access-key",
    regexes: [
      /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|awsSecretAccessKey)["'\s:=]+[A-Za-z0-9/+=]{40}/u,
    ],
  },
]);

/**
 * Scans git diff text for credential-shaped material.
 *
 * @param diffText - Git diff text to scan.
 * @returns Frozen secret scan result.
 *
 * @example
 * ```ts
 * const result = scanGitDiffForSecrets(diffText);
 * ```
 */
export function scanGitDiffForSecrets(diffText: string): GitSecretScanResult {
  const findings = Object.freeze(
    diffText
      .split("\n")
      .flatMap((line, index) => findingsForLine(stripCarriageReturn(line), index + 1)),
  );
  return Object.freeze({
    passed: findings.length === 0,
    findings,
    reason: reason(findings.length),
  });
}

/**
 * Checks whether a secret scan result blocks PR or merge actions.
 *
 * @param result - Secret scan result.
 * @returns True when at least one blocker finding exists.
 *
 * @example
 * ```ts
 * if (hasBlockingGitSecretFindings(result)) {
 *   throw new Error("blocked");
 * }
 * ```
 */
export function hasBlockingGitSecretFindings(result: GitSecretScanResult): boolean {
  return result.findings.length > 0;
}

const findingsForLine = (line: string, lineNumber: number): readonly GitSecretScanFinding[] => {
  const preview = redactText(line).value;
  return patterns.flatMap((pattern) =>
    matchesPattern(pattern, line) ? [finding(pattern.name, lineNumber, preview)] : [],
  );
};

const matchesPattern = (pattern: SecretPattern, line: string): boolean =>
  pattern.regexes.some((regex) => regex.test(line));

const finding = (
  pattern: GitSecretPatternName,
  line: number,
  preview: string,
): GitSecretScanFinding => Object.freeze({ pattern, severity: "blocker", line, preview });

const reason = (count: number): string => {
  if (count === 0) {
    return "Git diff secret scan passed.";
  }
  if (count === 1) {
    return "Git diff secret scan blocked 1 secret-shaped finding.";
  }
  return `Git diff secret scan blocked ${String(count)} secret-shaped findings.`;
};

const stripCarriageReturn = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;
