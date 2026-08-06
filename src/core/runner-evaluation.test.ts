import { describe, expect, it } from "vitest";

import { errorMessage, failureOf, stageFailureOutcome } from "./runner-evaluation.js";

import type { StageEvaluation } from "./runner-evaluation.js";
import type { StageRouteDecision } from "./routing.js";
import type { StageDecision } from "./stage-decision.js";

const decision = (overrides: Partial<StageDecision> = {}): StageDecision => ({
  stageId: "a",
  kind: "failed",
  passed: false,
  reason: "not ok",
  ...overrides,
});

const failRoute = (overrides: Partial<StageRouteDecision> = {}): StageRouteDecision => ({
  action: "fail",
  fromStageId: "a",
  regressions: 0,
  reason: "route failed",
  ...overrides,
});

describe("runner-evaluation", () => {
  it("falls back to stage-failed when a fail route lacks a failure code", () => {
    const evaluation: StageEvaluation = {
      decision: decision(),
      route: failRoute(),
      budgetFailure: null,
    };

    expect(stageFailureOutcome(evaluation, "a")).toEqual({
      status: "failed",
      failure: { code: "stage-failed", stageId: "a", reason: "route failed" },
    });
  });

  it("builds frozen failures", () => {
    const failure = failureOf("aborted", "stopped", "a");

    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure).toEqual({ code: "aborted", stageId: "a", reason: "stopped" });
  });

  it("extracts messages from Error values", () => {
    expect(errorMessage(new Error("bad"))).toBe("bad");
  });
});
