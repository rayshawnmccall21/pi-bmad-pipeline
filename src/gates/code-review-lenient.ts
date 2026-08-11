/**
 * Lenient code-review gate: passes when verdict is "approved" OR
 * when verdict is "needs-dev"/"needs-verify" with 0 critical and 0 high.
 * Medium/low/info findings are accepted.
 *
 * Use `gate: code-review-lenient` in pipeline YAML instead of `gate: code-review`.
 *
 * @packageDocumentation
 */
import type { PayloadGate, PayloadGateContext, PayloadGateResult } from "../rundef/index.js";

export const CODE_REVIEW_LENIENT_GATE_NAME = "code-review-lenient" as const;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

function countOf(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function severitySummary(payload: Record<string, unknown>): string {
  const counts = payload["findingsBySeverity"];
  if (!isRecord(counts)) return "unknown";
  return SEVERITIES.map(s => `${s}=${String(countOf(counts, s))}`).join(", ");
}

export const codeReviewLenientGate: PayloadGate = (
  payload: Record<string, unknown>,
  context?: PayloadGateContext,
): PayloadGateResult => {
  if (context?.storyId !== undefined && payload["storyId"] !== context.storyId) {
    return Object.freeze({
      passed: false,
      reason: `Story identity mismatch: ${JSON.stringify(payload["storyId"] ?? null)} vs ${JSON.stringify(context.storyId)}.`,
    });
  }

  const verdict = payload["verdict"];
  const counts = payload["findingsBySeverity"];
  const critical = isRecord(counts) ? countOf(counts, "critical") : 0;
  const high = isRecord(counts) ? countOf(counts, "high") : 0;

  if (verdict === "approved") {
    return Object.freeze({ passed: true, reason: "Code review approved." });
  }

  if (verdict === "needs-dev" || verdict === "needs-verify") {
    if (critical === 0 && high === 0) {
      return Object.freeze({
        passed: true,
        reason: `Code review ${String(verdict)} accepted: 0 critical, 0 high. Remaining: ${severitySummary(payload)}`,
      });
    }
    return Object.freeze({
      passed: false,
      reason: `Code review ${String(verdict)}: ${String(critical)} critical, ${String(high)} high.`,
      findings: Object.freeze([`Findings: ${severitySummary(payload)}`]),
    });
  }

  return Object.freeze({
    passed: false,
    reason: `Unrecognized code-review verdict ${JSON.stringify(verdict ?? null)}; failing closed.`,
  });
};
