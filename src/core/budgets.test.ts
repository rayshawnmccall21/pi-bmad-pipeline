import { describe, expect, it } from "vitest";

import { evaluateRunBudget, evaluateStageBudget, isBudgetUsage } from "./index.js";

import type { BudgetUsage, BudgetedStage, EvaluateRunBudgetRequest, RunBudget } from "./index.js";
import type { StageBudget } from "../rundef/index.js";

const stage = (budget?: StageBudget): BudgetedStage =>
  budget === undefined ? { id: "dev-story" } : { id: "dev-story", budget };

const usage = (tokens: number, dollars: number): BudgetUsage => ({ tokens, dollars });

const runBudget = (budget?: RunBudget): EvaluateRunBudgetRequest =>
  budget === undefined ? {} : { budget };

describe("stage budget evaluation", () => {
  it("accepts valid budget usage", () => {
    expect(isBudgetUsage({ tokens: 0, dollars: 0 })).toBe(true);
  });

  it.each([
    null,
    {},
    { tokens: 0 },
    { dollars: 0 },
    { tokens: "0", dollars: 0 },
    { tokens: 0, dollars: "0" },
    { tokens: -1, dollars: 0 },
    { tokens: 0, dollars: -1 },
    { tokens: Number.NaN, dollars: 0 },
    { tokens: 0, dollars: Number.POSITIVE_INFINITY },
  ])("rejects invalid budget usage %j", (candidate) => {
    expect(isBudgetUsage(candidate)).toBe(false);
  });

  it("passes stages with no budget without usage", () => {
    expect(evaluateStageBudget({ stage: stage() })).toEqual({
      stageId: "dev-story",
      passed: true,
      exceeded: [],
      reason: 'Stage "dev-story" has no budget ceiling.',
    });
  });

  it("fails closed when a budget has no usage", () => {
    const result = evaluateStageBudget({ stage: stage({ maxTokens: 100 }) });

    expect(result.passed).toBe(false);
    expect(result.budget).toEqual({ maxTokens: 100 });
    expect(result.exceeded).toEqual([]);
    expect(result.reason).toBe(
      'Stage "dev-story" has a budget ceiling but no valid usage was reported.',
    );
  });

  it("fails closed when usage is invalid", () => {
    const result = evaluateStageBudget({
      stage: stage({ maxTokens: 100 }),
      usage: { tokens: -1, dollars: 0 },
    });

    expect(result.passed).toBe(false);
    expect(result.usage).toBeUndefined();
  });

  it("passes maxTokens equality", () => {
    expect(
      evaluateStageBudget({ stage: stage({ maxTokens: 100 }), usage: usage(100, 1) }).passed,
    ).toBe(true);
  });

  it("fails when maxTokens is exceeded", () => {
    const result = evaluateStageBudget({ stage: stage({ maxTokens: 100 }), usage: usage(101, 1) });

    expect(result.passed).toBe(false);
    expect(result.exceeded).toEqual([{ kind: "tokens", actual: 101, limit: 100 }]);
    expect(result.reason).toBe('Stage "dev-story" exceeded budget: tokens 101 > 100.');
  });

  it("passes maxDollars equality", () => {
    expect(
      evaluateStageBudget({ stage: stage({ maxDollars: 1 }), usage: usage(100, 1) }).passed,
    ).toBe(true);
  });

  it("fails when maxDollars is exceeded", () => {
    const result = evaluateStageBudget({ stage: stage({ maxDollars: 1 }), usage: usage(100, 1.5) });

    expect(result.passed).toBe(false);
    expect(result.exceeded).toEqual([{ kind: "dollars", actual: 1.5, limit: 1 }]);
    expect(result.reason).toBe('Stage "dev-story" exceeded budget: dollars 1.5 > 1.');
  });

  it("reports both exceeded limits in deterministic order", () => {
    const result = evaluateStageBudget({
      stage: stage({ maxTokens: 100, maxDollars: 1 }),
      usage: usage(101, 1.5),
    });

    expect(result.exceeded).toEqual([
      { kind: "tokens", actual: 101, limit: 100 },
      { kind: "dollars", actual: 1.5, limit: 1 },
    ]);
    expect(result.reason).toBe(
      'Stage "dev-story" exceeded budget: tokens 101 > 100, dollars 1.5 > 1.',
    );
  });

  it("ignores dollars when only maxTokens is configured", () => {
    const result = evaluateStageBudget({
      stage: stage({ maxTokens: 100 }),
      usage: usage(100, 999),
    });

    expect(result.passed).toBe(true);
  });

  it("ignores tokens when only maxDollars is configured", () => {
    const result = evaluateStageBudget({ stage: stage({ maxDollars: 1 }), usage: usage(999, 1) });

    expect(result.passed).toBe(true);
  });

  it("freezes result, copied budget, copied usage, exceeded array, and exceeded items", () => {
    const result = evaluateStageBudget({
      stage: stage({ maxTokens: 100 }),
      usage: usage(101, 1),
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.budget)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(Object.isFrozen(result.exceeded)).toBe(true);
    expect(Object.isFrozen(result.exceeded[0])).toBe(true);
  });

  it("does not mutate input stage, budget, or usage", () => {
    const budget: StageBudget = { maxTokens: 100, maxDollars: 1 };
    const inputStage = stage(budget);
    const inputUsage = usage(101, 1.5);
    const before = JSON.stringify({ inputStage, budget, inputUsage });

    evaluateStageBudget({ stage: inputStage, usage: inputUsage });

    expect(JSON.stringify({ inputStage, budget, inputUsage })).toBe(before);
  });
});

describe("run budget evaluation", () => {
  it("passes without usage when no run budget is configured", () => {
    expect(evaluateRunBudget(runBudget())).toEqual({
      passed: true,
      exceeded: [],
      reason: "Run has no budget ceiling.",
    });
  });

  it("fails closed when a run budget has no usage", () => {
    const result = evaluateRunBudget(runBudget({ maxTokens: 100 }));

    expect(result.passed).toBe(false);
    expect(result.budget).toEqual({ maxTokens: 100 });
    expect(result.exceeded).toEqual([]);
    expect(result.reason).toBe("Run has a budget ceiling but no valid usage was reported.");
  });

  it("fails closed when run usage is invalid", () => {
    const result = evaluateRunBudget({
      budget: { maxTokens: 100 },
      usage: { tokens: -1, dollars: 0 },
    });

    expect(result.passed).toBe(false);
    expect(result.usage).toBeUndefined();
  });

  it("passes run maxTokens equality", () => {
    expect(evaluateRunBudget({ budget: { maxTokens: 100 }, usage: usage(100, 1) }).passed).toBe(
      true,
    );
  });

  it("fails when run maxTokens is exceeded", () => {
    const result = evaluateRunBudget({ budget: { maxTokens: 100 }, usage: usage(101, 1) });

    expect(result.passed).toBe(false);
    expect(result.exceeded).toEqual([{ kind: "tokens", actual: 101, limit: 100 }]);
    expect(result.reason).toBe("Run exceeded budget: tokens 101 > 100.");
  });

  it("passes run maxDollars equality", () => {
    expect(evaluateRunBudget({ budget: { maxDollars: 1 }, usage: usage(100, 1) }).passed).toBe(
      true,
    );
  });

  it("fails when run maxDollars is exceeded", () => {
    const result = evaluateRunBudget({ budget: { maxDollars: 1 }, usage: usage(100, 1.5) });

    expect(result.passed).toBe(false);
    expect(result.exceeded).toEqual([{ kind: "dollars", actual: 1.5, limit: 1 }]);
    expect(result.reason).toBe("Run exceeded budget: dollars 1.5 > 1.");
  });

  it("reports both run exceeded limits in deterministic order", () => {
    const result = evaluateRunBudget({
      budget: { maxTokens: 100, maxDollars: 1 },
      usage: usage(101, 1.5),
    });

    expect(result.exceeded).toEqual([
      { kind: "tokens", actual: 101, limit: 100 },
      { kind: "dollars", actual: 1.5, limit: 1 },
    ]);
    expect(result.reason).toBe("Run exceeded budget: tokens 101 > 100, dollars 1.5 > 1.");
  });

  it("ignores run dollars when only maxTokens is configured", () => {
    const result = evaluateRunBudget({ budget: { maxTokens: 100 }, usage: usage(100, 999) });

    expect(result.passed).toBe(true);
  });

  it("ignores run tokens when only maxDollars is configured", () => {
    const result = evaluateRunBudget({ budget: { maxDollars: 1 }, usage: usage(999, 1) });

    expect(result.passed).toBe(true);
  });

  it("freezes run result, copied budget, copied usage, exceeded array, and exceeded items", () => {
    const result = evaluateRunBudget({ budget: { maxTokens: 100 }, usage: usage(101, 1) });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.budget)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(Object.isFrozen(result.exceeded)).toBe(true);
    expect(Object.isFrozen(result.exceeded[0])).toBe(true);
  });

  it("does not mutate input run budget or usage", () => {
    const budget: RunBudget = { maxTokens: 100, maxDollars: 1 };
    const inputUsage = usage(101, 1.5);
    const before = JSON.stringify({ budget, inputUsage });

    evaluateRunBudget({ budget, usage: inputUsage });

    expect(JSON.stringify({ budget, inputUsage })).toBe(before);
  });
});
