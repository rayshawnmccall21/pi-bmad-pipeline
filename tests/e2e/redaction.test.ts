/**
 * Group D — credential redaction filter.
 *
 * A credential planted in child-controlled payload fields must never appear in
 * any emitted event or on stderr; the durable (unredacted) audit state may
 * keep it, which is asserted too so both halves of the boundary stay pinned.
 */
import { describe, expect, it } from "vitest";

import {
  REGRESSION_PIPELINE,
  makeProject,
  readState,
  runCli,
  singleResult,
  writePipeline,
} from "./harness.js";

describe("credential redaction at the event boundary", () => {
  it("never emits a planted credential in events while state keeps it", () => {
    const root = makeProject();
    writePipeline(root, "regression", REGRESSION_PIPELINE);
    const credential = `ghp_${"a".repeat(36)}`;

    const outcome = runCli(root, "regression", "D1-REDACT", { E2E_CREDENTIAL: credential }, [
      "--max-regressions",
      "0",
    ]);

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(outcome.stdout).not.toContain(credential);
    expect(outcome.stderr).not.toContain(credential);

    const gateDecisionLine = outcome.stdout
      .split("\n")
      .find((line) => line.includes('"event":"gate.decision"'));
    expect(gateDecisionLine, "expected a gate.decision event").toBeDefined();
    const gate = JSON.parse(gateDecisionLine ?? "{}") as { findings?: readonly string[] };
    expect(JSON.stringify(gate.findings ?? [])).toContain("[REDACTED]");

    // The durable audit surface is intentionally unredacted.
    const state = readState(root, "D1-REDACT");
    const findings = state.stages["verify"]?.history[0]?.findings ?? [];
    expect(JSON.stringify(findings)).toContain(credential);
  });
});
