import { describe, expect, it, vi } from "vitest";

import { checkStageDecision } from "./index.js";

import type { CompiledStageDef, PayloadGate } from "../rundef/index.js";
import type { StageDecisionExecutionResult } from "./index.js";

const stage = (
  overrides: Partial<Pick<CompiledStageDef, "id" | "payloadGate" | "payloadGateName">> = {},
): Pick<CompiledStageDef, "id" | "payloadGate" | "payloadGateName"> => ({
  id: "e2e-verify",
  ...overrides,
});

const result = (
  overrides: Partial<StageDecisionExecutionResult> = {},
): StageDecisionExecutionResult => ({
  output: { payload: { ok: true } },
  exitCode: 0,
  durationMs: 100,
  ...overrides,
});

describe("stage gate decision", () => {
  it("lets aborted beat all other failure signals", () => {
    const decision = checkStageDecision({
      stage: stage(),
      result: result({
        aborted: true,
        timedOut: true,
        parseError: "bad",
        output: null,
        exitCode: 9,
      }),
    });

    expect(decision).toMatchObject({
      kind: "aborted",
      passed: false,
      reason: 'Stage "e2e-verify" was aborted.',
    });
  });

  it("lets timed-out beat parse, output, and exit failures", () => {
    const decision = checkStageDecision({
      stage: stage(),
      result: result({ timedOut: true, parseError: "bad", output: null, exitCode: 9 }),
    });

    expect(decision.kind).toBe("timed-out");
    expect(decision.reason).toBe('Stage "e2e-verify" timed out.');
  });

  it("lets parse error beat missing output", () => {
    const decision = checkStageDecision({
      stage: stage(),
      result: result({ parseError: "line 1", output: null }),
    });

    expect(decision.kind).toBe("parse-error");
    expect(decision.reason).toBe('Stage "e2e-verify" produced invalid JSONL: line 1');
  });

  it("fails closed when output is missing", () => {
    const decision = checkStageDecision({ stage: stage(), result: result({ output: null }) });

    expect(decision.kind).toBe("failed");
    expect(decision.reason).toBe('Stage "e2e-verify" did not produce validated output.');
  });

  it("fails on non-zero exit code", () => {
    const decision = checkStageDecision({ stage: stage(), result: result({ exitCode: 2 }) });

    expect(decision.kind).toBe("failed");
    expect(decision.reason).toBe('Stage "e2e-verify" exited with code 2.');
  });

  it("fails on null exit code with output", () => {
    const decision = checkStageDecision({ stage: stage(), result: result({ exitCode: null }) });

    expect(decision.kind).toBe("failed");
    expect(decision.reason).toBe('Stage "e2e-verify" exited without an exit code.');
  });

  it("passes without a payload gate", () => {
    const decision = checkStageDecision({ stage: stage(), result: result() });

    expect(decision).toMatchObject({
      kind: "passed",
      passed: true,
      reason: 'Stage "e2e-verify" passed without a payload gate.',
    });
  });

  it("passes the output payload to the payload gate", () => {
    const gate = vi.fn<PayloadGate>(() => ({ passed: true }));
    const output = { payload: { ok: true, value: 1 } };

    checkStageDecision({ stage: stage({ payloadGate: gate }), result: result({ output }) });

    expect(gate).toHaveBeenCalledWith(output.payload);
  });

  it("uses a passing payload gate reason", () => {
    const gate: PayloadGate = () => ({ passed: true, reason: "gate ok" });

    const decision = checkStageDecision({
      stage: stage({ payloadGate: gate, payloadGateName: "e2e" }),
      result: result(),
    });

    expect(decision).toMatchObject({ kind: "passed", passed: true, reason: "gate ok" });
  });

  it("uses a default passing payload gate reason", () => {
    const gate: PayloadGate = () => ({ passed: true });

    const decision = checkStageDecision({
      stage: stage({ payloadGate: gate, payloadGateName: "e2e" }),
      result: result(),
    });

    expect(decision.reason).toBe('Stage "e2e-verify" payload gate "e2e" passed.');
  });

  it("uses a failed payload gate reason and copies findings", () => {
    const findings = ["broken"];
    const gate: PayloadGate = () => ({ passed: false, reason: "gate bad", findings });

    const decision = checkStageDecision({
      stage: stage({ payloadGate: gate, payloadGateName: "e2e" }),
      result: result(),
    });

    findings.push("later");
    expect(decision).toMatchObject({ kind: "gate-failed", passed: false, reason: "gate bad" });
    expect(decision.findings).toEqual(["broken"]);
  });

  it("uses a default failed payload gate reason", () => {
    const gate: PayloadGate = () => ({ passed: false });

    const decision = checkStageDecision({
      stage: stage({ payloadGate: gate, payloadGateName: "e2e" }),
      result: result(),
    });

    expect(decision.reason).toBe('Stage "e2e-verify" payload gate "e2e" failed.');
  });

  it("uses unnamed in default gate reasons when no gate name exists", () => {
    const gate: PayloadGate = () => ({ passed: true });

    const decision = checkStageDecision({ stage: stage({ payloadGate: gate }), result: result() });

    expect(decision.reason).toBe('Stage "e2e-verify" payload gate "unnamed" passed.');
  });

  it("copies and freezes usage", () => {
    const usage = { tokens: 10, dollars: 0.25 };

    const decision = checkStageDecision({ stage: stage(), result: result({ usage }) });

    usage.tokens = 99;
    expect(decision.usage).toEqual({ tokens: 10, dollars: 0.25 });
    expect(Object.isFrozen(decision.usage)).toBe(true);
  });

  it("copies and freezes findings", () => {
    const gate: PayloadGate = () => ({ passed: false, findings: ["broken"] });

    const decision = checkStageDecision({ stage: stage({ payloadGate: gate }), result: result() });

    expect(decision.findings).toEqual(["broken"]);
    expect(Object.isFrozen(decision.findings)).toBe(true);
  });

  it("freezes the decision object", () => {
    expect(Object.isFrozen(checkStageDecision({ stage: stage(), result: result() }))).toBe(true);
  });

  it("does not mutate stage, result, payload, usage, or findings", () => {
    const findings = ["broken"];
    const gate: PayloadGate = () => ({ passed: false, findings });
    const inputStage = stage({ payloadGate: gate });
    const inputResult = result({ usage: { tokens: 10, dollars: 0.25 } });
    const before = JSON.stringify({ inputStage, inputResult, findings });

    checkStageDecision({ stage: inputStage, result: inputResult });

    expect(JSON.stringify({ inputStage, inputResult, findings })).toBe(before);
  });

  it("propagates payload gate exceptions", () => {
    const gate: PayloadGate = () => {
      throw new Error("boom");
    };

    expect(() => {
      checkStageDecision({ stage: stage({ payloadGate: gate }), result: result() });
    }).toThrow("boom");
  });
});
