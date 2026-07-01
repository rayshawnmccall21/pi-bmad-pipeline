import { describe, expect, it } from "vitest";

import { findNextStage, findStageById, routeStageDecision } from "./index.js";

import type { CompiledStageDef } from "../rundef/index.js";
import type { StageDecision, StageDecisionKind } from "./stage-decision.js";

const stage = (id: string, index: number, onFail?: string): CompiledStageDef => ({
  id,
  kind: "agent",
  workflow: id,
  agent: "dev",
  index,
  timeoutSeconds: 1800,
  ...(onFail === undefined ? {} : { onFail }),
});

const passedDecision = (stageId: string): StageDecision => ({
  stageId,
  kind: "passed",
  passed: true,
  reason: "ok",
});

const failedDecision = (stageId: string, kind: StageDecisionKind = "failed"): StageDecision => ({
  stageId,
  kind,
  passed: false,
  reason: "not ok",
});

const stages = (): readonly CompiledStageDef[] => [
  stage("plan", 0),
  stage("dev", 1),
  stage("verify", 2, "dev"),
];

const route = (stageIndex: number, decision: StageDecision, overrides = {}) =>
  routeStageDecision({
    stages: stages(),
    stage: stages()[stageIndex] ?? stage("missing", stageIndex),
    decision,
    regressions: 0,
    maxRegressions: 3,
    ...overrides,
  });

describe("routing", () => {
  it("findStageById returns matching stage", () => {
    expect(findStageById(stages(), "dev")?.id).toBe("dev");
  });

  it("findStageById returns undefined for missing id", () => {
    expect(findStageById(stages(), "missing")).toBeUndefined();
  });

  it("findNextStage returns next stage", () => {
    expect(findNextStage(stages(), "dev")?.id).toBe("verify");
  });

  it("findNextStage returns undefined for last stage", () => {
    expect(findNextStage(stages(), "verify")).toBeUndefined();
  });

  it("continues passed stage to next stage", () => {
    expect(route(1, passedDecision("dev"))).toEqual({
      action: "continue",
      fromStageId: "dev",
      nextStageId: "verify",
      regressions: 0,
      reason: 'Stage "dev" passed; continuing to "verify".',
    });
  });

  it("completes after passed last stage", () => {
    expect(route(2, passedDecision("verify"))).toEqual({
      action: "complete",
      fromStageId: "verify",
      regressions: 0,
      reason: 'Stage "verify" passed; pipeline stages are complete.',
    });
  });

  it("fails closed for non-gate failures", () => {
    expect(route(1, failedDecision("dev"))).toEqual({
      action: "fail",
      fromStageId: "dev",
      regressions: 0,
      failureCode: "stage-failed",
      reason: 'Stage "dev" failed: not ok',
    });
  });

  it("fails closed for gate failure without onFail", () => {
    expect(route(1, failedDecision("dev", "gate-failed")).failureCode).toBe(
      "gate-failed-without-on-fail",
    );
  });

  it("fails closed for missing onFail target", () => {
    const badStage = stage("verify", 2, "missing");

    expect(
      routeStageDecision({
        stages: stages(),
        stage: badStage,
        decision: failedDecision("verify", "gate-failed"),
        regressions: 0,
        maxRegressions: 3,
      }).failureCode,
    ).toBe("on-fail-target-missing");
  });

  it("fails closed for self or forward onFail", () => {
    const self = stage("verify", 2, "verify");
    const forward = stage("dev", 1, "verify");

    expect(
      routeStageDecision({
        stages: [...stages(), self],
        stage: self,
        decision: failedDecision("verify", "gate-failed"),
        regressions: 0,
        maxRegressions: 3,
      }).failureCode,
    ).toBe("on-fail-target-not-earlier");
    expect(
      routeStageDecision({
        stages: stages(),
        stage: forward,
        decision: failedDecision("dev", "gate-failed"),
        regressions: 0,
        maxRegressions: 3,
      }).failureCode,
    ).toBe("on-fail-target-not-earlier");
  });

  it("regresses to earlier onFail target", () => {
    expect(route(2, failedDecision("verify", "gate-failed"))).toEqual({
      action: "regress",
      fromStageId: "verify",
      nextStageId: "dev",
      regressions: 1,
      reason: 'Stage "verify" gate failed; regressing to "dev".',
    });
  });

  it("increments regression count by one", () => {
    expect(route(2, failedDecision("verify", "gate-failed"), { regressions: 2 }).regressions).toBe(
      3,
    );
  });

  it("fails closed when regression limit is exceeded", () => {
    expect(route(2, failedDecision("verify", "gate-failed"), { regressions: 3 }).failureCode).toBe(
      "regression-limit-exceeded",
    );
  });

  it("allows regression below limit", () => {
    expect(
      route(2, failedDecision("verify", "gate-failed"), { regressions: 2, maxRegressions: 3 })
        .action,
    ).toBe("regress");
  });

  it("rejects invalid regressions", () => {
    expect(() => route(1, passedDecision("dev"), { regressions: -1 })).toThrow(
      new RangeError("regressions must be a non-negative integer."),
    );
  });

  it("rejects invalid maxRegressions", () => {
    expect(() => route(1, passedDecision("dev"), { maxRegressions: 1.5 })).toThrow(
      new RangeError("maxRegressions must be a non-negative integer."),
    );
  });

  it("freezes returned route decision", () => {
    expect(Object.isFrozen(route(1, passedDecision("dev")))).toBe(true);
  });

  it("omits optional fields when absent", () => {
    const result = route(2, passedDecision("verify"));

    expect(result).not.toHaveProperty("nextStageId");
    expect(result).not.toHaveProperty("failureCode");
  });

  it("does not mutate inputs", () => {
    const inputStages = stages();
    const inputStage = inputStages[2] ?? stage("verify", 2, "dev");
    const decision = failedDecision("verify", "gate-failed");
    const before = JSON.stringify({ inputStages, inputStage, decision });

    routeStageDecision({
      stages: inputStages,
      stage: inputStage,
      decision,
      regressions: 0,
      maxRegressions: 3,
    });

    expect(JSON.stringify({ inputStages, inputStage, decision })).toBe(before);
  });
});
