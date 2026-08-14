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

  it("redacts a failing code diagnostic before events and durable state", () => {
    const root = makeProject();
    const credential = `ghp_${"b".repeat(36)}`;
    const script = `process.stdout.write(${JSON.stringify(credential)}); process.stderr.write(${JSON.stringify(credential)}); process.exit(7)`;
    writePipeline(
      root,
      "code-secret",
      `
id: code-secret
stages:
  - id: check
    kind: code
    command: node
    args: ["-e", ${JSON.stringify(script)}]
    timeout: 60
`,
    );

    const outcome = runCli(root, "code-secret", "D2-CODE-SECRET");
    const durable = JSON.stringify(readState(root, "D2-CODE-SECRET"));

    expect(outcome.status).toBe(2);
    expect(singleResult(outcome)).toMatchObject({ status: "failed" });
    expect(outcome.stdout).not.toContain(credential);
    expect(outcome.stderr).not.toContain(credential);
    expect(durable).not.toContain(credential);
    expect(`${outcome.stdout}\n${durable}`).toContain("[REDACTED]");
  });
});
